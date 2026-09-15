/**
 * Wire format and validation for a handoff's verification inputs.
 *
 * Pure: no I/O, no DB, no config. Everything here is called twice — once by
 * the Slack-enforcement capture path (before the ledger transaction opens) and
 * again by the host verifier immediately before it starts a container, from
 * the stored rows. The second call is what makes DB tampering detectable as a
 * schema violation rather than as executable commands.
 *
 * On the formal handoff message:
 *
 *   CLASS: bugfix
 *   CHECKPOINT: 7ca90de9
 *   CHECKS: ["pnpm test", "node scripts/smoke.js"]
 *   REPRODUCE: []
 *
 * CHECKS and REPRODUCE are a JSON array of command strings on ONE logical
 * line. JSON is the canonical stored form and the only one: the host freezes
 * that array before the first container and writes one element to each
 * container's stdin. Nothing renders it into a script.
 *
 * Every error message is a specific, quotable string: the enforcement path
 * puts it in the reject reason the sender sees, and the verifier puts it in
 * the refusal record.
 */

export const CLASS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const CHECKPOINT_PATTERN = /^[0-9a-f]{7,40}$/;

export const MAX_CHECKS = 10;
export const MAX_COMMAND_BYTES = 1000;
export const MAX_ARRAY_JSON_BYTES = 32 * 1024;

export type CommandArrayLabel = 'CHECKS' | 'REPRODUCE';

export interface VerificationInputs {
  class: string;
  checkpoint: string;
  checks: string[];
  reproduce: string[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Validate an already-decoded array of command strings.
 *
 * `CHECKS` must be non-empty (a handoff with nothing to run is not
 * verifiable); `REPRODUCE` may be empty because it is informational.
 */
export function validateCommandArray(value: unknown, label: CommandArrayLabel): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array of command strings`);
  for (let i = 0; i < value.length; i++) {
    const command = value[i];
    if (typeof command !== 'string') throw new Error(`${label}[${i}] must be a string`);
    if (byteLength(command) > MAX_COMMAND_BYTES) {
      throw new Error(`${label}[${i}] exceeds ${MAX_COMMAND_BYTES} bytes`);
    }
  }
  if (label === 'CHECKS' && value.length === 0) {
    throw new Error('CHECKS must contain at least one command');
  }
  if (value.length > MAX_CHECKS) {
    throw new Error(`${label} must contain at most ${MAX_CHECKS} commands`);
  }
  if (byteLength(JSON.stringify(value)) > MAX_ARRAY_JSON_BYTES) {
    throw new Error(`${label} exceeds ${MAX_ARRAY_JSON_BYTES} bytes`);
  }
  return value as string[];
}

/** Decode and validate the raw on-the-wire (or stored) JSON text. */
export function parseCommandArray(raw: unknown, label: CommandArrayLabel): string[] {
  if (typeof raw !== 'string') throw new Error(`${label} must be a JSON array of command strings`);
  // Cap before parsing so a multi-megabyte field is refused, not decoded.
  if (byteLength(raw) > MAX_ARRAY_JSON_BYTES) {
    throw new Error(`${label} exceeds ${MAX_ARRAY_JSON_BYTES} bytes`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} must be a JSON array of command strings`, { cause: err });
  }
  return validateCommandArray(decoded, label);
}

export function validateClassToken(value: unknown): string {
  if (typeof value !== 'string' || !CLASS_PATTERN.test(value)) {
    throw new Error('CLASS must match ^[a-z][a-z0-9-]{0,31}$');
  }
  return value;
}

export function validateCheckpoint(value: unknown): string {
  if (typeof value !== 'string' || !CHECKPOINT_PATTERN.test(value)) {
    throw new Error('CHECKPOINT must match ^[0-9a-f]{7,40}$');
  }
  return value;
}

/** Validate inputs that are already in decoded form (capture call sites, re-validation). */
export function validateVerificationInputs(input: {
  class: unknown;
  checkpoint: unknown;
  checks: unknown;
  reproduce: unknown;
}): VerificationInputs {
  return {
    class: validateClassToken(input.class),
    checkpoint: validateCheckpoint(input.checkpoint),
    checks: validateCommandArray(input.checks, 'CHECKS'),
    reproduce: validateCommandArray(input.reproduce, 'REPRODUCE'),
  };
}

/** Validate inputs whose arrays are still raw JSON text (message fields, DB columns). */
export function parseVerificationInputs(input: {
  class: unknown;
  checkpoint: unknown;
  checksJson: unknown;
  reproduceJson: unknown;
}): VerificationInputs {
  return {
    class: validateClassToken(input.class),
    checkpoint: validateCheckpoint(input.checkpoint),
    checks: parseCommandArray(input.checksJson, 'CHECKS'),
    reproduce: parseCommandArray(input.reproduceJson, 'REPRODUCE'),
  };
}

/**
 * The exact byte string both fingerprints are taken over. Key order is fixed
 * here and nowhere else, so a recomputation can never disagree with a capture
 * because of object-literal ordering.
 */
export function canonicalVerificationInputs(inputs: VerificationInputs): string {
  return JSON.stringify({
    class: inputs.class,
    checkpoint: inputs.checkpoint,
    checks: inputs.checks,
    reproduce: inputs.reproduce,
  });
}
