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
  MailFactTypeSpec,
  ServerRecipeListEntry,
  ServerSchedule,
  ServerMissedRunReport,
  MissedSchedulePolicy,
  WatchSourceStatusEntry,
  WatchStatusEntry,
  PreapprovalExecutionStatus,
  PreapprovalActivation,
  PreapprovalCapabilities,
} from '@recued/contracts';
import { openPreapprovalActivation } from '../approvals/preapproval-activation.js';
import { preapprovalHref } from '../approvals/preapproval-route.js';
import {
  describeCron,
  decodeMcpResourceUri,
  isNotSwitchedOn,
  MCP_RESOURCE_POLL_SOURCE_ID,
} from '@recued/contracts';

import {
  formatClientDateTime,
  formatLateness,
  scheduleLatenessMs,
  MISSED_RUNS_ACTION_ATTR,
  parseMissedRunsAction,
  RefPicker,
  renderMissedRunsCard,
  RunModal,
  wireConfigEditorOverlay,
  dishLineName,
  dishStartsLine,
  dishStatus,
  intervalInWords,
  rowsOfDish,
  timerNextCheck,
  timerNextRun,
  timerRunsPhrase,
  timerWaitsForData,
  whatStartsIt,
  type ConfigEditorOverlayHandle,
  type MailTemplateVariableCallers,
  type MissedRunsAnswer,
} from '@recued/ui-shared';
import { bindRecordRefSearchToRecipe } from '../record-ref-search.js';
import {
  AUTOMATION_ACTION_ATTR as ACTION_ATTR,
  AUTOMATION_CHIP_ATTR,
  AUTOMATION_RULE_ID_ATTR as ROW_ID_ATTR,
  BY_RECIPE_STYLES,
  chipCounts,
  isAutomationChip,
  renderByRecipe,
  renderChips,
  renderComingUp,
  type AutomationChip,
  type ByRecipeGroup,
  type ComingUpEntry,
} from './by-recipe.js';
import { NOT_INSTALLED_TEXT, isInstalledRecipeEntry, startsOnItsOwn } from '../recipes/running-as.js';
import { dishFormStart, openDishForm, type DishFormMode } from '../recipes/dish-form.js';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  createHierarchicalHistory,
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalHistoryIntent,
} from '../shell/hierarchical-navigation.js';
import { serializeShellRoute } from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

/** Static config for the ★ ref-picker backing the recipe filter. */
const RECIPE_PICKER_CONFIG: RefPicker.RefPickerRenderConfig = {
  pickerId: 'automation-recipe-filter',
  placeholder: 'All recipes',
  ariaLabel: 'Show only one Recipe',
  emptyText: 'No automatic Recipes match.',
};

/** R21 create path — the "Add" recipe picker (which recipe to schedule /
 *  attach a trigger to; options = EVERY installed recipe, not just the
 *  already-automated set the filter picker shows). */
const ADD_PICKER_CONFIG: RefPicker.RefPickerRenderConfig = {
  pickerId: 'automation-add-recipe',
  placeholder: 'Choose a recipe…',
  ariaLabel: 'Choose a recipe to automate',
  emptyText: 'No installed Recipes match.',
};

export const AUTOMATION_ROUTE_STYLES_MARKER = 'data-recued-automation-route-styles';
export const AUTOMATION_ROUTE_HOST_ATTR = 'data-recued-automation-route';
export const AUTOMATION_ROUTE_HEADING_ATTR = 'data-recued-automation-heading';
export const AUTOMATION_ROUTE_SECTION_ATTR = 'data-recued-automation-section';
export const AUTOMATION_ROUTE_ROW_ATTR = 'data-recued-automation-row';
export const AUTOMATION_ROUTE_STATE_ATTR = 'data-recued-automation-state';
/** D-261 — the list-row marker for a rule whose next run is already approved. */
export const AUTOMATION_ROUTE_PREAPPROVAL_ATTR = 'data-recued-automation-preapproval';
export const AUTOMATION_ROUTE_ERROR_ATTR = 'data-recued-automation-error';
export const AUTOMATION_ROUTE_RETRY_ATTR = 'data-recued-automation-retry';
export const AUTOMATION_ROUTE_EMPTY_ATTR = 'data-recued-automation-empty';
export const AUTOMATION_ROUTE_DETAIL_HEADING_ATTR =
  'data-recued-automation-detail-heading';
/** R21 — one sub-nav tab per section. Value = the section HASH token
 *  (`auto-run` / `triggers` / `schedules`); `data-active` marks the
 *  visible one. */
export const AUTOMATION_ROUTE_SUBNAV_ATTR = 'data-recued-automation-subnav';
export const AUTOMATION_ROUTE_SECTION_PANEL_ATTR =
  'data-recued-automation-section-panel';
/** R21 — a trigger row's inline backing-poll status line. Value = the
 *  backing `watch_key`. */
export const AUTOMATION_ROUTE_POLL_ATTR = 'data-recued-automation-poll';
/** R21 — a section's "Add" (create) disclosure button. Value = the
 *  section hash token (`triggers` / `schedules`). */
export const AUTOMATION_ROUTE_ADD_ATTR = 'data-recued-automation-add';
/** A failed full-recipe inventory read inside an Add disclosure. Value =
 *  the section whose picker owns the failure. */
export const AUTOMATION_ROUTE_ADD_ERROR_ATTR =
  'data-recued-automation-add-error';
/** Retry a failed full-recipe inventory read. Value = the section whose
 *  Add disclosure (or Dishes config affordances) needs that inventory. */
export const AUTOMATION_ROUTE_ADD_RETRY_ATTR =
  'data-recued-automation-add-retry';
/** D-215 slice 4 — a subordinate managed dish's link to the rule that owns
 *  its lifecycle. Value = the owning rule id. */
export const DISH_OWNER_LINK_ATTR = 'data-recued-dish-owner-link';
/** D-215 slice 4b — the inline rename box on a dish row. Value = dish_id. */
export const DISH_RENAME_INPUT_ATTR = 'data-recued-dish-rename';
/** D-215 slice 5 — the dish detail's run-history list. Value = dish_id. */
export const DISH_HISTORY_ATTR = 'data-recued-dish-history';
/** D-215 slice 5 — a dish-history read failure. Value = dish_id. */
export const DISH_HISTORY_ERROR_ATTR = 'data-recued-dish-history-error';
/** D-215 slice 5 — retry the open dish's history read. Value = dish_id. */
export const DISH_HISTORY_RETRY_ATTR = 'data-recued-dish-history-retry';
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
export const AUTOMATION_STATUS_FILTERS = [
  'all', 'on', 'off', 'tripped', 'waiting',
] as const;
export type AutomationStatusFilter = (typeof AUTOMATION_STATUS_FILTERS)[number];

/** ⛔ DERIVED FROM THE TUPLE, NOT HAND-WRITTEN BESIDE IT. The input
 *  handler used to read `v === 'on' || v === 'off' || v === 'tripped'`,
 *  a closed list sitting next to the union with nothing tying them
 *  together — so adding `'waiting'` rendered the option, typechecked,
 *  and SILENTLY fell through to `'all'` when anyone picked it. */
const asStatusFilter = (value: unknown): AutomationStatusFilter =>
  (AUTOMATION_STATUS_FILTERS as readonly unknown[]).includes(value)
    ? value as AutomationStatusFilter
    : 'all';
export type AutomationOriginFilter = 'all' | 'user' | 'recipe';


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

interface AutomationActionFocus {
  verb: string;
  section: AutomationSectionKind;
  rule_id: string;
}

interface AutomationDeleteConfirmation {
  section: AutomationSectionKind;
  rule_id: string;
}

/** R21 — the page's sections, as their HASH tokens (the
 *  `#automation/<section>` segment; R16 deep-link pattern). */
export type AutomationSectionToken =
  /** D-319 §5.4 — one list, grouped by recipe then dish: the page. */
  | 'all'
  /** D-319 §5.4 — the next runs, by time. */
  | 'coming-up'
  | 'auto-run' | 'triggers' | 'schedules'
  /** D-215 slice 3 — the cross-recipe dish aggregate. */
  | 'dishes';
/** D-319 §5.4 — the page's views, its nav. The four lists by kind are no
 *  longer tabs; they stay reachable by link (a rule's Details, older links). */
export const AUTOMATION_VIEW_TOKENS: readonly AutomationSectionToken[] = ['all', 'coming-up'];
export const AUTOMATION_SECTION_TOKENS: readonly AutomationSectionToken[] = [
  'all',
  'coming-up',
  'auto-run',
  'triggers',
  'schedules',
  'dishes',
];
const isViewToken = (token: AutomationSectionToken): boolean =>
  (AUTOMATION_VIEW_TOKENS as readonly string[]).includes(token);
export const isAutomationSectionToken = (
  v: string,
): v is AutomationSectionToken =>
  (AUTOMATION_SECTION_TOKENS as readonly string[]).includes(v);

type AutomationCreateSectionToken = Extract<
  AutomationSectionToken,
  'triggers' | 'schedules' | 'dishes'
>;
const isAutomationCreateSectionToken = (
  value: string,
): value is AutomationCreateSectionToken =>
  value === 'triggers' || value === 'schedules' || value === 'dishes';

export type SchedulesListCaller = () => Promise<{ schedules: ServerSchedule[] }>;
export type SchedulesUpdateCaller = (args: {
  schedule_id: string;
  enabled?: boolean;
  /** D-215 slice 4b. ⛔ D-319: settings are a dish's, and the server refuses
   *  them on a schedule row — nothing here sends this any more. */
  config_overlay?: Record<string, unknown>;
  /** D-266 — the owner's missed-run policy. Declared rather than left
   *  to ride the passthrough: the bootstrap forwards `args` whole, so
   *  this already REACHED the rpc while the type said it could not —
   *  and the first refactor that destructured `args` would have
   *  dropped it silently, with nothing red. Accept and advertise. */
  missed_policy?: MissedSchedulePolicy;
}) => Promise<{ schedule: ServerSchedule }>;
export type SchedulesDeleteCaller = (args: {
  schedule_id: string;
}) => Promise<{ deleted: true }>;
/** D-266 — reads the one-per-wake missed-run card. Recomputed server-side
 *  on every call; there is no stored ask behind it. */
export type SchedulesMissedCaller = () => Promise<ServerMissedRunReport>;
/** D-266 — answers the card. Omitting `recipe_ids` answers every entry,
 *  which is what [Run them] / [Skip them] send. */
export type SchedulesAnswerMissedCaller = (args: {
  answer: MissedRunsAnswer;
  recipe_ids?: string[];
}) => Promise<{ ran: string[]; skipped: string[] }>;
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
  /** D-319 — one dish's timer. */
  dish_id?: string;
  /** D-319 — with no dish: the recipe's main dish, made from
   *  `config_overlay` when it has none (switching it on). */
  recipe_id?: string;
  enabled?: boolean;
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
  /** D-266 — soft enhancement. Absent ⇒ no missed-run card, and no load
   *  error: a host that has not opted in is not a failure. */
  schedulesMissedCaller?: SchedulesMissedCaller;
  schedulesAnswerMissedCaller?: SchedulesAnswerMissedCaller;
  triggersListCaller?: TriggersListCaller;
  triggersUpdateCaller?: TriggersUpdateCaller;
  triggersDeleteCaller?: TriggersDeleteCaller;
  autoRunListCaller?: AutoRunListCaller;
  autoRunUpdateCaller?: AutoRunUpdateCaller;
  preapprovalPrepareCaller?: Parameters<typeof openPreapprovalActivation>[0]['prepare'];
  onPreapprovalPrepared?: Parameters<typeof openPreapprovalActivation>[0]['onPrepared'];
  /** Remove the approval on an already pre-approved rule, in place. Absent ⇒
   *  the row still links to the review page, which owns the same action. */
  preapprovalRemoveCaller?: (proposalId: string, requestId: string) => Promise<void>;
  /** D-261 §6.2 — what this server can actually pre-approve. Soft: an absent or
   *  failing caller leaves the offer exactly as it was. */
  preapprovalCapabilitiesCaller?: () => Promise<PreapprovalCapabilities>;
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
  /** The server's zone (D-269), on whose clock a timer's window opens, so a
   *  timer's next run is its first check inside the window. Absent: this
   *  browser's. */
  serverTimeZone?: () => string | undefined;
  /** D-319 — what a first dish starts from (a mail template), for Switch on. */
  dishesDefaultsCaller?: (args: { recipe_id: string }) => Promise<{ config_overlay: Record<string, unknown> }>;
  /** D-319 §5.4 — the run dialog's Run tab. Absent, it said "Running is not
   *  available on this server yet" in a dialog opened to add a rule. */
  recipeExecuteCaller?: RunModal.RunModalExecuteCaller;
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
  /** D-315 §5.1 — the owner's mail templates, for the modal's "A mail fact"
   *  "Read by" picker. Absent ⇒ no template narrowing is offered. */
  mailFactTemplatesCaller?: RunModal.RunModalMailFactTemplatesCaller;
  /** D-315 §4.5 — the owner's kinds of email, offered beside the built-in ones. */
  mailFactTypesCaller?: RunModal.RunModalMailFactTypesCaller;
  /** D-200 — owner-file inventory for `file_ref` config fields. */
  fileRefSearchCaller?: RefPicker.RefPickerSearchCaller;
  /** D-319 — a `mail_template` setting in the settings form: the owner's
   *  templates (the recipe page's picker). Absent ⇒ a text box. */
  mailTemplateCallers?: MailTemplateVariableCallers;
  /** D-221 record picker for a `record_ref` setting, bound per recipe. */
  recordRefSearchCaller?: (
    owner: { publisher: string; pack_slug: string },
    entity: string,
    scope?: Readonly<Record<string, string>>,
  ) => RefPicker.RefPickerSearchCaller;
  /** R21 — `#automation/<section>` deep-link: which section opens. Absent →
   *  the one list (D-319 §5.4). */
  initialSection?: AutomationSectionToken;
  /** R21 — `#automation/<section>/<id>` deep-link: one rule's detail
   *  within `initialSection`. */
  initialDetailId?: string;
  /** Called after a successful in-page history write so the shell's cached
   *  address remains aligned with the visible section/detail. */
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
  /** True while a row mutation or child editor owns an unresolved command. */
  hasInFlightWork(): boolean;
  /** Contextual shell guard for Automation commands that cannot be recalled. */
  inFlightWorkPrompt(): string | null;
  dispose(): void;
}

const AUTOMATION_ROUTE_STYLES = `
[${AUTOMATION_ROUTE_HOST_ATTR}] {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
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
  min-width: 0;
  max-width: 100%;
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-section-title a {
  max-width: 100%;
  justify-content: flex-start;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_DETAIL_HEADING_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-section-hint {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 12px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-list {
  display: grid;
  min-width: 0;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${AUTOMATION_ROUTE_ROW_ATTR}] {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
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
[${AUTOMATION_ROUTE_ROW_ATTR}] > * {
  min-width: 0;
}
[${AUTOMATION_ROUTE_ROW_ATTR}][data-armed="off"] {
  opacity: .72;
}
[${AUTOMATION_ROUTE_ROW_ATTR}][data-armed="tripped"] {
  border-left-color: var(--danger);
}
/* D-266 — waiting on the owner. Accent rather than danger: nothing has
   failed, the schedule is holding for an answer it was told to ask for. */
[${AUTOMATION_ROUTE_ROW_ATTR}][data-armed="waiting"] {
  border-left-color: var(--accent);
}
/* D-319 §5.4 — inside a recipe's group a row needs no card of its own, nor
   the recipe's name again (its buttons still say it). */
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-recipe [${AUTOMATION_ROUTE_ROW_ATTR}] {
  border-width: 0 0 0 2px;
  border-radius: 0;
  background: none;
  padding: 4px 0 4px 10px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-recipe .automation-row-title {
  display: none;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-title a {
  box-sizing: border-box;
  min-height: 36px;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 4px 2px;
  border-radius: 5px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-detail,
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-meta {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 5px;
  color: var(--muted);
  font-size: 12px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-detail > *,
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-meta > * {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
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
[${AUTOMATION_ROUTE_PREAPPROVAL_ATTR}] {
  font-weight: 650;
  font-size: 12px;
  color: var(--accent);
}
/* Held and in-doubt are the two the owner has to act on, so they carry the
   same colour as a tripped rule rather than the calm approved one. */
[${AUTOMATION_ROUTE_PREAPPROVAL_ATTR}][data-attention="yes"] {
  color: var(--danger);
}
[${AUTOMATION_ROUTE_STATE_ATTR}][data-armed="tripped"],
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-error {
  color: var(--danger);
}
[${AUTOMATION_ROUTE_STATE_ATTR}][data-armed="waiting"] {
  color: var(--accent);
  font-weight: 650;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-error {
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
@media (max-width: 560px) {
  [${AUTOMATION_ROUTE_ROW_ATTR}] {
    grid-template-columns: minmax(0, 1fr);
  }
  [${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-actions {
    flex-wrap: wrap;
    justify-content: flex-start;
  }
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-actions a {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  font-weight: 600;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-title a:hover,
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-actions a:hover {
  background: var(--accent-weak);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-title a:focus-visible,
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-row-actions a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail,
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail > * {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  min-width: 0;
  max-width: 100%;
  gap: 6px 12px;
  margin: 12px 0;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail-facts dt {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail-facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail-facts code {
  white-space: normal;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail-note {
  overflow-wrap: anywhere;
}
@media (max-width: 360px) {
  [${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  [${AUTOMATION_ROUTE_HOST_ATTR}] .automation-detail-facts dd {
    margin-bottom: 8px;
  }
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
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-button:disabled,
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: .65;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] a {
  box-sizing: border-box;
  min-width: 36px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
  border-radius: 5px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] a:hover {
  background: var(--accent-weak);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${AUTOMATION_ROUTE_ERROR_ATTR}],
[${AUTOMATION_ROUTE_ADD_ERROR_ATTR}],
[${AUTOMATION_ROUTE_EMPTY_ATTR}] {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_ERROR_ATTR}],
[${AUTOMATION_ROUTE_ADD_ERROR_ATTR}] {
  border-left: 2px solid var(--danger);
  padding-left: 8px;
  color: var(--danger);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-load-error {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-load-error > span {
  flex: 1 1 180px;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-load-error > button {
  flex: 0 0 auto;
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
  min-width: 0;
  max-width: 100%;
  gap: 4px;
  margin: 12px 0 0;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-subnav-tab {
  box-sizing: border-box;
  flex: 0 0 auto;
  min-height: 36px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fg-muted);
  white-space: nowrap;
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
  box-sizing: border-box;
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  padding: 4px 8px;
  border-left: 2px solid var(--border);
  font-size: 12px;
  color: var(--fg-muted);
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-poll > span {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-poll > span:not(.automation-poll-state) {
  flex: 1 1 180px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-poll > .automation-row-error {
  flex-basis: 100%;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-poll > button {
  flex: 0 0 auto;
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
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 4px 0 8px;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-list-adds {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0 8px;
  min-width: 0;
}
[${AUTOMATION_ROUTE_HOST_ATTR}] .automation-add-picker {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 360px;
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
  all: 'By recipe',
  'coming-up': 'Coming up',
  'auto-run': 'Auto-run',
  triggers: 'Triggers',
  schedules: 'Schedules',
  dishes: 'Dishes',
};

/** D-266 adds `'waiting'`: armed, not paused, and holding for an answer
 *  about a run it missed.
 *
 *  ⛔ IT NEEDED ITS OWN STATE RATHER THAN A STATUS STRING. Such a
 *  schedule has `enabled: true`, so it rendered "On" — indistinguishable
 *  from one running fine, in a list where the whole question is WHICH
 *  row wants you. The card says something is waiting; only the row says
 *  which. `matchesStatus` compares against this union, so the filter
 *  picks it up with one added option. */
type ArmedState = 'on' | 'off' | 'tripped' | 'waiting';

/** D-261 — the list-row pre-approval marker.
 *
 *  ⛔ WHY IT EXISTS: an armed rule and an ordinary one rendered IDENTICALLY in
 *  the list. The only way to learn that a schedule's next run was already
 *  approved was to open its Details, one rule at a time — so the owner could
 *  not answer "what will run tonight without asking me?" from this page at all,
 *  which is the question the page is for.
 *
 *  ⚠ THE STATUS IS PART OF THE MARKER, NOT DECORATION. `describeAutomation`
 *  returns `preapproval` whenever the rule is managed and an execution row
 *  exists — including non-usable ones — so a terminal or stuck execution
 *  reaches here too. `held` is the one that matters most: a reviewed run that
 *  paused on an UNCOVERED call is waiting for an answer the owner does not know
 *  is owed, which is exactly the state a list marker should surface. */
const preapprovalBadge = (status: PreapprovalExecutionStatus): string => {
  const [label, attention]: [string, boolean] = status === 'held'
    ? ['Already said yes · still needs you', true]
    : status === 'in_doubt'
      ? ['Pre-approved · unconfirmed', true]
      : status === 'running'
        ? ['Pre-approved · running', false]
        : status === 'prepared' || status === 'active'
          ? ['Pre-approved', false]
          // succeeded / partial / failed / cancelled / expired / invalidated —
          // the approval is spent or gone; say so rather than implying it still
          // covers the next run.
          : [`Pre-approval ${status.replaceAll('_', ' ')}`, false];
  return `<span ${AUTOMATION_ROUTE_PREAPPROVAL_ATTR} data-status="${e(status)}"`
    + `${attention ? ' data-attention="yes"' : ''}>${e(label)}</span>`;
};

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
  busyVerb: string | undefined;
  confirmingDelete: boolean;
  /** D-261 — the armed approval on this rule, if any. Present ⇒ the next run
   *  needs no answer from the owner. Absent ⇒ the rule asks as it always did. */
  preapproval?: { execution_status: PreapprovalExecutionStatus } | undefined;
}): string => {
  const metaSpans = args.meta.map((m) => `<span>${e(m)}</span>`).join('');
  const title = args.titleHref
    ? `<a href="${e(args.titleHref)}">${e(args.title)}</a>`
    : e(args.title);
  const busyAttrs = (verb: string): string =>
    args.busy
      ? ` aria-disabled="true"${args.busyVerb === verb ? ' aria-busy="true"' : ''}`
      : '';
  const actionName = (label: string): string =>
    e(`${label} ${args.title} (${args.rule_id})`);
  const toggleLabel = args.busy && args.busyVerb === 'toggle'
    ? args.toggleLabel === 'Re-arm'
      ? 'Re-arming…'
      : args.toggleTo
        ? 'Resuming…'
        : 'Pausing…'
    : args.toggleLabel;
  const runLabel = args.busyVerb === 'run' ? 'Running…' : 'Run now';
  const confirmDeleteLabel = args.busyVerb === 'delete-confirm'
    ? 'Removing…'
    : 'Confirm remove';
  return `
    <li ${AUTOMATION_ROUTE_ROW_ATTR}="${e(`${args.section}:${args.rule_id}`)}" data-armed="${args.armed}">
      <div>
        <p class="automation-row-title">${title}</p>
        <div class="automation-row-detail">${args.detail}</div>
        <div class="automation-row-meta">
          <span ${AUTOMATION_ROUTE_STATE_ATTR} data-armed="${args.armed}">${e(args.stateLabel)}</span>
          ${args.preapproval ? preapprovalBadge(args.preapproval.execution_status) : ''}
          ${metaSpans}
        </div>
        ${args.error ? `<div class="automation-row-meta"><span class="automation-row-error">${e(args.error)}</span></div>` : ''}
        ${args.extra ?? ''}
      </div>
      <div class="automation-row-actions">
        ${args.toggleLabel !== undefined
          ? `<button type="button" class="automation-button"
          aria-label="${actionName(toggleLabel ?? args.toggleLabel)}"
          ${ACTION_ATTR}="toggle:${e(args.section)}:${args.toggleTo ? 'on' : 'off'}"
          ${ROW_ID_ATTR}="${e(args.rule_id)}"${busyAttrs('toggle')}>${e(toggleLabel ?? args.toggleLabel)}</button>`
          : ''}
        ${args.canRunNow
          ? `<button type="button" class="automation-button"
              aria-label="${actionName(runLabel)}"
              ${ACTION_ATTR}="run:${e(args.section)}"
              ${ROW_ID_ATTR}="${e(args.rule_id)}"${busyAttrs('run')}>${runLabel}</button>`
          : ''}
        ${args.canDelete
          ? args.confirmingDelete
            ? `<button type="button" class="automation-button automation-button--danger"
                aria-label="${actionName(confirmDeleteLabel)}"
                ${ACTION_ATTR}="delete-confirm:${e(args.section)}"
                ${ROW_ID_ATTR}="${e(args.rule_id)}"${busyAttrs('delete-confirm')}>${confirmDeleteLabel}</button>
              <button type="button" class="automation-button"
                aria-label="${actionName('Cancel')}"
                ${ACTION_ATTR}="delete-cancel:${e(args.section)}"
                ${ROW_ID_ATTR}="${e(args.rule_id)}"${busyAttrs('delete-cancel')}>Cancel</button>`
            : `<button type="button" class="automation-button automation-button--danger"
                aria-label="${actionName('Remove')}"
                ${ACTION_ATTR}="delete:${e(args.section)}"
                ${ROW_ID_ATTR}="${e(args.rule_id)}">Remove</button>`
          : ''}
        ${args.canDetail
          ? `<button type="button" class="automation-button"
              aria-label="${actionName('Details')}"
              ${ACTION_ATTR}="detail:${e(args.section)}"
              ${ROW_ID_ATTR}="${e(args.rule_id)}">Details</button>`
          : ''}
      </div>
    </li>
  `;
};

const renderSection = (args: {
  section: AutomationSectionKind;
  retryToken: AutomationSectionToken;
  retryable: boolean;
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
    const retrying = args.loading;
    const retry = args.retryable
      ? `<button type="button" class="automation-button"
          ${AUTOMATION_ROUTE_RETRY_ATTR}="${args.retryToken}"
          ${retrying ? 'aria-disabled="true" aria-busy="true"' : ''}>
          ${retrying ? 'Retrying…' : 'Retry'}
        </button>`
      : '';
    body = `<div class="automation-load-error"
      ${AUTOMATION_ROUTE_ERROR_ATTR}="${args.section}"
      role="${retrying ? 'status' : 'alert'}">
      <span>${e(args.error)}</span>${retry}
    </div>`;
  } else if (args.loading && args.rows.length === 0) {
    body = `<p ${AUTOMATION_ROUTE_EMPTY_ATTR}="${args.section}">Loading...</p>`;
  } else if (args.rows.length === 0) {
    body = `<p ${AUTOMATION_ROUTE_EMPTY_ATTR}="${args.section}">${e(args.emptyText)}</p>`;
  } else {
    body = `<ul class="automation-list" role="list">${args.rows.join('')}</ul>`;
  }
  const mutationLine = args.mutationError !== undefined
    ? `<p ${AUTOMATION_ROUTE_ERROR_ATTR}="${args.section}:mutation" role="alert">${e(args.mutationError)}</p>`
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
      BY_RECIPE_STYLES,
    ].join('\n');
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(AUTOMATION_ROUTE_HOST_ATTR, '');
  opts.root.appendChild(routeRoot);

  let schedules: ReadonlyArray<ServerSchedule> = [];
  // D-266 — the missed-run card. Null until read (or when the host has
  // not wired the caller); the report itself is recomputed server-side,
  // so this is a cache of a read and never a source of truth.
  let missedRuns: ServerMissedRunReport | null = null;
  let missedRunsBusy = false;
  let missedRunsError: string | null = null;
  let triggers: ReadonlyArray<EventTrigger> = [];
  /** D-315 §5.1 — a trigger on facts read from mail is said in words, which
   *  name the template it is narrowed to and the owner's kinds of email.
   *  Read with the triggers whenever one of them is on facts. Unknown (null)
   *  until read, or when the read failed: a narrowing then reads "read by one
   *  template", never "a template that was deleted". */
  let mailFactTemplates: readonly RunModal.RunModalMailFactTemplate[] | null = null;
  let mailFactTypes: readonly MailFactTypeSpec[] = [];
  let mailFactNamesSeq = 0;
  let watches: ReadonlyArray<WatchStatusEntry> = [];
  let autoRun: ReadonlyArray<AutoRunStatusEntry> = [];
  /** D-319 — an auto-run row is one dish's timer; a recipe nobody switched on
   *  is one row with no dish, keyed by the recipe. */
  const autoRunId = (a: AutoRunStatusEntry): string => a.dish_id ?? a.recipe_id;
  // D-215 slice 3 — the dish aggregate + its last-outcome map. `lastRuns`
  // is keyed by dish_id and a dish that has NEVER run is simply absent
  // (never present-with-nulls), so "unknown" and "never run" stay the
  // same rendering rather than becoming a false failure.
  let dishes: ReadonlyArray<Dish> = [];
  let dishLastRuns: Readonly<Record<string, DishLastRun>> = {};
  /** D-319 §5.4 — the one list's filter (On / Off / Needs you / Failing), or
   *  none; the recipes being switched on; and the section a rule's Details
   *  were opened from, which Back returns to. */
  let chipFilter: AutomationChip | null = null;
  let switchOnBusy = new Set<string>();
  let detailReturnSection: AutomationSectionToken | null = null;
  /** False until a `dishes.list` caller has actually answered — an absent
   *  caller must not render as "no dishes yet". */
  let dishesWired = false;
  /** D-215 slice 4b — the dish row currently showing its rename input, or
   *  null. Kept as state (not DOM) because the section repaints wholesale
   *  on every broadcast; an in-DOM-only edit box would vanish mid-type. */
  let renamingDishId: string | null = null;
  /** D-215 slice 5 — the open dish detail's history and read lifecycle.
   *  Every result is keyed both by dish and request identity: closing and
   *  reopening the SAME dish must not let an older request win. */
  let dishHistory: { dish_id: string; runs: DishRunRow[] } | null = null;
  let dishHistoryError: { dish_id: string; message: string } | null = null;
  let dishHistoryRequest: { dish_id: string; seq: number } | null = null;
  let dishHistoryRequestSeq = 0;
  let pendingDishHistoryRetryFocus: string | null = null;
  // R21 — the visible section. A section deep-link seeds it; a legacy
  // recipe deep-link leaves it on the default and the post-load one-shot
  // below repoints it at the first section with rows for that recipe.
  let activeSection: AutomationSectionToken = opts.initialSection ?? 'all';
  /** R21 detail — the open rule id within `activeSection`, or null (list). */
  let detailId: string | null =
    opts.initialSection !== undefined && opts.initialDetailId !== undefined
    && opts.initialDetailId.length > 0
      ? opts.initialDetailId
      : null;
  const automationAddress = (
    section: AutomationSectionToken,
    detail: string | null,
  ) => hierarchicalAddress(
    'automation',
    hierarchicalLevel(`section:${section}`, section),
    ...(detail === null
      ? []
      : [hierarchicalLevel(`detail:${section}:${detail}`, detail)]),
  );
  const automationHistory = createHierarchicalHistory({
    initial: automationAddress(activeSection, detailId),
    history: () => doc.defaultView?.history
      ?? (globalThis as { history?: History }).history,
    onCommit: (address) => opts.onHashSync?.(address.hash),
  });
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
  // An explicit load Retry owns focus through the busy repaint. Success
  // advances to the selected section tab; failure returns to Retry. Moving
  // elsewhere while the read is in flight cancels that ownership.
  let pendingRetryFocus: AutomationSectionToken | null = null;
  let disposed = false;
  let loadSeq = 0;
  /** Rule ids with an in-flight mutation — their actions remain focusable but
   *  are guarded by the delegated busy check. */
  const busy = new Set<string>();
  /** The exact mutation owning a busy row. This drives visible progress and
   *  distinguishes the initiator from sibling controls that are merely locked. */
  const busyActions = new Map<string, AutomationActionFocus>();
  let deleteConfirmation: AutomationDeleteConfirmation | null = null;
  let revokeConfirmation: { section: AutomationSectionKind; rule_id: string } | null = null;
  /** ⛔ NULL MEANS "NOT ANSWERED", NOT "NOTHING SUPPORTED". The gate below is
   *  monotone: an unknown capability set leaves the offer where the presence of
   *  `lifecycle_revision` already put it, so a transient rpc failure cannot
   *  silently withdraw a feature the server does support. */
  let preapprovalCapabilities: PreapprovalCapabilities | null = null;
  // Carry a focused row mutation's semantic identity through its busy repaint
  // and the authoritative re-list (for example Pause → Pausing… → Resume).
  let pendingActionFocus: AutomationActionFocus | null = null;
  // Delete has no same-row successor: fall through to a neighboring row's
  // safe Details action after a successful authoritative re-list.
  let pendingActionFallbackFocus: AutomationActionFocus | null = null;

  const busyVerbFor = (
    section: AutomationSectionKind,
    rule_id: string,
  ): string | undefined => {
    const action = busyActions.get(rule_id);
    return action?.section === section ? action.verb : undefined;
  };

  const mutationBusyAttrs = (
    section: AutomationSectionKind,
    rule_id: string,
    verb: string,
  ): string =>
    busy.has(rule_id)
      ? ` aria-disabled="true"${busyVerbFor(section, rule_id) === verb
        ? ' aria-busy="true"'
        : ''}`
      : '';

  const mutationToggleLabel = (
    section: AutomationSectionKind,
    rule_id: string,
    label: string,
    toggleTo: boolean,
  ): string => {
    if (busyVerbFor(section, rule_id) !== 'toggle') return label;
    if (label === 'Re-arm') return 'Re-arming…';
    return toggleTo ? 'Resuming…' : 'Pausing…';
  };

  const confirmingDeleteFor = (
    section: AutomationSectionKind,
    rule_id: string,
  ): boolean =>
    deleteConfirmation?.section === section
    && deleteConfirmation.rule_id === rule_id;

  /** D-261 §6.2 — may this server pre-approve THIS kind of activation?
   *
   *  ⛔ THE SPEC'S OWN CONTRACT, AND IT WAS NEVER CONSULTED: "Capability presence
   *  is conditional on the persistent repository, origin resolver, binding
   *  identities, child-call gates, decision channel and dispatch hooks all being
   *  wired. Clients retain ordinary Arm/Schedule when unavailable, without a
   *  false pre-approved label." The server computed that answer on every boot
   *  and no client ever asked, so the offer was gated on `lifecycle_revision`
   *  alone — which proves the repository composed, and nothing about what the
   *  server can actually freeze.
   *
   *  ⚠ MONOTONE BY CONSTRUCTION. `null` (unasked, unwired host, failed rpc) keeps
   *  the prior behaviour; only a real answer can narrow the offer. Today every
   *  composed server advertises all four kinds, so this withdraws nothing — the
   *  point is that a server which stops advertising one is now HONOURED rather
   *  than contradicted by a button that leads to a refusal. */
  const canPreapprove = (kind: PreapprovalActivation['kind']): boolean =>
    preapprovalCapabilities === null
    || preapprovalCapabilities.activation_kinds.includes(kind);

  const confirmingRevokeFor = (
    section: AutomationSectionKind,
    rule_id: string,
  ): boolean =>
    revokeConfirmation?.section === section
    && revokeConfirmation.rule_id === rule_id;

  /** The pre-approval controls on an armed rule: review it, or remove it here.
   *
   *  Confirmed like Remove and for the same reason — pressing this discards an
   *  owner decision (the selected members, the reviewed content, the challenge)
   *  and the only way back is to review the whole execution again. It is not a
   *  Pause.
   *
   *  ⚠ The request id is minted ONCE per row and RETAINED across a failed
   *  attempt: the repository dedupes revocations on `(request_id,
   *  responder_key)`, so a fresh id per press would make a lost response into a
   *  second revocation rather than a replay of the first. */
  const revokeRequestIds = new Map<string, string>();
  const revokeRequestIdFor = (section: AutomationSectionKind, rule_id: string): string => {
    const key = `${section}:${rule_id}`;
    const existing = revokeRequestIds.get(key);
    if (existing !== undefined) return existing;
    const minted = crypto.randomUUID();
    revokeRequestIds.set(key, minted);
    return minted;
  };

  const renderPreapprovalButtons = (
    section: AutomationSectionKind,
    rule_id: string,
    proposal_id: string,
  ): string =>
    `<a class="automation-button" href="${e(preapprovalHref(proposal_id))}">Look at this run</a>`
    // The other half of the same rule: a rule-delete confirmation hides this
    // destructive control, leaving the review LINK (navigation, not a mutation).
    + (opts.preapprovalRemoveCaller === undefined || confirmingDeleteFor(section, rule_id)
      ? ''
      : confirmingRevokeFor(section, rule_id)
        ? `<button type="button" class="automation-button automation-button--danger"
            aria-label="Confirm remove pre-approval"
            ${ACTION_ATTR}="preapproval-remove-confirm:${e(section)}"
            ${ROW_ID_ATTR}="${e(rule_id)}"${mutationBusyAttrs(section, rule_id, 'preapproval-remove-confirm')}>${
          busyVerbFor(section, rule_id) === 'preapproval-remove-confirm' ? 'Removing…' : 'Yes, take back this approval'}</button>
          <button type="button" class="automation-button"
            aria-label="Keep pre-approval"
            ${ACTION_ATTR}="preapproval-remove-cancel:${e(section)}"
            ${ROW_ID_ATTR}="${e(rule_id)}"${mutationBusyAttrs(section, rule_id, 'preapproval-remove-cancel')}>Keep</button>`
        : `<button type="button" class="automation-button automation-button--danger"
            aria-label="Remove pre-approval"
            ${ACTION_ATTR}="preapproval-remove:${e(section)}"
            ${ROW_ID_ATTR}="${e(rule_id)}">Remove pre-approval</button>`);

  /** The armed proposal on a rule, read at press time off the SAME rendered
   *  rows the owner clicked — never cached alongside the button. */
  const preapprovalProposalFor = (
    section: AutomationSectionKind,
    rule_id: string,
  ): string | null => {
    switch (section) {
      case 'schedule':
        return schedules.find((row) => row.schedule_id === rule_id)?.preapproval?.proposal_id ?? null;
      case 'event_trigger':
        return triggers.find((row) => row.trigger_id === rule_id)?.preapproval?.proposal_id ?? null;
      case 'auto_run':
        return autoRun.find((row) => autoRunId(row) === rule_id)?.preapproval?.proposal_id ?? null;
      case 'watch':
      case 'dish':
        return null;
    }
  };

  const automationRuleExists = (
    section: AutomationSectionKind,
    rule_id: string,
  ): boolean => {
    switch (section) {
      case 'schedule':
        return schedules.some((row) => row.schedule_id === rule_id);
      case 'event_trigger':
        return triggers.some((row) => row.trigger_id === rule_id);
      case 'watch':
        return watches.some((row) => row.watch_key === rule_id);
      case 'auto_run':
        return autoRun.some((row) => autoRunId(row) === rule_id);
      case 'dish':
        return dishes.some((row) => row.dish_id === rule_id);
    }
  };

  const renderDeleteButtons = (
    section: AutomationSectionKind,
    rule_id: string,
  ): string =>
    // ⛔ ONE DESTRUCTIVE CHOICE ON SCREEN AT A TIME. Browser-verified 2026-09-06:
    // with a pre-approval removal armed, this row read
    // `… Confirm remove approval | Keep | Remove` — and that last button deletes
    // the whole rule. Two destructive controls, adjacent, near-identical labels,
    // one of them mid-confirmation. A confirm step exists to focus a decision,
    // so it hides the other one until it resolves. Symmetric below.
    confirmingRevokeFor(section, rule_id)
      ? ''
      : confirmingDeleteFor(section, rule_id)
      ? `<button type="button" class="automation-button automation-button--danger"
          ${ACTION_ATTR}="delete-confirm:${e(section)}"
          ${ROW_ID_ATTR}="${e(rule_id)}"${mutationBusyAttrs(section, rule_id, 'delete-confirm')}>${busyVerbFor(section, rule_id) === 'delete-confirm' ? 'Removing…' : 'Confirm remove'}</button>
        <button type="button" class="automation-button"
          ${ACTION_ATTR}="delete-cancel:${e(section)}"
          ${ROW_ID_ATTR}="${e(rule_id)}"${mutationBusyAttrs(section, rule_id, 'delete-cancel')}>Cancel</button>`
      : `<button type="button" class="automation-button automation-button--danger"
          ${ACTION_ATTR}="delete:${e(section)}"
          ${ROW_ID_ATTR}="${e(rule_id)}">Remove</button>`;

  const matchesActionFocus = (
    element: { getAttribute?: (name: string) => string | null } | null | undefined,
    focus: AutomationActionFocus,
  ): boolean => {
    const action = element?.getAttribute?.(ACTION_ATTR);
    const prefix = `${focus.verb}:${focus.section}`;
    return element?.getAttribute?.(ROW_ID_ATTR) === focus.rule_id
      && (action === prefix || action?.startsWith(`${prefix}:`) === true);
  };

  const findActionFocusTarget = (
    focus: AutomationActionFocus,
  ): HTMLElement | null => {
    const candidates = routeRoot.querySelectorAll?.(
      `[${ACTION_ATTR}][${ROW_ID_ATTR}]`,
    );
    if (candidates === undefined) return null;
    const match = Array.from(candidates).find((candidate) =>
      matchesActionFocus(candidate, focus));
    return (match as HTMLElement | undefined) ?? null;
  };

  /** Internal view controls bypass the shell's route-switch work tracker. If
   * one is activated while a row mutation owns the route, return focus to the
   * semantic owner instead of letting a tab/filter repaint hide it. */
  const focusPendingMutationOwner = (): void => {
    const focus = pendingActionFocus
      ?? Array.from(busyActions.values()).find((candidate) =>
        busy.has(candidate.rule_id))
      ?? null;
    if (focus === null) return;
    const owner = findActionFocusTarget(focus);
    owner?.focus?.({ preventScroll: true });
    owner?.scrollIntoView?.({ block: 'nearest' });
  };

  const deletionFallbackFocus = (
    section: AutomationSectionKind,
    rule_id: string,
  ): AutomationActionFocus | null => {
    const candidates = routeRoot.querySelectorAll?.(
      `[${ACTION_ATTR}][${ROW_ID_ATTR}]`,
    );
    if (candidates === undefined) return null;
    const buttons = (Array.from(candidates) as HTMLElement[]).filter((button) => {
      const action = button.getAttribute?.(ACTION_ATTR);
      return action === `delete:${section}`
        || action === `delete-confirm:${section}`;
    });
    const removedIndex = buttons.findIndex(
      (button) => button.getAttribute?.(ROW_ID_ATTR) === rule_id,
    );
    if (removedIndex < 0) return null;
    const neighbor = buttons[removedIndex + 1] ?? buttons[removedIndex - 1];
    const neighborId = neighbor?.getAttribute?.(ROW_ID_ATTR);
    return neighborId === null || neighborId === undefined
      ? null
      : { verb: 'detail', section, rule_id: neighborId };
  };

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
          if (busy.size > 0) {
            recipePicker?.setValue(resolveRecipeSelection());
            focusPendingMutationOwner();
            return;
          }
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
  let addPickerFor: AutomationCreateSectionToken | null = null;
  let addPicker: RefPicker.RefPickerHandle | null = null;
  /** Full recipe entries (the modal and Dishes config affordances need the
   *  recipe body). Null is strictly "not loaded" — a failed read retains
   *  provenance below instead of becoming a false empty inventory. */
  let recipeEntries: ServerRecipeListEntry[] | null = null;
  let recipeEntriesError: string | null = null;
  let recipeEntriesRequest: number | null = null;
  let recipeEntriesRequestSeq = 0;
  /** A focused Add/Retry owns the async replacement. Initial success moves
   *  into the picker; retry success does the same, while failure returns to
   *  Retry. Moving to another live control cancels that ownership. */
  let pendingRecipeEntriesFocus: AutomationCreateSectionToken | null = null;
  let openModal: RunModal.RunModalHandle | null = null;
  /** Add disclosure to restore after its modal closes. It remains armed
   *  through the close-triggered re-list, unless the user moves elsewhere. */
  let pendingModalReturnFocus:
    | Extract<AutomationSectionToken, 'triggers' | 'schedules'>
    | null = null;
  // D-179 — the auto-run config editor (the shared config-editor overlay).
  // Detached on close / route teardown.
  let autoRunConfigHandle: ConfigEditorOverlayHandle | null = null;
  let preapprovalActivation: ReturnType<typeof openPreapprovalActivation> | null = null;

  const canCreate = (
    section: AutomationCreateSectionToken,
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

  const loadRecipeEntries = (explicitRetry = false): boolean => {
    if (
      recipeEntries !== null
      || opts.recipeEntriesCaller === undefined
      || recipeEntriesRequest !== null
      // A background Dishes repaint must not turn a persistent failure into
      // an unbounded retry loop. Only the visible Retry clears this gate.
      || (!explicitRetry && recipeEntriesError !== null)
    ) return false;

    const request = ++recipeEntriesRequestSeq;
    recipeEntriesRequest = request;
    void (async () => {
      try {
        const { recipes } = await opts.recipeEntriesCaller!();
        if (disposed || recipeEntriesRequest !== request) return;
        recipeEntries = recipes;
        recipeEntriesError = null;
      } catch (error) {
        if (disposed || recipeEntriesRequest !== request) return;
        recipeEntriesError = messageForError(error);
      }
      if (recipeEntriesRequest !== request) return;
      recipeEntriesRequest = null;
      // Repaint an open Add disclosure, the Dishes section whose Config
      // affordances depend on recipe variable definitions, the one list
      // (what starts each dish; the recipes nobody switched on), and every
      // view showing a timer: its real time and next run are read from its
      // recipe's window (2026-10-05).
      if (
        addPickerFor !== null
        || activeSection === 'dishes'
        || activeSection === 'all'
        || activeSection === 'coming-up'
        || activeSection === 'auto-run'
      ) render();
    })();
    return true;
  };

  /** D-319 — the recipes, read now: Switch on needs one's settings. */
  const loadRecipeEntriesNow = async (): Promise<void> => {
    if (recipeEntries !== null || opts.recipeEntriesCaller === undefined) return;
    const { recipes } = await opts.recipeEntriesCaller();
    if (disposed) return;
    recipeEntries = recipes;
    recipeEntriesError = null;
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

  /** A recipe the Dishes section's Add can make a dish for: not one the
   *  server only ships that starts on its own — that switch is refused. A
   *  schedule or trigger runs the shipped copy, so those pickers list it. */
  const dishable = (recipe_id: string): boolean => {
    const entry = (recipeEntries ?? []).find((r) => r.recipe_id === recipe_id);
    return entry === undefined || isInstalledRecipeEntry(entry) || !startsOnItsOwn(entry.recipe);
  };

  const addRecipeSearch = (
    query: string,
  ): Promise<readonly RefPicker.RefPickerOption[]> =>
    Promise.resolve(RefPicker.filterRefOptions(
      addPickerFor === 'dishes'
        ? allRecipeOptions().filter((option) => dishable(option.id))
        : allRecipeOptions(),
      query,
    ));

  const openCreateModal = (
    entry: ServerRecipeListEntry,
    tab: 'schedule' | 'trigger',
  ): void => {
    openModal?.destroy();
    pendingModalReturnFocus = null;
    const returnSection = tab === 'schedule' ? 'schedules' : 'triggers';
    const handle = RunModal.wireRunModal({
      recipe: entry,
      document: doc,
      initialTab: tab,
      // D-319 §5.4 — its Run tab runs (it said running was unavailable).
      ...(opts.recipeExecuteCaller !== undefined ? { execute: opts.recipeExecuteCaller } : {}),
      // D-319 — a schedule or trigger added here is a dish's: which one, when
      // the recipe has more than one.
      ...(dishesWired ? { dishes: dishes.filter((dish) => dish.recipe_id === entry.recipe_id) } : {}),
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
      ...(opts.mailFactTemplatesCaller !== undefined
        ? { mailFactTemplates: opts.mailFactTemplatesCaller }
        : {}),
      ...(opts.mailFactTypesCaller !== undefined
        ? { mailFactTypes: opts.mailFactTypesCaller }
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
        if (disposed) return;
        pendingModalReturnFocus = returnSection;
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
    if (addPickerFor === null || recipeEntries === null) {
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
            pendingRecipeEntriesFocus = null;
            // D-319 — a dish is made with its settings asked, as on the
            // recipe page: Switch on (or Save settings) for a first one,
            // Add another after.
            render();
            void makeDish(entry.recipe_id);
            return;
          }
          const tab = addPickerFor === 'schedules' ? 'schedule' : 'trigger';
          addPickerFor = null;
          pendingRecipeEntriesFocus = null;
          openCreateModal(entry, tab);
          render();
        },
      });
    } else {
      addPicker.rewire(routeRoot);
    }
  };

  /** D-266 — the detail view's own copies of the row's two derived
   *  facts, so the panel and the list cannot drift apart. */
  const detailLateness = (s: ServerSchedule): number | null =>
    scheduleLatenessMs(s.next_run_at, opts.now?.() ?? Date.now(), s.enabled);
  const detailStateLabel = (s: ServerSchedule): string =>
    waitingScheduleIds().has(s.schedule_id)
      ? 'Waiting on you'
      : s.enabled ? 'On' : 'Paused';

  /** D-266 — which schedules are holding for an answer. Derived from the
   *  missed-run report the route already fetches for the card, so the row
   *  mark and the card can never disagree about what is waiting. */
  const waitingScheduleIds = (): ReadonlySet<string> =>
    new Set((missedRuns?.entries ?? []).flatMap((entry) => entry.schedule_ids));

  /** D-319 §5.4 — one rule row, as the lists by kind and the grouped list
   *  both show it, with what the grouped list needs to place and filter it. */
  interface RuleItem {
    readonly html: string;
    readonly recipe_id: string;
    readonly dish_id: string | null;
    readonly armed: ArmedState;
  }

  // D-319 §5.4 — filtered by the state the row SHOWS. It tested `enabled`
  // before working out Waiting / Tripped, so "Waiting on you" matched no row.
  const scheduleRows = (): string[] =>
    scheduleItems().filter((item) => matchesStatus(item.armed)).map((item) => item.html);

  const scheduleItems = (): RuleItem[] =>
    schedules
      .filter((s) => matchesFilter(s.recipe_id))
      .map((s): RuleItem => {
      const isWaiting = waitingScheduleIds().has(s.schedule_id);
      // D-268 — a schedule the SERVER stopped is not a schedule the owner
      // paused, and they rendered identically: `off` / "Paused" for both, so
      // the one needing action was the one that looked handled. An owner
      // arm/disarm clears `consecutive_failures` in both directions, so a
      // non-zero counter on a disabled row means exactly one thing.
      // `ArmedState` already carried `'tripped'` for the trigger rows; only
      // this derivation was missing it.
      const selfStopped = !s.enabled && (s.consecutive_failures ?? 0) > 0;
      const armed: ArmedState = isWaiting
        ? 'waiting'
        : s.enabled ? 'on' : selfStopped ? 'tripped' : 'off';
      // D-266 — `next_run_at` is the EXPECTED slot (the server sets it at
      // every fire and touches it nowhere else), so a slot in the past is
      // exactly how late this occurrence is. Nothing is computed from an
      // interval: there is no honest single one for a weekday or
      // alternating cron.
      const lateBy = scheduleLatenessMs(s.next_run_at, opts.now?.() ?? Date.now(), s.enabled);
      return { recipe_id: s.recipe_id, dish_id: s.dish_id ?? null, armed, html: renderRow({
        section: 'schedule',
        rule_id: s.schedule_id,
        title: nameFor(s.recipe_id),
        titleHref: recipeHref(s.recipe_id),
        armed,
        stateLabel: isWaiting
          ? 'Waiting on you'
          : s.enabled ? 'On' : selfStopped ? 'Auto-disabled' : 'Paused',
        detail: `<span>${scheduleCadence(s)}</span>`,
        meta: [
          // When a run is overdue, "next <future date>" is the one thing
          // the row must NOT say — it reads as healthy. Say what was due
          // and how late it is instead.
          lateBy === null
            ? `next ${s.enabled ? formatDateTime(s.next_run_at) : '—'}`
            : `due ${formatDateTime(s.next_run_at)} · ${formatLateness(lateBy)}`,
          `last ${formatDateTime(s.last_run_at)}${s.last_status ? ` (${s.last_status})` : ''}`,
        ],
        error: s.last_error,
        toggleTo: !s.enabled,
        toggleLabel: s.enabled ? 'Pause' : 'Resume',
        canDelete: true,
        canDetail: true,
        busy: busy.has(s.schedule_id),
        busyVerb: busyVerbFor('schedule', s.schedule_id),
        confirmingDelete: confirmingDeleteFor('schedule', s.schedule_id),
        ...(s.preapproval ? { preapproval: s.preapproval } : {}),
      }) };
    });

  /** D-215 slice 3 — where a MANAGED dish's lifecycle actually lives.
   *  Ruling (a): managed dishes are VISIBLE and badged, but their edit /
   *  enable / remove actions belong to the owning row, never to the dish
   *  (D-179 versions a managed dish immutably — one `dish_id` = one
   *  config — so mutating it here would break that silently). */
  const dishOrigin = (d: Dish): { label: string; badge: string } => {
    // D-319 — a schedule, trigger or timer belongs to a dish and mints none.
    if (d.is_default) return { label: 'Main', badge: 'main' };
    return { label: 'Assigned', badge: 'assigned' };
  };

  /** A dish's display name. The DEFAULT dish carries `name: ''` and renders
   *  under its recipe's own name (D-179 fork (c): the default dish only
   *  surfaces once a second dish exists, and never invents a label). */
  const dishTitle = (d: Dish): string =>
    d.name !== '' ? d.name : nameFor(d.recipe_id);

  /** D-215 slice 4 — WHERE a dish's mutations go. D-319 retired the managed
   *  dishes (a schedule, trigger or timer belongs to a dish and owns none),
   *  so every dish is the owner's own; the `one_shot` / `owner` branches this
   *  page still carries are dead until the D-319 Automation rewrite (§ 5.4)
   *  removes them. */
  const dishWriteTarget = (
    d: Dish,
  ): { kind: 'own' } | { kind: 'one_shot'; schedule_id: string } | { kind: 'owner'; token: AutomationSectionToken; id: string } => {
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
  /** D-215 slice 5 — load the open dish's history. A request identity is
   *  required in addition to the dish id: the user can leave and reopen the
   *  same detail while its prior read is still settling. */
  const loadDishHistory = (dish_id: string): boolean => {
    const caller = opts.dishesHistoryCaller;
    if (caller === undefined || dishHistoryRequest?.dish_id === dish_id) {
      return false;
    }
    const request = { dish_id, seq: ++dishHistoryRequestSeq };
    dishHistoryRequest = request;
    void (async () => {
      try {
        const { runs } = await caller({ dish_id });
        if (
          disposed
          || dishHistoryRequest !== request
          || detailId !== dish_id
          || activeSection !== 'dishes'
        ) return;
        dishHistory = { dish_id, runs };
        dishHistoryError = null;
      } catch (err) {
        if (
          disposed
          || dishHistoryRequest !== request
          || detailId !== dish_id
          || activeSection !== 'dishes'
        ) return;
        dishHistory = null;
        dishHistoryError = { dish_id, message: messageForError(err) };
      } finally {
        if (dishHistoryRequest !== request) return;
        dishHistoryRequest = null;
        if (disposed || detailId !== dish_id || activeSection !== 'dishes') return;
        render();
      }
    })();
    return true;
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
    const title = dishTitle(d);
    const actionName = (label: string): string =>
      e(`${label} ${title} (${d.dish_id})`);
    if (ctx.renaming) {
      return `<div class="automation-row-actions">
        <input type="text" class="automation-input"
          ${DISH_RENAME_INPUT_ATTR}="${e(d.dish_id)}"
          value="${e(d.name)}" aria-label="${actionName('Rename')}" />
        <button type="button" class="automation-button"
          aria-label="${actionName('Save name for')}"
          ${ACTION_ATTR}="rename-save:dish" ${ROW_ID_ATTR}="${e(d.dish_id)}">Save name</button>
        <button type="button" class="automation-button"
          aria-label="${actionName('Cancel renaming')}"
          ${ACTION_ATTR}="rename-cancel:dish" ${ROW_ID_ATTR}="${e(d.dish_id)}">Cancel</button>
      </div>`;
    }
    const renaming = busyVerbFor('dish', d.dish_id) === 'rename';
    const renameLabel = renaming ? 'Renaming…' : 'Rename';
    const parts = [
      ctx.canConfigure
        ? `<button type="button" class="automation-button"
             aria-label="${actionName('Config')}"
             ${ACTION_ATTR}="configure:dish" ${ROW_ID_ATTR}="${e(d.dish_id)}"${mutationBusyAttrs('dish', d.dish_id, 'configure')}>Config</button>`
        : '',
      ctx.canRename
        ? `<button type="button" class="automation-button"
             aria-label="${actionName(renameLabel)}"
             ${ACTION_ATTR}="rename:dish" ${ROW_ID_ATTR}="${e(d.dish_id)}"${mutationBusyAttrs('dish', d.dish_id, 'rename')}>${renameLabel}</button>`
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

  const focusDishRenameInput = (dish_id: string): void => {
    const input = routeRoot.querySelector?.(
      `[${DISH_RENAME_INPUT_ATTR}="${dish_id}"]`,
    ) as HTMLElement | null | undefined;
    input?.focus?.({ preventScroll: true });
    input?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusDishRenameAction = (dish_id: string): void => {
    const rename = findActionFocusTarget({
      verb: 'rename',
      section: 'dish',
      rule_id: dish_id,
    });
    rename?.focus?.({ preventScroll: true });
    rename?.scrollIntoView?.({ block: 'nearest' });
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
          busyVerb: busyVerbFor('dish', d.dish_id),
          confirmingDelete: confirmingDeleteFor('dish', d.dish_id),
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
    triggers.filter(triggerVisible).map((t) => triggerItem(t).html);

  const triggerItems = (): RuleItem[] =>
    triggers.filter((t) => matchesFilter(t.recipe_id)).map(triggerItem);

  const triggerItem = (t: EventTrigger): RuleItem => {
      const armed: ArmedState = t.enabled
        ? 'on'
        : t.last_error
          ? 'tripped'
          : 'off';
      const fromRecipe = t.origin === 'recipe';
      // D-315 — a trigger on facts read from mail says what it watches in
      // words: its kind, values, "only when" and template.
      const fact = RunModal.describeMailFactTrigger(t, mailFactTemplates, mailFactTypes);
      return { recipe_id: t.recipe_id, dish_id: t.dish_id ?? null, armed, html: renderRow({
        section: 'event_trigger',
        rule_id: t.trigger_id,
        title: nameFor(t.recipe_id),
        titleHref: recipeHref(t.recipe_id),
        armed,
        stateLabel: t.enabled ? 'On' : armed === 'tripped' ? 'Auto-disabled' : 'Paused',
        detail: fact !== null
          ? `<span>on ${e(fact)}</span>`
          : `<span>on <code>${e(t.pattern)}</code></span>`,
        meta: [
          `last fired ${formatDateTime(t.last_fired_at)}`,
          // G6 — declarative rows are reconciler-managed: badge the
          // provenance and (below) hide Remove, since the reconciler
          // would re-create a deleted row; Pause is the gesture that
          // sticks.
          ...(fromRecipe ? ['from recipe'] : []),
          // Authoring sugar — surface the compiled dispatch filter so
          // governance reads WHAT narrows a row, not just its pattern.
          ...(fact === null && t.fields && t.fields.length > 0 ? [`when ${t.fields.join(' / ')} changes`] : []),
          ...(fact === null && t.filter && Object.keys(t.filter).length > 0
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
        busyVerb: busyVerbFor('event_trigger', t.trigger_id),
        confirmingDelete: confirmingDeleteFor('event_trigger', t.trigger_id),
        ...(t.preapproval ? { preapproval: t.preapproval } : {}),
      }) };
    };

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
        return `
          <div class="automation-poll" ${AUTOMATION_ROUTE_POLL_ATTR}="${e(w.watch_key)}" data-armed="${d.armed}">
            <span class="automation-poll-state" data-armed="${d.armed}">${e(d.stateLabel)}</span>
            <span>${e(watchTitle(w))} · every ${e(formatInterval(w.effective_interval_ms))} · last poll ${e(formatDateTime(w.last_poll_at))}${w.last_status ? ` (${e(w.last_status)})` : ''}</span>
            ${w.last_error ? `<span class="automation-row-error">${e(w.last_error)}</span>` : ''}
            <button type="button" class="automation-button automation-button--small"
              ${ACTION_ATTR}="toggle:watch:${!w.enabled ? 'on' : 'off'}"
              ${ROW_ID_ATTR}="${e(w.watch_key)}"${mutationBusyAttrs('watch', w.watch_key, 'toggle')}>${e(
                mutationToggleLabel('watch', w.watch_key, d.toggleLabel, !w.enabled),
              )}</button>
            ${w.active && opts.watchRunNowCaller !== undefined
              ? `<button type="button" class="automation-button automation-button--small"
                  ${ACTION_ATTR}="run:watch"
                  ${ROW_ID_ATTR}="${e(w.watch_key)}"${mutationBusyAttrs('watch', w.watch_key, 'run')}>${busyVerbFor('watch', w.watch_key) === 'run' ? 'Running…' : 'Run now'}</button>`
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
          busyVerb: busyVerbFor('watch', w.watch_key),
          confirmingDelete: false,
        });
      });
  };

  const autoRunRows = (): string[] =>
    autoRunItems().filter((item) => matchesStatus(item.armed)).map((item) => item.html);

  /** A timer's recipe and the settings its dish runs with: what its window
   *  is read from. */
  const timerSubject = (a: AutoRunStatusEntry): {
    readonly recipe: ServerRecipeListEntry['recipe'] | undefined;
    readonly overlay: Readonly<Record<string, unknown>> | undefined;
  } => ({
    recipe: (recipeEntries ?? []).find((entry) => entry.recipe_id === a.recipe_id)?.recipe,
    overlay: a.dish_id ? dishes.find((dish) => dish.dish_id === a.dish_id)?.config_overlay : undefined,
  });

  /** When a timer really runs, without the verb: "every 10 minutes from 8:00
   *  to 9:00 AM on weekdays", "when an email labelled “urgent” arrives,
   *  checking every minute". Its gates decide, not its interval; `null` for a
   *  timer with none (its interval says it). */
  const timerCadence = (a: AutoRunStatusEntry): string | null => {
    const { recipe, overlay } = timerSubject(a);
    if (recipe === undefined || (recipe.trigger_steps ?? []).length === 0) return null;
    return timerRunsPhrase(recipe, a.interval_ms, overlay).replace(/^runs /, '');
  };

  /** A timer's next real run: its first check inside its window; `null` when it
   *  waits for data (no time is its next run). */
  const timerNext = (a: AutoRunStatusEntry): number | null => {
    const { recipe, overlay } = timerSubject(a);
    return timerNextRun(a, recipe, overlay, opts.serverTimeZone?.());
  };

  /** The timer's next line: its next run, or for one that waits for data, its
   *  next check (which runs it only if there is something to run on). */
  const timerNextMeta = (a: AutoRunStatusEntry): string => {
    const { recipe, overlay } = timerSubject(a);
    return recipe !== undefined && timerWaitsForData(recipe, overlay)
      ? `next check ${formatDateTime(timerNextCheck(a, recipe, overlay, opts.serverTimeZone?.()))}`
      : `next ${formatDateTime(timerNext(a))}`;
  };

  const autoRunItems = (): RuleItem[] =>
    autoRun
      .filter((a) => matchesFilter(a.recipe_id))
      .map((a): RuleItem => {
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
      return { recipe_id: a.recipe_id, dish_id: a.dish_id ?? null, armed, html: renderRow({
        section: 'auto_run',
        rule_id: autoRunId(a),
        title: a.dish_name ? `${a.recipe_name ?? a.recipe_id} — ${a.dish_name}` : a.recipe_name ?? a.recipe_id,
        titleHref: recipeHref(a.recipe_id),
        armed,
        stateLabel,
        detail: `<span>${e(timerCadence(a) ?? `every ${formatInterval(a.interval_ms)}`)}${a.dynamic ? ' (dynamic)' : ''}</span>`,
        meta: [
          armed === 'on' ? timerNextMeta(a) : 'next —',
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
        ...(a.preapproval ? { preapproval: a.preapproval } : {}),
        busy: busy.has(autoRunId(a)),
        busyVerb: busyVerbFor('auto_run', autoRunId(a)),
        confirmingDelete: false,
      }) };
    });

  // ── D-319 §5.4 — the one list, and "Coming up" ────────────────────

  /** A dish's last run, as its line says it. */
  const lastRunText = (dish_id: string): string => {
    const last = dishLastRuns[dish_id];
    if (last === undefined) return 'never run';
    const when = formatDateTime(last.started_at);
    return last.commit_status === 'succeeded' ? `✓ ${when}`
      : last.commit_status === 'failed' ? `✗ ${when}`
        : last.commit_status === 'awaiting_approval' ? `waiting for you since ${when}`
          : `${last.commit_status} ${when}`;
  };

  /** Grouped by recipe, then by dish; each dish's rows under it. */
  const byRecipeGroups = (): ByRecipeGroup[] => {
    const schedule = scheduleItems();
    const trigger = triggerItems();
    const timer = autoRunItems();
    const recipeIds = new Set<string>();
    for (const dish of dishes) if (matchesFilter(dish.recipe_id)) recipeIds.add(dish.recipe_id);
    for (const item of [...schedule, ...trigger, ...timer]) recipeIds.add(item.recipe_id);
    for (const entry of recipeEntries ?? []) {
      if (matchesFilter(entry.recipe_id) && startsOnItsOwn(entry.recipe)) recipeIds.add(entry.recipe_id);
    }
    const groups = [...recipeIds].map((recipe_id): ByRecipeGroup => {
      const listed = (recipeEntries ?? []).find((entry) => entry.recipe_id === recipe_id);
      const recipe = listed?.recipe;
      // A recipe the server only ships is not the owner's to switch on: never
      // "Not switched on", so its group shows only for rows of its own (made
      // before the server refused the switch). Unlisted reads as installed.
      const shippedOnly = listed !== undefined && !isInstalledRecipeEntry(listed) && startsOnItsOwn(listed.recipe);
      const mine = dishes.filter((dish) => dish.recipe_id === recipe_id)
        .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.created_at - b.created_at);
      const lines = mine.map((dish) => {
        const rows = rowsOfDish(dish.dish_id, { triggers, schedules, autoRun });
        const own = (items: readonly RuleItem[]): RuleItem[] => items.filter((item) => item.dish_id === dish.dish_id);
        const dishRows = [...own(trigger), ...own(schedule), ...own(timer)];
        return {
          dish,
          name: dishLineName(dish, mine.length),
          status: dishStatus(dish, rows, dishLastRuns[dish.dish_id]),
          needsYou: dishRows.some((item) => item.armed === 'waiting'),
          startsLine: dishStartsLine(recipe ?? {}, rows.schedules, dish.config_overlay),
          lastRun: lastRunText(dish.dish_id),
          rows: dishRows.map((item) => item.html),
          busy: busy.has(dish.dish_id),
        };
      });
      const dishIds = new Set(mine.map((dish) => dish.dish_id));
      const strays = [...trigger, ...schedule].filter((item) =>
        item.recipe_id === recipe_id && (item.dish_id === null || !dishIds.has(item.dish_id)));
      const dishlessTimer = autoRun.find((entry) => entry.recipe_id === recipe_id && (entry.dish_id ?? null) === null);
      return {
        recipe_id,
        name: nameFor(recipe_id),
        href: recipeHref(recipe_id),
        lines,
        strayRows: strays.map((item) => item.html),
        // The contracts' rule: the server's one-time notice names the recipes
        // it matches, so the two cannot disagree.
        notSwitchedOn: !shippedOnly && isNotSwitchedOn({
          recipe,
          dishes: mine.length,
          dishlessTimer: dishlessTimer !== undefined,
        }),
        notInstalled: shippedOnly,
        lead: recipe !== undefined
          ? whatStartsIt(recipe)
          : dishlessTimer !== undefined ? `It runs every ${intervalInWords(dishlessTimer.interval_ms)}.` : '',
        switchOnBusy: switchOnBusy.has(recipe_id),
      };
    });
    return groups.sort((a, b) => a.name.localeCompare(b.name) || a.recipe_id.localeCompare(b.recipe_id));
  };

  /** The next runs on their own: each schedule's and timer's, of a dish on. */
  const comingUpEntries = (): ComingUpEntry[] => {
    const dishById = new Map(dishes.map((dish) => [dish.dish_id, dish]));
    const dishOf = (dish_id: string | undefined): string | null => {
      if (dish_id === undefined) return null;
      const dish = dishById.get(dish_id);
      if (dish === undefined) return null;
      const count = dishes.filter((other) => other.recipe_id === dish.recipe_id).length;
      return dishLineName(dish, count);
    };
    const dishOn = (dish_id: string | undefined): boolean =>
      dish_id === undefined || dishById.get(dish_id)?.enabled !== false;
    const out: ComingUpEntry[] = [];
    for (const s of schedules) {
      if (!matchesFilter(s.recipe_id) || !s.enabled || s.next_run_at === null || !dishOn(s.dish_id)) continue;
      out.push({
        at: s.next_run_at,
        recipe_name: nameFor(s.recipe_id),
        href: recipeHref(s.recipe_id),
        dish_name: dishOf(s.dish_id),
        what: s.mode === 'one_shot' ? 'Once' : describeCron(s.cron_expression),
      });
    }
    for (const a of autoRun) {
      if (!matchesFilter(a.recipe_id) || (a.dish_id ?? null) === null || !a.enabled || a.auto_disabled
        || a.next_run_at === null || !dishOn(a.dish_id ?? undefined)) continue;
      // Its next RUN, not its next check: a window that has not opened yet
      // runs nothing at the next check.
      const at = timerNext(a);
      if (at === null) continue;
      const cadence = timerCadence(a) ?? `every ${intervalInWords(a.interval_ms)}`;
      out.push({
        at,
        recipe_name: nameFor(a.recipe_id),
        href: recipeHref(a.recipe_id),
        dish_name: dishOf(a.dish_id ?? undefined),
        what: `${cadence.charAt(0).toUpperCase()}${cadence.slice(1)}`,
      });
    }
    return out;
  };

  // Recipe-filter combobox — names the recipe the view is narrowed to
  // and lets the user change or clear it (× → the full cross-pack view).
  // The deep-link seeds it; the picker mutates `recipeFilter` in-memory.
  const filterBar = (): string => `
    <div class="automation-filter"${busy.size > 0
      ? ' inert aria-disabled="true"'
      : ''}>
      <span class="automation-filter-label">Show only one Recipe</span>
      ${RefPicker.renderRefPicker(
        RefPicker.initialRefPickerState(resolveRecipeSelection()),
        RECIPE_PICKER_CONFIG,
      )}
      ${isViewToken(activeSection) ? '' : `<label class="automation-filter-label" for="automation-status-filter">Status</label>
      <select id="automation-status-filter" class="automation-filter-select"
        ${AUTOMATION_ROUTE_STATUS_FILTER_ATTR}>
        <option value="all"${statusFilter === 'all' ? ' selected' : ''}>All</option>
        <option value="on"${statusFilter === 'on' ? ' selected' : ''}>Armed</option>
        <option value="off"${statusFilter === 'off' ? ' selected' : ''}>Paused</option>
        <option value="tripped"${statusFilter === 'tripped' ? ' selected' : ''}>Tripped</option>
        <option value="waiting"${statusFilter === 'waiting' ? ' selected' : ''}>Waiting on you</option>
      </select>`}
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
  // Tab clicks flip `activeSection` and align its hierarchical address without
  // a remount. Sideways tab changes replace the current entry.
  const sectionCount = (token: AutomationSectionToken): number => {
    switch (token) {
      case 'all':
        return byRecipeGroups().reduce((sum, group) =>
          sum + group.lines.length + (group.notSwitchedOn ? 1 : 0), 0);
      case 'coming-up':
        return comingUpEntries().length;
      case 'auto-run':
        return autoRun.filter((a) => matchesFilter(a.recipe_id)).length;
      case 'triggers':
        return triggers.filter((t) => matchesFilter(t.recipe_id)).length;
      case 'schedules':
        return schedules.filter((s) => matchesFilter(s.recipe_id)).length;
      case 'dishes':
        return dishes.filter((d) => matchesFilter(d.recipe_id)).length;
    }
  };

  /** The section a rule's kind lives in (its Details open there). */
  const sectionTokenForKind = (kind: AutomationSectionKind): AutomationSectionToken | null => {
    switch (kind) {
      case 'schedule': return 'schedules';
      case 'event_trigger': return 'triggers';
      case 'auto_run': return 'auto-run';
      case 'dish': return 'dishes';
      default: return null;
    }
  };

  const actionSectionForToken = (
    token: AutomationSectionToken,
  ): AutomationSectionKind => {
    switch (token) {
      // The grouped views act on dishes (their rows keep their own kinds).
      case 'all': return 'dish';
      case 'coming-up': return 'dish';
      case 'auto-run': return 'auto_run';
      case 'triggers': return 'event_trigger';
      case 'schedules': return 'schedule';
      case 'dishes': return 'dish';
    }
  };

  const syncHash = (intent: HierarchicalHistoryIntent = 'auto'): void => {
    automationHistory.navigate(automationAddress(activeSection, detailId), {
      intent,
    });
  };

  const subNav = (): string => `
    <nav class="automation-subnav" data-recued-scroll-rail role="tablist" aria-label="Automation sections"
      aria-orientation="horizontal">
      ${AUTOMATION_VIEW_TOKENS.map((token) => `
        <button type="button" class="automation-subnav-tab" role="tab"
          ${AUTOMATION_ROUTE_SUBNAV_ATTR}="${token}"
          id="recued-automation-section-tab-${token}"
          aria-controls="recued-automation-section-panel"
          aria-selected="${activeSection === token ? 'true' : 'false'}"
          tabindex="${activeSection === token || (!isViewToken(activeSection) && token === 'all') ? '0' : '-1'}"
          ${busy.size > 0 ? 'aria-disabled="true"' : ''}
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
    section: AutomationCreateSectionToken,
  ): string => {
    const addAvailable = canCreate(section);
    const open = addPickerFor === section;
    // Dishes consumes the same inventory for Config buttons even when this
    // host has no create caller. Surface a failed background read there so
    // configuration does not silently disappear with no recovery path.
    const showClosedDishesFailure =
      section === 'dishes'
      && recipeEntriesError !== null
      && opts.recipeEntriesCaller !== undefined;
    if (!addAvailable && !showClosedDishesFailure) return '';
    const inventoryLoading = recipeEntriesRequest !== null;
    const inventoryFailure = recipeEntriesError === null
      ? ''
      : `<div class="automation-load-error"
          ${AUTOMATION_ROUTE_ADD_ERROR_ATTR}="${section}"
          role="${inventoryLoading ? 'status' : 'alert'}">
          <span>Could not load installed recipes: ${e(recipeEntriesError)}</span>
          <button type="button" class="automation-button"
            ${AUTOMATION_ROUTE_ADD_RETRY_ATTR}="${section}"
            ${inventoryLoading ? 'aria-disabled="true" aria-busy="true"' : ''}>
            ${inventoryLoading ? 'Retrying…' : 'Retry'}
          </button>
        </div>`;
    return `
      <div class="automation-section-actions">
        ${addAvailable
          ? `<button type="button" class="automation-button"
              ${AUTOMATION_ROUTE_ADD_ATTR}="${section}"
              aria-expanded="${open ? 'true' : 'false'}">
              ${section === 'schedules' ? 'Add schedule'
                : section === 'dishes' ? 'Add dish'
                : 'Add trigger'}
            </button>`
          : ''}
        ${open
          ? recipeEntriesError !== null
            ? inventoryFailure
            : recipeEntries === null
              ? '<p class="automation-section-hint" role="status">Loading installed recipes…</p>'
              : `<div class="automation-add-picker">${RefPicker.renderRefPicker(
                  RefPicker.initialRefPickerState(null),
                  ADD_PICKER_CONFIG,
                )}</div>`
          : showClosedDishesFailure ? inventoryFailure : ''}
      </div>`;
  };

  const activeSectionHtml = (): string => {
    const filtered = recipeFilter !== null;
    switch (activeSection) {
      case 'all': {
        // D-319 §5.4 — one list. The missed-run card feeds Needs you, so it
        // heads the page; the poll loops no trigger claims close it.
        const groups = byRecipeGroups();
        const list = renderByRecipe({
          groups,
          chip: chipFilter,
          can: {
            switchDish: opts.dishesUpdateCaller !== undefined,
            settings: opts.dishesUpdateCaller !== undefined && opts.recipeEntriesCaller !== undefined,
            switchOn: opts.dishesCreateCaller !== undefined && opts.recipeEntriesCaller !== undefined,
          },
        });
        const residual = residualWatchRows();
        const loadError = errors.dishes ?? errors.schedules ?? errors.triggers ?? errors.auto_run;
        const mutationError = mutationErrors.dishes ?? mutationErrors.schedules
          ?? mutationErrors.triggers ?? mutationErrors.auto_run;
        const adds = sectionActions('schedules') + sectionActions('triggers');
        return renderMissedRunsCard(missedRuns, { busy: missedRunsBusy, error: missedRunsError })
          + renderChips(chipCounts(groups), chipFilter)
          + (adds.trim() !== '' ? `<div class="automation-list-adds">${adds}</div>` : '')
          + (loadError !== undefined
            ? `<div class="automation-load-error" ${AUTOMATION_ROUTE_ERROR_ATTR}="all" role="${loading ? 'status' : 'alert'}">
                <span>${e(loadError)}</span>
                <button type="button" class="automation-button" ${AUTOMATION_ROUTE_RETRY_ATTR}="all"
                  ${loading ? 'aria-disabled="true" aria-busy="true"' : ''}>${loading ? 'Retrying…' : 'Retry'}</button>
              </div>`
            : '')
          + (mutationError !== undefined
            ? `<p class="automation-row-error" role="alert">${e(mutationError)}</p>` : '')
          // A re-read keeps the list on screen (and what has focus in it).
          + (list !== ''
            ? list
            : loading
              ? '<p class="automation-section-hint" role="status">Loading…</p>'
              : `<p class="automation-section-hint" ${AUTOMATION_ROUTE_EMPTY_ATTR}>${e(chipFilter !== null
                ? 'Nothing here right now.'
                : filtered
                  ? 'This Recipe does not run on its own.'
                  : 'Nothing runs on its own yet. Switch a Recipe on from its page, or add a schedule.')}</p>`)
          + (residual.length > 0
            ? `<section class="automation-recipe"><h3 class="automation-recipe-title">Checking for changes</h3>
                <ul class="automation-list">${residual.join('')}</ul></section>`
            : '');
      }
      case 'coming-up': {
        const entries = comingUpEntries();
        return loading && entries.length === 0
          ? '<p class="automation-section-hint" role="status">Loading…</p>'
          : renderComingUp(entries);
      }
      case 'auto-run':
        return renderSection({
          section: 'auto_run',
          retryToken: 'auto-run',
          retryable: opts.autoRunListCaller !== undefined,
          title: 'Auto-run',
          hint: 'Recipes that wake up on their own every so often and decide whether to do anything.',
          rows: autoRunRows(),
          loading,
          error: errors.auto_run,
          mutationError: mutationErrors.auto_run,
          emptyText: filtered
            ? 'This Recipe does not run on its own.'
            : 'You have no Recipes that run on their own.',
        });
      case 'dishes':
        return renderSection({
          section: 'dish',
          retryToken: 'dishes',
          retryable: opts.dishesListCaller !== undefined,
          title: 'Dishes',
          hint: 'Every set-up copy of a Recipe: what is waiting, what settings it '
            + 'has, and when it last ran. If a schedule, a trigger, or an '
            + 'on-its-own Recipe made it, it says so. Change it on that row, not here.',
          rows: dishRows(),
          actions: sectionActions('dishes'),
          loading,
          error: errors.dishes,
          mutationError: mutationErrors.dishes,
          emptyText: !dishesWired
            ? 'This server does not do dishes yet.'
            : filtered
              ? 'This Recipe has no dishes yet.'
              : 'No dishes yet. Putting a Recipe on a schedule or a trigger makes one.',
        });
      case 'triggers':
        return renderSection({
          section: 'event_trigger',
          retryToken: 'triggers',
          retryable: errors.triggers !== undefined
            ? opts.triggersListCaller !== undefined
            : opts.watchListCaller !== undefined,
          title: 'Triggers',
          hint: 'Recipes that run when your things change: mail, calendar, files, '
            + 'contacts. Each row shows what checks for changes, if anything does. '
            + 'Some services tell Recued themselves, so they need no checking.',
          // R21: the residual poll loops (no rendered trigger row claims
          // them) follow the trigger rows so a tripped loop stays visible.
          rows: [...triggerRows(), ...residualWatchRows()],
          loading,
          error: errors.triggers ?? errors.watches,
          mutationError: mutationErrors.triggers ?? mutationErrors.watches,
          emptyText: filtered
            ? 'Nothing sets this Recipe off.'
            : 'Nothing sets a Recipe off yet. Add one here, or from a Recipe in the library.',
          actions: sectionActions('triggers'),
        });
      case 'schedules':
        // D-266 — the missed-run card sits ABOVE the list, not inside a
        // row: it is one question about the outage, not an annotation on
        // each schedule. Empty string when nothing is waiting.
        return renderMissedRunsCard(missedRuns, {
          busy: missedRunsBusy,
          error: missedRunsError,
        }) + renderSection({
          section: 'schedule',
          retryToken: 'schedules',
          retryable: opts.schedulesListCaller !== undefined,
          title: 'Schedules',
          hint: 'Recipes that repeat, and one-off runs that have not happened yet.',
          rows: scheduleRows(),
          loading,
          error: errors.schedules,
          mutationError: mutationErrors.schedules,
          emptyText: filtered
            ? 'This Recipe has no schedule.'
            : 'No schedules yet. Add one here, or from a Recipe in the library.',
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
      data-recued-automation-back>Back to ${e(SECTION_LABEL[detailReturnSection ?? activeSection])}</button>`;
    const facts = (pairs: Array<[string, string]>): string =>
      `<dl class="automation-detail-facts">${pairs
        .map(([k, v]) => `<dt>${e(k)}</dt><dd>${v}</dd>`)
        .join('')}</dl>`;
    const heading = (content: string): string =>
      `<h2 class="automation-section-title" tabindex="-1" `
      + `${AUTOMATION_ROUTE_DETAIL_HEADING_ATTR}>${content}</h2>`;
    let body: string | null = null;
    if (activeSection === 'schedules') {
      const s = schedules.find((x) => x.schedule_id === detailId);
      if (s !== undefined) {
        body = `
          ${heading(`<a href="${e(recipeHref(s.recipe_id))}">${e(nameFor(s.recipe_id))}</a>`)}
          ${facts([
            ['Cadence', scheduleCadence(s)],
            ['State', e(detailStateLabel(s))],
            // D-266 — an overdue schedule must not show a future-looking
            // "Next run"; say what was due and how late it is.
            ...(detailLateness(s) === null
              ? [['Next run', e(s.enabled ? formatDateTime(s.next_run_at) : '—')] as [string, string]]
              : [['Due', e(`${formatDateTime(s.next_run_at)} · ${formatLateness(detailLateness(s)!)}`)] as [string, string]]),
            ['Last run', e(`${formatDateTime(s.last_run_at)}${s.last_status ? ` (${s.last_status})` : ''}`)],
            // D-266 — the forensic pair. `Last run` says when it stopped;
            // `Before that` says whether it was running normally before it
            // did, which is the question you actually have in front of a
            // stale or errored schedule. Shown as '—' rather than hidden:
            // "it has only ever run once" is itself an answer.
            ['Before that', e(formatDateTime(s.prev_run_at ?? null))],
            ...(s.missed_cycles === undefined
              ? []
              : [[
                'Missed since',
                e(s.missed_cycles === 'unknown'
                  ? 'at least one run'
                  : `${s.missed_cycles + 1} run${s.missed_cycles === 0 ? '' : 's'}`),
              ] as [string, string]]),
          ])}
          ${s.last_error ? `<p class="automation-row-error">${e(s.last_error)}</p>` : ''}
          <div class="automation-row-actions">
            <button type="button" class="automation-button" ${ACTION_ATTR}="toggle:schedule:${!s.enabled ? 'on' : 'off'}" ${ROW_ID_ATTR}="${e(s.schedule_id)}"${mutationBusyAttrs('schedule', s.schedule_id, 'toggle')}>${e(mutationToggleLabel('schedule', s.schedule_id, s.enabled ? 'Pause' : 'Resume', !s.enabled))}</button>
            ${s.preapproval ? renderPreapprovalButtons('schedule', s.schedule_id, s.preapproval.proposal_id)
              : opts.preapprovalPrepareCaller && opts.onPreapprovalPrepared && s.lifecycle_revision !== undefined
                  && canPreapprove('next_schedule')
                ? `<button type="button" class="automation-button" ${ACTION_ATTR}="preapprove:schedule" ${ROW_ID_ATTR}="${e(s.schedule_id)}">Look at the next run</button>` : ''}
            ${renderDeleteButtons('schedule', s.schedule_id)}
          </div>`;
      }
    } else if (activeSection === 'dishes' && detailId !== null) {
      const d = dishes.find((x) => x.dish_id === detailId);
      const runs = dishHistory?.dish_id === detailId ? dishHistory.runs : null;
      const historyError = dishHistoryError?.dish_id === detailId
        ? dishHistoryError.message
        : null;
      const historyLoading = dishHistoryRequest?.dish_id === detailId;
      const historyBlock = opts.dishesHistoryCaller === undefined
        ? ''
        : historyError !== null
          ? `<div class="automation-load-error"
              ${DISH_HISTORY_ERROR_ATTR}="${e(detailId)}"
              role="${historyLoading ? 'status' : 'alert'}">
              <span>Could not load run history: ${e(historyError)}</span>
              <button type="button" class="automation-button"
                ${DISH_HISTORY_RETRY_ATTR}="${e(detailId)}"
                ${historyLoading ? 'aria-disabled="true" aria-busy="true"' : ''}>
                ${historyLoading ? 'Retrying…' : 'Retry'}
              </button>
            </div>`
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
          ${heading(`<a href="${e(recipeHref(d.recipe_id))}">${e(dishTitle(d))}</a>`)}
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
          ${heading('Retired dish')}
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
        const fact = RunModal.describeMailFactTrigger(t, mailFactTemplates, mailFactTypes);
        body = `
          ${heading(`<a href="${e(recipeHref(t.recipe_id))}">${e(nameFor(t.recipe_id))}</a>`)}
          ${facts([
            fact !== null
              ? ['Starts on', e(fact)]
              : ['Pattern', `<code>${e(t.pattern)}</code>`],
            ['State', e(t.enabled ? 'On' : armed === 'tripped' ? 'Auto-disabled' : 'Paused')],
            ['Origin', e(t.origin === 'recipe' ? 'From a Recipe, looked after by Recued' : 'Manual')],
            ['Last fired', e(formatDateTime(t.last_fired_at))],
            ...(fact === null && t.fields && t.fields.length > 0
              ? [['Fields', e(t.fields.join(' / '))] as [string, string]]
              : []),
          ])}
          ${t.last_error ? `<p class="automation-row-error">${e(t.last_error)}</p>` : ''}
          ${pollStatusBlock(t)}
          <div class="automation-row-actions">
            <button type="button" class="automation-button" ${ACTION_ATTR}="toggle:event_trigger:${!t.enabled ? 'on' : 'off'}" ${ROW_ID_ATTR}="${e(t.trigger_id)}"${mutationBusyAttrs('event_trigger', t.trigger_id, 'toggle')}>${e(mutationToggleLabel('event_trigger', t.trigger_id, t.enabled ? 'Pause' : 'Resume', !t.enabled))}</button>
            ${t.preapproval ? renderPreapprovalButtons('event_trigger', t.trigger_id, t.preapproval.proposal_id)
              : opts.preapprovalPrepareCaller && opts.onPreapprovalPrepared && t.lifecycle_revision !== undefined
                  && canPreapprove('next_trigger')
                ? `<button type="button" class="automation-button" ${ACTION_ATTR}="preapprove:event_trigger" ${ROW_ID_ATTR}="${e(t.trigger_id)}">Look at the next run</button>` : ''}
            ${t.origin === 'recipe' ? '' : renderDeleteButtons('event_trigger', t.trigger_id)}
          </div>`;
      }
    } else {
      const a = autoRun.find((x) => autoRunId(x) === detailId);
      if (a !== undefined) {
        const tripped = a.enabled && a.auto_disabled;
        body = `
          ${heading(`<a href="${e(recipeHref(a.recipe_id))}">${e(a.recipe_name ?? a.recipe_id)}</a>`)}
          ${facts([
            ['Cadence', e(`every ${formatInterval(a.interval_ms)}${a.dynamic ? ' (dynamic)' : ''}`)],
            ['State', e(!a.enabled ? 'Paused' : tripped ? `Tripped (${a.consecutive_failures} failures)` : 'On')],
            ['Next run', e(a.enabled && !a.auto_disabled ? formatDateTime(a.next_run_at) : '—')],
            ['Last finished', e(formatDateTime(a.last_finished_at))],
          ])}
          ${a.last_failure_reason ? `<p class="automation-row-error">${e(a.last_failure_reason)}</p>` : ''}
          <div class="automation-row-actions">
            ${a.enabled && !a.auto_disabled && Object.keys(a.variables ?? {}).length > 0
              ? `<button type="button" class="automation-button" ${ACTION_ATTR}="configure:auto_run" ${ROW_ID_ATTR}="${e(autoRunId(a))}"${mutationBusyAttrs('auto_run', autoRunId(a), 'configure')}>Configure</button>`
              : ''}
            <button type="button" class="automation-button" ${ACTION_ATTR}="toggle:auto_run:${!a.enabled || a.auto_disabled ? 'on' : 'off'}" ${ROW_ID_ATTR}="${e(autoRunId(a))}"${mutationBusyAttrs('auto_run', autoRunId(a), 'toggle')}>${e(mutationToggleLabel('auto_run', autoRunId(a), !a.enabled ? 'Resume' : a.auto_disabled ? 'Re-arm' : 'Pause', !a.enabled || a.auto_disabled))}</button>
            ${a.preapproval ? renderPreapprovalButtons('auto_run', autoRunId(a), a.preapproval.proposal_id)
              : opts.preapprovalPrepareCaller && opts.onPreapprovalPrepared && a.lifecycle_revision !== undefined && !a.auto_disabled
                  && (a.dish_id ?? null) !== null && canPreapprove('next_auto_run')
                ? `<button type="button" class="automation-button" ${ACTION_ATTR}="preapprove:auto_run" ${ROW_ID_ATTR}="${e(autoRunId(a))}">Look at the next run</button>` : ''}
          </div>`;
      }
    }
    return `
      <section class="automation-detail" data-recued-automation-detail="${e(detailId ?? '')}">
        ${back}
        ${body ?? (loading
          ? '<p>Loading…</p>'
          : '<p>This rule no longer exists — it may have been removed.</p>')}
        <p class="automation-section-hint">Runs land in <a href="#logs">Logs<span aria-hidden="true">.</span></a></p>
      </section>`;
  };

  const focusRenderedDetailHeading = (): void => {
    const heading = routeRoot.querySelector?.(
      `[${AUTOMATION_ROUTE_DETAIL_HEADING_ATTR}]`,
    ) as HTMLElement | null | undefined;
    const fallback = routeRoot.querySelector?.(
      '[data-recued-automation-back]',
    ) as HTMLElement | null | undefined;
    (heading ?? fallback)?.focus?.({ preventScroll: true });
  };

  /** Keep a deep-linked or repainted active tab visible inside the narrow
   *  horizontal strip without moving the page vertically. `scrollIntoView`
   *  can also scroll ancestor containers, so adjust only this nav's own
   *  horizontal position from its painted geometry. */
  /** D-319 §5.4 — where focus lands in the nav: a view's own tab or, from a
   *  list by kind (it has no tab of its own), the nav's one keyboard stop. */
  const navTabFor = (token: string): HTMLElement | null | undefined =>
    (routeRoot.querySelector?.(`[${AUTOMATION_ROUTE_SUBNAV_ATTR}="${token}"]`)
      ?? routeRoot.querySelector?.(`[${AUTOMATION_ROUTE_SUBNAV_ATTR}][tabindex="0"]`)) as HTMLElement | null | undefined;

  const revealActiveSubnav = (): void => {
    const nav = routeRoot.querySelector?.(
      '.automation-subnav',
    ) as HTMLElement | null | undefined;
    const active = nav?.querySelector?.(
      `[${AUTOMATION_ROUTE_SUBNAV_ATTR}][aria-selected="true"]`,
    ) as HTMLElement | null | undefined;
    if (nav == null || active == null) return;
    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.left < navRect.left) {
      nav.scrollLeft -= navRect.left - activeRect.left;
    } else if (activeRect.right > navRect.right) {
      nav.scrollLeft += activeRect.right - navRect.right;
    }
  };

  const render = (): void => {
    // This route replaces every sub-nav button and native filter when state or
    // async reads repaint it. Preserve ownership only when one of those controls
    // currently has focus; otherwise activation detaches it and strands focus
    // on <body>.
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    const focusedRetryRaw = activeElement?.getAttribute?.(
      AUTOMATION_ROUTE_RETRY_ATTR,
    );
    const focusedRetry = focusedRetryRaw !== null
      && focusedRetryRaw !== undefined
      && isAutomationSectionToken(focusedRetryRaw)
        ? focusedRetryRaw
        : null;
    const focusedDishHistoryRetryRaw = activeElement?.getAttribute?.(
      DISH_HISTORY_RETRY_ATTR,
    );
    const focusedDishHistoryRetry =
      focusedDishHistoryRetryRaw !== null
      && focusedDishHistoryRetryRaw !== undefined
      && focusedDishHistoryRetryRaw.length > 0
        ? focusedDishHistoryRetryRaw
        : null;
    const focusedRecipeEntriesRetryRaw = activeElement?.getAttribute?.(
      AUTOMATION_ROUTE_ADD_RETRY_ATTR,
    );
    const focusedRecipeEntriesRetry =
      focusedRecipeEntriesRetryRaw !== null
      && focusedRecipeEntriesRetryRaw !== undefined
      && isAutomationCreateSectionToken(focusedRecipeEntriesRetryRaw)
        ? focusedRecipeEntriesRetryRaw
        : null;
    const focusedAddRaw = activeElement?.getAttribute?.(
      AUTOMATION_ROUTE_ADD_ATTR,
    );
    const focusedAdd =
      focusedAddRaw !== null
      && focusedAddRaw !== undefined
      && isAutomationCreateSectionToken(focusedAddRaw)
        ? focusedAddRaw
        : null;
    const focusedAddPicker =
      activeElement?.hasAttribute?.(RefPicker.REF_PICKER_INPUT_ATTR) === true
      && activeElement.closest?.(
        `[data-ref-picker="${ADD_PICKER_CONFIG.pickerId}"]`,
      ) !== null;
    if (pendingRetryFocus !== null) {
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false
        && focusedRetry !== pendingRetryFocus;
      if (liveOwnerMovedElsewhere) pendingRetryFocus = null;
    }
    if (pendingDishHistoryRetryFocus !== null) {
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false
        && focusedDishHistoryRetry !== pendingDishHistoryRetryFocus;
      if (liveOwnerMovedElsewhere) pendingDishHistoryRetryFocus = null;
    }
    if (pendingRecipeEntriesFocus !== null) {
      const stillOwnsRequest =
        focusedRecipeEntriesRetry === pendingRecipeEntriesFocus
        || focusedAdd === pendingRecipeEntriesFocus
        || (focusedAddPicker && addPickerFor === pendingRecipeEntriesFocus);
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false
        && !stillOwnsRequest;
      if (
        activeSection !== pendingRecipeEntriesFocus
        || detailId !== null
        || liveOwnerMovedElsewhere
      ) pendingRecipeEntriesFocus = null;
    }
    if (pendingModalReturnFocus !== null) {
      const focusedReturn =
        activeElement?.getAttribute?.(AUTOMATION_ROUTE_ADD_ATTR)
          === pendingModalReturnFocus;
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (
        activeSection !== pendingModalReturnFocus
        || detailId !== null
        || addPickerFor !== null
        || (!focusedReturn && liveOwnerMovedElsewhere)
      ) {
        pendingModalReturnFocus = null;
      }
    }
    const focusedDetailHeading = activeElement?.hasAttribute?.(
      AUTOMATION_ROUTE_DETAIL_HEADING_ATTR,
    ) === true;
    if (
      pendingActionFocus !== null
      && activeElement !== null
      && activeElement !== undefined
      && activeElement !== doc.body
      && !matchesActionFocus(activeElement, pendingActionFocus)
    ) {
      // Do not pull the user back to a completed mutation after they moved to
      // another control while its RPC was in flight.
      pendingActionFocus = null;
      pendingActionFallbackFocus = null;
    }
    const focusedSectionRaw = activeElement?.getAttribute?.(
      AUTOMATION_ROUTE_SUBNAV_ATTR,
    );
    const focusedSection = focusedSectionRaw !== null
      && focusedSectionRaw !== undefined
      && isAutomationSectionToken(focusedSectionRaw)
        ? focusedSectionRaw
        : null;
    const focusedFilter = activeElement?.hasAttribute?.(
      AUTOMATION_ROUTE_STATUS_FILTER_ATTR,
    ) === true
      ? 'status'
      : activeElement?.hasAttribute?.(AUTOMATION_ROUTE_ORIGIN_FILTER_ATTR)
        === true
        ? 'origin'
        : null;
    const focusedPickerShell = activeElement?.closest?.('[data-ref-picker]');
    const focusedPickerId = activeElement?.hasAttribute?.(
      RefPicker.REF_PICKER_INPUT_ATTR,
    ) === true
      ? focusedPickerShell?.getAttribute?.('data-ref-picker')
      : null;
    const focusedRoutePickerId = focusedPickerId === RECIPE_PICKER_CONFIG.pickerId
      || focusedPickerId === ADD_PICKER_CONFIG.pickerId
        ? focusedPickerId
        : null;
    const focusedPickerHandle = focusedRoutePickerId === RECIPE_PICKER_CONFIG.pickerId
      ? recipePicker
      : focusedRoutePickerId === ADD_PICKER_CONFIG.pickerId
        ? addPicker
        : null;
    const focusedPickerQuery = focusedRoutePickerId === null
      ? null
      : focusedPickerHandle?.getQuery()
        ?? (activeElement as HTMLInputElement).value;
    const focusedPickerCommittedLabel = focusedPickerHandle?.getValue()?.label ?? '';
    const focusedPickerSelection = focusedRoutePickerId === null
      ? null
      : {
          query: focusedPickerQuery !== focusedPickerCommittedLabel
            ? focusedPickerQuery
            : null,
          start: (activeElement as HTMLInputElement).selectionStart,
          end: (activeElement as HTMLInputElement).selectionEnd,
        };
    routeRoot.innerHTML = `
      <header class="automation-header">
        <h1 class="automation-title" ${AUTOMATION_ROUTE_HEADING_ATTR}>Automation</h1>
        <p class="automation-subtitle">What runs on its own, by Recipe: each Recipe you
        switched on, what starts it, and when it runs next. Switch any of them on or
        off here; runs land in <a href="#logs">Logs<span aria-hidden="true">.</span></a></p>
      </header>
      ${lockBanner()}
      ${subNav()}
      <div ${AUTOMATION_ROUTE_SECTION_PANEL_ATTR}
        id="recued-automation-section-panel" role="tabpanel"
        aria-labelledby="recued-automation-section-tab-${activeSection}">
        ${detailId !== null ? renderDetail() : `${filterBar()}${activeSectionHtml()}`}
      </div>
    `;
    if (focusedSection !== null) {
      const replacement = routeRoot.querySelector(
        `[${AUTOMATION_ROUTE_SUBNAV_ATTR}="${focusedSection}"]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    const retryFocus = pendingRetryFocus ?? focusedRetry;
    if (retryFocus !== null) {
      const replacement = routeRoot.querySelector?.(
        `[${AUTOMATION_ROUTE_RETRY_ATTR}="${retryFocus}"]`,
      ) as HTMLElement | null | undefined;
      const fallback = navTabFor(retryFocus);
      (replacement ?? (!loading ? fallback : null))
        ?.focus?.({ preventScroll: true });
    }
    const dishHistoryRetryFocus = pendingDishHistoryRetryFocus
      ?? focusedDishHistoryRetry;
    if (dishHistoryRetryFocus !== null) {
      const replacement = routeRoot.querySelector?.(
        `[${DISH_HISTORY_RETRY_ATTR}="${dishHistoryRetryFocus}"]`,
      ) as HTMLElement | null | undefined;
      const historyStillLoading =
        dishHistoryRequest?.dish_id === dishHistoryRetryFocus;
      const fallback = routeRoot.querySelector?.(
        `[${AUTOMATION_ROUTE_DETAIL_HEADING_ATTR}]`,
      ) as HTMLElement | null | undefined;
      (replacement ?? (!historyStillLoading ? fallback : null))
        ?.focus?.({ preventScroll: true });
      if (!historyStillLoading) pendingDishHistoryRetryFocus = null;
    }
    if (focusedFilter !== null) {
      const attr = focusedFilter === 'status'
        ? AUTOMATION_ROUTE_STATUS_FILTER_ATTR
        : AUTOMATION_ROUTE_ORIGIN_FILTER_ATTR;
      const replacement = routeRoot.querySelector(
        `[${attr}]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (pendingActionFocus !== null) {
      const replacement = findActionFocusTarget(pendingActionFocus)
        ?? (busy.has(pendingActionFocus.rule_id)
          || pendingActionFallbackFocus === null
          ? null
          : findActionFocusTarget(pendingActionFallbackFocus));
      const fallback = navTabFor(activeSection);
      (replacement ?? (busy.has(pendingActionFocus.rule_id) ? null : fallback))
        ?.focus?.({ preventScroll: true });
    }
    if (focusedDetailHeading) focusRenderedDetailHeading();
    if (detailId === null) {
      const focusedPickerReplacement = focusedRoutePickerId === null
        ? null
        : routeRoot.querySelector?.(
            `[data-ref-picker="${focusedRoutePickerId}"] `
            + `[${RefPicker.REF_PICKER_INPUT_ATTR}]`,
          ) as HTMLInputElement | null | undefined;
      // Restore focus before re-attaching the picker listeners. A committed
      // selection closes its popup; focusing only after rewire would look like
      // a fresh user focus and reopen the full inventory after every filter
      // repaint. An already-open picker still repaints open from handle state.
      focusedPickerReplacement?.focus?.({ preventScroll: true });
      // (Re-)attach the recipe-filter combobox to the freshly-painted shell.
      mountRecipePicker();
      // (Re-)attach / tear down the Add recipe picker (R21 create path).
      mountAddPicker();
      if (focusedRoutePickerId !== null) {
        const replacementHandle = focusedRoutePickerId === RECIPE_PICKER_CONFIG.pickerId
          ? recipePicker
          : addPicker;
        if (
          focusedPickerSelection !== null
          && focusedPickerSelection.query !== null
        ) {
          replacementHandle?.setQuery(focusedPickerSelection.query);
        }
        if (
          focusedPickerSelection !== null
          && focusedPickerSelection.start !== null
          && focusedPickerSelection.end !== null
        ) {
          focusedPickerReplacement?.setSelectionRange?.(
            focusedPickerSelection.start,
            focusedPickerSelection.end,
          );
        }
      }
      const recipeEntriesFocus = pendingRecipeEntriesFocus
        ?? focusedRecipeEntriesRetry;
      if (recipeEntriesFocus !== null && activeSection === recipeEntriesFocus) {
        const retry = routeRoot.querySelector?.(
          `[${AUTOMATION_ROUTE_ADD_RETRY_ATTR}="${recipeEntriesFocus}"]`,
        ) as HTMLElement | null | undefined;
        const add = routeRoot.querySelector?.(
          `[${AUTOMATION_ROUTE_ADD_ATTR}="${recipeEntriesFocus}"]`,
        ) as HTMLElement | null | undefined;
        const picker = routeRoot.querySelector?.(
          `[data-ref-picker="${ADD_PICKER_CONFIG.pickerId}"] `
          + `[${RefPicker.REF_PICKER_INPUT_ATTR}]`,
        ) as HTMLElement | null | undefined;
        const tab = navTabFor(recipeEntriesFocus);
        const replacement = recipeEntriesError !== null
          ? retry
          : addPickerFor === recipeEntriesFocus && recipeEntries !== null
            ? picker
            : addPickerFor === recipeEntriesFocus
              ? add
              : add ?? tab;
        replacement?.focus?.({ preventScroll: true });
        if (
          pendingRecipeEntriesFocus !== null
          && (
            recipeEntriesRequest === null
            || (addPickerFor !== recipeEntriesFocus && recipeEntriesError === null)
          )
        ) pendingRecipeEntriesFocus = null;
      }
    }
    if (pendingModalReturnFocus !== null) {
      const replacement = routeRoot.querySelector?.(
        `[${AUTOMATION_ROUTE_ADD_ATTR}="${pendingModalReturnFocus}"]`,
      ) as HTMLElement | null | undefined;
      const fallback = navTabFor(pendingModalReturnFocus);
      (replacement ?? fallback)?.focus?.({ preventScroll: true });
      if (!loading && (replacement ?? fallback) != null) {
        pendingModalReturnFocus = null;
      }
    }
    if (!loading && pendingRetryFocus !== null) pendingRetryFocus = null;
    revealActiveSubnav();
  };

  /** The templates and kinds a fact trigger's words name, read again with
   *  every triggers list that has one: a template renamed, switched off or
   *  deleted since reads as it now is. */
  const loadMailFactNames = (): void => {
    const templatesCaller = opts.mailFactTemplatesCaller;
    if (templatesCaller === undefined) return;
    if (!triggers.some((t) => RunModal.describeMailFactTrigger(t, null) !== null)) return;
    const seq = ++mailFactNamesSeq;
    void Promise.all([
      templatesCaller().then((result) => result.templates, () => null),
      opts.mailFactTypesCaller?.().then((result) => result.types, () => null) ?? Promise.resolve(null),
    ]).then(([templates, types]) => {
      if (disposed || seq !== mailFactNamesSeq) return;
      // A failed read keeps what was known: the words stay as they were.
      if (templates !== null) mailFactTemplates = templates;
      if (types !== null) mailFactTypes = types;
      if (templates !== null || types !== null) render();
    });
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
      missedRunsResult,
      namesResult,
      authStateResult,
      capabilitiesResult,
    ] = await Promise.allSettled([
      opts.schedulesListCaller
        ? opts.schedulesListCaller()
        : Promise.reject(new Error('Recued cannot list schedules here.')),
      opts.triggersListCaller
        ? opts.triggersListCaller()
        : Promise.reject(new Error('Recued cannot list triggers here.')),
      opts.watchListCaller
        ? opts.watchListCaller()
        : Promise.reject(new Error('Recued cannot list watchers here.')),
      opts.autoRunListCaller
        ? opts.autoRunListCaller()
        : Promise.reject(new Error('Recued cannot list Recipes that run on their own here.')),
      // D-215 slice 3 — SOFT enhancement, unlike the four core lists above.
      // An absent caller is a host that has not opted in, not a failure: it
      // must not put an error on `getLoadErrors()` (which every existing
      // host asserts on). `dishesWired` keeps the section from claiming
      // "no dishes yet" when the truth is "nobody asked".
      opts.dishesListCaller
        ? opts.dishesListCaller()
        : Promise.resolve(null),
      // D-266 soft enhancement — absent caller leaves the card off.
      opts.schedulesMissedCaller
        ? opts.schedulesMissedCaller()
        : Promise.resolve(null),
      // Soft enhancement — absent caller resolves to no names.
      opts.recipeNamesCaller
        ? opts.recipeNamesCaller()
        : Promise.resolve({ recipes: [] as ReadonlyArray<{ recipe_id: string; name?: string }> }),
      // R21.1 soft enhancement — absent caller leaves the lock banner off.
      opts.authStateCaller
        ? opts.authStateCaller()
        : Promise.resolve({ state: 'unlocked' as const }),
      // D-261 soft enhancement — absent/failing caller leaves the offer as-is.
      opts.preapprovalCapabilitiesCaller
        ? opts.preapprovalCapabilitiesCaller()
        : Promise.resolve(null),
    ]);
    if (disposed || seq !== loadSeq) return;

    if (capabilitiesResult.status === 'fulfilled' && capabilitiesResult.value !== null) {
      preapprovalCapabilities = capabilitiesResult.value;
    }
    // D-266 — a failed read leaves the PRIOR card standing rather than
    // blanking it: the misses it names are still outstanding, and
    // dropping the card would make the question disappear without
    // anyone answering it.
    if (missedRunsResult.status === 'fulfilled' && missedRunsResult.value !== null) {
      missedRuns = missedRunsResult.value;
      missedRunsError = null;
    }

    const next: AutomationLoadErrors = {};
    if (schedulesResult.status === 'fulfilled') {
      schedules = schedulesResult.value.schedules;
    } else {
      next.schedules = messageForError(schedulesResult.reason);
    }
    if (triggersResult.status === 'fulfilled') {
      triggers = triggersResult.value.triggers;
      loadMailFactNames();
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
    // D-319 — a recipe link (#automation/<recipe-id>) lands on the one list
    // narrowed to that recipe: every row of it is there, so nothing moves.
    if (
      deleteConfirmation !== null
      && !automationRuleExists(
        deleteConfirmation.section,
        deleteConfirmation.rule_id,
      )
    ) {
      deleteConfirmation = null;
      revokeConfirmation = null;
    }
    errors = next;
    loading = false;
    if (
      activeSection === 'dishes'
      && detailId !== null
      && opts.dishesHistoryCaller !== undefined
      && dishHistory?.dish_id !== detailId
      && dishHistoryError?.dish_id !== detailId
      && dishHistoryRequest?.dish_id !== detailId
    ) {
      // A URL can mount directly at #automation/dishes/<id>; unlike an
      // in-page Details click, that path has no click handler to start the
      // additive history read after the dish list resolves.
      loadDishHistory(detailId);
    }
    render();
  };

  const runMutation = async (
    rule_id: string,
    section: AutomationSectionKind,
    mutate: () => Promise<unknown>,
    focus?: AutomationActionFocus,
    fallbackFocus?: AutomationActionFocus | null,
    action?: AutomationActionFocus,
    focusAfterInitialRender = false,
  ): Promise<void> => {
    if (busy.has(rule_id)) return;
    if (focus !== undefined && !focusAfterInitialRender) {
      pendingActionFocus = focus;
      pendingActionFallbackFocus = fallbackFocus ?? null;
    }
    if (action !== undefined) busyActions.set(rule_id, action);
    busy.add(rule_id);
    render();
    if (focus !== undefined && focusAfterInitialRender) {
      pendingActionFocus = focus;
      pendingActionFallbackFocus = fallbackFocus ?? null;
      const replacement = findActionFocusTarget(focus);
      replacement?.focus?.({ preventScroll: true });
      replacement?.scrollIntoView?.({ block: 'nearest' });
    }
    try {
      await mutate();
      const { [sectionErrorKey(section)]: _cleared, ...rest } = mutationErrors;
      mutationErrors = rest;
    } catch (err) {
      mutationErrors = {
        ...mutationErrors,
        [sectionErrorKey(section)]: messageForError(err),
      };
    }
    // Re-list either way — on failure the fresh list shows the
    // authoritative state next to the preserved mutation error. The action
    // remains busy through this reconciliation; an acknowledged write is not
    // finished from the user's perspective until its authoritative row is
    // back on screen.
    try {
      await loadAll();
    } finally {
      busy.delete(rule_id);
      busyActions.delete(rule_id);
      if (!disposed) render();
      if (pendingActionFocus === focus) {
        pendingActionFocus = null;
        pendingActionFallbackFocus = null;
      }
    }
  };

  // D-179 — the auto-run config editor, for a host that makes no dishes
  // itself (`switchOnTimerRecipe`). Renders the recipe's variable widgets;
  // on confirm it sends them to `auto_run.update`, which (D-319) makes the
  // recipe's main dish from them. `mode: 'resume'` also switches the timer
  // on in the same call; `'edit'` leaves it as it is. Widget values are read
  // on confirm (native inputs hold their own state), so no re-render / caret
  // dance.
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
      copy: 'These settings are used every time it runs on its own.',
      confirmLabel: mode === 'resume' ? 'Resume' : 'Save',
      // A recipe's own settings (its mail template) are not a dish's (D-315).
      variables: entry.variables ?? {},
      currentOverlay: entry.config_overlay,
      ...(opts.fileRefSearchCaller !== undefined
        ? { fileRefSearch: opts.fileRefSearchCaller }
        : {}),
      // `mode: 'resume'` re-enables in the same call (arm-time is a config
      // adjustment point); `'edit'` leaves the enable state untouched.
      // D-319 — a row with no dish switches the recipe on: its main dish is
      // made from these settings. A dish's settings are the dish's (its
      // Settings); a timer has none of its own.
      onConfirm: (config) => {
        void runMutation(autoRunId(entry), 'auto_run', () =>
          caller({
            recipe_id: entry.recipe_id,
            ...(mode === 'resume' ? { enabled: true } : {}),
            config_overlay: config,
          }));
      },
      onClose: () => { autoRunConfigHandle = null; },
    });
  };

  /** The settings form's pickers: files, records of the recipe's pack, and
   *  the owner's mail templates — as on the recipe page. */
  const formPickers = (entry: ServerRecipeListEntry) => {
    const recordRefSearch = bindRecordRefSearchToRecipe(opts.recordRefSearchCaller, entry.recipe);
    return {
      ...(opts.fileRefSearchCaller !== undefined ? { fileRefSearch: opts.fileRefSearchCaller } : {}),
      ...(recordRefSearch !== undefined ? { recordRefSearch } : {}),
      ...(opts.mailTemplateCallers !== undefined ? { mailTemplates: opts.mailTemplateCallers } : {}),
    };
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
    const entry = (recipeEntries ?? []).find((r) => r.recipe_id === d.recipe_id);
    if (entry === undefined) return;
    closeAutoRunConfigModal();
    const mine = dishes.filter((dish) => dish.recipe_id === d.recipe_id);
    // D-319 §5.2 — the same form as the recipe page's Settings: the dish's
    // settings (a mail template too), in place, from its next run.
    autoRunConfigHandle = openDishForm({
      document: doc,
      mode: 'settings',
      entry,
      dishes: mine,
      dish: d,
      start: dishFormStart('settings', mine, d) ?? { ...d.config_overlay },
      callers: {
        ...(opts.dishesUpdateCaller !== undefined ? { update: opts.dishesUpdateCaller as never } : {}),
      },
      ...formPickers(entry),
      onSaved: () => { if (!disposed) void loadAll(); },
      onClose: () => { autoRunConfigHandle = null; },
    });
  };

  /** D-319 — a timer's recipe nobody switched on: the switch-on form (from
   *  what the install chose), where this host makes dishes; else the timer's
   *  own editor, whose settings make the main dish on the server. */
  const switchOnTimerRecipe = (entry: AutoRunStatusEntry): void => {
    if (opts.dishesCreateCaller !== undefined && opts.recipeEntriesCaller !== undefined) void makeDish(entry.recipe_id);
    else openAutoRunConfigModal(entry, 'resume');
  };

  /** D-319 §5.4 — make a dish with its settings asked: "Not switched on" →
   *  Switch on, and the Dishes section's Add dish. A first dish starts from
   *  what the install chose (Switch on, or Save settings for a recipe the
   *  owner runs); another starts from the main dish's settings. */
  const makeDish = async (recipe_id: string): Promise<void> => {
    if (doc === undefined || switchOnBusy.has(recipe_id) || autoRunConfigHandle !== null) return;
    const create = opts.dishesCreateCaller;
    if (create === undefined) return;
    switchOnBusy = new Set(switchOnBusy).add(recipe_id);
    const nextErrors = { ...mutationErrors };
    delete nextErrors.dishes;
    mutationErrors = nextErrors;
    render();
    const mineNow = (): Dish[] => dishes.filter((dish) => dish.recipe_id === recipe_id);
    let start: Record<string, unknown> | null = mineNow().length > 0 ? dishFormStart('add', mineNow()) : null;
    try {
      if (recipeEntries === null) await loadRecipeEntriesNow();
      if (start === null) {
        start = opts.dishesDefaultsCaller !== undefined
          ? { ...(await opts.dishesDefaultsCaller({ recipe_id })).config_overlay }
          : {};
      }
    } catch (error) {
      if (!disposed) {
        mutationErrors = { ...mutationErrors, dishes: `Recued could not read what this recipe starts from: ${messageForError(error)}` };
      }
      switchOnBusy = new Set([...switchOnBusy].filter((id) => id !== recipe_id));
      if (!disposed) render();
      return;
    }
    switchOnBusy = new Set([...switchOnBusy].filter((id) => id !== recipe_id));
    if (disposed) return;
    render();
    const entry = (recipeEntries ?? []).find((r) => r.recipe_id === recipe_id);
    if (entry === undefined || autoRunConfigHandle !== null) return;
    if (!dishable(recipe_id)) {
      // A control painted before the list said so: the server refuses this
      // switch, so say why here instead of opening a form it would refuse.
      mutationErrors = { ...mutationErrors, dishes: `${nameFor(recipe_id)}: ${NOT_INSTALLED_TEXT} Install it from Packs to switch it on.` };
      render();
      return;
    }
    const mine = mineNow();
    const mode: DishFormMode = mine.length > 0 ? 'add'
      : startsOnItsOwn(entry.recipe) ? 'switch-on' : 'save-settings';
    autoRunConfigHandle = openDishForm({
      document: doc,
      mode,
      entry,
      dishes: mine,
      start,
      callers: {
        create: create as never,
        ...(opts.schedulesCreateCaller !== undefined ? { schedulesCreate: opts.schedulesCreateCaller as never } : {}),
      },
      ...formPickers(entry),
      onCreated: (_dish, scheduleError) => {
        if (scheduleError !== null && !disposed) {
          mutationErrors = {
            ...mutationErrors,
            dishes: `${mode === 'switch-on' ? 'Switched on' : 'Saved'}, but Recued could not add the schedule: ${messageForError(scheduleError)}`,
          };
        }
      },
      onSaved: () => { if (!disposed) void loadAll(); },
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
    focus?: AutomationActionFocus,
  ): void => {
    const action = { verb: 'toggle', section, rule_id } satisfies AutomationActionFocus;
    if (section === 'schedule' && opts.schedulesUpdateCaller) {
      void runMutation(rule_id, section, () =>
        opts.schedulesUpdateCaller!({ schedule_id: rule_id, enabled }), focus, undefined, action);
    } else if (section === 'event_trigger' && opts.triggersUpdateCaller) {
      void runMutation(rule_id, section, () =>
        opts.triggersUpdateCaller!({ trigger_id: rule_id, enabled }), focus, undefined, action);
    } else if (section === 'watch' && opts.watchUpdateCaller) {
      void runMutation(rule_id, section, () =>
        opts.watchUpdateCaller!({ watch_key: rule_id, enabled }), focus, undefined, action);
    } else if (section === 'dish') {
      // D-215 slice 4 — route by write target, never by "it's a dish".
      const d = dishes.find((x) => x.dish_id === rule_id);
      if (d === undefined) return;
      const target = dishWriteTarget(d);
      if (target.kind === 'own' && opts.dishesUpdateCaller) {
        void runMutation(rule_id, section, () =>
          opts.dishesUpdateCaller!({ dish_id: rule_id, enabled }), focus, undefined, action);
      } else if (target.kind === 'one_shot' && opts.schedulesUpdateCaller) {
        // The § 3 exception: inline for the OWNER, but the write lands on
        // the schedule — `dishes.update` would be refused by the slice-0
        // guard, and rightly so.
        void runMutation(rule_id, section, () =>
          opts.schedulesUpdateCaller!({ schedule_id: target.schedule_id, enabled }), focus, undefined, action);
      }
    } else if (section === 'auto_run' && opts.autoRunUpdateCaller) {
      const entry = autoRun.find((a) => autoRunId(a) === rule_id);
      // D-319 — switching on a recipe nobody switched on asks for its settings
      // first (the switch-on form); a variable-less one just switches on. A
      // dish's timer switches alone: its settings are the dish's.
      if (enabled && entry && (entry.dish_id ?? null) === null && Object.keys(entry.variables ?? {}).length > 0) {
        switchOnTimerRecipe(entry);
        return;
      }
      void runMutation(rule_id, section, () =>
        opts.autoRunUpdateCaller!(entry?.dish_id
          ? { dish_id: entry.dish_id, enabled }
          : { recipe_id: entry?.recipe_id ?? rule_id, enabled }), focus, undefined, action);
    }
  };

  const onRunNow = (
    section: AutomationSectionKind,
    rule_id: string,
    focus?: AutomationActionFocus,
  ): void => {
    if (section === 'watch' && opts.watchRunNowCaller) {
      void runMutation(rule_id, section, () =>
        opts.watchRunNowCaller!({ watch_key: rule_id }), focus, undefined, {
          verb: 'run', section, rule_id,
        });
    }
  };

  const onDelete = (
    section: AutomationSectionKind,
    rule_id: string,
    focus?: AutomationActionFocus,
  ): void => {
    const action = {
      verb: focus?.verb ?? 'delete-confirm',
      section,
      rule_id,
    } satisfies AutomationActionFocus;
    const fallbackFocus = focus === undefined
      ? undefined
      : deletionFallbackFocus(section, rule_id);
    if (section === 'schedule' && opts.schedulesDeleteCaller) {
      void runMutation(
        rule_id,
        section,
        () => opts.schedulesDeleteCaller!({ schedule_id: rule_id }),
        focus,
        fallbackFocus,
        action,
      );
    } else if (section === 'event_trigger' && opts.triggersDeleteCaller) {
      void runMutation(
        rule_id,
        section,
        () => opts.triggersDeleteCaller!({ trigger_id: rule_id }),
        focus,
        fallbackFocus,
        action,
      );
    } else if (section === 'dish') {
      const d = dishes.find((x) => x.dish_id === rule_id);
      if (d === undefined) return;
      const target = dishWriteTarget(d);
      if (target.kind === 'own' && opts.dishesDeleteCaller) {
        void runMutation(
          rule_id,
          section,
          () => opts.dishesDeleteCaller!({ dish_id: rule_id }),
          focus,
          fallbackFocus,
          action,
        );
      } else if (target.kind === 'one_shot' && opts.schedulesDeleteCaller) {
        // D-215 § 5.2 — THE DISPOSAL PATH for a retained one-shot (an
        // errored or skipped fire is kept, disabled, and cleared BY HAND).
        // Deleting the SCHEDULE is what retires the pair: `retireSchedule`
        // drops the row and dissolves the dish behind it. Calling
        // `dishes.delete` here would be refused by the slice-0 guard AND
        // would orphan the schedule if it were not.
        void runMutation(
          rule_id,
          section,
          () => opts.schedulesDeleteCaller!({ schedule_id: target.schedule_id }),
          focus,
          fallbackFocus,
          action,
        );
      }
    }
  };

  const activateSection = (token: AutomationSectionToken): boolean => {
    if (busy.size > 0) {
      focusPendingMutationOwner();
      return false;
    }
    if (token === activeSection) return true;
    activeSection = token;
    // Switching sections leaves any open detail (it belongs to the
    // previous section), closes an open Add disclosure (per-section
    // state — returning later shouldn't resurrect it; codex R21 LOW),
    // and supersedes a pending legacy auto-pick.
    detailId = null;
    detailReturnSection = null;
    pendingDishHistoryRetryFocus = null;
    pendingRecipeEntriesFocus = null;
    addPickerFor = null;
    deleteConfirmation = null;
    revokeConfirmation = null;
    pendingModalReturnFocus = null;
    syncHash('replace');
    render();
    return true;
  };

  const onSubnavKeyDown = (ev: Event): void => {
    const event = ev as KeyboardEvent;
    const tab = (event.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${AUTOMATION_ROUTE_SUBNAV_ATTR}]`);
    if (tab === null || tab === undefined) return;
    const token = tab.getAttribute(AUTOMATION_ROUTE_SUBNAV_ATTR);
    if (token === null || !isAutomationSectionToken(token)) return;
    const currentIndex = Math.max(0, AUTOMATION_VIEW_TOKENS.indexOf(token));
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % AUTOMATION_VIEW_TOKENS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (
        currentIndex - 1 + AUTOMATION_VIEW_TOKENS.length
      ) % AUTOMATION_VIEW_TOKENS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = AUTOMATION_VIEW_TOKENS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = AUTOMATION_VIEW_TOKENS[nextIndex]!;
    if (!activateSection(next)) return;
    const replacement = routeRoot.querySelector?.(
      `[${AUTOMATION_ROUTE_SUBNAV_ATTR}="${next}"]`,
    ) as HTMLElement | null | undefined;
    replacement?.focus?.({ preventScroll: true });
  };

  /** D-266 — answer the missed-run card.
   *
   *  ⚠ RE-READS THE REPORT RATHER THAN CLEARING IT LOCALLY. The server
   *  recomputes what is outstanding, so the authoritative answer to
   *  "is anything still waiting?" is its next read — and a regular
   *  cycle that fired between the render and the click has already
   *  resolved some of what the card showed. */
  const answerMissedRuns = async (
    answer: MissedRunsAnswer,
    recipe_id?: string,
  ): Promise<void> => {
    const call = opts.schedulesAnswerMissedCaller;
    if (call === undefined || missedRunsBusy) return;
    missedRunsBusy = true;
    missedRunsError = null;
    render();
    try {
      await call(recipe_id === undefined ? { answer } : { answer, recipe_ids: [recipe_id] });
      if (disposed) return;
      // 'run' only GRANTS the catch-up; the scheduler fires it on its
      // next tick, so the schedule list is refreshed here for the
      // status/timestamps and again whenever the route next loads.
      missedRuns = opts.schedulesMissedCaller
        ? await opts.schedulesMissedCaller()
        : null;
    } catch (err) {
      if (disposed) return;
      missedRunsError = err instanceof Error ? err.message : String(err);
    } finally {
      if (!disposed) {
        missedRunsBusy = false;
        render();
      }
    }
  };

  const onClick = (ev: Event): void => {
    // D-266 — the missed-run card's two buttons. Probed first because
    // the card is outside the section's row machinery entirely.
    const missedRunsButton = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${MISSED_RUNS_ACTION_ATTR}]`) as
      | HTMLElement
      | null
      | undefined;
    if (missedRunsButton) {
      const parsed = parseMissedRunsAction(
        missedRunsButton.getAttribute(MISSED_RUNS_ACTION_ATTR),
      );
      if (parsed !== null) void answerMissedRuns(parsed.answer, parsed.recipe_id);
      return;
    }
    const dishHistoryRetryButton = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${DISH_HISTORY_RETRY_ATTR}]`) as
      | HTMLElement
      | null
      | undefined;
    if (dishHistoryRetryButton) {
      const dishId = dishHistoryRetryButton.getAttribute(
        DISH_HISTORY_RETRY_ATTR,
      );
      if (
        dishId === null
        || activeSection !== 'dishes'
        || detailId !== dishId
        || dishHistoryRequest?.dish_id === dishId
      ) return;
      pendingDishHistoryRetryFocus =
        doc.activeElement === dishHistoryRetryButton ? dishId : null;
      if (loadDishHistory(dishId)) render();
      return;
    }
    const recipeEntriesRetryButton = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${AUTOMATION_ROUTE_ADD_RETRY_ATTR}]`) as
      | HTMLElement
      | null
      | undefined;
    if (recipeEntriesRetryButton) {
      const section = recipeEntriesRetryButton.getAttribute(
        AUTOMATION_ROUTE_ADD_RETRY_ATTR,
      );
      if (
        section === null
        || !isAutomationCreateSectionToken(section)
        || activeSection !== section
        || recipeEntriesError === null
        || recipeEntriesRequest !== null
      ) return;
      pendingRecipeEntriesFocus =
        doc.activeElement === recipeEntriesRetryButton ? section : null;
      if (loadRecipeEntries(true)) render();
      return;
    }
    const retryButton = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${AUTOMATION_ROUTE_RETRY_ATTR}]`) as
      | HTMLElement
      | null
      | undefined;
    if (retryButton) {
      const token = retryButton.getAttribute(AUTOMATION_ROUTE_RETRY_ATTR);
      if (token === null || !isAutomationSectionToken(token) || loading) return;
      pendingRetryFocus = doc.activeElement === retryButton ? token : null;
      void loadAll();
      return;
    }
    // R21 detail — the back button returns to the section list.
    const backButton = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.('[data-recued-automation-back]');
    if (backButton) {
      const returnFocus = detailId === null
        ? null
        : {
            verb: 'detail',
            section: actionSectionForToken(activeSection),
            rule_id: detailId,
          } satisfies AutomationActionFocus;
      detailId = null;
      pendingDishHistoryRetryFocus = null;
      if (detailReturnSection !== null) {
        activeSection = detailReturnSection;
        detailReturnSection = null;
      }
      syncHash('replace');
      render();
      const replacement = returnFocus === null
        ? null
        : findActionFocusTarget(returnFocus);
      (replacement ?? navTabFor(activeSection))?.focus?.({ preventScroll: true });
      return;
    }
    // R21 create path — the per-section Add disclosure.
    const add = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${AUTOMATION_ROUTE_ADD_ATTR}]`);
    if (add) {
      const section = add.getAttribute(AUTOMATION_ROUTE_ADD_ATTR);
      if (section === 'triggers' || section === 'schedules' || section === 'dishes') {
        const opening = addPickerFor !== section;
        addPickerFor = opening ? section : null;
        pendingRecipeEntriesFocus =
          opening && recipeEntries === null && doc.activeElement === add
            ? section
            : null;
        if (addPickerFor !== null) void loadRecipeEntries();
        render();
        // `render()` replaces both the disclosure button and, when opening,
        // introduces a new combobox. Keep the keyboard path continuous:
        // enter the disclosed picker, or return to the replacement toggle
        // when the user closes it.
        const focusTarget = opening
          ? recipeEntriesError !== null
            ? routeRoot.querySelector?.(
                `[${AUTOMATION_ROUTE_ADD_RETRY_ATTR}="${section}"]`,
              )
            : recipeEntries !== null
              ? routeRoot.querySelector?.(
                  `[data-ref-picker="${ADD_PICKER_CONFIG.pickerId}"] `
                  + `[${RefPicker.REF_PICKER_INPUT_ATTR}]`,
                )
              : routeRoot.querySelector?.(
                  `[${AUTOMATION_ROUTE_ADD_ATTR}="${section}"]`,
                )
          : routeRoot.querySelector?.(
              `[${AUTOMATION_ROUTE_ADD_ATTR}="${section}"]`,
            );
        (focusTarget as HTMLElement | null | undefined)?.focus?.({ preventScroll: true });
      }
      return;
    }
    // R21 sub-nav — tab clicks flip the visible section + sync the hash.
    const tab = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${AUTOMATION_ROUTE_SUBNAV_ATTR}]`);
    if (tab) {
      if (busy.size > 0) {
        focusPendingMutationOwner();
        return;
      }
      const token = tab.getAttribute(AUTOMATION_ROUTE_SUBNAV_ATTR);
      if (token !== null && isAutomationSectionToken(token)) {
        activateSection(token);
      }
      return;
    }
    // D-319 §5.4 — the one list's filter chips (a second press clears it).
    const chip = (ev.target as (Element & {
      closest?: (selector: string) => Element | null;
    }) | null)?.closest?.(`[${AUTOMATION_CHIP_ATTR}]`);
    if (chip) {
      const value = chip.getAttribute(AUTOMATION_CHIP_ATTR);
      if (value !== null && isAutomationChip(value)) {
        chipFilter = chipFilter === value ? null : value;
        render();
        (routeRoot.querySelector?.(`[${AUTOMATION_CHIP_ATTR}="${value}"]`) as HTMLElement | null | undefined)
          ?.focus?.({ preventScroll: true });
      }
      return;
    }
    const target = targetWithAction(ev);
    if (target === null) return;
    const action = target.getAttribute(ACTION_ATTR);
    const ruleId = target.getAttribute(ROW_ID_ATTR);
    if (action === null || ruleId === null || ruleId.length === 0) return;
    // D-319 §5.4 — a recipe nobody switched on: the switch-on form.
    if (action === 'switch-on:recipe') {
      void makeDish(ruleId);
      return;
    }
    const [verb, section, to] = action.split(':') as [
      string,
      AutomationSectionKind,
      string | undefined,
    ];
    // Details is read-only — it must work DURING a mutation (codex R21
    // LOW: the button renders enabled, so a busy-guard swallow would be
    // a dead click). Mutating verbs stay busy-guarded below.
    if (verb === 'detail') {
      // D-319 §5.4 — from the one list, a rule's Details open in its own
      // kind's section; Back returns to the list.
      const own = sectionTokenForKind(section);
      if (own !== null && own !== activeSection) {
        detailReturnSection = activeSection;
        activeSection = own;
      }
      detailId = ruleId;
      if (section === 'dish') {
        dishHistory = null;
        dishHistoryError = null;
        pendingDishHistoryRetryFocus = null;
        loadDishHistory(ruleId);
      }
      syncHash('push');
      render();
      focusRenderedDetailHeading();
      return;
    }
    if (busy.has(ruleId)) return;
    if (verb === 'toggle') {
      onToggle(section, ruleId, to === 'on', doc.activeElement === target
        ? { verb, section, rule_id: ruleId }
        : undefined);
    } else if (verb === 'delete') {
      if (!automationRuleExists(section, ruleId)) return;
      deleteConfirmation = { section, rule_id: ruleId };
      render();
      const confirm = findActionFocusTarget({
        verb: 'delete-confirm',
        section,
        rule_id: ruleId,
      });
      confirm?.focus?.({ preventScroll: true });
      confirm?.scrollIntoView?.({ block: 'nearest' });
    } else if (verb === 'delete-cancel') {
      if (!confirmingDeleteFor(section, ruleId)) return;
      deleteConfirmation = null;
      revokeConfirmation = null;
      render();
      const remove = findActionFocusTarget({
        verb: 'delete',
        section,
        rule_id: ruleId,
      });
      remove?.focus?.({ preventScroll: true });
      remove?.scrollIntoView?.({ block: 'nearest' });
    } else if (verb === 'delete-confirm') {
      if (!confirmingDeleteFor(section, ruleId)) return;
      onDelete(
        section,
        ruleId,
        doc.activeElement === target
          ? { verb, section, rule_id: ruleId }
          : undefined,
      );
    } else if (verb === 'preapproval-remove') {
      if (!automationRuleExists(section, ruleId)) return;
      revokeConfirmation = { section, rule_id: ruleId };
      render();
      const confirm = findActionFocusTarget({
        verb: 'preapproval-remove-confirm',
        section,
        rule_id: ruleId,
      });
      confirm?.focus?.({ preventScroll: true });
      confirm?.scrollIntoView?.({ block: 'nearest' });
    } else if (verb === 'preapproval-remove-cancel') {
      if (!confirmingRevokeFor(section, ruleId)) return;
      revokeConfirmation = null;
      render();
      const remove = findActionFocusTarget({
        verb: 'preapproval-remove',
        section,
        rule_id: ruleId,
      });
      remove?.focus?.({ preventScroll: true });
      remove?.scrollIntoView?.({ block: 'nearest' });
    } else if (verb === 'preapproval-remove-confirm') {
      if (!confirmingRevokeFor(section, ruleId)) return;
      const remove = opts.preapprovalRemoveCaller;
      if (remove === undefined) return;
      const proposalId = preapprovalProposalFor(section, ruleId);
      if (proposalId === null) return;
      const requestId = revokeRequestIdFor(section, ruleId);
      const action = doc.activeElement === target
        ? { verb, section, rule_id: ruleId }
        : undefined;
      void runMutation(
        ruleId,
        section,
        async () => {
          await remove(proposalId, requestId);
          // Kept only until the revocation is known to have landed: a retry
          // must replay the SAME request, a fresh arm must not.
          revokeRequestIds.delete(`${section}:${ruleId}`);
          revokeConfirmation = null;
        },
        action,
        undefined,
        action,
      );
    } else if (verb === 'rename' && section === 'dish') {
      renamingDishId = ruleId;
      render();
      focusDishRenameInput(ruleId);
    } else if (verb === 'rename-cancel' && section === 'dish') {
      const ownsFocus = doc.activeElement === target;
      renamingDishId = null;
      render();
      if (ownsFocus) focusDishRenameAction(ruleId);
    } else if (verb === 'rename-save' && section === 'dish') {
      const ownsFocus = doc.activeElement === target;
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
        const focus = ownsFocus
          ? { verb: 'rename', section: 'dish', rule_id: ruleId } as const
          : undefined;
        void runMutation(
          ruleId,
          'dish',
          () => caller({ dish_id: ruleId, name: next }),
          focus,
          undefined,
          { verb: 'rename', section: 'dish', rule_id: ruleId },
          true,
        );
      } else {
        render();
        if (ownsFocus) focusDishRenameAction(ruleId);
      }
    } else if (verb === 'configure' && section === 'dish') {
      const d = dishes.find((x) => x.dish_id === ruleId);
      if (d !== undefined) openDishConfigModal(d);
    } else if (verb === 'preapprove' && (section === 'auto_run' || section === 'event_trigger' || section === 'schedule')) {
      const entry = section === 'auto_run' ? autoRun.find(a => autoRunId(a) === ruleId)
        : section === 'event_trigger' ? triggers.find(t => t.trigger_id === ruleId) : schedules.find(s => s.schedule_id === ruleId);
      if (!entry || entry.lifecycle_revision === undefined || entry.preapproval || ('auto_disabled' in entry && entry.auto_disabled)
        || !opts.preapprovalPrepareCaller || !opts.onPreapprovalPrepared) return;
      // D-319 — a timer's next run is one dish's; a recipe with no dish has none.
      if (section === 'auto_run' && (!('dish_id' in entry) || (entry.dish_id ?? null) === null)) return;
      preapprovalActivation?.destroy();
      preapprovalActivation = openPreapprovalActivation({ document: doc, recipe_id: entry.recipe_id,
        publisher_id: entry.publisher_id, name: ('recipe_name' in entry ? entry.recipe_name : nameFor(entry.recipe_id)) ?? entry.recipe_id,
        activation: section === 'auto_run'
          ? { kind: 'next_auto_run', recipe_id: entry.recipe_id,
            publisher_id: entry.publisher_id, dish_id: entry.dish_id!, expected_revision: entry.lifecycle_revision }
          : section === 'event_trigger' ? { kind: 'next_trigger', trigger_id: ruleId, expected_revision: entry.lifecycle_revision }
            : { kind: 'next_schedule', schedule_id: ruleId, expected_revision: entry.lifecycle_revision },
        scheduledFor: 'next_run_at' in entry ? entry.next_run_at : null,
        prepare: opts.preapprovalPrepareCaller, onPrepared: opts.onPreapprovalPrepared,
        onClose: () => { preapprovalActivation = null; },
      });
    } else if (verb === 'configure' && section === 'auto_run') {
      // D-319 — a timer's settings are its dish's: edit the dish. A recipe
      // nobody switched on configures by switching on (its settings form).
      const entry = autoRun.find((a) => autoRunId(a) === ruleId);
      const dish = entry?.dish_id ? dishes.find((d) => d.dish_id === entry.dish_id) : undefined;
      if (dish !== undefined) openDishConfigModal(dish);
      else if (entry && (entry.dish_id ?? null) === null) switchOnTimerRecipe(entry);
    } else if (verb === 'run') {
      onRunNow(section, ruleId, doc.activeElement === target
        ? { verb, section, rule_id: ruleId }
        : undefined);
    }
  };

  // R21 filters — the status/origin selects (change event; the recipe
  // combobox has its own wiring).
  const onFilterChange = (ev: Event): void => {
    const target = ev.target as (Element & { value?: string }) | null;
    if (target === null || typeof target.hasAttribute !== 'function') return;
    if (busy.size > 0) {
      focusPendingMutationOwner();
      return;
    }
    if (target.hasAttribute(AUTOMATION_ROUTE_STATUS_FILTER_ATTR)) {
      statusFilter = asStatusFilter(target.value);
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
  routeRoot.addEventListener('keydown', onSubnavKeyDown);

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
  const hasAutomationInFlightWork = (): boolean =>
    busy.size > 0
    || openModal?.hasInFlightWork() === true
    || preapprovalActivation?.hasInFlightWork() === true
    || autoRunConfigHandle?.hasInFlightWork() === true;

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
    hasInFlightWork: hasAutomationInFlightWork,
    inFlightWorkPrompt: () =>
      hasAutomationInFlightWork()
        ? 'Something is still happening here. Leave anyway?'
        : null,
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
      preapprovalActivation?.destroy();
      preapprovalActivation = null;
      routeRoot.removeEventListener('click', onClick);
      routeRoot.removeEventListener('change', onFilterChange);
      routeRoot.removeEventListener('keydown', onSubnavKeyDown);
      try {
        while (routeRoot.firstChild) routeRoot.removeChild(routeRoot.firstChild);
        opts.root.removeChild(routeRoot);
      } catch {
        // Test fakes may detach the host first.
      }
    },
  };
};
