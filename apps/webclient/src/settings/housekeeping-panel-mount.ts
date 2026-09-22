/** Settings → Housekeeping panel mount (D-174).
 *
 *  ⚠ A SETTINGS SECTION, SIBLING OF SERVER — not under it. It registers its own
 *  subview (`registerSubview('housekeeping', …)`) at the same level as Privacy
 *  and Server. Said "Settings → Server → Housekeeping" until 2026-09-16.
 *
 *  The codebase deferred the full housekeeping-panel mount as a
 *  "~1000+ LOC slice" (see `llm-result-cache-card-mount.ts:11-20`).
 *  Commit 1 landed the AI-control core — schedule (preset + custom
 *  window), the core task table, Run-now, and the per-topic **trust
 *  radios + pool policy** (D-132). Commit 2 (this commit) adds the
 *  remaining in-panel surfaces:
 *    - the **promotion banner** (D-132) — fed from the
 *      `enrichment_promotion_suggested` broadcast; Promote flips trust
 *      to `auto` via `trust.write`, Don't-ask-again fires
 *      `trust.dismiss_promotion`.
 *    - the **drift banner** (D-133) — fed from the
 *      `enrichment_drift_detected` broadcast; Review expands the topic
 *      drawer, Dismiss collapses the banner (client-side until the next
 *      severity transition re-fires it).
 *    - the per-topic **MCP-exposure override** — coverage panel fed
 *      from `registry.describe`, the "Hide from MCP agents" toggle
 *      writes through `mcp.visibility.write`.
 *    - the destructive two-step **topic-reset** modal — dry-run-then-
 *      confirm against `housekeeping.topic.reset`.
 *
 *  It still COMPOSES the ui-shared housekeeping sub-components against
 *  `renderHousekeepingPanel`'s state shape rather than calling the
 *  monolith — so the LLM-result-cache card stays on the AI/Models page
 *  (where the Pause-AI control already lives); the design-note's
 *  cache-nesting is left for a possible later monolith migration.
 *
 *  Every Commit-2 surface stays gated on its caller / data feed so an
 *  unwired seam renders nothing rather than a dead button: the reset
 *  section only shows when `runTopicReset` is wired; the MCP toggle +
 *  coverage panel only show when `registry.describe` populated coverage;
 *  the banners only show once a broadcast lands.
 *
 *  Mirrors `llm-result-cache-card-mount.ts`: closure state +
 *  `host.innerHTML = render(state)` + a delegated click/change listener
 *  + broadcast subscriptions (`housekeeping_cycle` reloads status;
 *  `enrichment_promotion_suggested` / `enrichment_drift_detected` feed
 *  the banners).
 *
 *  Spec: D-123 §5.2 + D-132 §A.7/§A.8 +
 *  D-133 §A.7 + D-136 §A.12/§A.13.5. */

import type {
  ConfidenceDriftSignal,
  EnrichmentPoolPolicy,
  EnrichmentTrustRow,
  EnrichmentTrustState,
  HousekeepingConfigRow,
  HousekeepingPreset,
  HousekeepingTaskStatus,
  RegistryDescribeRpcOutput,
  RegistryDescribeTopicEntry,
} from '@recued/contracts';
import {
  HOUSEKEEPING_PRODUCER_COST_ACTION,
  HOUSEKEEPING_PRODUCER_SEARCH_ACTION,
  initialHousekeepingPanelState,
  initialHousekeepingResetModalState,
  renderHousekeepingCustomWindowFields,
  renderHousekeepingDriftBanner,
  renderHousekeepingEnrichmentProducerSection,
  renderHousekeepingPresetPicker,
  renderHousekeepingPromotionBanner,
  renderHousekeepingRunNowConfirmDialog,
  renderHousekeepingTopicResetModal,
  type HousekeepingPanelState,
  type HousekeepingProducerCostFilter,
} from '@recued/ui-shared/server-settings/housekeeping';
import { button } from '@recued/ui-shared/primitives';
import { e } from '@recued/ui-shared/template';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const HOUSEKEEPING_PANEL_HOST_ATTR = 'data-recued-housekeeping-panel-host';

// ════════════════════════════════════════════════════════════════
// Caller seams — narrow Promise functions (mirrors the cache mount DD#1).
// The route wires these off `rpcConn.call`; tests inject fakes.
// ════════════════════════════════════════════════════════════════

export type HousekeepingConfigReadCaller = () => Promise<HousekeepingConfigRow>;
export type HousekeepingConfigWriteCaller = (args: {
  preset: HousekeepingPreset;
  cycle_budget_ms?: number;
  cycle_interval_minutes?: number;
  custom_window_start_hour?: number;
  custom_window_end_hour?: number;
}) => Promise<{ ok: true; effective: HousekeepingConfigRow }>;
export type HousekeepingStatusReadCaller = () => Promise<{
  tasks: ReadonlyArray<HousekeepingTaskStatus>;
}>;
export type HousekeepingRunNowCaller = (args: {
  task_id: string;
}) => Promise<{ ok: true; cycle_result: unknown }>;
export type HousekeepingTrustReadCaller = () => Promise<{
  rows: ReadonlyArray<EnrichmentTrustRow>;
}>;
export type HousekeepingTrustWriteCaller = (args: {
  topic: string;
  trust_state?: EnrichmentTrustState;
  pool_policy?: EnrichmentPoolPolicy;
}) => Promise<{ ok: true; effective: EnrichmentTrustRow }>;
export type HousekeepingDismissPromotionCaller = (args: {
  topic: string;
}) => Promise<{ ok: true; effective: EnrichmentTrustRow }>;
export type HousekeepingRegistryDescribeCaller =
  () => Promise<RegistryDescribeRpcOutput>;
/** D-285 — the PERSISTED drift signals. The `enrichment_drift_detected`
 *  broadcast announces a transition the instant it happens; this reads the
 *  state behind it, so a client that was not connected at that instant — or
 *  merely reloaded afterwards — can still see the verdict. */
export type HousekeepingDriftReadCaller = () => Promise<{
  rows: ReadonlyArray<ConfidenceDriftSignal>;
}>;

/** `housekeeping.topic.reset` response — dry-run mints a token + impact;
 *  confirm (token supplied) applies + returns actuals. Mirrors the rpc
 *  registry shape; redeclared here so the mount stays decoupled from the
 *  registry's `import()` type alias. */
export interface HousekeepingTopicResetResult {
  applied: boolean;
  confirmation_token: string | null;
  expires_at: number | null;
  topic: string;
  scope_filter: 'mail' | 'contact' | 'calendar' | 'file' | null;
  reset_psi_baselines: boolean;
  impact: {
    rows_to_tombstone: number;
    pinned_protected: number;
    psi_baselines_to_drop: number;
    estimated_recompute_tokens: number;
  };
  applied_summary: {
    rows_tombstoned: number;
    rows_recompute_enqueued: number;
    psi_baselines_dropped: number;
    pinned_skipped: number;
  };
}
export type HousekeepingTopicResetCaller = (args: {
  topic: string;
  scope_filter?: 'mail' | 'contact' | 'calendar' | 'file';
  reset_psi_baselines?: boolean;
  /** Omitted → dry-run; supplied → confirm. */
  confirmation_token?: string;
}) => Promise<HousekeepingTopicResetResult>;

export interface MountHousekeepingPanelOptions {
  /** Host element — owned wholesale (`innerHTML` rewrites on every
   *  state transition; `dispose()` clears it + drops the listeners). */
  host: HTMLElement;
  /** `housekeeping.config.read` — fired on mount. */
  runConfigRead: HousekeepingConfigReadCaller;
  /** `housekeeping.config.write` — fired on Save. */
  runConfigWrite: HousekeepingConfigWriteCaller;
  /** `housekeeping.status.read` — fired on mount + on every
   *  `housekeeping_cycle` broadcast. */
  runStatusRead: HousekeepingStatusReadCaller;
  /** `housekeeping.trust.read` — fired on mount; seeds the per-topic
   *  trust rows the drawer radios reflect. */
  runTrustRead: HousekeepingTrustReadCaller;
  /** D-285 — optional: an older server has no `housekeeping.drift.read`, and
   *  the panel degrades to the pre-D-285 behaviour (bus-only, lost on
   *  reload) rather than erroring. */
  runDriftRead?: HousekeepingDriftReadCaller;
  /** `housekeeping.task.run_now`. Optional — omitted → the Run-now
   *  confirm is unreachable (the open click is a no-op). */
  runRunNow?: HousekeepingRunNowCaller;
  /** `housekeeping.trust.write`. Optional — omitted → the trust + pool
   *  radios render but picks are no-ops (read-only trust view). Also
   *  backs the promotion banner's Promote button (flips trust to
   *  `auto`). */
  runTrustWrite?: HousekeepingTrustWriteCaller;
  /** `housekeeping.trust.dismiss_promotion` — backs the promotion
   *  banner's "Don't ask again" button. Optional — omitted → dismiss is
   *  a no-op (the banner still renders + Promote works when
   *  `runTrustWrite` is wired). */
  runDismissPromotion?: HousekeepingDismissPromotionCaller;
  /** `housekeeping.registry.describe` — fired on mount (non-fatal). Feeds
   *  the per-topic coverage panel in the drawer. Optional — omitted → no
   *  coverage panel (the drawer gates it on coverage). */
  runRegistryDescribe?: HousekeepingRegistryDescribeCaller;
  /** `housekeeping.topic.reset` — backs the destructive two-step
   *  topic-reset modal. Optional — omitted → the drawer's "Reset topic"
   *  section is gated OFF entirely (no dead button). */
  runTopicReset?: HousekeepingTopicResetCaller;
  /** `Date.now`-compatible clock for relative-time copy. */
  now?: () => number;
  /** Live broadcast subscription. When provided, the mount subscribes
   *  to `housekeeping_cycle` (reloads status on each cycle),
   *  `enrichment_promotion_suggested` (feeds the promotion banner), and
   *  `enrichment_drift_detected` (feeds the drift banner). */
  subscribe?: BroadcastSubscriber['on'];
}

export interface HousekeepingPanelMount {
  /** Current state snapshot — for tests + host introspection. */
  getState(): HousekeepingPanelState;
  /** Re-issue the config + status + trust reads. */
  refresh(): Promise<void>;
  /** Resolves after the initial (or latest) load settles. */
  whenLoaded(): Promise<void>;
  /** Tear down the DOM + listeners + subscription. Idempotent. */
  dispose(): void;
}

// Action names the ui-shared renderers emit via `button({ action })`
// + raw `data-action` attrs. Inlined so the delegator branches without
// importing renderer internals.
const ACTION_SAVE = 'housekeeping-save';
const ACTION_RUN_NOW_OPEN = 'housekeeping-run-now-open';
const ACTION_RUN_NOW_CONFIRM = 'housekeeping-run-now-confirm';
const ACTION_RUN_NOW_CANCEL = 'housekeeping-run-now-cancel';
const ACTION_DRAWER_TOGGLE = 'housekeeping-drawer-toggle';
const ACTION_PRESET_PICK = 'housekeeping-preset-pick';
const ACTION_TRUST_PICK = 'housekeeping-trust-state-pick';
const ACTION_POOL_PICK = 'housekeeping-pool-policy-pick';
const ACTION_CUSTOM_BUDGET = 'housekeeping-custom-budget';
const ACTION_CUSTOM_INTERVAL = 'housekeeping-custom-interval';
const ACTION_CUSTOM_START = 'housekeeping-custom-start';
const ACTION_CUSTOM_END = 'housekeeping-custom-end';
// Commit 2 — promotion / drift banners (click).
const ACTION_PROMOTION_PROMOTE = 'housekeeping-promotion-promote';
const ACTION_PROMOTION_DISMISS = 'housekeeping-promotion-dismiss';
const ACTION_DRIFT_REVIEW = 'housekeeping-drift-review';
const ACTION_DRIFT_DISMISS = 'housekeeping-drift-dismiss';
// Commit 2 — topic-reset modal (click, except toggle-psi which is change).
const ACTION_RESET_OPEN = 'housekeeping-reset-open';
const ACTION_RESET_CONFIRM = 'housekeeping-reset-confirm';
const ACTION_RESET_CANCEL = 'housekeeping-reset-cancel';
const ACTION_RESET_DONE = 'housekeeping-reset-done';
const ACTION_RESET_RETRY = 'housekeeping-reset-retry';
const ACTION_RESET_TOGGLE_PSI = 'housekeeping-reset-toggle-psi';

type HousekeepingFocusIntent =
  | { kind: 'action'; action: string; taskId?: string; topic?: string }
  | { kind: 'dialog'; dialog: 'run-now' | 'reset' };

export const mountHousekeepingPanel = (
  opts: MountHousekeepingPanelOptions,
): HousekeepingPanelMount => {
  const now = opts.now ?? Date.now;

  let state: HousekeepingPanelState = initialHousekeepingPanelState();
  // Mount-local AI-producer filters (search string + cost axis). Kept off
  // the shared state shape — they're pure view filters with no rpc churn,
  // and the producer section derives the visible list from them.
  let producerSearch = '';
  let producerCostFilter: HousekeepingProducerCostFilter = 'all';
  // Set on the frame we mutate `producerSearch` so the post-render pass
  // restores focus + caret to the search box (a full innerHTML rewrite
  // would otherwise drop focus mid-keystroke). `searchCaret` carries the
  // pre-render caret offset so mid-string edits don't jump to the end.
  let refocusSearch = false;
  let searchCaret: number | null = null;
  let disposed = false;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Stale-load guards (mirror the cache mount) — drop a stale response.
  // SEPARATE counters for the full load (config+status+trust) vs the
  // status-only cycle refresh: a `housekeeping_cycle` arriving mid
  // initial-load must not invalidate + abort the full load (which would
  // leave the panel stuck with no config/trust).
  let loadGeneration = 0;
  let statusGeneration = 0;

  opts.host.setAttribute(HOUSEKEEPING_PANEL_HOST_ATTR, '');

  // ── Render ───────────────────────────────────────────────────────
  const renderPanelFrame = (content: string): string => `
    <div class="housekeeping-panel">
      <header class="housekeeping-header">
        <h2>Housekeeping</h2>
        <p class="housekeeping-summary">
          Idle-driven maintenance. AI producers never run on their own
          until you set a topic's Run policy to Auto below.
        </p>
      </header>

      ${content}
    </div>
  `;

  const renderPanel = (): string => {
    if (state.loading && !state.config) {
      return renderPanelFrame(
        `<p class="housekeeping-loading">Loading housekeeping…</p>`,
      );
    }
    if (state.error) {
      return renderPanelFrame(
        `<p class="housekeeping-error">${e(state.error)}</p>`,
      );
    }
    if (!state.config) {
      return renderPanelFrame(
        '<p class="housekeeping-error">Housekeeping config unavailable.</p>',
      );
    }
    const config = state.config;
    const draftPreset = state.draftPreset ?? config.preset;
    const showCustom = draftPreset === 'custom';
    const dirty =
      state.draftPreset !== null && state.draftPreset !== config.preset;
    const dirtyCustom = showCustom && Object.keys(state.customDraft).length > 0;
    const canSave = (dirty || dirtyCustom) && !state.saving;
    const runNowTask = state.tasks.find(
      (t) => t.meta.id === state.runNow.task_id,
    );

    // R25 — ONE page, no tabs: idle schedule on top, then the AI-producer
    // list. The 11 core maintenance tasks graduated to Settings ▸ Server ▸
    // Maintenance (ops/status), so the panel is config-only.
    return renderPanelFrame(`
        ${renderHousekeepingPromotionBanner({
          suggestions: state.promotionSuggestions,
          writing: state.promotionWriting,
          writeError: state.promotionWriteError,
        })}

        ${renderHousekeepingDriftBanner({
          signals: state.driftSignals,
          writing: state.driftWriting,
          writeError: state.driftWriteError,
        })}

        <section class="housekeeping-schedule" aria-label="Idle schedule">
          <h3>Idle schedule</h3>
          ${renderHousekeepingPresetPicker({
            active: config.preset,
            draft: state.draftPreset,
            saving: state.saving,
          })}

          ${
            showCustom
              ? renderHousekeepingCustomWindowFields({
                  config,
                  draft: state.customDraft,
                  saving: state.saving,
                })
              : ''
          }

          ${state.saveError ? `<p class="housekeeping-error">${e(state.saveError)}</p>` : ''}

          <div class="housekeeping-actions">
            ${button({
              label: state.saving ? 'Saving…' : 'Save',
              variant: 'primary',
              size: 'sm',
              action: ACTION_SAVE,
              disabled: !canSave,
            })}
            <span class="housekeeping-current-summary">Currently ${e(config.preset)}</span>
          </div>
        </section>

        ${renderHousekeepingEnrichmentProducerSection({
          tasks: state.tasks,
          search: producerSearch,
          costFilter: producerCostFilter,
          expandedTopic: state.expandedTopic,
          trustRows: state.trustRows,
          recentRuns: state.recentRuns,
          errorHistory: state.errorHistory,
          hasConfidenceField: state.hasConfidenceField,
          trustWriting: state.trustWriting,
          trustWriteError: state.trustWriteError,
          scopeRead: state.scopeRead,
          // D-285 — the drawer now gets the signals that carry windows +
          // distributions, which `housekeeping.drift.read` supplies. Event
          // placeholders are filtered out for the reason the old comment
          // here gave: rendering the broadcast's zeroed windows would be
          // misleading. They upgrade to the stored row one round-trip after
          // the fire, so the section fills in rather than staying dark.
          driftSignals: fullDriftSignalsOnly(state.driftSignals),
          coverageEntries: state.coverageEntries,
          // Reset is destructive — only surface the drawer section when
          // the confirm/dry-run rpc is actually wired (no dead button).
          showResetSection: opts.runTopicReset !== undefined,
          now: now(),
        })}

        ${runNowTask
          ? renderHousekeepingRunNowConfirmDialog({
              state: state.runNow,
              task: runNowTask,
            })
          : renderHousekeepingRunNowConfirmDialog({ state: state.runNow })}

        ${renderHousekeepingTopicResetModal({
          state: state.reset,
          now: now(),
        })}
    `);
  };

  const findAction = (
    action: string,
    taskId?: string,
    topic?: string,
  ): HTMLElement | null => {
    const nodes = (opts.host as HTMLElement & {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    }).querySelectorAll?.('[data-action]');
    if (!nodes) return null;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i] as HTMLElement;
      if (node.getAttribute('data-action') !== action) continue;
      if (node.classList?.contains('housekeeping-reset-modal-backdrop')) {
        continue;
      }
      if (
        (taskId === undefined
          || node.getAttribute('data-task-id') === taskId)
        && (topic === undefined
          || node.getAttribute('data-topic') === topic
          || node.closest?.('[data-topic]')?.getAttribute('data-topic') === topic)
      ) {
        return node;
      }
    }
    return null;
  };

  const dialogElement = (
    dialog: Extract<HousekeepingFocusIntent, { kind: 'dialog' }>['dialog'],
  ): HTMLElement | null =>
    (opts.host as HTMLElement & {
      querySelector?: (selector: string) => HTMLElement | null;
    }).querySelector?.(
      dialog === 'run-now'
        ? '.housekeeping-runnow-dialog'
        : '.housekeeping-reset-modal',
    ) ?? null;

  const focusElement = (element: HTMLElement | null): void => {
    (element as (HTMLElement & {
      focus?: (options?: FocusOptions) => void;
    }) | null)?.focus?.({ preventScroll: true });
  };

  const modalFocusIntentFromActiveElement = (): HousekeepingFocusIntent | null => {
    const host = opts.host as HTMLElement & {
      contains?: (node: Node | null) => boolean;
      ownerDocument?: Document;
    };
    const active = host.ownerDocument?.activeElement as HTMLElement | null;
    if (!active || host.contains?.(active) !== true) return null;
    const resetDialog = active.closest?.('.housekeeping-reset-modal');
    const runNowDialog = active.closest?.('.housekeeping-runnow-dialog');
    if (!resetDialog && !runNowDialog) return null;
    const action = active.closest?.('[data-action]')?.getAttribute('data-action');
    if (action) {
      const topic = resetDialog?.getAttribute('data-topic');
      return {
        kind: 'action',
        action,
        ...(topic ? { topic } : {}),
      };
    }
    return {
      kind: 'dialog',
      dialog: resetDialog ? 'reset' : 'run-now',
    };
  };

  const applyFocusIntent = (intent: HousekeepingFocusIntent | null): void => {
    if (intent === null) return;
    focusElement(
      intent.kind === 'dialog'
        ? dialogElement(intent.dialog)
        : findAction(intent.action, intent.taskId, intent.topic),
    );
  };

  const render = (focusIntent?: HousekeepingFocusIntent): void => {
    if (disposed) return;
    const intent = focusIntent ?? modalFocusIntentFromActiveElement();
    opts.host.innerHTML = renderPanel();
    // Restore focus + caret to the search box after a keystroke-driven
    // re-render (full innerHTML rewrite drops focus otherwise).
    if (refocusSearch) {
      refocusSearch = false;
      const input = opts.host.querySelector<HTMLInputElement>(
        `[data-action="${HOUSEKEEPING_PRODUCER_SEARCH_ACTION}"]`,
      );
      if (input) {
        input.focus();
        // Restore the pre-render caret (clamped) so editing mid-string
        // doesn't jump to the end; fall back to end when unknown.
        const caret = Math.min(
          input.value.length,
          searchCaret ?? input.value.length,
        );
        try {
          input.setSelectionRange(caret, caret);
        } catch {
          // some input types / fake DOMs reject setSelectionRange; ignore.
        }
      }
      searchCaret = null;
      return;
    }
    applyFocusIntent(intent);
  };

  const setState = (
    patch: Partial<HousekeepingPanelState>,
    focusIntent?: HousekeepingFocusIntent,
  ): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render(focusIntent);
  };

  /** Update the AI-producer search string (mount-local). Pure re-render
   *  with focus restoration; no rpc. */
  const setProducerSearch = (value: string): void => {
    if (disposed || producerSearch === value) return;
    producerSearch = value;
    refocusSearch = true;
    render();
  };

  /** Update the AI-producer cost-axis filter (mount-local). Pure
   *  re-render; no rpc. */
  const setProducerCostFilter = (value: HousekeepingProducerCostFilter): void => {
    if (disposed || producerCostFilter === value) return;
    producerCostFilter = value;
    render();
  };

  // ── Loads ────────────────────────────────────────────────────────
  const doLoad = async (): Promise<void> => {
    if (disposed) return;
    const captured = ++loadGeneration;
    setState({ loading: true, error: null });
    try {
      const [config, status, trust] = await Promise.all([
        opts.runConfigRead(),
        opts.runStatusRead(),
        opts.runTrustRead(),
      ]);
      if (disposed || captured !== loadGeneration) return;
      const trustRows: Record<string, EnrichmentTrustRow> = {};
      for (const row of trust.rows) trustRows[row.topic] = row;
      setState({
        loading: false,
        error: null,
        config,
        tasks: status.tasks,
        trustRows,
      });
    } catch (err) {
      if (disposed || captured !== loadGeneration) return;
      setState({ loading: false, error: messageOf(err) });
    }
  };

  // D-285 — non-fatal drift load. Same shape as the coverage load below: a
  // failure leaves whatever the bus delivered rather than blanking the page.
  const doLoadDrift = async (): Promise<void> => {
    if (disposed) return;
    if (!opts.runDriftRead) return;
    const captured = loadGeneration;
    try {
      const res = await opts.runDriftRead();
      if (disposed || captured !== loadGeneration) return;
      const driftSignals: Record<string, ConfidenceDriftSignal> = { ...state.driftSignals };
      for (const row of res.rows) {
        driftSignals[row.source_topic] = mergeDriftSignal(driftSignals[row.source_topic], row);
      }
      setState({ driftSignals });
    } catch {
      // Drift is a secondary surface — a failed read keeps the bus-delivered
      // signals, never a page-level error.
    }
  };

  // Non-fatal coverage + MCP-visibility load. Runs alongside the main
  // load but never blanks the panel on failure: a missing coverage feed
  // just hides the drawer's coverage panel + MCP toggle (the producer
  // section gates both on `coverageEntries[topic]`), it doesn't error
  // the page. Shares `loadGeneration` so a `refresh()` supersedes a
  // stale in-flight meta load.
  const doLoadMcpMeta = async (): Promise<void> => {
    if (disposed) return;
    if (!opts.runRegistryDescribe) return;
    const captured = loadGeneration;
    try {
      const describe = await opts.runRegistryDescribe();
      if (disposed || captured !== loadGeneration) return;
      const coverageEntries: Record<string, RegistryDescribeTopicEntry> = {};
      for (const entry of describe.topics) coverageEntries[entry.topic] = entry;
      setState({ coverageEntries });
    } catch {
      // Coverage is a secondary surface — a failed read keeps it empty
      // (drawer coverage panel gated out), never a page-level error.
    }
  };

  // Status-only reload on a `housekeeping_cycle` broadcast — keeps the
  // task table + last-run times fresh without re-reading config/trust.
  const doRefreshStatus = async (): Promise<void> => {
    if (disposed) return;
    const captured = ++statusGeneration;
    try {
      const status = await opts.runStatusRead();
      if (disposed || captured !== statusGeneration) return;
      setState({ tasks: status.tasks });
    } catch {
      // A failed background refresh keeps the prior table — never paint
      // a page-level error from a passive cycle reload.
    }
  };

  const doSave = async (): Promise<void> => {
    if (disposed || state.saving) return;
    const config = state.config;
    if (!config) return;
    const preset = state.draftPreset ?? config.preset;
    const args: Parameters<HousekeepingConfigWriteCaller>[0] = { preset };
    if (preset === 'custom') {
      const d = state.customDraft;
      const budget = d.cycle_budget_ms ?? config.cycle_budget_ms;
      const interval = d.cycle_interval_minutes ?? config.cycle_interval_minutes;
      const startHour = d.custom_window_start_hour ?? config.custom_window_start_hour;
      const endHour = d.custom_window_end_hour ?? config.custom_window_end_hour;
      if (budget !== undefined) args.cycle_budget_ms = budget;
      if (interval !== undefined) args.cycle_interval_minutes = interval;
      if (startHour !== undefined) args.custom_window_start_hour = startHour;
      if (endHour !== undefined) args.custom_window_end_hour = endHour;
    }
    setState({ saving: true, saveError: null });
    try {
      const res = await opts.runConfigWrite(args);
      if (disposed) return;
      setState({
        saving: false,
        saveError: null,
        config: res.effective,
        draftPreset: null,
        customDraft: {},
      });
    } catch (err) {
      if (disposed) return;
      setState({ saving: false, saveError: messageOf(err) });
    }
  };

  const doRunNow = async (taskId: string): Promise<void> => {
    if (disposed || !opts.runRunNow) return;
    setState(
      { runNow: { task_id: taskId, running: true, error: null } },
      { kind: 'dialog', dialog: 'run-now' },
    );
    try {
      await opts.runRunNow({ task_id: taskId });
      if (disposed) return;
      const returnFocus: HousekeepingFocusIntent = {
        kind: 'action',
        action: ACTION_RUN_NOW_OPEN,
        taskId,
      };
      setState(
        { runNow: { task_id: null, running: false, error: null } },
        returnFocus,
      );
      await doRefreshStatus();
      applyFocusIntent(returnFocus);
    } catch (err) {
      if (disposed) return;
      setState(
        {
          runNow: {
            task_id: taskId,
            running: false,
            error: messageOf(err),
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

  const doTrustWrite = async (
    topic: string,
    patch: { trust_state?: EnrichmentTrustState; pool_policy?: EnrichmentPoolPolicy },
  ): Promise<void> => {
    if (disposed || !opts.runTrustWrite) return;
    setState({
      trustWriting: { ...state.trustWriting, [topic]: true },
      trustWriteError: omitKey(state.trustWriteError, topic),
    });
    try {
      const res = await opts.runTrustWrite({ topic, ...patch });
      if (disposed) return;
      setState({
        trustRows: { ...state.trustRows, [topic]: res.effective },
        trustWriting: omitKey(state.trustWriting, topic),
      });
    } catch (err) {
      if (disposed) return;
      setState({
        trustWriting: omitKey(state.trustWriting, topic),
        trustWriteError: { ...state.trustWriteError, [topic]: messageOf(err) },
      });
    }
  };

  // ── Promotion banner (D-132 §A.8) ────────────────────────────────
  // Promote flips trust to `auto` via `trust.write`; Don't-ask-again
  // fires `trust.dismiss_promotion`. Both drain the suggestion on
  // success + patch the resulting trust row so the drawer radio reflects
  // it. `promotionWriting` disables both buttons for the topic while in
  // flight.
  const doPromotion = async (
    topic: string,
    kind: 'promote' | 'dismiss',
  ): Promise<void> => {
    if (disposed) return;
    const caller =
      kind === 'promote'
        ? opts.runTrustWrite
          ? () => opts.runTrustWrite!({ topic, trust_state: 'auto' })
          : null
        : opts.runDismissPromotion
          ? () => opts.runDismissPromotion!({ topic })
          : null;
    if (!caller) return;
    setState({
      promotionWriting: { ...state.promotionWriting, [topic]: true },
      promotionWriteError: omitKey(state.promotionWriteError, topic),
    });
    try {
      const res = await caller();
      if (disposed) return;
      setState({
        trustRows: { ...state.trustRows, [topic]: res.effective },
        promotionSuggestions: omitKey(state.promotionSuggestions, topic),
        promotionWriting: omitKey(state.promotionWriting, topic),
      });
    } catch (err) {
      if (disposed) return;
      setState({
        promotionWriting: omitKey(state.promotionWriting, topic),
        promotionWriteError: {
          ...state.promotionWriteError,
          [topic]: messageOf(err),
        },
      });
    }
  };

  // ── Drift banner (D-133 §A.7) ────────────────────────────────────
  // Dismiss is client-side only: stamp `dismissed_at` on the in-memory
  // signal so `isBannerEligible` collapses the banner. There is no
  // dismissal-persistence rpc; the banner re-arms naturally on the next
  // `enrichment_drift_detected` broadcast (state-transition fire only,
  // server-gated). Review expands the topic's drawer for trust controls.
  const doDriftDismiss = (sourceTopic: string): void => {
    const signal = state.driftSignals[sourceTopic];
    if (!signal) return;
    setState({
      driftSignals: {
        ...state.driftSignals,
        [sourceTopic]: { ...signal, dismissed_at: now() },
      },
    });
  };


  // ── Topic reset (D-136 §A.12) — two-step dry-run-then-confirm ─────
  // `reset_psi_baselines` left undefined on the dry-run lets the server
  // resolve the registry default; the response echoes the resolved value
  // which we hold for the confirm call (the token binds to topic +
  // scope_filter + reset_psi_baselines, so confirm MUST replay the same
  // resolved value).
  const doResetDryRun = async (
    topic: string,
    resetPsiBaselines: boolean | null,
  ): Promise<void> => {
    if (disposed || !opts.runTopicReset) return;
    setState(
      {
        reset: {
          ...initialHousekeepingResetModalState(),
          topic,
          phase: 'previewing',
          resetPsiBaselines,
        },
      },
      { kind: 'action', action: ACTION_RESET_CANCEL },
    );
    try {
      const res = await opts.runTopicReset({
        topic,
        ...(resetPsiBaselines !== null
          ? { reset_psi_baselines: resetPsiBaselines }
          : {}),
      });
      if (disposed || state.reset.topic !== topic) return;
      setState(
        {
          reset: {
            topic,
            phase: 'preview',
            impact: res.impact,
            appliedSummary: null,
            confirmation_token: res.confirmation_token,
            expires_at: res.expires_at,
            resetPsiBaselines: res.reset_psi_baselines,
            error: null,
          },
        },
        { kind: 'action', action: ACTION_RESET_CANCEL },
      );
    } catch (err) {
      if (disposed || state.reset.topic !== topic) return;
      setState(
        {
          reset: { ...state.reset, phase: 'error', error: messageOf(err) },
        },
        { kind: 'action', action: ACTION_RESET_RETRY, topic },
      );
    }
  };

  const doResetConfirm = async (): Promise<void> => {
    if (disposed || !opts.runTopicReset) return;
    const { topic, confirmation_token, resetPsiBaselines } = state.reset;
    if (!topic || !confirmation_token) return;
    setState(
      { reset: { ...state.reset, phase: 'confirming', error: null } },
      { kind: 'dialog', dialog: 'reset' },
    );
    try {
      const res = await opts.runTopicReset({
        topic,
        confirmation_token,
        ...(resetPsiBaselines !== null
          ? { reset_psi_baselines: resetPsiBaselines }
          : {}),
      });
      if (disposed || state.reset.topic !== topic) return;
      setState(
        {
          reset: {
            ...state.reset,
            phase: 'applied',
            appliedSummary: res.applied_summary,
            confirmation_token: null,
            error: null,
          },
        },
        { kind: 'action', action: ACTION_RESET_DONE },
      );
      // The reset enqueued recomputes — refresh the task table so the
      // affected producer's status reflects the pending work.
      await doRefreshStatus();
    } catch (err) {
      if (disposed || state.reset.topic !== topic) return;
      setState(
        {
          reset: { ...state.reset, phase: 'error', error: messageOf(err) },
        },
        { kind: 'action', action: ACTION_RESET_RETRY, topic },
      );
    }
  };

  const closeReset = (): void => {
    const topic = state.reset.topic;
    setState(
      { reset: initialHousekeepingResetModalState() },
      topic === null
        ? undefined
        : { kind: 'action', action: ACTION_RESET_OPEN, topic },
    );
  };

  // ── Click delegation ─────────────────────────────────────────────
  const onClick = (ev: Event): void => {
    if (disposed) return;
    const actionEl = closestAction(ev.target);
    if (!actionEl) return;
    const action = actionEl.getAttribute('data-action');
    switch (action) {
      case ACTION_SAVE:
        void doSave();
        return;
      case HOUSEKEEPING_PRODUCER_COST_ACTION: {
        const cost = actionEl.getAttribute('data-cost');
        if (cost === 'all' || cost === 'llm' || cost === 'computed') {
          setProducerCostFilter(cost);
        }
        return;
      }
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
      case ACTION_RUN_NOW_CONFIRM: {
        if (state.runNow.task_id && !state.runNow.running) {
          void doRunNow(state.runNow.task_id);
        }
        return;
      }
      case ACTION_RUN_NOW_CANCEL:
        cancelRunNow();
        return;
      case ACTION_DRAWER_TOGGLE: {
        const topic = topicOf(actionEl);
        if (!topic) return;
        setState({ expandedTopic: state.expandedTopic === topic ? null : topic });
        return;
      }
      // ── Promotion banner ──────────────────────────────────────────
      case ACTION_PROMOTION_PROMOTE: {
        const topic = actionEl.getAttribute('data-topic');
        if (topic) void doPromotion(topic, 'promote');
        return;
      }
      case ACTION_PROMOTION_DISMISS: {
        const topic = actionEl.getAttribute('data-topic');
        if (topic) void doPromotion(topic, 'dismiss');
        return;
      }
      // ── Drift banner ──────────────────────────────────────────────
      case ACTION_DRIFT_REVIEW: {
        // Review expands the source topic's producer drawer (the drift
        // source_topic IS the producer topic). The trust controls there
        // are how the user responds to drift.
        const sourceTopic = actionEl.getAttribute('data-source-topic');
        if (sourceTopic) setState({ expandedTopic: sourceTopic });
        return;
      }
      case ACTION_DRIFT_DISMISS: {
        const sourceTopic = actionEl.getAttribute('data-source-topic');
        if (sourceTopic) doDriftDismiss(sourceTopic);
        return;
      }
      // ── Topic-reset modal ─────────────────────────────────────────
      case ACTION_RESET_OPEN: {
        if (!opts.runTopicReset) return;
        const topic = actionEl.getAttribute('data-topic');
        if (topic) void doResetDryRun(topic, null);
        return;
      }
      case ACTION_RESET_CONFIRM:
        if (state.reset.phase === 'preview') void doResetConfirm();
        return;
      case ACTION_RESET_RETRY: {
        const topic = state.reset.topic;
        if (topic) void doResetDryRun(topic, state.reset.resetPsiBaselines);
        return;
      }
      case ACTION_RESET_CANCEL:
        // Don't allow closing mid-confirm (the rpc is in flight).
        if (state.reset.phase !== 'confirming') closeReset();
        return;
      case ACTION_RESET_DONE:
        closeReset();
        return;
      default:
        return;
    }
  };

  // ── Change delegation (radios / number inputs / hour selects /
  //    checkboxes) ─────────────────────────────────────────────────
  const onChange = (ev: Event): void => {
    if (disposed) return;
    const el = ev.target as
      | (HTMLElement & { value?: string; checked?: boolean })
      | null;
    if (!el?.getAttribute) return;
    const action = el.getAttribute('data-action');
    const value = el.value ?? '';
    switch (action) {
      case ACTION_RESET_TOGGLE_PSI: {
        // Flipping re-mints the token (the substrate binds tokens to the
        // request shape) — re-enter the dry-run with the new choice.
        const topic = topicOf(el);
        if (topic && opts.runTopicReset) {
          void doResetDryRun(topic, el.checked ?? false);
        }
        return;
      }
      case ACTION_PRESET_PICK:
        setState({ draftPreset: value as HousekeepingPreset, saveError: null });
        return;
      case ACTION_TRUST_PICK: {
        const topic = topicOf(el);
        if (topic && value) {
          void doTrustWrite(topic, { trust_state: value as EnrichmentTrustState });
        }
        return;
      }
      case ACTION_POOL_PICK: {
        const topic = topicOf(el);
        if (topic && value) {
          void doTrustWrite(topic, { pool_policy: value as EnrichmentPoolPolicy });
        }
        return;
      }
      case ACTION_CUSTOM_BUDGET:
        setCustom('cycle_budget_ms', value);
        return;
      case ACTION_CUSTOM_INTERVAL:
        setCustom('cycle_interval_minutes', value);
        return;
      case ACTION_CUSTOM_START:
        setCustom('custom_window_start_hour', value);
        return;
      case ACTION_CUSTOM_END:
        setCustom('custom_window_end_hour', value);
        return;
      default:
        return;
    }
  };

  const setCustom = (
    field: keyof HousekeepingPanelState['customDraft'],
    raw: string,
  ): void => {
    const next = { ...state.customDraft };
    if (raw === '') {
      delete next[field];
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      next[field] = n;
    }
    setState({ customDraft: next });
  };

  // ── Input delegation (the AI-producer search box) ─────────────────
  // Live substring filter on each keystroke. Separate from `onChange`
  // (which fires on blur) so the list narrows as the user types; the
  // post-render pass restores focus + caret (full innerHTML rewrite).
  const onInput = (ev: Event): void => {
    if (disposed) return;
    const el = ev.target as
      | (HTMLElement & { value?: string; selectionStart?: number | null })
      | null;
    if (!el?.getAttribute) return;
    if (el.getAttribute('data-action') === HOUSEKEEPING_PRODUCER_SEARCH_ACTION) {
      // Capture the caret off the live (pre-render) input so the
      // post-render refocus restores the exact position, not the end.
      searchCaret = el.selectionStart ?? null;
      setProducerSearch(el.value ?? '');
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (disposed) return;
    const target = ev.target as HTMLElement | null;
    const resetDialog = target?.closest?.('.housekeeping-reset-modal') as
      | HTMLElement
      | null;
    const runNowDialog = target?.closest?.('.housekeeping-runnow-dialog') as
      | HTMLElement
      | null;
    const dialog = resetDialog ?? runNowDialog;
    if (!dialog) return;

    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (resetDialog) {
        if (state.reset.phase !== 'confirming') closeReset();
      } else {
        cancelRunNow();
      }
      return;
    }
    if (ev.key !== 'Tab') return;

    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      ),
    );
    if (controls.length === 0) {
      ev.preventDefault();
      focusElement(dialog);
      return;
    }
    const currentIndex = controls.indexOf(
      dialog.ownerDocument.activeElement as HTMLElement,
    );
    const wrapsBackward = ev.shiftKey && currentIndex <= 0;
    const wrapsForward = !ev.shiftKey
      && (currentIndex < 0 || currentIndex === controls.length - 1);
    if (!wrapsBackward && !wrapsForward) return;
    ev.preventDefault();
    focusElement(
      wrapsBackward ? controls[controls.length - 1]! : controls[0]!,
    );
  };

  opts.host.addEventListener('click', onClick);
  opts.host.addEventListener('change', onChange);
  opts.host.addEventListener('input', onInput);
  opts.host.addEventListener('keydown', onKeyDown);

  // Fire the main load + the non-fatal coverage meta load together.
  // The meta load never gates `whenLoaded()` — it's secondary — but it
  // shares `loadGeneration` so a `refresh()` supersedes a stale one.
  const loadAll = (): Promise<void> => {
    const p = doLoad();
    void doLoadMcpMeta();
    void doLoadDrift();
    return p;
  };

  // ── Broadcast subscriptions ──────────────────────────────────────
  const unsubscribers: Array<() => void> = [];
  if (opts.subscribe) {
    unsubscribers.push(
      opts.subscribe('housekeeping_cycle', () => {
        if (disposed) return;
        pendingLoad = doRefreshStatus();
      }),
      // D-132 §A.8 — a promotion suggestion fires once an AI producer
      // has been manually run past the threshold under `manual` trust.
      opts.subscribe('enrichment_promotion_suggested', (event) => {
        if (disposed) return;
        setState({
          promotionSuggestions: {
            ...state.promotionSuggestions,
            [event.topic]: {
              topic: event.topic,
              manual_run_count: event.manual_run_count,
              estimated_idle_cycle_cost_tokens:
                event.estimated_idle_cycle_cost_tokens,
            },
          },
        });
      }),
      // D-133 §A.7 — a drift signal fires on a confidence-distribution
      // severity transition. The broadcast is narrow (no windows); the
      // banner only needs source_topic / psi / severity, so the
      // constructed signal's window/distribution fields are placeholders
      // (never rendered — the drawer drift section stays unfed).
      opts.subscribe('enrichment_drift_detected', (event) => {
        if (disposed) return;
        setState({
          driftSignals: {
            ...state.driftSignals,
            [event.source_topic]: driftSignalFromEvent(event),
          },
        });
        // D-285 — paint from the event immediately (it is the whole point of
        // a broadcast), then pull the stored row so the placeholder's zeroed
        // windows are replaced by the real ones and the drawer can render.
        void doLoadDrift();
      }),
    );
  }

  // ── Initial paint + load ─────────────────────────────────────────
  render();
  pendingLoad = loadAll();

  return {
    getState: () => state,
    refresh: () => {
      pendingLoad = loadAll();
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
      opts.host.removeEventListener('change', onChange);
      opts.host.removeEventListener('input', onInput);
      opts.host.removeEventListener('keydown', onKeyDown);
      try {
        opts.host.innerHTML = '';
      } catch {
        // some fake DOMs throw on innerHTML setter; ignore.
      }
      opts.host.removeAttribute(HOUSEKEEPING_PANEL_HOST_ATTR);
    },
  };
};

// ── helpers ────────────────────────────────────────────────────────

const messageOf = (err: unknown): string =>
  humanizeRpcError(err);

/** Build a `ConfidenceDriftSignal` from the narrow
 *  `enrichment_drift_detected` broadcast. The banner reads
 *  `source_topic` / `severity` / `dismissed_at` plus D-283's
 *  `low_confidence_delta`; the window +
 *  distribution fields are placeholders the banner never renders (and
 *  the drawer drift section is deliberately left unfed — see the
 *  producer-section feed comment). They exist solely to satisfy the
 *  `ConfidenceDriftSignal` shape. */
const driftSignalFromEvent = (event: {
  source_topic: string;
  psi: number;
  severity: 'moderate' | 'significant';
  computed_at: number;
  low_confidence_delta?: number;
}): ConfidenceDriftSignal => {
  const window = {
    start_at: event.computed_at,
    end_at: event.computed_at,
    sample_count: 0,
  };
  return {
    source_topic: event.source_topic,
    psi: event.psi,
    severity: event.severity,
    baseline_window: window,
    recent_window: window,
    baseline_distribution: [],
    recent_distribution: [],
    computed_at: event.computed_at,
    // ⛔ D-283 — carried through, NOT synthesised. A `ProportionShift` is
    // deliberately absent here: this path has no rates, no n and no
    // p-value, and inventing them to fill the shape would put fabricated
    // statistics on a signal. These two are the only facts the event
    // actually holds, and they are the two the banner renders.
    ...(event.low_confidence_delta !== undefined
      ? { low_confidence_delta: event.low_confidence_delta }
      : {}),
  };
};

/** A stored signal always carries its PSI bins; an event placeholder is built
 *  with `baseline_distribution: []` because the broadcast has no bins to
 *  carry. That is the honest discriminator between the two — not a flag
 *  somebody has to remember to set. */
const hasDistributions = (s: ConfidenceDriftSignal): boolean =>
  s.baseline_distribution.length > 0;

/** D-285 — reconcile a stored row against whatever is already in hand.
 *
 *  Newer computation wins. On a TIE — the normal case, since the read is
 *  kicked off by the very broadcast that announced the same computation —
 *  the row with distributions wins, because it is the same verdict with the
 *  analysis attached.
 *
 *  ⛔ A local dismissal is carried across, but ONLY within one computation.
 *  Dismissal is client-side state (nothing persists it yet), so without this
 *  the next read would hand back the same verdict undismissed and re-raise a
 *  banner the owner had just closed — the read would have made the surface
 *  NAGGIER than the bug it fixes. A newer `computed_at` deliberately drops
 *  the dismissal: that is the "re-arms on the next transition" rule the
 *  banner already documents. */
const mergeDriftSignal = (
  prev: ConfidenceDriftSignal | undefined,
  next: ConfidenceDriftSignal,
): ConfidenceDriftSignal => {
  if (prev === undefined) return next;
  const chosen =
    next.computed_at > prev.computed_at
      ? next
      : next.computed_at < prev.computed_at
        ? prev
        : hasDistributions(next)
          ? next
          : prev;
  if (
    prev.dismissed_at !== undefined
    && chosen.dismissed_at === undefined
    && chosen.computed_at === prev.computed_at
  ) {
    return { ...chosen, dismissed_at: prev.dismissed_at };
  }
  return chosen;
};

/** The subset the drawer can render — see the feed comment at its call site. */
const fullDriftSignalsOnly = (
  signals: Record<string, ConfidenceDriftSignal>,
): Record<string, ConfidenceDriftSignal> => {
  const out: Record<string, ConfidenceDriftSignal> = {};
  for (const [topic, signal] of Object.entries(signals)) {
    if (hasDistributions(signal)) out[topic] = signal;
  }
  return out;
};

const omitKey = <T>(
  rec: Record<string, T>,
  key: string,
): Record<string, T> => {
  const next = { ...rec };
  delete next[key];
  return next;
};

const closestAction = (target: EventTarget | null): HTMLElement | null => {
  const el = target as (HTMLElement & {
    closest?: (s: string) => HTMLElement | null;
  }) | null;
  if (!el?.closest) return null;
  return el.closest('[data-action]');
};

/** Topic for a drawer-scoped control — read off the nearest
 *  `[data-topic]` ancestor (the producer row group + the radio
 *  fieldset both carry it). */
const topicOf = (el: HTMLElement & {
  closest?: (s: string) => HTMLElement | null;
}): string | null => {
  const direct = el.getAttribute('data-topic');
  if (direct) return direct;
  const ancestor = el.closest?.('[data-topic]');
  return ancestor?.getAttribute('data-topic') ?? null;
};

// ════════════════════════════════════════════════════════════════
// Styles — token-based, dark-safe. Covers the trust-core classes the
// composed components emit; the deferred drift / MCP / coverage /
// reset drawer sections (not rendered in this slice) get their CSS in
// the follow-on commit.
// ════════════════════════════════════════════════════════════════

export const HOUSEKEEPING_PANEL_STYLES = `
/* Server ▸ Maintenance storage read-out. Reuses \`housekeeping-task-table\` for
   the grid; these rules only add what a usage row needs beyond a task row. */
.maintenance-storage-size { font-variant-numeric: tabular-nums; white-space: nowrap; }
.maintenance-storage-receipt { color: var(--fg-muted); font-size: 11px; }
/* A surface off the running state is the one the owner opened this tab to find,
   so the row is marked rather than left to be read off the state column. */
.maintenance-storage-row--attention th[scope="row"],
.maintenance-storage-row--attention .maintenance-storage-size {
  color: var(--danger, #dc2626);
  font-weight: 600;
}

.housekeeping-panel { display: flex; flex-direction: column; gap: 18px; color: var(--fg); font-size: 13px; }
.housekeeping-loading, .housekeeping-error { margin: 0; }
.housekeeping-error { color: var(--danger); }
.housekeeping-header h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.housekeeping-summary { margin: 0; color: var(--fg-muted); line-height: 1.45; max-width: 60ch; }

/* R25 — ONE page: idle schedule + AI producers, no tab strip. */
.housekeeping-schedule, .housekeeping-producers { display: flex; flex-direction: column; gap: 12px; }
.housekeeping-schedule h3, .housekeeping-producers h3 { margin: 0; font-size: 13px; font-weight: 600; }

.housekeeping-preset-picker { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; border: 0; }
.housekeeping-preset-picker legend { padding: 0; font-weight: 600; font-size: 13px; }
.housekeeping-preset-choice { display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 4px 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.housekeeping-preset-choice input { grid-row: span 2; }
.housekeeping-preset-label { font-weight: 600; }
.housekeeping-preset-desc { grid-column: 2; color: var(--fg-muted); font-size: 12px; }

.housekeeping-custom-fields { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-sunk); }
.housekeeping-custom-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.housekeeping-custom-row label { min-width: 160px; }
.housekeeping-custom-hint { color: var(--fg-muted); font-size: 11px; }
.housekeeping-custom-row input, .housekeeping-custom-hour { padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--fg); }
.housekeeping-custom-window-sep { color: var(--fg-muted); }

.housekeeping-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.housekeeping-current-summary { color: var(--fg-muted); font-size: 12px; }

/* R25 — AI-producer filter bar: search + cost toggle (replaces the chip wall). */
.housekeeping-producer-filter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.housekeeping-producer-search { flex: 1 1 200px; min-width: 160px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--fg); font: inherit; font-size: 12px; }
.housekeeping-producer-cost-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.housekeeping-producer-cost-segment { box-sizing: border-box; min-height: 36px; display: inline-flex; align-items: center; justify-content: center; appearance: none; border: 0; background: var(--surface); color: var(--fg-muted); font: inherit; font-size: 12px; padding: 5px 12px; cursor: pointer; border-left: 1px solid var(--border); }
.housekeeping-producer-cost-segment:first-child { border-left: 0; }
.housekeeping-producer-cost-segment:hover { color: var(--fg); }
.housekeeping-producer-cost-segment[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
.housekeeping-producer-cost-segment:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* Producer table + core-task (Server ▸ Maintenance) table share this base. */
.housekeeping-task-table, .housekeeping-producer-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.housekeeping-task-table th, .housekeeping-producer-table th { text-align: left; font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--fg-muted); }
.housekeeping-task-row td, .housekeeping-producer-row td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.housekeeping-task-name, .housekeeping-producer-topic code { font-weight: 600; }
.housekeeping-task-desc, .housekeeping-producer-oneliner { color: var(--fg-muted); font-size: 11px; }
.housekeeping-task-id, .housekeeping-task-cursor { color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.housekeeping-task-error, .housekeeping-producer-status-flag { color: var(--danger); }
.housekeeping-task-empty, .housekeeping-producer-empty { color: var(--fg-muted); padding: 8px; }
.housekeeping-producer-action { white-space: nowrap; text-align: right; }
/* Last run. Sized to the widest value this column can actually hold: the
   format is relative and stays that way, so 999d ago (2.7 years, well past
   any real housekeeping cadence) is the ceiling — measured 70.5px in Chrome
   including the cell padding, with 59m ago at 66px. 80px is that plus
   headroom for a wider default font on Windows / Linux than the macOS
   system-ui these were measured in.
   ⛔ DO NOT re-widen this to fit an absolute stamp. If one ever lands here
   it must be TIGHT — no milliseconds, no zone abbreviation, no city. Those
   are Date.toString() / timeZoneName artefacts, they roughly treble the
   string, and none of them changes whether a producer looks overdue, which
   is the only question this column answers.
   nowrap means a longer value widens the cell rather than breaking in two,
   so the floor never has to cover the absurd case. tabular-nums stops the
   digits jittering between rows. */
.housekeeping-producer-last-run { min-width: 80px; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* Producer row — topic head (name + LLM badge) + inline Run-policy control. */
.housekeeping-producer-topic-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.housekeeping-producer-llm-badge { font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--accent); border: 1px solid var(--accent); border-radius: 4px; padding: 0 4px; }
.housekeeping-producer-status-flag { font-size: 10px; font-weight: 600; }
/* Off / Manual / Auto. ⛔ ESCAPE ANY BACKTICK IN THIS STYLESHEET (see the
   header comment for the existing ones) — it is one JS template literal, so
   a bare backtick in a CSS comment ends it mid-file and fails the bundle.
   The floor is the control's own natural width (measured 144.0px in Chrome
   at 11px), so it changes nothing at rest and only bites where an ancestor
   would otherwise compress it: this control sits in a grid cell whose track
   is minmax(0, 1fr) and whose td sets min-width: 0, and BOTH of those exist
   precisely to let a child shrink past its own min-content. Without a floor
   the three labels close up against each other and read as one word.
   flex: none covers the same hazard under a flex ancestor. */
.housekeeping-producer-runpolicy { display: inline-flex; flex: none; min-width: 144px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; margin: 0; padding: 0; }
.housekeeping-producer-runpolicy-seg { box-sizing: border-box; min-height: 36px; display: inline-flex; flex: 1 1 auto; }
/* nowrap is the structural half of the same fix — a width floor stops the
   control shrinking, this stops a label breaking onto a second line inside
   whatever width it does get. */
.housekeeping-producer-runpolicy-seg span { box-sizing: border-box; min-height: 36px; display: inline-flex; align-items: center; justify-content: center; width: 100%; white-space: nowrap; padding: 4px 10px; font-size: 11px; color: var(--fg-muted); cursor: pointer; border-left: 1px solid var(--border); }
.housekeeping-producer-runpolicy-seg:first-child span { border-left: 0; }
.housekeeping-producer-runpolicy-seg input { position: absolute; opacity: 0; width: 0; height: 0; }
.housekeeping-producer-runpolicy-seg[data-active="true"] span { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.housekeeping-producer-runpolicy-seg input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }
.housekeeping-producer-runpolicy-seg input:disabled + span { cursor: not-allowed; opacity: 0.5; }
.housekeeping-producer-runpolicy-error { margin-top: 4px; }
.housekeeping-drawer-toggle-button { box-sizing: border-box; min-width: 36px; min-height: 36px; }

.housekeeping-drawer { padding: 12px 14px; background: var(--surface-sunk); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; }
.housekeeping-drawer-section h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
.housekeeping-drawer-description { color: var(--fg-muted); margin: 0 0 8px; }
.housekeeping-drawer-radios { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; border: 0; }
.housekeeping-drawer-radio { box-sizing: border-box; min-height: 36px; display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 2px 8px; }
.housekeeping-drawer-radio input { grid-row: span 2; }
.housekeeping-drawer-radio-label { font-weight: 600; }
.housekeeping-drawer-radio-desc { grid-column: 2; color: var(--fg-muted); font-size: 11px; }
.housekeeping-drawer-empty { color: var(--fg-muted); margin: 0; }
.housekeeping-drawer-scope-list, .housekeeping-drawer-scope-fields { margin: 0; padding-left: 16px; }
.housekeeping-drawer-scope-count { color: var(--fg-muted); margin-left: 6px; }
.housekeeping-drawer-runs, .housekeeping-drawer-recent-runs { width: 100%; border-collapse: collapse; font-size: 11px; }
.housekeeping-drawer-runs td { padding: 3px 6px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.housekeeping-drawer-run-status { font-weight: 600; }
.housekeeping-drawer-errors { display: flex; flex-direction: column; gap: 4px; }
.housekeeping-drawer-error-time { color: var(--fg-muted); font-size: 11px; }
.housekeeping-drawer-error-msg { color: var(--danger); }
.housekeeping-drawer-confidence-spark { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1px; }
.housekeeping-drawer-confidence-meta { color: var(--fg-muted); font-size: 11px; }
.housekeeping-drawer-wipe-note { color: var(--fg-muted); font-size: 11px; margin: 0; }

.housekeeping-runnow-dialog { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); z-index: 50; }
.housekeeping-runnow-dialog-card { background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; max-width: 440px; display: flex; flex-direction: column; gap: 12px; }
.housekeeping-runnow-dialog-title { margin: 0; font-size: 14px; font-weight: 600; }
.housekeeping-runnow-dialog-body { margin: 0; line-height: 1.45; }
.housekeeping-runnow-dialog-warn { color: var(--danger); margin: 0; }
.housekeeping-runnow-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
.housekeeping-runnow-scope-list, .housekeeping-runnow-scope-fields { margin: 0; padding-left: 16px; }
.housekeeping-runnow-pool-policy-label { color: var(--fg-muted); }

/* ── Commit 2 — promotion banner (D-132 §A.8) ───────────────────── */
.housekeeping-promotion-banners, .housekeeping-drift-banners { display: flex; flex-direction: column; gap: 10px; }
.housekeeping-promotion-banner, .housekeeping-drift-banner { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-sunk); }
.housekeeping-promotion-banner { border-left: 3px solid var(--accent); }
.housekeeping-promotion-banner-body, .housekeeping-drift-banner-body { display: flex; flex-direction: column; gap: 4px; }
.housekeeping-promotion-banner-headline, .housekeeping-drift-banner-headline { margin: 0; font-weight: 600; line-height: 1.4; }
.housekeeping-promotion-banner-meta, .housekeeping-drift-banner-meta { margin: 0; color: var(--fg-muted); font-size: 12px; }
.housekeeping-promotion-banner-actions, .housekeeping-drift-banner-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }

/* ── Commit 2 — drift banner (D-133 §A.7) ───────────────────────── */
.housekeeping-drift-banner[data-severity="significant"] { border-left: 3px solid var(--danger); }
.housekeeping-drift-banner[data-severity="moderate"] { border-left: 3px solid var(--warning, var(--accent)); }

/* ── Commit 2 — drawer coverage panel (D-136 §A.14.4) ───────────── */
.housekeeping-drawer-coverage { display: flex; flex-direction: column; gap: 8px; }
.housekeeping-drawer-coverage-headline { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.housekeeping-drawer-coverage-band-badge { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid var(--border); }
.housekeeping-drawer-coverage-band-badge[data-band="high"] { color: var(--success, var(--accent)); border-color: currentColor; }
.housekeeping-drawer-coverage-band-badge[data-band="low"], .housekeeping-drawer-coverage-band-badge[data-band="novel_query_likely_uncovered"] { color: var(--danger); border-color: currentColor; }
.housekeeping-drawer-coverage-reasoning { color: var(--fg-muted); font-size: 11px; }
.housekeeping-drawer-coverage-stats { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; font-size: 11px; }
.housekeeping-drawer-coverage-stats dt { color: var(--fg-muted); }
.housekeeping-drawer-coverage-stats dd { margin: 0; font-variant-numeric: tabular-nums; }
.housekeeping-drawer-coverage-bias summary { box-sizing: border-box; min-height: 36px; display: flex; align-items: center; cursor: pointer; color: var(--fg-muted); font-size: 11px; }

/* ── R25 — drawer read-access cross-link (replaces the MCP toggle) ── */
.housekeeping-drawer-read-access { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.housekeeping-drawer-read-access-note { color: var(--fg-muted); font-size: 11px; margin: 0; }
.housekeeping-drawer-read-access-link { box-sizing: border-box; min-height: 36px; display: inline-flex; align-items: center; color: var(--accent); font-size: 12px; text-decoration: none; }
.housekeeping-drawer-read-access-link:hover { text-decoration: underline; }

/* ── Commit 2 — drawer reset entry-point (D-136 §A.12) ───────────── */
.housekeeping-drawer-reset { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.housekeeping-drawer-reset-warning { color: var(--fg-muted); font-size: 11px; margin: 0; }

/* ── Commit 2 — topic-reset modal (D-136 §A.12) ─────────────────── */
.housekeeping-reset-modal { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 60; }
.housekeeping-reset-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.4); }
.housekeeping-reset-modal-card { position: relative; background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; max-width: 480px; width: calc(100% - 48px); display: flex; flex-direction: column; gap: 12px; }
.housekeeping-reset-modal-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
.housekeeping-reset-modal-body { display: flex; flex-direction: column; gap: 12px; }
.housekeeping-reset-warning { margin: 0; line-height: 1.45; color: var(--danger); }
.housekeeping-reset-loading { margin: 0; color: var(--fg-muted); }
.housekeeping-reset-impact, .housekeeping-reset-applied { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; font-size: 12px; }
.housekeeping-reset-impact dt, .housekeeping-reset-applied dt { color: var(--fg-muted); }
.housekeeping-reset-impact dd, .housekeeping-reset-applied dd { margin: 0; font-variant-numeric: tabular-nums; }
.housekeeping-reset-impact-tokens { grid-column: 1 / -1; color: var(--fg-muted); }
.housekeeping-reset-psi-toggle { box-sizing: border-box; min-height: 36px; display: flex; align-items: center; gap: 8px; }
.housekeeping-reset-applied-headline, .housekeeping-reset-applied-followup { margin: 0; line-height: 1.45; }
.housekeeping-reset-applied-followup { color: var(--fg-muted); font-size: 12px; }
.housekeeping-reset-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
.housekeeping-reset-token-expiry { color: var(--fg-muted); font-size: 11px; }

@media (max-width: 720px) {
  .housekeeping-producer-table,
  .housekeeping-producer-table tbody,
  .housekeeping-producer-table tr,
  .housekeeping-producer-table td {
    box-sizing: border-box;
    display: block;
    width: 100%;
  }
  .housekeeping-producer-table thead { display: none; }
  .housekeeping-producer-row-group { margin-bottom: 8px; }
  .housekeeping-producer-table .housekeeping-producer-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }
  .housekeeping-producer-row td {
    min-width: 0;
    padding: 0;
    border-bottom: 0;
  }
  .housekeeping-producer-topic { grid-column: 1 / -1; }
  .housekeeping-producer-runpolicy-cell { grid-column: 1; }
  .housekeeping-producer-last-run {
    grid-column: 2;
    align-self: center;
    color: var(--fg-muted);
  }
  .housekeeping-producer-action {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .housekeeping-producer-row-group[data-expanded="true"] .housekeeping-producer-row {
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
  }
  .housekeeping-producer-drawer-cell {
    padding: 10px 0 0;
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 8px 8px;
    overflow: hidden;
  }
  .housekeeping-producer-cost-line { padding: 0 14px 10px; }
}
`;
