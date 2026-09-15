/**
 * The verifier config decides which host directories get mounted into a
 * container, so it is held to the same bar as a private key: owned by this
 * uid, no group or other bits, and every project path re-checked against the
 * existing mount allowlist with readonly forced on.
 *
 * MOUNT_ALLOWLIST_PATH is a module-level const in production; the mount
 * module's own test uses this getter-mock pattern to point it at a temp file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ allowlistPath: '' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../config.js');
  return {
    ...actual,
    get MOUNT_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

import { loadVerifierConfig } from './config.js';

let tmpDir: string;
let repoDir: string;
let outsideDir: string;
let configPath: string;

function writeConfig(doc: unknown, mode = 0o600): string {
  fs.writeFileSync(configPath, JSON.stringify(doc), { mode });
  fs.chmodSync(configPath, mode);
  return configPath;
}

function baseDoc(projects?: Record<string, unknown>): Record<string, unknown> {
  return {
    echoGroupId: 'ag-echo',
    atlasGroupId: 'ag-atlas',
    projects: projects ?? { ILLYSIUM: { hostPath: repoDir, mount: 'illysium' } },
  };
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-verifier-cfg-')));
  repoDir = path.join(tmpDir, 'allowed', 'repo');
  outsideDir = path.join(tmpDir, 'outside', 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  configPath = path.join(tmpDir, 'verifier.json');

  mockState.allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
  fs.writeFileSync(
    mockState.allowlistPath,
    JSON.stringify({
      allowedRoots: [{ path: path.join(tmpDir, 'allowed'), allowReadWrite: true }],
      blockedPatterns: [],
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('verifier config file permissions', () => {
  it('accepts mode 0600', () => {
    const cfg = loadVerifierConfig(writeConfig(baseDoc(), 0o600));
    expect(cfg.echoGroupId).toBe('ag-echo');
    expect(cfg.projects.ILLYSIUM!.realHostPath).toBe(repoDir);
  });

  it('rejects mode 0644', () => {
    expect(() => loadVerifierConfig(writeConfig(baseDoc(), 0o644))).toThrow(/group- or world-accessible/);
  });

  it('rejects a directory and a missing file', () => {
    expect(() => loadVerifierConfig(tmpDir)).toThrow(/not a regular file/);
    expect(() => loadVerifierConfig(path.join(tmpDir, 'absent.json'))).toThrow(/cannot read/);
  });
});

describe('verifier config contents', () => {
  it('rejects malformed agent group ids', () => {
    for (const bad of ['echo', 'ag_echo', 'ag-', '', 'ag-echo/../x']) {
      expect(() => loadVerifierConfig(writeConfig({ ...baseDoc(), echoGroupId: bad }))).toThrow(
        /echoGroupId must match/,
      );
      expect(() => loadVerifierConfig(writeConfig({ ...baseDoc(), atlasGroupId: bad }))).toThrow(
        /atlasGroupId must match/,
      );
    }
  });

  it('rejects an echo and atlas group that are the same agent', () => {
    expect(() => loadVerifierConfig(writeConfig({ ...baseDoc(), atlasGroupId: 'ag-echo' }))).toThrow(/must differ/);
  });

  it('rejects a project hostPath outside the mount allowlist', () => {
    expect(() =>
      loadVerifierConfig(writeConfig(baseDoc({ ILLYSIUM: { hostPath: outsideDir, mount: 'illysium' } }))),
    ).toThrow(/project ILLYSIUM mount rejected: .*not under any allowed root/);
  });

  it('rejects a project whose hostPath does not exist', () => {
    expect(() =>
      loadVerifierConfig(
        writeConfig(baseDoc({ ILLYSIUM: { hostPath: path.join(tmpDir, 'allowed', 'gone'), mount: 'illysium' } })),
      ),
    ).toThrow(/project ILLYSIUM mount rejected: .*does not exist/);
  });

  it('forces read-only even when the allowlist root permits read-write', () => {
    // The allowlist root above is allowReadWrite: true; the verifier still
    // asks for readonly, so validateMount resolves the mount read-only.
    const cfg = loadVerifierConfig(writeConfig(baseDoc()));
    expect(cfg.projects.ILLYSIUM!.mount).toBe('illysium');
  });

  it('applies limit defaults and validates overrides', () => {
    expect(loadVerifierConfig(writeConfig(baseDoc())).limits).toEqual({
      wallSeconds: 900,
      perCommandSeconds: 300,
      cpus: '1',
      memory: '1g',
      pids: 256,
      outputBytes: 1_048_576,
    });
    expect(loadVerifierConfig(writeConfig({ ...baseDoc(), limits: { wallSeconds: 20 } })).limits.wallSeconds).toBe(20);
    expect(() => loadVerifierConfig(writeConfig({ ...baseDoc(), limits: { wallSeconds: 0 } }))).toThrow(
      /wallSeconds must be a positive integer/,
    );
    expect(() => loadVerifierConfig(writeConfig({ ...baseDoc(), limits: { memory: '1g; rm -rf /' } }))).toThrow(
      /memory must be a docker size\/cpu token/,
    );
  });

  it('rejects malformed JSON and a non-object document', () => {
    fs.writeFileSync(configPath, 'not json', { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    expect(() => loadVerifierConfig(configPath)).toThrow(/not valid JSON/);
    expect(() => loadVerifierConfig(writeConfig([1, 2, 3]))).toThrow(/must contain a JSON object/);
  });

  it('reads NANOCLAW_VERIFIER_CONFIG when no path is injected', () => {
    vi.stubEnv('NANOCLAW_VERIFIER_CONFIG', writeConfig(baseDoc()));
    expect(loadVerifierConfig().atlasGroupId).toBe('ag-atlas');
  });
});
