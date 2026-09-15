/**
 * The wire format is the whole trust boundary for what the host will execute,
 * so every rejection here is also asserted as a specific, quotable string —
 * the enforcement path shows it to the sender and the verifier records it.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalVerificationInputs,
  parseCommandArray,
  parseVerificationInputs,
  validateCommandArray,
  validateVerificationInputs,
} from './checks-schema.js';

describe('CHECKS / REPRODUCE wire format', () => {
  it('accepts a JSON array of command strings', () => {
    expect(parseCommandArray('["pnpm test", "node scripts/smoke.js"]', 'CHECKS')).toEqual([
      'pnpm test',
      'node scripts/smoke.js',
    ]);
  });

  it('accepts an empty REPRODUCE but not an empty CHECKS', () => {
    expect(parseCommandArray('[]', 'REPRODUCE')).toEqual([]);
    expect(() => parseCommandArray('[]', 'CHECKS')).toThrow('CHECKS must contain at least one command');
  });

  it('refuses the prose block a reviewer might otherwise take at face value', () => {
    expect(() => parseCommandArray('- all checks passed manually', 'CHECKS')).toThrow(
      'CHECKS must be a JSON array of command strings',
    );
  });

  it('refuses a bare JSON string, which is valid JSON but not an array', () => {
    expect(() => parseCommandArray('"pnpm test"', 'CHECKS')).toThrow('CHECKS must be a JSON array of command strings');
  });

  it('refuses a non-string element', () => {
    expect(() => parseCommandArray('["pnpm test", 7]', 'CHECKS')).toThrow('CHECKS[1] must be a string');
  });

  it('refuses more than ten commands', () => {
    const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => `echo ${i}`));
    expect(() => parseCommandArray(eleven, 'CHECKS')).toThrow('CHECKS must contain at most 10 commands');
  });

  it('refuses a 1,001-byte command but accepts 1,000', () => {
    expect(parseCommandArray(JSON.stringify(['x'.repeat(1000)]), 'CHECKS')).toHaveLength(1);
    expect(() => parseCommandArray(JSON.stringify(['x'.repeat(1001)]), 'CHECKS')).toThrow(
      'CHECKS[0] exceeds 1000 bytes',
    );
  });

  it('refuses a field larger than 32 KB before it is parsed', () => {
    expect(() => parseCommandArray(`["${'x'.repeat(40_000)}"]`, 'CHECKS')).toThrow('CHECKS exceeds 32768 bytes');
  });

  it('refuses a missing field', () => {
    expect(() => parseCommandArray(undefined, 'CHECKS')).toThrow('CHECKS must be a JSON array of command strings');
  });

  it('validates already-decoded arrays with the same rules', () => {
    expect(() => validateCommandArray('pnpm test', 'CHECKS')).toThrow('CHECKS must be a JSON array of command strings');
    expect(validateCommandArray(['pnpm test'], 'CHECKS')).toEqual(['pnpm test']);
  });
});

describe('CLASS and CHECKPOINT tokens', () => {
  it('accepts a lowercase class token', () => {
    expect(
      validateVerificationInputs({ class: 'bug-fix', checkpoint: 'abc1234', checks: ['x'], reproduce: [] }).class,
    ).toBe('bug-fix');
  });

  it('refuses a class with uppercase, spaces, or 33 characters', () => {
    for (const bad of ['Complex', 'two words', 'a'.repeat(33), '1abc', '']) {
      expect(() =>
        validateVerificationInputs({ class: bad, checkpoint: 'abc1234', checks: ['x'], reproduce: [] }),
      ).toThrow('CLASS must match ^[a-z][a-z0-9-]{0,31}$');
    }
  });

  it('refuses a checkpoint that is not 7-40 lowercase hex', () => {
    for (const bad of ['abc123', 'ABC1234', 'z'.repeat(8), 'a'.repeat(41), 'HEAD']) {
      expect(() => validateVerificationInputs({ class: 'fix', checkpoint: bad, checks: ['x'], reproduce: [] })).toThrow(
        'CHECKPOINT must match ^[0-9a-f]{7,40}$',
      );
    }
    expect(
      validateVerificationInputs({ class: 'fix', checkpoint: 'a'.repeat(40), checks: ['x'], reproduce: [] }).checkpoint,
    ).toBe('a'.repeat(40));
  });
});

describe('canonical form', () => {
  it('is key-order stable regardless of how the caller built the object', () => {
    const a = parseVerificationInputs({
      class: 'fix',
      checkpoint: 'abc1234',
      checksJson: '["pnpm test"]',
      reproduceJson: '["node bug.js"]',
    });
    const b = validateVerificationInputs({
      reproduce: ['node bug.js'],
      checks: ['pnpm test'],
      checkpoint: 'abc1234',
      class: 'fix',
    });
    expect(canonicalVerificationInputs(a)).toBe(canonicalVerificationInputs(b));
    expect(canonicalVerificationInputs(a)).toBe(
      '{"class":"fix","checkpoint":"abc1234","checks":["pnpm test"],"reproduce":["node bug.js"]}',
    );
  });
});
