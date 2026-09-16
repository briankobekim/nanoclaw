import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { enqueueMemoryOp, getMemoryOp, type MemoryOpInput } from './ops.js';
import { isQuiesced, setQuiesced } from './quiesce.js';
import './migration.js';

// docs/specs/memory-provenance-gate/plan.md §4.3 "Quiesce (database barrier)"
// and "Enqueue and complete": the barrier lives inside the insert statement.

const INPUT: MemoryOpInput = {
  agentGroupId: 'ag-quiesce',
  requestId: 'owner:msg-1',
  sessionId: 'sess-1',
  kind: 'owner',
  path: 'owner-statements.md',
  mode: 'append',
  content: 'remember: my flight is Friday',
  ownerMessageId: 'msg-1',
};

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('memory-gate quiesce barrier', () => {
  it('isQuiesced reads the flag and setQuiesced flips it', async () => {
    expect(await isQuiesced()).toBe(false);
    await setQuiesced(true);
    expect(await isQuiesced()).toBe(true);
    expect(
      (await getDb().get<{ quiesced: number }>('SELECT quiesced FROM memory_gate_state WHERE id = 1'))!.quiesced,
    ).toBe(1);
    await setQuiesced(false);
    expect(await isQuiesced()).toBe(false);
  });

  it('enqueueMemoryOp returns quiesced when the barrier is set, exists for an identical duplicate, and throws for a conflicting duplicate', async () => {
    await setQuiesced(true);
    expect(await enqueueMemoryOp(INPUT)).toBe('quiesced');
    expect(await getMemoryOp(INPUT.agentGroupId, INPUT.requestId)).toBeUndefined();

    await setQuiesced(false);
    expect(await enqueueMemoryOp(INPUT)).toBe('inserted');
    const row = await getMemoryOp(INPUT.agentGroupId, INPUT.requestId);
    expect(row).toMatchObject({
      agent_group_id: INPUT.agentGroupId,
      request_id: INPUT.requestId,
      session_id: INPUT.sessionId,
      kind: 'owner',
      path: 'owner-statements.md',
      mode: 'append',
      content: INPUT.content,
      owner_message_id: 'msg-1',
      status: 'queued',
      attempts: 0,
      before_sha256: null,
      after_sha256: null,
      applied_at: null,
    });
    expect(row!.content_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Identical duplicate, with and without the barrier: accepted as existing.
    expect(await enqueueMemoryOp(INPUT)).toBe('exists');
    await setQuiesced(true);
    expect(await enqueueMemoryOp(INPUT)).toBe('exists');
    await setQuiesced(false);

    // Same key, different content: conflicting reuse of a message id.
    await expect(enqueueMemoryOp({ ...INPUT, content: 'remember: something else' })).rejects.toThrow(
      'memory op ag-quiesce/owner:msg-1 already exists with different content',
    );
    await expect(enqueueMemoryOp({ ...INPUT, mode: 'replace' })).rejects.toThrow(/different content/);
    await expect(enqueueMemoryOp({ ...INPUT, path: 'notes.md' })).rejects.toThrow(/different content/);
    await expect(enqueueMemoryOp({ ...INPUT, kind: 'free' })).rejects.toThrow(/different content/);

    // Still exactly one row.
    expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_write_ops'))!.n).toBe(1);
  });

  it('a concurrent identical insert that loses the primary-key race resolves to exists', async () => {
    const results = await Promise.all([enqueueMemoryOp(INPUT), enqueueMemoryOp(INPUT), enqueueMemoryOp(INPUT)]);
    expect(results.filter((r) => r === 'inserted')).toHaveLength(1);
    expect(results.filter((r) => r === 'exists')).toHaveLength(2);
  });
});
