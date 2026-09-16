/**
 * Digest-specific owner DM sender (docs/specs/usage-digest/plan.md §4.4).
 *
 * Unlike the memory gate's `notifyOwners`, which is best effort and swallows
 * every failure, this sender resolves ONLY when the delivery adapter accepted
 * the DM and throws otherwise: no adapter, an unreachable DM, a hung call, or
 * an adapter error. The digest sweep needs that distinction to write its
 * per-owner "sent today" marker only after a real send (invariant 6).
 */
import { getDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import type { MessagingGroup } from '../../types.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/** A Slack call that has not settled by then is treated as failed; the sweep retries next tick. */
export const DIGEST_DELIVER_TIMEOUT_MS = 30_000;

type Recipient = Pick<MessagingGroup, 'channel_type' | 'platform_id' | 'instance'>;

export interface DigestSendDeps {
  ensureUserDm: (userId: string) => Promise<Recipient | null>;
  getDeliveryAdapter: () => Pick<ChannelDeliveryAdapter, 'deliver'> | null;
  /** Test hook; production uses DIGEST_DELIVER_TIMEOUT_MS. */
  deliverTimeoutMs?: number;
}

const liveDeps: DigestSendDeps = { ensureUserDm, getDeliveryAdapter };

/** Bound a promise; the underlying call may still finish later, which the at-least-once contract tolerates. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * DM `text` to one owner. Resolves once the adapter accepted the message;
 * rejects on a missing adapter, an unreachable DM, a timeout or an adapter
 * error. Never swallows.
 */
export async function sendDigestTo(
  ownerUserId: string,
  text: string,
  overrides: Partial<DigestSendDeps> = {},
): Promise<void> {
  const deps: DigestSendDeps = { ...liveDeps, ...overrides };
  const adapter = deps.getDeliveryAdapter();
  if (!adapter) throw new Error('usage digest: no delivery adapter registered');

  const mg = await deps.ensureUserDm(ownerUserId);
  if (!mg) throw new Error(`usage digest: owner ${ownerUserId} has no reachable DM`);

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
    deps.deliverTimeoutMs ?? DIGEST_DELIVER_TIMEOUT_MS,
    `usage digest to ${mg.platform_id}`,
  );
}
