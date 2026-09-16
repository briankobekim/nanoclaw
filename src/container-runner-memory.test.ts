/**
 * Plan §5 M3 against the REAL mount builder: buildMounts scaffolds memory,
 * places the read-only overlay after the group mount, and its final alias
 * check accepts the standard set; composeSessionSpec re-checks the merged list.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-container-runner-memory';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-container-runner-memory/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-container-runner-memory/groups',
  };
});

import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { buildMounts, composeSessionSpec } from './container-runner.js';
import { assertNoWritableMemoryAlias, listProtectedMemoryRoots, MEMORY_CONTAINER_PATH } from './memory-mount-guard.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

const agentGroup: AgentGroup = {
  id: 'ag-real',
  name: 'Real',
  folder: 'real',
  agent_provider: null,
  created_at: '2026-09-16T00:00:00.000Z',
} as AgentGroup;
const session: Session = {
  id: 'sess-real',
  agent_group_id: 'ag-real',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-09-16T00:00:00.000Z',
} as Session;
const containerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
} as unknown as ContainerConfig;
const groupDir = path.join(TEST_ROOT, 'groups', 'real');

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
  fs.mkdirSync(groupDir, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('the standard mount set spawns (real buildMounts)', () => {
  it('scaffolds memory, mounts it read-only after the group mount, and passes both alias checks', async () => {
    // codex provides its own agent surfaces, so buildMounts skips the CLAUDE.md composer here.
    const mounts = await buildMounts(agentGroup, session, containerConfig, 'codex', {});
    const targets = mounts.map((m) => m.containerPath);
    const agentIdx = targets.indexOf('/workspace/agent');
    const overlayIdx = targets.indexOf(MEMORY_CONTAINER_PATH);
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(overlayIdx).toBeGreaterThan(agentIdx);
    expect(mounts[overlayIdx]!.readonly).toBe(true);
    expect(mounts[overlayIdx]!.hostPath).toBe(path.join(groupDir, 'memory'));
    expect(fs.existsSync(path.join(groupDir, 'memory', 'owner-statements.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'memory', 'system', 'definition.md'))).toBe(true);

    const spec = composeSessionSpec({
      agentGroup,
      session,
      containerName: 'nanoclaw-v2-real-1',
      mounts,
      containerConfig,
      mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
      contribution: {} as never,
      gateway: {} as never,
    });
    expect(spec.containers[0]!.mounts.some((m) => m.containerPath === MEMORY_CONTAINER_PATH && m.mode === 'ro')).toBe(
      true,
    );
  });

  it('a gateway contribution that would shadow the overlay with a writable ancestor is refused', async () => {
    const mounts = await buildMounts(agentGroup, session, containerConfig, 'codex', {});
    expect(() =>
      composeSessionSpec({
        agentGroup,
        session,
        containerName: 'nanoclaw-v2-real-2',
        mounts,
        containerConfig,
        mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
        contribution: {} as never,
        gateway: {
          mounts: [
            {
              class: 'allowlisted-extra',
              hostPath: path.join(TEST_ROOT, 'elsewhere'),
              containerPath: '/workspace/agent',
              mode: 'rw',
              groupScope: 'ag-real',
            },
          ],
        } as never,
      }),
    ).toThrow(/memory overlay/);
  });

  it('a read-only gateway replacement of the overlay backed by another directory is refused', async () => {
    const mounts = await buildMounts(agentGroup, session, containerConfig, 'codex', {});
    fs.mkdirSync(path.join(groupDir, 'scratch'), { recursive: true });
    expect(() =>
      composeSessionSpec({
        agentGroup,
        session,
        containerName: 'nanoclaw-v2-real-3',
        mounts,
        containerConfig,
        mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
        contribution: {} as never,
        gateway: {
          mounts: [
            {
              class: 'allowlisted-extra',
              hostPath: path.join(groupDir, 'scratch'),
              containerPath: MEMORY_CONTAINER_PATH,
              mode: 'ro',
              groupScope: 'ag-real',
            },
          ],
        } as never,
      }),
    ).toThrow(/backed by/);
  });

  it('a group that has never spawned is protected before its memory directory exists', async () => {
    fs.mkdirSync(path.join(TEST_ROOT, 'groups', 'never-spawned'), { recursive: true });
    const roots = listProtectedMemoryRoots();
    expect(roots).toContain(path.join(fs.realpathSync(TEST_ROOT), 'groups', 'never-spawned', 'memory'));
    const mounts = await buildMounts(agentGroup, session, containerConfig, 'codex', {});
    const withExtra = [
      ...mounts,
      {
        hostPath: path.join(TEST_ROOT, 'groups', 'never-spawned'),
        containerPath: '/workspace/extra/other',
        readonly: false,
      },
    ];
    expect(() =>
      assertNoWritableMemoryAlias(withExtra, roots, { expectedOverlaySource: path.join(groupDir, 'memory') }),
    ).toThrow(/aliases protected memory root/);
  });

  it('a symlinked memory root refuses the spawn', async () => {
    fs.symlinkSync(path.join(TEST_ROOT, 'outside'), path.join(groupDir, 'memory'));
    await expect(buildMounts(agentGroup, session, containerConfig, 'codex', {})).rejects.toThrow(/symlink/);
  });
});
