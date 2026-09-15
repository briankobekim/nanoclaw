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

registerMigration(handoffLedgerMigration);
