import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { SlackBotInboundContext } from '../../channels/slack-a2a-guard.js';
import {
  acknowledgeHandoff,
  closeHandoff,
  completeHandoffDelivery,
  completeHandoffReview,
  createHandoff,
  getHandoff,
  HANDOFF_DELIVERY_LEASE_MS,
  HANDOFF_REVIEW_DELIVERY_LEASE_MS,
  listHandoffEvents,
  markHandoffDelivered,
  releaseHandoffDelivery,
  releaseHandoffReview,
  reserveHandoffDelivery,
  reserveHandoffReview,
  reviewHandoff,
} from './ledger.js';
import './migration.js';
import { resolveWiredParticipants } from './slack-enforcement.js';

const SOURCE = 'ag-source';
const REVIEWER = 'ag-reviewer';
const OTHER = 'ag-other';

async function seedAgents(): Promise<void> {
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: SOURCE, name: 'Source', folder: 'source', agent_provider: null, created_at });
  await createAgentGroup({ id: REVIEWER, name: 'Reviewer', folder: 'reviewer', agent_provider: null, created_at });
  await createAgentGroup({ id: OTHER, name: 'Other', folder: 'other', agent_provider: null, created_at });
}

async function wire(id: string, instance: string, platformId: string, agentGroupId: string): Promise<void> {
  const created_at = new Date().toISOString();
  await createMessagingGroup({
    id,
    channel_type: 'slack',
    platform_id: platformId,
    instance,
    name: id,
    is_group: platformId.includes(':D') ? 0 : 1,
    unknown_sender_policy: 'public',
    created_at,
  });
  await createMessagingGroupAgent({
    id: `w-${id}-${agentGroupId}`,
    messaging_group_id: id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at,
  });
}

function wiredContext(instanceKey: string, platformId: string): SlackBotInboundContext {
  return {
    instanceKey,
    platformId,
    threadId: null,
    botId: 'B-SOURCE',
    message: {
      id: 'm-wiring',
      kind: 'chat-sdk',
      content: {},
      timestamp: new Date().toISOString(),
      isGroup: true,
    },
  };
}

async function freshHandoff() {
  return createHandoff({
    id: 'COS-07-TEST-1',
    sourceAgentGroupId: SOURCE,
    reviewerAgentGroupId: REVIEWER,
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
    await markHandoffDelivered(created.id, SOURCE, created.fingerprint);
    await reviewHandoff(created.id, REVIEWER, created.fingerprint, 'APPROVED', 'Policy is complete.');
    await acknowledgeHandoff(created.id, SOURCE, created.fingerprint);
    const closed = await closeHandoff(
      created.id,
      SOURCE,
      created.fingerprint,
      'Reviewer approved the exact fingerprint.',
    );

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
    await expect(markHandoffDelivered(created.id, SOURCE, 'wrong-fingerprint')).rejects.toThrow('fingerprint mismatch');
    expect((await listHandoffEvents(created.id)).map((event) => event.event_type)).toEqual(['created']);
  });

  it('reserves delivery durably, releases a failed route, and permits retry', async () => {
    const created = await freshHandoff();
    const first = await reserveHandoffDelivery(created.id, SOURCE, created.fingerprint);
    expect(first).toMatchObject({ status: 'created', reservation_kind: 'delivery', reservation_generation: 1 });
    await expect(reserveHandoffDelivery(created.id, SOURCE, created.fingerprint)).rejects.toThrow('already reserved');
    expect(
      (
        await releaseHandoffDelivery(
          created.id,
          SOURCE,
          created.fingerprint,
          first.reservation_generation,
          'router rejected recipient',
        )
      ).status,
    ).toBe('created');
    const retry = await reserveHandoffDelivery(created.id, SOURCE, created.fingerprint);
    expect(
      (await completeHandoffDelivery(created.id, SOURCE, created.fingerprint, retry.reservation_generation)).status,
    ).toBe('delivered');
    expect((await listHandoffEvents(created.id)).map((event) => event.event_type)).toEqual([
      'created',
      'delivery_reserved',
      'delivery_released',
      'delivery_reserved',
      'delivered',
    ]);
  });

  it('reclaims a stale delivery reservation after a host interruption', async () => {
    const created = await freshHandoff();
    const first = new Date('2026-08-26T00:00:00.000Z');
    const original = await reserveHandoffDelivery(created.id, SOURCE, created.fingerprint, first);
    const afterLease = new Date(first.getTime() + HANDOFF_DELIVERY_LEASE_MS + 1);

    const replacement = await reserveHandoffDelivery(created.id, SOURCE, created.fingerprint, afterLease);

    expect(replacement.reservation_generation).toBe(original.reservation_generation + 1);
    expect(await getHandoff(created.id)).toMatchObject({ status: 'created', reservation_kind: 'delivery' });
    const events = await listHandoffEvents(created.id);
    expect(JSON.parse(events.at(-1)!.payload_json)).toMatchObject({ recovered: true });
  });

  it('does not let a late delivery callback release a reclaimed reservation', async () => {
    const created = await freshHandoff();
    const first = new Date('2026-08-26T00:00:00.000Z');
    const original = await reserveHandoffDelivery(created.id, SOURCE, created.fingerprint, first);
    const afterLease = new Date(first.getTime() + HANDOFF_DELIVERY_LEASE_MS + 1);
    const replacement = await reserveHandoffDelivery(created.id, SOURCE, created.fingerprint, afterLease);

    await expect(
      releaseHandoffDelivery(
        created.id,
        SOURCE,
        created.fingerprint,
        original.reservation_generation,
        'late callback from first attempt',
      ),
    ).rejects.toThrow('reservation');
    await expect(
      completeHandoffDelivery(created.id, SOURCE, created.fingerprint, original.reservation_generation),
    ).rejects.toThrow('reservation');
    expect(await getHandoff(created.id)).toMatchObject({ status: 'created', reservation_kind: 'delivery' });
    expect(
      (await completeHandoffDelivery(created.id, SOURCE, created.fingerprint, replacement.reservation_generation))
        .status,
    ).toBe('delivered');
  });

  it('reserves review delivery durably, releases a failed route, and permits retry', async () => {
    const created = await freshHandoff();
    await markHandoffDelivered(created.id, SOURCE, created.fingerprint);
    const first = await reserveHandoffReview(
      created.id,
      REVIEWER,
      created.fingerprint,
      'CHANGES REQUIRED',
      'Tighten the test.',
    );
    expect(first).toMatchObject({ status: 'delivered', reservation_kind: 'review', reservation_generation: 1 });
    await expect(reserveHandoffReview(created.id, REVIEWER, created.fingerprint, 'APPROVED')).rejects.toThrow(
      'already reserved',
    );
    const released = await releaseHandoffReview(
      created.id,
      REVIEWER,
      created.fingerprint,
      first.reservation_generation,
      'source route rejected',
    );
    expect(released.status).toBe('delivered');
    expect(released.review_outcome).toBeNull();
    const retry = await reserveHandoffReview(created.id, REVIEWER, created.fingerprint, 'APPROVED', 'Ready.');
    expect(
      (await completeHandoffReview(created.id, REVIEWER, created.fingerprint, retry.reservation_generation)).status,
    ).toBe('approved');
    expect((await listHandoffEvents(created.id)).map((event) => event.event_type)).toEqual([
      'created',
      'delivered',
      'review_delivery_reserved',
      'review_delivery_released',
      'review_delivery_reserved',
      'approved',
    ]);
  });

  it('reclaims a stale review reservation after a host interruption', async () => {
    const created = await freshHandoff();
    await markHandoffDelivered(created.id, SOURCE, created.fingerprint);
    const first = new Date('2026-08-26T00:00:00.000Z');
    const original = await reserveHandoffReview(created.id, REVIEWER, created.fingerprint, 'REVIEW BLOCKED', '', first);
    const afterLease = new Date(first.getTime() + HANDOFF_REVIEW_DELIVERY_LEASE_MS + 1);

    const replacement = await reserveHandoffReview(
      created.id,
      REVIEWER,
      created.fingerprint,
      'APPROVED',
      '',
      afterLease,
    );

    expect(replacement.reservation_generation).toBe(original.reservation_generation + 1);
    expect(await getHandoff(created.id)).toMatchObject({ status: 'delivered', reservation_kind: 'review' });
    const events = await listHandoffEvents(created.id);
    expect(JSON.parse(events.at(-1)!.payload_json)).toMatchObject({ recovered: true, review_outcome: 'APPROVED' });
  });

  it('does not let a late review callback complete a replacement outcome', async () => {
    const created = await freshHandoff();
    await markHandoffDelivered(created.id, SOURCE, created.fingerprint);
    const first = new Date('2026-08-26T00:00:00.000Z');
    const original = await reserveHandoffReview(
      created.id,
      REVIEWER,
      created.fingerprint,
      'CHANGES REQUIRED',
      'First attempt.',
      first,
    );
    const afterLease = new Date(first.getTime() + HANDOFF_REVIEW_DELIVERY_LEASE_MS + 1);
    const replacement = await reserveHandoffReview(
      created.id,
      REVIEWER,
      created.fingerprint,
      'APPROVED',
      'Replacement.',
      afterLease,
    );

    await expect(
      completeHandoffReview(created.id, REVIEWER, created.fingerprint, original.reservation_generation),
    ).rejects.toThrow('reservation');
    await expect(
      releaseHandoffReview(
        created.id,
        REVIEWER,
        created.fingerprint,
        original.reservation_generation,
        'late callback from first attempt',
      ),
    ).rejects.toThrow('reservation');
    expect(await getHandoff(created.id)).toMatchObject({ status: 'delivered', reservation_kind: 'review' });
    expect((await getHandoff(created.id))?.review_outcome).toBe('APPROVED');
    expect(
      (await completeHandoffReview(created.id, REVIEWER, created.fingerprint, replacement.reservation_generation))
        .status,
    ).toBe('approved');
  });

  it('blocks manual transitions while a routed delivery or review owns the lease', async () => {
    const created = await freshHandoff();
    const delivery = await reserveHandoffDelivery(created.id, SOURCE, created.fingerprint);
    await expect(markHandoffDelivered(created.id, SOURCE, created.fingerprint)).rejects.toThrow('active delivery');
    await completeHandoffDelivery(created.id, SOURCE, created.fingerprint, delivery.reservation_generation);

    const review = await reserveHandoffReview(created.id, REVIEWER, created.fingerprint, 'APPROVED');
    await expect(reviewHandoff(created.id, REVIEWER, created.fingerprint, 'CHANGES REQUIRED')).rejects.toThrow(
      'active review',
    );
    await completeHandoffReview(created.id, REVIEWER, created.fingerprint, review.reservation_generation);
  });

  it('rejects a duplicate review', async () => {
    const created = await freshHandoff();
    await markHandoffDelivered(created.id, SOURCE, created.fingerprint);
    await reviewHandoff(created.id, REVIEWER, created.fingerprint, 'APPROVED');
    await expect(reviewHandoff(created.id, REVIEWER, created.fingerprint, 'APPROVED')).rejects.toThrow(
      'expected delivered',
    );
  });

  it('rejects the wrong actor at every ownership boundary', async () => {
    const created = await freshHandoff();
    await expect(markHandoffDelivered(created.id, REVIEWER, created.fingerprint)).rejects.toThrow('source');
    await markHandoffDelivered(created.id, SOURCE, created.fingerprint);
    await expect(reviewHandoff(created.id, SOURCE, created.fingerprint, 'APPROVED')).rejects.toThrow('reviewer');
  });

  it('does not allow changes-required work to be acknowledged or closed', async () => {
    const created = await freshHandoff();
    await markHandoffDelivered(created.id, SOURCE, created.fingerprint);
    await reviewHandoff(created.id, REVIEWER, created.fingerprint, 'CHANGES REQUIRED', 'Use “and,” not “or.”');
    await expect(acknowledgeHandoff(created.id, SOURCE, created.fingerprint)).rejects.toThrow('changes_required');
    await expect(closeHandoff(created.id, SOURCE, created.fingerprint, 'Not actually complete')).rejects.toThrow(
      'changes_required',
    );
  });
});

describe('Slack handoff participant wiring', () => {
  it('fails closed when one sender bot instance serves more than one agent group', async () => {
    await wire('mg-source-dm', 'slack-source', 'slack:D-SOURCE', SOURCE);
    await wire('mg-source-room', 'slack-source', 'slack:G-OTHER', OTHER);
    await wire('mg-review-room', 'slack-reviewer', 'slack:G-REVIEW', REVIEWER);

    expect(
      await resolveWiredParticipants(wiredContext('slack-reviewer', 'slack:G-REVIEW'), 'slack-source'),
    ).toBeUndefined();
  });

  it('resolves the receiver from the exact room instead of another room on its instance', async () => {
    await wire('mg-source-dm', 'slack-source', 'slack:D-SOURCE', SOURCE);
    await wire('mg-review-room', 'slack-reviewer', 'slack:G-REVIEW', REVIEWER);
    await wire('mg-other-room', 'slack-reviewer', 'slack:G-OTHER', OTHER);

    expect(await resolveWiredParticipants(wiredContext('slack-reviewer', 'slack:G-REVIEW'), 'slack-source')).toEqual({
      senderAgentGroupId: SOURCE,
      receiverAgentGroupId: REVIEWER,
    });
  });

  it('fails closed when the receiving room itself has ambiguous wiring', async () => {
    await wire('mg-source-dm', 'slack-source', 'slack:D-SOURCE', SOURCE);
    await wire('mg-review-room', 'slack-reviewer', 'slack:G-REVIEW', REVIEWER);
    await createMessagingGroupAgent({
      id: 'w-review-room-other',
      messaging_group_id: 'mg-review-room',
      agent_group_id: OTHER,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 1,
      created_at: new Date().toISOString(),
    });

    expect(
      await resolveWiredParticipants(wiredContext('slack-reviewer', 'slack:G-REVIEW'), 'slack-source'),
    ).toBeUndefined();
  });
});
