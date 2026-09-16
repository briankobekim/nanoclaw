import { getAllAgentGroups } from '../../db/agent-groups.js';
import { findTaskSessions, TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import type { TaskRecord } from '../../mailbox/index.js';
import {
  listAllHandoffs,
  listHandoffsForAgent,
  trustedSupersededIds,
  type HandoffRow,
  type HandoffStatus,
} from '../../modules/handoff-ledger/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { registerResource } from '../crud.js';
import { formatMissionsTable, type MissionListRow } from '../format-missions.js';
import type { CallerContext } from '../frame.js';

const DEFAULT_RECENT_DAYS = 30;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface GroupRef {
  id: string;
  name: string;
}

interface TaskMission {
  row: MissionListRow;
  sessionId: string;
  perSeriesSession: boolean;
  terminal: boolean;
}

interface HandoffMission {
  row: MissionListRow;
  sourceSessionId: string | null;
  terminal: boolean;
}

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

function handoffStage(status: HandoffStatus): string {
  switch (status) {
    case 'created':
      return 'awaiting_delivery';
    case 'delivered':
      return 'ready_for_review';
    case 'changes_required':
      return 'changes_requested';
    case 'review_blocked':
      return 'blocked';
    case 'approved':
    case 'acknowledged':
      return 'review_complete';
    case 'closed':
      return 'completed';
  }
}

function handoffNextAction(status: HandoffStatus, id: string): string {
  switch (status) {
    case 'created':
      return 'deliver formal handoff';
    case 'delivered':
      return 'reviewer records outcome';
    case 'changes_required':
      return `source revises with ncl handoffs create --supersedes ${id}`;
    case 'review_blocked':
      return `resolve the blocker, then revise with ncl handoffs create --supersedes ${id}`;
    case 'approved':
      return 'owner acknowledges; confirm ship authority';
    case 'acknowledged':
      return 'close with evidence; confirm ship authority';
    case 'closed':
      return 'none';
  }
}

function handoffShipping(status: HandoffStatus): 'no' | 'unknown' {
  // The ledger proves review state, not human authorization to push, deploy, or publish.
  return ['created', 'delivered', 'changes_required', 'review_blocked'].includes(status) ? 'no' : 'unknown';
}

const ABANDONED_PREFIX = 'abandoned by operator: ';

function handoffMission(row: HandoffRow, names: Map<string, string>, superseded: boolean): MissionListRow {
  // A superseded round is finished work: its successor carries the thread
  // forward, so it shows as terminal with nothing left to do. An abandoned
  // row was closed by the operator WITHOUT finishing: never "completed".
  const abandoned = row.status === 'closed' && (row.closure_evidence ?? '').startsWith(ABANDONED_PREFIX);
  const stage = superseded ? 'superseded' : abandoned ? 'abandoned' : handoffStage(row.status);
  const state = abandoned
    ? `closed: abandoned (${(row.closure_evidence ?? '').slice(ABANDONED_PREFIX.length)})`
    : row.review_outcome
      ? `${row.status}: ${row.review_outcome}`
      : row.status;
  return {
    mission_id: row.id,
    kind: 'handoff',
    owner_agent_group_id: row.source_agent_group_id,
    owner: names.get(row.source_agent_group_id) ?? row.source_agent_group_id,
    class: 'unknown',
    project: row.project,
    stage,
    handoff_state: state,
    next_action: superseded || abandoned ? 'none' : handoffNextAction(row.status, row.id),
    shipping_allowed: handoffShipping(row.status),
    updated_at: row.updated_at,
    revises: row.supersedes ?? '',
  };
}

function taskStage(status: TaskRecord['status']): string {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'paused':
    case 'failed':
      return 'blocked';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
  }
}

function taskNextAction(row: TaskRecord): string {
  switch (row.status) {
    case 'pending':
      return row.processAfter ? `await run ${row.processAfter}` : 'await scheduled run';
    case 'paused':
      return 'resume or cancel task';
    case 'failed':
      return 'inspect failure and retry';
    case 'completed':
    case 'cancelled':
      return 'none';
  }
}

function latestIso(...values: Array<string | null | undefined>): string {
  let latest: { value: string; time: number } | undefined;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isNaN(time) && (!latest || time > latest.time)) latest = { value, time };
  }
  return latest?.value ?? values.find((value): value is string => Boolean(value)) ?? 'unknown';
}

async function taskMissions(groups: GroupRef[]): Promise<TaskMission[]> {
  const rows: TaskMission[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const session of await findTaskSessions(group.id, true)) {
      const perSeries = session.thread_id?.startsWith(`${TASKS_SYSTEM_THREAD_ID}:`)
        ? session.thread_id.slice(`${TASKS_SYSTEM_THREAD_ID}:`.length)
        : undefined;
      const found = await withExistingMailboxSession(group.id, session.id, (mailbox) => {
        if (perSeries) {
          const task = mailbox.getTask(perSeries);
          return task ? [{ task, lastRun: mailbox.getTaskStats(perSeries).lastRun }] : [];
        }
        // Legacy shared task sessions can enumerate live series, but not closed series.
        return mailbox.listLiveTasks().map((task) => ({
          task,
          lastRun: mailbox.getTaskStats(task.seriesId ?? task.id).lastRun,
        }));
      });
      for (const item of found ?? []) {
        const series = item.task.seriesId ?? item.task.id;
        const key = `${group.id}:${series}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          sessionId: session.id,
          perSeriesSession: Boolean(perSeries),
          terminal: ['completed', 'failed', 'cancelled'].includes(item.task.status),
          row: {
            mission_id: series,
            kind: 'task',
            owner_agent_group_id: group.id,
            owner: group.name,
            class: 'unknown',
            project: 'unknown',
            stage: taskStage(item.task.status),
            handoff_state: 'not_recorded',
            next_action: taskNextAction(item.task),
            shipping_allowed: 'unknown',
            updated_at: latestIso(item.lastRun, item.task.timestamp),
            revises: '',
          },
        });
      }
    }
  }
  return rows;
}

function isRecent(row: MissionListRow, cutoff: number): boolean {
  const updated = Date.parse(row.updated_at);
  return Number.isNaN(updated) || updated >= cutoff;
}

async function listMissions(args: Record<string, unknown>, ctx: CallerContext): Promise<MissionListRow[]> {
  const recentDays = boundedInteger(args.recent_days, DEFAULT_RECENT_DAYS, 'recent-days', 3650);
  const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 'limit', MAX_LIMIT);
  const groups = await selectedGroups(args, ctx);
  const selectedIds = new Set(groups.map((group) => group.id));
  const names = new Map((await getAllAgentGroups()).map((group) => [group.id, group.name]));
  const hostGroupFilter = ctx.caller === 'host' && Boolean(stringArg(args.group));
  const handoffs =
    ctx.caller === 'agent'
      ? await listHandoffsForAgent(ctx.agentGroupId)
      : hostGroupFilter
        ? (await listAllHandoffs()).filter(
            (row) => selectedIds.has(row.source_agent_group_id) || selectedIds.has(row.reviewer_agent_group_id),
          )
        : await listAllHandoffs();
  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  const supersededIds = trustedSupersededIds(handoffs).superseded;
  const handoffRows: HandoffMission[] = handoffs.map((row) => {
    const superseded = supersededIds.has(row.id);
    return {
      sourceSessionId: row.source_session_id,
      terminal: superseded || ['changes_required', 'review_blocked', 'closed'].includes(row.status),
      row: handoffMission(row, names, superseded),
    };
  });
  const visibleHandoffs = handoffRows.filter(({ row, terminal }) => !terminal || isRecent(row, cutoff));
  const linkedTaskSessions = new Set(
    visibleHandoffs.map(({ sourceSessionId }) => sourceSessionId).filter((value): value is string => Boolean(value)),
  );
  const taskRows = (await taskMissions(groups))
    .filter(({ row, terminal }) => !terminal || isRecent(row, cutoff))
    .filter(({ sessionId, perSeriesSession }) => !perSeriesSession || !linkedTaskSessions.has(sessionId));
  // A ledger handoff created by a task session is the richer record for that
  // same mission, so suppress only that exactly linked task row. No prompt or
  // naming heuristics are used to guess at other relationships.
  return [...visibleHandoffs.map(({ row }) => row), ...taskRows.map(({ row }) => row)]
    .sort((a, b) => {
      const byTime = (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);
      return byTime || a.mission_id.localeCompare(b.mission_id);
    })
    .slice(0, limit);
}

registerResource({
  name: 'mission',
  plural: 'missions',
  table: 'missions',
  description:
    'Read-only mission-control view derived from scheduled tasks and the trusted handoff ledger; unknown fields stay explicit.',
  idColumn: 'mission_id',
  scopeField: 'owner_agent_group_id',
  columns: [
    { name: 'mission_id', type: 'string', description: 'Task series ID or handoff ID.' },
    { name: 'kind', type: 'string', description: 'Source record type.', enum: ['task', 'handoff'] },
    { name: 'owner_agent_group_id', type: 'string', description: 'Owning agent group ID.' },
    { name: 'owner', type: 'string', description: 'Owning agent group name.' },
    { name: 'class', type: 'string', description: 'Recorded simple/standard/complex class, or unknown.' },
    { name: 'project', type: 'string', description: 'Recorded project, or unknown.' },
    { name: 'stage', type: 'string', description: 'Derived operational stage.' },
    { name: 'handoff_state', type: 'string', description: 'Exact review/handoff state, or not_recorded.' },
    { name: 'next_action', type: 'string', description: 'Next action supported by the current source state.' },
    { name: 'shipping_allowed', type: 'string', description: 'No or unknown; review alone never grants authority.' },
    { name: 'updated_at', type: 'string', description: 'Most recent timestamp exposed by the source record.' },
    {
      name: 'revises',
      type: 'string',
      description: 'Prior handoff ID when this mission is a revision; empty otherwise.',
    },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List active missions plus recently terminal missions in one concise view.',
      args: [
        {
          name: 'group',
          type: 'string',
          description:
            'Include tasks owned by and handoffs involving this group (host callers; auto-scoped inside a container).',
        },
        {
          name: 'recent_days',
          type: 'number',
          description: `Terminal-history window in days (default ${DEFAULT_RECENT_DAYS}).`,
        },
        { name: 'limit', type: 'number', description: `Maximum rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      ],
      handler: (args, ctx) => listMissions(args, ctx),
      formatHuman: (rows) => formatMissionsTable(rows as MissionListRow[]),
    },
  },
});
