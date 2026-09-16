import { registerMigration, type ModuleMigration } from '../../db/migrations/index.js';

/**
 * Usage digest ledger (docs/specs/usage-digest/plan.md §4.2).
 *
 * `usage_turns`: one row per agent turn, keyed by (session, turn). Attribution,
 * provider and model are host-derived at ingest; the measurements are
 * container-reported and bounded by CHECK constraints as a last line behind
 * the handler's validation. `usage_digest_deliveries`: one row per owner,
 * written only after the adapter accepted that owner's digest.
 */
const TOKEN_MAX = 1_000_000_000;
const COST_MAX = 10_000;

export const usageMigration: ModuleMigration = {
  version: 1,
  name: 'module:nanoclaw.usage:turns',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE usage_turns (
        session_id            TEXT NOT NULL,
        turn_id               TEXT NOT NULL,
        agent_group_id        TEXT NOT NULL,
        provider              TEXT NOT NULL,
        model                 TEXT NOT NULL,
        reported              INTEGER NOT NULL CHECK (reported IN (0, 1)),
        is_error              INTEGER NOT NULL CHECK (is_error IN (0, 1)),
        cost_usd              REAL NULL CHECK (cost_usd IS NULL OR (cost_usd >= 0 AND cost_usd <= ${COST_MAX})),
        input_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND ${TOKEN_MAX}),
        output_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND ${TOKEN_MAX}),
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens BETWEEN 0 AND ${TOKEN_MAX}),
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens BETWEEN 0 AND ${TOKEN_MAX}),
        model_usage_json      TEXT NOT NULL DEFAULT '{}',
        duration_ms           INTEGER NULL,
        num_turns             INTEGER NULL,
        occurred_at           TEXT NOT NULL,
        ingested_at           TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );

      CREATE INDEX idx_usage_turns_group_occurred ON usage_turns(agent_group_id, occurred_at);

      CREATE TABLE usage_digest_deliveries (
        owner_user_id         TEXT PRIMARY KEY,
        last_sent_local_date  TEXT NOT NULL,
        window_end            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
    `);
  },
};

registerMigration(usageMigration);
