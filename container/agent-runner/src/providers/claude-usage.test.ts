import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// C1 — the Claude provider surfaces the SDK result's usage block on the
// `result` provider event, for the success subtype AND every error subtype.
// The host's usage digest (docs/specs/usage-digest/plan.md §4.1) is only as
// accurate as this translation: an error turn still spent tokens.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type ResultEvent = { type: 'result'; text: string | null; isError?: boolean; usage?: Record<string, unknown> };

async function runToResult(): Promise<ResultEvent> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const results: ResultEvent[] = [];
  for await (const e of q.events) if (e.type === 'result') results.push(e as ResultEvent);
  expect(results).toHaveLength(1);
  return results[0]!;
}

const SDK_USAGE_FIELDS = {
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 40,
  },
  modelUsage: {
    'claude-sonnet-4-5': {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 40,
      costUSD: 0.0123,
    },
  },
  duration_ms: 1500,
  duration_api_ms: 1200,
  num_turns: 3,
  uuid: 'res-uuid-1',
};

const EXPECTED_USAGE = {
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

describe('claude provider surfaces usage on success and every error result subtype', () => {
  it('success: the result event carries the exact usage numbers', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', subtype: 'success', result: '<message to="user">hello</message>', ...SDK_USAGE_FIELDS },
    );

    const r = await runToResult();
    expect(r.text).toBe('<message to="user">hello</message>');
    expect(r.isError).toBe(false);
    expect(r.usage).toEqual(EXPECTED_USAGE);
  });

  for (const subtype of [
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
  ]) {
    it(`${subtype}: the same usage is surfaced with isError:true`, async () => {
      sdkMessages.length = 0;
      sdkMessages.push(
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        { type: 'result', subtype, is_error: true, errors: ['boom'], ...SDK_USAGE_FIELDS },
      );

      const r = await runToResult();
      expect(r.text).toBe('boom');
      expect(r.isError).toBe(true);
      expect(r.usage).toEqual(EXPECTED_USAGE);
    });
  }

  it('a result with no usage fields yields zero tokens, null cost and a fresh id', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', subtype: 'success', result: 'x' },
    );

    const r = await runToResult();
    expect(r.usage).toBeDefined();
    const u = r.usage!;
    expect(u.cost_usd).toBeNull();
    expect(u.input_tokens).toBe(0);
    expect(u.output_tokens).toBe(0);
    expect(u.cache_read_tokens).toBe(0);
    expect(u.cache_creation_tokens).toBe(0);
    expect(u.model_usage).toEqual({});
    expect(u.duration_ms).toBe(0);
    expect(u.duration_api_ms).toBe(0);
    expect(u.num_turns).toBe(0);
    expect(typeof u.sdk_result_id).toBe('string');
    expect((u.sdk_result_id as string).length).toBeGreaterThan(0);
  });

  it('snake_case per-model usage (older SDK shape) is mapped the same way', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'result',
        subtype: 'success',
        result: 'x',
        uuid: 'res-uuid-2',
        modelUsage: {
          'claude-haiku-4-5': {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 1,
            cost_usd: 0.001,
          },
        },
      },
    );

    const r = await runToResult();
    expect(r.usage!.model_usage).toEqual({
      'claude-haiku-4-5': {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_tokens: 5,
        cache_creation_tokens: 1,
        cost_usd: 0.001,
      },
    });
  });
});
