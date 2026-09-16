import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { memoryWrite } from './memory.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

const REQUEST_ID_RE = /^mw-\d+-[0-9a-f]{8}$/;

function replyFor(path: string, mode: string): string {
  return (
    `requested: memory_write ${path} (${mode}); nothing is stored until you receive a ` +
    `'held for Kobe's approval' or 'memory written' notice — if neither arrives within five minutes, ask again`
  );
}

describe('memory_write', () => {
  it('memory_write validates locally and emits one system action', async () => {
    const invalid: Record<string, unknown>[] = [
      { path: '../x.md', mode: 'append', content: 'x' },
      { path: '/etc/x.md', mode: 'append', content: 'x' },
      { path: 'a/../b.md', mode: 'append', content: 'x' },
      { path: 'notes.txt', mode: 'append', content: 'x' },
      { path: 'owner-statements.md', mode: 'append', content: 'x' },
      { path: 'notes.md', mode: 'exec', content: 'x' },
      { path: 'notes.md', mode: 'append' },
      { path: 'notes.md', mode: 'append', content: 'x'.repeat(2001) },
      { path: 'notes.md', mode: 'delete', content: 'x' },
    ];
    for (const args of invalid) {
      const result = await memoryWrite.handler(args);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);

    const append = await memoryWrite.handler({ path: 'notes.md', mode: 'append', content: 'one line' });
    expect(append.isError).not.toBe(true);
    expect(append.content[0].text).toBe(replyFor('notes.md', 'append'));
    let rows = getUndeliveredMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    const appendPayload = JSON.parse(rows[0].content);
    expect(appendPayload.request_id).toMatch(REQUEST_ID_RE);
    expect(appendPayload.request_id.length).toBeLessThanOrEqual(64);
    expect(appendPayload).toEqual({
      action: 'memory_write',
      request_id: appendPayload.request_id,
      path: 'notes.md',
      mode: 'append',
      content: 'one line',
    });

    const replace = await memoryWrite.handler({
      path: 'projects/atlas.md',
      mode: 'replace',
      content: '# Atlas\n\nrewritten',
    });
    expect(replace.isError).not.toBe(true);
    expect(replace.content[0].text).toBe(replyFor('projects/atlas.md', 'replace'));
    rows = getUndeliveredMessages();
    expect(rows).toHaveLength(2);
    expect(rows[1].kind).toBe('system');
    const replacePayload = JSON.parse(rows[1].content);
    expect(replacePayload.request_id).toMatch(REQUEST_ID_RE);
    expect(replacePayload.request_id).not.toBe(appendPayload.request_id);
    expect(replacePayload).toEqual({
      action: 'memory_write',
      request_id: replacePayload.request_id,
      path: 'projects/atlas.md',
      mode: 'replace',
      content: '# Atlas\n\nrewritten',
    });

    const del = await memoryWrite.handler({ path: 'scratch/old.md', mode: 'delete' });
    expect(del.isError).not.toBe(true);
    expect(del.content[0].text).toBe(replyFor('scratch/old.md', 'delete'));
    rows = getUndeliveredMessages();
    expect(rows).toHaveLength(3);
    expect(rows[2].kind).toBe('system');
    const deletePayload = JSON.parse(rows[2].content);
    expect(deletePayload.request_id).toMatch(REQUEST_ID_RE);
    expect(Object.keys(deletePayload).sort()).toEqual(['action', 'mode', 'path', 'request_id']);
    expect(deletePayload).toEqual({
      action: 'memory_write',
      request_id: deletePayload.request_id,
      path: 'scratch/old.md',
      mode: 'delete',
    });
  });

  it('refuses the remaining path and content edge cases without a row', async () => {
    const invalid: Record<string, unknown>[] = [
      { path: './x.md', mode: 'append', content: 'x' },
      { path: 'a/./b.md', mode: 'append', content: 'x' },
      { path: 'a\\b.md', mode: 'append', content: 'x' },
      { path: 'a//b.md', mode: 'append', content: 'x' },
      { path: 'a/', mode: 'append', content: 'x' },
      { path: 'sp ace.md', mode: 'append', content: 'x' },
      { path: 'x.MD', mode: 'append', content: 'x' },
      { path: '.md', mode: 'append', content: 'x' },
      { path: 'sub/owner-statements.md', mode: 'append', content: 'x' },
      { path: `${'a'.repeat(198)}.md`, mode: 'append', content: 'x' },
      { path: '', mode: 'append', content: 'x' },
      { path: 42, mode: 'append', content: 'x' },
      { path: 'notes.md', mode: 'replace' },
      { path: 'notes.md', mode: 'replace', content: 7 },
      { path: 'notes.md', mode: 'append', content: `${'x'.repeat(1999)}é` }, // 2001 bytes
      { path: 'notes.md', mode: 'delete', content: '' },
      { path: 'notes.md' },
      { path: 'notes.md', mode: '' },
    ];
    for (const args of invalid) {
      const result = await memoryWrite.handler(args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toStartWith('Error:');
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('accepts a path at the 200-character cap and content at exactly 2000 bytes', async () => {
    const path200 = `${'a'.repeat(197)}.md`;
    expect(path200.length).toBe(200);
    const at200 = await memoryWrite.handler({ path: path200, mode: 'append', content: 'x' });
    expect(at200.isError).not.toBe(true);

    const bytes2000 = `${'x'.repeat(1998)}é`;
    expect(Buffer.byteLength(bytes2000, 'utf8')).toBe(2000);
    const atCap = await memoryWrite.handler({ path: 'notes.md', mode: 'replace', content: bytes2000 });
    expect(atCap.isError).not.toBe(true);

    const rows = getUndeliveredMessages();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1].content).content).toBe(bytes2000);
  });

  it('declares a closed input schema with path, mode and optional content', () => {
    expect(memoryWrite.tool.name).toBe('memory_write');
    expect(memoryWrite.tool.inputSchema.required).toEqual(['path', 'mode']);
    expect(memoryWrite.tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(memoryWrite.tool.inputSchema.properties ?? {}).sort()).toEqual(['content', 'mode', 'path']);
  });
});
