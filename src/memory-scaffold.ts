/**
 * Memory scaffold and spawn preflight for `groups/<folder>/memory`.
 *
 * Plan §4.2 (docs/specs/memory-provenance-gate/plan.md). Runs on the host
 * before the read-only memory overlay is mounted. The whole tree is walked
 * with `lstat`: a symlink anywhere, a non-directory at the root or at
 * `memory/system`, a non-regular file at `memory/owner-statements.md`, a real
 * path outside the group's real directory, or any regular file with a link
 * count above one refuses the spawn. Nothing is moved or deleted on refusal.
 * When the tree is clean, the missing pieces are created: `memory/system`, the
 * three shipped templates, and `memory/owner-statements.md`. Every host write
 * opens its target without following symlinks, so a link created between
 * preflight and write cannot redirect it.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/**
 * `config.ts` keeps PROJECT_ROOT private; `buildMounts` reads the install
 * root the same way, so the templates dir resolves against the same root as
 * every other release surface.
 */
const PROJECT_ROOT = process.cwd();
const TEMPLATES_DIR = path.join(PROJECT_ROOT, 'container', 'agent-runner', 'src', 'memory', 'templates');
/**
 * Relative to both the templates dir and the group's memory dir. These files
 * are recreated from the shipped templates whenever they are missing, so a
 * delete of one can never stick; the memory gate refuses such deletes.
 */
export const TEMPLATE_FILES = ['index.md', 'system/index.md', 'system/definition.md'] as const;

export const OWNER_STATEMENTS_FRONTMATTER = '---\ntype: owner-statements\n---\n';

export interface PreflightDeps {
  /** One owner notice per refusal. The lead wires the real delivery adapter. */
  notifyOwner(text: string): Promise<void>;
}

const logOnlyDeps: PreflightDeps = {
  async notifyOwner(text) {
    log.warn('memory-gate preflight owner notice (no notifier wired)', { text });
  },
};

export class MemoryPreflightError extends Error {
  constructor(
    public readonly reason: string,
    public readonly path: string,
  ) {
    super(`memory preflight refused: ${reason} at ${path}`);
    this.name = 'MemoryPreflightError';
  }
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Scaffold temp files live at the root of `memory/` itself: that tree is
 * mounted read-only into every container, so a temp (or a leftover one) can
 * never be a container-writable alias of an installed file. The group
 * directory would be the wrong place: it is mounted read-write.
 */
const SCAFFOLD_TEMP_PREFIX = '.memory-scaffold-';
const SCAFFOLD_TEMP_RE = /^\.memory-scaffold-[0-9a-f]{16}\.tmp$/;

/**
 * Create `p` with `content` so that the destination is either fully written
 * and fsynced or absent, never a short or unsynced file: the bytes go to an
 * exclusive temp file in `tempDir` (the memory root), are fsynced there, and
 * are then installed with `link` (which fails with EEXIST when anything, a
 * symlink included, is already at `p`: callers only ever create, never
 * overwrite or follow). After the install the temp name MUST go and the
 * destination must have exactly one name; otherwise this throws so that no
 * spawn or completion proceeds, and the next preflight heals the two-name
 * state by inode (see `healScaffoldTemps`).
 */
export function createFileNoFollow(p: string, content: string | Buffer, tempDir: string): void {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const tmp = path.join(tempDir, `${SCAFFOLD_TEMP_PREFIX}${randomBytes(8).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  let open = true;
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    open = false;
    fs.closeSync(fd);
    fs.linkSync(tmp, p);
  } catch (err) {
    if (open) {
      try {
        fs.closeSync(fd);
        // eslint-disable-next-line no-catch-all/no-catch-all -- the original failure is what matters; the descriptor is gone either way
      } catch (closeErr) {
        log.warn('memory scaffold: close failed after a failed write', { path: tmp, err: closeErr });
      }
    }
    try {
      fs.unlinkSync(tmp);
      // eslint-disable-next-line no-catch-all/no-catch-all -- nothing was installed; a leftover temp under the read-only overlay is inert
    } catch (cleanupErr) {
      log.warn('memory scaffold: could not remove a temp file', { path: tmp, err: cleanupErr });
    }
    throw err;
  }
  // Installed. The second name must disappear before anyone may rely on the tree.
  fs.unlinkSync(tmp);
  const names = fs.lstatSync(p).nlink;
  if (names !== 1) throw new Error(`scaffold file has ${names} names after install: ${p}`);
}

/**
 * A crash or failed unlink between `link` and the temp's removal leaves a
 * scaffold file with two names; the walk would refuse it as hard-linked.
 * Remove only a temp that is PROVEN ours: same device and inode as one of
 * the files this scaffold installs. Any other leftover is left alone. A
 * failure here propagates: the tree is not accepted until it is healed.
 */
function healScaffoldTemps(memoryPath: string): void {
  const names = fs.readdirSync(memoryPath).filter((name) => SCAFFOLD_TEMP_RE.test(name));
  if (names.length === 0) return;
  const installed = [...TEMPLATE_FILES, 'owner-statements.md']
    .map((rel) => lstatOrNull(path.join(memoryPath, rel)))
    .filter((st): st is fs.Stats => st !== null && st.isFile());
  for (const name of names) {
    const tmp = path.join(memoryPath, name);
    const st = lstatOrNull(tmp);
    if (!st || !st.isFile() || st.nlink < 2) continue;
    if (!installed.some((target) => target.ino === st.ino && target.dev === st.dev)) continue;
    log.warn('memory scaffold: removing the second name of an installed scaffold file', { path: tmp });
    fs.unlinkSync(tmp);
  }
}

/** One preflight per group at a time, so two concurrent runs never scaffold the same tree side by side. */
const preflightChains = new Map<string, Promise<unknown>>();

/**
 * Make a directory's entries durable. A new directory or file lives in its
 * parent's metadata until that parent is fsynced; without this a crash could
 * lose a freshly scaffolded `memory/` after the ledger already relied on it.
 */
function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Re-verify, right before a write, that `p` is a real directory (not a link). */
function assertRealDirectory(p: string): void {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) {
    throw new MemoryPreflightError('expected a real directory before writing', p);
  }
}

/**
 * Preflight + scaffold. Resolves to the real path of the memory root, or
 * rejects with `MemoryPreflightError` after logging and one owner notice.
 */
export async function prepareMemoryRoot(groupDir: string, deps: PreflightDeps = logOnlyDeps): Promise<string> {
  const key = path.resolve(groupDir);
  const previous = preflightChains.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => prepareMemoryRootSerialized(groupDir, deps),
    () => prepareMemoryRootSerialized(groupDir, deps),
  );
  preflightChains.set(key, run);
  try {
    return await run;
  } finally {
    if (preflightChains.get(key) === run) preflightChains.delete(key);
  }
}

async function prepareMemoryRootSerialized(groupDir: string, deps: PreflightDeps): Promise<string> {
  const memoryPath = path.join(groupDir, 'memory');

  const refuse = async (reason: string, p: string): Promise<never> => {
    log.error('memory-gate preflight refused spawn', { path: p, reason, groupDir });
    try {
      await deps.notifyOwner(`Memory preflight refused a spawn for ${path.basename(groupDir)}: ${reason} at ${p}`);
      // eslint-disable-next-line no-catch-all/no-catch-all -- the refusal must be thrown whatever the notifier does
    } catch (err) {
      log.error('memory-gate preflight owner notice failed', { err, path: p, reason });
    }
    throw new MemoryPreflightError(reason, p);
  };

  // Root: create when absent (a real directory), then inspect without following.
  if (lstatOrNull(memoryPath) === null) {
    fs.mkdirSync(memoryPath);
  }
  const rootStat = fs.lstatSync(memoryPath);
  if (rootStat.isSymbolicLink()) return refuse('memory root is a symlink', memoryPath);
  if (!rootStat.isDirectory()) return refuse('memory root is not a directory', memoryPath);

  const realGroupDir = fs.realpathSync(groupDir);
  const realMemory = fs.realpathSync(memoryPath);
  if (!realMemory.startsWith(realGroupDir + path.sep)) {
    return refuse(`memory root resolves outside the group directory (${realGroupDir})`, memoryPath);
  }

  healScaffoldTemps(memoryPath);

  // The two fixed entries have fixed types when present.
  const systemDir = path.join(memoryPath, 'system');
  const systemStat = lstatOrNull(systemDir);
  if (systemStat && !systemStat.isDirectory()) {
    return refuse(
      systemStat.isSymbolicLink() ? 'memory/system is a symlink' : 'memory/system is not a directory',
      systemDir,
    );
  }
  const ownerStatements = path.join(memoryPath, 'owner-statements.md');
  const ownerStat = lstatOrNull(ownerStatements);
  if (ownerStat && !ownerStat.isFile()) {
    return refuse(
      ownerStat.isSymbolicLink() ? 'owner-statements.md is a symlink' : 'owner-statements.md is not a regular file',
      ownerStatements,
    );
  }

  // Whole-tree walk: no symlinks, no hard links, no special files.
  const pending: string[] = [memoryPath];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const name of fs.readdirSync(dir).sort()) {
      const entry = path.join(dir, name);
      const st = fs.lstatSync(entry);
      if (st.isSymbolicLink()) return refuse('symlink inside memory tree', entry);
      if (st.isDirectory()) {
        pending.push(entry);
        continue;
      }
      if (!st.isFile()) return refuse('special file inside memory tree', entry);
      if (st.nlink > 1) return refuse(`hard-linked file (link count ${st.nlink})`, entry);
    }
  }

  // Scaffold what is missing. Every creation is exclusive and non-following;
  // an entry that appeared since the walk surfaces as EEXIST, never a rewrite.
  // Every created file is fsynced, then system/, memory/ and the group
  // directory are fsynced bottom-up on EVERY run (a previous run may have
  // created them and crashed or failed before its own fsync), so the tree is
  // durable before any op can be applied against it.
  const createdSystem = systemStat === null;
  if (createdSystem) {
    fs.mkdirSync(systemDir);
  }
  for (const rel of TEMPLATE_FILES) {
    const destination = path.join(memoryPath, rel);
    // Present already (the walk above verified its type): nothing to write.
    // A file that appears between this check and the install still surfaces
    // as EEXIST from the exclusive install, never as a rewrite.
    if (lstatOrNull(destination) !== null) continue;
    assertRealDirectory(path.dirname(destination));
    try {
      createFileNoFollow(destination, fs.readFileSync(path.join(TEMPLATES_DIR, rel)), memoryPath);
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
  }
  if (ownerStat === null) {
    assertRealDirectory(memoryPath);
    createFileNoFollow(ownerStatements, OWNER_STATEMENTS_FRONTMATTER, memoryPath);
  }
  fsyncDirectory(systemDir);
  fsyncDirectory(memoryPath);
  fsyncDirectory(groupDir);

  return realMemory;
}
