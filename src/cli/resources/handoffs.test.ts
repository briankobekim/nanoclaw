import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { dispatch } from '../dispatch.js';
import './handoffs.js';

const ATLAS = 'ag-atlas-cli';
const ECHO = 'ag-echo-cli';

function caller(agentGroupId: string, sessionId: string) {
  return { caller: 'agent' as const, agentGroupId, sessionId, messagingGroupId: 'mg-test' };
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: ATLAS, name: 'Atlas CLI', folder: 'atlas-cli', agent_provider: null, created_at });
  await createAgentGroup({ id: ECHO, name: 'Echo CLI', folder: 'echo-cli', agent_provider: null, created_at });
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
          reviewer: ECHO,
          project: 'none',
          goal: 'Review one policy',
          outcome: 'One formal outcome',
          scope: 'Policy text only',
          authority: 'recommend',
        },
      },
      caller(ATLAS, 'sess-atlas-dm'),
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
      caller(ATLAS, 'sess-atlas-dm'),
    );
    expect(delivered.ok && (delivered.data as { status: string }).status).toBe('delivered');

    const reviewed = await dispatch(
      {
        id: 'req-review',
        command: 'handoffs-review',
        args: { id: 'CLI-HANDOFF-1', fingerprint, outcome: 'APPROVED' },
      },
      caller(ECHO, 'sess-echo-room'),
    );
    expect(reviewed.ok && (reviewed.data as { status: string }).status).toBe('approved');

    const acknowledged = await dispatch(
      {
        id: 'req-ack',
        command: 'handoffs-acknowledge',
        args: { id: 'CLI-HANDOFF-1', fingerprint },
      },
      caller(ATLAS, 'sess-atlas-room'),
    );
    expect(acknowledged.ok && (acknowledged.data as { status: string }).status).toBe('acknowledged');

    const closed = await dispatch(
      {
        id: 'req-close',
        command: 'handoffs-close',
        args: { id: 'CLI-HANDOFF-1', fingerprint, evidence: 'Exact ledger item approved.' },
      },
      caller(ATLAS, 'sess-atlas-room'),
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
          reviewer: ECHO,
          project: 'none',
          goal: 'Private review',
          outcome: 'One formal outcome',
          scope: 'Policy text only',
          authority: 'recommend',
        },
      },
      caller(ATLAS, 'sess-atlas'),
    );

    const response = await dispatch(
      { id: 'req-get-private', command: 'handoffs-get', args: { id: 'CLI-HANDOFF-PRIVATE' } },
      caller('ag-outsider', 'sess-outsider'),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.message).toBe('handoff not found: CLI-HANDOFF-PRIVATE');
  });
});

describe('ncl handoffs abandon', () => {
  it('is operator-only: an agent caller is denied, the host caller closes the row with the reason', async () => {
    const create = await dispatch(
      {
        id: 'req-abandon-create',
        command: 'handoffs-create',
        args: {
          id: 'CLI-ABANDON-1',
          reviewer: ECHO,
          project: 'none',
          goal: 'g',
          outcome: 'o',
          scope: 's',
          authority: 'recommend',
        },
      },
      caller(ATLAS, 'sess-atlas-dm'),
    );
    expect(create.ok).toBe(true);

    const agentAttempt = await dispatch(
      { id: 'req-abandon-agent', command: 'handoffs-abandon', args: { id: 'CLI-ABANDON-1', reason: 'agent tries' } },
      caller(ATLAS, 'sess-atlas-dm'),
    );
    expect(agentAttempt.ok).toBe(false);
    expect(JSON.stringify(agentAttempt)).toMatch(/operator-only/);

    const host = await dispatch(
      { id: 'req-abandon-host', command: 'handoffs-abandon', args: { id: 'CLI-ABANDON-1', reason: 'smoke test' } },
      { caller: 'host' },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    expect((host.data as { status: string }).status).toBe('closed');
    expect((host.data as { closure_evidence: string }).closure_evidence).toBe('abandoned by operator: smoke test');
  });
});

describe('handoff revisions via ncl', () => {
  it('ncl handoffs create forwards --supersedes to the ledger', async () => {
    const create = await dispatch(
      {
        id: 'req-rev-create',
        command: 'handoffs-create',
        args: {
          id: 'CLI-REV-1',
          reviewer: ECHO,
          project: 'none',
          goal: 'Round one',
          outcome: 'One formal outcome',
          scope: 'Policy text only',
          authority: 'recommend',
        },
      },
      caller(ATLAS, 'sess-atlas-dm'),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const fingerprint = (create.data as { fingerprint: string }).fingerprint;
    await dispatch(
      { id: 'req-rev-deliver', command: 'handoffs-deliver', args: { id: 'CLI-REV-1', fingerprint } },
      caller(ATLAS, 'sess-atlas-dm'),
    );
    const reviewed = await dispatch(
      {
        id: 'req-rev-review',
        command: 'handoffs-review',
        args: { id: 'CLI-REV-1', fingerprint, outcome: 'CHANGES REQUIRED', notes: 'Tighten the scope.' },
      },
      caller(ECHO, 'sess-echo-dm'),
    );
    expect(reviewed.ok && (reviewed.data as { status: string }).status).toBe('changes_required');

    const revision = await dispatch(
      {
        id: 'req-rev-create-2',
        command: 'handoffs-create',
        args: {
          id: 'CLI-REV-2',
          reviewer: ECHO,
          project: 'none',
          goal: 'Round two',
          outcome: 'One formal outcome',
          scope: 'Policy text only, tightened',
          authority: 'recommend',
          supersedes: 'CLI-REV-1',
        },
      },
      caller(ATLAS, 'sess-atlas-dm'),
    );
    expect(revision.ok).toBe(true);
    if (!revision.ok) return;
    expect((revision.data as { supersedes: string | null }).supersedes).toBe('CLI-REV-1');

    const got = await dispatch(
      { id: 'req-rev-get', command: 'handoffs-get', args: { id: 'CLI-REV-2' } },
      caller(ECHO, 'sess-echo-dm'),
    );
    expect(got.ok && (got.data as { supersedes: string | null }).supersedes).toBe('CLI-REV-1');

    const priorEvents = await dispatch(
      { id: 'req-rev-events', command: 'handoffs-events', args: { id: 'CLI-REV-1' } },
      caller(ATLAS, 'sess-atlas-dm'),
    );
    expect(priorEvents.ok && (priorEvents.data as { event_type: string }[]).map((e) => e.event_type)).toEqual([
      'created',
      'delivered',
      'changes_required',
      'superseded',
    ]);
  });
});
