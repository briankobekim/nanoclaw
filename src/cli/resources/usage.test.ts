/** U4 from docs/specs/usage-digest/plan.md §6. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, TIMEZONE: 'UTC' };
});

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { runMigrations } from '../../db/migrations/index.js';
import '../../modules/usage/migration.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './usage.js';

const ATLAS = 'ag-atlas-usage';
const ECHO = 'ag-echo-usage';
// 12:00 in New York on 2026-09-15 (EDT, UTC-4).
const NOW = new Date('2026-09-15T16:00:00Z');

function agent(group: string): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId: `sess-${group}`, messagingGroupId: 'mg-test' };
}

interface Seed {
  turn_id: string;
  group: string;
  provider: string;
  reported: 0 | 1;
  is_error?: 0 | 1;
  cost_usd: number | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  occurred_at: string;
  ingested_at: string;
}

async function seed(row: Seed): Promise<void> {
  await getDb().run(
    `INSERT INTO usage_turns (session_id, turn_id, agent_group_id, provider, model, reported, is_error, cost_usd,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, occurred_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `sess-${row.group}`,
    row.turn_id,
    row.group,
    row.provider,
    row.provider === 'codex' ? 'gpt-5' : 'opus',
    row.reported,
    row.is_error ?? 0,
    row.cost_usd,
    row.input_tokens ?? 0,
    row.output_tokens ?? 0,
    row.cache_read_tokens ?? 0,
    row.cache_creation_tokens ?? 0,
    row.occurred_at,
    row.ingested_at,
  );
}

async function seedFixture(): Promise<void> {
  // Echo (Codex, America/New_York): two turns that straddle local midnight
  // (23:30 and 00:30 New York) but share a UTC date, both ingested after
  // midnight New York — a delivery retry across the boundary. Nothing is
  // reported, so cost must be null, never 0.
  await seed({
    turn_id: 'echo-late',
    group: ECHO,
    provider: 'codex',
    reported: 0,
    cost_usd: null,
    occurred_at: '2026-09-15T03:30:00.000Z',
    ingested_at: '2026-09-15T04:10:00.000Z',
  });
  await seed({
    turn_id: 'echo-early',
    group: ECHO,
    provider: 'codex',
    reported: 0,
    cost_usd: null,
    occurred_at: '2026-09-15T04:30:00.000Z',
    ingested_at: '2026-09-15T04:31:00.000Z',
  });
  // Outside a 2-day window (2026-09-13 New York).
  await seed({
    turn_id: 'echo-old',
    group: ECHO,
    provider: 'codex',
    reported: 0,
    cost_usd: null,
    occurred_at: '2026-09-13T12:00:00.000Z',
    ingested_at: '2026-09-13T12:00:05.000Z',
  });
  // Atlas (Claude, inherits UTC): two reported turns today, one an error.
  await seed({
    turn_id: 'atlas-a',
    group: ATLAS,
    provider: 'claude',
    reported: 1,
    cost_usd: 1.25,
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 5000,
    cache_creation_tokens: 300,
    occurred_at: '2026-09-15T10:00:00.000Z',
    ingested_at: '2026-09-15T10:00:02.000Z',
  });
  await seed({
    turn_id: 'atlas-b',
    group: ATLAS,
    provider: 'claude',
    reported: 1,
    is_error: 1,
    cost_usd: 0.75,
    input_tokens: 500,
    output_tokens: 100,
    occurred_at: '2026-09-15T11:00:00.000Z',
    ingested_at: '2026-09-15T11:00:01.000Z',
  });
  // Yesterday: one reported turn and one unreported (SDK failure with no
  // result) — the mixed agent/day.
  await seed({
    turn_id: 'atlas-c',
    group: ATLAS,
    provider: 'claude',
    reported: 1,
    cost_usd: 0.5,
    input_tokens: 400,
    output_tokens: 40,
    occurred_at: '2026-09-14T20:00:00.000Z',
    ingested_at: '2026-09-14T20:00:01.000Z',
  });
  await seed({
    turn_id: 'atlas-d',
    group: ATLAS,
    provider: 'claude',
    reported: 0,
    is_error: 1,
    cost_usd: null,
    occurred_at: '2026-09-14T21:00:00.000Z',
    ingested_at: '2026-09-14T21:00:01.000Z',
  });
}

async function summary(ctx: CallerContext, args: Record<string, unknown> = {}) {
  const response = await dispatch({ id: 'summary', command: 'usage-summary', args }, ctx);
  if (!response.ok) throw new Error(`usage-summary failed: ${response.error.code}: ${response.error.message}`);
  return { rows: response.data as Array<Record<string, unknown>>, human: response.human ?? '' };
}

async function list(ctx: CallerContext, args: Record<string, unknown> = {}) {
  const response = await dispatch({ id: 'list', command: 'usage-list', args }, ctx);
  if (!response.ok) throw new Error(`usage-list failed: ${response.error.code}: ${response.error.message}`);
  return { rows: response.data as Array<Record<string, unknown>>, human: response.human ?? '' };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await runMigrations(await initTestDb());
  const created_at = NOW.toISOString();
  await createAgentGroup({ id: ATLAS, name: 'Atlas', folder: 'atlas', agent_provider: null, created_at });
  await createAgentGroup({ id: ECHO, name: 'Echo', folder: 'echo', agent_provider: 'codex', created_at });
  await ensureContainerConfig(ATLAS, null);
  await ensureContainerConfig(ECHO, 'codex');
  await updateContainerConfigScalars(ECHO, { timezone: 'America/New_York' });
});

afterEach(async () => {
  await closeDb();
  vi.useRealTimers();
});

describe('U4 usage summary groups by agent and the local day the turn occurred, scopes agent callers, and never shows Codex as free', () => {
  it('groups by occurred_at in the group timezone, sums reported cost, and renders Codex as not reported', async () => {
    await seedFixture();

    const { rows, human } = await summary({ caller: 'host' }, { days: 2 });

    expect(rows).toHaveLength(4);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_group_id: ATLAS,
          agent: 'Atlas',
          day: '2026-09-15',
          turns: 2,
          error_turns: 1,
          reported_turns: 2,
          input_tokens: 1500,
          output_tokens: 300,
          cache_read_tokens: 5000,
          cache_creation_tokens: 300,
          cost_usd: 2,
        }),
        expect.objectContaining({
          agent_group_id: ATLAS,
          agent: 'Atlas',
          day: '2026-09-14',
          turns: 2,
          error_turns: 1,
          reported_turns: 1,
          cost_usd: 0.5,
        }),
        expect.objectContaining({
          agent_group_id: ECHO,
          agent: 'Echo',
          day: '2026-09-14',
          turns: 1,
          error_turns: 0,
          reported_turns: 0,
          cost_usd: null,
        }),
        expect.objectContaining({
          agent_group_id: ECHO,
          agent: 'Echo',
          day: '2026-09-15',
          turns: 1,
          error_turns: 0,
          reported_turns: 0,
          cost_usd: null,
        }),
      ]),
    );
    expect(rows.some((row) => row.day === '2026-09-13')).toBe(false);

    expect(human).toContain('not reported');
    expect(human).toContain('partial (1 of 2 turns)');
    expect(human).toContain('$2.00');
    expect(human).not.toContain('$0.00');
  });

  it('defaults to one local day', async () => {
    await seedFixture();
    const { rows } = await summary({ caller: 'host' });
    expect(rows.map((row) => row.day)).toEqual(['2026-09-15', '2026-09-15']);
  });

  it('scopes an agent caller to its own group even with --group', async () => {
    await seedFixture();

    const own = await summary(agent(ECHO), { days: 2 });
    expect(own.rows.length).toBeGreaterThan(0);
    expect(own.rows.every((row) => row.agent_group_id === ECHO)).toBe(true);

    // Naming another group is refused by the guard before the handler runs;
    // naming its own group is allowed and still pinned.
    const foreign = await dispatch(
      { id: 'foreign', command: 'usage-summary', args: { days: 2, group: 'Atlas' } },
      agent(ECHO),
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('forbidden');
    const pinned = await summary(agent(ECHO), { days: 2, group: ECHO });
    expect(pinned.rows.every((row) => row.agent_group_id === ECHO)).toBe(true);

    const listed = await list(agent(ECHO), { limit: 50 });
    expect(listed.rows).toHaveLength(3);
    expect(listed.rows.every((row) => row.agent_group_id === ECHO)).toBe(true);
  });

  it('lets a host caller narrow to one group by name', async () => {
    await seedFixture();
    const { rows } = await summary({ caller: 'host' }, { days: 2, group: 'echo' });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.agent_group_id === ECHO)).toBe(true);
  });

  it('list --limit 1 returns the newest row by occurred_at', async () => {
    await seedFixture();
    const { rows } = await list({ caller: 'host' }, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        turn_id: 'atlas-b',
        agent_group_id: ATLAS,
        agent: 'Atlas',
        provider: 'claude',
        reported: 1,
        is_error: 1,
        cost_usd: 0.75,
        occurred_at: '2026-09-15T11:00:00.000Z',
      }),
    );
  });

  it('never throws on an empty table', async () => {
    const empty = await summary({ caller: 'host' }, { days: 7 });
    expect(empty.rows).toEqual([]);
    expect(empty.human).toMatch(/no usage/i);
    const listed = await list({ caller: 'host' });
    expect(listed.rows).toEqual([]);
  });

  it('rejects out-of-range --days and --limit', async () => {
    const days = await dispatch({ id: 'd', command: 'usage-summary', args: { days: 91 } }, { caller: 'host' });
    expect(days.ok).toBe(false);
    const limit = await dispatch({ id: 'l', command: 'usage-list', args: { limit: 0 } }, { caller: 'host' });
    expect(limit.ok).toBe(false);
  });
});
