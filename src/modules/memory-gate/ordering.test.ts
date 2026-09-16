/**
 * Implementation-review corrections (2026-09-16): creation order survives a
 * retryable failure, and completion validates the memory root the way the
 * spawn preflight does.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-memory-gate-ordering';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-memory-gate-ordering/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-memory-gate-ordering/groups',
  };
});

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';
import { completePendingOps, enqueueMemoryOp, getMemoryOp, type CompletionDeps } from './ops.js';

const GROUP = 'ag-order';
const FOLDER = 'order';
const groupDir = path.join(TEST_ROOT, 'groups', FOLDER);
const memoryDir = path.join(groupDir, 'memory');
const deps: CompletionDeps = { notifyAgent: async () => {}, notifyOwner: async () => {}, now: () => new Date() };

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
  fs.mkdirSync(groupDir, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: GROUP,
    name: 'Order',
    folder: FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

async function enqueue(requestId: string, content: string, p = 'notes.md'): Promise<void> {
  await enqueueMemoryOp({
    agentGroupId: GROUP,
    requestId,
    sessionId: 'sess-order',
    kind: 'free',
    path: p,
    mode: 'append',
    content,
  });
}

describe('completion order and root validation', () => {
  it('a later op never overtakes an earlier one that failed transiently', async () => {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'notes.md'), 'start\n');
    const { prepareMemoryRoot } = await import('../../memory-scaffold.js');
    await prepareMemoryRoot(groupDir); // scaffold up front so the unwritable dir only breaks the op's temp file
    await enqueue('first', 'first line');
    await enqueue('second', 'second line');

    // First attempt: the directory is not writable, so the temp file cannot be created.
    fs.chmodSync(memoryDir, 0o500);
    await completePendingOps(deps);
    fs.chmodSync(memoryDir, 0o755);
    expect((await getMemoryOp(GROUP, 'first'))?.status).toBe('prepared');
    expect((await getMemoryOp(GROUP, 'second'))?.status).toBe('queued');
    expect(fs.readFileSync(path.join(memoryDir, 'notes.md'), 'utf8')).toBe('start\n');

    await completePendingOps(deps);
    expect((await getMemoryOp(GROUP, 'first'))?.status).toBe('applied');
    expect((await getMemoryOp(GROUP, 'second'))?.status).toBe('applied');
    expect(fs.readFileSync(path.join(memoryDir, 'notes.md'), 'utf8')).toBe('start\nfirst line\nsecond line');
  });

  it('a symlinked memory root leaves ops queued instead of following the link, and a missing root is scaffolded', async () => {
    const outside = path.join(TEST_ROOT, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, memoryDir);
    await enqueue('linked', 'must not land outside');
    await completePendingOps(deps);
    expect((await getMemoryOp(GROUP, 'linked'))?.status).toBe('queued');
    expect(fs.readdirSync(outside)).toEqual([]);

    fs.unlinkSync(memoryDir);
    await completePendingOps(deps);
    expect((await getMemoryOp(GROUP, 'linked'))?.status).toBe('applied');
    expect(fs.existsSync(path.join(memoryDir, 'owner-statements.md'))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, 'system/definition.md'))).toBe(true);
    expect(fs.readFileSync(path.join(memoryDir, 'notes.md'), 'utf8')).toBe('must not land outside');
  });
});

describe('fourth-review corrections', () => {
  it('a temp file left by a crash mid-write is removed and the op still lands exactly once', async () => {
    fs.mkdirSync(memoryDir, { recursive: true });
    const { prepareMemoryRoot } = await import('../../memory-scaffold.js');
    await prepareMemoryRoot(groupDir);
    fs.writeFileSync(path.join(memoryDir, 'notes.md'), 'start\n');
    await enqueue('crashed', 'landed once');
    // Simulate a crash after the temp file was written but before the rename.
    const { createHash } = await import('node:crypto');
    const tag = createHash('sha256').update(`${GROUP}\ncrashed`).digest('hex').slice(0, 8);
    fs.writeFileSync(path.join(memoryDir, `notes.md.mg-${tag}.tmp`), 'partial');
    // A file that merely looks like a temp file is not ours and must survive (fifth review).
    fs.writeFileSync(path.join(memoryDir, 'other.md.mg-deadbeef.tmp'), 'not ours');
    await completePendingOps(deps);
    expect((await getMemoryOp(GROUP, 'crashed'))?.status).toBe('applied');
    expect(fs.readFileSync(path.join(memoryDir, 'notes.md'), 'utf8')).toBe('start\nlanded once');
    expect(fs.readdirSync(memoryDir).filter((n) => n.endsWith('.tmp'))).toEqual(['other.md.mg-deadbeef.tmp']);
    expect(fs.readFileSync(path.join(memoryDir, 'other.md.mg-deadbeef.tmp'), 'utf8')).toBe('not ours');
  });

  it('a same-key row from another session, another payload, or a terminal state is a conflicting reuse', async () => {
    fs.mkdirSync(memoryDir, { recursive: true });
    await enqueue('k1', 'one');
    await expect(
      enqueueMemoryOp({
        agentGroupId: GROUP,
        requestId: 'k1',
        sessionId: 'sess-other',
        kind: 'free',
        path: 'notes.md',
        mode: 'append',
        content: 'one',
      }),
    ).rejects.toThrow(/different content/);
    await expect(enqueue('k1', 'two')).rejects.toThrow(/different content/);
    const { getDb } = await import('../../db/connection.js');
    await getDb().run("UPDATE memory_write_ops SET status = 'abandoned' WHERE request_id = 'k1'");
    await expect(enqueue('k1', 'one')).rejects.toThrow(/different content/);
  });
});
