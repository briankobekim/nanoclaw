import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { log } from '../../log.js';
import {
  acknowledgeHandoff,
  closeHandoff,
  createHandoff,
  listHandoffEvents,
  markHandoffDelivered,
  OWNER_PINGED_EVENT,
  recordOwnerPing,
  reviewHandoff,
  type HandoffRow,
  type HandoffStatus,
} from './ledger.js';
import { STALL_MS_BLOCKED, STALL_MS_OPEN, sweepStalledHandoffs, type StallPingDeps } from './stall-ping.js';
import './migration.js';

const ATLAS = 'ag-atlas';
const ECHO = 'ag-echo';
const OWNER = 'slack:U0OWNER';
const OWNER_DM = 'slack:D0OWNER';
const HOUR = 60 * 60 * 1000;
/** Fixed "now" so ages are exact regardless of wall-clock time. */
const NOW = Date.parse('2026-09-15T12:00:00.000Z');

async function seedAgents(): Promise<void> {
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: ATLAS, name: 'Atlas', folder: 'atlas', agent_provider: null, created_at });
  await createAgentGroup({ id: ECHO, name: 'Echo', folder: 'echo', agent_provider: null, created_at });
}

async function newHandoff(id: string, supersedes?: string): Promise<HandoffRow> {
  return createHandoff({
    id,
    sourceAgentGroupId: ATLAS,
    reviewerAgentGroupId: ECHO,
    project: 'nanoclaw',
    goal: 'Ship the stall ping',
    outcome: 'Owner is told about stalls',
    scope: 'host sweep only',
    authority: 'recommend',
    supersedes,
  });
}

/** Build a handoff in the given status through the ledger's own transitions. */
async function handoffIn(id: string, status: HandoffStatus): Promise<HandoffRow> {
  let row = await newHandoff(id);
  if (status === 'created') return row;
  row = await markHandoffDelivered(id, ATLAS, row.fingerprint);
  if (status === 'delivered') return row;
  if (status === 'changes_required') return reviewHandoff(id, ECHO, row.fingerprint, 'CHANGES REQUIRED');
  if (status === 'review_blocked') return reviewHandoff(id, ECHO, row.fingerprint, 'REVIEW BLOCKED');
  row = await reviewHandoff(id, ECHO, row.fingerprint, 'APPROVED');
  if (status === 'approved') return row;
  row = await acknowledgeHandoff(id, ATLAS, row.fingerprint);
  if (status === 'acknowledged') return row;
  return closeHandoff(id, ATLAS, row.fingerprint, 'done');
}

/** Backdate a handoff so it has been in its current state for `ms` at NOW. */
async function age(id: string, ms: number): Promise<string> {
  const updatedAt = new Date(NOW - ms).toISOString();
  await getDb().run('UPDATE handoffs SET updated_at = ? WHERE id = ?', updatedAt, id);
  return updatedAt;
}

async function pingEvents(id: string) {
  return (await listHandoffEvents(id))
    .filter((event) => event.event_type === OWNER_PINGED_EVENT)
    .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>);
}

function textOf(call: unknown[]): string {
  return (JSON.parse(call[4] as string) as { text: string }).text;
}

type Deliver = NonNullable<ReturnType<StallPingDeps['getDeliveryAdapter']>>['deliver'];

function makeDeps(overrides: Partial<StallPingDeps> = {}) {
  const deliver = vi.fn<Deliver>(async () => 'msg-1');
  const deps: StallPingDeps = {
    getOwners: async () => [{ user_id: OWNER }],
    ensureUserDm: async () => ({ channel_type: 'slack', platform_id: OWNER_DM, instance: 'slack' }),
    getDeliveryAdapter: () => ({ deliver }),
    recordOwnerPing,
    ...overrides,
  };
  return { deps, deliver };
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await seedAgents();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

describe('sweepStalledHandoffs', () => {
  it('pings the owner once for a handoff stalled past the threshold', async () => {
    const row = await handoffIn('H-E1', 'delivered');
    const updatedAt = await age(row.id, 7 * HOUR);
    const { deps, deliver } = makeDeps();

    await sweepStalledHandoffs(NOW, deps);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [channelType, platformId, threadId, kind, , files, instance] = deliver.mock.calls[0] as unknown[];
    expect([channelType, platformId, threadId, kind, files, instance]).toEqual([
      'slack',
      OWNER_DM,
      null,
      'chat-sdk',
      undefined,
      'slack',
    ]);
    const text = textOf(deliver.mock.calls[0] as unknown[]);
    expect(text).toContain(row.id);
    expect(text).toContain('delivered');
    expect(text).toContain('7 hours');

    const events = await pingEvents(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'delivered',
      updated_at: updatedAt,
      recipient: OWNER_DM,
      platform_message_id: 'msg-1',
      pinged_at: new Date(NOW).toISOString(),
    });

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await pingEvents(row.id)).toHaveLength(1);
  });

  it('does not ping closed or superseded handoffs', async () => {
    const closed = await handoffIn('H-E2-CLOSED', 'closed');
    await age(closed.id, 48 * HOUR);
    const prior = await handoffIn('H-E2-PRIOR', 'changes_required');
    const revision = await newHandoff('H-E2-REV', prior.id);
    await age(prior.id, 48 * HOUR);
    // The live revision itself is fresh, so it is not stalled either.
    const { deps, deliver } = makeDeps();

    await sweepStalledHandoffs(NOW, deps);

    expect(deliver).not.toHaveBeenCalled();
    expect(await pingEvents(closed.id)).toHaveLength(0);
    expect(await pingEvents(prior.id)).toHaveLength(0);
    expect(await pingEvents(revision.id)).toHaveLength(0);
  });

  it('review_blocked pings after one hour and other open statuses after six', async () => {
    expect(STALL_MS_BLOCKED).toBe(1 * HOUR);
    expect(STALL_MS_OPEN).toBe(6 * HOUR);
    const blocked = await handoffIn('H-E3-BLOCKED', 'review_blocked');
    const delivered = await handoffIn('H-E3-DELIVERED', 'delivered');
    await age(blocked.id, 2 * HOUR);
    await age(delivered.id, 2 * HOUR);
    const { deps, deliver } = makeDeps();

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(textOf(deliver.mock.calls[0] as unknown[])).toContain(blocked.id);
    expect(await pingEvents(blocked.id)).toHaveLength(1);
    expect(await pingEvents(delivered.id)).toHaveLength(0);

    await age(delivered.id, 7 * HOUR);
    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(textOf(deliver.mock.calls[1] as unknown[])).toContain(delivered.id);
    expect(await pingEvents(delivered.id)).toHaveLength(1);
  });

  it('pings again when the handoff moves to a new stalled state', async () => {
    const row = await handoffIn('H-E4', 'delivered');
    await age(row.id, 7 * HOUR);
    const { deps, deliver } = makeDeps();

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(1);

    await reviewHandoff(row.id, ECHO, row.fingerprint, 'CHANGES REQUIRED');
    const updatedAt = await age(row.id, 7 * HOUR);
    await sweepStalledHandoffs(NOW, deps);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(textOf(deliver.mock.calls[1] as unknown[])).toContain('changes_required');
    const events = await pingEvents(row.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ status: 'changes_required', updated_at: updatedAt, recipient: OWNER_DM });

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await pingEvents(row.id)).toHaveLength(2);
  });

  it('a delivery failure records no event and is retried on the next sweep', async () => {
    const row = await handoffIn('H-E5', 'delivered');
    await age(row.id, 7 * HOUR);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { deps, deliver } = makeDeps();
    deliver.mockRejectedValueOnce(new Error('slack timeout'));

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await pingEvents(row.id)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ handoffId: row.id, recipient: OWNER_DM }),
    );

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await pingEvents(row.id)).toHaveLength(1);
  });

  it('does nothing without an owner DM or delivery adapter', async () => {
    const row = await handoffIn('H-E6', 'delivered');
    await age(row.id, 7 * HOUR);
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const noDm = makeDeps({ ensureUserDm: async () => null });
    await expect(sweepStalledHandoffs(NOW, noDm.deps)).resolves.toBeUndefined();
    expect(noDm.deliver).not.toHaveBeenCalled();

    const noAdapter = makeDeps({ getDeliveryAdapter: () => null });
    await expect(sweepStalledHandoffs(NOW, noAdapter.deps)).resolves.toBeUndefined();
    expect(noAdapter.deliver).not.toHaveBeenCalled();

    expect(await pingEvents(row.id)).toHaveLength(0);
  });

  it('the message names who is waiting and the next action', async () => {
    const expected: Array<[HandoffStatus, string, string]> = [
      ['created', 'Waiting on: Atlas.', 'deliver the formal handoff'],
      ['delivered', 'Waiting on: Echo.', 'record a review outcome'],
      ['changes_required', 'Waiting on: Atlas.', '--supersedes'],
      ['review_blocked', 'Waiting on: you.', 'resolve the blocker'],
      ['approved', 'Waiting on: Atlas.', 'acknowledge'],
      ['acknowledged', 'Waiting on: Atlas.', 'close with evidence'],
    ];
    for (const [status] of expected) {
      const row = await handoffIn(`H-E7-${status}`, status);
      await age(row.id, 7 * HOUR);
    }
    const { deps, deliver } = makeDeps();

    await sweepStalledHandoffs(NOW, deps);

    expect(deliver).toHaveBeenCalledTimes(expected.length);
    const texts = deliver.mock.calls.map((call) => textOf(call as unknown[]));
    for (const [status, who, action] of expected) {
      const id = `H-E7-${status}`;
      const text = texts.find((candidate) => candidate.includes(`${id} (nanoclaw)`));
      expect(text, `message for ${status}`).toBeDefined();
      expect(text).toContain('⏳ Handoff needs attention');
      expect(text).toContain(`has been \`${status}\` for 7 hours.`);
      expect(text).toContain(who);
      expect(text).toContain(action);
      expect(text).toContain(`ncl handoffs get --id ${id}`);
      if (status === 'changes_required') expect(text).toContain(`ncl handoffs create --supersedes ${id}`);
    }
  });

  it('a handoff that changes between the scan and the send is not pinged', async () => {
    const first = await handoffIn('H-E8-FIRST', 'delivered');
    const second = await handoffIn('H-E8-SECOND', 'delivered');
    // listAllHandoffs orders by updated_at DESC, so the newer row is sent first.
    await age(first.id, 7 * HOUR);
    await age(second.id, 8 * HOUR);
    const { deps, deliver } = makeDeps();
    deliver.mockImplementationOnce(async () => {
      // Echo records a review outcome while the first ping is in flight.
      await reviewHandoff(second.id, ECHO, second.fingerprint, 'APPROVED');
      return 'msg-1';
    });

    await sweepStalledHandoffs(NOW, deps);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(textOf(deliver.mock.calls[0] as unknown[])).toContain(first.id);
    expect(await pingEvents(first.id)).toHaveLength(1);
    expect(await pingEvents(second.id)).toHaveLength(0);
  });

  it('a failed event append after a successful send yields one duplicate, not a silent miss', async () => {
    const row = await handoffIn('H-E9', 'delivered');
    await age(row.id, 7 * HOUR);
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    let failOnce = true;
    const { deps, deliver } = makeDeps({
      recordOwnerPing: async (id, record) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('sequence collision');
        }
        await recordOwnerPing(id, record);
      },
    });

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await pingEvents(row.id)).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ handoffId: row.id }));

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await pingEvents(row.id)).toHaveLength(1);

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await pingEvents(row.id)).toHaveLength(1);
  });

  it('each owner is deduplicated separately', async () => {
    const row = await handoffIn('H-E10', 'delivered');
    await age(row.id, 7 * HOUR);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const DM_A = 'slack:D0A';
    const DM_B = 'slack:D0B';
    const { deps, deliver } = makeDeps({
      getOwners: async () => [{ user_id: 'slack:U0A' }, { user_id: 'slack:U0B' }],
      ensureUserDm: async (userId) => ({
        channel_type: 'slack',
        platform_id: userId === 'slack:U0A' ? DM_A : DM_B,
        instance: 'slack',
      }),
    });
    let failSecond = true;
    deliver.mockImplementation(async (_channelType, platformId) => {
      if (platformId === DM_B && failSecond) {
        failSecond = false;
        throw new Error('slack timeout');
      }
      return `msg-${platformId}`;
    });

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
    let events = await pingEvents(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ recipient: DM_A });

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[2][1]).toBe(DM_B);
    events = await pingEvents(row.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ recipient: DM_B });

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(await pingEvents(row.id)).toHaveLength(2);
  });
});

describe('stall ping hardening (implementation review corrections, 2026-09-15)', () => {
  it('a corrupted successor link does not silence the prior', async () => {
    const stalled = await handoffIn('H-E11', 'delivered');
    await age(stalled.id, 7 * HOUR);
    const decoy = await newHandoff('H-E11-decoy');
    await getDb().run('UPDATE handoffs SET supersedes = ? WHERE id = ?', stalled.id, decoy.id);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { deps, deliver } = makeDeps();

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver.mock.calls.map(textOf).filter((text) => text.includes('H-E11 ('))).toHaveLength(1);
    expect(await pingEvents(stalled.id)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fingerprint'),
      expect.objectContaining({ successors: ['H-E11-decoy'] }),
    );
  });

  it('a delivery that never settles is treated as a failure and retried', async () => {
    const row = await handoffIn('H-E12', 'delivered');
    await age(row.id, 7 * HOUR);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { deps, deliver } = makeDeps({ deliverTimeoutMs: 20 });
    deliver.mockImplementationOnce(() => new Promise<string>(() => {}));

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await pingEvents(row.id)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ handoffId: row.id }));

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await pingEvents(row.id)).toHaveLength(1);
  });

  it('a malformed owner_pinged event neither blocks the sweep nor counts as a ping', async () => {
    const a = await handoffIn('H-E13-A', 'delivered');
    await age(a.id, 7 * HOUR);
    const b = await handoffIn('H-E13-B', 'delivered');
    await age(b.id, 7 * HOUR);
    await getDb().run(
      `INSERT INTO handoff_events (id, handoff_id, sequence, event_type, actor_agent_group_id, payload_json, created_at)
       VALUES ('bad-evt', ?, 99, ?, 'host:ping', '{not json', ?)`,
      a.id,
      OWNER_PINGED_EVENT,
      new Date(NOW).toISOString(),
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { deps, deliver } = makeDeps();

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
    const recorded = await getDb().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM handoff_events WHERE handoff_id = ? AND event_type = ? AND id <> 'bad-evt'",
      a.id,
      OWNER_PINGED_EVENT,
    );
    expect(recorded!.n).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
      expect.objectContaining({ eventId: 'bad-evt' }),
    );

    await sweepStalledHandoffs(NOW, deps);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
