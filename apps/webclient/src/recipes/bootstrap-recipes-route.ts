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
  RecipePiiDisclosureEntry,
  RecipePiiPostureSummary,
  RecipeRunnabilityEntry,
  RunnabilityStatus,
  ServerExecuteResponse,
  ServerRecipeListEntry,
  ServerSchedule,
  ToolEntry,
} from '@recued/contracts';
import { NOTIFICATION_CHANNEL_NAMES } from '@recued/contracts';
import { describeCron, resolveRecipeBundleInstallPack } from '@recued/contracts';
import {
  formatValue,
  renderAiAnalysisBlock,
  renderCopyableBlock,
  renderJsonBlock,
  renderLinkButtonBlock,
} from '@recued/renderer';
import {
  e,
  RefPicker,
  renderRecipeCard,
  runnabilityDisclosureLines,
  RunModal,
  wireConfigEditorOverlay,
  type ConfigEditorOverlayHandle,
  type RecipeCardState,
  type RecipeCardTriggerKind,
} from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { classifyRecipeAction } from '../chat/run-palette.js';
import { serializeShellRoute } from '../shell/route.js';
import {
  recipeRequiredConnections,
  type RequiredConnection,
} from './required-connections.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { fetchPackRecipeRefs } from '../discover/catalog-client.js';
import type {
  CatalogPackRow,
  CatalogRecipeRow,
  CatalogResult,
} from '../discover/catalog-client.js';

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
/** D-195 P3 — current-session recipe run result panel on the detail page. */
export const RECIPES_ROUTE_RESULT_PANEL_ATTR =
  'data-recued-recipes-result-panel';
export const RECIPES_ROUTE_RESULT_SECTION_ATTR =
  'data-recued-recipes-result-section';
export const RECIPES_ROUTE_RESULT_ACTION_ATTR =
  'data-recued-recipes-result-action';
/** D-200 — exact file card + its authenticated owner preview/download controls. */
export const RECIPES_ROUTE_RESULT_FILE_ATTR =
  'data-recued-recipes-result-file';
export const RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR =
  'data-recued-recipes-result-file-status';
export const RECIPES_ROUTE_RESULT_RETURN_ATTR =
  'data-recued-recipes-result-return';
export const RECIPES_ROUTE_RESULT_PROVENANCE_ATTR =
  'data-recued-recipes-result-provenance';

const RECIPES_ROUTE_ACTION_ATTR = 'data-recued-recipes-action';
const RECIPES_ROUTE_RECIPE_ID_ATTR = 'data-recipe-id';
const SHARED_ACTION_ATTR = 'data-action';
const RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR =
  'data-recued-recipes-result-action-select';
const RECIPES_ROUTE_RESULT_FILE_MODE_ATTR =
  'data-recued-recipes-result-file-mode';

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


/** Automation LIST callers — read-only status surfacing (the per-recipe
 *  summary line). Management lives at #automation. All soft. */
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
  cron_expression: string;
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

export type RecipesResultOrigin =
  | 'recipe-detail'
  | 'related-recipes'
  | 'result-action';

export interface RecipesResultPanelSnapshot {
  route_recipe_id: string;
  source_recipe_id: string | null;
  render_recipe_id: string;
  origin: RecipesResultOrigin;
  result: ServerExecuteResponse;
  previous?: RecipesResultPanelSnapshot;
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
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-panel {
  display: grid;
  gap: 10px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-status {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-provenance {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-provenance code {
  font: 11px/1.4 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-card h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 650;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-list,
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-checklist {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-row {
  display: grid;
  grid-template-columns: minmax(100px, 180px) minmax(0, 1fr);
  gap: 10px;
  font-size: 12px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-label {
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-value {
  color: var(--fg);
  overflow-wrap: anywhere;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-table-wrap {
  overflow-x: auto;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-table th,
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-table td {
  border-bottom: 1px solid var(--border-subtle);
  padding: 6px;
  text-align: left;
  vertical-align: top;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-table th {
  color: var(--fg-muted);
  font-weight: 650;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
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
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-muted {
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-action-disabled {
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-action-select {
  max-width: 220px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-list {
  display: grid;
  gap: 10px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact {
  display: grid;
  gap: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-sunk);
  padding: 10px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact--invalid {
  border-style: dashed;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-header h4,
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-header p {
  margin: 0;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-header h4 {
  font-size: 13px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-header p {
  margin-top: 3px;
  color: var(--fg-muted);
  font-size: 12px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-badge {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 7px;
  color: var(--fg-muted);
  font-size: 11px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-metadata code {
  overflow-wrap: anywhere;
  font: 11px/1.4 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-file-artifact-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
[${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-file-error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}
@media (max-width: 720px) {
  [${RECIPES_ROUTE_HOST_ATTR}] .recipes-result-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
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

const recipeGrantSummary = (
  entry: ServerRecipeListEntry,
  tool: ToolEntry | null,
  enrolledConnections: ReadonlyArray<ConnectionView> | null,
): string => {
  const requires = entry.recipe.requires ?? [];
  const risk = tool?.risk_tier ?? tool?.classification ?? 'unknown';
  const approval =
    risk === 'write' || risk === 'admin' || risk === 'destructive'
      ? 'Approval policy applies before external side effects.'
      : risk === 'read'
        ? 'Read-class recipe; write approval is not declared.'
        : 'Risk is resolved at dispatch from the recipe and tools.';
  const needs = requires.length > 0 ? requires.join(', ') : 'No manifest permissions declared.';
  const connectionsLine = renderConnectionsNeed(
    recipeRequiredConnections(entry.recipe),
    enrolledConnections,
  );
  return `
    <div><strong>Needs:</strong> ${e(needs)}</div>
    ${connectionsLine}
    <div><strong>Risk:</strong> ${e(String(risk))}. ${e(approval)}</div>
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

/** Pack chips group the installed recipes by the pack each one binds to via
 *  `depends_on` (`<publisher>.<pack>`, e.g. `recued-core.hubspot`) — the
 *  real recipe->pack link (D-182 Tier-P). Recipes with no `depends_on`
 *  fall under a separate "Standalone" chip. Most-used packs first, capped. */
const recipePackLabel = (dep: string): string => {
  const short = dep.slice(dep.lastIndexOf('.') + 1).replace(/-pack$/, '');
  return short.charAt(0).toUpperCase() + short.slice(1).replace(/[_-]+/g, ' ');
};

const topRecipePacks = (
  recipes: ReadonlyArray<ServerRecipeListEntry>,
): ReadonlyArray<{ value: string; label: string }> => {
  const freq = new Map<string, number>();
  for (const entry of recipes) {
    for (const dep of entry.recipe.depends_on ?? []) {
      freq.set(dep, (freq.get(dep) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([dep]) => ({ value: dep, label: recipePackLabel(dep) }));
};

/** Delta 3 — the "from pack X" provenance label. Links to the dedicated
 *  #packs route (where pack install / grant management lives). Empty for a
 *  standalone recipe. Reused on the card + the detail header. */
const renderFromPack = (depends_on: ReadonlyArray<string>): string => {
  if (depends_on.length === 0) return '';
  const label = depends_on.map((dep) => recipePackLabel(dep)).join(', ');
  return `<a class="recipes-inline-link" href="#packs" ${RECIPES_ROUTE_FROM_PACK_ATTR}="${e(depends_on.join(' '))}">from ${e(label)}</a>`;
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
  const packs = entry.recipe.depends_on ?? [];
  return filter.pack === '__standalone__'
    ? packs.length === 0
    : packs.includes(filter.pack);
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
  const hasStandalone = recipes.some(
    (entry) => (entry.recipe.depends_on ?? []).length === 0,
  );
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
  const deps = entry.recipe.depends_on ?? [];
  return `
    <article ${RECIPES_ROUTE_RECIPE_CARD_ATTR}="${e(entry.recipe_id)}"
      ${RECIPES_ROUTE_ACTION_ATTR}="open-recipe"
      ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}"
      ${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="${e(deriveTriggerKind(entry))}"
      ${RECIPES_ROUTE_RECIPE_PACKS_ATTR}="${e(deps.join(' '))}"
      ${RECIPES_ROUTE_RECIPE_SEARCH_ATTR}="${e(searchText)}"
      role="button" tabindex="0" aria-label="Open ${e(name)}">
      ${renderRecipeCard(projectRecipeCardState(entry, catalog))}
      <div class="recipes-card-meta">
        ${renderFromPack(deps)}
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
}

type RenderedOutputSection = {
  type: string;
  data: unknown;
  label?: unknown;
  source?: unknown;
} & Record<string, unknown>;

type RecipeOutputAction = {
  kind: 'recipe.run';
  label: string;
  recipe_id: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  variant?: 'primary' | 'secondary' | 'danger';
  confirm?: string;
};

type ResultFileArtifact = {
  record_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  generated_at: number;
  title: string;
  generation_mode?: string;
  origin?: {
    submission_id?: string;
  };
  payment?: {
    amount_minor?: number;
    currency?: string;
    status?: string;
    verified_at?: number;
  };
  template?: {
    filename?: string;
    sha256?: string;
    format?: string;
  };
  approval_action?: unknown;
  decision_actions?: unknown[];
};

type RegisteredResultFile = {
  artifact: ResultFileArtifact;
  stableKey: string;
};

type ResultActionRegistry = {
  actions: Map<string, RecipeOutputAction>;
  files: Map<string, RegisteredResultFile>;
  installed: ReadonlyMap<string, ServerRecipeListEntry>;
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null;
  canReadFiles: boolean;
  fileBusy: ReadonlySet<string>;
  fileErrors: ReadonlyMap<string, string>;
  fileVerified: ReadonlySet<string>;
  nextActionId: number;
  nextGroupId: number;
  nextFileId: number;
};

type ResultActionValidation =
  | { ok: true; action: RecipeOutputAction }
  | { ok: false; label: string; reason: string };

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const isJsonCompatible = (
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): boolean => {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonCompatible(entry, nextAncestors));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>)
    .every((entry) => isJsonCompatible(entry, nextAncestors));
};

const RESULT_ACTION_VARIANTS = new Set(['primary', 'secondary', 'danger']);
const RESULT_ACTION_RESERVED_CONTEXT_KEYS = new Set(['event', 'server', 'recipe', 'tabs']);

const createResultActionRegistry = (
  installed: ReadonlyArray<ServerRecipeListEntry>,
  runnability: ReadonlyMap<string, RecipeRunnabilityEntry> | null,
  canReadFiles: boolean,
  fileBusy: ReadonlySet<string>,
  fileErrors: ReadonlyMap<string, string>,
  fileVerified: ReadonlySet<string>,
): ResultActionRegistry => ({
  actions: new Map(),
  files: new Map(),
  installed: new Map(installed.map((entry) => [entry.recipe_id, entry])),
  runnability,
  canReadFiles,
  fileBusy,
  fileErrors,
  fileVerified,
  nextActionId: 0,
  nextGroupId: 0,
  nextFileId: 0,
});

const resultActionError = (
  label: string,
  reason: string,
): ResultActionValidation => ({ ok: false, label, reason });

const normalizeResultAction = (
  value: unknown,
  registry: ResultActionRegistry,
): ResultActionValidation => {
  const row = asRecord(value);
  if (row === null) {
    return resultActionError('Unavailable action', 'Action descriptor is malformed.');
  }
  const rawLabel = row.label;
  const label = typeof rawLabel === 'string' && rawLabel.trim().length > 0
    ? rawLabel.trim()
    : 'Unavailable action';
  if (row.kind !== 'recipe.run') {
    return resultActionError(label, 'Only recipe.run actions can be opened.');
  }
  if (typeof rawLabel !== 'string' || rawLabel.trim().length === 0) {
    return resultActionError(label, 'Action label is missing.');
  }
  if (typeof row.recipe_id !== 'string' || row.recipe_id.trim().length === 0) {
    return resultActionError(label, 'Target recipe is missing.');
  }
  const recipeId = row.recipe_id.trim();
  const targetEntry = registry.installed.get(recipeId);
  if (targetEntry === undefined) {
    return resultActionError(label, `Recipe "${recipeId}" is not installed.`);
  }
  let config: Record<string, unknown> | undefined;
  if (row.config !== undefined) {
    const parsedConfig = asRecord(row.config);
    if (parsedConfig === null || !isJsonCompatible(parsedConfig)) {
      return resultActionError(
        label,
        'Action config must be a JSON-compatible object.',
      );
    }
    config = parsedConfig;
  }
  let context: Record<string, unknown> | undefined;
  if (row.context !== undefined) {
    const parsedContext = asRecord(row.context);
    if (parsedContext === null || !isJsonCompatible(parsedContext)) {
      return resultActionError(
        label,
        'Action context must be a JSON-compatible object.',
      );
    }
    context = parsedContext;
  }
  if (
    row.variant !== undefined
    && (typeof row.variant !== 'string' || !RESULT_ACTION_VARIANTS.has(row.variant))
  ) {
    return resultActionError(label, 'Action variant is not supported.');
  }
  if (row.confirm !== undefined && typeof row.confirm !== 'string') {
    return resultActionError(label, 'Action confirmation text must be a string.');
  }
  if (context !== undefined) {
    const reserved = Object.keys(context)
      .find((key) => RESULT_ACTION_RESERVED_CONTEXT_KEYS.has(key));
    if (reserved !== undefined) {
      return resultActionError(label, `Action context cannot set reserved key "${reserved}".`);
    }
  }
  if (registry.runnability === null) {
    return resultActionError(label, 'Recipe runnability is unavailable.');
  }
  const targetRunnability = registry.runnability.get(recipeId);
  if (targetRunnability === undefined) {
    return resultActionError(label, 'Target recipe runnability is unavailable.');
  }
  if (targetRunnability?.status === 'blocked') {
    return resultActionError(label, 'Target recipe is blocked by missing providers.');
  }
  return {
    ok: true,
    action: {
      kind: 'recipe.run',
      label,
      recipe_id: recipeId,
      ...(config !== undefined ? { config } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(typeof row.variant === 'string'
        ? { variant: row.variant as RecipeOutputAction['variant'] }
        : {}),
      ...(typeof row.confirm === 'string' && row.confirm.trim().length > 0
        ? { confirm: row.confirm.trim() }
        : {}),
    },
  };
};

const registerResultAction = (
  registry: ResultActionRegistry,
  action: RecipeOutputAction,
): string => {
  const id = `result-action-${registry.nextActionId}`;
  registry.nextActionId += 1;
  registry.actions.set(id, action);
  return id;
};

const resultOutputSections = (
  result: ServerExecuteResponse,
): RenderedOutputSection[] => {
  const output = asRecord(result.output);
  if (output === null) return [];
  const render = output.render;
  const sidebar = output.sidebar;
  const sections = Array.isArray(render) ? render : sidebar;
  if (!Array.isArray(sections)) return [];
  return sections
    .filter((section): section is RenderedOutputSection => {
      const row = asRecord(section);
      return row !== null && typeof row.type === 'string';
    })
    .map((section) => section);
};

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

type ResultFileArtifactValidation =
  | { ok: true; artifact: ResultFileArtifact }
  | { ok: false; reason: string };

const readNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;

const readOptionalFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const normalizeResultFileArtifact = (
  value: unknown,
): ResultFileArtifactValidation => {
  const row = asRecord(value);
  if (row === null) return { ok: false, reason: 'File artifact descriptor is malformed.' };
  const recordId = readNonEmptyString(row.record_id);
  const filename = readNonEmptyString(row.filename);
  const mimeType = readNonEmptyString(row.mime_type);
  const sha256 = readNonEmptyString(row.sha256);
  const sizeBytes = readOptionalFiniteNumber(row.size_bytes);
  const generatedAt = readOptionalFiniteNumber(row.generated_at);
  if (recordId === undefined) return { ok: false, reason: 'File reference is missing.' };
  if (filename === undefined) return { ok: false, reason: 'Filename is missing.' };
  if (mimeType === undefined) return { ok: false, reason: 'File MIME type is missing.' };
  if (sha256 === undefined || !/^[a-f0-9]{64}$/.test(sha256)) {
    return { ok: false, reason: 'File SHA-256 is invalid.' };
  }
  if (sizeBytes === undefined || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, reason: 'File size must be a positive integer.' };
  }
  if (
    generatedAt === undefined
    || !Number.isSafeInteger(generatedAt)
    || generatedAt < 0
    || generatedAt > 8_640_000_000_000_000
  ) {
    return { ok: false, reason: 'Generation timestamp is invalid.' };
  }
  if (
    row.decision_actions !== undefined
    && (!Array.isArray(row.decision_actions) || row.decision_actions.length > 3)
  ) {
    return { ok: false, reason: 'File decision actions are malformed.' };
  }

  const originRow = asRecord(row.origin);
  const paymentRow = asRecord(row.payment);
  const templateRow = asRecord(row.template);
  const submissionId = readNonEmptyString(originRow?.submission_id);
  const amountMinor = readOptionalFiniteNumber(paymentRow?.amount_minor);
  const verifiedAt = readOptionalFiniteNumber(paymentRow?.verified_at);
  const paymentCurrency = readNonEmptyString(paymentRow?.currency);
  const paymentStatus = readNonEmptyString(paymentRow?.status);
  const templateFilename = readNonEmptyString(templateRow?.filename);
  const templateSha256 = readNonEmptyString(templateRow?.sha256);
  const templateFormat = readNonEmptyString(templateRow?.format);
  const generationMode = readNonEmptyString(row.generation_mode);
  const artifact: ResultFileArtifact = {
    record_id: recordId,
    filename,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    sha256,
    generated_at: generatedAt,
    title: readNonEmptyString(row.title) ?? filename,
    ...(generationMode !== undefined ? { generation_mode: generationMode } : {}),
    ...(originRow !== null
      ? {
          origin: {
            ...(submissionId !== undefined ? { submission_id: submissionId } : {}),
          },
        }
      : {}),
    ...(paymentRow !== null
      ? {
          payment: {
            ...(amountMinor !== undefined ? { amount_minor: amountMinor } : {}),
            ...(paymentCurrency !== undefined ? { currency: paymentCurrency } : {}),
            ...(paymentStatus !== undefined ? { status: paymentStatus } : {}),
            ...(verifiedAt !== undefined ? { verified_at: verifiedAt } : {}),
          },
        }
      : {}),
    ...(templateRow !== null
      ? {
          template: {
            ...(templateFilename !== undefined ? { filename: templateFilename } : {}),
            ...(templateSha256 !== undefined ? { sha256: templateSha256 } : {}),
            ...(templateFormat !== undefined ? { format: templateFormat } : {}),
          },
        }
      : {}),
    ...(row.approval_action !== undefined
      ? { approval_action: row.approval_action }
      : {}),
    ...(Array.isArray(row.decision_actions)
      ? { decision_actions: row.decision_actions }
      : {}),
  };
  return { ok: true, artifact };
};

/** Verification is descriptor-exact, not merely blob-exact. Two cards that
 * happen to name the same content address must not share an approval unlock if
 * their displayed MIME, filename, or size differs. */
const resultFileStableKey = (artifact: ResultFileArtifact): string =>
  JSON.stringify([
    artifact.record_id,
    artifact.sha256,
    artifact.mime_type,
    artifact.filename,
    artifact.size_bytes,
  ]);

const registerResultFile = (
  registry: ResultActionRegistry,
  artifact: ResultFileArtifact,
): { id: string; stableKey: string } => {
  const id = `result-file-${registry.nextFileId}`;
  registry.nextFileId += 1;
  const stableKey = resultFileStableKey(artifact);
  registry.files.set(id, { artifact, stableKey });
  return { id, stableKey };
};

const displayResultFileTime = (value: number | undefined): string => {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
};

const displayResultFileMoney = (
  amountMinor: number | undefined,
  currency: string | undefined,
): string => {
  if (amountMinor === undefined || currency === undefined) return '—';
  return `${amountMinor.toLocaleString('en-US')} ${currency.toUpperCase()} minor units`;
};

const getPathValue = (row: unknown, path: string): unknown => {
  let current: unknown = row;
  for (const part of path.split('.')) {
    if (part.length === 0) return undefined;
    const record = asRecord(current);
    if (record === null || !Object.prototype.hasOwnProperty.call(record, part)) {
      return undefined;
    }
    current = record[part];
  }
  return current;
};

const sectionTitle = (section: RenderedOutputSection): string => {
  if (typeof section.label === 'string' && section.label.trim().length > 0) {
    return section.label;
  }
  const data = asRecord(section.data);
  if (data !== null && typeof data.title === 'string' && data.title.length > 0) {
    return data.title;
  }
  switch (section.type) {
    case 'summary':
      return 'Summary';
    case 'table':
      return 'Table';
    case 'checklist':
      return 'Checklist';
    case 'copyable':
      return 'Copyable';
    case 'ai_analysis':
      return 'AI analysis';
    case 'text':
      return 'Text';
    case 'button':
      return 'Actions';
    case 'file_artifact':
      return 'File artifacts';
    case 'link_button':
      return 'Links';
    case 'json':
      return 'Data';
    default:
      return `Unsupported output: ${section.type}`;
  }
};

const resultActionClass = (action: RecipeOutputAction): string =>
  action.variant === 'primary'
    ? ' recipes-button--primary'
    : action.variant === 'danger'
      ? ' recipes-button--danger'
      : '';

const renderDisabledResultAction = (
  label: string,
  reason: string,
): string => `
  <span class="recipes-result-actions">
    <button type="button" class="recipes-button" disabled>${e(label)}</button>
    <span class="recipes-result-action-disabled">${e(reason)}</span>
  </span>
`;

const renderSingleResultAction = (
  validation: ResultActionValidation,
  registry: ResultActionRegistry,
): string => {
  if (!validation.ok) {
    return renderDisabledResultAction(validation.label, validation.reason);
  }
  const id = registerResultAction(registry, validation.action);
  return `
    <span class="recipes-result-actions">
      <button type="button" class="recipes-button${resultActionClass(validation.action)}"
        ${RECIPES_ROUTE_ACTION_ATTR}="run-result-action"
        ${RECIPES_ROUTE_RESULT_ACTION_ATTR}="${e(id)}">${e(validation.action.label)}</button>
    </span>
  `;
};

const renderResultActionControls = (
  value: unknown,
  registry: ResultActionRegistry,
): string => {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return '<p class="recipes-detail-note">No actions returned.</p>';
  }
  const validations = values.map((entry) => normalizeResultAction(entry, registry));
  if (validations.length === 1) {
    return renderSingleResultAction(validations[0]!, registry);
  }
  const groupId = `result-action-group-${registry.nextGroupId}`;
  registry.nextGroupId += 1;
  const options = validations
    .filter((validation): validation is { ok: true; action: RecipeOutputAction } => validation.ok)
    .map((validation) => {
      const id = registerResultAction(registry, validation.action);
      return `<option value="${e(id)}">${e(validation.action.label)}</option>`;
    });
  const disabled = validations
    .filter((validation): validation is { ok: false; label: string; reason: string } => !validation.ok)
    .map((validation) =>
      `<span class="recipes-result-action-disabled">${e(validation.label)}: ${e(validation.reason)}</span>`)
    .join('');
  if (options.length === 0) {
    return `<span class="recipes-result-actions">${disabled}</span>`;
  }
  return `
    <span class="recipes-result-actions">
      <select class="recipes-result-action-select"
        ${RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR}="${e(groupId)}"
        aria-label="Recipe action">
        ${options.join('')}
      </select>
      <button type="button" class="recipes-button"
        ${RECIPES_ROUTE_ACTION_ATTR}="run-selected-result-action"
        ${RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR}="${e(groupId)}">Run</button>
      ${disabled}
    </span>
  `;
};

const validatePinnedResultApprovalAction = (
  value: unknown,
  artifact: ResultFileArtifact,
  registry: ResultActionRegistry,
): ResultActionValidation => {
  const validation = normalizeResultAction(value, registry);
  if (!validation.ok) return validation;
  const submissionId = artifact.origin?.submission_id;
  const actionSubmissionId = validation.action.config?.submission_id;
  const reviewedSha256 = validation.action.config?.reviewed_artifact_sha256;
  if (submissionId === undefined) {
    return resultActionError(
      validation.action.label,
      'Approval action is missing its originating response pin.',
    );
  }
  if (actionSubmissionId !== submissionId || reviewedSha256 !== artifact.sha256) {
    return resultActionError(
      validation.action.label,
      'Approval action does not match this exact response and file hash.',
    );
  }
  if (
    validation.action.recipe_id !== 'approve-deliver-paid-document'
    || validation.action.context !== undefined
    || Object.keys(validation.action.config ?? {}).sort().join(',')
      !== 'reviewed_artifact_sha256,submission_id'
  ) {
    return resultActionError(
      validation.action.label,
      'Approval action target or config is not the closed exact-artifact action.',
    );
  }
  return validation;
};

const validatePinnedResultDecisionAction = (
  value: unknown,
  artifact: ResultFileArtifact,
  registry: ResultActionRegistry,
): ResultActionValidation => {
  const validation = normalizeResultAction(value, registry);
  if (!validation.ok) return validation;
  const submissionId = artifact.origin?.submission_id;
  const config = validation.action.config;
  if (
    submissionId === undefined
    || config?.submission_id !== submissionId
    || config.reviewed_artifact_sha256 !== artifact.sha256
  ) {
    return resultActionError(
      validation.action.label,
      'Decision action does not match this exact response and file hash.',
    );
  }
  const configKeys = Object.keys(config).sort().join(',');
  const isRegenerate = validation.action.recipe_id === 'generate-paid-document'
    && validation.action.context === undefined
    && configKeys === 'reviewed_artifact_sha256,submission_id';
  const isRejectOrCancel = validation.action.recipe_id
      === 'regenerate-reject-paid-document'
    && validation.action.context === undefined
    && configKeys === 'decision,reviewed_artifact_sha256,submission_id'
    && (config.decision === 'reject' || config.decision === 'cancel');
  if (!isRegenerate && !isRejectOrCancel) {
    return resultActionError(
      validation.action.label,
      'Decision action target or config is outside the closed artifact-decision set.',
    );
  }
  return validation;
};

const renderGatedPinnedFileActions = (
  validations: ResultActionValidation[],
  registry: ResultActionRegistry,
  registered: { stableKey: string },
  busy: boolean,
  kind: 'approval' | 'decision',
): string => validations.map((actionValidation) => {
  if (!actionValidation.ok) return renderSingleResultAction(actionValidation, registry);
  if (!registry.canReadFiles) {
    return renderDisabledResultAction(
      actionValidation.action.label,
      kind === 'approval'
        ? 'Authenticated preview/download is required before approval.'
        : 'Authenticated preview/download is required before this decision.',
    );
  }
  if (busy) {
    return renderDisabledResultAction(
      actionValidation.action.label,
      'The exact file is still being verified.',
    );
  }
  if (!registry.fileVerified.has(registered.stableKey)) {
    return renderDisabledResultAction(
      actionValidation.action.label,
      kind === 'approval'
        ? 'Preview or download this exact file before approving it.'
        : 'Preview or download this exact file before deciding.',
    );
  }
  return renderSingleResultAction(actionValidation, registry);
}).join('');

const renderOneFileArtifact = (
  value: unknown,
  registry: ResultActionRegistry,
): string => {
  const validation = normalizeResultFileArtifact(value);
  if (!validation.ok) {
    return `
      <article class="recipes-file-artifact recipes-file-artifact--invalid">
        <p class="recipes-detail-note">${e(validation.reason)}</p>
      </article>
    `;
  }
  const artifact = validation.artifact;
  const registered = registerResultFile(registry, artifact);
  const busy = registry.fileBusy.has(registered.stableKey);
  const readDisabled = !registry.canReadFiles || busy;
  const readReason = !registry.canReadFiles
    ? 'Authenticated file preview is not available from this client.'
    : busy
      ? 'Reading the exact file…'
      : '';
  const error = registry.fileErrors.get(registered.stableKey);
  const canPreview = artifact.mime_type === 'application/pdf';
  const approvalValidation = artifact.approval_action === undefined
    ? null
    : validatePinnedResultApprovalAction(
        artifact.approval_action,
        artifact,
        registry,
      );
  const decisionValidations = (artifact.decision_actions ?? []).map((action) =>
    validatePinnedResultDecisionAction(action, artifact, registry));
  const approval = approvalValidation === null
    ? ''
    : renderGatedPinnedFileActions(
        [approvalValidation],
        registry,
        registered,
        busy,
        'approval',
      );
  const decisions = renderGatedPinnedFileActions(
    decisionValidations,
    registry,
    registered,
    busy,
    'decision',
  );
  return `
    <article class="recipes-file-artifact" ${RECIPES_ROUTE_RESULT_FILE_ATTR}="${e(registered.id)}">
      <header class="recipes-file-artifact-header">
        <div>
          <h4>${e(artifact.title)}</h4>
          <p>${e(artifact.filename)} · ${e(artifact.mime_type)} · ${e(artifact.size_bytes.toLocaleString('en-US'))} bytes</p>
        </div>
        <span class="recipes-file-artifact-badge">Exact immutable file</span>
      </header>
      <dl class="recipes-result-list recipes-file-artifact-metadata">
        <div class="recipes-result-row">
          <dt class="recipes-result-label">Originating response</dt>
          <dd class="recipes-result-value"><code>${e(artifact.origin?.submission_id ?? '—')}</code></dd>
        </div>
        <div class="recipes-result-row">
          <dt class="recipes-result-label">Verified payment</dt>
          <dd class="recipes-result-value">${e(displayResultFileMoney(
            artifact.payment?.amount_minor,
            artifact.payment?.currency,
          ))} · ${e(artifact.payment?.status ?? '—')} · ${e(displayResultFileTime(artifact.payment?.verified_at))}</dd>
        </div>
        <div class="recipes-result-row">
          <dt class="recipes-result-label">Template</dt>
          <dd class="recipes-result-value">${e(artifact.template?.filename ?? '—')} · ${e(artifact.template?.format ?? '—')}<br><code>${e(artifact.template?.sha256 ?? '—')}</code></dd>
        </div>
        <div class="recipes-result-row">
          <dt class="recipes-result-label">Generation</dt>
          <dd class="recipes-result-value">${e(artifact.generation_mode ?? '—')} · ${e(displayResultFileTime(artifact.generated_at))}</dd>
        </div>
        <div class="recipes-result-row">
          <dt class="recipes-result-label">PDF SHA-256</dt>
          <dd class="recipes-result-value"><code>${e(artifact.sha256)}</code></dd>
        </div>
      </dl>
      <div class="recipes-file-artifact-controls">
        ${canPreview
          ? `<button type="button" class="recipes-button"
              ${RECIPES_ROUTE_ACTION_ATTR}="open-result-file"
              ${RECIPES_ROUTE_RESULT_FILE_ATTR}="${e(registered.id)}"
              ${RECIPES_ROUTE_RESULT_FILE_MODE_ATTR}="preview"
              ${readDisabled ? 'disabled' : ''}>Preview exact PDF</button>`
          : ''}
        <button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="open-result-file"
          ${RECIPES_ROUTE_RESULT_FILE_ATTR}="${e(registered.id)}"
          ${RECIPES_ROUTE_RESULT_FILE_MODE_ATTR}="download"
          ${readDisabled ? 'disabled' : ''}>Download exact ${canPreview ? 'PDF' : 'file'}</button>
        ${approval}
        ${decisions}
      </div>
      ${readReason !== ''
        ? `<p class="recipes-detail-note" ${RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR}>${e(readReason)}</p>`
        : ''}
      ${error !== undefined
        ? `<p class="recipes-result-file-error" role="alert" ${RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR}>${e(error)}</p>`
        : ''}
    </article>
  `;
};

const renderFileArtifactResultSection = (
  section: RenderedOutputSection,
  registry: ResultActionRegistry,
): string => {
  const values = Array.isArray(section.data) ? section.data : [section.data];
  if (section.data === null || section.data === undefined || values.length === 0) {
    return '<p class="recipes-detail-note">No exact file artifacts returned.</p>';
  }
  return `<div class="recipes-file-artifact-list">${values
    .map((value) => renderOneFileArtifact(value, registry))
    .join('')}</div>`;
};

const renderSummaryResultSection = (
  section: RenderedOutputSection,
): string => {
  const data = asRecord(section.data);
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  if (fields.length === 0) {
    return `<pre class="recipes-result-pre">${e(displayValue(section.data))}</pre>`;
  }
  return `
    <dl class="recipes-result-list">
      ${fields.map((field) => {
        const row = asRecord(field);
        if (row === null) return '';
        return `
          <div class="recipes-result-row">
            <dt class="recipes-result-label">${e(displayValue(row.label))}</dt>
            <dd class="recipes-result-value">${e(displayValue(row.value))}</dd>
          </div>
        `;
      }).join('')}
    </dl>
  `;
};

const renderTableResultSection = (
  section: RenderedOutputSection,
  registry: ResultActionRegistry,
): string => {
  const data = asRecord(section.data);
  const columns = (Array.isArray(data?.columns) ? data.columns : [])
    .map((column) => {
      if (typeof column === 'string') {
        return {
          field: column,
          label: column,
          type: 'text' as const,
          format: undefined,
        };
      }
      const row = asRecord(column);
      if (row === null || typeof row.field !== 'string') return null;
      return {
        field: row.field,
        label: typeof row.label === 'string' ? row.label : row.field,
        type: row.type === 'action' ? 'action' as const : 'text' as const,
        format: typeof row.format === 'string' ? row.format : undefined,
      };
    })
    .filter((column): column is {
      field: string;
      label: string;
      type: 'text' | 'action';
      format: string | undefined;
    } =>
      column !== null);
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (columns.length === 0 || rows.length === 0) {
    return '<p class="recipes-detail-note">No rows returned.</p>';
  }
  return `
    <div class="recipes-result-table-wrap">
      <table class="recipes-result-table">
        <thead>
          <tr>${columns.map((column) => `<th>${e(column.label)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              ${columns.map((column) => {
                const cell = getPathValue(row, column.field);
                return `<td>${column.type === 'action'
                  ? renderResultActionControls(cell, registry)
                  : e(formatValue(cell, column.format))}</td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
};

const renderChecklistResultSection = (
  section: RenderedOutputSection,
  registry: ResultActionRegistry,
): string => {
  const data = asRecord(section.data);
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) {
    return '<p class="recipes-detail-note">No checklist items returned.</p>';
  }
  return `
    <ul class="recipes-result-checklist" role="list">
      ${items.map((item) => {
        const row = asRecord(item);
        if (row === null) return '';
        const status = displayValue(row.status);
        const prefix = status === 'ok'
          ? 'OK'
          : status === 'issue'
            ? 'Issue'
            : status === 'null'
              ? 'No data'
              : 'Unknown';
        return `
          <li>
            <strong>${e(prefix)}:</strong>
            <span>${e(displayValue(row.label))}</span>
            ${row.detail !== undefined
              ? `<span class="recipes-result-muted"> — ${e(displayValue(row.detail))}</span>`
              : ''}
            ${Array.isArray(row.actions)
              ? renderResultActionControls(row.actions, registry)
              : row.action !== undefined
                ? renderResultActionControls(row.action, registry)
                : ''}
          </li>
        `;
      }).join('')}
    </ul>
  `;
};

const renderPlainResultSection = (section: RenderedOutputSection): string =>
  `<pre class="recipes-result-pre">${e(displayValue(section.data))}</pre>`;

/** The label is deliberately NOT passed: this panel already renders it as the card's <h3>
 *  (`sectionTitle` above), and the shared block renders a label of its own — passing it here
 *  printed the authored title TWICE. Same rule as the `json` branch below, and the same rule
 *  for any host that owns its own chrome (`packages/renderer` `label.ts`). */
const renderCopyableResultSection = (section: RenderedOutputSection): string =>
  renderCopyableBlock(section.data);

const PLAIN_RESULT_SECTION_TYPES = new Set(['text']);

const renderUnsupportedResultSection = (section: RenderedOutputSection): string => `
  <p class="recipes-detail-note">Unsupported output section type: ${e(section.type)}</p>
  ${renderPlainResultSection(section)}
`;

const renderRecipeResultSection = (
  section: RenderedOutputSection,
  registry: ResultActionRegistry,
): string => {
  const body =
    section.type === 'summary'
      ? renderSummaryResultSection(section)
      : section.type === 'table'
        ? renderTableResultSection(section, registry)
        : section.type === 'checklist'
          ? renderChecklistResultSection(section, registry)
          : section.type === 'copyable'
            ? renderCopyableResultSection(section)
            : section.type === 'ai_analysis'
              ? renderAiAnalysisBlock(section.data)
              : section.type === 'button'
                ? renderResultActionControls(section.data, registry)
                : section.type === 'file_artifact'
                  ? renderFileArtifactResultSection(section, registry)
                  // A link button is a plain anchor — no action registry, no
                  // host-owned interaction — so the owner's panel renders it
                  // from the SAME shared block the reception surfaces use.
                  : section.type === 'link_button'
                    ? renderLinkButtonBlock(section.data)
                  // Raw step detail, from the SAME shared block the reception
                  // surfaces use. The label is deliberately NOT passed: this
                  // panel already renders it as the card's <h3> (`sectionTitle`
                  // above), so handing it to the block too would print the
                  // authored title twice — once as the heading and again as the
                  // disclosure summary. Reception, which wraps no heading of its
                  // own, DOES pass it (`renderSection`). Same block, and the
                  // consuming surface decides what chrome it already owns.
                  : section.type === 'json'
                    ? renderJsonBlock(section.data)
                : PLAIN_RESULT_SECTION_TYPES.has(section.type)
                  ? renderPlainResultSection(section)
                  : renderUnsupportedResultSection(section);
  return `
    <article class="recipes-result-card" ${RECIPES_ROUTE_RESULT_SECTION_ATTR}="${e(section.type)}">
      <h3>${e(sectionTitle(section))}</h3>
      ${body}
    </article>
  `;
};

const resultAwaitingApproval = (result: ServerExecuteResponse): boolean => {
  return result.awaiting_approval === true;
};

const resultTerminated = (result: ServerExecuteResponse): boolean => {
  return result.run_terminated !== undefined;
};

const installedRecipeName = (
  installed: ReadonlyArray<ServerRecipeListEntry>,
  recipeId: string,
): string =>
  installed.find((entry) => entry.recipe_id === recipeId)
    ?.recipe.metadata?.name?.trim()
  || recipeId;

const resultOriginLabel = (origin: RecipesResultOrigin): string => {
  if (origin === 'result-action') return 'Result action';
  if (origin === 'related-recipes') return 'Related recipes panel';
  return 'Recipe detail';
};

const renderResultRecipeIdentity = (
  installed: ReadonlyArray<ServerRecipeListEntry>,
  recipeId: string,
): string =>
  `${e(installedRecipeName(installed, recipeId))} (<code>${e(recipeId)}</code>)`;

const renderRecipeResultPanel = (
  panel: RecipesResultPanelSnapshot | null,
  installed: ReadonlyArray<ServerRecipeListEntry>,
  registry: ResultActionRegistry,
): string => {
  const renderName = panel === null
    ? ''
    : installedRecipeName(installed, panel.render_recipe_id);
  const empty = panel === null
    ? '<p class="recipes-detail-note">No current-session result yet. Run a recipe to render its returned output here.</p>'
    : '';
  const result = panel?.result ?? null;
  const status = result === null
    ? ''
    : resultTerminated(result)
      ? 'Run terminated'
      : resultAwaitingApproval(result)
        ? 'Awaiting approval'
        : result.success
          ? 'Run completed'
          : 'Run returned errors';
  const sections = result === null || resultAwaitingApproval(result) || resultTerminated(result)
    ? []
    : resultOutputSections(result);
  const previousName = panel?.previous === undefined
    ? ''
    : installedRecipeName(installed, panel.previous.render_recipe_id);
  const returnControl = panel?.previous === undefined
    ? ''
    : `<button type="button" class="recipes-button"
        ${RECIPES_ROUTE_ACTION_ATTR}="restore-result-panel"
        ${RECIPES_ROUTE_RESULT_RETURN_ATTR}="${e(panel.previous.render_recipe_id)}">
        Return to ${e(previousName)} result
      </button>`;
  const body = result === null
    ? empty
    : resultTerminated(result)
      ? '<p class="recipes-detail-note">The run stopped before producing renderable output.</p>'
      : resultAwaitingApproval(result)
        ? '<p class="recipes-detail-note">This run is held for approval. No result output is rendered until the owner reruns or reviews the workflow.</p>'
        : sections.length > 0
          ? sections.map((section) => renderRecipeResultSection(section, registry)).join('')
          : '<p class="recipes-detail-note">The run completed without renderable output.</p>';
  const provenance = panel === null
    ? ''
    : `<p class="recipes-result-provenance"
        ${RECIPES_ROUTE_RESULT_PROVENANCE_ATTR}="${e(panel.origin)}">
        <span><strong>Rendered recipe:</strong> ${renderResultRecipeIdentity(installed, panel.render_recipe_id)}</span>
        <span><strong>Origin:</strong> ${e(resultOriginLabel(panel.origin))}</span>
        <span><strong>Source recipe:</strong> ${panel.source_recipe_id === null
          ? 'None (related-list navigation)'
          : renderResultRecipeIdentity(installed, panel.source_recipe_id)}</span>
      </p>`;
  return `
    <section class="recipes-detail-section recipes-result-panel"
      ${RECIPES_ROUTE_RESULT_PANEL_ATTR}="${panel === null ? '' : e(panel.render_recipe_id)}">
      <h2 class="recipes-detail-section-title">Result</h2>
      ${result !== null
        ? `<p class="recipes-result-status" role="status" aria-live="polite" aria-atomic="true">${e(status)}${renderName !== '' ? ` · ${e(renderName)}` : ''} · ${e(String(result.duration_ms))} ms · ${e(plural(result.steps.length, 'step'))}</p>`
        : ''}
      ${provenance}
      ${returnControl}
      ${body}
    </section>
  `;
};

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

/** One compact line of a recipe's automation state (read-only — management
 *  lives at #automation). Empty when the recipe has none. */
const recipeAutomationSummaryText = (
  data: RecipesAutomationData,
  recipe_id: string,
): string => {
  const parts: string[] = [];
  for (const s of recipeSchedules(data, recipe_id)) {
    parts.push(`${describeCron(s.cron_expression)}${s.enabled ? '' : ' (paused)'}`);
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
): string => {
  const name = recipeDisplayName(entry);
  const triggerKind = deriveTriggerKind(entry);
  const tool = findToolForRecipe(entry, catalog);
  const deps = entry.recipe.depends_on ?? [];
  const fromPack = renderFromPack(deps);
  const description = entry.recipe.metadata?.description ?? '';
  const repo = entry.recipe.metadata?.repo;
  const automationText = recipeAutomationSummaryText(automation, entry.recipe_id);
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
            ${RECIPES_ROUTE_ACTION_ATTR}="open-run"
            ${RECIPES_ROUTE_RECIPE_ID_ATTR}="${e(entry.recipe_id)}">Run</button>
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
      </header>
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
          ${recipeGrantSummary(entry, tool, connections)}
        </div>
      </section>
      <section class="recipes-detail-section">
        <h2 class="recipes-detail-section-title">Runs &amp; automation</h2>
        <a class="recipes-inline-link" href="${serializeShellRoute('logs', 'recipe', entry.recipe_id)}" ${RECIPES_ROUTE_RUNS_LINK_ATTR}>View runs in Logs →</a>
        <a class="recipes-inline-link" href="${serializeShellRoute('automation', entry.recipe_id)}" ${RECIPES_ROUTE_AUTOMATION_LINK_ATTR}>Manage automation →</a>
        ${automationText !== '' ? `<p class="recipes-detail-note"><strong>Automation:</strong> ${automationText}</p>` : '<p class="recipes-detail-note">No schedules or triggers yet — add one from Run · Schedule or in Automation.</p>'}
      </section>
      ${renderRecipeResultPanel(resultPanel, installed, resultActionRegistry)}
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
    style.textContent = RECIPES_ROUTE_STYLES;
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
    schedules: null,
    triggers: null,
    autoRun: null,
  };
  let autoRunBusy = new Set<string>();
  let resultPanel: RecipesResultPanelSnapshot | null = null;
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
    const selected = selectedRecipeId !== null
      ? recipes.find((r) => r.recipe_id === selectedRecipeId) ?? null
      : null;
    if (selected !== null) {
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
        runnability,
        pii,
        automationData,
        opts.recipeExecuteCaller !== undefined,
        opts.schedulesListCaller !== undefined
          && opts.schedulesCreateCaller !== undefined,
        opts.recipeConfigGetCaller !== undefined && opts.recipeConfigSetCaller !== undefined,
        opts.autoRunUpdateCaller !== undefined,
        autoRunBusy,
        resultPanel?.route_recipe_id === selected.recipe_id ? resultPanel : null,
        resultActionRegistry,
      );
      resultActions = resultActionRegistry.actions;
      resultFiles = resultActionRegistry.files;
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
    const [schedulesResult, triggersResult, autoRunResult] =
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
    };
    render();
  };

  const openRecipe = (recipe_id: string): void => {
    if (!recipes.some((r) => r.recipe_id === recipe_id)) return;
    if (selectedRecipeId !== recipe_id) {
      resultPanel = null;
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
    resultFileBusy = new Set();
    resultFileErrors = new Map();
    resultFileVerified = new Set();
    resultFileGeneration += 1;
    syncRecipeHash();
    render();
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

  const exactResultFileReadError = (
    expected: ResultFileArtifact,
    actual: Awaited<ReturnType<RecipeFileReadCaller>>,
  ): string | null => {
    if (actual.record_id !== expected.record_id) {
      return 'Authenticated file read returned a different file reference.';
    }
    if (actual.blob_hash !== expected.sha256) {
      return 'Authenticated file read no longer matches the reviewed SHA-256.';
    }
    if (actual.mime_type !== expected.mime_type) {
      return 'Authenticated file read returned a different MIME type.';
    }
    if (actual.filename !== expected.filename) {
      return 'Authenticated file read returned a different filename.';
    }
    if (actual.size_bytes !== expected.size_bytes) {
      return 'Authenticated file read returned a different file size.';
    }
    if (typeof actual.bytes_b64 !== 'string' || actual.bytes_b64.length === 0) {
      return 'Authenticated file read returned no file bytes.';
    }
    return null;
  };

  const triggerResultFileOpen = (
    file: Awaited<ReturnType<RecipeFileReadCaller>>,
    mode: 'preview' | 'download',
    previewWindow?: Window,
  ): void => {
    const view = doc.defaultView as unknown as {
      atob?: (value: string) => string;
      Blob?: typeof Blob;
      URL?: {
        createObjectURL(blob: Blob): string;
        revokeObjectURL(url: string): void;
      };
    } | null | undefined;
    if (
      typeof view?.atob !== 'function'
      || typeof view.Blob !== 'function'
      || typeof view.URL?.createObjectURL !== 'function'
      || typeof view.URL.revokeObjectURL !== 'function'
    ) {
      throw new Error('This browser cannot safely open authenticated file bytes.');
    }
    if (mode === 'preview' && file.mime_type !== 'application/pdf') {
      throw new Error('Inline preview is available only for verified PDF files.');
    }
    const binary = view.atob(file.bytes_b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    if (bytes.length !== file.size_bytes) {
      throw new Error('Authenticated file bytes do not match the returned file size.');
    }
    const blob = new view.Blob([bytes], { type: file.mime_type });
    const url = view.URL.createObjectURL(blob);
    if (mode === 'preview' && previewWindow !== undefined) {
      try {
        previewWindow.location.replace(url);
      } catch (err) {
        view.URL.revokeObjectURL(url);
        throw err;
      }
      const timeout = globalThis.setTimeout(() => {
        resultObjectUrls.delete(url);
        view.URL?.revokeObjectURL(url);
      }, 60_000);
      resultObjectUrls.set(url, timeout);
      return;
    }
    const anchor = doc.createElement('a');
    anchor.href = url;
    if (mode === 'download') {
      anchor.download = file.filename;
    } else {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
    try {
      anchor.click();
    } catch (err) {
      view.URL.revokeObjectURL(url);
      throw err;
    }
    if (mode === 'download') {
      view.URL.revokeObjectURL(url);
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      resultObjectUrls.delete(url);
      view.URL?.revokeObjectURL(url);
    }, 60_000);
    resultObjectUrls.set(url, timeout);
  };

  /** Open the preview browsing context synchronously while the click still
   * has user activation. The later authenticated RPC can then navigate this
   * already-opened context to the verified blob URL without popup blocking. */
  const openResultPreviewWindow = (): Window | null | undefined => {
    const view = doc.defaultView as unknown as {
      open?: (url?: string, target?: string) => Window | null;
    } | null | undefined;
    if (typeof view?.open !== 'function') return undefined;
    const opened = view.open('about:blank', '_blank');
    if (opened === null) return null;
    try {
      opened.opener = null;
    } catch {
      // The newly opened context is still navigable even if a hardened browser
      // refuses the explicit opener assignment.
    }
    return opened;
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
      ? openResultPreviewWindow()
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
      triggerResultFileOpen(file, rawMode, previewWindow);
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
