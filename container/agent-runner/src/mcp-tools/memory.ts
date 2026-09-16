/**
 * Memory MCP tool: memory_write.
 *
 * Memory is mounted read-only at /workspace/agent/memory. The only way an
 * agent gets anything written there is this tool: it emits ONE outbound
 * system row describing the requested write, and the host holds it on the
 * owner's approval card, then applies it durably after approval. Nothing is
 * stored until the host says so.
 *
 * Shape validation happens here only for a fast, local error message (no
 * outbound row on failure); the host re-validates on receipt and refuses
 * anything else it is handed.
 */
import { randomBytes } from 'crypto';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `mw-<epoch ms>-<8 hex>`; 25 characters, well inside the host's 64 cap. */
function generateRequestId(): string {
  return `mw-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

const MODES = ['replace', 'append', 'delete'] as const;
type Mode = (typeof MODES)[number];

const MAX_PATH_CHARS = 200;
const MAX_CONTENT_BYTES = 2000;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const OWNER_FILE = 'owner-statements.md';

/**
 * Relative, already-normalized, markdown-only paths under memory/: no leading
 * `/`, no backslash, no `.` or `..` segment, no empty segment, every segment
 * `[A-Za-z0-9._-]+`, a real name before `.md`, at most 200 characters, and
 * never the owner's own file (which only the host writes, via `remember:`).
 */
function pathError(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'path is required';
  if (path.length > MAX_PATH_CHARS) return `path must be at most ${MAX_PATH_CHARS} characters`;
  if (path.startsWith('/')) return 'path must be relative to memory/ (no leading "/")';
  if (path.includes('\\')) return 'path must use "/" as the separator';
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'path must be normalized: no empty, "." or ".." segments';
    }
    if (!SEGMENT_RE.test(segment)) return 'path segments may only use letters, digits, ".", "_" or "-"';
  }
  const name = segments[segments.length - 1];
  if (!name.endsWith('.md') || name.length <= 3) return 'path must name a markdown file ending in ".md"';
  if (name === OWNER_FILE) {
    return `${OWNER_FILE} is written only by the host from Kobe's own "remember:" messages`;
  }
  return null;
}

function isMode(mode: unknown): mode is Mode {
  return typeof mode === 'string' && (MODES as readonly string[]).includes(mode);
}

function contentError(mode: Mode, content: unknown): string | null {
  if (mode === 'delete') {
    return content === undefined ? null : 'content must be omitted for mode "delete"';
  }
  if (typeof content !== 'string') return `content (a string) is required for mode "${mode}"`;
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return `content must be at most ${MAX_CONTENT_BYTES} bytes (UTF-8); split it into smaller writes`;
  }
  return null;
}

function error(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const memoryWrite: McpToolDefinition = {
  tool: {
    name: 'memory_write',
    description:
      'Ask Kobe to approve a write to your memory (/workspace/agent/memory is read-only). One file per call: ' +
      "replace or append up to 2000 bytes of markdown, or delete a file. Every request goes to Kobe's approval " +
      "card; nothing is stored until the host replies 'held for Kobe's approval' and later 'memory written'.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Relative path under memory/, ending in .md (e.g. "projects/atlas.md"); never owner-statements.md',
        },
        mode: { type: 'string', enum: [...MODES], description: 'replace | append | delete' },
        content: {
          type: 'string',
          description: 'Markdown to write (at most 2000 bytes UTF-8); required for replace/append, omitted for delete',
        },
      },
      required: ['path', 'mode'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const { path, mode, content } = args;

    const badPath = pathError(path);
    if (badPath) return error(badPath);
    if (!isMode(mode)) return error(`mode must be one of ${MODES.join(', ')}`);
    const badContent = contentError(mode, content);
    if (badContent) return error(badContent);

    const requestId = generateRequestId();
    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'memory_write',
        request_id: requestId,
        path,
        mode,
        ...(mode === 'delete' ? {} : { content }),
      }),
    });

    log(`memory_write: requested ${requestId} ${mode} ${path}`);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `requested: memory_write ${path} (${mode}); nothing is stored until you receive a ` +
            `'held for Kobe's approval' or 'memory written' notice — if neither arrives within five minutes, ask again`,
        },
      ],
    };
  },
};

registerTools([memoryWrite]);
