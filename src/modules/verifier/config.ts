/**
 * Host configuration for the bounded verifier.
 *
 * Lives beside `mount-allowlist.json` in `~/.config/nanoclaw/`, which is on
 * the mount module's blocked-pattern list, so no container can be handed the
 * directory that decides which repositories the verifier will read.
 *
 * Everything here fails closed: a missing file, a group-readable file, a file
 * owned by someone else, a malformed id, or a project path the mount allowlist
 * rejects all throw. The caller turns the throw into a refusal record.
 *
 *   {
 *     "echoGroupId": "ag-echo",
 *     "atlasGroupId": "ag-atlas",
 *     "projects": { "ILLYSIUM": { "hostPath": "~/src/illysium", "mount": "illysium" } },
 *     "limits": { "wallSeconds": 900 }
 *   }
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { validateMount } from '../mount-security/index.js';

export interface VerifierLimits {
  wallSeconds: number;
  perCommandSeconds: number;
  cpus: string;
  memory: string;
  pids: number;
  outputBytes: number;
}

export interface VerifierProject {
  /** As written in the config file. */
  hostPath: string;
  /** Container path stem handed to `validateMount`; the verifier always mounts at /src. */
  mount: string;
  /** `validateMount`'s resolved realpath — the only path ever given to docker. */
  realHostPath: string;
}

export interface VerifierConfig {
  echoGroupId: string;
  atlasGroupId: string;
  projects: Record<string, VerifierProject>;
  limits: VerifierLimits;
}

export const DEFAULT_LIMITS: VerifierLimits = {
  wallSeconds: 900,
  perCommandSeconds: 300,
  cpus: '1',
  memory: '1g',
  pids: 256,
  outputBytes: 1_048_576,
};

const GROUP_ID_PATTERN = /^ag-[A-Za-z0-9-]+$/;
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function defaultVerifierConfigPath(): string {
  return process.env.NANOCLAW_VERIFIER_CONFIG || path.join(os.homedir(), '.config', 'nanoclaw', 'verifier.json');
}

function requireGroupId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GROUP_ID_PATTERN.test(value)) {
    throw new Error(`verifier config: ${field} must match ^ag-[A-Za-z0-9-]+$`);
  }
  return value;
}

function positiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`verifier config: limits.${field} must be a positive integer`);
  }
  return value;
}

function sizeToken(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[0-9]+(\.[0-9]+)?[bkmgBKMG]?$/.test(value)) {
    throw new Error(`verifier config: limits.${field} must be a docker size/cpu token`);
  }
  return value;
}

/**
 * The config file decides which host directories the verifier will read, so it
 * is held to the same bar as an SSH key: a regular file, owned by this uid,
 * with no group or other bits.
 */
function assertSecureFile(configPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch (err) {
    throw new Error(`verifier config: cannot read ${configPath}`, { cause: err });
  }
  if (!stat.isFile()) throw new Error(`verifier config: ${configPath} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `verifier config: ${configPath} must not be group- or world-accessible (mode ${(stat.mode & 0o777)
        .toString(8)
        .padStart(4, '0')})`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`verifier config: ${configPath} must be owned by uid ${uid} (owner is ${stat.uid})`);
  }
}

export function loadVerifierConfig(configPath = defaultVerifierConfigPath()): VerifierConfig {
  assertSecureFile(configPath);

  const text = fs.readFileSync(configPath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`verifier config: ${configPath} is not valid JSON`, { cause: err });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`verifier config: ${configPath} must contain a JSON object`);
  }
  const doc = raw as Record<string, unknown>;

  const echoGroupId = requireGroupId(doc.echoGroupId, 'echoGroupId');
  const atlasGroupId = requireGroupId(doc.atlasGroupId, 'atlasGroupId');
  if (echoGroupId === atlasGroupId) throw new Error('verifier config: echoGroupId and atlasGroupId must differ');

  const rawProjects = doc.projects;
  if (typeof rawProjects !== 'object' || rawProjects === null || Array.isArray(rawProjects)) {
    throw new Error('verifier config: projects must be an object');
  }
  const projects: Record<string, VerifierProject> = {};
  for (const [name, entry] of Object.entries(rawProjects as Record<string, unknown>)) {
    if (!PROJECT_NAME_PATTERN.test(name)) {
      throw new Error(`verifier config: project name ${JSON.stringify(name)} is not a plain identifier`);
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`verifier config: project ${name} must be an object`);
    }
    const { hostPath, mount } = entry as Record<string, unknown>;
    if (typeof hostPath !== 'string' || !hostPath.trim()) {
      throw new Error(`verifier config: project ${name} needs a hostPath`);
    }
    if (typeof mount !== 'string' || !mount.trim()) {
      throw new Error(`verifier config: project ${name} needs a mount`);
    }
    // Readonly is forced, never read from the allowlist root's allowReadWrite.
    const validation = validateMount({ hostPath, containerPath: mount, readonly: true });
    if (!validation.allowed || !validation.realHostPath) {
      throw new Error(`verifier config: project ${name} mount rejected: ${validation.reason}`);
    }
    if (validation.effectiveReadonly === false) {
      throw new Error(`verifier config: project ${name} resolved read-write; the verifier mounts read-only only`);
    }
    projects[name] = { hostPath, mount, realHostPath: validation.realHostPath };
  }

  const rawLimits = doc.limits ?? {};
  if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) {
    throw new Error('verifier config: limits must be an object');
  }
  const l = rawLimits as Record<string, unknown>;
  const limits: VerifierLimits = {
    wallSeconds: positiveInt(l.wallSeconds, 'wallSeconds', DEFAULT_LIMITS.wallSeconds),
    perCommandSeconds: positiveInt(l.perCommandSeconds, 'perCommandSeconds', DEFAULT_LIMITS.perCommandSeconds),
    cpus: sizeToken(l.cpus, 'cpus', DEFAULT_LIMITS.cpus),
    memory: sizeToken(l.memory, 'memory', DEFAULT_LIMITS.memory),
    pids: positiveInt(l.pids, 'pids', DEFAULT_LIMITS.pids),
    outputBytes: positiveInt(l.outputBytes, 'outputBytes', DEFAULT_LIMITS.outputBytes),
  };

  return { echoGroupId, atlasGroupId, projects, limits };
}
