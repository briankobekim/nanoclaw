import { SlackFormatConverter } from '@chat-adapter/slack';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlackBotInboundContext } from '../../channels/slack-a2a-guard.js';
import type { HandoffRow } from './ledger.js';
import {
  createHandoffMessageEnforcer,
  parseTrackedHandoffMessage,
  type HandoffMessageEnforcementDeps,
} from './slack-enforcement.js';

const SOURCE = 'ag-source';
const REVIEWER = 'ag-reviewer';
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
    outcome: 'A trusted review reaches the source',
    scope: 'NanoClaw only',
    authority: 'execute',
    fingerprint: FINGERPRINT,
    status,
    review_outcome: null,
    review_notes: null,
    reservation_kind: null,
    reservation_generation: 0,
    reservation_expires_at: null,
    closure_evidence: null,
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    closed_at: null,
  };
}

function context(text: string): SlackBotInboundContext {
  return {
    instanceKey: 'slack-reviewer',
    platformId: 'slack:G0ROOM',
    threadId: null,
    botId: 'B0SOURCE',
    message: {
      id: 'msg-1',
      kind: 'chat-sdk',
      content: { text, author: { userId: 'B0SOURCE', isBot: true } },
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
    OUTCOME: 'A trusted review reaches the source',
    CLASS: 'complex',
    SCOPE: 'NanoClaw only',
    AUTHORITY: 'execute',
    CHECKPOINT: 'abc123',
    FILES: 'src/example.ts',
    CHECKS: 'focused tests passed',
    REPRODUCE: 'n/a',
    EVIDENCE: 'verified locally',
    RISKS: 'none known',
    FOLLOW_UP: 'Reviewer checks the result',
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

let reserveDelivery: HandoffMessageEnforcementDeps['reserveDelivery'];
let completeDelivery: HandoffMessageEnforcementDeps['completeDelivery'];
let releaseDelivery: HandoffMessageEnforcementDeps['releaseDelivery'];
let reserveReview: HandoffMessageEnforcementDeps['reserveReview'];
let completeReview: HandoffMessageEnforcementDeps['completeReview'];
let releaseReview: HandoffMessageEnforcementDeps['releaseReview'];

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
    reserveDelivery,
    completeDelivery,
    releaseDelivery,
    reserveReview,
    completeReview,
    releaseReview,
    resolveParticipants: vi.fn(async () => ({
      senderAgentGroupId: options.sender ?? SOURCE,
      receiverAgentGroupId: options.receiver ?? REVIEWER,
    })),
  };
}

beforeEach(() => {
  reserveDelivery = vi.fn(async () => ({
    ...row('created'),
    reservation_kind: 'delivery' as const,
    reservation_generation: 1,
  }));
  completeDelivery = vi.fn(async () => row('delivered'));
  releaseDelivery = vi.fn(async () => row('created'));
  reserveReview = vi.fn(async () => ({
    ...row('delivered'),
    reservation_kind: 'review' as const,
    reservation_generation: 1,
  }));
  completeReview = vi.fn(async () => row('approved'));
  releaseReview = vi.fn(async () => row('delivered'));
});

describe('parseTrackedHandoffMessage', () => {
  it('leaves ordinary agent conversation untracked', () => {
    expect(parseTrackedHandoffMessage('Can you pressure-test this idea?')).toEqual({
      tracked: false,
      fields: new Map(),
      reviewOutcome: undefined,
    });
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

  it('reserves source → reviewer before forwarding and completes only after receipt', async () => {
    const decision = await createHandoffMessageEnforcer(deps())(context(handoffText()));
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    expect(decision.requiredAgentGroupId).toBe(REVIEWER);
    await decision.beforeForward?.();
    expect(reserveDelivery).toHaveBeenCalledWith(ID, SOURCE, FINGERPRINT);
    expect(completeDelivery).not.toHaveBeenCalled();
    await decision.onAccepted?.();
    expect(completeDelivery).toHaveBeenCalledWith(ID, SOURCE, FINGERPRINT, 1);
    expect(reserveReview).not.toHaveBeenCalled();
  });

  it('releases a reserved delivery when the required recipient does not accept it', async () => {
    const decision = await createHandoffMessageEnforcer(deps())(context(handoffText()));
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    await decision.onRejected?.();
    expect(releaseDelivery).toHaveBeenCalledWith(
      ID,
      SOURCE,
      FINGERPRINT,
      1,
      'required reviewer did not accept routed message',
    );
    expect(completeDelivery).not.toHaveBeenCalled();
  });

  it('preserves Slack paragraph boundaries so a HANDOFF_ID after an intro is not lost', async () => {
    const converter = new SlackFormatConverter();
    const raw = `Formal handoff <@U0REVIEWER>\n\n${handoffText()}`;
    const message = context(converter.extractPlainText(raw));
    message.message.content = {
      text: converter.extractPlainText(raw),
      formatted: converter.toAst(raw),
      author: { userId: 'B0SOURCE', isBot: true },
    };

    // This exact Slack converter shape used to collapse "@U0REVIEWER" and
    // "HANDOFF_ID" onto one line, so the line-oriented parser rejected it.
    expect((message.message.content as { text: string }).text).toContain('@U0REVIEWERHANDOFF_ID');

    const decision = await createHandoffMessageEnforcer(deps())(message);
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(reserveDelivery).toHaveBeenCalledWith(ID, SOURCE, FINGERPRINT);
  });

  it('recovers the first HANDOFF_ID when Slack serialization retains only collapsed plain text', async () => {
    const converter = new SlackFormatConverter();
    const raw = `Formal handoff <@U0REVIEWER>\n\n${handoffText()}`;
    const collapsed = converter.extractPlainText(raw);
    expect(collapsed).toContain('@U0REVIEWERHANDOFF_ID');

    const decision = await createHandoffMessageEnforcer(deps())(context(collapsed));
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(reserveDelivery).toHaveBeenCalledWith(ID, SOURCE, FINGERPRINT);
  });

  it('does not recover an inline HANDOFF_ID from an incomplete quoted example', () => {
    const parsed = parseTrackedHandoffMessage(`Example HANDOFF_ID: ${ID}\nFINGERPRINT: ${FINGERPRINT}`);
    expect(parsed.tracked).toBe(true);
    expect(parsed.fields.has('HANDOFF_ID')).toBe(false);
  });

  it('does not recover HANDOFF_ID from a quoted line beside an otherwise complete review', () => {
    const parsed = parseTrackedHandoffMessage(
      `> HANDOFF_ID: ${ID}\nFINGERPRINT: ${FINGERPRINT}\nPROJECT: none\nGOAL: Verify automatic handoff enforcement\nAPPROVED`,
    );
    expect(parsed.fields.has('HANDOFF_ID')).toBe(false);
  });

  it('does not recover HANDOFF_ID from fenced code beside an otherwise complete contract', () => {
    const withoutId = handoffText()
      .split('\n')
      .filter((line) => !line.startsWith('HANDOFF_ID:'))
      .join('\n');
    const parsed = parseTrackedHandoffMessage(`\`\`\`text\nHANDOFF_ID: ${ID}\n\`\`\`\n${withoutId}`);
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
      author: { userId: 'B0SOURCE', isBot: true },
    };

    const decision = await createHandoffMessageEnforcer(deps())(message);
    expect(decision.action).toBe('allow');
  });

  it('reserves reviewer → source before forwarding and completes only after receipt', async () => {
    const d = deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE });
    const reviewerContext = { ...context(reviewText()), instanceKey: 'slack', botId: 'B0REVIEWER' };
    const decision = await createHandoffMessageEnforcer(d)(reviewerContext);
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    expect(decision.requiredAgentGroupId).toBe(SOURCE);
    await decision.beforeForward?.();
    expect(reserveReview).toHaveBeenCalledWith(
      ID,
      REVIEWER,
      FINGERPRINT,
      'APPROVED',
      'Recorded automatically from the verified Slack handback',
    );
    expect(completeReview).not.toHaveBeenCalled();
    await decision.onAccepted?.();
    expect(completeReview).toHaveBeenCalledWith(ID, REVIEWER, FINGERPRINT, 1);
  });

  it('releases a reserved review when the source does not accept it', async () => {
    const d = deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE });
    const reviewerContext = { ...context(reviewText()), instanceKey: 'slack', botId: 'B0REVIEWER' };
    const decision = await createHandoffMessageEnforcer(d)(reviewerContext);
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    await decision.onRejected?.();
    expect(releaseReview).toHaveBeenCalledWith(
      ID,
      REVIEWER,
      FINGERPRINT,
      1,
      'required source did not accept routed review',
    );
    expect(completeReview).not.toHaveBeenCalled();
  });

  it('recovers a complete formal review whose HANDOFF_ID follows the source mention', async () => {
    const d = deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE });
    const collapsedReview = `<@U0SOURCE> HANDOFF_ID: ${ID}\nFINGERPRINT: ${FINGERPRINT}\nPROJECT: none\nGOAL: Verify automatic handoff enforcement\n\nAPPROVED`;
    const reviewerContext = { ...context(collapsedReview), instanceKey: 'slack', botId: 'B0REVIEWER' };

    const decision = await createHandoffMessageEnforcer(d)(reviewerContext);
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(reserveReview).toHaveBeenCalledWith(
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
    expect(reserveDelivery).not.toHaveBeenCalled();
  });

  it('blocks a fingerprint mismatch', async () => {
    const decision = await createHandoffMessageEnforcer(deps())(context(handoffText({ FINGERPRINT: 'b'.repeat(64) })));
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining('FINGERPRINT') });
  });

  it.each([
    ['OUTCOME', 'altered outcome'],
    ['SCOPE', 'untrusted extra scope'],
    ['AUTHORITY', 'deploy production'],
  ])('blocks a %s value that is not bound to the fingerprint', async (field, value) => {
    const decision = await createHandoffMessageEnforcer(deps())(context(handoffText({ [field]: value })));
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining(field) });
    expect(reserveDelivery).not.toHaveBeenCalled();
  });

  it('blocks duplicate contract fields', async () => {
    const decision = await createHandoffMessageEnforcer(deps())(
      context(`${handoffText()}\nAUTHORITY: deploy production`),
    );
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining('duplicate fields') });
  });

  it('blocks contradictory formal review outcomes', async () => {
    const d = deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE });
    const decision = await createHandoffMessageEnforcer(d)(context(`${reviewText('CHANGES REQUIRED')}\nAPPROVED`));
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining('multiple') });
    expect(reserveReview).not.toHaveBeenCalled();
  });

  it('blocks a duplicated formal review outcome', async () => {
    const d = deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE });
    const decision = await createHandoffMessageEnforcer(d)(context(`${reviewText()}\nAPPROVED`));
    expect(decision).toMatchObject({ action: 'drop', reason: expect.stringContaining('multiple') });
    expect(reserveReview).not.toHaveBeenCalled();
  });

  it('treats a formatted blockquote review as non-executable conversation', async () => {
    const converter = new SlackFormatConverter();
    const quoted = reviewText()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const reviewerContext = context(converter.extractPlainText(quoted));
    reviewerContext.message.content = {
      text: converter.extractPlainText(quoted),
      formatted: converter.toAst(quoted),
      author: { userId: 'B0REVIEWER', isBot: true },
    };
    const d = deps({ handoff: row('delivered'), sender: REVIEWER, receiver: SOURCE });

    expect(await createHandoffMessageEnforcer(d)(reviewerContext)).toEqual({ action: 'allow' });
    expect(reserveReview).not.toHaveBeenCalled();
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
    expect(reserveDelivery).not.toHaveBeenCalled();
  });
});
