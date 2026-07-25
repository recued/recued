/** D-123 Phase 5 — Per-task status table (Server ▸ Maintenance).
 *
 *  One row per registered `kind: 'core'` task. R25 graduated these 11
 *  deterministic maintenance tasks out of the Housekeeping config page
 *  into Settings ▸ Server ▸ Maintenance (ops/status, not config). The
 *  row is: name · state · last-run · [Run now] · clean one-liner. The
 *  cursor column dropped with the graduation — it was internal progress
 *  detail, not operator-facing status.
 *
 *  The [Run now] button emits `housekeeping-run-now-open` with the task
 *  id; the maintenance panel mount wires it to the shared
 *  `housekeeping.task.run_now` confirm flow. Empty list → a hint (tasks
 *  register at server boot).
 *
 *  Spec: D-123 §5.2 +
 *  internal design notes §R25 (LOCKED). */

import type {
  HousekeepingLastStatus,
  HousekeepingTaskStatus,
} from '@recued/contracts';
import { e } from '../../template.js';
import { button } from '../../primitives/button.js';

export interface HousekeepingTaskStatusTableProps {
  tasks: ReadonlyArray<HousekeepingTaskStatus>;
  /** Filter the table to one task kind. Maintenance renders
   *  `kind: 'core'`; enrichment producers have their own section. */
  kind: 'core' | 'enrichment';
  /** When true, render a per-row [Run now] button. The Maintenance
   *  panel wires it; a read-only host omits it (no dead button).
   *  Defaults to false. */
  showRunNow?: boolean;
  /** "now" for the relative-time formatter. Tests pass a fixed
   *  timestamp so renders are deterministic. */
  now: number;
}

const STATUS_LABELS: Record<HousekeepingLastStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  complete: 'Complete',
  error: 'Error',
};

const formatRelative = (then: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const renderRow = (
  status: HousekeepingTaskStatus,
  now: number,
  showRunNow: boolean,
): string => {
  const state = status.state;
  const lastRun =
    state?.last_run_at != null ? formatRelative(state.last_run_at, now) : '—';
  const lastStatus: HousekeepingLastStatus = state?.last_status ?? 'pending';
  const errorBlock = state?.last_error
    ? `<div class="housekeeping-task-error">${e(state.last_error)}</div>`
    : '';
  return `
    <tr class="housekeeping-task-row" data-task-id="${e(status.meta.id)}" data-task-status="${e(lastStatus)}">
      <td class="housekeeping-task-name">
        <div class="housekeeping-task-id">${e(status.meta.id)}</div>
        <div class="housekeeping-task-desc">${e(status.meta.description)}</div>
      </td>
      <td class="housekeeping-task-status">${e(STATUS_LABELS[lastStatus])}${errorBlock}</td>
      <td class="housekeeping-task-last">${e(lastRun)}</td>
      ${showRunNow
        ? `<td class="housekeeping-task-action">${button({
            label: 'Run now',
            size: 'xs',
            action: 'housekeeping-run-now-open',
            data: { 'task-id': status.meta.id },
          })}</td>`
        : ''}
    </tr>
  `;
};

export const renderHousekeepingTaskStatusTable = (
  props: HousekeepingTaskStatusTableProps,
): string => {
  const filtered = props.tasks.filter((t) => t.meta.kind === props.kind);
  const showRunNow = props.showRunNow ?? false;
  if (filtered.length === 0) {
    const hint =
      props.kind === 'core'
        ? 'Core tasks register at server boot. None registered yet.'
        : 'No enrichment producers registered yet.';
    return `<p class="housekeeping-task-empty">${e(hint)}</p>`;
  }
  return `
    <table class="housekeeping-task-table">
      <thead>
        <tr>
          <th>Task</th>
          <th>State</th>
          <th>Last run</th>
          ${showRunNow ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${filtered.map((t) => renderRow(t, props.now, showRunNow)).join('')}
      </tbody>
    </table>
  `;
};
