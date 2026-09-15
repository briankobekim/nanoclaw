/**
 * Module migration for the verifier's captured inputs.
 *
 * `verification_inputs` is written in exactly one place — the ledger's
 * `deliverHandoffWithInputs`, inside the same transaction that moves a handoff
 * to `delivered`. There is deliberately no `ncl` resource for it: an agent
 * that can create handoffs through the CLI must not be able to supply the
 * commands the host will later execute.
 *
 * The handoff-ledger migration is imported first for its registration side
 * effect. Module migrations run in import order, and this table's foreign key
 * points at `handoffs(id)`.
 */
import '../handoff-ledger/migration.js';

import { registerMigration, type ModuleMigration } from '../../db/migrations/index.js';

export const verifierInputsMigration: ModuleMigration = {
  version: 1,
  name: 'module:nanoclaw.verifier:verification-inputs',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE verification_inputs (
        handoff_id          TEXT PRIMARY KEY REFERENCES handoffs(id),
        class               TEXT NOT NULL,
        checkpoint          TEXT NOT NULL,
        checks_json         TEXT NOT NULL,
        reproduce_json      TEXT NOT NULL,
        inputs_fingerprint  TEXT NOT NULL,
        captured_at         TEXT NOT NULL,
        captured_by         TEXT NOT NULL
      );
    `);
  },
};

registerMigration(verifierInputsMigration);
