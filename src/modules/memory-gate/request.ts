/**
 * Shape validation, the hold request, and the approved-replay wrapper for
 * `memory_write` (plan §4.3).
 *
 * Dependencies are injectable so the acceptance tests can fake the approval
 * primitive, the delivery adapter, and the ledger without touching Slack.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getPendingApprovalsByAction } from '../../db/sessions.js';
import { getDeliveryAdapter, reenterGuardedDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval, type ApprovalHandlerContext } from '../approvals/index.js';
import { getOwners } from '../permissions/db/user-roles.js';
import { MEMORY_WRITE_ACTION, requestSha } from './guard.js';
import { notifyOwners } from './notify.js';
import { completePendingOps, enqueueMemoryOp, getMemoryOp, OWNER_STATEMENTS_PATH } from './ops.js';
import { isQuiesced } from './quiesce.js';
import { CONTENT_MAX_BYTES, encodeVisible, QUESTION_MAX_CHARS, renderQuestion } from './render.js';

export class QuiescedError extends Error {
  constructor() {
    super('memory gate is quiesced');
    this.name = 'QuiescedError';
  }
}

export interface MemoryGateDeps {
  requestApproval: typeof requestApproval;
  notifyAgent: typeof notifyAgent;
  notifyOwners: typeof notifyOwners;
  getDeliveryAdapter: typeof getDeliveryAdapter;
  getOwners: typeof getOwners;
  getPendingApprovalsByAction: typeof getPendingApprovalsByAction;
  isQuiesced: typeof isQuiesced;
  enqueueMemoryOp: typeof enqueueMemoryOp;
  completePendingOps: typeof completePendingOps;
  getMemoryOp: typeof getMemoryOp;
}

const liveDeps: MemoryGateDeps = {
  requestApproval,
  notifyAgent,
  notifyOwners,
  getDeliveryAdapter,
  getOwners,
  getPendingApprovalsByAction,
  isQuiesced,
  enqueueMemoryOp,
  completePendingOps,
  getMemoryOp,
};

let deps: MemoryGateDeps = liveDeps;

/** Test seam. Pass nothing to restore the live dependencies. */
export function setMemoryGateDeps(overrides?: Partial<MemoryGateDeps>): void {
  deps = overrides ? { ...liveDeps, ...overrides } : liveDeps;
}

export function memoryGateDeps(): MemoryGateDeps {
  return deps;
}

const MODES = new Set(['replace', 'append', 'delete']);
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_PATH = 200;
const MAX_REQUEST_ID = 64;

/** Pure shape check: no filesystem, no database. Returns the refusal reason or null. */
export function shapeError(content: Record<string, unknown>): string | null {
  const requestId = content.request_id;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID) {
    return 'request_id must be a string of at most 64 characters';
  }
  const mode = content.mode;
  if (typeof mode !== 'string' || !MODES.has(mode)) return 'mode must be replace, append, or delete';
  const p = content.path;
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH) {
    return `path must be a relative markdown path of at most ${MAX_PATH} characters`;
  }
  if (p.startsWith('/') || p.includes('\\')) return 'path must be relative to memory/ and use forward slashes';
  const segments = p.split('/');
  if (segments.some((s) => s === '.' || s === '..' || !SEGMENT.test(s))) {
    return 'path segments may use only letters, digits, dot, underscore, and dash';
  }
  if (!p.endsWith('.md')) return 'path must end in .md';
  if (p === OWNER_STATEMENTS_PATH) return `${OWNER_STATEMENTS_PATH} is written only from Kobe's remember: messages`;
  if (mode === 'delete') {
    if (content.content !== undefined && content.content !== null) return 'delete takes no content';
    return null;
  }
  if (typeof content.content !== 'string') return 'content is required for replace and append';
  if (Buffer.byteLength(encodeVisible(content.content), 'utf8') > CONTENT_MAX_BYTES) {
    return `content exceeds ${CONTENT_MAX_BYTES} bytes in its visible form; split into smaller writes`;
  }
  return null;
}

/** Guard precheck: shape only, so a replay can never lose a tap to filesystem or database state. */
export async function validateShape(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const reason = shapeError(content);
  if (reason === null) return true;
  await deps.notifyAgent(session, `memory request denied: ${reason}`);
  return false;
}

/** Fresh dispatch only: card the owner with the complete content, then confirm the hold exists. */
export async function requestMemoryHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const path = content.path as string;
  const mode = content.mode as string;
  const requestId = content.request_id as string;
  const body = typeof content.content === 'string' ? content.content : '';

  if (await deps.isQuiesced()) {
    await deps.notifyAgent(session, 'memory writes are paused for maintenance; try later');
    return;
  }
  if (!deps.getDeliveryAdapter()) {
    await deps.notifyAgent(
      session,
      'memory_write could not be held right now (no delivery channel); retry in a minute',
    );
    return;
  }
  const owners = await deps.getOwners();
  if (owners.length === 0) {
    await deps.notifyAgent(session, 'memory_write could not be held: no owner is configured to approve it');
    return;
  }
  const agentGroup = await getAgentGroup(session.agent_group_id);
  const agentName = agentGroup?.name ?? session.agent_group_id;

  const encoded = encodeVisible(body);
  const bytes = Buffer.byteLength(body, 'utf8');
  const sha256 = requestSha(content);
  const question = renderQuestion({ agentName, path, mode, bytes, sha256, encoded });
  if (question.length >= QUESTION_MAX_CHARS) {
    await deps.notifyAgent(
      session,
      'memory request denied: the approval card would be too long; split into smaller writes',
    );
    return;
  }

  await deps.requestApproval({
    session,
    agentName,
    action: MEMORY_WRITE_ACTION,
    payload:
      mode === 'delete'
        ? { request_id: requestId, session_id: session.id, path, mode, sha256 }
        : { request_id: requestId, session_id: session.id, path, mode, content: body, sha256 },
    approverUserId: owners[0]!.user_id,
    title: `${agentName} wants to write memory`,
    question,
  });

  const rows = await deps.getPendingApprovalsByAction(MEMORY_WRITE_ACTION);
  const held = rows.some((row) => {
    if (row.session_id !== session.id) return false;
    try {
      return (JSON.parse(row.payload) as { request_id?: unknown }).request_id === requestId;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed row is simply not our hold
    } catch {
      return false;
    }
  });
  if (held) {
    await deps.notifyAgent(session, `memory_write held for Kobe's approval: ${path}`);
    return;
  }
  log.error('memory-gate: hold was requested but no pending approval exists', { sessionId: session.id, requestId });
  await deps.notifyAgent(
    session,
    `memory_write could not be held (no approver or no DM); ask Kobe directly. path=${path}`,
  );
}

const REPLAY_ATTEMPTS = 3;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Approved replay. The commit point is the durable op insert; a barrier
 * (quiesce) keeps the tap by returning `retained`; a repeated insert failure
 * with no op on record is reported as lost to both the agent and the owner.
 */
export async function retainingReplay(ctx: ApprovalHandlerContext): Promise<void | { outcome: 'retained' }> {
  const reenter = reenterGuardedDeliveryAction(MEMORY_WRITE_ACTION);
  let lastError: unknown;
  for (let attempt = 1; attempt <= REPLAY_ATTEMPTS; attempt += 1) {
    try {
      await reenter(ctx);
      return;
    } catch (err) {
      if (err instanceof QuiescedError) {
        // The approvals response handler owns the approved → pending transition.
        log.info('memory-gate: approval retained while quiesced', { approvalId: ctx.approval.approval_id });
        return { outcome: 'retained' };
      }
      lastError = err;
      log.warn('memory-gate: approved replay failed; retrying', { attempt, err });
      await delay(200 * attempt);
    }
  }
  const requestId = typeof ctx.payload.request_id === 'string' ? ctx.payload.request_id : '';
  if (requestId && (await deps.getMemoryOp(ctx.session.agent_group_id, requestId))) {
    log.warn('memory-gate: replay threw after the op was committed; the sweep will complete it', { requestId });
    return;
  }
  const path = typeof ctx.payload.path === 'string' ? ctx.payload.path : '?';
  log.error('memory-gate: approved write lost', { requestId, err: lastError });
  await deps.notifyAgent(
    ctx.session,
    `approved memory write was lost before it could be recorded; ask again. path=${path}`,
  );
  await deps.notifyOwners(
    `An approved memory write (${path}) was lost before it could be recorded; the agent will ask again.`,
  );
}
