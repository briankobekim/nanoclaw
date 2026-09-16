import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getAgentMailbox } from './mailbox/index.js';
import { getUndeliveredMessages, type MessageOutRow } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent, TurnUsage } from './providers/types.js';

// C2 / C3 — the poll loop records every turn as ONE `kind:'system'`
// `record_usage` row (docs/specs/usage-digest/plan.md §4.1), written before
// the batch is completed and before any reply, and also when the provider
// fails terminally without ever yielding a `result`.

/**
 * Ordered log of the three observable steps. Both `markCompleted` and
 * `writeMessageOut` route through the registered mailbox instance
 * (`operations === this` for the SQLite mailbox), so wrapping two of its
 * methods observes the real call order without module mocking.
 */
let calls: string[] = [];
let restore: () => void = () => {};

beforeEach(() => {
  initTestSessionDb();
  calls = [];
  const mb = getAgentMailbox().operations;
  const origMark = mb.markMessages;
  const origWrite = mb.writeMessageOut;
  mb.markMessages = (ids, status) => {
    if (status === 'completed') calls.push('markCompleted');
    return origMark.call(mb, ids, status);
  };
  mb.writeMessageOut = (message) => {
    if (message.kind === 'system' && JSON.parse(message.content).action === 'record_usage') calls.push('record');
    else if (message.kind === 'chat') calls.push('reply');
    return origWrite.call(mb, message);
  };
  restore = () => {
    mb.markMessages = origMark;
    mb.writeMessageOut = origWrite;
  };
});

afterEach(() => {
  restore();
  closeSessionDb();
});

function insertMessage(id: string, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
       VALUES (?, 'chat', datetime('now'), 'processing', NULL, 1, 0, ?)`,
    )
    .run(id, JSON.stringify(content));
}

function seedDestination(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('user', 'User', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
}

const ROUTING = { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' };

const USAGE: TurnUsage = {
  cost_usd: 0.0123,
  input_tokens: 100,
  output_tokens: 20,
  cache_read_tokens: 300,
  cache_creation_tokens: 40,
  model_usage: {
    'claude-sonnet-4-5': {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 300,
      cache_creation_tokens: 40,
      cost_usd: 0.0123,
    },
  },
  duration_ms: 1500,
  duration_api_ms: 1200,
  num_turns: 3,
  sdk_result_id: 'res-uuid-1',
};

function makeQuery(events: () => AsyncGenerator<ProviderEvent>): AgentQuery {
  return { push: () => {}, end: () => {}, events: events(), abort: () => {} };
}

function recordRows(): Array<{ row: MessageOutRow; payload: Record<string, unknown> }> {
  return getUndeliveredMessages()
    .filter((r) => r.kind === 'system')
    .map((row) => ({ row, payload: JSON.parse(row.content) as Record<string, unknown> }))
    .filter((r) => r.payload.action === 'record_usage');
}

function expectIso8601(value: unknown): void {
  expect(typeof value).toBe('string');
  expect(new Date(value as string).toISOString()).toBe(value as string);
}

describe('the record row is written before the batch is completed and before any reply', () => {
  it('one result with usage → exactly one record_usage row, order record → markCompleted → reply', async () => {
    insertMessage('m1', { sender: 'A', text: 'hi' });
    seedDestination();
    const query = makeQuery(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      yield { type: 'result', text: '<message to="user">hello</message>', isError: false, usage: USAGE };
    });

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const records = recordRows();
    expect(records).toHaveLength(1);
    const { payload } = records[0]!;
    expect(payload.action).toBe('record_usage');
    expect(payload.turn_id).toBe('res-uuid-1');
    expect(payload.reported).toBe(true);
    expect(payload.is_error).toBe(false);
    expectIso8601(payload.occurred_at);
    expect(payload.usage).toEqual(USAGE);
    expect(Object.keys(payload).sort()).toEqual(
      ['action', 'is_error', 'occurred_at', 'reported', 'turn_id', 'usage'].sort(),
    );

    // The reply really went out, and the observed order is the invariant.
    expect(getUndeliveredMessages().filter((r) => r.kind === 'chat')).toHaveLength(1);
    expect(calls).toEqual(['record', 'markCompleted', 'reply']);
  });

  it('a result without usage → one row with reported:false and no usage key', async () => {
    insertMessage('m1', { sender: 'A', text: 'hi' });
    const query = makeQuery(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      yield { type: 'result', text: null };
    });

    await processQuery(query, ROUTING, ['m1'], 'codex', undefined, 'prompt', undefined);

    const records = recordRows();
    expect(records).toHaveLength(1);
    const { payload } = records[0]!;
    expect(payload.reported).toBe(false);
    expect(payload.is_error).toBe(false);
    expect('usage' in payload).toBe(false);
    expect(typeof payload.turn_id).toBe('string');
    expect((payload.turn_id as string).length).toBeGreaterThan(0);
    expectIso8601(payload.occurred_at);
    expect(calls.slice(0, 2)).toEqual(['record', 'markCompleted']);
  });

  it('an error result → is_error:true, still record → markCompleted → reply', async () => {
    insertMessage('m1', { sender: 'A', text: 'hi' });
    const query = makeQuery(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      yield { type: 'result', text: 'Spending limit reached.', isError: true, usage: USAGE };
    });

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const records = recordRows();
    expect(records).toHaveLength(1);
    expect(records[0]!.payload.is_error).toBe(true);
    expect(records[0]!.payload.reported).toBe(true);
    expect(records[0]!.payload.turn_id).toBe('res-uuid-1');
    expect(calls).toEqual(['record', 'markCompleted', 'reply']);
  });
});

describe('a terminal provider failure with no result still records the turn', () => {
  it('a provider that yields an error and throws (the Codex shape) → one row, reported:false, is_error:true', async () => {
    insertMessage('m1', { sender: 'A', text: 'hi' });
    const query = makeQuery(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      yield { type: 'error', message: 'Codex turn failed', retryable: false };
      throw new Error('Codex turn failed');
    });

    await expect(processQuery(query, ROUTING, ['m1'], 'codex', undefined, 'prompt', undefined)).rejects.toThrow(
      'Codex turn failed',
    );

    const records = recordRows();
    expect(records).toHaveLength(1);
    const { payload } = records[0]!;
    expect(payload.reported).toBe(false);
    expect(payload.is_error).toBe(true);
    expect('usage' in payload).toBe(false);
    expect(typeof payload.turn_id).toBe('string');
    expectIso8601(payload.occurred_at);
  });

  it('a stream that ends with neither result nor exception (an abort) still records one unreported error turn', async () => {
    insertMessage('m1', { sender: 'A', text: 'hi' });
    const query = makeQuery(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      // The provider generator returns: no result, no throw (query.abort() shape).
    });

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const records = recordRows();
    expect(records).toHaveLength(1);
    expect(records[0]!.payload.reported).toBe(false);
    expect(records[0]!.payload.is_error).toBe(true);
    expect('usage' in records[0]!.payload).toBe(false);
  });

  it('exactly one record per turn: a stream exception after a completed result does not record twice', async () => {
    insertMessage('m1', { sender: 'A', text: 'hi' });
    const query = makeQuery(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
      yield { type: 'result', text: null, usage: USAGE };
      throw new Error('stream closed');
    });

    await expect(processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined)).rejects.toThrow(
      'stream closed',
    );

    const records = recordRows();
    expect(records).toHaveLength(1);
    expect(records[0]!.payload.turn_id).toBe('res-uuid-1');
    expect(records[0]!.payload.is_error).toBe(false);
  });
});
