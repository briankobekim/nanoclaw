import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  acknowledgeHandoff,
  closeHandoff,
  createHandoff,
  fingerprintOfRow,
  getHandoff,
  recordOwnerPing,
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

// ---------------------------------------------------------------------------
// Revision loop (docs/specs/handoff-revision-loop/plan.md §5, cases A1–A9)
// ---------------------------------------------------------------------------

async function revisable(id: string, outcome: 'CHANGES REQUIRED' | 'REVIEW BLOCKED' = 'CHANGES REQUIRED') {
  const created = await createHandoff({
    id,
    sourceAgentGroupId: ATLAS,
    reviewerAgentGroupId: ECHO,
    project: 'quiveriq',
    goal: 'Round one goal',
    outcome: 'Round one outcome',
    scope: 'Round one scope',
    authority: 'recommend',
  });
  await markHandoffDelivered(created.id, ATLAS, created.fingerprint);
  return reviewHandoff(created.id, ECHO, created.fingerprint, outcome, 'Fix the thing.');
}

function revisionInput(prior: { id: string }, id = `${prior.id}-r2`) {
  return {
    id,
    sourceAgentGroupId: ATLAS,
    reviewerAgentGroupId: ECHO,
    project: 'quiveriq',
    goal: 'Round two goal',
    outcome: 'Round two outcome',
    scope: 'Round two scope',
    authority: 'recommend',
    supersedes: prior.id,
  };
}

describe('handoff revisions', () => {
  it('createHandoff with supersedes links a new round to a changes_required handoff', async () => {
    const prior = await revisable('REV-A1');
    const revision = await createHandoff(revisionInput(prior));

    expect(revision.supersedes).toBe(prior.id);
    expect(revision.status).toBe('created');
    const priorAfter = (await getHandoff(prior.id))!;
    expect(priorAfter.status).toBe('changes_required');
    expect(priorAfter.updated_at).toBe(prior.updated_at);
    const priorEvents = await listHandoffEvents(prior.id);
    const last = priorEvents[priorEvents.length - 1]!;
    expect(last.event_type).toBe('superseded');
    expect(JSON.parse(last.payload_json)).toMatchObject({ successor: revision.id, fingerprint: prior.fingerprint });
    const createdEvent = (await listHandoffEvents(revision.id))[0]!;
    expect(createdEvent.event_type).toBe('created');
    expect(JSON.parse(createdEvent.payload_json)).toMatchObject({ supersedes: prior.id });
  });

  it('createHandoff with supersedes accepts a review_blocked prior', async () => {
    const prior = await revisable('REV-A2', 'REVIEW BLOCKED');
    const revision = await createHandoff(revisionInput(prior));
    expect(revision.supersedes).toBe(prior.id);
    expect((await getHandoff(prior.id))!.status).toBe('review_blocked');
    expect((await listHandoffEvents(prior.id)).map((e) => e.event_type)).toEqual([
      'created',
      'delivered',
      'review_blocked',
      'superseded',
    ]);
  });

  it('createHandoff with supersedes rejects a prior that is not changes_required or review_blocked', async () => {
    const base = {
      sourceAgentGroupId: ATLAS,
      reviewerAgentGroupId: ECHO,
      project: 'quiveriq',
      goal: 'g',
      outcome: 'o',
      scope: 's',
      authority: 'recommend',
    };
    const created = await createHandoff({ ...base, id: 'REV-A3-created' });
    const delivered = await createHandoff({ ...base, id: 'REV-A3-delivered' });
    await markHandoffDelivered(delivered.id, ATLAS, delivered.fingerprint);
    const approved = await createHandoff({ ...base, id: 'REV-A3-approved' });
    await markHandoffDelivered(approved.id, ATLAS, approved.fingerprint);
    await reviewHandoff(approved.id, ECHO, approved.fingerprint, 'APPROVED');
    const acknowledged = await createHandoff({ ...base, id: 'REV-A3-acknowledged' });
    await markHandoffDelivered(acknowledged.id, ATLAS, acknowledged.fingerprint);
    await reviewHandoff(acknowledged.id, ECHO, acknowledged.fingerprint, 'APPROVED');
    await acknowledgeHandoff(acknowledged.id, ATLAS, acknowledged.fingerprint);
    const closed = await createHandoff({ ...base, id: 'REV-A3-closed' });
    await markHandoffDelivered(closed.id, ATLAS, closed.fingerprint);
    await reviewHandoff(closed.id, ECHO, closed.fingerprint, 'APPROVED');
    await acknowledgeHandoff(closed.id, ATLAS, closed.fingerprint);
    await closeHandoff(closed.id, ATLAS, closed.fingerprint, 'done');

    for (const prior of [created, delivered, approved, acknowledged, closed]) {
      await expect(createHandoff(revisionInput(prior))).rejects.toThrow(
        /only a changes_required or review_blocked handoff can be revised/,
      );
      expect(await getHandoff(`${prior.id}-r2`)).toBeUndefined();
    }
  });

  it('createHandoff with supersedes rejects a mismatched source, reviewer, or project', async () => {
    const prior = await revisable('REV-A4');
    await createAgentGroup({
      id: 'ag-other',
      name: 'Other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const cases = [
      { ...revisionInput(prior, 'REV-A4-src'), sourceAgentGroupId: 'ag-other' },
      { ...revisionInput(prior, 'REV-A4-rev'), reviewerAgentGroupId: 'ag-other' },
      { ...revisionInput(prior, 'REV-A4-proj'), project: 'illysium' },
    ];
    for (const input of cases) {
      await expect(createHandoff(input)).rejects.toThrow(/revision must match the source, reviewer, and project/);
      expect(await getHandoff(input.id)).toBeUndefined();
    }
    expect((await listHandoffEvents(prior.id)).some((e) => e.event_type === 'superseded')).toBe(false);
  });

  it('createHandoff with supersedes rejects an unknown or self-referencing prior', async () => {
    await expect(createHandoff(revisionInput({ id: 'REV-A5-missing' }, 'REV-A5-new'))).rejects.toThrow(/not found/);
    expect(await getHandoff('REV-A5-new')).toBeUndefined();
    await expect(createHandoff(revisionInput({ id: 'REV-A5-self' }, 'REV-A5-self'))).rejects.toThrow();
    expect(await getHandoff('REV-A5-self')).toBeUndefined();
  });

  it('a handoff can be superseded only once', async () => {
    const prior = await revisable('REV-A6');
    await createHandoff(revisionInput(prior, 'REV-A6-r2'));
    await expect(createHandoff(revisionInput(prior, 'REV-A6-r3'))).rejects.toThrow(/already superseded by REV-A6-r2/);
    const successors = await getDb().all<{ id: string }>('SELECT id FROM handoffs WHERE supersedes = ?', prior.id);
    expect(successors.map((r) => r.id)).toEqual(['REV-A6-r2']);
    // Database backstop: the partial unique index refuses a second successor even
    // if the code path is bypassed.
    await expect(
      getDb().run(
        `INSERT INTO handoffs (id, source_agent_group_id, reviewer_agent_group_id, project, goal, outcome, scope,
           authority, fingerprint, status, created_at, updated_at, supersedes)
         VALUES ('REV-A6-sql', ?, ?, 'quiveriq', 'g', 'o', 's', 'recommend', 'x', 'created', 't', 't', ?)`,
        ATLAS,
        ECHO,
        prior.id,
      ),
    ).rejects.toThrow();
  });

  it('the fingerprint of a revision covers the supersedes link', async () => {
    const prior = await revisable('REV-A7');
    const revision = await createHandoff(revisionInput(prior));
    expect(fingerprintOfRow(revision)).toBe(revision.fingerprint);

    await getDb().run('UPDATE handoffs SET supersedes = NULL WHERE id = ?', revision.id);
    expect(fingerprintOfRow((await getHandoff(revision.id))!)).not.toBe(revision.fingerprint);
    const other = await revisable('REV-A7-other');
    await getDb().run('UPDATE handoffs SET supersedes = ? WHERE id = ?', other.id, revision.id);
    expect(fingerprintOfRow((await getHandoff(revision.id))!)).not.toBe(revision.fingerprint);

    // A first-round row must hash exactly as before this change: the pre-change
    // canonical form, reproduced independently here, byte for byte.
    const first = await freshHandoff();
    const legacy = createHash('sha256')
      .update(
        JSON.stringify({
          id: first.id,
          source_agent_group_id: ATLAS,
          reviewer_agent_group_id: ECHO,
          project: 'none',
          goal: 'Verify the closure policy',
          outcome: 'One formal review outcome',
          scope: 'Policy text only',
          authority: 'recommend',
        }),
      )
      .digest('hex');
    expect(first.fingerprint).toBe(legacy);
    expect(fingerprintOfRow(first)).toBe(legacy);
  });

  it('recordOwnerPing appends an owner_pinged event without changing the handoff', async () => {
    const created = await freshHandoff();
    await recordOwnerPing(created.id, {
      status: created.status,
      updated_at: created.updated_at,
      pinged_at: '2026-09-15T23:00:00.000Z',
      recipient: 'slack:D0OWNER',
      platform_message_id: '1789.001',
    });
    const events = await listHandoffEvents(created.id);
    expect(events.map((e) => e.event_type)).toEqual(['created', 'owner_pinged']);
    expect(events[1]!.actor_agent_group_id).toBe('host:ping');
    expect(JSON.parse(events[1]!.payload_json)).toEqual({
      status: 'created',
      updated_at: created.updated_at,
      pinged_at: '2026-09-15T23:00:00.000Z',
      recipient: 'slack:D0OWNER',
      platform_message_id: '1789.001',
    });
    const after = (await getHandoff(created.id))!;
    expect(after.status).toBe('created');
    expect(after.updated_at).toBe(created.updated_at);
  });

  it('createHandoff with supersedes rejects a prior whose stored fingerprint does not match its fields', async () => {
    const prior = await revisable('REV-A9');
    await getDb().run("UPDATE handoffs SET goal = 'tampered' WHERE id = ?", prior.id);
    await expect(createHandoff(revisionInput(prior))).rejects.toThrow(
      /ledger fingerprint does not match its own fields/,
    );
    expect(await getHandoff(`${prior.id}-r2`)).toBeUndefined();
    expect((await listHandoffEvents(prior.id)).some((e) => e.event_type === 'superseded')).toBe(false);
  });
});
