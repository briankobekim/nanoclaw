/**
 * Owner "needs you" ping for stalled handoffs.
 *
 * Runs once per host-sweep tick. A handoff that has sat in one open state past
 * its threshold is reported to every owner's DM exactly once per (handoff,
 * recipient, state); the record of each ping is an `owner_pinged` event on the
 * handoff itself, so dedupe survives restarts and needs no in-memory state.
 *
 * Contract is at-least-once: the event is appended AFTER a successful send, so
 * a crash or append failure between the two produces one duplicate on the next
 * tick rather than a silent miss (spec §4.2 step 8).
 */
import { getDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';
import { getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import {
  getHandoff,
  listAllHandoffs,
  listHandoffEvents,
  OWNER_PINGED_EVENT,
  recordOwnerPing,
  trustedSupersededIds,
  type HandoffRow,
  type HandoffStatus,
} from './ledger.js';

/** A `review_blocked` handoff needs a human, so it is reported after one hour. */
export const STALL_MS_BLOCKED = 60 * 60 * 1000;
/** Every other open state is an agent's turn; six hours before the owner hears. */
export const STALL_MS_OPEN = 6 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
/** A Slack call that has not settled by then is treated as failed and retried next tick. */
export const DELIVER_TIMEOUT_MS = 30_000;

export interface StallPingDeps {
  getOwners: () => Promise<Array<{ user_id: string }>>;
  ensureUserDm: (userId: string) => Promise<Pick<MessagingGroup, 'channel_type' | 'platform_id' | 'instance'> | null>;
  getDeliveryAdapter: () => Pick<ChannelDeliveryAdapter, 'deliver'> | null;
  recordOwnerPing: typeof recordOwnerPing;
  /** Test hook; production uses DELIVER_TIMEOUT_MS. */
  deliverTimeoutMs?: number;
}

const liveDeps: StallPingDeps = { getOwners, ensureUserDm, getDeliveryAdapter, recordOwnerPing };

type Recipient = Pick<MessagingGroup, 'channel_type' | 'platform_id' | 'instance'>;

/** Who the handoff is waiting on in this deployment and what unblocks it. */
const NEXT_STEP: Record<Exclude<HandoffStatus, 'closed'>, (id: string) => { who: string; action: string }> = {
  created: () => ({ who: 'Atlas', action: 'deliver the formal handoff' }),
  delivered: () => ({ who: 'Echo', action: 'record a review outcome' }),
  changes_required: (id) => ({ who: 'Atlas', action: `revise with \`ncl handoffs create --supersedes ${id}\`` }),
  review_blocked: () => ({ who: 'you', action: 'resolve the blocker, then Atlas revises with --supersedes' }),
  approved: () => ({ who: 'Atlas', action: 'acknowledge' }),
  acknowledged: () => ({ who: 'Atlas', action: 'close with evidence' }),
};

function stallThreshold(status: HandoffStatus): number {
  return status === 'review_blocked' ? STALL_MS_BLOCKED : STALL_MS_OPEN;
}

export function stallMessage(row: HandoffRow, ageMs: number): string {
  const hours = Math.floor(ageMs / HOUR_MS);
  const { who, action } = NEXT_STEP[row.status as Exclude<HandoffStatus, 'closed'>](row.id);
  return [
    '⏳ Handoff needs attention',
    `${row.id} (${row.project}) has been \`${row.status}\` for ${hours} hours.`,
    `Waiting on: ${who}. Next: ${action}.`,
    `ncl handoffs get --id ${row.id}`,
  ].join('\n');
}

/**
 * Open rows with no trustworthy successor: the only rows a ping can be about.
 * A successor whose fingerprint no longer matches its fields is a corrupted
 * link and must not hide the prior (that would be a silent missed ping).
 */
async function openUnsupersededRows(): Promise<HandoffRow[]> {
  const rows = await listAllHandoffs();
  const { superseded, corrupted } = trustedSupersededIds(rows);
  if (corrupted.length > 0) {
    log.warn('Handoff stall sweep: ignoring successor links whose fingerprint does not match their fields', {
      successors: corrupted.map((row) => row.id),
    });
  }
  return rows.filter((row) => row.status !== 'closed' && !superseded.has(row.id));
}

/** Bound a promise; the underlying call may still finish later, which the at-least-once contract tolerates. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function alreadyPinged(row: HandoffRow, recipient: string): Promise<boolean> {
  const events = await listHandoffEvents(row.id);
  return events.some((event) => {
    if (event.event_type !== OWNER_PINGED_EVENT) return false;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed audit row is data; it must neither stop the sweep nor count as a ping
    } catch (err) {
      log.warn('Handoff stall sweep: malformed owner_pinged payload ignored', {
        handoffId: row.id,
        eventId: event.id,
        err,
      });
      return false;
    }
    return payload.status === row.status && payload.updated_at === row.updated_at && payload.recipient === recipient;
  });
}

/** True when the row is still in exactly the state the scan saw and still has no successor. */
async function stillStalled(scanned: HandoffRow): Promise<boolean> {
  const current = await getHandoff(scanned.id);
  if (!current || current.status !== scanned.status || current.updated_at !== scanned.updated_at) return false;
  return (await openUnsupersededRows()).some((row) => row.id === scanned.id);
}

export async function sweepStalledHandoffs(now = Date.now(), deps: StallPingDeps = liveDeps): Promise<void> {
  const stalled = (await openUnsupersededRows()).filter(
    (row) => now - Date.parse(row.updated_at) > stallThreshold(row.status),
  );
  if (stalled.length === 0) return;

  const adapter = deps.getDeliveryAdapter();
  const recipients: Recipient[] = [];
  for (const owner of await deps.getOwners()) {
    const dm = await deps.ensureUserDm(owner.user_id);
    if (dm) recipients.push(dm);
  }
  if (!adapter || recipients.length === 0) {
    log.warn('Handoff stall sweep: no delivery adapter or owner DM; pings deferred', {
      stalled: stalled.map((row) => row.id),
      hasAdapter: !!adapter,
      recipients: recipients.length,
    });
    return;
  }

  for (const row of stalled) {
    for (const mg of recipients) {
      if (await alreadyPinged(row, mg.platform_id)) continue;
      // The scan may be stale by the time this pair is reached; do not report
      // a state the handoff has already left.
      if (!(await stillStalled(row))) continue;

      let platformMessageId: string | undefined;
      try {
        platformMessageId = await withTimeout(
          adapter.deliver(
            mg.channel_type,
            mg.platform_id,
            null,
            'chat-sdk',
            JSON.stringify({ text: stallMessage(row, now - Date.parse(row.updated_at)) }),
            undefined,
            mg.instance,
          ),
          deps.deliverTimeoutMs ?? DELIVER_TIMEOUT_MS,
          `stall ping to ${mg.platform_id}`,
        );
      } catch (err) {
        log.warn('Handoff stall ping failed; will retry next sweep', {
          handoffId: row.id,
          recipient: mg.platform_id,
          err,
        });
        continue;
      }

      try {
        await deps.recordOwnerPing(row.id, {
          status: row.status,
          updated_at: row.updated_at,
          pinged_at: new Date(now).toISOString(),
          recipient: mg.platform_id,
          platform_message_id: platformMessageId ?? null,
        });
      } catch (err) {
        // The message went out but the record did not: the next tick will
        // send one duplicate. Accepted over a silent miss.
        log.error('Handoff stall ping sent but not recorded; next sweep will repeat it', {
          handoffId: row.id,
          recipient: mg.platform_id,
          err,
        });
      }
    }
  }
}
