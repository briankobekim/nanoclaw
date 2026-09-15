/** Compact human renderer for the derived mission-control view. */

export interface MissionListRow {
  mission_id: string;
  kind: 'task' | 'handoff';
  owner_agent_group_id: string;
  owner: string;
  class: string;
  project: string;
  stage: string;
  handoff_state: string;
  next_action: string;
  shipping_allowed: string;
  updated_at: string;
  /** Prior handoff ID when this mission is a revision; empty otherwise. */
  revises: string;
}

const COLS = [
  'MISSION',
  'KIND',
  'OWNER',
  'CLASS',
  'PROJECT',
  'STAGE',
  'REVIEW/HANDOFF',
  'REVISES',
  'NEXT ACTION',
  'SHIP',
  'UPDATED',
] as const;

function clip(value: string, length: number): string {
  return value.length <= length ? value : value.slice(0, length - 3) + '...';
}

function updated(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 'unknown' : new Date(parsed).toISOString().slice(0, 10);
}

export function formatMissionsTable(rows: MissionListRow[]): string {
  if (rows.length === 0) return 'No active or recent missions.';
  const body = rows.map((row) => [
    clip(row.mission_id, 28),
    row.kind,
    clip(row.owner, 16),
    row.class,
    clip(row.project, 18),
    row.stage,
    row.handoff_state,
    clip(row.revises || '-', 28),
    clip(row.next_action, 40),
    row.shipping_allowed,
    updated(row.updated_at),
  ]);
  const widths = COLS.map((column, index) => Math.max(column.length, ...body.map((row) => row[index]!.length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  return [line(COLS), ...body.map(line)].join('\n');
}
