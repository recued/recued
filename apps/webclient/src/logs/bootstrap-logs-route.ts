/** D-174 P5 - top-level Logs/Audit route.
 *
 *  Consumes the local-UI `execution.list` + `execution.get` RPC seam.
 *  The server owns redaction and policy gating; this route keeps the
 *  projection narrow and never renders raw error details or checkpoint
 *  payload dumps.
 *
 *  D-181 slice 5b adds the **Active** section: a live list of the long-op
 *  governor's in-flight runs + queued calls (the `execution.active` read)
 *  with owner kill / cancel / promote control, refreshed off the
 *  `execution` broadcast deltas. The webclient is the `control`-capable
 *  surface (D-181 §8); a paired bridge mirror is slice 6. The same slice
 *  surfaces the failed/killed `error_category` chip on feed + detail rows.
 */

import type {
  ActiveExecutionEntry,
  Actor,
  CliFailureDetail,
  CliFailureReason,
  ExecutionActiveRequest,
  ExecutionActiveResponse,
  ExecutionCancelRequest,
  ExecutionCancelResponse,
  ExecutionGetRequest,
  ExecutionGetResponse,
  ExecutionKillRequest,
  ExecutionKillResponse,
  ExecutionListCursor,
  ExecutionListQuery,
  ExecutionListResponse,
  ExecutionPromoteRequest,
  ExecutionPromoteResponse,
  HeavyOpErrorCategory,
  LaneStatus,
  PolicyResult,
  RecipeError,
  RunAnchorStatus,
  RunApprovalOutcome,
  RunDegradation,
  RunDetail,
  RunFeedRow,
  RunGatewayCallTraceEntry,
  RunOrigin,
  RunProvenanceLink,
  SessionGrantListRequest,
  SessionGrantListResponse,
  SessionGrantRevokeRequest,
  SessionGrantView,
} from '@recued/contracts';
import {
  ACTORS,
  RUN_ANCHOR_STATUSES,
  isCliFailureDetail,
  parseTimelineEntityId,
} from '@recued/contracts';

import { RefPicker } from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  serializeDataEntityVerificationAddress,
  serializeChatPlanAddress,
  serializeLogsRunAddress,
  serializeShellRoute,
  serializeSourceRecordVerificationAddress,
  type ChatPlanAddress,
  type DataEntityVerificationTab,
  type DataVerificationRelationship,
  type LogsRunAddress,
  type SourceRecordDataTab,
} from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const LOGS_ROUTE_STYLES_MARKER = 'data-recued-logs-route-styles';
export const LOGS_ROUTE_HOST_ATTR = 'data-recued-logs-route';
export const LOGS_ROUTE_HEADING_ATTR = 'data-recued-logs-route-heading';
export const LOGS_ROUTE_CHAT_RETURN_ATTR =
  'data-recued-logs-route-chat-return';
export const LOGS_ROUTE_FILTER_ATTR = 'data-recued-logs-filter';
export const LOGS_ROUTE_ROW_ATTR = 'data-recued-logs-row';
export const LOGS_ROUTE_STATUS_ATTR = 'data-recued-logs-status';
export const LOGS_ROUTE_POLICY_ATTR = 'data-recued-logs-policy';
export const LOGS_ROUTE_LINK_ATTR = 'data-recued-logs-link';
export const LOGS_ROUTE_DETAIL_ATTR = 'data-recued-logs-detail';
export const LOGS_ROUTE_OUTCOME_ATTR = 'data-recued-logs-outcome';
export const LOGS_ROUTE_AFFECTED_ITEMS_ATTR =
  'data-recued-logs-affected-items';
export const LOGS_ROUTE_GATEWAY_TRACE_ATTR = 'data-recued-logs-gateway-trace';
export const LOGS_ROUTE_DEGRADED_ATTR = 'data-recued-logs-degraded';
export const LOGS_ROUTE_REDACTED_IO_ATTR = 'data-recued-logs-redacted-io';
export const LOGS_ROUTE_LOAD_MORE_ATTR = 'data-recued-logs-load-more';
export const LOGS_ROUTE_ERROR_ATTR = 'data-recued-logs-error';
export const LOGS_ROUTE_EMPTY_ATTR = 'data-recued-logs-empty';
// D-181 slice 5b — the live Active section + the failed/killed error chip.
export const LOGS_ROUTE_ACTIVE_ATTR = 'data-recued-logs-active';
export const LOGS_ROUTE_ACTIVE_ROW_ATTR = 'data-recued-logs-active-row';
export const LOGS_ROUTE_LANES_ATTR = 'data-recued-logs-lanes';
// R17 — the capped Active peek-strip on the default (#logs) view. The FULL
// operator console (the `LOGS_ROUTE_ACTIVE_ATTR` section + lanes + passes) lives
// at the `#logs/active` deep link; the peek is the at-a-glance twin that never
// buries History.
export const LOGS_ROUTE_PEEK_ATTR = 'data-recued-logs-peek';
// D-186 Slice C — the live "Active passes" (session-grant) section, mirroring
// the Active section's shell + row styling (the selectors below are comma-joined).
export const LOGS_ROUTE_PASSES_ATTR = 'data-recued-logs-passes';
export const LOGS_ROUTE_PASS_ROW_ATTR = 'data-recued-logs-pass-row';
export const LOGS_ROUTE_ERROR_CATEGORY_ATTR = 'data-recued-logs-error-category';
// D-182 — the cli (local-binary) failure chip attr (feed) + stderr detail block.
export const LOGS_ROUTE_CLI_FAILURE_ATTR = 'data-recued-logs-cli-failure';

const LOGS_ROUTE_ACTION_ATTR = 'data-recued-logs-action';
const LOGS_ROUTE_RUN_ID_ATTR = 'data-run-id';
const LOGS_ROUTE_QUEUED_CALL_ID_ATTR = 'data-queued-call-id';
// D-186 Slice C — the session-grant id carried on the Revoke button.
const LOGS_ROUTE_GRANT_ID_ATTR = 'data-grant-id';
const LOGS_ROUTE_FILTER_KIND_ATTR = 'data-filter-kind';
const DEFAULT_LIMIT = 25;
// R17 — at most this many live runs show as inline glance rows in the default
// view's Active peek-strip; beyond it the strip collapses to "N running ▸
// manage" so a busy server never buries the History table.
const ACTIVE_PEEK_CAP = 3;

export type RunsListCaller = (
  query: ExecutionListQuery,
) => Promise<ExecutionListResponse>;

export type RunsGetCaller = (
  request: ExecutionGetRequest,
) => Promise<ExecutionGetResponse>;

// D-181 slice 5b — the live-control rpc seam. All four are optional in the
// route; when `activeCaller` is absent the Active section is not rendered (a
// host that wires only the audit feed is unaffected). The three mutators are
// owner-only + bridge-approval-gated server-side (D-181 §13); the webclient
// is the `control` surface so it surfaces the buttons unconditionally.
export type RunsActiveCaller = (
  request: ExecutionActiveRequest,
) => Promise<ExecutionActiveResponse>;

export type RunsKillCaller = (
  request: ExecutionKillRequest,
) => Promise<ExecutionKillResponse>;

export type RunsCancelCaller = (
  request: ExecutionCancelRequest,
) => Promise<ExecutionCancelResponse>;

export type RunsPromoteCaller = (
  request: ExecutionPromoteRequest,
) => Promise<ExecutionPromoteResponse>;

// D-186 Slice C — the live "Active passes" (session-grant) seam. Both are
// optional in the route; when `grantsListCaller` is absent the passes section is
// not rendered (a host that wires only runs/active is unaffected). Owner-only
// server-side (the `collection.contract.` MCP-reserved prefix); the webclient is
// the surface, so it renders the Revoke button unconditionally.
export type RunsSessionGrantListCaller = (
  request: SessionGrantListRequest,
) => Promise<SessionGrantListResponse>;

export type RunsSessionGrantRevokeCaller = (
  request: SessionGrantRevokeRequest,
) => Promise<SessionGrantView>;

/** Optional recipe-name resolution for the Recipe filter combobox —
 *  maps installed recipes to display names (reuses `recipe.list`).
 *  Soft enhancement: absent or failed, the filter is an empty picker. */
export type RunsRecipeNamesCaller = () => Promise<{
  recipes: ReadonlyArray<{ recipe_id: string; name?: string }>;
}>;

/** Static config for the ★ ref-picker backing the Recipe filter. */
const RECIPE_PICKER_CONFIG: RefPicker.RefPickerRenderConfig = {
  pickerId: 'logs-recipe-filter',
  placeholder: 'Any recipe',
  ariaLabel: 'Filter by recipe',
  emptyText: 'No recipes match.',
};

export type RunsTimeRange = 'all' | '24h' | '7d' | '30d';

export interface RunsFilters {
  status: RunAnchorStatus | 'all';
  origin: Actor | 'all';
  recipe_id: string;
  time_range: RunsTimeRange;
}

export interface BootstrapLogsRouteOptions {
  root: HTMLElement;
  document?: Document;
  listCaller?: RunsListCaller;
  getCaller?: RunsGetCaller;
  /** D-181 slice 5b — the live Active section. Wired together: when
   *  `activeCaller` is present the section renders and the three mutators
   *  drive its kill / cancel / promote buttons (absent mutators leave the
   *  list read-only). */
  activeCaller?: RunsActiveCaller;
  killCaller?: RunsKillCaller;
  cancelCaller?: RunsCancelCaller;
  promoteCaller?: RunsPromoteCaller;
  /** D-181 slice 5b — debounce window (ms) for the Active section's
   *  bus-delta-driven re-list. The delay both coalesces a burst of
   *  `execution` deltas into one `execution.active` snapshot AND lets the
   *  server's synchronous `registerRun` settle before the snapshot is taken:
   *  the engine emits the `start` op (execute-handler) BEFORE the run is
   *  inserted into the in-flight registry, so a `start`-triggered snapshot can
   *  race ahead of the insertion and miss the run until the debounce expires.
   *  (Queue membership — a call entering/leaving a lane queue mid-run — now has
   *  its own `queued` / `slot_acquired` deltas from the governor, slice-4
   *  follow-up #2, so the section is fully live off the bus; the only remaining
   *  race the debounce covers is the run-level `start`-before-`registerRun`
   *  window.) Default 250ms; `<= 0` refreshes immediately (tests). */
  activeRefreshDebounceMs?: number;
  /** D-186 Slice C — the live "Active passes" section. Wired together: when
   *  `grantsListCaller` is present the section renders and `grantsRevokeCaller`
   *  drives its Revoke button (absent ⇒ the list is read-only). */
  grantsListCaller?: RunsSessionGrantListCaller;
  grantsRevokeCaller?: RunsSessionGrantRevokeCaller;
  /** Backs the Recipe filter combobox (★ ref-picker). */
  recipeNamesCaller?: RunsRecipeNamesCaller;
  initialRunId?: string;
  /** Originating reviewed Chat action for an exact-run drill-down. Bound to
   * `initialRunId`; selecting another run intentionally drops this context. */
  chatReturn?: ChatPlanAddress;
  /** R24 follow-on — pre-select the Recipe filter from a `#logs/recipe/<recipe_id>`
   *  deep link (the recipe detail's "View runs in Logs" link), so the History
   *  view opens already scoped to that recipe's runs. Seeds `filters.recipe_id`;
   *  the first feed load queries it and the ref-picker shows it selected. The
   *  shell remounts on a hash change, so it is fixed for one mount. */
  initialRecipeId?: string;
  /** R17 — which view to mount. `'logs'` (default) = History table + the capped
   *  Active peek-strip; `'active'` = the full operator console (uncapped Active
   *  + lanes + passes) reached via the `#logs/active` deep link. The shell
   *  remounts the route on a `#logs` ↔ `#logs/active` hash change, so the view
   *  is fixed for the lifetime of one mount. */
  initialView?: 'logs' | 'active';
  now?: () => number;
  subscribe?: BroadcastSubscriber['on'];
}

export interface RunsLoadErrors {
  feed?: string;
  detail?: string;
  active?: string;
  /** D-186 Slice C — the "Active passes" list error. */
  grants?: string;
}

export type RunOutcomeTone =
  | 'positive'
  | 'attention'
  | 'danger'
  | 'neutral';

export interface RunOutcomeAction {
  readonly href: string;
  readonly label: string;
}

export interface RunRecordWarning {
  readonly code: RunDegradation;
  readonly message: string;
}

export interface RunOutcomeSummary {
  readonly tone: RunOutcomeTone;
  readonly title: string;
  readonly detail: string;
  readonly nextStep?: string;
  readonly action?: RunOutcomeAction;
  readonly recordWarnings: ReadonlyArray<RunRecordWarning>;
}

export type RunAffectedItemRelationship =
  | 'involved'
  | 'derived'
  | 'action';

export type RunAffectedItemResolution =
  | 'exact'
  | 'resolve-source'
  | 'fallback';

export interface RunAffectedItem {
  readonly entityId: string;
  readonly collection: string;
  readonly recordId: string;
  readonly title: string;
  readonly relationship: RunAffectedItemRelationship;
  readonly relationshipLabel: string;
  readonly resolution: RunAffectedItemResolution;
  readonly href: string;
  readonly actionLabel: string;
}

export interface RunsRoute {
  getRuns(): ReadonlyArray<RunFeedRow>;
  getNextCursor(): ExecutionListCursor | null;
  getFilters(): RunsFilters;
  getSelectedRun(): RunDetail | null;
  getLoadErrors(): RunsLoadErrors;
  /** D-181 slice 5b — the current live Active snapshot. */
  getActiveEntries(): ReadonlyArray<ActiveExecutionEntry>;
  getLanes(): ReadonlyArray<LaneStatus>;
  /** D-186 Slice C — the current live "Active passes" snapshot. */
  getSessionGrants(): ReadonlyArray<SessionGrantView>;
  refresh(): Promise<void>;
  /** D-181 slice 5b — re-fetch the `execution.active` snapshot. */
  refreshActive(): Promise<void>;
  /** D-186 Slice C — re-fetch the `session_grant.list` snapshot. */
  refreshGrants(): Promise<void>;
  whenLoaded(): Promise<void>;
  setFilters(filters: Partial<RunsFilters>): Promise<void>;
  loadMore(): Promise<void>;
  openRun(run_id: string): Promise<void>;
  /** D-181 slice 5b — owner live-control over the long-op governor. */
  killRun(run_id: string): Promise<void>;
  cancelCall(queued_call_id: string): Promise<void>;
  promoteCall(queued_call_id: string): Promise<void>;
  /** D-186 Slice C — revoke one active session grant (expire it early). */
  revokeGrant(contract_id: string): Promise<void>;
  dispose(): void;
}

const LOGS_ROUTE_STYLES = `
[${LOGS_ROUTE_HOST_ATTR}] {
  /* Inherit the shell's light/dark tokens instead of hard-pinning light
     values, which left inner --bg/--surface-sunk elements dark-on-dark
     in dark mode (visual-UX review). */
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
}
[${LOGS_ROUTE_CHAT_RETURN_ATTR}] {
  min-height: 44px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 14px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
[${LOGS_ROUTE_CHAT_RETURN_ATTR}] a {
  min-height: 44px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--accent);
  font-weight: 680;
  text-decoration: none;
}
[${LOGS_ROUTE_CHAT_RETURN_ATTR}] a:hover,
[${LOGS_ROUTE_CHAT_RETURN_ATTR}] a:focus-visible {
  background: var(--accent-weak);
}
[${LOGS_ROUTE_HOST_ATTR}] a,
[${LOGS_ROUTE_HOST_ATTR}] .logs-inline-link {
  color: var(--accent);
  font-size: 13px;
  text-decoration: none;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-inline-link,
[${LOGS_ROUTE_HOST_ATTR}] .logs-row-links a,
[${LOGS_ROUTE_HOST_ATTR}] .logs-detail-meta a {
  box-sizing: border-box;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  gap: 14px;
  align-items: start;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-panel {
  min-width: 0;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-filters {
  display: grid;
  grid-template-columns: repeat(4, minmax(140px, 1fr)) auto;
  gap: 8px;
  align-items: end;
  margin-bottom: 12px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-field {
  display: grid;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  color: var(--muted);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-select {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 7px 9px;
  font: inherit;
  font-size: 13px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-button {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-button--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-button:disabled {
  cursor: not-allowed;
  opacity: .65;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-table thead th {
  text-align: left;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-table td {
  padding: 8px 10px;
  vertical-align: top;
  border-bottom: 1px solid var(--border-subtle);
}
[${LOGS_ROUTE_ROW_ATTR}] {
  cursor: pointer;
}
[${LOGS_ROUTE_ROW_ATTR}][data-selected="true"] {
  background: var(--surface-sunk, var(--surface));
}
/* Risk marker: an inset rule on the first cell (border-left on a collapsed
   table cell is unreliable; an inset box-shadow paints cleanly). */
[${LOGS_ROUTE_ROW_ATTR}][data-risk="blocked"] td:first-child {
  box-shadow: inset 2px 0 0 var(--danger);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-cell-title {
  display: block;
  font-weight: 650;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-cell-sub {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 11px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-cell-status,
[${LOGS_ROUTE_HOST_ATTR}] .logs-cell-policy {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: center;
  justify-content: flex-start;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-cell-open {
  text-align: right;
  white-space: nowrap;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-row-open {
  min-width: 32px;
  min-height: 32px;
  padding: 2px 9px;
  font-size: 14px;
  line-height: 1.2;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-row-links,
[${LOGS_ROUTE_HOST_ATTR}] .logs-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-top: 6px;
  color: var(--muted);
  font-size: 12px;
}
/* R17 — Status / Policy = single color-coded chips (near-monochrome: one
   accent, one danger). The ok tone keeps the default fg; the rest tint. */
[${LOGS_ROUTE_STATUS_ATTR}],
[${LOGS_ROUTE_POLICY_ATTR}] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--fg);
  font-size: 12px;
  font-weight: 650;
}
[${LOGS_ROUTE_STATUS_ATTR}][data-tone="off"],
[${LOGS_ROUTE_POLICY_ATTR}][data-tone="off"] {
  color: var(--danger);
}
[${LOGS_ROUTE_STATUS_ATTR}][data-tone="accent"],
[${LOGS_ROUTE_POLICY_ATTR}][data-tone="accent"] {
  color: var(--accent);
}
[${LOGS_ROUTE_STATUS_ATTR}][data-tone="neutral"],
[${LOGS_ROUTE_POLICY_ATTR}][data-tone="neutral"] {
  color: var(--muted);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-glyph {
  min-width: 1.5em;
  font-weight: 800;
  text-align: center;
}
[${LOGS_ROUTE_DETAIL_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 12px;
}
[${LOGS_ROUTE_DETAIL_ATTR}] h2,
[${LOGS_ROUTE_DETAIL_ATTR}] h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
[${LOGS_ROUTE_DETAIL_ATTR}] h3 {
  margin-top: 14px;
  font-size: 13px;
}
[${LOGS_ROUTE_OUTCOME_ATTR}] {
  margin: 10px 0 12px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--fg);
  border-radius: 7px;
  background: var(--surface-sunk, var(--surface));
}
[${LOGS_ROUTE_OUTCOME_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
[${LOGS_ROUTE_OUTCOME_ATTR}][data-tone="attention"] {
  border-left-color: var(--accent);
}
[${LOGS_ROUTE_OUTCOME_ATTR}][data-tone="danger"] {
  border-left-color: var(--danger);
}
[${LOGS_ROUTE_OUTCOME_ATTR}][data-tone="neutral"] {
  border-left-color: var(--muted);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-outcome-label {
  margin: 0 0 3px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
[${LOGS_ROUTE_OUTCOME_ATTR}] .logs-outcome-title {
  margin: 0;
  color: var(--fg-strong, var(--fg));
  font-size: 16px;
  line-height: 1.3;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-outcome-copy,
[${LOGS_ROUTE_HOST_ATTR}] .logs-outcome-next {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.45;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-outcome-next {
  color: var(--fg);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-outcome-action {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  margin-top: 7px;
  padding: 0 9px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 6px;
  background: var(--surface);
  font-weight: 680;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-outcome-action:hover,
[${LOGS_ROUTE_HOST_ATTR}] .logs-outcome-action:focus-visible {
  border-color: var(--accent);
  background: var(--accent-weak);
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] {
  margin: 0 0 14px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] h3 {
  margin: 0;
  font-size: 14px;
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-intro,
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-empty {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-list {
  display: grid;
  gap: 8px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px 12px;
  align-items: center;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-copy {
  min-width: 0;
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-title {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 8px;
  align-items: baseline;
  font-size: 13px;
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-relationship {
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .03em;
  text-transform: uppercase;
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-reference,
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-fallback {
  display: block;
  margin-top: 3px;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-action {
  box-sizing: border-box;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 9px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 6px;
  background: var(--surface);
  font-weight: 680;
  text-align: center;
}
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-action:hover,
[${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-action:focus-visible {
  border-color: var(--accent);
  background: var(--accent-weak);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-detail-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-detail-row {
  border-top: 1px solid var(--border-subtle);
  padding-top: 8px;
  font-size: 13px;
}
[${LOGS_ROUTE_DEGRADED_ATTR}],
[${LOGS_ROUTE_REDACTED_IO_ATTR}],
[${LOGS_ROUTE_EMPTY_ATTR}],
[${LOGS_ROUTE_ERROR_ATTR}] {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.45;
}
[${LOGS_ROUTE_DEGRADED_ATTR}] {
  border-left: 2px solid var(--accent);
  padding-left: 8px;
  font-weight: 650;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-record-warnings {
  margin-top: 9px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-record-warnings strong {
  font-weight: 680;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-record-warnings ul {
  display: grid;
  gap: 2px;
  margin: 3px 0 0;
  padding-left: 18px;
  font-weight: 400;
}
@media (max-width: 560px) {
  [${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-row {
    grid-template-columns: minmax(0, 1fr);
  }
  [${LOGS_ROUTE_AFFECTED_ITEMS_ATTR}] .logs-affected-action {
    width: 100%;
  }
}
[${LOGS_ROUTE_ERROR_ATTR}] {
  border-left: 2px solid var(--danger);
  padding-left: 8px;
  color: var(--danger);
}
[${LOGS_ROUTE_EMPTY_ATTR}],
[${LOGS_ROUTE_REDACTED_IO_ATTR}] {
  color: var(--muted);
}
[${LOGS_ROUTE_GATEWAY_TRACE_ATTR}] .logs-trace-title {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
[${LOGS_ROUTE_ACTIVE_ATTR}],
[${LOGS_ROUTE_PASSES_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 12px;
  margin-bottom: 14px;
}
[${LOGS_ROUTE_ACTIVE_ATTR}] .logs-active-head,
[${LOGS_ROUTE_PASSES_ATTR}] .logs-active-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
[${LOGS_ROUTE_ACTIVE_ATTR}] h2,
[${LOGS_ROUTE_PASSES_ATTR}] h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
[${LOGS_ROUTE_LANES_ATTR}] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 12px;
}
[${LOGS_ROUTE_LANES_ATTR}] .logs-lane {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
[${LOGS_ROUTE_LANES_ATTR}] .logs-lane[data-saturated="true"] {
  color: var(--fg);
  font-weight: 650;
}
[${LOGS_ROUTE_ACTIVE_ATTR}] .logs-active-feed,
[${LOGS_ROUTE_PASSES_ATTR}] .logs-active-feed {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${LOGS_ROUTE_ACTIVE_ROW_ATTR}],
[${LOGS_ROUTE_PASS_ROW_ATTR}] {
  border: 1px solid var(--border);
  border-left: 2px solid var(--accent);
  border-radius: 8px;
  background: var(--surface-sunk, var(--surface));
  padding: 10px;
  display: grid;
  gap: 8px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
}
[${LOGS_ROUTE_ACTIVE_ROW_ATTR}][data-stalled="true"] {
  border-left-color: var(--danger);
}
[${LOGS_ROUTE_ACTIVE_ROW_ATTR}] .logs-active-title,
[${LOGS_ROUTE_PASS_ROW_ATTR}] .logs-active-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
[${LOGS_ROUTE_ACTIVE_ROW_ATTR}] .logs-active-meta,
[${LOGS_ROUTE_PASS_ROW_ATTR}] .logs-active-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-top: 6px;
  color: var(--muted);
  font-size: 12px;
}
[${LOGS_ROUTE_ACTIVE_ROW_ATTR}] .logs-active-controls,
[${LOGS_ROUTE_PASS_ROW_ATTR}] .logs-active-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-button--danger {
  border-color: var(--danger);
  color: var(--danger);
}
/* R17 — the default-view Active peek-strip: a glance, not the console box. */
[${LOGS_ROUTE_PEEK_ATTR}] {
  margin-bottom: 14px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-peek-idle {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-peek-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-peek-count {
  font-size: 13px;
  font-weight: 650;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-peek-feed {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-peek-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
  font-size: 13px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-peek-title {
  font-weight: 650;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-peek-sub {
  color: var(--muted);
  font-size: 12px;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-peek-row[data-stalled="true"] .logs-peek-sub {
  color: var(--danger);
}
[${LOGS_ROUTE_ERROR_CATEGORY_ATTR}],
[${LOGS_ROUTE_CLI_FAILURE_ATTR}] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--danger);
  font-size: 12px;
  font-weight: 650;
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-cli-failure {
  color: var(--danger);
}
[${LOGS_ROUTE_HOST_ATTR}] .logs-cli-stderr {
  margin: 6px 0 0;
  padding: 8px;
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 860px) {
  [${LOGS_ROUTE_HOST_ATTR}] .logs-layout,
  [${LOGS_ROUTE_HOST_ATTR}] .logs-filters {
    grid-template-columns: 1fr;
  }
  /* R17 — the History table collapses to label-prefixed cards. */
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table,
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table tbody,
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table tr,
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table td {
    display: block;
  }
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table thead {
    display: none;
  }
  [${LOGS_ROUTE_ROW_ATTR}] {
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 8px;
    padding: 4px 2px;
    background: var(--surface);
  }
  [${LOGS_ROUTE_ROW_ATTR}][data-risk="blocked"] {
    border-left: 2px solid var(--danger);
  }
  [${LOGS_ROUTE_ROW_ATTR}][data-risk="blocked"] td:first-child {
    box-shadow: none;
  }
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table td {
    border-bottom: 0;
    padding: 4px 10px;
  }
  /* Simple cells: label left, value right. Status / Policy keep their own
     left-flowing chip layout (set above) — only the label is prefixed. */
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table td[data-label]:not(.logs-cell-status):not(.logs-cell-policy) {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table td[data-label]::before {
    content: attr(data-label);
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }
  /* Hide an empty Policy cell (allowed runs) so it shows no lone label. */
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table td.logs-cell-policy:empty {
    display: none;
  }
  [${LOGS_ROUTE_HOST_ATTR}] .logs-table td.logs-cell-open {
    text-align: right;
  }
}
`;

const STATUS_LABELS: Record<RunAnchorStatus, string> = {
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  killed: 'killed',
  in_doubt: 'in doubt',
  awaiting_approval: 'awaiting approval',
};

// R17 — near-monochrome chip tone per status (one accent, one danger). Drives
// the color-coded Status chip; replaces the old per-status glyph. `ok` = the
// unremarkable settled-good state (fg), `off` = danger, `accent` = live /
// needs-attention, `neutral` = a benign stop.
type ChipTone = 'ok' | 'off' | 'accent' | 'neutral';

const STATUS_TONES: Record<RunAnchorStatus, ChipTone> = {
  pending: 'accent',
  running: 'accent',
  succeeded: 'ok',
  failed: 'off',
  cancelled: 'neutral',
  killed: 'off',
  in_doubt: 'accent',
  awaiting_approval: 'accent',
};

const POLICY_LABELS: Record<PolicyResult, string> = {
  allowed: 'allowed',
  'approval-requested': 'approval requested',
  denied: 'denied',
  'released-after-approval': 'released after approval',
  blocked: 'blocked',
};

const POLICY_TONES: Record<PolicyResult, ChipTone> = {
  allowed: 'ok',
  'approval-requested': 'accent',
  denied: 'off',
  'released-after-approval': 'ok',
  blocked: 'off',
};

const ACTOR_LABELS: Record<Actor, string> = {
  user_self: 'You',
  contracted_user: 'Connected agent',
  system: 'System',
  anonymous: 'Anonymous visitor',
};

// D-181 slice 5b — display copy for the failed/killed long-op `error_category`
// (§12). The Runs feed + detail surface *why* a run ended without opening the
// audit. Keep the wording neutral + lowercase to match the status glyphs.
const ERROR_CATEGORY_LABELS: Record<HeavyOpErrorCategory, string> = {
  timeout: 'timed out',
  oom: 'out of memory',
  crashed: 'crashed',
  stalled: 'stalled',
  killed: 'killed',
  cancelled_before_dispatch: 'cancelled before dispatch',
};

// D-182 — display copy for a cli (local-binary) step failure (the feed chip + the
// detail block). Neutral + lowercase to match the status glyphs.
const CLI_FAILURE_LABELS: Record<CliFailureReason, string> = {
  not_found: 'tool not found',
  spawn_error: 'tool failed to start',
  nonzero_exit: 'tool error',
  timeout: 'tool timed out',
  bad_output: 'bad tool output',
};

const DEGRADATION_MESSAGES: Record<RunDegradation, string> = {
  audit_unwritten: 'Part of this run’s history could not be saved.',
  provenance_incomplete:
    'Some links to records affected by this run are missing.',
};

const APPROVAL_OUTCOME_LABELS: Record<RunApprovalOutcome, string> = {
  allow: 'Approved',
  deny: 'Denied',
  edit: 'Edited',
  dismiss: 'Dismissed',
  dismiss_unseen: 'Dismissed without review',
};

type RunOutcomeCore = Omit<RunOutcomeSummary, 'recordWarnings'>;

const FAILED_CATEGORY_OUTCOMES: Record<
  HeavyOpErrorCategory,
  RunOutcomeCore
> = {
  timeout: {
    tone: 'danger',
    title: 'Run timed out',
    detail:
      'The run reached its time limit before completing. Earlier steps may still have made changes.',
    nextStep: 'Check the affected app or data before trying again.',
  },
  oom: {
    tone: 'danger',
    title: 'Run ran out of memory',
    detail:
      'The run stopped after exhausting available memory. Earlier steps may still have made changes.',
    nextStep: 'Check the affected app or data before trying again.',
  },
  crashed: {
    tone: 'danger',
    title: 'Run crashed',
    detail:
      'The run stopped unexpectedly before completing. Earlier steps may still have made changes.',
    nextStep: 'Check the affected app or data before trying again.',
  },
  stalled: {
    tone: 'danger',
    title: 'Run stalled',
    detail:
      'The run stopped because it was no longer making progress. Earlier steps may still have made changes.',
    nextStep: 'Check the affected app or data before trying again.',
  },
  killed: {
    tone: 'danger',
    title: 'Run was stopped',
    detail:
      'The run was stopped while an operation was still active. Earlier steps may still have made changes.',
    nextStep: 'Check the affected app or data before trying again.',
  },
  cancelled_before_dispatch: {
    tone: 'neutral',
    title: 'Queued action was cancelled',
    detail:
      'A queued step was cancelled before it was sent, so the run did not complete. Earlier steps may still have made changes.',
    nextStep:
      'Review the activity and any affected app or data before starting a new run.',
  },
};

const CLI_FAILURE_OUTCOMES: Record<CliFailureReason, RunOutcomeCore> = {
  not_found: {
    tone: 'danger',
    title: 'Required tool was not found',
    detail:
      'The run could not start a required local tool and did not complete. Earlier steps may still have made changes.',
    nextStep:
      'Review the tool error below, then install or configure the missing tool.',
  },
  spawn_error: {
    tone: 'danger',
    title: 'Required tool could not start',
    detail:
      'The run could not start a required local tool and did not complete. Earlier steps may still have made changes.',
    nextStep: 'Review the tool error below before trying again.',
  },
  nonzero_exit: {
    tone: 'danger',
    title: 'A required tool returned an error',
    detail:
      'A local tool stopped the run before it completed. Earlier steps may still have made changes.',
    nextStep:
      'Review the tool error and check the affected app or data before trying again.',
  },
  timeout: {
    tone: 'danger',
    title: 'A required tool timed out',
    detail:
      'A local tool exceeded its time limit. Earlier steps may still have made changes.',
    nextStep:
      'Review the tool error and check the affected app or data before trying again.',
  },
  bad_output: {
    tone: 'danger',
    title: 'A required tool returned unreadable output',
    detail:
      'The run could not use a local tool’s result. Earlier steps may still have made changes.',
    nextStep:
      'Review the tool error and check the affected app or data before trying again.',
  },
};

// D-181 slice 5b — the live Active-section copy.
const ACTIVE_STATE_LABELS: Record<ActiveExecutionEntry['state'], string> = {
  running: 'running',
  waiting_slot: 'queued',
  detached: 'detached',
  stopping: 'stopping…',
};

const activeEntryTitle = (entry: ActiveExecutionEntry): string =>
  entry.step_id !== undefined && entry.step_id.length > 0
    ? `${entry.recipe_id} · ${entry.step_id}`
    : entry.recipe_id;

const TIME_RANGE_LABELS: Record<RunsTimeRange, string> = {
  all: 'All time',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

const TIME_RANGE_MS: Partial<Record<RunsTimeRange, number>> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });

const e = (value: unknown): string => escapeHtml(String(value));

const removeChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

const messageForError = (err: unknown): string =>
  humanizeRpcError(err);

const formatDateTime = (ts: number): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString();
};

const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms)) return 'duration unknown';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
};

const detailErrors = (detail: RunDetail): ReadonlyArray<RecipeError> =>
  detail.errors.length > 0 ? detail.errors : detail.audit.errors;

const firstCliFailureReason = (
  detail: RunDetail,
): CliFailureReason | undefined => {
  for (const err of detailErrors(detail)) {
    const cli = err.details.cli_failure;
    if (isCliFailureDetail(cli)) return cli.reason;
  }
  return undefined;
};

const failedOutcome = (detail: RunDetail): RunOutcomeCore => {
  const category = detail.audit.error_category;
  if (category !== undefined) return FAILED_CATEGORY_OUTCOMES[category];

  const errors = detailErrors(detail);
  const permissionDenied =
    detail.approvals.outcome === 'deny'
    || detail.gateway.policy_result === 'denied'
    || errors.some((error) => error.code === 'RECIPE_POLICY_DENIED');
  if (permissionDenied) {
    return {
      tone: 'danger',
      title: 'Permission was denied',
      detail:
        'The denied step was not sent. Earlier steps may still have made changes.',
      nextStep:
        'Review the error and permission details below before trying again.',
    };
  }

  const cliFailure = firstCliFailureReason(detail);
  if (cliFailure !== undefined) return CLI_FAILURE_OUTCOMES[cliFailure];

  return {
    tone: 'danger',
    title: 'Run failed',
    detail:
      'The run ended before completing. Earlier steps may still have made changes.',
    nextStep:
      'Review the error and check the affected app or data before trying again.',
  };
};

const runOutcomeCore = (detail: RunDetail): RunOutcomeCore => {
  const status = detail.audit.status;
  switch (status) {
    case 'pending':
      return {
        tone: 'attention',
        title: 'Run is waiting to start',
        detail: 'The run has been recorded, but it has not started yet.',
        nextStep: 'Check its live status before starting another run.',
        action: {
          href: serializeShellRoute('logs', 'active'),
          label: 'View live status',
        },
      };
    case 'running':
      return {
        tone: 'attention',
        title: 'Run is still in progress',
        detail:
          'The run has started, but no final outcome has been recorded.',
        nextStep: 'Check its live status before starting another run.',
        action: {
          href: serializeShellRoute('logs', 'active'),
          label: 'View live status',
        },
      };
    case 'succeeded':
      return {
        tone: 'positive',
        title: 'Run completed',
        detail: 'The run finished successfully.',
      };
    case 'failed':
      return failedOutcome(detail);
    case 'cancelled':
      return {
        tone: 'neutral',
        title: 'Run was cancelled',
        detail:
          'The run stopped before completing. Earlier steps may still have made changes.',
        nextStep:
          'Review the activity and any affected app or data before starting a new run.',
      };
    case 'killed':
      return FAILED_CATEGORY_OUTCOMES.killed;
    case 'in_doubt':
      return {
        tone: 'attention',
        title: 'Outcome needs verification',
        detail:
          'The system lost confirmation before it could determine whether the action finished.',
        nextStep:
          'Check the affected app or data before trying again. This run will not retry automatically.',
      };
    case 'awaiting_approval': {
      const askId = detail.approvals.ask_id ?? detail.audit.ask_id;
      const hasAsk = askId !== undefined && askId.length > 0;
      return {
        tone: 'attention',
        title: 'Run is waiting for approval',
        detail:
          'The run paused before sending the step that needs approval. That step has not run.',
        nextStep: hasAsk
          ? 'Review the approval to continue or stop the action.'
          : 'This hold is not linked to the approval queue. Check the surface that requested it for next steps.',
        ...(hasAsk
          ? {
              action: {
                href: serializeShellRoute('approvals', askId),
                label: 'Review approval',
              },
            }
          : {}),
      };
    }
    default: {
      const exhaustiveStatus: never = status;
      return exhaustiveStatus;
    }
  }
};

/** Plain-language projection for the run-detail hero.
 *
 * Status remains the authority for whether a run completed. Structured
 * termination / policy / CLI fields only refine a failed status, and audit
 * degradation stays a separate record warning because it does not change the
 * side-effect outcome.
 */
export const projectRunOutcomeSummary = (
  detail: RunDetail,
): RunOutcomeSummary => {
  const core = runOutcomeCore(detail);
  const recordWarnings = (detail.audit.degraded ?? []).map((code) => ({
    code,
    message: DEGRADATION_MESSAGES[code],
  }));
  const hasRecordWarning = recordWarnings.length > 0;
  return {
    ...core,
    ...(hasRecordWarning && core.tone === 'positive'
      ? { tone: 'attention' as const }
      : {}),
    ...(hasRecordWarning && core.nextStep === undefined
      ? {
          nextStep:
            'Review the record warning before relying on this run history.',
        }
      : {}),
    recordWarnings,
  };
};

const originLabel = (origin: RunOrigin): string => {
  if (origin.channel === 'mcp') return 'Connected agent';
  if (origin.channel === 'reception') return 'Reception';
  if (origin.channel === 'schedule') return 'Scheduler';
  if (origin.channel === 'chat' || origin.channel === 'messenger') {
    return 'Bridge';
  }
  if (origin.channel === 'housekeeping' || origin.channel === 'reactive') {
    return 'System';
  }
  if (origin.channel === 'user') return 'You';
  return ACTOR_LABELS[origin.actor];
};

const originDetail = (origin: RunOrigin): string => {
  const parts = [originLabel(origin)];
  if (origin.attribution !== undefined) parts.push(origin.attribution.label);
  return parts.join(' / ');
};

const rowRisk = (row: RunFeedRow): 'blocked' | 'normal' =>
  row.policy_result === 'denied' || row.policy_result === 'blocked'
    ? 'blocked'
    : 'normal';

const runHref = (
  run_id: string,
  returnToChat?: ChatPlanAddress,
): string => serializeLogsRunAddress({
  runId: run_id,
  ...(returnToChat !== undefined ? { returnToChat } : {}),
});

const recipeHref = (recipe_id: string): string =>
  serializeShellRoute('recipes', recipe_id);

const hasRunLink = (
  row: Pick<RunFeedRow, 'status' | 'policy_result'>,
): boolean =>
  row.status === 'awaiting_approval'
  || row.policy_result === 'approval-requested'
  || row.policy_result === 'released-after-approval';

// R17 — a single color-coded chip (tone via `data-tone`); the redundant glyph
// is gone, so a settled run reads "succeeded" not "OK succeeded".
const renderStatus = (status: RunAnchorStatus): string =>
  `<span ${LOGS_ROUTE_STATUS_ATTR}="${e(status)}" data-tone="${STATUS_TONES[status]}">${e(STATUS_LABELS[status])}</span>`;

// R17 — same single-chip treatment. The History table renders this ONLY when
// the policy is not the boring `allowed` default (see `renderHistoryRow`), so
// the old "OK succeeded · OK allowed" double-glyph is gone; the detail's
// gateway trace still calls it directly for its allowed/blocked decisions.
const renderPolicy = (policy: PolicyResult): string =>
  `<span ${LOGS_ROUTE_POLICY_ATTR}="${e(policy)}" data-tone="${POLICY_TONES[policy]}">${e(POLICY_LABELS[policy])}</span>`;

// D-181 slice 5b — the failed/killed `error_category` chip (§12). Closed enum,
// so an unknown value (forward-compat) falls back to the raw token rather than
// rendering blank.
const renderErrorCategory = (category: HeavyOpErrorCategory): string => `
  <span ${LOGS_ROUTE_ERROR_CATEGORY_ATTR}="${e(category)}">
    <span class="logs-glyph" aria-hidden="true">!</span>
    <span>${e(ERROR_CATEGORY_LABELS[category] ?? category)}</span>
  </span>
`;

// D-182 — the feed-row cli failure chip. Disjoint from the error_category chip
// (a stall/kill category); at most one renders per row.
const renderCliFailureChip = (reason: CliFailureReason): string => `
  <span ${LOGS_ROUTE_CLI_FAILURE_ATTR}="${e(reason)}">
    <span class="logs-glyph" aria-hidden="true">!</span>
    <span>${e(CLI_FAILURE_LABELS[reason] ?? reason)}</span>
  </span>
`;

// D-182 — the detail-pane cli failure block: the reason + which tool + exit code,
// plus the tool's own stderr tail (the executor already content-isolation-gated
// it — absent for an input_materialize op). Renders ONLY the structured
// cli_failure sub-object, NEVER the raw err.details blob (which can carry secrets).
const renderCliFailureDetail = (cli: CliFailureDetail): string => {
  const meta = [`<span>${e(CLI_FAILURE_LABELS[cli.reason] ?? cli.reason)}</span>`];
  if (cli.tool !== undefined && cli.tool.length > 0) meta.push(`<span>tool ${e(cli.tool)}</span>`);
  if (cli.exit_code !== undefined) meta.push(`<span>exit ${e(String(cli.exit_code))}</span>`);
  const hasStderr = typeof cli.stderr === 'string' && cli.stderr.length > 0;
  const trimNote = cli.stderr_truncated ? `${hasStderr ? '\n' : ''}…(earlier tool output trimmed)` : '';
  const stderrBlock = hasStderr || cli.stderr_truncated
    ? `<pre class="logs-cli-stderr">${e((cli.stderr ?? '') + trimNote)}</pre>`
    : '';
  return `
    <div class="logs-detail-meta logs-cli-failure">${meta.join('')}</div>
    ${stderrBlock}
  `;
};

const EXECUTION_PROVENANCE_KINDS: ReadonlySet<string> = new Set([
  'execution.action',
  'execution.derived',
  'execution.write',
]);

const isExecutionProvenanceLink = (
  link: RunProvenanceLink,
): boolean => EXECUTION_PROVENANCE_KINDS.has(link.kind);

const isProjectableExecutionProvenanceLink = (
  link: RunProvenanceLink,
): boolean =>
  isExecutionProvenanceLink(link)
  && parseTimelineEntityId(link.entity_id) !== null;

const AFFECTED_RELATIONSHIP_BY_KIND: Readonly<
  Record<string, {
    relationship: RunAffectedItemRelationship;
    label: string;
    rank: number;
  }>
> = {
  'execution.action': {
    relationship: 'action',
    label: 'Used by action',
    rank: 1,
  },
  'execution.derived': {
    relationship: 'derived',
    label: 'Created or changed',
    rank: 3,
  },
  'execution.write': {
    // The persisted kind predates access-mode storage: it can name the written
    // target OR an input read by a local side-effecting step. Do not claim this
    // exact item changed until provenance retains that distinction.
    relationship: 'involved',
    label: 'Involved in change',
    rank: 2,
  },
};

const SOURCE_TAB_BY_COLLECTION: Readonly<
  Partial<Record<string, SourceRecordDataTab>>
> = {
  mail: 'mail',
  calendar: 'calendar',
  file: 'files',
  files: 'files',
};

const DIRECT_DATA_TAB_BY_COLLECTION: Readonly<
  Partial<Record<string, DataEntityVerificationTab>>
> = {
  contact: 'contact',
  form_response: 'form_response',
  crm: 'crm',
  task: 'task',
  note: 'note',
  commitment: 'commitment',
  project: 'project',
  booking: 'booking',
  annotation: 'annotation',
  link: 'link',
  shared: 'shared',
};

const COLLECTION_TITLES: Readonly<Record<string, string>> = {
  mail: 'Mail message',
  calendar: 'Calendar event',
  file: 'File',
  files: 'File',
  contact: 'Contact',
  form_response: 'Form response',
  crm: 'CRM record',
  task: 'Task',
  note: 'Note',
  commitment: 'Commitment',
  project: 'Project',
  booking: 'Booking',
  annotation: 'Annotation',
  link: 'Data link',
  shared: 'Shared data item',
};

const humanizeCollection = (collection: string): string => {
  const raw = collection
    .split('.')
    .filter((part) => part.length > 0)
    .slice(-2)
    .join(' ')
    .replace(/[_-]+/g, ' ')
    .trim();
  return raw.length === 0
    ? 'Data item'
    : raw.charAt(0).toUpperCase() + raw.slice(1);
};

const isCrmCollection = (collection: string): boolean =>
  collection === 'deal'
  || collection === 'account'
  || collection === 'owner'
  || collection.startsWith('connection.api.');

const affectedActionLabel = (
  status: RunAnchorStatus,
  relationship: RunAffectedItemRelationship,
  resolution: RunAffectedItemResolution,
): string => {
  if (resolution === 'fallback') return 'Open Data';
  if (
    status === 'failed'
    || status === 'cancelled'
    || status === 'killed'
    || status === 'in_doubt'
  ) {
    return 'Verify before retrying';
  }
  if (status === 'succeeded') {
    return relationship === 'derived' ? 'View result' : 'Verify item';
  }
  return 'Review item';
};

interface AffectedItemTarget {
  readonly title: string;
  readonly resolution: RunAffectedItemResolution;
  readonly href: string;
}

const affectedItemTarget = (
  collection: string,
  recordId: string,
  entityId: string,
  returnToRun: LogsRunAddress,
  verificationRelationship: DataVerificationRelationship,
): AffectedItemTarget => {
  const sourceTab = SOURCE_TAB_BY_COLLECTION[collection];
  if (sourceTab !== undefined) {
    return {
      title: COLLECTION_TITLES[collection] ?? 'Source record',
      resolution: 'resolve-source',
      href: serializeSourceRecordVerificationAddress({
        tab: sourceTab,
        recordId,
        returnToRun,
        verificationRelationship,
      }),
    };
  }

  const directTab = DIRECT_DATA_TAB_BY_COLLECTION[collection];
  if (directTab !== undefined) {
    return {
      title: COLLECTION_TITLES[collection] ?? humanizeCollection(collection),
      resolution: 'exact',
      href: serializeDataEntityVerificationAddress({
        tab: directTab,
        entityId: directTab === 'crm' ? entityId : recordId,
        returnToRun,
        verificationRelationship,
      }),
    };
  }

  if (isCrmCollection(collection)) {
    return {
      title: `CRM ${humanizeCollection(collection).toLowerCase()}`,
      resolution: 'exact',
      href: serializeDataEntityVerificationAddress({
        tab: 'crm',
        entityId,
        returnToRun,
        verificationRelationship,
      }),
    };
  }

  return {
    title: humanizeCollection(collection),
    resolution: 'fallback',
    href: serializeShellRoute('data'),
  };
};

/** Turn raw provenance edges into one human-readable verification target per
 * entity. A stronger write/derived relationship wins when a run emitted more
 * than one edge for the same item; source mirrors route through an account
 * resolver because the persisted edge does not carry a collection slug. */
export const projectRunAffectedItems = (
  links: ReadonlyArray<RunProvenanceLink>,
  run: Pick<RunFeedRow, 'run_id' | 'status'>,
  returnToChat?: ChatPlanAddress,
): ReadonlyArray<RunAffectedItem> => {
  const returnToRun: LogsRunAddress = {
    runId: run.run_id,
    ...(returnToChat !== undefined ? { returnToChat } : {}),
  };
  const projected = new Map<string, RunAffectedItem & { readonly rank: number }>();
  for (const link of links) {
    const relationship = AFFECTED_RELATIONSHIP_BY_KIND[link.kind];
    if (relationship === undefined) continue;
    const parsed = parseTimelineEntityId(link.entity_id);
    if (parsed === null) continue;
    const target = affectedItemTarget(
      parsed.collection,
      parsed.id,
      link.entity_id,
      returnToRun,
      relationship.relationship,
    );
    const previous = projected.get(link.entity_id);
    if (previous !== undefined && previous.rank >= relationship.rank) continue;
    projected.set(link.entity_id, {
      entityId: link.entity_id,
      collection: parsed.collection,
      recordId: parsed.id,
      title: target.title,
      relationship: relationship.relationship,
      relationshipLabel: relationship.label,
      resolution: target.resolution,
      href: target.href,
      actionLabel: affectedActionLabel(
        run.status,
        relationship.relationship,
        target.resolution,
      ),
      rank: relationship.rank,
    });
  }
  return [...projected.values()].map(({ rank: _rank, ...item }) => item);
};

const renderProvenanceLink = (
  link: RunProvenanceLink,
  idx: number,
): string => {
  const kind = link.kind.toLowerCase();
  const href = kind.includes('connection') ? '#connections' : '#data';
  const label = kind.includes('connection') ? 'Connection' : 'Data entity';
  return `<a ${LOGS_ROUTE_LINK_ATTR}="${e(`entity:${idx}`)}" href="${href}">${label}: ${e(link.kind)} ${e(link.entity_id)}</a>`;
};

const renderRunLinks = (
  row: Pick<RunFeedRow, 'run_id' | 'recipe_id' | 'status' | 'policy_result' | 'links'>
    & { ask_id?: string },
  returnToChat?: ChatPlanAddress,
): string => {
  // R17 — the approval link is run-SCOPED when the run carries a pending ask id:
  // `#approvals/<ask_id>` focuses + highlights that one card instead of dropping
  // the user at the whole queue. Falls back to the bare queue when the id is
  // absent (an older audit row, or a released-after-approval run whose ask has
  // since closed — the focus target degrades to the queue with no highlight).
  //
  // D-210 Phase C — but a run STILL AWAITING with no ask id is a case the
  // fallback above cannot serve: `#approvals` is ask-store-backed, so it
  // structurally cannot contain a hold that has no ask. The link would land
  // the user in an empty queue and tell them nothing is waiting while it is.
  // Render NO link rather than a dead one.
  //
  // Two different states reach here, and suppression is right for both:
  //   - a hold whose lifecycle a PARTY owns directly (the Reception inbox in
  //     notify mode), deliberately never given a durable ask;
  //   - a raise that FAILED after the checkpoint write, until the boot sweep
  //     re-raises — the queue is equally empty in the meantime.
  // The name below says only what this actually knows: awaiting, no ask. It
  // does NOT claim to know which of the two it is.
  //
  // ⛔ Do NOT redirect to the inbox instead. The client cannot tell a
  // reception hold from an ask-less MCP hold without re-deriving
  // `isReceptionOriginSource` here, which is the second-derivation drift the
  // D-210 fanout fence exists to avoid — and it would be simply wrong for the
  // MCP case. The detail pane this sits in already names the run; a link that
  // cannot be made correct is better absent.
  const awaitingWithNoAsk =
    row.status === 'awaiting_approval'
    && !(row.ask_id !== undefined && row.ask_id.length > 0);
  const approvalHref = row.ask_id !== undefined && row.ask_id.length > 0
    ? serializeShellRoute('approvals', row.ask_id)
    : '#approvals';
  const approvalLink = hasRunLink(row) && !awaitingWithNoAsk
    ? `<a ${LOGS_ROUTE_LINK_ATTR}="approval" href="${e(approvalHref)}">Approval</a>`
    : '';
  // Execution provenance now has a human, outcome-adjacent verification
  // surface. Keep legacy/non-execution links — and malformed execution links
  // that cannot be projected there — in this technical row. Suppressing by
  // kind alone would make old or corrupt audit evidence disappear entirely.
  const provenance = row.links
    .filter((link) => !isProjectableExecutionProvenanceLink(link))
    .map(renderProvenanceLink)
    .join('');
  return `
    <div class="logs-row-links">
      <a ${LOGS_ROUTE_LINK_ATTR}="recipe" href="${e(recipeHref(row.recipe_id))}">Recipe: ${e(row.recipe_id)}</a>
      ${approvalLink}
      <a ${LOGS_ROUTE_LINK_ATTR}="audit" href="${e(runHref(row.run_id, returnToChat))}">Audit detail</a>
      ${provenance}
    </div>
  `;
};

const renderFilterOptions = <T extends string>(
  values: ReadonlyArray<T>,
  selected: T | 'all',
  labels: Record<T, string>,
): string => [
  `<option value="all"${selected === 'all' ? ' selected' : ''}>All</option>`,
  ...values.map((value) =>
    `<option value="${e(value)}"${selected === value ? ' selected' : ''}>${e(labels[value])}</option>`,
  ),
].join('');

const renderFilters = (
  filters: RunsFilters,
  recipePickerHtml: string,
): string => `
  <div class="logs-filters">
    <label class="logs-field">
      <span>Status</span>
      <select class="logs-select" ${LOGS_ROUTE_FILTER_ATTR}="status" ${LOGS_ROUTE_FILTER_KIND_ATTR}="status">
        ${renderFilterOptions(RUN_ANCHOR_STATUSES, filters.status, STATUS_LABELS)}
      </select>
    </label>
    <label class="logs-field">
      <span>Origin</span>
      <select class="logs-select" ${LOGS_ROUTE_FILTER_ATTR}="origin" ${LOGS_ROUTE_FILTER_KIND_ATTR}="origin">
        ${renderFilterOptions(ACTORS, filters.origin, ACTOR_LABELS)}
      </select>
    </label>
    <div class="logs-field">
      <span>Recipe</span>
      ${recipePickerHtml}
    </div>
    <label class="logs-field">
      <span>Time range</span>
      <select class="logs-select" ${LOGS_ROUTE_FILTER_ATTR}="time_range" ${LOGS_ROUTE_FILTER_KIND_ATTR}="time_range">
        ${Object.entries(TIME_RANGE_LABELS).map(([value, label]) =>
          `<option value="${e(value)}"${filters.time_range === value ? ' selected' : ''}>${e(label)}</option>`,
        ).join('')}
      </select>
    </label>
    <button type="button" class="logs-button logs-button--primary" ${LOGS_ROUTE_ACTION_ATTR}="apply-filters">Apply</button>
  </div>
`;

// R17 — the History table's status cell: the status chip plus, at most, one
// failure-reason chip (a long-op kill/stall category WINS over a cli-tool
// reason — see `projectRunFeedRow`, so the two are never both present).
const renderHistoryStatusCell = (row: RunFeedRow): string => `
  ${renderStatus(row.status)}
  ${row.error_category !== undefined ? renderErrorCategory(row.error_category) : ''}
  ${row.error_category === undefined && row.cli_failure_reason !== undefined ? renderCliFailureChip(row.cli_failure_reason) : ''}
`;

// R17 — one History row. READ-ONLY: the whole row navigates to the
// `#logs/<run_id>` detail (the ▸ button is the keyboard-reachable affordance;
// the row carries the same `open-detail` action so a mouse click anywhere on it
// opens the run too). Per-row provenance / recipe / approval links live in the
// detail pane (`renderRunLinks`), not in the scannable table.
const renderHistoryRow = (row: RunFeedRow, selected: boolean): string => `
  <tr ${LOGS_ROUTE_ROW_ATTR}="${e(row.run_id)}" data-risk="${rowRisk(row)}"${selected ? ' data-selected="true"' : ''}
    ${LOGS_ROUTE_ACTION_ATTR}="open-detail" ${LOGS_ROUTE_RUN_ID_ATTR}="${e(row.run_id)}">
    <td data-label="Run">
      <span class="logs-cell-title">${e(row.name || row.recipe_id)}</span>
      <span class="logs-cell-sub">${e(row.recipe_id)}</span>
    </td>
    <td data-label="Origin">${e(originLabel(row.origin))}</td>
    <td data-label="Started">${e(formatDateTime(row.started_at))}</td>
    <td data-label="Duration">${e(formatDuration(row.duration_ms))}</td>
    <td data-label="Status" class="logs-cell-status">${renderHistoryStatusCell(row)}</td>
    <td data-label="Policy" class="logs-cell-policy">${row.policy_result !== 'allowed' ? renderPolicy(row.policy_result) : ''}</td>
    <td class="logs-cell-open">
      <button type="button" class="logs-button logs-row-open"
        ${LOGS_ROUTE_ACTION_ATTR}="open-detail" ${LOGS_ROUTE_RUN_ID_ATTR}="${e(row.run_id)}"
        aria-label="Open run detail">▸</button>
    </td>
  </tr>
`;

const renderFeed = (
  runs: ReadonlyArray<RunFeedRow>,
  loading: boolean,
  loadingMore: boolean,
  nextCursor: ExecutionListCursor | null,
  error: string | undefined,
  selectedRunId: string | null,
): string => {
  if (error !== undefined) {
    return `<p ${LOGS_ROUTE_ERROR_ATTR}>${e(error)}</p>`;
  }
  if (loading && runs.length === 0) {
    return `<p ${LOGS_ROUTE_EMPTY_ATTR}>Loading runs...</p>`;
  }
  if (runs.length === 0) {
    return `<p ${LOGS_ROUTE_EMPTY_ATTR}>No runs match these filters.</p>`;
  }
  // Desktop: a columnar table (Run · Origin · Started · Duration · Status ·
  // Policy · ▸). Mobile (≤860px): the same rows collapse to label-prefixed
  // cards via CSS (`td::before { content: attr(data-label) }`).
  return `
    <table class="logs-table">
      <caption class="logs-sr-only">Run history</caption>
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Origin</th>
          <th scope="col">Started</th>
          <th scope="col">Duration</th>
          <th scope="col">Status</th>
          <th scope="col">Policy</th>
          <th scope="col"><span class="logs-sr-only">Open</span></th>
        </tr>
      </thead>
      <tbody>
        ${runs.map((row) => renderHistoryRow(row, row.run_id === selectedRunId)).join('')}
      </tbody>
    </table>
    ${nextCursor !== null
      ? `<button type="button" class="logs-button" ${LOGS_ROUTE_LOAD_MORE_ATTR} ${LOGS_ROUTE_ACTION_ATTR}="load-more">${loadingMore ? 'Loading...' : 'Load more'}</button>`
      : ''}
  `;
};

// D-181 slice 5b — wall-clock wait formatter for the lane line. Mirrors the
// server `/status` `fmtWait` (ms → `45s` / `12m` / `3h`), `—` when idle.
const formatWait = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
};

const renderLanes = (lanes: ReadonlyArray<LaneStatus>): string => {
  if (lanes.length === 0) return '';
  const chips = lanes.map((lane) => {
    const saturated = lane.capacity > 0 && lane.in_use >= lane.capacity;
    const queuedPart = lane.queued > 0
      ? `, ${lane.queued} queued, oldest ${formatWait(lane.oldest_wait_ms)}`
      : '';
    return `<span class="logs-lane" data-lane="${e(lane.lane)}" data-saturated="${saturated}">${e(lane.lane)} ${e(String(lane.in_use))}/${e(String(lane.capacity))}${e(queuedPart)}</span>`;
  }).join('');
  return `<div ${LOGS_ROUTE_LANES_ATTR}>${chips}</div>`;
};

const renderActiveControls = (
  entry: ActiveExecutionEntry,
  busy: boolean,
): string => {
  const disabled = busy ? ' disabled' : '';
  if (entry.entry_kind === 'queued-call' && entry.queued_call_id !== undefined) {
    const id = e(entry.queued_call_id);
    return `
      <div class="logs-active-controls">
        <button type="button" class="logs-button" ${LOGS_ROUTE_ACTION_ATTR}="promote-call" ${LOGS_ROUTE_QUEUED_CALL_ID_ATTR}="${id}"${disabled}>Promote</button>
        <button type="button" class="logs-button logs-button--danger" ${LOGS_ROUTE_ACTION_ATTR}="cancel-call" ${LOGS_ROUTE_QUEUED_CALL_ID_ATTR}="${id}"${disabled}>Cancel</button>
      </div>
    `;
  }
  // `run` + `detached-job` entries are killed by run_id. A queued-call without
  // a threaded run_id (rare, queue feed before the descriptor lands) gets no
  // control — `cancel`/`promote` need the queued_call_id which it also lacks.
  if (entry.run_id !== undefined && entry.run_id.length > 0) {
    return `
      <div class="logs-active-controls">
        <button type="button" class="logs-button logs-button--danger" ${LOGS_ROUTE_ACTION_ATTR}="kill-run" ${LOGS_ROUTE_RUN_ID_ATTR}="${e(entry.run_id)}"${disabled}>Kill</button>
      </div>
    `;
  }
  return '';
};

const activeEntryId = (entry: ActiveExecutionEntry): string =>
  entry.entry_kind === 'queued-call'
    ? entry.queued_call_id ?? entry.run_id ?? ''
    : entry.run_id ?? '';

const renderActiveEntry = (
  entry: ActiveExecutionEntry,
  now: number,
  busyIds: ReadonlySet<string>,
): string => {
  const stalled = entry.progress.stalled === true;
  const sinceTs = entry.slot_acquired_at ?? entry.started_at;
  const elapsed = Number.isFinite(now) && now >= sinceTs
    ? `<span>${e(formatDuration(now - sinceTs))}</span>`
    : '';
  const laneMeta = entry.lane !== undefined ? `<span>lane ${e(entry.lane)}</span>` : '';
  const id = activeEntryId(entry);
  return `
    <li ${LOGS_ROUTE_ACTIVE_ROW_ATTR}="${e(id)}" data-stalled="${stalled}" data-entry-kind="${e(entry.entry_kind)}">
      <div>
        <p class="logs-active-title">${e(activeEntryTitle(entry))}</p>
        <div class="logs-active-meta">
          <span>${e(ACTIVE_STATE_LABELS[entry.state])}</span>
          ${laneMeta}
          <span>${e(entry.origin)}</span>
          ${elapsed}
          ${stalled ? '<span>stalled</span>' : ''}
        </div>
      </div>
      ${renderActiveControls(entry, busyIds.has(id))}
    </li>
  `;
};

// R17 — the default (#logs) view's Active peek-strip: a deferential glance at
// what is running now, capped so it never buries History. Glance-only — acting
// on a run (kill / cancel / promote) happens in the `#logs/active` console (the
// owner's framing: #logs shows what *was* run, not what is executing). Three
// shapes: 0 → a thin "Nothing running" line; 1..cap → inline rows (title ·
// state · elapsed · stalled?); > cap → just "N running ▸ manage".
const renderActivePeek = (
  entries: ReadonlyArray<ActiveExecutionEntry>,
  loading: boolean,
  error: string | undefined,
  now: number,
): string => {
  const consoleHref = e(serializeShellRoute('logs', 'active'));
  const manageLink = `<a class="logs-inline-link" ${LOGS_ROUTE_LINK_ATTR}="manage-active" href="${consoleHref}">manage ▸</a>`;
  const shell = (body: string): string =>
    `<section ${LOGS_ROUTE_PEEK_ATTR}>${body}</section>`;
  if (error !== undefined) {
    return shell(`<p ${LOGS_ROUTE_ERROR_ATTR}>${e(error)}</p>`);
  }
  if (loading && entries.length === 0) {
    return shell('<p class="logs-peek-idle">Checking for active runs…</p>');
  }
  if (entries.length === 0) {
    return shell('<p class="logs-peek-idle">Nothing running.</p>');
  }
  const head = `
    <div class="logs-peek-head">
      <span class="logs-peek-count">${e(String(entries.length))} running</span>
      ${manageLink}
    </div>
  `;
  if (entries.length > ACTIVE_PEEK_CAP) {
    // Long: the count + the manage link only — no rows, History stays in view.
    return shell(head);
  }
  const rows = entries.map((entry) => {
    const sinceTs = entry.slot_acquired_at ?? entry.started_at;
    const elapsed = Number.isFinite(now) && now >= sinceTs
      ? ` · ${e(formatDuration(now - sinceTs))}`
      : '';
    const stalled = entry.progress.stalled === true ? ' · stalled' : '';
    return `
      <li class="logs-peek-row" data-stalled="${entry.progress.stalled === true}">
        <span class="logs-peek-title">${e(activeEntryTitle(entry))}</span>
        <span class="logs-peek-sub">${e(ACTIVE_STATE_LABELS[entry.state])}${elapsed}${stalled}</span>
      </li>
    `;
  }).join('');
  return shell(`${head}<ul class="logs-peek-feed" role="list">${rows}</ul>`);
};

const renderActive = (
  entries: ReadonlyArray<ActiveExecutionEntry>,
  lanes: ReadonlyArray<LaneStatus>,
  loading: boolean,
  error: string | undefined,
  notice: string | undefined,
  now: number,
  busyIds: ReadonlySet<string>,
): string => {
  const body = error !== undefined
    ? `<p ${LOGS_ROUTE_ERROR_ATTR}>${e(error)}</p>`
    : loading && entries.length === 0 && lanes.length === 0
      ? `<p ${LOGS_ROUTE_EMPTY_ATTR}>Loading active executions...</p>`
      : entries.length === 0
        ? `<p ${LOGS_ROUTE_EMPTY_ATTR}>No active executions.</p>`
        : `<ul class="logs-active-feed" role="list">${entries.map((entry) => renderActiveEntry(entry, now, busyIds)).join('')}</ul>`;
  return `
    <section ${LOGS_ROUTE_ACTIVE_ATTR}>
      <div class="logs-active-head">
        <h2>Active</h2>
        <button type="button" class="logs-inline-link" ${LOGS_ROUTE_ACTION_ATTR}="refresh-active">Refresh</button>
      </div>
      ${renderLanes(lanes)}
      ${notice !== undefined ? `<p ${LOGS_ROUTE_DEGRADED_ATTR}>${e(notice)}</p>` : ''}
      ${body}
    </section>
  `;
};

// ════════════════════════════════════════════════════════════════
// D-186 Slice C — the live "Active passes" (session-grant) section.
// ════════════════════════════════════════════════════════════════

// Short, user-facing label for each grant_mode (what kind of pass it is).
const PASS_MODE_LABELS: Record<SessionGrantView['grant_mode'], string> = {
  exact: 'one call',
  batch: 'batch',
  open: 'open-ended',
  scoped: 'scoped',
  raw_op: 'direct op',
};

/** "expires in 4m" — recomputed from `expiry_at` at render time so the label
 *  stays fresh between server re-lists (falls back to the server's
 *  `remaining_ttl_ms` snapshot when the row has no `expiry_at`). */
const formatExpiresIn = (grant: SessionGrantView, now: number): string => {
  const remaining =
    grant.expiry_at !== undefined ? grant.expiry_at - now : grant.remaining_ttl_ms;
  if (remaining === undefined) return 'no expiry';
  if (remaining <= 0) return 'expiring';
  return `expires in ${formatWait(remaining)}`;
};

/** What the pass lets through — prefer the operation(s) (most specific), else
 *  the ingredient(s); append the bound connection as "via <conn>". */
const passPermitsSummary = (permits: SessionGrantView['permits']): string => {
  const parts: string[] = [];
  const ops = permits.operation_ids ?? [];
  const ingredients = permits.ingredient_ids ?? [];
  if (ops.length > 0) parts.push(ops.join(', '));
  else if (ingredients.length > 0) parts.push(ingredients.join(', '));
  const conns = permits.connection_names ?? [];
  if (conns.length > 0) parts.push(`via ${conns.join(', ')}`);
  return parts.join(' ');
};

/** The remaining budget — a batch grant's count is its items; everything else
 *  shows uses-left. Empty when unbounded (no session grant is, but defensive). */
const passBudgetSummary = (grant: SessionGrantView): string => {
  if (grant.grant_mode === 'batch' && grant.member_count !== undefined) {
    return grant.uses_remaining !== undefined && grant.uses_remaining !== grant.member_count
      ? `${grant.uses_remaining}/${grant.member_count} items left`
      : `${grant.member_count} item${grant.member_count === 1 ? '' : 's'}`;
  }
  if (grant.uses_remaining !== undefined && grant.max_uses !== undefined) {
    return `${grant.uses_remaining}/${grant.max_uses} uses left`;
  }
  return '';
};

const renderPassControls = (grant: SessionGrantView, busy: boolean): string => {
  const disabled = busy ? ' disabled' : '';
  return `
    <div class="logs-active-controls">
      <button type="button" class="logs-button logs-button--danger" ${LOGS_ROUTE_ACTION_ATTR}="revoke-grant" ${LOGS_ROUTE_GRANT_ID_ATTR}="${e(grant.contract_id)}"${disabled}>Revoke</button>
    </div>
  `;
};

const renderPassEntry = (
  grant: SessionGrantView,
  now: number,
  busyIds: ReadonlySet<string>,
): string => {
  const permits = passPermitsSummary(grant.permits);
  const budget = passBudgetSummary(grant);
  return `
    <li ${LOGS_ROUTE_PASS_ROW_ATTR}="${e(grant.contract_id)}" data-grant-mode="${e(grant.grant_mode)}">
      <div>
        <p class="logs-active-title">${e(grant.display_name)}</p>
        <div class="logs-active-meta">
          <span>${e(PASS_MODE_LABELS[grant.grant_mode])}</span>
          ${permits.length > 0 ? `<span>${e(permits)}</span>` : ''}
          <span>${e(formatExpiresIn(grant, now))}</span>
          ${budget.length > 0 ? `<span>${e(budget)}</span>` : ''}
        </div>
      </div>
      ${renderPassControls(grant, busyIds.has(grant.contract_id))}
    </li>
  `;
};

const renderPasses = (
  grants: ReadonlyArray<SessionGrantView>,
  loading: boolean,
  error: string | undefined,
  notice: string | undefined,
  now: number,
  busyIds: ReadonlySet<string>,
): string => {
  const body = error !== undefined
    ? `<p ${LOGS_ROUTE_ERROR_ATTR}>${e(error)}</p>`
    : loading && grants.length === 0
      ? `<p ${LOGS_ROUTE_EMPTY_ATTR}>Loading active passes...</p>`
      : grants.length === 0
        ? `<p ${LOGS_ROUTE_EMPTY_ATTR}>No active passes.</p>`
        : `<ul class="logs-active-feed" role="list">${grants.map((grant) => renderPassEntry(grant, now, busyIds)).join('')}</ul>`;
  return `
    <section ${LOGS_ROUTE_PASSES_ATTR}>
      <div class="logs-active-head">
        <h2>Active passes</h2>
        <button type="button" class="logs-inline-link" ${LOGS_ROUTE_ACTION_ATTR}="refresh-passes">Refresh</button>
      </div>
      ${notice !== undefined ? `<p ${LOGS_ROUTE_DEGRADED_ATTR}>${e(notice)}</p>` : ''}
      ${body}
    </section>
  `;
};

const renderErrors = (errors: ReadonlyArray<RecipeError>): string => {
  if (errors.length === 0) {
    return '<p class="logs-detail-row">No run errors recorded.</p>';
  }
  return `
    <ul class="logs-detail-list" role="list">
      ${errors.map((err) => {
        // D-182 — narrow ONLY the structured cli_failure sub-object (executor-
        // gated); the raw err.details blob is never rendered (it can carry secrets).
        const cli = err.details.cli_failure;
        return `
        <li class="logs-detail-row">
          <strong>${e(err.severity)} / ${e(err.code)}</strong>
          <div>${e(err.message)}</div>
          ${isCliFailureDetail(cli) ? renderCliFailureDetail(cli) : ''}
          <div class="logs-detail-meta">
            <span>step ${e(err.source.step_id ?? 'n/a')}</span>
            ${err.source.ingredient_slug ? `<span>op ${e(err.source.ingredient_slug)}</span>` : ''}
            <span>retryable ${e(String(err.retryable))}</span>
            <span>${e(err.timestamp)}</span>
          </div>
        </li>
      `;
      }).join('')}
    </ul>
  `;
};

const renderApprovals = (detail: RunDetail): string => {
  const approvals = detail.approvals;
  const checkpointRows = approvals.checkpoints.map((checkpoint) => `
    <li class="logs-detail-row">
      <strong>${e(checkpoint.gated_step_id)}</strong>
      <div class="logs-detail-meta">
        <span>checkpoint ${e(checkpoint.checkpoint_id)}</span>
        <span>${e(formatDateTime(checkpoint.created_at))}</span>
      </div>
    </li>
  `).join('');
  const outcome = approvals.outcome !== undefined
    ? `<p class="logs-detail-row">Approval result: ${e(APPROVAL_OUTCOME_LABELS[approvals.outcome])}</p>`
    : '';
  if (checkpointRows.length === 0 && outcome.length === 0) {
    return '<p class="logs-detail-row">No approval checkpoints joined to this run.</p>';
  }
  return `
    ${outcome}
    ${checkpointRows.length > 0
      ? `<ul class="logs-detail-list" role="list">${checkpointRows}</ul>`
      : ''}
  `;
};

const renderGatewayTraceRow = (trace: RunGatewayCallTraceEntry): string => `
  <li class="logs-detail-row">
    <div class="logs-trace-title">
      <strong>${e(trace.ingredient)} / ${e(trace.tool)}</strong>
      ${renderStatus(trace.verdict)}
    </div>
    <div class="logs-detail-meta">
      <span>ref ${e(trace.commit_id)}</span>
      <span>type ${e(trace.kind)}</span>
      <span>${e(formatDateTime(trace.dispatched_at))}</span>
      ${trace.duration_ms !== undefined ? `<span>${e(formatDuration(trace.duration_ms))}</span>` : ''}
      ${trace.cached === true ? '<span>cached</span>' : ''}
    </div>
  </li>
`;

const renderGateway = (detail: RunDetail): string => {
  const trace = detail.gateway.per_call_trace;
  return `
    <p class="logs-detail-row">Recorded result: ${renderPolicy(detail.gateway.policy_result)}</p>
    ${trace.length === 0
      ? '<p class="logs-detail-row">No per-step gateway activity was recorded for this run.</p>'
      : `<ul class="logs-detail-list" ${LOGS_ROUTE_GATEWAY_TRACE_ATTR} role="list">
          ${trace.map(renderGatewayTraceRow).join('')}
        </ul>`}
  `;
};

const renderRecordWarnings = (
  warnings: ReadonlyArray<RunRecordWarning>,
): string => {
  if (warnings.length === 0) return '';
  const label = warnings.length === 1 ? 'Record warning' : 'Record warnings';
  return `
    <div class="logs-record-warnings" ${LOGS_ROUTE_DEGRADED_ATTR} role="note">
      <strong>${label}</strong>
      <ul role="list">
        ${warnings.map((warning) =>
          `<li data-degradation="${e(warning.code)}">${e(warning.message)}</li>`,
        ).join('')}
      </ul>
    </div>
  `;
};

const renderOutcome = (detail: RunDetail): string => {
  const summary = projectRunOutcomeSummary(detail);
  return `
    <section ${LOGS_ROUTE_OUTCOME_ATTR}="${e(detail.audit.status)}" data-tone="${e(summary.tone)}" aria-label="Run outcome" tabindex="-1">
      <p class="logs-outcome-label">Outcome</p>
      <h3 class="logs-outcome-title">${e(summary.title)}</h3>
      <p class="logs-outcome-copy">${e(summary.detail)}</p>
      ${summary.nextStep !== undefined
        ? `<p class="logs-outcome-next"><strong>Next:</strong> ${e(summary.nextStep)}</p>`
        : ''}
      ${summary.action !== undefined
        ? `<a class="logs-outcome-action" href="${e(summary.action.href)}">${e(summary.action.label)}</a>`
        : ''}
      ${renderRecordWarnings(summary.recordWarnings)}
    </section>
  `;
};

const runNeedsAffectedItemVerification = (status: RunAnchorStatus): boolean =>
  status === 'failed'
  || status === 'cancelled'
  || status === 'killed'
  || status === 'in_doubt';

const affectedItemsIntro = (status: RunAnchorStatus): string => {
  if (runNeedsAffectedItemVerification(status)) {
    return 'Check these recorded items before retrying or starting a replacement run.';
  }
  if (status === 'succeeded') {
    return 'Open a recorded item to review what the run used or changed.';
  }
  return 'These items were already involved in the run.';
};

const renderAffectedItems = (
  detail: RunDetail,
  returnToChat?: ChatPlanAddress,
): string => {
  const items = projectRunAffectedItems(
    detail.links,
    {
      run_id: detail.audit.run_id,
      status: detail.audit.status,
    },
    returnToChat,
  );
  if (items.length === 0 && !runNeedsAffectedItemVerification(detail.audit.status)) {
    return '';
  }
  const rows = items.map((item, idx) => `
    <li class="logs-affected-row" data-resolution="${e(item.resolution)}">
      <div class="logs-affected-copy">
        <div class="logs-affected-title">
          <span class="logs-affected-relationship">${e(item.relationshipLabel)}</span>
          <strong>${e(item.title)}</strong>
        </div>
        <span class="logs-affected-reference">Reference ${e(item.recordId)}</span>
        ${item.resolution === 'resolve-source'
          ? '<span class="logs-affected-fallback">Data will check connected sources before opening this record.</span>'
          : item.resolution === 'fallback'
            ? '<span class="logs-affected-fallback">An exact record view is not available for this collection yet.</span>'
            : ''}
      </div>
      <a class="logs-affected-action" ${LOGS_ROUTE_LINK_ATTR}="${e(`affected:${idx}`)}" href="${e(item.href)}">${e(item.actionLabel)}</a>
    </li>
  `).join('');
  return `
    <section ${LOGS_ROUTE_AFFECTED_ITEMS_ATTR} aria-labelledby="logs-affected-title">
      <h3 id="logs-affected-title">Recorded items</h3>
      <p class="logs-affected-intro">${e(affectedItemsIntro(detail.audit.status))}</p>
      ${rows.length > 0
        ? `<ul class="logs-affected-list" role="list">${rows}</ul>`
        : '<p class="logs-affected-empty">No item links were recorded. Check the destination app directly before retrying.</p>'}
    </section>
  `;
};

const renderChatReturn = (
  address: ChatPlanAddress | undefined,
): string => address === undefined
  ? ''
  : `<aside ${LOGS_ROUTE_CHAT_RETURN_ATTR} role="note">
      <span>You came here from an action in Chat.</span>
      <a href="${e(serializeChatPlanAddress(address))}" aria-label="Back to the originating Chat action">Back to this Chat action</a>
    </aside>`;

const renderDetail = (
  detail: RunDetail | null,
  selectedRunId: string | null,
  loading: boolean,
  error: string | undefined,
  returnToChat?: ChatPlanAddress,
): string => {
  if (error !== undefined) {
    return `<aside ${LOGS_ROUTE_DETAIL_ATTR}><h2>Run detail</h2><p ${LOGS_ROUTE_ERROR_ATTR}>${e(error)}</p></aside>`;
  }
  if (loading) {
    return `<aside ${LOGS_ROUTE_DETAIL_ATTR}><h2>Run detail</h2><p ${LOGS_ROUTE_EMPTY_ATTR}>Loading ${e(selectedRunId ?? 'run')}...</p></aside>`;
  }
  if (detail === null) {
    return `<aside ${LOGS_ROUTE_DETAIL_ATTR}><h2>Run detail</h2><p ${LOGS_ROUTE_EMPTY_ATTR}>Select a run to see its activity, approvals, errors, and permission decisions.</p></aside>`;
  }

  const audit = detail.audit;
  // R17 — the run's pending-approval ask id (the detail is the only place the
  // approval link now lives — the History table is read-only). Prefer the
  // approvals summary's id, fall back to the audit row's.
  const askId = detail.approvals.ask_id ?? audit.ask_id;
  return `
    <aside ${LOGS_ROUTE_DETAIL_ATTR}="${e(audit.run_id)}">
      <h2>${e(audit.recipe_id)}</h2>
      ${renderOutcome(detail)}
      ${renderAffectedItems(detail, returnToChat)}
      <div class="logs-detail-meta">
        <span>run ${e(audit.run_id)}</span>
        <span>hash ${e(audit.recipe_hash)}</span>
        <span>${e(originDetail(audit.origin))}</span>
        <span>${e(formatDateTime(audit.started_at))}</span>
        <span>${e(formatDuration(audit.duration_ms))}</span>
        ${renderStatus(audit.status)}
        ${audit.error_category !== undefined ? renderErrorCategory(audit.error_category) : ''}
      </div>
      ${audit.trigger_source !== null ? `<p class="logs-detail-row">Trigger source: ${e(audit.trigger_source)}</p>` : ''}
      ${audit.instance_id !== null ? `<p class="logs-detail-row">Instance: ${e(audit.instance_id)}</p>` : ''}
      ${audit.output_string !== undefined
        ? `<p ${LOGS_ROUTE_REDACTED_IO_ATTR}>Redacted output is recorded for this run.</p>`
        : `<p ${LOGS_ROUTE_REDACTED_IO_ATTR}>No redacted output summary recorded.</p>`}

      <h3>Approvals</h3>
      ${renderApprovals(detail)}

      <h3>Errors</h3>
      ${renderErrors(detailErrors(detail))}

      <h3>Gateway</h3>
      ${renderGateway(detail)}

      <h3>Links</h3>
      ${renderRunLinks({
        run_id: audit.run_id,
        recipe_id: audit.recipe_id,
        status: audit.status,
        policy_result: detail.gateway.policy_result,
        links: detail.links,
        ...(askId !== undefined ? { ask_id: askId } : {}),
      }, returnToChat)}
    </aside>
  `;
};

const targetWithAction = (ev: Event): HTMLElement | null => {
  const target = ev.target as (Element & {
    closest?: (selector: string) => Element | null;
  }) | null;
  return target?.closest?.(`[${LOGS_ROUTE_ACTION_ATTR}]`) as HTMLElement | null;
};

const buildQuery = (
  filters: RunsFilters,
  cursor: ExecutionListCursor | null,
  now: number,
): ExecutionListQuery => {
  const query: ExecutionListQuery = { limit: DEFAULT_LIMIT };
  if (filters.status !== 'all') query.status = [filters.status];
  if (filters.origin !== 'all') query.origin = [filters.origin];
  const recipeId = filters.recipe_id.trim();
  if (recipeId.length > 0) query.recipe_id = recipeId;
  const range = TIME_RANGE_MS[filters.time_range];
  if (range !== undefined) query.since = now - range;
  if (cursor !== null) query.cursor = cursor;
  return query;
};

const dedupeRuns = (
  rows: ReadonlyArray<RunFeedRow>,
): ReadonlyArray<RunFeedRow> => {
  const byId = new Map<string, RunFeedRow>();
  for (const row of rows) byId.set(row.run_id, row);
  return [...byId.values()];
};

export const bootstrapLogsRoute = (
  opts: BootstrapLogsRouteOptions,
): RunsRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapLogsRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (doc.head.querySelector(`style[${LOGS_ROUTE_STYLES_MARKER}]`) === null) {
    const style = doc.createElement('style');
    style.setAttribute(LOGS_ROUTE_STYLES_MARKER, '');
    style.textContent = [LOGS_ROUTE_STYLES, RefPicker.REF_PICKER_STYLES].join(
      '\n',
    );
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(LOGS_ROUTE_HOST_ATTR, '');
  opts.root.appendChild(routeRoot);

  // R17 — fixed for this mount; the shell remounts the route on a
  // #logs ↔ #logs/active hash change. 'active' = the full operator console;
  // 'logs' = the default History table + capped Active peek-strip.
  const view: 'logs' | 'active' = opts.initialView ?? 'logs';

  let filters: RunsFilters = {
    status: 'all',
    origin: 'all',
    // R24 follow-on — a `#logs/recipe/<id>` deep link opens pre-scoped to that
    // recipe (buildQuery sends it; resolveRecipeSelection shows it in the picker).
    recipe_id: opts.initialRecipeId ?? '',
    time_range: 'all',
  };
  let runs: ReadonlyArray<RunFeedRow> = [];
  let nextCursor: ExecutionListCursor | null = null;
  let selectedRunId: string | null = opts.initialRunId ?? null;
  let selectedRun: RunDetail | null = null;
  const initialFocusRunId = opts.initialRunId ?? null;
  let pendingInitialRunFocus = initialFocusRunId !== null;
  // The Chat return is meaningful only for the exact inbound run. A later
  // History selection becomes an ordinary Logs drill-down and drops it.
  const chatReturnRunId =
    opts.chatReturn !== undefined && selectedRunId !== null
      ? selectedRunId
      : null;
  let chatReturn =
    chatReturnRunId === null ? undefined : opts.chatReturn;
  let loadingFeed = false;
  let loadingMore = false;
  let loadingDetail = false;
  let errors: RunsLoadErrors = {};
  let disposed = false;
  let feedSeq = 0;
  let detailSeq = 0;
  // D-181 slice 5b — the live Active section.
  let activeEntries: ReadonlyArray<ActiveExecutionEntry> = [];
  let lanes: ReadonlyArray<LaneStatus> = [];
  let loadingActive = false;
  let activeSeq = 0;
  let activeNotice: string | undefined;
  const busyControlIds = new Set<string>();
  const hasActiveSection = opts.activeCaller !== undefined;
  const activeRefreshDebounceMs = opts.activeRefreshDebounceMs ?? 250;
  let activeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // D-186 Slice C — the live "Active passes" (session-grant) section. Reuses
  // the active section's debounce window for its bus-delta re-list.
  let sessionGrants: ReadonlyArray<SessionGrantView> = [];
  let loadingGrants = false;
  let grantsSeq = 0;
  let grantsNotice: string | undefined;
  const busyGrantIds = new Set<string>();
  const hasPassesSection = opts.grantsListCaller !== undefined;
  let grantsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Recipe filter combobox (★ ref-picker). `recipeNameOptions` loads once
  // from `recipe.list`; the picker filters them client-side. The single
  // source of truth for the chosen recipe stays `filters.recipe_id` — the
  // resting selection is derived from it at render time.
  let recipeNameOptions: ReadonlyArray<RefPicker.RefPickerOption> = [];
  let recipePicker: RefPicker.RefPickerHandle | null = null;

  const resolveRecipeSelection = (): RefPicker.RefPickerSelection | null => {
    const id = filters.recipe_id.trim();
    if (id === '') return null;
    const match = recipeNameOptions.find((option) => option.id === id);
    return { id, label: match?.label ?? id };
  };

  const recipeSearch = (
    query: string,
  ): Promise<readonly RefPicker.RefPickerOption[]> =>
    Promise.resolve(RefPicker.filterRefOptions(recipeNameOptions, query));

  // Mount once the shell first exists, then re-attach after every full
  // re-paint — the picker keeps its own state, so `rewire` restores an
  // open dropdown / in-progress query / focus.
  const mountRecipePicker = (): void => {
    if (recipePicker === null) {
      recipePicker = RefPicker.wireRefPicker(routeRoot, {
        search: recipeSearch,
        config: RECIPE_PICKER_CONFIG,
        minChars: 0,
        initialValue: resolveRecipeSelection(),
        // Mirror the old free-text input: stage the filter; the Apply
        // button applies it (no auto-refetch on pick).
        onChange: (selection) => {
          filters = { ...filters, recipe_id: selection?.id ?? '' };
        },
      });
    } else {
      recipePicker.rewire(routeRoot);
    }
  };

  const render = (): void => {
    const nowMs = opts.now?.() ?? Date.now();
    if (view === 'active') {
      // Console — the cross-session operator surface: the uncapped Active list
      // (+ lanes + controls) and the Active passes. No feed, no Recipe picker.
      routeRoot.innerHTML = `
        <header class="logs-header">
          <a class="logs-inline-link" href="${e(serializeShellRoute('logs'))}" ${LOGS_ROUTE_LINK_ATTR}="back-to-logs">← Logs</a>
          <h1 class="logs-title" ${LOGS_ROUTE_HEADING_ATTR}>Active runs</h1>
        </header>
        ${hasActiveSection
          ? renderActive(
              activeEntries,
              lanes,
              loadingActive,
              errors.active,
              activeNotice,
              nowMs,
              busyControlIds,
            )
          : ''}
        ${hasPassesSection
          ? renderPasses(
              sessionGrants,
              loadingGrants,
              errors.grants,
              grantsNotice,
              nowMs,
              busyGrantIds,
            )
          : ''}
      `;
      return;
    }
    // Default — the History table, with a capped Active peek-strip above it.
    routeRoot.innerHTML = `
      <header class="logs-header">
        <h1 class="logs-title" ${LOGS_ROUTE_HEADING_ATTR}>Logs</h1>
      </header>
      ${renderChatReturn(chatReturn)}
      ${hasActiveSection
        ? renderActivePeek(activeEntries, loadingActive, errors.active, nowMs)
        : ''}
      ${renderFilters(
        filters,
        RefPicker.renderRefPicker(
          RefPicker.initialRefPickerState(resolveRecipeSelection()),
          RECIPE_PICKER_CONFIG,
        ),
      )}
      <div class="logs-layout">
        <section class="logs-panel">
          ${renderFeed(runs, loadingFeed, loadingMore, nextCursor, errors.feed, selectedRunId)}
        </section>
        ${renderDetail(
          selectedRun,
          selectedRunId,
          loadingDetail,
          errors.detail,
          chatReturn,
        )}
      </div>
    `;
    // (Re-)attach the Recipe combobox to the freshly-painted shell.
    mountRecipePicker();
  };

  /** Delay focus until the feed and exact detail have both settled; otherwise
   * the last parallel hydration paint can replace the focused outcome. */
  const focusInitialRunOutcome = (): void => {
    if (
      !pendingInitialRunFocus
      || selectedRunId !== initialFocusRunId
      || selectedRun === null
    ) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selectors: string) => HTMLElement | null;
    };
    const outcome =
      queryable.querySelector?.(`[${LOGS_ROUTE_OUTCOME_ATTR}]`) ?? null;
    if (outcome === null) return;
    pendingInitialRunFocus = false;
    outcome.focus?.({ preventScroll: true });
  };

  const loadRecipeNames = async (): Promise<void> => {
    if (opts.recipeNamesCaller === undefined) return;
    try {
      const { recipes } = await opts.recipeNamesCaller();
      recipeNameOptions = recipes.map((r) => {
        const named = typeof r.name === 'string' && r.name.length > 0;
        return {
          id: r.recipe_id,
          label: named ? r.name! : r.recipe_id,
          // When a human name resolves, keep the id as a disambiguating
          // sub-line; otherwise the label already IS the id.
          ...(named ? { sublabel: r.recipe_id } : {}),
        };
      });
    } catch {
      // Soft enhancement — leave the picker empty on failure.
    }
  };

  const loadFeed = async (mode: 'replace' | 'append'): Promise<void> => {
    if (opts.listCaller === undefined) {
      errors = { ...errors, feed: 'execution.list caller is not wired in this host.' };
      render();
      return;
    }
    const seq = ++feedSeq;
    if (mode === 'replace') {
      loadingFeed = true;
      nextCursor = null;
    } else {
      loadingMore = true;
    }
    errors = { ...errors, feed: undefined };
    render();
    try {
      const response = await opts.listCaller(
        buildQuery(
          filters,
          mode === 'append' ? nextCursor : null,
          opts.now?.() ?? Date.now(),
        ),
      );
      if (disposed || seq !== feedSeq) return;
      runs = mode === 'append'
        ? dedupeRuns([...runs, ...response.runs])
        : response.runs;
      nextCursor = response.next_cursor ?? null;
      const { feed: _feed, ...rest } = errors;
      errors = rest;
    } catch (err) {
      if (disposed || seq !== feedSeq) return;
      errors = { ...errors, feed: messageForError(err) };
    } finally {
      if (!disposed && seq === feedSeq) {
        loadingFeed = false;
        loadingMore = false;
        render();
      }
    }
  };

  // R17 — keep the URL addressable on in-page master-detail selection (R16).
  // The History row opens its run via `openRun` (smooth, no shell remount); this
  // reflects the open run as `#logs/<run_id>` with `replaceState` so a refresh /
  // shared link re-opens it, WITHOUT a hashchange (no remount → the table never
  // refetch-flashes, and the slice-2 `#logs/active` view-switch — a real
  // hashchange — is unaffected). Guarded for the console view (it owns no run
  // selection) and for the test fake DOM (no `defaultView`); replaceState can
  // throw in sandboxed embeddings, so it is best-effort.
  const syncSelectedHash = (run_id: string): void => {
    if (disposed || view !== 'logs') return;
    const history = doc.defaultView?.history;
    if (history?.replaceState === undefined) return;
    try {
      history.replaceState(null, '', runHref(run_id, chatReturn));
    } catch {
      // Non-fatal — addressability degrades to in-page-only.
    }
  };

  const openRun = async (run_id: string): Promise<void> => {
    if (disposed) return;
    if (run_id !== initialFocusRunId) pendingInitialRunFocus = false;
    if (chatReturn !== undefined && run_id !== chatReturnRunId) {
      chatReturn = undefined;
    }
    selectedRunId = run_id;
    syncSelectedHash(run_id);
    if (opts.getCaller === undefined) {
      errors = { ...errors, detail: 'execution.get caller is not wired in this host.' };
      render();
      return;
    }
    const seq = ++detailSeq;
    selectedRun = null;
    loadingDetail = true;
    errors = { ...errors, detail: undefined };
    render();
    try {
      const response = await opts.getCaller({ run_id });
      if (disposed || seq !== detailSeq) return;
      selectedRun = response.run;
      const { detail: _detail, ...rest } = errors;
      errors = rest;
    } catch (err) {
      if (disposed || seq !== detailSeq) return;
      errors = { ...errors, detail: messageForError(err) };
    } finally {
      if (!disposed && seq === detailSeq) {
        loadingDetail = false;
        render();
      }
    }
  };

  const loadActive = async (): Promise<void> => {
    if (opts.activeCaller === undefined) return;
    const seq = ++activeSeq;
    loadingActive = true;
    errors = { ...errors, active: undefined };
    render();
    try {
      // Owner view — no `session_id`: the Runs page is the cross-session
      // owner surface, so the server returns every attended + unattended
      // entry (D-181 §7b / handler `handleExecutionActive`).
      const response = await opts.activeCaller({});
      if (disposed || seq !== activeSeq) return;
      activeEntries = response.entries;
      lanes = response.lanes;
      const { active: _active, ...rest } = errors;
      errors = rest;
    } catch (err) {
      if (disposed || seq !== activeSeq) return;
      errors = { ...errors, active: messageForError(err) };
    } finally {
      if (!disposed && seq === activeSeq) {
        loadingActive = false;
        render();
      }
    }
  };

  /** Debounced re-list for the bus-delta path (NOT user actions, which
   *  re-list immediately). Coalesces a delta burst + survives the
   *  emit-`start`-before-`registerRun` race (see `activeRefreshDebounceMs`). */
  const scheduleActiveRefresh = (): void => {
    if (opts.activeCaller === undefined || disposed) return;
    if (activeRefreshDebounceMs <= 0) {
      void loadActive();
      return;
    }
    if (activeRefreshTimer !== null) clearTimeout(activeRefreshTimer);
    activeRefreshTimer = setTimeout(() => {
      activeRefreshTimer = null;
      void loadActive();
    }, activeRefreshDebounceMs);
  };

  /** Run one live-control mutation, then re-list. `busyId` disables the
   *  entry's buttons while the call is in flight; `notice` surfaces the
   *  server's non-terminal verdict (`already_terminal` / `already_dispatched`
   *  / `not_found`) so a no-op click is legible rather than silent. */
  const runControl = async (
    busyId: string,
    op: () => Promise<{ noticed?: string } | void>,
  ): Promise<void> => {
    if (busyId.length === 0 || busyControlIds.has(busyId)) return;
    busyControlIds.add(busyId);
    activeNotice = undefined;
    render();
    try {
      const result = await op();
      if (disposed) return;
      if (result && result.noticed !== undefined) activeNotice = result.noticed;
    } catch (err) {
      if (disposed) return;
      activeNotice = messageForError(err);
    } finally {
      busyControlIds.delete(busyId);
      if (!disposed) await loadActive();
    }
  };

  const killRun = (run_id: string): Promise<void> =>
    runControl(run_id, async () => {
      if (opts.killCaller === undefined) {
        return { noticed: 'execution.kill caller is not wired in this host.' };
      }
      const { status } = await opts.killCaller({ run_id });
      if (status === 'killed') return;
      return {
        noticed: status === 'already_terminal'
          ? 'That run already finished.'
          : 'That run is no longer active.',
      };
    });

  const cancelCall = (queued_call_id: string): Promise<void> =>
    runControl(queued_call_id, async () => {
      if (opts.cancelCaller === undefined) {
        return { noticed: 'execution.cancel caller is not wired in this host.' };
      }
      const { status } = await opts.cancelCaller({ queued_call_id });
      if (status === 'cancelled_before_dispatch') return;
      return {
        noticed: status === 'already_dispatched'
          ? 'That call already started — use Kill instead.'
          : 'That queued call is no longer waiting.',
      };
    });

  const promoteCall = (queued_call_id: string): Promise<void> =>
    runControl(queued_call_id, async () => {
      if (opts.promoteCaller === undefined) {
        return { noticed: 'execution.promote caller is not wired in this host.' };
      }
      const { status } = await opts.promoteCaller({ queued_call_id });
      if (status === 'promoted') return;
      return { noticed: 'That queued call is no longer waiting.' };
    });

  // ── D-186 Slice C — "Active passes" (session-grant) load + revoke ──

  const loadGrants = async (): Promise<void> => {
    if (opts.grantsListCaller === undefined) return;
    const seq = ++grantsSeq;
    loadingGrants = true;
    errors = { ...errors, grants: undefined };
    render();
    try {
      // Owner view — no `channel_session_id`: the Runs page is the cross-session
      // owner surface, so the server returns every ACTIVE session grant owner-
      // wide (handler `handleSessionGrantList`).
      const response = await opts.grantsListCaller({});
      if (disposed || seq !== grantsSeq) return;
      sessionGrants = response.grants;
      const { grants: _grants, ...rest } = errors;
      errors = rest;
    } catch (err) {
      if (disposed || seq !== grantsSeq) return;
      errors = { ...errors, grants: messageForError(err) };
    } finally {
      if (!disposed && seq === grantsSeq) {
        loadingGrants = false;
        render();
      }
    }
  };

  /** Debounced re-list for the `contract.contract_definition_changed` bus path
   *  (a grant minted at the gate / revoked / consumed-to-exhaustion on any
   *  paired client). Coalesces a burst into one `session_grant.list`. Reuses
   *  the Active section's debounce window. */
  const scheduleGrantsRefresh = (): void => {
    if (opts.grantsListCaller === undefined || disposed) return;
    if (activeRefreshDebounceMs <= 0) {
      void loadGrants();
      return;
    }
    if (grantsRefreshTimer !== null) clearTimeout(grantsRefreshTimer);
    grantsRefreshTimer = setTimeout(() => {
      grantsRefreshTimer = null;
      void loadGrants();
    }, activeRefreshDebounceMs);
  };

  const revokeGrant = async (contract_id: string): Promise<void> => {
    if (contract_id.length === 0 || busyGrantIds.has(contract_id)) return;
    busyGrantIds.add(contract_id);
    grantsNotice = undefined;
    render();
    try {
      if (opts.grantsRevokeCaller === undefined) {
        grantsNotice = 'session_grant.revoke caller is not wired in this host.';
        return;
      }
      await opts.grantsRevokeCaller({ contract_id });
      // Success path stays silent — the row drops on the re-list below (and the
      // server's `contract.contract_definition_changed` broadcast re-lists every
      // other paired client). The revoke also echoes back the now-`revoked`
      // view, which the active-only list omits.
    } catch (err) {
      if (disposed) return;
      // A `not_found` means the pass already expired / was revoked elsewhere —
      // surface it so a no-op click is legible rather than silent (mirrors the
      // Active section's `runControl` notice posture).
      grantsNotice = messageForError(err);
    } finally {
      // Hold the busy flag THROUGH the re-list so the row stays disabled until
      // it drops off (no flash-of-enabled-button → no duplicate revoke rpc on
      // an already-revoked grant). Clear + re-render after, so the error path
      // (row persists) re-enables the button. `loadGrants` re-renders on the
      // success path (row gone); the trailing render only matters when it stays.
      if (!disposed) await loadGrants();
      busyGrantIds.delete(contract_id);
      if (!disposed) render();
    }
  };

  const onClick = (ev: Event): void => {
    const target = targetWithAction(ev);
    if (target === null) return;
    const action = target.getAttribute(LOGS_ROUTE_ACTION_ATTR);
    if (action === 'apply-filters') {
      void loadFeed('replace');
      return;
    }
    if (action === 'load-more') {
      if (nextCursor !== null) void loadFeed('append');
      return;
    }
    if (action === 'open-detail') {
      const runId = target.getAttribute(LOGS_ROUTE_RUN_ID_ATTR);
      if (runId !== null && runId.length > 0) void openRun(runId);
      return;
    }
    if (action === 'refresh-active') {
      void loadActive();
      return;
    }
    if (action === 'kill-run') {
      const runId = target.getAttribute(LOGS_ROUTE_RUN_ID_ATTR);
      if (runId !== null && runId.length > 0) void killRun(runId);
      return;
    }
    if (action === 'cancel-call') {
      const callId = target.getAttribute(LOGS_ROUTE_QUEUED_CALL_ID_ATTR);
      if (callId !== null && callId.length > 0) void cancelCall(callId);
      return;
    }
    if (action === 'promote-call') {
      const callId = target.getAttribute(LOGS_ROUTE_QUEUED_CALL_ID_ATTR);
      if (callId !== null && callId.length > 0) void promoteCall(callId);
      return;
    }
    if (action === 'refresh-passes') {
      void loadGrants();
      return;
    }
    if (action === 'revoke-grant') {
      const grantId = target.getAttribute(LOGS_ROUTE_GRANT_ID_ATTR);
      if (grantId !== null && grantId.length > 0) void revokeGrant(grantId);
    }
  };

  const onChange = (ev: Event): void => {
    const target = ev.target as HTMLSelectElement | null;
    if (target === null || typeof target.getAttribute !== 'function') return;
    const kind = target.getAttribute(LOGS_ROUTE_FILTER_KIND_ATTR);
    if (kind === 'status') {
      filters = { ...filters, status: target.value as RunsFilters['status'] };
    } else if (kind === 'origin') {
      filters = { ...filters, origin: target.value as RunsFilters['origin'] };
    } else if (kind === 'time_range') {
      filters = { ...filters, time_range: target.value as RunsTimeRange };
    }
  };

  routeRoot.addEventListener('click', onClick);
  routeRoot.addEventListener('change', onChange);

  const unsubscribers: Array<() => void> = [];
  if (opts.subscribe !== undefined) {
    // The History feed + its session/ask-driven re-list only exist in the
    // default view; the console has no feed, so don't subscribe there.
    if (view === 'logs') {
      unsubscribers.push(
        opts.subscribe('session_lifecycle', () => {
          void loadFeed('replace');
        }),
        opts.subscribe('notification.ask_closed', () => {
          void loadFeed('replace');
        }),
      );
    }
    // D-181 slice 5b + slice-4 follow-up #2 — the Active section re-lists off
    // the long-op governor's live deltas, now covering every membership change:
    // the engine `start` adds the run; the governor emits `queued` /
    // `slot_acquired` (a call entering/leaving a lane queue mid-run) + `stalled`
    // / `promoted` / `cancelled` / `killed`; and the registry's `retired` (every
    // `completeRun`) removes the run — the ONLY removal signal on the
    // durable-pause / trigger-skipped exits, which emit no `complete`/`error`.
    // So the section stays live off the bus alone — no catch-up poll. Skip the
    // high-frequency `progress` op (it never changes membership — `stalled`
    // carries the only progress transition the list cares about). The refresh is
    // debounced (`scheduleActiveRefresh`) to coalesce bursts AND to outlast the
    // server's emit-`start`-before-`registerRun` window so a freshly-started run
    // reliably appears.
    if (hasActiveSection) {
      unsubscribers.push(
        opts.subscribe('execution', (event) => {
          if (event.op === 'progress') return;
          scheduleActiveRefresh();
        }),
      );
    }
    // D-186 Slice C — the "Active passes" section re-lists off the
    // `contract.contract_definition_changed` bus kind (the authoritative
    // mint/revoke signal — fired by the session-grant resolver on a gate mint
    // and by `session_grant.revoke`). A peer minting / revoking a pass reflects
    // live here without a manual refresh. Debounced (`scheduleGrantsRefresh`) to
    // coalesce a burst. (The kind also fires for standing-contract + delegation
    // lifecycle, which the list filters out — a harmless extra re-list.)
    if (hasPassesSection && view === 'active') {
      unsubscribers.push(
        opts.subscribe('contract.contract_definition_changed', () => {
          scheduleGrantsRefresh();
        }),
      );
    }
  }

  render();
  const initialLoad = (view === 'active'
    ? Promise.all([
        // Console — the Active list (+ lanes) and Active passes; no feed.
        hasActiveSection ? loadActive() : Promise.resolve(),
        hasPassesSection ? loadGrants() : Promise.resolve(),
      ])
    : Promise.all([
        // Default — the History feed and a deep-linked run are independent
        // reads. Start the exact detail immediately instead of making it wait
        // for the list; that also prevents a late list completion from opening
        // the stale run after this route has already been disposed.
        loadFeed('replace'),
        selectedRunId !== null
          ? openRun(selectedRunId)
          : Promise.resolve(),
        hasActiveSection ? loadActive() : Promise.resolve(),
        loadRecipeNames(),
      ])
  ).then(() => {
    if (!disposed) focusInitialRunOutcome();
  });

  return {
    getRuns: () => runs,
    getNextCursor: () => nextCursor,
    getFilters: () => filters,
    getSelectedRun: () => selectedRun,
    getLoadErrors: () => errors,
    getActiveEntries: () => activeEntries,
    getLanes: () => lanes,
    getSessionGrants: () => sessionGrants,
    refresh: () => loadFeed('replace'),
    refreshActive: () => loadActive(),
    refreshGrants: () => loadGrants(),
    whenLoaded: () => initialLoad,
    setFilters: async (next) => {
      filters = { ...filters, ...next };
      // A programmatic recipe-filter change must push into the picker's
      // own state, else the next `rewire()` repaints the (now stale)
      // internal selection over the freshly-rendered label.
      if (next.recipe_id !== undefined) {
        recipePicker?.setValue(resolveRecipeSelection());
      }
      await loadFeed('replace');
    },
    loadMore: async () => {
      if (nextCursor === null) return;
      await loadFeed('append');
    },
    openRun,
    killRun,
    cancelCall,
    promoteCall,
    revokeGrant,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (activeRefreshTimer !== null) {
        clearTimeout(activeRefreshTimer);
        activeRefreshTimer = null;
      }
      if (grantsRefreshTimer !== null) {
        clearTimeout(grantsRefreshTimer);
        grantsRefreshTimer = null;
      }
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      recipePicker?.destroy();
      recipePicker = null;
      routeRoot.removeEventListener('click', onClick);
      routeRoot.removeEventListener('change', onChange);
      try {
        removeChildren(routeRoot);
        opts.root.removeChild(routeRoot);
      } catch {
        // Test fakes may detach the host first. Event listeners and
        // subscriptions have already been removed.
      }
    },
  };
};
