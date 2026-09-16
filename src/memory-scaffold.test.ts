/**
 * memory-scaffold — the spawn preflight for `groups/<folder>/memory`.
 *
 * Plan case M1 (docs/specs/memory-provenance-gate/plan.md §5): the preflight
 * refuses any symlink in the tree, wrong types at `system/` and
 * `owner-statements.md`, an out-of-tree real path, and hard-linked files, and
 * scaffolds otherwise. Nothing is ever moved or deleted on a refusal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { log } from './log.js';
import {
  MemoryPreflightError,
  OWNER_STATEMENTS_FRONTMATTER,
  createFileNoFollow,
  prepareMemoryRoot,
  type PreflightDeps,
} from './memory-scaffold.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const TEMPLATES = path.join(process.cwd(), 'container', 'agent-runner', 'src', 'memory', 'templates');

/** A fresh temp root with a real group dir inside it. Never the real groups/. */
function fixture(): { root: string; groupDir: string; memory: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-memory-preflight-'));
  const groupDir = path.join(root, 'group');
  fs.mkdirSync(groupDir);
  return { root, groupDir, memory: path.join(groupDir, 'memory') };
}

function deps(): PreflightDeps & { notifyOwner: ReturnType<typeof vi.fn> } {
  return { notifyOwner: vi.fn().mockResolvedValue(undefined) };
}

/** Asserts a refusal: typed error naming `expectedPath`, one owner notice, one error log. */
async function expectRefused(groupDir: string, expectedPath: string): Promise<MemoryPreflightError> {
  vi.mocked(log.error).mockClear();
  const d = deps();
  let caught: unknown;
  try {
    await prepareMemoryRoot(groupDir, d);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MemoryPreflightError);
  const error = caught as MemoryPreflightError;
  expect(error.path).toBe(expectedPath);
  expect(error.message).toContain(expectedPath);
  expect(d.notifyOwner).toHaveBeenCalledTimes(1);
  expect(d.notifyOwner.mock.calls[0][0]).toContain(path.basename(groupDir));
  expect(d.notifyOwner.mock.calls[0][0]).toContain(expectedPath);
  expect(log.error).toHaveBeenCalledWith(
    'memory-gate preflight refused spawn',
    expect.objectContaining({ path: expectedPath }),
  );
  return error;
}

describe('M1 prepareMemoryRoot refuses any symlink in the tree, wrong types at system/ and owner-statements.md, an out-of-tree real path, and hard-linked files, and scaffolds otherwise', () => {
  it('refuses a symlinked root (even one pointing inside the group dir)', async () => {
    const { groupDir, memory } = fixture();
    const real = path.join(groupDir, 'real-memory');
    fs.mkdirSync(real);
    fs.symlinkSync(real, memory);

    await expectRefused(groupDir, memory);
    // Nothing moved: the symlink is still there, the target untouched.
    expect(fs.lstatSync(memory).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it('refuses memory/system → elsewhere', async () => {
    const { root, groupDir, memory } = fixture();
    fs.mkdirSync(memory);
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(memory, 'system'));

    await expectRefused(groupDir, path.join(memory, 'system'));
    expect(fs.lstatSync(path.join(memory, 'system')).isSymbolicLink()).toBe(true);
  });

  it('refuses owner-statements.md → index.md', async () => {
    const { groupDir, memory } = fixture();
    fs.mkdirSync(memory);
    fs.writeFileSync(path.join(memory, 'index.md'), '# index\n');
    fs.symlinkSync('index.md', path.join(memory, 'owner-statements.md'));

    await expectRefused(groupDir, path.join(memory, 'owner-statements.md'));
    expect(fs.readFileSync(path.join(memory, 'index.md'), 'utf8')).toBe('# index\n');
  });

  it('refuses a symlinked leaf file deep in the tree', async () => {
    const { root, groupDir, memory } = fixture();
    fs.mkdirSync(path.join(memory, 'notes'), { recursive: true });
    const target = path.join(root, 'secret.md');
    fs.writeFileSync(target, 'secret\n');
    const leaf = path.join(memory, 'notes', 'a.md');
    fs.symlinkSync(target, leaf);

    await expectRefused(groupDir, leaf);
    expect(fs.lstatSync(leaf).isSymbolicLink()).toBe(true);
  });

  it('refuses a regular file at memory/system', async () => {
    const { groupDir, memory } = fixture();
    fs.mkdirSync(memory);
    fs.writeFileSync(path.join(memory, 'system'), 'not a dir\n');

    await expectRefused(groupDir, path.join(memory, 'system'));
    expect(fs.readFileSync(path.join(memory, 'system'), 'utf8')).toBe('not a dir\n');
  });

  it('refuses a directory at memory/owner-statements.md', async () => {
    const { groupDir, memory } = fixture();
    fs.mkdirSync(path.join(memory, 'owner-statements.md'), { recursive: true });

    await expectRefused(groupDir, path.join(memory, 'owner-statements.md'));
  });

  it('refuses an out-of-tree real path (memory is a symlink to a dir outside the group)', async () => {
    const { root, groupDir, memory } = fixture();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, memory);

    const error = await expectRefused(groupDir, memory);
    expect(error.reason).toMatch(/symlink|outside/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a hard-linked file', async () => {
    const { root, groupDir, memory } = fixture();
    fs.mkdirSync(memory);
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, 'shared inode\n');
    const linked = path.join(memory, 'a.md');
    fs.linkSync(outside, linked);
    expect(fs.statSync(linked).nlink).toBe(2);

    await expectRefused(groupDir, linked);
    expect(fs.readFileSync(outside, 'utf8')).toBe('shared inode\n');
  });

  it('scaffolds otherwise: creates missing templates and owner-statements.md, leaves an existing index.md byte-identical', async () => {
    const { groupDir, memory } = fixture();
    fs.mkdirSync(memory);
    const existingIndex = '---\nokf_version: "0.1"\n---\n\n# Mine\n\nDo not touch.\n';
    fs.writeFileSync(path.join(memory, 'index.md'), existingIndex);
    const d = deps();

    const result = await prepareMemoryRoot(groupDir, d);

    expect(result).toBe(fs.realpathSync(memory));
    expect(d.notifyOwner).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(memory, 'index.md'), 'utf8')).toBe(existingIndex);
    expect(fs.lstatSync(path.join(memory, 'system')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(memory, 'system', 'index.md'))).toEqual(
      fs.readFileSync(path.join(TEMPLATES, 'system', 'index.md')),
    );
    expect(fs.readFileSync(path.join(memory, 'system', 'definition.md'))).toEqual(
      fs.readFileSync(path.join(TEMPLATES, 'system', 'definition.md')),
    );
    expect(fs.readFileSync(path.join(memory, 'owner-statements.md'), 'utf8')).toBe(
      '---\ntype: owner-statements\n---\n',
    );
    expect(OWNER_STATEMENTS_FRONTMATTER).toBe('---\ntype: owner-statements\n---\n');
  });

  it('creates the memory dir itself when absent and is idempotent on a second run', async () => {
    const { groupDir, memory } = fixture();
    const d = deps();

    await prepareMemoryRoot(groupDir, d);
    const snapshot = Object.fromEntries(
      ['index.md', 'system/index.md', 'system/definition.md', 'owner-statements.md'].map((rel) => [
        rel,
        fs.readFileSync(path.join(memory, rel), 'utf8'),
      ]),
    );
    expect(snapshot['index.md']).toBe(fs.readFileSync(path.join(TEMPLATES, 'index.md'), 'utf8'));

    // Mutate the scaffolded files; a second preflight must not overwrite them.
    fs.appendFileSync(path.join(memory, 'owner-statements.md'), '\n## Brian\n\n- fact\n');
    await prepareMemoryRoot(groupDir, d);
    expect(fs.readFileSync(path.join(memory, 'owner-statements.md'), 'utf8')).toBe(
      snapshot['owner-statements.md'] + '\n## Brian\n\n- fact\n',
    );
    expect(fs.readFileSync(path.join(memory, 'index.md'), 'utf8')).toBe(snapshot['index.md']);
    expect(d.notifyOwner).not.toHaveBeenCalled();
  });

  it('logs and still throws when the owner notice itself fails', async () => {
    const { groupDir, memory } = fixture();
    fs.symlinkSync(path.join(groupDir, 'nowhere'), memory);
    const d: PreflightDeps = { notifyOwner: vi.fn().mockRejectedValue(new Error('adapter down')) };

    await expect(prepareMemoryRoot(groupDir, d)).rejects.toBeInstanceOf(MemoryPreflightError);
    expect(log.error).toHaveBeenCalledWith('memory-gate preflight owner notice failed', expect.anything());
  });

  it('a symlink introduced after preflight makes a no-follow create fail closed', async () => {
    const { root, groupDir, memory } = fixture();
    await prepareMemoryRoot(groupDir, deps());
    const target = path.join(root, 'victim.md');
    fs.writeFileSync(target, 'untouched\n');
    fs.symlinkSync(target, path.join(memory, 'x.md'));

    expect(() => createFileNoFollow(path.join(memory, 'x.md'), 'injected\n')).toThrow(/EEXIST|ELOOP/);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched\n');
  });
});
