/**
 * The real container matrix (P1-P13). Gated on VERIFIER_DOCKER=1 because it
 * needs a working Docker daemon and the agent image.
 *
 *   VERIFIER_DOCKER=1 pnpm exec vitest run src/modules/verifier/docker.integration.test.ts
 *
 * Override the image with VERIFIER_TEST_IMAGE and the gate directory with
 * VERIFIER_TEST_GATE_DIR (it must contain the final `run-check.sh`, and must
 * NOT contain `verify.sh` or `run.sh`).
 *
 * Nothing here touches the production tree: the repository, the config, the
 * allowlist, the data directory and the database are all temporary.
 */
import { execFileSync } from 'child_process';
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
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';
import { createHandoff, deliverHandoffWithInputs, reviewHandoff } from '../handoff-ledger/ledger.js';
import '../handoff-ledger/migration.js';
import './migration.js';
import { execNoShell, realRunDocker, type DockerRunOptions } from './docker.js';
import { runChecksAction, type RunChecksOutcome, type VerifierDeps } from './index.js';
import type { CheckRecord } from './record.js';

const ECHO = 'ag-echo';
const ATLAS = 'ag-atlas';

/**
 * Everything that lives on the host side of the boundary and must not cross it:
 * an untracked secret, a file that exists only on another branch, the dirty
 * working-tree content, and the repository's own absolute path.
 */
const SECRET = 'do-not-leak';
const BRANCH_SECRET = 'BRANCH-LEAK';
const DIRTY = 'dirty';

/**
 * The same two needles, written so the LITERAL never appears in the command
 * text. The shell concatenates the halves, so `grep` receives the whole string,
 * but a check's own captured output — which can echo its command — does not
 * contain it. Without this the leak assertion would be searching for a needle
 * it had planted in the haystack itself.
 */
const SECRET_NEEDLE = '"do-not""-leak"';
const BRANCH_NEEDLE = '"BRANCH""-LEAK"';

const IMAGE = process.env.VERIFIER_TEST_IMAGE || 'nanoclaw-agent-v2-eacf8390:latest';
const GATE_DIR = process.env.VERIFIER_TEST_GATE_DIR || path.resolve(process.cwd(), '..', 'gate');

let tmpDir: string;
let repoDir: string;
let dataDir: string;
let configPath: string;
let checkpoint: string;
let headCommit: string;
let counter = 0;
/** Every `docker run` this run made: the argv and what went on its stdin. */
let dockerCalls: Array<{ argv: string[]; options: DockerRunOptions }>;

function git(...argv: string[]): string {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...argv], {
    cwd: repoDir,
    encoding: 'utf8',
  });
}

function docker(...argv: string[]): string {
  return execFileSync('docker', argv, { encoding: 'utf8' });
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
    gateDir: GATE_DIR,
    tmpRoot: tmpDir,
    // The real runner, wrapped only to record what it was handed.
    runDocker: async (file, argv, options) => {
      dockerCalls.push({ argv, options });
      return realRunDocker(file, argv, options);
    },
    exec: execNoShell,
    resolveImageRef: async () => IMAGE,
    ...over,
  };
}

function session(): Session {
  return {
    id: 'sess-int',
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

async function deliverChecks(checks: string[], reproduce: string[] = []): Promise<string> {
  const id = `INT-${++counter}`;
  const row = await createHandoff({
    id,
    sourceAgentGroupId: ATLAS,
    reviewerAgentGroupId: ECHO,
    project: 'FIXTURE',
    goal: 'Exercise the real per-check sandbox',
    outcome: 'A host-attested evidence record',
    scope: 'verifier module only',
    authority: 'execute',
  });
  await deliverHandoffWithInputs({
    id: row.id,
    actor: ATLAS,
    fingerprint: row.fingerprint,
    inputs: { class: 'fix', checkpoint, checks, reproduce },
  });
  return row.id;
}

async function runWith(
  checks: string[],
  reproduce: string[] = [],
  over: Partial<VerifierDeps> = {},
): Promise<RunChecksOutcome> {
  const id = await deliverChecks(checks, reproduce);
  return runChecksAction({ handoff_id: id }, session(), deps(over));
}

function readRecord(outcome: RunChecksOutcome): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(outcome.runDir!, 'record.json'), 'utf8'));
}

function checksOf(outcome: RunChecksOutcome): CheckRecord[] {
  return readRecord(outcome).checks as CheckRecord[];
}

function outputOf(outcome: RunChecksOutcome, index: number, stream: 'stdout' | 'stderr' = 'stdout'): string {
  const file = path.join(outcome.runDir!, `check-${index}.${stream}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Any archive directory the verifier failed to clean up (matched by its tar). */
function leftoverArchiveDirs(): string[] {
  return fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith('ncl-verify-'))
    .filter((name) => fs.existsSync(path.join(tmpDir, name, 'checkpoint.tar')));
}

function stillListed(name: string): string {
  return docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}').trim();
}

const dockerEnabled = process.env.VERIFIER_DOCKER === '1';

describe.skipIf(!dockerEnabled)('verifier per-CHECK docker matrix', () => {
  beforeEach(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-verify-int-')));
    repoDir = path.join(tmpDir, 'allowed', 'fixture-repo');
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    dockerCalls = [];

    fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
    fs.writeFileSync(path.join(repoDir, 'test.js'), 'if (2 + 2 !== 4) { process.exit(1); }\n');
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'original\n');
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    git('add', '.');
    git('commit', '-q', '-m', 'fixture');
    checkpoint = git('rev-parse', 'HEAD').trim();

    // Everything below happens AFTER the checkpoint, so none of it may reach a
    // container: an untracked secret, a dirty working tree, a newer commit, a
    // second branch and a tag.
    const defaultBranch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    fs.writeFileSync(path.join(repoDir, 'secret.env'), `TOKEN=${SECRET}\n`);
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'newer\n');
    git('add', 'tracked.txt');
    git('commit', '-q', '-m', 'newer');

    git('checkout', '-q', '-b', 'feature/leak', checkpoint);
    fs.writeFileSync(path.join(repoDir, 'branch-only.txt'), `${BRANCH_SECRET}\n`);
    git('add', 'branch-only.txt');
    git('commit', '-q', '-m', 'branch only');
    git('tag', 'leak-tag');
    git('checkout', '-q', defaultBranch);
    expect(fs.existsSync(path.join(repoDir, 'branch-only.txt'))).toBe(false);

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'dirty\n');
    headCommit = git('rev-parse', 'HEAD').trim();
    expect(headCommit).not.toBe(checkpoint);

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

  it('the gate directory holds run-check.sh and neither retired script', () => {
    expect(fs.existsSync(path.join(GATE_DIR, 'run-check.sh'))).toBe(true);
    expect(fs.existsSync(path.join(GATE_DIR, 'verify.sh'))).toBe(false);
    expect(fs.existsSync(path.join(GATE_DIR, 'run.sh'))).toBe(false);
  });

  it('P1: three passing checks run in three containers, all confirmed removed', async () => {
    const outcome = await runWith(['test $((2+2)) -eq 4', 'node test.js', 'test -f package.json']);

    expect(outcome.refused).toBe(false);
    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
    expect(outcome.error_reason).toBeNull();
    expect(outcome.checks_ran).toBe(3);
    expect(dockerCalls).toHaveLength(3);

    const record = readRecord(outcome);
    const checks = checksOf(outcome);
    expect(checks.map((c) => c.status)).toEqual(['ran', 'ran', 'ran']);
    expect(checks.map((c) => c.exit_code)).toEqual([0, 0, 0]);
    expect(checks.every((c) => c.removal_confirmed)).toBe(true);
    expect(checks.every((c) => c.removal_attempts === 1)).toBe(true);
    expect(new Set(checks.map((c) => c.container_name)).size).toBe(3);

    // Docker itself says each container is gone — the same words the verifier
    // required before starting the next check.
    for (const check of checks) {
      expect(stillListed(check.container_name!)).toBe('');
      let stderr = '';
      try {
        docker('inspect', '--type', 'container', check.container_name!);
        throw new Error('inspect should have failed');
      } catch (err) {
        stderr = String((err as { stderr?: Buffer }).stderr ?? (err as Error).message);
      }
      expect(stderr).toMatch(/No such container/);
    }

    expect(record.image_ref).toBe(IMAGE);
    expect(record.image_id).toMatch(/^sha256:/);
    expect(record.gate_run_check_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.checkpoint).toBe(checkpoint);

    const { createHash } = await import('crypto');
    const bytes = fs.readFileSync(path.join(outcome.runDir!, 'record.json'));
    expect(fs.readFileSync(path.join(outcome.runDir!, 'record.sha256'), 'utf8').trim()).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );

    const event = await getDb().get<{ payload_json: string; actor_agent_group_id: string }>(
      "SELECT * FROM handoff_events WHERE event_type = 'verification' ORDER BY rowid DESC LIMIT 1",
    );
    expect(event!.actor_agent_group_id).toBe('host:verifier');
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      record_sha256: outcome.recordSha256,
      verdict: 'ALL_CHECKS_PASSED',
      checks_ran: 3,
    });
    expect(notifications.messages[0]).toContain('verdict: ALL_CHECKS_PASSED');
    expect(leftoverArchiveDirs()).toEqual([]);
  }, 300_000);

  it('P2: a failing check does not stop the run; the verdict is CHECK_FAILED', async () => {
    const outcome = await runWith(['true', 'false', 'true']);

    expect(dockerCalls).toHaveLength(3);
    expect(outcome.verdict).toBe('CHECK_FAILED');
    expect(outcome.checks_ran).toBe(3);
    const checks = checksOf(outcome);
    expect(checks.map((c) => c.status)).toEqual(['ran', 'ran', 'ran']);
    expect(checks.map((c) => c.exit_code)).toEqual([0, 1, 0]);
    expect(checks.every((c) => c.removal_confirmed)).toBe(true);
    for (const check of checks) expect(stillListed(check.container_name!)).toBe('');
  }, 300_000);

  it('P3: a check killed at its cap does not stop the run; the verdict is TIMED_OUT', async () => {
    writeConfig({ perCommandSeconds: 5 });
    const outcome = await runWith(['sleep 1000', 'true']);

    expect(dockerCalls).toHaveLength(2);
    const checks = checksOf(outcome);
    expect(checks[0]!.timed_out).toBe(true);
    // The cap plus the 5 s grace, and generous room for docker's own latency.
    expect(checks[0]!.wall_seconds!).toBeLessThan(5 + 5 + 20);
    expect(checks[0]!.cap_seconds).toBe(5);
    expect(checks[0]!.removal_confirmed).toBe(true);
    // c2 still ran, in its own container, and passed.
    expect(checks[1]!.status).toBe('ran');
    expect(checks[1]!.exit_code).toBe(0);
    expect(outcome.verdict).toBe('TIMED_OUT');
    for (const check of checks) expect(stillListed(check.container_name!)).toBe('');
  }, 300_000);

  it('P4: a detached grandchild cannot survive into the next check', async () => {
    // c1 leaves a `setsid` process group behind and exits 0 anyway. Under the
    // old in-container sweep this was the hard case; here the container's PID
    // namespace is torn down with it.
    const outcome = await runWith([
      "setsid bash -c 'sleep 300 & wait' & sleep 0.3; true",
      'test -z "$(pgrep -x sleep)"',
    ]);

    const checks = checksOf(outcome);
    expect(outcome.verdict, outputOf(outcome, 2, 'stderr')).toBe('ALL_CHECKS_PASSED');
    expect(checks.map((c) => c.exit_code)).toEqual([0, 0]);

    // The ordering that makes it true: c1's container was confirmed gone BEFORE
    // c2 started.
    expect(checks[0]!.removal_confirmed).toBe(true);
    expect(Date.parse(checks[1]!.started_at!)).toBeGreaterThanOrEqual(Date.parse(checks[0]!.finished_at!));
    expect(checks[0]!.container_name).not.toBe(checks[1]!.container_name);
    for (const check of checks) expect(stillListed(check.container_name!)).toBe('');
  }, 300_000);

  it('P5: a file written to /work in one check is not there in the next', async () => {
    const outcome = await runWith(['touch /work/marker', 'test ! -e /work/marker']);
    expect(outcome.verdict, outputOf(outcome, 2, 'stderr')).toBe('ALL_CHECKS_PASSED');
    expect(checksOf(outcome).map((c) => c.exit_code)).toEqual([0, 0]);
  }, 300_000);

  it('P6: hostile REPRODUCE commands are recorded and displayed, never executed', async () => {
    const hostile = [
      'touch /work/reproduce-ran',
      'touch /work/tree/reproduce-ran',
      '$(touch /work/reproduce-subst)',
      '`touch /work/reproduce-backtick`',
      '; touch /work/reproduce-semi;',
      'rm -rf /work/tree',
    ];
    const outcome = await runWith(
      [
        'test ! -e /work/reproduce-ran',
        'test ! -e /work/tree/reproduce-ran',
        'test ! -e /work/reproduce-subst',
        'test ! -e /work/reproduce-backtick',
        'test ! -e /work/reproduce-semi',
        'test -f /work/tree/package.json',
      ],
      hostile,
    );

    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
    // The strings are in no argv and on no stdin.
    for (const call of dockerCalls) {
      for (const command of hostile) {
        expect(call.options.stdin).not.toContain(command);
        expect(call.argv.some((element) => element.includes(command))).toBe(false);
      }
    }
    expect(readRecord(outcome).reproduce).toEqual(hostile);
    const message = notifications.messages[0]!;
    expect(message).toContain('REPRODUCE (documentation only, not executed):');
    for (const command of hostile) expect(message).toContain(command);
  }, 300_000);

  it('P8: a container sees the checkpoint tar and nothing else of the repository', async () => {
    const outcome = await runWith([
      'test -f /work/tree/tracked.txt',
      'grep -qx original /work/tree/tracked.txt',
      'test ! -e /work/tree/secret.env',
      'test ! -e /work/tree/.git',
      'test ! -e /src',
      'test ! -e /work/tree/branch-only.txt',
      `grep -rq ${SECRET_NEEDLE} /work/tree /archive /gate; test $? -ne 0`,
      `grep -rq ${BRANCH_NEEDLE} /work/tree /archive /gate; test $? -ne 0`,
    ]);

    expect(outcome.refused).toBe(false);
    const checks = checksOf(outcome);
    const failed = checks.filter((c) => c.exit_code !== 0).map((c) => `c${c.index}: ${c.command}`);
    expect(outcome.verdict, failed.join('\n')).toBe('ALL_CHECKS_PASSED');

    const record = readRecord(outcome);
    expect(record.checkpoint).toBe(checkpoint);
    expect(record.archive_bytes as number).toBeGreaterThan(0);

    // ---- Nothing on the host side of the boundary appears in the evidence ----
    const recordText = fs.readFileSync(path.join(outcome.runDir!, 'record.json'), 'utf8');
    const notifyText = notifications.messages.join('\n');
    const outputs = checks
      .map((c) => `${outputOf(outcome, c.index)}\n${outputOf(outcome, c.index, 'stderr')}`)
      .join('\n');

    // `host_path` is the ONE place the repository path is allowed to be, and it
    // is a record field, not evidence.
    expect(record.host_path).toBe(repoDir);
    const recordWithoutHostPath = recordText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('"host_path"'))
      .join('\n');

    for (const [label, haystack] of [
      ['per-check outputs', outputs],
      ['record.json (minus host_path)', recordWithoutHostPath],
      ['notifyAgent text', notifyText],
    ] as const) {
      for (const needle of [SECRET, BRANCH_SECRET, DIRTY, repoDir]) {
        expect(haystack.includes(needle), `${needle} leaked into ${label}`).toBe(false);
      }
    }
    expect(notifyText).not.toContain('host_path');

    // The recorded hash is the hash of a host-side `git archive` of the same
    // checkpoint, byte for byte.
    const reference = path.join(tmpDir, 'reference.tar');
    execFileSync('git', ['-C', repoDir, 'archive', '--format=tar', '-o', reference, checkpoint]);
    const { createHash } = await import('crypto');
    expect(record.archive_sha256).toBe(createHash('sha256').update(fs.readFileSync(reference)).digest('hex'));
    expect(record.archive_bytes).toBe(fs.statSync(reference).size);

    // The working tree on the host is still dirty and HEAD is still ahead.
    expect(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8')).toBe('dirty\n');
    expect(git('rev-parse', 'HEAD').trim()).toBe(headCommit);
    expect(leftoverArchiveDirs()).toEqual([]);
  }, 300_000);

  it('P9: the argv carries no host path and a running check has exactly two mounts', async () => {
    writeConfig({ perCommandSeconds: 60 });
    const id = await deliverChecks(['sleep 8', 'true']);
    const running = runChecksAction({ handoff_id: id }, session(), deps());

    // Catch c1 while it is alive and ask docker what is mounted into it.
    let mounts: Array<{ Source: string; Destination: string; RW: boolean }> = [];
    for (let i = 0; i < 200 && mounts.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const name = dockerCalls[0]?.options.containerName;
      if (!name || stillListed(name) === '') continue;
      try {
        mounts = JSON.parse(docker('inspect', '--format', '{{json .Mounts}}', name).trim());
        // eslint-disable-next-line no-catch-all/no-catch-all -- the container may exit mid-inspect
      } catch {
        // Try again on the next tick.
      }
    }
    const outcome = await running;

    expect(mounts).toHaveLength(2);
    expect(mounts.map((m) => m.Destination).sort()).toEqual(['/archive/checkpoint.tar', '/gate/run-check.sh']);
    expect(mounts.every((m) => m.RW === false)).toBe(true);
    expect(mounts.some((m) => m.Source.includes(repoDir))).toBe(false);

    // ...and the argv agrees, for every check.
    for (const call of dockerCalls) {
      expect(call.argv.filter((element, i) => call.argv[i - 1] === '-v')).toHaveLength(2);
      for (const element of call.argv) {
        for (const forbidden of [repoDir, dataDir, 'data/', '.env', 'docker.sock', '/workspace', 'groups/', 'sh -c']) {
          expect(element.includes(forbidden), `${forbidden} appeared in ${element}`).toBe(false);
        }
      }
      expect(call.argv[call.argv.length - 1]).toBe('/gate/run-check.sh');
    }
    // The command text is only ever on stdin.
    expect(dockerCalls.map((call) => call.options.stdin)).toEqual(['sleep 8', 'true']);
    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
  }, 300_000);

  it('P11: the overall deadline stops the run and outranks a check that timed out', async () => {
    writeConfig({ wallSeconds: 8, perCommandSeconds: 300 });
    const outcome = await runWith(['sleep 5', 'sleep 5', 'true']);

    const checks = checksOf(outcome);
    expect(checks[0]!.status).toBe('ran');
    expect(checks[0]!.exit_code).toBe(0);
    // c1's cap was what remained of the whole budget — the deadline started
    // before the archive export, so it is a shade under 8 — not the 300 s
    // perCommandSeconds.
    expect(checks[0]!.cap_seconds!).toBeGreaterThan(7);
    expect(checks[0]!.cap_seconds!).toBeLessThanOrEqual(8);

    // c2 either ran on the remainder and was killed by it, or never started
    // because less than a second was left. Both are the deadline biting; which
    // one depends on docker's own start-up latency on the day.
    if (checks[1]!.status === 'ran') {
      expect(checks[1]!.timed_out).toBe(true);
      expect(checks[1]!.cap_seconds!).toBeLessThan(300);
    }
    expect(checks[2]!.status).toBe('not_run');
    expect(checks[2]!.container_name).toBeNull();

    // Documented precedence: the deadline is why we stopped, so VERIFIER_ERROR
    // wins over the TIMED_OUT that c2 would otherwise have produced.
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('deadline');
    expect(notifications.messages[0]).toContain('error_reason: deadline');
    expect(notifications.messages[0]).toContain('c3 not_run exit=-');
    for (const check of checks.filter((c) => c.container_name)) {
      expect(stillListed(check.container_name!)).toBe('');
    }
  }, 300_000);

  it('P12: a 5 MB check is counted in full and stored at the 1 MB cap', async () => {
    const outcome = await runWith(["head -c 5000000 /dev/zero | tr '\\0' x"]);

    const check = checksOf(outcome)[0]!;
    expect(check.exit_code).toBe(0);
    expect(check.stdout_bytes).toBe(5_000_000);
    expect(check.stdout_truncated).toBe(true);
    expect(fs.statSync(path.join(outcome.runDir!, 'check-1.stdout.txt')).size).toBe(1_048_576);
    expect(outcome.verdict).toBe('ALL_CHECKS_PASSED');
  }, 300_000);

  // -------------------------------------------------------------------------
  // I1-I5: the correction batch, against real containers.
  // -------------------------------------------------------------------------

  it('I1: exit 4, 125, 126 and 127 from a CHECK are ordinary CHECK failures', async () => {
    // Every one of these is also an exit code the DAEMON or the gate script can
    // produce. The handshake is what tells them apart: with it verified, these
    // four belong to the check and the run continues through all five.
    const outcome = await runWith(['exit 4', 'exit 125', 'exit 126', 'exit 127', 'true']);

    expect(dockerCalls).toHaveLength(5);
    expect(outcome.checks_ran).toBe(5);
    expect(outcome.verdict).toBe('CHECK_FAILED');
    expect(outcome.error_reason).toBeNull();

    const checks = checksOf(outcome);
    expect(checks.map((c) => c.status)).toEqual(['ran', 'ran', 'ran', 'ran', 'ran']);
    expect(checks.map((c) => c.exit_code)).toEqual([4, 125, 126, 127, 0]);
    expect(checks.every((c) => c.handshake === 'ok')).toBe(true);
    expect(checks.every((c) => c.removal_confirmed)).toBe(true);
    expect(new Set(checks.map((c) => c.container_name)).size).toBe(5);
    for (const check of checks) expect(stillListed(check.container_name!)).toBe('');
    // Nothing the containers printed reached the verdict.
    expect(notifications.messages[0]).toContain('verdict: CHECK_FAILED');
  }, 300_000);

  it('I2: a corrupt checkpoint archive is setup_failed, and no later check runs', async () => {
    // The export is intercepted and a zero-byte file is left where the tar
    // should be, so `tar -x` inside the container fails and `run-check.sh`
    // exits 4 BEFORE its printf. Exit 4 with no handshake is infrastructure.
    const outcome = await runWith(['true', 'true'], [], {
      exec: async (file, argv, options) => {
        if (file === 'git' && argv.includes('archive')) {
          fs.writeFileSync(argv[argv.indexOf('-o') + 1]!, '');
          return { code: 0, stdout: '', stderr: '', ok: true, timedOut: false };
        }
        return execNoShell(file, argv, options);
      },
    });

    expect(dockerCalls).toHaveLength(1);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('setup_failed');
    expect(outcome.checks_ran).toBe(0);

    const checks = checksOf(outcome);
    expect(checks.map((c) => c.status)).toEqual(['setup_failed', 'not_run']);
    expect(checks[0]!.handshake).toBe('missing');
    expect(checks[0]!.exit_code).toBe(4);
    expect(checks[0]!.removal_confirmed).toBe(true);
    expect(stillListed(checks[0]!.container_name!)).toBe('');
    expect(outputOf(outcome, 1, 'stderr')).toContain('tar');
    expect(notifications.messages[0]).toContain('c1 setup_failed exit=4');
    expect(notifications.messages[0]).toContain('handshake=missing');
  }, 300_000);

  it('I3: a docker startup failure is setup_failed, and zero user CHECKS ran', async () => {
    // A tag that does not exist: the daemon refuses to start anything and the
    // CLI exits 125 with nothing on stdout. Documented outcome: `setup_failed`,
    // NOT `spawn_failed` — the docker client itself started perfectly well, so
    // `spawnFailed` is false; what failed is the container's own startup.
    writeConfig({ perCommandSeconds: 120 });
    const outcome = await runWith(['true', 'true'], [], {
      resolveImageRef: async () => `${IMAGE.split(':')[0]}:no-such-tag-for-the-verifier-test`,
    });

    expect(dockerCalls).toHaveLength(1);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('setup_failed');
    expect(outcome.checks_ran).toBe(0);

    const checks = checksOf(outcome);
    expect(checks.map((c) => c.status)).toEqual(['setup_failed', 'not_run']);
    expect(checks[0]!.handshake).toBe('missing');
    expect(checks[0]!.exit_code).toBe(125);
    expect(checks[0]!.removal_confirmed).toBe(true);
    expect(outputOf(outcome, 1)).toBe('');
    expect(outputOf(outcome, 1, 'stderr')).toMatch(
      /Unable to find image|pull access denied|Error response from daemon/,
    );
    // The image could not be inspected either; the record says so honestly.
    expect(readRecord(outcome).image_id).toBeNull();
    expect(stillListed(checks[0]!.container_name!)).toBe('');
  }, 300_000);

  it('I4: the overall deadline cuts the second check short and outranks its timeout', async () => {
    writeConfig({ wallSeconds: 6, perCommandSeconds: 300 });
    const startedMs = Date.now();
    const outcome = await runWith(['sleep 4', 'sleep 4']);
    const elapsed = (Date.now() - startedMs) / 1000;

    const checks = checksOf(outcome);
    expect(checks[0]!.status).toBe('ran');
    expect(checks[0]!.exit_code).toBe(0);
    expect(checks[0]!.cap_seconds!).toBeLessThanOrEqual(6);

    // c2 gets whatever is left of the 6 s — about 2 s once c1's four have gone
    // — and is killed by it. If docker's start-up latency on the day leaves
    // under a second, the host refuses to start c2 at all; both are the
    // deadline biting, and both end the same way.
    if (checks[1]!.status === 'ran') {
      expect(checks[1]!.timed_out).toBe(true);
      expect(checks[1]!.cap_seconds!).toBeLessThan(3);
      expect(checks[1]!.removal_confirmed).toBe(true);
    } else {
      expect(checks[1]!.status).toBe('not_run');
    }

    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('deadline');
    expect(elapsed).toBeLessThan(60);
    for (const check of checks.filter((c) => c.container_name)) {
      expect(check.removal_confirmed).toBe(true);
      expect(stillListed(check.container_name!)).toBe('');
    }
  }, 300_000);

  it('I5: a handoff that leaves `delivered` between checks stops with invalid_input', async () => {
    const id = await deliverChecks(['true', 'true']);
    const row = (await getDb().get<{ fingerprint: string }>('SELECT fingerprint FROM handoffs WHERE id = ?', id))!;
    const base = deps();

    const outcome = await runChecksAction(
      { handoff_id: id },
      session(),
      deps({
        runDocker: async (file, argv, options) => {
          const result = await base.runDocker(file, argv, options);
          // The reviewer's own verdict lands, through the real ledger function,
          // while the verifier is between containers.
          if (dockerCalls.length === 1) await reviewHandoff(id, ECHO, row.fingerprint, 'CHANGES REQUIRED');
          return result;
        },
      }),
    );

    expect(dockerCalls).toHaveLength(1);
    expect(outcome.verdict).toBe('VERIFIER_ERROR');
    expect(outcome.error_reason).toBe('invalid_input');

    const record = readRecord(outcome);
    expect(record.invalid_input_detail).toBe('status');
    const checks = record.checks as CheckRecord[];
    expect(checks.map((c) => c.status)).toEqual(['ran', 'not_run']);
    expect(checks[0]!.removal_confirmed).toBe(true);
    expect(checks[1]!.container_name).toBeNull();
    expect(stillListed(checks[0]!.container_name!)).toBe('');
    expect(notifications.messages[0]).toContain('error_reason: invalid_input (status)');

    // The handoff itself was not touched by the verifier; Echo's transition stands.
    const after = await getDb().get<{ status: string }>('SELECT status FROM handoffs WHERE id = ?', id);
    expect(after!.status).toBe('changes_required');
  }, 300_000);

  it('P13: a gate directory that still has a retired script is refused, with no container', async () => {
    const legacyGate = path.join(tmpDir, 'legacy-gate');
    fs.mkdirSync(legacyGate, { recursive: true });
    fs.copyFileSync(path.join(GATE_DIR, 'run-check.sh'), path.join(legacyGate, 'run-check.sh'));
    fs.writeFileSync(path.join(legacyGate, 'verify.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

    const before = docker('ps', '-a', '--filter', 'name=ncl-verify-', '--format', '{{.Names}}').trim();
    const outcome = await runWith(['true'], [], { gateDir: legacyGate });

    expect(outcome.refused).toBe(true);
    expect(outcome.reason).toBe('legacy_gate_scripts_present: verify.sh');
    expect(dockerCalls).toHaveLength(0);
    expect(docker('ps', '-a', '--filter', 'name=ncl-verify-', '--format', '{{.Names}}').trim()).toBe(before);
  }, 300_000);
});
