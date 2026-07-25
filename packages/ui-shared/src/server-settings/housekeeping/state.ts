/** D-123 Phase 5 — Settings → Server → Housekeeping panel state.
 *
 *  The host wires the four `housekeeping.*` rpcs against this state:
 *  config + status read on mount, config write on Save, status read +
 *  cycle write on Run-now. The `kind: 'housekeeping_cycle'` realtime
 *  event triggers a status reload so the table refreshes live.
 *
 *  D-132 P5 widens the state with the per-topic detail-drawer slots
 *  (trust rows, recent runs, error history, sparkline series) so the
 *  enrichment producer table can expand into a drawer per spec
 *  D-132 §A.7.
 *
 *  Spec: D-123 §5.2 + D-132 §A.7. */

import type {
  ConfidenceDriftSignal,
  EnrichmentTrustRow,
  HousekeepingConfigRow,
  HousekeepingErrorEntry,
  HousekeepingPreset,
  HousekeepingScopeReadEntry,
  HousekeepingTaskStatus,
  RegistryDescribeTopicEntry,
} from '@recued/contracts';

/** Active `Run now` confirmation dialog. Rendered inline above the
 *  task table; closed when `task_id === null`. The dialog stays open
 *  through the rpc round-trip so a slow `runOnce` shows the spinner
 *  on the same UI surface that initiated it. */
export interface HousekeepingRunNowDialogState {
  task_id: string | null;
  /** True while the `housekeeping.task.run_now` rpc is in-flight.
   *  Disables Confirm; renderer swaps the label to "Running…". */
  running: boolean;
  /** Inline error from the most recent attempt. Cleared on next open. */
  error: string | null;
}

/** Pending custom-window edits. The user types into the custom-only
 *  fields; on Save the host commits via `housekeeping.config.write`
 *  + reloads the page state from the response's `effective` field.
 *  Non-`custom` presets clear this back to undefined on Save. */
export interface HousekeepingCustomDraft {
  cycle_budget_ms?: number;
  cycle_interval_minutes?: number;
  custom_window_start_hour?: number;
  custom_window_end_hour?: number;
}

/** D-132 P5 — A single past-run row rendered in the detail drawer's
 *  "Last N runs" table. The host derives this from `audit_entries`
 *  rows authored by the housekeeping cycle (one per task per cycle).
 *  `tokens` is undefined for deterministic producers; `confidence` is
 *  set only for AI producers whose `value_schema` declares
 *  `confidence: number` and is `undefined` otherwise. */
export interface HousekeepingDrawerRunEntry {
  ts: number;
  status: 'complete' | 'yield' | 'error';
  duration_ms: number;
  tokens?: number;
  /** Average produced confidence on this run (0..1). Drives the
   *  sparkline; `undefined` = sample skipped on this row. */
  confidence?: number;
}

/** D-132 P5 / P6 — drawer scope-of-read payload. P6 promoted the type
 *  into contracts so the rpc surface (`HousekeepingEnrichmentInfo
 *  .scope_read`) and the drawer share one shape; the alias is kept so
 *  existing call sites keep compiling. The `record_count?` field
 *  surfaces per-collection counts the server resolves at preview
 *  time. */
export type HousekeepingDrawerScopeRead = HousekeepingScopeReadEntry;

export interface HousekeepingPanelState {
  /** True while the initial config + status reads are in flight. The
   *  renderer shows a placeholder; subsequent reloads keep the prior
   *  config/tasks visible (no flicker). */
  loading: boolean;
  /** Inline page-level error from a failed read. The Save / Run-now
   *  inline errors live on their own state slots. */
  error: string | null;
  /** Most recent `housekeeping.config.read` response. Null until the
   *  first read lands. */
  config: HousekeepingConfigRow | null;
  /** Pending preset selection while the picker is open but Save hasn't
   *  fired yet. Null when no edit is in progress. */
  draftPreset: HousekeepingPreset | null;
  /** Custom-only fields the user is editing. Keys absent ⇒ "use the
   *  current persisted value" (the host reads them off `config` on
   *  the rpc payload composition path). */
  customDraft: HousekeepingCustomDraft;
  /** True while a `housekeeping.config.write` rpc is in flight. */
  saving: boolean;
  /** Inline Save error. Cleared on next preset change. */
  saveError: string | null;
  /** Most recent `housekeeping.status.read` response. */
  tasks: ReadonlyArray<HousekeepingTaskStatus>;
  /** Run-now dialog state. */
  runNow: HousekeepingRunNowDialogState;
  /** D-132 P5 — Topic of the row currently expanded into the detail
   *  drawer. Null when no row is expanded. The host toggles on
   *  `housekeeping-drawer-toggle` clicks and clears on collapse. */
  expandedTopic: string | null;
  /** D-132 P5 — Per-topic trust rows from `housekeeping.trust.read`.
   *  Topics absent from the map fall back to registry defaults at the
   *  drawer-render layer. */
  trustRows: Record<string, EnrichmentTrustRow>;
  /** D-132 P5 — Per-topic recent-runs feed for the drawer. Newest
   *  first; capped at 5 by the host. The host fetches lazily on first
   *  expand + on `housekeeping_cycle` events for the expanded topic. */
  recentRuns: Record<string, ReadonlyArray<HousekeepingDrawerRunEntry>>;
  /** D-132 P5 — Per-topic last-N error feed for the drawer (sourced
   *  from `housekeeping_state.last_errors_json`). Newest first; capped
   *  at `TRUST_ERROR_HISTORY_SIZE` by the producer-side ring buffer. */
  errorHistory: Record<string, ReadonlyArray<HousekeepingErrorEntry>>;
  /** D-132 P5 — Per-topic flag: does this topic's value_schema declare
   *  a `confidence: number` field? Drives the sparkline-section gate.
   *  Topics absent default to false. */
  hasConfidenceField: Record<string, boolean>;
  /** D-132 P5 — Trust-write rpc in flight, keyed by topic. The drawer
   *  disables radios for that topic while the boolean is true. */
  trustWriting: Record<string, boolean>;
  /** D-132 P5 — Last write error per topic, cleared on next write
   *  attempt. */
  trustWriteError: Record<string, string>;
  /** D-132 P5 — Per-topic producer scope-of-read declaration. The
   *  host derives from the producer manifest cache + threads it
   *  through. Topics absent → drawer renders the "no scope declared"
   *  empty hint (only happens during early boot races). */
  scopeRead: Record<string, ReadonlyArray<HousekeepingDrawerScopeRead>>;
  /** D-132 P6 — Active promotion-banner suggestions keyed by topic.
   *  The host populates this on every `enrichment_promotion_suggested`
   *  realtime event + drains entries when the user dismisses or
   *  promotes through the banner buttons. The banner renders in
   *  topic-key insertion order; one banner per topic. */
  promotionSuggestions: Record<string, HousekeepingPromotionSuggestion>;
  /** D-132 P6 — Per-topic in-flight flag for the promote / dismiss
   *  rpcs the banner fires. Disables both buttons while true. */
  promotionWriting: Record<string, boolean>;
  /** D-132 P6 — Per-topic last error from a banner-driven write. */
  promotionWriteError: Record<string, string>;
  /** D-133 — Drift signals keyed by source topic. Populated when the
   *  `confidence_drift_signal` housekeeping producer has computed PSI
   *  for a topic; the drawer reads `state.driftSignals[topic]` to
   *  render the Drift section. Topics absent → drawer skips the
   *  section (sparse / new producer / under sample-count floor). */
  driftSignals: Record<string, ConfidenceDriftSignal>;
  /** D-133 — Per-source-topic in-flight flag for the dismiss rpc the
   *  drift banner fires. Disables Review + Dismiss while true. */
  driftWriting: Record<string, boolean>;
  /** D-133 — Per-source-topic last write error from a banner-driven
   *  dismiss. */
  driftWriteError: Record<string, string>;
  /** D-136 P7.G — per-topic registry describe slice (coverage band +
   *  reasoning + effective `mcp_exposed`). Loaded once on Settings →
   *  Server panel mount via `housekeeping.registry.describe`; the
   *  drawer + producer-section reach into it for the Coverage panel +
   *  the privacy-toggle row. Topics absent from the map (e.g. boot
   *  race before the rpc returns) render the row without the panel. */
  coverageEntries: Record<string, RegistryDescribeTopicEntry>;
  /** D-136 §A.12 P7.G — topic-reset dry-run-then-confirm modal state.
   *  Closed when `topic === null`; otherwise the modal hosts the
   *  preview / confirm / applied views. */
  reset: HousekeepingResetModalState;
  /** D-145 PA11 — "LLM result cache" Settings card state. Holds the
   *  most recent `housekeeping.cache.stats` snapshot + the inline
   *  two-stage Clear-cache confirm flag (mirrors devices DD#2 + SI
   *  Slice 1.5 + packs Slice B patterns). */
  cache: HousekeepingCacheCardState;
}

/** D-145 PA11 — per-topic cache stats bucket. Mirrors the shape the
 *  `housekeeping.cache.stats` rpc returns; the renderer derives a
 *  hit-rate percentage from `hit_count / (hit_count + entry_count)`
 *  at render time so the snapshot stays minimal. */
export interface HousekeepingCacheTopicStats {
  topic: string;
  entry_count: number;
  hit_count: number;
}

/** D-145 PA11 — Settings card lifecycle for the LLM result cache.
 *
 *    - `loading`      : initial `housekeeping.cache.stats` rpc in flight.
 *    - `stats`        : most recent snapshot — null until the first read
 *                       lands; preserved across refreshes so the card
 *                       stays populated while the next read fires.
 *    - `loadError`    : inline error from the most recent read attempt;
 *                       cleared on next successful load.
 *    - `confirmingClear`: true once the user clicks "Clear cache" and the
 *                         inline confirm strip is open (DD: two-stage,
 *                         mirror SI delete). False on Cancel.
 *    - `clearing`     : true while the `housekeeping.cache.clear` rpc is
 *                       in flight. Disables both Confirm + Cancel.
 *    - `clearError`   : inline error from the most recent clear attempt;
 *                       cleared on next confirm-open. */
export interface HousekeepingCacheCardState {
  loading: boolean;
  stats: {
    total_entries: number;
    total_hits: number;
    per_topic: ReadonlyArray<HousekeepingCacheTopicStats>;
    last_gc_at: number | null;
  } | null;
  loadError: string | null;
  confirmingClear: boolean;
  clearing: boolean;
  clearError: string | null;
}

/** D-136 §A.12 P7.G — topic-reset dry-run-then-confirm modal.
 *
 *  Lifecycle phases:
 *    - `'idle'`     : modal closed (`topic === null`).
 *    - `'previewing'`: dry-run rpc in flight; renderer shows a
 *      placeholder + cancel button.
 *    - `'preview'`  : dry-run returned; impact + token-cost preview
 *      visible; user has confirm + cancel buttons. The
 *      `confirmation_token` is single-use + TTL-bound (5 min).
 *    - `'confirming'`: confirm rpc in flight; renderer disables both
 *      buttons + swaps "Confirm" → "Applying…".
 *    - `'applied'`  : confirm succeeded; renderer shows the
 *      applied summary + an explicit Done button (the user closes
 *      the modal so they can read the row counts before dismissal).
 *    - `'error'`    : either dry-run or confirm failed; renderer
 *      surfaces the error inline with a Retry / Cancel pair.
 *
 *  `reset_psi_baselines` defaults from the topic's registry (true for
 *  emits-confidence topics) but the user can flip via a checkbox in
 *  the preview view. Flipping after the dry-run lands clears the
 *  token and re-enters `previewing` (the substrate binds tokens to
 *  the request shape; arg drift triggers a re-mint). */
export type HousekeepingResetModalPhase =
  | 'idle'
  | 'previewing'
  | 'preview'
  | 'confirming'
  | 'applied'
  | 'error';

export interface HousekeepingResetModalState {
  /** Current topic under reset. Null = modal closed. */
  topic: string | null;
  phase: HousekeepingResetModalPhase;
  /** Dry-run impact summary. Populated when phase ∈ {'preview',
   *  'confirming', 'applied', 'error'} (but never on first 'previewing'). */
  impact:
    | {
        rows_to_tombstone: number;
        pinned_protected: number;
        psi_baselines_to_drop: number;
        estimated_recompute_tokens: number;
      }
    | null;
  /** Confirm-path actuals. Populated only when phase === 'applied'. */
  appliedSummary:
    | {
        rows_tombstoned: number;
        rows_recompute_enqueued: number;
        psi_baselines_dropped: number;
        pinned_skipped: number;
      }
    | null;
  /** Token returned from dry-run; spent on confirm. Single-use. */
  confirmation_token: string | null;
  /** Wall-clock expiry of the token (epoch ms). UI may surface a
   *  "preview expires in N min" hint near the confirm button. */
  expires_at: number | null;
  /** User-side override of the registry default for `reset_psi_baselines`.
   *  `null` = follow registry (the dry-run resolves it server-side); a
   *  boolean = explicit choice. Toggling re-mints the token. */
  resetPsiBaselines: boolean | null;
  /** Inline error from the most recent rpc attempt (dry-run OR confirm). */
  error: string | null;
}

/** D-132 P6 — One pending promotion-banner suggestion. The host
 *  caches the realtime payload here; the banner reads
 *  `manual_run_count` + `estimated_idle_cycle_cost_tokens` for the
 *  copy and `topic` for the rpc routing. */
export interface HousekeepingPromotionSuggestion {
  topic: string;
  manual_run_count: number;
  estimated_idle_cycle_cost_tokens: number;
}

export const initialHousekeepingRunNowDialogState =
  (): HousekeepingRunNowDialogState => ({
    task_id: null,
    running: false,
    error: null,
  });

export const initialHousekeepingResetModalState =
  (): HousekeepingResetModalState => ({
    topic: null,
    phase: 'idle',
    impact: null,
    appliedSummary: null,
    confirmation_token: null,
    expires_at: null,
    resetPsiBaselines: null,
    error: null,
  });

export const initialHousekeepingCacheCardState =
  (): HousekeepingCacheCardState => ({
    loading: false,
    stats: null,
    loadError: null,
    confirmingClear: false,
    clearing: false,
    clearError: null,
  });

export const initialHousekeepingPanelState = (): HousekeepingPanelState => ({
  loading: false,
  error: null,
  config: null,
  draftPreset: null,
  customDraft: {},
  saving: false,
  saveError: null,
  tasks: [],
  runNow: initialHousekeepingRunNowDialogState(),
  expandedTopic: null,
  trustRows: {},
  recentRuns: {},
  errorHistory: {},
  hasConfidenceField: {},
  trustWriting: {},
  trustWriteError: {},
  scopeRead: {},
  promotionSuggestions: {},
  promotionWriting: {},
  promotionWriteError: {},
  driftSignals: {},
  driftWriting: {},
  driftWriteError: {},
  coverageEntries: {},
  reset: initialHousekeepingResetModalState(),
  cache: initialHousekeepingCacheCardState(),
});
