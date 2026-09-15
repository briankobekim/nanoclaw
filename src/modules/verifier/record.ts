/**
 * The canonical aggregate evidence record.
 *
 * Every container in a run is disposable and says nothing about the verdict.
 * The host keeps three facts per CHECK that no container can write — the child
 * process exit code, the host's own wall-clock kill, and whether docker
 * confirmed the container is gone — and derives the verdict from those alone.
 * Nothing printed inside a container is read by `deriveVerdict`.
 *
 * The host writes `record.json` under `data/`, hashes those exact bytes, and
 * stores the hash on a `handoff_events` row. The reviewing agent receives a
 * copy and quotes `record_sha256`.
 *
 * Nothing under `data/` is ever mounted into a container — the run directory
 * path does not appear in any check's argv, and the record is written after the
 * last container is gone.
 */
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { getDb } from '../../db/connection.js';
import type { HandshakeStatus } from './docker.js';

export type Verdict =
  | 'ALL_CHECKS_PASSED'
  | 'CHECK_FAILED'
  | 'TIMED_OUT'
  | 'VERIFIER_ERROR'
  /**
   * Unreachable at runtime: `checks-schema` rejects an empty CHECKS array both
   * at capture and again at re-validation, so a run with nothing to execute
   * never starts. Kept in the enum so a reader of a record does not have to
   * wonder what the verifier would do, and so a future schema change that
   * allowed it would have a name waiting.
   */
  | 'NO_CHECKS_PRESENT';

/** Why the run stopped early. Exactly one of these, or null. */
export type ErrorReason =
  | 'archive_failed'
  | 'spawn_failed'
  /**
   * The docker client started but the container never completed its setup: no
   * `RUN_CHECK_READY <nonce>` came back, or one came back with the wrong nonce.
   * The exit code therefore belongs to the daemon or the gate script, not to
   * the CHECK, and must never be reported as a CHECK result.
   */
  | 'setup_failed'
  | 'removal_unconfirmed'
  | 'docker_uncertain'
  | 'invalid_input'
  | 'deadline';

/**
 * `ran` means the container completed its handshake, so its exit code is the
 * CHECK's. `setup_failed` means it did not, so the exit code says nothing about
 * the CHECK. `not_run` means no container was ever started for it.
 */
export type CheckStatus = 'ran' | 'not_run' | 'setup_failed';

export interface CheckRecord {
  /** 1-based, matching the container name suffix `-c<i>`. */
  index: number;
  command: string;
  command_sha256: string;
  container_name: string | null;
  status: CheckStatus;
  started_at: string | null;
  finished_at: string | null;
  wall_seconds: number | null;
  /** `min(limits.perCommandSeconds, remainingOverall)` at the moment it started. */
  cap_seconds: number | null;
  exit_code: number | null;
  /**
   * Whether this container proved, with the host's own per-container nonce,
   * that it finished setting up before running the CHECK. `null` for a check
   * that never started a container.
   */
  handshake: HandshakeStatus | null;
  timed_out: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  removal_confirmed: boolean;
  removal_attempts: number;
}

export function emptyCheckRecord(index: number, command: string, commandSha256: string): CheckRecord {
  return {
    index,
    command,
    command_sha256: commandSha256,
    container_name: null,
    status: 'not_run',
    started_at: null,
    finished_at: null,
    wall_seconds: null,
    cap_seconds: null,
    exit_code: null,
    handshake: null,
    timed_out: false,
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    removal_confirmed: false,
    removal_attempts: 0,
  };
}

export interface DerivedVerdict {
  verdict: Verdict;
  error_reason: ErrorReason | null;
}

/**
 * The verdict, derived on the host from the per-CHECK facts only.
 *
 * Precedence, in this order and no other:
 *
 *     deadline > infrastructure > timed_out > check_failed
 *
 * where `infrastructure` is every other `ErrorReason`: `archive_failed`,
 * `spawn_failed`, `setup_failed`, `removal_unconfirmed`, `docker_uncertain`,
 * `invalid_input`. The caller resolves the first two into the single `stop`
 * argument — see `stopReasonFor` in index.ts, which is where "the deadline
 * outranks an unconfirmed removal" is actually decided — and this function
 * resolves the rest.
 *
 *  1. A STOP condition wins outright. The run was cut short, so the remaining
 *     checks are `not_run` and no statement about "the checks" can be made:
 *     `VERIFIER_ERROR` with the reason. This is why P11 — a run that hits the
 *     overall deadline after a check timed out — is `VERIFIER_ERROR deadline`
 *     and not `TIMED_OUT`: the deadline is why we stopped, and a reader needs
 *     to know the list was not finished.
 *  2. A pass requires EVERY check to have run, exited 0, not timed out, and had
 *     its container's removal confirmed. A check whose container we could not
 *     prove gone cannot contribute to a pass, because the next check's
 *     isolation was never established.
 *  3. Otherwise a timeout outranks a failure (a killed check never "failed",
 *     it never finished), and a failure outranks everything left.
 */
export function deriveVerdict(checks: CheckRecord[], stop: ErrorReason | null): DerivedVerdict {
  if (stop) return { verdict: 'VERIFIER_ERROR', error_reason: stop };
  if (checks.length === 0) return { verdict: 'NO_CHECKS_PRESENT', error_reason: null };

  const allRanClean = checks.every(
    (check) =>
      check.status === 'ran' && check.exit_code === 0 && check.timed_out === false && check.removal_confirmed === true,
  );
  if (allRanClean) return { verdict: 'ALL_CHECKS_PASSED', error_reason: null };
  if (checks.some((check) => check.timed_out)) return { verdict: 'TIMED_OUT', error_reason: null };
  if (checks.some((check) => check.status === 'ran' && check.exit_code !== 0)) {
    return { verdict: 'CHECK_FAILED', error_reason: null };
  }
  // A `not_run` check with no stop reason, or a confirmed-removal failure that
  // did not stop the run, would be a bug in the loop. Never a pass.
  return { verdict: 'VERIFIER_ERROR', error_reason: null };
}

export interface VerificationRecord {
  handoff_id: string;
  ledger_fingerprint: string | null;
  inputs_fingerprint: string | null;
  project: string | null;
  /** The one field allowed to carry the repository path. Never sent to Echo. */
  host_path: string | null;
  checkpoint: string | null;
  /** sha256 of the `git archive` tar the host built and mounted into every check. */
  archive_sha256: string | null;
  archive_bytes: number | null;
  class: string | null;
  image_ref: string | null;
  image_id: string | null;
  image_digests: string | null;
  gate_run_check_sha256: string | null;
  host_uid: number | null;
  host_gid: number | null;
  run_id: string | null;
  started_at: string;
  finished_at: string;
  wall_seconds: number;
  /** `limits.wallSeconds`: the overall deadline this run was given. */
  deadline_seconds: number | null;
  /** The CHECKS list exactly as frozen before the first container. */
  frozen_checks: string[];
  frozen_checks_sha256: string | null;
  checks: CheckRecord[];
  /** Documentation only. Stored, fingerprinted, recorded, displayed. NEVER executed. */
  reproduce: string[];
  verdict: Verdict | null;
  error_reason: ErrorReason | null;
  /**
   * With `error_reason: 'invalid_input'`, the NAME of the trusted field that
   * stopped the run — `status`, `checks_json`, `fingerprint`, and so on. A
   * reader needs to know which part of the handoff moved under the verifier's
   * feet; the values themselves are in the ledger and are not copied here.
   */
  invalid_input_detail: string | null;
  refusal_reason: string | null;
  /**
   * What persistence looked like AT WRITE TIME, which is all a self-describing
   * file can honestly say.
   *
   * `filesystem` is `ok` by construction: if you are reading this field, the
   * atomic write and rename succeeded. `ledger_event` is `pending`, because the
   * event carries `record_sha256` and therefore cannot be appended until these
   * bytes exist. The RESOLVED status is written afterwards to the sibling
   * `persistence.json`, reported to the reviewing agent in the run message, and
   * evidenced by the `handoff_events` row itself.
   *
   * `record.sha256` covers record.json's bytes only, so resolving the ledger
   * half later cannot invalidate the hash the review quotes.
   */
  persistence: { filesystem: string; ledger_event: string };
}

/** The resolved status, written beside the record once both halves are done. */
export interface ResolvedPersistence {
  filesystem: string;
  ledger_event: string;
  errors: string[];
  resolved_at: string;
}

/**
 * Write `persistence.json` beside a record that was written successfully.
 *
 * Best effort and never throws: it is a convenience for a human reading the run
 * directory later. The authoritative signals are the run message (which the
 * reviewing agent sees) and the presence or absence of the `handoff_events`
 * row. A failure here is logged by the caller, not escalated.
 */
export function writeResolvedPersistence(runDir: string, resolved: ResolvedPersistence): boolean {
  try {
    fs.writeFileSync(path.join(runDir, 'persistence.json'), `${JSON.stringify(resolved, null, 2)}\n`, { mode: 0o600 });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a convenience file is never worth failing a run over
  } catch {
    return false;
  }
}

export interface WriteRecordInput {
  dataDir: string;
  reviewerGroupId: string;
  handoffId: string;
  runTimestamp: string;
  record: VerificationRecord;
  /** One entry per CHECK that actually ran. Written as `check-<i>.stdout.txt`. */
  checkOutputs: Array<{ index: number; stdout: string; stderr: string }>;
}

export interface WrittenRecord {
  runDir: string;
  recordSha256: string;
  verdict: Verdict | null;
}

/** ISO timestamps carry `:`; keep the directory name filesystem-portable. */
function safeStamp(iso: string): string {
  return iso.replace(/[:]/g, '-');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(filePath: string): string | null {
  try {
    return sha256Hex(fs.readFileSync(filePath));
    // eslint-disable-next-line no-catch-all/no-catch-all -- an absent gate file is recorded as null
  } catch {
    return null;
  }
}

/** The hash the record carries over the frozen list, over a fixed encoding. */
export function frozenChecksSha256(checks: string[]): string {
  return sha256Hex(JSON.stringify(checks));
}

export async function writeVerificationRecord(input: WriteRecordInput): Promise<WrittenRecord> {
  const runDir = path.join(
    input.dataDir,
    'evidence',
    input.reviewerGroupId,
    input.handoffId,
    safeStamp(input.runTimestamp),
  );
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

  // The per-check siblings first: a `record.json` that exists must describe
  // evidence that also exists.
  for (const output of input.checkOutputs) {
    fs.writeFileSync(path.join(runDir, `check-${output.index}.stdout.txt`), output.stdout, { mode: 0o600 });
    fs.writeFileSync(path.join(runDir, `check-${output.index}.stderr.txt`), output.stderr, { mode: 0o600 });
  }

  // `record.json` appears ATOMICALLY: written under a temporary name in the
  // same directory, then renamed. A half-written record is the one thing that
  // must never exist, because `record_sha256` is what the review cites — a
  // truncated file would still hash, and the hash would be of nothing.
  const recordBytes = Buffer.from(`${JSON.stringify(input.record, null, 2)}\n`, 'utf8');
  const finalPath = path.join(runDir, 'record.json');
  const tmpPath = path.join(runDir, `.record.json.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, recordBytes, { mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    // Rethrown: the caller reports `filesystem: 'failed'`. The only thing done
    // here is making sure a half-written temporary file is not left behind.
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  // Hashed from the RENAMED bytes, read back off disk, so the hash the reviewer
  // quotes is demonstrably the hash of the file that is actually there.
  const recordSha256 = sha256Hex(fs.readFileSync(finalPath));
  fs.writeFileSync(path.join(runDir, 'record.sha256'), `${recordSha256}\n`, { mode: 0o600 });

  return { runDir, recordSha256, verdict: input.record.verdict };
}

/**
 * Reference the record from the ledger without transitioning the handoff.
 * Echo still posts the formal outcome through the existing enforcement path.
 *
 * `handoff_events.actor_agent_group_id` has no CHECK constraint and no foreign
 * key, so the host writes its own actor rather than borrowing the reviewer's
 * identity for something the reviewer did not do.
 */
export const VERIFIER_ACTOR = 'host:verifier';

/**
 * A completed run and a refusal are different events. A reviewer scanning the
 * ledger should not have to read a payload to tell "the checks ran and failed"
 * from "the host would not run them at all".
 */
export type VerificationEventType = 'verification' | 'verification_refused';

/**
 * Throws on failure, deliberately. The caller reports `ledger_event: 'failed'`
 * to the reviewing agent rather than letting a silent insert failure look like
 * a recorded verification.
 */
export async function appendVerificationEvent(
  handoffId: string,
  payload: Record<string, unknown>,
  eventType: VerificationEventType = 'verification',
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    const next =
      (
        await getDb().get<{ sequence: number }>(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM handoff_events WHERE handoff_id = ?',
          handoffId,
        )
      )?.sequence ?? 1;
    await getDb().run(
      `INSERT INTO handoff_events
         (id, handoff_id, sequence, event_type, actor_agent_group_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      handoffId,
      next,
      eventType,
      VERIFIER_ACTOR,
      JSON.stringify(payload),
      now,
    );
  });
}
