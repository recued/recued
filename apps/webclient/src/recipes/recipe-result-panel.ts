/** The recipe RESULT PANEL — one run's returned output, rendered interactively.
 *
 *  ⛔ THIS IS THE ONE INTERACTIVE RESULT SURFACE, and it is shared on purpose.
 *  `@recued/renderer` is the one BLOCK renderer (D-196 § 4.5) but it is
 *  deliberately inert: it emits a `type: 'action'` table cell as plain text and
 *  ships no stylesheet. Everything that makes a result *usable* rather than
 *  merely visible lives here —
 *
 *    - the result-action registry + its validation (a `recipe.run` descriptor
 *      is checked against the installed roster AND its target's runnability
 *      before it becomes a pressable control; reserved context keys refused),
 *    - file artifacts, whose preview/download is gated on a re-check of
 *      ref / hash / MIME / name / size against what the card claimed,
 *    - the D-222 filter form, its paging, and the editable grid.
 *
 *  Each of those is a FENCE. Extracted out of `bootstrap-recipes-route.ts` so a
 *  second host (`#packs/<slug>`'s Use tab) renders results through the same
 *  code instead of growing a parallel copy — which is precisely how a fence
 *  gets tightened on one surface and forgotten on the other.
 *
 *  ── Layering ──────────────────────────────────────────────────────
 *  PURE: state in → HTML string out, plus a registry the host reads back to
 *  wire clicks. It owns no state, performs no IO, and never touches the DOM.
 *  The host owns the panel snapshot, the filter states, the file busy/error
 *  sets, and every async handler (`submitResultFilter`, `openResultFile`,
 *  `openResultAction`, …). That split is what lets two hosts with very
 *  different lifecycles share one renderer.
 *
 *  ⚠ The `data-recued-recipes-*` attribute names are the PANEL's vocabulary,
 *  not the recipes route's. They are emitted wherever the panel renders; a host
 *  delegating clicks matches on them. Renaming them is a test-wide churn with
 *  no behavioural gain, so they kept the name they were born with.
 */


import type {
  RecipeRunnabilityEntry,
  ResolvedFilterDescriptor,
  ResolvedTableEditDescriptor,
  ServerExecuteResponse,
  ServerRecipeListEntry,
  TableColumnControl,
} from '@recued/contracts';
import {
  isResolvedRecordColumnsDescriptor, NUMERIC_FIELD_KINDS, tableColumnInputType,
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
  canSubmitTableEdit,
  formatClientDateTime,
  initialTableEditState,
  isResolvedTableEditDescriptor,
  tableEditCellAddress,
  tableEditStatus,
  type OutputTableEditState,
  dedupeOutputRowsById,
  initialOutputFilterState,
  isResolvedFilterDescriptor,
  outputFilterKey,
  outputFilterInvocation,
  outputFilterPageConfig,
  outputFilterSearchConfig,
  renderVariableWidget,
  toWidgetShape,
  validateOutputFilterDraft,
  type OutputFilterState,
  RECORD_REF_CELL_ATTR,
  RECORD_REF_CELL_ENTITY_ATTR,
  RECORD_REF_CELL_FILTER_ATTR,
  RefPicker,
} from '@recued/ui-shared';


/** The host attribute every surface embedding the panel must stamp on its
 *  result container. It is what makes {@link RECIPE_RESULT_PANEL_STYLES}
 *  reach BOTH the recipes route and `#packs/<slug>`.
 *
 *  ⛔ These rules used to live in the recipes route's own style literal scoped
 *  under `[data-recued-recipes-route]`, which meant they could not reach any
 *  other surface — the packs Use tab rendered the panel's markup with none of
 *  its styling and grew a partial second copy. Styles for one renderer belong
 *  WITH it; two stylesheets drift exactly the way two renderers do, just less
 *  visibly. */
export const RECIPE_RESULT_HOST_ATTR = 'data-recued-result-host';

/** Every rule the panel's own markup needs, scoped to
 *  {@link RECIPE_RESULT_HOST_ATTR}. Both route bundles include it.
 *
 *  ⚠ The `.recipes-button` / `.recipes-detail-note` /
 *  `.recipes-detail-section-title` rules are here AND in the recipes route.
 *  That is not drift: both modules EMIT those classes (17 and 11 sites
 *  respectively), so each sheet styles the markup its own module renders. The
 *  route's copies serve its cards and headings, outside any result container.
 *
 *  ⚠ CSS is invisible to the render tests — changing anything here needs a
 *  browser check on BOTH surfaces, not a green suite. */
export const RECIPE_RESULT_PANEL_STYLES = `
[${RECIPE_RESULT_HOST_ATTR}] .recipes-button {
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
[${RECIPE_RESULT_HOST_ATTR}] .recipes-button--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-button--danger {
  border-color: var(--danger);
  color: var(--danger);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-button:disabled,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: .65;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-button[aria-busy="true"] {
  cursor: progress;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-detail-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-detail-note {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.45;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-panel {
  display: grid;
  gap: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-status {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-provenance {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-provenance code {
  font: 11px/1.4 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-card h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 650;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-list,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-checklist {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-row {
  display: grid;
  grid-template-columns: minmax(100px, 180px) minmax(0, 1fr);
  gap: 10px;
  font-size: 12px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-label {
  color: var(--fg-muted);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-value {
  color: var(--fg);
  overflow-wrap: anywhere;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-table-wrap {
  overflow-x: auto;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-table th,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-table td {
  border-bottom: 1px solid var(--border-subtle);
  padding: 6px;
  text-align: left;
  vertical-align: top;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-table th {
  color: var(--fg-muted);
  font-weight: 650;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-table th.is-numeric,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-table td.is-numeric,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-cell.is-numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid {
  display: grid;
  gap: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid .recipes-result-table-wrap {
  max-height: min(62vh, 640px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid .recipes-result-table {
  min-width: 760px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid .recipes-result-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-2);
  box-shadow: 0 1px 0 var(--border);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid .recipes-result-table tbody tr:hover td {
  background: var(--surface-2);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid .recipes-result-table td.is-editable {
  background: var(--accent-weak);
  min-width: 180px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-row-actions {
  width: 1%;
  white-space: nowrap;
  text-align: right !important;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-remove {
  padding: 5px 8px;
  color: var(--danger);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-empty {
  padding: 18px !important;
  color: var(--fg-muted);
  text-align: center !important;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-cell {
  width: 100%;
  min-width: 140px;
  box-sizing: border-box;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-cell:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-ref {
  min-width: 220px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-ref.is-disabled {
  pointer-events: none;
  opacity: 0.65;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-status {
  color: var(--fg-muted);
  font-size: 12px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-status[data-dirty="true"] {
  color: var(--fg);
  font-weight: 600;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-refused {
  margin: 0 0 12px;
  padding: 8px 11px;
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--danger);
  border-radius: var(--radius, 8px);
  background: var(--surface-2);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.45;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-radios {
  display: inline-flex;
  gap: 10px;
  flex-wrap: wrap;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-radio {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.45;
}
/* Shared-block label/value list (\`packages/renderer\` summary + record_fields).
   This panel renders summary / table / checklist with its OWN
   \`recipes-result-*\` markup, so it never needed these rules — but it DOES
   delegate other kinds to the shared blocks, and an undelegated class renders
   as an unstyled vertical stack. Reception carries the same rules
   (\`static-assets.ts\`); a structure-and-text test cannot see the difference,
   only a browser can. */
[${RECIPE_RESULT_HOST_ATTR}] .summary-list { margin: 0; }
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-muted {
  color: var(--fg-muted);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter {
  display: grid;
  gap: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .run-modal-fields {
  display: grid;
  gap: 12px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-row {
  display: grid;
  gap: 4px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-row-inline {
  display: block;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-row > label,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-multi-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-row-inline > label,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-multi-opt {
  display: flex;
  align-items: center;
  gap: 7px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-help {
  margin: 0;
  color: var(--fg-muted);
  font-size: 11px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-optional {
  margin-left: 6px;
  color: var(--fg-muted);
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: .04em;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-row input[type="text"],
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-row input[type="number"],
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-row input[type="password"],
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-row select {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-filter .var-multi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 6px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-action-disabled {
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-action-select {
  max-width: 220px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-list {
  display: grid;
  gap: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact {
  display: grid;
  gap: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-sunk);
  padding: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact--invalid {
  border-style: dashed;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header h4,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header p {
  margin: 0;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header h4 {
  font-size: 13px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header p {
  margin-top: 3px;
  color: var(--fg-muted);
  font-size: 12px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-badge {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 7px;
  color: var(--fg-muted);
  font-size: 11px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-metadata code {
  overflow-wrap: anywhere;
  font: 11px/1.4 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-file-error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}
@media (max-width: 720px) {
  [${RECIPE_RESULT_HOST_ATTR}] .recipes-result-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
${RefPicker.REF_PICKER_STYLES}
`;

// ── Attributes the panel emits ────────────────────────────────────
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
/** D-222 owner filter form + its page controls. Attribute value is the stable
 *  `<recipe_id>:<authored_hash>:<section_index>` result-state key. */
export const RECIPES_ROUTE_RESULT_FILTER_ATTR =
  'data-recued-recipes-result-filter';
export const RECIPES_ROUTE_RESULT_FILTER_PAGE_ATTR =
  'data-recued-recipes-result-filter-page';
/** The editable grid's section key (value = `outputFilterKey`-style id). */
export const RECIPES_ROUTE_RESULT_GRID_ATTR = 'data-recued-recipes-result-grid';
/** Carries the TOTAL refused count, so a test pins the number rather than the
 *  sentence — and a host can badge without re-deriving it. */
export const RECIPES_ROUTE_RESULT_REFUSED_ATTR = 'data-recued-recipes-result-refused';
/** Marks the filter's "save the grid first" note, so a test pins the guard
 *  rather than its wording. */
export const RECIPES_ROUTE_RESULT_FILTER_BLOCKED_ATTR =
  'data-recued-recipes-result-filter-blocked';
/** One editable cell: `<rowIndex>:<column>`. */
export const RECIPES_ROUTE_RESULT_GRID_CELL_ATTR = 'data-recued-recipes-result-grid-cell';
/** A row-scoped control (remove), value = the row index. */
export const RECIPES_ROUTE_RESULT_GRID_ROW_ATTR = 'data-recued-recipes-result-grid-row';
export const RECIPES_ROUTE_RESULT_FILTER_ERROR_ATTR =
  'data-recued-recipes-result-filter-error';
export const RECIPES_ROUTE_ACTION_ATTR = 'data-recued-recipes-action';
export const RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR =
  'data-recued-recipes-result-action-select';
export const RECIPES_ROUTE_RESULT_FILE_MODE_ATTR =
  'data-recued-recipes-result-file-mode';

// ── Panel state shapes (owned by the HOST, described here) ────────

export type RecipesResultOrigin =
  | 'recipe-detail'
  | 'related-recipes'
  | 'result-action'
  | 'result-filter';

export interface RecipesResultPanelSnapshot {
  route_recipe_id: string;
  source_recipe_id: string | null;
  render_recipe_id: string;
  origin: RecipesResultOrigin;
  result: ServerExecuteResponse;
  previous?: RecipesResultPanelSnapshot;
}

export type RecipesResultFilterAction = 'search' | 'next' | 'previous';

export interface RecipesResultFilterState extends OutputFilterState {
  readonly busy: boolean;
  readonly busy_action: RecipesResultFilterAction | null;
  readonly error: string | null;
}

/** Optional presentation controls for hosts that reuse the full result
 *  lifecycle outside Recipe detail. Defaults preserve the technical Recipes
 *  surface; Pack Use hides recipe provenance/runtime metrics and supplies its
 *  own workspace heading. */
export interface RecipeResultPanelPresentation {
  /** `undefined` = "Result" (Recipes default), `null` = no panel heading. */
  readonly heading?: string | null;
  /** Render recipe ids, origin, and source recipe. Default true. */
  readonly show_provenance?: boolean;
  /** Render duration and engine step count beside status. Default true. */
  readonly show_run_metrics?: boolean;
  /** Use concise app navigation copy instead of "Return to X result". */
  readonly return_label?: 'result' | 'back';
}

export type RenderedOutputSection = {
  type: string;
  data: unknown;
  label?: unknown;
  source?: unknown;
} & Record<string, unknown>;

export type RecipeOutputAction = {
  kind: 'recipe.run';
  label: string;
  recipe_id: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  variant?: 'primary' | 'secondary' | 'danger';
  confirm?: string;
};

export type ResultFileArtifact = {
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

export type RegisteredResultFile = {
  artifact: ResultFileArtifact;
  stableKey: string;
};

export type ResultActionRegistry = {
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

/** Wire-shape guard for the engine-derived descriptor. A malformed projection
 *  renders as unsupported and, critically, never becomes an allowlist or
 *  typed carrier the client trusts. Server admission re-derives it again. */
export const resolvedFilterDescriptor = (
  section: RenderedOutputSection,
): ResolvedFilterDescriptor | null =>
  isResolvedFilterDescriptor(section.filter) ? section.filter : null;

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
const RESULT_ACTION_RESERVED_CONTEXT_KEYS = new Set(['event', 'server', 'recipe', 'tabs', 'caller']);

export const createResultActionRegistry = (
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

export const resultOutputSections = (
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

/** Every editable-table section in a result, resolved once for whichever host
 *  embeds the shared panel. The descriptor guard and key construction belong
 *  here so Recipes, Packs, and future result hosts cannot drift on what counts
 *  as an editable grid. */
export interface ResultTableEdit {
  key: string;
  descriptor: ResolvedTableEditDescriptor;
  data: unknown;
}

export const resultTableEdits = (
  result: ServerExecuteResponse,
  recipeId = result.recipe_id,
): ResultTableEdit[] => resultOutputSections(result).flatMap((section) => {
  if (section.type !== 'table' || !isResolvedTableEditDescriptor(section.table_edit)) {
    return [];
  }
  return [{
    key: gridKey(recipeId, section.table_edit),
    descriptor: section.table_edit,
    data: section.data,
  }];
});

export const findResultTableEdit = (
  result: ServerExecuteResponse,
  key: string,
  recipeId = result.recipe_id,
): ResultTableEdit | null =>
  resultTableEdits(result, recipeId).find((edit) => edit.key === key) ?? null;

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
  return formatClientDateTime(value, { invalidText: '—' });
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
    case 'filter':
      return 'Filter';
    case 'record_fields':
      return 'Record';
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

/** Stable per-section key, same shape the filter uses. */
export const gridKey = (recipeId: string, d: { section_index: number }): string =>
  `${recipeId}#grid-${String(d.section_index)}`;

/** Stable picker id shared by the pure renderer and the DOM host adapter. */
export const gridRefPickerId = (
  recipeId: string,
  descriptor: { section_index: number },
  address: string,
): string => `${gridKey(recipeId, descriptor)}-ref-${address}`;

/** One drawn column, however it was derived. Named so the schema-derived and
 *  hand-authored branches produce ONE shape — the grid reads `control` and
 *  `numeric` without caring which branch supplied the column. */
interface ResultTableColumn {
  field: string;
  label: string;
  /** Declared schema kind, where the column came from a schema. Drives the
   *  editor an editable cell gets — from the DECLARATION, never the runtime
   *  value, same as `numeric` beside it. Absent on a hand-written column, which
   *  declares no kinds. */
  kind: string | undefined;
  numeric: boolean;
  type: 'text' | 'action';
  format: string | undefined;
  control: TableColumnControl | undefined;
  options: readonly string[] | undefined;
  /** For a ref column — the entity it points at, so an editable cell is a
   *  picker. ⚠ This local type is a NARROWER COPY of `ResolvedRecordColumn`,
   *  and a field missing here is a field the panel cannot draw however well the
   *  contract carries it. */
  references: string | undefined;
}

const renderTableResultSection = (
  section: RenderedOutputSection,
  registry: ResultActionRegistry,
  dedupeRows = false,
  recipeId = '',
  gridStates: ReadonlyMap<string, OutputTableEditState> = new Map(),
  recordRefPickers = false,
): string => {
  const data = asRecord(section.data);
  // The editable grid — cells become inputs and the rows submit as ONE
  // declared variable. Absent, everything below is the read-only table.
  const editDescriptor = isResolvedTableEditDescriptor(section.table_edit)
    ? section.table_edit : null;
  const editable = new Set(editDescriptor?.editable ?? []);
  // ⛔ An entity-derived table resolves its columns host-side, so the block may
  // point `source` straight at the data — a bare array or a Records
  // `{ records }` — with no `to_table` step to carry `{ columns, rows }`.
  const derivedColumns = isResolvedRecordColumnsDescriptor(section.record_columns)
    && section.record_columns.columns.length > 0
    ? section.record_columns.columns.map((column): ResultTableColumn => ({
        field: column.field,
        label: column.label,
        type: 'text' as const,
        format: column.format,
        // ⛔ The schema knows which entity a ref points at, and this is the only
        // path that carries it to the cell. Dropped here, an editable ref
        // column renders as a box you type `tag/alice` into.
        references: column.references,
        // Quantities read right-aligned so the decimal points line up. Derived
        // from the declared KIND — money is a `decimal` slot returned as the
        // STRING "1200.0000", so a runtime typeof test left-aligns every
        // amount in a ledger.
        kind: column.kind,
        numeric: NUMERIC_FIELD_KINDS.has(column.kind),
        // An authored column may say HOW an editable cell accepts input. It is
        // presentation only — the grid ships strings either way, and the recipe
        // and store are what refuse a value that is not a real choice.
        control: column.control,
        options: column.options,
      }))
    : undefined;
  const authoredColumns = (Array.isArray(data?.columns) ? data.columns : [])
    .map((column): ResultTableColumn | null => {
      if (typeof column === 'string') {
        return {
          field: column,
          label: column,
          kind: undefined,
          numeric: false,
          type: 'text' as const,
          format: undefined,
          control: undefined,
          options: undefined,
          // A hand-written column declares no kinds, so it names no entity —
          // and a picker over nothing is worse than a text box.
          references: undefined,
        };
      }
      const row = asRecord(column);
      if (row === null || typeof row.field !== 'string') return null;
      return {
        field: row.field,
        label: typeof row.label === 'string' ? row.label : row.field,
        kind: undefined,
        numeric: false,
        type: row.type === 'action' ? 'action' as const : 'text' as const,
        format: typeof row.format === 'string' ? row.format : undefined,
        control: undefined,
        options: undefined,
        references: undefined,
      };
    })
    .filter((column): column is ResultTableColumn => column !== null);
  // The schema supplies the DATA columns; the author still supplies the ACTION
  // one — nothing in an entity schema declares "Open this row", so deriving
  // columns must not drop the row actions a list depends on.
  // A no-entity composing grid is allowed to start from a bare empty array. In
  // that useful case the resolved edit descriptor is the only surviving source
  // of column names; falling back to it keeps an empty collection form usable
  // without forcing an otherwise-pointless `to_table` step just for headings.
  const descriptorColumns = editDescriptor === null ? []
    : [...editDescriptor.carry, ...editDescriptor.editable].map(
        (field): ResultTableColumn => ({
          field,
          label: field.replace(/_/g, ' ').replace(/^./, (char) => char.toUpperCase()),
          kind: undefined,
          numeric: false,
          type: 'text',
          format: undefined,
          control: undefined,
          options: undefined,
          references: undefined,
        }),
      );
  const columns = derivedColumns === undefined
    ? authoredColumns.length > 0 ? authoredColumns : descriptorColumns
    : [...derivedColumns, ...authoredColumns.filter((column) => column.type === 'action')];
  const rawRows = Array.isArray(data?.rows) ? data.rows
    : Array.isArray(section.data) ? section.data
      : Array.isArray(data?.records) ? data.records : [];
  // Dedupe is a read-only paging affordance. An editable grid must preserve a
  // one-to-one row/index mapping between what is shown, what the host edits and
  // what is submitted; collapsing only the rendered copy breaks that mapping.
  const rows = dedupeRows && editDescriptor === null
    ? dedupeOutputRowsById(rawRows) : rawRows;
  const editState = editDescriptor === null ? null
    : gridStates.get(gridKey(recipeId, editDescriptor))
      ?? initialTableEditState(editDescriptor, rawRows);
  const displayRows = editDescriptor?.rows === 'add_remove' && editState !== null
    ? editState.rows : rows;
  const canCompose = editDescriptor?.rows === 'add_remove' && editState !== null;
  if (columns.length === 0 || (displayRows.length === 0 && !canCompose)) {
    return '<p class="recipes-detail-note">No rows returned.</p>';
  }
  const gridControls = editDescriptor === null || editState === null ? '' : `
    <div class="recipes-result-grid-footer">
      <span class="recipes-result-grid-status" aria-live="polite"
        data-dirty="${String(editState.dirty)}">${e(tableEditStatus(editState))}</span>
      <div class="recipes-result-actions">
        ${editDescriptor.rows === 'add_remove' ? `<button type="button" class="recipes-button"
          ${RECIPES_ROUTE_ACTION_ATTR}="result-grid-add"
          ${RECIPES_ROUTE_RESULT_GRID_ATTR}="${e(gridKey(recipeId, editDescriptor))}"${
    editState.busy ? ' disabled' : ''}>Add a row</button>` : ''}
        <button type="button" class="recipes-button recipes-button--primary"
          ${RECIPES_ROUTE_ACTION_ATTR}="result-grid-submit"
          ${RECIPES_ROUTE_RESULT_GRID_ATTR}="${e(gridKey(recipeId, editDescriptor))}"${
    canSubmitTableEdit(editState)
      ? ''
      : editState.busy
        ? ' aria-disabled="true" aria-busy="true"'
        : ' aria-disabled="true" tabindex="-1"'}>${e(
      editState.busy ? 'Saving…' : editDescriptor.submit)}</button>
      </div>
    </div>
    ${editState.error === null ? '' : `<p role="alert" class="recipes-result-file-error">${e(editState.error)}</p>`}`;

  const table = `
    <div class="recipes-result-table-wrap">
      <table class="recipes-result-table">
        <thead>
          <tr>${columns.map((column) =>
            `<th${column.numeric ? ' class="is-numeric"' : ''}>${e(column.label)}</th>`).join('')}${
    canCompose ? '<th class="recipes-result-grid-row-actions">Row</th>' : ''}</tr>
        </thead>
        <tbody>
          ${displayRows.length === 0
    ? `<tr><td class="recipes-result-grid-empty" colspan="${String(columns.length + 1)}">
        No rows yet. Add a row to get started.
      </td></tr>`
    : displayRows.map((row, rowIndex) => `
            <tr ${RECIPES_ROUTE_RESULT_GRID_ROW_ATTR}="${String(rowIndex)}">
              ${columns.map((column) => {
                const cell = getPathValue(row, column.field);
                if (editState !== null && editable.has(column.field)) {
                  // A cell the owner may type into. The value comes from the
                  // GRID state, not from the row — an edit survives a re-render
                  // that has not been submitted yet.
                  const typed = editState.rows[rowIndex]?.[column.field] ?? '';
                  const address = e(tableEditCellAddress(rowIndex, column.field));
                  const disabled = editState.busy ? ' disabled' : '';
                  const options = column.options ?? [];
                  if (column.control === 'select' && options.length > 0) {
                    // A blank first choice so an untouched cell stays untouched
                    // — without it the grid would assert the first option for
                    // every row the owner never looked at.
                    return `<td class="is-editable"><select class="input recipes-result-grid-cell"
                      ${RECIPES_ROUTE_RESULT_GRID_CELL_ATTR}="${address}"
                      aria-label="${e(column.label)}"${disabled}>${
                      [...(options.includes(typed) ? [] : ['']), ...options].map((option) =>
                        `<option value="${e(option)}"${option === typed ? ' selected' : ''}>${
                          option === '' ? '—' : e(option)}</option>`).join('')}</select></td>`;
                  }
                  if (column.control === 'radio' && options.length > 0) {
                    return `<td class="is-editable"><span class="recipes-result-grid-radios" role="radiogroup"
                      aria-label="${e(column.label)}">${options.map((option, optionIndex) =>
                      `<label class="recipes-result-grid-radio"><input type="radio"
                        class="recipes-result-grid-cell"
                        ${RECIPES_ROUTE_RESULT_GRID_CELL_ATTR}="${address}"
                        name="${e(gridKey(recipeId, editDescriptor!))}:${address}"
                        value="${e(option)}"${option === typed ? ' checked' : ''}${disabled}
                        id="${e(gridKey(recipeId, editDescriptor!))}-${address}-${optionIndex}"
                        />${e(option)}</label>`).join('')}</span></td>`;
                  }
                  if (column.control === 'textarea') {
                    return `<td class="is-editable"><textarea class="input recipes-result-grid-cell" rows="2"
                      ${RECIPES_ROUTE_RESULT_GRID_CELL_ATTR}="${address}"
                      aria-label="${e(column.label)}"${disabled}>${e(typed)}</textarea></td>`;
                  }
                  // The editor comes from the DECLARED kind — a date slot gets a
                  // date picker, an amount a numeric field — so a pack gets a
                  // usable grid without every recipe authoring `control`.
                  const inputType = tableColumnInputType(
                    { kind: column.kind ?? 'string', control: column.control,
                      ...(column.references === undefined
                        ? {} : { references: column.references }) });
                  // ⛔ A REF CELL IS A PICKER. `tableColumnInputType` returns
                  // null for one, and the cell carries the entity (and any
                  // scope) so a host attaches the same chooser a `record_ref`
                  // variable gets. Falling back to a text box here is how the
                  // owner ends up typing `tag/alice` into a grid.
                  //
                  // ⚠ It still renders as an input, so a host that wires no
                  // picker degrades to typing rather than to nothing — the
                  // value and the change handler are identical either way.
                  const cellScope = editDescriptor?.scopes?.[column.field];
                  if (
                    inputType === null
                    && column.references !== undefined
                    && recordRefPickers
                  ) {
                    const selected = typed === '' ? null : { id: typed, label: typed };
                    const pickerId = gridRefPickerId(
                      recipeId,
                      editDescriptor!,
                      tableEditCellAddress(rowIndex, column.field),
                    );
                    const scopeAttr = cellScope === undefined ? ''
                      : ` ${RECORD_REF_CELL_FILTER_ATTR}="${e(JSON.stringify(cellScope))}"`;
                    return `<td class="is-editable"><div class="recipes-result-grid-ref${
                      editState.busy ? ' is-disabled' : ''}"
                      ${RECIPES_ROUTE_RESULT_GRID_CELL_ATTR}="${address}"
                      ${RECORD_REF_CELL_ATTR}="${address}"
                      ${RECORD_REF_CELL_ENTITY_ATTR}="${e(column.references)}"${scopeAttr}
                      aria-disabled="${String(editState.busy)}"${
    editState.busy ? ' inert' : ''}>${RefPicker.renderRefPicker(
                      RefPicker.initialRefPickerState(selected),
                      {
                        pickerId,
                        placeholder: `Search ${column.references.replace(/_/g, ' ')}`,
                        ariaLabel: `Choose ${column.label}`,
                        emptyText: 'No matching records.',
                      },
                    )}</div></td>`;
                  }
                  const refCell = inputType === null && column.references !== undefined
                    ? ` ${RECORD_REF_CELL_ATTR}="${e(address)}"`
                      + ` ${RECORD_REF_CELL_ENTITY_ATTR}="${e(column.references)}"`
                      + (cellScope === undefined ? ''
                        : ` ${RECORD_REF_CELL_FILTER_ATTR}="${e(JSON.stringify(cellScope))}"`)
                    : '';
                  const drawnType = inputType ?? 'text';
                  return `<td class="is-editable${column.numeric ? ' is-numeric' : ''}"><input class="input recipes-result-grid-cell${
                    column.numeric ? ' is-numeric' : ''}" type="${drawnType}"${
                    drawnType === 'number' ? ' step="any"' : ''}
                    ${RECIPES_ROUTE_RESULT_GRID_CELL_ATTR}="${address}"${refCell}
                    value="${e(typed)}" aria-label="${e(column.label)}"${disabled} /></td>`;
                }
                return `<td${column.numeric ? ' class="is-numeric"' : ''}>${column.type === 'action'
                  ? renderResultActionControls(cell, registry)
                  : e(formatValue(cell, column.format))}</td>`;
              }).join('')}
              ${canCompose ? `<td class="recipes-result-grid-row-actions">
                <button type="button" class="recipes-button recipes-result-grid-remove"
                  ${RECIPES_ROUTE_ACTION_ATTR}="result-grid-remove"
                  ${RECIPES_ROUTE_RESULT_GRID_ATTR}="${e(gridKey(recipeId, editDescriptor!))}"
                  ${RECIPES_ROUTE_RESULT_GRID_ROW_ATTR}="${String(rowIndex)}"${
    editState?.busy ? ' disabled' : ''} aria-label="Remove row ${String(rowIndex + 1)}">Remove</button>
              </td>` : ''}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  if (editDescriptor === null || editState === null) return table;
  return `<div class="recipes-result-grid"
    ${RECIPES_ROUTE_RESULT_GRID_ATTR}="${e(gridKey(recipeId, editDescriptor))}">
    ${table}
    ${gridControls}
  </div>`;
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

const renderFilterResultSection = (
  section: RenderedOutputSection,
  recipeId: string,
  states: ReadonlyMap<string, RecipesResultFilterState>,
  /** An editable grid ELSEWHERE in this result has unsaved rows. Deliberately a
   *  boolean, not the grid map: the filter has no business knowing what a grid
   *  is — only that running would destroy work the owner has not committed. */
  gridsDirty = false,
): string => {
  const descriptor = resolvedFilterDescriptor(section);
  if (descriptor === null) {
    return '<p class="recipes-detail-note">This filter descriptor is invalid. Refresh and run the recipe again.</p>';
  }
  const key = outputFilterKey(recipeId, descriptor);
  const initial = initialOutputFilterState(descriptor);
  const state = states.get(key) ?? {
    ...initial,
    busy: false,
    busy_action: null,
    error: null,
  };
  const rows = descriptor.fields.map((field) => {
    const definition = descriptor.definitions[field];
    if (definition === undefined) return '';
    const value = Object.prototype.hasOwnProperty.call(state.draft_values, field)
      ? state.draft_values[field]
      : undefined;
    return renderVariableWidget(toWidgetShape(field, definition, value), {
      idPrefix: `result-filter-${descriptor.section_index}`,
    });
  }).join('');
  // ⛔⛔ Searching or paging re-runs the recipe, and a new result RESETS every
  // grid — so a sheet of typed amounts vanishes with no warning and no undo.
  // The filter already protects its OWN three fields from exactly this
  // (`state.dirty` below); the grid's loss is larger and had no guard at all.
  const pageDisabled = state.busy || state.dirty || gridsDirty;
  const searchDisabled = state.busy || gridsDirty;
  const actionAttributes = (
    action: RecipesResultFilterAction,
    disabled: boolean,
  ): string => state.busy && state.busy_action === action
    ? ' aria-disabled="true" aria-busy="true"'
    : disabled ? ' disabled' : '';
  const previous = descriptor.paging?.prev_cursor === undefined
    ? ''
    : `<button type="button" class="recipes-button"
        ${RECIPES_ROUTE_ACTION_ATTR}="result-filter-page:previous"
        ${RECIPES_ROUTE_RESULT_FILTER_ATTR}="${e(key)}"
        ${RECIPES_ROUTE_RESULT_FILTER_PAGE_ATTR}="previous"${actionAttributes(
    'previous', pageDisabled)}>${state.busy_action === 'previous'
    ? 'Loading previous page…' : 'Previous'}</button>`;
  const next = descriptor.paging?.next_cursor === undefined
    ? ''
    : `<button type="button" class="recipes-button"
        ${RECIPES_ROUTE_ACTION_ATTR}="result-filter-page:next"
        ${RECIPES_ROUTE_RESULT_FILTER_ATTR}="${e(key)}"
        ${RECIPES_ROUTE_RESULT_FILTER_PAGE_ATTR}="next"${actionAttributes(
    'next', pageDisabled)}>${state.busy_action === 'next'
    ? 'Loading next page…' : 'Next'}</button>`;
  const error = state.error === null
    ? ''
    : `<p role="alert" class="recipes-result-file-error"
        ${RECIPES_ROUTE_RESULT_FILTER_ERROR_ATTR}>${e(state.error)}</p>`;
  return `
    <form class="recipes-result-filter" ${RECIPES_ROUTE_RESULT_FILTER_ATTR}="${e(key)}"
      onsubmit="return false">
      <div class="run-modal-fields">${rows}</div>
      <div class="recipes-result-actions">
        <button type="button" class="recipes-button recipes-button--primary"
          ${RECIPES_ROUTE_ACTION_ATTR}="result-filter-search"
          ${RECIPES_ROUTE_RESULT_FILTER_ATTR}="${e(key)}"${actionAttributes(
    'search', searchDisabled)}>${e(
      state.busy_action === 'search' ? 'Running…' : descriptor.submit)}</button>
        ${previous}${next}
      </div>
      ${gridsDirty
        ? `<p class="recipes-detail-note" ${RECIPES_ROUTE_RESULT_FILTER_BLOCKED_ATTR}>
            Save the edited table first — searching or paging reloads the rows and
            would discard what you have typed.
          </p>`
        : state.dirty && (previous !== '' || next !== '')
          ? '<p class="recipes-detail-note">Run Search before paging with edited filters.</p>'
          : ''}
      ${error}
    </form>`;
};

const PLAIN_RESULT_SECTION_TYPES = new Set(['text']);

const renderUnsupportedResultSection = (section: RenderedOutputSection): string => `
  <p class="recipes-detail-note">Unsupported output section type: ${e(section.type)}</p>
  ${renderPlainResultSection(section)}
`;

export const renderRecipeResultSection = (
  section: RenderedOutputSection,
  registry: ResultActionRegistry,
  filterStates: ReadonlyMap<string, RecipesResultFilterState>,
  recipeId: string,
  dedupeRows: boolean,
  gridStates: ReadonlyMap<string, OutputTableEditState> = new Map(),
  gridsDirty = false,
  recordRefPickers = false,
): string => {
  const body =
    section.type === 'summary'
      ? renderSummaryResultSection(section)
      : section.type === 'table'
        ? renderTableResultSection(
            section,
            registry,
            dedupeRows,
            recipeId,
            gridStates,
            recordRefPickers,
          )
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
                  : section.type === 'filter'
                    ? renderFilterResultSection(section, recipeId, filterStates, gridsDirty)
                  // Schema-bound field list. Host-resolved and non-interactive,
                  // so it renders from the SAME shared block every other
                  // surface uses — this panel owning a second copy is how a new
                  // kind renders correctly on reception and as "unsupported"
                  // here. Label deliberately not passed: the card's <h3> above
                  // already prints it.
                  : section.type === 'record_fields'
                    ? renderRecordFieldsBlock(section.record_fields, { audience: 'owner' })
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
  if (origin === 'result-filter') return 'Result filter';
  if (origin === 'result-action') return 'Result action';
  if (origin === 'related-recipes') return 'Related recipes panel';
  return 'Recipe detail';
};

const renderResultRecipeIdentity = (
  installed: ReadonlyArray<ServerRecipeListEntry>,
  recipeId: string,
): string =>
  `${e(installedRecipeName(installed, recipeId))} (<code>${e(recipeId)}</code>)`;

export const renderRecipeResultPanel = (
  panel: RecipesResultPanelSnapshot | null,
  installed: ReadonlyArray<ServerRecipeListEntry>,
  registry: ResultActionRegistry,
  filterStates: ReadonlyMap<string, RecipesResultFilterState>,
  gridStates: ReadonlyMap<string, OutputTableEditState> = new Map(),
  recordRefPickers = false,
  presentation: RecipeResultPanelPresentation = {},
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
  const dedupeRows = sections.some((section) =>
    section.type === 'filter'
    && resolvedFilterDescriptor(section)?.paging !== undefined,
  );
  // Any grid in THIS result with uncommitted rows. Computed once here because
  // the hazard is cross-section: the filter is what re-runs, the table is what
  // loses. Neither block can see the other, so the panel that holds both says so.
  const gridsDirty = [...gridStates.values()].some((state) => state.dirty);
  const previousName = panel?.previous === undefined
    ? ''
    : installedRecipeName(installed, panel.previous.render_recipe_id);
  const returnControl = panel?.previous === undefined
    ? ''
    : `<button type="button" class="recipes-button"
        ${RECIPES_ROUTE_ACTION_ATTR}="restore-result-panel"
        ${RECIPES_ROUTE_RESULT_RETURN_ATTR}="${e(panel.previous.render_recipe_id)}">
        ${presentation.return_label === 'back'
          ? `Back to ${e(previousName)}`
          : `Return to ${e(previousName)} result`}
      </button>`;
  const body = result === null
    ? empty
    : resultTerminated(result)
      ? '<p class="recipes-detail-note">The run stopped before producing renderable output.</p>'
      : resultAwaitingApproval(result)
        ? '<p class="recipes-detail-note">This run is held for approval. No result output is rendered until the owner reruns or reviews the workflow.</p>'
        : sections.length > 0
          ? sections.map((section) => renderRecipeResultSection(
              section,
              registry,
              filterStates,
              panel!.render_recipe_id,
              dedupeRows,
              gridStates,
              gridsDirty,
              recordRefPickers,
            )).join('')
          : '<p class="recipes-detail-note">The run completed without renderable output.</p>';
  // ⛔⛔ Per-item failures inside a `foreach`. A foreach is continue-on-error, so
  // these never reach `errors[]` and never make `success` false — which is
  // correct (a partial write is not a failed run) and is exactly why a month
  // that refused EVERY receipt rendered identically to one that wrote them all.
  // The owner is the only one who can act on it, so it belongs beside the status
  // line, not in a log.
  const refused = result === null ? [] : (result.steps as ReadonlyArray<{
    id?: string; foreach?: { items: number; failed: number };
  }>).filter((step) => step.foreach !== undefined && step.foreach.failed > 0);
  const refusedNote = refused.length === 0
    ? ''
    : `<p class="recipes-result-refused" role="alert"
        ${RECIPES_ROUTE_RESULT_REFUSED_ATTR}="${refused.reduce((n, s) => n + s.foreach!.failed, 0)}">
        ${refused.map((step) => {
          const { items, failed } = step.foreach!;
          return `${e(String(failed))} of ${e(plural(items, 'item'))} in `
            + `<code>${e(step.id ?? '?')}</code> ${failed === items ? 'were all refused' : 'were refused'}`;
        }).join('; ')}. Nothing else in this run reports it — the step succeeded.
      </p>`;
  const provenance = panel === null || presentation.show_provenance === false
    ? ''
    : `<p class="recipes-result-provenance"
        ${RECIPES_ROUTE_RESULT_PROVENANCE_ATTR}="${e(panel.origin)}">
        <span><strong>Rendered recipe:</strong> ${renderResultRecipeIdentity(installed, panel.render_recipe_id)}</span>
        <span><strong>Origin:</strong> ${e(resultOriginLabel(panel.origin))}</span>
        <span><strong>Source recipe:</strong> ${panel.source_recipe_id === null
          ? 'None (related-list navigation)'
          : renderResultRecipeIdentity(installed, panel.source_recipe_id)}</span>
      </p>`;
  const heading = presentation.heading === null
    ? ''
    : `<h2 class="recipes-detail-section-title">${e(presentation.heading ?? 'Result')}</h2>`;
  const runMetrics = result === null || presentation.show_run_metrics === false
    ? ''
    : ` · ${e(String(result.duration_ms))} ms · ${e(plural(result.steps.length, 'step'))}`;
  return `
    <section class="recipes-detail-section recipes-result-panel" ${RECIPE_RESULT_HOST_ATTR}
      ${RECIPES_ROUTE_RESULT_PANEL_ATTR}="${panel === null ? '' : e(panel.render_recipe_id)}">
      ${heading}
      ${result !== null
        ? `<p class="recipes-result-status" role="status" aria-live="polite" aria-atomic="true">${e(status)}${renderName !== '' ? ` · ${e(renderName)}` : ''}${runMetrics}</p>`
        : ''}
      ${refusedNote}
      ${provenance}
      ${returnControl}
      ${body}
    </section>
  `;
};

// ══════════════════════════════════════════════════════════════════
// Authenticated file artifacts
// ══════════════════════════════════════════════════════════════════

/** What `data.file.read` returns. Declared here rather than imported from a
 *  route so both hosts describe the same wire shape. */
export interface ResultFileReadResult {
  record_id: string;
  bytes_b64: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
  blob_hash: string;
}

/** ⛔ THE FENCE. A file card claims a ref, a hash, a MIME type, a name and a
 *  size; this re-checks every one of them against what the authenticated read
 *  actually returned, and only then are bytes allowed anywhere near a Blob. It
 *  is shared so a second surface cannot open a file on weaker terms than the
 *  first — which is the whole reason the panel was extracted. */
export const exactResultFileReadError = (
  expected: ResultFileArtifact,
  actual: ResultFileReadResult,
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

export const triggerResultFileOpen = (
  doc: Document,
  objectUrls: Map<string, ReturnType<typeof globalThis.setTimeout>>,
  file: ResultFileReadResult,
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
      objectUrls.delete(url);
      view.URL?.revokeObjectURL(url);
    }, 60_000);
    objectUrls.set(url, timeout);
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
    objectUrls.delete(url);
    view.URL?.revokeObjectURL(url);
  }, 60_000);
  objectUrls.set(url, timeout);
};

/** Open the preview browsing context synchronously while the click still
 * has user activation. The later authenticated RPC can then navigate this
 * already-opened context to the verified blob URL without popup blocking. */
export const openResultPreviewWindow = (doc: Document): Window | null | undefined => {
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



// ══════════════════════════════════════════════════════════════════
// Filter submit / paging
// ══════════════════════════════════════════════════════════════════

/** The config a filter submit should run with, or a thrown reason it must not.
 *
 *  ⛔ THE FENCE IS THE DIRTY-GRID REFUSAL. A new result resets every editable
 *  grid, so searching or paging with unsaved rows would discard a sheet of
 *  typed data with no warning and no undo. It is refused HERE rather than
 *  merely disabled in the render, so a host that draws its own Search control
 *  hits the same wall the rendered one shows.
 *
 *  Pure: throws with the message to surface, or returns the config + the
 *  invocation proof the server admits the run under. */
export const resultFilterRunConfig = (
  descriptor: ResolvedFilterDescriptor,
  state: OutputFilterState,
  mode: 'search' | 'next' | 'previous',
  anyGridDirty: boolean,
): { config: Record<string, unknown>; invocation: ReturnType<typeof outputFilterInvocation> } | null => {
  if (anyGridDirty) {
    throw new Error(
      'Save the edited table first — searching or paging reloads the rows and '
      + 'would discard what you have typed.',
    );
  }
  if (mode === 'search') {
    const issues = validateOutputFilterDraft(descriptor, state);
    if (issues.length > 0) {
      throw new Error(issues.map((issue) => `${issue.key}: ${issue.message}`).join('; '));
    }
    return {
      config: outputFilterSearchConfig(descriptor, state),
      invocation: outputFilterInvocation(descriptor),
    };
  }
  const cursor = mode === 'next'
    ? descriptor.paging?.next_cursor
    : descriptor.paging?.prev_cursor;
  // No cursor in that direction — the control should not have been rendered;
  // null means "do nothing", distinct from a thrown refusal.
  if (cursor === undefined) return null;
  return {
    config: outputFilterPageConfig(descriptor, state, cursor),
    invocation: outputFilterInvocation(descriptor),
  };
};
