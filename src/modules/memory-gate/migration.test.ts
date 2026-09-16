import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { memoryGateMigration } from './migration.js';

// docs/specs/memory-provenance-gate/plan.md §5 case G15.

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe('memory-gate migration', () => {
  it('the migration creates memory_write_ops and memory_gate_state', async () => {
    const db = getDb();
    await runMigrations(db, [memoryGateMigration]);

    expect(await db.hasTable('memory_write_ops')).toBe(true);
    expect(await db.hasTable('memory_gate_state')).toBe(true);

    const state = await db.get<{ id: number; quiesced: number; updated_at: string }>(
      'SELECT id, quiesced, updated_at FROM memory_gate_state WHERE id = 1',
    );
    expect(state).toMatchObject({ id: 1, quiesced: 0 });
    expect(Number.isNaN(Date.parse(state!.updated_at))).toBe(false);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_gate_state'))!.n).toBe(1);

    // The single-row check constraint holds.
    await expect(db.run("INSERT INTO memory_gate_state (id, quiesced, updated_at) VALUES (2, 0, 't')")).rejects.toThrow(
      /CHECK|constraint/i,
    );

    // Status and kind are constrained at the database level.
    const insert = (status: string, kind = 'free', mode = 'append') =>
      db.run(
        `INSERT INTO memory_write_ops (agent_group_id, request_id, session_id, kind, path, mode, content, content_sha256,
           status, created_at, updated_at)
         VALUES ('g', ?, 's', ?, 'x.md', ?, 'c', 'h', ?, 't', 't')`,
        `${status}-${kind}-${mode}`,
        kind,
        mode,
        status,
      );
    await insert('queued');
    await expect(insert('done')).rejects.toThrow(/CHECK|constraint/i);
    await expect(insert('queued', 'host')).rejects.toThrow(/CHECK|constraint/i);
    await expect(insert('queued', 'free', 'exec')).rejects.toThrow(/CHECK|constraint/i);

    const index = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_write_ops_status'",
    );
    expect(index?.name).toBe('idx_memory_write_ops_status');

    // Re-run is a no-op: same applied rows, state row untouched.
    const countBefore = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_version'))!.n;
    await runMigrations(db, [memoryGateMigration]);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_version'))!.n).toBe(countBefore);
    expect(await db.get('SELECT id, quiesced, updated_at FROM memory_gate_state WHERE id = 1')).toEqual(state);
    expect(
      (await db.all<{ name: string }>("SELECT name FROM schema_version WHERE name = 'module:nanoclaw.memory-gate:ops'"))
        .length,
    ).toBe(1);
  });
});
