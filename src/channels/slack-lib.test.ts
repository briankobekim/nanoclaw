/**
 * slack-lib — request/error shaping of the shared fetch-based Web API client
 * and the per-instance bot-token env-key convention.
 *
 * Pinned invariants: Slack's error strings surface in thrown messages; token
 * values never do (Authorization header is the only place a token travels).
 * All fetches are mocked — no live Slack calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { botTokenKeyForInstance, SlackApiError, slackAuthTest, slackCall } from './slack-lib.js';

const TOKEN = 'xoxb-secret-test-token-value';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl as (...args: unknown[]) => Promise<Response>);
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function captureError(promise: Promise<unknown>): Promise<SlackApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SlackApiError);
    return err as SlackApiError;
  }
  throw new Error('expected the call to throw');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('slackCall request shaping', () => {
  it('POSTs the method to slack.com/api with a JSON body, bearer token, and a timeout signal', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ ok: true, stuff: 1 }));

    const json = await slackCall(TOKEN, 'chat.postMessage', { channel: 'C1', text: 'hi' }, 'my-step');

    expect(json).toMatchObject({ ok: true, stuff: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toContain('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', text: 'hi' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('slackCall error shaping', () => {
  it("surfaces Slack's error string with the method and step — never the token", async () => {
    mockFetch(async () => jsonResponse({ ok: false, error: 'channel_not_found' }));

    const err = await captureError(slackCall(TOKEN, 'conversations.info', { channel: 'C9' }, 'room-lookup'));

    expect(err.name).toBe('SlackApiError');
    expect(err.step).toBe('room-lookup');
    expect(err.message).toBe('slack conversations.info failed: channel_not_found');
    expect(err.message).not.toContain(TOKEN);
  });

  it('falls back to the HTTP status when ok:false carries no error string', async () => {
    mockFetch(async () => jsonResponse({ ok: false }, 429));

    const err = await captureError(slackCall(TOKEN, 'auth.test', {}, 's'));

    expect(err.message).toBe('slack auth.test failed: HTTP 429');
  });

  it('wraps fetch-level failures (network error / timeout abort) without leaking the token', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const err = await captureError(slackCall(TOKEN, 'auth.test', {}, 'origin-auth'));

    expect(err.step).toBe('origin-auth');
    expect(err.message).toBe('slack auth.test failed: The operation was aborted due to timeout');
    expect(err.message).not.toContain(TOKEN);
  });

  it('reports non-JSON bodies as HTTP <status>, non-JSON body', async () => {
    mockFetch(async () => new Response('<html>bad gateway</html>', { status: 502 }));

    const err = await captureError(slackCall(TOKEN, 'chat.postMessage', { channel: 'C1' }, 's'));

    expect(err.message).toBe('slack chat.postMessage failed: HTTP 502, non-JSON body');
  });
});

describe('slackAuthTest', () => {
  it('maps the user and bot ids from the response', async () => {
    mockFetch(async () => jsonResponse({ ok: true, user_id: 'U123', bot_id: 'B456' }));

    await expect(slackAuthTest(TOKEN, 's')).resolves.toEqual({
      userId: 'U123',
      botId: 'B456',
    });
  });

  it('throws when the response has no user_id', async () => {
    mockFetch(async () => jsonResponse({ ok: true }));

    const err = await captureError(slackAuthTest(TOKEN, 'origin-auth'));

    expect(err.step).toBe('origin-auth');
    expect(err.message).toBe('slack auth.test failed: no user_id in response');
  });
});

describe('botTokenKeyForInstance', () => {
  it('maps the default instance to SLACK_BOT_TOKEN', () => {
    expect(botTokenKeyForInstance('slack')).toBe('SLACK_BOT_TOKEN');
  });

  it('strips a leading slack- prefix and uppercases the remainder', () => {
    expect(botTokenKeyForInstance('slack-zulu')).toBe('SLACK_BOT_TOKEN_ZULU');
  });

  it('normalizes dashes to underscores', () => {
    expect(botTokenKeyForInstance('slack-growth-bot')).toBe('SLACK_BOT_TOKEN_GROWTH_BOT');
  });

  it('normalizes case', () => {
    expect(botTokenKeyForInstance('slack-Zulu')).toBe('SLACK_BOT_TOKEN_ZULU');
  });

  it('handles keys without the slack- prefix', () => {
    expect(botTokenKeyForInstance('ops-bot')).toBe('SLACK_BOT_TOKEN_OPS_BOT');
  });

  it('strips only the leading slack- prefix, not interior occurrences', () => {
    expect(botTokenKeyForInstance('slack-slack-two')).toBe('SLACK_BOT_TOKEN_SLACK_TWO');
  });
});
