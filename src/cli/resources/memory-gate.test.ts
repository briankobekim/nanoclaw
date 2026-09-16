import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { guard } from '../../guard/index.js';
import { isQuiesced } from '../../modules/memory-gate/quiesce.js';
import { commandGuard, lookup } from '../registry.js';
import '../../modules/memory-gate/migration.js';
import './memory-gate.js';

// The verb is exercised at the registry + guard level, exactly what dispatch.ts
// runs, without importing dispatch.ts itself: its static graph reaches the
// router and the memory-gate barrel, which does not belong to this test.

const COMMAND = 'memory-gate-quiesce';
const HOST = { caller: 'host' as const };
const AGENT = { kind: 'agent' as const, agentGroupId: 'ag-x', sessionId: 'sess-x' };

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('ncl memory-gate quiesce', () => {
  it('flips the barrier for a host caller and refuses every agent caller', async () => {
    const cmd = lookup(COMMAND)!;
    expect(cmd).toBeDefined();
    expect(cmd.hostOnly).toBe(true);
    expect(cmd.access).toBe('hidden');

    expect(await cmd.handler(cmd.parseArgs({ state: 'on' }), HOST)).toEqual({ quiesced: true });
    expect(await isQuiesced()).toBe(true);
    expect(await cmd.handler(cmd.parseArgs({ state: 'off' }), HOST)).toEqual({ quiesced: false });
    expect(await isQuiesced()).toBe(false);

    expect(() => cmd.parseArgs({ state: 'maybe' })).toThrow(/--state must be one of: on, off/);
    expect(() => cmd.parseArgs({})).toThrow(/--state is required/);

    const host = await guard(commandGuard(COMMAND), { actor: { kind: 'host' }, payload: { state: 'on' }, grant: null });
    expect(host.effect).toBe('allow');

    // hostOnly denies ANY container caller, whatever its cli_scope, and a
    // grant cannot satisfy a deny.
    const agent = await guard(commandGuard(COMMAND), { actor: AGENT, payload: { state: 'on' }, grant: null });
    expect(agent.effect).toBe('deny');
    if (agent.effect === 'deny') expect(agent.reason).toContain('operator-only');
    expect(await isQuiesced()).toBe(false);
  });
});
