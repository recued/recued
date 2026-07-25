/** Settings ▸ Server ▸ Maintenance panel mount (R25).
 *
 *  The 11 deterministic core housekeeping tasks (TLS renew · audit
 *  compaction · cache GC · due-status sweep · link discovery · lifecycle
 *  drain · merge-candidate scan · deterministic-risk · delegation-
 *  suggestion · upload sweeps) graduated out of the Housekeeping config
 *  page into a Server sub-tab: ops/status, not config. Each row shows
 *  name · state · last-run · [Run now] · a clean one-liner.
 *
 *  It reuses the shared `housekeeping.status.read` +
 *  `housekeeping.task.run_now` seams (the same the Housekeeping panel
 *  wires for enrichment producers) — `status.read` returns every task
 *  and `renderHousekeepingTaskStatusTable({ kind: 'core' })` renders the
 *  core partition. Mirrors the Housekeeping mount's run-now confirm flow
 *  + `housekeeping_cycle` live refresh.
 *
 *  Spec: internal design notes §R25 (LOCKED) point 4. */

import {
  initialHousekeepingRunNowDialogState,
  renderHousekeepingRunNowConfirmDialog,
  renderHousekeepingTaskStatusTable,
  type HousekeepingRunNowDialogState,
} from '@recued/ui-shared/server-settings/housekeeping';

import type { HousekeepingTaskStatus } from '@recued/contracts';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import type {
  HousekeepingRunNowCaller,
  HousekeepingStatusReadCaller,
} from './housekeeping-panel-mount.js';

export const MAINTENANCE_PANEL_HOST_ATTR = 'data-recued-maintenance-panel-host';

// Actions — reuse the shared run-now confirm-dialog action names the
// `renderHousekeepingRunNowConfirmDialog` component + task table emit.
const ACTION_RUN_NOW_OPEN = 'housekeeping-run-now-open';
const ACTION_RUN_NOW_CONFIRM = 'housekeeping-run-now-confirm';
const ACTION_RUN_NOW_CANCEL = 'housekeeping-run-now-cancel';

export interface MountMaintenancePanelOptions {
  /** Host element — owned wholesale (`innerHTML` rewrites on every
   *  state transition; `dispose()` clears it + drops the listeners). */
  host: HTMLElement;
  /** `housekeeping.status.read` — fired on mount + on every
   *  `housekeeping_cycle` broadcast. Returns every task; the core
   *  partition is rendered. */
  runStatusRead: HousekeepingStatusReadCaller;
  /** `housekeeping.task.run_now`. Optional — omitted → the table
   *  renders without Run-now buttons (read-only status view). */
  runRunNow?: HousekeepingRunNowCaller;
  /** `Date.now`-compatible clock for relative-time copy. */
  now?: () => number;
  /** Live broadcast subscription. When provided, subscribes to
   *  `housekeeping_cycle` (reloads status on each cycle). */
  subscribe?: BroadcastSubscriber['on'];
}

interface MaintenancePanelState {
  loading: boolean;
  error: string | null;
  tasks: ReadonlyArray<HousekeepingTaskStatus>;
  runNow: HousekeepingRunNowDialogState;
}

export interface MaintenancePanelMount {
  getState(): MaintenancePanelState;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

export const mountMaintenancePanel = (
  opts: MountMaintenancePanelOptions,
): MaintenancePanelMount => {
  const now = opts.now ?? Date.now;

  let state: MaintenancePanelState = {
    loading: false,
    error: null,
    tasks: [],
    runNow: initialHousekeepingRunNowDialogState(),
  };
  let disposed = false;
  let pendingLoad: Promise<void> = Promise.resolve();
  // SEPARATE counters for the full load (clears `loading`) vs the
  // status-only cycle refresh — a `housekeeping_cycle` arriving mid initial
  // load must NOT invalidate the load that clears `loading` (else the panel
  // can stick on "Loading…" if the refresh then fails). Mirrors the
  // housekeeping mount's split-generation guard.
  let loadGeneration = 0;
  let statusGeneration = 0;

  opts.host.setAttribute(MAINTENANCE_PANEL_HOST_ATTR, '');

  const renderPanel = (): string => {
    if (state.loading && state.tasks.length === 0) {
      return `<p class="housekeeping-loading">Loading maintenance tasks…</p>`;
    }
    if (state.error) {
      return `<p class="housekeeping-error">${escapeHtml(state.error)}</p>`;
    }
    const runNowTask = state.tasks.find(
      (t) => t.meta.id === state.runNow.task_id,
    );
    return `
      <div class="housekeeping-panel">
        <header class="housekeeping-header">
          <h2>Maintenance</h2>
          <p class="housekeeping-summary">
            Deterministic upkeep the server runs on its own when idle —
            TLS renewal, audit compaction, cache cleanup, and more. Run any
            task now if you don't want to wait for the next idle cycle.
          </p>
        </header>

        <section class="housekeeping-maintenance" aria-label="Maintenance tasks">
          ${renderHousekeepingTaskStatusTable({
            tasks: state.tasks,
            kind: 'core',
            showRunNow: opts.runRunNow !== undefined,
            now: now(),
          })}
        </section>

        ${runNowTask
          ? renderHousekeepingRunNowConfirmDialog({
              state: state.runNow,
              task: runNowTask,
            })
          : renderHousekeepingRunNowConfirmDialog({ state: state.runNow })}
      </div>
    `;
  };

  const render = (): void => {
    if (disposed) return;
    opts.host.innerHTML = renderPanel();
  };

  const setState = (patch: Partial<MaintenancePanelState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render();
  };

  const doLoad = async (): Promise<void> => {
    if (disposed) return;
    const captured = ++loadGeneration;
    setState({ loading: true, error: null });
    try {
      const status = await opts.runStatusRead();
      if (disposed || captured !== loadGeneration) return;
      setState({ loading: false, error: null, tasks: status.tasks });
    } catch (err) {
      if (disposed || captured !== loadGeneration) return;
      setState({ loading: false, error: humanizeRpcError(err) });
    }
  };

  // Background status refresh (on a `housekeeping_cycle` broadcast) — keeps
  // the prior table on failure, never a page-level error.
  const doRefreshStatus = async (): Promise<void> => {
    if (disposed) return;
    const captured = ++statusGeneration;
    try {
      const status = await opts.runStatusRead();
      if (disposed || captured !== statusGeneration) return;
      setState({ tasks: status.tasks });
    } catch {
      // keep the prior table
    }
  };

  const doRunNow = async (taskId: string): Promise<void> => {
    if (disposed || !opts.runRunNow) return;
    setState({ runNow: { task_id: taskId, running: true, error: null } });
    try {
      await opts.runRunNow({ task_id: taskId });
      if (disposed) return;
      setState({ runNow: { task_id: null, running: false, error: null } });
      await doRefreshStatus();
    } catch (err) {
      if (disposed) return;
      setState({
        runNow: { task_id: taskId, running: false, error: humanizeRpcError(err) },
      });
    }
  };

  const onClick = (ev: Event): void => {
    if (disposed) return;
    const target = ev.target as (HTMLElement & {
      closest?: (s: string) => HTMLElement | null;
    }) | null;
    const actionEl = target?.closest?.('[data-action]');
    if (!actionEl) return;
    switch (actionEl.getAttribute('data-action')) {
      case ACTION_RUN_NOW_OPEN: {
        if (!opts.runRunNow) return;
        const taskId = actionEl.getAttribute('data-task-id');
        if (!taskId) return;
        setState({ runNow: { task_id: taskId, running: false, error: null } });
        return;
      }
      case ACTION_RUN_NOW_CONFIRM:
        if (state.runNow.task_id && !state.runNow.running) {
          void doRunNow(state.runNow.task_id);
        }
        return;
      case ACTION_RUN_NOW_CANCEL:
        if (!state.runNow.running) {
          setState({ runNow: { task_id: null, running: false, error: null } });
        }
        return;
      default:
        return;
    }
  };

  opts.host.addEventListener('click', onClick);

  const unsubscribers: Array<() => void> = [];
  if (opts.subscribe) {
    unsubscribers.push(
      opts.subscribe('housekeeping_cycle', () => {
        if (disposed) return;
        pendingLoad = doRefreshStatus();
      }),
    );
  }

  render();
  pendingLoad = doLoad();

  return {
    getState: () => state,
    refresh: () => {
      pendingLoad = doLoad();
      return pendingLoad;
    },
    whenLoaded: () => pendingLoad,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const u of unsubscribers) {
        try {
          u();
        } catch {
          // subscriber owns its own teardown; just drop the handle.
        }
      }
      unsubscribers.length = 0;
      opts.host.removeEventListener('click', onClick);
      try {
        opts.host.innerHTML = '';
      } catch {
        // some fake DOMs throw on innerHTML setter; ignore.
      }
      opts.host.removeAttribute(MAINTENANCE_PANEL_HOST_ATTR);
    },
  };
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;',
  );
