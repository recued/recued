/** R24 — top-level Recipes route (list -> detail).
 *
 *  This is the "what can Recued do?" run library. It lists the installed
 *  recipes (search + trigger / pack filters), and a durable
 *  `#recipes/<slug>` detail view shows one recipe's header, a read-only
 *  definition inspect, the depends-on / grant provenance (links to Packs +
 *  Contracts), and links out to its Runs (#logs) and Automation
 *  (#automation). Tool exposure is per-(recipe × contract) — granted in
 *  `#contracts`, never toggled here (a recipe can be exposed through one
 *  contract and not another, so a single per-recipe toggle would misread).
 *
 *  Pack install/uninstall lives at the dedicated `#packs` route now (the
 *  recipes route only keeps the by-pack FILTER, driven by each recipe's
 *  `depends_on`). Manual recipes run / schedule through the shared modal;
 *  reactive recipes expose their actual lifecycle control instead (auto-run
 *  pause / arm, or trigger management at `#automation`).
 *  Grant editing stays in `#contracts`. Recipes get NO contract-access editing
 *  here (R23): pack-ops are shared across recipes, so an op toggle shown
 *  in a recipe's context would falsely read as recipe-local.
 */

import type {
  AutoRunStatusEntry,
  ConnectionView,
  EventTrigger,
  PackListEntry,
  RecipePiiDisclosureEntry,
  RecipeInvocation,
  ResolvedFilterDescriptor,
  RecipePiiPostureSummary,
  RecipeRunnabilityEntry,
  RunnabilityStatus,
  Dish,
  DishLastRun,
  RecipeDefinition,
  ServerExecuteResponse,
  ServerRecipeFullEntry,
  ServerRecipeListEntry,
  ServerSchedule,
  ToolCatalogEntryView,
} from '@recued/contracts';
import { recipeConsumedEnrichments, recipeNotificationChannels } from '@recued/contracts';
import { DEFAULT_INSTANCE_PREFS, getPref } from '@recued/contracts';
import type { InstancePrefs } from '@recued/contracts';
import type {
  ResolvedTableEditDescriptor,
  ResolvedTableSelectDescriptor,
} from '@recued/contracts';
import { openPreapprovalActivation } from '../approvals/preapproval-activation.js';
import { mainDishSettings, type MainDishSettings } from './main-dish-settings.js';
import {
  dishFormStart,
  openDishForm as openSharedDishForm,
  type DishFormMode,
} from './dish-form.js';
import {
  RUNNING_AS_ACTION_ATTR,
  RUNNING_AS_ACTIONS,
  RUNNING_AS_DISH_ATTR,
  RUNNING_AS_FOCUS_AFTER,
  RUNNING_AS_RECIPE_ATTR,
  RUNNING_AS_STYLES,
  isInstalledRecipeEntry,
  renderRunningAs,
  renderSwitchOnButton,
  runningAsFocusKey,
  startsOnItsOwn,
  type RunningAsAction,
} from './running-as.js';
import { preapprovalHref } from '../approvals/preapproval-route.js';
import {
  describeCron,
  isResolvedRecordColumnsDescriptor,
  parseRecipeBundleKey,
  resolveRecipeBundleInstallPack,
} from '@recued/contracts';
import {
  formatValue,
  renderAiAnalysisBlock,
  renderCopyableBlock,
  renderJsonBlock,
  renderLinkButtonBlock,
  renderRecordFieldsBlock,
} from '@recued/renderer';
import {
  e,
  anyTableEditDirty,
  beginTableEditSubmit,
  canSubmitTableEdit,
  failTableEditSubmit,
  formatClientDateTime,
  initialTableEditState,
  outputTableEditConfig,
  outputTableEditInvocation,
  addRow as gridAddRow,
  removeRow as gridRemoveRow,
  setCell as gridSetCell,
  type OutputTableEditState,
  beginTableSelectSubmit,
  canSubmitTableSelect,
  failTableSelectSubmit,
  initialTableSelectState,
  outputTableSelectConfig,
  outputTableSelectInvocation,
  setAllTableSelection,
  tableSelectAllState,
  toggleTableSelection,
  type OutputTableSelectState,
  RefPicker,
  dedupeOutputRowsById,
  initialOutputFilterState,
  isInvocationVariable,
  isResolvedFilterDescriptor,
  outputFilterInvocation,
  outputFilterKey,
  outputFilterPageConfig,
  outputFilterSearchConfig,
  readWidgetValue,
  renderRecipeCard,
  renderProvenance,
  renderVariableWidget,
  missingPackRefsFromRunnability,
  runnabilityDisclosureLines,
  setOutputFilterDraftValue,
  toWidgetShape,
  validateOutputFilterDraft,
  RunModal,
  wireConfigEditorOverlay,
  plainSettingText,
  type SettingValueText,
  type ConfigEditorOverlayHandle,
  type MailTemplateVariableCallers,
  type RecipeCardState,
  type RecipeCardTriggerKind,
  type OutputFilterState,
} from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { HeldRunFollower } from '../held-run-follow.js';
import { bindRecordRefSearchToRecipe } from '../record-ref-search.js';
import {
  autoRunStateOf,
  autoRunToggle as paletteAutoRunToggle,
  classifyRecipeAction,
} from './recipe-action-kind.js';
import {
  createHierarchicalHistory,
  hierarchicalAddress,
  hierarchicalLevel,
} from '../shell/hierarchical-navigation.js';
import { serializeShellRoute } from '../shell/route.js';
import {
  recipeRequiredConnections,
  type RequiredConnection,
} from '@recued/contracts';
import {
  packSlugLabel,
  recipeIsStandalone,
  recipePackRefs,
  type RecipePackRef,
} from './recipe-pack-provenance.js';
import {
  buildPackOperationIndex,
  recipeDeclaredOps,
  recipeRecordsUsage,
  type RecordsEffect,
  type RecordsEntityUsage,
  type RecordsUsagePack,
} from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { fetchPackRecipeRefs } from '../discover/catalog-client.js';
import type {
  CatalogPackRow,
  CatalogRecipeRow,
  CatalogResult,
} from '../discover/catalog-client.js';

// ── The result panel ──────────────────────────────────────────────
// The interactive rendering of a run's returned output — the action registry
// and its validation, file-artifact gating, the filter form + paging, and the
// editable grid — now lives in `recipe-result-panel.ts` so `#packs/<slug>`
// renders results through the SAME code. This route keeps what it always
// owned: the panel snapshot, the filter/file state, and every async handler.
// The panel's attribute vocabulary is re-exported below; tests import it from
// here and there is no reason to churn them.
import { renderFilePreviewBody, type FilePreviewCallers } from '../files/file-preview.js';

import {
  RECIPES_ROUTE_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR,
  RECIPES_ROUTE_RESULT_FILE_ATTR,
  RECIPES_ROUTE_RESULT_FILE_MODE_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_ERROR_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_PAGE_ATTR,
  RECIPES_ROUTE_RESULT_GRID_ATTR,
  RECIPES_ROUTE_RESULT_GRID_ROW_ATTR,
  RECIPES_ROUTE_RESULT_SELECT_ATTR,
  RECIPES_ROUTE_RESULT_SELECT_ROW_ATTR,
  RECIPE_RESULT_PANEL_STYLES,
  copyRecipeResultValue,
  RECIPE_RESULT_HOST_ATTR,
  createResultActionRegistry,
  exactResultFileReadError,
  openResultPreviewWindow,
  resultFilterRunConfig,
  triggerResultFileOpen,
  findResultTableEdit,
  findResultTableSelect,
  renderRecipeResultPanel,
  RECIPES_FILE_PREVIEW_MOUNT_ATTR,
  RECIPES_FILE_PREVIEW_NAME_ATTR,
  resolvedFilterDescriptor,
  resultOutputSections,
  resultTableEdits,
  type RecipeOutputAction,
  type RegisteredResultFile,
  type ResultActionRegistry,
  type ResultFileArtifact,
} from './recipe-result-panel.js';
import {
  ensureSheetImportResultStyles,
  renderSheetImportResult,
  sheetImportFor,
  wireSheetImport,
  type SheetImportHandle,
  type SheetImportUploader,
} from './spreadsheet-import/index.js';
import {
  captureResultFilterActionFocus,
  captureResultTableEditSubmitFocus,
  readResultTableEditCellInput,
  restoreResultFilterActionFocus,
  restoreResultTableEditSubmitFocus,
  syncResultTableEditChrome,
  wireResultTableEditRefPickers,
} from './result-table-edit-host.js';
import {
  RESULT_FULLSCREEN_ACTION,
  domFullscreenApi,
  syncResultFullscreenChrome,
  toggleResultFullscreen,
} from './result-fullscreen-host.js';
export {
  RECIPES_ROUTE_RESULT_PANEL_ATTR,
  RECIPES_ROUTE_RESULT_SECTION_ATTR,
  RECIPES_ROUTE_RESULT_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_FILE_ATTR,
  RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR,
  RECIPES_ROUTE_RESULT_RETURN_ATTR,
  RECIPES_ROUTE_RESULT_PROVENANCE_ATTR,
  RECIPES_ROUTE_RESULT_FACTS_ATTR,
  RECIPES_ROUTE_RESULT_REASON_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_PAGE_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_ERROR_ATTR,
  RECIPES_ROUTE_RESULT_GRID_ATTR,
  RECIPES_ROUTE_RESULT_GRID_CELL_ATTR,
  RECIPES_ROUTE_RESULT_GRID_ROW_ATTR,
  type RecipesResultFilterState,
  type RecipesResultOrigin,
  type RecipesResultPanelSnapshot,
} from './recipe-result-panel.js';
import type {
  RecipesResultFilterState,
  RecipesResultOrigin,
  RecipesResultPanelSnapshot,
} from './recipe-result-panel.js';
import {
  PACK_INSTALL_OFFER_STYLES,
  missingPacksFromError,
  renderPackInstallOffer,
} from '../shell/pack-install-offer.js';
import {
  LIST_PREVIEW_STYLES,
  mountListPreview,
  readListContinuity,
  readListScroll,
  restoreListScroll,
  updateListContinuity,
  type ListPreviewMount,
} from '../shell/list-preview-continuity.js';

export const RECIPES_ROUTE_STYLES_MARKER =
  'data-recued-recipes-route-styles';
export const RECIPES_ROUTE_HOST_ATTR = 'data-recued-recipes-route';
export const RECIPES_ROUTE_HEADING_ATTR = 'data-recued-recipes-route-heading';
export const RECIPES_ROUTE_SECTION_ATTR = 'data-recued-recipes-section';
export const RECIPES_ROUTE_RECIPE_CARD_ATTR = 'data-recued-recipes-card';
export const RECIPES_ROUTE_RECIPE_OPEN_ATTR =
  'data-recued-recipes-open-button';
export const RECIPES_ROUTE_RECIPE_SUMMARY_ATTR =
  'data-recued-recipes-grant-summary';
// Installed-recipes search + filter + bounded paging. Filtering happens over
// the in-memory recipe list before card markup is emitted, so large libraries
// never mount thousands of hidden cards.
export const RECIPES_ROUTE_FILTERS_ATTR = 'data-recued-recipes-filters';
export const RECIPES_ROUTE_SEARCH_ATTR = 'data-recued-recipes-search';
export const RECIPES_ROUTE_FILTER_CHIP_ATTR = 'data-recued-recipes-filter-chip';
export const RECIPES_ROUTE_NO_MATCHES_ATTR = 'data-recued-recipes-no-matches';
export const RECIPES_ROUTE_COUNT_ATTR = 'data-recued-recipes-count';
export const RECIPES_ROUTE_PAGER_ATTR = 'data-recued-recipes-pager';
export const RECIPES_ROUTE_PAGER_CONTROL_ATTR =
  'data-recued-recipes-pager-control';
export const RECIPES_ROUTE_RECIPE_TRIGGER_ATTR = 'data-recued-recipe-trigger';
export const RECIPES_ROUTE_RECIPE_PACKS_ATTR = 'data-recued-recipe-packs';
export const RECIPES_ROUTE_RECIPE_SEARCH_ATTR = 'data-recued-recipe-search';
const RECIPES_PAGE_SIZE = 24;
const RECIPES_LIST_CONTINUITY_KEY = 'recipes:installed';
/** The per-card "Run" button (the trigger). The Run MODAL it opens is the
 *  shared `@recued/ui-shared` RunModal (its own `RUN_MODAL_*` hooks). */
export const RECIPES_ROUTE_RUN_BUTTON_ATTR = 'data-recued-recipes-run-button';
export const RECIPES_ROUTE_AUTO_RUN_ERROR_ATTR =
  'data-recued-recipes-auto-run-error';
export const RECIPES_ROUTE_SOURCE_ERROR_ATTR =
  'data-recued-recipes-source-error';
export const RECIPES_ROUTE_UNAVAILABLE_ATTR =
  'data-recued-recipes-unavailable';
export const RECIPES_ROUTE_KITCHEN_LINK_ATTR =
  'data-recued-recipes-kitchen-link';
export const RECIPES_ROUTE_CONTRACTS_LINK_ATTR =
  'data-recued-recipes-contracts-link';
/** UX-review flow-10 — the per-recipe "Connections" need line + its
 *  enroll CTA (now on the detail provenance). Exported for the render test. */
export const RECIPES_ROUTE_CONNECTIONS_ATTR =
  'data-recued-recipes-connections';
export const RECIPES_ROUTE_CONNECTIONS_LINK_ATTR =
  'data-recued-recipes-connections-link';
/** Per-recipe derived-runnability line (recipe-identity doc §1.6).
 *  Attribute value = the recipe's `RunnabilityStatus`; the element carries
 *  the status pill + one detail line per unsatisfied dependency. DISCLOSURE
 *  over the D-157 gate, never enforcement. */
export const RECIPES_ROUTE_RUNNABILITY_ATTR =
  'data-recued-recipes-runnability';
/** Per-recipe PII posture line (`recipe.pii`). Value =
 *  `'auto' | 'manual' | 'info'`. DISCLOSURE only. */
export const RECIPES_ROUTE_PII_ATTR = 'data-recued-recipes-pii';
/** D-221 — the stored-Records disclosure. Value is the posture:
 *  `present` | `destructive` | `unknown` (roster unavailable) |
 *  `unresolved` (a named pack is not installed). */
export const RECIPES_ROUTE_RECORDS_ATTR = 'data-recued-recipes-records';
export const RECIPES_ROUTE_RECORDS_PACK_ATTR =
  'data-recued-recipes-records-pack';
export const RECIPES_ROUTE_RECORDS_LINK_ATTR =
  'data-recued-recipes-records-link';
/** Per-card automation status one-liner (schedules / triggers / auto-run).
 *  The card summary is read-only; actions live on detail / #automation. */
export const RECIPES_ROUTE_AUTOMATION_SUMMARY_ATTR =
  'data-recued-recipes-automation-summary';

// ── R24 list -> detail surface ──────────────────────────────────────
/** The durable detail view container (value = the selected recipe_id). */
export const RECIPES_ROUTE_DETAIL_ATTR = 'data-recued-recipes-detail';
/** The focus target for list -> detail navigation and detail repaints. */
export const RECIPES_ROUTE_DETAIL_HEADING_ATTR =
  'data-recued-recipes-detail-heading';
/** The "<- Recipes" back-to-list link on the detail. */
export const RECIPES_ROUTE_BACK_ATTR = 'data-recued-recipes-back';
/** The per-card "from pack X" provenance label (delta 3) + the detail's
 *  pack link. Value = a space-joined list of the recipe's `depends_on`. */
export const RECIPES_ROUTE_FROM_PACK_ATTR = 'data-recued-recipes-from-pack';
/** The detail's read-only definition inspect. */
export const RECIPES_ROUTE_DEFINITION_ATTR = 'data-recued-recipes-definition';
/** The detail's "View runs in Logs" link — deep-links `#logs/recipe/<recipe_id>`
 *  so Logs opens pre-scoped to this recipe's runs (delta 5 · R24 recipe-filter). */
export const RECIPES_ROUTE_RUNS_LINK_ATTR = 'data-recued-recipes-runs-link';
/** D-319 — the detail's "Running as" section and its controls carry the
 *  `RUNNING_AS_*` attributes (`running-as.ts`), re-exported for tests. */
export {
  RUNNING_AS_ACTION_ATTR,
  RUNNING_AS_ATTR,
  RUNNING_AS_DISH_ATTR,
  RUNNING_AS_NOT_INSTALLED_ATTR,
  RUNNING_AS_RECIPE_ATTR,
  RUNNING_AS_STATUS_ATTR,
} from './running-as.js';

/** The detail's "Manage automation" link (-> #automation/<recipe_id>). */
export const RECIPES_ROUTE_AUTOMATION_LINK_ATTR =
  'data-recued-recipes-automation-link';
/** The detail's "Edit in Kitchen" link — deep-links `#kitchen/recipe/<recipe_id>`
 *  so the Kitchen recipe editor opens loaded on this recipe (the recipe-editing
 *  sibling of the pack editor's `#kitchen/pack`). */
export const RECIPES_ROUTE_EDIT_LINK_ATTR = 'data-recued-recipes-edit-link';
/** D-195 P2 — related installed recipes sharing `metadata.recipe_bundle`. */
export const RECIPES_ROUTE_RELATED_ATTR = 'data-recued-recipes-related';
export const RECIPES_ROUTE_RELATED_ROW_ATTR =
  'data-recued-recipes-related-row';
/** Exact BulkPackManifest carrier for the selected recipe bundle. */
export const RECIPES_ROUTE_BUNDLE_PACK_ATTR =
  'data-recued-recipes-bundle-pack';
/** Recovery status + retry control for the selected bundle carrier's
 * per-pack membership artifact. */
export const RECIPES_ROUTE_BUNDLE_STATUS_ATTR =
  'data-recued-recipes-bundle-status';
export const RECIPES_ROUTE_BUNDLE_RETRY_ATTR =
  'data-recued-recipes-bundle-retry';

// `RECIPES_ROUTE_ACTION_ATTR`, `…RESULT_ACTION_SELECT_ATTR` and
// `…RESULT_FILE_MODE_ATTR` moved to `recipe-result-panel.ts` (the panel emits
// them; this route matches on them) and are imported above.
const RECIPES_ROUTE_RECIPE_ID_ATTR = 'data-recipe-id';

/** D-319 — a setting holds a value a run can use. */
const hasSettingValue = (value: unknown): boolean =>
  value !== undefined && value !== null
  && !(typeof value === 'string' && value.trim() === '')
  && !(Array.isArray(value) && value.length === 0);

const relatedActionFocusKey = (action: string | null): string | null =>
  action?.startsWith('toggle-auto-run:') === true ? 'toggle-auto-run' : action;
const SHARED_ACTION_ATTR = 'data-action';

export type RecipesListCaller = () => Promise<{
  recipes: ReadonlyArray<ServerRecipeListEntry>;
}>;

/** `recipe.get` — one recipe's FULL body. The list rows carry none of the steps. */
export type RecipesGetCaller = (args: { recipe_id: string }) => Promise<{
  recipe: ServerRecipeFullEntry | null;
}>;

/** What the detail view's Definition shows: the full body once `recipe.get` answers. */
type RecipeDefinitionView =
  | { kind: 'loaded'; recipe: RecipeDefinition }
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  /** No `recipe.get` wired: the list row is all this host can show. */
  | { kind: 'row' };

export type RecipeExecuteCaller = (args: {
  recipe_id: string;
  config?: Record<string, unknown>;
  /** Targeting guard (design § 8) — caller-supplied runtime context.
   *  The run modal threads the filled target fields here (e.g.
   *  `{ entity_id: '123' }`); the host passes it through to the
   *  `execute` rpc verbatim. */
  context?: Record<string, unknown>;
  invocation?: RecipeInvocation;
  /** D-319 — run as this dish, with its settings; `config` changes them for
   *  this run alone. Absent ⇒ the recipe's main dish's settings. */
  dish_id?: string;
}) => Promise<ServerExecuteResponse>;

/** D-200 — owner-authenticated file-content read used only after an emitted
 * file_artifact card has been validated. The returned identity is compared to
 * the card's server-derived ref/hash/metadata before any bytes are opened. */
export type RecipeFileReadCaller = (args: {
  record_id: string;
}) => Promise<{
  record_id: string;
  bytes_b64: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
  blob_hash: string;
}>;

export type RecipesToolCatalogCaller = () => Promise<{
  catalog: ReadonlyArray<ToolCatalogEntryView>;
}>;

/** UX-review flow-10 — unfiltered enrolled-connection list, so the
 *  per-recipe provenance can show whether each needed connection is
 *  already set up. Optional + soft. */
export type RecipesConnectionsListCaller = () => Promise<{
  connections: ReadonlyArray<ConnectionView>;
}>;

/** `recipe.runnability` read: for every known recipe, whether its declared
 *  capability dependencies are satisfied. Optional + soft. */
export type RecipesRunnabilityCaller = () => Promise<{
  recipes: ReadonlyArray<RecipeRunnabilityEntry>;
}>;

/** `recipe.pii` read: per-recipe PII posture. Optional + soft. */
export type RecipesPiiCaller = () => Promise<{
  recipes: ReadonlyArray<RecipePiiDisclosureEntry>;
}>;

/** `packs.list` read — the installed-pack roster, each row carrying its full
 *  manifest. The route joins a recipe's Tier-P op ids against the manifests'
 *  composition operation rows to disclose what the recipe does to pack-owned
 *  Records and at what author-declared risk. Optional + soft: structurally the
 *  settings panel's `PacksListCaller`, so the shell passes the same one. */
export type RecipesPacksListCaller = () => Promise<{
  packs: ReadonlyArray<PackListEntry>;
}>;


/** Automation LIST callers — read-only status surfacing (the per-recipe
 *  summary line). Management lives at #automation. All soft. */
/** D-215 slice 3 — `dishes.list` for the detail's Dishes section, including
 *  the last-outcome map the server resolves in one audit scan. */
export type RecipesDishesListCaller = () => Promise<{
  dishes: Dish[];
  last_runs?: Record<string, DishLastRun>;
}>;
/** D-319 — switching a recipe on: a dish with its settings. The recipe's
 *  first dish is its main one. `enabled: false` saves without switching on. */
export type RecipesDishesCreateCaller = (args: {
  recipe_id: string;
  publisher_id: string;
  name?: string;
  config_overlay?: Record<string, unknown>;
  enabled?: boolean;
}) => Promise<{ dish: Dish }>;
/** D-319 — a dish's switch (every trigger, schedule and timer of it), its
 *  settings (in place, from its next run), its name, and "Make this the main
 *  one". */
export type RecipesDishesUpdateCaller = (args: {
  dish_id: string;
  name?: string;
  config_overlay?: Record<string, unknown>;
  enabled?: boolean;
  main?: boolean;
}) => Promise<{ dish: Dish }>;
/** D-319 — remove a dish; its triggers and schedules go with it. */
export type RecipesDishesDeleteCaller = (args: { dish_id: string }) => Promise<{ deleted: true }>;
/** D-319 — what a new dish starts from beyond the recipe's own defaults:
 *  the mail template the install chose. */
export type RecipesDishesDefaultsCaller = (args: {
  recipe_id: string;
}) => Promise<{ config_overlay: Record<string, unknown> }>;

export type RecipesSchedulesListCaller = () => Promise<{
  schedules: ServerSchedule[];
}>;
export type RecipesTriggersListCaller = () => Promise<{
  triggers: EventTrigger[];
}>;
export type RecipesAutoRunListCaller = () => Promise<{
  entries: AutoRunStatusEntry[];
}>;
export type RecipesAutoRunUpdateCaller = (args: {
  recipe_id: string;
  enabled?: boolean;
  config_overlay?: Record<string, unknown>;
}) => Promise<{ entry: AutoRunStatusEntry }>;

/** Per-recipe schedule callers, threaded into the shared Run | Schedule
 *  modal so the detail's [Schedule] opens straight onto a working Schedule
 *  tab (quick-schedule via the L1 run modal — R24). All soft. */
export type RecipesSchedulesCreateCaller = (args: {
  recipe_id: string;
  publisher_id?: string;
  /** D-215 slice 5 — absent ⇒ `'recurring'`, the pre-slice-5 shape. */
  mode?: 'recurring' | 'one_shot';
  cron_expression?: string;
  /** D-215 slice 5 — one-shot fire time, epoch ms. */
  run_at?: number;
  /** D-319 — the dish it runs as, with the dish's settings. Absent ⇒ the
   *  recipe's main dish. */
  dish_id?: string;
}) => Promise<{ schedule: ServerSchedule }>;
export type RecipesSchedulesUpdateCaller = (args: {
  schedule_id: string;
  enabled?: boolean;
}) => Promise<{ schedule: ServerSchedule }>;
export type RecipesSchedulesDeleteCaller = (args: {
  schedule_id: string;
}) => Promise<{ deleted: true }>;
export type RecipesPackRecipeRefsCaller = (
  slug: string,
) => Promise<Array<{ slug: string; version: number }>>;

/** D-display-mode P1 — the `ui.result_display_mode` pref over the standard
 *  pair-WS prefs rpc, mirroring the transparency / learning caller pairs. Its
 *  own pair rather than reusing theirs so a harness can drive one surface
 *  without standing up a server for the others. Absent ⇒ display mode is simply
 *  unavailable, which is the right degradation: the panel still renders. */
export type RecipesDisplayPrefsGetCaller = () => Promise<{ prefs: InstancePrefs }>;
export type RecipesDisplayPrefsSetCaller = (
  args: { patch: Partial<InstancePrefs> },
) => Promise<{ prefs: InstancePrefs }>;

/** D-display-mode P2 — should a completed run make a displayed board re-read?
 *
 *  🔑 SELF-EXCLUSION, NOT A DEBOUNCE. A refresh run emits its own `execution`
 *  events, so a handler reacting to everything re-triggers itself forever. The
 *  rule falls out of what a display board IS — all-Records reads
 *  (internal design notes § 3) — so a run that cannot write cannot be the
 *  cause of its own staleness, and its own events are irrelevant by definition.
 *  A timer would only slow the loop while making the screen laggy.
 *
 *  ⚠ Exported because the route cannot be unit-tested without a DOM and a WS,
 *  and an inline copy plus a test copy is a twin that drifts. One function, one
 *  caller, one test.
 *
 *  ⛔ `recipe_id` must be a non-empty STRING. `emitExecution` refuses to emit
 *  without one, but a client that trusts an upstream guard is one upstream
 *  change from refreshing on every malformed event — which a test caught here
 *  before it shipped. */
export const shouldRefreshDisplayedBoard = (args: {
  displayMode: boolean;
  busy: boolean;
  shown: string | undefined;
  event: { op?: unknown; recipe_id?: unknown; audit_exempt?: unknown };
  /** D-display-mode P4 — the SERVER's answer for the board's last run, taken
   *  verbatim from `ServerExecuteResponse.audit_exempt`. */
  lastRunAuditExempt: boolean | undefined;
}): boolean => {
  if (!args.displayMode || args.busy) return false;
  if (args.shown === undefined || args.shown === '') return false;
  // ⛔⛔ REFUSE TO AUTO-REFRESH A BOARD THAT IS NOT EXEMPT. A display re-runs on
  // every change; that is free only while every dispatching step is provably a
  // Records read. One non-Records step — a vendor read, a notification, an
  // `ai-*` call — and each tick writes an audit anchor instead, which the
  // retention pruner then pays for by evicting the OLDEST rows, i.e. the real
  // history. See internal design notes § 3.
  //
  // ⚠ `undefined` is UNKNOWN, NOT YES — a server too old to send the field, or
  // a board that has not run yet. Refusing is the fail-safe reading: the cost of
  // being wrong here is a screen that does not refresh, against a log that
  // quietly fills.
  if (args.lastRunAuditExempt !== true) return false;
  if (args.event.op !== 'complete') return false;
  if (typeof args.event.recipe_id !== 'string' || args.event.recipe_id === '') return false;
  // ⛔⛔ A READ COMPLETING IS NEVER A REASON TO RE-READ — not just MY read, ANY
  // read. The first version of this guard excluded only the displayed board,
  // and two clients in display mode showing DIFFERENT boards then triggered
  // each other forever: A's refresh reads to B as a real change and B's reads
  // the same to A. A live two-client drive measured ~135 runs/second, with
  // symmetric counts (1077 / 1076 / 1076 / 1076 completes in eight seconds).
  // Unfindable single-client, which is why every unit test and the first drive
  // passed.
  //
  // ⚠ `undefined` MEANS DO NOT REFRESH — the opposite fail-safe to P4's
  // `lastRunAuditExempt`, and deliberately so. There the question is "may I run
  // at all", so unknown must refuse. HERE the question is "did something
  // change", and the cheap failure is a stale screen while the expensive one is
  // the loop above. An older server that cannot send the field therefore gets a
  // display that never auto-refreshes, which is the correct degradation.
  if (args.event.audit_exempt !== false) return false;
  return args.event.recipe_id !== args.shown;
};

export interface BootstrapRecipesRouteOptions {
  /** D-269 step 1 — the server's resolved IANA zone, forwarded to the run
   *  modal's scheduled-activation stamp. Absent ⇒ this browser's, as before. */
  serverTimeZone?: () => string | undefined;
  root: HTMLElement;
  document?: Document;
  /** Shell-owned scrolling element used for list continuity across detail and
   * browser route remounts. Defaults to `root` for embedded/test mounts. */
  scrollRoot?: HTMLElement;
  displayPrefsGetCaller?: RecipesDisplayPrefsGetCaller;
  displayPrefsSetCaller?: RecipesDisplayPrefsSetCaller;
  recipesListCaller?: RecipesListCaller;
  /** The detail view's Definition reads the full body through this. Absent ⇒ it shows the
   *  list row, which carries no steps. */
  recipeGetCaller?: RecipesGetCaller;
  recipeExecuteCaller?: RecipeExecuteCaller;
  /** Follows a result shown "held for approval" to the run's end, so the
   *  recipe's own result replaces the note once the owner approves it
   *  anywhere. Absent ⇒ the note stays, as before. */
  followHeldRun?: HeldRunFollower['follow'];
  /** D-200 — paired-client authenticated preview/download for exact file
   * artifact result cards. Absent keeps metadata visible and controls disabled. */
  fileReadCaller?: RecipeFileReadCaller;
  /** D-274 — needed to DRAW a `file_preview` block inline. Absent means the
   *  block renders its fallback text instead of the picture; nothing breaks. */
  filePreviewCallers?: FilePreviewCallers;
  toolCatalogCaller?: RecipesToolCatalogCaller;
  connectionsListCaller?: RecipesConnectionsListCaller;
  runnabilityCaller?: RecipesRunnabilityCaller;
  piiCaller?: RecipesPiiCaller;
  /** Absent ⇒ the Records + declared-risk disclosures stay in their
   *  "roster unavailable" wording. */
  packsListCaller?: RecipesPacksListCaller;
  /** D-215 slice 3 — absent ⇒ the detail's "Running as" section stays hidden. */
  dishesListCaller?: RecipesDishesListCaller;
  /** D-319 — Switch on, Save settings, + Add another. Absent ⇒ none is offered. */
  dishesCreateCaller?: RecipesDishesCreateCaller;
  /** D-319 — a dish's switch, Settings and "Make this the main one". */
  dishesUpdateCaller?: RecipesDishesUpdateCaller;
  /** D-319 — Remove a dish. */
  dishesDeleteCaller?: RecipesDishesDeleteCaller;
  /** D-319 — the mail template a new dish starts from. Absent ⇒ the recipe's
   *  own defaults only. */
  dishesDefaultsCaller?: RecipesDishesDefaultsCaller;
  schedulesListCaller?: RecipesSchedulesListCaller;
  schedulesCreateCaller?: RecipesSchedulesCreateCaller;
  schedulesUpdateCaller?: RecipesSchedulesUpdateCaller;
  schedulesDeleteCaller?: RecipesSchedulesDeleteCaller;
  preapprovalPrepareCaller?: RunModal.WireRunModalOptions['preapprovalPrepare'];
  onPreapprovalPrepared?: RunModal.WireRunModalOptions['onPreapprovalPrepared'];
  triggersListCaller?: RecipesTriggersListCaller;
  autoRunListCaller?: RecipesAutoRunListCaller;
  autoRunUpdateCaller?: RecipesAutoRunUpdateCaller;
  /** D-315 §5.2 — the owner's mail templates, for a `mail_template` setting in
   *  the Settings editor: pick one, open it, duplicate one to edit. Absent ⇒
   *  the setting is a text box. */
  mailTemplateCallers?: MailTemplateVariableCallers;
  /** D-292 — uploads a file for the guided spreadsheet import. Absent ⇒ that
   *  flow offers only files already in Recued. */
  sheetImportUploadCaller?: SheetImportUploader;
  /** D-200 — Data Files inventory projected into `file_ref` variable pickers
   * for Run, Schedule, and install-config editors. */
  fileRefSearchCaller?: RefPicker.RefPickerSearchCaller;
  /** D-221 record picker — build an inventory caller for one pack's entity.
   *  The route supplies the OWNER (from the recipe's bundle) because only it
   *  knows which pack the form belongs to; the overlay supplies the entity. */
  recordRefSearchCaller?: (
    owner: { publisher: string; pack_slug: string },
    entity: string,
    scope?: Readonly<Record<string, string>>,
  ) => RefPicker.RefPickerSearchCaller;
  /** Soft marketplace projections used to verify the workflow pack named by
   *  `recipe_bundle`. Both are required; catalog failures keep the CTA closed. */
  recipeCatalogCaller?: () => Promise<CatalogResult<CatalogRecipeRow>>;
  packCatalogCaller?: () => Promise<CatalogResult<CatalogPackRow>>;
  /** On-demand membership from the selected pack's install artifact. Omit in
   *  production to use the public marketplace fetcher; injected by tests and
   *  private-mirror hosts that already own the catalog transport. */
  packRecipeRefsCaller?: RecipesPackRecipeRefsCaller;
  initialRecipeId?: string;
  /** Keep the shell router's cached hash aligned with in-page detail history
   *  writes, which emit no hashchange. */
  onHashSync?: (hash: string) => void;
  subscribe?: BroadcastSubscriber['on'];
}

export interface RecipesLoadErrors {
  recipes?: string;
  tools?: string;
}

export interface RecipesRunModalSnapshot {
  recipe_id: string;
  /** D-319 — the dish a run goes as (`null`: the recipe has none). */
  dish_id: string | null;
  config_text: string;
  /** Targeting guard (design § 8) — values typed into the per-target
   *  context inputs, keyed by target key. Sent as the run's `context`. */
  target_values: Record<string, string>;
  /** JSON-typed context prefilled by a result action. */
  context_values: Record<string, unknown>;
  executing: boolean;
  error: string | null;
  result: ServerExecuteResponse | null;
}

export interface RecipesRunModalPrefill {
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

/** Keep at most one current-session snapshot per rendered recipe. Result
 *  actions can form cycles (A -> B -> A); linking the full source stack in
 *  that case would resurrect A's stale actionable output and grow history
 *  without bound. */
const withoutRenderedRecipe = (
  panel: RecipesResultPanelSnapshot | undefined,
  recipeId: string,
): RecipesResultPanelSnapshot | undefined => {
  if (panel === undefined) return undefined;
  const previous = withoutRenderedRecipe(panel.previous, recipeId);
  if (panel.render_recipe_id === recipeId) return previous;
  if (previous === panel.previous) return panel;
  const next = { ...panel };
  if (previous === undefined) delete next.previous;
  else next.previous = previous;
  return next;
};

export interface RecipesRoute {
  getRecipes(): ReadonlyArray<ServerRecipeListEntry>;
  getTools(): ReadonlyArray<ToolCatalogEntryView>;
  getLoadErrors(): RecipesLoadErrors;
  /** The currently open detail recipe id, or null when on the list. */
  selectedRecipe(): string | null;
  runModal(): RecipesRunModalSnapshot | null;
  /** D-292 — the guided spreadsheet import, when one is open instead of the
   *  run modal (test-facing). */
  sheetImport(): SheetImportHandle | null;
  resultPanel(): RecipesResultPanelSnapshot | null;
  /** D-222 test/host seam over currently rendered output filters. */
  resultFilterKeys(): ReadonlyArray<string>;
  /** Editable-grid section keys currently rendered (test-facing). */
  resultGridKeys(): ReadonlyArray<string>;
  /** Type into a grid cell, as the owner would. */
  setResultGridCell(gridKey: string, rowIndex: number, column: string, value: string): void;
  /** Add/remove rows on a composing grid. Fixed grids refuse both. */
  addResultGridRow(gridKey: string): void;
  removeResultGridRow(gridKey: string, rowIndex: number): void;
  /** Press the grid's save button. */
  submitResultGrid(gridKey: string): Promise<void>;
  setResultFilterValue(filterKey: string, variableKey: string, value: unknown): void;
  submitResultFilter(
    filterKey: string,
    mode?: 'search' | 'next' | 'previous',
  ): Promise<void>;
  refresh(): void;
  whenLoaded(): Promise<void>;
  /** Open the durable `#recipes/<id>` detail view. */
  openRecipe(recipe_id: string): void;
  /** Return to the list (`#recipes`). */
  closeDetail(): void;
  openRunModal(
    recipe_id: string,
    tab?: 'run' | 'schedule',
    prefill?: RecipesRunModalPrefill,
  ): void;
  setRunConfigText(text: string): void;
  /** Targeting guard (design § 8) — set one target input's value. */
  setRunTargetValue(key: string, value: string): void;
  confirmRun(): Promise<void>;
  closeRunModal(): void;
  /** Foreground recipe commands whose terminal outcome still belongs here. */
  hasInFlightWork(): boolean;
  inFlightWorkPrompt(): string | null;
  /** Owner-entered result rows that would be discarded with this route. */
  hasUnsavedChanges(): boolean;
  unsavedChangesPrompt(): string | null;
  dispose(): void;
}

const RECIPES_ROUTE_STYLES = `
[${RECIPES_ROUTE_HOST_ATTR}] {
  /* Inherit the shell's light/dark base tokens; the amber --warn pair is
     kept deliberately for the recipes risk pills (a hue the monochrome
     shell --warn doesn't provide). */
  --warn: #b54708;
  --warn-subtle: #fff4e5;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-inline-link {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 4px 0;
  border-radius: 6px;
  color: var(--accent);
  font-size: 13px;
  text-decoration: none;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-inline-link:hover {
  text-decoration: underline;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-actions > .recipes-inline-link,
[${RECIPES_ROUTE_DETAIL_ATTR}] > .recipes-inline-link,
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-section > .recipes-inline-link {
  width: fit-content;
  padding: 4px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-actions > .recipes-inline-link:hover,
[${RECIPES_ROUTE_DETAIL_ATTR}] > .recipes-inline-link:hover,
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-section > .recipes-inline-link:hover {
  background: var(--accent-weak);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-inline-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-button--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-button--danger {
  border-color: var(--danger);
  color: var(--danger);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-button:disabled,
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: .65;
}
/* ── Installed-recipes search + filter chips ─────────────────────── */
[${RECIPES_ROUTE_FILTERS_ATTR}] {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-search {
  box-sizing: border-box;
  width: 100%;
  max-width: 360px;
  font: inherit;
  font-size: 13px;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 6px);
  padding: 7px 10px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-search::placeholder {
  color: var(--fg-subtle);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-search:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-chip {
  min-height: 36px;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--fg-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 90ms ease, background 90ms ease, color 90ms ease;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-chip:hover {
  border-color: var(--border-strong);
  color: var(--fg);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-chip--active {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--fg);
  font-weight: 600;
}
[${RECIPES_ROUTE_NO_MATCHES_ATTR}] {
  margin: 0 0 12px;
  padding: 14px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--wc-radius-lg, 8px);
  background: var(--surface-sunk);
  text-align: center;
  font-size: 13px;
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_COUNT_ATTR}] {
  font-size: 12px;
  color: var(--fg-subtle);
}
[${RECIPES_ROUTE_PAGER_ATTR}] {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_SECTION_ATTR}] {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 10px;
  margin: 14px 0;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-section-copy,
[${RECIPES_ROUTE_UNAVAILABLE_ATTR}],
[${RECIPES_ROUTE_SOURCE_ERROR_ATTR}] {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
}
[${RECIPES_ROUTE_SOURCE_ERROR_ATTR}] {
  border-left: 3px solid var(--warn);
  padding-left: 8px;
  color: var(--warn);
}
[${RECIPES_ROUTE_UNAVAILABLE_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
  padding: 10px 12px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-card-grid {
  display: grid;
  min-width: 0;
  max-width: 100%;
  grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
  gap: 12px;
  /* Each card sizes to its own content — a verbose card no longer
     stretches every sibling in its row to match. */
  align-items: start;
}
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}] {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px;
  cursor: pointer;
}
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}]:hover {
  border-color: var(--accent);
}
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}]:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}]:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}] .recipe-card {
  border: 0;
  padding: 0;
  background: transparent;
}
@media (max-width: 560px) {
  [${RECIPES_ROUTE_HOST_ATTR}] .recipes-chip,
  [${RECIPES_ROUTE_PAGER_ATTR}] .recipes-button {
    min-height: 44px;
  }
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-card-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}
[${RECIPES_ROUTE_FROM_PACK_ATTR}] {
  color: var(--fg-muted);
  font-size: 12px;
  text-decoration: none;
}
[${RECIPES_ROUTE_FROM_PACK_ATTR}]:hover {
  text-decoration: underline;
  color: var(--accent);
}
[${RECIPES_ROUTE_RECIPE_SUMMARY_ATTR}] {
  display: grid;
  gap: 5px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
  font-size: 12px;
  color: var(--muted);
}
[${RECIPES_ROUTE_RECIPE_SUMMARY_ATTR}] strong {
  color: var(--fg);
}
[${RECIPES_ROUTE_RUNNABILITY_ATTR}] {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 3px;
  justify-items: start;
  margin-top: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-runnability-pill {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  min-height: 18px;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-runnability-pill--runnable {
  background: var(--ok-bg);
  color: var(--ok);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-runnability-pill--degraded {
  background: var(--warn-subtle);
  color: var(--warn);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-runnability-pill--blocked {
  background: var(--danger-weak);
  color: var(--danger);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-runnability-detail {
  min-width: 0;
  max-width: 100%;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-pii-pill {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  min-height: 18px;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-pii-pill--auto {
  background: var(--ok-bg);
  color: var(--ok);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-pii-pill--manual {
  background: var(--warn-subtle);
  color: var(--warn);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-pii-pill--info {
  background: var(--surface-2);
  color: var(--muted);
}
[${RECIPES_ROUTE_PII_ATTR}] {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 3px;
  justify-items: start;
  margin-top: 6px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-pii-detail {
  min-width: 0;
  max-width: 100%;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
@media (max-width: 720px) {
  [${RECIPES_ROUTE_HOST_ATTR}] .recipes-header {
    display: grid;
  }
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-header {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-direction: row;
  justify-content: space-between;
  /* Top-align so the badge keeps its natural height next to a title that
     wraps to two lines. */
  align-items: flex-start;
  gap: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-name {
  min-width: 0;
  max-width: 100%;
  font-weight: 600;
  color: var(--fg-strong);
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-badges {
  display: flex;
  flex-direction: row;
  gap: 4px;
  flex-wrap: wrap;
  flex: 0 0 auto;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-badge {
  background: var(--accent-weak);
  color: var(--fg);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 0.75rem;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-badge--alert {
  background: var(--danger-weak);
  color: var(--danger);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-badge--reactive {
  background: var(--accent-weak);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-badge--url {
  background: var(--surface-sunk);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-badge--manual {
  background: var(--surface-sunk);
}
/* The marketplace blurb + discovery tags + channel/enrichment pills are
   detail-level — the management card is name + badges + provenance + the
   actionable pills (R24: description moves OFF the card -> detail). */
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}] .recipe-card-description,
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}] .recipe-card-tags,
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}] .recipe-card-pills {
  display: none;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-footer {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: var(--fg-muted);
  font-size: 0.75rem;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-footer > *,
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-card-meta > * {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-author,
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-version {
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-installed,
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-support {
  margin-left: auto;
}
/* ── R24 detail view ─────────────────────────────────────────────── */
[${RECIPES_ROUTE_DETAIL_ATTR}] {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 16px;
}
[${RECIPES_ROUTE_DETAIL_ATTR}] > * {
  min-width: 0;
  max-width: 100%;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-header {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-title {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-name {
  flex: 1 1 180px;
  min-width: 0;
  max-width: 100%;
  font-size: 20px;
  font-weight: 700;
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-meta {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-section {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 6px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 12px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-note {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.45;
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_DEFINITION_ATTR}] {
  min-width: 0;
}
[${RECIPES_ROUTE_DEFINITION_ATTR}] summary {
  box-sizing: border-box;
  min-height: 36px;
  padding: 9px 0;
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
}
@media (max-width: 560px) {
  [${RECIPES_ROUTE_DEFINITION_ATTR}] summary {
    min-height: 44px;
    padding-block: 13px;
  }
}
[${RECIPES_ROUTE_DEFINITION_ATTR}] pre {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  margin: 8px 0 0;
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-sunk);
  padding: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-related-list {
  display: grid;
  gap: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-related-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-related-heading .recipes-detail-section-title {
  margin: 0;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-bundle-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 9px 10px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.4;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-bundle-status[role="alert"] {
  border-color: var(--danger);
  color: var(--danger);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-bundle-status p {
  margin: 0;
  flex: 1 1 300px;
}
[${RECIPES_ROUTE_RELATED_ROW_ATTR}] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-related-title {
  display: block;
  color: var(--fg);
  font-size: 13px;
  font-weight: 650;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-related-meta {
  display: block;
  margin-top: 2px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.35;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-related-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-config-error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}
[${RECIPES_ROUTE_RELATED_ROW_ATTR}] .recipes-config-error {
  grid-column: 1 / -1;
}
@media (max-width: 720px) {
  [${RECIPES_ROUTE_RELATED_ROW_ATTR}] {
    grid-template-columns: 1fr;
  }
  [${RECIPES_ROUTE_HOST_ATTR}] .recipes-related-actions {
    justify-content: flex-start;
  }
}
`;

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const recipeDisplayName = (entry: ServerRecipeListEntry): string =>
  entry.recipe.metadata?.name?.trim() || entry.recipe_id;

const recipeBundleKey = (entry: ServerRecipeListEntry): string | null => {
  const key = entry.recipe.metadata?.recipe_bundle;
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const recipeToolName = (entry: ServerRecipeListEntry): string =>
  `${entry.publisher_id}/${entry.recipe_id}`;

const findToolForRecipe = (
  entry: ServerRecipeListEntry,
  catalog: ReadonlyArray<ToolCatalogEntryView>,
): ToolCatalogEntryView | null => {
  const full = recipeToolName(entry);
  return catalog.find((tool) =>
    tool.tier === 2
    && (
      tool.name === full
      || tool.name === entry.recipe_id
      || tool.name.endsWith(`/${entry.recipe_id}`)
    ),
  ) ?? null;
};

/** Trigger-kind classification for the card badge. The reactive detection
 *  is the structural `classifyRecipeAction` (auto_run / event_triggers /
 *  trigger_steps) shared with the chat run-palette — R24 delta 6, replacing
 *  the old whole-recipe JSON.stringify scan. The alert + url heuristics
 *  stay recipe-card-specific. */
const deriveTriggerKind = (
  entry: ServerRecipeListEntry,
): RecipeCardTriggerKind => {
  const recipe = entry.recipe;
  const lowerTags = (recipe.metadata?.tags ?? []).map((tag) => tag.toLowerCase());
  if (lowerTags.some((tag) => tag.includes('alert'))) {
    return 'alert';
  }
  if (classifyRecipeAction(recipe) !== 'manual') {
    return 'reactive';
  }
  if ((recipe.trigger ?? []).some((trigger) => trigger.toLowerCase().includes('url'))) {
    return 'url';
  }
  return 'manual';
};

/** ⛔ THE SERVER'S ANSWER FIRST. Channels and enrichment reads live in
 *  `steps`, which a list row has not carried since f95faec10, so scanning the
 *  row left every enrichment pill empty. The server projects both from the body
 *  it holds. The scan is only the fallback for an older server, whose rows
 *  still carry the body. */
const deriveNotificationChannels = (
  entry: ServerRecipeListEntry,
): readonly string[] =>
  entry.notification_channels ?? recipeNotificationChannels(entry.recipe);

const deriveConsumedEnrichments = (
  entry: ServerRecipeListEntry,
): readonly string[] =>
  entry.consumed_enrichments ?? recipeConsumedEnrichments(entry.recipe);

export const projectRecipeCardState = (
  entry: ServerRecipeListEntry,
  catalog: ReadonlyArray<ToolCatalogEntryView>,
): RecipeCardState => ({
  recipe_id: entry.recipe_id,
  publisher_id: entry.publisher_id,
  name: recipeDisplayName(entry),
  description: entry.recipe.metadata?.description ?? '',
  version: entry.version,
  author: entry.recipe.metadata?.author ?? entry.publisher_id,
  tags: entry.recipe.metadata?.tags ?? [],
  trigger_kind: deriveTriggerKind(entry),
  notification_channels: deriveNotificationChannels(entry),
  consumed_enrichments: deriveConsumedEnrichments(entry),
  // v3 `repo` — display-only; surfaced on the detail, not the management
  // card (the card hides the support link via CSS).
  ...(entry.recipe.metadata?.repo !== undefined
    ? { repo: entry.recipe.metadata.repo }
    : {}),
  installed: true,
});

const connectionIsEnrolled = (
  need: RequiredConnection,
  enrolled: ReadonlyArray<ConnectionView>,
): ConnectionView | undefined =>
  enrolled.find(
    (c) => c.name === need.name && (need.kind === null || c.kind === need.kind),
  );

/** UX-review flow-10 — render the "Connections" need line for a recipe's
 *  provenance. Empty when the recipe needs none. When `enrolled` is null
 *  the line still names the need + links to enroll. */
const renderConnectionsNeed = (
  needed: ReadonlyArray<RequiredConnection>,
  enrolled: ReadonlyArray<ConnectionView> | null,
): string => {
  if (needed.length === 0) return '';
  const items = needed
    .map((need) => {
      const label =
        need.kind !== null ? `${need.name} (${need.kind})` : need.name;
      if (enrolled === null) return e(label);
      const match = connectionIsEnrolled(need, enrolled);
      return match !== undefined
        ? `${e(match.display_name || label)} — connected`
        : `${e(label)} — needs setup`;
    })
    .join(', ');
  const anyMissing =
    enrolled === null
    || needed.some((need) => connectionIsEnrolled(need, enrolled) === undefined);
  const cta = anyMissing
    ? ` <a class="recipes-inline-link" href="#connections" ${RECIPES_ROUTE_CONNECTIONS_LINK_ATTR}>Set up in Connections</a>`
    : '';
  return `<div ${RECIPES_ROUTE_CONNECTIONS_ATTR}><strong>Connections:</strong> ${items}.${cta}</div>`;
};

const RECORDS_EFFECT_VERB: Record<RecordsEffect, string> = {
  read: 'reads',
  write: 'writes',
  delete: 'deletes',
};

/** Human phrasing for one entity's usage. Derived from the composition's
 *  BINDING, so a `delete` reads as a deletion whatever the op is called. */
const recordsUsagePhrase = (usage: RecordsEntityUsage): string =>
  `${usage.effects.map((effect) => RECORDS_EFFECT_VERB[effect]).join(' + ')} (${usage.actions.join(', ')})`;

/** D-221 disclosure — what this recipe does to pack-owned Records rows.
 *
 *  Records are durable, local, user-owned business data, and a Records
 *  operation declares no manifest permission (access is pack-scoped), so
 *  nothing else on this detail distinguishes a recipe that LISTS a job board
 *  from one that DELETES rows off it. This line is that distinction.
 *
 *  `packs === null` means the roster read failed or no caller was supplied —
 *  say so, rather than render the silence as "touches no Records". */
const renderRecordsUsage = (
  entry: ServerRecipeListEntry,
  packs: ReadonlyArray<RecordsUsagePack> | null,
): string => {
  if (packs === null) {
    return `<div ${RECIPES_ROUTE_RECORDS_ATTR}="unknown"><strong>Records:</strong> the installed-pack list is unavailable, so this recipe's stored-data use can't be shown.</div>`;
  }
  const usage = recipeRecordsUsage(entry.recipe, buildPackOperationIndex(packs));
  if (usage.length === 0) return '';
  const rows = usage
    .map((pack) => {
      const entities = pack.entities
        .map((ent) => `${ent.entity} — ${recordsUsagePhrase(ent)}`)
        .join('; ');
      return `<div ${RECIPES_ROUTE_RECORDS_PACK_ATTR}="${e(pack.pack_ref)}">${e(pack.pack_name)}: ${e(entities)}</div>`;
    })
    .join('');
  // The headline must not overstate. A list recipe that only searches is NOT
  // "changing data stored on this server", and a reader who is told it is
  // stops believing the line that matters — the one above a deletion.
  const effects = new Set(
    usage.flatMap((pack) => pack.entities.flatMap((ent) => ent.effects)),
  );
  const headline = effects.has('delete')
    ? 'this Recipe changes things on this server, and DELETES some of them.'
    : effects.has('write')
      ? 'this Recipe reads and changes things on this server.'
      : 'this Recipe only reads things on this server.';
  return `
    <div ${RECIPES_ROUTE_RECORDS_ATTR}="${effects.has('delete') ? 'destructive' : 'present'}">
      <strong>Records:</strong> ${headline}
      ${rows}
      <a class="recipes-inline-link" href="${serializeShellRoute('data')}" ${RECIPES_ROUTE_RECORDS_LINK_ATTR}>Browse these records in Data →</a>
    </div>
  `;
};

const recipeGrantSummary = (
  entry: ServerRecipeListEntry,
  tool: ToolCatalogEntryView | null,
  enrolledConnections: ReadonlyArray<ConnectionView> | null,
  packs: ReadonlyArray<RecordsUsagePack> | null,
): string => {
  const requires = entry.recipe.requires ?? [];
  // The pack author's own per-op classification, joined from the installed
  // manifests. It beats the tool catalog because the catalog only holds
  // entries for `chat_exposed` recipes — every other recipe used to read
  // "Risk: unknown" no matter what its ops do.
  const declared = packs === null
    ? null
    : recipeDeclaredOps(entry.recipe, buildPackOperationIndex(packs));
  const risk = declared?.risk ?? tool?.risk_tier ?? tool?.classification ?? 'unknown';
  const approval =
    declared !== null && declared.asks_approval
      ? 'At least one thing here will ask you first.'
      : risk === 'write' || risk === 'admin' || risk === 'destructive'
        ? 'Recued asks you before anything reaches the outside world.'
        : risk === 'read'
          ? 'This Recipe only reads, so there is nothing to approve.'
          : 'Recued works out the risk when it runs, from the Recipe and its tools.';
  const riskSource = declared?.risk !== undefined && declared.risk !== null
    ? ' Set by the Pack.'
    : '';
  const unresolved = declared !== null && declared.unresolved.length > 0
    ? `<div ${RECIPES_ROUTE_RECORDS_ATTR}="unresolved"><strong>Unresolved operations:</strong> ${e(declared.unresolved.join(', '))} — the pack that declares them is not installed, so what they do can't be shown.</div>`
    : '';
  const needs = requires.length > 0 ? requires.join(', ') : 'This Recipe asks for no permissions.';
  const connectionsLine = renderConnectionsNeed(
    // ⛔ THE SERVER'S PROJECTION, NOT A LOCAL WALK. Deriving this needs the
    // step bodies, and a list row no longer carries them — re-walking the
    // trimmed view would silently UNDER-report, showing fewer connections
    // than the recipe needs. The local walk remains only for a server that
    // does not project it.
    (entry.required_connections as RequiredConnection[] | undefined)
      ?? recipeRequiredConnections(entry.recipe as never),
    enrolledConnections,
  );
  return `
    <div><strong>Needs:</strong> ${e(needs)}</div>
    ${connectionsLine}
    ${renderRecordsUsage(entry, packs)}
    ${unresolved}
    <div><strong>Risk:</strong> ${e(String(risk))}. ${e(approval)}${riskSource}</div>
    <div><strong>Grants:</strong> managed per contract. <a class="recipes-inline-link" href="#contracts" ${RECIPES_ROUTE_CONTRACTS_LINK_ATTR}>Manage in Contracts</a>.</div>
  `;
};

const RUNNABILITY_PILL_COPY: Record<RunnabilityStatus, string> = {
  runnable: 'Runnable',
  degraded: 'Degraded',
  blocked: 'Cannot run. Add a provider',
};

const runnabilityPillCopy = (entry: RecipeRunnabilityEntry): string => {
  if (entry.status !== 'blocked') return RUNNABILITY_PILL_COPY[entry.status] ?? entry.status;
  const missingPacks = missingPackRefsFromRunnability(entry);
  if (missingPacks.length === 0) return RUNNABILITY_PILL_COPY.blocked;
  return missingPacks.length === 1
    ? 'Cannot run. Install a Pack'
    : 'Cannot run. Install some Packs';
};

const missingPackRunAttrs = (missingPacks: readonly string[]): string =>
  missingPacks.length === 0
    ? ''
    : ` disabled title="${missingPacks.length === 1
      ? 'Install the missing Pack before you run this.'
      : 'Install the missing Packs before you run this.'}"`;

/** The per-recipe derived-runnability line: status pill + per-dependency
 *  detail. Empty when the recipe has no runnability entry. */
const renderRunnabilityLine = (
  entry: RecipeRunnabilityEntry | undefined,
): string => {
  if (entry === undefined) return '';
  const detail = runnabilityDisclosureLines(entry)
    .map((line) => `<span class="recipes-runnability-detail">${e(line)}</span>`)
    .join('');
  // Defensive raw-status fallback for server version skew.
  const pillCopy = runnabilityPillCopy(entry);
  return `
    <div ${RECIPES_ROUTE_RUNNABILITY_ATTR}="${e(entry.status)}">
      <span class="recipes-runnability-pill recipes-runnability-pill--${e(entry.status)}">${e(pillCopy)}</span>
      ${detail}
    </div>
  `;
};

/** The per-recipe PII posture line: tone pill + headline + per-step
 *  detail. Empty when the recipe has no entry. */
const renderPiiLine = (
  summary: RecipePiiPostureSummary | undefined,
): string => {
  if (summary === undefined) return '';
  const tone =
    summary.warnings.length > 0
      ? 'manual'
      : summary.auto_protected.length > 0
        ? 'auto'
        : 'info';
  const pillCopy =
    tone === 'manual'
      ? 'Personal details. You need to look'
      : tone === 'auto'
        ? 'Personal details, protected by Recued'
        : 'About personal details';
  const detail = [
    ...(summary.headline !== '' ? [summary.headline] : []),
    ...summary.auto_protected.map((l) => l.message),
    ...summary.warnings.map((l) => l.message),
    ...summary.infos.map((l) => l.message),
  ]
    .map((line) => `<span class="recipes-pii-detail">${e(line)}</span>`)
    .join('');
  return `
    <div ${RECIPES_ROUTE_PII_ATTR}="${e(tone)}">
      <span class="recipes-pii-pill recipes-pii-pill--${e(tone)}">${e(pillCopy)}</span>
      ${detail}
    </div>
  `;
};

/** Reduce a `packs.list` row to the join's inputs. A row whose manifest the
 *  server omitted contributes no operations, which surfaces as `unresolved`
 *  rather than as an absent Records line. */
const toRecordsUsagePack = (entry: PackListEntry): RecordsUsagePack => ({
  slug: entry.slug,
  publisher: entry.publisher,
  name: entry.name,
  manifest: entry.manifest,
});

const packageSource = (entry: ServerRecipeListEntry): string => {
  switch (entry.source) {
    case 'bundled':
      return 'Bundled';
    case 'pair-sync':
      return 'Pair-synced';
    case 'inline':
      return 'Inline';
  }
};

const renderPackageSource = (entry: ServerRecipeListEntry): string =>
  renderProvenance({
    primary: packageSource(entry),
    kind: 'source',
    ariaLabel: 'Where this Recipe came from',
  });

const renderSourceErrors = (errors: RecipesLoadErrors): string => {
  const rows = Object.entries(errors);
  if (rows.length === 0) return '';
  return rows.map(([source, message]) => `
    <p ${RECIPES_ROUTE_SOURCE_ERROR_ATTR}="${e(source)}">${e(message)}</p>
  `).join('');
};

const RECIPE_TRIGGER_CHIPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '__all__', label: 'All' },
  { value: 'alert', label: 'Alert' },
  { value: 'reactive', label: 'Reactive' },
  { value: 'url', label: 'On page' },
  { value: 'manual', label: 'Manual' },
];

/** Pack chips group the installed recipes by every pack each one is attached
 *  to — the owning `metadata.recipe_bundle` AND its `depends_on` packs, both
 *  keyed as `<publisher>.<pack>` (see `recipe-pack-provenance.ts` for why
 *  reading `depends_on` alone loses every pack-owned recipe). Only a recipe
 *  attached to NO pack falls under the separate "Standalone" chip. Most-used
 *  packs first, capped. */
const topRecipePacks = (
  recipes: ReadonlyArray<ServerRecipeListEntry>,
): ReadonlyArray<{ value: string; label: string }> => {
  const freq = new Map<string, { count: number; label: string }>();
  for (const entry of recipes) {
    // Both provenance fields, one key space — a pack-owned recipe that
    // declares no `depends_on` (every Records pack member) still chips.
    for (const ref of recipePackRefs(entry.recipe)) {
      const prev = freq.get(ref.pack_ref);
      freq.set(ref.pack_ref, {
        count: (prev?.count ?? 0) + 1,
        label: packSlugLabel(ref.pack),
      });
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([pack_ref, { label }]) => ({ value: pack_ref, label }));
};

/** Delta 3 — the "from pack X" provenance label. Links to the dedicated
 *  #packs route (where pack install / grant management lives). Empty for a
 *  standalone recipe. Reused on the card + the detail header.
 *
 *  An OWNING pack (`metadata.recipe_bundle`) reads "from X"; packs the recipe
 *  merely calls into read "needs Y", because "from" is a false claim about a
 *  co-installed dependency. A recipe with no owning bundle keeps the original
 *  "from <deps>" wording — for those, the dep IS the only pack the user knows
 *  the recipe by. */
const renderFromPack = (refs: ReadonlyArray<RecipePackRef>): string => {
  if (refs.length === 0) return '';
  const owned = refs.filter((ref) => ref.relation === 'bundle');
  const needed = refs.filter((ref) => ref.relation === 'depends_on');
  const label = owned.length === 0
    ? `from ${needed.map((ref) => packSlugLabel(ref.pack)).join(', ')}`
    : [
        `from ${owned.map((ref) => packSlugLabel(ref.pack)).join(', ')}`,
        ...(needed.length === 0
          ? []
          : [`needs ${needed.map((ref) => packSlugLabel(ref.pack)).join(', ')}`]),
      ].join(' · ');
  const packAttr = refs.map((ref) => ref.pack_ref).join(' ');
  return renderProvenance({
    primary: label,
    kind: 'source',
    href: '#packs',
    linkClassName: 'recipes-inline-link',
    primaryAttributes: { [RECIPES_ROUTE_FROM_PACK_ATTR]: packAttr },
    ariaLabel: 'Which Pack this came from',
  });
};

interface RecipeListFilter {
  query: string;
  trigger: string | null;
  pack: string | null;
}

const recipeListSearchText = (entry: ServerRecipeListEntry): string => [
  recipeDisplayName(entry),
  entry.recipe.metadata?.description ?? '',
  ...(entry.recipe.metadata?.tags ?? []),
].join(' ').toLocaleLowerCase();

const recipeMatchesListFilter = (
  entry: ServerRecipeListEntry,
  filter: RecipeListFilter,
): boolean => {
  const query = filter.query.trim().toLocaleLowerCase();
  if (query !== '' && !recipeListSearchText(entry).includes(query)) return false;
  if (filter.trigger !== null && deriveTriggerKind(entry) !== filter.trigger) return false;
  if (filter.pack === null) return true;
  const packs = recipePackRefs(entry.recipe);
  return filter.pack === '__standalone__'
    ? packs.length === 0
    : packs.some((ref) => ref.pack_ref === filter.pack);
};

const renderFilterChip = (
  kind: 'trigger' | 'pack',
  value: string,
  label: string,
  filter: RecipeListFilter,
): string => {
  const current = kind === 'pack' ? filter.pack : filter.trigger;
  const active = current === null ? value === '__all__' : current === value;
  return `<button type="button" class="recipes-chip${active ? ' recipes-chip--active' : ''}" ${RECIPES_ROUTE_ACTION_ATTR}="filter-set" ${RECIPES_ROUTE_FILTER_CHIP_ATTR} data-filter-kind="${e(kind)}" data-filter-value="${e(value)}" aria-pressed="${String(active)}">${e(label)}</button>`;
};

/** Search box + filter-chip rows for the installed-recipes section. */
const renderRecipeFilters = (
  recipes: ReadonlyArray<ServerRecipeListEntry>,
  filter: RecipeListFilter,
): string => {
  const packChips = topRecipePacks(recipes);
  const hasStandalone = recipes.some((entry) => recipeIsStandalone(entry.recipe));
  return `
    <div ${RECIPES_ROUTE_FILTERS_ATTR}>
      <input type="search" class="recipes-search" ${RECIPES_ROUTE_SEARCH_ATTR}
        value="${e(filter.query)}" placeholder="Search Recipes…" aria-label="Search installed recipes">
      <div class="recipes-chip-row" role="group" aria-label="Filter by type">
        ${RECIPE_TRIGGER_CHIPS.map((c) => renderFilterChip('trigger', c.value, c.label, filter)).join('')}
      </div>
      ${packChips.length > 0
        ? `<div class="recipes-chip-row" role="group" aria-label="Filter by pack">
            ${renderFilterChip('pack', '__all__', 'All', filter)}
            ${packChips.map((c) => renderFilterChip('pack', c.value, c.label, filter)).join('')}
            ${hasStandalone ? renderFilterChip('pack', '__standalone__', 'Standalone', filter) : ''}
          </div>`
        : ''}
    </div>
  `;
};

/** The slim management card (R24): name + trigger badge + "from pack X" +
 *  runnability / PII pills + actions. Card body/Space opens a read-only preview;
 *  Enter or the explicit Open action enters durable detail. */
const renderRecipeListCard = (
  entry: ServerRecipeListEntry,
  catalog: ReadonlyArray<ToolCatalogEntryView>,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  pii: ReadonlyMap<string, RecipePiiPostureSummary> | null,
): string => {
  const name = recipeDisplayName(entry);
  const actionKind = classifyRecipeAction(entry.recipe);
  const searchText = recipeListSearchText(entry);
  const packs = recipePackRefs(entry.recipe);
  const targetRunnability = runnability?.get(entry.recipe_id);
  const missingPacks = targetRunnability === undefined
    ? []
    : missingPackRefsFromRunnability(targetRunnability);
  return `
    <div ${RECIPES_ROUTE_RECIPE_CARD_ATTR}="${e(entry.recipe_id)}"
      ${RECIPES_ROUTE_ACTION_ATTR}="preview-recipe"
      ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"
      ${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="${e(deriveTriggerKind(entry))}"
      ${RECIPES_ROUTE_RECIPE_PACKS_ATTR}="${e(packs.map((ref) => ref.pack_ref).join(' '))}"
      ${RECIPES_ROUTE_RECIPE_SEARCH_ATTR}="${e(searchText)}"
      role="group" tabindex="0"
      aria-label="${e(name)}. Space to preview; Enter to open details.">
      ${renderRecipeCard(projectRecipeCardState(entry, catalog))}
      <div class="recipes-card-meta">
        ${renderFromPack(packs)}
      </div>
      ${renderRunnabilityLine(targetRunnability)}
      ${renderPiiLine(pii?.get(entry.recipe_id))}
      <div class="recipes-actions">
        <button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="preview-recipe"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"
          aria-label="Preview ${e(name)}">
          Preview
        </button>
        <button type="button" class="recipes-button"
          ${RECIPES_ROUTE_RECIPE_OPEN_ATTR}="${e(entry.recipe_id)}"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"
          aria-label="Open ${e(name)} details">
          Open
        </button>
        ${actionKind === 'manual'
          ? `<button type="button" class="recipes-button recipes-button--primary"
          ${RECIPES_ROUTE_RUN_BUTTON_ATTR}="${e(entry.recipe_id)}"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-run"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"
          aria-label="Run ${e(name)}"${missingPackRunAttrs(missingPacks)}>
          Run
        </button>`
          : `<a class="recipes-button recipes-button--primary"
          href="${serializeShellRoute('automation', entry.recipe_id)}"
          aria-label="Manage automation for ${e(name)}"
          ${RECIPES_ROUTE_AUTOMATION_LINK_ATTR}>Manage</a>`}
      </div>
    </div>
  `;
};

const renderRecipeSection = (
  recipes: ReadonlyArray<ServerRecipeListEntry>,
  catalog: ReadonlyArray<ToolCatalogEntryView>,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  pii: ReadonlyMap<string, RecipePiiPostureSummary> | null,
  filter: RecipeListFilter,
  page: number,
): string => {
  if (recipes.length === 0) {
    return `<p ${RECIPES_ROUTE_UNAVAILABLE_ATTR}>No recipes installed yet — install a pack from <a class="recipes-inline-link" href="#packs">Packs</a> to get started.</p>`;
  }
  const filtered = recipes.filter((entry) => recipeMatchesListFilter(entry, filter));
  const totalPages = Math.max(1, Math.ceil(filtered.length / RECIPES_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * RECIPES_PAGE_SIZE;
  const pageRows = filtered.slice(startIndex, startIndex + RECIPES_PAGE_SIZE);
  const visibleStart = filtered.length === 0 ? 0 : startIndex + 1;
  const visibleEnd = Math.min(startIndex + RECIPES_PAGE_SIZE, filtered.length);
  return `
    ${renderRecipeFilters(recipes, filter)}
    <p ${RECIPES_ROUTE_NO_MATCHES_ATTR}${filtered.length === 0 ? '' : ' hidden'}>No installed recipes match your search.</p>
    <div class="recipes-list-count" ${RECIPES_ROUTE_COUNT_ATTR} aria-live="polite">Showing ${visibleStart}–${visibleEnd} of ${filtered.length} recipe${filtered.length === 1 ? '' : 's'}</div>
    <div class="recipes-card-grid">
      ${pageRows.map((entry) => renderRecipeListCard(entry, catalog, runnability, pii)).join('')}
    </div>
    ${totalPages > 1
      ? `<nav class="recipes-pager" ${RECIPES_ROUTE_PAGER_ATTR} aria-label="Installed recipes pages">
          <button type="button" class="recipes-button" ${RECIPES_ROUTE_ACTION_ATTR}="recipe-page" ${RECIPES_ROUTE_PAGER_CONTROL_ATTR}="previous" data-page="${safePage - 1}"${safePage === 1 ? ' disabled' : ''}>‹ Previous</button>
          <span>Page ${safePage} of ${totalPages}</span>
          <button type="button" class="recipes-button" ${RECIPES_ROUTE_ACTION_ATTR}="recipe-page" ${RECIPES_ROUTE_PAGER_CONTROL_ATTR}="next" data-page="${safePage + 1}"${safePage === totalPages ? ' disabled' : ''}>Next ›</button>
        </nav>`
      : ''}
  `;
};

interface RecipesAutomationData {
  schedules: ServerSchedule[] | null;
  triggers: EventTrigger[] | null;
  autoRun: AutoRunStatusEntry[] | null;
  /** D-215 slice 3 — this recipe's standing dishes. `null` = the caller is
   *  absent or its read failed (the section stays quiet); `[]` = the read
   *  succeeded and there are none (the section says so). */
  dishes: Dish[] | null;
  /** D-215 slice 3 — dish_id → newest run. A dish that has NEVER run is
   *  absent, and an omitted server field normalises to `{}` here, so
   *  "unknown" and "never run" render identically rather than as failure. */
  dishLastRuns: Record<string, DishLastRun>;
}

const recipeSchedules = (
  data: RecipesAutomationData,
  recipe_id: string,
): ServerSchedule[] =>
  (data.schedules ?? []).filter((s) => s.recipe_id === recipe_id);

const recipeTriggers = (
  data: RecipesAutomationData,
  recipe_id: string,
): EventTrigger[] =>
  (data.triggers ?? []).filter((t) => t.recipe_id === recipe_id);

/** D-319 — a recipe's auto-run rows are one per dish; the recipe page shows
 *  its MAIN dish's timer (the one Arm / Pause act on — `auto_run.update`
 *  naming only the recipe), else the recipe's "not switched on" row. */
const recipeAutoRun = (
  data: RecipesAutomationData,
  recipe_id: string,
): AutoRunStatusEntry | undefined => {
  const rows = (data.autoRun ?? []).filter((a) => a.recipe_id === recipe_id);
  const main = (data.dishes ?? []).find((d) => d.recipe_id === recipe_id && d.is_default)?.dish_id;
  return rows.find((a) => a.dish_id === main && main !== undefined)
    ?? rows.find((a) => (a.dish_id ?? null) !== null)
    ?? rows[0];
};

/** One compact line of a recipe's automation state (read-only — management
 *  lives at #automation). Empty when the recipe has none. */
const recipeAutomationSummaryText = (
  data: RecipesAutomationData,
  recipe_id: string,
): string => {
  const parts: string[] = [];
  for (const s of recipeSchedules(data, recipe_id)) {
    const cadence = s.mode === 'one_shot'
      ? `Once — ${formatClientDateTime(s.run_at, { invalidText: 'time not set' })}`
      : describeCron(s.cron_expression);
    parts.push(`${cadence}${s.enabled ? '' : ' (paused)'}`);
  }
  for (const t of recipeTriggers(data, recipe_id)) {
    parts.push(`on ${t.pattern}${t.enabled ? '' : ' (paused)'}`);
  }
  const auto = recipeAutoRun(data, recipe_id);
  if (auto !== undefined) {
    // D-319 — a recipe with no dish is not paused: nobody switched it on.
    const state = (auto.dish_id ?? null) === null
      ? ' (not switched on)'
      : !auto.enabled
        ? ' (paused)'
        : auto.auto_disabled
          ? ' (tripped)'
          : '';
    parts.push(`auto-run${state}`);
  }
  return parts.map((p) => e(p)).join(' · ');
};

/** Render one recipe-level auto-run lifecycle action. Both the selected detail
 *  and related-recipe rows use this helper so armed / paused / tripped copy,
 *  pending ownership, and the next `enabled` value cannot drift apart. */
const renderAutoRunToggle = (
  entry: ServerRecipeListEntry,
  autoRun: AutoRunStatusEntry | undefined,
  canUpdate: boolean,
  busy: boolean,
  primary = false,
): string => {
  if (!canUpdate) return '';
  const lifecycle = paletteAutoRunToggle(autoRunStateOf(autoRun));
  const actionLabel = `${lifecycle.label} auto-run`;
  const label = busy
    ? lifecycle.label === 'Arm'
      ? 'Setting it to run on its own…'
      : lifecycle.label === 'Re-arm'
        ? 'Setting it to run on its own again…'
        : 'Pausing…'
    : actionLabel;
  const name = recipeDisplayName(entry);
  return `<button type="button" class="recipes-button${primary ? ' recipes-button--primary' : ''}"
    ${RECIPES_ROUTE_ACTION_ATTR}="toggle-auto-run:${lifecycle.nextEnabled ? 'on' : 'off'}"
    aria-label="${e(`${label} ${name} (${entry.recipe_id})`)}"
    ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"${busy
      ? ' aria-disabled="true" aria-busy="true"'
      : ''}>${e(label)}</button>`;
};

const relatedRecipesFor = (
  selected: ServerRecipeListEntry,
  installed: ReadonlyArray<ServerRecipeListEntry>,
): ServerRecipeListEntry[] => {
  const bundle = recipeBundleKey(selected);
  if (bundle === null) return [];
  return installed
    .filter((entry) =>
      entry.recipe_id !== selected.recipe_id
      && recipeBundleKey(entry) === bundle,
    )
    .sort((a, b) => recipeDisplayName(a).localeCompare(recipeDisplayName(b))
      || a.recipe_id.localeCompare(b.recipe_id));
};

interface RelatedBundlePack {
  slug: string;
  name: string;
  recipeCount: number;
  fullyInstalled: boolean;
}

interface BundleCarrierReadStatus {
  slug: string;
  status: 'loading' | 'error';
  retrying: boolean;
}

interface BundleCarrierDescriptor {
  target: CatalogRecipeRow;
  pack: CatalogPackRow;
  slug: string;
  cacheKey: string;
  readKey: string;
}

const relatedBundlePackFor = (
  selected: ServerRecipeListEntry,
  installed: ReadonlyArray<ServerRecipeListEntry>,
  recipeCatalog: ReadonlyArray<CatalogRecipeRow>,
  packCatalog: ReadonlyArray<CatalogPackRow>,
): RelatedBundlePack | null => {
  const bundleKey = recipeBundleKey(selected);
  if (bundleKey === null) return null;
  const catalogTarget = recipeCatalog.find((row) =>
    row.recipe_id === selected.recipe_id
    && row.publisher_id === selected.publisher_id
    && row.recipe_bundle === bundleKey,
  );
  if (catalogTarget === undefined) return null;
  const resolution = resolveRecipeBundleInstallPack(
    catalogTarget,
    recipeCatalog,
    packCatalog,
  );
  if (resolution.status !== 'resolved') return null;

  const installedVersions = new Map(
    installed.map((entry) => [
      `${entry.publisher_id}/${entry.recipe_id}`,
      entry.version,
    ] as const),
  );
  const fullyInstalled = resolution.pack.recipe_refs.every((member) =>
    (installedVersions.get(`${selected.publisher_id}/${member.slug}`) ?? 0)
      >= member.version,
  );
  return {
    slug: resolution.pack.slug,
    name: resolution.pack.name,
    recipeCount: resolution.pack.recipe_refs.length,
    fullyInstalled,
  };
};

const renderRelatedRecipeRow = (
  entry: ServerRecipeListEntry,
  automation: RecipesAutomationData,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  canExecute: boolean,
  canCreateSchedules: boolean,
  /** D-319 — the host can switch a recipe on (`dishes.create`). */
  canSwitchOn: boolean,
  canAutoRunUpdate: boolean,
  autoRunBusy: ReadonlySet<string>,
  autoRunErrors: ReadonlyMap<string, string>,
): string => {
  const name = recipeDisplayName(entry);
  const actionName = (label: string): string =>
    e(`${label} ${name} (${entry.recipe_id})`);
  const automationText = recipeAutomationSummaryText(automation, entry.recipe_id);
  const autoRun = recipeAutoRun(automation, entry.recipe_id);
  const autoRunError = autoRunErrors.get(entry.recipe_id);
  // D-319 — a recipe nobody switched on asks for its settings first: its row
  // offers the same form as its own page, never a switch that starts it bare.
  const hasDish = (automation.dishes ?? []).some((dish) => dish.recipe_id === entry.recipe_id)
    || (autoRun?.dish_id ?? null) !== null;
  const targetRunnability = runnability?.get(entry.recipe_id);
  const actionKind = classifyRecipeAction(entry.recipe);
  const canRun =
    canExecute
    && actionKind === 'manual'
    && targetRunnability?.status !== 'blocked';
  const hasSchedules = recipeSchedules(automation, entry.recipe_id).length > 0;
  const canSchedule = actionKind === 'manual' && (hasSchedules || canCreateSchedules);
  const hasAutomationSurface =
    canSchedule
    || automationText !== ''
    || entry.recipe.auto_run !== undefined
    || (entry.recipe.event_triggers?.length ?? 0) > 0
    || (entry.recipe.trigger_steps?.length ?? 0) > 0;
  const autoRunToggle = hasDish && actionKind === 'autorun' && automation.autoRun !== null
    ? renderAutoRunToggle(
        entry,
        autoRun,
        canAutoRunUpdate,
        autoRunBusy.has(entry.recipe_id),
      )
    : !hasDish && automation.dishes !== null && canSwitchOn && startsOnItsOwn(entry.recipe)
        && isInstalledRecipeEntry(entry)
      ? renderSwitchOnButton(entry.recipe_id, false)
      : '';
  return `
    <li ${RECIPES_ROUTE_RELATED_ROW_ATTR}="${e(entry.recipe_id)}">
      <div>
        <span class="recipes-related-title">${e(name)}</span>
        <span class="recipes-related-meta">${e(deriveTriggerKind(entry))} · ${renderPackageSource(entry)}${automationText !== '' ? ` · ${automationText}` : ''}</span>
      </div>
      <div class="recipes-related-actions">
        <a class="recipes-button"
          href="${serializeShellRoute('recipes', entry.recipe_id)}"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe"
          aria-label="${actionName('Open')}"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Open</a>
        ${canRun ? `<button type="button" class="recipes-button recipes-button--primary"
          ${RECIPES_ROUTE_RUN_BUTTON_ATTR}="${e(entry.recipe_id)}"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-run"
          aria-label="${actionName('Run')}"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Run</button>` : ''}
        ${canSchedule ? `<button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-schedule"
          aria-label="${actionName('Schedule')}"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Schedule</button>` : ''}
        ${hasAutomationSurface ? `<a class="recipes-button"
          href="${serializeShellRoute('automation', entry.recipe_id)}"
          aria-label="${actionName('Automation for')}"
          ${RECIPES_ROUTE_AUTOMATION_LINK_ATTR}>Automation</a>` : ''}
        ${autoRunToggle}
        <a class="recipes-button"
          href="${serializeShellRoute('logs', 'recipe', entry.recipe_id)}"
          aria-label="${actionName('Logs for')}"
          ${RECIPES_ROUTE_RUNS_LINK_ATTR}>Logs</a>
      </div>
      ${autoRunError === undefined
        ? ''
        : `<p role="alert" class="recipes-config-error" ${RECIPES_ROUTE_AUTO_RUN_ERROR_ATTR}="${e(entry.recipe_id)}">${e(autoRunError)}</p>`}
    </li>
  `;
};

const renderRelatedRecipesSection = (
  selected: ServerRecipeListEntry,
  installed: ReadonlyArray<ServerRecipeListEntry>,
  recipeCatalog: ReadonlyArray<CatalogRecipeRow>,
  packCatalog: ReadonlyArray<CatalogPackRow>,
  carrierRead: BundleCarrierReadStatus | null,
  automation: RecipesAutomationData,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  canExecute: boolean,
  canCreateSchedules: boolean,
  canSwitchOn: boolean,
  canAutoRunUpdate: boolean,
  autoRunBusy: ReadonlySet<string>,
  autoRunErrors: ReadonlyMap<string, string>,
): string => {
  const related = relatedRecipesFor(selected, installed);
  const bundlePack = relatedBundlePackFor(
    selected,
    installed,
    recipeCatalog,
    packCatalog,
  );
  if (related.length === 0 && bundlePack === null && carrierRead === null) return '';
  const carrierStatus = carrierRead === null
    ? ''
    : carrierRead.status === 'loading'
      ? `<div class="recipes-bundle-status" role="status" aria-live="polite"
          ${RECIPES_ROUTE_BUNDLE_STATUS_ATTR}="${e(carrierRead.slug)}">
          <p>${carrierRead.retrying
            ? 'Trying again…'
            : 'Checking what is in the Pack…'}</p>
          ${carrierRead.retrying
            ? `<button type="button" class="recipes-button"
                ${RECIPES_ROUTE_ACTION_ATTR}="retry-bundle-carrier"
                ${RECIPES_ROUTE_BUNDLE_RETRY_ATTR}="${e(carrierRead.slug)}"
                aria-disabled="true" aria-busy="true">Retrying…</button>`
            : ''}
        </div>`
      : `<div class="recipes-bundle-status" role="alert"
          ${RECIPES_ROUTE_BUNDLE_STATUS_ATTR}="${e(carrierRead.slug)}">
          <p>Couldn’t verify this recipe’s workflow pack contents. The installed recipe remains usable; retry to restore the pack handoff.</p>
          <button type="button" class="recipes-button"
            ${RECIPES_ROUTE_ACTION_ATTR}="retry-bundle-carrier"
            ${RECIPES_ROUTE_BUNDLE_RETRY_ATTR}="${e(carrierRead.slug)}">Retry workflow pack</button>
        </div>`;
  return `
    <section class="recipes-detail-section" ${RECIPES_ROUTE_RELATED_ATTR}="${e(recipeBundleKey(selected) ?? '')}">
      <div class="recipes-related-heading">
        <h2 class="recipes-detail-section-title">Related recipes</h2>
        ${bundlePack === null ? '' : `<a class="recipes-button${bundlePack.fullyInstalled ? '' : ' recipes-button--primary'}"
          href="${serializeShellRoute('packs', bundlePack.slug)}"
          ${RECIPES_ROUTE_BUNDLE_PACK_ATTR}="${e(bundlePack.slug)}">${bundlePack.fullyInstalled
            ? 'See the whole Pack'
            : `Install everything (${bundlePack.recipeCount})`}</a>`}
      </div>
      ${bundlePack === null ? '' : `<p class="recipes-detail-note">${e(bundlePack.name)} is the bundled install pack for this recipe. Pack detail shows the full contents and grants before install.</p>`}
      ${carrierStatus}
      ${related.length === 0 ? '' : `<ul class="recipes-related-list" role="list">
        ${related.map((entry) => renderRelatedRecipeRow(
          entry,
          automation,
          runnability,
          canExecute,
          canCreateSchedules,
          canSwitchOn,
          canAutoRunUpdate,
          autoRunBusy,
          autoRunErrors,
        )).join('')}
      </ul>`}
    </section>
  `;
};

/** The detail view (R24 delta 1) — header + pills +
 *  description + read-only definition + depends-on provenance + Runs /
 *  Automation links. Rendered from the in-memory recipe entry, except the
 *  Definition, which is the full body `recipe.get` returns.
 *
 *  ⛔ IT SAID "no extra fetch — `recipe.list` already carries the full definition",
 *  and that stopped being true when the step bodies came off the list rows
 *  (f95faec10): the Definition showed a recipe with no steps, so an owner checking
 *  what a recipe does saw nothing it does (2026-09-24 audit). */
const renderRecipeDetail = (
  entry: ServerRecipeListEntry,
  catalog: ReadonlyArray<ToolCatalogEntryView>,
  installed: ReadonlyArray<ServerRecipeListEntry>,
  recipeCatalog: ReadonlyArray<CatalogRecipeRow>,
  packCatalog: ReadonlyArray<CatalogPackRow>,
  carrierRead: BundleCarrierReadStatus | null,
  connections: ReadonlyArray<ConnectionView> | null,
  packs: ReadonlyArray<RecordsUsagePack> | null,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  pii: ReadonlyMap<string, RecipePiiPostureSummary> | null,
  automation: RecipesAutomationData,
  canExecute: boolean,
  canCreateSchedules: boolean,
  /** D-319 — the "Running as" section, already drawn (it owns its own state),
   *  and whether the host can switch a recipe on (related rows offer it). */
  dishes: { readonly markup: string; readonly canSwitchOn: boolean },
  canAutoRunUpdate: boolean,
  autoRunBusy: ReadonlySet<string>,
  autoRunErrors: ReadonlyMap<string, string>,
  resultPanel: RecipesResultPanelSnapshot | null,
  resultActionRegistry: ResultActionRegistry,
  resultFilterStates: ReadonlyMap<string, RecipesResultFilterState>,
  defaultRunBusy: boolean,
  defaultRunError: string | null,
  /** Packs a `pack_not_installed` run failure named — rendered as the shared
   *  offer instead of the bare message. Null for every other failure. */
  defaultRunMissingPacks: readonly string[] | null,
  resultGridStates: ReadonlyMap<string, OutputTableEditState> = new Map(),
  recordRefPickers = false,
  canPreapprove = false,
  // ⛔ LAST, AND THAT MATTERS. Inserted mid-list it typechecked CLEAN while
  // shifting every trailing argument by one — the neighbours are all booleans,
  // so the compiler had nothing to object to and `recordRefPickers` would have
  // arrived as `displayMode`. ⚠ The SEVENTEENTH positional parameter;
  // `renderTableResultSection` hit the same wall at six. The next addition to
  // either should convert to an options object rather than push the count again.
  // `undefined` = the host wired no prefs rpc, so no control is offered.
  displayMode: boolean | undefined = undefined,
  /** D-282 B6 — per-table selection, keyed by `selectKey`.
   *
   *  ⚠ THE EIGHTEENTH, and the note above asked for an options object instead.
   *  Added here anyway, with the reason that note's own bug does not reach it:
   *  that bug was a boolean inserted among booleans, which the compiler could
   *  not object to. This is a `ReadonlyMap`, so a shifted position is a type
   *  error rather than a silent swap. The refactor is still owed; doing it
   *  inside a feature slice would bury the feature in it. */
  selectStates: ReadonlyMap<string, OutputTableSelectState> = new Map(),
  /** What the Definition shows (`RecipeDefinitionView`). ⚠ The NINETEENTH, last, and a
   *  tagged union, so a shifted position is a type error, as the note above requires. */
  definition: RecipeDefinitionView = { kind: 'row' },
): string => {
  const name = recipeDisplayName(entry);
  const triggerKind = deriveTriggerKind(entry);
  const tool = findToolForRecipe(entry, catalog);
  const fromPack = renderFromPack(recipePackRefs(entry.recipe));
  const description = entry.recipe.metadata?.description ?? '';
  const repo = entry.recipe.metadata?.repo;
  const automationText = recipeAutomationSummaryText(automation, entry.recipe_id);
  const actionKind = classifyRecipeAction(entry.recipe);
  const isManual = actionKind === 'manual';
  // D-319 — the recipe's timer is its main dish's; switching it is the dish's
  // switch, under "Running as".
  const autoRun = recipeAutoRun(automation, entry.recipe_id);
  const emptyAutomationCopy = isManual
    ? 'Nothing sets this off yet. Add a schedule here, or set one up under Automation.'
    : actionKind === 'autorun'
      ? 'This Recipe runs on its own. Open Automation to see it and change it.'
      : 'Something sets this Recipe off. Open Automation to see what, and change it.';
  const variableDefs = Object.values(entry.recipe.variables ?? {});
  const defaultPrimitiveOnly = variableDefs.length > 0
    && variableDefs.every((definition) => !isInvocationVariable(definition));
  // D-319 — Run runs as the main dish when the recipe has one, and nothing
  // needs asking when the dish holds every value a run would ask for.
  const mainDish = (automation.dishes ?? []).find((dish) =>
    dish.recipe_id === entry.recipe_id && dish.is_default);
  const mainDishAnswersAll = mainDish !== undefined
    && Object.entries(entry.recipe.variables ?? {}).every(([key, definition]) =>
      !isInvocationVariable(definition) || hasSettingValue(mainDish.config_overlay[key]));
  const targetRunnability = runnability?.get(entry.recipe_id);
  const missingPacks = targetRunnability === undefined
    ? []
    : missingPackRefsFromRunnability(targetRunnability);
  const canRunDefaultsDirectly = (defaultPrimitiveOnly || mainDishAnswersAll)
    && canExecute
    && targetRunnability?.status !== 'blocked';
  return `
    <div ${RECIPES_ROUTE_DETAIL_ATTR}="${e(entry.recipe_id)}">
      <a class="recipes-inline-link" href="#recipes" ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe-list" ${RECIPES_ROUTE_BACK_ATTR}>← Recipes</a>
      <header class="recipes-detail-header">
        <h1 class="recipes-detail-title"
          ${RECIPES_ROUTE_DETAIL_HEADING_ATTR}="${e(entry.recipe_id)}" tabindex="-1">
          <span class="recipes-detail-name">${e(name)}</span>
          <span class="recipe-card-badge recipe-card-badge--${e(triggerKind)}">${e(triggerKind)}</span>
        </h1>
        <p class="recipes-detail-meta">v${entry.version} · ${e(entry.publisher_id)}${fromPack !== '' ? ` · ${fromPack}` : ''} · ${renderPackageSource(entry)}</p>
        <div class="recipes-actions">
          ${isManual ? `<button type="button" class="recipes-button recipes-button--primary"
            ${RECIPES_ROUTE_RUN_BUTTON_ATTR}="${e(entry.recipe_id)}"
            ${RECIPES_ROUTE_ACTION_ATTR}="${canRunDefaultsDirectly ? 'run-defaults' : 'open-run'}"
            ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"${defaultRunBusy
              ? ' aria-disabled="true" aria-busy="true"'
              : ''}${missingPackRunAttrs(missingPacks)}>${defaultRunBusy ? 'Running…' : 'Run'}</button>
          ${defaultPrimitiveOnly || mainDishAnswersAll ? `<button type="button" class="recipes-button"
            ${RECIPES_ROUTE_ACTION_ATTR}="open-run"
            ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"${missingPackRunAttrs(missingPacks)}>Run with overrides</button>` : ''}
          <button type="button" class="recipes-button"
            ${RECIPES_ROUTE_ACTION_ATTR}="open-schedule"
            ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Schedule</button>` : ''}
          ${actionKind === 'autorun' && autoRun?.preapproval
            ? `<a class="recipes-button" href="${e(preapprovalHref(autoRun.preapproval.proposal_id))}">Look at this run</a>`
            : actionKind === 'autorun' && canPreapprove && autoRun?.lifecycle_revision !== undefined && !autoRun.auto_disabled
              ? `<button type="button" class="recipes-button" ${RECIPES_ROUTE_ACTION_ATTR}="review-auto-run"
                ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Look at the next run</button>` : ''}
          ${isManual ? '' : `<a class="recipes-button recipes-button--primary"
            href="${serializeShellRoute('automation', entry.recipe_id)}"
            ${RECIPES_ROUTE_AUTOMATION_LINK_ATTR}>Manage automation</a>`}
          <a class="recipes-button"
            href="${serializeShellRoute('kitchen', 'recipe', entry.recipe_id)}"
            ${RECIPES_ROUTE_EDIT_LINK_ATTR}>Edit in Kitchen</a>
        </div>
        ${isManual && defaultRunMissingPacks !== null
          ? renderPackInstallOffer(defaultRunMissingPacks)
          : isManual && defaultRunError !== null
            ? `<p role="alert" class="recipes-result-file-error">${e(defaultRunError)}</p>`
            : ''}
      </header>
      ${dishes.markup}
      <section class="recipes-detail-section">
        <h2 class="recipes-detail-section-title">Exposed as a tool</h2>
        <p class="recipes-detail-note">Whether the AI can call this recipe is granted per contract — it can be exposed through one contract and not another. <a class="recipes-inline-link" href="#contracts" ${RECIPES_ROUTE_CONTRACTS_LINK_ATTR}>Manage in Contracts →</a></p>
      </section>
      ${renderRunnabilityLine(targetRunnability)}
      ${defaultRunMissingPacks === null ? renderPackInstallOffer(missingPacks) : ''}
      ${renderPiiLine(pii?.get(entry.recipe_id))}
      ${description !== '' ? `<section class="recipes-detail-section"><h2 class="recipes-detail-section-title">About</h2><p class="recipes-detail-note">${e(description)}</p>${repo !== undefined ? `<a class="recipes-inline-link" href="${e(repo)}" target="_blank" rel="noopener noreferrer">Issues &amp; support</a>` : ''}</section>` : ''}
      <section class="recipes-detail-section">
        <h2 class="recipes-detail-section-title">Depends on</h2>
        <div ${RECIPES_ROUTE_RECIPE_SUMMARY_ATTR}>
          ${recipeGrantSummary(entry, tool, connections, packs)}
        </div>
      </section>
      <section class="recipes-detail-section">
        <h2 class="recipes-detail-section-title">Runs &amp; automation</h2>
        <a class="recipes-inline-link" href="${serializeShellRoute('logs', 'recipe', entry.recipe_id)}" ${RECIPES_ROUTE_RUNS_LINK_ATTR}>View runs in Logs →</a>
        <a class="recipes-inline-link" href="${serializeShellRoute('automation', entry.recipe_id)}" ${RECIPES_ROUTE_AUTOMATION_LINK_ATTR}>Manage automation →</a>
        ${automationText !== '' ? `<p class="recipes-detail-note"><strong>Automation:</strong> ${automationText}</p>` : `<p class="recipes-detail-note">${e(emptyAutomationCopy)}</p>`}
      </section>
      ${renderRecipeResultPanel(
        resultPanel,
        installed,
        resultActionRegistry,
        resultFilterStates,
        resultGridStates,
        recordRefPickers,
        { display_mode: displayMode },
        selectStates,
      )}
      ${renderRelatedRecipesSection(
        entry,
        installed,
        recipeCatalog,
        packCatalog,
        carrierRead,
        automation,
        runnability,
        canExecute,
        canCreateSchedules,
        dishes.canSwitchOn,
        canAutoRunUpdate,
        autoRunBusy,
        autoRunErrors,
      )}
      <section class="recipes-detail-section">
        <details ${RECIPES_ROUTE_DEFINITION_ATTR}>
          <summary>Definition (read-only)</summary>
          ${definition.kind === 'loaded'
            ? `<pre>${e(JSON.stringify(definition.recipe, null, 2))}</pre>`
            : definition.kind === 'loading'
              ? '<p class="recipes-detail-muted">Loading the definition…</p>'
              : definition.kind === 'failed'
                ? `<p role="alert">Could not load the definition: ${e(definition.message)}</p>`
                : `<pre>${e(JSON.stringify(entry.recipe, null, 2))}</pre>`}
        </details>
      </section>
    </div>
  `;
};

export const bootstrapRecipesRoute = (
  opts: BootstrapRecipesRouteOptions,
): RecipesRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapRecipesRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (doc.head.querySelector(`style[${RECIPES_ROUTE_STYLES_MARKER}]`) === null) {
    const style = doc.createElement('style');
    style.setAttribute(RECIPES_ROUTE_STYLES_MARKER, '');
    // The panel's own rules travel WITH it now — scoped to
    // `RECIPE_RESULT_HOST_ATTR`, not to this route's host, so the same sheet
    // serves `#packs/<slug>`.
    style.textContent = `${RECIPES_ROUTE_STYLES}\n${RECIPE_RESULT_PANEL_STYLES}\n${PACK_INSTALL_OFFER_STYLES}\n${LIST_PREVIEW_STYLES}\n${RUNNING_AS_STYLES}`;
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(RECIPES_ROUTE_HOST_ATTR, '');
  opts.root.appendChild(routeRoot);
  const scrollRoot = opts.scrollRoot ?? opts.root;
  const rememberedList = readListContinuity<RecipeListFilter>(
    doc,
    RECIPES_LIST_CONTINUITY_KEY,
  );

  let disposed = false;
  /** Stops for the held runs this route is following. */
  const heldRunStops: Array<() => void> = [];
  /** The full body behind each opened detail's Definition, with the list hash it was read
   *  for: a recipe changed since is read again. */
  const definitionBodies = new Map<string, { hash: string; view: RecipeDefinitionView }>();
  const definitionFor = (entry: ServerRecipeListEntry): RecipeDefinitionView => {
    const getCaller = opts.recipeGetCaller;
    if (getCaller === undefined) return { kind: 'row' };
    const known = definitionBodies.get(entry.recipe_id);
    if (known !== undefined && known.hash === entry.recipe_hash) return known.view;
    const asked = { hash: entry.recipe_hash, view: { kind: 'loading' } as RecipeDefinitionView };
    definitionBodies.set(entry.recipe_id, asked);
    const settle = (view: RecipeDefinitionView): void => {
      // Each answer lands on the read that asked for it, so an answer for an older hash
      // lands on a slot the newer read already replaced and is never shown. This check
      // only spares that stale answer a render of a page it would not change.
      if (disposed || definitionBodies.get(entry.recipe_id) !== asked) return;
      asked.view = view;
      render();
    };
    void getCaller({ recipe_id: entry.recipe_id }).then(
      ({ recipe }) => settle(recipe === null
        ? { kind: 'failed', message: 'this recipe is no longer installed' }
        : { kind: 'loaded', recipe: recipe.recipe }),
      (error: unknown) => settle({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return asked.view;
  };
  let loading = true;
  let recipes: ServerRecipeListEntry[] = [];
  let catalog: ToolCatalogEntryView[] = [];
  // Soft public projections used only for the direct recipe_bundle -> pack
  // handoff. They are kept as one aligned snapshot and cleared together on a
  // failed refresh so a stale recipe set can never match a newer pack set.
  let bundleRecipeCatalog: CatalogRecipeRow[] = [];
  let bundlePackCatalog: CatalogPackRow[] = [];
  let bundleCatalogLoaded = false;
  let bundleCatalogGeneration = 0;
  /** Carrier membership, fetched from the per-pack install artifact.
   *
   *  `recipe_refs` is pack MEMBERSHIP and belongs to `/packs/<slug>.json`, not
   *  to the meta catalog — carrying it there was the only reason the catalog's
   *  server-side read had to touch all 927 pack manifests. 56 distinct carriers
   *  serve 382 bundled recipes, so it is fetched for the SELECTED recipe's
   *  carrier only, cached by immutable pack version, and folded into each new
   *  pack snapshot. Reads remain retryable: `[]` means the artifact could not
   *  be verified, not that the one-shot attempt should poison the route. */
  const carrierRefsCache = new Map<
    string,
    Array<{ slug: string; version: number }>
  >();
  const carrierRefsFlights = new Map<string, Promise<void>>();
  const carrierRefsReadStates = new Map<string, BundleCarrierReadStatus>();
  let pendingBundleCatalogPromise: Promise<void> | null = null;
  // R24 delta 1 — the durable detail selection. `null` = the list view.
  let selectedRecipeId: string | null = opts.initialRecipeId ?? null;
  // Recipe ids can repeat across separate list -> detail visits. Async work
  // belongs to the exact visit that started it, not merely to a matching id
  // that happened to be reopened before the earlier response arrived.
  let detailVisitGeneration = 0;
  // Navigation focus survives the route's whole-shell repaints. Pending keys
  // own the first list/detail handoff; after that, only a semantic target that
  // still owns focus is restored, so async enrichment cannot steal focus back
  // after the owner has moved to another control.
  let pendingDetailFocusRecipeId: string | null = null;
  let pendingListCardFocusRecipeId: string | null =
    opts.initialRecipeId === undefined
      && (rememberedList?.focusKind === undefined
        || rememberedList.focusKind === 'recipe')
      ? rememberedList?.focusedId ?? null
      : null;
  let pendingListControlFocus = opts.initialRecipeId === undefined
    && rememberedList?.focusKind !== undefined
    && rememberedList.focusKind !== 'recipe'
      ? {
          kind: rememberedList.focusKind,
          id: rememberedList.focusedId ?? null,
        }
      : null;
  let pendingListScrollRestore = opts.initialRecipeId === undefined
    ? rememberedList?.scroll
    : undefined;
  // Installed-recipes filter (client-side, survives route remounts in this
  // document without creating persistent storage).
  let recipeFilter: RecipeListFilter = rememberedList?.filter === undefined
    ? { query: '', trigger: null, pack: null }
    : {
        query: rememberedList.filter.query,
        trigger: rememberedList.filter.trigger,
        pack: rememberedList.filter.pack,
      };
  let recipePage = rememberedList?.page === undefined
    ? 1
    : Math.max(1, Math.floor(rememberedList.page));
  let connections: ConnectionView[] | null = null;
  // Installed-pack roster, reduced to what the Records / declared-op joins
  // need. `null` = the read failed or no caller was supplied — the disclosure
  // says so rather than rendering silence as "touches nothing".
  let packs: RecordsUsagePack[] | null = null;
  // Derived runnability by recipe id. `null` = unknown. Patched in place by
  // the `recipe_runnability_changed` broadcast (full recomputed snapshot).
  let runnability: Map<string, RecipeRunnabilityEntry> | null = null;
  let pii: Map<string, RecipePiiPostureSummary> | null = null;
  // Counts broadcast-applied runnability snapshots so a refresh already in
  // flight when an event lands discards its (possibly pre-mutation) read.
  let runnabilityEventSeq = 0;
  // Freshest-kickoff-wins across overlapping refreshes (packs-panel DD#14).
  let refreshGeneration = 0;
  // Same discipline for the targeted automation-status refresh — a slower
  // earlier broadcast must not overwrite a newer one's data (codex MEDIUM).
  let automationRefreshGeneration = 0;
  let errors: RecipesLoadErrors = {};
  // The shared Run | Schedule modal — a self-contained portaled element with
  // its OWN render + events (NOT part of this route's innerHTML repaint), so
  // it mounts to body (or `opts.root` in the fake-doc tests) and survives
  // the route's repaints. The route tracks the handle + the recipe behind it.
  let childRunModal: RunModal.RunModalHandle | null = null;
  /** D-292 — opened INSTEAD of `childRunModal` for a declared spreadsheet
   *  import; the two share the one-dialog-at-a-time rule. */
  let childSheetImport: SheetImportHandle | null = null;
  let runModalRecipeId: string | null = null;
  // D-319 — "Running as": the one form for Switch on / Save settings / + Add
  // another / a dish's Settings, the dishes with a change in flight, the open
  // menu, the remove being confirmed, and errors per dish (`''` = the
  // recipe's own). The switch-on form's read of what a first dish starts
  // from belongs to this visit: leaving retires it (`switchOnToken`).
  let dishFormHandle: ConfigEditorOverlayHandle | null = null;
  let switchOnReading: string | null = null;
  let switchOnToken = 0;
  /** A dish just made: its switch takes the focus once its line is drawn
   *  (the Switch on / Add another it came from is gone by then). */
  let pendingDishFocus: string | null = null;
  let preapprovalActivation: ReturnType<typeof openPreapprovalActivation> | null = null;
  let dishBusy = new Set<string>();
  let dishMenuOpen: string | null = null;
  let dishConfirmingRemove: string | null = null;
  let dishErrors = new Map<string, string>();
  /** The owner's mail templates by id: a dish's line names its template. */
  let templateNames: ReadonlyMap<string, string> | null = null;
  let templateNamesRequested = false;
  const resetDishState = (): void => {
    dishMenuOpen = null;
    dishConfirmingRemove = null;
    dishErrors = new Map();
    switchOnReading = null;
    switchOnToken += 1;
    pendingDishFocus = null;
  };
  // Read-only automation status (the per-recipe summary line on the detail).
  let automationData: RecipesAutomationData = {
    dishes: null,
    dishLastRuns: {},
    schedules: null,
    triggers: null,
    autoRun: null,
  };
  let autoRunBusy = new Set<string>();
  let autoRunErrors = new Map<string, string>();
  let resultPanel: RecipesResultPanelSnapshot | null = null;
  // D-display-mode P1/P2 — this device keeps its board current on its own.
  // Per-device because prefs are stored per instance: the owner's laptop and
  // the wall screen hold different values, and the screen keeps its own across
  // a reload, which is the point after a power cut.
  let displayMode = getPref(DEFAULT_INSTANCE_PREFS, 'ui.result_display_mode') === true;
  let displayRefreshBusy = false;
  let resultGridStates = new Map<string, OutputTableEditState>();
  /** D-282 B6. ⚠ NOT part of the dirty/discard discipline beside it — a
   *  selection costs three clicks to rebuild, typed cells do not. */
  let resultSelectStates = new Map<string, OutputTableSelectState>();
  let resultGridRefPickers: RefPicker.RefPickerHandle[] = [];
  let resultFilterStates = new Map<string, RecipesResultFilterState>();
  let defaultRunBusy = false;
  let defaultRunError: string | null = null;
  let defaultRunMissingPacks: readonly string[] | null = null;
  let resultActions = new Map<string, RecipeOutputAction>();
  let resultFiles = new Map<string, RegisteredResultFile>();
  let resultFileBusy = new Set<string>();
  let resultFileErrors = new Map<string, string>();
  let resultFileVerified = new Set<string>();
  let resultFileGeneration = 0;
  let listPreview: ListPreviewMount | null = null;
  const resultObjectUrls = new Map<
    string,
    ReturnType<typeof globalThis.setTimeout>
  >();
  let pendingLoadPromise: Promise<void> = Promise.resolve();

  const hasResultGridSaveInFlight = (): boolean =>
    [...resultGridStates.values()].some((state) => state.busy);

  const hasResultFilterInFlight = (): boolean =>
    [...resultFilterStates.values()].some((state) => state.busy);

  const hasUnsavedResultGridChanges = (): boolean =>
    anyTableEditDirty(resultGridStates);

  const hasRecipeInFlightWork = (): boolean =>
    defaultRunBusy
    || autoRunBusy.size > 0
    || hasResultGridSaveInFlight()
    || hasResultFilterInFlight()
    || dishBusy.size > 0
    || dishFormHandle?.hasInFlightWork() === true
    || preapprovalActivation?.hasInFlightWork() === true
    || childRunModal?.hasInFlightWork() === true;

  const recipeAddress = (recipeId: string | null) => recipeId === null
    ? hierarchicalAddress('recipes')
    : hierarchicalAddress(
        'recipes',
        hierarchicalLevel(`recipe:${recipeId}`, recipeId),
      );
  /** Seeded from the mounted selection: hydrating `#recipes/<id>` must not
   * duplicate the deep-link entry. The shared controller then pushes only when
   * entering a detail and replaces sideways/closing transitions. */
  const recipeHistory = createHierarchicalHistory({
    initial: recipeAddress(selectedRecipeId),
    history: doc.defaultView?.history,
    onCommit: (address) => opts.onHashSync?.(address.hash),
  });

  const focusedListState = (): {
    readonly kind: string;
    readonly id: string | null;
  } | null => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    if (active?.hasAttribute?.(RECIPES_ROUTE_SEARCH_ATTR) === true) {
      return { kind: 'search', id: null };
    }
    if (active?.hasAttribute?.(RECIPES_ROUTE_FILTER_CHIP_ATTR) === true) {
      const kind = active.getAttribute('data-filter-kind');
      const value = active.getAttribute('data-filter-value');
      return kind === null || value === null
        ? null
        : { kind: 'filter', id: `${kind}\u0000${value}` };
    }
    const pager = active?.getAttribute?.(RECIPES_ROUTE_PAGER_CONTROL_ATTR) ?? null;
    if (pager === 'previous' || pager === 'next') {
      return { kind: 'pager', id: pager };
    }
    if (active?.getAttribute?.(RECIPES_ROUTE_ACTION_ATTR) === 'refresh') {
      return { kind: 'refresh', id: null };
    }
    const card = active?.closest?.(
      `[${RECIPES_ROUTE_RECIPE_CARD_ATTR}]`,
    ) as HTMLElement | null | undefined;
    const id = card?.getAttribute?.(RECIPES_ROUTE_RECIPE_CARD_ATTR) ?? null;
    return id === null ? null : { kind: 'recipe', id };
  };

  const rememberRecipeList = (focusedId?: string | null): void => {
    const focused = focusedId === undefined
      ? focusedListState()
      : { kind: 'recipe', id: focusedId };
    updateListContinuity(doc, RECIPES_LIST_CONTINUITY_KEY, {
      filter: { ...recipeFilter },
      page: recipePage,
      ...(focused === null
        ? {}
        : {
            focusKind: focused.kind,
            ...(focused.id === null ? {} : { focusedId: focused.id }),
          }),
      scroll: readListScroll(scrollRoot),
    });
  };
  const syncRecipeHash = (): void => {
    recipeHistory.navigate(recipeAddress(selectedRecipeId));
  };

  const carrierCacheKey = (pack: CatalogPackRow): string =>
    `${pack.publisher_id}/${pack.slug}@${pack.version}`;

  /** Resolve only the unique, publisher-matching carrier whose slug-addressed
   * artifact is safe to read. The final membership resolution still runs the
   * shared fail-closed contract after the artifact arrives. */
  const selectedBundleCarrier = (): BundleCarrierDescriptor | null => {
    if (selectedRecipeId === null || !bundleCatalogLoaded) return null;
    const selected = recipes.find((entry) => entry.recipe_id === selectedRecipeId);
    if (selected === undefined) return null;
    const bundleKey = recipeBundleKey(selected);
    if (bundleKey === null) return null;
    const target = bundleRecipeCatalog.find((row) =>
      row.recipe_id === selected.recipe_id
      && row.publisher_id === selected.publisher_id
      && row.recipe_bundle === bundleKey,
    );
    if (target === undefined) return null;
    const parsed = parseRecipeBundleKey(bundleKey);
    if (parsed === null || parsed.publisher !== selected.publisher_id) return null;
    const candidates = bundlePackCatalog.filter((pack) =>
      pack.slug === parsed.bundle_slug,
    );
    if (candidates.length !== 1) return null;
    const pack = candidates[0]!;
    if (pack.publisher_id !== parsed.publisher) return null;
    const cacheKey = carrierCacheKey(pack);
    return {
      target,
      pack,
      slug: pack.slug,
      cacheKey,
      readKey: `${bundleCatalogGeneration}:${cacheKey}`,
    };
  };

  const selectedCarrierReadStatus = (): BundleCarrierReadStatus | null => {
    const carrier = selectedBundleCarrier();
    if (carrier === null || carrier.pack.recipe_refs.length > 0) return null;
    return carrierRefsReadStates.get(carrier.readKey) ?? null;
  };

  const render = (): void => {
    if (disposed) return;
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    const focusedResultFilterAction = captureResultFilterActionFocus(activeElement);
    const focusedResultGridSubmitKey = captureResultTableEditSubmitFocus(activeElement);
    const focusedDetailRecipeId = activeElement?.getAttribute?.(
      RECIPES_ROUTE_DETAIL_HEADING_ATTR,
    ) ?? null;
    const focusedDefaultRunRecipeId = activeElement?.getAttribute?.(
      RECIPES_ROUTE_ACTION_ATTR,
    ) === 'run-defaults'
      ? activeElement.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR)
      : null;
    // D-319 — a "Running as" control keeps the focus its own click moved:
    // the same control where it survives the repaint, else its line's menu.
    const focusedRunningAs = activeElement?.hasAttribute?.(RUNNING_AS_ACTION_ATTR) === true
      ? {
          key: RUNNING_AS_FOCUS_AFTER[activeElement.getAttribute(RUNNING_AS_ACTION_ATTR) ?? ''] ?? null,
          dish_id: activeElement.getAttribute(RUNNING_AS_DISH_ATTR),
        }
      : null;
    const focusedBundleSlug = activeElement?.getAttribute?.(
      RECIPES_ROUTE_BUNDLE_RETRY_ATTR,
    ) ?? activeElement?.getAttribute?.(RECIPES_ROUTE_BUNDLE_PACK_ATTR) ?? null;
    const focusedRelatedRow = activeElement?.closest?.(
      `[${RECIPES_ROUTE_RELATED_ROW_ATTR}]`,
    ) as HTMLElement | null | undefined;
    const focusedRelatedRecipeId = focusedRelatedRow?.getAttribute?.(
      RECIPES_ROUTE_RELATED_ROW_ATTR,
    ) ?? null;
    let focusedRelatedControl: {
      recipeId: string;
      kind: 'action' | 'automation' | 'logs';
      action: string | null;
    } | null = null;
    if (
      focusedRelatedRecipeId !== null
      && activeElement !== null
      && activeElement !== undefined
    ) {
      const action = relatedActionFocusKey(activeElement.getAttribute?.(
        RECIPES_ROUTE_ACTION_ATTR,
      ) ?? null);
      if (action !== null) {
        focusedRelatedControl = {
          recipeId: focusedRelatedRecipeId,
          kind: 'action',
          action,
        };
      } else if (
        activeElement.hasAttribute?.(RECIPES_ROUTE_AUTOMATION_LINK_ATTR) === true
      ) {
        focusedRelatedControl = {
          recipeId: focusedRelatedRecipeId,
          kind: 'automation',
          action: null,
        };
      } else if (
        activeElement.hasAttribute?.(RECIPES_ROUTE_RUNS_LINK_ATTR) === true
      ) {
        focusedRelatedControl = {
          recipeId: focusedRelatedRecipeId,
          kind: 'logs',
          action: null,
        };
      }
    }
    const focusedListCardRecipeId = activeElement?.getAttribute?.(
      RECIPES_ROUTE_RECIPE_OPEN_ATTR,
    ) ?? null;
    const focusedSearch = activeElement?.hasAttribute?.(
      RECIPES_ROUTE_SEARCH_ATTR,
    ) === true
      ? activeElement as HTMLInputElement
      : null;
    const focusedSearchSelection = focusedSearch === null
      ? null
      : {
          start: focusedSearch.selectionStart,
          end: focusedSearch.selectionEnd,
          direction: focusedSearch.selectionDirection,
        };
    const focusedFilterChip = activeElement?.hasAttribute?.(
      RECIPES_ROUTE_FILTER_CHIP_ATTR,
    ) === true
      ? {
          kind: activeElement.getAttribute('data-filter-kind'),
          value: activeElement.getAttribute('data-filter-value'),
        }
      : null;
    const focusedPagerDirectionRaw = activeElement?.getAttribute?.(
      RECIPES_ROUTE_PAGER_CONTROL_ATTR,
    );
    const focusedPagerDirection = focusedPagerDirectionRaw === 'previous'
      || focusedPagerDirectionRaw === 'next'
        ? focusedPagerDirectionRaw
        : null;
    const focusedRefresh = activeElement?.getAttribute?.(
      RECIPES_ROUTE_ACTION_ATTR,
    ) === 'refresh';
    for (const picker of resultGridRefPickers.splice(0)) picker.destroy();
    const selected = selectedRecipeId !== null
      ? recipes.find((r) => r.recipe_id === selectedRecipeId) ?? null
      : null;
    if (selected !== null) {
      const shownPanel = resultPanel?.route_recipe_id === selected.recipe_id
        ? resultPanel : null;
      const renderedEntry = shownPanel === null
        ? null
        : recipes.find((entry) => entry.recipe_id === shownPanel.render_recipe_id) ?? null;
      const resultRecordSearch = recordRefSearchFor(renderedEntry?.recipe);
      const resultActionRegistry = createResultActionRegistry(
        recipes,
        runnability,
        opts.fileReadCaller !== undefined,
        resultFileBusy,
        resultFileErrors,
        resultFileVerified,
      );
      routeRoot.innerHTML = renderRecipeDetail(
        selected,
        catalog,
        recipes,
        bundleRecipeCatalog,
        bundlePackCatalog,
        selectedCarrierReadStatus(),
        connections,
        packs,
        runnability,
        pii,
        automationData,
        opts.recipeExecuteCaller !== undefined,
        opts.schedulesListCaller !== undefined
          && opts.schedulesCreateCaller !== undefined,
        { markup: runningAsFor(selected), canSwitchOn: opts.dishesCreateCaller !== undefined },
        opts.autoRunUpdateCaller !== undefined,
        autoRunBusy,
        autoRunErrors,
        shownPanel,
        resultActionRegistry,
        resultFilterStates,
        defaultRunBusy,
        defaultRunError,
        defaultRunMissingPacks,
        resultGridStates,
        resultRecordSearch !== undefined,
        opts.preapprovalPrepareCaller !== undefined && opts.onPreapprovalPrepared !== undefined,
        // `undefined` when the host wired no prefs rpc — no control is offered
        // at all, rather than a dead one.
        opts.displayPrefsSetCaller === undefined ? undefined : displayMode,
        resultSelectStates,
        definitionFor(selected),
      );
      mountFilePreviews();
      resultActions = resultActionRegistry.actions;
      resultFiles = resultActionRegistry.files;
      if (resultRecordSearch !== undefined && shownPanel !== null) {
        resultGridRefPickers = wireResultTableEditRefPickers(routeRoot, {
          search: (entity, scope) => resultRecordSearch(entity, scope),
          valueAt: (key, rowIndex, column) => {
            const found = findGridDescriptor(key);
            if (found === null) return '';
            const state = resultGridStates.get(key)
              ?? initialTableEditState(found.descriptor, found.data);
            return state.rows[rowIndex]?.[column] ?? '';
          },
          onChange: (key, gridRoot, rowIndex, column, value) => {
            const found = findGridDescriptor(key);
            if (found === null) return;
            const state = resultGridStates.get(key)
              ?? initialTableEditState(found.descriptor, found.data);
            const next = gridSetCell(found.descriptor, state, rowIndex, column, value);
            resultGridStates = new Map(resultGridStates).set(key, next);
            syncResultTableEditChrome(gridRoot, next);
          },
        });
      }
      if (restoreResultTableEditSubmitFocus(routeRoot, focusedResultGridSubmitKey)) {
        return;
      }
      if (restoreResultFilterActionFocus(routeRoot, focusedResultFilterAction)) {
        return;
      }
      if (pendingDishFocus !== null) {
        const made = Array.from(routeRoot.querySelectorAll?.(
          `[${RUNNING_AS_DISH_ATTR}="${pendingDishFocus}"][role="switch"]`,
        ) ?? []) as HTMLElement[];
        if (made.length > 0) {
          pendingDishFocus = null;
          made[0]!.focus?.({ preventScroll: true });
          return;
        }
      }
      if (focusedRunningAs !== null && focusedRunningAs.key !== null) {
        const controls = Array.from(routeRoot.querySelectorAll?.(
          `[${RUNNING_AS_ACTION_ATTR}]`,
        ) ?? []) as HTMLElement[];
        const recipeLevel = (key: string | null): boolean =>
          key === 'add' || key === 'switch-on' || key === 'save-settings';
        const onDish = (candidate: HTMLElement): boolean =>
          candidate.getAttribute(RUNNING_AS_DISH_ATTR) === focusedRunningAs.dish_id;
        const replacement = controls.find((candidate) => {
          const key = runningAsFocusKey(candidate.getAttribute(RUNNING_AS_ACTION_ATTR));
          return key === focusedRunningAs.key && (recipeLevel(key) || onDish(candidate));
        })
          ?? controls.find((candidate) =>
            candidate.getAttribute(RUNNING_AS_ACTION_ATTR) === 'menu' && onDish(candidate))
          ?? controls.find((candidate) =>
            recipeLevel(candidate.getAttribute(RUNNING_AS_ACTION_ATTR)));
        if (replacement !== undefined) {
          replacement.focus?.({ preventScroll: true });
          return;
        }
      }
      if (focusedBundleSlug !== null) {
        const replacement = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_BUNDLE_RETRY_ATTR}="${focusedBundleSlug}"]`,
        ) as HTMLElement | null | undefined
          ?? routeRoot.querySelector?.(
            `[${RECIPES_ROUTE_BUNDLE_PACK_ATTR}="${focusedBundleSlug}"]`,
          ) as HTMLElement | null | undefined;
        if (replacement !== null && replacement !== undefined) {
          replacement.focus?.({ preventScroll: true });
          return;
        }
      }
      if (pendingDetailFocusRecipeId === null && focusedRelatedControl !== null) {
        const relatedRow = Array.from(routeRoot.querySelectorAll(
          `[${RECIPES_ROUTE_RELATED_ROW_ATTR}]`,
        )).find((candidate) =>
          candidate.getAttribute(RECIPES_ROUTE_RELATED_ROW_ATTR)
            === focusedRelatedControl.recipeId);
        const replacement = focusedRelatedControl.kind === 'action'
          ? Array.from(relatedRow?.querySelectorAll?.(
              `[${RECIPES_ROUTE_ACTION_ATTR}]`,
            ) ?? []).find((candidate) =>
              relatedActionFocusKey(
                candidate.getAttribute(RECIPES_ROUTE_ACTION_ATTR),
              )
              === focusedRelatedControl.action)
          : relatedRow?.querySelector?.(
              focusedRelatedControl.kind === 'automation'
                ? `[${RECIPES_ROUTE_AUTOMATION_LINK_ATTR}]`
                : `[${RECIPES_ROUTE_RUNS_LINK_ATTR}]`,
            );
        if (replacement !== null && replacement !== undefined) {
          (replacement as HTMLElement).focus?.({ preventScroll: true });
          return;
        }
      }
      const defaultRun = focusedDefaultRunRecipeId === selected.recipe_id
        ? routeRoot.querySelector?.(
            `[${RECIPES_ROUTE_RUN_BUTTON_ATTR}]`,
          ) as HTMLElement | null | undefined
        : null;
      if (
        defaultRun?.getAttribute?.(RECIPES_ROUTE_ACTION_ATTR) === 'run-defaults'
        && defaultRun.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR)
          === focusedDefaultRunRecipeId
      ) {
        defaultRun.focus?.({ preventScroll: true });
        return;
      }
      const detailFocusRecipeId = pendingDetailFocusRecipeId
        ?? focusedDetailRecipeId;
      if (
        detailFocusRecipeId !== null
        && detailFocusRecipeId === selected.recipe_id
      ) {
        const isNavigation = pendingDetailFocusRecipeId === detailFocusRecipeId;
        if (isNavigation) pendingDetailFocusRecipeId = null;
        const heading = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_DETAIL_HEADING_ATTR}="${detailFocusRecipeId}"]`,
        ) as HTMLElement | null | undefined;
        if (
          heading?.getAttribute?.(RECIPES_ROUTE_DETAIL_HEADING_ATTR)
            === detailFocusRecipeId
        ) {
          heading.focus?.({ preventScroll: !isNavigation });
        }
      }
      return;
    }
    resultActions = new Map();
    resultFiles = new Map();
    const filteredRecipeCount = recipes.filter((entry) =>
      recipeMatchesListFilter(entry, recipeFilter)).length;
    const totalRecipePages = Math.max(
      1,
      Math.ceil(filteredRecipeCount / RECIPES_PAGE_SIZE),
    );
    // A route remount paints once before `recipe.list` resolves. At that
    // point an empty loading snapshot has one synthetic page; clamping the
    // remembered page against it would erase continuity before real rows
    // arrive. The renderer already bounds the visual page, so commit the
    // clamp only once the current list has settled.
    if (!loading) {
      recipePage = Math.max(1, Math.min(recipePage, totalRecipePages));
    }
    routeRoot.innerHTML = `
      <header class="recipes-header">
        <h1 class="recipes-title" ${RECIPES_ROUTE_HEADING_ATTR} tabindex="-1">Recipes</h1>
      </header>
      <div class="recipes-actions">
        <button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="refresh"
          aria-disabled="${String(loading)}" aria-busy="${String(loading)}">
          ${loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <a class="recipes-inline-link" href="${serializeShellRoute('kitchen', 'pack')}" ${RECIPES_ROUTE_KITCHEN_LINK_ATTR}>Author in Kitchen</a>
        <a class="recipes-inline-link" href="#packs">Manage packs</a>
      </div>
      ${loading ? '<p class="recipes-section-copy">Loading recipes...</p>' : ''}
      ${renderSourceErrors(errors)}
      <section ${RECIPES_ROUTE_SECTION_ATTR}="recipes">
        <h2 class="recipes-section-title">Installed recipes</h2>
        <p class="recipes-section-copy">Run a manual recipe, or open any recipe to inspect what it does and manage how it activates.</p>
        ${renderRecipeSection(
          recipes,
          catalog,
          runnability,
          pii,
          recipeFilter,
          recipePage,
        )}
      </section>
    `;
    const listFocusRecipeId = pendingListCardFocusRecipeId
      ?? focusedListCardRecipeId;
    if (listFocusRecipeId !== null) {
      const isNavigation = pendingListCardFocusRecipeId === listFocusRecipeId;
      const card = routeRoot.querySelector?.(
        `[${RECIPES_ROUTE_RECIPE_OPEN_ATTR}="${listFocusRecipeId}"]`,
      ) as HTMLElement | null | undefined;
      if (
        card?.getAttribute?.(RECIPES_ROUTE_RECIPE_OPEN_ATTR)
          === listFocusRecipeId
      ) {
        if (isNavigation) pendingListCardFocusRecipeId = null;
        // When continuity owns an exact scroll offset, the focus handoff must
        // not ask the browser to reveal the row again after restoration. That
        // deferred reveal otherwise wins over the explicit offset on native
        // Back and leaves the row merely visible rather than in its old place.
        card.focus?.({
          preventScroll: pendingListScrollRestore !== undefined || !isNavigation,
        });
      } else if (isNavigation && !loading) {
        pendingListCardFocusRecipeId = null;
        const heading = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_HEADING_ATTR}]`,
        ) as HTMLElement | null | undefined;
        heading?.focus?.({ preventScroll: true });
      }
    } else if (focusedSearchSelection !== null) {
      const search = routeRoot.querySelector?.(
        `[${RECIPES_ROUTE_SEARCH_ATTR}]`,
      ) as HTMLInputElement | null | undefined;
      search?.focus?.({ preventScroll: true });
      if (
        focusedSearchSelection.start !== null
        && focusedSearchSelection.end !== null
      ) {
        search?.setSelectionRange?.(
          focusedSearchSelection.start,
          focusedSearchSelection.end,
          focusedSearchSelection.direction ?? undefined,
        );
      }
    } else if (
      focusedFilterChip !== null
      && focusedFilterChip.kind !== null
      && focusedFilterChip.value !== null
    ) {
      const chip = routeRoot.querySelector?.(
        `[${RECIPES_ROUTE_FILTER_CHIP_ATTR}]`
        + `[data-filter-kind="${focusedFilterChip.kind}"]`
        + `[data-filter-value="${focusedFilterChip.value}"]`,
      ) as HTMLElement | null | undefined;
      if (
        chip?.getAttribute?.('data-filter-kind') === focusedFilterChip.kind
        && chip.getAttribute('data-filter-value') === focusedFilterChip.value
      ) {
        chip.focus?.({ preventScroll: true });
      }
    } else if (focusedPagerDirection !== null) {
      const findEnabledPagerControl = (
        direction: 'previous' | 'next',
      ): HTMLElement | null | undefined => {
        const control = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_PAGER_CONTROL_ATTR}="${direction}"]`,
        ) as HTMLElement | null | undefined;
        return control?.hasAttribute?.('disabled') === true ? null : control;
      };
      const opposite = focusedPagerDirection === 'previous'
        ? 'next'
        : 'previous';
      const control = findEnabledPagerControl(focusedPagerDirection)
        ?? findEnabledPagerControl(opposite);
      if (control !== null && control !== undefined) {
        control.focus?.({ preventScroll: true });
      } else {
        const firstCard = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_RECIPE_OPEN_ATTR}]`,
        ) as HTMLElement | null | undefined;
        const heading = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_HEADING_ATTR}]`,
        ) as HTMLElement | null | undefined;
        const fallback = firstCard ?? heading;
        fallback?.focus?.({ preventScroll: true });
      }
    } else if (focusedRefresh) {
      const refresh = routeRoot.querySelector?.(
        `[${RECIPES_ROUTE_ACTION_ATTR}="refresh"]`,
      ) as HTMLElement | null | undefined;
      refresh?.focus?.({ preventScroll: true });
    }
    if (!loading && pendingListControlFocus !== null) {
      const pending = pendingListControlFocus;
      let target: HTMLElement | null = null;
      if (pending.kind === 'search') {
        target = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_SEARCH_ATTR}]`,
        ) as HTMLElement | null;
      } else if (pending.kind === 'filter' && pending.id !== null) {
        const [kind, value] = pending.id.split('\u0000', 2);
        target = Array.from(routeRoot.querySelectorAll?.(
          `[${RECIPES_ROUTE_FILTER_CHIP_ATTR}]`,
        ) ?? []).find((candidate) =>
          candidate.getAttribute('data-filter-kind') === kind
          && candidate.getAttribute('data-filter-value') === value,
        ) as HTMLElement | undefined ?? null;
      } else if (
        pending.kind === 'pager'
        && (pending.id === 'previous' || pending.id === 'next')
      ) {
        const pager = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_PAGER_CONTROL_ATTR}="${pending.id}"]`,
        ) as HTMLElement | null | undefined;
        target = pager?.hasAttribute?.('disabled') === true ? null : pager ?? null;
      } else if (pending.kind === 'refresh') {
        target = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_ACTION_ATTR}="refresh"]`,
        ) as HTMLElement | null;
      }
      pendingListControlFocus = null;
      const fallback = routeRoot.querySelector?.(
        `[${RECIPES_ROUTE_SEARCH_ATTR}]`,
      ) as HTMLElement | null | undefined
        ?? routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_HEADING_ATTR}]`,
        ) as HTMLElement | null | undefined;
      (target ?? fallback)?.focus?.({ preventScroll: true });
    }
    if (!loading && pendingListScrollRestore !== undefined) {
      restoreListScroll(scrollRoot, pendingListScrollRestore);
      pendingListScrollRestore = undefined;
    }
  };

  const resetResultFilterStates = (result: ServerExecuteResponse | null): void => {
    const next = new Map<string, RecipesResultFilterState>();
    if (result !== null) {
      for (const section of resultOutputSections(result)) {
        if (section.type !== 'filter') continue;
        const descriptor = resolvedFilterDescriptor(section);
        if (descriptor === null) continue;
        next.set(outputFilterKey(result.recipe_id, descriptor), {
          ...initialOutputFilterState(descriptor),
          busy: false,
          busy_action: null,
          error: null,
        });
      }
    }
    resultFilterStates = next;
  };

  const activeResultFilter = (key: string): {
    descriptor: ResolvedFilterDescriptor;
    state: RecipesResultFilterState;
  } | null => {
    if (resultPanel === null) return null;
    for (const section of resultOutputSections(resultPanel.result)) {
      if (section.type !== 'filter') continue;
      const descriptor = resolvedFilterDescriptor(section);
      if (descriptor === null
          || outputFilterKey(resultPanel.render_recipe_id, descriptor) !== key) continue;
      return {
        descriptor,
        state: resultFilterStates.get(key) ?? {
          ...initialOutputFilterState(descriptor),
          busy: false,
          busy_action: null,
          error: null,
        },
      };
    }
    return null;
  };

  /** Top up the selected recipe's unique carrier with verified membership.
   *
   *  A missing/invalid response remains fail-closed, but now renders an honest
   *  retry instead of becoming a mount-lifetime tombstone. Concurrent opens and
   *  repeated retry clicks share one read per catalog generation + pack version.
   *  A successful immutable-version result is cached and folded back into later
   *  catalog refreshes, so Refresh cannot make a working handoff disappear. */
  const ensureCarrierRefs = async (retrying = false): Promise<void> => {
    const carrier = selectedBundleCarrier();
    if (carrier === null || carrier.pack.recipe_refs.length > 0) return;
    const existing = carrierRefsFlights.get(carrier.readKey);
    if (existing !== undefined) {
      await existing;
      return;
    }

    carrierRefsReadStates.set(carrier.readKey, {
      slug: carrier.slug,
      status: 'loading',
      retrying,
    });
    render();
    const myGeneration = bundleCatalogGeneration;
    const caller = opts.packRecipeRefsCaller ?? fetchPackRecipeRefs;
    const promise = (async (): Promise<void> => {
      let refs: Array<{ slug: string; version: number }> = [];
      try {
        refs = await caller(carrier.slug);
      } catch {
        // Custom/private-mirror callers have the same never-break-detail
        // contract as the default fetcher, even if they accidentally throw.
      }
      if (disposed || myGeneration !== bundleCatalogGeneration) return;

      const nextPackCatalog = bundlePackCatalog.map((pack) =>
        pack.slug === carrier.pack.slug
          && pack.publisher_id === carrier.pack.publisher_id
          && pack.version === carrier.pack.version
          ? { ...pack, recipe_refs: refs }
          : pack,
      );
      const resolution = refs.length === 0
        ? { status: 'none' as const }
        : resolveRecipeBundleInstallPack(
            carrier.target,
            bundleRecipeCatalog,
            nextPackCatalog,
          );
      if (
        resolution.status !== 'resolved'
        || resolution.pack.slug !== carrier.slug
      ) {
        carrierRefsReadStates.set(carrier.readKey, {
          slug: carrier.slug,
          status: 'error',
          retrying: false,
        });
        render();
        return;
      }

      carrierRefsCache.set(carrier.cacheKey, [...refs]);
      carrierRefsReadStates.delete(carrier.readKey);
      bundlePackCatalog = nextPackCatalog;
      render();
    })();
    carrierRefsFlights.set(carrier.readKey, promise);
    try {
      await promise;
    } finally {
      if (carrierRefsFlights.get(carrier.readKey) === promise) {
        carrierRefsFlights.delete(carrier.readKey);
      }
    }
  };

  const loadBundleCatalog = (force = false): Promise<void> => {
    if (
      opts.recipeCatalogCaller === undefined
      || opts.packCatalogCaller === undefined
    ) {
      return Promise.resolve();
    }
    if (!force) {
      if (bundleCatalogLoaded) return Promise.resolve();
      if (pendingBundleCatalogPromise !== null) return pendingBundleCatalogPromise;
    }

    bundleCatalogGeneration += 1;
    carrierRefsReadStates.clear();
    const myGeneration = bundleCatalogGeneration;
    const promise = (async (): Promise<void> => {
      const [bundleRecipesResult, bundlePacksResult] = await Promise.allSettled([
        opts.recipeCatalogCaller!(),
        opts.packCatalogCaller!(),
      ]);
      if (disposed || myGeneration !== bundleCatalogGeneration) return;
      if (
        bundleRecipesResult.status === 'fulfilled'
        && bundleRecipesResult.value.status === 'ok'
        && bundlePacksResult.status === 'fulfilled'
        && bundlePacksResult.value.status === 'ok'
      ) {
        bundleRecipeCatalog = [...bundleRecipesResult.value.rows];
        bundlePackCatalog = bundlePacksResult.value.rows.map((pack) => {
          if (pack.recipe_refs.length > 0) return pack;
          const cached = carrierRefsCache.get(carrierCacheKey(pack));
          return cached === undefined ? pack : { ...pack, recipe_refs: [...cached] };
        });
        bundleCatalogLoaded = true;
      } else {
        bundleRecipeCatalog = [];
        bundlePackCatalog = [];
        bundleCatalogLoaded = false;
      }
      render();
      await ensureCarrierRefs();
    })();
    pendingBundleCatalogPromise = promise;
    void promise.finally(() => {
      if (pendingBundleCatalogPromise === promise) {
        pendingBundleCatalogPromise = null;
      }
    });
    return promise;
  };

  const refreshData = async (): Promise<void> => {
    loading = true;
    errors = {};
    render();

    refreshGeneration += 1;
    const myGeneration = refreshGeneration;
    const runnabilityEventSeqAtStart = runnabilityEventSeq;
    const [
      recipeResult,
      toolResult,
      connectionResult,
      runnabilityResult,
      piiResult,
      schedulesResult,
      triggersResult,
      autoRunResult,
      dishesResult,
      packsResult,
    ] =
      await Promise.allSettled([
        opts.recipesListCaller !== undefined
          ? opts.recipesListCaller()
          : Promise.reject(new Error('This server cannot list your Recipes yet.')),
        opts.toolCatalogCaller !== undefined
          ? opts.toolCatalogCaller()
          : Promise.reject(new Error('This server cannot list its tools yet.')),
        // Soft enhancement — failure leaves `connections` null.
        opts.connectionsListCaller !== undefined
          ? opts.connectionsListCaller()
          : Promise.reject(new Error('no connections caller')),
        // Soft enhancement — failure leaves `runnability` null.
        opts.runnabilityCaller !== undefined
          ? opts.runnabilityCaller()
          : Promise.reject(new Error('no runnability caller')),
        // Soft PII posture load; failure leaves `pii` null.
        opts.piiCaller !== undefined
          ? opts.piiCaller()
          : Promise.reject(new Error('no pii caller')),
        // Soft automation status loads; failures leave the slot null.
        opts.schedulesListCaller !== undefined
          ? opts.schedulesListCaller()
          : Promise.reject(new Error('no schedules caller')),
        opts.triggersListCaller !== undefined
          ? opts.triggersListCaller()
          : Promise.reject(new Error('no triggers caller')),
        opts.autoRunListCaller !== undefined
          ? opts.autoRunListCaller()
          : Promise.reject(new Error('no auto-run caller')),
        // D-215 slice 3 — soft dish load; failure leaves the slot null.
        opts.dishesListCaller !== undefined
          ? opts.dishesListCaller()
          : Promise.reject(new Error('no dishes caller')),
        // Soft installed-pack roster; failure leaves `packs` null, which the
        // Records + declared-risk disclosures render as "unknown" rather than
        // as "touches nothing".
        opts.packsListCaller !== undefined
          ? opts.packsListCaller()
          : Promise.reject(new Error('no packs caller')),
      ]);

    if (disposed) return;
    // Stale completion — a newer refresh owns the paint. Drop everything.
    if (myGeneration !== refreshGeneration) return;
    if (recipeResult.status === 'fulfilled') {
      recipes = [...recipeResult.value.recipes];
    } else {
      recipes = [];
      errors = { ...errors, recipes: errMessage(recipeResult.reason) };
    }
    if (toolResult.status === 'fulfilled') {
      catalog = [...toolResult.value.catalog];
    } else {
      catalog = [];
      errors = { ...errors, tools: errMessage(toolResult.reason) };
    }
    connections =
      connectionResult.status === 'fulfilled'
        ? [...connectionResult.value.connections]
        : null;
    packs =
      packsResult.status === 'fulfilled'
        ? packsResult.value.packs.map(toRecordsUsagePack)
        : null;
    automationData = {
      schedules:
        schedulesResult.status === 'fulfilled'
          ? [...schedulesResult.value.schedules]
          : null,
      triggers:
        triggersResult.status === 'fulfilled'
          ? [...triggersResult.value.triggers]
          : null,
      autoRun:
        autoRunResult.status === 'fulfilled'
          ? [...autoRunResult.value.entries]
          : null,
      dishes:
        dishesResult.status === 'fulfilled'
          ? [...dishesResult.value.dishes]
          : null,
      dishLastRuns:
        dishesResult.status === 'fulfilled'
          ? dishesResult.value.last_runs ?? {}
          : {},
    };
    // Skip when a broadcast snapshot landed while this read was in flight —
    // the event is the fresher recompute (codex fold, MEDIUM).
    if (runnabilityEventSeq === runnabilityEventSeqAtStart) {
      runnability =
        runnabilityResult.status === 'fulfilled'
          ? new Map(
              runnabilityResult.value.recipes.map((row) => [row.recipe_id, row]),
            )
          : null;
    }
    pii =
      piiResult.status === 'fulfilled'
        ? new Map(
            piiResult.value.recipes.map((row) => [row.recipe_id, row.summary]),
          )
        : null;
    // A deep-linked recipe that no longer exists (uninstalled, or a stale
    // URL) drops back to the list rather than showing an empty detail — but
    // ONLY when the list actually LOADED and proved the slug absent. A
    // transient `recipe.list` failure must not discard a valid deep-link
    // (codex HIGH); the next refresh re-resolves it.
    if (
      recipeResult.status === 'fulfilled'
      && selectedRecipeId !== null
      && !recipes.some((r) => r.recipe_id === selectedRecipeId)
    ) {
      detailVisitGeneration += 1;
      resetDishState();
      selectedRecipeId = null;
      syncRecipeHash();
    }
    loading = false;
    render();

    // Do not hold the installed-recipe paint on the public marketplace. The
    // route is already interactive above; this soft completion adds (or hides)
    // only the bundled workflow-pack CTA. `whenLoaded()` still awaits it, which
    // gives tests and refresh callers a deterministic settled snapshot.
    const selected = selectedRecipeId === null
      ? undefined
      : recipes.find((entry) => entry.recipe_id === selectedRecipeId);
    if (selected !== undefined && recipeBundleKey(selected) !== null) {
      await loadBundleCatalog(true);
    }
  };

  const startRefresh = (): void => {
    pendingLoadPromise = refreshData();
  };

  /** Targeted re-fetch of the automation status lists after a broadcast —
   *  keeps the detail's status line fresh without the full-route flash. */
  const refreshAutomation = async (): Promise<void> => {
    automationRefreshGeneration += 1;
    const myGeneration = automationRefreshGeneration;
    const [schedulesResult, triggersResult, autoRunResult, dishesResult] =
      await Promise.allSettled([
        opts.schedulesListCaller !== undefined
          ? opts.schedulesListCaller()
          : Promise.reject(new Error('no schedules caller')),
        opts.triggersListCaller !== undefined
          ? opts.triggersListCaller()
          : Promise.reject(new Error('no triggers caller')),
        opts.autoRunListCaller !== undefined
          ? opts.autoRunListCaller()
          : Promise.reject(new Error('no auto-run caller')),
        opts.dishesListCaller !== undefined
          ? opts.dishesListCaller()
          : Promise.reject(new Error('no dishes caller')),
      ]);
    // Freshest-kickoff-wins — drop an out-of-order completion (codex MEDIUM).
    if (disposed || myGeneration !== automationRefreshGeneration) return;
    automationData = {
      schedules:
        schedulesResult.status === 'fulfilled'
          ? [...schedulesResult.value.schedules]
          : automationData.schedules,
      triggers:
        triggersResult.status === 'fulfilled'
          ? [...triggersResult.value.triggers]
          : automationData.triggers,
      autoRun:
        autoRunResult.status === 'fulfilled'
          ? [...autoRunResult.value.entries]
          : automationData.autoRun,
      // Same keep-prior-on-failure posture as its siblings: a failed
      // refresh must not blank a section that was rendering fine.
      dishes:
        dishesResult.status === 'fulfilled'
          ? [...dishesResult.value.dishes]
          : automationData.dishes,
      dishLastRuns:
        dishesResult.status === 'fulfilled'
          ? dishesResult.value.last_runs ?? {}
          : automationData.dishLastRuns,
    };
    render();
  };

  const previewRecipe = (
    recipeId: string,
    opener: HTMLElement | null,
  ): void => {
    const entry = recipes.find((candidate) => candidate.recipe_id === recipeId);
    if (entry === undefined || listPreview === null) return;
    rememberRecipeList(recipeId);
    const actionKind = classifyRecipeAction(entry.recipe);
    const packRefs = recipePackRefs(entry.recipe);
    const runState = runnability?.get(recipeId);
    const piiState = pii?.get(recipeId);
    listPreview.open({
      id: recipeId,
      eyebrow: 'Recipe preview',
      title: recipeDisplayName(entry),
      summary: entry.recipe.metadata?.description ?? '',
      facts: [
        {
          label: 'Activation',
          value: actionKind === 'manual'
            ? 'Manual'
            : `Reactive · ${deriveTriggerKind(entry)}`,
        },
        {
          label: 'Source',
          value: packRefs.length === 0
            ? 'A Recipe on its own'
            : packRefs.map((ref) => ref.pack_ref).join(', '),
        },
        {
          label: 'Readiness',
          value: runState === undefined
            ? 'Not checked'
            : runnabilityPillCopy(runState),
        },
        {
          label: 'AI data',
          value: piiState?.headline
            || (piiState === undefined ? 'Not checked' : 'Nothing else to tell you'),
        },
      ],
      primaryLabel: 'Open the Recipe',
    }, opener);
  };

  const openRecipe = (recipe_id: string): void => {
    if (!recipes.some((r) => r.recipe_id === recipe_id)) return;
    // The sheet is non-modal, so an explicit Open behind it remains reachable.
    // Entering durable detail retires the preview instead of stacking layers.
    listPreview?.close();
    if (selectedRecipeId === null) rememberRecipeList(recipe_id);
    pendingDetailFocusRecipeId = recipe_id;
    pendingListCardFocusRecipeId = null;
    pendingListControlFocus = null;
    if (selectedRecipeId !== recipe_id) {
      detailVisitGeneration += 1;
      resetDishState();
      resultPanel = null;
      resetResultFilterStates(null);
      // Grid state belongs to the PANEL, and the paging guard reads this map
      // directly. ⚠ Belt-and-braces, NOT a fixed bug: every result-producing
      // path (`runRecipeDefaults`, `confirmRun`) already resets the map, so a
      // dirty grid cannot currently reach another recipe's panel. This makes the
      // invariant true by construction instead of by a chain of four other
      // resets — it is deliberately untested, because a test for it would only
      // observe the nulled panel and pass for the wrong reason.
      resultGridStates = new Map();
      resultSelectStates = new Map();
      defaultRunBusy = false;
      defaultRunError = null;
      defaultRunMissingPacks = null;
      resultFileBusy = new Set();
      resultFileErrors = new Map();
      resultFileVerified = new Set();
      resultFileGeneration += 1;
    }
    selectedRecipeId = recipe_id;
    void ensureCarrierRefs();
    syncRecipeHash();
    render();
    const selected = recipes.find((entry) => entry.recipe_id === recipe_id);
    if (selected !== undefined && recipeBundleKey(selected) !== null) {
      void loadBundleCatalog();
    }
  };

  const closeDetail = (): void => {
    if (
      defaultRunBusy
      || autoRunBusy.size > 0
      || dishBusy.size > 0
      || dishFormHandle?.hasInFlightWork() === true
      || hasResultGridSaveInFlight()
      || hasResultFilterInFlight()
    ) {
      const confirm = doc.defaultView?.confirm;
      if (
        confirm !== undefined
        && !confirm('Something is still happening. Leave anyway?')
      ) return;
    } else if (hasUnsavedResultGridChanges()) {
      const confirm = doc.defaultView?.confirm;
      if (
        confirm !== undefined
        && !confirm(
          'You have changes you have not saved. Leave anyway?',
        )
      ) return;
    }
    const remembered = readListContinuity<RecipeListFilter>(
      doc,
      RECIPES_LIST_CONTINUITY_KEY,
    );
    pendingListCardFocusRecipeId = selectedRecipeId ?? remembered?.focusedId ?? null;
    pendingListControlFocus = null;
    pendingListScrollRestore = remembered?.scroll;
    pendingDetailFocusRecipeId = null;
    detailVisitGeneration += 1;
    resetDishState();
    selectedRecipeId = null;
    resultPanel = null;
    resetResultFilterStates(null);
    resultGridStates = new Map();
    resultSelectStates = new Map();
    defaultRunBusy = false;
    defaultRunError = null;
    defaultRunMissingPacks = null;
    resultFileBusy = new Set();
    resultFileErrors = new Map();
    resultFileVerified = new Set();
    resultFileGeneration += 1;
    syncRecipeHash();
    render();
  };

  listPreview = mountListPreview({
    host: opts.root,
    document: doc,
    scrollRoot,
    onOpen: (recipeId) => openRecipe(recipeId),
  });

  /** D-222 §2.3 — the five defaulted-primitive-only recipes have no first-
   *  class question to ask. Their primary Run executes with server-resolved
   *  defaults, while the adjacent explicit override control still opens the
   *  raw config editor. */
  /** D-319 — runs as `dish_id`, else the recipe's main dish when it has
   *  one (a run that names no dish takes its settings anyway; naming it puts
   *  the run in the dish's history). */
  const runRecipeDefaults = async (recipeId: string, dish_id?: string): Promise<void> => {
    if (defaultRunBusy || selectedRecipeId !== recipeId) return;
    const visitAtDispatch = detailVisitGeneration;
    const stillOwnsVisit = (): boolean => !disposed
      && selectedRecipeId === recipeId
      && detailVisitGeneration === visitAtDispatch;
    const execute = opts.recipeExecuteCaller;
    if (execute === undefined) {
      defaultRunError = 'This server cannot run things yet.';
      render();
      return;
    }
    const panelAtDispatch = resultPanel;
    defaultRunBusy = true;
    defaultRunError = null;
    defaultRunMissingPacks = null;
    render();
    try {
      const runAs = dish_id ?? mainDishOf(recipeId)?.dish_id;
      const result = await execute({ recipe_id: recipeId, config: {}, ...(runAs !== undefined ? { dish_id: runAs } : {}) });
      if (!stillOwnsVisit()) return;
      const previous = withoutRenderedRecipe(
        panelAtDispatch ?? undefined,
        result.recipe_id,
      );
      resultPanel = {
        route_recipe_id: recipeId,
        source_recipe_id: recipeId,
        render_recipe_id: result.recipe_id,
        origin: 'recipe-detail',
        result,
        ...(previous !== undefined ? { previous } : {}),
      };
      resetResultFilterStates(result);
    resultGridStates = new Map();
    resultSelectStates = new Map();
      resultFileBusy = new Set();
      resultFileErrors = new Map();
      resultFileVerified = new Set();
      resultFileGeneration += 1;
    } catch (error) {
      if (stillOwnsVisit()) {
        // A missing pack has an action attached, so it renders as the shared
        // offer rather than as text. Every other failure keeps the plain message.
        defaultRunMissingPacks = missingPacksFromError(error);
        defaultRunError = errMessage(error);
      }
    } finally {
      if (stillOwnsVisit()) {
        defaultRunBusy = false;
        render();
      }
    }
  };

  const openRunModal = (
    recipe_id: string,
    tab: 'run' | 'schedule' = 'run',
    prefill?: RecipesRunModalPrefill,
    origin?: RecipesResultOrigin,
    /** D-319 — the dish it was opened from (its menu's Run once / Add a schedule). */
    dish_id?: string,
  ): void => {
    const entry = recipes.find((row) => row.recipe_id === recipe_id);
    if (entry === undefined) return;
    // One modal at a time — a re-open while a run modal (or the guided
    // spreadsheet import that stands in for one) is up is a no-op.
    if (childRunModal !== null || childSheetImport !== null) return;
    const routeRecipeIdAtOpen = selectedRecipeId;
    const activeBeforeOpen = doc.activeElement as HTMLElement | null | undefined;
    listPreview?.close();
    const detailRunReturnRecipeId = routeRecipeIdAtOpen === recipe_id
      && activeBeforeOpen?.getAttribute?.(RECIPES_ROUTE_RUN_BUTTON_ATTR) === recipe_id
        ? recipe_id
        : null;
    const resolvedOrigin = origin
      ?? (routeRecipeIdAtOpen === recipe_id ? 'recipe-detail' : 'related-recipes');
    const activePanelAtOpen =
      routeRecipeIdAtOpen !== null
      && resultPanel?.route_recipe_id === routeRecipeIdAtOpen
        ? resultPanel
        : null;
    const sourcePanelAtOpen =
      resolvedOrigin === 'recipe-detail' ? null : activePanelAtOpen;
    const sourceRecipeIdAtOpen = resolvedOrigin === 'result-action'
      ? activePanelAtOpen?.render_recipe_id ?? null
      : resolvedOrigin === 'recipe-detail'
        ? recipe_id
        : null;
    const runRecordRefSearch = recordRefSearchFor(entry.recipe);
    /** Hand focus back to the detail's Run button the dialog was opened from. */
    const returnFocusToRunButton = (): void => {
      if (
        detailRunReturnRecipeId !== null
        && selectedRecipeId === detailRunReturnRecipeId
      ) {
        const replacement = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_RUN_BUTTON_ATTR}]`,
        ) as HTMLElement | null | undefined;
        if (
          replacement?.getAttribute?.(RECIPES_ROUTE_RUN_BUTTON_ATTR)
            === detailRunReturnRecipeId
        ) {
          replacement.focus?.({ preventScroll: true });
        }
      }
    };
    /** Show a finished run as the route's current result. */
    const showRunResult = (result: ServerExecuteResponse): void => {
      if (
        routeRecipeIdAtOpen !== null
        && selectedRecipeId === routeRecipeIdAtOpen
      ) {
        const previous = withoutRenderedRecipe(
          sourcePanelAtOpen ?? undefined,
          result.recipe_id,
        );
        resultPanel = {
          route_recipe_id: routeRecipeIdAtOpen,
          source_recipe_id: sourceRecipeIdAtOpen,
          render_recipe_id: result.recipe_id,
          origin: resolvedOrigin,
          result,
          ...(previous !== undefined ? { previous } : {}),
        };
        resetResultFilterStates(result);
        resultGridStates = new Map();
        resultSelectStates = new Map();
        resultFileBusy = new Set();
        resultFileErrors = new Map();
        resultFileVerified = new Set();
        resultFileGeneration += 1;
        render();
      }
    };
    /** Show it, and if it is held for approval, follow the run: once the owner
     *  approves it — in the tray, on another device — its own result replaces
     *  the note, as long as the note is still what this route shows. */
    const showRunResultAndFollow = (result: ServerExecuteResponse): void => {
      showRunResult(result);
      if (
        opts.followHeldRun === undefined
        || disposed
        || result.awaiting_approval !== true
      ) return;
      heldRunStops.push(opts.followHeldRun(result, (next, later) => {
        if (disposed || resultPanel?.result !== later.replaces) return;
        showRunResult(next);
      }));
    };
    // D-292 — a declared spreadsheet import gets the guided flow on Run:
    // upload → match the file's own columns → a real server check → import. The
    // declaration is re-checked here (`sheetImportFor`), not trusted from
    // install; one that does not hold keeps the modal below.
    const sheet = tab === 'run' && opts.recipeExecuteCaller !== undefined
      ? sheetImportFor(entry)
      : null;
    if (sheet !== null && opts.recipeExecuteCaller !== undefined) {
      ensureSheetImportResultStyles(doc);
      const remembered = rememberedSettings();
      childSheetImport = wireSheetImport({
        recipe: entry,
        declaration: sheet,
        // Portal to body, like the run modal, so a route repaint cannot wipe it.
        mount: (doc as { body?: HTMLElement }).body ?? opts.root,
        document: doc,
        execute: opts.recipeExecuteCaller,
        ...(opts.sheetImportUploadCaller !== undefined
          ? { uploadFile: opts.sheetImportUploadCaller }
          : {}),
        ...(opts.fileReadCaller !== undefined ? { readFile: opts.fileReadCaller } : {}),
        ...(opts.fileRefSearchCaller !== undefined
          ? { fileRefSearch: opts.fileRefSearchCaller }
          : {}),
        ...(remembered !== null
          ? { configGet: remembered.get, configSet: remembered.set }
          : {}),
        renderResult: renderSheetImportResult,
        ...(prefill?.config !== undefined ? { prefill: prefill.config } : {}),
        onClose: () => {
          childSheetImport = null;
          returnFocusToRunButton();
        },
        onRan: showRunResultAndFollow,
      });
      return;
    }
    runModalRecipeId = recipe_id;
    childRunModal = RunModal.wireRunModal({
      ...(opts.serverTimeZone ? { serverTimeZone: opts.serverTimeZone } : {}),
      recipe: entry,
      document: doc,
      initialTab: tab,
      // D-319 — a run, schedule or trigger made here is a dish's.
      ...(automationData.dishes !== null
        ? { dishes: automationData.dishes.filter((dish) => dish.recipe_id === recipe_id) }
        : {}),
      ...(dish_id !== undefined ? { dish_id } : {}),
      ...(opts.recipeExecuteCaller !== undefined
        ? { execute: opts.recipeExecuteCaller }
        : {}),
      ...(opts.fileRefSearchCaller !== undefined
        ? { fileRefSearch: opts.fileRefSearchCaller }
        : {}),
      ...(runRecordRefSearch !== undefined
        ? { recordRefSearch: runRecordRefSearch }
        : {}),
      // Quick-schedule via the L1 run modal (R24) — wiring the schedule
      // callers lights up the Schedule tab; trigger / auto-run management
      // stays at #automation, with a lightweight bundled sibling toggle in
      // the detail panel.
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
      ...(opts.preapprovalPrepareCaller !== undefined
        ? { preapprovalPrepare: opts.preapprovalPrepareCaller,
            ...(opts.onPreapprovalPrepared !== undefined ? { onPreapprovalPrepared: opts.onPreapprovalPrepared } : {}) }
        : {}),
      onClose: () => {
        childRunModal = null;
        runModalRecipeId = null;
        returnFocusToRunButton();
      },
      onRan: showRunResultAndFollow,
    });
    if (prefill?.config !== undefined) {
      let configText = '{}';
      try {
        configText = JSON.stringify(prefill.config, null, 2) ?? '{}';
      } catch {
        configText = '{}';
      }
      childRunModal.setConfigText(configText);
    }
    if (prefill?.context !== undefined) {
      childRunModal.setContextValues(prefill.context);
    }
    // Portal to body so the route's repaint can't wipe an open run; the
    // fake-doc tests have no `body`, so they get `opts.root` (a sibling of
    // the repainted `routeRoot`, which the route never clears).
    const portal = (doc as { body?: HTMLElement }).body ?? opts.root;
    portal.appendChild(childRunModal.element);
  };

  // D-179 — the recipe INSTALL-config editor: sets the recipe's default-dish
  // overlay, applied as a base to every dishless run. Reuses the shared
  // config-editor overlay (which portals itself to <body>).
  /** Bundle -> owner, so a `record_ref` picker searches the right pack. */
  const recordRefSearchFor = (
    recipe: { metadata?: { recipe_bundle?: unknown } } | undefined,
  ): ((
    entity: string,
    scope?: Readonly<Record<string, string>>,
  ) => RefPicker.RefPickerSearchCaller) | undefined => {
    return bindRecordRefSearchToRecipe(opts.recordRefSearchCaller, recipe);
  };

  // ── D-319 — "Running as" ────────────────────────────────────────

  /** A dish line names a mail template by the owner's name for it. */
  const settingValueText: SettingValueText = (key, type, value) =>
    type === 'mail_template'
      ? typeof value === 'string' ? templateNames?.get(value) ?? null : null
      : plainSettingText(key, type, value);

  /** The owner's template names, read once a recipe with a template setting
   *  shows its dishes; again after a Settings save (it may name a new one). */
  const ensureTemplateNames = (entry: ServerRecipeListEntry): void => {
    const callers = opts.mailTemplateCallers;
    if (callers === undefined || templateNamesRequested) return;
    const wantsNames = Object.values(entry.recipe.variables ?? {}).some((definition) =>
      typeof definition === 'object' && definition !== null && !Array.isArray(definition)
      && (definition as { type?: unknown }).type === 'mail_template');
    if (!wantsNames) return;
    templateNamesRequested = true;
    void callers.list().then(
      (choices) => {
        if (disposed) return;
        templateNames = new Map(choices.map((choice) => [choice.template_id, choice.name]));
        render();
      },
      // The line shows no template name; everything else stands.
      () => {},
    );
  };

  /** The selected recipe's "Running as" section (§5.1). */
  const runningAsFor = (entry: ServerRecipeListEntry): string => {
    ensureTemplateNames(entry);
    return renderRunningAs({
      recipe_id: entry.recipe_id,
      recipe_name: recipeDisplayName(entry),
      recipe: entry.recipe,
      installed: isInstalledRecipeEntry(entry),
      dishes: automationData.dishes === null
        ? null
        : automationData.dishes.filter((dish) => dish.recipe_id === entry.recipe_id),
      lastRuns: automationData.dishLastRuns,
      schedules: automationData.schedules,
      triggers: automationData.triggers,
      autoRun: automationData.autoRun,
      can: {
        create: opts.dishesCreateCaller !== undefined,
        update: opts.dishesUpdateCaller !== undefined,
        remove: opts.dishesDeleteCaller !== undefined,
        run: opts.recipeExecuteCaller !== undefined,
        schedule: opts.schedulesListCaller !== undefined && opts.schedulesCreateCaller !== undefined,
      },
      busy: switchOnReading === entry.recipe_id ? new Set([...dishBusy, '']) : dishBusy,
      openMenu: dishMenuOpen,
      confirmingRemove: dishConfirmingRemove,
      errors: dishErrors,
      failureHref: serializeShellRoute('automation', entry.recipe_id),
      valueText: settingValueText,
      // A timer's window opens on the server's clock (D-269).
      ...(opts.serverTimeZone?.() !== undefined ? { timeZone: opts.serverTimeZone()! } : {}),
    });
  };

  const dishOf = (dish_id: string): Dish | undefined =>
    (automationData.dishes ?? []).find((dish) => dish.dish_id === dish_id);

  const mainDishOf = (recipe_id: string): Dish | undefined =>
    (automationData.dishes ?? []).find((dish) => dish.recipe_id === recipe_id && dish.is_default);

  /** D-319 — "remember these columns" (the guided import): the recipe's
   *  MAIN dish's settings (`main-dish-settings.ts`), and the lists again. */
  const rememberedSettings = (): MainDishSettings | null => {
    const list = opts.dishesListCaller;
    const update = opts.dishesUpdateCaller;
    const create = opts.dishesCreateCaller;
    if (list === undefined || update === undefined || create === undefined) return null;
    const settings = mainDishSettings({ list, update, create });
    return {
      get: settings.get,
      set: async (args) => {
        const result = await settings.set(args);
        if (!disposed) void refreshAutomation();
        return result;
      },
    };
  };

  /** One dish's change: busy while it runs, its error on its line, then the
   *  lists again (the server switched its triggers, schedules and timer). */
  const mutateDish = async (dish_id: string, change: () => Promise<unknown>): Promise<void> => {
    if (dishBusy.has(dish_id)) return;
    const nextErrors = new Map(dishErrors);
    nextErrors.delete(dish_id);
    dishErrors = nextErrors;
    dishBusy = new Set(dishBusy).add(dish_id);
    render();
    try {
      await change();
      if (!disposed) await refreshAutomation();
    } catch (error) {
      if (!disposed) dishErrors = new Map(dishErrors).set(dish_id, `Recued could not change that: ${errMessage(error)}`);
    } finally {
      if (!disposed) {
        const next = new Set(dishBusy);
        next.delete(dish_id);
        dishBusy = next;
        render();
      }
    }
  };

  /** D-319 §5.2 — the switch-on form (`dish-form.ts`): Switch on, Save
   *  settings, + Add another and a dish's Settings. This page reads where a
   *  first dish starts from, and owns the busy state and errors around it. */
  const openDishForm = async (
    mode: DishFormMode,
    recipe_id: string,
    dish_id: string | null,
  ): Promise<void> => {
    if (dishFormHandle !== null) return;
    const entry = recipes.find((row) => row.recipe_id === recipe_id);
    if (entry === undefined) return;
    const mine = (automationData.dishes ?? []).filter((dish) => dish.recipe_id === recipe_id);
    const dish = dish_id === null ? undefined : mine.find((candidate) => candidate.dish_id === dish_id);
    if (mode === 'settings'
      ? dish === undefined || opts.dishesUpdateCaller === undefined
      : opts.dishesCreateCaller === undefined) return;
    let start = dishFormStart(mode, mine, dish);
    if (start === null) {
      // The first dish starts from the recipe's defaults (the form shows them)
      // and whatever the install chose for it (its mail template).
      start = {};
      const defaults = opts.dishesDefaultsCaller;
      if (defaults !== undefined) {
        if (switchOnReading !== null) return;
        const token = ++switchOnToken;
        switchOnReading = recipe_id;
        const nextErrors = new Map(dishErrors);
        nextErrors.delete('');
        dishErrors = nextErrors;
        render();
        let read: Record<string, unknown> | null = null;
        try {
          read = (await defaults({ recipe_id })).config_overlay;
        } catch (error) {
          if (!disposed && token === switchOnToken) {
            dishErrors = new Map(dishErrors).set('',
              `Recued could not read what this recipe starts from: ${errMessage(error)}`);
          }
        } finally {
          if (!disposed && token === switchOnToken) {
            switchOnReading = null;
            render();
          }
        }
        // Left (or reopened) meanwhile: this read is retired.
        if (read === null || disposed || token !== switchOnToken || dishFormHandle !== null) return;
        start = { ...read };
      }
    }
    const recordRefSearch = recordRefSearchFor(entry.recipe);
    dishFormHandle = openSharedDishForm({
      document: doc,
      mode,
      entry,
      dishes: mine,
      ...(dish !== undefined ? { dish } : {}),
      start,
      callers: {
        ...(opts.dishesCreateCaller !== undefined ? { create: opts.dishesCreateCaller } : {}),
        ...(opts.dishesUpdateCaller !== undefined ? { update: opts.dishesUpdateCaller } : {}),
        ...(opts.schedulesCreateCaller !== undefined ? { schedulesCreate: opts.schedulesCreateCaller } : {}),
      },
      ...(opts.fileRefSearchCaller !== undefined ? { fileRefSearch: opts.fileRefSearchCaller } : {}),
      ...(recordRefSearch !== undefined ? { recordRefSearch } : {}),
      ...(opts.mailTemplateCallers !== undefined ? { mailTemplates: opts.mailTemplateCallers } : {}),
      onCreated: (made, scheduleError) => {
        pendingDishFocus = made.dish_id;
        if (scheduleError !== null && !disposed) {
          dishErrors = new Map(dishErrors).set(made.dish_id,
            `Switched on, but Recued could not add the schedule: ${errMessage(scheduleError)}`);
        }
      },
      onSaved: () => {
        templateNamesRequested = false;
        if (!disposed) void refreshAutomation();
      },
      onClose: () => { dishFormHandle = null; },
    });
  };

  /** "Run once as this": straight away when the dish holds every value a run
   *  would ask for, else the run dialog, running as it. */
  const runAsDish = (recipe_id: string, dish_id: string): void => {
    const entry = recipes.find((row) => row.recipe_id === recipe_id);
    const dish = dishOf(dish_id);
    if (entry === undefined || dish === undefined) return;
    const answersAll = Object.entries(entry.recipe.variables ?? {}).every(([key, definition]) =>
      !isInvocationVariable(definition) || hasSettingValue(dish.config_overlay[key]));
    if (answersAll) void runRecipeDefaults(recipe_id, dish_id);
    else openRunModal(recipe_id, 'run', undefined, undefined, dish_id);
  };

  const onRunningAsAction = (action: RunningAsAction, target: HTMLElement): void => {
    const dish_id = target.getAttribute(RUNNING_AS_DISH_ATTR);
    const recipe_id = target.getAttribute(RUNNING_AS_RECIPE_ATTR)
      ?? (dish_id !== null ? dishOf(dish_id)?.recipe_id ?? null : null)
      ?? selectedRecipeId;
    if (recipe_id === null) return;
    const update = opts.dishesUpdateCaller;
    switch (action) {
      case 'switch-on':
      case 'save-settings':
      case 'add':
        // A related recipe's "Switch on…" opens its own page under the form,
        // so what follows (busy, errors, its new dish) shows where it is.
        if (recipe_id !== selectedRecipeId) openRecipe(recipe_id);
        void openDishForm(action, recipe_id, null);
        return;
      case 'settings':
        if (dish_id !== null) void openDishForm('settings', recipe_id, dish_id);
        return;
      case 'menu':
        if (dish_id === null) return;
        dishMenuOpen = dishMenuOpen === dish_id ? null : dish_id;
        dishConfirmingRemove = null;
        render();
        return;
      case 'toggle-on':
      case 'toggle-off':
      // Switching a dish on again, while it is on, restarts what the server
      // stopped (its breaker, a disarmed trigger or schedule).
      case 'rearm':
        if (dish_id !== null && update !== undefined) {
          void mutateDish(dish_id, () => update({ dish_id, enabled: action !== 'toggle-off' }));
        }
        return;
      case 'make-main':
        if (dish_id === null || update === undefined) return;
        dishMenuOpen = null;
        void mutateDish(dish_id, () => update({ dish_id, main: true }));
        return;
      case 'run':
        if (dish_id === null) return;
        dishMenuOpen = null;
        render();
        runAsDish(recipe_id, dish_id);
        return;
      case 'schedule':
        if (dish_id === null) return;
        dishMenuOpen = null;
        render();
        openRunModal(recipe_id, 'schedule', undefined, undefined, dish_id);
        return;
      case 'remove':
        if (dish_id === null) return;
        dishMenuOpen = null;
        dishConfirmingRemove = dish_id;
        render();
        return;
      case 'remove-cancel':
        dishConfirmingRemove = null;
        render();
        return;
      case 'remove-confirm': {
        const remove = opts.dishesDeleteCaller;
        if (dish_id === null || remove === undefined || dishConfirmingRemove !== dish_id) return;
        void mutateDish(dish_id, async () => {
          await remove({ dish_id });
          dishConfirmingRemove = null;
        });
        return;
      }
    }
  };

  const toggleAutoRun = async (recipe_id: string, enabled: boolean): Promise<void> => {
    const update = opts.autoRunUpdateCaller;
    if (update === undefined || autoRunBusy.has(recipe_id)) return;
    const nextErrors = new Map(autoRunErrors);
    nextErrors.delete(recipe_id);
    autoRunErrors = nextErrors;
    autoRunBusy = new Set(autoRunBusy).add(recipe_id);
    render();
    try {
      const { entry } = await update({ recipe_id, enabled });
      const current = automationData.autoRun ?? [];
      // D-319 — the row is one dish's timer: it replaces that timer's row (or
      // the recipe's "not switched on" one), never the recipe's other dishes'.
      automationData = {
        ...automationData,
        autoRun: [
          ...current.filter((row) => !(row.recipe_id === recipe_id
            && ((row.dish_id ?? null) === null || row.dish_id === entry.dish_id))),
          entry,
        ],
      };
    } catch (error) {
      const next = new Map(autoRunErrors);
      next.set(recipe_id, `Recued could not change that: ${errMessage(error)}`);
      autoRunErrors = next;
    } finally {
      const next = new Set(autoRunBusy);
      next.delete(recipe_id);
      autoRunBusy = next;
      render();
    }
  };

  const reviewAutoRun = (recipe_id: string): void => {
    const entry = recipes.find(row => row.recipe_id === recipe_id);
    const auto = recipeAutoRun(automationData, recipe_id);
    if (!entry || !auto || auto.lifecycle_revision === undefined || auto.preapproval || auto.auto_disabled
      || (auto.dish_id ?? null) === null || !opts.preapprovalPrepareCaller || !opts.onPreapprovalPrepared) return;
    preapprovalActivation?.destroy();
    preapprovalActivation = openPreapprovalActivation({ document: doc, recipe_id, publisher_id: entry.publisher_id,
      name: recipeDisplayName(entry), activation: { kind: 'next_auto_run', recipe_id,
        publisher_id: entry.publisher_id, dish_id: auto.dish_id!, expected_revision: auto.lifecycle_revision },
      prepare: opts.preapprovalPrepareCaller, onPrepared: opts.onPreapprovalPrepared,
      onClose: () => { preapprovalActivation = null; },
    });
  };

  const closeRunModal = (): void => {
    // D-292 — the guided import stands in for the run modal; tear it down too.
    if (childSheetImport !== null) {
      const sheetDialog = childSheetImport;
      childSheetImport = null;
      sheetDialog.destroy();
    }
    if (childRunModal === null) return;
    const open = childRunModal;
    childRunModal = null;
    runModalRecipeId = null;
    open.destroy();
  };

  const openResultAction = (actionId: string | null): void => {
    if (actionId === null) return;
    const action = resultActions.get(actionId);
    if (action === undefined) return;
    if (action.confirm !== undefined) {
      const confirm = doc.defaultView?.confirm;
      if (typeof confirm === 'function' && !confirm.call(doc.defaultView, action.confirm)) {
        return;
      }
    }
    openRunModal(action.recipe_id, 'run', {
      config: action.config ?? {},
      context: action.context ?? {},
    }, 'result-action');
  };

  const openSelectedResultAction = (groupId: string | null): void => {
    if (groupId === null) return;
    const select = routeRoot.querySelector?.(
      `[${RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR}="${groupId}"]`,
    ) as HTMLSelectElement | null;
    openResultAction(select?.value ?? null);
  };

  const setResultFilterValue = (
    filterKey: string,
    variableKey: string,
    value: unknown,
    repaint = true,
  ): void => {
    const active = activeResultFilter(filterKey);
    if (active === null || active.state.busy) return;
    resultFilterStates = new Map(resultFilterStates).set(filterKey, {
      ...setOutputFilterDraftValue(
        active.descriptor,
        active.state,
        variableKey,
        value,
      ),
      busy: false,
      busy_action: null,
      error: null,
    });
    if (repaint) render();
  };

  /** Locate an editable grid's descriptor + its seed data in the rendered
   *  panel. The descriptor is host-derived and carries the proof the config
   *  came from an installed section — a caller never supplies it. */
  const findGridDescriptor = (
    key: string,
  ): { descriptor: ResolvedTableEditDescriptor; data: unknown } | null => {
    const panel = resultPanel;
    if (panel === null) return null;
    return findResultTableEdit(panel.result, key, panel.render_recipe_id);
  };

  const mutateResultGridRows = (
    key: string,
    update: (
      descriptor: ResolvedTableEditDescriptor,
      state: OutputTableEditState,
    ) => OutputTableEditState,
  ): void => {
    const found = findGridDescriptor(key);
    if (found === null) return;
    const state = resultGridStates.get(key)
      ?? initialTableEditState(found.descriptor, found.data);
    const next = update(found.descriptor, state);
    if (next === state) return;
    resultGridStates = new Map(resultGridStates).set(key, next);
    render();
  };

  const addResultGridRow = (key: string): void => {
    mutateResultGridRows(key, gridAddRow);
  };

  const removeResultGridRow = (key: string, rowIndex: number): void => {
    mutateResultGridRows(key, (descriptor, state) =>
      gridRemoveRow(descriptor, state, rowIndex));
  };

  /** Submit the grid: ONE key, the variable its section declared, plus the
   *  invocation the server checks against the installed recipe. Mirrors
   *  `submitResultFilter` — same panel-swap discipline, same staleness guard. */
  /** D-282 B6 — the picked rows behind one selectable table. */
  const findSelectDescriptor = (
    key: string,
  ): { descriptor: ResolvedTableSelectDescriptor; data: unknown } | null => {
    const panel = resultPanel;
    if (panel === null) return null;
    return findResultTableSelect(panel.result, key, panel.render_recipe_id);
  };

  const mutateResultSelection = (
    key: string,
    update: (state: OutputTableSelectState) => OutputTableSelectState,
  ): void => {
    const found = findSelectDescriptor(key);
    if (found === null) return;
    const state = resultSelectStates.get(key)
      ?? initialTableSelectState(found.descriptor, found.data);
    const next = update(state);
    if (next === state) return;
    resultSelectStates = new Map(resultSelectStates).set(key, next);
    render();
  };

  /** Act on the picked rows: ONE run, one array, one audit anchor. See the
   *  pack app view's twin for why this is not N runs. */
  const submitResultSelection = async (key: string): Promise<void> => {
    const execute = opts.recipeExecuteCaller;
    const panelAtDispatch = resultPanel;
    const found = findSelectDescriptor(key);
    if (execute === undefined || panelAtDispatch === null || found === null) return;
    const state = resultSelectStates.get(key)
      ?? initialTableSelectState(found.descriptor, found.data);
    // An empty selection has nothing to act on. The button is disabled too, but
    // the dispatch seam owns the same rule so a scripted click cannot turn
    // "nothing picked" into a run over the recipe's default.
    if (!canSubmitTableSelect(state)) return;

    resultSelectStates = new Map(resultSelectStates).set(key, beginTableSelectSubmit(state));
    render();
    try {
      const result = await execute({
        recipe_id: panelAtDispatch.render_recipe_id,
        config: outputTableSelectConfig(found.descriptor, state),
        invocation: outputTableSelectInvocation(found.descriptor),
      });
      if (resultPanel !== panelAtDispatch) return;
      resultPanel = {
        route_recipe_id: panelAtDispatch.route_recipe_id,
        source_recipe_id: panelAtDispatch.render_recipe_id,
        render_recipe_id: result.recipe_id,
        origin: 'result-filter',
        result,
      };
      resetResultFilterStates(result);
      resultGridStates = new Map();
      resultSelectStates = new Map();
      render();
    } catch (error) {
      if (resultPanel !== panelAtDispatch) return;
      // The selection SURVIVES a failure — read the reason, press again.
      resultSelectStates = new Map(resultSelectStates).set(
        key,
        failTableSelectSubmit(state, errMessage(error)),
      );
      render();
    }
  };

  const submitResultGrid = async (key: string): Promise<void> => {
    const execute = opts.recipeExecuteCaller;
    const panelAtDispatch = resultPanel;
    const found = findGridDescriptor(key);
    if (execute === undefined || panelAtDispatch === null || found === null) return;
    const state = resultGridStates.get(key)
      ?? initialTableEditState(found.descriptor, found.data);
    // An untouched grid has nothing to persist. The button is disabled too,
    // but the dispatch seam owns the same rule so a custom host or scripted
    // click cannot turn "reviewed, no changes" into a redundant write run.
    if (!canSubmitTableEdit(state)) return;

    resultGridStates = new Map(resultGridStates).set(key, beginTableEditSubmit(state));
    render();
    try {
      const result = await execute({
        recipe_id: panelAtDispatch.render_recipe_id,
        config: outputTableEditConfig(found.descriptor, state),
        invocation: outputTableEditInvocation(found.descriptor),
      });
      // ⛔ The panel may have moved while the write was in flight. Dropping the
      // result is right — writing it into a panel the owner has navigated away
      // from would show a stale grid as the live one.
      if (resultPanel !== panelAtDispatch) return;
      resultPanel = {
        route_recipe_id: panelAtDispatch.route_recipe_id,
        source_recipe_id: panelAtDispatch.render_recipe_id,
        render_recipe_id: result.recipe_id,
        origin: 'result-filter',
        result,
      };
      resetResultFilterStates(result);
      resultGridStates = new Map();
      resultSelectStates = new Map();
      render();
    } catch (error) {
      if (resultPanel !== panelAtDispatch) return;
      resultGridStates = new Map(resultGridStates).set(
        key,
        failTableEditSubmit(state, errMessage(error)),
      );
      render();
    }
  };

  const submitResultFilter = async (
    filterKey: string,
    mode: 'search' | 'next' | 'previous' = 'search',
  ): Promise<void> => {
    const execute = opts.recipeExecuteCaller;
    const active = activeResultFilter(filterKey);
    const panelAtDispatch = resultPanel;
    if (active === null || panelAtDispatch === null || active.state.busy) return;
    if (execute === undefined) {
      resultFilterStates = new Map(resultFilterStates).set(filterKey, {
        ...active.state,
        error: 'This server cannot run things yet.',
      });
      render();
      return;
    }

    // The dirty-grid refusal + draft validation + cursor selection are the
    // panel's fence, shared with `#packs/<slug>` so a host that draws its own
    // Search control hits the same wall the rendered one shows.
    let run: ReturnType<typeof resultFilterRunConfig>;
    try {
      run = resultFilterRunConfig(
        active.descriptor,
        active.state,
        mode,
        anyTableEditDirty(resultGridStates),
      );
    } catch (error) {
      resultFilterStates = new Map(resultFilterStates).set(filterKey, {
        ...active.state,
        error: errMessage(error),
      });
      render();
      return;
    }
    // No cursor in that direction — nothing to do, and not an error.
    if (run === null) return;

    resultFilterStates = new Map(resultFilterStates).set(filterKey, {
      ...active.state,
      busy: true,
      busy_action: mode,
      error: null,
    });
    render();
    try {
      const result = await execute({
        recipe_id: panelAtDispatch.render_recipe_id,
        config: run.config,
        invocation: run.invocation,
      });
      if (resultPanel !== panelAtDispatch) return;
      const previous = withoutRenderedRecipe(
        panelAtDispatch.previous,
        result.recipe_id,
      );
      resultPanel = {
        route_recipe_id: panelAtDispatch.route_recipe_id,
        source_recipe_id: panelAtDispatch.render_recipe_id,
        render_recipe_id: result.recipe_id,
        origin: 'result-filter',
        result,
        ...(previous !== undefined ? { previous } : {}),
      };
      resetResultFilterStates(result);
    resultGridStates = new Map();
    resultSelectStates = new Map();
      resultFileBusy = new Set();
      resultFileErrors = new Map();
      resultFileVerified = new Set();
      resultFileGeneration += 1;
      render();
    } catch (error) {
      if (resultPanel !== panelAtDispatch) return;
      resultFilterStates = new Map(resultFilterStates).set(filterKey, {
        ...active.state,
        busy: false,
        busy_action: null,
        error: errMessage(error),
      });
      render();
    }
  };

  // `exactResultFileReadError` / `triggerResultFileOpen` /
  // `openResultPreviewWindow` moved to `recipe-result-panel.ts` so the packs
  // Use tab opens a file on exactly these terms. `doc` + the object-url map
  // are passed in rather than captured.
  /** D-274 — pass two of a `file_preview` block. The string render left an
   *  empty `<figure>` per file; this fills each one by calling the SHARED body
   *  renderer, the same code path the modal viewer uses.
   *
   *  ⛔ Guarded by generation, because a repaint replaces the mounts underneath
   *  an in-flight decode. A late draw that landed in a detached element would be
   *  invisible; one that landed in a REUSED element would show the previous
   *  run's photo next to this run's sentence, which is the failure that matters
   *  in a review screen.
   *
   *  A mount that fails keeps its fallback text rather than emptying: an empty
   *  box says nothing, and "could not load" beside a filename is actionable. */
  let filePreviewGeneration = 0;
  const filePreviewUrls = new Set<string>();
  const releaseFilePreviews = (): void => {
    for (const url of filePreviewUrls) URL.revokeObjectURL(url);
    filePreviewUrls.clear();
  };
  const mountFilePreviews = (): void => {
    const callers = opts.filePreviewCallers;
    const mounts = typeof routeRoot.querySelectorAll === 'function'
      ? Array.from(routeRoot.querySelectorAll(`[${RECIPES_FILE_PREVIEW_MOUNT_ATTR}]`))
      : [];
    if (mounts.length === 0) return;
    filePreviewGeneration += 1;
    releaseFilePreviews();
    const own = filePreviewGeneration;
    if (callers === undefined) return;   // fallback text stays; nothing breaks
    const controller = new AbortController();
    for (const mount of mounts) {
      const element = mount as HTMLElement;
      const recordId = element.getAttribute(RECIPES_FILE_PREVIEW_MOUNT_ATTR);
      if (recordId === null || recordId === '') continue;
      const filename = element.getAttribute(RECIPES_FILE_PREVIEW_NAME_ATTR) ?? undefined;
      void (async () => {
        const body = doc.createElement('div');
        try {
          await renderFilePreviewBody({
            doc,
            body,
            urlFor: (bytes, mime) => {
              const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
              filePreviewUrls.add(url);
              return url;
            },
            status: () => {},
            signal: controller.signal,
            isCurrent: () => own === filePreviewGeneration,
            onFailure: () => {},
          }, { record_id: recordId, ...(filename !== undefined ? { filename } : {}) }, callers);
          if (own !== filePreviewGeneration || !element.isConnected) return;
          element.replaceChildren(body);
        } catch (failure) {
          if (own !== filePreviewGeneration || !element.isConnected) return;
          const note = doc.createElement('p');
          note.className = 'recipes-result-file-error';
          note.setAttribute('role', 'alert');
          note.textContent = failure instanceof Error
            ? failure.message
            : `Could not show ${filename ?? 'this file'}.`;
          element.replaceChildren(note);
        }
      })();
    }
  };

  const openResultFile = async (
    fileId: string | null,
    rawMode: string | null,
  ): Promise<void> => {
    if (fileId === null || (rawMode !== 'preview' && rawMode !== 'download')) return;
    const registered = resultFiles.get(fileId);
    if (registered === undefined || opts.fileReadCaller === undefined) return;
    if (resultFileBusy.has(registered.stableKey)) return;
    const previewWindow = rawMode === 'preview'
      ? openResultPreviewWindow(doc)
      : undefined;
    if (previewWindow === null) {
      resultFileErrors = new Map(resultFileErrors).set(
        registered.stableKey,
        'Your browser blocked the preview window. Allow pop-ups for this address, or download the file instead.',
      );
      render();
      return;
    }
    const generationAtOpen = resultFileGeneration;
    resultFileBusy = new Set(resultFileBusy).add(registered.stableKey);
    const clearedErrors = new Map(resultFileErrors);
    clearedErrors.delete(registered.stableKey);
    resultFileErrors = clearedErrors;
    render();
    try {
      const file = await opts.fileReadCaller({
        record_id: registered.artifact.record_id,
      });
      if (disposed || generationAtOpen !== resultFileGeneration) {
        previewWindow?.close();
        return;
      }
      const mismatch = exactResultFileReadError(registered.artifact, file);
      if (mismatch !== null) throw new Error(mismatch);
      triggerResultFileOpen(doc, resultObjectUrls, file, rawMode, previewWindow);
      resultFileVerified = new Set(resultFileVerified).add(registered.stableKey);
    } catch (err) {
      previewWindow?.close();
      if (!disposed && generationAtOpen === resultFileGeneration) {
        const nextVerified = new Set(resultFileVerified);
        nextVerified.delete(registered.stableKey);
        resultFileVerified = nextVerified;
        resultFileErrors = new Map(resultFileErrors).set(
          registered.stableKey,
          errMessage(err),
        );
      }
    } finally {
      if (!disposed && generationAtOpen === resultFileGeneration) {
        const nextBusy = new Set(resultFileBusy);
        nextBusy.delete(registered.stableKey);
        resultFileBusy = nextBusy;
        render();
      }
    }
  };

  const restorePreviousResultPanel = (): void => {
    if (
      selectedRecipeId === null
      || resultPanel?.route_recipe_id !== selectedRecipeId
      || resultPanel.previous === undefined
    ) {
      return;
    }
    resultPanel = resultPanel.previous;
    resetResultFilterStates(resultPanel.result);
    resultFileBusy = new Set();
    resultFileErrors = new Map();
    resultFileVerified = new Set();
    resultFileGeneration += 1;
    render();
  };

  const findActionTarget = (target: EventTarget | null): HTMLElement | null => {
    if (target === null || typeof target !== 'object') return null;
    const maybe = target as HTMLElement;
    if (typeof maybe.closest === 'function') {
      return maybe.closest(
        `[${RECIPES_ROUTE_ACTION_ATTR}], [${SHARED_ACTION_ATTR}]`,
      );
    }
    return null;
  };

  const onClick = (ev: Event): void => {
    // D-319 — the "Running as" section names its own actions.
    const runningAs = typeof (ev.target as HTMLElement | null)?.closest === 'function'
      ? (ev.target as HTMLElement).closest(`[${RUNNING_AS_ACTION_ATTR}]`) as HTMLElement | null
      : null;
    if (runningAs !== null) {
      const runningAsAction = runningAs.getAttribute(RUNNING_AS_ACTION_ATTR);
      if (runningAsAction !== null && RUNNING_AS_ACTIONS.has(runningAsAction)) {
        onRunningAsAction(runningAsAction as RunningAsAction, runningAs);
      }
      return;
    }
    const target = findActionTarget(ev.target);
    if (target === null) return;
    const action =
      target.getAttribute(RECIPES_ROUTE_ACTION_ATTR)
      ?? target.getAttribute(SHARED_ACTION_ATTR);
    if (action === null) return;
    // A click that lands on a real anchor INSIDE the clickable card (the
    // "from pack" link, the repo support link) should navigate, not open
    // the detail — let the anchor be and don't swallow its default.
    if (action === 'open-recipe' || action === 'preview-recipe') {
      const rawTarget = ev.target as HTMLElement | null;
      const anchor = rawTarget?.closest?.('a[href]') ?? null;
      if (anchor !== null && anchor !== target && target.contains(anchor)) {
        return;
      }
    }
    ev.preventDefault();
    if (action === 'copy') {
      void copyRecipeResultValue(target, doc);
      return;
    }
    if (action === 'refresh') {
      if (!loading) startRefresh();
      return;
    }
    if (action === 'retry-bundle-carrier') {
      void ensureCarrierRefs(true);
      return;
    }
    if (action === 'filter-set') {
      const kind = target.getAttribute('data-filter-kind');
      const raw = target.getAttribute('data-filter-value') ?? '__all__';
      const next = raw === '__all__' ? null : raw;
      // Single-select per dimension; clicking the active chip clears it.
      if (kind === 'pack') {
        recipeFilter = { ...recipeFilter, pack: recipeFilter.pack === next ? null : next };
      } else {
        recipeFilter = { ...recipeFilter, trigger: recipeFilter.trigger === next ? null : next };
      }
      recipePage = 1;
      rememberRecipeList();
      render();
      return;
    }
    if (action === 'recipe-page') {
      const nextPage = Number(target.getAttribute('data-page'));
      if (Number.isInteger(nextPage) && nextPage > 0) {
        recipePage = nextPage;
        rememberRecipeList();
        render();
        const section = routeRoot.querySelector?.(
          `[${RECIPES_ROUTE_SECTION_ATTR}="recipes"]`,
        ) as HTMLElement | null;
        section?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      }
      return;
    }
    if (action === 'open-recipe') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) openRecipe(recipeId);
      return;
    }
    if (action === 'preview-recipe') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) previewRecipe(recipeId, target);
      return;
    }
    if (action === 'open-recipe-list') {
      closeDetail();
      return;
    }
    if (action === 'open-run') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) openRunModal(recipeId, 'run');
      return;
    }
    if (action === 'run-defaults') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) void runRecipeDefaults(recipeId);
      return;
    }
    if (action === 'open-schedule') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) openRunModal(recipeId, 'schedule');
      return;
    }
    if (action === 'run-result-action') {
      openResultAction(target.getAttribute(RECIPES_ROUTE_RESULT_ACTION_ATTR));
      return;
    }
    if (action === 'run-selected-result-action') {
      openSelectedResultAction(target.getAttribute(RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR));
      return;
    }
    if (action === 'result-grid-add') {
      const key = target.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR);
      if (key !== null) addResultGridRow(key);
      return;
    }
    if (action === 'result-grid-remove') {
      const key = target.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR);
      const rowIndex = Number(target.getAttribute(RECIPES_ROUTE_RESULT_GRID_ROW_ATTR));
      if (key !== null && Number.isSafeInteger(rowIndex) && rowIndex >= 0) {
        removeResultGridRow(key, rowIndex);
      }
      return;
    }
    if (action === 'result-grid-submit') {
      const key = target.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR);
      if (key !== null) void submitResultGrid(key);
      return;
    }
    if (action === 'result-select-submit') {
      const key = target.getAttribute(RECIPES_ROUTE_RESULT_SELECT_ATTR);
      if (key !== null) void submitResultSelection(key);
      return;
    }
    if (action === 'result-select-toggle') {
      const key = target.getAttribute(RECIPES_ROUTE_RESULT_SELECT_ATTR);
      const row = target.getAttribute(RECIPES_ROUTE_RESULT_SELECT_ROW_ATTR);
      // ⛔ Derived from STATE, never from `input.checked` — `onClick` calls
      // `preventDefault()` on every dispatched action, which reverts the tick
      // the browser had already applied. See the pack app view's twin.
      if (key !== null && row !== null) {
        mutateResultSelection(key, (state) => (row === '*'
          ? setAllTableSelection(state, tableSelectAllState(state) !== 'all')
          : toggleTableSelection(state, row)));
      }
      return;
    }
    if (action === 'result-filter-search') {
      const key = target.getAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR);
      if (key !== null) void submitResultFilter(key, 'search');
      return;
    }
    if (action === 'result-filter-page:next' || action === 'result-filter-page:previous') {
      const key = target.getAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR);
      if (key !== null) {
        void submitResultFilter(
          key,
          action.endsWith(':next') ? 'next' : 'previous',
        );
      }
      return;
    }
    if (action === 'open-result-file') {
      void openResultFile(
        target.getAttribute(RECIPES_ROUTE_RESULT_FILE_ATTR),
        target.getAttribute(RECIPES_ROUTE_RESULT_FILE_MODE_ATTR),
      );
      return;
    }
    if (action === 'restore-result-panel') {
      restorePreviousResultPanel();
      return;
    }
    if (action === 'toggle-result-display-mode') {
      // Optimistic, then authoritative: the screen flips now and the server's
      // returned prefs win. A rejected write reverts rather than leaving the
      // control saying something the device is not doing.
      const setter = opts.displayPrefsSetCaller;
      if (setter === undefined) return;
      const next = !displayMode;
      displayMode = next;
      render();
      void setter({ patch: { 'ui.result_display_mode': next } })
        .then((res) => { displayMode = getPref(res.prefs, 'ui.result_display_mode') === true; render(); })
        .catch(() => { displayMode = !next; render(); });
      return;
    }
    if (action === RESULT_FULLSCREEN_ACTION) {
      // ⛔ Called straight from the click, not deferred. `requestFullscreen`
      // needs a live user activation, and awaiting anything first spends it —
      // the request then rejects and the panel silently never enlarges.
      const host = target.closest?.(`[${RECIPE_RESULT_HOST_ATTR}]`) ?? null;
      if (host !== null) void toggleResultFullscreen(host, domFullscreenApi(doc));
      return;
    }
    if (action === 'toggle-auto-run:on' || action === 'toggle-auto-run:off') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) {
        void toggleAutoRun(recipeId, action.endsWith(':on'));
      }
      return;
    }
    if (action === 'review-auto-run') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) reviewAutoRun(recipeId);
      return;
    }
    // close-run / confirm-run are owned by the shared RunModal's own event
    // delegation (its Close + Run buttons), not this route's innerHTML.
  };

  const onInput = (ev: Event): void => {
    const target0 = ev.target as
      | (HTMLElement & { value?: string })
      | null;
    // An editable grid cell. The shared adapter decodes the same delegated
    // address for every result host and updates only the footer chrome — no
    // repaint while someone is typing, so the caret stays put.
    const gridInput = readResultTableEditCellInput(target0);
    if (gridInput !== null) {
      const found = findGridDescriptor(gridInput.key);
      if (found !== null) {
        const state = resultGridStates.get(gridInput.key)
          ?? initialTableEditState(found.descriptor, found.data);
        const next = gridSetCell(
          found.descriptor,
          state,
          gridInput.rowIndex,
          gridInput.column,
          gridInput.value,
        );
        resultGridStates = new Map(resultGridStates).set(gridInput.key, next);
        syncResultTableEditChrome(gridInput.gridRoot, next);
      }
      // ⛔ No re-render. Repainting on every keystroke would replace the input
      // the owner is typing in and drop the caret — the state is already
      // updated, and the next render (submit, add) shows it.
      return;
    }
    const filterRoot = target0?.closest?.(
      `[${RECIPES_ROUTE_RESULT_FILTER_ATTR}]`,
    ) as HTMLElement | null | undefined;
    const filterKey = filterRoot?.getAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR) ?? null;
    const variableKey = target0?.dataset?.varKey;
    if (target0 !== null
        && filterKey !== null
        && variableKey !== undefined
        && variableKey.length > 0) {
      setResultFilterValue(filterKey, variableKey, readWidgetValue(target0), false);
      const state = resultFilterStates.get(filterKey);
      for (const control of Array.from(filterRoot?.querySelectorAll?.(
        `[${RECIPES_ROUTE_RESULT_FILTER_PAGE_ATTR}]`,
      ) ?? [])) {
        (control as HTMLButtonElement).disabled = state?.dirty === true;
      }
      const error = filterRoot?.querySelector?.(
        `[${RECIPES_ROUTE_RESULT_FILTER_ERROR_ATTR}]`,
      ) as HTMLElement | null | undefined;
      if (error) error.style.display = 'none';
      return;
    }
    // Installed-recipes search filters the in-memory list BEFORE markup is
    // emitted. `render` carries the focused search + selection across the
    // bounded repaint while mounting at most one page of cards.
    if (
      target0 !== null
      && typeof target0.hasAttribute === 'function'
      && target0.hasAttribute(RECIPES_ROUTE_SEARCH_ATTR)
    ) {
      recipeFilter = { ...recipeFilter, query: target0.value ?? '' };
      recipePage = 1;
      rememberRecipeList();
      render();
    }
    // Run-modal inputs are owned by the shared RunModal's own delegation.
  };

  const onKeyDown = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    if (target === null || typeof target.closest !== 'function') return;
    const card = target.closest(
      `[${RECIPES_ROUTE_RECIPE_CARD_ATTR}]`,
    ) as HTMLElement | null;
    // Buttons/links keep their native keyboard contract. This branch is only
    // the focusable card body: Space previews, Enter enters durable detail.
    if (card === null || card !== target) return;
    const recipeId = card.getAttribute(RECIPES_ROUTE_RECIPE_CARD_ATTR);
    if (recipeId === null) return;
    const key = (ev as KeyboardEvent).key;
    if (key === ' ') {
      (ev as KeyboardEvent).preventDefault();
      previewRecipe(recipeId, card);
    } else if (key === 'Enter') {
      (ev as KeyboardEvent).preventDefault();
      openRecipe(recipeId);
    }
  };

  // Escape and the window chrome both leave fullscreen without routing through
  // the click handler, so the toggle's label is only truthful if it re-reads
  // the document on every change.
  const onFullscreenChange = (): void => {
    const host = routeRoot.querySelector?.(`[${RECIPE_RESULT_HOST_ATTR}]`) ?? null;
    if (host !== null) syncResultFullscreenChrome(routeRoot, host, domFullscreenApi(doc));
  };
  // ⚠ `doc` and not the global: this route mounts headless in tests against a
  // fake document, and a bare `document` reference throws before a single
  // assertion runs. Optional-called for the same reason — a fake that does not
  // implement the listener must not take the route down with it.
  doc.addEventListener?.('fullscreenchange', onFullscreenChange);

  // Soft read, like the LLM-config and transparency reads elsewhere: a failure
  // leaves the substrate default (OFF) in place rather than taking the route
  // down. A screen that does not refresh is recoverable; a route that does not
  // mount is not.
  if (opts.displayPrefsGetCaller !== undefined) {
    void opts.displayPrefsGetCaller()
      .then((res) => {
        displayMode = getPref(res.prefs, 'ui.result_display_mode') === true;
        render();
      })
      .catch(() => { /* default stands */ });
  }

  routeRoot.addEventListener('click', onClick);
  routeRoot.addEventListener('input', onInput);
  routeRoot.addEventListener('keydown', onKeyDown);

  const unsubscribers: Array<() => void> = [];
  if (opts.subscribe !== undefined) {
    unsubscribers.push(
      // A pack install / uninstall changes the installed-recipe set.
      // D-display-mode P2 — a board left on a screen keeps itself current.
      //
      // 🔑 THE GUARD IS SELF-EXCLUSION, NOT A DEBOUNCE. A refresh run emits its
      // own `execution` events, so a handler that reacts to everything
      // re-triggers itself into a loop. The exact rule falls out of what a
      // display board IS: it is all-Records reads (see
      // internal design notes § 3, which is also why re-running is free),
      // and a run that cannot write cannot be the cause of its own staleness.
      // ⇒ Events for the displayed recipe are IGNORED; anything else completing
      // is a real change. A timer would only slow the loop down while making the
      // screen laggy — the wrong fix for a self-trigger.
      //
      // ⚠ `complete` only. `start` / `progress` fire repeatedly mid-run and the
      // data is not settled until the writer commits.
      opts.subscribe('execution', (event) => {
        const shown = resultPanel?.render_recipe_id;
        if (!shouldRefreshDisplayedBoard({
          displayMode,
          busy: displayRefreshBusy,
          shown,
          event: event as { op?: unknown; recipe_id?: unknown },
          lastRunAuditExempt: (resultPanel?.result as { audit_exempt?: boolean } | undefined)
            ?.audit_exempt,
        })) return;
        displayRefreshBusy = true;
        void runRecipeDefaults(shown!).finally(() => { displayRefreshBusy = false; });
      }),
      opts.subscribe('pack_installed', () => startRefresh()),
      opts.subscribe('pack_uninstalled', () => startRefresh()),
      opts.subscribe('chat.inbound_token_changed', () => startRefresh()),
      // Derived runnability moved (connection connect/disconnect, grant
      // change, pack install/uninstall). The event carries the FULL
      // recomputed per-recipe snapshot — patch in place + re-render.
      opts.subscribe('recipe_runnability_changed', (event) => {
        if (disposed) return;
        runnabilityEventSeq += 1;
        runnability = new Map(
          event.recipes.map((row) => [row.recipe_id, row]),
        );
        render();
      }),
      // Automation status moved (another client's toggle, the dispatcher's
      // auto-disable, a schedule CRUD). Targeted list re-fetch.
      opts.subscribe('schedule', () => {
        void refreshAutomation();
      }),
      opts.subscribe('automation_rule_changed', () => {
        void refreshAutomation();
      }),
    );
  }

  startRefresh();

  return {
    getRecipes: () => recipes,
    getTools: () => catalog,
    getLoadErrors: () => errors,
    selectedRecipe: () => selectedRecipeId,
    // A compat snapshot over the shared RunModal handle's state.
    sheetImport: () => childSheetImport,
    runModal: () =>
      childRunModal === null || runModalRecipeId === null
        ? null
        : {
            recipe_id: runModalRecipeId,
            dish_id: childRunModal.getState().dish_id,
            config_text: childRunModal.getState().config_text,
            target_values: childRunModal.getState().target_values,
            context_values: childRunModal.getState().context_values,
            executing: childRunModal.getState().executing,
            error: childRunModal.getState().run_error,
            result: childRunModal.getState().result,
          },
    resultPanel: () =>
      selectedRecipeId !== null && resultPanel?.route_recipe_id === selectedRecipeId
        ? resultPanel
        : null,
    resultFilterKeys: () => [...resultFilterStates.keys()],
    resultGridKeys: () => {
      const panel = resultPanel;
      return panel === null
        ? []
        : resultTableEdits(panel.result, panel.render_recipe_id).map((edit) => edit.key);
    },
    setResultGridCell: (key, rowIndex, column, value) => {
      const found = findGridDescriptor(key);
      if (found === null) return;
      const state = resultGridStates.get(key)
        ?? initialTableEditState(found.descriptor, found.data);
      resultGridStates = new Map(resultGridStates)
        .set(key, gridSetCell(found.descriptor, state, rowIndex, column, value));
      render();
    },
    addResultGridRow,
    removeResultGridRow,
    submitResultGrid: (key) => submitResultGrid(key),
    setResultFilterValue: (filterKey, variableKey, value) => {
      setResultFilterValue(filterKey, variableKey, value);
    },
    submitResultFilter,
    refresh: startRefresh,
    whenLoaded: () => pendingLoadPromise,
    openRecipe,
    closeDetail,
    openRunModal,
    setRunConfigText: (text: string) => childRunModal?.setConfigText(text),
    setRunTargetValue: (key: string, value: string) => {
      if (key.length === 0) return;
      childRunModal?.setTargetValue(key, value);
    },
    confirmRun: () => childRunModal?.confirmRun() ?? Promise.resolve(),
    closeRunModal,
    hasInFlightWork: hasRecipeInFlightWork,
    inFlightWorkPrompt: () =>
      hasRecipeInFlightWork()
        ? 'Something is still happening. Leave anyway?'
        : null,
    hasUnsavedChanges: hasUnsavedResultGridChanges,
    unsavedChangesPrompt: () =>
      hasUnsavedResultGridChanges()
        ? 'You have changes you have not saved. Leave anyway?'
        : null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const stopFollowing of heldRunStops.splice(0)) stopFollowing();
      // Tear down an open shared Run modal — it portals to body (outside
      // `routeRoot`), so removing the route root below won't reach it.
      closeRunModal();
      listPreview?.dispose();
      listPreview = null;
      dishFormHandle?.destroy();
      dishFormHandle = null;
      preapprovalActivation?.destroy();
      preapprovalActivation = null;
      for (const picker of resultGridRefPickers.splice(0)) picker.destroy();
      const urlApi = (doc.defaultView as unknown as {
        URL?: { revokeObjectURL(url: string): void };
      } | null | undefined)?.URL;
      for (const [url, timeout] of resultObjectUrls) {
        globalThis.clearTimeout(timeout);
        urlApi?.revokeObjectURL(url);
      }
      resultObjectUrls.clear();
      routeRoot.removeEventListener('click', onClick);
      routeRoot.removeEventListener('input', onInput);
      routeRoot.removeEventListener('keydown', onKeyDown);
      // ⛔ The one listener not on routeRoot. Discarding the root drops the
      // other three with it; this one hangs off the DOCUMENT, so a remount
      // without this line stacks a second handler that syncs a panel the page
      // no longer shows.
      doc.removeEventListener?.('fullscreenchange', onFullscreenChange);
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // Teardown must remain best-effort.
        }
      }
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};
