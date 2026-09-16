import { getDb } from '../../db/connection.js';
import {
  abandonHandoff,
  acknowledgeHandoff,
  closeHandoff,
  createHandoff,
  getHandoff,
  listAllHandoffs,
  listHandoffEvents,
  listHandoffsForAgent,
  markHandoffDelivered,
  reviewHandoff,
  type HandoffStatus,
  type ReviewOutcome,
} from '../../modules/handoff-ledger/index.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

const STATUSES: HandoffStatus[] = [
  'created',
  'delivered',
  'approved',
  'changes_required',
  'review_blocked',
  'acknowledged',
  'closed',
];
const REVIEW_OUTCOMES: ReviewOutcome[] = [
  'APPROVED',
  'APPROVED WITH MINOR NOTES',
  'CHANGES REQUIRED',
  'REVIEW BLOCKED',
];

function stringArg(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = args[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new Error(`--${name.replace(/_/g, '-')} is required`);
  return undefined;
}

async function resolveAgent(ref: string): Promise<string> {
  const rows = await getDb().all<{ id: string }>(
    'SELECT id FROM agent_groups WHERE id = ? OR LOWER(name) = LOWER(?) ORDER BY id',
    ref,
    ref,
  );
  if (rows.length === 0) throw new Error(`agent not found: ${ref}`);
  if (rows.length > 1) throw new Error(`agent name is ambiguous; use an agent group id: ${ref}`);
  return rows[0]!.id;
}

async function actor(args: Record<string, unknown>, ctx: CallerContext): Promise<string> {
  if (ctx.caller === 'agent') return ctx.agentGroupId;
  return resolveAgent(stringArg(args, 'actor')!);
}

async function visibleHandoff(id: string, ctx: CallerContext) {
  const row = await getHandoff(id);
  if (!row) throw new Error(`handoff not found: ${id}`);
  if (
    ctx.caller === 'agent' &&
    row.source_agent_group_id !== ctx.agentGroupId &&
    row.reviewer_agent_group_id !== ctx.agentGroupId
  ) {
    throw new Error(`handoff not found: ${id}`);
  }
  return row;
}

registerResource({
  name: 'handoff',
  plural: 'handoffs',
  table: 'handoffs',
  description:
    'Trusted append-only handoff ledger. It binds one source agent, reviewer, project, goal, and fingerprint to a strict created→delivered→reviewed→acknowledged→closed lifecycle.',
  idColumn: 'id',
  scopeField: 'source_agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'Stable handoff tracking ID.' },
    { name: 'source_agent_group_id', type: 'string', description: 'Agent that owns and closes the handoff.' },
    { name: 'reviewer_agent_group_id', type: 'string', description: 'Agent authorized to review the handoff.' },
    { name: 'source_session_id', type: 'string', description: 'Session that created the handoff.' },
    { name: 'project', type: 'string', description: 'Registered project name, or none.' },
    { name: 'goal', type: 'string', description: 'Exact review goal.' },
    { name: 'outcome', type: 'string', description: 'Desired result and success evidence.' },
    { name: 'scope', type: 'string', description: 'Approved and excluded scope.' },
    { name: 'authority', type: 'string', description: 'Highest approved authority level.' },
    { name: 'fingerprint', type: 'string', description: 'SHA-256 barcode of the immutable handoff fields.' },
    { name: 'status', type: 'string', description: 'Current verified lifecycle state.', enum: STATUSES },
    { name: 'review_outcome', type: 'string', description: 'Formal Echo outcome.' },
    { name: 'review_notes', type: 'string', description: 'Optional reviewer notes.' },
    { name: 'closure_evidence', type: 'string', description: 'Evidence supplied when closing.' },
    { name: 'created_at', type: 'string', description: 'Creation time.' },
    { name: 'updated_at', type: 'string', description: 'Last transition time.' },
    { name: 'closed_at', type: 'string', description: 'Closure time.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List handoffs visible to the caller. Optionally filter with --status.',
      args: [{ name: 'status', type: 'string', description: 'Lifecycle status.', enum: STATUSES }],
      handler: async (args, ctx) => {
        const status = stringArg(args, 'status', false) as HandoffStatus | undefined;
        return ctx.caller === 'agent' ? listHandoffsForAgent(ctx.agentGroupId, status) : listAllHandoffs(status);
      },
    },
    get: {
      access: 'open',
      description: 'Get one handoff by tracking ID.',
      args: [{ name: 'id', type: 'string', description: 'Handoff ID.', required: true }],
      handler: async (args, ctx) => visibleHandoff(stringArg(args, 'id')!, ctx),
    },
    events: {
      access: 'open',
      description: 'Read the append-only event timeline for one visible handoff.',
      args: [{ name: 'id', type: 'string', description: 'Handoff ID.', required: true }],
      handler: async (args, ctx) => {
        const id = stringArg(args, 'id')!;
        await visibleHandoff(id, ctx);
        return listHandoffEvents(id);
      },
    },
    create: {
      access: 'open',
      description:
        'Create a trusted handoff. Agent callers are automatically the source; host callers also provide --source.',
      args: [
        { name: 'id', type: 'string', description: 'Optional stable ID.' },
        { name: 'source', type: 'string', description: 'Source agent name/id; host callers only.' },
        { name: 'reviewer', type: 'string', description: 'Reviewer agent name or id.', required: true },
        { name: 'project', type: 'string', description: 'Project name or none.', required: true },
        { name: 'goal', type: 'string', description: 'Exact goal.', required: true },
        { name: 'outcome', type: 'string', description: 'Desired result and evidence.', required: true },
        { name: 'scope', type: 'string', description: 'Included and excluded scope.', required: true },
        { name: 'authority', type: 'string', description: 'Approved authority.', required: true },
        {
          name: 'supersedes',
          type: 'string',
          description:
            'Prior handoff ID this revision replaces; that handoff must be changes_required or review_blocked.',
        },
      ],
      handler: async (args, ctx) => {
        const sourceAgentGroupId =
          ctx.caller === 'agent' ? ctx.agentGroupId : await resolveAgent(stringArg(args, 'source')!);
        const reviewerAgentGroupId = await resolveAgent(stringArg(args, 'reviewer')!);
        return createHandoff({
          id: stringArg(args, 'id', false),
          sourceAgentGroupId,
          reviewerAgentGroupId,
          sourceSessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
          project: stringArg(args, 'project')!,
          goal: stringArg(args, 'goal')!,
          outcome: stringArg(args, 'outcome')!,
          scope: stringArg(args, 'scope')!,
          authority: stringArg(args, 'authority')!,
          supersedes: stringArg(args, 'supersedes', false),
        });
      },
    },
    abandon: {
      access: 'open',
      hostOnly: true,
      description:
        'OPERATOR-ONLY. Close a handoff in any non-closed state without a review: test debris, a thread nobody ' +
        'will finish. The reason is recorded as closure evidence and as an `abandoned` event; nothing else changes.',
      args: [
        { name: 'id', type: 'string', description: 'Handoff ID.', required: true },
        { name: 'reason', type: 'string', description: 'Why it is being abandoned (recorded).', required: true },
      ],
      examples: ['ncl handoffs abandon --id handoff-123 --reason "smoke test from the revision-loop build"'],
      handler: async (args) => abandonHandoff(stringArg(args, 'id')!, stringArg(args, 'reason')!),
    },
    deliver: {
      access: 'open',
      description: 'Source records that the exact fingerprint was delivered to the reviewer.',
      args: [
        { name: 'id', type: 'string', description: 'Handoff ID.', required: true },
        { name: 'fingerprint', type: 'string', description: 'Exact handoff fingerprint.', required: true },
        { name: 'actor', type: 'string', description: 'Actor agent name/id; host callers only.' },
      ],
      handler: async (args, ctx) =>
        markHandoffDelivered(stringArg(args, 'id')!, await actor(args, ctx), stringArg(args, 'fingerprint')!),
    },
    review: {
      access: 'open',
      description: 'Reviewer records one formal outcome for the exact delivered fingerprint.',
      args: [
        { name: 'id', type: 'string', description: 'Handoff ID.', required: true },
        { name: 'fingerprint', type: 'string', description: 'Exact handoff fingerprint.', required: true },
        {
          name: 'outcome',
          type: 'string',
          description: 'Formal review outcome.',
          required: true,
          enum: REVIEW_OUTCOMES,
        },
        { name: 'notes', type: 'string', description: 'Optional review notes.' },
        { name: 'actor', type: 'string', description: 'Actor agent name/id; host callers only.' },
      ],
      handler: async (args, ctx) =>
        reviewHandoff(
          stringArg(args, 'id')!,
          await actor(args, ctx),
          stringArg(args, 'fingerprint')!,
          stringArg(args, 'outcome')! as ReviewOutcome,
          stringArg(args, 'notes', false) ?? '',
        ),
    },
    acknowledge: {
      access: 'open',
      description: 'Source acknowledges an approved review for the exact fingerprint.',
      args: [
        { name: 'id', type: 'string', description: 'Handoff ID.', required: true },
        { name: 'fingerprint', type: 'string', description: 'Exact handoff fingerprint.', required: true },
        { name: 'actor', type: 'string', description: 'Actor agent name/id; host callers only.' },
      ],
      handler: async (args, ctx) =>
        acknowledgeHandoff(stringArg(args, 'id')!, await actor(args, ctx), stringArg(args, 'fingerprint')!),
    },
    close: {
      access: 'open',
      description: 'Source closes an acknowledged handoff with concrete outcome evidence.',
      args: [
        { name: 'id', type: 'string', description: 'Handoff ID.', required: true },
        { name: 'fingerprint', type: 'string', description: 'Exact handoff fingerprint.', required: true },
        { name: 'evidence', type: 'string', description: 'Observable closure evidence.', required: true },
        { name: 'actor', type: 'string', description: 'Actor agent name/id; host callers only.' },
      ],
      handler: async (args, ctx) =>
        closeHandoff(
          stringArg(args, 'id')!,
          await actor(args, ctx),
          stringArg(args, 'fingerprint')!,
          stringArg(args, 'evidence')!,
        ),
    },
  },
});
