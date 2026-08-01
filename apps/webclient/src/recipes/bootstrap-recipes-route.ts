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
 *  `depends_on`). Per-recipe scheduling rides the shared Run | Schedule
 *  modal; bundled recipe siblings get a quick auto-run enable / disable
 *  control while full trigger / auto-run management lives at `#automation`.
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
  ServerExecuteResponse,
  ServerRecipeListEntry,
  ServerSchedule,
  ToolEntry,
} from '@recued/contracts';
import { NOTIFICATION_CHANNEL_NAMES } from '@recued/contracts';
import type { ResolvedTableEditDescriptor } from '@recued/contracts';
import { describeCron, isResolvedRecordColumnsDescriptor, resolveRecipeBundleInstallPack } from '@recued/contracts';
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
  renderVariableWidget,
  runnabilityDisclosureLines,
  setOutputFilterDraftValue,
  toWidgetShape,
  validateOutputFilterDraft,
  RunModal,
  wireConfigEditorOverlay,
  type ConfigEditorOverlayHandle,
  type RecipeCardState,
  type RecipeCardTriggerKind,
  type OutputFilterState,
} from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { bindRecordRefSearchToRecipe } from '../record-ref-search.js';
import { classifyRecipeAction } from '../chat/run-palette.js';
import { serializeShellRoute } from '../shell/route.js';
import {
  recipeRequiredConnections,
  type RequiredConnection,
} from './required-connections.js';
import {
  packSlugLabel,
  recipeIsStandalone,
  recipePackRefs,
  type RecipePackRef,
} from './recipe-pack-provenance.js';
import {
  recipeDeclaredOps,
  recipeRecordsUsage,
  type RecordsEffect,
  type RecordsEntityUsage,
  type RecordsUsagePack,
} from './recipe-records-usage.js';
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
  RECIPE_RESULT_PANEL_STYLES,
  createResultActionRegistry,
  exactResultFileReadError,
  openResultPreviewWindow,
  resultFilterRunConfig,
  triggerResultFileOpen,
  findResultTableEdit,
  renderRecipeResultPanel,
  resolvedFilterDescriptor,
  resultOutputSections,
  resultTableEdits,
  type RecipeOutputAction,
  type RegisteredResultFile,
  type ResultActionRegistry,
  type ResultFileArtifact,
} from './recipe-result-panel.js';
import {
  readResultTableEditCellInput,
  syncResultTableEditChrome,
  wireResultTableEditRefPickers,
} from './result-table-edit-host.js';
export {
  RECIPES_ROUTE_RESULT_PANEL_ATTR,
  RECIPES_ROUTE_RESULT_SECTION_ATTR,
  RECIPES_ROUTE_RESULT_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_FILE_ATTR,
  RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR,
  RECIPES_ROUTE_RESULT_RETURN_ATTR,
  RECIPES_ROUTE_RESULT_PROVENANCE_ATTR,
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

export const RECIPES_ROUTE_STYLES_MARKER =
  'data-recued-recipes-route-styles';
export const RECIPES_ROUTE_HOST_ATTR = 'data-recued-recipes-route';
export const RECIPES_ROUTE_HEADING_ATTR = 'data-recued-recipes-route-heading';
export const RECIPES_ROUTE_SECTION_ATTR = 'data-recued-recipes-section';
export const RECIPES_ROUTE_RECIPE_CARD_ATTR = 'data-recued-recipes-card';
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
export const RECIPES_ROUTE_RECIPE_TRIGGER_ATTR = 'data-recued-recipe-trigger';
export const RECIPES_ROUTE_RECIPE_PACKS_ATTR = 'data-recued-recipe-packs';
export const RECIPES_ROUTE_RECIPE_SEARCH_ATTR = 'data-recued-recipe-search';
const RECIPES_PAGE_SIZE = 24;
/** The per-card "Run" button (the trigger). The Run MODAL it opens is the
 *  shared `@recued/ui-shared` RunModal (its own `RUN_MODAL_*` hooks). */
export const RECIPES_ROUTE_RUN_BUTTON_ATTR = 'data-recued-recipes-run-button';
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
/** D-215 slice 3 — the detail's Dishes section (value = recipe_id) + one
 *  row (value = dish_id). Test + future click-delegation handles. */
export const RECIPES_ROUTE_DISHES_ATTR = 'data-recued-recipes-dishes';
export const RECIPES_ROUTE_DISH_ROW_ATTR = 'data-recued-recipes-dish-row';

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

// `RECIPES_ROUTE_ACTION_ATTR`, `…RESULT_ACTION_SELECT_ATTR` and
// `…RESULT_FILE_MODE_ATTR` moved to `recipe-result-panel.ts` (the panel emits
// them; this route matches on them) and are imported above.
const RECIPES_ROUTE_RECIPE_ID_ATTR = 'data-recipe-id';
const SHARED_ACTION_ATTR = 'data-action';

export type RecipesListCaller = () => Promise<{
  recipes: ReadonlyArray<ServerRecipeListEntry>;
}>;

export type RecipeExecuteCaller = (args: {
  recipe_id: string;
  config?: Record<string, unknown>;
  /** Targeting guard (design § 8) — caller-supplied runtime context.
   *  The run modal threads the filled target fields here (e.g.
   *  `{ entity_id: '123' }`); the host passes it through to the
   *  `execute` rpc verbatim. */
  context?: Record<string, unknown>;
  invocation?: RecipeInvocation;
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
  catalog: ReadonlyArray<ToolEntry>;
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
  config_overlay?: Record<string, unknown>;
}) => Promise<{ schedule: ServerSchedule }>;
export type RecipesSchedulesUpdateCaller = (args: {
  schedule_id: string;
  enabled?: boolean;
}) => Promise<{ schedule: ServerSchedule }>;
export type RecipesSchedulesDeleteCaller = (args: {
  schedule_id: string;
}) => Promise<{ deleted: true }>;
/** D-179 — read/write a recipe's INSTALL config (its default-dish overlay,
 *  applied as a base to every dishless run). */
export type RecipeConfigGetCaller = (args: {
  recipe_id: string;
}) => Promise<{ config_overlay: Record<string, unknown> }>;
export type RecipeConfigSetCaller = (args: {
  recipe_id: string;
  publisher_id?: string;
  config_overlay: Record<string, unknown>;
}) => Promise<{ config_overlay: Record<string, unknown> }>;

export interface BootstrapRecipesRouteOptions {
  root: HTMLElement;
  document?: Document;
  recipesListCaller?: RecipesListCaller;
  recipeExecuteCaller?: RecipeExecuteCaller;
  /** D-200 — paired-client authenticated preview/download for exact file
   * artifact result cards. Absent keeps metadata visible and controls disabled. */
  fileReadCaller?: RecipeFileReadCaller;
  toolCatalogCaller?: RecipesToolCatalogCaller;
  connectionsListCaller?: RecipesConnectionsListCaller;
  runnabilityCaller?: RecipesRunnabilityCaller;
  piiCaller?: RecipesPiiCaller;
  /** Absent ⇒ the Records + declared-risk disclosures stay in their
   *  "roster unavailable" wording. */
  packsListCaller?: RecipesPacksListCaller;
  /** D-215 slice 3 — absent ⇒ the detail's Dishes section stays hidden. */
  dishesListCaller?: RecipesDishesListCaller;
  schedulesListCaller?: RecipesSchedulesListCaller;
  schedulesCreateCaller?: RecipesSchedulesCreateCaller;
  schedulesUpdateCaller?: RecipesSchedulesUpdateCaller;
  schedulesDeleteCaller?: RecipesSchedulesDeleteCaller;
  triggersListCaller?: RecipesTriggersListCaller;
  autoRunListCaller?: RecipesAutoRunListCaller;
  autoRunUpdateCaller?: RecipesAutoRunUpdateCaller;
  recipeConfigGetCaller?: RecipeConfigGetCaller;
  recipeConfigSetCaller?: RecipeConfigSetCaller;
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
   *  `recipe_bundle`. Both are required; failures hide the CTA. */
  recipeCatalogCaller?: () => Promise<CatalogResult<CatalogRecipeRow>>;
  packCatalogCaller?: () => Promise<CatalogResult<CatalogPackRow>>;
  initialRecipeId?: string;
  subscribe?: BroadcastSubscriber['on'];
}

export interface RecipesLoadErrors {
  recipes?: string;
  tools?: string;
}

export interface RecipesRunModalSnapshot {
  recipe_id: string;
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
  getTools(): ReadonlyArray<ToolEntry>;
  getLoadErrors(): RecipesLoadErrors;
  /** The currently open detail recipe id, or null when on the list. */
  selectedRecipe(): string | null;
  runModal(): RecipesRunModalSnapshot | null;
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
  dispose(): void;
}

const RECIPES_ROUTE_STYLES = `
[${RECIPES_ROUTE_HOST_ATTR}] {
  /* Inherit the shell's light/dark base tokens; the amber --warn pair is
     kept deliberately for the recipes risk pills (a hue the monochrome
     shell --warn doesn't provide). */
  --warn: #b54708;
  --warn-subtle: #fff4e5;
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
  color: var(--accent);
  font-size: 13px;
  text-decoration: none;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-inline-link:hover {
  text-decoration: underline;
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
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-button:disabled {
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
  min-height: 34px;
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
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  /* Each card sizes to its own content — a verbose card no longer
     stretches every sibling in its row to match. */
  align-items: start;
}
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}] {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px;
  cursor: pointer;
}
[${RECIPES_ROUTE_RECIPE_CARD_ATTR}]:hover {
  border-color: var(--accent);
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
  gap: 3px;
  justify-items: start;
  margin-top: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-runnability-pill {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 650;
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
  font-size: 12px;
  color: var(--muted);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-pii-pill {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 650;
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
  gap: 3px;
  justify-items: start;
  margin-top: 6px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-pii-detail {
  font-size: 12px;
  color: var(--muted);
}
@media (max-width: 720px) {
  [${RECIPES_ROUTE_HOST_ATTR}] .recipes-header {
    display: grid;
  }
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card {
  display: flex;
  flex-direction: column;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-header {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  /* Top-align so the badge keeps its natural height next to a title that
     wraps to two lines. */
  align-items: flex-start;
  gap: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipe-card-name {
  font-weight: 600;
  color: var(--fg-strong);
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
  flex-direction: row;
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: var(--fg-muted);
  font-size: 0.75rem;
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
  gap: 16px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-header {
  display: grid;
  gap: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-name {
  font-size: 20px;
  font-weight: 700;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-meta {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-detail-section {
  display: grid;
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
}
[${RECIPES_ROUTE_HOST_ATTR}] .copyable-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .copyable-label {
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 650;
}
[${RECIPES_ROUTE_HOST_ATTR}] .copyable-content pre,
[${RECIPES_ROUTE_HOST_ATTR}] .ai-json {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.45 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
[${RECIPES_ROUTE_HOST_ATTR}] .summary-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}
[${RECIPES_ROUTE_HOST_ATTR}] .summary-row:last-child { border-bottom: none; }
[${RECIPES_ROUTE_HOST_ATTR}] .summary-row dt { color: var(--fg-muted); }
[${RECIPES_ROUTE_HOST_ATTR}] .summary-row dd { margin: 0; font-weight: 600; }
[${RECIPES_ROUTE_HOST_ATTR}] .record-field-unset,
[${RECIPES_ROUTE_HOST_ATTR}] .record-field-structured {
  color: var(--fg-subtle);
  font-weight: 400;
  font-style: italic;
}
[${RECIPES_ROUTE_HOST_ATTR}] .copy-btn {
  appearance: none;
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
[${RECIPES_ROUTE_HOST_ATTR}] .ai-block {
  display: grid;
  gap: 7px;
  font-size: 12px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .ai-block p {
  margin: 0;
  line-height: 1.45;
}
[${RECIPES_ROUTE_HOST_ATTR}] .ai-row {
  display: grid;
  grid-template-columns: minmax(90px, 140px) minmax(0, 1fr);
  gap: 8px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .ai-label {
  color: var(--fg-muted);
  font-weight: 650;
}
[${RECIPES_ROUTE_HOST_ATTR}] .ai-points {
  margin: 0;
  padding-left: 20px;
}
[${RECIPES_ROUTE_DEFINITION_ATTR}] summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}
[${RECIPES_ROUTE_DEFINITION_ATTR}] pre {
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
  catalog: ReadonlyArray<ToolEntry>,
): ToolEntry | null => {
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

const deriveNotificationChannels = (
  entry: ServerRecipeListEntry,
): readonly string[] => {
  const body = JSON.stringify(entry.recipe).toLowerCase();
  // D-192 seam 10 — the channel vocabulary comes from contracts, so a newly
  // declared chat transport is detected here with no edit.
  return NOTIFICATION_CHANNEL_NAMES.filter((channel) => body.includes(channel));
};

const deriveConsumedEnrichments = (
  entry: ServerRecipeListEntry,
): readonly string[] => {
  const body = JSON.stringify(entry.recipe);
  const matches = body.match(/data\.enrichment\.[a-zA-Z0-9_.-]+/g) ?? [];
  return [...new Set(matches)].slice(0, 4);
};

export const projectRecipeCardState = (
  entry: ServerRecipeListEntry,
  catalog: ReadonlyArray<ToolEntry>,
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
  const usage = recipeRecordsUsage(entry.recipe, packs);
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
    ? 'this recipe changes and DELETES data stored on this server.'
    : effects.has('write')
      ? 'this recipe reads and changes data stored on this server.'
      : 'this recipe only reads data stored on this server.';
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
  tool: ToolEntry | null,
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
    : recipeDeclaredOps(entry.recipe, packs);
  const risk = declared?.risk ?? tool?.risk_tier ?? tool?.classification ?? 'unknown';
  const approval =
    declared !== null && declared.asks_approval
      ? 'At least one operation is declared approval: ask.'
      : risk === 'write' || risk === 'admin' || risk === 'destructive'
        ? 'Approval policy applies before external side effects.'
        : risk === 'read'
          ? 'Read-class recipe; write approval is not declared.'
          : 'Risk is resolved at dispatch from the recipe and tools.';
  const riskSource = declared?.risk !== undefined && declared.risk !== null
    ? ' Declared by the pack.'
    : '';
  const unresolved = declared !== null && declared.unresolved.length > 0
    ? `<div ${RECIPES_ROUTE_RECORDS_ATTR}="unresolved"><strong>Unresolved operations:</strong> ${e(declared.unresolved.join(', '))} — the pack that declares them is not installed, so what they do can't be shown.</div>`
    : '';
  const needs = requires.length > 0 ? requires.join(', ') : 'No manifest permissions declared.';
  const connectionsLine = renderConnectionsNeed(
    recipeRequiredConnections(entry.recipe),
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
  blocked: 'Blocked — add a provider',
};

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
  const pillCopy = RUNNABILITY_PILL_COPY[entry.status] ?? entry.status;
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
      ? 'PII — manual attention'
      : tone === 'auto'
        ? 'PII auto-protected'
        : 'PII note';
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
  return `<a class="recipes-inline-link" href="#packs" ${RECIPES_ROUTE_FROM_PACK_ATTR}="${e(packAttr)}">${e(label)}</a>`;
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
        value="${e(filter.query)}" placeholder="Search recipes…" aria-label="Search installed recipes">
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
 *  runnability / PII pills + [Run]. The whole card opens the detail;
 *  description + grant provenance live there. */
const renderRecipeListCard = (
  entry: ServerRecipeListEntry,
  catalog: ReadonlyArray<ToolEntry>,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  pii: ReadonlyMap<string, RecipePiiPostureSummary> | null,
): string => {
  const name = recipeDisplayName(entry);
  const searchText = recipeListSearchText(entry);
  const packs = recipePackRefs(entry.recipe);
  return `
    <article ${RECIPES_ROUTE_RECIPE_CARD_ATTR}="${e(entry.recipe_id)}"
      ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe"
      ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"
      ${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="${e(deriveTriggerKind(entry))}"
      ${RECIPES_ROUTE_RECIPE_PACKS_ATTR}="${e(packs.map((ref) => ref.pack_ref).join(' '))}"
      ${RECIPES_ROUTE_RECIPE_SEARCH_ATTR}="${e(searchText)}"
      role="button" tabindex="0" aria-label="Open ${e(name)}">
      ${renderRecipeCard(projectRecipeCardState(entry, catalog))}
      <div class="recipes-card-meta">
        ${renderFromPack(packs)}
      </div>
      ${renderRunnabilityLine(runnability?.get(entry.recipe_id))}
      ${renderPiiLine(pii?.get(entry.recipe_id))}
      <div class="recipes-actions">
        <button type="button" class="recipes-button recipes-button--primary"
          ${RECIPES_ROUTE_RUN_BUTTON_ATTR}="${e(entry.recipe_id)}"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-run"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">
          Run
        </button>
      </div>
    </article>
  `;
};

const renderRecipeSection = (
  recipes: ReadonlyArray<ServerRecipeListEntry>,
  catalog: ReadonlyArray<ToolEntry>,
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
          <button type="button" class="recipes-button" ${RECIPES_ROUTE_ACTION_ATTR}="recipe-page" data-page="${safePage - 1}"${safePage === 1 ? ' disabled' : ''}>‹ Previous</button>
          <span>Page ${safePage} of ${totalPages}</span>
          <button type="button" class="recipes-button" ${RECIPES_ROUTE_ACTION_ATTR}="recipe-page" data-page="${safePage + 1}"${safePage === totalPages ? ' disabled' : ''}>Next ›</button>
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

const recipeAutoRun = (
  data: RecipesAutomationData,
  recipe_id: string,
): AutoRunStatusEntry | undefined =>
  (data.autoRun ?? []).find((a) => a.recipe_id === recipe_id);

/** D-215 slice 3 — this recipe's dishes, read-only.
 *
 *  A dish minted BY a schedule / trigger / auto-run is badged with its
 *  owner and carries no actions: D-179 versions a managed dish immutably
 *  (one `dish_id` = one config), so its edits belong to the owning row.
 *  Slice 4 adds create / rename / remove here.
 *
 *  Hidden entirely when the caller is absent or its read failed (`null`) —
 *  a soft enhancement must not turn into an empty-state claim. `[]` is a
 *  real answer and says so. */
const renderDishesSection = (
  data: RecipesAutomationData,
  recipe_id: string,
): string => {
  if (data.dishes === null) return '';
  const mine = data.dishes.filter((d) => d.recipe_id === recipe_id);
  const rows = mine.map((d) => {
    const origin = d.managed_by_schedule_id !== undefined
      ? { badge: 'schedule', label: `Schedule ${d.managed_by_schedule_id}` }
      : d.managed_by_trigger_id !== undefined
        ? { badge: 'trigger', label: `Trigger ${d.managed_by_trigger_id}` }
        : d.managed_by_auto_run !== undefined
          ? { badge: 'auto-run', label: 'Auto-run' }
          : { badge: 'assigned', label: 'Assigned' };
    const last = data.dishLastRuns[d.dish_id];
    return `<li ${RECIPES_ROUTE_DISH_ROW_ATTR}="${e(d.dish_id)}" data-enabled="${d.enabled ? 'true' : 'false'}">
      <span class="recipes-dish-name">${e(d.name !== '' ? d.name : 'Default')}</span>
      <span class="recipes-dish-origin" data-dish-origin="${e(origin.badge)}">${e(origin.label)}</span>
      <span class="recipes-dish-last">${e(
        last === undefined ? 'never run' : `last run ${last.commit_status}`,
      )}</span>
      ${d.enabled ? '' : '<span class="recipes-dish-paused">Paused</span>'}
    </li>`;
  }).join('');
  return `
    <section class="recipes-detail-section" ${RECIPES_ROUTE_DISHES_ATTR}="${e(recipe_id)}">
      <h2 class="recipes-detail-section-title">Dishes</h2>
      ${mine.length === 0
        ? '<p class="recipes-detail-note">No dishes yet — scheduling this recipe mints one.</p>'
        : `<ul class="recipes-dish-list">${rows}</ul>`}
    </section>`;
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
    const state = !auto.enabled
      ? ' (paused)'
      : auto.auto_disabled
        ? ' (tripped)'
        : '';
    parts.push(`auto-run${state}`);
  }
  return parts.map((p) => e(p)).join(' · ');
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
  canConfig: boolean,
  canAutoRunUpdate: boolean,
  autoRunBusy: ReadonlySet<string>,
): string => {
  const name = recipeDisplayName(entry);
  const automationText = recipeAutomationSummaryText(automation, entry.recipe_id);
  const autoRun = recipeAutoRun(automation, entry.recipe_id);
  const hasVariables = Object.keys(entry.recipe.variables ?? {}).length > 0;
  const targetRunnability = runnability?.get(entry.recipe_id);
  const actionKind = classifyRecipeAction(entry.recipe);
  const canRun =
    canExecute
    && actionKind === 'manual'
    && targetRunnability?.status !== 'blocked';
  const hasSchedules = recipeSchedules(automation, entry.recipe_id).length > 0;
  const canSchedule = hasSchedules || (canCreateSchedules && actionKind === 'manual');
  const hasAutomationSurface =
    canSchedule
    || automationText !== ''
    || entry.recipe.auto_run !== undefined
    || (entry.recipe.event_triggers?.length ?? 0) > 0
    || (entry.recipe.trigger_steps?.length ?? 0) > 0;
  const autoRunToggle = autoRun !== undefined && canAutoRunUpdate
    ? (() => {
        const nextEnabled = !autoRun.enabled || autoRun.auto_disabled;
        const label = !autoRun.enabled
          ? 'Resume auto-run'
          : autoRun.auto_disabled
            ? 'Re-arm auto-run'
            : 'Pause auto-run';
        return `<button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="toggle-auto-run:${nextEnabled ? 'on' : 'off'}"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"${autoRunBusy.has(entry.recipe_id) ? ' disabled' : ''}>${e(label)}</button>`;
      })()
    : '';
  return `
    <li ${RECIPES_ROUTE_RELATED_ROW_ATTR}="${e(entry.recipe_id)}">
      <div>
        <span class="recipes-related-title">${e(name)}</span>
        <span class="recipes-related-meta">${e(deriveTriggerKind(entry))} · ${e(packageSource(entry))}${automationText !== '' ? ` · ${automationText}` : ''}</span>
      </div>
      <div class="recipes-related-actions">
        <a class="recipes-button"
          href="${serializeShellRoute('recipes', entry.recipe_id)}"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Open</a>
        ${canRun ? `<button type="button" class="recipes-button recipes-button--primary"
          ${RECIPES_ROUTE_RUN_BUTTON_ATTR}="${e(entry.recipe_id)}"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-run"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Run</button>` : ''}
        ${canConfig && hasVariables
          ? `<button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe-config"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Config</button>`
          : ''}
        ${canSchedule ? `<button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-schedule"
          ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Schedule</button>` : ''}
        ${hasAutomationSurface ? `<a class="recipes-button"
          href="${serializeShellRoute('automation', entry.recipe_id)}"
          ${RECIPES_ROUTE_AUTOMATION_LINK_ATTR}>Automation</a>` : ''}
        ${autoRunToggle}
        <a class="recipes-button"
          href="${serializeShellRoute('logs', 'recipe', entry.recipe_id)}"
          ${RECIPES_ROUTE_RUNS_LINK_ATTR}>Logs</a>
      </div>
    </li>
  `;
};

const renderRelatedRecipesSection = (
  selected: ServerRecipeListEntry,
  installed: ReadonlyArray<ServerRecipeListEntry>,
  recipeCatalog: ReadonlyArray<CatalogRecipeRow>,
  packCatalog: ReadonlyArray<CatalogPackRow>,
  automation: RecipesAutomationData,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  canExecute: boolean,
  canCreateSchedules: boolean,
  canConfig: boolean,
  canAutoRunUpdate: boolean,
  autoRunBusy: ReadonlySet<string>,
): string => {
  const related = relatedRecipesFor(selected, installed);
  const bundlePack = relatedBundlePackFor(
    selected,
    installed,
    recipeCatalog,
    packCatalog,
  );
  if (related.length === 0 && bundlePack === null) return '';
  return `
    <section class="recipes-detail-section" ${RECIPES_ROUTE_RELATED_ATTR}="${e(recipeBundleKey(selected) ?? '')}">
      <div class="recipes-related-heading">
        <h2 class="recipes-detail-section-title">Related recipes</h2>
        ${bundlePack === null ? '' : `<a class="recipes-button${bundlePack.fullyInstalled ? '' : ' recipes-button--primary'}"
          href="${serializeShellRoute('packs', bundlePack.slug)}"
          ${RECIPES_ROUTE_BUNDLE_PACK_ATTR}="${e(bundlePack.slug)}">${bundlePack.fullyInstalled
            ? 'View workflow pack'
            : `Install complete workflow (${bundlePack.recipeCount})`}</a>`}
      </div>
      ${bundlePack === null ? '' : `<p class="recipes-detail-note">${e(bundlePack.name)} is the bundled install pack for this recipe. Pack detail shows the full contents and grants before install.</p>`}
      ${related.length === 0 ? '' : `<ul class="recipes-related-list" role="list">
        ${related.map((entry) => renderRelatedRecipeRow(
          entry,
          automation,
          runnability,
          canExecute,
          canCreateSchedules,
          canConfig,
          canAutoRunUpdate,
          autoRunBusy,
        )).join('')}
      </ul>`}
    </section>
  `;
};

/** The detail view (R24 delta 1) — header + pills +
 *  description + read-only definition + depends-on provenance + Runs /
 *  Automation links. Rendered from the in-memory recipe entry (no extra
 *  fetch — `recipe.list` already carries the full definition). */
const renderRecipeDetail = (
  entry: ServerRecipeListEntry,
  catalog: ReadonlyArray<ToolEntry>,
  installed: ReadonlyArray<ServerRecipeListEntry>,
  recipeCatalog: ReadonlyArray<CatalogRecipeRow>,
  packCatalog: ReadonlyArray<CatalogPackRow>,
  connections: ReadonlyArray<ConnectionView> | null,
  packs: ReadonlyArray<RecordsUsagePack> | null,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  pii: ReadonlyMap<string, RecipePiiPostureSummary> | null,
  automation: RecipesAutomationData,
  canExecute: boolean,
  canCreateSchedules: boolean,
  canConfig: boolean,
  canAutoRunUpdate: boolean,
  autoRunBusy: ReadonlySet<string>,
  resultPanel: RecipesResultPanelSnapshot | null,
  resultActionRegistry: ResultActionRegistry,
  resultFilterStates: ReadonlyMap<string, RecipesResultFilterState>,
  defaultRunBusy: boolean,
  defaultRunError: string | null,
  resultGridStates: ReadonlyMap<string, OutputTableEditState> = new Map(),
  recordRefPickers = false,
): string => {
  const name = recipeDisplayName(entry);
  const triggerKind = deriveTriggerKind(entry);
  const tool = findToolForRecipe(entry, catalog);
  const fromPack = renderFromPack(recipePackRefs(entry.recipe));
  const description = entry.recipe.metadata?.description ?? '';
  const repo = entry.recipe.metadata?.repo;
  const automationText = recipeAutomationSummaryText(automation, entry.recipe_id);
  const variableDefs = Object.values(entry.recipe.variables ?? {});
  const defaultPrimitiveOnly = variableDefs.length > 0
    && variableDefs.every((definition) => !isInvocationVariable(definition));
  const canRunDefaultsDirectly = defaultPrimitiveOnly
    && canExecute
    && runnability?.get(entry.recipe_id)?.status !== 'blocked';
  return `
    <div ${RECIPES_ROUTE_DETAIL_ATTR}="${e(entry.recipe_id)}">
      <a class="recipes-inline-link" href="#recipes" ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe-list" ${RECIPES_ROUTE_BACK_ATTR}>← Recipes</a>
      <header class="recipes-detail-header">
        <h1 class="recipes-detail-title">
          <span class="recipes-detail-name">${e(name)}</span>
          <span class="recipe-card-badge recipe-card-badge--${e(triggerKind)}">${e(triggerKind)}</span>
        </h1>
        <p class="recipes-detail-meta">v${entry.version} · ${e(entry.publisher_id)}${fromPack !== '' ? ` · ${fromPack}` : ''} · ${e(packageSource(entry))}</p>
        <div class="recipes-actions">
          <button type="button" class="recipes-button recipes-button--primary"
            ${RECIPES_ROUTE_RUN_BUTTON_ATTR}="${e(entry.recipe_id)}"
            ${RECIPES_ROUTE_ACTION_ATTR}="${canRunDefaultsDirectly ? 'run-defaults' : 'open-run'}"
            ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"${defaultRunBusy ? ' disabled' : ''}>${defaultRunBusy ? 'Running…' : 'Run'}</button>
          ${defaultPrimitiveOnly ? `<button type="button" class="recipes-button"
            ${RECIPES_ROUTE_ACTION_ATTR}="open-run"
            ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Run with overrides</button>` : ''}
          <button type="button" class="recipes-button"
            ${RECIPES_ROUTE_ACTION_ATTR}="open-schedule"
            ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Schedule</button>
          ${canConfig && Object.keys(entry.recipe.variables ?? {}).length > 0
            ? `<button type="button" class="recipes-button"
            ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe-config"
            ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Config</button>`
            : ''}
          <a class="recipes-button"
            href="${serializeShellRoute('kitchen', 'recipe', entry.recipe_id)}"
            ${RECIPES_ROUTE_EDIT_LINK_ATTR}>Edit in Kitchen</a>
        </div>
        ${defaultRunError !== null
          ? `<p role="alert" class="recipes-result-file-error">${e(defaultRunError)}</p>`
          : ''}
      </header>
      ${renderDishesSection(automation, entry.recipe_id)}
      <section class="recipes-detail-section">
        <h2 class="recipes-detail-section-title">Exposed as a tool</h2>
        <p class="recipes-detail-note">Whether the AI can call this recipe is granted per contract — it can be exposed through one contract and not another. <a class="recipes-inline-link" href="#contracts" ${RECIPES_ROUTE_CONTRACTS_LINK_ATTR}>Manage in Contracts →</a></p>
      </section>
      ${renderRunnabilityLine(runnability?.get(entry.recipe_id))}
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
        ${automationText !== '' ? `<p class="recipes-detail-note"><strong>Automation:</strong> ${automationText}</p>` : '<p class="recipes-detail-note">No schedules or triggers yet — add one from Run · Schedule or in Automation.</p>'}
      </section>
      ${renderRecipeResultPanel(
        resultPanel,
        installed,
        resultActionRegistry,
        resultFilterStates,
        resultGridStates,
        recordRefPickers,
      )}
      ${renderRelatedRecipesSection(
        entry,
        installed,
        recipeCatalog,
        packCatalog,
        automation,
        runnability,
        canExecute,
        canCreateSchedules,
        canConfig,
        canAutoRunUpdate,
        autoRunBusy,
      )}
      <section class="recipes-detail-section">
        <details ${RECIPES_ROUTE_DEFINITION_ATTR}>
          <summary>Definition (read-only)</summary>
          <pre>${e(JSON.stringify(entry.recipe, null, 2))}</pre>
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
    style.textContent = `${RECIPES_ROUTE_STYLES}\n${RECIPE_RESULT_PANEL_STYLES}`;
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(RECIPES_ROUTE_HOST_ATTR, '');
  opts.root.appendChild(routeRoot);

  let disposed = false;
  let loading = true;
  let recipes: ServerRecipeListEntry[] = [];
  let catalog: ToolEntry[] = [];
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
   *  carrier only, cached, and folded into the pack snapshot on arrival. The
   *  render stays synchronous; the data shows up and re-renders. */
  const carrierRefsFetched = new Set<string>();
  let pendingBundleCatalogPromise: Promise<void> | null = null;
  // R24 delta 1 — the durable detail selection. `null` = the list view.
  let selectedRecipeId: string | null = opts.initialRecipeId ?? null;
  // Installed-recipes filter (client-side, persists across re-renders).
  let recipeFilter: RecipeListFilter = {
    query: '',
    trigger: null,
    pack: null,
  };
  let recipePage = 1;
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
  let runModalRecipeId: string | null = null;
  // D-179 — the recipe install-config editor (the shared config overlay).
  let recipeConfigHandle: ConfigEditorOverlayHandle | null = null;
  // Read-only automation status (the per-recipe summary line on the detail).
  let automationData: RecipesAutomationData = {
    dishes: null,
    dishLastRuns: {},
    schedules: null,
    triggers: null,
    autoRun: null,
  };
  let autoRunBusy = new Set<string>();
  let resultPanel: RecipesResultPanelSnapshot | null = null;
  let resultGridStates = new Map<string, OutputTableEditState>();
  let resultGridRefPickers: RefPicker.RefPickerHandle[] = [];
  let resultFilterStates = new Map<string, RecipesResultFilterState>();
  let defaultRunBusy = false;
  let defaultRunError: string | null = null;
  let resultActions = new Map<string, RecipeOutputAction>();
  let resultFiles = new Map<string, RegisteredResultFile>();
  let resultFileBusy = new Set<string>();
  let resultFileErrors = new Map<string, string>();
  let resultFileVerified = new Set<string>();
  let resultFileGeneration = 0;
  const resultObjectUrls = new Map<
    string,
    ReturnType<typeof globalThis.setTimeout>
  >();
  let pendingLoadPromise: Promise<void> = Promise.resolve();

  const syncRecipeHash = (): void => {
    const history = doc.defaultView?.history;
    if (history?.replaceState === undefined) return;
    try {
      history.replaceState(
        null,
        '',
        serializeShellRoute('recipes', selectedRecipeId ?? undefined),
      );
    } catch {
      // Non-fatal — addressability degrades to in-page-only.
    }
  };

  const render = (): void => {
    if (disposed) return;
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
        connections,
        packs,
        runnability,
        pii,
        automationData,
        opts.recipeExecuteCaller !== undefined,
        opts.schedulesListCaller !== undefined
          && opts.schedulesCreateCaller !== undefined,
        opts.recipeConfigGetCaller !== undefined && opts.recipeConfigSetCaller !== undefined,
        opts.autoRunUpdateCaller !== undefined,
        autoRunBusy,
        shownPanel,
        resultActionRegistry,
        resultFilterStates,
        defaultRunBusy,
        defaultRunError,
        resultGridStates,
        resultRecordSearch !== undefined,
      );
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
    recipePage = Math.max(1, Math.min(recipePage, totalRecipePages));
    routeRoot.innerHTML = `
      <header class="recipes-header">
        <h1 class="recipes-title" ${RECIPES_ROUTE_HEADING_ATTR}>Recipes</h1>
      </header>
      <div class="recipes-actions">
        <button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="refresh">
          Refresh
        </button>
        <a class="recipes-inline-link" href="${serializeShellRoute('kitchen', 'pack')}" ${RECIPES_ROUTE_KITCHEN_LINK_ATTR}>Author in Kitchen</a>
        <a class="recipes-inline-link" href="#packs">Manage packs</a>
      </div>
      ${loading ? '<p class="recipes-section-copy">Loading recipes...</p>' : ''}
      ${renderSourceErrors(errors)}
      <section ${RECIPES_ROUTE_SECTION_ATTR}="recipes">
        <h2 class="recipes-section-title">Installed recipes</h2>
        <p class="recipes-section-copy">Run a local recipe, or open one to inspect what it does and the grant boundary it depends on.</p>
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
          error: null,
        },
      };
    }
    return null;
  };

  /** Top up the SELECTED recipe's carrier pack with its real membership.
   *  Idempotent and best-effort: a failure leaves the row's empty refs in place,
   *  which makes bundle resolution refuse — the same fail-closed answer a
   *  malformed manifest has always produced. */
  const ensureCarrierRefs = async (): Promise<void> => {
    if (selectedRecipeId === null || !bundleCatalogLoaded) return;
    const row = bundleRecipeCatalog.find((r) => r.recipe_id === selectedRecipeId);
    const key = row?.recipe_bundle;
    if (key === undefined) return;
    const slug = key.slice(key.indexOf('/') + 1);
    const carrier = bundlePackCatalog.find((p) => p.slug === slug);
    if (carrier === undefined || carrier.recipe_refs.length > 0) return;
    if (carrierRefsFetched.has(slug)) return;
    carrierRefsFetched.add(slug);
    const myGeneration = bundleCatalogGeneration;
    const refs = await fetchPackRecipeRefs(slug);
    if (disposed || myGeneration !== bundleCatalogGeneration || refs.length === 0) return;
    bundlePackCatalog = bundlePackCatalog.map((p) =>
      (p.slug === slug ? { ...p, recipe_refs: refs } : p));
    render();
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
        bundlePackCatalog = [...bundlePacksResult.value.rows];
        bundleCatalogLoaded = true;
      } else {
        bundleRecipeCatalog = [];
        bundlePackCatalog = [];
        bundleCatalogLoaded = false;
      }
      render();
      void ensureCarrierRefs();
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
          : Promise.reject(new Error('Installed recipes are not available on this server yet.')),
        opts.toolCatalogCaller !== undefined
          ? opts.toolCatalogCaller()
          : Promise.reject(new Error('The tool list is not available on this server yet.')),
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

  const openRecipe = (recipe_id: string): void => {
    if (!recipes.some((r) => r.recipe_id === recipe_id)) return;
    if (selectedRecipeId !== recipe_id) {
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
      defaultRunBusy = false;
      defaultRunError = null;
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
    selectedRecipeId = null;
    resultPanel = null;
    resetResultFilterStates(null);
    resultGridStates = new Map();
    defaultRunBusy = false;
    defaultRunError = null;
    resultFileBusy = new Set();
    resultFileErrors = new Map();
    resultFileVerified = new Set();
    resultFileGeneration += 1;
    syncRecipeHash();
    render();
  };

  /** D-222 §2.3 — the five defaulted-primitive-only recipes have no first-
   *  class question to ask. Their primary Run executes with server-resolved
   *  defaults, while the adjacent explicit override control still opens the
   *  raw config editor. */
  const runRecipeDefaults = async (recipeId: string): Promise<void> => {
    if (defaultRunBusy || selectedRecipeId !== recipeId) return;
    const execute = opts.recipeExecuteCaller;
    if (execute === undefined) {
      defaultRunError = 'Running is not available on this server yet.';
      render();
      return;
    }
    const panelAtDispatch = resultPanel;
    defaultRunBusy = true;
    defaultRunError = null;
    render();
    try {
      const result = await execute({ recipe_id: recipeId, config: {} });
      if (selectedRecipeId !== recipeId) return;
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
      resultFileBusy = new Set();
      resultFileErrors = new Map();
      resultFileVerified = new Set();
      resultFileGeneration += 1;
    } catch (error) {
      if (selectedRecipeId === recipeId) defaultRunError = errMessage(error);
    } finally {
      if (selectedRecipeId === recipeId) {
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
  ): void => {
    const entry = recipes.find((row) => row.recipe_id === recipe_id);
    if (entry === undefined) return;
    // One modal at a time — a re-open while a run modal is up is a no-op.
    if (childRunModal !== null) return;
    const routeRecipeIdAtOpen = selectedRecipeId;
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
    runModalRecipeId = recipe_id;
    childRunModal = RunModal.wireRunModal({
      recipe: entry,
      document: doc,
      initialTab: tab,
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
      onClose: () => {
        childRunModal = null;
        runModalRecipeId = null;
      },
      onRan: (result) => {
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
          resultFileBusy = new Set();
          resultFileErrors = new Map();
          resultFileVerified = new Set();
          resultFileGeneration += 1;
          render();
        }
      },
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

  const openRecipeConfigEditor = async (recipe_id: string): Promise<void> => {
    const getCaller = opts.recipeConfigGetCaller;
    const setCaller = opts.recipeConfigSetCaller;
    if (getCaller === undefined || setCaller === undefined || doc === undefined) return;
    if (recipeConfigHandle !== null) return; // one at a time
    const entry = recipes.find((row) => row.recipe_id === recipe_id);
    if (entry === undefined) return;
    let current: Record<string, unknown>;
    try {
      current = (await getCaller({ recipe_id })).config_overlay;
    } catch {
      // A read failure must NOT open an empty editor — saving that empty
      // overlay would CLEAR the recipe's real install config. Abort; a
      // retry (re-click Config) re-reads.
      return;
    }
    if (recipeConfigHandle !== null) return; // re-entrancy guard across the await
    const configRecordRefSearch = recordRefSearchFor(entry.recipe);
    recipeConfigHandle = wireConfigEditorOverlay({
      document: doc,
      title: entry.recipe.metadata?.name ?? recipe_id,
      copy: 'These values apply to every run of this recipe. A single run can still override them.',
      confirmLabel: 'Save',
      variables: entry.recipe.variables ?? {},
      currentOverlay: current,
      ...(opts.fileRefSearchCaller !== undefined
        ? { fileRefSearch: opts.fileRefSearchCaller }
        : {}),
      // A `record_ref` searches ONE pack's entity, and the pack is the
      // recipe's own bundle — `<publisher>/<pack>`. A recipe with no bundle
      // (a standalone) has no Records namespace to search, so it keeps the
      // text box rather than showing a picker over nothing.
      ...(configRecordRefSearch !== undefined
        ? { recordRefSearch: configRecordRefSearch }
        : {}),
      onConfirm: (config) => {
        void setCaller({
          recipe_id,
          publisher_id: entry.publisher_id,
          config_overlay: config,
        }).catch(() => { /* best-effort; a failure leaves the prior config */ });
      },
      onClose: () => { recipeConfigHandle = null; },
    });
  };

  const toggleAutoRun = async (recipe_id: string, enabled: boolean): Promise<void> => {
    const update = opts.autoRunUpdateCaller;
    if (update === undefined || autoRunBusy.has(recipe_id)) return;
    autoRunBusy = new Set(autoRunBusy).add(recipe_id);
    render();
    try {
      const { entry } = await update({ recipe_id, enabled });
      const current = automationData.autoRun ?? [];
      automationData = {
        ...automationData,
        autoRun: [
          ...current.filter((row) => row.recipe_id !== recipe_id),
          entry,
        ],
      };
    } catch {
      // The dedicated Automation route owns detailed mutation errors. Here the
      // control is a convenience; failure leaves the prior status intact.
    } finally {
      const next = new Set(autoRunBusy);
      next.delete(recipe_id);
      autoRunBusy = next;
      render();
    }
  };

  const closeRunModal = (): void => {
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
        error: 'Running is not available on this server yet.',
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
        error: errMessage(error),
      });
      render();
    }
  };

  // `exactResultFileReadError` / `triggerResultFileOpen` /
  // `openResultPreviewWindow` moved to `recipe-result-panel.ts` so the packs
  // Use tab opens a file on exactly these terms. `doc` + the object-url map
  // are passed in rather than captured.
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
        'The browser blocked the PDF preview window. Allow popups for this site or download the file instead.',
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

  const copyResultValue = async (target: HTMLElement): Promise<void> => {
    const value = target.getAttribute('data-value');
    if (value === null) return;
    target.setAttribute('aria-live', 'polite');
    const clipboard = doc.defaultView?.navigator?.clipboard;
    if (clipboard?.writeText === undefined) {
      target.textContent = 'Copy unavailable';
      return;
    }
    try {
      await clipboard.writeText(value);
      target.textContent = 'Copied';
    } catch {
      target.textContent = 'Copy failed';
    }
  };

  const onClick = (ev: Event): void => {
    const target = findActionTarget(ev.target);
    if (target === null) return;
    const action =
      target.getAttribute(RECIPES_ROUTE_ACTION_ATTR)
      ?? target.getAttribute(SHARED_ACTION_ATTR);
    if (action === null) return;
    // A click that lands on a real anchor INSIDE the clickable card (the
    // "from pack" link, the repo support link) should navigate, not open
    // the detail — let the anchor be and don't swallow its default.
    if (action === 'open-recipe') {
      const rawTarget = ev.target as HTMLElement | null;
      const anchor = rawTarget?.closest?.('a[href]') ?? null;
      if (anchor !== null && anchor !== target && target.contains(anchor)) {
        return;
      }
    }
    ev.preventDefault();
    if (action === 'copy') {
      void copyResultValue(target);
      return;
    }
    if (action === 'refresh') {
      startRefresh();
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
      render();
      return;
    }
    if (action === 'recipe-page') {
      const nextPage = Number(target.getAttribute('data-page'));
      if (Number.isInteger(nextPage) && nextPage > 0) {
        recipePage = nextPage;
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
    if (action === 'open-recipe-config') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) void openRecipeConfigEditor(recipeId);
      return;
    }
    if (action === 'toggle-auto-run:on' || action === 'toggle-auto-run:off') {
      const recipeId = target.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
      if (recipeId !== null) {
        void toggleAutoRun(recipeId, action.endsWith(':on'));
      }
      return;
    }
    // close-run / confirm-run are owned by the shared RunModal's own event
    // delegation (its Close + Run buttons), not this route's innerHTML.
  };

  const onKeydown = (ev: Event): void => {
    const ke = ev as KeyboardEvent;
    if (ke.key !== 'Enter' && ke.key !== ' ') return;
    const node = ev.target as HTMLElement | null;
    // Only the card itself (role=button) — never a focused child control.
    if (
      node === null
      || typeof node.getAttribute !== 'function'
      || node.getAttribute(RECIPES_ROUTE_ACTION_ATTR) !== 'open-recipe'
    ) {
      return;
    }
    ev.preventDefault();
    const recipeId = node.getAttribute(RECIPES_ROUTE_RECIPE_ID_ATTR);
    if (recipeId !== null) openRecipe(recipeId);
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
    // emitted. Re-focus the replacement input so the bounded repaint keeps
    // the typing flow continuous while mounting at most one page of cards.
    if (
      target0 !== null
      && typeof target0.hasAttribute === 'function'
      && target0.hasAttribute(RECIPES_ROUTE_SEARCH_ATTR)
    ) {
      const caret = (target0 as HTMLInputElement).selectionStart;
      recipeFilter = { ...recipeFilter, query: target0.value ?? '' };
      recipePage = 1;
      render();
      const nextSearch = routeRoot.querySelector?.(
        `[${RECIPES_ROUTE_SEARCH_ATTR}]`,
      ) as HTMLInputElement | null;
      nextSearch?.focus?.();
      if (caret !== null && caret !== undefined) {
        nextSearch?.setSelectionRange?.(caret, caret);
      }
    }
    // Run-modal inputs are owned by the shared RunModal's own delegation.
  };

  routeRoot.addEventListener('click', onClick);
  routeRoot.addEventListener('input', onInput);
  routeRoot.addEventListener('keydown', onKeydown);

  const unsubscribers: Array<() => void> = [];
  if (opts.subscribe !== undefined) {
    unsubscribers.push(
      // A pack install / uninstall changes the installed-recipe set.
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
    runModal: () =>
      childRunModal === null || runModalRecipeId === null
        ? null
        : {
            recipe_id: runModalRecipeId,
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
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Tear down an open shared Run modal — it portals to body (outside
      // `routeRoot`), so removing the route root below won't reach it.
      closeRunModal();
      recipeConfigHandle?.destroy();
      recipeConfigHandle = null;
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
      routeRoot.removeEventListener('keydown', onKeydown);
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
