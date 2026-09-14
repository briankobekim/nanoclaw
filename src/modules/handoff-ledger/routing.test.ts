import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import { setBotInboundPolicy, wrapSlackBotGuard } from '../../channels/slack-a2a-guard.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { routeInboundWithReceipt } from '../../router.js';
import {
  completeHandoffDelivery,
  completeHandoffReview,
  createHandoff,
  getHandoff,
  markHandoffDelivered,
  releaseHandoffDelivery,
  releaseHandoffReview,
  reserveHandoffDelivery,
  reserveHandoffReview,
} from './ledger.js';
import './migration.js';
import { createHandoffMessageEnforcer } from './slack-enforcement.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-handoff-routing';
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-handoff-routing' };
});

const SOURCE = 'ag-source';
const REVIEWER = 'ag-reviewer';
const REVIEW_ROOM = 'slack:G-REVIEW';
const SOURCE_ROOM = 'slack:G-SOURCE';

function handoffMessage(fingerprint: string, isMention: boolean): InboundMessage {
  return {
    id: `msg-${isMention ? 'retry' : 'denied'}`,
    kind: 'chat-sdk',
    content: {
      text: [
        'HANDOFF_ID: HANDOFF-ROUTING',
        `FINGERPRINT: ${fingerprint}`,
        'PROJECT: none',
        'GOAL: Prove receipt-bound delivery',
        'OUTCOME: Reviewer receives the package',
        'CLASS: complex',
        'SCOPE: This test',
        'AUTHORITY: review',
        'CHECKPOINT: test',
        'FILES: none',
        'CHECKS: focused tests',
        'REPRODUCE: vitest',
        'EVIDENCE: durable receipt',
        'RISKS: none',
        'FOLLOW_UP: review',
      ].join('\n'),
      author: { userId: 'B-SOURCE', isBot: true },
    },
    timestamp: new Date().toISOString(),
    isMention,
    isGroup: true,
  };
}

function reviewMessage(fingerprint: string, isMention: boolean): InboundMessage {
  return {
    id: `review-${isMention ? 'retry' : 'denied'}`,
    kind: 'chat-sdk',
    content: {
      text: [
        'HANDOFF_ID: HANDOFF-ROUTING',
        `FINGERPRINT: ${fingerprint}`,
        'PROJECT: none',
        'GOAL: Prove receipt-bound delivery',
        'APPROVED',
      ].join('\n'),
      author: { userId: 'B-REVIEWER', isBot: true },
    },
    timestamp: new Date().toISOString(),
    isMention,
    isGroup: true,
  };
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: SOURCE, name: 'Source', folder: 'source', agent_provider: null, created_at });
  await createAgentGroup({ id: REVIEWER, name: 'Reviewer', folder: 'reviewer', agent_provider: null, created_at });
  await createMessagingGroup({
    id: 'mg-review',
    channel_type: 'slack',
    platform_id: REVIEW_ROOM,
    instance: 'slack-reviewer',
    name: 'Review room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at,
  });
  await createMessagingGroupAgent({
    id: 'w-review',
    messaging_group_id: 'mg-review',
    agent_group_id: REVIEWER,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at,
  });
  await createMessagingGroup({
    id: 'mg-source',
    channel_type: 'slack',
    platform_id: SOURCE_ROOM,
    instance: 'slack-source',
    name: 'Source room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at,
  });
  await createMessagingGroupAgent({
    id: 'w-source',
    messaging_group_id: 'mg-source',
    agent_group_id: SOURCE,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at,
  });
});

afterEach(async () => {
  setBotInboundPolicy(null);
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function installPolicy(): Promise<string> {
  const handoff = await createHandoff({
    id: 'HANDOFF-ROUTING',
    sourceAgentGroupId: SOURCE,
    reviewerAgentGroupId: REVIEWER,
    project: 'none',
    goal: 'Prove receipt-bound delivery',
    outcome: 'Reviewer receives the package',
    scope: 'This test',
    authority: 'review',
  });
  const enforce = createHandoffMessageEnforcer({
    getHandoff,
    reserveDelivery: reserveHandoffDelivery,
    completeDelivery: completeHandoffDelivery,
    releaseDelivery: releaseHandoffDelivery,
    reserveReview: reserveHandoffReview,
    completeReview: completeHandoffReview,
    releaseReview: releaseHandoffReview,
    resolveParticipants: async (ctx) =>
      ctx.botId === 'B-REVIEWER'
        ? { senderAgentGroupId: REVIEWER, receiverAgentGroupId: SOURCE }
        : { senderAgentGroupId: SOURCE, receiverAgentGroupId: REVIEWER },
  });
  setBotInboundPolicy({
    async decideBotInbound(ctx) {
      const decision = await enforce(ctx);
      return decision.action === 'drop'
        ? decision
        : { ...decision, action: 'admit' as const, senderId: `slack:bot:${ctx.botId}` };
    },
  });
  return handoff.fingerprint;
}

function routedSetup(instance: string): ChannelSetup {
  return {
    onInbound(platformId, threadId, message) {
      return routeInboundWithReceipt({
        channelType: 'slack',
        instance,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
}

describe('receipt-bound Slack handoff routing', () => {
  it('releases a real router denial and completes the retry only after reviewer receipt', async () => {
    const fingerprint = await installPolicy();
    const wrapped = wrapSlackBotGuard(routedSetup('slack-reviewer'), 'slack-reviewer');

    await wrapped.onInbound(REVIEW_ROOM, null, handoffMessage(fingerprint, false));
    expect((await getHandoff('HANDOFF-ROUTING'))?.status).toBe('created');

    await wrapped.onInbound(REVIEW_ROOM, null, handoffMessage(fingerprint, true));
    expect((await getHandoff('HANDOFF-ROUTING'))?.status).toBe('delivered');
  });

  it('releases the durable reservation when host routing throws', async () => {
    const fingerprint = await installPolicy();
    const setup = routedSetup('slack-reviewer');
    setup.onInbound = async () => {
      throw new Error('routing failed');
    };
    const wrapped = wrapSlackBotGuard(setup, 'slack-reviewer');

    await expect(wrapped.onInbound(REVIEW_ROOM, null, handoffMessage(fingerprint, true))).rejects.toThrow(
      'routing failed',
    );
    expect((await getHandoff('HANDOFF-ROUTING'))?.status).toBe('created');
  });

  it('releases a denied review handback and completes only after the exact source receipt', async () => {
    const fingerprint = await installPolicy();
    await markHandoffDelivered('HANDOFF-ROUTING', SOURCE, fingerprint);
    const wrapped = wrapSlackBotGuard(routedSetup('slack-source'), 'slack-source');

    await wrapped.onInbound(SOURCE_ROOM, null, reviewMessage(fingerprint, false));
    expect((await getHandoff('HANDOFF-ROUTING'))?.status).toBe('delivered');

    await wrapped.onInbound(SOURCE_ROOM, null, reviewMessage(fingerprint, true));
    expect((await getHandoff('HANDOFF-ROUTING'))?.status).toBe('approved');
  });
});
