/**
 * Owner DM notice for the memory gate, mirroring the handoff stall ping: every
 * owner with a reachable DM gets the text; a failed or hung send is logged and
 * skipped, never propagated.
 */
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/** A Slack call that has not settled by then is treated as failed. */
export const DELIVER_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function notifyOwners(text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('memory-gate: no delivery adapter; owner notice dropped', { text });
    return;
  }
  for (const owner of await getOwners()) {
    const mg = await ensureUserDm(owner.user_id);
    if (!mg) {
      log.warn('memory-gate: owner has no reachable DM; notice skipped', { userId: owner.user_id });
      continue;
    }
    try {
      await withTimeout(
        adapter.deliver(
          mg.channel_type,
          mg.platform_id,
          null,
          'chat-sdk',
          JSON.stringify({ text }),
          undefined,
          mg.instance,
        ),
        DELIVER_TIMEOUT_MS,
        `memory-gate owner notice to ${mg.platform_id}`,
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- a notice is best effort; any send failure is logged and the next owner is tried
    } catch (err) {
      log.warn('memory-gate: owner notice failed', { recipient: mg.platform_id, err });
    }
  }
}
