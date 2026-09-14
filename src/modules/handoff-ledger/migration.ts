import { registerMigration, type ModuleMigration } from '../../db/migrations/index.js';

export const handoffLedgerMigration: ModuleMigration = {
  version: 1,
  name: 'module:nanoclaw.handoff-ledger:initial',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE handoffs (
        id                       TEXT PRIMARY KEY,
        source_agent_group_id    TEXT NOT NULL,
        reviewer_agent_group_id  TEXT NOT NULL,
        source_session_id        TEXT,
        project                  TEXT NOT NULL,
        goal                     TEXT NOT NULL,
        outcome                  TEXT NOT NULL,
        scope                    TEXT NOT NULL,
        authority                TEXT NOT NULL,
        fingerprint              TEXT NOT NULL,
        status                   TEXT NOT NULL,
        review_outcome           TEXT,
        review_notes             TEXT,
        closure_evidence         TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        closed_at                TEXT,
        CHECK (source_agent_group_id <> reviewer_agent_group_id),
        CHECK (status IN ('created', 'delivered', 'approved', 'changes_required', 'review_blocked', 'acknowledged', 'closed'))
      );

      CREATE INDEX idx_handoffs_source_status
        ON handoffs(source_agent_group_id, status, updated_at);
      CREATE INDEX idx_handoffs_reviewer_status
        ON handoffs(reviewer_agent_group_id, status, updated_at);

      CREATE TABLE handoff_events (
        id                    TEXT PRIMARY KEY,
        handoff_id            TEXT NOT NULL REFERENCES handoffs(id),
        sequence              INTEGER NOT NULL,
        event_type            TEXT NOT NULL,
        actor_agent_group_id  TEXT NOT NULL,
        payload_json          TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        UNIQUE(handoff_id, sequence)
      );

      CREATE INDEX idx_handoff_events_handoff
        ON handoff_events(handoff_id, sequence);
    `);
  },
};

/**
 * Adds attempt fencing without relying on the experimental `delivering` and
 * `reviewing` status values. Normalizing those values first makes this safe
 * for local databases that applied an earlier, unpublished version of v1;
 * databases with the original v1 constraint simply update zero rows.
 */
export const handoffReservationFencingMigration: ModuleMigration = {
  version: 2,
  name: 'module:nanoclaw.handoff-ledger:reservation-fencing',
  up: async (db) => {
    await db.exec(`
      UPDATE handoffs SET status = 'created' WHERE status = 'delivering';
      UPDATE handoffs SET status = 'delivered' WHERE status = 'reviewing';
      ALTER TABLE handoffs ADD COLUMN reservation_kind TEXT;
      ALTER TABLE handoffs ADD COLUMN reservation_generation INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE handoffs ADD COLUMN reservation_expires_at TEXT;
    `);
  },
};

registerMigration(handoffLedgerMigration);
registerMigration(handoffReservationFencingMigration);
