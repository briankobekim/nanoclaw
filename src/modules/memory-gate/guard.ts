/**
 * Guard catalog entry for `memory_write` (plan §4.3).
 *
 * `decide` performs no lookups: a container-originated request always HOLDs,
 * so a fresh dispatch cards the owner and an approved replay is validated by
 * the guard framework (`grantSatisfies`: live row, matching action, and the
 * request binding below). Nothing transient can turn an owner's tap into a
 * denial, and a stale, foreign, or re-targeted grant is refused by the
 * framework rather than by code here.
 */
import { createHash } from 'node:crypto';

import { DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import type { PendingApproval } from '../../types.js';

export const MEMORY_WRITE_ACTION = 'memory_write';

/** Binds a grant to the exact bytes it was shown for. */
export function requestSha(payload: Record<string, unknown>): string {
  const path = typeof payload.path === 'string' ? payload.path : '';
  const mode = typeof payload.mode === 'string' ? payload.mode : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  return createHash('sha256').update(`${path}\n${mode}\n${content}`).digest('hex');
}

function grantPayload(grant: PendingApproval): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(grant.payload) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed grant payload is a refusal, not a crash
  } catch {
    return null;
  }
}

export const memoryWriteGuard = defineGuardedAction({
  action: 'memory.write',
  grantActionName: MEMORY_WRITE_ACTION,
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('memory_write is a container-originated action');
    return HOLD('free-form memory write');
  },
  grantCoversRequest: (grant, input) => {
    const granted = grantPayload(grant);
    if (!granted) return false;
    const sessionId = input.actor.kind === 'agent' ? input.actor.sessionId : undefined;
    return (
      granted.request_id === input.payload.request_id &&
      granted.session_id === sessionId &&
      granted.sha256 === requestSha(input.payload) &&
      requestSha(granted) === requestSha(input.payload)
    );
  },
});
