/**
 * Approval-click durability (docs/specs/approval-click-durability/plan.md).
 *
 * The bridge must record a button click BEFORE it terminalizes the card.
 * Drives the bridge's real onAction handler through the real Chat SDK
 * dispatch (`chat.processAction`) for the Slack/chat-sdk path, and the
 * exported `handleForwardedEvent` for the Discord gateway path with `fetch`
 * stubbed. Three properties per path: a throwing recorder leaves the card
 * untouched; a slow recorder is awaited before the edit; an unclaimed click
 * (stale card) is still terminalized.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, Chat } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createPendingApproval } from '../db/sessions.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge, handleForwardedEvent } from './chat-sdk-bridge.js';

type Recorder = ChannelSetup['onAction'];

function makeAdapter(log: string[]): Adapter {
  return {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    editMessage: async (_t: string, _m: string, _msg: AdapterPostableMessage) => {
      log.push('card-edited');
    },
  } as unknown as Adapter;
}

async function click(onAction: Recorder): Promise<string[]> {
  const log: string[] = [];
  const adapter = makeAdapter(log);
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
  await bridge.setup({
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: (...args: Parameters<Recorder>) => {
      const result = onAction(...args);
      log.push('recorder-called');
      return result;
    },
  } as ChannelSetup);
  const chat = captured.chat as Chat;
  expect(chat).toBeTruthy();
  await chat.processAction(
    {
      actionId: 'ncq:q-1:approve',
      adapter,
      messageId: 'msg-1',
      raw: {},
      threadId: 'T-1',
      user: { userId: 'U1' } as never,
      value: 'approve',
    },
    undefined,
  );
  await bridge.teardown();
  return log;
}

beforeEach(async () => {
  captured.chat = null;
  const db = await initTestDb();
  await runMigrations(db);
  await createPendingApproval({
    approval_id: 'q-1',
    session_id: null,
    request_id: 'q-1',
    action: 'test_action',
    payload: '{}',
    created_at: new Date().toISOString(),
    title: 'Approval needed',
    question: 'Full request details.',
    options_json: JSON.stringify([
      { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
      { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
    ]),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

describe('chat-sdk path: the click is recorded before the card is terminalized', () => {
  it('a recorder that throws leaves the card actionable (no edit)', async () => {
    const log = await click(async () => {
      throw new Error('database down');
    });
    expect(log).toEqual(['recorder-called']);
  });

  it('a slow recorder is awaited; the edit happens only after it resolves', async () => {
    const log: string[] = [];
    const seen = await click(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      log.push('recorded');
      return true;
    });
    expect(seen).toEqual(['recorder-called', 'card-edited']);
    expect(log).toEqual(['recorded']);
  });

  it('an unclaimed click (stale card, no row) is still terminalized', async () => {
    const log = await click(async () => false);
    expect(log).toEqual(['recorder-called', 'card-edited']);
  });

  it('the legacy void recorder still terminalizes the card', async () => {
    const log = await click(() => undefined);
    expect(log).toEqual(['recorder-called', 'card-edited']);
  });
});

describe('discord gateway path: deferred acknowledgement, record, then edit the original', () => {
  function interactionBody(): string {
    return JSON.stringify({
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 3,
        id: 'i-1',
        token: 'tok-1',
        application_id: 'app-1',
        data: { custom_id: 'ncq:q-1:0' },
        user: { id: 'D1', username: 'dana' },
        message: { embeds: [{ title: 'Approval needed', description: 'Full request details.' }] },
      },
    });
  }

  function stubFetch(calls: Array<{ url: string; method: string; body: unknown }>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        return new Response('{}', { status: 200 });
      }),
    );
  }

  function setup(onAction: Recorder): ChannelSetup {
    return {
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction,
    } as ChannelSetup;
  }

  it('acknowledges with a deferred update, and on a throwing recorder never edits the original', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(calls);
    await handleForwardedEvent(
      interactionBody(),
      {} as never,
      setup(async () => {
        throw new Error('database down');
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/interactions/i-1/tok-1/callback');
    expect(calls[0]!.body).toEqual({ type: 6 });
  });

  it('edits the original message with buttons removed only after the recorder resolved', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(calls);
    const order: string[] = [];
    await handleForwardedEvent(
      interactionBody(),
      {} as never,
      setup(async (questionId, selectedOption, userId) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`recorded ${questionId}:${selectedOption}:${userId} after ${calls.length} fetch`);
        return true;
      }),
    );
    expect(order).toEqual(['recorded q-1:approve:D1 after 1 fetch']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.url).toBe('https://discord.com/api/v10/webhooks/app-1/tok-1/messages/@original');
    expect(calls[1]!.body).toMatchObject({ components: [], embeds: [{ footer: { text: '✅ Approved by dana' } }] });
  });
});
