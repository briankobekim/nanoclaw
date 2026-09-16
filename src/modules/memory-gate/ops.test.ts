import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Point GROUPS_DIR at a fresh temp root before ops.ts resolves it.
const GROUPS_ROOT = await vi.hoisted(async () => {
  const fsMod = await import('fs');
  const os = await import('os');
  const pathMod = await import('path');
  return fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'memory-gate-ops-'));
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, GROUPS_DIR: GROUPS_ROOT };
});

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import {
  MAX_ATTEMPTS,
  OWNER_STATEMENTS_PATH,
  completePendingOps,
  enqueueMemoryOp,
  formatOwnerBlock,
  getMemoryOp,
  listOps,
  type CompletionDeps,
  type MemoryOpInput,
} from './ops.js';
import './migration.js';

// docs/specs/memory-provenance-gate/plan.md §5 cases G10, G11, G12 and the
// completion half of §4.3 "Enqueue and complete".

const GROUP = 'ag-ops';
const FOLDER = 'ops-group';
const SESSION = 'sess-ops';
const HEADER = '---\ntype: owner-statements\n---\n';
const NOW = new Date('2026-09-16T12:00:00.000Z');
const memoryRoot = path.join(GROUPS_ROOT, FOLDER, 'memory');

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function fileState(rel: string): string {
  const target = path.join(memoryRoot, rel);
  return fs.existsSync(target) ? sha(fs.readFileSync(target)) : 'absent';
}

function read(rel: string): string {
  return fs.readFileSync(path.join(memoryRoot, rel), 'utf8');
}

function hashesOf(dir: string, skip: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    const rel = path.relative(dir, full);
    if (rel === skip) continue;
    out.set(rel, sha(fs.readFileSync(full)));
  }
  return out;
}

function tmpFiles(): string[] {
  return fs
    .readdirSync(memoryRoot, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.tmp'));
}

function owner(requestId: string, text: string, messageId: string): MemoryOpInput {
  return {
    agentGroupId: GROUP,
    requestId,
    sessionId: SESSION,
    kind: 'owner',
    path: OWNER_STATEMENTS_PATH,
    mode: 'append',
    content: text,
    ownerMessageId: messageId,
  };
}

function free(requestId: string, rel: string, mode: MemoryOpInput['mode'], content: string | null): MemoryOpInput {
  return { agentGroupId: GROUP, requestId, sessionId: SESSION, kind: 'free', path: rel, mode, content };
}

interface DirectRow {
  request_id: string;
  kind?: 'owner' | 'free';
  path: string;
  mode: 'replace' | 'append' | 'delete';
  content: string | null;
  owner_message_id?: string | null;
  before_sha256: string | null;
  after_sha256: string | null;
  status: 'queued' | 'prepared';
  attempts?: number;
  created_at?: string;
}

async function insertRow(row: DirectRow): Promise<void> {
  const created = row.created_at ?? '2026-09-15T08:00:00.000Z';
  await getDb().run(
    `INSERT INTO memory_write_ops (seq, agent_group_id, request_id, session_id, kind, path, mode, content, content_sha256,
       owner_message_id, before_sha256, after_sha256, status, attempts, created_at, updated_at)
     VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM memory_write_ops), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    GROUP,
    row.request_id,
    SESSION,
    row.kind ?? 'free',
    row.path,
    row.mode,
    row.content,
    sha(row.content ?? ''),
    row.owner_message_id ?? null,
    row.before_sha256,
    row.after_sha256,
    row.status,
    row.attempts ?? 0,
    created,
    created,
  );
}

let deps: CompletionDeps & { notifyAgent: ReturnType<typeof vi.fn>; notifyOwner: ReturnType<typeof vi.fn> };

function agentNotices(): string[] {
  return deps.notifyAgent.mock.calls.map((call) => String(call[1]));
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  const created_at = NOW.toISOString();
  await createAgentGroup({ id: GROUP, name: 'Ops', folder: FOLDER, agent_provider: null, created_at });
  await createSession({
    id: SESSION,
    agent_group_id: GROUP,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at,
  });
  fs.rmSync(path.join(GROUPS_ROOT, FOLDER), { recursive: true, force: true });
  fs.mkdirSync(path.join(memoryRoot, 'system'), { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, OWNER_STATEMENTS_PATH), HEADER);
  fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# index\n');
  fs.writeFileSync(path.join(memoryRoot, 'notes.md'), 'hello\n');
  fs.writeFileSync(path.join(memoryRoot, 'system', 'definition.md'), '# def\n');
  deps = {
    notifyAgent: vi.fn().mockResolvedValue(undefined),
    notifyOwner: vi.fn().mockResolvedValue(undefined),
    now: () => NOW,
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

describe('formatOwnerBlock', () => {
  it('renders the provenance block with every line indented two spaces', () => {
    expect(
      formatOwnerBlock({ date: '2026-09-16', messageId: '1758000000.000100', text: 'remember: line one\nline two' }),
    ).toBe('\n- 2026-09-16 Kobe wrote (msg 1758000000.000100):\n  remember: line one\n  line two\n');
  });
});

describe('memory-gate ops completion', () => {
  it('ops for one group are serialized and each touches exactly one file', async () => {
    expect(await enqueueMemoryOp(owner('owner:m1', 'remember: first', 'm1'))).toBe('inserted');
    expect(await enqueueMemoryOp(owner('owner:m2', 'remember: second\nline two', 'm2'))).toBe('inserted');
    const others = hashesOf(memoryRoot, OWNER_STATEMENTS_PATH);
    const rows = await listOps();
    expect(rows.map((row) => row.request_id)).toEqual(['owner:m1', 'owner:m2']);
    const date = (row: { created_at: string }) => row.created_at.slice(0, 10);

    await Promise.all([completePendingOps(deps), completePendingOps(deps)]);

    expect(read(OWNER_STATEMENTS_PATH)).toBe(
      HEADER +
        formatOwnerBlock({ date: date(rows[0]!), messageId: 'm1', text: 'remember: first' }) +
        formatOwnerBlock({ date: date(rows[1]!), messageId: 'm2', text: 'remember: second\nline two' }),
    );
    expect(tmpFiles()).toEqual([]);
    // Completion scaffolds missing templates before writing; every file that existed before is untouched.
    const after = hashesOf(memoryRoot, OWNER_STATEMENTS_PATH);
    expect(new Map([...after].filter(([name]) => others.has(name)))).toEqual(others);

    const done = await listOps();
    expect(done.map((row) => row.status)).toEqual(['applied', 'applied']);
    expect(done.map((row) => row.attempts)).toEqual([1, 1]);
    expect(done[0]!.before_sha256).toBe(sha(HEADER));
    expect(done[0]!.after_sha256).toBe(done[1]!.before_sha256);
    expect(done[1]!.after_sha256).toBe(fileState(OWNER_STATEMENTS_PATH));
    expect(done.every((row) => row.applied_at !== null)).toBe(true);
    // Each op was applied exactly once even though two completions ran concurrently.
    expect(agentNotices().filter((text) => text === `memory written: ${OWNER_STATEMENTS_PATH}`)).toHaveLength(2);
    expect(deps.notifyOwner).not.toHaveBeenCalled();

    // A third run is a no-op.
    await completePendingOps(deps);
    expect(agentNotices()).toHaveLength(2);
  });

  it('hashes are committed before mutation and recovery is exact', async () => {
    const base = 'hello\n';
    const planned = `${base}appended`;

    // (a) prepared, file already equals after_sha256: applied, no second append.
    fs.writeFileSync(path.join(memoryRoot, 'a.md'), planned);
    await insertRow({
      request_id: 'a',
      path: 'a.md',
      mode: 'append',
      content: 'appended',
      before_sha256: sha(base),
      after_sha256: sha(planned),
      status: 'prepared',
      attempts: 1,
    });
    // (b) prepared, file equals before_sha256: mutated once.
    fs.writeFileSync(path.join(memoryRoot, 'b.md'), base);
    await insertRow({
      request_id: 'b',
      path: 'b.md',
      mode: 'append',
      content: 'appended',
      before_sha256: sha(base),
      after_sha256: sha(planned),
      status: 'prepared',
      attempts: 1,
    });
    // (c) prepared, file matches neither hash: conflict, untouched.
    fs.writeFileSync(path.join(memoryRoot, 'c.md'), 'someone else wrote this');
    await insertRow({
      request_id: 'c',
      path: 'c.md',
      mode: 'append',
      content: 'appended',
      before_sha256: sha(base),
      after_sha256: sha(planned),
      status: 'prepared',
      attempts: 1,
    });
    // (d) prepared delete whose unlink already happened: the absent sentinel matches after_sha256.
    await insertRow({
      request_id: 'd',
      path: 'd.md',
      mode: 'delete',
      content: null,
      before_sha256: sha('gone'),
      after_sha256: 'absent',
      status: 'prepared',
      attempts: 1,
    });

    await completePendingOps(deps);

    const byId = new Map((await listOps()).map((row) => [row.request_id, row]));
    expect(byId.get('a')).toMatchObject({
      status: 'applied',
      attempts: 1,
      before_sha256: sha(base),
      after_sha256: sha(planned),
    });
    expect(read('a.md')).toBe(planned);
    expect(byId.get('b')).toMatchObject({
      status: 'applied',
      attempts: 2,
      before_sha256: sha(base),
      after_sha256: sha(planned),
    });
    expect(read('b.md')).toBe(planned);
    expect(byId.get('c')).toMatchObject({ status: 'conflict', attempts: 1 });
    expect(byId.get('c')!.last_error).toMatch(/before_sha256|changed/i);
    expect(read('c.md')).toBe('someone else wrote this');
    expect(byId.get('d')).toMatchObject({ status: 'applied', attempts: 1, after_sha256: 'absent' });
    expect(fs.existsSync(path.join(memoryRoot, 'd.md'))).toBe(false);
    expect(byId.get('a')!.applied_at).not.toBeNull();
    expect(byId.get('d')!.applied_at).not.toBeNull();

    const notices = agentNotices();
    expect(notices.filter((text) => text === 'memory written: a.md')).toHaveLength(1);
    expect(notices.filter((text) => text === 'memory written: b.md')).toHaveLength(1);
    expect(notices.filter((text) => text === 'memory written: d.md')).toHaveLength(1);
    expect(notices.some((text) => text.includes('c.md') && /conflict/i.test(text))).toBe(true);
    expect(tmpFiles()).toEqual([]);

    // A queued op commits both hashes as `prepared` before the filesystem is touched:
    // when the write itself fails, the row already carries them.
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EIO: injected');
    });
    await enqueueMemoryOp(free('e', 'e.md', 'replace', 'fresh'));
    await completePendingOps(deps);
    renameSpy.mockRestore();
    expect(await getMemoryOp(GROUP, 'e')).toMatchObject({
      status: 'prepared',
      attempts: 1,
      before_sha256: 'absent',
      after_sha256: sha('fresh'),
    });
    expect(fs.existsSync(path.join(memoryRoot, 'e.md'))).toBe(false);
  });

  it('a write whose first attempt fails is completed by the sweep', async () => {
    await enqueueMemoryOp(free('r1', 'notes.md', 'replace', 'new notes'));
    const renameSpy = vi.spyOn(fs, 'renameSync');
    renameSpy.mockImplementationOnce(() => {
      throw new Error('EACCES: injected rename failure');
    });

    await completePendingOps(deps);
    expect(await getMemoryOp(GROUP, 'r1')).toMatchObject({ status: 'prepared', attempts: 1 });
    expect((await getMemoryOp(GROUP, 'r1'))!.last_error).toContain('injected rename failure');
    expect(read('notes.md')).toBe('hello\n');
    expect(tmpFiles()).toEqual([]);
    expect(agentNotices()).toEqual(['memory write attempt failed; will retry']);

    // Next sweep tick: written exactly once, attempts counts both tries.
    await completePendingOps(deps);
    expect(await getMemoryOp(GROUP, 'r1')).toMatchObject({
      status: 'applied',
      attempts: 2,
      after_sha256: sha('new notes'),
    });
    expect(read('notes.md')).toBe('new notes');
    expect(renameSpy).toHaveBeenCalledTimes(2);
    expect(agentNotices().filter((text) => text === 'memory written: notes.md')).toHaveLength(1);
    expect(deps.notifyOwner).not.toHaveBeenCalled();

    // Ten consecutive failures: abandoned, agent and owner told, nothing written.
    deps.notifyAgent.mockClear();
    renameSpy.mockImplementation(() => {
      throw new Error('EROFS: injected persistent failure');
    });
    await enqueueMemoryOp(free('r2', 'index.md', 'replace', 'never lands'));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await completePendingOps(deps);
      const row = (await getMemoryOp(GROUP, 'r2'))!;
      expect(row.attempts).toBe(i + 1);
      expect(row.status).toBe(i + 1 < MAX_ATTEMPTS ? 'prepared' : 'abandoned');
    }
    expect(read('index.md')).toBe('# index\n');
    expect(tmpFiles()).toEqual([]);
    expect(agentNotices().filter((text) => text === 'memory write attempt failed; will retry')).toHaveLength(
      MAX_ATTEMPTS - 1,
    );
    expect(agentNotices().at(-1)).toBe(`memory write abandoned after ${MAX_ATTEMPTS} attempts: ${GROUP}/index.md`);
    expect(deps.notifyOwner).toHaveBeenCalledTimes(1);
    expect(deps.notifyOwner).toHaveBeenCalledWith(
      `memory write abandoned after ${MAX_ATTEMPTS} attempts: ${GROUP}/index.md`,
    );

    // An abandoned op is never retried.
    const calls = renameSpy.mock.calls.length;
    await completePendingOps(deps);
    expect(renameSpy.mock.calls.length).toBe(calls);
    expect(await getMemoryOp(GROUP, 'r2')).toMatchObject({ status: 'abandoned', attempts: MAX_ATTEMPTS });
  });

  it('a symlink anywhere in the tree keeps every op of the group queued and writes nothing', async () => {
    fs.symlinkSync(path.join(GROUPS_ROOT, 'outside.md'), path.join(memoryRoot, 'link.md'));
    fs.writeFileSync(path.join(GROUPS_ROOT, 'outside.md'), 'outside');
    fs.symlinkSync(path.join(GROUPS_ROOT), path.join(memoryRoot, 'dirlink'));
    await enqueueMemoryOp(free('p2', 'link.md', 'replace', 'x'));
    await enqueueMemoryOp(free('p3', 'dirlink/inner.md', 'replace', 'x'));
    await enqueueMemoryOp(free('p8', 'plain.md', 'replace', 'x'));

    await completePendingOps(deps);

    const byId = new Map((await listOps()).map((row) => [row.request_id, row]));
    for (const id of ['p2', 'p3', 'p8']) expect(byId.get(id)!.status, id).toBe('queued');
    expect(fs.readFileSync(path.join(GROUPS_ROOT, 'outside.md'), 'utf8')).toBe('outside');
    expect(fs.existsSync(path.join(GROUPS_ROOT, 'inner.md'))).toBe(false);
    expect(fs.existsSync(path.join(memoryRoot, 'plain.md'))).toBe(false);
    expect(agentNotices()).toHaveLength(0);

    // Once the links are gone the same ops complete: p2/p3 then resolve as conflicts (parent missing / target absent for replace is fine → p2 becomes a plain file).
    fs.unlinkSync(path.join(memoryRoot, 'link.md'));
    fs.unlinkSync(path.join(memoryRoot, 'dirlink'));
    await completePendingOps(deps);
    expect((await listOps()).find((row) => row.request_id === 'p8')?.status).toBe('applied');
  });

  it('resolves escapes, missing parents, missing delete targets, a directory target, and a missing group as conflict', async () => {
    await enqueueMemoryOp(free('p1', '../escape.md', 'replace', 'x'));
    await enqueueMemoryOp(free('p4', 'missing-dir/inner.md', 'replace', 'x'));
    await enqueueMemoryOp(free('p5', 'nope.md', 'delete', null));
    await enqueueMemoryOp(free('p6', 'system', 'replace', 'x'));
    await enqueueMemoryOp(free('p7', 'system/definition.md', 'replace', 'redefined'));
    await getDb().run(
      `INSERT INTO memory_write_ops (seq, agent_group_id, request_id, session_id, kind, path, mode, content, content_sha256,
         status, created_at, updated_at)
       VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM memory_write_ops), 'ag-missing', 'g1', 'sess-none', 'free', 'x.md', 'replace', 'x', 'h', 'queued', 't', 't')`,
    );

    await completePendingOps(deps);

    const byId = new Map((await listOps()).map((row) => [row.request_id, row]));
    for (const id of ['p1', 'p4', 'p5', 'p6', 'g1']) {
      expect(byId.get(id)!.status, id).toBe('conflict');
      expect(byId.get(id)!.last_error, id).toBeTruthy();
    }
    expect(byId.get('p7')).toMatchObject({ status: 'applied' });
    expect(read('system/definition.md')).toBe('redefined');
    expect(fs.existsSync(path.join(GROUPS_ROOT, 'escape.md'))).toBe(false);
    expect(fs.existsSync(path.join(memoryRoot, 'missing-dir'))).toBe(false);
    expect(tmpFiles()).toEqual([]);
    // Four conflicts for the live session, none for the missing group (no session to notify).
    expect(agentNotices().filter((text) => /conflict/i.test(text))).toHaveLength(4);
    expect(deps.notifyOwner).not.toHaveBeenCalled();
  });

  it('removes only the exact temp path of a pending op and never a look-alike file', async () => {
    // An operator's file that merely LOOKS like a memory-gate temp file.
    const lookAlike = path.join(memoryRoot, 'notes.md.mg-deadbeef.tmp');
    fs.writeFileSync(lookAlike, 'not ours');
    // The stale temp of the op itself, as a crash between temp write and rename leaves it.
    await enqueueMemoryOp(free('t1', 'notes.md', 'replace', 'from the op'));
    const tag = sha(`${GROUP}\nt1`).slice(0, 8);
    const ownTemp = path.join(memoryRoot, `notes.md.mg-${tag}.tmp`);
    fs.writeFileSync(ownTemp, 'half-written');

    await completePendingOps(deps);

    expect(await getMemoryOp(GROUP, 't1')).toMatchObject({ status: 'applied' });
    expect(read('notes.md')).toBe('from the op');
    expect(fs.existsSync(ownTemp)).toBe(false);
    expect(fs.readFileSync(lookAlike, 'utf8')).toBe('not ours');
  });

  it('an edit that lands between prepare and the rename or unlink becomes a conflict, never a write', async () => {
    // deps.now() is evaluated while the prepare UPDATE is being issued: the
    // last moment before the mutation where an outside edit can slip in.
    const nowSpy = vi.fn(() => NOW);
    deps.now = nowSpy;
    await enqueueMemoryOp(free('w1', 'notes.md', 'append', 'appended'));
    nowSpy.mockImplementationOnce(() => {
      fs.writeFileSync(path.join(memoryRoot, 'notes.md'), 'edited by hand\n');
      return NOW;
    });
    await completePendingOps(deps);
    const w1 = (await getMemoryOp(GROUP, 'w1'))!;
    expect(w1.status).toBe('conflict');
    expect(w1.before_sha256).toBe(sha('hello\n'));
    expect(w1.last_error).toMatch(/changed since prepare/);
    expect(read('notes.md')).toBe('edited by hand\n');
    expect(tmpFiles()).toEqual([]);

    await enqueueMemoryOp(free('d1', 'index.md', 'delete', null));
    nowSpy.mockImplementationOnce(() => {
      fs.writeFileSync(path.join(memoryRoot, 'index.md'), '# index, revised\n');
      return NOW;
    });
    await completePendingOps(deps);
    expect((await getMemoryOp(GROUP, 'd1'))!.status).toBe('conflict');
    expect(read('index.md')).toBe('# index, revised\n');

    // A component swapped for a symlink in the same window is a conflict too.
    fs.mkdirSync(path.join(memoryRoot, 'sub'));
    fs.writeFileSync(path.join(memoryRoot, 'sub', 'a.md'), 'a\n');
    await enqueueMemoryOp(free('s1', 'sub/a.md', 'replace', 'replaced'));
    nowSpy.mockImplementationOnce(() => {
      fs.rmSync(path.join(memoryRoot, 'sub'), { recursive: true });
      fs.mkdirSync(path.join(GROUPS_ROOT, 'elsewhere'));
      fs.writeFileSync(path.join(GROUPS_ROOT, 'elsewhere', 'a.md'), 'a\n');
      fs.symlinkSync(path.join(GROUPS_ROOT, 'elsewhere'), path.join(memoryRoot, 'sub'));
      return NOW;
    });
    await completePendingOps(deps);
    expect((await getMemoryOp(GROUP, 's1'))!.status).toBe('conflict');
    expect(fs.readFileSync(path.join(GROUPS_ROOT, 'elsewhere', 'a.md'), 'utf8')).toBe('a\n');
    expect(agentNotices().filter((text) => /conflict/i.test(text))).toHaveLength(3);
  });

  it('a rename or unlink is marked applied only after the directory is durable', async () => {
    // The temp file's own fsync succeeds; the directory fsync (a directory fd) fails once.
    const realFsync = fs.fsyncSync;
    let failDirOnce = true;
    let dirFsyncs = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) {
        dirFsyncs += 1;
        if (failDirOnce) {
          failDirOnce = false;
          throw new Error('EIO: injected directory fsync failure');
        }
      }
      return realFsync(fd);
    });
    const renameSpy = vi.spyOn(fs, 'renameSync');

    await enqueueMemoryOp(free('f1', 'notes.md', 'replace', 'durable'));
    await completePendingOps(deps);
    // The rename happened, but the op is NOT applied until the directory is durable.
    expect(read('notes.md')).toBe('durable');
    expect(await getMemoryOp(GROUP, 'f1')).toMatchObject({ status: 'prepared', attempts: 1 });
    expect((await getMemoryOp(GROUP, 'f1'))!.last_error).toContain('injected directory fsync');
    expect(tmpFiles()).toEqual([]);

    // Next tick: the file already holds after_sha256, so it is applied without a second write.
    await completePendingOps(deps);
    expect(await getMemoryOp(GROUP, 'f1')).toMatchObject({ status: 'applied', attempts: 1 });
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(agentNotices().filter((text) => text === 'memory written: notes.md')).toHaveLength(1);

    // Same for a delete: unlinked, then applied only once the directory fsync succeeds.
    failDirOnce = true;
    await enqueueMemoryOp(free('f2', 'notes.md', 'delete', null));
    await completePendingOps(deps);
    expect(fs.existsSync(path.join(memoryRoot, 'notes.md'))).toBe(false);
    expect(await getMemoryOp(GROUP, 'f2')).toMatchObject({ status: 'prepared', attempts: 1 });
    await completePendingOps(deps);
    expect(await getMemoryOp(GROUP, 'f2')).toMatchObject({ status: 'applied', after_sha256: 'absent' });
    // A tick that finds the file already at after_sha256 does not mutate, so no fsync ran there.
    expect(dirFsyncs).toBe(2);
    // A clean write fsyncs the directory once, after the rename and before applied.
    await enqueueMemoryOp(free('f3', 'notes.md', 'replace', 'again'));
    await completePendingOps(deps);
    expect(await getMemoryOp(GROUP, 'f3')).toMatchObject({ status: 'applied', attempts: 1 });
    expect(dirFsyncs).toBe(3);
  });

  it('an approved path must be spelled on disk exactly as approved, so a case-folding filesystem cannot redirect it', async () => {
    const folds = fs.existsSync(path.join(memoryRoot, 'NOTES.MD'));
    await enqueueMemoryOp(free('c1', 'NOTES.md', 'replace', 'through an alias'));
    await enqueueMemoryOp(free('c2', 'SYSTEM/definition.md', 'replace', 'through a directory alias'));
    await completePendingOps(deps);
    const c1 = (await getMemoryOp(GROUP, 'c1'))!;
    const c2 = (await getMemoryOp(GROUP, 'c2'))!;
    if (folds) {
      // macOS default (APFS case-insensitive): the alias resolves to notes.md; refused as a conflict, nothing written.
      expect(c1.status).toBe('conflict');
      expect(c1.last_error).toMatch(/spelling differs from the file on disk: NOTES.md/);
      expect(c2.status).toBe('conflict');
      expect(c2.last_error).toMatch(/spelling differs from the directory on disk: SYSTEM/);
      expect(read('notes.md')).toBe('hello\n');
      expect(read('system/definition.md')).toBe('# def\n');
    } else {
      // Case-sensitive filesystem: NOTES.md is simply a new file; SYSTEM/ does not exist.
      expect(c1.status).toBe('applied');
      expect(c2.status).toBe('conflict');
    }
    expect(tmpFiles()).toEqual([]);
  });

  it('a directory-fsync failure after the mutation never abandons the op, even on the last attempt', async () => {
    const realRename = fs.renameSync;
    const realFsync = fs.fsyncSync;
    let renameFailures = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (renameFailures < MAX_ATTEMPTS - 1) {
        renameFailures += 1;
        throw new Error('EIO: injected rename failure');
      }
      return realRename(from, to);
    });
    let failDirFsync = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      if (failDirFsync && fs.fstatSync(fd).isDirectory()) throw new Error('EIO: injected directory fsync failure');
      return realFsync(fd);
    });

    await enqueueMemoryOp(free('x1', 'notes.md', 'replace', 'landed on the last try'));
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await completePendingOps(deps);
    expect(await getMemoryOp(GROUP, 'x1')).toMatchObject({ status: 'prepared', attempts: MAX_ATTEMPTS - 1 });
    expect(read('notes.md')).toBe('hello\n');

    // Tenth attempt: the rename succeeds, the directory fsync fails.
    failDirFsync = true;
    await completePendingOps(deps);
    failDirFsync = false;
    const afterTenth = (await getMemoryOp(GROUP, 'x1'))!;
    expect(read('notes.md')).toBe('landed on the last try');
    expect(afterTenth.status).toBe('prepared');
    expect(afterTenth.attempts).toBe(MAX_ATTEMPTS);
    expect(afterTenth.last_error).toMatch(/mutation done but directory fsync failed/);
    expect(deps.notifyOwner).not.toHaveBeenCalled();
    expect(agentNotices().some((text) => /abandoned/.test(text))).toBe(false);

    // Next tick: the file is at after_sha256, so the op is applied; nothing is rewritten.
    await completePendingOps(deps);
    expect(await getMemoryOp(GROUP, 'x1')).toMatchObject({ status: 'applied', attempts: MAX_ATTEMPTS });
    expect(read('notes.md')).toBe('landed on the last try');
    expect(agentNotices().filter((text) => text === 'memory written: notes.md')).toHaveLength(1);
  });

  it('completion order is the durable insertion sequence, never the wall clock', async () => {
    // An older PREPARED op whose created_at is LATER than a newer queued op on the
    // same file (a restart after a backward clock correction). The prepared op
    // was inserted first and must run first; otherwise the newer op would change
    // the file and force the approved older op into a conflict.
    await insertRow({
      request_id: 'older-prepared',
      path: 'notes.md',
      mode: 'append',
      content: 'first',
      before_sha256: sha('hello\n'),
      after_sha256: sha('hello\nfirst'),
      status: 'prepared',
      attempts: 1,
      created_at: '2026-09-16T12:00:00.000Z',
    });
    await insertRow({
      request_id: 'newer-queued',
      path: 'notes.md',
      mode: 'append',
      content: 'second',
      before_sha256: null,
      after_sha256: null,
      status: 'queued',
      created_at: '2026-09-15T00:00:00.000Z',
    });
    const rows = await listOps();
    expect(rows.map((row) => row.request_id)).toEqual(['older-prepared', 'newer-queued']);
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);

    await completePendingOps(deps);

    expect(await getMemoryOp(GROUP, 'older-prepared')).toMatchObject({ status: 'applied', attempts: 2 });
    expect(await getMemoryOp(GROUP, 'newer-queued')).toMatchObject({ status: 'applied', attempts: 1 });
    expect(read('notes.md')).toBe('hello\nfirst\nsecond');
    // Enqueue through the real path keeps assigning increasing sequence numbers.
    await enqueueMemoryOp(free('after-restart', 'notes.md', 'append', 'third'));
    const last = (await getMemoryOp(GROUP, 'after-restart'))!;
    expect(last.seq).toBeGreaterThan(rows[1]!.seq);
  });

  it('appends after a missing trailing newline, replaces, and deletes, one file per op', async () => {
    fs.writeFileSync(path.join(memoryRoot, 'notes.md'), 'no newline');
    await enqueueMemoryOp(free('a1', 'notes.md', 'append', 'tail'));
    await enqueueMemoryOp(free('a2', 'fresh.md', 'append', 'first'));
    await enqueueMemoryOp(free('a3', 'index.md', 'delete', null));
    await enqueueMemoryOp(owner('owner:z', 'remember: z', 'z'));
    deps.notifyAgent.mockRejectedValue(new Error('agent notify exploded'));

    await completePendingOps(deps);

    expect(read('notes.md')).toBe('no newline\ntail');
    expect(read('fresh.md')).toBe('first');
    expect(fs.existsSync(path.join(memoryRoot, 'index.md'))).toBe(false);
    const ownerRow = (await getMemoryOp(GROUP, 'owner:z'))!;
    expect(read(OWNER_STATEMENTS_PATH)).toBe(
      HEADER + formatOwnerBlock({ date: ownerRow.created_at.slice(0, 10), messageId: 'z', text: 'remember: z' }),
    );
    expect((await listOps()).map((row) => row.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(await listOps('applied')).toHaveLength(4);
    expect(await listOps('queued')).toHaveLength(0);
  });
});
