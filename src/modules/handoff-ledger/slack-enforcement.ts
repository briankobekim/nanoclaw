import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import {
  setA2aMessageEnforcer,
  type A2aMessageEnforcementDecision,
  type A2aMessageEnforcer,
} from '../../channels/slack-a2a.js';
import type { SlackBotInboundContext } from '../../channels/slack-a2a-guard.js';
import { botTokenKeyForInstance, slackAuthTest } from '../../channels/slack-lib.js';
import { resolveInstanceAgentGroup } from '../slack-room-membership/membership.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { findSessionByAgentGroup, findSessionForAgent } from '../../db/sessions.js';
import { notifyAgent } from '../approvals/index.js';
import { readEnvValue } from '../slack-room-membership/env-file.js';
import { parseVerificationInputs, type VerificationInputs } from '../verifier/checks-schema.js';
import {
  deliverHandoffWithInputs,
  getHandoff,
  reviewHandoff,
  type DeliverHandoffWithInputsArgs,
  type HandoffRow,
  type ReviewOutcome,
} from './ledger.js';

const CONTRACT_FIELDS = [
  'HANDOFF_ID',
  'FINGERPRINT',
  'PROJECT',
  'GOAL',
  'OUTCOME',
  'CLASS',
  'SCOPE',
  'AUTHORITY',
  'CHECKPOINT',
  'FILES',
  'CHECKS',
  'REPRODUCE',
  'EVIDENCE',
  'RISKS',
  'FOLLOW_UP',
] as const;

const REVIEW_FIELDS = ['HANDOFF_ID', 'FINGERPRINT', 'PROJECT', 'GOAL'] as const;
const TRACKED_MARKERS = new Set<string>(CONTRACT_FIELDS);
const FIELD_LINE = /^\s*(?:[-*]\s*)?(?:[*_`]{0,2})([A-Z][A-Z0-9_]*)(?:[*_`]{0,2})\s*:\s*(?:[*_`]{0,2})\s*(.*?)\s*$/i;
const REVIEW_LINE =
  // The outcome may stand alone on its line or carry the label the protocol
  // uses ("FORMAL REVIEW OUTCOME: <outcome>"), with light Slack markdown
  // around either part. Any other prefix is rejected on purpose.
  /^\s*(?:[-*]\s*)?(?:[*_`]{0,2}FORMAL REVIEW OUTCOME[*_`]{0,2}\s*:?[*_`]{0,2}\s*)?(?:[*_`]{0,2})(APPROVED WITH MINOR NOTES|APPROVED|CHANGES REQUIRED|REVIEW BLOCKED)(?:[*_`]{0,2})(?:\s*[—-].*)?\s*$/i;

export interface ParsedTrackedMessage {
  tracked: boolean;
  fields: Map<string, string>;
  reviewOutcome?: ReviewOutcome;
}

export interface HandoffMessageParticipants {
  senderAgentGroupId: string;
  receiverAgentGroupId: string;
}

export interface HandoffMessageEnforcementDeps {
  getHandoff(id: string): Promise<HandoffRow | undefined>;
  /**
   * Atomic capture + delivery. Replaces the old `markDelivered`: the commands
   * the host may later execute are persisted in the same transaction that
   * moves the handoff, so `delivered` never exists without them.
   */
  deliverWithInputs(args: DeliverHandoffWithInputsArgs): Promise<HandoffRow>;
  review(id: string, actor: string, fingerprint: string, outcome: ReviewOutcome, notes?: string): Promise<HandoffRow>;
  resolveParticipants(ctx: SlackBotInboundContext): Promise<HandoffMessageParticipants | undefined>;
  /**
   * Optional: tell the SENDING agent why its formal message was blocked. Fire-and-forget;
   * it can never change the decision. Without it a blocked handoff or review only leaves a
   * WARN in the host log and the agent learns nothing (2026-09-15 incident).
   */
  notifyRejection?(ctx: SlackBotInboundContext, reason: string, handoffId?: string): Promise<void>;
}

function messageText(ctx: SlackBotInboundContext): string {
  const content =
    typeof ctx.message.content === 'object' && ctx.message.content !== null
      ? (ctx.message.content as Record<string, unknown>)
      : undefined;
  const formatted = formattedMessageText(content?.formatted);
  if (formatted) return formatted;
  if (typeof content?.text === 'string') return content.text;
  if (typeof content?.markdown === 'string') return content.markdown;
  return '';
}

/**
 * Recover the structural line breaks preserved by Chat SDK's formatted AST.
 * SlackFormatConverter.extractPlainText currently joins adjacent top-level
 * paragraphs without a separator, which can turn a field at the start of the
 * second paragraph into part of the preceding sentence. Formal handoffs are
 * line-oriented, so prefer the AST and keep top-level blocks separated.
 */
function formattedMessageText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { type?: unknown; value?: unknown; children?: unknown };
  if (typeof node.value === 'string') return node.value;
  if (!Array.isArray(node.children)) return '';

  const parts = node.children.map(formattedMessageText).filter((part) => part.length > 0);
  const separator =
    node.type === 'root'
      ? '\n\n'
      : node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote'
        ? '\n'
        : '';
  return parts.join(separator);
}

/** Parse only explicit contract markers; ordinary conversation is untracked. */
export function parseTrackedHandoffMessage(text: string): ParsedTrackedMessage {
  const fields = new Map<string, string>();
  let reviewOutcome: ReviewOutcome | undefined;
  let tracked = false;

  for (const line of text.split(/\r?\n/)) {
    const field = line.match(FIELD_LINE);
    if (field) {
      const name = field[1]!.toUpperCase();
      if (TRACKED_MARKERS.has(name)) tracked = true;
      if (!fields.has(name)) fields.set(name, field[2]!.trim());
    }
    const review = line.match(REVIEW_LINE);
    if (review) reviewOutcome = review[1]!.toUpperCase() as ReviewOutcome;
  }

  // Chat SDK's Slack serializer currently drops blank paragraph boundaries
  // from `message.toJSON()`. That can append the first HANDOFF_ID field to an
  // introductory sentence even though every later field keeps its newline.
  // Recover only that exact, otherwise-complete contract shape: broad inline
  // field parsing would turn quoted examples into executable handoffs.
  const missingContract = CONTRACT_FIELDS.filter((field) => !(fields.get(field)?.trim() ?? ''));
  const missingReview = REVIEW_FIELDS.filter((field) => !(fields.get(field)?.trim() ?? ''));
  const recoverableContract = tracked && missingContract.length === 1 && missingContract[0] === 'HANDOFF_ID';
  const recoverableReview =
    tracked && reviewOutcome !== undefined && missingReview.length === 1 && missingReview[0] === 'HANDOFF_ID';
  if (recoverableContract || recoverableReview) {
    const inlineId = text.match(/HANDOFF_ID(?:[*_`]{0,2})\s*:\s*(?:[*_`]{0,2})\s*([^\r\n]+)/i)?.[1]?.trim();
    if (inlineId) fields.set('HANDOFF_ID', inlineId);
  }

  return { tracked, fields, reviewOutcome };
}

function missingFields(parsed: ParsedTrackedMessage, required: readonly string[]): string[] {
  return required.filter((field) => !(parsed.fields.get(field)?.trim() ?? ''));
}

function rejectSilently(
  ctx: SlackBotInboundContext,
  reason: string,
  handoffId?: string,
): A2aMessageEnforcementDecision {
  log.warn('handoff-ledger: blocked formal Slack handoff', {
    reason,
    handoffId,
    instance: ctx.instanceKey,
    platformId: ctx.platformId,
    botId: ctx.botId,
  });
  return { action: 'drop', reason: `handoff enforcement: ${reason}` };
}

function mismatch(field: string, expected: string, actual: string | undefined): string | undefined {
  return actual === expected ? undefined : `${field} does not match the trusted ledger`;
}

/**
 * Validate formal Atlas/Echo Slack packages and bind their state transitions
 * to the host-owned ledger before the receiving agent can act on them.
 */
export function createHandoffMessageEnforcer(deps: HandoffMessageEnforcementDeps): A2aMessageEnforcer {
  const reject = (ctx: SlackBotInboundContext, reason: string, handoffId?: string): A2aMessageEnforcementDecision => {
    const decision = rejectSilently(ctx, reason, handoffId);
    if (deps.notifyRejection) {
      void deps.notifyRejection(ctx, reason, handoffId).catch((err) => {
        log.warn('handoff-ledger: could not notify the sender about a blocked message', { reason, handoffId, err });
      });
    }
    return decision;
  };
  return async (ctx) => {
    const parsed = parseTrackedHandoffMessage(messageText(ctx));
    if (!parsed.tracked) return { action: 'allow' };

    const id = parsed.fields.get('HANDOFF_ID');
    const fingerprint = parsed.fields.get('FINGERPRINT');
    if (!id || !fingerprint) {
      const missing = [!id ? 'HANDOFF_ID' : '', !fingerprint ? 'FINGERPRINT' : ''].filter(Boolean);
      return reject(ctx, `missing ${missing.join(', ')}`, id);
    }

    const [participants, row] = await Promise.all([deps.resolveParticipants(ctx), deps.getHandoff(id)]);
    if (!participants) return reject(ctx, 'could not authenticate the sending and receiving agents', id);
    if (!row) return reject(ctx, 'HANDOFF_ID was not found in the trusted ledger', id);

    const commonMismatch =
      mismatch('FINGERPRINT', row.fingerprint, fingerprint) ??
      mismatch('PROJECT', row.project, parsed.fields.get('PROJECT')) ??
      mismatch('GOAL', row.goal, parsed.fields.get('GOAL'));
    if (commonMismatch) return reject(ctx, commonMismatch, id);

    const { senderAgentGroupId: sender, receiverAgentGroupId: receiver } = participants;
    if (sender === row.source_agent_group_id && receiver === row.reviewer_agent_group_id) {
      const missing = missingFields(parsed, CONTRACT_FIELDS);
      if (missing.length > 0) return reject(ctx, `incomplete handoff: missing ${missing.join(', ')}`, id);
      if (parsed.reviewOutcome) return reject(ctx, 'source handoff cannot contain a formal review outcome', id);
      if (row.status !== 'created') return reject(ctx, `handoff is ${row.status}; expected created`, id);

      // Validate the verification inputs at DECISION time so the sender gets a
      // named reason. The guard drops a message whose `beforeForward` throws,
      // but it cannot tell the sender why — and a prose CHECKS block must not
      // reach Echo looking like a verifiable handoff.
      let inputs: VerificationInputs;
      try {
        inputs = parseVerificationInputs({
          class: parsed.fields.get('CLASS'),
          checkpoint: parsed.fields.get('CHECKPOINT'),
          checksJson: parsed.fields.get('CHECKS'),
          reproduceJson: parsed.fields.get('REPRODUCE'),
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed package is data, not a bug
      } catch (err) {
        return reject(ctx, err instanceof Error ? err.message : String(err), id);
      }

      return {
        action: 'allow',
        // Second line of defence: the capture and the status change are one
        // transaction. If it throws here the guard drops the message and the
        // handoff stays `created`.
        beforeForward: async () => {
          await deps.deliverWithInputs({ id, actor: sender, fingerprint, inputs });
        },
      };
    }

    if (sender === row.reviewer_agent_group_id && receiver === row.source_agent_group_id) {
      const missing = missingFields(parsed, REVIEW_FIELDS);
      if (missing.length > 0) return reject(ctx, `incomplete review: missing ${missing.join(', ')}`, id);
      if (!parsed.reviewOutcome) return reject(ctx, 'review is missing its formal outcome', id);
      if (row.status !== 'delivered') return reject(ctx, `handoff is ${row.status}; expected delivered`, id);
      return {
        action: 'allow',
        beforeForward: async () => {
          await deps.review(
            id,
            sender,
            fingerprint,
            parsed.reviewOutcome!,
            parsed.fields.get('NOTES') || 'Recorded automatically from the verified Slack handback',
          );
        },
      };
    }

    return reject(ctx, 'message direction does not match the ledger source and reviewer', id);
  };
}

const identityCache = new Map<string, string>();
let identityCacheLoadedAt = 0;
const IDENTITY_CACHE_TTL_MS = 10 * 60_000;

function configuredSlackInstances(): string[] {
  const named = (readEnvFile(['SLACK_INSTANCES']).SLACK_INSTANCES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => `slack-${name}`);
  return ['slack', ...named];
}

async function refreshBotIdentityCache(rootDir: string): Promise<void> {
  if (Date.now() - identityCacheLoadedAt < IDENTITY_CACHE_TTL_MS && identityCache.size > 0) return;
  const next = new Map<string, string>();
  for (const instance of configuredSlackInstances()) {
    const token = readEnvValue(rootDir, botTokenKeyForInstance(instance));
    if (!token) continue;
    try {
      const auth = await slackAuthTest(token, 'handoff-identity');
      next.set(auth.userId, instance);
      if (auth.botId) next.set(auth.botId, instance);
    } catch (err) {
      log.warn('handoff-ledger: could not resolve Slack bot identity', { instance, err });
    }
  }
  identityCache.clear();
  for (const [id, instance] of next) identityCache.set(id, instance);
  identityCacheLoadedAt = Date.now();
}

export function clearHandoffIdentityCache(): void {
  identityCache.clear();
  identityCacheLoadedAt = 0;
}

async function resolveLiveParticipants(ctx: SlackBotInboundContext): Promise<HandoffMessageParticipants | undefined> {
  await refreshBotIdentityCache(process.cwd());
  const senderInstance = identityCache.get(ctx.botId);
  if (!senderInstance) return undefined;
  const [sender, receiver] = await Promise.all([
    resolveInstanceAgentGroup(senderInstance),
    resolveInstanceAgentGroup(ctx.instanceKey),
  ]);
  if (!sender || !receiver) return undefined;
  return { senderAgentGroupId: sender.id, receiverAgentGroupId: receiver.id };
}

/**
 * Deliver the block reason to the agent that sent the message, in the session it used for
 * this thread (falling back to its most recent session). The agent sees a system note and is
 * woken so it can correct and re-post. Nothing here touches the ledger.
 */
async function notifyLiveRejection(ctx: SlackBotInboundContext, reason: string, handoffId?: string): Promise<void> {
  await refreshBotIdentityCache(process.cwd());
  const senderInstance = identityCache.get(ctx.botId);
  if (!senderInstance) return;
  const sender = await resolveInstanceAgentGroup(senderInstance);
  if (!sender) return;
  const group = await getMessagingGroupByPlatform('slack', ctx.platformId, senderInstance);
  const session =
    (group ? await findSessionForAgent(sender.id, group.id, ctx.threadId) : undefined) ??
    (await findSessionByAgentGroup(sender.id));
  if (!session) return;
  const what = handoffId ? `handoff ${handoffId}` : 'your formal handoff/review message';
  await notifyAgent(
    session,
    `LEDGER BLOCKED: ${what} was NOT recorded and was NOT forwarded to the other agent. Reason: ${reason}. ` +
      'Fix the message per shared-protocol.md and re-post it; the ledger row is unchanged.',
  );
}

setA2aMessageEnforcer(
  createHandoffMessageEnforcer({
    getHandoff,
    deliverWithInputs: deliverHandoffWithInputs,
    review: reviewHandoff,
    resolveParticipants: resolveLiveParticipants,
    notifyRejection: notifyLiveRejection,
  }),
);
