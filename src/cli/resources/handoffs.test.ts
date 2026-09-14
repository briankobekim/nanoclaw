import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { dispatch } from '../dispatch.js';
import './handoffs.js';

const SOURCE = 'ag-source-cli';
const REVIEWER = 'ag-reviewer-cli';

function caller(agentGroupId: string, sessionId: string) {
  return { caller: 'agent' as const, agentGroupId, sessionId, messagingGroupId: 'mg-test' };
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: SOURCE, name: 'Source CLI', folder: 'source-cli', agent_provider: null, created_at });
  await createAgentGroup({
    id: REVIEWER,
    name: 'Reviewer CLI',
    folder: 'reviewer-cli',
    agent_provider: null,
    created_at,
  });
});

afterEach(async () => {
  await closeDb();
});

describe('handoffs CLI', () => {
  it('lets the source and reviewer complete a verified lifecycle across separate sessions', async () => {
    const create = await dispatch(
      {
        id: 'req-create',
        command: 'handoffs-create',
        args: {
          id: 'CLI-HANDOFF-1',
          reviewer: REVIEWER,
          project: 'none',
          goal: 'Review one policy',
          outcome: 'One formal outcome',
          scope: 'Policy text only',
          authority: 'recommend',
        },
      },
      caller(SOURCE, 'sess-source-dm'),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const fingerprint = (create.data as { fingerprint: string }).fingerprint;

    const delivered = await dispatch(
      {
        id: 'req-deliver',
        command: 'handoffs-deliver',
        args: { id: 'CLI-HANDOFF-1', fingerprint },
      },
      caller(SOURCE, 'sess-source-dm'),
    );
    expect(delivered.ok && (delivered.data as { status: string }).status).toBe('delivered');

    const reviewed = await dispatch(
      {
        id: 'req-review',
        command: 'handoffs-review',
        args: { id: 'CLI-HANDOFF-1', fingerprint, outcome: 'APPROVED' },
      },
      caller(REVIEWER, 'sess-reviewer-room'),
    );
    expect(reviewed.ok && (reviewed.data as { status: string }).status).toBe('approved');

    const acknowledged = await dispatch(
      {
        id: 'req-ack',
        command: 'handoffs-acknowledge',
        args: { id: 'CLI-HANDOFF-1', fingerprint },
      },
      caller(SOURCE, 'sess-source-room'),
    );
    expect(acknowledged.ok && (acknowledged.data as { status: string }).status).toBe('acknowledged');

    const closed = await dispatch(
      {
        id: 'req-close',
        command: 'handoffs-close',
        args: { id: 'CLI-HANDOFF-1', fingerprint, evidence: 'Exact ledger item approved.' },
      },
      caller(SOURCE, 'sess-source-room'),
    );
    expect(closed.ok && (closed.data as { status: string }).status).toBe('closed');
  });

  it('does not reveal a handoff to an unrelated agent', async () => {
    const created_at = new Date().toISOString();
    await createAgentGroup({
      id: 'ag-outsider',
      name: 'Outsider',
      folder: 'outsider',
      agent_provider: null,
      created_at,
    });
    await dispatch(
      {
        id: 'req-create-private',
        command: 'handoffs-create',
        args: {
          id: 'CLI-HANDOFF-PRIVATE',
          reviewer: REVIEWER,
          project: 'none',
          goal: 'Private review',
          outcome: 'One formal outcome',
          scope: 'Policy text only',
          authority: 'recommend',
        },
      },
      caller(SOURCE, 'sess-source'),
    );

    const response = await dispatch(
      { id: 'req-get-private', command: 'handoffs-get', args: { id: 'CLI-HANDOFF-PRIVATE' } },
      caller('ag-outsider', 'sess-outsider'),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.message).toBe('handoff not found: CLI-HANDOFF-PRIVATE');
  });
});
