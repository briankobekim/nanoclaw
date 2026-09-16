/**
 * Nightly usage digest (docs/specs/usage-digest/plan.md §4.4).
 *
 * Runs once per host-sweep tick. After the configured local hour, every owner
 * who has not yet received today's digest gets one DM: per agent, the turns,
 * tokens and SDK-reported cost since that owner's previous digest; then what
 * is still open (handoffs, approval cards waiting on a human, memory ops).
 *
 * Contract is at-least-once per owner per local date (invariant 6): the
 * marker row in `usage_digest_deliveries` is written only AFTER the sender
 * resolved, so a failed send is retried on the next tick for that owner alone
 * and a crash between send and marker repeats one digest rather than losing
 * it. Nothing here wakes a container or writes to an agent inbox
 * (invariant 7), and no container-supplied string is ever rendered: agent
 * names come from the host's agent groups, providers from the host-derived
 * column, everything else is a count or a sum (invariant 8).
 */
import { DIGEST_HOUR, TIMEZONE } from '../../config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { listPendingApprovalsOpen } from '../../db/sessions.js';
import { log } from '../../log.js';
import { formatLocalStamp } from '../../timezone.js';
import { listAllHandoffs, trustedSupersededIds, type HandoffRow } from '../handoff-ledger/ledger.js';
import { listOps } from '../memory-gate/ops.js';
import { getOwners } from '../permissions/db/user-roles.js';
import { sendDigestTo } from './notify.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Open handoffs listed before the digest says "and N more". */
export const MAX_HANDOFF_LINES = 10;

export interface DigestDeliveryRow {
  owner_user_id: string;
  last_sent_local_date: string;
  window_end: string;
  updated_at: string;
}

export interface UsageDigestDeps {
  now: () => Date;
  timezone: () => string;
  digestHour: () => number | 'off';
  getOwners: () => Promise<Array<{ user_id: string }>>;
  /** Must resolve only when the adapter accepted the DM and throw otherwise (see notify.ts). */
  send: (ownerUserId: string, text: string) => Promise<void>;
  /** Marker upsert; a throw here is logged and the digest repeats next tick. */
  recordDelivery: (row: DigestDeliveryRow) => Promise<void>;
}

// ── Marker table ──

export async function getDigestDelivery(ownerUserId: string): Promise<DigestDeliveryRow | undefined> {
  return getDb().get<DigestDeliveryRow>('SELECT * FROM usage_digest_deliveries WHERE owner_user_id = ?', ownerUserId);
}

export async function upsertDigestDelivery(row: DigestDeliveryRow): Promise<void> {
  await getDb().run(
    `INSERT INTO usage_digest_deliveries (owner_user_id, last_sent_local_date, window_end, updated_at)
       VALUES (@owner_user_id, @last_sent_local_date, @window_end, @updated_at)
       ON CONFLICT (owner_user_id) DO UPDATE SET
         last_sent_local_date = excluded.last_sent_local_date,
         window_end = excluded.window_end,
         updated_at = excluded.updated_at`,
    row,
  );
}

const liveDeps: UsageDigestDeps = {
  now: () => new Date(),
  timezone: () => TIMEZONE,
  digestHour: () => DIGEST_HOUR,
  getOwners,
  send: (ownerUserId, text) => sendDigestTo(ownerUserId, text),
  recordDelivery: upsertDigestDelivery,
};

// ── Local time helpers ──

/** "YYYY-MM-DD" and the 0-23 hour of `date` in `timezone`. */
export function localDateAndHour(date: Date, timezone: string): { date: string; hour: number } {
  const stamp = formatLocalStamp(date, timezone); // "YYYY-MM-DD HH:mm"
  const hour = Number(stamp.slice(11, 13));
  return { date: stamp.slice(0, 10), hour: hour === 24 ? 0 : hour };
}

/** The calendar date one day before "YYYY-MM-DD". */
function previousDate(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** `yesterday 21:00` when the instant falls on the previous local day of `now`, else `YYYY-MM-DD HH:mm`. */
export function describeWindowStart(start: Date, now: Date, timezone: string): string {
  const stamp = formatLocalStamp(start, timezone);
  const today = localDateAndHour(now, timezone).date;
  if (stamp.slice(0, 10) === previousDate(today)) return `yesterday ${stamp.slice(11, 16)}`;
  return stamp;
}

// ── Number formatting ──

/** 182000 → "182k", 1200000 → "1.2M", 512 → "512". */
export function formatTokens(n: number): string {
  const trim = (value: string) => value.replace(/\.0$/, '');
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${trim((n / 1_000).toFixed(1))}k`;
  return String(n);
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** 2d 3h / 3h / 12m. */
export function formatAge(ms: number): string {
  const clamped = Math.max(0, ms);
  const days = Math.floor(clamped / DAY_MS);
  const hours = Math.floor((clamped % DAY_MS) / HOUR_MS);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(clamped / 60_000)}m`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function capitalise(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

// ── Per-agent aggregates ──

interface AgentAggregate {
  agent_group_id: string;
  turns: number;
  errors: number;
  reported_turns: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Host-derived provider of the unreported turns (the "(Codex)" label), null when every turn was reported. */
  unreported_provider: string | null;
}

async function aggregateTurns(windowStart: Date, windowEnd: Date): Promise<Map<string, AgentAggregate>> {
  const rows = await getDb().all<AgentAggregate>(
    `SELECT agent_group_id,
            COUNT(*)                                             AS turns,
            COALESCE(SUM(is_error), 0)                           AS errors,
            COALESCE(SUM(reported), 0)                           AS reported_turns,
            COALESCE(SUM(CASE WHEN reported = 1 THEN cost_usd END), 0) AS cost_usd,
            COALESCE(SUM(input_tokens), 0)                       AS input_tokens,
            COALESCE(SUM(output_tokens), 0)                      AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0)                  AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0)              AS cache_creation_tokens,
            MAX(CASE WHEN reported = 0 THEN provider END)        AS unreported_provider
       FROM usage_turns
      WHERE occurred_at > ? AND occurred_at <= ?
      GROUP BY agent_group_id`,
    windowStart.toISOString(),
    windowEnd.toISOString(),
  );
  return new Map(rows.map((row) => [row.agent_group_id, row]));
}

function agentLine(name: string, agg: AgentAggregate | undefined): string {
  if (!agg || agg.turns === 0) return `${name} — no turns`;
  const turns = plural(agg.turns, 'turn') + (agg.errors > 0 ? ` (${plural(agg.errors, 'error')})` : '');
  if (agg.reported_turns === 0) {
    return `${name} — ${turns}, cost not reported (${capitalise(agg.unreported_provider ?? 'unknown')})`;
  }
  const tokens = `${formatTokens(agg.input_tokens)} in / ${formatTokens(agg.output_tokens)} out, ${formatTokens(agg.cache_read_tokens)} cache read`;
  const cost =
    agg.reported_turns === agg.turns
      ? formatCost(agg.cost_usd)
      : `cost partial (${formatCost(agg.cost_usd)} over ${agg.reported_turns} of ${agg.turns} turns)`;
  return `${name} — ${turns}, ${tokens}, ${cost}`;
}

// ── Open work ──

/** Who a handoff in this state is waiting on: the reviewer once delivered, the source otherwise. */
function waitingOn(row: HandoffRow, names: Map<string, string>): string {
  const id = row.status === 'delivered' ? row.reviewer_agent_group_id : row.source_agent_group_id;
  return names.get(id) ?? id;
}

async function openHandoffLines(now: Date, names: Map<string, string>): Promise<string[]> {
  const rows = await listAllHandoffs();
  const { superseded, corrupted } = trustedSupersededIds(rows);
  if (corrupted.length > 0) {
    log.warn('Usage digest: ignoring successor links whose fingerprint does not match their fields', {
      successors: corrupted.map((row) => row.id),
    });
  }
  const open = rows
    .filter((row) => row.status !== 'closed' && !superseded.has(row.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (open.length === 0) return ['Handoffs: none'];
  const lines = open
    .slice(0, MAX_HANDOFF_LINES)
    .map(
      (row) =>
        `${row.id} — ${row.status}, ${formatAge(now.getTime() - Date.parse(row.created_at))} — waiting on ${waitingOn(row, names)}`,
    );
  if (open.length > MAX_HANDOFF_LINES) lines.push(`and ${open.length - MAX_HANDOFF_LINES} more (ncl missions list)`);
  return lines;
}

async function approvalsLine(now: Date): Promise<string> {
  const open = await listPendingApprovalsOpen();
  if (open.length === 0) return 'Approvals waiting on you: none';
  const oldestMs = Math.max(...open.map((row) => now.getTime() - Date.parse(row.created_at)));
  return `Approvals waiting on you: ${open.length} (oldest ${formatAge(oldestMs)})`;
}

async function memoryOpsLine(): Promise<string> {
  const ops = await listOps();
  const queued = ops.filter((op) => op.status === 'queued' || op.status === 'prepared').length;
  const conflict = ops.filter((op) => op.status === 'conflict').length;
  if (queued === 0 && conflict === 0) return 'Memory ops: none';
  return `Memory ops: ${queued} queued, ${conflict} in conflict`;
}

// ── Text ──

export interface DigestBuildArgs {
  /** Exclusive start of the window. */
  windowStart: Date;
  /** Inclusive end of the window; also "now" for ages. */
  windowEnd: Date;
  timezone: string;
}

export interface DigestBuild {
  text: string;
  turns: number;
  /** Sum of SDK-reported cost over the window; null when no turn was reported. */
  reportedCostUsd: number | null;
}

export async function buildDigest(args: DigestBuildArgs): Promise<DigestBuild> {
  const { windowStart, windowEnd, timezone } = args;
  const groups = (await getAllAgentGroups()).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const byAgent = await aggregateTurns(windowStart, windowEnd);

  const lines = [`Usage digest — since ${describeWindowStart(windowStart, windowEnd, timezone)}`];
  for (const group of groups) lines.push(agentLine(group.name, byAgent.get(group.id)));

  let turns = 0;
  let reportedTurns = 0;
  let reportedCost = 0;
  for (const agg of byAgent.values()) {
    turns += agg.turns;
    reportedTurns += agg.reported_turns;
    reportedCost += agg.cost_usd;
  }
  const reportedCostUsd = reportedTurns > 0 ? reportedCost : null;
  if (reportedCostUsd !== null) lines.push(`Total reported cost: ${formatCost(reportedCostUsd)}`);

  lines.push('', 'Open');
  lines.push(...(await openHandoffLines(windowEnd, names)));
  lines.push(await approvalsLine(windowEnd));
  lines.push(await memoryOpsLine());

  return { text: lines.join('\n'), turns, reportedCostUsd };
}

export async function buildDigestText(args: DigestBuildArgs): Promise<string> {
  return (await buildDigest(args)).text;
}

// ── Sweep ──

/** Window start for an owner's first digest: the earliest record, or the last 24 h when there is none. */
async function firstWindowStart(now: Date): Promise<Date> {
  const row = await getDb().get<{ earliest: string | null }>('SELECT MIN(occurred_at) AS earliest FROM usage_turns');
  const earliest = row?.earliest ? Date.parse(row.earliest) : Number.NaN;
  // The window is exclusive at its start; step back so the earliest record is inside it.
  return Number.isNaN(earliest) ? new Date(now.getTime() - DAY_MS) : new Date(earliest - 1);
}

async function digestOwner(owner: string, today: string, now: Date, tz: string, deps: UsageDigestDeps): Promise<void> {
  const existing = await getDigestDelivery(owner);
  if (existing?.last_sent_local_date === today) return;

  const windowStart = existing ? new Date(existing.window_end) : await firstWindowStart(now);
  const digest = await buildDigest({ windowStart, windowEnd: now, timezone: tz });
  await deps.send(owner, digest.text);
  // Only a resolved send reaches the marker (invariant 6).
  await deps.recordDelivery({
    owner_user_id: owner,
    last_sent_local_date: today,
    window_end: now.toISOString(),
    updated_at: now.toISOString(),
  });
  log.info('Usage digest sent', {
    ownerUserId: owner,
    date: today,
    windowStart: windowStart.toISOString(),
    turns: digest.turns,
    reportedCostUsd: digest.reportedCostUsd,
  });
}

/**
 * One tick. Never throws: a failing owner is logged and retried on the next
 * tick; the other owners are unaffected.
 */
export async function usageDigestSweep(overrides: Partial<UsageDigestDeps> = {}): Promise<void> {
  const deps: UsageDigestDeps = { ...liveDeps, ...overrides };
  try {
    const digestHour = deps.digestHour();
    if (digestHour === 'off') return;
    const now = deps.now();
    const tz = deps.timezone();
    const { date: today, hour } = localDateAndHour(now, tz);
    if (hour < digestHour) return;

    for (const owner of await deps.getOwners()) {
      try {
        await digestOwner(owner.user_id, today, now, tz, deps);
        // eslint-disable-next-line no-catch-all/no-catch-all -- a failed send or marker is retried next tick for this owner alone; the others must still get theirs
      } catch (err) {
        log.error('Usage digest failed for owner; will retry next tick', {
          ownerUserId: owner.user_id,
          date: today,
          err,
        });
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- the sweep must never throw out of the host sweep tick
  } catch (err) {
    log.error('Usage digest sweep failed', { err });
  }
}
