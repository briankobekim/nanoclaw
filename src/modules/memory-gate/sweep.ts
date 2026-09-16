/**
 * Host-sweep hook (plan §4.3): finishes every queued or prepared memory op.
 * Called once per tick from the `MODULE-HOOK:memory-gate-ops-sweep` block in
 * src/host-sweep.ts; the same function is kicked after every enqueue.
 */
import { completePendingOps } from './ops.js';

export async function memoryGateSweep(): Promise<void> {
  await completePendingOps();
}
