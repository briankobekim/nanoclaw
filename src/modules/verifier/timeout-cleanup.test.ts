/**
 * The per-check clock, the removal proof, and the output bound — against a
 * docker that never answers.
 *
 * This file drives the REAL `createDockerRunner` and the REAL
 * `removeContainerConfirmed` — the timeout, the grace window, the SIGKILL, the
 * single-settle guard, the stream cap and the three removal rounds are the code
 * under test — but hands them a fake `spawn` and a fake bounded `exec`. No
 * docker daemon is involved, so a daemon that hangs is something we can
 * actually reproduce.
 *
 * `git` stays real: the precondition ladder ahead of the runner must be the
 * production one, or "the mutex was released" would be a claim about a stub.
 */
import { execFileSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ allowlistPath: '' }));
const notifications = vi.hoisted(() => ({ messages: [] as string[] }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../config.js');
  return {
    ...actual,
    get MOUNT_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

vi.mock('../approvals/primitive.js', () => ({
  notifyAgent: async (_session: unknown, text: string) => {
    notifications.messages.push(text);
  },
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';
import { createHandoff, deliverHandoffWithInputs, type HandoffRow } from '../handoff-ledger/ledger.js';
import '../handoff-ledger/migration.js';
import './migration.js';
import {
  CappedSink,
  containerNameFor,
  createDockerRunner,
  execNoShell,
  newRunId,
  removeContainerConfirmed,
  HANDSHAKE_PREFIX,
  NO_SUCH_CONTAINER_RE,
  type DockerRunner,
  type ExecResult,
  type ExecRunner,
} from './docker.js';
import { runChecksAction, type RunChecksOutcome, type VerifierDeps } from './index.js';
import type { CheckRecord } from './record.js';

const ECHO = 'ag-echo';
const ATLAS = 'ag-atlas';

/** The subset of `ChildProcess` the runner touches, and nothing else. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), {
    end: (_payload?: unknown) => undefined,
    destroy: () => undefined,
  });
  signals: string[] = [];
  /** A child that never exits on its own — the whole point of these tests. */
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }
  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

let tmpDir: string;
let repoDir: string;
let dataDir: string;
let gateDir: string;
let configPath: string;
let checkpoint: string;
let children: FakeChild[];
let auxCalls: string[][];
let settlements: number;
let counter: number;

function ok(stdout = 'sha256:deadbeef|\n'): ExecResult {
  return { code: 0, stdout, stderr: '', ok: true, timedOut: false };
}

function gone(name: string): ExecResult {
  return {
    code: 1,
    stdout: '',
    stderr: `Error response from daemon: No such container: ${name}\n`,
    ok: false,
    timedOut: false,
    error: 'Command failed',
  };
}

function writeConfig(limits: Record<string, unknown>): void {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      echoGroupId: ECHO,
      atlasGroupId: ATLAS,
      projects: { FIXTURE: { hostPath: repoDir, mount: 'fixture' } },
      limits,
    }),
    { mode: 0o600 },
  );
  fs.chmodSync(configPath, 0o600);
}

/**
 * The nonce of the container currently being started, so a `FakeChild` can echo
 * the host's own handshake back the way `run-check.sh` does. Set by `counted`,
 * which every runner in this file goes through, BEFORE the inner runner spawns.
 */
let currentNonce = '';

/** Wrap a runner so a second resolution of the same call would be visible. */
function counted(runner: DockerRunner): DockerRunner {
  return async (file, argv, options) => {
    currentNonce = options.nonce;
    const result = await runner(file, argv, options);
    settlements += 1;
    return result;
  };
}

/**
 * Emit the startup handshake, as a real container does before it execs the
 * command. Scheduled rather than emitted inline because the runner attaches its
 * `data` listener after `spawnFn` returns.
 */
function handshake(child: FakeChild): void {
  const nonce = currentNonce;
  setImmediate(() => child.stdout.emit('data', Buffer.from(`${HANDSHAKE_PREFIX}${nonce}\n`)));
}

function session(): Session {
  return {
    id: 'sess-timeout',
    agent_group_id: ECHO,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

async function delivered(checks: string[] = ['true']): Promise<HandoffRow> {
  const id = `H-TO-${++counter}`;
  const row = await createHandoff({
    id,
    sourceAgentGroupId: ATLAS,
    reviewerAgentGroupId: ECHO,
    project: 'FIXTURE',
    goal: 'Bound a docker daemon that answers nothing',
    outcome: 'A host-attested evidence record',
    scope: 'verifier module only',
    authority: 'execute',
  });
  await deliverHandoffWithInputs({
    id: row.id,
    actor: ATLAS,
    fingerprint: row.fingerprint,
    inputs: { class: 'fix', checkpoint, checks, reproduce: [] },
  });
  return row;
}

/** A fake exec: real git, scripted docker. Every docker argv is recorded. */
function makeExec(docker: (argv: string[]) => Promise<ExecResult>): ExecRunner {
  return async (file, argv, options) => {
    if (file === 'git') return execNoShell(file, argv, options);
    auxCalls.push([file, ...argv]);
    return docker(argv);
  };
}

/** The default: every container inspects as "No such container". */
const removalConfirms = makeExec(async (argv) => {
  if (argv[0] === 'inspect' && argv[1] === '--type') return gone(argv[3]!);
  return ok();
});

function deps(over: Partial<VerifierDeps>): VerifierDeps {
  return {
    configPath,
    dataDir,
    gateDir,
    tmpRoot: tmpDir,
    runDocker: async () => {
      throw new Error('a runner must be provided');
    },
    exec: removalConfirms,
    resolveImageRef: async () => 'nanoclaw-agent:test',
    ...over,
  };
}

/** Count the run directories written for one handoff. */
function runDirsFor(handoffId: string): string[] {
  const dir = path.join(dataDir, 'evidence', ECHO, handoffId);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function readRecord(outcome: RunChecksOutcome): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(outcome.runDir!, 'record.json'), 'utf8'));
}

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-verifier-to-')));
  repoDir = path.join(tmpDir, 'allowed', 'fixture-repo');
  dataDir = path.join(tmpDir, 'data');
  gateDir = path.join(tmpDir, 'gate');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(gateDir, { recursive: true });
  fs.writeFileSync(path.join(gateDir, 'run-check.sh'), '#!/bin/bash\nset -u\ncmd=$(cat)\nexec bash -c "$cmd"\n', {
    mode: 0o755,
  });

  fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"fixture"}\n');
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'],
    { cwd: repoDir },
  );
  checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

  mockState.allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
  fs.writeFileSync(
    mockState.allowlistPath,
    JSON.stringify({
      allowedRoots: [{ path: path.join(tmpDir, 'allowed'), allowReadWrite: false }],
      blockedPatterns: [],
    }),
  );

  configPath = path.join(tmpDir, 'verifier.json');
  writeConfig({ perCommandSeconds: 1 });

  children = [];
  auxCalls = [];
  settlements = 0;
  counter = 0;
  notifications.messages = [];

  const db = await initTestDb();
  await runMigrations(db);
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: ECHO, name: 'Echo', folder: 'echo', agent_provider: null, created_at });
  await createAgentGroup({ id: ATLAS, name: 'Atlas', folder: 'atlas', agent_provider: null, created_at });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A runner over a fake child that never exits, with a short grace window. */
function stalledRunner(dockerKill: () => Promise<ExecResult>): DockerRunner {
  return counted(
    createDockerRunner({
      spawnFn: () => {
        const child = new FakeChild();
        children.push(child);
        handshake(child);
        return child.asChildProcess();
      },
      exec: async (file, argv) => {
        auxCalls.push([file, ...argv]);
        return dockerKill();
      },
      graceMs: 50,
      killTimeoutMs: 50,
    }),
  );
}

describe('a docker that never answers is still bounded by the host', () => {
  it('(i) SIGKILLs the client when a check stalls and `docker kill` never returns', async () => {
    // `docker kill` returns a promise that is never settled: the daemon is
    // wedged. Nothing downstream may wait on it.
    const runner = stalledRunner(() => new Promise<ExecResult>(() => {}));
    const row = await delivered();

    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps({ runDocker: runner }));

    expect(outcome.verdict).toBe('TIMED_OUT');
    expect(outcome.refused).toBe(false);

    // (b) happened without (a): the client was killed by us.
    expect(children).toHaveLength(1);
    expect(children[0]!.signals).toEqual(['SIGKILL']);

    // The record landed, the ledger event with it, and the container was still
    // removed and confirmed gone despite the wedged kill.
    expect(runDirsFor(row.id)).toHaveLength(1);
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks[0]!.timed_out).toBe(true);
    expect(checks[0]!.removal_confirmed).toBe(true);
    expect(outcome.persistence).toEqual({ filesystem: 'ok', ledger_event: 'ok' });
    expect(fs.readFileSync(path.join(outcome.runDir!, 'check-1.stderr.txt'), 'utf8')).toContain(
      'SIGKILL of the docker client',
    );

    // A late `close` from the corpse must not settle anything a second time.
    children[0]!.emit('close', 137);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settlements).toBe(1);
    expect(runDirsFor(row.id)).toHaveLength(1);

    // The mutex was released, so the next run proceeds.
    const next = await delivered();
    const after = await runChecksAction({ handoff_id: next.id }, session(), deps({ runDocker: runner }));
    expect(after.refused).toBe(false);
  }, 30_000);

  it('(ii) reaches the same outcome when `docker kill` fails outright', async () => {
    const runner = stalledRunner(async () => ({
      code: 1,
      stdout: '',
      stderr: 'Error response from daemon: No such container\n',
      ok: false,
      timedOut: false,
      error: 'Command failed: docker kill',
    }));
    const row = await delivered();

    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps({ runDocker: runner }));

    expect(outcome.verdict).toBe('TIMED_OUT');
    expect(children[0]!.signals).toEqual(['SIGKILL']);
    expect(runDirsFor(row.id)).toHaveLength(1);
    expect(outcome.persistence).toEqual({ filesystem: 'ok', ledger_event: 'ok' });

    const stderr = fs.readFileSync(path.join(outcome.runDir!, 'check-1.stderr.txt'), 'utf8');
    expect(stderr).toContain('docker kill');
    expect(stderr).toContain('failed');
    expect(stderr).toContain('SIGKILL of the docker client');
    // A failed kill is a recorded fact, not a verdict: nothing read it.
    expect(readRecord(outcome).verdict).toBe('TIMED_OUT');
  }, 30_000);

  it('(iii) a timed-out check does not stop the run: the next one still starts', async () => {
    // The first container stalls to its cap; the second exits cleanly. The
    // policy is run-all, so the verdict is TIMED_OUT with BOTH checks ran.
    let spawned = 0;
    const runner = counted(
      createDockerRunner({
        spawnFn: () => {
          const child = new FakeChild();
          children.push(child);
          handshake(child);
          spawned += 1;
          if (spawned > 1) setTimeout(() => child.emit('close', 0), 5);
          return child.asChildProcess();
        },
        exec: async () => ok(),
        graceMs: 50,
        killTimeoutMs: 50,
      }),
    );
    const row = await delivered(['sleep 1000', 'true']);
    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps({ runDocker: runner }));

    expect(outcome.verdict).toBe('TIMED_OUT');
    expect(outcome.checks_ran).toBe(2);
    expect(settlements).toBe(2);
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.map((c) => c.timed_out)).toEqual([true, false]);
    expect(checks.every((c) => c.removal_confirmed)).toBe(true);
    // Each container was removed by its own name, before the next was spawned.
    expect(auxCalls.filter((argv) => argv[1] === 'rm').map((argv) => argv[3])).toEqual([
      checks[0]!.container_name,
      checks[1]!.container_name,
    ]);
  }, 30_000);

  it('(iv) holds the mutex through a hanging cleanup, then frees it', async () => {
    const quickRunner = counted(
      createDockerRunner({
        spawnFn: () => {
          const child = new FakeChild();
          children.push(child);
          handshake(child);
          setTimeout(() => child.emit('close', 0), 5);
          return child.asChildProcess();
        },
        exec: async () => ok(),
        graceMs: 50,
      }),
    );

    let removals = 0;
    let releaseRemoval!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const slowCleanup = makeExec(async (argv) => {
      if (argv[0] === 'rm') {
        removals += 1;
        // The first `rm -f` stalls, as a wedged daemon's would, up to its bound.
        if (removals === 1) {
          releaseRemoval();
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      if (argv[0] === 'inspect' && argv[1] === '--type') return gone(argv[3]!);
      return ok();
    });

    const first = await delivered();
    const second = await delivered();
    const third = await delivered();

    const firstRun = runChecksAction(
      { handoff_id: first.id },
      session(),
      deps({ runDocker: quickRunner, exec: slowCleanup }),
    );

    // Wait until the first run is INSIDE its cleanup — past the container, not
    // yet past the mutex.
    await removalStarted;

    const refused = await runChecksAction(
      { handoff_id: second.id },
      session(),
      deps({ runDocker: quickRunner, exec: slowCleanup }),
    );
    expect(refused).toMatchObject({
      refused: true,
      reason: `verification in progress for ${second.id}`,
      verdict: 'REFUSED',
    });
    expect(runDirsFor(second.id)).toHaveLength(1); // the refusal record, not a run

    const firstOutcome: RunChecksOutcome = await firstRun;
    expect(firstOutcome.refused).toBe(false);

    const thirdOutcome = await runChecksAction(
      { handoff_id: third.id },
      session(),
      deps({ runDocker: quickRunner, exec: slowCleanup }),
    );
    expect(thirdOutcome.refused).toBe(false);

    // Two containers actually ran; each settled once and wrote one record.
    expect(settlements).toBe(2);
    expect(runDirsFor(first.id)).toHaveLength(1);
    expect(runDirsFor(third.id)).toHaveLength(1);

    // Unique names, one removal each, and nothing cleared before a run.
    const firstName = (readRecord(firstOutcome).checks as CheckRecord[])[0]!.container_name!;
    const thirdName = (readRecord(thirdOutcome).checks as CheckRecord[])[0]!.container_name!;
    expect(firstName).not.toBe(thirdName);
    expect(auxCalls.filter((argv) => argv[1] === 'rm').map((argv) => argv[3])).toEqual([firstName, thirdName]);
  }, 30_000);

  it('(v) turns a spawn failure into a recorded stop and releases the mutex', async () => {
    const runner = counted(
      createDockerRunner({
        spawnFn: () => {
          const child = new FakeChild();
          children.push(child);
          // No handshake: a client that never started produces no stdout at
          // all. The check is therefore `setup_failed`, and `spawn_failed`
          // outranks it as the reason the run stopped.
          setTimeout(() => child.emit('error', new Error('spawn docker ENOENT')), 5);
          return child.asChildProcess();
        },
        exec: async () => ok(),
        graceMs: 50,
      }),
    );

    const row = await delivered(['true', 'true']);
    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps({ runDocker: runner }));

    expect(outcome.refused).toBe(false);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('spawn_failed');
    expect(outcome.persistence).toEqual({ filesystem: 'ok', ledger_event: 'ok' });
    expect(settlements).toBe(1);

    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.map((c) => c.status)).toEqual(['setup_failed', 'not_run']);
    expect(checks[0]!.handshake).toBe('missing');
    expect(checks[0]!.exit_code).toBe(-1);
    expect(fs.readFileSync(path.join(outcome.runDir!, 'check-1.stderr.txt'), 'utf8')).toContain('spawn docker ENOENT');

    // The name was still proved free, and the mutex is released.
    expect(auxCalls.filter((argv) => argv[1] === 'rm')).toHaveLength(1);
    const next = await delivered();
    expect((await runChecksAction({ handoff_id: next.id }, session(), deps({ runDocker: runner }))).refused).toBe(
      false,
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The removal proof, in isolation.
// ---------------------------------------------------------------------------
describe("removeContainerConfirmed only believes docker's own words", () => {
  function scripted(replies: ExecResult[]): { exec: ExecRunner; calls: string[][] } {
    const calls: string[][] = [];
    let inspects = 0;
    const exec: ExecRunner = async (file, argv) => {
      calls.push([file, ...argv]);
      if (argv[0] === 'inspect') return replies[Math.min(inspects++, replies.length - 1)]!;
      return ok('');
    };
    return { exec, calls };
  }

  it('confirms only a NON-ZERO inspect whose stderr says "No such container"', async () => {
    const { exec, calls } = scripted([gone('ncl-verify-x-c1')]);
    const result = await removeContainerConfirmed('ncl-verify-x-c1', exec);
    expect(result).toMatchObject({ outcome: 'confirmed', confirmed: true, attempts: 1 });
    expect(calls).toEqual([
      ['docker', 'rm', '-f', 'ncl-verify-x-c1'],
      ['docker', 'inspect', '--type', 'container', 'ncl-verify-x-c1'],
    ]);
    expect(NO_SUCH_CONTAINER_RE.test('Error response from daemon: No such container: x')).toBe(true);
  });

  it('does NOT confirm a zero exit, however healthy the daemon looks', async () => {
    const { exec, calls } = scripted([{ code: 0, stdout: '[{"Id":"abc"}]', stderr: '', ok: true, timedOut: false }]);
    const result = await removeContainerConfirmed('n', exec);
    expect(result).toMatchObject({ outcome: 'unconfirmed', confirmed: false, attempts: 3 });
    // Three full rounds of rm + inspect, then fail closed.
    expect(calls).toHaveLength(6);
  });

  it('does NOT confirm a daemon error that is not the "No such container" text', async () => {
    const { exec } = scripted([
      { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon\n', ok: false, timedOut: false },
    ]);
    expect(await removeContainerConfirmed('n', exec)).toMatchObject({ outcome: 'unconfirmed', attempts: 3 });
  });

  it('does NOT confirm an empty stderr, and calls a killed call uncertain', async () => {
    const { exec: quiet } = scripted([{ code: 1, stdout: '', stderr: '', ok: false, timedOut: false }]);
    expect(await removeContainerConfirmed('n', quiet)).toMatchObject({ outcome: 'unconfirmed' });

    const { exec: killed } = scripted([
      { code: 1, stdout: '', stderr: '', ok: false, timedOut: true, error: 'SIGKILL' },
    ]);
    expect(await removeContainerConfirmed('n', killed)).toMatchObject({ outcome: 'uncertain', confirmed: false });
  });

  it('stops retrying as soon as it is confirmed', async () => {
    const { exec, calls } = scripted([{ code: 0, stdout: '', stderr: '', ok: true, timedOut: false }, gone('n')]);
    expect(await removeContainerConfirmed('n', exec)).toMatchObject({ outcome: 'confirmed', attempts: 2 });
    expect(calls).toHaveLength(4);
  });

  it('bounds both calls at 10 s by default', async () => {
    const seen: Array<number | undefined> = [];
    const exec: ExecRunner = async (_file, argv, options) => {
      seen.push(options?.timeoutMs);
      return argv[0] === 'inspect' ? gone('n') : ok('');
    };
    await removeContainerConfirmed('n', exec);
    expect(seen).toEqual([10_000, 10_000]);
  });
});

// ---------------------------------------------------------------------------
// The output bound.
// ---------------------------------------------------------------------------
describe('stdout and stderr are stream-bounded', () => {
  it('stores at most the cap, counts everything, and never buffers past the cap', () => {
    const cap = 1_048_576;
    const sink = new CappedSink(cap);
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let peak = 0;
    // 5 MB in 64 KB chunks, the way an `on('data')` handler receives them.
    for (let written = 0; written < 5_000_000; written += chunk.length) {
      sink.push(chunk);
      // The assertion that matters: the ceiling holds DURING streaming, not
      // only once the child has exited.
      peak = Math.max(peak, sink.bufferedBytes());
      expect(sink.bufferedBytes()).toBeLessThanOrEqual(cap);
    }
    expect(peak).toBe(cap);
    expect(sink.total).toBeGreaterThanOrEqual(5_000_000);
    expect(sink.truncated).toBe(true);
    expect(Buffer.byteLength(sink.text(), 'utf8')).toBe(cap);
  });

  it('keeps draining a 5 MB check through the real runner and flags the truncation', async () => {
    const cap = 1_048_576;
    writeConfig({ outputBytes: cap, perCommandSeconds: 30 });
    const chunk = Buffer.alloc(100_000, 0x79);
    const runner = counted(
      createDockerRunner({
        spawnFn: () => {
          const child = new FakeChild();
          children.push(child);
          handshake(child);
          setTimeout(() => {
            for (let i = 0; i < 50; i++) child.stdout.emit('data', chunk);
            child.stderr.emit('data', Buffer.alloc(2_000_000, 0x7a));
            child.emit('close', 0);
          }, 5);
          return child.asChildProcess();
        },
        exec: async () => ok(),
        graceMs: 50,
      }),
    );

    const row = await delivered(["head -c 5000000 /dev/zero | tr '\\0' x"]);
    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps({ runDocker: runner }));

    const check = (readRecord(outcome).checks as CheckRecord[])[0]!;
    expect(check.stdout_bytes).toBe(5_000_000);
    expect(check.stderr_bytes).toBe(2_000_000);
    expect(check.stdout_truncated).toBe(true);
    expect(check.stderr_truncated).toBe(true);
    // Stored, not counted: the file on disk is exactly the cap.
    expect(fs.statSync(path.join(outcome.runDir!, 'check-1.stdout.txt')).size).toBe(cap);
    expect(fs.statSync(path.join(outcome.runDir!, 'check-1.stderr.txt')).size).toBe(cap);
    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Names.
// ---------------------------------------------------------------------------
describe('container names', () => {
  it('are unique per run AND per check, and are legal docker names', () => {
    const runId = newRunId();
    const a = containerNameFor('ag-echodeadbeef', 'COS-07', runId, 1);
    const b = containerNameFor('ag-echodeadbeef', 'COS-07', runId, 2);
    const c = containerNameFor('ag-echodeadbeef', 'COS-07', newRunId(), 1);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a.endsWith('-c1')).toBe(true);
    expect(b.endsWith('-c2')).toBe(true);
    for (const name of [a, b, c]) {
      expect(name.startsWith('ncl-verify-ag-echod-COS-07-')).toBe(true);
      // Docker accepts [a-zA-Z0-9][a-zA-Z0-9_.-]* only.
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    }
    // 1,000 ids in the same millisecond still collide only by chance.
    expect(new Set(Array.from({ length: 1000 }, () => newRunId())).size).toBeGreaterThan(990);
  });
});
