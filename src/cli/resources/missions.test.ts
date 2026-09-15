import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-missions',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-missions/groups',
    TIMEZONE: 'UTC',
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { closeDb, createAgentGroup, deleteAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession, TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { withMailboxSession } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './tasks.js';
import './handoffs.js';
import './missions.js';

const TEST_DIR = '/tmp/nanoclaw-test-cli-missions';
const ATLAS = 'ag-atlas-missions';
const ECHO = 'ag-echo-missions';
const OUTSIDER = 'ag-outsider-missions';

function agent(group: string, sessionId = `sess-${group}`): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId, messagingGroupId: 'mg-test' };
}

async function createGroup(id: string, name: string): Promise<void> {
  await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

async function createHandoff(id: string, sourceSession?: string): Promise<{ fingerprint: string }> {
  const response = await dispatch(
    {
      id: `create-${id}`,
      command: 'handoffs-create',
      args: {
        id,
        reviewer: ECHO,
        project: 'quiveriq',
        goal: 'Review mission control',
        outcome: 'Verified CLI status',
        scope: 'Mission view only',
        authority: 'execute',
      },
    },
    agent(ATLAS, sourceSession),
  );
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.error.message);
  return response.data as { fingerprint: string };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createGroup(ATLAS, 'Atlas');
  await createGroup(ECHO, 'Echo');
  await createGroup(OUTSIDER, 'Outsider');
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('missions CLI', () => {
  it('combines tasks and handoffs without inventing class, project, or ship authority', async () => {
    await dispatch(
      {
        id: 'task-create',
        command: 'tasks-create',
        args: { name: 'weekday-brief', prompt: 'Prepare briefing', process_after: '2999-01-01T00:00:00Z' },
      },
      agent(ATLAS),
    );
    await createHandoff('MISSION-READY-REVIEW');

    const response = await dispatch({ id: 'missions-list', command: 'missions-list', args: {} }, { caller: 'host' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const rows = response.data as Array<Record<string, unknown>>;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mission_id: 'MISSION-READY-REVIEW',
          owner: 'Atlas',
          class: 'unknown',
          project: 'quiveriq',
          stage: 'awaiting_delivery',
          handoff_state: 'created',
          shipping_allowed: 'no',
        }),
        expect.objectContaining({
          kind: 'task',
          owner: 'Atlas',
          class: 'unknown',
          project: 'unknown',
          stage: 'queued',
          handoff_state: 'not_recorded',
          shipping_allowed: 'unknown',
        }),
      ]),
    );
    expect(response.human).toMatch(/MISSION\s+KIND\s+OWNER\s+CLASS\s+PROJECT\s+STAGE\s+REVIEW\/HANDOFF/);
  });

  it('derives the review stages while keeping actual shipping authority unknown after approval', async () => {
    const { fingerprint } = await createHandoff('MISSION-APPROVED');
    await dispatch(
      {
        id: 'deliver-approved',
        command: 'handoffs-deliver',
        args: { id: 'MISSION-APPROVED', fingerprint },
      },
      agent(ATLAS),
    );
    await dispatch(
      {
        id: 'review-approved',
        command: 'handoffs-review',
        args: { id: 'MISSION-APPROVED', fingerprint, outcome: 'APPROVED' },
      },
      agent(ECHO),
    );

    const response = await dispatch({ id: 'missions-approved', command: 'missions-list', args: {} }, agent(ATLAS));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mission_id: 'MISSION-APPROVED',
          stage: 'review_complete',
          handoff_state: 'approved: APPROVED',
          shipping_allowed: 'unknown',
          next_action: 'owner acknowledges; confirm ship authority',
        }),
      ]),
    );
  });

  it('derives changes-requested, blocked, and completed stages from exact ledger states', async () => {
    const cases = [
      { id: 'MISSION-CHANGES', outcome: 'CHANGES REQUIRED', stage: 'changes_requested', ship: 'no' },
      { id: 'MISSION-BLOCKED', outcome: 'REVIEW BLOCKED', stage: 'blocked', ship: 'no' },
      { id: 'MISSION-CLOSED', outcome: 'APPROVED', stage: 'completed', ship: 'unknown' },
    ] as const;
    for (const item of cases) {
      const { fingerprint } = await createHandoff(item.id);
      await dispatch(
        { id: `deliver-${item.id}`, command: 'handoffs-deliver', args: { id: item.id, fingerprint } },
        agent(ATLAS),
      );
      await dispatch(
        {
          id: `review-${item.id}`,
          command: 'handoffs-review',
          args: { id: item.id, fingerprint, outcome: item.outcome },
        },
        agent(ECHO),
      );
      if (item.id === 'MISSION-CLOSED') {
        await dispatch(
          { id: 'ack-closed', command: 'handoffs-acknowledge', args: { id: item.id, fingerprint } },
          agent(ATLAS),
        );
        await dispatch(
          {
            id: 'close-closed',
            command: 'handoffs-close',
            args: { id: item.id, fingerprint, evidence: 'Focused checks passed.' },
          },
          agent(ATLAS),
        );
      }
    }

    const response = await dispatch({ id: 'missions-stages', command: 'missions-list', args: {} }, agent(ATLAS));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const rows = response.data as Array<{ mission_id: string; stage: string; shipping_allowed: string }>;
    for (const item of cases) {
      expect(rows).toContainEqual(
        expect.objectContaining({ mission_id: item.id, stage: item.stage, shipping_allowed: item.ship }),
      );
    }
  });

  it('scopes agent callers to involved handoffs and their own tasks', async () => {
    await createHandoff('MISSION-PRIVATE');
    const response = await dispatch({ id: 'missions-outsider', command: 'missions-list', args: {} }, agent(OUTSIDER));
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.data).toEqual([]);

    const reviewerView = await dispatch(
      { id: 'missions-reviewer-filter', command: 'missions-list', args: { group: 'Echo' } },
      { caller: 'host' },
    );
    expect(reviewerView.ok).toBe(true);
    if (reviewerView.ok) {
      expect(reviewerView.data).toEqual(
        expect.arrayContaining([expect.objectContaining({ mission_id: 'MISSION-PRIVATE', owner: 'Atlas' })]),
      );
    }
  });

  it('ages terminal change-requested and review-blocked handoffs out of the recent window', async () => {
    for (const outcome of ['CHANGES REQUIRED', 'REVIEW BLOCKED'] as const) {
      const id = outcome === 'CHANGES REQUIRED' ? 'MISSION-OLD-CHANGES' : 'MISSION-OLD-BLOCKED';
      const { fingerprint } = await createHandoff(id);
      await dispatch({ id: `deliver-${id}`, command: 'handoffs-deliver', args: { id, fingerprint } }, agent(ATLAS));
      await dispatch(
        { id: `review-${id}`, command: 'handoffs-review', args: { id, fingerprint, outcome } },
        agent(ECHO),
      );
      await getDb().run("UPDATE handoffs SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", id);
    }

    const response = await dispatch(
      { id: 'missions-recent', command: 'missions-list', args: { recent_days: 1 } },
      { caller: 'host' },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mission_id: 'MISSION-OLD-CHANGES' }),
        expect.objectContaining({ mission_id: 'MISSION-OLD-BLOCKED' }),
      ]),
    );
  });

  it('keeps orphaned durable handoffs in the unfiltered host view with owner ID fallback', async () => {
    await createHandoff('MISSION-ORPHANED');
    await deleteAgentGroup(ATLAS);
    await deleteAgentGroup(ECHO);

    const response = await dispatch(
      { id: 'missions-orphaned', command: 'missions-list', args: {} },
      { caller: 'host' },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mission_id: 'MISSION-ORPHANED', owner: ATLAS, owner_agent_group_id: ATLAS }),
      ]),
    );
  });

  it('uses the richer handoff row when its source session exactly matches a task mission', async () => {
    const created = await dispatch(
      {
        id: 'linked-task-create',
        command: 'tasks-create',
        args: { name: 'linked-work', prompt: 'Prepare review', process_after: '2999-01-01T00:00:00Z' },
      },
      agent(ATLAS),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = (created.data as { session_id: string }).session_id;
    await createHandoff('MISSION-LINKED', sessionId);

    const response = await dispatch({ id: 'missions-linked', command: 'missions-list', args: {} }, agent(ATLAS));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const rows = response.data as Array<{ mission_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mission_id).toBe('MISSION-LINKED');
  });

  it('does not hide unrelated series when a handoff points at a legacy shared task session', async () => {
    const sessionId = 'legacy-shared-tasks';
    await createSession({
      id: sessionId,
      agent_group_id: ATLAS,
      messaging_group_id: null,
      thread_id: TASKS_SYSTEM_THREAD_ID,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
    await withMailboxSession(ATLAS, sessionId, async (mailbox) => {
      for (const seriesId of ['legacy-series-a', 'legacy-series-b']) {
        await mailbox.insertTask({
          id: seriesId,
          seriesId,
          processAfter: '2999-01-01T00:00:00.000Z',
          recurrence: null,
          content: JSON.stringify({ prompt: seriesId, script: null, originSessionId: null }),
        });
      }
    });
    await createHandoff('MISSION-SHARED-LINK', sessionId);

    const response = await dispatch({ id: 'missions-shared', command: 'missions-list', args: {} }, agent(ATLAS));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const ids = (response.data as Array<{ mission_id: string }>).map((row) => row.mission_id);
    expect(ids).toEqual(expect.arrayContaining(['MISSION-SHARED-LINK', 'legacy-series-a', 'legacy-series-b']));
  });
});

describe('handoff revisions in the mission view', () => {
  async function reviewed(id: string, outcome: 'CHANGES REQUIRED' | 'REVIEW BLOCKED'): Promise<void> {
    const { fingerprint } = await createHandoff(id);
    await dispatch({ id: `deliver-${id}`, command: 'handoffs-deliver', args: { id, fingerprint } }, agent(ATLAS));
    const review = await dispatch(
      { id: `review-${id}`, command: 'handoffs-review', args: { id, fingerprint, outcome } },
      agent(ECHO),
    );
    expect(review.ok).toBe(true);
  }

  async function revise(prior: string, id: string): Promise<void> {
    const response = await dispatch(
      {
        id: `revise-${id}`,
        command: 'handoffs-create',
        args: {
          id,
          reviewer: ECHO,
          project: 'quiveriq',
          goal: 'Review mission control, round two',
          outcome: 'Verified CLI status',
          scope: 'Mission view only',
          authority: 'execute',
          supersedes: prior,
        },
      },
      agent(ATLAS),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
  }

  async function missions(args: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
    const response = await dispatch(
      { id: `missions-${Math.random()}`, command: 'missions-list', args },
      { caller: 'host' },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    return response.data as Array<Record<string, unknown>>;
  }

  it('a superseded handoff is labeled superseded with no next action', async () => {
    await reviewed('MISSION-REV-1', 'CHANGES REQUIRED');
    await revise('MISSION-REV-1', 'MISSION-REV-2');

    const rows = await missions();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mission_id: 'MISSION-REV-1',
          stage: 'superseded',
          next_action: 'none',
          handoff_state: 'changes_required: CHANGES REQUIRED',
        }),
      ]),
    );

    await getDb().run("UPDATE handoffs SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", 'MISSION-REV-1');
    const recent = (await missions({ recent_days: 1 })).map((row) => row.mission_id);
    expect(recent).not.toContain('MISSION-REV-1');
    expect(recent).toContain('MISSION-REV-2');
  });

  it('changes_required and review_blocked next actions name the --supersedes revision', async () => {
    await reviewed('MISSION-NEXT-CHANGES', 'CHANGES REQUIRED');
    await reviewed('MISSION-NEXT-BLOCKED', 'REVIEW BLOCKED');
    const rows = await missions();
    for (const id of ['MISSION-NEXT-CHANGES', 'MISSION-NEXT-BLOCKED']) {
      const row = rows.find((candidate) => candidate.mission_id === id)!;
      expect(row.next_action).toContain(`--supersedes ${id}`);
    }
  });

  it('a revision and its prior render as one thread', async () => {
    await dispatch(
      {
        id: 'task-create-thread',
        command: 'tasks-create',
        args: { name: 'thread-task', prompt: 'Prepare briefing', process_after: '2999-01-01T00:00:00Z' },
      },
      agent(ATLAS),
    );
    await createHandoff('MISSION-FIRST-ROUND');
    await reviewed('MISSION-THREAD-1', 'CHANGES REQUIRED');
    await revise('MISSION-THREAD-1', 'MISSION-THREAD-2');

    const rows = await missions();
    const byId = new Map(rows.map((row) => [row.mission_id, row]));
    expect(byId.get('MISSION-THREAD-2')).toMatchObject({ revises: 'MISSION-THREAD-1', stage: 'awaiting_delivery' });
    expect(byId.get('MISSION-THREAD-1')).toMatchObject({ stage: 'superseded', revises: '' });
    expect(byId.get('MISSION-FIRST-ROUND')).toMatchObject({ revises: '' });
    const task = rows.find((row) => row.kind === 'task')!;
    expect(task).toMatchObject({ revises: '' });
    expect(rows.every((row) => typeof row.revises === 'string')).toBe(true);
  });
});
