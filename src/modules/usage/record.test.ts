/**
 * U1, U2, U3 from docs/specs/usage-digest/plan.md §6: the `record_usage`
 * delivery action through the REAL delivery loop with a real session mailbox.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-usage-record';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-usage-record',
    GROUPS_DIR: '/tmp/nanoclaw-test-usage-record/groups',
  };
});

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import './index.js';

const GROUP = 'ag-usage';
const CONTROL_CHAR = String.fromCharCode(7);

function now(): string {
  return new Date().toISOString();
}

function baseUsage(): Record<string, unknown> {
  return {
    cost_usd: 0.42,
    input_tokens: 1200,
    output_tokens: 340,
    cache_read_tokens: 9000,
    cache_creation_tokens: 100,
    model_usage: {
      'claude-opus-5': {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_tokens: 9000,
        cache_creation_tokens: 100,
        cost_usd: 0.42,
      },
    },
    duration_ms: 5400,
    duration_api_ms: 5100,
    num_turns: 3,
    sdk_result_id: 'sdk-result-1',
  };
}

function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'record_usage',
    turn_id: 'sdk-result-1',
    reported: true,
    is_error: false,
    occurred_at: '2026-09-16T20:00:00.000Z',
    usage: baseUsage(),
    ...overrides,
  };
}

function modelEntry(): Record<string, unknown> {
  return { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0 };
}

let session: Session;
let rowSeq = 0;

function enqueue(content: Record<string, unknown>): string {
  const id = `out-${++rowSeq}`;
  const out = new Database(outboundDbPath(GROUP, session.id));
  out
    .prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'system', ?, 'agent', ?)`,
    )
    .run(id, GROUP, JSON.stringify(content));
  out.close();
  return id;
}

async function rows(): Promise<Array<Record<string, unknown>>> {
  return getDb().all('SELECT * FROM usage_turns ORDER BY ingested_at, turn_id');
}

function deliveryStatus(id: string): string | undefined {
  const db = new Database(inboundDbPath(GROUP, session.id), { readonly: true });
  const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(id) as
    | { status: string }
    | undefined;
  db.close();
  return row?.status;
}

const deliver = vi.fn(async () => undefined);

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: GROUP, name: 'Usage', folder: 'usage', agent_provider: 'claude', created_at: now() });
  await getDb().run(
    "INSERT INTO container_configs (agent_group_id, provider, model, updated_at) VALUES (?, 'claude', 'opus', ?)",
    GROUP,
    now(),
  );
  deliver.mockClear();
  setDeliveryAdapter({ deliver } as never);
  ({ session } = await resolveSession(GROUP, null, null, 'shared'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

describe('U1 record_usage persists one row per turn, attributed and labelled from the host, idempotent under redelivery', () => {
  it('one row, host attribution, host provider and model, payload numbers, occurred_at from payload and ingested_at from host', async () => {
    const before = Date.now();
    const id = enqueue(usagePayload({ agent_group_id: 'ag-someone-else', provider: 'codex', model: 'gpt-x' }));
    await deliverSessionMessages(session);
    // Redelivery of the same record under a new outbound id.
    enqueue(usagePayload());
    await deliverSessionMessages(session);

    const all = await rows();
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(row.session_id).toBe(session.id);
    expect(row.turn_id).toBe('sdk-result-1');
    expect(row.agent_group_id).toBe(GROUP);
    expect(row.provider).toBe('claude');
    expect(row.model).toBe('opus');
    expect(row.reported).toBe(1);
    expect(row.is_error).toBe(0);
    expect(row.cost_usd).toBeCloseTo(0.42);
    expect(row.input_tokens).toBe(1200);
    expect(row.output_tokens).toBe(340);
    expect(row.cache_read_tokens).toBe(9000);
    expect(row.cache_creation_tokens).toBe(100);
    expect(JSON.parse(String(row.model_usage_json))).toHaveProperty('claude-opus-5');
    expect(row.duration_ms).toBe(5400);
    expect(row.num_turns).toBe(3);
    expect(row.occurred_at).toBe('2026-09-16T20:00:00.000Z');
    expect(Date.parse(String(row.ingested_at))).toBeGreaterThanOrEqual(before - 1000);
    expect(deliveryStatus(id)).toBe('delivered');
  });

  it('an unreported turn (Codex) stores null cost and zero tokens with the host model', async () => {
    enqueue({ action: 'record_usage', turn_id: 'codex-1', reported: false, is_error: true, occurred_at: now() });
    await deliverSessionMessages(session);
    const [row] = await rows();
    expect(row).toMatchObject({
      turn_id: 'codex-1',
      reported: 0,
      is_error: 1,
      cost_usd: null,
      input_tokens: 0,
      model: 'opus',
    });
  });
});

describe('U2 malformed or excessive usage records are dropped with a warning, never retried, and never block a valid row behind them', () => {
  it('drops each bad record with a named field, clock-corrects a stale occurred_at, and persists the valid rows', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const nineModels = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`m${i}`, modelEntry()]));
    const bad: Array<[string, Record<string, unknown>]> = [
      ['turn_id', usagePayload({ turn_id: undefined })],
      ['input_tokens', usagePayload({ turn_id: 't-neg', usage: { ...baseUsage(), input_tokens: -1 } })],
      ['cost_usd', usagePayload({ turn_id: 't-negcost', usage: { ...baseUsage(), cost_usd: -1 } })],
      ['cost_usd', usagePayload({ turn_id: 't-richcost', usage: { ...baseUsage(), cost_usd: 20000 } })],
      ['model_usage', usagePayload({ turn_id: 't-nine', usage: { ...baseUsage(), model_usage: nineModels } })],
      [
        'model_usage',
        usagePayload({
          turn_id: 't-ctrl',
          usage: { ...baseUsage(), model_usage: { [`bad${CONTROL_CHAR}key`]: modelEntry() } },
        }),
      ],
      ['usage', usagePayload({ turn_id: 't-noreport', usage: undefined })],
      ['payload', usagePayload({ turn_id: 't-big', note: 'x'.repeat(9 * 1024) })],
    ];
    const ids = bad.map(([, p]) => enqueue(p));
    const staleId = enqueue(usagePayload({ turn_id: 't-stale', occurred_at: '2026-09-13T00:00:00.000Z' }));
    const goodId = enqueue(usagePayload({ turn_id: 't-good' }));
    await deliverSessionMessages(session);

    const all = await rows();
    expect(all.map((r) => r.turn_id).sort()).toEqual(['t-good', 't-stale']);
    const stale = all.find((r) => r.turn_id === 't-stale')!;
    expect(stale.occurred_at).toBe(stale.ingested_at);
    for (const id of [...ids, staleId, goodId]) expect(deliveryStatus(id)).toBe('delivered');
    for (const [field] of bad) {
      const named = warn.mock.calls.some(
        (c) => String(c[0]).includes('record_usage') && JSON.stringify(c[1] ?? {}).includes(field),
      );
      expect(named, field).toBe(true);
    }
  });

  it('drops the 121st record for a session inside an hour and logs it', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 121; i += 1) enqueue(usagePayload({ turn_id: `burst-${i}` }));
    await deliverSessionMessages(session);
    expect((await rows()).length).toBe(120);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('rate'))).toBe(true);
  });
});

describe('U3 a usage record never reaches the channel adapter', () => {
  it('the adapter is never called and nothing lands in the session inbox', async () => {
    enqueue(usagePayload());
    await deliverSessionMessages(session);
    expect(deliver).not.toHaveBeenCalled();
    const inbox = new Database(inboundDbPath(GROUP, session.id), { readonly: true });
    const count = inbox.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number };
    inbox.close();
    expect(count.n).toBe(0);
    expect(await rows()).toHaveLength(1);
  });
});
