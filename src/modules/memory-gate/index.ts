/**
 * Memory provenance gate (docs/specs/memory-provenance-gate/plan.md).
 *
 * One door for durable memory:
 *   - the owner files his own words with a `remember:` message (router →
 *     ./owner-filing.ts), written by the host into owner-statements.md;
 *   - an agent proposes anything else with the `memory_write` tool, which is
 *     always held on the owner's approval card (guard → hold → approved replay
 *     → durable op → completion by the host sweep).
 * The container's memory mount is read-only (src/container-runner.ts).
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { memoryWriteGuard, MEMORY_WRITE_ACTION } from './guard.js';
import { memoryGateDeps, QuiescedError, requestMemoryHold, retainingReplay, validateShape } from './request.js';
import './migration.js';

/** Runs only on an approved replay (fresh dispatches always hold). */
async function enqueueMemoryWrite(content: Record<string, unknown>, session: Session): Promise<void> {
  const mode = content.mode as 'replace' | 'append' | 'delete';
  const result = await memoryGateDeps().enqueueMemoryOp({
    agentGroupId: session.agent_group_id,
    requestId: content.request_id as string,
    sessionId: session.id,
    kind: 'free',
    path: content.path as string,
    mode,
    content: mode === 'delete' ? null : (content.content as string),
  });
  if (result === 'quiesced') throw new QuiescedError();
  // Fire-and-forget kick; the sweep is the durable path. Isolated so a
  // completion error can never look like an enqueue failure to the replay.
  void memoryGateDeps()
    .completePendingOps()
    .catch((err) => log.warn('memory-gate: completion kick failed; the sweep will retry', { err }));
}

registerDeliveryAction(MEMORY_WRITE_ACTION, enqueueMemoryWrite, {
  guardAction: memoryWriteGuard,
  precheck: validateShape,
  requestHold: requestMemoryHold,
  onDeny: (_content, session, reason) => memoryGateDeps().notifyAgent(session, `memory request denied: ${reason}`),
});
registerApprovalHandler(MEMORY_WRITE_ACTION, retainingReplay);

export { classifyTrust, stampTrust, parseContentSafe, type TrustLabel } from './trust.js';
export { fileOwnerStatement, isOwnerFilingMessage, setOwnerFilingDeps } from './owner-filing.js';
export { setMemoryGateDeps } from './request.js';
export { memoryGateSweep } from './sweep.js';
