/** Reactive-substrate slice 1 — top-level Automation route.
 *
 *  The cross-pack governance view: every rule that runs without the
 *  user — cron schedules, warehouse event-triggers, auto-run tickers —
 *  in one surface with arm/disarm per row.
 *  Governance-load-bearing, not tidiness: "you control autonomous
 *  action" fails if you must open each pack to see what fires.
 *
 *  Four sections, one mechanism each:
 *    - Schedules            `schedules.{list,update,delete}`
 *    - Event triggers       `triggers.{list,update,delete}`
 *    - Watches              `watch.{list,update}` (poll-manager / G6 —
 *      the connection-entity poll loops trigger demand spins up;
 *      pause/resume only, rows derive from triggers + connections)
 *    - Auto-run             `auto_run.{list,update}`
 *
 *  Recipe-origin trigger rows (G6 declarative reconciler) show a
 *  "from recipe" badge and hide Remove — the reconciler would re-create
 *  a deleted row on the next recipe-store mutation; disarm is the
 *  supported gesture and it sticks.
 *
 *  Live refresh rides the D-121 bus: `schedule` (CRUD + fires),
 *  `automation_rule_changed` (trigger CRUD / auto-run toggle / watch
 *  pause + auto-disable / dispatcher auto-disable), `reactive_fire`
 *  (auto-run + trigger last-run stamps). Each section degrades
 *  independently — a missing caller or a failed load renders that
 *  section's error line without taking the page down. */

import type {
  AutoRunStatusEntry,
  Dish,
  DishLastRun,
  DishRunRow,
  EventTrigger,
  ServerRecipeListEntry,
  ServerSchedule,
  WatchSourceStatusEntry,
  WatchStatusEntry,
} from '@recued/contracts';
import {
  describeCron,
  decodeMcpResourceUri,
  MCP_RESOURCE_POLL_SOURCE_ID,
} from '@recued/contracts';

import {
  formatClientDateTime,
  RefPicker,
  RunModal,
  wireConfigEditorOverlay,
  type ConfigEditorOverlayHandle,
} from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { serializeShellRoute } from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

/** Static config for the ★ ref-picker backing the recipe filter. */
const RECIPE_PICKER_CONFIG: RefPicker.RefPickerRenderConfig = {
  pickerId: 'automation-recipe-filter',
  placeholder: 'All recipes',
  ariaLabel: 'Filter automation by recipe',
  emptyText: 'No automated recipes match.',
};

/** R21 create path — the "Add" recipe picker (which recipe to schedule /
 *  attach a trigger to; options = EVERY installed recipe, not just the
 *  already-automated set the filter picker shows). */
const ADD_PICKER_CONFIG: RefPicker.RefPickerRenderConfig = {
  pickerId: 'automation-add-recipe',
  placeholder: 'Choose a recipe…',
  ariaLabel: 'Choose a recipe to automate',
  emptyText: 'No installed recipes match.',
};

export const AUTOMATION_ROUTE_STYLES_MARKER = 'data-recued-automation-route-styles';
export const AUTOMATION_ROUTE_HOST_ATTR = 'data-recued-automation-route';
export const AUTOMATION_ROUTE_HEADING_ATTR = 'data-recued-automation-heading';
export const AUTOMATION_ROUTE_SECTION_ATTR = 'data-recued-automation-section';
export const AUTOMATION_ROUTE_ROW_ATTR = 'data-recued-automation-row';
export const AUTOMATION_ROUTE_STATE_ATTR = 'data-recued-automation-state';
export const AUTOMATION_ROUTE_ERROR_ATTR = 'data-recued-automation-error';
export const AUTOMATION_ROUTE_EMPTY_ATTR = 'data-recued-automation-empty';
/** R21 — one sub-nav tab per section. Value = the section HASH token
 *  (`auto-run` / `triggers` / `schedules`); `data-active` marks the
 *  visible one. */
export const AUTOMATION_ROUTE_SUBNAV_ATTR = 'data-recued-automation-subnav';
/** R21 — a trigger row's inline backing-poll status line. Value = the
 *  backing `watch_key`. */
export const AUTOMATION_ROUTE_POLL_ATTR = 'data-recued-automation-poll';
/** R21 — a section's "Add" (create) disclosure button. Value = the
 *  section hash token (`triggers` / `schedules`). */
export const AUTOMATION_ROUTE_ADD_ATTR = 'data-recued-automation-add';
/** D-215 slice 4 — a subordinate managed dish's link to the rule that owns
 *  its lifecycle. Value = the owning rule id. */
export const DISH_OWNER_LINK_ATTR = 'data-recued-dish-owner-link';
/** D-215 slice 4b — the inline rename box on a dish row. Value = dish_id. */
export const DISH_RENAME_INPUT_ATTR = 'data-recued-dish-rename';
/** D-215 slice 5 — the dish detail's run-history list. Value = dish_id. */
export const DISH_HISTORY_ATTR = 'data-recued-dish-history';
/** D-215 slice 5 — the RETIRED-dish notice (history without a dish row). */
export const DISH_RETIRED_ATTR = 'data-recued-dish-retired';
/** R21 — the status filter select (armed/paused/tripped). */
export const AUTOMATION_ROUTE_STATUS_FILTER_ATTR =
  'data-recued-automation-status-filter';
/** R21 — the origin filter select (manual/from-recipe; Triggers only). */
export const AUTOMATION_ROUTE_ORIGIN_FILTER_ATTR =
  'data-recued-automation-origin-filter';

/** R21 status filter — matches the row's derived ArmedState ('on' =
 *  armed, 'off' = paused, 'tripped' = auto-disabled). Pack filter is
 *  DEFERRED: rule rows carry no pack provenance today (recipe.list
 *  entries would need the install's pack id threaded through). */
export type AutomationStatusFilter = 'all' | 'on' | 'off' | 'tripped';
export type AutomationOriginFilter = 'all' | 'user' | 'recipe';

const ACTION_ATTR = 'data-recued-automation-action';
const ROW_ID_ATTR = 'data-rule-id';

/** Action namespaces for the delegated click handler. `watch` is no
 *  longer a rendered SECTION (R21 dissolved it into the Triggers view)
 *  but stays an action namespace — inline poll-status controls and the
 *  residual poll-loop rows still route their mutations through it. */
export type AutomationSectionKind =
  | 'schedule'
  | 'event_trigger'
  | 'watch'
  | 'auto_run'
  /** D-215 slice 3 — the dish rows. Read-only in this slice (no toggle,
   *  no remove); slice 4 wires the mutations onto the same namespace. */
  | 'dish';

/** R21 — the three rendered sections, as their HASH tokens (the
 *  `#automation/<section>` segment; R16 deep-link pattern). */
export type AutomationSectionToken =
  | 'auto-run' | 'triggers' | 'schedules'
  /** D-215 slice 3 — the cross-recipe dish aggregate. */
  | 'dishes';
export const AUTOMATION_SECTION_TOKENS: readonly AutomationSectionToken[] = [
  'auto-run',
  'triggers',
  'schedules',
  'dishes',
];
export const isAutomationSectionToken = (
  v: string,
): v is AutomationSectionToken =>
  (AUTOMATION_SECTION_TOKENS as readonly string[]).includes(v);

export type SchedulesListCaller = () => Promise<{ schedules: ServerSchedule[] }>;
export type SchedulesUpdateCaller = (args: {
  schedule_id: string;
  enabled?: boolean;
  /** D-215 slice 4b — the rpc has always accepted this; the caller type
   *  simply never exposed it. A one-shot dish's config edit lands here
   *  (the immutable reconcile: a changed overlay mints a new dish and
   *  dissolves the prior), because `dishes.update` on a managed dish is
   *  refused by the slice-0 guard. */
  config_overlay?: Record<string, unknown>;
}) => Promise<{ schedule: ServerSchedule }>;
export type SchedulesDeleteCaller = (args: {
  schedule_id: string;
}) => Promise<{ deleted: true }>;
export type TriggersListCaller = () => Promise<{ triggers: EventTrigger[] }>;
export type TriggersUpdateCaller = (args: {
  trigger_id: string;
  enabled?: boolean;
}) => Promise<{ trigger: EventTrigger }>;
export type TriggersDeleteCaller = (args: {
  trigger_id: string;
}) => Promise<{ ok: true }>;
export type AutoRunListCaller = () => Promise<{ entries: AutoRunStatusEntry[] }>;
export type AutoRunUpdateCaller = (args: {
  recipe_id: string;
  enabled?: boolean;
  /** D-179 — the config the recipe's headless fires use. Provided ⇒ the
   *  server versions it on a managed immutable dish (new dish per change,
   *  superseded one dissolved). `{}` clears it. */
  config_overlay?: Record<string, unknown>;
}) => Promise<{ entry: AutoRunStatusEntry }>;
export type WatchListCaller = () => Promise<{
  watches: WatchStatusEntry[];
  /** WatchSource push-source governance rows. Optional on the wire so
   *  the route tolerates a pre-generalization server. */
  sources?: WatchSourceStatusEntry[];
}>;
export type WatchUpdateCaller = (args: {
  watch_key: string;
  enabled: boolean;
}) => Promise<{ entry: WatchStatusEntry }>;
/** Run-Now — polls the key immediately; resolves once the poll lands
 *  so the follow-up re-list shows the fresh `last_poll_at`. */
export type WatchRunNowCaller = (args: {
  watch_key: string;
}) => Promise<{ entry: WatchStatusEntry }>;
/** Optional recipe-name resolution — maps recipe ids on schedule /
 *  trigger rows to display names. Soft-enhancement: absent or failed,
 *  rows render the raw recipe id. */
export type RecipeNamesCaller = () => Promise<{
  recipes: ReadonlyArray<{ recipe_id: string; name?: string }>;
}>;
/** Vault lock-state reader (`auth.state`). R21.1 — autonomous execution
 *  (schedules / triggers / auto-run / watches / housekeeping) is paused
 *  while the vault is sealed, so the route surfaces a banner when state
 *  is not `'unlocked'`. Soft-enhancement: absent or failed, no banner. */
export type AuthStateCaller = () => Promise<{
  state: 'uninitialized' | 'locked' | 'unlocked';
}>;

export interface BootstrapAutomationRouteOptions {
  root: HTMLElement;
  document?: Document;
  schedulesListCaller?: SchedulesListCaller;
  schedulesUpdateCaller?: SchedulesUpdateCaller;
  schedulesDeleteCaller?: SchedulesDeleteCaller;
  triggersListCaller?: TriggersListCaller;
  triggersUpdateCaller?: TriggersUpdateCaller;
  triggersDeleteCaller?: TriggersDeleteCaller;
  autoRunListCaller?: AutoRunListCaller;
  autoRunUpdateCaller?: AutoRunUpdateCaller;
  watchListCaller?: WatchListCaller;
  watchUpdateCaller?: WatchUpdateCaller;
  watchRunNowCaller?: WatchRunNowCaller;
  recipeNamesCaller?: RecipeNamesCaller;
  authStateCaller?: AuthStateCaller;
  // ── R21 create path — per-section "Add" → recipe picker → the shared
  // run-modal on the Schedule|Trigger tab. All optional: a host without
  // them renders no Add affordance (management-only parity). ──
  /** Full `recipe.list` entries (the modal needs the recipe body for
   *  widgets/targeting). Absent → no Add affordance. */
  recipeEntriesCaller?: () => Promise<{ recipes: ServerRecipeListEntry[] }>;
  /** D-215 slice 3 — `dishes.list`. Absent ⇒ the Dishes section renders
   *  its "not wired" error line; every other section is unaffected. */
  dishesListCaller?: DishesListCaller;
  /** D-215 slice 4 — absent ⇒ the dish rows stay read-only. */
  dishesUpdateCaller?: DishesUpdateCaller;
  dishesDeleteCaller?: DishesDeleteCaller;
  /** D-215 slice 4b — `dishes.create`, for a STANDALONE (scheduleless) dish. */
  dishesCreateCaller?: DishesCreateCaller;
  /** D-215 slice 5 — absent ⇒ a dish detail shows no history block. */
  dishesHistoryCaller?: DishesHistoryCaller;
  /** `schedules.create` — the modal's Add-schedule. */
  schedulesCreateCaller?: RunModal.RunModalSchedulesCreateCaller;
  /** `triggers.create` — the modal's Add-trigger. */
  triggersCreateCaller?: RunModal.RunModalTriggersCreateCaller;
  /** D-200 — owner-file inventory for `file_ref` config fields. */
  fileRefSearchCaller?: RefPicker.RefPickerSearchCaller;
  /** R21 — `#automation/<section>` deep-link: which of the three
   *  sections opens. Absent → `auto-run` (the first). */
  initialSection?: AutomationSectionToken;
  /** R21 — `#automation/<section>/<id>` deep-link: one rule's detail
   *  within `initialSection`. */
  initialDetailId?: string;
  /** Called with the new `#automation/...` hash AFTER a successful in-page
   *  `replaceState`. The shell router uses it to keep its cached
   *  `activeHash` in lockstep, so a later hashchange BACK to a previously
   *  shown hash isn't dropped as a same-hash no-op (the packs R22 fix —
   *  codex R21 MEDIUM; recipes/data share the gap, uniform shell fix is a
   *  separate follow-up). */
  onHashSync?: (hash: string) => void;
  /** LEGACY `#automation/<recipe-id>` deep-link (the Recipes R24 detail
   *  links here) — narrow the view to one recipe's rules. The bootstrap
   *  routes a non-section first segment into this. After the initial
   *  load, the view one-shot auto-picks the first section that has rows
   *  for the recipe (a recipe with only a schedule shouldn't land on an
   *  empty Auto-run tab). Clearing the picker (×) shows everything. */
  initialRecipeFilter?: string;
  now?: () => number;
  subscribe?: BroadcastSubscriber['on'];
}

/** D-215 slice 3 — `dishes.list`, including the slice-3 last-outcome map. */
export type DishesListCaller = () => Promise<{
  dishes: Dish[];
  last_runs?: Record<string, DishLastRun>;
}>;

/** D-215 slice 4 — dish mutations. Both optional: a host without them
 *  renders the section read-only (slice 3's shape) rather than dead
 *  buttons. */
export type DishesUpdateCaller = (args: {
  dish_id: string;
  name?: string;
  enabled?: boolean;
  config_overlay?: Record<string, unknown>;
}) => Promise<{ dish: Dish }>;
export type DishesDeleteCaller = (args: {
  dish_id: string;
}) => Promise<{ deleted: true }>;
/** D-215 slice 5 — `dishes.history`. */
export type DishesHistoryCaller = (args: {
  dish_id: string;
  limit?: number;
}) => Promise<{ runs: DishRunRow[] }>;
export type DishesCreateCaller = (args: {
  recipe_id: string;
  name?: string;
}) => Promise<{ dish: Dish }>;

export interface AutomationLoadErrors {
  /** D-215 slice 3. */
  dishes?: string;
  schedules?: string;
  triggers?: string;
  watches?: string;
  auto_run?: string;
}

export interface AutomationRoute {
  getSchedules(): ReadonlyArray<ServerSchedule>;
  getTriggers(): ReadonlyArray<EventTrigger>;
  getWatches(): ReadonlyArray<WatchStatusEntry>;
  getAutoRun(): ReadonlyArray<AutoRunStatusEntry>;
  /** R21 — the visible section (hash token). */
  getActiveSection(): AutomationSectionToken;
  /** R21 — the open rule detail's id, or null on the section list. */
  getDetailId(): string | null;
  /** The active recipe-focus id, or null when the full view shows. */
  getRecipeFilter(): string | null;
  getLoadErrors(): AutomationLoadErrors;
  /** Failed pause/resume/remove actions, keyed like load errors but
   *  kept SEPARATE so the post-mutation re-list can't wash a failure
   *  away (codex MEDIUM fold). Cleared per section on the next
   *  successful mutation in that section. */
  getMutationErrors(): AutomationLoadErrors;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

const AUTOMATION_ROUTE_STYLES = `
[${AUTOMATION_ROUTE_HOST_ATTR}] {
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-header {
  margin-bottom: 16px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-subtitle {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 16px;
  max-width: 760px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-filter > .ref-picker {
  flex: 1 1 240px;
  min-width: 220px;
  max-width: 360px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-filter-label {
  flex: none;
  font-size: 13px;
  color: var(--muted);
}
[${AUTOMATION_ROUTE_SECTION_ATTR}] {
  margin-bottom: 22px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-section-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 650;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-section-hint {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 12px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${AUTOMATION_ROUTE_ROW_ATTR}] {
  border: 1px solid var(--border);
  border-left: 2px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
}
[${AUTOMATION_ROUTE_ROW_ATTR}][data-armed="off"] {
  opacity: .72;
}
[${AUTOMATION_ROUTE_ROW_ATTR}][data-armed="tripped"] {
  border-left-color: var(--danger);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-detail,
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 5px;
  color: var(--muted);
  font-size: 12px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-detail code {
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_STATE_ATTR}] {
  font-weight: 650;
  font-size: 12px;
  color: var(--fg);
}
[${AUTOMATION_ROUTE_STATE_ATTR}][data-armed="tripped"],
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-error {
  color: var(--danger);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-error {
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-button {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-button--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-button:disabled {
  cursor: not-allowed;
  opacity: .65;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] a {
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
}
[${AUTOMATION_ROUTE_ERROR_ATTR}],
[${AUTOMATION_ROUTE_EMPTY_ATTR}] {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.45;
}
[${AUTOMATION_ROUTE_ERROR_ATTR}] {
  border-left: 2px solid var(--danger);
  padding-left: 8px;
  color: var(--danger);
}
[${AUTOMATION_ROUTE_EMPTY_ATTR}] {
  color: var(--muted);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-lock-banner {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  font-size: 13px;
  line-height: 1.45;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-lock-banner strong {
  color: var(--danger);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-subnav {
  display: flex;
  gap: 4px;
  margin: 12px 0 0;
  border-bottom: 1px solid var(--border);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-subnav-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fg-muted);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-subnav-tab[data-active='true'] {
  color: var(--fg);
  font-weight: 600;
  border-bottom-color: var(--accent, var(--fg));
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-subnav-count {
  font-size: 11px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-poll {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  padding: 4px 8px;
  border-left: 2px solid var(--border);
  font-size: 12px;
  color: var(--fg-muted);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-poll[data-armed='tripped'] {
  border-left-color: var(--danger);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-poll-state {
  font-weight: 600;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-poll-state[data-armed='tripped'] {
  color: var(--danger);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-button--small {
  font-size: 11px;
  padding: 1px 8px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-section-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 4px 0 8px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-add-picker {
  min-width: 260px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-filter-select {
  font-size: 12px;
  color: var(--fg);
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
}
`;

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

const messageForError = (err: unknown): string =>
  humanizeRpcError(err);

const formatDateTime = (ts: number | null | undefined): string => {
  if (ts === null || ts === undefined) return 'never';
  return formatClientDateTime(ts, { invalidText: String(ts) });
};

/** A one-shot's cron expression is only a storage compatibility detail. The
 * owner scheduled one instant, so render that intent instead of presenting it
 * as a recurring cron rule. Returns trusted markup with every value escaped. */
const scheduleCadence = (schedule: ServerSchedule): string =>
  schedule.mode === 'one_shot'
    ? `Once — ${e(formatDateTime(schedule.run_at))}`
    : `${e(describeCron(schedule.cron_expression))} <code>${e(schedule.cron_expression)}</code>`;

const formatInterval = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(ms % 3_600_000 === 0 ? 0 : 1)}h`;
};

const recipeHref = (recipe_id: string): string =>
  serializeShellRoute('recipes', recipe_id);

/** R21 sub-nav labels, in render order (treemap §4: Auto-run first). */
const SECTION_LABEL: Record<AutomationSectionToken, string> = {
  'auto-run': 'Auto-run',
  triggers: 'Triggers',
  schedules: 'Schedules',
  dishes: 'Dishes',
};

type ArmedState = 'on' | 'off' | 'tripped';

const renderRow = (args: {
  section: AutomationSectionKind;
  rule_id: string;
  title: string;
  titleHref?: string;
  armed: ArmedState;
  stateLabel: string;
  detail: string;
  meta: string[];
  error?: string | null;
  /** Omit BOTH toggle fields to render a toggle-less row (push-source
   *  rows: their enablement lives at their own config boundary, not
   *  here). */
  toggleTo?: boolean;
  toggleLabel?: string;
  canDelete: boolean;
  /** Renders a "Run now" action (`run:<section>`). Watch rows offer it
   *  while the poll loop is armed. */
  canRunNow?: boolean;
  /** R21 — renders a "Details" action (`detail:<section>`) opening the
   *  rule's `#automation/<section>/<id>` view. Rule rows only (poll
   *  loops are infra — no detail). */
  canDetail?: boolean;
  /** R21 — extra pre-built HTML after the meta/error lines (the trigger
   *  rows' inline backing-poll status). Caller-escaped. */
  extra?: string;
  busy: boolean;
}): string => {
  const metaSpans = args.meta.map((m) => `<span>${e(m)}</span>`).join('');
  const title = args.titleHref
    ? `<a href="${e(args.titleHref)}">${e(args.title)}</a>`
    : e(args.title);
  return `
    <li ${AUTOMATION_ROUTE_ROW_ATTR}="${e(`${args.section}:${args.rule_id}`)}" data-armed="${args.armed}">
      <div>
        <p class="automation-row-title">${title}</p>
        <div class="automation-row-detail">${args.detail}</div>
        <div class="automation-row-meta">
          <span ${AUTOMATION_ROUTE_STATE_ATTR} data-armed="${args.armed}">${e(args.stateLabel)}</span>
          ${metaSpans}
        </div>
        ${args.error ? `<div class="automation-row-meta"><span class="automation-row-error">${e(args.error)}</span></div>` : ''}
        ${args.extra ?? ''}
      </div>
      <div class="automation-row-actions">
        ${args.toggleLabel !== undefined
          ? `<button type="button" class="automation-button"
          ${ACTION_ATTR}="toggle:${e(args.section)}:${args.toggleTo ? 'on' : 'off'}"
          ${ROW_ID_ATTR}="${e(args.rule_id)}"${args.busy ? ' disabled' : ''}>${e(args.toggleLabel)}</button>`
          : ''}
        ${args.canRunNow
          ? `<button type="button" class="automation-button"
              ${ACTION_ATTR}="run:${e(args.section)}"
              ${ROW_ID_ATTR}="${e(args.rule_id)}"${args.busy ? ' disabled' : ''}>Run now</button>`
          : ''}
        ${args.canDelete
          ? `<button type="button" class="automation-button automation-button--danger"
              ${ACTION_ATTR}="delete:${e(args.section)}"
              ${ROW_ID_ATTR}="${e(args.rule_id)}"${args.busy ? ' disabled' : ''}>Remove</button>`
          : ''}
        ${args.canDetail
          ? `<button type="button" class="automation-button"
              ${ACTION_ATTR}="detail:${e(args.section)}"
              ${ROW_ID_ATTR}="${e(args.rule_id)}">Details</button>`
          : ''}
      </div>
    </li>
  `;
};

const renderSection = (args: {
  section: AutomationSectionKind;
  title: string;
  hint: string;
  rows: string[];
  loading: boolean;
  error: string | undefined;
  /** Failed mutation in this section — rendered ABOVE the (still
   *  valid) list instead of replacing it. */
  mutationError: string | undefined;
  emptyText: string;
  /** R21 — pre-built section-action HTML (the Add affordance). */
  actions?: string;
}): string => {
  let body: string;
  if (args.error !== undefined) {
    body = `<p ${AUTOMATION_ROUTE_ERROR_ATTR}="${args.section}">${e(args.error)}</p>`;
  } else if (args.loading && args.rows.length === 0) {
    body = `<p ${AUTOMATION_ROUTE_EMPTY_ATTR}="${args.section}">Loading...</p>`;
  } else if (args.rows.length === 0) {
    body = `<p ${AUTOMATION_ROUTE_EMPTY_ATTR}="${args.section}">${e(args.emptyText)}</p>`;
  } else {
    body = `<ul class="automation-list" role="list">${args.rows.join('')}</ul>`;
  }
  const mutationLine = args.mutationError !== undefined
    ? `<p ${AUTOMATION_ROUTE_ERROR_ATTR}="${args.section}:mutation">${e(args.mutationError)}</p>`
    : '';
  return `
    <section ${AUTOMATION_ROUTE_SECTION_ATTR}="${args.section}">
      <h2 class="automation-section-title">${e(args.title)}</h2>
      <p class="automation-section-hint">${e(args.hint)}</p>
      ${args.actions ?? ''}
      ${mutationLine}
      ${body}
    </section>
  `;
};

const targetWithAction = (ev: Event): HTMLElement | null => {
  const target = ev.target as (Element & {
    closest?: (selector: string) => Element | null;
  }) | null;
  return target?.closest?.(`[${ACTION_ATTR}]`) as HTMLElement | null;
};

export const bootstrapAutomationRoute = (
  opts: BootstrapAutomationRouteOptions,
): AutomationRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapAutomationRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (doc.head.querySelector(`style[${AUTOMATION_ROUTE_STYLES_MARKER}]`) === null) {
    const style = doc.createElement('style');
    style.setAttribute(AUTOMATION_ROUTE_STYLES_MARKER, '');
    style.textContent = [
      AUTOMATION_ROUTE_STYLES,
      RefPicker.REF_PICKER_STYLES,
    ].join('\n');
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(AUTOMATION_ROUTE_HOST_ATTR, '');
  opts.root.appendChild(routeRoot);

  let schedules: ReadonlyArray<ServerSchedule> = [];
  let triggers: ReadonlyArray<EventTrigger> = [];
  let watches: ReadonlyArray<WatchStatusEntry> = [];
  let autoRun: ReadonlyArray<AutoRunStatusEntry> = [];
  // D-215 slice 3 — the dish aggregate + its last-outcome map. `lastRuns`
  // is keyed by dish_id and a dish that has NEVER run is simply absent
  // (never present-with-nulls), so "unknown" and "never run" stay the
  // same rendering rather than becoming a false failure.
  let dishes: ReadonlyArray<Dish> = [];
  let dishLastRuns: Readonly<Record<string, DishLastRun>> = {};
  /** False until a `dishes.list` caller has actually answered — an absent
   *  caller must not render as "no dishes yet". */
  let dishesWired = false;
  /** D-215 slice 4b — the dish row currently showing its rename input, or
   *  null. Kept as state (not DOM) because the section repaints wholesale
   *  on every broadcast; an in-DOM-only edit box would vanish mid-type. */
  let renamingDishId: string | null = null;
  /** D-215 slice 5 — the open dish detail's history, keyed by dish_id so a
   *  stale response for a previously-open dish can never paint into the
   *  current one. `null` = not loaded / loading. */
  let dishHistory: { dish_id: string; runs: DishRunRow[] } | null = null;
  // R21 — the visible section. A section deep-link seeds it; a legacy
  // recipe deep-link leaves it on the default and the post-load one-shot
  // below repoints it at the first section with rows for that recipe.
  let activeSection: AutomationSectionToken = opts.initialSection ?? 'auto-run';
  /** R21 detail — the open rule id within `activeSection`, or null (list). */
  let detailId: string | null =
    opts.initialSection !== undefined && opts.initialDetailId !== undefined
    && opts.initialDetailId.length > 0
      ? opts.initialDetailId
      : null;
  // One-shot: only the LEGACY recipe deep-link auto-picks (an explicit
  // section deep-link or a user tab click must never be overridden).
  let sectionAutoPickPending =
    opts.initialSection === undefined
    && opts.initialRecipeFilter !== undefined
    && opts.initialRecipeFilter.length > 0;
  // R21.1 — vault lock state. `null` = unknown (caller absent / not yet
  // read). Drives the "automation paused — vault locked" banner.
  let vaultState: 'uninitialized' | 'locked' | 'unlocked' | null = null;
  let recipeNames = new Map<string, string>();
  // `#automation/<recipe-id>` deep-link focus, now also driven by the
  // recipe-filter combobox. Null = the full cross-pack view; a recipe id
  // narrows the recipe-bound sections and hides the global push-source
  // section. The deep-link seeds it; the picker mutates it in-memory.
  let recipeFilter: string | null =
    opts.initialRecipeFilter !== undefined && opts.initialRecipeFilter.length > 0
      ? opts.initialRecipeFilter
      : null;
  let recipePicker: RefPicker.RefPickerHandle | null = null;
  // One-shot guard: resolve a deep-link filter's label (id→name) into the
  // picker exactly once, the first time recipe names load. Re-syncing on
  // every background re-list would clobber an in-progress typed query.
  let recipeFilterLabelSynced = false;
  let errors: AutomationLoadErrors = {};
  // Failed pause/resume/remove actions — separate from load errors so
  // the post-mutation re-list can't wash a failure away (codex MEDIUM
  // fold). Cleared per section on the next successful mutation there.
  let mutationErrors: AutomationLoadErrors = {};
  let loading = false;
  let disposed = false;
  let loadSeq = 0;
  /** Rule ids with an in-flight mutation — their buttons disable. */
  const busy = new Set<string>();

  const nameFor = (recipe_id: string): string =>
    recipeNames.get(recipe_id) ?? recipe_id;

  const matchesFilter = (recipe_id: string): boolean =>
    recipeFilter === null || recipe_id === recipeFilter;

  // R21 filters — status (all sections) + origin (Triggers only).
  let statusFilter: AutomationStatusFilter = 'all';
  let originFilter: AutomationOriginFilter = 'all';
  const matchesStatus = (armed: ArmedState): boolean =>
    statusFilter === 'all' || armed === statusFilter;

  // ── Recipe filter combobox (★ ref-picker) ─────────────────────────
  // Options = the recipes that actually HAVE automation (distinct ids
  // across every section), labelled via `nameFor`. Recomputed live so it
  // tracks the loaded data; the picker filters it client-side.
  const automationRecipeOptions = (): RefPicker.RefPickerOption[] => {
    const ids = new Set<string>();
    for (const s of schedules) ids.add(s.recipe_id);
    for (const t of triggers) ids.add(t.recipe_id);
    for (const a of autoRun) ids.add(a.recipe_id);
    for (const w of watches) for (const id of w.subscriber_recipe_ids) ids.add(id);
    return [...ids]
      .map((id) => {
        const name = recipeNames.get(id);
        return name !== undefined
          ? { id, label: name, sublabel: id }
          : { id, label: id };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  const recipeSearch = (
    query: string,
  ): Promise<readonly RefPicker.RefPickerOption[]> =>
    Promise.resolve(RefPicker.filterRefOptions(automationRecipeOptions(), query));

  const resolveRecipeSelection = (): RefPicker.RefPickerSelection | null =>
    recipeFilter === null
      ? null
      : { id: recipeFilter, label: nameFor(recipeFilter) };

  // Mount once the shell first exists, then re-attach after every render.
  // onChange applies the filter IMMEDIATELY (no Apply button) — set the
  // filter + re-render the sections; `rewire()` reconciles the picker.
  const mountRecipePicker = (): void => {
    if (recipePicker === null) {
      recipePicker = RefPicker.wireRefPicker(routeRoot, {
        search: recipeSearch,
        config: RECIPE_PICKER_CONFIG,
        minChars: 0,
        initialValue: resolveRecipeSelection(),
        onChange: (selection) => {
          recipeFilter = selection?.id ?? null;
          render();
        },
      });
    } else {
      recipePicker.rewire(routeRoot);
    }
  };

  // ── R21 create path — per-section "Add" → recipe picker → the shared
  // run-modal opened on the Schedule|Trigger tab. ──
  /** Which section's Add picker is disclosed (`triggers` / `schedules`). */
  let addPickerFor: Extract<AutomationSectionToken, 'triggers' | 'schedules' | 'dishes'> | null =
    null;
  let addPicker: RefPicker.RefPickerHandle | null = null;
  /** Full recipe entries (the modal needs the recipe body) — lazy-loaded
   *  on the first Add click. `[]` after a failed load (empty picker). */
  let recipeEntries: ServerRecipeListEntry[] | null = null;
  let openModal: RunModal.RunModalHandle | null = null;
  // D-179 — the auto-run config editor (the shared config-editor overlay).
  // Detached on close / route teardown.
  let autoRunConfigHandle: ConfigEditorOverlayHandle | null = null;

  const canCreate = (
    section: Extract<AutomationSectionToken, 'triggers' | 'schedules' | 'dishes'>,
  ): boolean =>
    opts.recipeEntriesCaller !== undefined
    && (section === 'schedules'
      ? opts.schedulesCreateCaller !== undefined
      : section === 'dishes'
        // D-215 slice 4b — a STANDALONE dish: assigned to a recipe with no
        // schedule and no trigger. This is the only path that mints a dish
        // the owner owns outright; every other dish on this surface was
        // auto-minted BY a rule and is managed by it.
        ? opts.dishesCreateCaller !== undefined
        : opts.triggersCreateCaller !== undefined);

  const loadRecipeEntries = async (): Promise<void> => {
    if (recipeEntries !== null || opts.recipeEntriesCaller === undefined) return;
    try {
      const { recipes } = await opts.recipeEntriesCaller();
      if (disposed) return;
      recipeEntries = recipes;
    } catch {
      if (disposed) return;
      recipeEntries = [];
    }
    // Repaint if the Add picker is still disclosed — its first search may
    // have run against the not-yet-loaded (empty) list and shown a false
    // "no recipes match" (codex R21 LOW); the rewire re-searches.
    //
    // D-215 slice 4b — ALSO repaint for the Dishes section, which reads
    // these entries to decide whether a row offers Config (the recipe
    // declares the variables; the dish only stores values). Without this
    // the button appeared only after some unrelated repaint — the load
    // populated the list and nothing asked for a new paint.
    if (addPickerFor !== null || activeSection === 'dishes') render();
  };

  const allRecipeOptions = (): RefPicker.RefPickerOption[] =>
    (recipeEntries ?? [])
      .map((entry) => {
        const name = entry.recipe.metadata?.name?.trim();
        return name !== undefined && name.length > 0
          ? { id: entry.recipe_id, label: name, sublabel: entry.recipe_id }
          : { id: entry.recipe_id, label: entry.recipe_id };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

  const addRecipeSearch = (
    query: string,
  ): Promise<readonly RefPicker.RefPickerOption[]> =>
    Promise.resolve(RefPicker.filterRefOptions(allRecipeOptions(), query));

  const openCreateModal = (
    entry: ServerRecipeListEntry,
    tab: 'schedule' | 'trigger',
  ): void => {
    openModal?.destroy();
    const handle = RunModal.wireRunModal({
      recipe: entry,
      document: doc,
      initialTab: tab,
      ...(opts.schedulesListCaller !== undefined
        ? { schedulesList: opts.schedulesListCaller }
        : {}),
      ...(opts.schedulesCreateCaller !== undefined
        ? { schedulesCreate: opts.schedulesCreateCaller }
        : {}),
      ...(opts.schedulesUpdateCaller !== undefined
        ? { schedulesUpdate: opts.schedulesUpdateCaller }
        : {}),
      ...(opts.schedulesDeleteCaller !== undefined
        ? { schedulesDelete: opts.schedulesDeleteCaller }
        : {}),
      ...(opts.triggersListCaller !== undefined
        ? { triggersList: opts.triggersListCaller }
        : {}),
      ...(opts.triggersCreateCaller !== undefined
        ? { triggersCreate: opts.triggersCreateCaller }
        : {}),
      ...(opts.fileRefSearchCaller !== undefined
        ? { fileRefSearch: opts.fileRefSearchCaller }
        : {}),
      ...(opts.triggersUpdateCaller !== undefined
        ? { triggersUpdate: opts.triggersUpdateCaller }
        : {}),
      ...(opts.triggersDeleteCaller !== undefined
        ? { triggersDelete: opts.triggersDeleteCaller }
        : {}),
      onClose: () => {
        openModal?.destroy();
        openModal = null;
        // The modal mutates rules — re-list so the section reflects them.
        void loadAll();
      },
    });
    openModal = handle;
    doc.body.appendChild(handle.element);
  };

  /** (Re-)attach the Add recipe picker after a paint, mirroring
   *  `mountRecipePicker`; torn down whenever the disclosure closes. */
  const mountAddPicker = (): void => {
    if (addPickerFor === null) {
      addPicker?.destroy();
      addPicker = null;
      return;
    }
    if (addPicker === null) {
      addPicker = RefPicker.wireRefPicker(routeRoot, {
        search: addRecipeSearch,
        config: ADD_PICKER_CONFIG,
        minChars: 0,
        initialValue: null,
        onChange: (selection) => {
          if (selection === null || addPickerFor === null) return;
          const entry = (recipeEntries ?? []).find(
            (r) => r.recipe_id === selection.id,
          );
          if (entry === undefined) return;
          if (addPickerFor === 'dishes') {
            addPickerFor = null;
            const create = opts.dishesCreateCaller;
            if (create !== undefined) {
              // Named after the recipe by default — the owner renames it
              // from the row. An unnamed dish would render as "Default",
              // which is the ONE name that means something else (D-179
              // fork (c): the invisible default dish).
              void runMutation(entry.recipe_id, 'dish', () =>
                create({
                  recipe_id: entry.recipe_id,
                  name: entry.recipe.metadata?.name?.trim() || entry.recipe_id,
                }));
            }
            render();
            return;
          }
          const tab = addPickerFor === 'schedules' ? 'schedule' : 'trigger';
          addPickerFor = null;
          openCreateModal(entry, tab);
          render();
        },
      });
    } else {
      addPicker.rewire(routeRoot);
    }
  };

  const isPrimaryManagedOneShot = (s: ServerSchedule): boolean =>
    s.mode === 'one_shot'
    && s.dish_id !== undefined
    && dishes.some((d) =>
      d.dish_id === s.dish_id
      && d.managed_by_schedule_id === s.schedule_id);

  const scheduleRows = (): string[] =>
    schedules
      .filter(
        (s) =>
          matchesFilter(s.recipe_id)
          && matchesStatus(s.enabled ? 'on' : 'off')
          // A one-shot managed dish is the pending act's primary row. Showing
          // its backing schedule as a second row presents one act twice and
          // gives the owner two competing lifecycle controls.
          && !isPrimaryManagedOneShot(s),
      )
      .map((s) => {
      const armed: ArmedState = s.enabled ? 'on' : 'off';
      return renderRow({
        section: 'schedule',
        rule_id: s.schedule_id,
        title: nameFor(s.recipe_id),
        titleHref: recipeHref(s.recipe_id),
        armed,
        stateLabel: s.enabled ? 'On' : 'Paused',
        detail: `<span>${scheduleCadence(s)}</span>`,
        meta: [
          `next ${s.enabled ? formatDateTime(s.next_run_at) : '—'}`,
          `last ${formatDateTime(s.last_run_at)}${s.last_status ? ` (${s.last_status})` : ''}`,
        ],
        error: s.last_error,
        toggleTo: !s.enabled,
        toggleLabel: s.enabled ? 'Pause' : 'Resume',
        canDelete: true,
        canDetail: true,
        busy: busy.has(s.schedule_id),
      });
    });

  /** D-215 slice 3 — where a MANAGED dish's lifecycle actually lives.
   *  Ruling (a): managed dishes are VISIBLE and badged, but their edit /
   *  enable / remove actions belong to the owning row, never to the dish
   *  (D-179 versions a managed dish immutably — one `dish_id` = one
   *  config — so mutating it here would break that silently). */
  const dishOrigin = (d: Dish): { label: string; badge: string } => {
    if (d.managed_by_schedule_id !== undefined) {
      return { label: `Schedule ${d.managed_by_schedule_id}`, badge: 'schedule' };
    }
    if (d.managed_by_trigger_id !== undefined) {
      return { label: `Trigger ${d.managed_by_trigger_id}`, badge: 'trigger' };
    }
    if (d.managed_by_auto_run !== undefined) {
      return { label: 'Auto-run', badge: 'auto-run' };
    }
    return { label: 'Assigned', badge: 'assigned' };
  };

  /** A dish's display name. The DEFAULT dish carries `name: ''` and renders
   *  under its recipe's own name (D-179 fork (c): the default dish only
   *  surfaces once a second dish exists, and never invents a label). */
  const dishTitle = (d: Dish): string =>
    d.name !== '' ? d.name : nameFor(d.recipe_id);

  /** D-215 slice 4 — WHERE a dish's mutations go.
   *
   *  Three cases, and the middle one is the § 3 exception:
   *
   *   `own`      — a user-assigned dish. Its own `dishes.*` rpcs.
   *   `one_shot` — a dish minted by a ONE-SHOT schedule. Edits INLINE (no
   *                bouncing to a rule that exists only to hold it: one row,
   *                one dish, one pending act, all 1:1) but the writes go to
   *                `schedules.*`, NOT `dishes.*`. That is not a workaround —
   *                it is the sanctioned path: `schedules.update` runs the
   *                immutable reconcile (a changed overlay MINTS a new dish
   *                and dissolves the prior), and `schedules.delete` retires
   *                the pair. Writing `dishes.update` here would be refused
   *                by the slice-0 guard, correctly.
   *   `owner`    — every other managed dish. It is subordinate to a STANDING
   *                rule that outlives any single fire, so the row offers a
   *                link to that rule instead of inline actions.
   */
  const dishWriteTarget = (
    d: Dish,
  ): { kind: 'own' } | { kind: 'one_shot'; schedule_id: string } | { kind: 'owner'; token: AutomationSectionToken; id: string } => {
    if (d.managed_by_schedule_id !== undefined) {
      const owning = schedules.find((x) => x.schedule_id === d.managed_by_schedule_id);
      if (owning?.mode === 'one_shot') {
        return { kind: 'one_shot', schedule_id: d.managed_by_schedule_id };
      }
      return { kind: 'owner', token: 'schedules', id: d.managed_by_schedule_id };
    }
    if (d.managed_by_trigger_id !== undefined) {
      return { kind: 'owner', token: 'triggers', id: d.managed_by_trigger_id };
    }
    if (d.managed_by_auto_run !== undefined) {
      return { kind: 'owner', token: 'auto-run', id: d.managed_by_auto_run };
    }
    return { kind: 'own' };
  };

  /** D-215 slice 4b — a dish row's trailing affordances.
   *
   *  Composed, NOT nested. An earlier nesting hung Rename inside the
   *  `canConfigure` branch, so a recipe declaring no variables silently
   *  lost its Rename button — the two are independent and now read that
   *  way. Rename is offered on a MANAGED dish too: `name` is a label, it
   *  changes no resolution, and the slice-0 guard leaves it writable on
   *  purpose (only `config_overlay` / `enabled` / `group_id` are frozen). */
  /** D-215 slice 5 — load the open dish's history. Fire-and-forget with a
   *  key check on paint: the detail can change while this is in flight. */
  const loadDishHistory = async (dish_id: string): Promise<void> => {
    const caller = opts.dishesHistoryCaller;
    if (caller === undefined) return;
    try {
      const { runs } = await caller({ dish_id });
      if (disposed || detailId !== dish_id || activeSection !== 'dishes') return;
      dishHistory = { dish_id, runs };
    } catch {
      if (disposed || detailId !== dish_id) return;
      dishHistory = { dish_id, runs: [] };
    }
    render();
  };

  const dishRowExtra = (
    d: Dish,
    ctx: {
      canConfigure: boolean;
      canRename: boolean;
      renaming: boolean;
      target: ReturnType<typeof dishWriteTarget>;
      origin: { label: string; badge: string };
    },
  ): string => {
    if (ctx.renaming) {
      return `<div class="automation-row-actions">
        <input type="text" class="automation-input"
          ${DISH_RENAME_INPUT_ATTR}="${e(d.dish_id)}"
          value="${e(d.name)}" aria-label="Rename dish" />
        <button type="button" class="automation-button"
          ${ACTION_ATTR}="rename-save:dish" ${ROW_ID_ATTR}="${e(d.dish_id)}">Save name</button>
        <button type="button" class="automation-button"
          ${ACTION_ATTR}="rename-cancel:dish" ${ROW_ID_ATTR}="${e(d.dish_id)}">Cancel</button>
      </div>`;
    }
    const disabled = busy.has(d.dish_id) ? ' disabled' : '';
    const parts = [
      ctx.canConfigure
        ? `<button type="button" class="automation-button"
             ${ACTION_ATTR}="configure:dish" ${ROW_ID_ATTR}="${e(d.dish_id)}"${disabled}>Config</button>`
        : '',
      ctx.canRename
        ? `<button type="button" class="automation-button"
             ${ACTION_ATTR}="rename:dish" ${ROW_ID_ATTR}="${e(d.dish_id)}"${disabled}>Rename</button>`
        : '',
      ctx.target.kind === 'owner'
        ? `<a class="recipes-inline-link"
             href="${e(serializeShellRoute('automation', ctx.target.token, ctx.target.id))}"
             ${DISH_OWNER_LINK_ATTR}="${e(ctx.target.id)}"
             >Manage on its ${e(ctx.origin.badge)} →</a>`
        : '',
    ].filter((x) => x !== '');
    return parts.length === 0
      ? ''
      : `<div class="automation-row-actions">${parts.join('')}</div>`;
  };

  const dishRows = (): string[] =>
    dishes
      .filter(
        (d) =>
          matchesFilter(d.recipe_id) && matchesStatus(d.enabled ? 'on' : 'off'),
      )
      .map((d) => {
        const origin = dishOrigin(d);
        const last = dishLastRuns[d.dish_id];
        const overlayKeys = Object.keys(d.config_overlay).length;
        const target = dishWriteTarget(d);
        // A row is actionable only when the rpcs it would need are wired.
        const canWriteOwn = target.kind === 'own' && opts.dishesUpdateCaller !== undefined;
        const canWriteOneShot =
          target.kind === 'one_shot' && opts.schedulesUpdateCaller !== undefined;
        const actionable = canWriteOwn || canWriteOneShot;
        const canConfigure =
          actionable
          && (recipeEntries ?? []).some(
            (r) => r.recipe_id === d.recipe_id
              && Object.keys(r.recipe.variables ?? {}).length > 0,
          );
        // ⚠ Rename is allowed on a MANAGED dish too — `name` is a label, it
        // changes no resolution, and the slice-0 guard deliberately leaves
        // it writable (only config_overlay / enabled / group_id are frozen).
        // Naming the queued item is much of the point of listing it.
        const canRename = opts.dishesUpdateCaller !== undefined;
        const canRemove =
          (target.kind === 'own' && opts.dishesDeleteCaller !== undefined)
          || (target.kind === 'one_shot' && opts.schedulesDeleteCaller !== undefined);
        return renderRow({
          section: 'dish',
          rule_id: d.dish_id,
          title: dishTitle(d),
          titleHref: recipeHref(d.recipe_id),
          armed: d.enabled ? 'on' : 'off',
          stateLabel: d.enabled ? 'On' : 'Paused',
          detail: `<span data-dish-origin="${e(origin.badge)}">${e(origin.label)}</span>`,
          meta: [
            // Absent from the map = never run. Deliberately NOT "unknown":
            // the map omits a dish that has no runs, so this is a fact.
            last === undefined
              ? 'never run'
              : `last ${formatDateTime(last.started_at)} (${last.commit_status})`,
            overlayKeys === 0 ? 'recipe defaults' : `${overlayKeys} config value(s)`,
          ],
          // D-215 slice 4 — a subordinate managed dish gets NO inline
          // actions; the row links to the rule that owns its lifecycle.
          ...(actionable
            ? { toggleTo: !d.enabled, toggleLabel: d.enabled ? 'Pause' : 'Resume' }
            : {}),
          canDelete: canRemove,
          canDetail: true,
          extra: dishRowExtra(d, {
            canConfigure, canRename, target, origin,
            renaming: renamingDishId === d.dish_id,
          }),
          busy: busy.has(d.dish_id),
        });
      });

  /** The Triggers section's row predicate — shared with the residual
   *  claimed-set so a FILTERED-OUT trigger row can never claim its watch
   *  (codex R21 MEDIUM: a paused trigger claiming a tripped poll loop
   *  made the loop invisible under Status = Tripped). */
  const triggerVisible = (t: EventTrigger): boolean =>
    matchesFilter(t.recipe_id)
    && matchesStatus(t.enabled ? 'on' : t.last_error ? 'tripped' : 'off')
    && (originFilter === 'all' || t.origin === originFilter);

  const triggerRows = (): string[] =>
    triggers
      .filter(triggerVisible)
      .map((t) => {
      const armed: ArmedState = t.enabled
        ? 'on'
        : t.last_error
          ? 'tripped'
          : 'off';
      const fromRecipe = t.origin === 'recipe';
      return renderRow({
        section: 'event_trigger',
        rule_id: t.trigger_id,
        title: nameFor(t.recipe_id),
        titleHref: recipeHref(t.recipe_id),
        armed,
        stateLabel: t.enabled ? 'On' : armed === 'tripped' ? 'Auto-disabled' : 'Paused',
        detail: `<span>on <code>${e(t.pattern)}</code></span>`,
        meta: [
          `last fired ${formatDateTime(t.last_fired_at)}`,
          // G6 — declarative rows are reconciler-managed: badge the
          // provenance and (below) hide Remove, since the reconciler
          // would re-create a deleted row; Pause is the gesture that
          // sticks.
          ...(fromRecipe ? ['from recipe'] : []),
          // Authoring sugar — surface the compiled dispatch filter so
          // governance reads WHAT narrows a row, not just its pattern.
          ...(t.fields && t.fields.length > 0 ? [`when ${t.fields.join(' / ')} changes`] : []),
          ...(t.filter && Object.keys(t.filter).length > 0
            ? [Object.entries(t.filter).map(([k, v]) => `${k} = ${String(v)}`).join(', ')]
            : []),
        ],
        error: t.last_error,
        toggleTo: !t.enabled,
        toggleLabel: t.enabled ? 'Pause' : 'Resume',
        canDelete: !fromRecipe,
        // R21 — the backing poll loop's status, inline (dissolved Watches).
        extra: pollStatusBlock(t),
        canDetail: true,
        busy: busy.has(t.trigger_id),
      });
    });

  // ── R21: Watches DISSOLVED — a poll loop is runtime infra UNDER a
  // trigger, not a peer section. Each trigger row carries its backing
  // poll status INLINE; poll loops no rendered trigger row claims render
  // as a residual group after the trigger rows. Push sources (webhook /
  // messenger / reception) left this surface — their config + status
  // live at the Connection / Reception boundary (R21 lock). ──

  /** Shared watch display classification (treemap §4 status set —
   *  Covered-by-sync / Tripped / Paused / Polling / Baselining / Idle). */
  const watchDisplay = (w: WatchStatusEntry): {
    armed: ArmedState;
    stateLabel: string;
    toggleLabel: string;
  } => {
    const tripped = !w.enabled && w.consecutive_failures > 0;
    return {
      armed: w.active ? 'on' : tripped ? 'tripped' : 'off',
      stateLabel: w.deferred_to === 'reconciler'
        ? 'Covered by sync'
        : !w.enabled
          ? tripped
            ? `Tripped (${w.consecutive_failures} failures)`
            : 'Paused'
          : w.active
            ? w.baselined
              ? 'Polling'
              : 'Baselining'
            : 'Idle',
      // A tripped watch re-arms with the same "turn it on" gesture
      // (enable clears the failure counter server-side).
      toggleLabel: w.enabled ? 'Pause' : tripped ? 'Re-arm' : 'Resume',
    };
  };

  /** mcp-resource watches key `entity` to a base64url-encoded uri —
   *  decode it to a readable label. Escaped by every consumer. */
  const watchTitle = (w: WatchStatusEntry): string =>
    w.source_id === MCP_RESOURCE_POLL_SOURCE_ID
      ? `MCP resource ${decodeMcpResourceUri(w.entity) ?? w.entity} — ${w.connection_name}`
      : `${w.vendor} ${w.entity} — ${w.connection_name}`;

  /** The poll loops backing one trigger. Join = the watch's refcount
   *  (`subscriber_recipe_ids` lists the recipes whose ENABLED trigger
   *  rows demand the key), refined by the trigger's own pattern when the
   *  recipe demands several keys (the pattern names the vendor.entity —
   *  or, for mcp-resource keys, embeds the encoded entity). A pattern
   *  the refinement can't place keeps every candidate (over-showing a
   *  status line beats hiding a tripped loop). */
  /** SEGMENT-bounded containment — the needle must end at a `.` segment
   *  boundary or the end of the pattern (codex R21 MEDIUM: a bare
   *  `includes` let a `deal` watch attach to a `deal_note` trigger). */
  const patternHasSegment = (pattern: string, needle: string): boolean =>
    pattern.includes(`${needle}.`) || pattern.endsWith(needle);

  const watchesForTrigger = (t: EventTrigger): WatchStatusEntry[] => {
    const candidates = watches.filter((w) =>
      w.subscriber_recipe_ids.includes(t.recipe_id),
    );
    if (candidates.length <= 1) return candidates;
    const refined = candidates.filter(
      (w) =>
        patternHasSegment(t.pattern, `.${w.vendor}.${w.entity}`)
        || patternHasSegment(t.pattern, `.${w.entity}`),
    );
    return refined.length > 0 ? refined : candidates;
  };

  /** One trigger row's inline backing-poll status block. The controls
   *  reuse the delegated `watch` action namespace (`toggle:watch` /
   *  `run:watch` + the watch_key as rule id) — the same mutation path
   *  the old section rows used. */
  const pollStatusBlock = (t: EventTrigger): string =>
    watchesForTrigger(t)
      .map((w) => {
        const d = watchDisplay(w);
        const isBusy = busy.has(w.watch_key);
        return `
          <div class="automation-poll" ${AUTOMATION_ROUTE_POLL_ATTR}="${e(w.watch_key)}" data-armed="${d.armed}">
            <span class="automation-poll-state" data-armed="${d.armed}">${e(d.stateLabel)}</span>
            <span>${e(watchTitle(w))} · every ${e(formatInterval(w.effective_interval_ms))} · last poll ${e(formatDateTime(w.last_poll_at))}${w.last_status ? ` (${e(w.last_status)})` : ''}</span>
            ${w.last_error ? `<span class="automation-row-error">${e(w.last_error)}</span>` : ''}
            <button type="button" class="automation-button automation-button--small"
              ${ACTION_ATTR}="toggle:watch:${!w.enabled ? 'on' : 'off'}"
              ${ROW_ID_ATTR}="${e(w.watch_key)}"${isBusy ? ' disabled' : ''}>${e(d.toggleLabel)}</button>
            ${w.active && opts.watchRunNowCaller !== undefined
              ? `<button type="button" class="automation-button automation-button--small"
                  ${ACTION_ATTR}="run:watch"
                  ${ROW_ID_ATTR}="${e(w.watch_key)}"${isBusy ? ' disabled' : ''}>Run now</button>`
              : ''}
          </div>`;
      })
      .join('');

  /** Poll loops no rendered trigger row claims (e.g. every demanding
   *  trigger is paused, so the refcount dropped them) — a residual group
   *  after the trigger rows, so a tripped or still-running loop never
   *  disappears from governance view. */
  const residualWatchRows = (): string[] => {
    const claimed = new Set<string>();
    for (const t of triggers) {
      // Only a trigger row that actually RENDERS claims its watches —
      // a filtered-out row's watch falls through to the residual group
      // (where the status filter applies to the WATCH's own state).
      if (!triggerVisible(t)) continue;
      for (const w of watchesForTrigger(t)) claimed.add(w.watch_key);
    }
    return watches
      .filter(
        (w) =>
          !claimed.has(w.watch_key)
          && (recipeFilter === null
            || w.subscriber_recipe_ids.includes(recipeFilter))
          && matchesStatus(watchDisplay(w).armed),
      )
      .map((w) => {
        const d = watchDisplay(w);
        const subscribers = w.subscriber_recipe_ids
          .map((id) => `<a href="${e(recipeHref(id))}">${e(nameFor(id))}</a>`)
          .join(', ');
        return renderRow({
          section: 'watch',
          rule_id: w.watch_key,
          title: watchTitle(w),
          armed: d.armed,
          stateLabel: d.stateLabel,
          detail: `<span>poll loop · every ${e(formatInterval(w.effective_interval_ms))}</span>`
            + (subscribers.length > 0 ? `<span>for ${subscribers}</span>` : ''),
          meta: [
            `last poll ${formatDateTime(w.last_poll_at)}${w.last_status ? ` (${w.last_status})` : ''}`,
          ],
          error: w.last_error,
          toggleTo: !w.enabled,
          toggleLabel: d.toggleLabel,
          canDelete: false,
          // Run-Now only where the server would accept it (armed loop);
          // paused / deferred / idle rows keep the action hidden rather
          // than render a button that 409s.
          canRunNow: w.active && opts.watchRunNowCaller !== undefined,
          busy: busy.has(w.watch_key),
        });
      });
  };

  const autoRunRows = (): string[] =>
    autoRun
      .filter(
        (a) =>
          matchesFilter(a.recipe_id)
          && matchesStatus(!a.enabled ? 'off' : a.auto_disabled ? 'tripped' : 'on'),
      )
      .map((a) => {
      const armed: ArmedState = !a.enabled
        ? 'off'
        : a.auto_disabled
          ? 'tripped'
          : 'on';
      const stateLabel = !a.enabled
        ? 'Paused'
        : a.auto_disabled
          ? `Tripped (${a.consecutive_failures} failures)`
          : 'On';
      return renderRow({
        section: 'auto_run',
        rule_id: a.recipe_id,
        title: a.recipe_name ?? a.recipe_id,
        titleHref: recipeHref(a.recipe_id),
        armed,
        stateLabel,
        detail: `<span>every ${e(formatInterval(a.interval_ms))}${a.dynamic ? ' (dynamic)' : ''}</span>`,
        meta: [
          `next ${armed === 'on' ? formatDateTime(a.next_run_at) : '—'}`,
          `last ${formatDateTime(a.last_finished_at)}`,
        ],
        error: a.last_failure_reason,
        // A tripped circuit re-arms with the same "turn it on" gesture.
        toggleTo: !a.enabled || a.auto_disabled,
        toggleLabel: !a.enabled
          ? 'Resume'
          : a.auto_disabled
            ? 'Re-arm'
            : 'Pause',
        canDelete: false,
        canDetail: true,
        busy: busy.has(a.recipe_id),
      });
    });

  // Recipe-filter combobox — names the recipe the view is narrowed to
  // and lets the user change or clear it (× → the full cross-pack view).
  // The deep-link seeds it; the picker mutates `recipeFilter` in-memory.
  const filterBar = (): string => `
    <div class="automation-filter">
      <span class="automation-filter-label">Filter by recipe</span>
      ${RefPicker.renderRefPicker(
        RefPicker.initialRefPickerState(resolveRecipeSelection()),
        RECIPE_PICKER_CONFIG,
      )}
      <label class="automation-filter-label" for="automation-status-filter">Status</label>
      <select id="automation-status-filter" class="automation-filter-select"
        ${AUTOMATION_ROUTE_STATUS_FILTER_ATTR}>
        <option value="all"${statusFilter === 'all' ? ' selected' : ''}>All</option>
        <option value="on"${statusFilter === 'on' ? ' selected' : ''}>Armed</option>
        <option value="off"${statusFilter === 'off' ? ' selected' : ''}>Paused</option>
        <option value="tripped"${statusFilter === 'tripped' ? ' selected' : ''}>Tripped</option>
      </select>
      ${activeSection === 'triggers'
        ? `<label class="automation-filter-label" for="automation-origin-filter">Origin</label>
      <select id="automation-origin-filter" class="automation-filter-select"
        ${AUTOMATION_ROUTE_ORIGIN_FILTER_ATTR}>
        <option value="all"${originFilter === 'all' ? ' selected' : ''}>All</option>
        <option value="user"${originFilter === 'user' ? ' selected' : ''}>Manual</option>
        <option value="recipe"${originFilter === 'recipe' ? ' selected' : ''}>From recipe</option>
      </select>`
        : ''}
    </div>
  `;

  // R21.1 — the vault gates ALL autonomous execution. When it's sealed,
  // nothing on this page runs; surface that plainly so a locked vault
  // doesn't read as broken automation. Only `'locked'` banners — an
  // `'uninitialized'` server has no vault (and no automation) to pause,
  // and `'unlocked'` / unknown stay silent.
  const lockBanner = (): string =>
    vaultState === 'locked'
      ? `<div class="automation-lock-banner" role="status">
          <strong>Automation paused — vault locked.</strong>
          Schedules, event triggers, auto-run, and watches don't run while the
          vault is sealed. Unlock the vault to resume; in-flight rules pick up
          automatically.
        </div>`
      : '';

  // ── R21 sub-nav — one tab per section, count-badged once loaded.
  // Tab clicks flip `activeSection` + replaceState-sync the hash (the
  // R17/R18 idiom: addressable without a remount flash; replaceState
  // fires no hashchange, so the shell's remount listener stays quiet).
  const sectionCount = (token: AutomationSectionToken): number => {
    switch (token) {
      case 'auto-run':
        return autoRun.filter((a) => matchesFilter(a.recipe_id)).length;
      case 'triggers':
        return triggers.filter((t) => matchesFilter(t.recipe_id)).length;
      case 'schedules':
        return schedules.filter((s) =>
          matchesFilter(s.recipe_id) && !isPrimaryManagedOneShot(s)).length;
      case 'dishes':
        return dishes.filter((d) => matchesFilter(d.recipe_id)).length;
    }
  };

  const syncHash = (): void => {
    try {
      const hash = serializeShellRoute('automation', activeSection, detailId);
      const history = (globalThis as {
        history?: { replaceState?: (d: unknown, t: string, url: string) => void };
      }).history;
      if (history?.replaceState !== undefined) {
        history.replaceState(null, '', hash);
        // Keep the shell router's cached activeHash in lockstep (codex
        // R21 MEDIUM — without this, an external hashchange back to the
        // pre-sync hash normalize-equals the stale cache and is dropped).
        opts.onHashSync?.(hash);
      }
    } catch {
      // Non-browser hosts (tests) have no history — state alone suffices.
    }
  };

  const subNav = (): string => `
    <nav class="automation-subnav" role="tablist" aria-label="Automation sections">
      ${AUTOMATION_SECTION_TOKENS.map((token) => `
        <button type="button" class="automation-subnav-tab" role="tab"
          ${AUTOMATION_ROUTE_SUBNAV_ATTR}="${token}"
          aria-selected="${activeSection === token ? 'true' : 'false'}"
          data-active="${activeSection === token ? 'true' : 'false'}">
          ${e(SECTION_LABEL[token])}${loading ? '' : ` <span class="automation-subnav-count">${sectionCount(token)}</span>`}
        </button>`).join('')}
    </nav>
  `;

  /** The R21 per-section Add affordance (create path): a disclosure
   *  button + (open) the recipe ref-picker. Only for sections with a
   *  wired create caller; auto-run has no create (a recipe DECLARES
   *  auto_run — arming is the row toggle). */
  const sectionActions = (
    section: Extract<AutomationSectionToken, 'triggers' | 'schedules' | 'dishes'>,
  ): string => {
    if (!canCreate(section)) return '';
    const open = addPickerFor === section;
    return `
      <div class="automation-section-actions">
        <button type="button" class="automation-button"
          ${AUTOMATION_ROUTE_ADD_ATTR}="${section}"
          aria-expanded="${open ? 'true' : 'false'}">
          ${section === 'schedules' ? 'Add schedule'
            : section === 'dishes' ? 'Add dish'
            : 'Add trigger'}
        </button>
        ${open
          ? `<div class="automation-add-picker">${RefPicker.renderRefPicker(
              RefPicker.initialRefPickerState(null),
              ADD_PICKER_CONFIG,
            )}</div>`
          : ''}
      </div>`;
  };

  const activeSectionHtml = (): string => {
    const filtered = recipeFilter !== null;
    switch (activeSection) {
      case 'auto-run':
        return renderSection({
          section: 'auto_run',
          title: 'Auto-run',
          hint: 'Reactive recipes that tick on their own interval and decide each time whether to act.',
          rows: autoRunRows(),
          loading,
          error: errors.auto_run,
          mutationError: mutationErrors.auto_run,
          emptyText: filtered
            ? 'This recipe has no auto-run ticker.'
            : 'No auto-run recipes installed.',
        });
      case 'dishes':
        return renderSection({
          section: 'dish',
          title: 'Dishes',
          hint: 'Every standing instance of a recipe — what is queued, what config it '
            + 'carries, and when it last ran. A dish minted BY a schedule / trigger / '
            + 'auto-run is badged with its owner; change it on that row, not here.',
          rows: dishRows(),
          actions: sectionActions('dishes'),
          loading,
          error: errors.dishes,
          mutationError: mutationErrors.dishes,
          emptyText: !dishesWired
            ? 'Dishes are not available on this server yet.'
            : filtered
              ? 'This recipe has no dishes yet.'
              : 'No dishes yet — assigning a recipe to a schedule or trigger mints one.',
        });
      case 'triggers':
        return renderSection({
          section: 'event_trigger',
          title: 'Triggers',
          hint: 'Recipes that fire when warehouse data changes (mail, calendar, files, '
            + 'contacts). Each row carries the poll loop feeding it, when one does — '
            + 'vendors with a built-in sync are covered by it instead.',
          // R21: the residual poll loops (no rendered trigger row claims
          // them) follow the trigger rows so a tripped loop stays visible.
          rows: [...triggerRows(), ...residualWatchRows()],
          loading,
          error: errors.triggers ?? errors.watches,
          mutationError: mutationErrors.triggers ?? mutationErrors.watches,
          emptyText: filtered
            ? 'No event triggers for this recipe.'
            : 'No event triggers yet. Add one, or attach one from a recipe in the Recipes library.',
          actions: sectionActions('triggers'),
        });
      case 'schedules':
        return renderSection({
          section: 'schedule',
          title: 'Schedules',
          hint: 'Recurring recipes and pending one-time runs.',
          rows: scheduleRows(),
          loading,
          error: errors.schedules,
          mutationError: mutationErrors.schedules,
          emptyText: filtered
            ? 'No schedules for this recipe.'
            : 'No schedules yet. Add one, or from a recipe in the Recipes library.',
          actions: sectionActions('schedules'),
        });
    }
  };

  // ── R21 detail — `#automation/<section>/<id>`: one rule's facts +
  // the SAME action machinery (toggle/re-arm/remove buttons carry the
  // section+id, so the delegated handler and post-mutation re-list work
  // unchanged; the detail re-renders with fresh data). No new rpc — the
  // list entries carry everything shown; full run history lives in Logs.
  const renderDetail = (): string => {
    const back = `<button type="button" class="automation-button"
      data-recued-automation-back>Back to ${e(SECTION_LABEL[activeSection])}</button>`;
    const facts = (pairs: Array<[string, string]>): string =>
      `<dl class="automation-detail-facts">${pairs
        .map(([k, v]) => `<dt>${e(k)}</dt><dd>${v}</dd>`)
        .join('')}</dl>`;
    let body: string | null = null;
    if (activeSection === 'schedules') {
      const s = schedules.find((x) => x.schedule_id === detailId);
      if (s !== undefined) {
        body = `
          <h2 class="automation-section-title"><a href="${e(recipeHref(s.recipe_id))}">${e(nameFor(s.recipe_id))}</a></h2>
          ${facts([
            ['Cadence', scheduleCadence(s)],
            ['State', e(s.enabled ? 'On' : 'Paused')],
            ['Next run', e(s.enabled ? formatDateTime(s.next_run_at) : '—')],
            ['Last run', e(`${formatDateTime(s.last_run_at)}${s.last_status ? ` (${s.last_status})` : ''}`)],
          ])}
          ${s.last_error ? `<p class="automation-row-error">${e(s.last_error)}</p>` : ''}
          <div class="automation-row-actions">
            <button type="button" class="automation-button" ${ACTION_ATTR}="toggle:schedule:${!s.enabled ? 'on' : 'off'}" ${ROW_ID_ATTR}="${e(s.schedule_id)}"${busy.has(s.schedule_id) ? ' disabled' : ''}>${s.enabled ? 'Pause' : 'Resume'}</button>
            <button type="button" class="automation-button automation-button--danger" ${ACTION_ATTR}="delete:schedule" ${ROW_ID_ATTR}="${e(s.schedule_id)}"${busy.has(s.schedule_id) ? ' disabled' : ''}>Remove</button>
          </div>`;
      }
    } else if (activeSection === 'dishes' && detailId !== null) {
      const d = dishes.find((x) => x.dish_id === detailId);
      const runs = dishHistory?.dish_id === detailId ? dishHistory.runs : null;
      const historyBlock = opts.dishesHistoryCaller === undefined
        ? ''
        : runs === null
          ? '<p class="automation-empty">Loading history…</p>'
          : runs.length === 0
            ? '<p class="automation-empty">No runs recorded for this dish.</p>'
            : `<ul class="automation-rows" ${DISH_HISTORY_ATTR}="${e(detailId)}">${runs
                .map((r) => `<li data-run-status="${e(r.commit_status)}">
                  <div><p class="automation-row-title">${e(formatDateTime(r.started_at))}</p>
                  <div class="automation-row-meta">
                    <span>${e(r.commit_status)}</span>
                    <span>${e(`${r.duration_ms}ms`)}</span>
                    ${r.trigger_source !== null ? `<span>${e(r.trigger_source)}</span>` : ''}
                  </div>
                  ${r.error !== null ? `<div class="automation-row-meta"><span class="automation-row-error">${e(r.error)}</span></div>` : ''}
                  </div></li>`)
                .join('')}</ul>`;
      if (d !== undefined) {
        const origin = dishOrigin(d);
        body = `
          <h2 class="automation-section-title"><a href="${e(recipeHref(d.recipe_id))}">${e(dishTitle(d))}</a></h2>
          ${facts([
            ['Origin', e(origin.label)],
            ['State', e(d.enabled ? 'On' : 'Paused')],
            ['Config', e(Object.keys(d.config_overlay).length === 0
              ? 'recipe defaults'
              : `${Object.keys(d.config_overlay).length} value(s)`)],
          ])}
          <h3 class="automation-section-title">History</h3>
          ${historyBlock}`;
      } else {
        // ⛔ D-215 § 9e — a RETIRED dish: its runs are in audit, its row is
        // not. Reachable without a stale bookmark — a one-shot retires
        // itself the moment it succeeds, so an open detail becomes this on
        // the very next refresh. It must read as RETIRED, never as an error
        // and never as an empty state, because the history below is real.
        body = `
          <h2 class="automation-section-title">Retired dish</h2>
          <p class="automation-detail-note" ${DISH_RETIRED_ATTR}="${e(detailId)}">
            This dish no longer exists — a one-shot retires itself once it
            succeeds, and a config change replaces the dish it versioned.
            Its run history is kept.
          </p>
          <h3 class="automation-section-title">History</h3>
          ${historyBlock}`;
      }
    } else if (activeSection === 'triggers') {
      const t = triggers.find((x) => x.trigger_id === detailId);
      if (t !== undefined) {
        const armed = t.enabled ? 'on' : t.last_error ? 'tripped' : 'off';
        body = `
          <h2 class="automation-section-title"><a href="${e(recipeHref(t.recipe_id))}">${e(nameFor(t.recipe_id))}</a></h2>
          ${facts([
            ['Pattern', `<code>${e(t.pattern)}</code>`],
            ['State', e(t.enabled ? 'On' : armed === 'tripped' ? 'Auto-disabled' : 'Paused')],
            ['Origin', e(t.origin === 'recipe' ? 'From recipe (reconciler-managed)' : 'Manual')],
            ['Last fired', e(formatDateTime(t.last_fired_at))],
            ...(t.fields && t.fields.length > 0
              ? [['Fields', e(t.fields.join(' / '))] as [string, string]]
              : []),
          ])}
          ${t.last_error ? `<p class="automation-row-error">${e(t.last_error)}</p>` : ''}
          ${pollStatusBlock(t)}
          <div class="automation-row-actions">
            <button type="button" class="automation-button" ${ACTION_ATTR}="toggle:event_trigger:${!t.enabled ? 'on' : 'off'}" ${ROW_ID_ATTR}="${e(t.trigger_id)}"${busy.has(t.trigger_id) ? ' disabled' : ''}>${t.enabled ? 'Pause' : 'Resume'}</button>
            ${t.origin === 'recipe' ? '' : `<button type="button" class="automation-button automation-button--danger" ${ACTION_ATTR}="delete:event_trigger" ${ROW_ID_ATTR}="${e(t.trigger_id)}"${busy.has(t.trigger_id) ? ' disabled' : ''}>Remove</button>`}
          </div>`;
      }
    } else {
      const a = autoRun.find((x) => x.recipe_id === detailId);
      if (a !== undefined) {
        const tripped = a.enabled && a.auto_disabled;
        body = `
          <h2 class="automation-section-title"><a href="${e(recipeHref(a.recipe_id))}">${e(a.recipe_name ?? a.recipe_id)}</a></h2>
          ${facts([
            ['Cadence', e(`every ${formatInterval(a.interval_ms)}${a.dynamic ? ' (dynamic)' : ''}`)],
            ['State', e(!a.enabled ? 'Paused' : tripped ? `Tripped (${a.consecutive_failures} failures)` : 'On')],
            ['Next run', e(a.enabled && !a.auto_disabled ? formatDateTime(a.next_run_at) : '—')],
            ['Last finished', e(formatDateTime(a.last_finished_at))],
          ])}
          ${a.last_failure_reason ? `<p class="automation-row-error">${e(a.last_failure_reason)}</p>` : ''}
          <div class="automation-row-actions">
            ${a.enabled && !a.auto_disabled && Object.keys(a.variables ?? {}).length > 0
              ? `<button type="button" class="automation-button" ${ACTION_ATTR}="configure:auto_run" ${ROW_ID_ATTR}="${e(a.recipe_id)}"${busy.has(a.recipe_id) ? ' disabled' : ''}>Configure</button>`
              : ''}
            <button type="button" class="automation-button" ${ACTION_ATTR}="toggle:auto_run:${!a.enabled || a.auto_disabled ? 'on' : 'off'}" ${ROW_ID_ATTR}="${e(a.recipe_id)}"${busy.has(a.recipe_id) ? ' disabled' : ''}>${!a.enabled ? 'Resume' : a.auto_disabled ? 'Re-arm' : 'Pause'}</button>
          </div>`;
      }
    }
    return `
      <section class="automation-detail" data-recued-automation-detail="${e(detailId ?? '')}">
        ${back}
        ${body ?? (loading
          ? '<p>Loading…</p>'
          : '<p>This rule no longer exists — it may have been removed.</p>')}
        <p class="automation-section-hint">Runs land in <a href="#logs">Logs</a>.</p>
      </section>`;
  };

  const render = (): void => {
    routeRoot.innerHTML = `
      <header class="automation-header">
        <h1 class="automation-title" ${AUTOMATION_ROUTE_HEADING_ATTR}>Automation</h1>
        <p class="automation-subtitle">Every rule that runs without you — auto-run tickers,
        event triggers (and the poll loops feeding them), and schedules. Pause or
        resume any of them here; runs land in <a href="#logs">Logs</a>.</p>
      </header>
      ${lockBanner()}
      ${subNav()}
      ${detailId !== null ? renderDetail() : `${filterBar()}${activeSectionHtml()}`}
    `;
    if (detailId === null) {
      // (Re-)attach the recipe-filter combobox to the freshly-painted shell.
      mountRecipePicker();
      // (Re-)attach / tear down the Add recipe picker (R21 create path).
      mountAddPicker();
    }
  };

  const loadAll = async (): Promise<void> => {
    const seq = ++loadSeq;
    loading = true;
    render();

    const [
      schedulesResult,
      triggersResult,
      watchesResult,
      autoRunResult,
      dishesResult,
      namesResult,
      authStateResult,
    ] = await Promise.allSettled([
      opts.schedulesListCaller
        ? opts.schedulesListCaller()
        : Promise.reject(new Error('schedules.list caller is not wired in this host.')),
      opts.triggersListCaller
        ? opts.triggersListCaller()
        : Promise.reject(new Error('triggers.list caller is not wired in this host.')),
      opts.watchListCaller
        ? opts.watchListCaller()
        : Promise.reject(new Error('watch.list caller is not wired in this host.')),
      opts.autoRunListCaller
        ? opts.autoRunListCaller()
        : Promise.reject(new Error('auto_run.list caller is not wired in this host.')),
      // D-215 slice 3 — SOFT enhancement, unlike the four core lists above.
      // An absent caller is a host that has not opted in, not a failure: it
      // must not put an error on `getLoadErrors()` (which every existing
      // host asserts on). `dishesWired` keeps the section from claiming
      // "no dishes yet" when the truth is "nobody asked".
      opts.dishesListCaller
        ? opts.dishesListCaller()
        : Promise.resolve(null),
      // Soft enhancement — absent caller resolves to no names.
      opts.recipeNamesCaller
        ? opts.recipeNamesCaller()
        : Promise.resolve({ recipes: [] as ReadonlyArray<{ recipe_id: string; name?: string }> }),
      // R21.1 soft enhancement — absent caller leaves the lock banner off.
      opts.authStateCaller
        ? opts.authStateCaller()
        : Promise.resolve({ state: 'unlocked' as const }),
    ]);
    if (disposed || seq !== loadSeq) return;

    const next: AutomationLoadErrors = {};
    if (schedulesResult.status === 'fulfilled') {
      schedules = schedulesResult.value.schedules;
    } else {
      next.schedules = messageForError(schedulesResult.reason);
    }
    if (triggersResult.status === 'fulfilled') {
      triggers = triggersResult.value.triggers;
    } else {
      next.triggers = messageForError(triggersResult.reason);
    }
    if (watchesResult.status === 'fulfilled') {
      // R21: push sources (`.sources`) left this surface — only the poll
      // loops are consumed (inline trigger status + the residual group).
      watches = watchesResult.value.watches;
    } else {
      next.watches = messageForError(watchesResult.reason);
    }
    if (dishesResult.status === 'fulfilled') {
      // D-215 slice 4b — the dish rows need the recipe's variable
      // DEFINITIONS to decide whether a Config affordance applies, and
      // `recipeEntries` is otherwise loaded lazily (only when the Add
      // picker is disclosed). Without this the button never appeared —
      // a defect the first version of the row shipped with.
      if (dishesResult.value !== null) void loadRecipeEntries();
      // `null` is the soft "no caller wired" sentinel above — distinct from
      // a real empty answer, which is what `dishesWired` preserves.
      const value = dishesResult.value;
      dishesWired = value !== null;
      dishes = value?.dishes ?? [];
      // `last_runs` is omitted entirely when the server has no audit store;
      // `{}` and "absent" must read the same, so normalise here rather than
      // making every row site handle two shapes.
      dishLastRuns = value?.last_runs ?? {};
    } else {
      next.dishes = messageForError(dishesResult.reason);
    }
    if (autoRunResult.status === 'fulfilled') {
      autoRun = autoRunResult.value.entries;
    } else {
      next.auto_run = messageForError(autoRunResult.reason);
    }
    // R21.1 — soft enhancement: a failed read leaves the prior state
    // (or null) untouched rather than flashing the banner on a transient
    // rpc error.
    if (authStateResult.status === 'fulfilled') {
      vaultState = authStateResult.value.state;
    }
    if (namesResult.status === 'fulfilled') {
      recipeNames = new Map(
        namesResult.value.recipes
          .filter((r) => typeof r.name === 'string' && r.name.length > 0)
          .map((r) => [r.recipe_id, r.name as string]),
      );
      // First names load — push the deep-link selection's now-known label
      // into the picker's own state so the next render()'s rewire() shows
      // the recipe NAME, not the bare id it was seeded with pre-load. Once
      // only: a later background re-list must not overwrite a typed query.
      if (!recipeFilterLabelSynced) {
        if (recipeFilter !== null) {
          recipePicker?.setValue(resolveRecipeSelection());
        }
        recipeFilterLabelSynced = true;
      }
    }
    // R21 one-shot: a LEGACY recipe deep-link (#automation/<recipe-id>)
    // lands on the default tab; once the data is in, repoint at the
    // first section that actually has rows for that recipe (order =
    // the render order). Never fires for an explicit section deep-link
    // or after a user tab click.
    if (sectionAutoPickPending) {
      sectionAutoPickPending = false;
      if (recipeFilter !== null) {
        const first = AUTOMATION_SECTION_TOKENS.find(
          (token) => sectionCount(token) > 0,
        );
        if (first !== undefined && first !== activeSection) {
          // Deliberately NO syncHash() here (codex R21 MEDIUM): the URL
          // stays `#automation/<recipe-id>` — the legacy recipe link is
          // the shareable/refreshable form of this view (a refresh
          // re-parses it and re-auto-picks); rewriting it to a bare
          // section hash would lose the recipe focus. A USER tab click
          // still syncs (explicit navigation supersedes the deep link).
          activeSection = first;
        }
      }
    }
    errors = next;
    loading = false;
    render();
  };

  const runMutation = async (
    rule_id: string,
    section: AutomationSectionKind,
    mutate: () => Promise<unknown>,
  ): Promise<void> => {
    busy.add(rule_id);
    render();
    try {
      await mutate();
      const { [sectionErrorKey(section)]: _cleared, ...rest } = mutationErrors;
      mutationErrors = rest;
    } catch (err) {
      mutationErrors = {
        ...mutationErrors,
        [sectionErrorKey(section)]: messageForError(err),
      };
    } finally {
      busy.delete(rule_id);
    }
    // Re-list either way — on failure the fresh list shows the
    // authoritative state next to the preserved mutation error.
    await loadAll();
  };

  // D-179 — the auto-run config editor. Renders the recipe's variable
  // widgets pre-filled from the current overlay; on confirm it sends the
  // collected config to `auto_run.update` (the server versions it on a
  // managed immutable dish). `mode: 'resume'` also re-enables the recipe
  // in the same call (arm-time is a config-adjustment point); `'edit'`
  // leaves the enable state untouched. Widget values are read on confirm
  // (native inputs hold their own state), so no re-render / caret dance.
  const closeAutoRunConfigModal = (): void => {
    autoRunConfigHandle?.destroy();
  };

  const openAutoRunConfigModal = (
    entry: AutoRunStatusEntry,
    mode: 'resume' | 'edit',
  ): void => {
    const caller = opts.autoRunUpdateCaller;
    if (caller === undefined || doc === undefined) return;
    closeAutoRunConfigModal();
    autoRunConfigHandle = wireConfigEditorOverlay({
      document: doc,
      title: entry.recipe_name ?? entry.recipe_id,
      copy: 'These values apply to every automatic run.',
      confirmLabel: mode === 'resume' ? 'Resume' : 'Save',
      variables: entry.variables ?? {},
      currentOverlay: entry.config_overlay,
      ...(opts.fileRefSearchCaller !== undefined
        ? { fileRefSearch: opts.fileRefSearchCaller }
        : {}),
      // `mode: 'resume'` re-enables in the same call (arm-time is a config
      // adjustment point); `'edit'` leaves the enable state untouched.
      onConfirm: (config) => {
        void runMutation(entry.recipe_id, 'auto_run', () =>
          caller({
            recipe_id: entry.recipe_id,
            ...(mode === 'resume' ? { enabled: true } : {}),
            config_overlay: config,
          }));
      },
      onClose: () => { autoRunConfigHandle = null; },
    });
  };

  /** D-215 slice 4b — edit a dish's config.
   *
   *  Routed by the SAME write-target rule as toggle / remove (§ 4.4a): an
   *  assigned dish writes `dishes.update`, a one-shot writes
   *  `schedules.update` (whose reconcile MINTS a new dish and dissolves the
   *  prior — the immutable path the slice-0 guard exists to protect), and a
   *  subordinate managed dish never gets here at all.
   *
   *  The variable DEFINITIONS come from the recipe, not the dish: a dish
   *  stores values, the recipe declares their shape. No recipe entry (the
   *  lazy list has not loaded, or the recipe is gone) ⇒ no editor, rather
   *  than an editor with no widgets. */
  const openDishConfigModal = (d: Dish): void => {
    if (doc === undefined) return;
    const target = dishWriteTarget(d);
    if (target.kind === 'owner') return;
    const entry = (recipeEntries ?? []).find((r) => r.recipe_id === d.recipe_id);
    if (entry === undefined) return;
    closeAutoRunConfigModal();
    autoRunConfigHandle = wireConfigEditorOverlay({
      document: doc,
      title: d.name !== '' ? d.name : nameFor(d.recipe_id),
      copy: target.kind === 'one_shot'
        ? 'These values apply to this scheduled run.'
        : 'These values apply to every run of this dish.',
      confirmLabel: 'Save',
      variables: entry.recipe.variables ?? {},
      currentOverlay: d.config_overlay,
      ...(opts.fileRefSearchCaller !== undefined
        ? { fileRefSearch: opts.fileRefSearchCaller }
        : {}),
      onConfirm: (config) => {
        if (target.kind === 'one_shot' && opts.schedulesUpdateCaller) {
          void runMutation(d.dish_id, 'dish', () =>
            opts.schedulesUpdateCaller!({
              schedule_id: target.schedule_id,
              config_overlay: config,
            }));
        } else if (target.kind === 'own' && opts.dishesUpdateCaller) {
          void runMutation(d.dish_id, 'dish', () =>
            opts.dishesUpdateCaller!({ dish_id: d.dish_id, config_overlay: config }));
        }
      },
      onClose: () => { autoRunConfigHandle = null; },
    });
  };

  const sectionErrorKey = (
    section: AutomationSectionKind,
  ): keyof AutomationLoadErrors => {
    switch (section) {
      case 'schedule':
        return 'schedules';
      case 'event_trigger':
        return 'triggers';
      case 'watch':
        return 'watches';
      case 'auto_run':
        return 'auto_run';
      case 'dish':
        return 'dishes';
    }
  };

  const onToggle = (
    section: AutomationSectionKind,
    rule_id: string,
    enabled: boolean,
  ): void => {
    if (section === 'schedule' && opts.schedulesUpdateCaller) {
      void runMutation(rule_id, section, () =>
        opts.schedulesUpdateCaller!({ schedule_id: rule_id, enabled }));
    } else if (section === 'event_trigger' && opts.triggersUpdateCaller) {
      void runMutation(rule_id, section, () =>
        opts.triggersUpdateCaller!({ trigger_id: rule_id, enabled }));
    } else if (section === 'watch' && opts.watchUpdateCaller) {
      void runMutation(rule_id, section, () =>
        opts.watchUpdateCaller!({ watch_key: rule_id, enabled }));
    } else if (section === 'dish') {
      // D-215 slice 4 — route by write target, never by "it's a dish".
      const d = dishes.find((x) => x.dish_id === rule_id);
      if (d === undefined) return;
      const target = dishWriteTarget(d);
      if (target.kind === 'own' && opts.dishesUpdateCaller) {
        void runMutation(rule_id, section, () =>
          opts.dishesUpdateCaller!({ dish_id: rule_id, enabled }));
      } else if (target.kind === 'one_shot' && opts.schedulesUpdateCaller) {
        // The § 3 exception: inline for the OWNER, but the write lands on
        // the schedule — `dishes.update` would be refused by the slice-0
        // guard, and rightly so.
        void runMutation(rule_id, section, () =>
          opts.schedulesUpdateCaller!({ schedule_id: target.schedule_id, enabled }));
      }
    } else if (section === 'auto_run' && opts.autoRunUpdateCaller) {
      const entry = autoRun.find((a) => a.recipe_id === rule_id);
      // D-179 — resuming a recipe that declares config variables opens the
      // pre-filled editor (arm-time is a config-adjustment point) rather
      // than a blind flip; a variable-less recipe just toggles.
      if (enabled && entry && Object.keys(entry.variables ?? {}).length > 0) {
        openAutoRunConfigModal(entry, 'resume');
        return;
      }
      void runMutation(rule_id, section, () =>
        opts.autoRunUpdateCaller!({ recipe_id: rule_id, enabled }));
    }
  };

  const onRunNow = (section: AutomationSectionKind, rule_id: string): void => {
    if (section === 'watch' && opts.watchRunNowCaller) {
      void runMutation(rule_id, section, () =>
        opts.watchRunNowCaller!({ watch_key: rule_id }));
    }
  };

  const onDelete = (section: AutomationSectionKind, rule_id: string): void => {
    if (section === 'schedule' && opts.schedulesDeleteCaller) {
      void runMutation(rule_id, section, () =>
        opts.schedulesDeleteCaller!({ schedule_id: rule_id }));
    } else if (section === 'event_trigger' && opts.triggersDeleteCaller) {
      void runMutation(rule_id, section, () =>
        opts.triggersDeleteCaller!({ trigger_id: rule_id }));
    } else if (section === 'dish') {
      const d = dishes.find((x) => x.dish_id === rule_id);
      if (d === undefined) return;
      const target = dishWriteTarget(d);
      if (target.kind === 'own' && opts.dishesDeleteCaller) {
        void runMutation(rule_id, section, () =>
          opts.dishesDeleteCaller!({ dish_id: rule_id }));
      } else if (target.kind === 'one_shot' && opts.schedulesDeleteCaller) {
        // D-215 § 5.2 — THE DISPOSAL PATH for a retained one-shot (an
        // errored or skipped fire is kept, disabled, and cleared BY HAND).
        // Deleting the SCHEDULE is what retires the pair: `retireSchedule`
        // drops the row and dissolves the dish behind it. Calling
        // `dishes.delete` here would be refused by the slice-0 guard AND
        // would orphan the schedule if it were not.
        void runMutation(rule_id, section, () =>
          opts.schedulesDeleteCaller!({ schedule_id: target.schedule_id }));
      }
    }
  };

  const onClick = (ev: Event): void => {
    // R21 detail — the back button returns to the section list.
    const backButton = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.('[data-recued-automation-back]');
    if (backButton) {
      detailId = null;
      syncHash();
      render();
      return;
    }
    // R21 create path — the per-section Add disclosure.
    const add = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${AUTOMATION_ROUTE_ADD_ATTR}]`);
    if (add) {
      const section = add.getAttribute(AUTOMATION_ROUTE_ADD_ATTR);
      if (section === 'triggers' || section === 'schedules' || section === 'dishes') {
        addPickerFor = addPickerFor === section ? null : section;
        if (addPickerFor !== null) void loadRecipeEntries();
        render();
      }
      return;
    }
    // R21 sub-nav — tab clicks flip the visible section + sync the hash.
    const tab = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${AUTOMATION_ROUTE_SUBNAV_ATTR}]`);
    if (tab) {
      const token = tab.getAttribute(AUTOMATION_ROUTE_SUBNAV_ATTR);
      if (token !== null && isAutomationSectionToken(token) && token !== activeSection) {
        activeSection = token;
        // Switching sections leaves any open detail (it belongs to the
        // previous section), closes an open Add disclosure (per-section
        // state — returning later shouldn't resurrect it; codex R21 LOW),
        // and supersedes a pending legacy auto-pick.
        detailId = null;
        addPickerFor = null;
        sectionAutoPickPending = false;
        syncHash();
        render();
      }
      return;
    }
    const target = targetWithAction(ev);
    if (target === null) return;
    const action = target.getAttribute(ACTION_ATTR);
    const ruleId = target.getAttribute(ROW_ID_ATTR);
    if (action === null || ruleId === null || ruleId.length === 0) return;
    const [verb, section, to] = action.split(':') as [
      string,
      AutomationSectionKind,
      string | undefined,
    ];
    // Details is read-only — it must work DURING a mutation (codex R21
    // LOW: the button renders enabled, so a busy-guard swallow would be
    // a dead click). Mutating verbs stay busy-guarded below.
    if (verb === 'detail') {
      detailId = ruleId;
      if (section === 'dish') {
        dishHistory = null;
        void loadDishHistory(ruleId);
      }
      syncHash();
      render();
      return;
    }
    if (busy.has(ruleId)) return;
    if (verb === 'toggle') {
      onToggle(section, ruleId, to === 'on');
    } else if (verb === 'rename' && section === 'dish') {
      renamingDishId = ruleId;
      render();
    } else if (verb === 'rename-cancel' && section === 'dish') {
      renamingDishId = null;
      render();
    } else if (verb === 'rename-save' && section === 'dish') {
      const input = routeRoot.querySelector?.(
        `[${DISH_RENAME_INPUT_ATTR}="${ruleId}"]`,
      ) as { value?: string } | null;
      const next = (input?.value ?? '').trim();
      renamingDishId = null;
      const caller = opts.dishesUpdateCaller;
      const current = dishes.find((x) => x.dish_id === ruleId);
      // An unchanged name is not a write. An EMPTY name is also refused:
      // `name: ''` is reserved for the invisible default dish (D-179 fork
      // (c)), so blanking a named dish would silently disguise it as one.
      if (caller !== undefined && next.length > 0 && next !== current?.name) {
        void runMutation(ruleId, 'dish', () => caller({ dish_id: ruleId, name: next }));
      } else {
        render();
      }
    } else if (verb === 'configure' && section === 'dish') {
      const d = dishes.find((x) => x.dish_id === ruleId);
      if (d !== undefined) openDishConfigModal(d);
    } else if (verb === 'configure' && section === 'auto_run') {
      // D-179 — edit config on an already-enabled recipe (no enable-state
      // change); opens the same editor the resume flow uses, in 'edit'.
      const entry = autoRun.find((a) => a.recipe_id === ruleId);
      if (entry) openAutoRunConfigModal(entry, 'edit');
    } else if (verb === 'run') {
      onRunNow(section, ruleId);
    } else if (verb === 'delete') {
      onDelete(section, ruleId);
    }
  };

  // R21 filters — the status/origin selects (change event; the recipe
  // combobox has its own wiring).
  const onFilterChange = (ev: Event): void => {
    const target = ev.target as (Element & { value?: string }) | null;
    if (target === null || typeof target.hasAttribute !== 'function') return;
    if (target.hasAttribute(AUTOMATION_ROUTE_STATUS_FILTER_ATTR)) {
      const v = target.value ?? 'all';
      statusFilter =
        v === 'on' || v === 'off' || v === 'tripped' ? v : 'all';
      render();
      return;
    }
    if (target.hasAttribute(AUTOMATION_ROUTE_ORIGIN_FILTER_ATTR)) {
      const v = target.value ?? 'all';
      originFilter = v === 'user' || v === 'recipe' ? v : 'all';
      render();
    }
  };

  routeRoot.addEventListener('click', onClick);
  routeRoot.addEventListener('change', onFilterChange);

  const unsubscribers: Array<() => void> = [];
  if (opts.subscribe !== undefined) {
    unsubscribers.push(
      opts.subscribe('schedule', () => {
        void loadAll();
      }),
      opts.subscribe('automation_rule_changed', () => {
        void loadAll();
      }),
      opts.subscribe('reactive_fire', () => {
        void loadAll();
      }),
    );
  }

  render();
  const initialLoad = loadAll();

  return {
    getSchedules: () => schedules,
    getTriggers: () => triggers,
    getWatches: () => watches,
    getAutoRun: () => autoRun,
    getActiveSection: () => activeSection,
    getDetailId: () => detailId,
    getRecipeFilter: () => recipeFilter,
    getLoadErrors: () => errors,
    getMutationErrors: () => mutationErrors,
    refresh: () => loadAll(),
    whenLoaded: () => initialLoad,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      recipePicker?.destroy();
      recipePicker = null;
      addPicker?.destroy();
      addPicker = null;
      openModal?.destroy();
      openModal = null;
      closeAutoRunConfigModal();
      routeRoot.removeEventListener('click', onClick);
      routeRoot.removeEventListener('change', onFilterChange);
      try {
        while (routeRoot.firstChild) routeRoot.removeChild(routeRoot.firstChild);
        opts.root.removeChild(routeRoot);
      } catch {
        // Test fakes may detach the host first.
      }
    },
  };
};
