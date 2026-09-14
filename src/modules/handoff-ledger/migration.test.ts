import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initSqliteTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { handoffLedgerMigration, handoffReservationFencingMigration } from './migration.js';

afterEach(async () => {
  await closeDb();
});

async function seedAppliedInitial(allowedStatuses: string, rows: Array<[string, string]>): Promise<void> {
  const db = await initSqliteTestDb();
  await db.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied TEXT NOT NULL
    );
    INSERT INTO schema_version (version, name, applied)
      VALUES (1, 'module:nanoclaw.handoff-ledger:initial', '2026-09-14T00:00:00.000Z');
    CREATE TABLE handoffs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN (${allowedStatuses}))
    );
  `);
  for (const [id, status] of rows) await db.run('INSERT INTO handoffs (id, status) VALUES (?, ?)', id, status);
}

async function applyFencingMigration(): Promise<void> {
  await runMigrations(getDb(), [handoffLedgerMigration, handoffReservationFencingMigration]);
}

describe('handoff reservation fencing migration', () => {
  it('upgrades the original experimental schema and remains idempotent', async () => {
    await seedAppliedInitial("'created', 'delivered', 'approved'", [['h-created', 'created']]);

    await applyFencingMigration();
    await applyFencingMigration();

    const db = getDb();
    const columns = await db.all<{ name: string }>('PRAGMA table_info(handoffs)');
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['reservation_kind', 'reservation_generation', 'reservation_expires_at']),
    );
    expect(await db.get('SELECT * FROM handoffs WHERE id = ?', 'h-created')).toMatchObject({
      status: 'created',
      reservation_kind: null,
      reservation_generation: 0,
      reservation_expires_at: null,
    });
  });

  it('makes unpublished in-flight status rows retryable during upgrade', async () => {
    await seedAppliedInitial("'created', 'delivering', 'delivered', 'reviewing', 'approved'", [
      ['h-delivery', 'delivering'],
      ['h-review', 'reviewing'],
    ]);

    await applyFencingMigration();

    const db = getDb();
    expect(await db.all('SELECT id, status, reservation_generation FROM handoffs ORDER BY id')).toEqual([
      { id: 'h-delivery', status: 'created', reservation_generation: 0 },
      { id: 'h-review', status: 'delivered', reservation_generation: 0 },
    ]);
  });
});
