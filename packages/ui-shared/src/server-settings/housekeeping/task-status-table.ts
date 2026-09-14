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

/** D-250 § D — token counts read better abbreviated once they pass a thousand;
 *  an exact figure is on the `housekeeping_cycle` audit row for anyone who needs
 *  it. ⚠ Never rounds a real value to `0`: sub-thousand counts render exactly, so
 *  a measured 4 stays 4 rather than becoming "0k". */
const formatTokens = (total: number): string =>
  total < 1000 ? `${total}` : `${(total / 1000).toFixed(1)}k`;

const renderRow = (
  status: HousekeepingTaskStatus,
  now: number,
  showRunNow: boolean,
): string => {
  const state = status.state;
  const lastRun =
    state?.last_run_at != null ? formatRelative(state.last_run_at, now) : '—';
  const lastStatus: HousekeepingLastStatus = state?.last_status ?? 'pending';
  // D-250 § D — what the last step actually cost.
  // ⚠ EM DASH FOR ABSENT, "0" FOR A MEASURED ZERO. Most tasks are deterministic
  // and never call a provider; rendering those as 0 would claim a measurement
  // that was never taken, and would make a task that ran AI for free
  // indistinguishable from one that has no AI in it at all.
  const lastCost =
    state?.last_run_tokens != null ? formatTokens(state.last_run_tokens) : '—';
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
      <td class="housekeeping-task-cost">${e(lastCost)}</td>
      ${showRunNow
        ? `<td class="housekeeping-task-action">${button({
            label: 'Run now',
            ariaLabel: `Run ${status.meta.id} now`,
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
        ? 'These are set up when your server starts. None yet.'
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
          <th>Cost</th>
          ${showRunNow ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${filtered.map((t) => renderRow(t, props.now, showRunNow)).join('')}
      </tbody>
    </table>
  `;
};
