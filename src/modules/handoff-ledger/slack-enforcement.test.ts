import { SlackFormatConverter } from '@chat-adapter/slack';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlackBotInboundContext } from '../../channels/slack-a2a-guard.js';
import type { HandoffRow } from './ledger.js';
import {
  createHandoffMessageEnforcer,
  parseTrackedHandoffMessage,
  type HandoffMessageEnforcementDeps,
} from './slack-enforcement.js';

const SOURCE = 'ag-atlas';
const REVIEWER = 'ag-echo';
const ID = 'HANDOFF-123';
const FINGERPRINT = 'a'.repeat(64);

function row(status: HandoffRow['status'] = 'created'): HandoffRow {
  return {
    id: ID,
    source_agent_group_id: SOURCE,
    reviewer_agent_group_id: REVIEWER,
    source_session_id: null,
    project: 'none',
    goal: 'Verify automatic handoff enforcement',
    outcome: 'A trusted review reaches Atlas',
    scope: 'NanoClaw only',
    authority: 'execute',
    fingerprint: FINGERPRINT,
    status,
    review_outcome: null,
    review_notes: null,
    closure_evidence: null,
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    closed_at: null,
  };
}

function context(text: string): SlackBotInboundContext {
  return {
    instanceKey: 'slack-echo',
    platformId: 'slack:G0ROOM',
    threadId: null,
    botId: 'B0ATLAS',
    message: {
      id: 'msg-1',
      kind: 'chat-sdk',
      content: { text, author: { userId: 'B0ATLAS', isBot: true } },
      timestamp: '2026-08-26T00:00:00.000Z',
      isGroup: true,
    },
  };
}

function handoffText(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    HANDOFF_ID: ID,
    FINGERPRINT,
    PROJECT: 'none',
    GOAL: 'Verify automatic handoff enforcement',
    OUTCOME: 'A trusted review reaches Atlas',
    CLASS: 'complex',
    SCOPE: 'NanoClaw only',
    AUTHORITY: 'execute',
    CHECKPOINT: 'abc1234',
    FILES: 'src/example.ts',
    CHECKS: '["pnpm test"]',
    REPRODUCE: '[]',
    EVIDENCE: 'verified locally',
    RISKS: 'none known',
    FOLLOW_UP: 'Echo reviews',
    ...overrides,
  };
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function reviewText(outcome = 'APPROVED'): string {
  return [
    `HANDOFF_ID: ${ID}`,
    `FINGERPRINT: ${FINGERPRINT}`,
    'PROJECT: none',
    'GOAL: Verify automatic handoff enforcement',
    outcome,
  ].join('\n');
}

let deliverWithInputs: HandoffMessageEnforcementDeps['deliverWithInputs'];
let review: HandoffMessageEnforcementDeps['review'];

function deps(
  options: {
    handoff?: HandoffRow;
    sender?: string;
    receiver?: string;
  } = {},
): HandoffMessageEnforcementDeps {
  const handoff = options.handoff ?? row();
  return {
    getHandoff: vi.fn(async () => handoff),
    deliverWithInputs,
    review,
    resolveParticipants: vi.fn(async () => ({
      senderAgentGroupId: options.sender ?? SOURCE,
      receiverAgentGroupId: options.receiver ?? REVIEWER,
    })),
  };
}

beforeEach(() => {
  deliverWithInputs = vi.fn(async () => row('delivered'));
  review = vi.fn(async () => row('approved'));
});

describe('parseTrackedHandoffMessage', () => {
  it('leaves ordinary agent conversation untracked', () => {
    expect(parseTrackedHandoffMessage('Can you pressure-test this idea?')).toEqual({
      tracked: false,
      fields: new Map(),
      reviewOutcome: undefined,
    });
  });

  it('accepts the labeled outcome line Echo actually posts (regression, 2026-09-15)', () => {
    // Verbatim shape of Echo's handback for handoff-1789503177574-b2315abc, which the
    // enforcer rejected with "review is missing its formal outcome".
    const parsed = parseTrackedHandoffMessage(
      [
        `HANDOFF_ID: ${ID}`,
        `FINGERPRINT: ${FINGERPRINT}`,
        'PROJECT: QuiverIQ',
        'GOAL: Negative verifier smoke test: Echo runs run_checks against QuiverIQ HEAD',
        '',
        'FORMAL REVIEW OUTCOME: CHANGES REQUIRED',
        'Host verdict: CHECK_FAILED (error_reason: NONE).',
        'record_sha256: fd07657e473b0eabf01a8471b325ae7a04c9b2331b39229c761bbbe3618c735f',
      ].join('\n'),
    );
    expect(parsed.tracked).toBe(true);
    expect(parsed.reviewOutcome).toBe('CHANGES REQUIRED');
  });

  it('accepts the labeled outcome with Slack bold and still rejects unrelated prefixes', () => {
    expect(
      parseTrackedHandoffMessage(`HANDOFF_ID: ${ID}\nFINGERPRINT: ${FINGERPRINT}\n*FORMAL REVIEW OUTCOME:* *APPROVED*`)
        .reviewOutcome,
    ).toBe('APPROVED');
    expect(
      parseTrackedHandoffMessage(
        `HANDOFF_ID: ${ID}\nFINGERPRINT: ${FINGERPRINT}\nOUTCOME: the retry path is APPROVED by tests`,
      ).reviewOutcome,
    ).toBeUndefined();
  });

  it('accepts light Slack markdown around field names and outcomes', () => {
    const parsed = parseTrackedHandoffMessage(
      `*HANDOFF_ID:* ${ID}\n*FINGERPRINT:* ${FINGERPRINT}\n- **APPROVED WITH MINOR NOTES**`,
    );
    expect(parsed.tracked).toBe(true);
    expect(parsed.fields.get('HANDOFF_ID')).toBe(ID);
    expect(parsed.reviewOutcome).toBe('APPROVED WITH MINOR NOTES');
  });
});

describe('automatic Slack handoff enforcement', () => {
  it('passes ordinary conversation without touching the ledger', async () => {
    const d = deps();
    const decision = await createHandoffMessageEnforcer(d)(context('Normal architecture discussion'));
    expect(decision).toEqual({ action: 'allow' });
    expect(d.getHandoff).not.toHaveBeenCalled();
  });

  it('validates Atlas → Echo and marks the exact package delivered before forwarding', async () => {
    const decision = await createHandoffMessageEnforcer(deps())(context(handoffText()));
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(deliverWithInputs).toHaveBeenCalledWith({
      id: ID,
      actor: SOURCE,
      fingerprint: FINGERPRINT,
      inputs: { class: 'complex', checkpoint: 'abc1234', checks: ['pnpm test'], reproduce: [] },
    });
    expect(review).not.toHaveBeenCalled();
  });

  it('preserves Slack paragraph boundaries so a HANDOFF_ID after an intro is not lost', async () => {
    const converter = new SlackFormatConverter();
    const raw = `Formal handoff <@U0ECHO>\n\n${handoffText()}`;
    const message = context(converter.extractPlainText(raw));
    message.message.content = {
      text: converter.extractPlainText(raw),
      formatted: converter.toAst(raw),
      author: { userId: 'B0ATLAS', isBot: true },
    };

    // This exact Slack converter shape used to collapse "@U0ECHO" and
    // "HANDOFF_ID" onto one line, so the line-oriented parser rejected it.
    expect((message.message.content as { text: string }).text).toContain('@U0ECHOHANDOFF_ID');

    const decision = await createHandoffMessageEnforcer(deps())(message);
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(deliverWithInputs).toHaveBeenCalledWith({
      id: ID,
      actor: SOURCE,
      fingerprint: FINGERPRINT,
      inputs: { class: 'complex', checkpoint: 'abc1234', checks: ['pnpm test'], reproduce: [] },
    });
  });

  it('recovers the first HANDOFF_ID when Slack serialization retains only collapsed plain text', async () => {
    const converter = new SlackFormatConverter();
    const raw = `Formal handoff <@U0ECHO>\n\n${handoffText()}`;
    const collapsed = converter.extractPlainText(raw);
    expect(collapsed).toContain('@U0ECHOHANDOFF_ID');

    const decision = await createHandoffMessageEnforcer(deps())(context(collapsed));
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(deliverWithInputs).toHaveBeenCalledWith({
      id: ID,
      actor: SOURCE,
      fingerprint: FINGERPRINT,
      inputs: { class: 'complex', checkpoint: 'abc1234', checks: ['pnpm test'], reproduce: [] },
    });
  });

  it('does not recover an inline HANDOFF_ID from an incomplete quoted example', () => {
    const parsed = parseTrackedHandoffMessage(`Example HANDOFF_ID: ${ID}\nFINGERPRINT: ${FINGERPRINT}`);
    expect(parsed.tracked).toBe(true);
    expect(parsed.fields.has('HANDOFF_ID')).toBe(false);
  });

  it('keeps separate Slack list items parseable when formatted content is present', async () => {
    const converter = new SlackFormatConverter();
    const raw = handoffText()
      .split('\n')
      .map((line) => `- ${line}`)
      .join('\n');
    const message = context(converter.extractPlainText(raw));
    message.message.content = {
      text: converter.extractPlainText(raw),
      formatted: converter.toAst(raw),
      author: { userId: 'B0ATLAS', isBot: true },
    };

    const decision = await createHandoffMessageEnforcer(deps())(message);
    expect(decision.action).toBe('allow');
  });

  it('validates Echo → Atlas and records the formal review before forwarding', async () => {
    const d = deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE });
    const echoContext = { ...context(reviewText()), instanceKey: 'slack', botId: 'B0ECHO' };
    const decision = await createHandoffMessageEnforcer(d)(echoContext);
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(review).toHaveBeenCalledWith(
      ID,
      REVIEWER,
      FINGERPRINT,
      'APPROVED',
      'Recorded automatically from the verified Slack handback',
    );
  });

  it('recovers a complete formal review whose HANDOFF_ID follows the Atlas mention', async () => {
    const d = deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE });
    const collapsedReview = `<@U0ATLAS> HANDOFF_ID: ${ID}\nFINGERPRINT: ${FINGERPRINT}\nPROJECT: none\nGOAL: Verify automatic handoff enforcement\n\nAPPROVED`;
    const echoContext = { ...context(collapsedReview), instanceKey: 'slack', botId: 'B0ECHO' };

    const decision = await createHandoffMessageEnforcer(d)(echoContext);
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(review).toHaveBeenCalledWith(
      ID,
      REVIEWER,
      FINGERPRINT,
      'APPROVED',
      'Recorded automatically from the verified Slack handback',
    );
  });

  it('blocks an incomplete formal package', async () => {
    const decision = await createHandoffMessageEnforcer(deps())(context(`HANDOFF_ID: ${ID}`));
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining('FINGERPRINT') });
    expect(deliverWithInputs).not.toHaveBeenCalled();
  });

  it('blocks a fingerprint mismatch', async () => {
    const decision = await createHandoffMessageEnforcer(deps())(context(handoffText({ FINGERPRINT: 'b'.repeat(64) })));
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining('FINGERPRINT') });
  });

  it('blocks a package sent in the wrong agent direction', async () => {
    const decision = await createHandoffMessageEnforcer(deps({ sender: 'ag-foreign', receiver: REVIEWER }))(
      context(handoffText()),
    );
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining('direction') });
  });

  it('blocks stale or duplicate delivery instead of replaying it', async () => {
    const decision = await createHandoffMessageEnforcer(deps({ handoff: row('delivered') }))(context(handoffText()));
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining('expected created') });
    expect(deliverWithInputs).not.toHaveBeenCalled();
  });
});

describe('blocked messages tell the sender why', () => {
  it('calls notifyRejection with the reason and handoff id when a review lacks its outcome', async () => {
    const notifyRejection = vi.fn(
      async (_ctx: SlackBotInboundContext, _reason: string, _handoffId?: string) => undefined,
    );
    const d = { ...deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE }), notifyRejection };
    const text = [
      `HANDOFF_ID: ${ID}`,
      `FINGERPRINT: ${FINGERPRINT}`,
      'PROJECT: none',
      'GOAL: Verify automatic handoff enforcement',
      'Looks fine to me',
    ].join('\n');
    const echoContext = { ...context(text), instanceKey: 'slack', botId: 'B0ECHO' };
    const decision = await createHandoffMessageEnforcer(d)(echoContext);
    expect(decision.action).toBe('drop');
    await new Promise((r) => setImmediate(r));
    expect(notifyRejection).toHaveBeenCalledTimes(1);
    expect(notifyRejection.mock.calls[0]![1]).toBe('review is missing its formal outcome');
    expect(notifyRejection.mock.calls[0]![2]).toBe(ID);
  });

  it('a failing notifier never changes the decision', async () => {
    const notifyRejection = vi.fn(async () => {
      throw new Error('slack down');
    });
    const d = { ...deps(), notifyRejection };
    const decision = await createHandoffMessageEnforcer(d)(context(`HANDOFF_ID: ${ID}\nAPPROVED`));
    expect(decision.action).toBe('drop');
    await new Promise((r) => setImmediate(r));
    expect(notifyRejection).toHaveBeenCalledTimes(1);
  });
});
