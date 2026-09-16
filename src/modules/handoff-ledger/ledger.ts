import { createHash, randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';
import {
  canonicalVerificationInputs,
  validateVerificationInputs,
  type VerificationInputs,
} from '../verifier/checks-schema.js';

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
  closure_evidence: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Prior handoff this row revises (round two and later); null on a first round. */
  supersedes: string | null;
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
  /**
   * Prior handoff id when this is a revision. The prior must belong to the same
   * source, reviewer and project, be `changes_required` or `review_blocked`, and
   * not already have a successor.
   */
  supersedes?: string | null;
}

/** Event appended to the prior handoff when a revision is created. */
export const SUPERSEDED_EVENT = 'superseded';
/** Event appended by the host stall sweep after it told an owner about a stalled handoff. */
export const OWNER_PINGED_EVENT = 'owner_pinged';
/** Non-agent actor recorded on owner-ping events, alongside the verifier's `host:verifier`. */
export const HOST_PING_ACTOR = 'host:ping';

const REVISABLE_STATUSES: ReadonlySet<HandoffStatus> = new Set(['changes_required', 'review_blocked']);

/**
 * A handoff id is used as a path segment by the verifier's evidence directory,
 * so the ledger refuses at creation anything the verifier would refuse at use:
 * it must start with an alphanumeric and may then use only `[A-Za-z0-9._-]`, to
 * 64 characters. Same rule in the tool, the host and here.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function required(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function handoffId(value?: string): string {
  const id = value?.trim() || `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`;
  // `.` and `..` cannot match the pattern, but they are the two names that
  // would do real damage as a path segment, so they are also refused by name.
  if (id === '.' || id === '..' || !ID_PATTERN.test(id)) {
    throw new Error(
      'handoff id must start with a letter or digit and use at most 64 characters of letters, digits, dot, underscore, or dash',
    );
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
  supersedes?: string | null;
}): string {
  const fields: Record<string, string> = {
    id: input.id,
    source_agent_group_id: input.sourceAgentGroupId,
    reviewer_agent_group_id: input.reviewerAgentGroupId,
    project: input.project,
    goal: input.goal,
    outcome: input.outcome,
    scope: input.scope,
    authority: input.authority,
  };
  // The revision link is part of the contract, so it is hashed — but only when
  // present. A first-round row keeps the byte-identical pre-v2 canonical form,
  // so every fingerprint stored before the link existed stays valid.
  if (input.supersedes) fields.supersedes = input.supersedes;
  return JSON.stringify(fields);
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

/**
 * A row whose stored fingerprint no longer matches its own fields has been
 * edited outside the ledger (a contract field or the `supersedes` link). No
 * transition may build on it.
 */
function expectSelfIntegrity(row: HandoffRow): void {
  if (fingerprintOfRow(row) !== row.fingerprint) {
    throw new Error(`handoff ${row.id} ledger fingerprint does not match its own fields`);
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
  const supersedes = input.supersedes?.trim() || null;
  if (supersedes) {
    if (supersedes === id) throw new Error('a handoff cannot supersede itself');
    if (supersedes === '.' || supersedes === '..' || !ID_PATTERN.test(supersedes)) {
      throw new Error('supersedes must be an existing handoff id');
    }
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
    supersedes,
  });
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    // A revision is validated against the prior INSIDE the transaction so the
    // `superseded` event, the successor row and the one-successor rule commit
    // or fail together.
    let prior: HandoffRow | undefined;
    if (supersedes) {
      prior = await getHandoff(supersedes);
      if (!prior) throw new Error(`handoff not found: ${supersedes}`);
      if (fingerprintOfRow(prior) !== prior.fingerprint) {
        throw new Error(`handoff ${prior.id} ledger fingerprint does not match its own fields`);
      }
      if (
        prior.source_agent_group_id !== input.sourceAgentGroupId ||
        prior.reviewer_agent_group_id !== input.reviewerAgentGroupId ||
        prior.project !== project
      ) {
        throw new Error(`revision must match the source, reviewer, and project of ${prior.id}`);
      }
      if (!REVISABLE_STATUSES.has(prior.status)) {
        throw new Error(
          `handoff ${prior.id} is ${prior.status}; only a changes_required or review_blocked handoff can be revised`,
        );
      }
      const successor = await getDb().get<{ id: string }>('SELECT id FROM handoffs WHERE supersedes = ?', prior.id);
      if (successor) throw new Error(`handoff ${prior.id} is already superseded by ${successor.id}`);
    }
    await getDb().run(
      `INSERT INTO handoffs
         (id, source_agent_group_id, reviewer_agent_group_id, source_session_id,
          project, goal, outcome, scope, authority, fingerprint, status, created_at, updated_at, supersedes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
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
      supersedes,
    );
    await appendEvent(
      id,
      'created',
      input.sourceAgentGroupId,
      supersedes ? { fingerprint, project, goal, supersedes } : { fingerprint, project, goal },
      now,
    );
    if (prior) {
      await appendEvent(
        prior.id,
        SUPERSEDED_EVENT,
        input.sourceAgentGroupId,
        { fingerprint: prior.fingerprint, successor: id },
        now,
      );
    }
  });
  return (await getHandoff(id))!;
}

export interface OwnerPingRecord {
  status: HandoffStatus;
  updated_at: string;
  pinged_at: string;
  recipient: string;
  platform_message_id: string | null;
}

/**
 * Append the host's record that an owner was told about a stalled handoff.
 * Pure audit trail: it never touches the handoff row, and the stall sweep uses
 * it to avoid telling the same owner about the same stall twice.
 */
export async function recordOwnerPing(id: string, record: OwnerPingRecord): Promise<void> {
  await mustGetHandoff(id);
  await appendEvent(id, OWNER_PINGED_EVENT, HOST_PING_ACTOR, { ...record }, record.pinged_at);
}

export async function markHandoffDelivered(id: string, actor: string, fingerprint: string): Promise<HandoffRow> {
  return transition(id, actor, fingerprint, 'created', 'delivered', 'delivered', {});
}

/** Recompute the stored fingerprint from the row's own columns. */
export function fingerprintOfRow(row: HandoffRow): string {
  return fingerprintHandoff({
    id: row.id,
    sourceAgentGroupId: row.source_agent_group_id,
    reviewerAgentGroupId: row.reviewer_agent_group_id,
    project: row.project,
    goal: row.goal,
    outcome: row.outcome,
    scope: row.scope,
    authority: row.authority,
    supersedes: row.supersedes,
  });
}

/**
 * Ids of handoffs that have a trustworthy successor. A successor whose stored
 * fingerprint no longer matches its own fields (for example a `supersedes`
 * value edited after insert) is not honored: a corrupted link must never hide
 * the prior from the stall sweep or the mission view. The corrupted rows are
 * returned so callers can say so.
 */
export function trustedSupersededIds(rows: HandoffRow[]): { superseded: Set<string>; corrupted: HandoffRow[] } {
  const superseded = new Set<string>();
  const corrupted: HandoffRow[] = [];
  for (const row of rows) {
    if (!row.supersedes) continue;
    if (fingerprintOfRow(row) === row.fingerprint) superseded.add(row.supersedes);
    else corrupted.push(row);
  }
  return { superseded, corrupted };
}

/**
 * Bind the verification inputs to the ledger fingerprint they were captured
 * against. Editing either the handoff row or the inputs row breaks this hash,
 * which is what the host verifier re-derives before it starts a container.
 */
export function fingerprintVerificationInputs(ledgerFingerprint: string, inputs: VerificationInputs): string {
  return createHash('sha256')
    .update(`${ledgerFingerprint}\n${canonicalVerificationInputs(inputs)}`)
    .digest('hex');
}

export interface DeliverHandoffWithInputsArgs {
  id: string;
  actor: string;
  fingerprint: string;
  inputs: { class: string; checkpoint: string; checks: string[]; reproduce: string[] };
}

export interface VerificationInputsRow {
  handoff_id: string;
  class: string;
  checkpoint: string;
  checks_json: string;
  reproduce_json: string;
  inputs_fingerprint: string;
  captured_at: string;
  captured_by: string;
}

export async function getVerificationInputs(handoffId: string): Promise<VerificationInputsRow | undefined> {
  return getDb().get<VerificationInputsRow>('SELECT * FROM verification_inputs WHERE handoff_id = ?', handoffId);
}

/**
 * The single atomic `created` → `delivered` operation: capture the commands
 * the host may later execute and move the handoff, or do neither.
 *
 * Inputs are validated BEFORE the transaction opens, so a malformed CHECKS
 * array throws without touching the DB at all. Everything else — status,
 * actor, fingerprint, self-consistency of the row, the inputs insert, the
 * status update and the `delivered` event — happens inside one transaction, so
 * any failure leaves the handoff `created`, with no inputs row and no event.
 */
export async function deliverHandoffWithInputs(args: DeliverHandoffWithInputsArgs): Promise<HandoffRow> {
  const inputs = validateVerificationInputs(args.inputs);
  const now = new Date().toISOString();

  await getDb().transaction(async () => {
    const row = await mustGetHandoff(args.id);
    expectStatus(row, 'created');
    expectActor(args.actor, row.source_agent_group_id, 'source');
    expectFingerprint(row, args.fingerprint);
    if (fingerprintOfRow(row) !== row.fingerprint) {
      throw new Error(`handoff ${row.id} ledger fingerprint does not match its own fields`);
    }

    const inputsFingerprint = fingerprintVerificationInputs(row.fingerprint, inputs);
    await getDb().run(
      `INSERT INTO verification_inputs
         (handoff_id, class, checkpoint, checks_json, reproduce_json, inputs_fingerprint, captured_at, captured_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      inputs.class,
      inputs.checkpoint,
      JSON.stringify(inputs.checks),
      JSON.stringify(inputs.reproduce),
      inputsFingerprint,
      now,
      args.actor,
    );

    const result = await getDb().run(
      `UPDATE handoffs SET status = 'delivered', updated_at = ? WHERE id = ? AND status = 'created'`,
      now,
      row.id,
    );
    if (result.changes !== 1) throw new Error(`handoff ${row.id} changed concurrently; reload before continuing`);

    await appendEvent(
      row.id,
      'delivered',
      args.actor,
      { fingerprint: row.fingerprint, inputs_fingerprint: inputsFingerprint },
      now,
    );
  });

  return (await getHandoff(args.id))!;
}

function reviewStatus(outcome: ReviewOutcome): HandoffStatus {
  if (outcome === 'APPROVED' || outcome === 'APPROVED WITH MINOR NOTES') return 'approved';
  if (outcome === 'CHANGES REQUIRED') return 'changes_required';
  return 'review_blocked';
}

export async function reviewHandoff(
  id: string,
  actor: string,
  fingerprint: string,
  reviewOutcome: ReviewOutcome,
  notes = '',
): Promise<HandoffRow> {
  const row = await mustGetHandoff(id);
  expectSelfIntegrity(row);
  expectActor(actor, row.reviewer_agent_group_id, 'reviewer');
  expectFingerprint(row, fingerprint);
  expectStatus(row, 'delivered');
  const status = reviewStatus(reviewOutcome);
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET status = ?, review_outcome = ?, review_notes = ?, updated_at = ?
       WHERE id = ? AND status = 'delivered'`,
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
  expectSelfIntegrity(row);
  expectActor(actor, row.source_agent_group_id, 'source');
  expectFingerprint(row, fingerprint);
  expectStatus(row, from);
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    const result = await getDb().run(
      `UPDATE handoffs
       SET status = ?, closure_evidence = COALESCE(?, closure_evidence),
           closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END,
           updated_at = ?
       WHERE id = ? AND status = ?`,
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
