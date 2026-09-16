/**
 * Owner filing (plan §4.1): a message from the owner that starts with
 * `remember:` is written by the host, keyed by the message's originating
 * conversation and its platform id, into the group's owner-statements file.
 * No agent is involved.
 */
import { createHash } from 'crypto';

import { log } from '../../log.js';
import { notifyOwners } from './notify.js';
import { completePendingOps, enqueueMemoryOp, OWNER_STATEMENTS_PATH } from './ops.js';

/**
 * Dependencies kept separate from request.ts on purpose: the router imports
 * this file, and request.ts pulls the approvals graph, which reaches back into
 * the router (reason-capture → router). This file must stay cycle-free.
 */
export interface OwnerFilingDeps {
  enqueueMemoryOp: typeof enqueueMemoryOp;
  completePendingOps: typeof completePendingOps;
  notifyOwners: typeof notifyOwners;
}
const liveDeps: OwnerFilingDeps = { enqueueMemoryOp, completePendingOps, notifyOwners };
let deps: OwnerFilingDeps = liveDeps;
/** Test seam. Pass nothing to restore the live dependencies. */
export function setOwnerFilingDeps(overrides?: Partial<OwnerFilingDeps>): void {
  deps = overrides ? { ...liveDeps, ...overrides } : liveDeps;
}

const OWNER_FILING_RE = /^\s*remember\s*[:,-]\s*\S/i;

export function isOwnerFilingMessage(text: unknown): text is string {
  return typeof text === 'string' && OWNER_FILING_RE.test(text);
}

/**
 * Where an owner message came from. Platform message ids are unique only
 * within their conversation (and adapter instance), so the ledger key is the
 * whole tuple, hashed to a bounded, deterministic id.
 */
export interface OwnerFilingSource {
  channelType: string;
  instance: string | null;
  messagingGroupId: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
  agentGroupId: string;
}

export function ownerFilingRequestId(source: OwnerFilingSource): string {
  const tuple = [
    source.channelType,
    source.instance ?? '',
    source.messagingGroupId,
    source.platformId,
    source.threadId ?? '',
    source.messageId,
    source.agentGroupId,
  ]
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `owner:${createHash('sha256').update(tuple).digest('hex').slice(0, 32)}`;
}

/**
 * Enqueue the owner's message. Throws if the durable insert fails (the caller
 * must not deliver the message in that case, so a retry of the same event
 * stays idempotent through the deterministic key). Returns the insert result.
 */
export async function fileOwnerStatement(args: {
  agentGroupId: string;
  sessionId: string;
  source: OwnerFilingSource;
  /** Shown in the filed block so the owner can find the message again. */
  perAgentMessageId: string;
  text: string;
}): Promise<'inserted' | 'exists' | 'quiesced'> {
  const result = await deps.enqueueMemoryOp({
    agentGroupId: args.agentGroupId,
    requestId: ownerFilingRequestId(args.source),
    sessionId: args.sessionId,
    kind: 'owner',
    path: OWNER_STATEMENTS_PATH,
    mode: 'append',
    content: args.text,
    ownerMessageId: args.perAgentMessageId,
  });
  if (result === 'quiesced') {
    log.warn('memory-gate: owner filing skipped while quiesced', { messageId: args.perAgentMessageId });
    try {
      await deps.notifyOwners(
        'Your "remember:" message was delivered but not filed: memory writes are paused for maintenance.',
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- a failed notice must not block delivery
    } catch (err) {
      log.warn('memory-gate: could not notify the owner about a skipped filing', { err });
    }
    return result;
  }
  if (result === 'inserted') kickCompletion();
  return result;
}

/** Fire-and-forget completion kick; the sweep is the durable path. */
export function kickCompletion(): void {
  void deps
    .completePendingOps()
    .catch((err) => log.warn('memory-gate: completion kick failed; the sweep will retry', { err }));
}
