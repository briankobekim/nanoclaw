import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { handoffLedgerMigration, handoffSupersedesMigration } from './migration.js';

// docs/specs/handoff-revision-loop/plan.md §5 case A10: the live ledger is a
// populated v1 database; the v2 column must arrive without touching its rows.

const ATLAS = 'ag-atlas-mig';
const ECHO = 'ag-echo-mig';

async function insertV1Handoff(id: string): Promise<void> {
  await getDb().run(
    `INSERT INTO handoffs
       (id, source_agent_group_id, reviewer_agent_group_id, source_session_id, project, goal, outcome, scope,
        authority, fingerprint, status, review_outcome, review_notes, closure_evidence, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, NULL, 'quiveriq', 'goal', 'outcome', 'scope', 'recommend', ?, 'delivered', NULL, NULL, NULL,
             '2026-09-14T00:00:00.000Z', '2026-09-14T01:00:00.000Z', NULL)`,
    id,
    ATLAS,
    ECHO,
    `fp-${id}`,
  );
  for (const [sequence, type] of [
    [1, 'created'],
    [2, 'delivered'],
  ] as const) {
    await getDb().run(
      `INSERT INTO handoff_events (id, handoff_id, sequence, event_type, actor_agent_group_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, '{}', '2026-09-14T00:00:00.000Z')`,
      `${id}-e${sequence}`,
      id,
      sequence,
      type,
      ATLAS,
    );
  }
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe('handoff-ledger supersedes migration', () => {
  it('the supersedes migration upgrades a populated v1 ledger without loss', async () => {
    const db = getDb();
    await runMigrations(db, [handoffLedgerMigration]);
    await insertV1Handoff('MIG-1');
    await insertV1Handoff('MIG-2');
    const rowsBefore = await db.all<Record<string, unknown>>('SELECT * FROM handoffs ORDER BY id');
    const eventsBefore = await db.all<Record<string, unknown>>('SELECT * FROM handoff_events ORDER BY id');
    expect(rowsBefore).toHaveLength(2);
    expect(eventsBefore).toHaveLength(4);

    await runMigrations(db, [handoffLedgerMigration, handoffSupersedesMigration]);

    const rowsAfter = await db.all<Record<string, unknown>>('SELECT * FROM handoffs ORDER BY id');
    expect(rowsAfter.map(({ supersedes, ...rest }) => rest)).toEqual(rowsBefore);
    expect(rowsAfter.map((row) => row.supersedes)).toEqual([null, null]);
    expect(await db.all<Record<string, unknown>>('SELECT * FROM handoff_events ORDER BY id')).toEqual(eventsBefore);

    const index = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_handoffs_supersedes'",
    );
    expect(index?.name).toBe('idx_handoffs_supersedes');

    const insertSuccessor = (id: string, supersedes: string) =>
      db.run(
        `INSERT INTO handoffs (id, source_agent_group_id, reviewer_agent_group_id, project, goal, outcome, scope,
           authority, fingerprint, status, created_at, updated_at, supersedes)
         VALUES (?, ?, ?, 'quiveriq', 'g', 'o', 's', 'recommend', ?, 'created', 't', 't', ?)`,
        id,
        ATLAS,
        ECHO,
        `fp-${id}`,
        supersedes,
      );
    await expect(insertSuccessor('MIG-DANGLING', 'MIG-MISSING')).rejects.toThrow(/FOREIGN KEY/i);
    await insertSuccessor('MIG-1-r2', 'MIG-1');
    await expect(insertSuccessor('MIG-1-r3', 'MIG-1')).rejects.toThrow(/UNIQUE|constraint/i);

    const applied = await db.all<{ name: string }>(
      "SELECT name FROM schema_version WHERE name = 'module:nanoclaw.handoff-ledger:supersedes'",
    );
    expect(applied).toHaveLength(1);
    const countBefore = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_version'))!.n;
    await runMigrations(db, [handoffLedgerMigration, handoffSupersedesMigration]);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_version'))!.n).toBe(countBefore);
  });
});
