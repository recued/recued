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

import { formatPressureBytes, pressureSurfaceRows } from '@recued/contracts';
import type {
  HousekeepingTaskStatus,
  PressureDetails,
  PressureSurfaceRow,
} from '@recued/contracts';
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
const ACTION_RECLAIM = 'maintenance-storage-reclaim';

/** Stable hook for the storage section. */
export const MAINTENANCE_STORAGE_ATTR = 'data-recued-maintenance-storage';

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
  /** `server.getStatus` — the per-surface storage read-out. Optional;
   *  omitted → no Storage section at all.
   *
   *  ⛔ WHY IT BELONGS HERE. `used_bytes` / `quota_bytes` / `pct` have been on
   *  `server.getStatus` and the heartbeat envelope since Phase B and NO client
   *  rendered them. This tab is the ops/status surface (R25) and already lists
   *  the tasks that RECLAIM these surfaces — audit compaction, cache GC. The
   *  number and the lever that moves it belong on one screen; today you can see
   *  "audit compaction ran 20 min ago" and have no way to tell whether it
   *  helped. */
  runServerStatus?: () => Promise<{ pressure_details?: PressureDetails }>;
  /** `server.runPressureReclaim`. Optional — omitted → the storage rows render
   *  without a Reclaim button.
   *
   *  ⚠ NO CONFIRM DIALOG, unlike task Run-now. Reclaim forces the SAME pipeline
   *  the eviction cascade runs on its own when a surface is pressured; it is
   *  "do now what would happen anyway", debounced server-side, not a new
   *  destructive capability the owner is granting. An extra modal would imply
   *  otherwise. */
  runReclaim?: (args: { surface: string; force?: boolean }) => Promise<{
    ran: boolean;
    bytes_freed: number;
  }>;
}

interface MaintenancePanelState {
  loading: boolean;
  error: string | null;
  tasks: ReadonlyArray<HousekeepingTaskStatus>;
  runNow: HousekeepingRunNowDialogState;
  /** Storage read-out rows, most-constrained first. Empty when
   *  `runServerStatus` is absent or the snapshot carried no pressure block. */
  storage: ReadonlyArray<PressureSurfaceRow>;
  /** Surface whose reclaim is in flight, or null. */
  reclaiming: string | null;
  /** Last reclaim outcome, keyed by surface — the receipt the owner needs to
   *  tell "it ran and freed nothing" from "it did not run". */
  reclaimResult: Readonly<Record<string, string>>;
}

type MaintenanceFocusIntent =
  | { kind: 'action'; action: string; taskId?: string }
  | { kind: 'dialog' };

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
    storage: [],
    reclaiming: null,
    reclaimResult: {},
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

  /** The storage read-out. Rows come from the shared `pressureSurfaceRows`
   *  projection, so the ordering + labelling match the server-pill popover
   *  exactly — one model, two renderers, no chance of the two surfaces
   *  disagreeing about which surface is worst. */
  const renderStorage = (): string => {
    if (state.storage.length === 0) return '';
    const rows = state.storage.map((row) => {
      const busy = state.reclaiming === row.surface;
      const receipt = state.reclaimResult[row.surface];
      const button = opts.runReclaim === undefined
        ? ''
        : `<button type="button" class="housekeeping-runnow-btn"`
          + ` data-action="${ACTION_RECLAIM}" data-surface="${escapeHtml(row.surface)}"`
          + `${busy ? ' disabled' : ''}>`
          + `${busy ? 'Reclaiming…' : 'Reclaim now'}</button>`;
      return `<tr class="maintenance-storage-row${row.attention ? ' maintenance-storage-row--attention' : ''}">`
        + `<th scope="row">${escapeHtml(row.surface)}</th>`
        + `<td>${escapeHtml(row.stateLabel)}</td>`
        + `<td class="maintenance-storage-size">${escapeHtml(row.size)}`
        + ` (${escapeHtml(row.pctLabel)})</td>`
        // ⚠ The server's `last_reclaim` is the durable column; the click
        // receipt is a transient overlay on top of it. Showing only the
        // receipt (the first cut) left this column blank until you pressed the
        // button, on a row whose header promised "Last reclaim".
        + `<td class="maintenance-storage-receipt">`
        + `${escapeHtml(receipt ?? row.lastReclaim)}</td>`
        + `<td>${button}</td>`
        + `</tr>`;
    }).join('');
    return `
      <section class="housekeeping-maintenance" aria-label="Storage" ${MAINTENANCE_STORAGE_ATTR}>
        <h3>Storage</h3>
        <p class="housekeeping-summary">
          How full each stored surface is. The server reclaims space on its own
          when a surface comes under pressure${opts.runReclaim === undefined
            ? ''
            : ' — Reclaim now does the same pass immediately'}.
        </p>
        <table class="housekeeping-task-table">
          <thead><tr>
            <th scope="col">Surface</th><th scope="col">State</th>
            <th scope="col">Used</th><th scope="col">Last reclaim</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    `;
  };

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

        ${renderStorage()}

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

  const findAction = (
    action: string,
    taskId?: string,
  ): HTMLElement | null => {
    const nodes = (opts.host as HTMLElement & {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    }).querySelectorAll?.('[data-action]');
    if (!nodes) return null;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      if (node.getAttribute('data-action') !== action) continue;
      // ⚠ The reclaim button identifies its row with `data-surface`, not
      // `data-task-id` — without this the focus intent never matches and the
      // button loses focus on every re-render, which for a busy→idle
      // transition means the keyboard user is dropped to <body> mid-action.
      const rowId = node.getAttribute('data-task-id')
        ?? node.getAttribute('data-surface');
      if (taskId === undefined || rowId === taskId) {
        return node as HTMLElement;
      }
    }
    return null;
  };

  const dialogElement = (): HTMLElement | null =>
    (opts.host as HTMLElement & {
      querySelector?: (selector: string) => HTMLElement | null;
    }).querySelector?.('.housekeeping-runnow-dialog') ?? null;

  const focusElement = (element: HTMLElement | null): void => {
    (element as (HTMLElement & {
      focus?: (options?: FocusOptions) => void;
    }) | null)?.focus?.({ preventScroll: true });
  };

  const focusIntentFromActiveElement = (): MaintenanceFocusIntent | null => {
    const host = opts.host as HTMLElement & {
      contains?: (node: Node | null) => boolean;
      ownerDocument?: Document;
    };
    const active = host.ownerDocument?.activeElement as HTMLElement | null;
    if (!active || host.contains?.(active) !== true) return null;
    const actionElement = active.closest?.('[data-action]');
    const action = actionElement?.getAttribute('data-action');
    if (action) {
      const taskId = actionElement?.getAttribute('data-task-id');
      return {
        kind: 'action',
        action,
        ...(taskId !== null && taskId !== undefined ? { taskId } : {}),
      };
    }
    if (active.closest?.('.housekeeping-runnow-dialog')) {
      return { kind: 'dialog' };
    }
    return null;
  };

  const applyFocusIntent = (intent: MaintenanceFocusIntent | null): void => {
    if (intent === null) return;
    focusElement(
      intent.kind === 'dialog'
        ? dialogElement()
        : findAction(intent.action, intent.taskId),
    );
  };

  const render = (focusIntent?: MaintenanceFocusIntent): void => {
    if (disposed) return;
    const intent = focusIntent ?? focusIntentFromActiveElement();
    opts.host.innerHTML = renderPanel();
    applyFocusIntent(intent);
  };

  const setState = (
    patch: Partial<MaintenancePanelState>,
    focusIntent?: MaintenanceFocusIntent,
  ): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render(focusIntent);
  };

  const doLoad = async (): Promise<void> => {
    if (disposed) return;
    const captured = ++loadGeneration;
    setState({ loading: true, error: null });
    try {
      const status = await opts.runStatusRead();
      if (disposed || captured !== loadGeneration) return;
      setState({ loading: false, error: null, tasks: status.tasks });
      await doRefreshStorage();
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
      await doRefreshStorage();
    } catch {
      // keep the prior table
    }
  };

  /** ⚠ SEPARATE FROM THE TASK LOAD, and failure is CONTAINED. A storage read
   *  that fails must not blank the maintenance table — the tasks are the
   *  primary content of this tab and they loaded fine. The rows simply stay as
   *  they were (or absent), which is the honest rendering of "could not
   *  refresh", and the next cycle retries. */
  const doRefreshStorage = async (): Promise<void> => {
    if (disposed || !opts.runServerStatus) return;
    try {
      const status = await opts.runServerStatus();
      if (disposed) return;
      setState({ storage: pressureSurfaceRows(status.pressure_details, now()) });
    } catch {
      // keep the prior rows
    }
  };

  const doReclaim = async (surface: string): Promise<void> => {
    if (disposed || !opts.runReclaim || state.reclaiming !== null) return;
    setState(
      { reclaiming: surface },
      { kind: 'action', action: ACTION_RECLAIM, taskId: surface },
    );
    try {
      const result = await opts.runReclaim({ surface });
      if (disposed) return;
      // ⛔ "ran: false" IS A RESULT, not a failure. The server debounces one
      // reclaim per surface per window, so a second click inside it is
      // declined — and reporting that as success would tell the owner space
      // was reclaimed when nothing ran.
      const receipt = result.ran
        ? `freed ${formatPressureBytes(result.bytes_freed)}`
        : 'already ran recently';
      setState(
        {
          reclaiming: null,
          reclaimResult: { ...state.reclaimResult, [surface]: receipt },
        },
        { kind: 'action', action: ACTION_RECLAIM, taskId: surface },
      );
      await doRefreshStorage();
    } catch (err) {
      if (disposed) return;
      setState(
        {
          reclaiming: null,
          reclaimResult: {
            ...state.reclaimResult,
            [surface]: humanizeRpcError(err),
          },
        },
        { kind: 'action', action: ACTION_RECLAIM, taskId: surface },
      );
    }
  };

  const doRunNow = async (taskId: string): Promise<void> => {
    if (disposed || !opts.runRunNow) return;
    setState(
      { runNow: { task_id: taskId, running: true, error: null } },
      { kind: 'dialog' },
    );
    try {
      await opts.runRunNow({ task_id: taskId });
      if (disposed) return;
      setState(
        { runNow: { task_id: null, running: false, error: null } },
        { kind: 'action', action: ACTION_RUN_NOW_OPEN, taskId },
      );
      await doRefreshStatus();
    } catch (err) {
      if (disposed) return;
      setState(
        {
          runNow: {
            task_id: taskId,
            running: false,
            error: humanizeRpcError(err),
          },
        },
        { kind: 'action', action: ACTION_RUN_NOW_CONFIRM },
      );
    }
  };

  const cancelRunNow = (): void => {
    const taskId = state.runNow.task_id;
    if (taskId === null || state.runNow.running) return;
    setState(
      { runNow: { task_id: null, running: false, error: null } },
      { kind: 'action', action: ACTION_RUN_NOW_OPEN, taskId },
    );
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
        setState(
          { runNow: { task_id: taskId, running: false, error: null } },
          { kind: 'action', action: ACTION_RUN_NOW_CANCEL },
        );
        return;
      }
      case ACTION_RUN_NOW_CONFIRM:
        if (state.runNow.task_id && !state.runNow.running) {
          void doRunNow(state.runNow.task_id);
        }
        return;
      case ACTION_RUN_NOW_CANCEL:
        cancelRunNow();
        return;
      case ACTION_RECLAIM: {
        const surface = actionEl.getAttribute('data-surface');
        if (surface) void doReclaim(surface);
        return;
      }
      default:
        return;
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (disposed) return;
    const target = ev.target as HTMLElement | null;
    const dialog = target?.closest?.('.housekeeping-runnow-dialog') as
      | HTMLElement
      | null;
    if (!dialog) return;

    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      cancelRunNow();
      return;
    }
    if (ev.key !== 'Tab') return;

    const buttons = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );
    if (buttons.length === 0) {
      ev.preventDefault();
      focusElement(dialog);
      return;
    }
    const currentIndex = buttons.indexOf(
      dialog.ownerDocument.activeElement as HTMLButtonElement,
    );
    const wrapsBackward = ev.shiftKey && currentIndex <= 0;
    const wrapsForward = !ev.shiftKey
      && (currentIndex < 0 || currentIndex === buttons.length - 1);
    if (!wrapsBackward && !wrapsForward) return;
    ev.preventDefault();
    focusElement(
      wrapsBackward ? buttons[buttons.length - 1]! : buttons[0]!,
    );
  };

  opts.host.addEventListener('click', onClick);
  opts.host.addEventListener('keydown', onKeyDown);

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
      opts.host.removeEventListener('keydown', onKeyDown);
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
