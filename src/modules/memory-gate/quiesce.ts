/**
 * Quiesce barrier (plan §4.3). The flag lives in `memory_gate_state` and is
 * consulted INSIDE the op insert statement (see ops.ts), so an in-flight
 * handler cannot race it. Set and cleared with `ncl memory-gate quiesce on|off`.
 */
import { getDb } from '../../db/connection.js';

export async function isQuiesced(): Promise<boolean> {
  const row = await getDb().get<{ quiesced: number }>('SELECT quiesced FROM memory_gate_state WHERE id = 1');
  return row?.quiesced === 1;
}

export async function setQuiesced(on: boolean): Promise<void> {
  await getDb().run(
    `INSERT INTO memory_gate_state (id, quiesced, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET quiesced = excluded.quiesced, updated_at = excluded.updated_at`,
    on ? 1 : 0,
    new Date().toISOString(),
  );
}
