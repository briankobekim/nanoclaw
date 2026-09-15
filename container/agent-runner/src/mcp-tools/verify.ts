/**
 * Verification MCP tool: run_checks.
 *
 * Fire-and-forget, like the self-mod tools. The ONLY argument is a handoff id;
 * the host owns the commands, the repository, the checkpoint and the image,
 * and reads them from its own ledger rows. Nothing this agent writes can
 * change what executes — which is the whole point of the tool existing instead
 * of the agent running the gate script itself.
 *
 * The id is validated here for a fast, local error message; the host
 * re-validates on receipt and refuses anything else it is handed.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Same rule as the host and the ledger: starts with an alphanumeric, then only
 * `[A-Za-z0-9._-]`, to 64 characters. The leading-alphanumeric rule is what
 * rules out `.`, `..`, `.hidden` and a leading `-` that a later argv could read
 * as a flag. The id becomes a directory name on the host, so `.` and `..` are
 * also refused by name.
 */
const HANDOFF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isValidHandoffId(id: string): boolean {
  return id !== '.' && id !== '..' && HANDOFF_ID_RE.test(id);
}

export const runChecks: McpToolDefinition = {
  tool: {
    name: 'run_checks',
    description:
      "Ask the host to execute a delivered handoff's CHECKS at its CHECKPOINT in an offline, read-only sandbox. Takes only the handoff id; the commands, repository, checkpoint and image all come from the host's trusted ledger. Fire-and-forget: the result arrives as a system message.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        handoff_id: { type: 'string', description: 'The handoff id from the formal handoff package' },
      },
      required: ['handoff_id'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const handoffId = typeof args.handoff_id === 'string' ? args.handoff_id : '';
    if (!handoffId) {
      return { content: [{ type: 'text' as const, text: 'Error: handoff_id is required' }], isError: true };
    }
    if (!isValidHandoffId(handoffId)) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              'Error: handoff_id must start with a letter or digit and use at most 64 characters of ' +
              'letters, digits, ".", "_" or "-"',
          },
        ],
        isError: true,
      };
    }

    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'run_checks', handoff_id: handoffId }),
    });

    log(`run_checks: queued ${handoffId}`);
    return {
      content: [
        {
          type: 'text' as const,
          text: `queued: run_checks ${handoffId}; the host will reply with a system message`,
        },
      ],
    };
  },
};

registerTools([runChecks]);
