/**
 * memory-mount-guard — no writable mount may alias a group's memory.
 *
 * Plan cases M2 and M3 (docs/specs/memory-provenance-gate/plan.md §5). The
 * mount lists here mirror what `buildMounts` composes for a normal session;
 * `src/container-runner.test.ts` does not exercise `buildMounts` with fixtures,
 * so the standard-set assertions live here against that hand-built mirror.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  MEMORY_CONTAINER_PATH,
  MemoryMountError,
  assertNoWritableMemoryAlias,
  listProtectedMemoryRoots,
} from './memory-mount-guard.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

interface Fixture {
  root: string;
  groupsDir: string;
  groupA: string;
  groupB: string;
  memoryA: string;
  memoryB: string;
  sessDir: string;
  install: string;
}

/** Two fake groups under a temp groups/ root, plus a session dir and an install root. */
function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-memory-guard-'));
  const groupsDir = path.join(root, 'groups');
  const groupA = path.join(groupsDir, 'group-a');
  const groupB = path.join(groupsDir, 'group-b');
  const memoryA = path.join(groupA, 'memory');
  const memoryB = path.join(groupB, 'memory');
  fs.mkdirSync(path.join(memoryA, 'system'), { recursive: true });
  fs.mkdirSync(memoryB, { recursive: true });
  // Entries listProtectedMemoryRoots must skip: a dot-entry and a plain file.
  fs.mkdirSync(path.join(groupsDir, '.hidden', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(groupsDir, 'README.md'), 'not a group\n');
  // A group without a memory dir yet is STILL a root: its prospective memory path is protected
  // so nothing can pre-populate it before the group's first spawn.
  fs.mkdirSync(path.join(groupsDir, 'group-c'));
  const sessDir = path.join(root, 'data', 'v2-sessions', 'agent-1', 'session-1');
  fs.mkdirSync(sessDir, { recursive: true });
  const install = path.join(root, 'install');
  fs.mkdirSync(path.join(install, 'container', 'agent-runner', 'src'), { recursive: true });
  fs.mkdirSync(path.join(install, 'container', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(groupA, 'container.json'), '{}\n');
  fs.writeFileSync(path.join(groupA, 'CLAUDE.md'), '# group\n');
  return { root, groupsDir, groupA, groupB, memoryA, memoryB, sessDir, install };
}

const scope = 'agent-1';

/** Mirrors the order `buildMounts` pushes for a default-surfaces session of group A. */
function standardMounts(f: Fixture): VolumeMount[] {
  return [
    { hostPath: f.sessDir, containerPath: '/workspace', readonly: false, mountClass: 'group-state', scope },
    {
      hostPath: path.join(f.sessDir, '.nanoclaw-session.json'),
      containerPath: '/app/.nanoclaw-session.json',
      readonly: true,
      mountClass: 'group-state',
      scope,
    },
    { hostPath: f.groupA, containerPath: '/workspace/agent', readonly: false, mountClass: 'group-state', scope },
    {
      hostPath: f.memoryA,
      containerPath: MEMORY_CONTAINER_PATH,
      readonly: true,
      mountClass: 'group-state',
      scope,
    },
    {
      hostPath: path.join(f.groupA, 'container.json'),
      containerPath: '/workspace/agent/container.json',
      readonly: true,
      mountClass: 'group-state',
      scope,
    },
    {
      hostPath: path.join(f.groupA, 'plugins'),
      containerPath: '/workspace/agent/plugins',
      readonly: true,
      mountClass: 'install-surface',
      scope,
    },
    {
      hostPath: path.join(f.groupA, 'CLAUDE.md'),
      containerPath: '/workspace/agent/CLAUDE.md',
      readonly: true,
      mountClass: 'group-state',
      scope,
    },
    {
      hostPath: path.join(f.install, 'container', 'CLAUDE.md'),
      containerPath: '/app/CLAUDE.md',
      readonly: true,
      mountClass: 'install-surface',
      scope,
    },
    {
      hostPath: path.join(f.root, 'data', 'v2-sessions', 'agent-1', '.claude-shared'),
      containerPath: '/home/node/.claude',
      readonly: false,
      mountClass: 'group-state',
      scope,
    },
    {
      hostPath: path.join(f.install, 'container', 'agent-runner', 'src'),
      containerPath: '/app/src',
      readonly: true,
      mountClass: 'install-surface',
      scope,
    },
    {
      hostPath: path.join(f.install, 'container', 'skills'),
      containerPath: '/app/skills',
      readonly: true,
      mountClass: 'install-surface',
      scope,
    },
    {
      hostPath: path.join(f.root, 'projects'),
      containerPath: '/workspace/projects',
      readonly: true,
      mountClass: 'allowlisted-extra',
      scope,
    },
  ];
}

function rwExtra(hostPath: string, containerPath = '/workspace/extra'): VolumeMount {
  return { hostPath, containerPath, readonly: false, mountClass: 'allowlisted-extra', scope };
}

describe('listProtectedMemoryRoots', () => {
  it('lists the canonical groups/*/memory path of every group dir, existing or not, skipping dot-entries and files', () => {
    const f = fixture();
    const roots = listProtectedMemoryRoots(f.groupsDir);
    expect(roots.sort()).toEqual(
      [
        fs.realpathSync(f.memoryA),
        fs.realpathSync(f.memoryB),
        path.join(fs.realpathSync(path.join(f.groupsDir, 'group-c')), 'memory'),
      ].sort(),
    );
  });

  it('returns nothing for a missing groups dir', () => {
    expect(listProtectedMemoryRoots(path.join(os.tmpdir(), 'ncl-does-not-exist-' + Date.now()))).toEqual([]);
  });
});

describe("M2 no writable mount may alias any group's memory by source, or the memory path by destination", () => {
  const sourceCases: Array<[string, (f: Fixture) => string]> = [
    ["this group's dir", (f) => f.groupA],
    ["this group's memory dir", (f) => f.memoryA],
    ['a subdirectory of the memory dir', (f) => path.join(f.memoryA, 'system')],
    ['a not-yet-existing path under the memory dir', (f) => path.join(f.memoryA, 'injected')],
    ["another group's memory dir", (f) => f.memoryB],
    ['an ancestor containing several groups', (f) => f.groupsDir],
    ['the root above the groups dir', (f) => f.root],
    ['a trailing-slash spelling of the memory dir', (f) => f.memoryA + '/'],
    ['a dot-dot spelling that resolves to the memory dir', (f) => path.join(f.groupB, '..', 'group-a', 'memory')],
  ];

  for (const [label, source] of sourceCases) {
    it(`aborts a RW extra whose source is ${label}`, () => {
      const f = fixture();
      const roots = listProtectedMemoryRoots(f.groupsDir);
      const extra = rwExtra(source(f));
      const mounts = [...standardMounts(f), extra];
      expect(() => assertNoWritableMemoryAlias(mounts, roots)).toThrow(MemoryMountError);
      expect(() => assertNoWritableMemoryAlias(mounts, roots)).toThrow(extra.hostPath);
    });
  }

  it("aborts a RW extra whose source is a symlink to a group's memory dir", () => {
    const f = fixture();
    const link = path.join(f.root, 'innocent-looking');
    fs.symlinkSync(f.memoryB, link);
    const mounts = [...standardMounts(f), rwExtra(link)];
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(MemoryMountError);
  });

  it('does not treat a sibling whose name merely starts with the root as an alias (/a/b vs /a/bc)', () => {
    const f = fixture();
    const sibling = f.memoryA + '-archive';
    fs.mkdirSync(sibling);
    const mounts = [...standardMounts(f), rwExtra(sibling)];
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).not.toThrow();
  });

  for (const dest of [MEMORY_CONTAINER_PATH, `${MEMORY_CONTAINER_PATH}/injected`, '/workspace/agent/memory/']) {
    it(`aborts a RW mount whose destination is ${dest}`, () => {
      const f = fixture();
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-elsewhere-'));
      const mounts = [...standardMounts(f), rwExtra(elsewhere, dest)];
      expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(
        MemoryMountError,
      );
      expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(dest);
    });
  }

  it('aborts a RW mount whose destination is an ancestor of the memory path other than the two shadowed ones', () => {
    const f = fixture();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-elsewhere-'));
    const mounts = [...standardMounts(f), rwExtra(elsewhere, '/workspace/agent/../agent')];
    // Normalizes to /workspace/agent — an ancestor, but it is a second RW
    // mount at that target placed AFTER the overlay, so the ordering check
    // rejects it rather than the alias check.
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(MemoryMountError);
  });

  it('accepts a RW extra elsewhere and the RO projects mount', () => {
    const f = fixture();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-elsewhere-'));
    const mounts = [...standardMounts(f), rwExtra(elsewhere)];
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).not.toThrow();
  });

  it("accepts a RO mount of a group's memory dir elsewhere (only writable aliases are refused)", () => {
    const f = fixture();
    const mounts = [...standardMounts(f), { ...rwExtra(f.memoryB, '/workspace/peer-memory'), readonly: true }];
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).not.toThrow();
  });
});

describe('M3 the standard mount set spawns', () => {
  it('passes the alias check with the memory overlay present and after both ancestors', () => {
    const f = fixture();
    const mounts = standardMounts(f);
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).not.toThrow();

    const overlay = mounts.findIndex((m) => m.containerPath === MEMORY_CONTAINER_PATH);
    expect(mounts[overlay].readonly).toBe(true);
    expect(overlay).toBeGreaterThan(mounts.findIndex((m) => m.containerPath === '/workspace'));
    expect(overlay).toBeGreaterThan(mounts.findIndex((m) => m.containerPath === '/workspace/agent'));
  });

  it('passes with no protected roots at all (first spawn on a fresh install)', () => {
    const f = fixture();
    expect(() => assertNoWritableMemoryAlias(standardMounts(f), [])).not.toThrow();
  });

  it('fails when the overlay is removed', () => {
    const f = fixture();
    const mounts = standardMounts(f).filter((m) => m.containerPath !== MEMORY_CONTAINER_PATH);
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(MemoryMountError);
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(/overlay/);
  });

  it('fails when the overlay is placed before /workspace/agent', () => {
    const f = fixture();
    const mounts = standardMounts(f);
    const overlayIndex = mounts.findIndex((m) => m.containerPath === MEMORY_CONTAINER_PATH);
    const [overlay] = mounts.splice(overlayIndex, 1);
    const agentIndex = mounts.findIndex((m) => m.containerPath === '/workspace/agent');
    mounts.splice(agentIndex, 0, overlay);
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(MemoryMountError);
  });

  it('fails when the overlay is placed before /workspace', () => {
    const f = fixture();
    const mounts = standardMounts(f);
    const overlayIndex = mounts.findIndex((m) => m.containerPath === MEMORY_CONTAINER_PATH);
    const [overlay] = mounts.splice(overlayIndex, 1);
    mounts.unshift(overlay);
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(MemoryMountError);
  });

  it('fails when a read-only ancestor is appended AFTER the overlay and would hide it', () => {
    // Docker resolves a later parent mount over an earlier child, so a
    // contributed read-only /workspace/agent placed after the overlay makes
    // /workspace/agent/memory come from that source, not the protected root.
    const f = fixture();
    const roots = listProtectedMemoryRoots(f.groupsDir);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-shadow-'));

    const afterAgent: VolumeMount[] = [
      ...standardMounts(f),
      { hostPath: elsewhere, containerPath: '/workspace/agent', readonly: true, mountClass: 'allowlisted-extra', scope },
    ];
    expect(() => assertNoWritableMemoryAlias(afterAgent, roots)).toThrow(MemoryMountError);
    expect(() => assertNoWritableMemoryAlias(afterAgent, roots)).toThrow(/must come after/);

    const afterWorkspace: VolumeMount[] = [
      ...standardMounts(f),
      { hostPath: elsewhere, containerPath: '/workspace', readonly: true, mountClass: 'allowlisted-extra', scope },
    ];
    expect(() => assertNoWritableMemoryAlias(afterWorkspace, roots)).toThrow(MemoryMountError);

    // The same read-only mount BEFORE the overlay is harmless: the overlay still wins.
    const beforeOverlay = standardMounts(f);
    const overlayIndex = beforeOverlay.findIndex((m) => m.containerPath === MEMORY_CONTAINER_PATH);
    beforeOverlay.splice(overlayIndex, 0, {
      hostPath: elsewhere,
      containerPath: '/workspace/agent',
      readonly: true,
      mountClass: 'allowlisted-extra',
      scope,
    });
    expect(() => assertNoWritableMemoryAlias(beforeOverlay, roots)).not.toThrow();
  });

  it('fails when the overlay is writable, and when it is duplicated', () => {
    const f = fixture();
    const roots = listProtectedMemoryRoots(f.groupsDir);
    const writable = standardMounts(f).map((m) =>
      m.containerPath === MEMORY_CONTAINER_PATH ? { ...m, readonly: false } : m,
    );
    expect(() => assertNoWritableMemoryAlias(writable, roots)).toThrow(MemoryMountError);

    const base = standardMounts(f);
    const duplicated = [...base, base.find((m) => m.containerPath === MEMORY_CONTAINER_PATH)!];
    expect(() => assertNoWritableMemoryAlias(duplicated, roots)).toThrow(/overlay/);
  });

  it('fails when a required ancestor mount is missing', () => {
    const f = fixture();
    const mounts = standardMounts(f).filter((m) => m.containerPath !== '/workspace/agent');
    expect(() => assertNoWritableMemoryAlias(mounts, listProtectedMemoryRoots(f.groupsDir))).toThrow(MemoryMountError);
  });
});
