import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { runChecks } from './verify.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('run_checks', () => {
  it('queues a system action carrying only the handoff id', async () => {
    const result = await runChecks.handler({ handoff_id: 'COS-07-2026-09-15' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe(
      'queued: run_checks COS-07-2026-09-15; the host will reply with a system message',
    );
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toEqual({
      action: 'run_checks',
      handoff_id: 'COS-07-2026-09-15',
    });
  });

  it('refuses an id that could be read as a path or a shell fragment', async () => {
    const bad = [
      '.',
      '..',
      '-x',
      '.hidden',
      'a/b',
      'x'.repeat(65),
      '../../etc/passwd',
      'a b',
      'id;rm -rf /',
      '$(whoami)',
      '',
    ];
    for (const id of bad) {
      const result = await runChecks.handler({ handoff_id: id });
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('accepts a normal id and an id exactly at the 64-character cap', async () => {
    for (const good of ['COS-07-2026-09-15', `a${'x'.repeat(63)}`]) {
      const result = await runChecks.handler({ handoff_id: good });
      expect(result.isError).not.toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(2);
  });

  it('declares a closed input schema with handoff_id as the only property', () => {
    expect(runChecks.tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        handoff_id: { type: 'string', description: 'The handoff id from the formal handoff package' },
      },
      required: ['handoff_id'],
      additionalProperties: false,
    });
  });
});
