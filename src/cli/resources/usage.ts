/**
 * `ncl usage` — read-only view over the usage_turns ledger
 * (docs/specs/usage-digest/plan.md §4.3).
 *
 * Virtual resource: no generic operations, two custom verbs. Custom verbs
 * bypass the dispatcher's generic scope post-filter, so scoping is done here:
 * an agent caller is pinned to its own group; a host caller sees every group
 * or one `--group`. Only the table's stored, validated columns are rendered —
 * nothing derived from the free-form payload (model_usage_json is omitted).
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { formatLocalStamp } from '../../timezone.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

const DEFAULT_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

interface GroupRef {
  id: string;
  name: string;
}

interface UsageTurnRow {
  session_id: string;
  turn_id: string;
  agent_group_id: string;
  provider: string;
  model: string;
  reported: number;
  is_error: number;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  duration_ms: number | null;
  num_turns: number | null;
  occurred_at: string;
  ingested_at: string;
}

export interface UsageSummaryRow {
  agent_group_id: string;
  agent: string;
  /** Local calendar date (YYYY-MM-DD) of occurred_at in the group's timezone. */
  day: string;
  turns: number;
  error_turns: number;
  reported_turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Sum over reported turns; null when no turn of this agent/day was reported. */
  cost_usd: number | null;
}

export type UsageListRow = UsageTurnRow & { agent: string };

const TURN_COLUMNS =
  'session_id, turn_id, agent_group_id, provider, model, reported, is_error, cost_usd, ' +
  'input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, num_turns, ' +
  'occurred_at, ingested_at';

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedInteger(value: unknown, fallback: number, label: string, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`--${label} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

/** Same resolution as `ncl missions`: agents are pinned to their own group. */
async function selectedGroups(args: Record<string, unknown>, ctx: CallerContext): Promise<GroupRef[]> {
  const groups = await getAllAgentGroups();
  if (ctx.caller === 'agent') {
    const own = groups.find((group) => group.id === ctx.agentGroupId);
    return own ? [{ id: own.id, name: own.name }] : [{ id: ctx.agentGroupId, name: ctx.agentGroupId }];
  }

  const ref = stringArg(args.group);
  if (!ref) return groups.map(({ id, name }) => ({ id, name }));
  const matches = groups.filter((group) => group.id === ref || group.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 0) throw new Error(`agent not found: ${ref}`);
  if (matches.length > 1) throw new Error(`agent name is ambiguous; use an agent group id: ${ref}`);
  return [{ id: matches[0]!.id, name: matches[0]!.name }];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Local calendar date of `date` in `tz`, as YYYY-MM-DD. */
function localDay(date: Date, tz: string): string {
  return formatLocalStamp(date, tz).slice(0, 10);
}

/**
 * The last `days` local calendar dates ending today, computed by calendar
 * arithmetic on the date parts (not by subtracting 24 h from now, which
 * skips or repeats a date across a DST change).
 */
function recentLocalDays(now: Date, tz: string, days: number): Set<string> {
  const [year, month, day] = localDay(now, tz).split('-').map(Number) as [number, number, number];
  const out = new Set<string>();
  for (let i = 0; i < days; i++) {
    out.add(new Date(Date.UTC(year, month - 1, day - i)).toISOString().slice(0, 10));
  }
  return out;
}

async function usageSummary(args: Record<string, unknown>, ctx: CallerContext): Promise<UsageSummaryRow[]> {
  const days = boundedInteger(args.days, DEFAULT_DAYS, 'days', MAX_DAYS);
  const groups = await selectedGroups(args, ctx);
  if (groups.length === 0) return [];

  const now = new Date();
  // Coarse SQL bound (one extra day of slack for any timezone offset); the
  // exact local-day bucketing happens below in TypeScript.
  const since = new Date(now.getTime() - (days + 1) * DAY_MS).toISOString();
  const rows = await getDb().all<UsageTurnRow>(
    `SELECT ${TURN_COLUMNS} FROM usage_turns
      WHERE agent_group_id IN (${placeholders(groups.length)}) AND occurred_at >= ?
      ORDER BY agent_group_id, occurred_at`,
    ...groups.map((group) => group.id),
    since,
  );

  const buckets = new Map<string, UsageSummaryRow>();
  for (const group of groups) {
    const tz = await resolveGroupTimezone(group.id);
    const window = recentLocalDays(now, tz, days);
    for (const row of rows) {
      if (row.agent_group_id !== group.id) continue;
      const occurred = new Date(row.occurred_at);
      if (Number.isNaN(occurred.getTime())) continue;
      const day = localDay(occurred, tz);
      if (!window.has(day)) continue;

      const key = `${group.id}\n${day}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          agent_group_id: group.id,
          agent: group.name,
          day,
          turns: 0,
          error_turns: 0,
          reported_turns: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cost_usd: null,
        };
        buckets.set(key, bucket);
      }
      bucket.turns += 1;
      if (row.is_error) bucket.error_turns += 1;
      bucket.input_tokens += row.input_tokens;
      bucket.output_tokens += row.output_tokens;
      bucket.cache_read_tokens += row.cache_read_tokens;
      bucket.cache_creation_tokens += row.cache_creation_tokens;
      if (row.reported) {
        bucket.reported_turns += 1;
        bucket.cost_usd = (bucket.cost_usd ?? 0) + (row.cost_usd ?? 0);
      }
    }
  }

  return [...buckets.values()].sort(
    (a, b) =>
      a.agent.localeCompare(b.agent) || a.agent_group_id.localeCompare(b.agent_group_id) || a.day.localeCompare(b.day),
  );
}

async function usageList(args: Record<string, unknown>, ctx: CallerContext): Promise<UsageListRow[]> {
  const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 'limit', MAX_LIMIT);
  const groups = await selectedGroups(args, ctx);
  if (groups.length === 0) return [];
  const names = new Map(groups.map((group) => [group.id, group.name]));

  const rows = await getDb().all<UsageTurnRow>(
    `SELECT ${TURN_COLUMNS} FROM usage_turns
      WHERE agent_group_id IN (${placeholders(groups.length)})
      ORDER BY occurred_at DESC, ingested_at DESC, turn_id DESC
      LIMIT ?`,
    ...groups.map((group) => group.id),
    limit,
  );
  return rows.map((row) => ({ ...row, agent: names.get(row.agent_group_id) ?? row.agent_group_id }));
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

function table(columns: readonly string[], body: string[][]): string {
  const widths = columns.map((column, index) => Math.max(column.length, ...body.map((row) => row[index]!.length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  return [line(columns), ...body.map(line)].join('\n');
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function summaryCost(row: UsageSummaryRow): string {
  if (row.cost_usd === null || row.reported_turns === 0) return 'not reported';
  if (row.reported_turns < row.turns) {
    return `${money(row.cost_usd)} partial (${row.reported_turns} of ${row.turns} turns)`;
  }
  return money(row.cost_usd);
}

const SUMMARY_COLS = [
  'AGENT',
  'DAY',
  'TURNS',
  'ERRORS',
  'INPUT',
  'OUTPUT',
  'CACHE READ',
  'CACHE WRITE',
  'COST',
] as const;

export function formatUsageSummary(rows: UsageSummaryRow[]): string {
  if (rows.length === 0) return 'No usage recorded.';
  return table(
    SUMMARY_COLS,
    rows.map((row) => [
      row.agent,
      row.day,
      String(row.turns),
      String(row.error_turns),
      String(row.input_tokens),
      String(row.output_tokens),
      String(row.cache_read_tokens),
      String(row.cache_creation_tokens),
      summaryCost(row),
    ]),
  );
}

const LIST_COLS = [
  'OCCURRED',
  'AGENT',
  'PROVIDER',
  'MODEL',
  'TURN',
  'ERROR',
  'INPUT',
  'OUTPUT',
  'CACHE READ',
  'CACHE WRITE',
  'COST',
  'SESSION',
] as const;

export function formatUsageList(rows: UsageListRow[]): string {
  if (rows.length === 0) return 'No usage recorded.';
  return table(
    LIST_COLS,
    rows.map((row) => [
      row.occurred_at,
      row.agent,
      row.provider,
      row.model,
      row.turn_id,
      row.is_error ? 'yes' : 'no',
      String(row.input_tokens),
      String(row.output_tokens),
      String(row.cache_read_tokens),
      String(row.cache_creation_tokens),
      row.reported && row.cost_usd !== null ? money(row.cost_usd) : 'not reported',
      row.session_id,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const GROUP_ARG = {
  name: 'group',
  type: 'string',
  description: 'Agent group name or id (host callers; auto-scoped to your own group inside a container).',
} as const;

registerResource({
  name: 'usage',
  plural: 'usage',
  table: 'usage_turns',
  description:
    'Read-only per-turn usage ledger: which agent ran, tokens by class, and the SDK cost figure. ' +
    'Codex turns are counted but their cost is "not reported", never zero.',
  idColumn: 'turn_id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'session_id', type: 'string', description: 'Host session the turn ran in.' },
    { name: 'turn_id', type: 'string', description: 'SDK result id, or a random id when the SDK gave none.' },
    { name: 'agent_group_id', type: 'string', description: 'Host-attributed agent group.' },
    { name: 'provider', type: 'string', description: 'Host-derived provider (claude, codex, ...).' },
    { name: 'model', type: 'string', description: 'Host-derived model from the group container config.' },
    { name: 'reported', type: 'number', description: '1 when the provider reported usage; 0 otherwise.' },
    { name: 'is_error', type: 'number', description: '1 when the turn ended in an error.' },
    { name: 'cost_usd', type: 'number', description: 'SDK cost estimate; null when not reported.' },
    { name: 'input_tokens', type: 'number', description: 'Input tokens.' },
    { name: 'output_tokens', type: 'number', description: 'Output tokens.' },
    { name: 'cache_read_tokens', type: 'number', description: 'Prompt-cache read tokens.' },
    { name: 'cache_creation_tokens', type: 'number', description: 'Prompt-cache creation tokens.' },
    { name: 'duration_ms', type: 'number', description: 'Turn wall time reported by the SDK, if any.' },
    { name: 'num_turns', type: 'number', description: 'SDK-internal turn count, if any.' },
    { name: 'occurred_at', type: 'string', description: 'Container clock at the end of the turn (ISO 8601).' },
    { name: 'ingested_at', type: 'string', description: 'Host clock when the record was persisted.' },
  ],
  operations: {},
  customOperations: {
    summary: {
      access: 'open',
      description:
        'Per-agent, per-local-day totals over the last N days.\n\n' +
        "Days are the local calendar dates of occurred_at in each group's timezone. " +
        'cost_usd sums reported turns only and is null when nothing was reported; the human view ' +
        'prints "not reported" or "partial (r of t turns)" so an unreported provider never looks free.',
      examples: ['ncl usage summary', 'ncl usage summary --days 7 --group Atlas'],
      args: [
        GROUP_ARG,
        {
          name: 'days',
          type: 'number',
          description: `Local days to include, ending today (default ${DEFAULT_DAYS}, max ${MAX_DAYS}).`,
        },
      ],
      handler: (args, ctx) => usageSummary(args, ctx),
      formatHuman: (rows) => formatUsageSummary(rows as UsageSummaryRow[]),
    },
    list: {
      access: 'open',
      description: 'Raw usage_turns rows, newest by occurred_at first.',
      examples: ['ncl usage list --limit 20'],
      args: [
        GROUP_ARG,
        { name: 'limit', type: 'number', description: `Maximum rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      ],
      handler: (args, ctx) => usageList(args, ctx),
      formatHuman: (rows) => formatUsageList(rows as UsageListRow[]),
    },
  },
});
