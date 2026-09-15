import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  acknowledgeHandoff,
  closeHandoff,
  createHandoff,
  listHandoffEvents,
  markHandoffDelivered,
  reviewHandoff,
} from './ledger.js';
import './migration.js';

const ATLAS = 'ag-atlas';
const ECHO = 'ag-echo';

async function seedAgents(): Promise<void> {
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: ATLAS, name: 'Atlas', folder: 'atlas', agent_provider: null, created_at });
  await createAgentGroup({ id: ECHO, name: 'Echo', folder: 'echo', agent_provider: null, created_at });
}

async function freshHandoff() {
  return createHandoff({
    id: 'COS-07-TEST-1',
    sourceAgentGroupId: ATLAS,
    reviewerAgentGroupId: ECHO,
    project: 'none',
    goal: 'Verify the closure policy',
    outcome: 'One formal review outcome',
    scope: 'Policy text only',
    authority: 'recommend',
  });
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await seedAgents();
});

afterEach(async () => {
  await closeDb();
});

describe('handoff ledger', () => {
  it('records the full append-only happy path', async () => {
    const created = await freshHandoff();
    await markHandoffDelivered(created.id, ATLAS, created.fingerprint);
    await reviewHandoff(created.id, ECHO, created.fingerprint, 'APPROVED', 'Policy is complete.');
    await acknowledgeHandoff(created.id, ATLAS, created.fingerprint);
    const closed = await closeHandoff(created.id, ATLAS, created.fingerprint, 'Echo approved the exact fingerprint.');

    expect(closed.status).toBe('closed');
    expect(closed.closure_evidence).toContain('exact fingerprint');
    expect((await listHandoffEvents(created.id)).map((event) => event.event_type)).toEqual([
      'created',
      'delivered',
      'approved',
      'acknowledged',
      'closed',
    ]);
  });

  it('rejects a mismatched fingerprint without advancing state', async () => {
    const created = await freshHandoff();
    await expect(markHandoffDelivered(created.id, ATLAS, 'wrong-fingerprint')).rejects.toThrow('fingerprint mismatch');
    expect((await listHandoffEvents(created.id)).map((event) => event.event_type)).toEqual(['created']);
  });

  it('rejects a duplicate review', async () => {
    const created = await freshHandoff();
    await markHandoffDelivered(created.id, ATLAS, created.fingerprint);
    await reviewHandoff(created.id, ECHO, created.fingerprint, 'APPROVED');
    await expect(reviewHandoff(created.id, ECHO, created.fingerprint, 'APPROVED')).rejects.toThrow(
      'expected delivered',
    );
  });

  it('rejects the wrong actor at every ownership boundary', async () => {
    const created = await freshHandoff();
    await expect(markHandoffDelivered(created.id, ECHO, created.fingerprint)).rejects.toThrow('source');
    await markHandoffDelivered(created.id, ATLAS, created.fingerprint);
    await expect(reviewHandoff(created.id, ATLAS, created.fingerprint, 'APPROVED')).rejects.toThrow('reviewer');
  });

  it('does not allow changes-required work to be acknowledged or closed', async () => {
    const created = await freshHandoff();
    await markHandoffDelivered(created.id, ATLAS, created.fingerprint);
    await reviewHandoff(created.id, ECHO, created.fingerprint, 'CHANGES REQUIRED', 'Use “and,” not “or.”');
    await expect(acknowledgeHandoff(created.id, ATLAS, created.fingerprint)).rejects.toThrow('changes_required');
    await expect(closeHandoff(created.id, ATLAS, created.fingerprint, 'Not actually complete')).rejects.toThrow(
      'changes_required',
    );
  });
});
