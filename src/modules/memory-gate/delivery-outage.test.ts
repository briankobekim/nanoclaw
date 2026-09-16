/**
 * Plan §5 G16 through the REAL delivery loop: one memory_write system row,
 * a host database that throws while the hold is being requested, three
 * delivery attempts, a permanent-failure mark, and never a "held" notice.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-memory-gate-delivery';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-memory-gate-delivery',
    GROUPS_DIR: '/tmp/nanoclaw-test-memory-gate-delivery/groups',
  };
});

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import '../approvals/index.js';
import './index.js';
import { setMemoryGateDeps } from './request.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-out', name: 'Out', folder: 'out', agent_provider: null, created_at: now() });
  setDeliveryAdapter({ deliver: async () => undefined } as never);
});

afterEach(async () => {
  setMemoryGateDeps();
  vi.restoreAllMocks();
  await closeDb();
});

describe('a database outage on a fresh request never produces a false held notice', () => {
  it('the real delivery loop retries three times, marks the row failed, logs, and never says held', async () => {
    const { session } = await resolveSession('ag-out', null, null, 'shared');
    const dbPath = outboundDbPath('ag-out', session.id);
    const out = new Database(dbPath);
    out
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
         VALUES (?, datetime('now'), 'system', ?, 'agent', ?)`,
      )
      .run(
        'out-mw-1',
        'ag-out',
        JSON.stringify({
          action: 'memory_write',
          request_id: 'mw-outage',
          path: 'notes.md',
          mode: 'append',
          content: 'x',
        }),
      );
    out.close();

    const notices: string[] = [];
    setMemoryGateDeps({
      isQuiesced: async () => {
        throw new Error('db down');
      },
      notifyAgent: async (_s, text) => {
        notices.push(text);
      },
    });
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

    for (let attempt = 1; attempt <= 3; attempt += 1) await deliverSessionMessages(session);

    // Delivery bookkeeping (the `delivered` table) lives in the session's inbound database.
    const status = new Database(inboundDbPath('ag-out', session.id), { readonly: true })
      .prepare('SELECT status FROM delivered WHERE message_out_id = ?')
      .get('out-mw-1') as { status: string } | undefined;
    expect(status?.status).toBe('failed');
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('will retry'))).toHaveLength(2);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('failed permanently'))).toBe(true);
    expect(notices.some((n) => n.includes('held'))).toBe(false);

    // A fourth pass does nothing: the row is terminal.
    await deliverSessionMessages(session);
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('will retry'))).toHaveLength(2);
  });
});
