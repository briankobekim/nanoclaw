/**
 * Memory mount guard — no writable mount may alias a group's memory.
 *
 * Plan §4.2 (docs/specs/memory-provenance-gate/plan.md). The memory directory
 * is mounted read-only at `/workspace/agent/memory` on top of the writable
 * group mount. That overlay is only meaningful if no OTHER writable mount
 * reaches the same bytes: neither by host source (the same directory, an
 * ancestor of it, or a subdirectory of it — for EVERY group's memory on the
 * host, not only the spawning group's) nor by container destination (the
 * memory path, an ancestor of it, or a path beneath it). The two required
 * ancestors, `/workspace` and `/workspace/agent`, are the exception: they are
 * exactly what the overlay shadows, so the guard also asserts the overlay is
 * present, read-only, unique, and ordered after both of them.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

export const MEMORY_CONTAINER_PATH = '/workspace/agent/memory';

/** The only writable mounts allowed to contain the memory path: shadowed by the overlay. */
const SHADOWED_ANCESTORS: readonly string[] = ['/workspace', '/workspace/agent'];

export class MemoryMountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryMountError';
  }
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

/** Real paths of every existing `<groupsDir>/<group>/memory` directory. */
export function listProtectedMemoryRoots(groupsDir: string = GROUPS_DIR): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(groupsDir);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
  const roots: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const memoryDir = path.join(groupsDir, name, 'memory');
    let st: fs.Stats;
    try {
      st = fs.statSync(memoryDir);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw err;
    }
    if (!st.isDirectory()) continue;
    roots.push(fs.realpathSync(memoryDir));
  }
  return roots;
}

/**
 * Canonical form of a host path for comparison: the real path when it
 * exists; otherwise the real path of its deepest existing ancestor with the
 * remaining segments appended, so a not-yet-created path under a symlinked
 * parent still resolves to where it would land.
 */
function canonicalHostPath(hostPath: string): string {
  const absolute = path.resolve(hostPath);
  const missing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    const parent = path.dirname(probe);
    if (parent === probe) return absolute; // hit the filesystem root without finding anything real
    missing.push(path.basename(probe));
    probe = parent;
  }
}

/** Container destinations are POSIX; strip a trailing slash so `/x/` and `/x` compare equal. */
function normalizeContainerPath(containerPath: string): string {
  const normalized = path.posix.normalize(containerPath);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/** Segment-wise: `a` equals `b`, or `a` is an ancestor of `b`. `/a/b` is not an ancestor of `/a/bc`. */
function isEqualOrAncestor(a: string, b: string, sep: string): boolean {
  if (a === b) return true;
  const prefix = a.endsWith(sep) ? a : a + sep;
  return b.startsWith(prefix);
}

function overlaps(a: string, b: string, sep: string): boolean {
  return isEqualOrAncestor(a, b, sep) || isEqualOrAncestor(b, a, sep);
}

function describeMount(mount: VolumeMount): string {
  return `${mount.hostPath} -> ${mount.containerPath} (rw${mount.mountClass ? `, ${mount.mountClass}` : ''})`;
}

/**
 * Throws `MemoryMountError` if any writable mount aliases a protected memory
 * root by source or the memory path by destination, or if the read-only
 * memory overlay is missing, writable, duplicated, or ordered before either
 * of the two ancestors it shadows. Pass `requireOverlay: false` for a list
 * assembled elsewhere (the post-gateway merge in composeSessionSpec) where
 * buildMounts has already proven the overlay and only aliasing can change.
 */
export function assertNoWritableMemoryAlias(
  mounts: readonly VolumeMount[],
  protectedRoots: readonly string[],
  options: { requireOverlay?: boolean } = {},
): void {
  const requireOverlay = options.requireOverlay ?? true;
  const roots = protectedRoots.map((root) => path.resolve(root));
  let lastWorkspace = -1;
  let lastAgent = -1;
  const overlayIndices: number[] = [];

  mounts.forEach((mount, index) => {
    const destination = normalizeContainerPath(mount.containerPath);
    if (destination === MEMORY_CONTAINER_PATH) overlayIndices.push(index);
    if (destination === '/workspace') lastWorkspace = index;
    if (destination === '/workspace/agent') lastAgent = index;

    if (mount.readonly !== false) return;
    if (SHADOWED_ANCESTORS.includes(destination)) return;

    const source = canonicalHostPath(mount.hostPath);
    for (const root of roots) {
      if (overlaps(source, root, path.sep)) {
        throw new MemoryMountError(
          `writable mount ${describeMount(mount)} aliases protected memory root ${root} by host source (resolved ${source})`,
        );
      }
    }
    if (overlaps(destination, MEMORY_CONTAINER_PATH, '/')) {
      throw new MemoryMountError(
        `writable mount ${describeMount(mount)} aliases ${MEMORY_CONTAINER_PATH} by container destination (normalized ${destination})`,
      );
    }
  });

  if (!requireOverlay) return;
  if (overlayIndices.length !== 1) {
    throw new MemoryMountError(
      `expected exactly one read-only memory overlay at ${MEMORY_CONTAINER_PATH}, found ${overlayIndices.length}`,
    );
  }
  const overlayIndex = overlayIndices[0];
  const overlay = mounts[overlayIndex];
  if (overlay.readonly !== true) {
    throw new MemoryMountError(`memory overlay at ${MEMORY_CONTAINER_PATH} must be read-only`);
  }
  if (lastWorkspace === -1 || lastAgent === -1) {
    throw new MemoryMountError(
      `memory overlay requires both ancestor mounts /workspace and /workspace/agent (found workspace=${lastWorkspace >= 0}, agent=${lastAgent >= 0})`,
    );
  }
  if (overlayIndex < lastWorkspace || overlayIndex < lastAgent) {
    throw new MemoryMountError(
      `memory overlay (index ${overlayIndex}) must come after /workspace (index ${lastWorkspace}) and /workspace/agent (index ${lastAgent})`,
    );
  }
}
