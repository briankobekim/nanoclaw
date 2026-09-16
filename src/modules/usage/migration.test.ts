/** U7 from docs/specs/usage-digest/plan.md §6. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

const BASE = `INSERT INTO usage_turns (session_id, turn_id, agent_group_id, provider, model, reported, is_error, cost_usd,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, occurred_at, ingested_at)
   VALUES ('s', ?, 'g', 'claude', 'opus', ?, 0, ?, ?, 0, 0, 0, 't', 't')`;

describe('U7 migration creates usage_turns and usage_digest_deliveries, is idempotent, and enforces its bounds', () => {
  it('creates both tables with their primary keys', async () => {
    const db = getDb();
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('usage_turns', 'usage_digest_deliveries') ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual(['usage_digest_deliveries', 'usage_turns']);
    const pk = await db.all<{ name: string; pk: number }>('PRAGMA table_info(usage_turns)');
    expect(pk.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['session_id', 'turn_id']);
    const index = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_turns_group_occurred'",
    );
    expect(index?.name).toBe('idx_usage_turns_group_occurred');
  });

  it('running the migrations again is a no-op', async () => {
    await runMigrations(getDb());
    const tables = await getDb().all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'usage_%'",
    );
    expect(tables).toHaveLength(2);
  });

  it('rejects a negative token count, a token count above 1e9, a cost above 1e4, and reported = 2', async () => {
    const db = getDb();
    await db.run(BASE, 'ok', 1, 1.25, 10);
    await expect(db.run(BASE, 'neg', 1, 1, -1)).rejects.toThrow(/CHECK|constraint/i);
    await expect(db.run(BASE, 'huge', 1, 1, 1_000_000_001)).rejects.toThrow(/CHECK|constraint/i);
    await expect(db.run(BASE, 'rich', 1, 10_001, 1)).rejects.toThrow(/CHECK|constraint/i);
    await expect(db.run(BASE, 'two', 2, 1, 1)).rejects.toThrow(/CHECK|constraint/i);
    expect((await db.all('SELECT turn_id FROM usage_turns')).length).toBe(1);
  });
});
