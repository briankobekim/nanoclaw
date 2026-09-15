/**
 * `delivered` and "the host knows what to run" are now one fact.
 *
 * Before this change the Slack enforcer marked a handoff delivered and threw
 * the CHECKS away, so a `delivered` row carried no evidence of what the author
 * claimed to have verified. The capture and the transition are now a single
 * transaction: either both happen or neither does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import { setBotInboundPolicy, wrapSlackBotGuard, type SlackBotInboundContext } from '../../channels/slack-a2a-guard.js';
import '../verifier/migration.js';
import {
  createHandoff,
  deliverHandoffWithInputs,
  fingerprintVerificationInputs,
  getHandoff,
  getVerificationInputs,
  listHandoffEvents,
  type HandoffRow,
} from './ledger.js';
import { createHandoffMessageEnforcer, type HandoffMessageEnforcementDeps } from './slack-enforcement.js';

const ATLAS = 'ag-atlas';
const ECHO = 'ag-echo';
const ID = 'HANDOFF-ATOMIC';

const GOOD_INPUTS = { class: 'fix', checkpoint: 'abc1234', checks: ['pnpm test'], reproduce: [] };

async function seed(): Promise<HandoffRow> {
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: ATLAS, name: 'Atlas', folder: 'atlas', agent_provider: null, created_at });
  await createAgentGroup({ id: ECHO, name: 'Echo', folder: 'echo', agent_provider: null, created_at });
  return createHandoff({
    id: ID,
    sourceAgentGroupId: ATLAS,
    reviewerAgentGroupId: ECHO,
    project: 'FIXTURE',
    goal: 'Capture and deliver atomically',
    outcome: 'A delivered handoff always has its inputs',
    scope: 'ledger only',
    authority: 'execute',
  });
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  setBotInboundPolicy(null);
});

describe('deliverHandoffWithInputs', () => {
  it('captures the inputs and delivers in one transaction', async () => {
    const row = await seed();
    const delivered = await deliverHandoffWithInputs({
      id: row.id,
      actor: ATLAS,
      fingerprint: row.fingerprint,
      inputs: GOOD_INPUTS,
    });

    expect(delivered.status).toBe('delivered');
    const inputs = await getVerificationInputs(row.id);
    expect(inputs).toMatchObject({
      class: 'fix',
      checkpoint: 'abc1234',
      checks_json: '["pnpm test"]',
      reproduce_json: '[]',
      captured_by: ATLAS,
    });
    expect(inputs!.inputs_fingerprint).toBe(fingerprintVerificationInputs(row.fingerprint, GOOD_INPUTS));

    const events = await listHandoffEvents(row.id);
    expect(events.map((e) => e.event_type)).toEqual(['created', 'delivered']);
    expect(JSON.parse(events[1]!.payload_json)).toEqual({
      fingerprint: row.fingerprint,
      inputs_fingerprint: inputs!.inputs_fingerprint,
    });
  });

  it('leaves nothing behind when CHECKS is invalid', async () => {
    const row = await seed();
    await expect(
      deliverHandoffWithInputs({
        id: row.id,
        actor: ATLAS,
        fingerprint: row.fingerprint,
        inputs: { ...GOOD_INPUTS, checks: [] },
      }),
    ).rejects.toThrow('CHECKS must contain at least one command');

    expect((await getHandoff(row.id))!.status).toBe('created');
    expect(await getVerificationInputs(row.id)).toBeUndefined();
    expect((await listHandoffEvents(row.id)).map((e) => e.event_type)).toEqual(['created']);
  });

  it('rolls back the inputs row when the transition itself fails', async () => {
    const row = await seed();
    // A second delivery: the status guard fires after the inputs INSERT, so
    // the rollback is what keeps the table from gaining an orphan row.
    await deliverHandoffWithInputs({ id: row.id, actor: ATLAS, fingerprint: row.fingerprint, inputs: GOOD_INPUTS });
    await expect(
      deliverHandoffWithInputs({
        id: row.id,
        actor: ATLAS,
        fingerprint: row.fingerprint,
        inputs: { ...GOOD_INPUTS, checks: ['pnpm test:other'] },
      }),
    ).rejects.toThrow('expected created');

    expect((await getVerificationInputs(row.id))!.checks_json).toBe('["pnpm test"]');
    expect((await listHandoffEvents(row.id)).filter((e) => e.event_type === 'delivered')).toHaveLength(1);
  });

  it('refuses a non-source actor and a fingerprint that is not the row’s', async () => {
    const row = await seed();
    await expect(
      deliverHandoffWithInputs({ id: row.id, actor: ECHO, fingerprint: row.fingerprint, inputs: GOOD_INPUTS }),
    ).rejects.toThrow('only the handoff source may perform this transition');
    await expect(
      deliverHandoffWithInputs({ id: row.id, actor: ATLAS, fingerprint: 'b'.repeat(64), inputs: GOOD_INPUTS }),
    ).rejects.toThrow('fingerprint mismatch');
    expect(await getVerificationInputs(row.id)).toBeUndefined();
  });

  it('refuses a row whose fields no longer hash to its stored fingerprint', async () => {
    const row = await seed();
    await getDb().run('UPDATE handoffs SET goal = ? WHERE id = ?', 'edited in place', row.id);
    await expect(
      deliverHandoffWithInputs({ id: row.id, actor: ATLAS, fingerprint: row.fingerprint, inputs: GOOD_INPUTS }),
    ).rejects.toThrow('does not match its own fields');
    expect((await getHandoff(row.id))!.status).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// The enforcement path
// ---------------------------------------------------------------------------

const FINGERPRINT = 'a'.repeat(64);

function enforcementRow(status: HandoffRow['status'] = 'created'): HandoffRow {
  return {
    id: ID,
    source_agent_group_id: ATLAS,
    reviewer_agent_group_id: ECHO,
    source_session_id: null,
    project: 'FIXTURE',
    goal: 'Capture and deliver atomically',
    outcome: 'A delivered handoff always has its inputs',
    scope: 'ledger only',
    authority: 'execute',
    fingerprint: FINGERPRINT,
    status,
    review_outcome: null,
    review_notes: null,
    closure_evidence: null,
    created_at: '2026-09-15T00:00:00.000Z',
    updated_at: '2026-09-15T00:00:00.000Z',
    closed_at: null,
    supersedes: null,
  };
}

function packageText(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    HANDOFF_ID: ID,
    FINGERPRINT,
    PROJECT: 'FIXTURE',
    GOAL: 'Capture and deliver atomically',
    OUTCOME: 'A delivered handoff always has its inputs',
    CLASS: 'fix',
    SCOPE: 'ledger only',
    AUTHORITY: 'execute',
    CHECKPOINT: 'abc1234',
    FILES: 'src/modules/handoff-ledger/ledger.ts',
    CHECKS: '["pnpm test"]',
    REPRODUCE: '[]',
    EVIDENCE: 'unit tests',
    RISKS: 'none known',
    FOLLOW_UP: 'Echo reviews',
    ...overrides,
  };
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function ctx(text: string): SlackBotInboundContext {
  return {
    instanceKey: 'slack-echo',
    platformId: 'slack:G0ROOM',
    threadId: null,
    botId: 'B0ATLAS',
    message: {
      id: 'msg-1',
      kind: 'chat-sdk',
      content: { text, author: { userId: 'B0ATLAS', isBot: true } },
      timestamp: '2026-09-15T00:00:00.000Z',
      isGroup: true,
    },
  };
}

function enforcementDeps(deliverWithInputs: HandoffMessageEnforcementDeps['deliverWithInputs']) {
  return {
    getHandoff: async () => enforcementRow(),
    deliverWithInputs,
    review: vi.fn(async () => enforcementRow('approved')),
    resolveParticipants: async () => ({ senderAgentGroupId: ATLAS, receiverAgentGroupId: ECHO }),
  } satisfies HandoffMessageEnforcementDeps;
}

describe('slack enforcement capture', () => {
  it('passes the parsed inputs to the atomic delivery', async () => {
    const deliverWithInputs = vi.fn(async () => enforcementRow('delivered'));
    const decision = await createHandoffMessageEnforcer(enforcementDeps(deliverWithInputs))(ctx(packageText()));
    expect(decision.action).toBe('allow');
    if (decision.action !== 'allow') throw new Error('expected allow');
    await decision.beforeForward?.();
    expect(deliverWithInputs).toHaveBeenCalledWith({
      id: ID,
      actor: ATLAS,
      fingerprint: FINGERPRINT,
      inputs: { class: 'fix', checkpoint: 'abc1234', checks: ['pnpm test'], reproduce: [] },
    });
  });

  it('rejects a prose CHECKS block at decision time, naming the error', async () => {
    const deliverWithInputs = vi.fn(async () => enforcementRow('delivered'));
    const decision = await createHandoffMessageEnforcer(enforcementDeps(deliverWithInputs))(
      ctx(packageText({ CHECKS: '- all checks passed manually' })),
    );
    expect(decision).toMatchObject({
      action: 'drop',
      reason: 'handoff enforcement: CHECKS must be a JSON array of command strings',
    });
    expect(deliverWithInputs).not.toHaveBeenCalled();
  });

  it('rejects a malformed CHECKPOINT and CLASS at decision time', async () => {
    const deliverWithInputs = vi.fn(async () => enforcementRow('delivered'));
    const enforcer = createHandoffMessageEnforcer(enforcementDeps(deliverWithInputs));
    expect(await enforcer(ctx(packageText({ CHECKPOINT: 'HEAD' })))).toMatchObject({
      reason: 'handoff enforcement: CHECKPOINT must match ^[0-9a-f]{7,40}$',
    });
    expect(await enforcer(ctx(packageText({ CLASS: 'Two Words' })))).toMatchObject({
      reason: 'handoff enforcement: CLASS must match ^[a-z][a-z0-9-]{0,31}$',
    });
    expect(deliverWithInputs).not.toHaveBeenCalled();
  });
});

describe('the bridge guard does not forward a message whose capture failed', () => {
  it('drops the inbound when beforeForward throws', async () => {
    const forwarded: InboundMessage[] = [];
    const setup: ChannelSetup = {
      onInbound: async (_platformId: string, _threadId: string | null, message: InboundMessage) => {
        forwarded.push(message);
      },
    } as unknown as ChannelSetup;

    setBotInboundPolicy({
      decideBotInbound: () => ({
        action: 'admit',
        beforeForward: async () => {
          throw new Error('CHECKS must contain at least one command');
        },
      }),
    });

    const wrapped = wrapSlackBotGuard(setup, 'slack-echo');
    const message = ctx(packageText()).message;
    await wrapped.onInbound('slack:G0ROOM', null, message);
    expect(forwarded).toHaveLength(0);
  });

  it('forwards when the capture succeeds', async () => {
    const forwarded: InboundMessage[] = [];
    const setup: ChannelSetup = {
      onInbound: async (_platformId: string, _threadId: string | null, message: InboundMessage) => {
        forwarded.push(message);
      },
    } as unknown as ChannelSetup;

    setBotInboundPolicy({
      decideBotInbound: () => ({ action: 'admit', beforeForward: async () => {} }),
    });

    const wrapped = wrapSlackBotGuard(setup, 'slack-echo');
    await wrapped.onInbound('slack:G0ROOM', null, ctx(packageText()).message);
    expect(forwarded).toHaveLength(1);
  });
});
