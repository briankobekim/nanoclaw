import { createHash, randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';

export type HandoffStatus =
  | 'created'
  | 'delivered'
  | 'approved'
  | 'changes_required'
  | 'review_blocked'
  | 'acknowledged'
  | 'closed';

export type ReviewOutcome = 'APPROVED' | 'APPROVED WITH MINOR NOTES' | 'CHANGES REQUIRED' | 'REVIEW BLOCKED';

export interface HandoffRow {
  id: string;
  source_agent_group_id: string;
  reviewer_agent_group_id: string;
  source_session_id: string | null;
  project: string;
  goal: string;
  outcome: string;
  scope: string;
  authority: string;
  fingerprint: string;
  status: HandoffStatus;
  review_outcome: ReviewOutcome | null;
  review_notes: string | null;
  reservation_kind: 'delivery' | 'review' | null;
  reservation_generation: number;
  reservation_expires_at: string | null;
  closure_evidence: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface HandoffEventRow {
  id: string;
  handoff_id: string;
  sequence: number;
  event_type: string;
  actor_agent_group_id: string;
  payload_json: string;
  created_at: string;
}

export interface CreateHandoffInput {
  id?: string;
  sourceAgentGroupId: string;
  reviewerAgentGroupId: string;
  sourceSessionId?: string | null;
  project: string;
  goal: string;
  outcome: string;
  scope: string;
  authority: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

function required(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function handoffId(value?: string): string {
  const id = value?.trim() || `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (!ID_PATTERN.test(id)) {
    throw new Error('handoff id must be 3-128 characters using letters, numbers, dot, underscore, colon, or dash');
  }
  return id;
}

function canonical(input: {
  id: string;
  sourceAgentGroupId: string;
  reviewerAgentGroupId: string;
  project: string;
  goal: string;
  outcome: string;
  scope: string;
  authority: string;
}): string {
  return JSON.stringify({
    id: input.id,
    source_agent_group_id: input.sourceAgentGroupId,
    reviewer_agent_group_id: input.reviewerAgentGroupId,
    project: input.project,
    goal: input.goal,
    outcome: input.outcome,
    scope: input.scope,
    authority: input.authority,
  });
}

export function fingerprintHandoff(input: Parameters<typeof canonical>[0]): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

async function appendEvent(
  handoffId: string,
  eventType: string,
  actorAgentGroupId: string,
  payload: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  const next =
    (
      await getDb().get<{ sequence: number }>(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM handoff_events WHERE handoff_id = ?',
        handoffId,
      )
    )?.sequence ?? 1;
  await getDb().run(
    `INSERT INTO handoff_events
       (id, handoff_id, sequence, event_type, actor_agent_group_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    handoffId,
    next,
    eventType,
    actorAgentGroupId,
    JSON.stringify(payload),
    createdAt,
  );
}

export async function getHandoff(id: string): Promise<HandoffRow | undefined> {
  return getDb().get<HandoffRow>('SELECT * FROM handoffs WHERE id = ?', id);
}

async function mustGetHandoff(id: string): Promise<HandoffRow> {
  const row = await getHandoff(id);
  if (!row) throw new Error(`handoff not found: ${id}`);
  return row;
}

function expectFingerprint(row: HandoffRow, fingerprint: string): void {
  if (row.fingerprint !== fingerprint) {
    throw new Error(`handoff fingerprint mismatch for ${row.id}`);
  }
}

function expectActor(actual: string, expected: string, role: string): void {
  if (actual !== expected) throw new Error(`only the handoff ${role} may perform this transition`);
}

function expectStatus(row: HandoffRow, expected: HandoffStatus): void {
  if (row.status !== expected) {
    throw new Error(`handoff ${row.id} is ${row.status}; expected ${expected}`);
  }
}

function expectNoReservation(row: HandoffRow): void {
  if (row.reservation_kind !== null) {
    throw new Error(`handoff ${row.id} has an active ${row.reservation_kind} reservation`);
  }
}

function expectReservation(row: HandoffRow, kind: 'delivery' | 'review', generation: number): void {
  if (row.reservation_kind !== kind || row.reservation_generation !== generation) {
    throw new Error(`handoff ${row.id} ${kind} reservation was replaced or released`);
  }
}

export async function createHandoff(input: CreateHandoffInput): Promise<HandoffRow> {
  const id = handoffId(input.id);
  const project = required('project', input.project);
  const goal = required('goal', input.goal);
  const outcome = required('outcome', input.outcome);
  const scope = required('scope', input.scope);
  const authority = required('authority', input.authority);
  if (input.sourceAgentGroupId === input.reviewerAgentGroupId) {
    throw new Error('source and reviewer must be different agents');
  }
  const fingerprint = fingerprintHandoff({
    id,
    sourceAgentGroupId: input.sourceAgentGroupId,
    reviewerAgentGroupId: input.reviewerAgentGroupId,
    project,
    goal,
    outcome,
    scope,
    authority,
  });
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    await getDb().run(
      `INSERT INTO handoffs
         (id, source_agent_group_id, reviewer_agent_group_id, source_session_id,
          project, goal, outcome, scope, authority, fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
      id,
      input.sourceAgentGroupId,
      input.reviewerAgentGroupId,
      input.sourceSessionId ?? null,
      project,
      goal,
      outcome,
      scope,
      authority,
      fingerprint,
      now,
      now,
    );
    await appendEvent(id, 'created', input.sourceAgentGroupId, { fingerprint, project, goal }, now);
  });
  return (await getHandoff(id))!;
}

export async function markHandoffDelivered(id: string, actor: string, fingerprint: string): Promise<HandoffRow> {
  return transition(id, actor, fingerprint, 'created', 'delivered', 'delivered', {});
}

export const HANDOFF_DELIVERY_LEASE_MS = 5 * 60_000;
export const HANDOFF_REVIEW_DELIVERY_LEASE_MS = 5 * 60_000;

/**
 * Durably reserve one Slack delivery before it reaches a reviewer. A stale
 * reservation can be reclaimed after a host crash; an ordinary concurrent
 * retry is rejected by the conditional update.
 */
export async function reserveHandoffDelivery(
  id: string,
  actor: string,
  fingerprint: string,
  now = new Date(),
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectActor(actor, row.source_agent_group_id, 'source');
  expectFingerprint(row, fingerprint);
  expectStatus(row, 'created');
  const at = now.toISOString();
  const activeReservation = row.reservation_kind !== null && (row.reservation_expires_at ?? '') > at;
  if (activeReservation) {
    throw new Error(`handoff ${id} delivery is already reserved`);
  }
  const expiresAt = new Date(now.getTime() + HANDOFF_DELIVERY_LEASE_MS).toISOString();
  const generation = row.reservation_generation + 1;
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET reservation_kind = 'delivery', reservation_generation = ?,
           reservation_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'created' AND reservation_generation = ?
         AND (reservation_kind IS NULL OR reservation_expires_at <= ?)`,
      generation,
      expiresAt,
      at,
      id,
      row.reservation_generation,
      at,
    );
    if (result.changes !== 1) throw new Error(`handoff ${id} delivery is already reserved`);
    await appendEvent(
      id,
      'delivery_reserved',
      actor,
      { fingerprint, generation, recovered: row.reservation_kind !== null },
      at,
    );
  });
  return (await getHandoff(id))!;
}

export async function completeHandoffDelivery(
  id: string,
  actor: string,
  fingerprint: string,
  generation: number,
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectActor(actor, row.source_agent_group_id, 'source');
  expectFingerprint(row, fingerprint);
  expectStatus(row, 'created');
  expectReservation(row, 'delivery', generation);
  const at = new Date().toISOString();
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET status = 'delivered', reservation_kind = NULL,
           reservation_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'created' AND reservation_kind = 'delivery'
         AND reservation_generation = ?`,
      at,
      id,
      generation,
    );
    if (result.changes !== 1) throw new Error(`handoff ${id} delivery reservation was replaced or released`);
    await appendEvent(id, 'delivered', actor, { fingerprint, generation }, at);
  });
  return (await getHandoff(id))!;
}

export async function releaseHandoffDelivery(
  id: string,
  actor: string,
  fingerprint: string,
  generation: number,
  reason: string,
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectActor(actor, row.source_agent_group_id, 'source');
  expectFingerprint(row, fingerprint);
  expectStatus(row, 'created');
  expectReservation(row, 'delivery', generation);
  const at = new Date().toISOString();
  const releaseReason = required('delivery release reason', reason);
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET reservation_kind = NULL, reservation_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'created' AND reservation_kind = 'delivery'
         AND reservation_generation = ?`,
      at,
      id,
      generation,
    );
    if (result.changes !== 1) throw new Error(`handoff ${id} delivery reservation was replaced or released`);
    await appendEvent(id, 'delivery_released', actor, { fingerprint, generation, reason: releaseReason }, at);
  });
  return (await getHandoff(id))!;
}

function reviewStatus(outcome: ReviewOutcome): HandoffStatus {
  if (outcome === 'APPROVED' || outcome === 'APPROVED WITH MINOR NOTES') return 'approved';
  if (outcome === 'CHANGES REQUIRED') return 'changes_required';
  return 'review_blocked';
}

/**
 * Reserve a formal review result before routing it back to the source. The
 * outcome is held on the handoff, but does not become authoritative until the
 * source's durable routing receipt completes the reservation.
 */
export async function reserveHandoffReview(
  id: string,
  actor: string,
  fingerprint: string,
  reviewOutcome: ReviewOutcome,
  notes = '',
  now = new Date(),
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectActor(actor, row.reviewer_agent_group_id, 'reviewer');
  expectFingerprint(row, fingerprint);
  expectStatus(row, 'delivered');
  const at = now.toISOString();
  const activeReservation = row.reservation_kind !== null && (row.reservation_expires_at ?? '') > at;
  if (activeReservation) {
    throw new Error(`handoff ${id} review is already reserved`);
  }
  const expiresAt = new Date(now.getTime() + HANDOFF_REVIEW_DELIVERY_LEASE_MS).toISOString();
  const generation = row.reservation_generation + 1;
  const reviewNotes = notes.trim();
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET review_outcome = ?, review_notes = ?, reservation_kind = 'review',
           reservation_generation = ?, reservation_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'delivered' AND reservation_generation = ?
         AND (reservation_kind IS NULL OR reservation_expires_at <= ?)`,
      reviewOutcome,
      reviewNotes || null,
      generation,
      expiresAt,
      at,
      id,
      row.reservation_generation,
      at,
    );
    if (result.changes !== 1) throw new Error(`handoff ${id} review is already reserved`);
    await appendEvent(
      id,
      'review_delivery_reserved',
      actor,
      {
        fingerprint,
        generation,
        review_outcome: reviewOutcome,
        notes: reviewNotes,
        recovered: row.reservation_kind !== null,
      },
      at,
    );
  });
  return (await getHandoff(id))!;
}

export async function completeHandoffReview(
  id: string,
  actor: string,
  fingerprint: string,
  generation: number,
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectActor(actor, row.reviewer_agent_group_id, 'reviewer');
  expectFingerprint(row, fingerprint);
  expectStatus(row, 'delivered');
  expectReservation(row, 'review', generation);
  if (!row.review_outcome) throw new Error(`handoff ${id} review reservation has no outcome`);
  const status = reviewStatus(row.review_outcome);
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET status = ?, reservation_kind = NULL, reservation_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'delivered' AND reservation_kind = 'review'
         AND reservation_generation = ?`,
      status,
      now,
      id,
      generation,
    );
    if (result.changes !== 1) throw new Error(`handoff ${id} changed concurrently; reload before reviewing`);
    await appendEvent(
      id,
      status,
      actor,
      { fingerprint, generation, review_outcome: row.review_outcome, notes: row.review_notes ?? '' },
      now,
    );
  });
  return (await getHandoff(id))!;
}

export async function releaseHandoffReview(
  id: string,
  actor: string,
  fingerprint: string,
  generation: number,
  reason: string,
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectActor(actor, row.reviewer_agent_group_id, 'reviewer');
  expectFingerprint(row, fingerprint);
  expectStatus(row, 'delivered');
  expectReservation(row, 'review', generation);
  const at = new Date().toISOString();
  const releaseReason = required('review release reason', reason);
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET review_outcome = NULL, review_notes = NULL, reservation_kind = NULL,
           reservation_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'delivered' AND reservation_kind = 'review'
         AND reservation_generation = ?`,
      at,
      id,
      generation,
    );
    if (result.changes !== 1) throw new Error(`handoff ${id} changed concurrently; reload before reviewing`);
    await appendEvent(id, 'review_delivery_released', actor, { fingerprint, generation, reason: releaseReason }, at);
  });
  return (await getHandoff(id))!;
}

export async function reviewHandoff(
  id: string,
  actor: string,
  fingerprint: string,
  reviewOutcome: ReviewOutcome,
  notes = '',
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectActor(actor, row.reviewer_agent_group_id, 'reviewer');
  expectFingerprint(row, fingerprint);
  expectStatus(row, 'delivered');
  expectNoReservation(row);
  const status = reviewStatus(reviewOutcome);
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET status = ?, review_outcome = ?, review_notes = ?, updated_at = ?
       WHERE id = ? AND status = 'delivered' AND reservation_kind IS NULL`,
      status,
      reviewOutcome,
      notes.trim() || null,
      now,
      id,
    );
    if (result.changes !== 1) throw new Error(`handoff ${id} changed concurrently; reload before reviewing`);
    await appendEvent(id, status, actor, { fingerprint, review_outcome: reviewOutcome, notes: notes.trim() }, now);
  });
  return (await getHandoff(id))!;
}

export async function acknowledgeHandoff(id: string, actor: string, fingerprint: string): Promise<HandoffRow> {
  return transition(id, actor, fingerprint, 'approved', 'acknowledged', 'acknowledged', {});
}

export async function closeHandoff(
  id: string,
  actor: string,
  fingerprint: string,
  evidence: string,
): Promise<HandoffRow> {
  const closureEvidence = required('closure evidence', evidence);
  return transition(
    id,
    actor,
    fingerprint,
    'acknowledged',
    'closed',
    'closed',
    { evidence: closureEvidence },
    {
      closureEvidence,
    },
  );
}

async function transition(
  id: string,
  actor: string,
  fingerprint: string,
  from: HandoffStatus,
  to: HandoffStatus,
  eventType: string,
  payload: Record<string, unknown>,
  options: { closureEvidence?: string } = {},
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectActor(actor, row.source_agent_group_id, 'source');
  expectFingerprint(row, fingerprint);
  expectStatus(row, from);
  expectNoReservation(row);
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET status = ?, closure_evidence = COALESCE(?, closure_evidence),
           closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END,
           updated_at = ?
       WHERE id = ? AND status = ? AND reservation_kind IS NULL`,
      to,
      options.closureEvidence ?? null,
      to,
      now,
      now,
      id,
      from,
    );
    if (result.changes !== 1) throw new Error(`handoff ${id} changed concurrently; reload before continuing`);
    await appendEvent(id, eventType, actor, { fingerprint, ...payload }, now);
  });
  return (await getHandoff(id))!;
}

export async function listHandoffsForAgent(agentGroupId: string, status?: HandoffStatus): Promise<HandoffRow[]> {
  if (status) {
    return getDb().all<HandoffRow>(
      `SELECT * FROM handoffs
       WHERE (source_agent_group_id = ? OR reviewer_agent_group_id = ?) AND status = ?
       ORDER BY updated_at DESC, id`,
      agentGroupId,
      agentGroupId,
      status,
    );
  }
  return getDb().all<HandoffRow>(
    `SELECT * FROM handoffs
     WHERE source_agent_group_id = ? OR reviewer_agent_group_id = ?
     ORDER BY updated_at DESC, id`,
    agentGroupId,
    agentGroupId,
  );
}

export async function listAllHandoffs(status?: HandoffStatus): Promise<HandoffRow[]> {
  return status
    ? getDb().all<HandoffRow>('SELECT * FROM handoffs WHERE status = ? ORDER BY updated_at DESC, id', status)
    : getDb().all<HandoffRow>('SELECT * FROM handoffs ORDER BY updated_at DESC, id');
}

export async function listHandoffEvents(id: string): Promise<HandoffEventRow[]> {
  await mustGetHandoff(id);
  return getDb().all<HandoffEventRow>('SELECT * FROM handoff_events WHERE handoff_id = ? ORDER BY sequence', id);
}
