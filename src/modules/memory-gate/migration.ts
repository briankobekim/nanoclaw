import { registerMigration, type ModuleMigration } from '../../db/migrations/index.js';

/**
 * Memory provenance gate ledger (docs/specs/memory-provenance-gate/plan.md §4.3).
 *
 * `memory_write_ops` is the durable operation ledger: one row per write, keyed
 * by (agent group, request id) so an owner message or an approved request can
 * be enqueued idempotently. `memory_gate_state` is the single-row quiesce
 * barrier consulted inside every insert statement.
 */
export const memoryGateMigration: ModuleMigration = {
  version: 1,
  name: 'module:nanoclaw.memory-gate:ops',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE memory_write_ops (
        -- Durable insertion order, assigned by the database inside the insert
        -- statement; completion order never depends on the wall clock.
        seq               INTEGER NOT NULL UNIQUE,
        agent_group_id    TEXT NOT NULL,
        request_id        TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN ('owner', 'free')),
        path              TEXT NOT NULL,
        mode              TEXT NOT NULL CHECK (mode IN ('replace', 'append', 'delete')),
        content           TEXT,
        content_sha256    TEXT NOT NULL,
        owner_message_id  TEXT,
        before_sha256     TEXT,
        after_sha256      TEXT,
        status            TEXT NOT NULL CHECK (status IN ('queued', 'prepared', 'applied', 'conflict', 'abandoned')),
        attempts          INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        applied_at        TEXT,
        PRIMARY KEY (agent_group_id, request_id)
      );

      CREATE INDEX idx_memory_write_ops_status ON memory_write_ops(status, seq);

      CREATE TABLE memory_gate_state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        quiesced    INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL
      );
    `);
    await db.run('INSERT INTO memory_gate_state (id, quiesced, updated_at) VALUES (1, 0, ?)', new Date().toISOString());
  },
};

registerMigration(memoryGateMigration);
