/**
 * Canonical visible encoding for the approval card (plan §4.3, case G9).
 *
 * The card must show the COMPLETE proposed content in a form where two
 * different payloads can never look the same and nothing can hide or break
 * out of the code block. So the encoding is injective and total:
 *   - `\` is written `\\`;
 *   - backtick, every C0 control except `\n` and `\t`, DEL, the zero-width and
 *     bidi controls, U+FEFF, the wrap marker U+23CE, lone surrogates, and every
 *     code point above U+FFFF are written `\u{HEX}` (uppercase, no padding);
 *   - nothing else is altered (mentions and links stay verbatim: inside a code
 *     block Slack does not expand them);
 *   - a physical line that would exceed WRAP_COLS is hard-wrapped by inserting
 *     `⏎\n`; the marker ends the physical line and the continuation follows.
 *     An escape sequence is never split. A literal U+23CE in the input is
 *     always escaped, so a raw marker in the encoded text is always a wrap.
 * `decodeVisible` inverts exactly and refuses anything the encoder would not
 * have produced.
 */

/** Cap on the ENCODED form (bytes). Measured after escaping and wrapping. */
export const CONTENT_MAX_BYTES = 2000;
/** Slack section text limit; a rendered question at or over this is refused before sending. */
export const QUESTION_MAX_CHARS = 3000;
/** Physical line width before a wrap marker is inserted. */
export const WRAP_COLS = 200;

const WRAP_MARKER = '⏎';
const BACKSLASH = 0x5c;

/**
 * Code points written as `\u{HEX}`. Backslash is handled separately (`\\`).
 * The rule is by Unicode category, not by an enumerated list, so every
 * control (Cc, except \n and \t), format (Cf: bidi controls, zero-width
 * characters, soft hyphen, U+061C, ...), surrogate (Cs), private-use (Co),
 * unassigned (Cn) and line/paragraph separator (Zl, Zp) code point is shown
 * as a visible escape, plus the backtick, the wrap marker, and anything
 * outside the BMP.
 */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
function escapedAsHex(cp: number): boolean {
  if (cp === 0x0a || cp === 0x09) return false; // newline and tab stay literal
  if (cp === 0x60) return true; // backtick
  if (cp === 0x23ce) return true; // the wrap marker itself
  if (cp > 0xffff) return true; // outside the BMP
  if (cp >= 0xd800 && cp <= 0xdfff) return true; // lone surrogate (refused upstream; escaped here for totality)
  return INVISIBLE_RE.test(String.fromCodePoint(cp));
}

function hexEscape(cp: number): string {
  return `\\u{${cp.toString(16).toUpperCase()}}`;
}

/** One visible token per input code point: a literal character or an escape. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp === BACKSLASH) tokens.push('\\\\');
    else if (escapedAsHex(cp)) tokens.push(hexEscape(cp));
    else tokens.push(ch);
  }
  return tokens;
}

export function encodeVisible(s: string): string {
  let out = '';
  let width = 0;
  for (const token of tokenize(s)) {
    if (token === '\n') {
      out += token;
      width = 0;
      continue;
    }
    if (width > 0 && width + token.length > WRAP_COLS) {
      out += `${WRAP_MARKER}\n`;
      width = 0;
    }
    out += token;
    width += token.length;
  }
  return out;
}

const HEX_RE = /^[0-9A-F]+$/;

export function decodeVisible(s: string): string {
  // Pass 1: remove wrap markers. A raw marker is only ever a wrap.
  let unwrapped = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === WRAP_MARKER) {
      if (s[i + 1] !== '\n') throw new Error(`visible encoding: wrap marker at ${i} is not followed by a newline`);
      i += 1;
      continue;
    }
    unwrapped += ch;
  }
  // Pass 2: unescape, accepting only the canonical spelling of each escape.
  let out = '';
  for (let i = 0; i < unwrapped.length; i++) {
    const ch = unwrapped[i]!;
    if (ch !== '\\') {
      const cp = unwrapped.codePointAt(i)!;
      if (escapedAsHex(cp))
        throw new Error(`visible encoding: unescaped code point U+${cp.toString(16).toUpperCase()} at ${i}`);
      out += ch;
      continue;
    }
    const next = unwrapped[i + 1];
    if (next === '\\') {
      out += '\\';
      i += 1;
      continue;
    }
    if (next !== 'u' || unwrapped[i + 2] !== '{') throw new Error(`visible encoding: bad escape at ${i}`);
    const close = unwrapped.indexOf('}', i + 3);
    if (close < 0) throw new Error(`visible encoding: unterminated escape at ${i}`);
    const hex = unwrapped.slice(i + 3, close);
    if (!HEX_RE.test(hex) || (hex.length > 1 && hex.startsWith('0'))) {
      throw new Error(`visible encoding: malformed escape at ${i}`);
    }
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff || !escapedAsHex(cp)) throw new Error(`visible encoding: non-canonical escape at ${i}`);
    out += String.fromCodePoint(cp);
    i = close;
  }
  return out;
}

export function renderQuestion(args: {
  agentName: string;
  path: string;
  mode: string;
  bytes: number;
  sha256: string;
  encoded: string;
}): string {
  const { path, mode, bytes, sha256, encoded } = args;
  return [
    `path: ${path}`,
    `mode: ${mode}`,
    `bytes: ${bytes}`,
    `sha256: ${sha256}`,
    'Approve to write exactly this content:',
    '```',
    encoded,
    '```',
  ].join('\n');
}
