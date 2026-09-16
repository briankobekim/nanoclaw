/**
 * Durable memory operation ledger and its completion (plan §4.3 "Enqueue and
 * complete", cases G10–G12).
 *
 * Every write to `groups/<folder>/memory/` is one row in `memory_write_ops`,
 * inserted through a single statement that the quiesce barrier can block.
 * `completePendingOps` finishes rows in creation order, serialized per group,
 * committing before/after hashes as `prepared` BEFORE the filesystem is
 * touched, so a crash anywhere is resolved exactly on the next tick: the file
 * already equals `after_sha256` → applied; still equals `before_sha256` →
 * mutate; anything else → conflict, never a second write.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { MemoryPreflightError, prepareMemoryRoot } from '../../memory-scaffold.js';
import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyOwners } from './notify.js';

export const OWNER_STATEMENTS_PATH = 'owner-statements.md';
export const MAX_ATTEMPTS = 10;
/** Sentinel recorded in before/after hashes when the target does not exist. */
export const ABSENT = 'absent';

export type MemoryOpKind = 'owner' | 'free';
export type MemoryOpMode = 'replace' | 'append' | 'delete';
export type MemoryOpStatus = 'queued' | 'prepared' | 'applied' | 'conflict' | 'abandoned';

export interface MemoryOpInput {
  agentGroupId: string;
  requestId: string;
  sessionId: string;
  kind: MemoryOpKind;
  path: string;
  mode: MemoryOpMode;
  content: string | null;
  ownerMessageId?: string | null;
}

export interface MemoryOpRow {
  agent_group_id: string;
  request_id: string;
  session_id: string;
  kind: MemoryOpKind;
  path: string;
  mode: MemoryOpMode;
  content: string | null;
  content_sha256: string;
  owner_message_id: string | null;
  before_sha256: string | null;
  after_sha256: string | null;
  status: MemoryOpStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

export interface CompletionDeps {
  notifyAgent(session: Session, text: string): Promise<void>;
  notifyOwner(text: string): Promise<void>;
  now(): Date;
}

/**
 * The approvals module is loaded lazily: its static graph reaches the router,
 * which imports this module's barrel, and that cycle must not run through
 * the ledger (every gate test and `request.ts` import this file directly).
 */
const liveDeps: CompletionDeps = {
  notifyAgent: async (session, text) => (await import('../approvals/index.js')).notifyAgent(session, text),
  notifyOwner: notifyOwners,
  now: () => new Date(),
};

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * `created_at` is the completion order within a group, so two ops enqueued in
 * the same millisecond must still sort in dispatch order.
 */
let lastCreatedMs = 0;
function nextCreatedAt(): string {
  let ms = Date.now();
  if (ms <= lastCreatedMs) ms = lastCreatedMs + 1;
  lastCreatedMs = ms;
  return new Date(ms).toISOString();
}

const INSERT_OP_SQL = `
  INSERT INTO memory_write_ops
    (agent_group_id, request_id, session_id, kind, path, mode, content, content_sha256, owner_message_id,
     status, attempts, created_at, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM memory_gate_state WHERE quiesced = 1)`;

/**
 * Insert one op as `queued`. The quiesce barrier is part of the statement, so
 * once the flag is set no insert can succeed however far a handler already got.
 * Returns `exists` for an identical row under the same key (idempotent retry),
 * throws for a same-key row with different content (conflicting reuse).
 */
export async function enqueueMemoryOp(input: MemoryOpInput): Promise<'inserted' | 'exists' | 'quiesced'> {
  const contentSha = sha256(input.content ?? '');
  const now = nextCreatedAt();
  let changes = 0;
  let raceError: unknown;
  try {
    ({ changes } = await getDb().run(
      INSERT_OP_SQL,
      input.agentGroupId,
      input.requestId,
      input.sessionId,
      input.kind,
      input.path,
      input.mode,
      input.content,
      contentSha,
      input.ownerMessageId ?? null,
      now,
      now,
    ));
  } catch (err) {
    // A concurrent identical insert may win the primary key; that is `exists`, not a failure.
    if (!isUniqueViolation(err)) throw err;
    raceError = err;
  }
  if (changes === 1) return 'inserted';

  const existing = await getMemoryOp(input.agentGroupId, input.requestId);
  if (!existing) {
    if (raceError) throw raceError;
    return 'quiesced';
  }
  // Only the identical op, from the same session, still live or applied, is
  // this request already on record. A same-key row with another payload, from
  // another session, or terminally failed is a conflicting reuse of the id.
  const identical =
    existing.kind === input.kind &&
    existing.session_id === input.sessionId &&
    existing.path === input.path &&
    existing.mode === input.mode &&
    existing.content_sha256 === contentSha &&
    (existing.status === 'queued' || existing.status === 'prepared' || existing.status === 'applied');
  if (identical) return 'exists';
  throw new Error(`memory op ${input.agentGroupId}/${input.requestId} already exists with different content`);
}

export async function getMemoryOp(agentGroupId: string, requestId: string): Promise<MemoryOpRow | undefined> {
  return getDb().get<MemoryOpRow>(
    'SELECT * FROM memory_write_ops WHERE agent_group_id = ? AND request_id = ?',
    agentGroupId,
    requestId,
  );
}

export async function listOps(status?: MemoryOpStatus): Promise<MemoryOpRow[]> {
  if (status) {
    return getDb().all<MemoryOpRow>(
      'SELECT * FROM memory_write_ops WHERE status = ? ORDER BY created_at, agent_group_id, request_id',
      status,
    );
  }
  return getDb().all<MemoryOpRow>('SELECT * FROM memory_write_ops ORDER BY created_at, agent_group_id, request_id');
}

/** The provenance block appended to owner-statements.md for a `remember:` message. */
export function formatOwnerBlock(args: { date: string; messageId: string; text: string }): string {
  const body = args.text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return `\n- ${args.date} Kobe wrote (msg ${args.messageId}):\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Per-group promise chains: ops of one group never run concurrently within
 * this process, and a call that queues behind another re-reads the pending
 * rows when its turn comes, so no op is processed twice.
 */
const groupChains = new Map<string, Promise<void>>();

function withGroupLock(groupId: string, fn: () => Promise<void>): Promise<void> {
  const prev = groupChains.get(groupId) ?? Promise.resolve();
  const run = prev.then(fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  groupChains.set(groupId, settled);
  void settled.then(() => {
    if (groupChains.get(groupId) === settled) groupChains.delete(groupId);
  });
  return run;
}

/** Process every `queued` or `prepared` op, in creation order, serialized per group. */
export async function completePendingOps(deps: CompletionDeps = liveDeps): Promise<void> {
  const groups = await getDb().all<{ agent_group_id: string }>(
    "SELECT DISTINCT agent_group_id FROM memory_write_ops WHERE status IN ('queued', 'prepared') ORDER BY agent_group_id",
  );
  await Promise.all(
    groups.map(({ agent_group_id }) =>
      // One group's failure must not stop the others; the sweep retries next tick.
      withGroupLock(agent_group_id, () => completeGroup(agent_group_id, deps)).catch((err: unknown) => {
        log.error('memory-gate: group completion failed', { agentGroupId: agent_group_id, err });
      }),
    ),
  );
}

async function pendingOpsFor(groupId: string): Promise<MemoryOpRow[]> {
  return getDb().all<MemoryOpRow>(
    `SELECT * FROM memory_write_ops WHERE agent_group_id = ? AND status IN ('queued', 'prepared')
     ORDER BY created_at, request_id`,
    groupId,
  );
}

/** Temp file name for an op: deterministic, so a crash between write and rename leaves nothing anonymous. */
function tempPathFor(abs: string, op: MemoryOpRow): string {
  const tag = sha256(`${op.agent_group_id}\n${op.request_id}`).slice(0, 8);
  return path.join(path.dirname(abs), `${path.basename(abs)}.mg-${tag}.tmp`);
}

/**
 * Remove the temp file of each pending op that a crash between the temp
 * write and the rename may have left behind. Only the exact, ledger-derived
 * path of each op is touched (and only when it is a regular file): the host
 * never deletes a file it cannot prove it created, whatever its name.
 */
function removeOpTemps(memoryRoot: string, ops: MemoryOpRow[]): void {
  for (const op of ops) {
    const target = resolveTarget(memoryRoot, op.path);
    if (!target.ok) continue;
    const tmp = tempPathFor(target.abs, op);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(tmp);
      // eslint-disable-next-line no-catch-all/no-catch-all -- absent is the normal case; anything else is logged and left alone
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('memory-gate: could not inspect an op temp path', { file: tmp, err });
      }
      continue;
    }
    if (!st.isFile()) continue;
    log.warn('memory-gate: removing the temp file left by an interrupted write', {
      file: tmp,
      agentGroupId: op.agent_group_id,
      requestId: op.request_id,
    });
    removeQuietly(tmp);
  }
}

/** The live target no longer matches what the ledger recorded: the op becomes a conflict, never a write. */
class TargetChangedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TargetChangedError';
  }
}

async function completeGroup(groupId: string, deps: CompletionDeps): Promise<void> {
  const ops = await pendingOpsFor(groupId);
  if (ops.length === 0) return;

  const group = await getAgentGroup(groupId);
  if (!group) {
    for (const op of ops) await markConflict(op, 'agent group not found', deps, { notify: false });
    return;
  }
  // The same preflight the spawn runs: lstat walk (no symlink anywhere, real
  // directory beneath the real group dir, no hard links) and scaffolding of a
  // missing tree. Owner filing can kick completion before the group's first
  // spawn, so this must not depend on the spawn having run. A refusal leaves
  // every op queued for the next tick (the spawn preflight tells the owner);
  // it is never a conflict.
  let memoryRoot: string;
  try {
    memoryRoot = await prepareMemoryRoot(path.join(GROUPS_DIR, group.folder), {
      notifyOwner: async () => undefined,
    });
  } catch (err) {
    if (err instanceof MemoryPreflightError) {
      log.error('memory-gate: memory root refused by preflight; ops stay queued', { agentGroupId: groupId, err });
      return;
    }
    throw err;
  }

  removeOpTemps(memoryRoot, ops);

  for (const op of ops) {
    try {
      await completeOne(op, memoryRoot, deps);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a database or unexpected error leaves the row as it is; the next tick retries
    } catch (err) {
      log.error('memory-gate: op completion failed', {
        agentGroupId: op.agent_group_id,
        requestId: op.request_id,
        path: op.path,
        err,
      });
    }
    // Creation order is the contract: if this op is still pending after its
    // attempt, a later op must not overtake it (two appends to one file would
    // otherwise land out of order and turn the earlier one into a conflict).
    const after = await getMemoryOp(op.agent_group_id, op.request_id);
    if (after && (after.status === 'queued' || after.status === 'prepared')) {
      log.warn('memory-gate: earlier op still pending; later ops of the group wait for the next tick', {
        agentGroupId: op.agent_group_id,
        requestId: op.request_id,
      });
      return;
    }
  }
}

type Target = { ok: true; abs: string } | { ok: false; reason: string };

/**
 * Resolve `rel` under the group's real memory root on the LIVE filesystem:
 * every intermediate must be a real directory (lstat, so a symlink fails), the
 * leaf must be absent or a regular file, and the joined path must sit under
 * the root. No component is ever followed, so nothing can redirect the write.
 */
function resolveTarget(memoryRoot: string, rel: string): Target {
  const segments = rel.split('/');
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, reason: `path is not a clean relative path: ${rel}` };
  }
  let dir = memoryRoot;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
      // eslint-disable-next-line no-catch-all/no-catch-all -- any lstat failure on a component means the path cannot be verified: conflict, never a write
    } catch (err) {
      return { ok: false, reason: `parent directory missing: ${errorMessage(err)}` };
    }
    if (!st.isDirectory()) return { ok: false, reason: `path component is not a real directory: ${segment}` };
  }
  const abs = path.join(dir, segments[segments.length - 1]!);
  if (!abs.startsWith(memoryRoot + path.sep)) return { ok: false, reason: `path escapes memory root: ${rel}` };
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return { ok: false, reason: 'target exists and is not a regular file' };
    // eslint-disable-next-line no-catch-all/no-catch-all -- only ENOENT means absent; every other lstat failure is reported as a conflict reason
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, reason: `target not readable: ${errorMessage(err)}` };
    }
  }
  return { ok: true, abs };
}

function readCurrent(abs: string): Buffer | null {
  try {
    return fs.readFileSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function stateOf(bytes: Buffer | null): string {
  return bytes === null ? ABSENT : sha256(bytes);
}

/** The bytes the file will hold after the op, or null for a delete. */
function plannedResult(op: MemoryOpRow, existing: Buffer | null): Buffer | null {
  if (op.mode === 'delete') return null;
  if (op.mode === 'replace') return Buffer.from(op.content ?? '', 'utf8');
  // The owner block is dated by the op's own creation (the moment the message
  // was filed), which keeps the planned bytes stable across retries.
  const payload =
    op.kind === 'owner'
      ? formatOwnerBlock({
          date: op.created_at.slice(0, 10),
          messageId: op.owner_message_id ?? '',
          text: op.content ?? '',
        })
      : (op.content ?? '');
  const parts: Buffer[] = [];
  if (existing && existing.length > 0) {
    parts.push(existing);
    if (existing[existing.length - 1] !== 0x0a) parts.push(Buffer.from('\n'));
  }
  parts.push(Buffer.from(payload, 'utf8'));
  return Buffer.concat(parts);
}

async function completeOne(op: MemoryOpRow, memoryRoot: string, deps: CompletionDeps): Promise<void> {
  const target = resolveTarget(memoryRoot, op.path);
  if (!target.ok) {
    await markConflict(op, target.reason, deps);
    return;
  }
  const existing = readCurrent(target.abs);
  const current = stateOf(existing);
  let planned: Buffer | null;
  let attempts: number;

  if (op.status === 'prepared') {
    if (op.after_sha256 !== null && current === op.after_sha256) {
      // A previous attempt already mutated (a completed delete included).
      await markApplied(op, op.attempts, deps);
      return;
    }
    if (current !== op.before_sha256) {
      await markConflict(op, `file changed since prepare: before_sha256 ${op.before_sha256}, now ${current}`, deps);
      return;
    }
    planned = plannedResult(op, existing);
    const after = planned === null ? ABSENT : sha256(planned);
    if (after !== op.after_sha256) {
      await markConflict(op, `planned result no longer matches after_sha256 ${op.after_sha256}`, deps);
      return;
    }
    attempts = op.attempts + 1;
    await getDb().run(
      `UPDATE memory_write_ops SET attempts = ?, updated_at = ?
       WHERE agent_group_id = ? AND request_id = ? AND status = 'prepared'`,
      attempts,
      deps.now().toISOString(),
      op.agent_group_id,
      op.request_id,
    );
  } else {
    if (op.mode === 'delete' && existing === null) {
      await markConflict(op, 'delete target does not exist', deps);
      return;
    }
    planned = plannedResult(op, existing);
    const after = planned === null ? ABSENT : sha256(planned);
    attempts = op.attempts + 1;
    // Commit both hashes BEFORE any filesystem mutation.
    const result = await getDb().run(
      `UPDATE memory_write_ops SET status = 'prepared', before_sha256 = ?, after_sha256 = ?, attempts = ?, updated_at = ?
       WHERE agent_group_id = ? AND request_id = ? AND status = 'queued'`,
      current,
      after,
      attempts,
      deps.now().toISOString(),
      op.agent_group_id,
      op.request_id,
    );
    if (result.changes !== 1) {
      log.warn('memory-gate: op left queued state before prepare; skipping', {
        agentGroupId: op.agent_group_id,
        requestId: op.request_id,
      });
      return;
    }
  }

  // Re-verified IMMEDIATELY before the rename or unlink: every path component
  // is resolved again and the live bytes must still be the recorded before
  // state, so an edit that landed while the hashes were being committed (or
  // while the temp file was written) turns the op into a conflict instead of
  // being overwritten or deleted. (§4.3 step 4.)
  const recheck = (): string | null => {
    const again = resolveTarget(memoryRoot, op.path);
    if (!again.ok) return again.reason;
    if (again.abs !== target.abs) return `target path resolved differently: ${again.abs}`;
    const live = stateOf(readCurrent(again.abs));
    if (live !== current) return `file changed since prepare: before_sha256 ${current}, now ${live}`;
    return null;
  };
  try {
    mutate(target.abs, planned, tempPathFor(target.abs, op), recheck);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a changed target is a conflict; every other filesystem failure is one failed attempt, retried by the sweep
  } catch (err) {
    if (err instanceof TargetChangedError) {
      await markConflict(op, err.message, deps);
      return;
    }
    await failAttempt(op, attempts, err, deps);
    return;
  }
  await markApplied(op, attempts, deps);
}

/**
 * replace/append: the op's own temp file in the same directory, then rename
 * over the target; delete: unlink. `recheck` runs right before the rename or
 * unlink and returns a reason when the target no longer matches the ledger.
 */
function mutate(abs: string, planned: Buffer | null, tmp: string, recheck: () => string | null): void {
  if (planned === null) {
    const changed = recheck();
    if (changed !== null) throw new TargetChangedError(changed);
    fs.unlinkSync(abs);
    fsyncDirectory(path.dirname(abs));
    return;
  }
  removeQuietlyIfPresent(tmp);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tmp, flags, 0o644);
  try {
    let offset = 0;
    while (offset < planned.length) offset += fs.writeSync(fd, planned, offset, planned.length - offset);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    removeQuietly(tmp);
    throw err;
  }
  fs.closeSync(fd);
  try {
    const changed = recheck();
    if (changed !== null) throw new TargetChangedError(changed);
    fs.renameSync(tmp, abs);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  fsyncDirectory(path.dirname(abs));
}

/**
 * Make a rename or unlink durable before the op is marked `applied`: the
 * directory entry lives in the parent's metadata, which a crash can lose even
 * after the file's own fsync. A failure here is one failed attempt; the next
 * tick sees the file already at `after_sha256` and marks the op applied.
 */
function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeQuietlyIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
    // eslint-disable-next-line no-catch-all/no-catch-all -- temp-file cleanup is best effort after a failed write
  } catch (err) {
    log.warn('memory-gate: could not remove temp file', { file, err });
  }
}

async function markApplied(op: MemoryOpRow, attempts: number, deps: CompletionDeps): Promise<void> {
  const now = deps.now().toISOString();
  await getDb().run(
    `UPDATE memory_write_ops SET status = 'applied', attempts = ?, applied_at = ?, updated_at = ?, last_error = NULL
     WHERE agent_group_id = ? AND request_id = ?`,
    attempts,
    now,
    now,
    op.agent_group_id,
    op.request_id,
  );
  log.info('memory-gate: applied', {
    agentGroupId: op.agent_group_id,
    requestId: op.request_id,
    kind: op.kind,
    path: op.path,
    mode: op.mode,
    attempts,
  });
  await tellAgent(op, `memory written: ${op.path}`, deps);
}

async function markConflict(
  op: MemoryOpRow,
  reason: string,
  deps: CompletionDeps,
  { notify = true }: { notify?: boolean } = {},
): Promise<void> {
  await getDb().run(
    `UPDATE memory_write_ops SET status = 'conflict', last_error = ?, updated_at = ?
     WHERE agent_group_id = ? AND request_id = ?`,
    reason,
    deps.now().toISOString(),
    op.agent_group_id,
    op.request_id,
  );
  log.warn('memory-gate: conflict', {
    agentGroupId: op.agent_group_id,
    requestId: op.request_id,
    path: op.path,
    reason,
  });
  if (notify) await tellAgent(op, `memory write conflict: ${op.path} (${reason}); nothing was written`, deps);
}

async function failAttempt(op: MemoryOpRow, attempts: number, err: unknown, deps: CompletionDeps): Promise<void> {
  const message = errorMessage(err);
  const now = deps.now().toISOString();
  if (attempts >= MAX_ATTEMPTS) {
    await getDb().run(
      `UPDATE memory_write_ops SET status = 'abandoned', last_error = ?, updated_at = ?
       WHERE agent_group_id = ? AND request_id = ?`,
      message,
      now,
      op.agent_group_id,
      op.request_id,
    );
    log.error('memory-gate: abandoned after repeated write failures', {
      agentGroupId: op.agent_group_id,
      requestId: op.request_id,
      path: op.path,
      attempts,
      err,
    });
    const text = `memory write abandoned after ${MAX_ATTEMPTS} attempts: ${op.agent_group_id}/${op.path}`;
    await tellAgent(op, text, deps);
    try {
      await deps.notifyOwner(text);
      // eslint-disable-next-line no-catch-all/no-catch-all -- notices never propagate; the ledger row is already final
    } catch (notifyErr) {
      log.warn('memory-gate: owner notice failed', { requestId: op.request_id, err: notifyErr });
    }
    return;
  }
  await getDb().run(
    `UPDATE memory_write_ops SET last_error = ?, updated_at = ?
     WHERE agent_group_id = ? AND request_id = ? AND status = 'prepared'`,
    message,
    now,
    op.agent_group_id,
    op.request_id,
  );
  log.warn('memory-gate: write attempt failed; will retry', {
    agentGroupId: op.agent_group_id,
    requestId: op.request_id,
    path: op.path,
    attempts,
    err,
  });
  await tellAgent(op, 'memory write attempt failed; will retry', deps);
}

/** Notices are best effort: a missing session skips, a throwing notifier is logged. */
async function tellAgent(op: MemoryOpRow, text: string, deps: CompletionDeps): Promise<void> {
  try {
    const session = await getSession(op.session_id);
    if (!session) {
      log.debug('memory-gate: no session for notice', { requestId: op.request_id, sessionId: op.session_id });
      return;
    }
    await deps.notifyAgent(session, text);
    // eslint-disable-next-line no-catch-all/no-catch-all -- notices never propagate; a failed notice is logged and the ledger row stands
  } catch (err) {
    log.warn('memory-gate: agent notice failed', { requestId: op.request_id, sessionId: op.session_id, err });
  }
}
