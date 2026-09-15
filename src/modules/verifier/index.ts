/**
 * Host-side bounded verifier: one disposable container per CHECK.
 *
 * Given only a `handoff_id` from the reviewing agent's own session, the host
 * loads that handoff and its captured verification inputs from trusted state,
 * re-validates both fingerprints, resolves the project's repository through the
 * mount allowlist, FREEZES the CHECKS list and its per-command hashes, exports
 * the exact checkpoint once to a throwaway tar, and then runs each frozen CHECK
 * in its own hardened, offline, read-only container with fresh tmpfs — removing
 * that container and CONFIRMING its removal before the next CHECK starts.
 *
 * Isolation between CHECKS comes from the kernel. When a container is removed,
 * every process in its PID namespace is killed and its tmpfs is discarded: no
 * process, file or service can carry into the next CHECK. That is why removal
 * is not a cleanup step here but a precondition for continuing — if docker will
 * not confirm the container is gone, the run stops and the remaining checks are
 * recorded as `not_run`.
 *
 * Three things never cross the boundary. The repository never enters a
 * container (only a `git archive` of one commit does); the command text never
 * enters argv or env (it is written to stdin from the host's frozen list); and
 * nothing a container prints is read when deriving the verdict.
 *
 * Three things are re-proved rather than assumed:
 *
 *  - that each container actually got as far as running the CHECK, by a
 *    per-container nonce the gate script echoes back before it execs (see
 *    `classifyHandshake`). Without it, `exit 125` is ambiguous between "the
 *    check said 125" and "the daemon started nothing";
 *  - that the run is still inside its budget, against a MONOTONIC clock started
 *    before the first ledger read and consulted at every step (`Deadline`);
 *  - that the handoff still carries the authority the run began with, by
 *    comparing both trusted rows to a preflight snapshot before every container
 *    and before the verdict (`revalidateIdentity`).
 *
 * One precedence order governs all of it, stated once in `stopReasonFor` and
 * again in `deriveVerdict`: deadline > infrastructure > timed_out > check_failed.
 *
 * See `checks-schema.ts` for the trusted-input contract and `docker.ts` for the
 * argv and removal contracts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR } from '../../config.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/primitive.js';
import {
  fingerprintOfRow,
  fingerprintVerificationInputs,
  getHandoff,
  getVerificationInputs,
  type HandoffRow,
  type VerificationInputsRow,
} from '../handoff-ledger/ledger.js';
import { parseVerificationInputs, type VerificationInputs } from './checks-schema.js';
import { loadVerifierConfig, type VerifierConfig } from './config.js';
import {
  buildCheckArgv,
  classifyHandshake,
  containerNameFor,
  execNoShell,
  newCheckNonce,
  newRunId,
  realRunDocker,
  removeContainerConfirmed,
  DEFAULT_EXEC_TIMEOUT_MS,
  GIT_EXEC_TIMEOUT_MS,
  type DockerRunner,
  type ExecRunner,
} from './docker.js';
import './migration.js';
import {
  appendVerificationEvent,
  deriveVerdict,
  emptyCheckRecord,
  frozenChecksSha256,
  sha256File,
  sha256Hex,
  writeResolvedPersistence,
  writeVerificationRecord,
  type CheckRecord,
  type ErrorReason,
  type Verdict,
  type VerificationEventType,
  type VerificationRecord,
  type WriteRecordInput,
} from './record.js';

/**
 * A handoff id must start with an alphanumeric and may then use only
 * `[A-Za-z0-9._-]`, to 64 characters. The leading-alphanumeric rule is what
 * keeps `.`, `..`, `.hidden` and `-anything` out; the length cap keeps the run
 * directory name and the container name bounded.
 */
export const HANDOFF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const HANDOFF_ID_RULE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';

/** The one gate script. `verify.sh` and `run.sh` are retired and must be absent. */
export const GATE_SCRIPT = 'run-check.sh';
export const LEGACY_GATE_SCRIPTS = ['verify.sh', 'run.sh'];
export const LEGACY_GATE_REFUSAL = 'legacy_gate_scripts_present';

/**
 * Below this much time left on the overall deadline, starting another check
 * would be dishonest: it could not complete, and a one-second container is a
 * timeout dressed up as a result. Stop instead, and say `deadline`.
 */
export const MIN_REMAINING_SECONDS = 1;

/**
 * A mandatory removal is never skipped because the clock ran out: a container
 * we cannot prove gone is a worse outcome than a verdict that arrives late. So
 * the removal calls are bounded by `max(this, min(default, remaining))`, which
 * means they may finish AFTER the overall deadline. When that happens the
 * deadline check that follows still fires and the verdict is `deadline`.
 */
export const REMOVAL_MIN_BOUND_MS = 5_000;

/**
 * The one overall clock.
 *
 * It is monotonic (`process.hrtime.bigint`), not `Date.now`, because the thing
 * it bounds is "how long this run may take" and a wall clock can be stepped
 * backwards by NTP or a laptop waking up — which would silently EXTEND the
 * budget of a run that is executing agent-authored commands. The wall clock is
 * still what the record's timestamps are made of; it just does not decide when
 * to stop.
 */
export interface Deadline {
  /** Milliseconds left, truncated toward zero; negative once it has passed. */
  remainingMs(): number;
  /** `min(defaultMs, remaining)`, floored at 1 ms so it is never "unbounded". */
  bound(defaultMs: number): number;
  /** The bound for a mandatory removal: never below `REMOVAL_MIN_BOUND_MS`. */
  removalBound(): number;
  expired(): boolean;
}

export function createDeadline(wallSeconds: number, monotonicNs: () => bigint): Deadline {
  const deadlineAt = monotonicNs() + BigInt(Math.round(wallSeconds * 1000)) * 1_000_000n;
  const remainingMs = (): number => Number((deadlineAt - monotonicNs()) / 1_000_000n);
  return {
    remainingMs,
    // `execFile` treats a timeout of 0 as "no timeout", so the floor is 1 ms:
    // an operation started with no budget left must fail fast, not run free.
    bound: (defaultMs) => Math.max(1, Math.min(defaultMs, remainingMs())),
    removalBound: () => Math.max(REMOVAL_MIN_BOUND_MS, Math.min(DEFAULT_EXEC_TIMEOUT_MS, remainingMs())),
    expired: () => remainingMs() <= 0,
  };
}

/**
 * Defence in depth: the regex already rejects every traversal we know of, and
 * then we resolve the id against the directory it would become a child of and
 * require the result to be strictly inside. Two independent reasons to refuse
 * beat one clever regex.
 */
export function isSafeHandoffId(value: unknown, base: string): value is string {
  if (typeof value !== 'string') return false;
  if (value === '.' || value === '..') return false;
  if (!HANDOFF_ID_PATTERN.test(value)) return false;
  const root = path.resolve(base);
  const resolved = path.resolve(root, value);
  return resolved !== root && resolved.startsWith(root + path.sep);
}

export interface VerifierDeps {
  configPath?: string;
  dataDir: string;
  /** Directory holding the fixed gate script; only the FILE inside it is mounted. */
  gateDir: string;
  /**
   * Parent of the throwaway `mkdtemp` archive directory. Only a test sets it,
   * so that "nothing was left behind" is an assertion about THIS run's
   * directory rather than about everything in the system temp directory.
   */
  tmpRoot?: string;
  runDocker: DockerRunner;
  exec: ExecRunner;
  resolveImageRef: (agentGroupId: string) => Promise<string>;
  /** Test seam: the wall clock the record's timestamps are made of. */
  now?: () => number;
  /** Test seam: the MONOTONIC clock the overall deadline is measured against. */
  monotonicNs?: () => bigint;
}

export function defaultVerifierDeps(): VerifierDeps {
  return {
    dataDir: DATA_DIR,
    gateDir: path.join(process.cwd(), 'projects', 'echo'),
    runDocker: realRunDocker,
    exec: execNoShell,
    // Same resolution container-runner does: the group's built image, else the
    // install default. Never a name that arrived in the request.
    resolveImageRef: async (agentGroupId) => (await getContainerConfig(agentGroupId))?.image_tag || CONTAINER_IMAGE,
  };
}

/**
 * One verification per reviewer group at a time, in this process. Deliberately
 * NOT a lock file: a stale file on disk is a second failure mode, and a second
 * host process would be a bigger problem than a queued review.
 */
const inFlight = new Map<string, true>();

function emptyRecord(handoffId: string, at: string): VerificationRecord {
  return {
    handoff_id: handoffId,
    ledger_fingerprint: null,
    inputs_fingerprint: null,
    project: null,
    host_path: null,
    checkpoint: null,
    archive_sha256: null,
    archive_bytes: null,
    class: null,
    image_ref: null,
    image_id: null,
    image_digests: null,
    gate_run_check_sha256: null,
    host_uid: process.getuid?.() ?? null,
    host_gid: process.getgid?.() ?? null,
    run_id: null,
    started_at: at,
    finished_at: at,
    wall_seconds: 0,
    deadline_seconds: null,
    frozen_checks: [],
    frozen_checks_sha256: null,
    checks: [],
    reproduce: [],
    verdict: null,
    error_reason: null,
    invalid_input_detail: null,
    refusal_reason: null,
    // Resolved in `persistence.json`; see the field's contract in record.ts.
    persistence: { filesystem: 'ok', ledger_event: 'pending' },
  };
}

export type PersistenceState = 'ok' | 'failed';

/**
 * Which halves of "this run was recorded" actually happened.
 *
 * They are reported separately because they fail separately and mean different
 * things: a failed filesystem write means there is no evidence to cite at all,
 * while a failed ledger event means the evidence exists on disk but nothing in
 * the handoff's history points at it.
 */
export interface PersistenceStatus {
  filesystem: PersistenceState;
  ledger_event: PersistenceState;
}

export interface RunChecksOutcome {
  /**
   * The host-derived verdict, or `REFUSED` when a precondition stopped the run
   * before the overall deadline started.
   */
  verdict: Verdict | 'REFUSED';
  error_reason: ErrorReason | null;
  /** NULL whenever the record was not fully written. Never a hash of nothing. */
  record_sha256: string | null;
  run_dir: string | null;
  persistence: PersistenceStatus;
  /** Every persistence failure, in the words the reviewing agent was given. */
  errors: string[];
  /** The per-CHECK rows exactly as they went into the record. */
  checks: CheckRecord[];
  checks_ran: number;

  refused: boolean;
  reason?: string;
  /** Aliases of `run_dir` / `record_sha256`. */
  runDir?: string;
  recordSha256?: string;
}

interface Persisted {
  runDir: string | null;
  recordSha256: string | null;
  persistence: PersistenceStatus;
  errors: string[];
}

/**
 * Write the record and append the ledger event, reporting BOTH outcomes.
 *
 * Neither failure is swallowed and neither aborts the other: a disk that is
 * full should still leave a ledger event saying so, and a broken ledger should
 * still leave the evidence on disk. What must never happen is a success-shaped
 * message about a run that was not recorded — so `recordSha256` stays null
 * unless `writeVerificationRecord` returned, and the ledger payload carries
 * that same null.
 */
async function persistRun(
  write: WriteRecordInput,
  event: { handoffId: string; payload: Record<string, unknown>; eventType: VerificationEventType } | null,
): Promise<Persisted> {
  const errors: string[] = [];
  const persistence: PersistenceStatus = { filesystem: 'ok', ledger_event: 'ok' };
  let runDir: string | null = null;
  let recordSha256: string | null = null;

  try {
    const written = await writeVerificationRecord(write);
    runDir = written.runDir;
    recordSha256 = written.recordSha256;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a record we cannot write is reported, never swallowed
  } catch (err) {
    persistence.filesystem = 'failed';
    errors.push(`filesystem: ${err instanceof Error ? err.message : String(err)}`);
    log.error('verifier: could not write the evidence record', { handoffId: write.handoffId, err });
  }

  if (event) {
    try {
      await appendVerificationEvent(
        event.handoffId,
        { ...event.payload, record_sha256: recordSha256, run_dir: runDir },
        event.eventType,
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- a ledger event we cannot write is reported, never swallowed
    } catch (err) {
      persistence.ledger_event = 'failed';
      errors.push(`ledger_event: ${err instanceof Error ? err.message : String(err)}`);
      log.error('verifier: could not append the verification event', { handoffId: event.handoffId, err });
    }
  }

  // The resolved answer, beside the record, for whoever reads the run directory
  // later. `record.sha256` is over record.json's bytes only, so this sibling
  // cannot disturb the hash the review quotes.
  if (runDir) {
    const wrote = writeResolvedPersistence(runDir, {
      ...persistence,
      errors,
      resolved_at: new Date().toISOString(),
    });
    if (!wrote) log.warn('verifier: could not write persistence.json', { handoffId: write.handoffId, runDir });
  }

  return { runDir, recordSha256, persistence, errors };
}

/** The lines the reviewing agent must see when persistence did not fully succeed. */
function persistenceReport(p: Persisted): string[] {
  const lines: string[] = [];
  if (p.persistence.filesystem === 'failed') {
    lines.push('filesystem persistence FAILED: no evidence record was written to disk, so there is no record_sha256');
  }
  if (p.persistence.ledger_event === 'failed') {
    lines.push('ledger event persistence FAILED: this run is NOT referenced from the handoff ledger');
  }
  for (const err of p.errors) lines.push(`  ${err}`);
  if (lines.length > 0) lines.push('Do not cite this run as recorded evidence.');
  return lines;
}

/**
 * `c<i> <status> exit=<n|-> timed_out=<b> removed=<b> sha256=<12>`, with
 * ` handshake=<missing|mismatch>` appended only when the container failed to
 * prove it had set itself up — the one case where the exit code on the same
 * line must NOT be read as the check's own.
 */
function checkLine(check: CheckRecord): string {
  const exit = check.exit_code === null ? '-' : String(check.exit_code);
  const handshake = check.handshake && check.handshake !== 'ok' ? ` handshake=${check.handshake}` : '';
  return (
    `c${check.index} ${check.status} exit=${exit} timed_out=${check.timed_out} ` +
    `removed=${check.removal_confirmed} sha256=${check.command_sha256.slice(0, 12)}${handshake}`
  );
}

// ---------------------------------------------------------------------------
// Handoff lifecycle revalidation.
//
// The precondition ladder proves, once, that this handoff is a `delivered`
// handoff from the configured source to the configured reviewer, carrying these
// commands against this checkpoint. A run then takes minutes, and every one of
// those facts lives in a database another process can write. Echo can mark the
// handoff `changes_required` halfway through; a compromised writer can repoint
// `project`; either would leave the verifier executing commands under an
// authority that has been withdrawn.
//
// So the trusted identity is SNAPSHOTTED at preflight and compared again
// immediately before every container and before the verdict. It is a snapshot
// of names and hashes only — no command text is re-read from it — and any
// difference at all stops the run.
// ---------------------------------------------------------------------------

/** The trusted identity, frozen at preflight. Field names are the record's detail. */
export interface IdentitySnapshot {
  status: string;
  source_agent_group_id: string;
  reviewer_agent_group_id: string;
  project: string;
  goal: string;
  outcome: string;
  scope: string;
  authority: string;
  fingerprint: string;
  inputs_fingerprint: string;
  checkpoint: string;
  checks_json: string;
  class: string;
}

function snapshotIdentity(row: HandoffRow, inputsRow: VerificationInputsRow): IdentitySnapshot {
  return {
    status: row.status,
    source_agent_group_id: row.source_agent_group_id,
    reviewer_agent_group_id: row.reviewer_agent_group_id,
    project: row.project,
    goal: row.goal,
    outcome: row.outcome,
    scope: row.scope,
    authority: row.authority,
    fingerprint: row.fingerprint,
    inputs_fingerprint: inputsRow.inputs_fingerprint,
    checkpoint: inputsRow.checkpoint,
    checks_json: inputsRow.checks_json,
    class: inputsRow.class,
  };
}

/**
 * The delivery-action handler. Exported (with injectable deps) so the tests
 * drive the real precondition ladder against a fake docker runner.
 */
export async function runChecksAction(
  content: Record<string, unknown>,
  session: Session,
  deps: VerifierDeps = defaultVerifierDeps(),
): Promise<RunChecksOutcome> {
  // The id becomes one path segment under the evidence root, so it is checked
  // against that exact root as well as against the pattern.
  const evidenceRoot = path.join(deps.dataDir, 'evidence');
  const rawId = content.handoff_id;
  const handoffId = isSafeHandoffId(rawId, evidenceRoot) ? rawId : null;

  // A run directory is named after the id, so an id we would not put in a path
  // gets a fixed stand-in rather than a sanitized version of itself.
  const recordId = handoffId ?? 'malformed-handoff-id';

  const refuse = async (
    reason: string,
    partial?: Partial<VerificationRecord>,
    groupDir?: string,
  ): Promise<RunChecksOutcome> => {
    const at = new Date().toISOString();
    const record: VerificationRecord = { ...emptyRecord(recordId, at), ...partial, refusal_reason: reason };

    // A refusal is evidence too: it gets the same record and the same ledger
    // event as a completed run, under its own event type, and the same
    // unswallowed report of whether either actually landed.
    const persisted = await persistRun(
      {
        dataDir: deps.dataDir,
        reviewerGroupId: groupDir ?? session.agent_group_id,
        handoffId: recordId,
        runTimestamp: at,
        record,
        checkOutputs: [],
      },
      handoffId && partial?.ledger_fingerprint !== undefined
        ? {
            handoffId,
            eventType: 'verification_refused',
            payload: { verdict: null, error_reason: null, checks_ran: 0, refusal_reason: reason },
          }
        : null,
    );

    log.warn('verifier: run_checks refused', { handoffId: recordId, reason, sessionId: session.id });
    await notifyAgent(session, [`run_checks refused: ${reason}`, ...persistenceReport(persisted)].join('\n'));
    return {
      refused: true,
      reason,
      verdict: 'REFUSED',
      error_reason: null,
      record_sha256: persisted.recordSha256,
      run_dir: persisted.runDir,
      persistence: persisted.persistence,
      errors: persisted.errors,
      checks: [],
      checks_ran: 0,
      runDir: persisted.runDir ?? undefined,
      recordSha256: persisted.recordSha256 ?? undefined,
    };
  };

  if (!handoffId) return refuse(`handoff_id must match ${HANDOFF_ID_RULE}`);

  // Only `handoff_id` is accepted. Anything else is an attempt to steer the
  // run, and there is no field we would honour.
  const extras = Object.keys(content).filter((key) => key !== 'handoff_id' && key !== 'action');
  if (extras.length > 0) return refuse(`unexpected fields: ${extras.sort().join(', ')}`);

  let cfg: VerifierConfig;
  try {
    cfg = loadVerifierConfig(deps.configPath);
    // eslint-disable-next-line no-catch-all/no-catch-all -- config problems are refusals, not bugs
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }

  // The overall deadline starts HERE: at the first instant `wallSeconds` is
  // known, and before every ledger read, git call, archive export and container
  // in this run. Everything downstream measures against this one monotonic
  // origin, so a slow preflight spends the run's budget rather than extending
  // it. Refusals above this line are decided without a clock at all.
  const deadline = createDeadline(cfg.limits.wallSeconds, deps.monotonicNs ?? (() => process.hrtime.bigint()));

  // (1) caller identity
  if (session.agent_group_id !== cfg.echoGroupId) {
    return refuse('run_checks is not permitted for this group', {}, cfg.echoGroupId);
  }

  // (2) the handoff row itself
  const row: HandoffRow | undefined = await getHandoff(handoffId);
  if (!row) return refuse(`handoff ${handoffId} not found in the trusted ledger`, {}, cfg.echoGroupId);
  if (row.reviewer_agent_group_id !== cfg.echoGroupId) {
    return refuse('handoff reviewer is not this group', {}, cfg.echoGroupId);
  }
  if (row.source_agent_group_id !== cfg.atlasGroupId) {
    return refuse('handoff source is not the configured source agent', {}, cfg.echoGroupId);
  }
  if (row.status !== 'delivered') {
    return refuse(`handoff is ${row.status}; only a delivered handoff can be verified`, {}, cfg.echoGroupId);
  }

  const base: Partial<VerificationRecord> = { ledger_fingerprint: row.fingerprint, project: row.project };

  // (3) captured inputs
  const inputsRow: VerificationInputsRow | undefined = await getVerificationInputs(handoffId);
  if (!inputsRow) return refuse('no captured verification inputs for this handoff', base, cfg.echoGroupId);

  // (4) both fingerprints, recomputed from the rows we just read
  if (fingerprintOfRow(row) !== row.fingerprint) {
    return refuse('ledger fingerprint mismatch', base, cfg.echoGroupId);
  }

  // (5) the stored arrays must still satisfy the wire schema
  let inputs: VerificationInputs;
  try {
    inputs = parseVerificationInputs({
      class: inputsRow.class,
      checkpoint: inputsRow.checkpoint,
      checksJson: inputsRow.checks_json,
      reproduceJson: inputsRow.reproduce_json,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- tampered rows are data, not bugs
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err), base, cfg.echoGroupId);
  }
  if (fingerprintVerificationInputs(row.fingerprint, inputs) !== inputsRow.inputs_fingerprint) {
    return refuse('inputs fingerprint mismatch', base, cfg.echoGroupId);
  }

  const withInputs: Partial<VerificationRecord> = {
    ...base,
    inputs_fingerprint: inputsRow.inputs_fingerprint,
    checkpoint: inputs.checkpoint,
    class: inputs.class,
    reproduce: inputs.reproduce,
  };

  // (6) project → allowlisted, read-only mount → a real git repository
  const project = cfg.projects[row.project];
  if (!project)
    return refuse(`project ${row.project} is not resolvable from the verifier config`, withInputs, cfg.echoGroupId);
  const hostPath = project.realHostPath;
  const isRepo = await deps.exec('git', ['-C', hostPath, 'rev-parse', '--git-dir'], {
    timeoutMs: deadline.bound(GIT_EXEC_TIMEOUT_MS),
  });
  if (isRepo.code !== 0) {
    return refuse(
      `project ${row.project} does not resolve to a git repository`,
      { ...withInputs, host_path: hostPath },
      cfg.echoGroupId,
    );
  }

  // (7) the checkpoint must exist in THAT repository, checked by host git
  const hasCommit = await deps.exec('git', ['-C', hostPath, 'cat-file', '-e', `${inputs.checkpoint}^{commit}`], {
    timeoutMs: deadline.bound(GIT_EXEC_TIMEOUT_MS),
  });
  if (hasCommit.code !== 0) {
    return refuse(
      `checkpoint ${inputs.checkpoint} not found in ${row.project}`,
      { ...withInputs, host_path: hostPath },
      cfg.echoGroupId,
    );
  }

  // (8) the gate: exactly one script, and neither retired one. A directory that
  //     still carries verify.sh or run.sh is a half-finished install, and the
  //     verifier will not start a container against it.
  const gateScriptPath = path.join(deps.gateDir, GATE_SCRIPT);
  const legacyPresent = LEGACY_GATE_SCRIPTS.filter((name) => fs.existsSync(path.join(deps.gateDir, name)));
  if (legacyPresent.length > 0) {
    return refuse(
      `${LEGACY_GATE_REFUSAL}: ${legacyPresent.sort().join(', ')}`,
      { ...withInputs, host_path: hostPath },
      cfg.echoGroupId,
    );
  }
  if (!fs.existsSync(gateScriptPath)) {
    return refuse(
      `gate directory must contain ${GATE_SCRIPT}`,
      { ...withInputs, host_path: hostPath },
      cfg.echoGroupId,
    );
  }

  // (9) one run per reviewer group
  if (inFlight.has(cfg.echoGroupId)) {
    return refuse(`verification in progress for ${handoffId}`, { ...withInputs, host_path: hostPath }, cfg.echoGroupId);
  }
  inFlight.set(cfg.echoGroupId, true);
  try {
    return await execute({
      cfg,
      deps,
      session,
      row,
      inputs,
      hostPath,
      withInputs,
      gateScriptPath,
      gateSha: sha256File(gateScriptPath),
      deadline,
      // Taken from the two rows the ladder above just validated. Every later
      // revalidation is a comparison against THIS, never against a row read
      // later, so nothing that happens during the run can move the baseline.
      snapshot: snapshotIdentity(row, inputsRow),
    });
  } finally {
    inFlight.delete(cfg.echoGroupId);
  }
}

interface ExecuteArgs {
  cfg: VerifierConfig;
  deps: VerifierDeps;
  session: Session;
  row: HandoffRow;
  inputs: VerificationInputs;
  hostPath: string;
  withInputs: Partial<VerificationRecord>;
  gateScriptPath: string;
  gateSha: string | null;
  deadline: Deadline;
  snapshot: IdentitySnapshot;
}

async function execute(a: ExecuteArgs): Promise<RunChecksOutcome> {
  // The containers' only source is a tar of the exact checkpoint, built here by
  // the host. The repository is never mounted, so untracked files (a stray
  // `.env`), a dirty working tree and every other commit stay on the host side
  // of the boundary. mkdtemp gives a 0700 directory with an unpredictable name;
  // the file inside it is fixed, so the bind-mount target is fixed too.
  const archiveDir = fs.mkdtempSync(path.join(a.deps.tmpRoot ?? os.tmpdir(), 'ncl-verify-'));
  try {
    fs.chmodSync(archiveDir, 0o700);
    return await runPerCheck({ ...a, archiveDir });
  } finally {
    // Runs on success, on a stop taken after the directory existed, on a docker
    // failure and on a per-check timeout.
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
}

async function runPerCheck(a: ExecuteArgs & { archiveDir: string }): Promise<RunChecksOutcome> {
  const { cfg, deps, session, row, inputs, hostPath, archiveDir, deadline, snapshot } = a;
  const now = deps.now ?? (() => Date.now());

  // ---- The frozen list. Nothing below re-reads the ledger for a command. ----
  const frozenChecks = [...inputs.checks];
  const commandHashes = frozenChecks.map((command) => sha256Hex(command));
  const checks: CheckRecord[] = frozenChecks.map((command, i) => emptyCheckRecord(i + 1, command, commandHashes[i]!));
  const checkOutputs: Array<{ index: number; stdout: string; stderr: string }> = [];

  const runId = newRunId();
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();

  // Fields discovered as the run proceeds; folded into the record by `finish`
  // so that a stop at any point still records everything already known. It is
  // spread BEFORE the derived verdict so it can never overwrite one.
  const runState: Partial<VerificationRecord> = {};

  const finish = async (stop: ErrorReason | null): Promise<RunChecksOutcome> => {
    const finishedAtMs = now();
    const derived = deriveVerdict(checks, stop);
    const checksRan = checks.filter((check) => check.status === 'ran').length;

    const record: VerificationRecord = {
      ...emptyRecord(row.id, startedAt),
      ...a.withInputs,
      ...runState,
      host_path: hostPath,
      gate_run_check_sha256: a.gateSha,
      run_id: runId,
      started_at: startedAt,
      finished_at: new Date(finishedAtMs).toISOString(),
      wall_seconds: (finishedAtMs - startedAtMs) / 1000,
      deadline_seconds: cfg.limits.wallSeconds,
      frozen_checks: frozenChecks,
      frozen_checks_sha256: frozenChecksSha256(frozenChecks),
      checks,
      reproduce: inputs.reproduce,
      verdict: derived.verdict,
      error_reason: derived.error_reason,
      refusal_reason: null,
    };

    const persisted = await persistRun(
      {
        dataDir: deps.dataDir,
        reviewerGroupId: cfg.echoGroupId,
        handoffId: row.id,
        runTimestamp: startedAt,
        record,
        checkOutputs,
      },
      {
        handoffId: row.id,
        eventType: 'verification',
        payload: { verdict: derived.verdict, error_reason: derived.error_reason, checks_ran: checksRan },
      },
    );

    const failures = persistenceReport(persisted);
    await notifyAgent(
      session,
      [
        `run_checks complete for ${row.id}`,
        `verdict: ${derived.verdict}`,
        `error_reason: ${derived.error_reason ?? 'NONE'}${
          record.invalid_input_detail ? ` (${record.invalid_input_detail})` : ''
        }`,
        '',
        // One line per CHECK, in frozen order. Everything on it is host-owned.
        ...checks.map(checkLine),
        '',
        // A hash is quoted ONLY when there is a file on disk whose bytes it is.
        persisted.recordSha256
          ? `record_sha256: ${persisted.recordSha256}`
          : 'record_sha256: NONE (the record was not written)',
        `frozen_checks_sha256: ${record.frozen_checks_sha256}`,
        `persistence: filesystem=${persisted.persistence.filesystem} ledger_event=${persisted.persistence.ledger_event}`,
        ...(failures.length > 0 ? ['', ...failures] : []),
        '',
        'REPRODUCE (documentation only, not executed):',
        ...(inputs.reproduce.length > 0 ? inputs.reproduce.map((cmd) => `- ${cmd}`) : ['- (none)']),
        '',
        'The verdict above was derived by the host from each check process exit',
        "code, the host wall clock, and docker's own confirmation that each",
        'container was removed. Nothing printed inside a container was read.',
        'Per-check output is recorded beside the record as check-<i>.stdout.txt',
        'and check-<i>.stderr.txt.',
      ].join('\n'),
    );

    return {
      refused: false,
      verdict: derived.verdict,
      error_reason: derived.error_reason,
      record_sha256: persisted.recordSha256,
      run_dir: persisted.runDir,
      persistence: persisted.persistence,
      errors: persisted.errors,
      checks,
      checks_ran: checksRan,
      runDir: persisted.runDir ?? undefined,
      recordSha256: persisted.recordSha256 ?? undefined,
    };
  };

  /**
   * The stop reason for a completed container, in the ONE precedence order the
   * whole module uses:
   *
   *     deadline > infrastructure > timed_out > check_failed
   *
   * The deadline outranks an unconfirmed removal deliberately. Both stop the
   * run, so nothing unsafe follows either way; when the clock has run out, that
   * is the honest headline, and the removal's own outcome stays on the check
   * row (`removal_confirmed: false`, `removal_attempts`) and in the host log
   * where an operator will see it. `timed_out` and `check_failed` are not
   * stops at all — they are results, and `deriveVerdict` ranks them.
   */
  const stopReasonFor = (
    result: { spawnFailed: boolean },
    removal: { confirmed: boolean; outcome: string },
    handshake: 'ok' | 'missing' | 'mismatch',
  ): ErrorReason | null => {
    if (deadline.expired()) return 'deadline';
    if (!removal.confirmed) return removal.outcome === 'uncertain' ? 'docker_uncertain' : 'removal_unconfirmed';
    // A client that never started tells us nothing at all, so it outranks a
    // container that started and failed to set itself up.
    if (result.spawnFailed) return 'spawn_failed';
    if (handshake !== 'ok') return 'setup_failed';
    return null;
  };

  /** Stop with `invalid_input`, naming the field, after removing any live container. */
  const stopInvalid = async (detail: string, activeContainer: string | null): Promise<RunChecksOutcome> => {
    log.warn('verifier: trusted handoff identity changed during the run', { handoffId: row.id, detail });
    if (activeContainer) {
      // Belt and braces: at every revalidation point the previous container has
      // already been confirmed gone. If that ever stops being true, the run
      // still does not walk away from a live container.
      const removal = await removeContainerConfirmed(activeContainer, deps.exec, {
        timeoutMs: deadline.removalBound(),
      });
      log.error('verifier: removed an unexpectedly active container on an invalid_input stop', {
        handoffId: row.id,
        containerName: activeContainer,
        outcome: removal.outcome,
      });
    }
    runState.invalid_input_detail = detail;
    return finish('invalid_input');
  };

  // ---- Re-validate the trusted identity IMMEDIATELY before the export. ----
  // The precondition ladder ran against rows read earlier; this reads them
  // again and compares every field to the snapshot, so a row edited in the gap
  // between the ladder and the container is a stop, not an execution.
  const preflight = await revalidateIdentity(row.id, snapshot, frozenChecks, inputs);
  if (preflight) return stopInvalid(preflight, null);

  // ---- One archive, mounted read-only into every check's container. ----
  const archiveTarPath = path.join(archiveDir, 'checkpoint.tar');
  const archived = await deps.exec(
    'git',
    ['-C', hostPath, 'archive', '--format=tar', '-o', archiveTarPath, inputs.checkpoint],
    { timeoutMs: deadline.bound(GIT_EXEC_TIMEOUT_MS) },
  );
  // Deadline BEFORE the archive's own outcome: an export that ran past the
  // budget is a deadline, even when what it reported was a failure (the bound
  // above is what made it fail). Precedence, not convenience.
  if (deadline.expired()) {
    log.warn('verifier: overall deadline reached during the checkpoint export', { handoffId: row.id });
    return finish('deadline');
  }
  if (archived.code !== 0 || !fs.existsSync(archiveTarPath)) {
    log.error('verifier: checkpoint export failed', { handoffId: row.id, project: row.project });
    return finish('archive_failed');
  }
  runState.archive_sha256 = sha256File(archiveTarPath);
  runState.archive_bytes = fs.statSync(archiveTarPath).size;

  const imageRef = await deps.resolveImageRef(cfg.echoGroupId);
  runState.image_ref = imageRef;
  const inspect = await deps.exec(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}|{{join .RepoDigests ","}}', imageRef],
    { timeoutMs: deadline.bound(DEFAULT_EXEC_TIMEOUT_MS) },
  );
  const [imageId, imageDigests] = inspect.code === 0 ? inspect.stdout.trim().split('|') : [null, null];
  runState.image_id = imageId || null;
  runState.image_digests = imageDigests || null;
  if (deadline.expired()) {
    log.warn('verifier: overall deadline reached during image inspection', { handoffId: row.id });
    return finish('deadline');
  }

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;

  // ---- One container per CHECK, in frozen order. ----
  for (let i = 0; i < frozenChecks.length; i++) {
    const check = checks[i]!;
    const command = frozenChecks[i]!;

    // (a) The deadline is consulted BEFORE each container, never during one: a
    //     check already running keeps its own cap. The bar is higher than "any
    //     time at all" — a container given under a second could not finish, and
    //     a one-second timeout dressed up as a result is a lie.
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= MIN_REMAINING_SECONDS * 1000) {
      log.warn('verifier: overall deadline reached', { handoffId: row.id, nextCheck: check.index });
      return finish('deadline');
    }

    // (b) ...and the authority under which this command is about to execute is
    //     re-proved, against the preflight snapshot, with no container alive.
    const drift = await revalidateIdentity(row.id, snapshot, frozenChecks, inputs);
    if (drift) return stopInvalid(drift, null);

    const cap = Math.min(cfg.limits.perCommandSeconds, remainingMs / 1000);
    const containerName = containerNameFor(cfg.echoGroupId, row.id, runId, check.index);
    check.container_name = containerName;
    check.cap_seconds = cap;

    const argv = buildCheckArgv({
      containerName,
      uid,
      gid,
      cpus: cfg.limits.cpus,
      memory: cfg.limits.memory,
      pids: cfg.limits.pids,
      gateRunCheckPath: a.gateScriptPath,
      archiveTarPath,
      imageRef,
    });

    // The command text goes on stdin and nowhere else; so does the nonce, on
    // the line before it. Neither is in argv and neither is in the environment.
    const nonce = newCheckNonce();
    const result = await deps.runDocker('docker', argv, {
      stdin: command,
      nonce,
      wallSeconds: cap,
      outputBytes: cfg.limits.outputBytes,
      containerName,
      killTimeoutMs: deadline.bound(DEFAULT_EXEC_TIMEOUT_MS),
    });

    // The container's own account of itself: did it finish setting up before it
    // ran the command? Only then does its exit code belong to the CHECK.
    const handshake = classifyHandshake(result.handshakeLine, nonce);
    check.handshake = handshake;
    check.status = handshake === 'ok' ? 'ran' : 'setup_failed';
    check.started_at = result.startedAt;
    check.finished_at = result.finishedAt;
    check.wall_seconds = result.wallSeconds;
    check.exit_code = result.exitCode;
    check.timed_out = result.timedOut;
    check.stdout_bytes = result.stdoutBytes;
    check.stderr_bytes = result.stderrBytes;
    check.stdout_truncated = result.stdoutTruncated;
    check.stderr_truncated = result.stderrTruncated;
    checkOutputs.push({ index: check.index, stdout: result.stdout, stderr: result.stderr });

    // Removal is attempted for EVERY check, including one whose client never
    // spawned: proving the name is free costs one bounded call and removes the
    // only way a stray container could outlive the run. It is MANDATORY, so its
    // bound never drops below 5 s — it may therefore finish after the overall
    // deadline, and when it does the verdict below is `deadline`.
    const removal = await removeContainerConfirmed(containerName, deps.exec, {
      timeoutMs: deadline.removalBound(),
    });
    check.removal_confirmed = removal.confirmed;
    check.removal_attempts = removal.attempts;

    // One decision point, covering "after each CHECK" and "after each removal".
    const stop = stopReasonFor(result, removal, handshake);
    if (stop) {
      log.error('verifier: stopping the run', {
        handoffId: row.id,
        containerName,
        stop,
        handshake,
        removalOutcome: removal.outcome,
        removalDetail: removal.detail,
      });
      return finish(stop);
    }

    // Otherwise CONTINUE — a non-zero exit and a timeout are both results, and
    // Echo is owed the rest of the list. That includes exit 4, 125, 126 and
    // 127: with a verified handshake those are the CHECK's own exit codes and
    // nothing to do with the daemon.
  }

  // ---- Before the verdict: the clock, then the authority, one last time. ----
  if (deadline.expired()) {
    log.warn('verifier: overall deadline reached before finalization', { handoffId: row.id });
    return finish('deadline');
  }
  const final = await revalidateIdentity(row.id, snapshot, frozenChecks, inputs);
  if (final) return stopInvalid(final, null);

  return finish(null);
}

/**
 * Read both trusted rows again, in one go, and prove they still say EXACTLY
 * what the preflight snapshot says. Returns the name of the first field that
 * moved, or null when nothing did.
 *
 * Runs at three kinds of moment: during preflight before the archive export,
 * immediately before every CHECK (after the previous container was confirmed
 * gone), and once more before the verdict is derived. A `delivered` handoff
 * that is no longer `delivered`, a repointed project and an edited CHECKS array
 * are all the same answer here: stop.
 *
 * Both fingerprints are recomputed rather than compared, so an attacker who
 * edits a row AND its stored fingerprint together is caught by the recomputation
 * even though the snapshot comparison would pass on the fingerprint field.
 */
async function revalidateIdentity(
  handoffId: string,
  snapshot: IdentitySnapshot,
  frozenChecks: string[],
  inputs: VerificationInputs,
): Promise<string | null> {
  const row = await getHandoff(handoffId);
  if (!row) return 'handoff_row_missing';
  const inputsRow = await getVerificationInputs(handoffId);
  if (!inputsRow) return 'verification_inputs_row_missing';

  const current = snapshotIdentity(row, inputsRow);
  for (const field of Object.keys(snapshot) as Array<keyof IdentitySnapshot>) {
    if (current[field] !== snapshot[field]) return field;
  }

  // The rows are byte-identical to the snapshot, so the hashes over them must
  // reproduce. A failure here means the stored fingerprint was never a hash of
  // this row in the first place.
  if (fingerprintOfRow(row) !== row.fingerprint) return 'fingerprint_recomputed';

  let reparsed: VerificationInputs;
  try {
    reparsed = parseVerificationInputs({
      class: inputsRow.class,
      checkpoint: inputsRow.checkpoint,
      checksJson: inputsRow.checks_json,
      reproduceJson: inputsRow.reproduce_json,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- tampered rows are data, not bugs
  } catch {
    return 'checks_json';
  }
  if (fingerprintVerificationInputs(row.fingerprint, reparsed) !== inputsRow.inputs_fingerprint) {
    return 'inputs_fingerprint_recomputed';
  }

  // Belt and braces: the frozen array the containers are actually fed is
  // compared element by element against what the row now parses to.
  if (reparsed.checkpoint !== inputs.checkpoint) return 'checkpoint';
  if (reparsed.checks.length !== frozenChecks.length) return 'checks_json';
  for (let i = 0; i < frozenChecks.length; i++) {
    if (reparsed.checks[i] !== frozenChecks[i]) return 'checks_json';
  }
  return null;
}

registerDeliveryAction(
  'run_checks',
  async (content, session) => {
    await runChecksAction(content, session);
  },
  unguarded(
    'run_checks takes no approvable parameter: the only argument is an opaque handoff id, and every executable ' +
      'input is read from host-owned ledger rows and host-owned config. An approval card would show the admin ' +
      'nothing the host did not already decide.',
  ),
);
