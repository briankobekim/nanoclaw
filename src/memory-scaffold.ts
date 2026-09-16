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
 * Create `p` with `content`, refusing to follow a symlink at `p`
 * (`O_CREAT|O_EXCL` already refuses a symlink; `O_NOFOLLOW` is belt and
 * braces). Throws EEXIST when anything is already there, so callers only ever
 * create — never overwrite.
 */
export function createFileNoFollow(p: string, content: string | Buffer): void {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(p, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (err) {
    // The file is ours (created exclusively a moment ago) and is either short
    // or unsynced: remove it so the next run must create and fsync it again
    // instead of accepting it as already present.
    fs.closeSync(fd);
    try {
      fs.unlinkSync(p);
      // eslint-disable-next-line no-catch-all/no-catch-all -- the original failure is what matters; a failed cleanup is logged with it
    } catch (cleanupErr) {
      log.error('memory scaffold: could not remove a partially written file', { path: p, err: cleanupErr });
    }
    throw err;
  }
  fs.closeSync(fd);
}

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
    assertRealDirectory(path.dirname(destination));
    try {
      createFileNoFollow(destination, fs.readFileSync(path.join(TEMPLATES_DIR, rel)));
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
  }
  if (ownerStat === null) {
    assertRealDirectory(memoryPath);
    createFileNoFollow(ownerStatements, OWNER_STATEMENTS_FRONTMATTER);
  }
  fsyncDirectory(systemDir);
  fsyncDirectory(memoryPath);
  fsyncDirectory(groupDir);

  return realMemory;
}
