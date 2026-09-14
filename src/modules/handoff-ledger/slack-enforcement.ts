import {
  getAllMessagingGroups,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from '../../db/messaging-groups.js';
import { envValue, readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import {
  setA2aMessageEnforcer,
  type A2aMessageEnforcementDecision,
  type A2aMessageEnforcer,
} from '../../channels/slack-a2a.js';
import type { SlackBotInboundContext } from '../../channels/slack-a2a-guard.js';
import { botTokenKeyForInstance, slackAuthTest } from '../../channels/slack-lib.js';
import {
  completeHandoffDelivery,
  completeHandoffReview,
  getHandoff,
  releaseHandoffDelivery,
  releaseHandoffReview,
  reserveHandoffDelivery,
  reserveHandoffReview,
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
  /^\s*(?:[-*]\s*)?(?:[*_`]{0,2})(APPROVED WITH MINOR NOTES|APPROVED|CHANGES REQUIRED|REVIEW BLOCKED)(?:[*_`]{0,2})(?:\s*[—-].*)?\s*$/i;

export interface ParsedTrackedMessage {
  tracked: boolean;
  fields: Map<string, string>;
  reviewOutcome?: ReviewOutcome;
  reviewOutcomeConflict?: boolean;
  duplicateFields?: string[];
}

export interface HandoffMessageParticipants {
  senderAgentGroupId: string;
  receiverAgentGroupId: string;
}

export interface HandoffMessageEnforcementDeps {
  getHandoff(id: string): Promise<HandoffRow | undefined>;
  reserveDelivery(id: string, actor: string, fingerprint: string): Promise<HandoffRow>;
  completeDelivery(id: string, actor: string, fingerprint: string, generation: number): Promise<HandoffRow>;
  releaseDelivery(
    id: string,
    actor: string,
    fingerprint: string,
    generation: number,
    reason: string,
  ): Promise<HandoffRow>;
  reserveReview(
    id: string,
    actor: string,
    fingerprint: string,
    outcome: ReviewOutcome,
    notes?: string,
  ): Promise<HandoffRow>;
  completeReview(id: string, actor: string, fingerprint: string, generation: number): Promise<HandoffRow>;
  releaseReview(
    id: string,
    actor: string,
    fingerprint: string,
    generation: number,
    reason: string,
  ): Promise<HandoffRow>;
  resolveParticipants(ctx: SlackBotInboundContext): Promise<HandoffMessageParticipants | undefined>;
}

function messageText(ctx: SlackBotInboundContext): string {
  const content =
    typeof ctx.message.content === 'object' && ctx.message.content !== null
      ? (ctx.message.content as Record<string, unknown>)
      : undefined;
  const formatted = formattedMessageText(content?.formatted);
  if (formatted !== undefined) return formatted;
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
function formattedMessageText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const node = value as { type?: unknown; value?: unknown; children?: unknown };
  if (node.type === 'blockquote' || node.type === 'code') return '';
  if (typeof node.value === 'string') return node.value;
  if (!Array.isArray(node.children)) return undefined;

  const parts = node.children
    .map(formattedMessageText)
    .filter((part): part is string => part !== undefined && part.length > 0);
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
  let reviewOutcomeConflict = false;
  const duplicateFields = new Set<string>();
  const eligibleLines: string[] = [];
  let tracked = false;
  let inCodeFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || /^\s*>/.test(line)) continue;
    eligibleLines.push(line);
    const field = line.match(FIELD_LINE);
    if (field) {
      const name = field[1]!.toUpperCase();
      if (TRACKED_MARKERS.has(name)) tracked = true;
      if (fields.has(name)) duplicateFields.add(name);
      else fields.set(name, field[2]!.trim());
    }
    const review = line.match(REVIEW_LINE);
    if (review) {
      const next = review[1]!.toUpperCase() as ReviewOutcome;
      if (reviewOutcome) reviewOutcomeConflict = true;
      reviewOutcome ??= next;
    }
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
    tracked &&
    reviewOutcome !== undefined &&
    !reviewOutcomeConflict &&
    missingReview.length === 1 &&
    missingReview[0] === 'HANDOFF_ID';
  if (recoverableContract || recoverableReview) {
    const inlineId = eligibleLines
      .join('\n')
      .match(/HANDOFF_ID(?:[*_`]{0,2})\s*:\s*(?:[*_`]{0,2})\s*([^\r\n]+)/i)?.[1]
      ?.trim();
    if (inlineId) fields.set('HANDOFF_ID', inlineId);
  }

  return {
    tracked,
    fields,
    reviewOutcome,
    ...(reviewOutcomeConflict ? { reviewOutcomeConflict: true } : {}),
    ...(duplicateFields.size > 0 ? { duplicateFields: [...duplicateFields].sort() } : {}),
  };
}

function missingFields(parsed: ParsedTrackedMessage, required: readonly string[]): string[] {
  return required.filter((field) => !(parsed.fields.get(field)?.trim() ?? ''));
}

function reject(ctx: SlackBotInboundContext, reason: string, handoffId?: string): A2aMessageEnforcementDecision {
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
 * Validate formal source/reviewer Slack packages and bind their state transitions
 * to the host-owned ledger before the receiving agent can act on them.
 */
export function createHandoffMessageEnforcer(deps: HandoffMessageEnforcementDeps): A2aMessageEnforcer {
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
      if (parsed.duplicateFields?.length) {
        return reject(ctx, `handoff contains duplicate fields: ${parsed.duplicateFields.join(', ')}`, id);
      }
      const contractMismatch =
        mismatch('OUTCOME', row.outcome, parsed.fields.get('OUTCOME')) ??
        mismatch('SCOPE', row.scope, parsed.fields.get('SCOPE')) ??
        mismatch('AUTHORITY', row.authority, parsed.fields.get('AUTHORITY'));
      if (contractMismatch) return reject(ctx, contractMismatch, id);
      if (parsed.reviewOutcome) return reject(ctx, 'source handoff cannot contain a formal review outcome', id);
      if (row.status !== 'created') {
        return reject(ctx, `handoff is ${row.status}; expected created`, id);
      }
      let reservationGeneration: number | undefined;
      return {
        action: 'allow',
        requiredAgentGroupId: receiver,
        beforeForward: async () => {
          const reserved = await deps.reserveDelivery(id, sender, fingerprint);
          reservationGeneration = reserved.reservation_generation;
        },
        onAccepted: async () => {
          if (reservationGeneration === undefined) throw new Error(`handoff ${id} delivery was not reserved`);
          await deps.completeDelivery(id, sender, fingerprint, reservationGeneration);
          reservationGeneration = undefined;
        },
        onRejected: async () => {
          if (reservationGeneration === undefined) return;
          await deps.releaseDelivery(
            id,
            sender,
            fingerprint,
            reservationGeneration,
            'required reviewer did not accept routed message',
          );
          reservationGeneration = undefined;
        },
      };
    }

    if (sender === row.reviewer_agent_group_id && receiver === row.source_agent_group_id) {
      const missing = missingFields(parsed, REVIEW_FIELDS);
      if (missing.length > 0) return reject(ctx, `incomplete review: missing ${missing.join(', ')}`, id);
      if (parsed.duplicateFields?.length) {
        return reject(ctx, `review contains duplicate fields: ${parsed.duplicateFields.join(', ')}`, id);
      }
      if (parsed.reviewOutcomeConflict) return reject(ctx, 'review contains multiple formal outcomes', id);
      if (!parsed.reviewOutcome) return reject(ctx, 'review is missing its formal outcome', id);
      if (row.status !== 'delivered') {
        return reject(ctx, `handoff is ${row.status}; expected delivered`, id);
      }
      let reservationGeneration: number | undefined;
      return {
        action: 'allow',
        requiredAgentGroupId: receiver,
        beforeForward: async () => {
          const reserved = await deps.reserveReview(
            id,
            sender,
            fingerprint,
            parsed.reviewOutcome!,
            parsed.fields.get('NOTES') || 'Recorded automatically from the verified Slack handback',
          );
          reservationGeneration = reserved.reservation_generation;
        },
        onAccepted: async () => {
          if (reservationGeneration === undefined) throw new Error(`handoff ${id} review was not reserved`);
          await deps.completeReview(id, sender, fingerprint, reservationGeneration);
          reservationGeneration = undefined;
        },
        onRejected: async () => {
          if (reservationGeneration === undefined) return;
          await deps.releaseReview(
            id,
            sender,
            fingerprint,
            reservationGeneration,
            'required source did not accept routed review',
          );
          reservationGeneration = undefined;
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

/**
 * Resolve one Slack adapter instance only when every one of its wirings names
 * the same agent group. Ambiguous or unwired instances fail closed.
 */
async function resolveInstanceAgentGroup(instance: string): Promise<string | undefined> {
  const rows = (await getAllMessagingGroups()).filter(
    (group) => group.channel_type === 'slack' && (group.instance ?? group.channel_type) === instance,
  );
  const ids = new Set<string>();
  for (const group of rows) {
    for (const wiring of await getMessagingGroupAgents(group.id)) ids.add(wiring.agent_group_id);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** Resolve the receiving agent from this exact instance + room wiring. */
async function resolveRoomAgentGroup(instance: string, platformId: string): Promise<string | undefined> {
  const found = await getMessagingGroupWithAgentCount('slack', platformId, instance);
  if (!found || found.agentCount === 0) return undefined;
  const ids = new Set((await getMessagingGroupAgents(found.mg.id)).map((wiring) => wiring.agent_group_id));
  return ids.size === 1 ? [...ids][0] : undefined;
}

export async function resolveWiredParticipants(
  ctx: SlackBotInboundContext,
  senderInstance: string,
): Promise<HandoffMessageParticipants | undefined> {
  const [sender, receiver] = await Promise.all([
    resolveInstanceAgentGroup(senderInstance),
    resolveRoomAgentGroup(ctx.instanceKey, ctx.platformId),
  ]);
  if (!sender || !receiver) return undefined;
  return { senderAgentGroupId: sender, receiverAgentGroupId: receiver };
}

async function refreshBotIdentityCache(rootDir: string): Promise<void> {
  if (Date.now() - identityCacheLoadedAt < IDENTITY_CACHE_TTL_MS && identityCache.size > 0) return;
  const next = new Map<string, string>();
  for (const instance of configuredSlackInstances()) {
    const token = envValue(botTokenKeyForInstance(instance), rootDir);
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
  return resolveWiredParticipants(ctx, senderInstance);
}

setA2aMessageEnforcer(
  createHandoffMessageEnforcer({
    getHandoff,
    reserveDelivery: reserveHandoffDelivery,
    completeDelivery: completeHandoffDelivery,
    releaseDelivery: releaseHandoffDelivery,
    reserveReview: reserveHandoffReview,
    completeReview: completeHandoffReview,
    releaseReview: releaseHandoffReview,
    resolveParticipants: resolveLiveParticipants,
  }),
);
