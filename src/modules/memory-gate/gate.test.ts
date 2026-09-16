/**
 * Acceptance cases G3–G6, G8, G14, G16 from docs/specs/memory-provenance-gate/plan.md §5,
 * exercised through the real delivery-action registry, guard, and approvals
 * response handler, with the approval primitive and Slack delivery faked.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-memory-gate';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-memory-gate/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-memory-gate/groups',
  };
});

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { getDeliveryAction } from '../../delivery.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import '../approvals/index.js';
import './index.js';
import { requestSha } from './guard.js';
import { getMemoryOp } from './ops.js';
import { setQuiesced } from './quiesce.js';
import { setMemoryGateDeps, type MemoryGateDeps } from './request.js';
import type { RequestApprovalOptions } from '../approvals/primitive.js';

const OWNER = 'slack:U0OWNER';
const GROUP = 'ag-atlas-gate';
const FOLDER = 'atlas-gate';
let session: Session;
let memoryDir: string;

function now(): string {
  return new Date().toISOString();
}

interface Fakes {
  approvals: RequestApprovalOptions[];
  createdIds: string[];
  notices: string[];
  ownerNotices: string[];
}

function fakes(overrides: Partial<MemoryGateDeps> = {}): Fakes {
  const state: Fakes = { approvals: [], createdIds: [], notices: [], ownerNotices: [] };
  setMemoryGateDeps({
    requestApproval: async (opts) => {
      state.approvals.push(opts);
      const id = `appr-${state.approvals.length}-${Math.random().toString(36).slice(2, 8)}`;
      state.createdIds.push(id);
      await createPendingApproval({
        approval_id: id,
        session_id: opts.session.id,
        request_id: id,
        action: opts.action,
        payload: JSON.stringify(opts.payload),
        created_at: now(),
        title: opts.title,
        options_json: JSON.stringify([]),
        approver_user_id: opts.approverUserId ?? null,
      });
    },
    notifyAgent: async (_s, text) => {
      state.notices.push(text);
    },
    notifyOwners: async (text) => {
      state.ownerNotices.push(text);
    },
    getDeliveryAdapter: () => ({}) as never,
    ...overrides,
  });
  return state;
}

const dispatch = () => getDeliveryAction('memory_write')!;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: 'mw-1-deadbeef',
    path: 'operations/decisions.md',
    mode: 'append',
    content: 'Ship on Fridays.',
    ...overrides,
  };
}

async function approve(approvalId: string): Promise<boolean> {
  return handleApprovalsResponse({
    questionId: approvalId,
    value: 'approve',
    userId: 'U0OWNER',
    channelType: 'slack',
    platformId: 'dm-owner',
    threadId: null,
  });
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
  memoryDir = path.join(TEST_ROOT, 'groups', FOLDER, 'memory');
  fs.mkdirSync(path.join(memoryDir, 'operations'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'owner-statements.md'), '---\ntype: owner-statements\n---\n');
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: GROUP, name: 'Atlas', folder: FOLDER, agent_provider: null, created_at: now() });
  await upsertUser({ id: OWNER, kind: 'slack', display_name: 'Kobe', created_at: now() });
  await grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  session = {
    id: 'sess-gate-1',
    agent_group_id: GROUP,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  await setQuiesced(false);
});

afterEach(async () => {
  setMemoryGateDeps();
  await closeDb();
  vi.restoreAllMocks();
});

describe('memory_write door', () => {
  it('memory_write is always held with the complete content on the card', async () => {
    const f = fakes();
    await dispatch()(request(), session);
    expect(f.approvals).toHaveLength(1);
    const card = f.approvals[0]!;
    expect(card.action).toBe('memory_write');
    expect(card.approverUserId).toBe(OWNER);
    expect(card.question).toContain('operations/decisions.md');
    expect(card.question).toContain('append');
    expect(card.question).toContain(requestSha(request()));
    expect(card.question).toContain('Ship on Fridays.');
    expect(fs.existsSync(path.join(memoryDir, 'operations/decisions.md'))).toBe(false);
    expect(f.notices.at(-1)).toContain("held for Kobe's approval");
  });

  it('an approved replay executes exactly once and a mismatched grant is refused', async () => {
    const f = fakes();
    await dispatch()(request(), session);
    expect(await approve(f.createdIds[0]!)).toBe(true);
    await vi.waitFor(async () => {
      expect((await getMemoryOp(GROUP, 'mw-1-deadbeef'))?.status).toBe('applied');
    });
    const target = path.join(memoryDir, 'operations/decisions.md');
    expect(fs.readFileSync(target, 'utf8')).toContain('Ship on Fridays.');
    expect(await getPendingApproval(f.createdIds[0]!)).toBeUndefined();

    // Same grant replayed again (row re-created by hand): the op already exists → no second append.
    await createPendingApproval({
      approval_id: 'appr-again',
      session_id: session.id,
      request_id: 'appr-again',
      action: 'memory_write',
      payload: f.approvals[0]!.payload && JSON.stringify(f.approvals[0]!.payload),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-again');
    expect(fs.readFileSync(target, 'utf8').split('Ship on Fridays.').length - 1).toBe(1);

    // A grant whose payload was shown for different bytes is refused by the framework.
    const tampered = { ...(f.approvals[0]!.payload as Record<string, unknown>), content: 'Ship on Mondays.' };
    await createPendingApproval({
      approval_id: 'appr-bad',
      session_id: session.id,
      request_id: 'appr-bad',
      action: 'memory_write',
      payload: JSON.stringify(tampered),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-bad');
    expect(f.notices.some((n) => /denied.*mismatched grant/i.test(n))).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('Mondays');
  });

  it('rejecting drops', async () => {
    const f = fakes();
    await dispatch()(request(), session);
    await handleApprovalsResponse({
      questionId: f.createdIds[0]!,
      value: 'reject',
      userId: 'U0OWNER',
      channelType: 'slack',
      platformId: 'dm-owner',
      threadId: null,
    });
    expect(await getPendingApproval(f.createdIds[0]!)).toBeUndefined();
    expect(await getMemoryOp(GROUP, 'mw-1-deadbeef')).toBeUndefined();
    expect(fs.existsSync(path.join(memoryDir, 'operations/decisions.md'))).toBe(false);
  });

  it('the replay commit point is the durable insert', async () => {
    // (a) every lookup faked to throw: a replay still enqueues and applies.
    const { enqueueMemoryOp, completePendingOps } = await import('./ops.js');
    let f = fakes({
      getOwners: async () => {
        throw new Error('db down');
      },
      isQuiesced: async () => {
        throw new Error('db down');
      },
    });
    await createPendingApproval({
      approval_id: 'appr-a',
      session_id: session.id,
      request_id: 'appr-a',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-a' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-a');
    await vi.waitFor(async () => expect((await getMemoryOp(GROUP, 'mw-a'))?.status).toBe('applied'));

    // (b) insert fails twice then succeeds: one approval consumed, one op.
    let failures = 2;
    f = fakes({
      enqueueMemoryOp: async (input) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('sqlite busy');
        }
        return enqueueMemoryOp(input);
      },
    });
    await createPendingApproval({
      approval_id: 'appr-b',
      session_id: session.id,
      request_id: 'appr-b',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-b' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-b');
    expect(await getMemoryOp(GROUP, 'mw-b')).toBeDefined();
    expect(f.ownerNotices).toHaveLength(0);

    // (c) insert fails four times with no op row: agent and owner told the write was lost.
    f = fakes({
      enqueueMemoryOp: async () => {
        throw new Error('sqlite busy');
      },
    });
    await createPendingApproval({
      approval_id: 'appr-c',
      session_id: session.id,
      request_id: 'appr-c',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-c' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-c');
    expect(f.notices.some((n) => n.includes('lost'))).toBe(true);
    expect(f.ownerNotices.some((n) => n.includes('lost'))).toBe(true);
    expect(await getMemoryOp(GROUP, 'mw-c')).toBeUndefined();

    // (d) insert succeeds but the completion kick throws: no "lost" notice; the sweep applies once.
    f = fakes({
      completePendingOps: async () => {
        throw new Error('kick failed');
      },
    });
    await createPendingApproval({
      approval_id: 'appr-d',
      session_id: session.id,
      request_id: 'appr-d',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-d', path: 'operations/d.md' }),
        session_id: session.id,
        sha256: requestSha(request({ path: 'operations/d.md' })),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-d');
    expect(f.notices.some((n) => n.includes('lost'))).toBe(false);
    expect((await getMemoryOp(GROUP, 'mw-d'))?.status).toBe('queued');
    await completePendingOps({ notifyAgent: async () => {}, notifyOwner: async () => {}, now: () => new Date() });
    expect((await getMemoryOp(GROUP, 'mw-d'))?.status).toBe('applied');
    expect(fs.readFileSync(path.join(memoryDir, 'operations/d.md'), 'utf8').split('Ship on Fridays.').length - 1).toBe(
      1,
    );
  });

  it('filesystem state is resolved at completion as conflict, never as a lost tap', async () => {
    const f = fakes();
    const target = path.join(memoryDir, 'operations/gone.md');
    fs.writeFileSync(target, 'to be deleted\n');
    await dispatch()(
      request({ request_id: 'mw-del', path: 'operations/gone.md', mode: 'delete', content: undefined }),
      session,
    );
    fs.unlinkSync(target);
    await approve(f.createdIds[0]!);
    await vi.waitFor(async () => expect((await getMemoryOp(GROUP, 'mw-del'))?.status).toBe('conflict'));
    expect(await getPendingApproval(f.createdIds[0]!)).toBeUndefined();

    await dispatch()(request({ request_id: 'mw-sym', path: 'operations/link.md' }), session);
    fs.symlinkSync(path.join(TEST_ROOT, 'outside.md'), path.join(memoryDir, 'operations/link.md'));
    await approve(f.createdIds[1]!);
    await new Promise((r) => setTimeout(r, 50));
    // A symlink anywhere in the tree fails the whole group closed: the op waits, nothing is written anywhere.
    expect((await getMemoryOp(GROUP, 'mw-sym'))?.status).toBe('queued');
    expect(fs.existsSync(path.join(TEST_ROOT, 'outside.md'))).toBe(false);
    expect(await getPendingApproval(f.createdIds[1]!)).toBeUndefined();
  });

  it('quiesce is an atomic barrier', async () => {
    const { completePendingOps, enqueueMemoryOp } = await import('./ops.js');
    // A previously queued op completes even while quiesced.
    await enqueueMemoryOp({
      agentGroupId: GROUP,
      requestId: 'mw-q0',
      sessionId: session.id,
      kind: 'free',
      path: 'operations/q0.md',
      mode: 'replace',
      content: 'queued before',
    });
    await setQuiesced(true);
    let f = fakes();
    await dispatch()(request({ request_id: 'mw-q1' }), session);
    expect(f.approvals).toHaveLength(0);
    expect(f.notices.at(-1)).toContain('paused for maintenance');

    // An approval resolved while quiesced is retained: row back to pending, nothing enqueued.
    await createPendingApproval({
      approval_id: 'appr-q',
      session_id: session.id,
      request_id: 'appr-q',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-q2' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-q');
    // Retained = re-issued: the old (terminalized) card's row is gone and a fresh pending row carries the same request.
    expect(await getPendingApproval('appr-q')).toBeUndefined();
    const reissued = f.approvals.at(-1)!;
    expect(reissued.payload.request_id).toBe('mw-q2');
    expect((await getPendingApproval(f.createdIds.at(-1)!))?.status).toBe('pending');
    expect(f.notices.at(-1)).toContain('re-held');
    expect(await getMemoryOp(GROUP, 'mw-q2')).toBeUndefined();
    await completePendingOps({ notifyAgent: async () => {}, notifyOwner: async () => {}, now: () => new Date() });
    expect((await getMemoryOp(GROUP, 'mw-q0'))?.status).toBe('applied');

    // Race: a replay that passed every check before the flag flips still cannot insert.
    await setQuiesced(false);
    f = fakes({
      enqueueMemoryOp: async (input) => {
        await setQuiesced(true);
        return enqueueMemoryOp(input);
      },
    });
    await createPendingApproval({
      approval_id: 'appr-race',
      session_id: session.id,
      request_id: 'appr-race',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-race' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-race');
    expect(await getPendingApproval('appr-race')).toBeUndefined();
    expect(f.approvals.at(-1)!.payload.request_id).toBe('mw-race');
    expect(await getMemoryOp(GROUP, 'mw-race')).toBeUndefined();
    expect(fs.existsSync(path.join(memoryDir, 'operations/decisions.md'))).toBe(false);
    await setQuiesced(false);
  });

  it('a database outage on a fresh request never produces a false held notice', async () => {
    const f = fakes({
      isQuiesced: async () => {
        throw new Error('db down');
      },
    });
    for (let i = 0; i < 4; i += 1) {
      await expect(dispatch()(request({ request_id: `mw-out-${i}` }), session)).rejects.toThrow('db down');
    }
    expect(f.approvals).toHaveLength(0);
    expect(f.notices.some((n) => n.includes('held'))).toBe(false);
  });

  it('shape validation refuses escapes, non-markdown, oversize content, bad modes, and the owner-statements file, without touching the filesystem', async () => {
    const f = fakes();
    const before = fs.readdirSync(memoryDir, { recursive: true }).sort();
    const bad: Record<string, unknown>[] = [
      request({ path: '../x.md' }),
      request({ path: '/etc/x.md' }),
      request({ path: 'a/../../x.md' }),
      request({ path: 'notes.txt' }),
      request({ content: 'x'.repeat(2001) }),
      request({ mode: 'exec' }),
      request({ path: 'owner-statements.md' }),
      request({ mode: 'append', content: undefined }),
      request({ mode: 'delete' }),
    ];
    for (const content of bad) await dispatch()(content, session);
    expect(f.approvals).toHaveLength(0);
    expect(f.notices).toHaveLength(bad.length);
    expect(f.notices.every((n) => n.startsWith('memory request denied'))).toBe(true);
    expect(fs.readdirSync(memoryDir, { recursive: true }).sort()).toEqual(before);
  });
});

describe('memory_write door: hold confirmation and correction cases', () => {
  it('hold confirmation fails safe', async () => {
    // requestApproval that creates no row (no approver or no DM path): no "held" notice, an error is logged.
    const { log } = await import('../../log.js');
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const noRow = fakes({ requestApproval: async () => undefined });
    await dispatch()(request({ request_id: 'mw-norow' }), session);
    expect(noRow.notices.some((n) => n.includes('could not be held'))).toBe(true);
    expect(noRow.notices.some((n) => n.includes("held for Kobe's approval"))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();

    // No delivery adapter: early notice, requestApproval never called.
    const noAdapter = fakes({ getDeliveryAdapter: () => null });
    await dispatch()(request({ request_id: 'mw-noadapter' }), session);
    expect(noAdapter.approvals).toHaveLength(0);
    expect(noAdapter.notices.at(-1)).toContain('no delivery channel');
  });

  it('an unreadable ledger after replay failures keeps the approval for the operator', async () => {
    fakes({
      enqueueMemoryOp: async () => {
        throw new Error('sqlite busy');
      },
      getMemoryOp: async () => {
        throw new Error('sqlite busy');
      },
    });
    await createPendingApproval({
      approval_id: 'appr-keep',
      session_id: session.id,
      request_id: 'appr-keep',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-keep' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-keep');
    const row = await getPendingApproval('appr-keep');
    expect(row).toBeDefined();
    expect(row!.status).toBe('approved');
  });

  it('a same-key ledger row with another payload or a terminal status is not a commit', async () => {
    const { enqueueMemoryOp } = await import('./ops.js');
    // A different payload already holds the request id (agent reused it): the approved write cannot be recorded.
    await enqueueMemoryOp({
      agentGroupId: GROUP,
      requestId: 'mw-reuse',
      sessionId: session.id,
      kind: 'free',
      path: 'operations/other.md',
      mode: 'replace',
      content: 'other',
    });
    const f = fakes({
      enqueueMemoryOp: async () => {
        throw new Error('sqlite busy');
      },
    });
    await createPendingApproval({
      approval_id: 'appr-reuse',
      session_id: session.id,
      request_id: 'appr-reuse',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-reuse' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-reuse');
    expect(f.notices.some((n) => n.includes('lost'))).toBe(true);
    expect(f.ownerNotices.some((n) => n.includes('lost'))).toBe(true);
  });

  it('a quiesced replay whose re-hold cannot be issued keeps the approval for the operator', async () => {
    await setQuiesced(true);
    fakes({ getDeliveryAdapter: () => null });
    await createPendingApproval({
      approval_id: 'appr-noadapter',
      session_id: session.id,
      request_id: 'appr-noadapter',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-noadapter' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-noadapter');
    expect((await getPendingApproval('appr-noadapter'))?.status).toBe('approved');
    expect(await getMemoryOp(GROUP, 'mw-noadapter')).toBeUndefined();

    // requestApproval that creates no row (missing DM): the clicked row must not count as its own confirmation.
    fakes({ requestApproval: async () => undefined });
    await createPendingApproval({
      approval_id: 'appr-nodm',
      session_id: session.id,
      request_id: 'appr-nodm',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-nodm' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-nodm');
    expect((await getPendingApproval('appr-nodm'))?.status).toBe('approved');

    // requestApproval that throws: kept as well.
    fakes({
      requestApproval: async () => {
        throw new Error('slack down');
      },
    });
    await createPendingApproval({
      approval_id: 'appr-throw',
      session_id: session.id,
      request_id: 'appr-throw',
      action: 'memory_write',
      payload: JSON.stringify({
        ...request({ request_id: 'mw-throw' }),
        session_id: session.id,
        sha256: requestSha(request()),
      }),
      created_at: now(),
      title: 't',
      options_json: JSON.stringify([]),
      approver_user_id: OWNER,
    });
    await approve('appr-throw');
    expect((await getPendingApproval('appr-throw'))?.status).toBe('approved');
    await setQuiesced(false);
  });
});
