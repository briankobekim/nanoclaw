import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';

import {
  CONTENT_MAX_BYTES,
  QUESTION_MAX_CHARS,
  WRAP_COLS,
  decodeVisible,
  encodeVisible,
  renderQuestion,
} from './render.js';

// docs/specs/memory-provenance-gate/plan.md §5 case G9.

const WRAP = '\u23CE';

const FIXTURES: Record<string, string> = {
  closingFence: 'before\n```\nafter the fence',
  backslashes: 'C:\\path\\to\\file and a trailing \\',
  zeroWidthAndBidi: 'zero\u200Bwidth and bidi\u202Eoverride\u200F\u2066\uFEFF',
  slackMention: 'ping <@U0123> and <!channel>',
  url: 'see https://example.com/a?b=c&d=e#frag',
  longLine: 'x'.repeat(300),
  controls: 'tab\tkeeps\nnewline keeps\rcarriage\u0000nul\u001Besc\u007Fdel',
  astral: 'emoji \u{1F600} and \u{10FFFF}',
  loneSurrogate: 'lone \uD800 surrogate',
  literalWrapMarker: `a literal ${WRAP} marker`,
  empty: '',
};

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Largest prefix of `raw` whose encoded form fits the content cap. */
function largestEncodable(raw: string): string {
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(encodeVisible(raw.slice(0, mid))) <= CONTENT_MAX_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return raw.slice(0, lo);
}

describe('memory-gate render', () => {
  it('the canonical visible encoding is injective, exposes hostile content, and the rendered card never exceeds 3,000 characters', () => {
    // Visible escapes: hostile bytes are shown, never interpreted.
    expect(encodeVisible(FIXTURES.closingFence)).toBe('before\n\\u{60}\\u{60}\\u{60}\nafter the fence');
    expect(encodeVisible(FIXTURES.backslashes)).toBe('C:\\\\path\\\\to\\\\file and a trailing \\\\');
    expect(encodeVisible(FIXTURES.zeroWidthAndBidi)).toBe(
      'zero\\u{200B}width and bidi\\u{202E}override\\u{200F}\\u{2066}\\u{FEFF}',
    );
    expect(encodeVisible(FIXTURES.controls)).toBe(
      'tab\tkeeps\nnewline keeps\\u{D}carriage\\u{0}nul\\u{1B}esc\\u{7F}del',
    );
    expect(encodeVisible(FIXTURES.astral)).toBe('emoji \\u{1F600} and \\u{10FFFF}');
    expect(encodeVisible(FIXTURES.loneSurrogate)).toBe('lone \\u{D800} surrogate');
    expect(encodeVisible(FIXTURES.literalWrapMarker)).toBe('a literal \\u{23CE} marker');
    // Mentions and links stay verbatim: inside a code block they are inert and visible.
    expect(encodeVisible(FIXTURES.slackMention)).toBe(FIXTURES.slackMention);
    expect(encodeVisible(FIXTURES.url)).toBe(FIXTURES.url);

    // Long lines are hard-wrapped with the visible marker ending each physical line.
    const wrapped = encodeVisible(FIXTURES.longLine);
    expect(wrapped).toBe(`${'x'.repeat(200)}${WRAP}\n${'x'.repeat(100)}`);
    for (const line of wrapped.split('\n')) expect(line.length).toBeLessThanOrEqual(WRAP_COLS + 1);

    // Round trip for every fixture and for the concatenation of all of them.
    for (const [name, raw] of Object.entries(FIXTURES)) {
      const encoded = encodeVisible(raw);
      expect(encoded, name).not.toContain('```');
      expect(encoded, name).not.toContain('`');
      expect(decodeVisible(encoded), name).toBe(raw);
    }
    const all = Object.values(FIXTURES).join('\n');
    expect(decodeVisible(encodeVisible(all))).toBe(all);

    // Collision pairs encode differently.
    expect(encodeVisible('\\u{202E}')).not.toBe(encodeVisible('\u202E'));
    expect(encodeVisible('\\u{202E}')).toBe('\\\\u{202E}');
    expect(encodeVisible('` ` `')).not.toBe(encodeVisible('```'));
    expect(encodeVisible(WRAP)).toBe('\\u{23CE}');
    const literalThenNewline = `${'x'.repeat(200)}${WRAP}\ny`;
    const wrappedByEncoder = `${'x'.repeat(200)}y`;
    expect(encodeVisible(literalThenNewline)).not.toBe(encodeVisible(wrappedByEncoder));
    expect(decodeVisible(encodeVisible(literalThenNewline))).toBe(literalThenNewline);
    expect(decodeVisible(encodeVisible(wrappedByEncoder))).toBe(wrappedByEncoder);
    // An escape sequence is never split by a wrap.
    const escapesAtBoundary = `${'x'.repeat(198)}\u200B${'y'.repeat(10)}`;
    for (const line of encodeVisible(escapesAtBoundary).split('\n')) {
      expect(line.replace(/\u23CE$/, '')).toMatch(/^(?:[^\\]|\\\\|\\u\{[0-9A-F]+\})*$/);
    }

    // Malformed input is refused rather than guessed at.
    expect(() => decodeVisible('\\x')).toThrow();
    expect(() => decodeVisible('\\u{12')).toThrow();
    expect(() => decodeVisible('\\u{}')).toThrow();
    expect(() => decodeVisible(`bare ${WRAP} marker`)).toThrow();
    expect(() => decodeVisible('trailing \\')).toThrow();

    // Card size: the 2,000-byte cap is measured on the ENCODED form, so the
    // worst raw inputs (all backticks: 6x expansion; all backslashes: 2x) are
    // refused by the cap long before the card could reach Slack's 3,000-char
    // section limit. The raw 2,000-byte worst case is over the cap.
    const rawWorst = '`'.repeat(1000) + '\\'.repeat(1000);
    expect(Buffer.byteLength(rawWorst)).toBe(2000);
    expect(Buffer.byteLength(encodeVisible(rawWorst))).toBeGreaterThan(CONTENT_MAX_BYTES);

    const longestPath = `${'d/'.repeat(90)}${'f'.repeat(17)}.md`;
    expect(longestPath.length).toBe(200);
    let maxRendered = 0;
    for (const raw of [
      '`'.repeat(1000),
      '\\'.repeat(2000),
      'x'.repeat(2000),
      '\u200B'.repeat(500),
      '\u{1F600}'.repeat(500),
      `${'x'.repeat(199)}\u200B`.repeat(20),
    ]) {
      const content = largestEncodable(raw);
      const encoded = encodeVisible(content);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(CONTENT_MAX_BYTES);
      const question = renderQuestion({
        agentName: 'Atlas',
        path: longestPath,
        mode: 'replace',
        bytes: Buffer.byteLength(content),
        sha256: sha(content),
        encoded,
      });
      maxRendered = Math.max(maxRendered, question.length);
      expect(question.length).toBeLessThan(QUESTION_MAX_CHARS);
      expect(question).toContain(longestPath);
      expect(question).toContain('replace');
      expect(question).toContain(sha(content));
      expect(question).toContain('Approve to write exactly this content:');
      expect(question).toContain(`\`\`\`\n${encoded}\n\`\`\``);
      expect(question.split('```')).toHaveLength(3);
    }
    // Header budget: everything but the encoded content stays well under 700.
    expect(maxRendered - CONTENT_MAX_BYTES).toBeLessThan(700);
  });
});

describe('fourth-review correction: every invisible code point is escaped', () => {
  it('escapes Cf/Cc/Zl/Zp characters beyond the original list and refuses lone surrogates upstream', async () => {
    const { encodeVisible, decodeVisible } = await import('./render.js');
    const samples = [
      '\u061C',
      '\u00AD',
      '\u2028',
      '\u2029',
      '\u200E',
      '\u180E',
      '\u0085',
      '\uFFF9',
      // Default-ignorable combining marks: no glyph of their own, so two payloads
      // that differ only by them would collide on the card unless escaped.
      '\u034F', // COMBINING GRAPHEME JOINER
      '\uFE0F', // VARIATION SELECTOR-16
      '\uFE00', // VARIATION SELECTOR-1
      '\u1160', // HANGUL JUNGSEONG FILLER
      '\u3164', // HANGUL FILLER
    ];
    // A visible combining accent is NOT escaped: it changes what the owner sees.
    expect(encodeVisible('e\u0301')).toBe('e\u0301');
    expect(encodeVisible('a\u034Fb\uFE0Fc')).toBe('a\\u{34F}b\\u{FE0F}c');
    expect(encodeVisible('ab')).not.toBe(encodeVisible('a\u034Fb'));
    for (const s of samples) {
      const encoded = encodeVisible(`a${s}b`);
      expect(encoded).toMatch(/^a\\u\{[0-9A-F]+\}b$/);
      expect(decodeVisible(encoded)).toBe(`a${s}b`);
    }
    const { shapeError } = await import('./request.js');
    expect(shapeError({ request_id: 'r', path: 'x.md', mode: 'append', content: 'bad \uD800 text' })).toMatch(
      /lone surrogate/,
    );
  });
});
