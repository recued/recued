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
  ResolvedTableSelectDescriptor,
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
  // The one reader of a column's path, shared with the reception table block
  // and the server's text output so the three cannot disagree again.
  tableFieldValue,
} from '@recued/renderer';
import {
  e,
  formatRecipeRunFacts,
  runFailureReason,
  canSubmitTableEdit,
  formatClientDateTime,
  initialTableEditState,
  isResolvedTableEditDescriptor,
  tableEditCellAddress,
  tableEditStatus,
  type OutputTableEditState,
  canSubmitTableSelect,
  initialTableSelectState,
  isResolvedTableSelectDescriptor,
  isTableRowSelected,
  tableSelectAllState,
  tableSelectRowId,
  tableSelectStatus,
  type OutputTableSelectState,
  dedupeOutputRowsById,
  initialOutputFilterState,
  isResolvedFilterDescriptor,
  missingPackRefsFromRunnability,
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
  REFERENCE_PROVENANCE_STYLES,
  RefPicker,
  renderProvenance,
  renderReferenceIdentity,
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
/** D-display-mode P5 — stamped when this panel is a screen rather than a pane.
 *  An ATTRIBUTE and not a class so the type scale below can key off it without
 *  competing with the class list the detail section already carries. */
export const RESULT_DISPLAY_MODE_ATTR = 'data-recued-display-mode';

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
${REFERENCE_PROVENANCE_STYLES}
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
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-reason {
  margin: 0;
  overflow-wrap: anywhere;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-receipt {
  display: grid;
  gap: 4px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-facts {
  margin: 0;
  font-size: 12px;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
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
/* A file_preview had NO RULE AT ALL, and the two UA defaults it inherited both
   hurt: a figure carries margin 1em 40px, which pushed the picture past the
   card's own border, and an img with no max-width renders at its natural size.
   A preview is 768px wide; a phone column is about 366px. Measured in real
   Chrome at a 390px viewport: the image overflowed the page and the photograph
   was cut off at the right edge.
   That is the ONE control the photo pack's safety rests on - a wrong face is
   caught by a person LOOKING at the picture, and half of it was off screen.
   Found by rendering it; no test asserts pixels. */
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-preview {
  margin: 0;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-preview img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
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
/* A grouped table stays ONE table — the group row is a heading inside the body,
   not a second table and not a column. It has to read as a break in the list
   even when the theme's borders are subtle, so it carries its own ground and a
   top rule, and it sticks under the header on a long board. */
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-group-row > th {
  background: var(--bg-subtle, var(--bg-elevated));
  border-top: 2px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--fg-default);
  font-weight: 700;
  letter-spacing: 0.01em;
  padding: 8px 6px;
  position: sticky;
  top: 0;
  text-align: left;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-table tbody tr:first-child > th {
  border-top: 0;
}
/* The count is secondary to the bucket name — same line, quieter, and tabular
   so a column of counts does not jitter as it re-renders. */
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-group-count {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  margin-inline-start: 6px;
}
/* ⛔ A fullscreened element gets the UA's own backdrop — black in every engine
   that ships one — so the panel must paint its own ground or a light theme
   inverts the moment it opens. It also stops being a child of the scrolling
   page, so it owns its scrolling and its padding from here. */
/* ⛔⛔ P5 — A SCREEN IS READ AT THREE TO FIVE METRES, A PANE AT FIFTY
   CENTIMETRES. Everything below is one decision applied consistently: roughly
   double the desk scale. Sizes are explicit rather than an em cascade because
   this panel's existing rules are in px, so a base-size change alone would
   scale the text and leave every padding, gap and rule where it was — type
   growing inside furniture that did not.

   ⛔ WHAT THIS DELIBERATELY DOES NOT DO: DROP COLUMNS. "How many columns survive
   at fifteen feet" is a real question and it is NOT the renderer's to answer —
   it cannot know which two of nine a glance needs, and guessing wrong hides the
   column somebody mounted the screen for. An author who wants fewer columns
   names fewer in to_table, or points the board at a recipe that does. The
   grouping heading is the one thing this can safely enlarge more than the rest,
   because on a grouped board it IS the primary content. */
[${RESULT_DISPLAY_MODE_ATTR}] .recipes-result-table {
  font-size: 26px;
}
[${RESULT_DISPLAY_MODE_ATTR}] .recipes-result-table th,
[${RESULT_DISPLAY_MODE_ATTR}] .recipes-result-table td {
  padding: 14px 12px;
}
[${RESULT_DISPLAY_MODE_ATTR}] .recipes-result-group-row > th {
  font-size: 32px;
  padding: 18px 12px;
}
[${RESULT_DISPLAY_MODE_ATTR}] .recipes-result-group-count {
  font-size: 26px;
}
/* The status line and provenance are desk furniture: still present for whoever
   walks up to the screen, never competing with the board for attention. */
[${RESULT_DISPLAY_MODE_ATTR}] .recipes-result-status,
[${RESULT_DISPLAY_MODE_ATTR}] .recipes-result-provenance {
  font-size: 15px;
  opacity: 0.75;
}
/* A board read from across a room scrolls on its own or not at all — a
   horizontal scrollbar nobody can reach is worse than a clipped column, so the
   wrap keeps its scroll but stops advertising it. */
[${RESULT_DISPLAY_MODE_ATTR}] .recipes-result-table-wrap {
  scrollbar-width: none;
}
[${RECIPE_RESULT_HOST_ATTR}]:fullscreen {
  background: var(--bg-default);
  color: var(--fg-default);
  overflow: auto;
  padding: 24px;
}
/* The toggle has to stay reachable once the page chrome is gone — it is the
   way back for anyone who did not reach for Escape. */
[${RECIPE_RESULT_HOST_ATTR}]:fullscreen .recipes-result-fullscreen-toggle {
  position: sticky;
  top: 0;
  z-index: 2;
}
/* More room means the board can breathe; the group headings stay sticky, so
   the bucket a row belongs to is readable however far down it sits. */
[${RECIPE_RESULT_HOST_ATTR}]:fullscreen .recipes-result-table th,
[${RECIPE_RESULT_HOST_ATTR}]:fullscreen .recipes-result-table td {
  padding: 10px 8px;
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
/* D-282 B6 — the selectable table. The count is emphasised for the same reason
   the grid emphasises "unsaved": it is the number the owner checks before
   pressing a button that acts on all of them.
   ⛔ NOTE THE [data-selected] PREFIX. A bare :not([data-selected="0"]) is TRUE when the
   attribute is absent, so it would bold every editable grid's status line too —
   a negation over an optional attribute matches the elements that do not have
   it at all. */
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-grid-status[data-selected]:not([data-selected="0"]) {
  color: var(--fg);
  font-weight: 600;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-select {
  display: grid;
  gap: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-select-cell {
  width: 1%;
  white-space: nowrap;
  text-align: center;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-result-select-cell input {
  /* A 44px row target on a phone without widening the column on a desktop. */
  width: 18px;
  height: 18px;
  margin: 4px;
  accent-color: var(--accent);
  cursor: pointer;
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
[${RECIPE_RESULT_HOST_ATTR}] .copyable-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
}
[${RECIPE_RESULT_HOST_ATTR}] .copyable-label {
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 650;
}
[${RECIPE_RESULT_HOST_ATTR}] .copyable-content pre {
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.45 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
[${RECIPE_RESULT_HOST_ATTR}] .copy-btn {
  box-sizing: border-box;
  appearance: none;
  min-height: 36px;
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
[${RECIPE_RESULT_HOST_ATTR}] .copy-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${RECIPE_RESULT_HOST_ATTR}] .link-button-block {
  display: grid;
  min-width: 0;
  gap: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .link-button {
  display: grid;
  min-width: 0;
  gap: 4px;
}
[${RECIPE_RESULT_HOST_ATTR}] .link-button-link {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  align-items: center;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-decoration: none;
  overflow-wrap: anywhere;
}
[${RECIPE_RESULT_HOST_ATTR}] .link-button-link:hover {
  border-color: var(--accent);
}
[${RECIPE_RESULT_HOST_ATTR}] .link-button-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${RECIPE_RESULT_HOST_ATTR}] .link-button-description {
  min-width: 0;
  margin: 0 2px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
[${RECIPE_RESULT_HOST_ATTR}] .json-block,
[${RECIPE_RESULT_HOST_ATTR}] .json-details {
  min-width: 0;
  max-width: 100%;
}
[${RECIPE_RESULT_HOST_ATTR}] .json-summary {
  box-sizing: border-box;
  min-height: 36px;
  padding: 9px 4px;
  color: var(--fg);
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
  cursor: pointer;
}
[${RECIPE_RESULT_HOST_ATTR}] .json-summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${RECIPE_RESULT_HOST_ATTR}] .json-content {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  margin: 6px 0 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.45 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
[${RECIPE_RESULT_HOST_ATTR}] .ai-block {
  display: grid;
  min-width: 0;
  gap: 7px;
  font-size: 12px;
}
[${RECIPE_RESULT_HOST_ATTR}] .ai-block p {
  min-width: 0;
  margin: 0;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
[${RECIPE_RESULT_HOST_ATTR}] .ai-row {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(90px, 140px) minmax(0, 1fr);
  gap: 8px;
}
[${RECIPE_RESULT_HOST_ATTR}] .ai-row > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
[${RECIPE_RESULT_HOST_ATTR}] .ai-label {
  color: var(--fg-muted);
  font-weight: 650;
}
[${RECIPE_RESULT_HOST_ATTR}] .ai-points {
  min-width: 0;
  margin: 0;
  padding-left: 20px;
  overflow-wrap: anywhere;
}
[${RECIPE_RESULT_HOST_ATTR}] .ai-json {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.45 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
/* Shared-block label/value list (\`packages/renderer\` summary + record_fields).
   This panel renders summary / table / checklist with its OWN
   \`recipes-result-*\` markup, but delegates record_fields to the shared block.
   These rules must therefore travel with the panel: route-scoped copies make
   the exact same output a readable grid in Recipes and browser-default dt/dd
   blocks in Packs. Reception carries its own copy in \`static-assets.ts\`. */
[${RECIPE_RESULT_HOST_ATTR}] .summary-list {
  min-width: 0;
  margin: 0;
}
[${RECIPE_RESULT_HOST_ATTR}] .summary-row {
  display: grid;
  grid-template-columns: minmax(100px, 180px) minmax(0, 1fr);
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
[${RECIPE_RESULT_HOST_ATTR}] .summary-row:last-child {
  border-bottom: none;
}
[${RECIPE_RESULT_HOST_ATTR}] .summary-row dt,
[${RECIPE_RESULT_HOST_ATTR}] .summary-row dd {
  min-width: 0;
}
[${RECIPE_RESULT_HOST_ATTR}] .summary-row dt {
  color: var(--fg-muted);
}
[${RECIPE_RESULT_HOST_ATTR}] .summary-row dd {
  margin: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${RECIPE_RESULT_HOST_ATTR}] .record-field-unset,
[${RECIPE_RESULT_HOST_ATTR}] .record-field-structured {
  color: var(--fg-muted);
  font-weight: 400;
  font-style: italic;
}
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
  min-width: 0;
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
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header > div {
  min-width: 0;
}
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header h4,
[${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header p {
  margin: 0;
  overflow-wrap: anywhere;
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
  max-width: 100%;
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
  [${RECIPE_RESULT_HOST_ATTR}] .summary-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  [${RECIPE_RESULT_HOST_ATTR}] .ai-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
@media (max-width: 520px) {
  [${RECIPE_RESULT_HOST_ATTR}] .copy-btn {
    min-height: 44px;
  }
  [${RECIPE_RESULT_HOST_ATTR}] .link-button-link {
    min-height: 44px;
    padding-block: 11px;
  }
  [${RECIPE_RESULT_HOST_ATTR}] .json-summary {
    min-height: 44px;
    padding-block: 13px;
  }
  [${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-header {
    display: grid;
  }
  [${RECIPE_RESULT_HOST_ATTR}] .recipes-file-artifact-badge {
    width: fit-content;
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
export const RECIPES_ROUTE_RESULT_FACTS_ATTR =
  'data-recued-recipes-result-facts';
/** Why a run returned errors: the first error's message and step (D-312). */
export const RECIPES_ROUTE_RESULT_REASON_ATTR =
  'data-recued-recipes-result-reason';
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
/** D-282 B6 — one selectable table, value = its section key. */
export const RECIPES_ROUTE_RESULT_SELECT_ATTR = 'data-recued-recipes-result-select';
/** The row id one checkbox submits. ⛔ The ID, not the row index: a re-render
 *  can reorder rows (a `group_by` bucket, a filter), and an index that meant
 *  row 3 before the repaint would tick a different record after it. */
export const RECIPES_ROUTE_RESULT_SELECT_ROW_ATTR =
  'data-recued-recipes-result-select-row';
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
 *  surface; Pack Use keeps the shared provenance receipt, hides legacy inline
 *  metrics, keeps audit-backed run facts, and supplies its own heading. */
export interface RecipeResultPanelPresentation {
  /** `undefined` = "Result" (Recipes default), `null` = no panel heading. */
  readonly heading?: string | null;
  /** Render recipe ids, origin, and source recipe. Default true. */
  readonly show_provenance?: boolean;
  /** Render duration and engine step count beside status. Default true. */
  readonly show_run_metrics?: boolean;
  /** Use concise app navigation copy instead of "Return to X result". */
  readonly return_label?: 'result' | 'back';
  /** D-display-mode P1 — this device keeps the board current on its own.
   *  `undefined` means the HOST DID NOT WIRE THE PREFS RPC, so no control is
   *  offered at all; `false` means wired and off. The three states are
   *  deliberate — a dead toggle is worse than an absent one. */
  readonly display_mode?: boolean;
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

/** Locate the interactive control emitted by the shared copyable renderer.
 * Every result host delegates clicks from its own stable root, so keeping the
 * selector here prevents Recipes and Pack apps from drifting into different
 * notions of which returned control is actionable. */
export const findRecipeResultCopyTarget = (
  target: EventTarget | null,
): HTMLElement | null => {
  if (target === null || typeof target !== 'object') return null;
  const candidate = target as HTMLElement;
  if (typeof candidate.closest !== 'function') return null;
  return candidate.closest('[data-action="copy"]');
};

/** Copy one returned value and keep the outcome on the focused control. */
export const copyRecipeResultValue = async (
  target: HTMLElement,
  doc: Document,
): Promise<void> => {
  const value = target.getAttribute('data-value');
  if (value === null) return;
  target.setAttribute('aria-live', 'polite');
  const clipboard = doc.defaultView?.navigator?.clipboard;
  if (clipboard?.writeText === undefined) {
    target.textContent = 'Recued cannot copy here';
    return;
  }
  try {
    await clipboard.writeText(value);
    target.textContent = 'Copied';
  } catch {
    target.textContent = 'Recued could not copy it';
  }
};

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
    return resultActionError('You cannot do this', 'Recued could not read what this does.');
  }
  const rawLabel = row.label;
  const label = typeof rawLabel === 'string' && rawLabel.trim().length > 0
    ? rawLabel.trim()
    : 'You cannot do this';
  if (row.kind !== 'recipe.run') {
    return resultActionError(label, 'You can only open things that run a Recipe.');
  }
  if (typeof rawLabel !== 'string' || rawLabel.trim().length === 0) {
    return resultActionError(label, 'This has no name.');
  }
  if (typeof row.recipe_id !== 'string' || row.recipe_id.trim().length === 0) {
    return resultActionError(label, 'Recued does not know which Recipe to run.');
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
        'The settings have to be a JSON object.',
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
        'The details have to be a JSON object.',
      );
    }
    context = parsedContext;
  }
  if (
    row.variant !== undefined
    && (typeof row.variant !== 'string' || !RESULT_ACTION_VARIANTS.has(row.variant))
  ) {
    return resultActionError(label, 'Recued does not know that kind.');
  }
  if (row.confirm !== undefined && typeof row.confirm !== 'string') {
    return resultActionError(label, 'The confirmation message has to be text.');
  }
  if (context !== undefined) {
    const reserved = Object.keys(context)
      .find((key) => RESULT_ACTION_RESERVED_CONTEXT_KEYS.has(key));
    if (reserved !== undefined) {
      return resultActionError(label, `You cannot use the name Recued keeps for itself: "${reserved}".`);
    }
  }
  if (registry.runnability === null) {
    return resultActionError(label, 'Recued cannot tell whether this can run.');
  }
  const targetRunnability = registry.runnability.get(recipeId);
  if (targetRunnability === undefined) {
    return resultActionError(label, 'Recued cannot tell whether that Recipe can run.');
  }
  if (targetRunnability?.status === 'blocked') {
    const missingPacks = missingPackRefsFromRunnability(targetRunnability);
    return resultActionError(
      label,
      missingPacks.length === 0
        ? 'That Recipe cannot run. It needs a provider you do not have.'
        : missingPacks.length === 1
          ? 'That Recipe needs a Pack you have not installed.'
          : 'That Recipe needs Packs you have not installed.',
    );
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

/** D-282 B6 — every selectable-table section in a result. Sibling of
 *  `resultTableEdits`, and here for the same reason: the descriptor guard and
 *  the key construction live in ONE place so Recipes, Packs and any later
 *  result host cannot drift on what counts as a selectable table. */
export interface ResultTableSelect {
  key: string;
  descriptor: ResolvedTableSelectDescriptor;
  data: unknown;
}

export const resultTableSelects = (
  result: ServerExecuteResponse,
  recipeId = result.recipe_id,
): ResultTableSelect[] => resultOutputSections(result).flatMap((section) => {
  if (section.type !== 'table' || !isResolvedTableSelectDescriptor(section.table_select)) {
    return [];
  }
  return [{
    key: selectKey(recipeId, section.table_select),
    descriptor: section.table_select,
    data: section.data,
  }];
});

export const findResultTableSelect = (
  result: ServerExecuteResponse,
  key: string,
  recipeId = result.recipe_id,
): ResultTableSelect | null =>
  resultTableSelects(result, recipeId).find((entry) => entry.key === key) ?? null;

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
  if (row === null) return { ok: false, reason: 'Recued could not read the file details.' };
  const recordId = readNonEmptyString(row.record_id);
  const filename = readNonEmptyString(row.filename);
  const mimeType = readNonEmptyString(row.mime_type);
  const sha256 = readNonEmptyString(row.sha256);
  const sizeBytes = readOptionalFiniteNumber(row.size_bytes);
  const generatedAt = readOptionalFiniteNumber(row.generated_at);
  if (recordId === undefined) return { ok: false, reason: 'Recued does not know which file.' };
  if (filename === undefined) return { ok: false, reason: 'The file has no name.' };
  if (mimeType === undefined) return { ok: false, reason: 'Recued does not know what kind of file it is.' };
  if (sha256 === undefined || !/^[a-f0-9]{64}$/.test(sha256)) {
    return { ok: false, reason: 'The file’s fingerprint is wrong.' };
  }
  if (sizeBytes === undefined || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, reason: 'The file size has to be a whole number above zero.' };
  }
  if (
    generatedAt === undefined
    || !Number.isSafeInteger(generatedAt)
    || generatedAt < 0
    || generatedAt > 8_640_000_000_000_000
  ) {
    return { ok: false, reason: 'The time it was made is not valid.' };
  }
  if (
    row.decision_actions !== undefined
    && (!Array.isArray(row.decision_actions) || row.decision_actions.length > 3)
  ) {
    return { ok: false, reason: 'Recued could not read what you can do with this file.' };
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
  return `${amountMinor.toLocaleString('en-US')} ${currency.toUpperCase()} in the smallest coins`;
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
      return 'What the AI found';
    case 'text':
      return 'Text';
    case 'button':
      return 'Actions';
    case 'file_artifact':
      return 'Files';
    case 'file_preview':
      return 'Preview';
    case 'link_button':
      return 'Links';
    case 'json':
      return 'Data';
    case 'filter':
      return 'Filter';
    case 'record_fields':
      return 'Record';
    default:
      return `Recued cannot show this: ${section.type}`;
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

/** One runnable action as its own button — the label visible, the variant applied. */
const resultActionButton = (
  action: RecipeOutputAction,
  registry: ResultActionRegistry,
): string => {
  const id = registerResultAction(registry, action);
  return `<button type="button" class="recipes-button${resultActionClass(action)}"
        ${RECIPES_ROUTE_ACTION_ATTR}="run-result-action"
        ${RECIPES_ROUTE_RESULT_ACTION_ATTR}="${e(id)}">${e(action.label)}</button>`;
};

/** How many runnable actions are drawn as buttons before the group collapses into a
 *  picker.
 *
 *  ⛔⛔ D-282 B1 — TWO ACTIONS USED TO COLLAPSE INTO A `<select>` + a generic "Run".
 *  One action rendered as a styled button honouring its `variant`; **two or more lost
 *  their labels, their variants and the one-press affordance**, at every call site —
 *  table cells, checklist items and the `button` block alike. It also contradicted the
 *  ruling that refused a row-of-buttons primitive, which rests on *"both renderers
 *  already lay it out horizontally (webclient flex row, shared renderer inline
 *  spans)"*: the shared renderer does, this one did not, and the flex container was
 *  already here (`.recipes-result-actions`).
 *
 *  🔑 THREE IS MEASURED, NOT CHOSEN. Across `community/recipes` there are 89 groups of
 *  one, 7 of two, 7 of three, and 4 larger (one 4, two 5, one 6). Three inline buttons
 *  fit a table cell; five do not, and the widest groups live in `button` blocks and
 *  table cells alike, so the picker stays for them rather than a per-caller threshold
 *  nobody can see from the recipe. */
const INLINE_RESULT_ACTION_LIMIT = 3;

const renderSingleResultAction = (
  validation: ResultActionValidation,
  registry: ResultActionRegistry,
): string => {
  if (!validation.ok) {
    return renderDisabledResultAction(validation.label, validation.reason);
  }
  return `
    <span class="recipes-result-actions">
      ${resultActionButton(validation.action, registry)}
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
  const runnable = validations
    .filter((validation): validation is { ok: true; action: RecipeOutputAction } => validation.ok);
  const refused = validations
    .filter((validation): validation is { ok: false; label: string; reason: string } => !validation.ok)
    .map((validation) =>
      `<span class="recipes-result-action-disabled">${e(validation.label)}: ${e(validation.reason)}</span>`)
    .join('');
  // ⚠ The REFUSED ones still show their reason either way — a group that is partly
  // invalid must say which half and why, not silently render the runnable remainder.
  if (runnable.length > 0 && runnable.length <= INLINE_RESULT_ACTION_LIMIT) {
    return `
    <span class="recipes-result-actions">
      ${runnable.map((validation) => resultActionButton(validation.action, registry)).join('\n      ')}
      ${refused}
    </span>
  `;
  }
  const groupId = `result-action-group-${registry.nextGroupId}`;
  registry.nextGroupId += 1;
  const options = runnable.map((validation) => {
    const id = registerResultAction(registry, validation.action);
    return `<option value="${e(id)}">${e(validation.action.label)}</option>`;
  });
  // ⚠ Every action refused: no control to draw, only the reasons. Reached when the
  // group is wider than the inline threshold OR nothing in it is runnable at all.
  if (options.length === 0) {
    return `<span class="recipes-result-actions">${refused}</span>`;
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
      ${refused}
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
      'Recued cannot tell which answer this belongs to.',
    );
  }
  if (actionSubmissionId !== submissionId || reviewedSha256 !== artifact.sha256) {
    return resultActionError(
      validation.action.label,
      'This does not match the answer and the file Recued has.',
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
      'This is not the exact thing Recued expected.',
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
      'This does not match the answer and the file Recued has.',
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
      'This is not one of the things you can do with a file.',
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
        ? 'Open or download the file first, then you can say yes.'
        : 'Open or download the file first, then you can decide.',
    );
  }
  if (busy) {
    return renderDisabledResultAction(
      actionValidation.action.label,
      'Recued is still checking the file.',
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
    ? 'This browser cannot show a signed-in file.'
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

/** D-274 — a `file_preview` block is drawn in TWO passes, because this panel
 *  builds HTML STRINGS and drawing a file needs a live element: decode, an
 *  object URL, `img.decode()`. So the string pass emits an empty MOUNT and the
 *  route's post-render pass fills it via the shared `renderFilePreviewBody` —
 *  the same function the modal viewer uses, so the two cannot drift.
 *
 *  ⚠ The fallback text inside the mount is what a reader sees if the second
 *  pass never runs (no preview caller wired, an older host). It says what the
 *  file is rather than showing an empty box, which is also what the
 *  non-browser renderer emits for the same block. */
export const RECIPES_FILE_PREVIEW_MOUNT_ATTR = 'data-recipe-file-preview';
export const RECIPES_FILE_PREVIEW_NAME_ATTR = 'data-recipe-file-preview-name';

const renderFilePreviewResultSection = (section: RenderedOutputSection): string => {
  const record = section.data !== null && typeof section.data === 'object' && !Array.isArray(section.data)
    ? section.data as Record<string, unknown>
    : null;
  const recordId = typeof record?.record_id === 'string' && record.record_id.trim() !== ''
    ? record.record_id.trim()
    : null;
  // D-274 — the LIVE shape: bytes the run just read from a file on disk, which
  // Recued never copied. Drawn from the result itself, so there is no second
  // fetch and nothing to go stale.
  const inline = typeof record?.bytes_b64 === 'string' && record.bytes_b64.length > 0
    && typeof record?.mime_type === 'string' && record.mime_type.startsWith('image/')
    ? { bytes_b64: record.bytes_b64, mime_type: record.mime_type }
    : null;
  if (recordId === null && inline === null) {
    return '<p class="recipes-detail-note">This file cannot be shown: the block carries no file.</p>';
  }
  const filename = typeof record?.filename === 'string' && record.filename.trim() !== ''
    ? record.filename.trim()
    : 'this file';
  if (inline !== null) {
    // ⚠ A data: URL rather than a mount, because there is nothing to fetch — the
    // bytes are already here. That also means it draws with no second pass, so
    // a host that never runs one still shows the picture.
    return `<figure class="recipes-file-preview">
    <img alt="${e(filename)}" src="data:${e(inline.mime_type)};base64,${e(inline.bytes_b64)}">
  </figure>`;
  }
  return `<figure class="recipes-file-preview"
    ${RECIPES_FILE_PREVIEW_MOUNT_ATTR}="${e(recordId as string)}"
    ${RECIPES_FILE_PREVIEW_NAME_ATTR}="${e(filename)}">
    <p class="recipes-detail-note">Loading ${e(filename)}…</p>
  </figure>`;
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

/** D-282 B6. A DIFFERENT prefix from `gridKey` on purpose: the two are mutually
 *  exclusive per section today (`table_select_with_edit`), and one shared key
 *  space would make a future relaxation collide silently. */
export const selectKey = (recipeId: string, d: { section_index: number }): string =>
  `${recipeId}#select-${String(d.section_index)}`;

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
  /** D-display-mode P3 (cheap form) — drop the action column on a screen.
   *
   *  ⛔ A UX GUARD, NOT A SECURITY BOUNDARY. It stops a passer-by's thumb and
   *  nothing more: the session is still the owner's and every op stays reachable
   *  from any other client. A screen in a lobby is safe because the device is
   *  PAIRED and physically controlled. Calling this protection would be
   *  assurance-shaped non-assurance.
   *
   *  ⚠ The PROPER form threads `RenderContext` — which already carries
   *  `interactive`, documented for exactly this — into this builder, so every
   *  block honours ONE flag instead of tables honouring a bespoke one. That is a
   *  7-call-site change and turns this SEVENTH positional parameter into the
   *  options object it has wanted since the sixth. Deferred deliberately; noted
   *  here so the next reader knows this is the cheap half, not the design. */
  suppressActions = false,
  /** D-282 B6 — per-section selection, keyed by `selectKey`.
   *
   *  ⚠ THE EIGHTH POSITIONAL PARAMETER, which makes the note above's case and
   *  does not act on it: the options-object refactor is a change to three
   *  signatures and their callers, and doing it inside a feature slice would
   *  bury the feature in it. Recorded, not excused. */
  selectStates: ReadonlyMap<string, OutputTableSelectState> = new Map(),
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
  const allColumns = derivedColumns === undefined
    ? authoredColumns.length > 0 ? authoredColumns : descriptorColumns
    : [...derivedColumns, ...authoredColumns.filter((column) => column.type === 'action')];
  // ⛔ DROPPED FROM THE COLUMN SET, never merely hidden: a cell that is rendered
  // and then covered is still in the DOM, still focusable by keyboard, and still
  // a button somebody can reach.
  const columns = suppressActions
    ? allColumns.filter((column) => column.type !== 'action')
    : allColumns;
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
  // D-282 B6 — pick rows, then act on the set.
  const selectDescriptor = isResolvedTableSelectDescriptor(section.table_select)
    ? section.table_select : null;
  const selectState = selectDescriptor === null ? null
    : selectStates.get(selectKey(recipeId, selectDescriptor))
      ?? initialTableSelectState(selectDescriptor, rawRows);
  // ⛔ The checkbox column exists only when the identity RESOLVED. An
  // unresolved descriptor draws the table read-only plus the reason — a
  // selectable-looking table that submits nothing is worse than a plain one.
  const selectable = selectDescriptor !== null
    && selectDescriptor.unresolved === undefined
    && selectState !== null;
  const displayRows = editDescriptor?.rows === 'add_remove' && editState !== null
    ? editState.rows : rows;
  const canCompose = editDescriptor?.rows === 'add_remove' && editState !== null;

  // ⛔ GROUPING REORDERS FOR DISPLAY ONLY, SO EVERY ROW KEEPS THE INDEX IT HAD.
  // `rowIndex` is the grid's cell address and the remove-button target;
  // renumbering by display position would aim both at the wrong row. The
  // validator already refuses `group_by` beside `table.edit`, and requiring a
  // null edit descriptor HERE as well means a path that somehow skips the
  // validator still cannot desynchronise them.
  //
  // ⚠ Bucket order is FIRST APPEARANCE, matching `packages/renderer`. Neither
  // surface can know that `missing` precedes `received`, so the only order that
  // is never wrong is the one the producing step chose; an author who wants a
  // sequence sorts in the recipe.
  const groupField = editDescriptor === null
    && typeof section.group_by === 'string' && section.group_by.trim() !== ''
    ? section.group_by.trim()
    : null;
  type ResultBodyEntry = {
    row: unknown; rowIndex: number; groupLabel?: string; groupCount?: number;
  };
  const bodyEntries: ResultBodyEntry[] = (() => {
    const flat: ResultBodyEntry[] = displayRows.map((row, rowIndex) => ({ row, rowIndex }));
    if (groupField === null) return flat;
    const UNGROUPED = '\u0000ungrouped';
    const buckets = new Map<string, ResultBodyEntry[]>();
    for (const entry of flat) {
      const raw = tableFieldValue(entry.row, groupField);
      const empty = raw === undefined || raw === null || String(raw).trim() === '';
      const key = empty ? UNGROUPED : String(raw);
      let bucket = buckets.get(key);
      if (bucket === undefined) { bucket = []; buckets.set(key, bucket); }
      bucket.push(entry);
    }
    // The no-value bucket trails; a row is never dropped for lacking the field.
    const order = [...buckets.keys()].filter((key) => key !== UNGROUPED);
    if (buckets.has(UNGROUPED)) order.push(UNGROUPED);
    const out: ResultBodyEntry[] = [];
    for (const key of order) {
      const rows = buckets.get(key) ?? [];
      out.push({
        row: null, rowIndex: -1,
        groupLabel: key === UNGROUPED ? '\u2014' : key,
        groupCount: rows.length,
      });
      out.push(...rows);
    }
    return out;
  })();
  // ⛔⛔ D-282 B3 — TWO SITUATIONS, ONE SENTENCE. "No rows returned." was returned both
  // for a table that could not be DRAWN (no columns anywhere) and for one that simply had
  // no rows, and a reader could not tell which they were looking at. The composing grid
  // forty lines below has always said the right thing — "No rows yet. Add a row to get
  // started." — so the good phrasing was already in this file, applied to one case.
  if (columns.length === 0) {
    return '<p class="recipes-detail-note">This table has no columns to draw:'
      + ' the recipe declared none and no entity schema supplied any.</p>';
  }
  if (displayRows.length === 0 && !canCompose) {
    // ⚠ The entity is NOT pluralised — `company` → "companys" and `person` → "persons"
    // are wrong, and the keys belong to the pack author. "records" is the plural.
    const entity = isResolvedRecordColumnsDescriptor(section.record_columns)
      ? section.record_columns.entity.replace(/[._]/g, ' ').trim()
      : '';
    return `<p class="recipes-detail-note">${
      entity === '' ? 'Nothing here yet.' : `No ${e(entity)} records yet.`
    }</p>`;
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
    <div class="recipes-result-table-wrap" data-recued-scroll-rail>
      <table class="recipes-result-table">
        <thead>
          <tr>${selectable ? `<th class="recipes-result-select-cell"><input type="checkbox"
            ${RECIPES_ROUTE_ACTION_ATTR}="result-select-toggle"
            ${RECIPES_ROUTE_RESULT_SELECT_ATTR}="${e(selectKey(recipeId, selectDescriptor!))}"
            ${RECIPES_ROUTE_RESULT_SELECT_ROW_ATTR}="*"
            aria-label="Select every row"${
    tableSelectAllState(selectState!) === 'all' ? ' checked' : ''}${
    tableSelectAllState(selectState!) === 'some' ? ' data-indeterminate="true"' : ''}${
    selectState!.busy || selectState!.selectable.length === 0 ? ' disabled' : ''} /></th>` : ''}${
    columns.map((column) =>
      `<th${column.numeric ? ' class="is-numeric"' : ''}>${e(column.label)}</th>`).join('')}${
    canCompose ? '<th class="recipes-result-grid-row-actions">Row</th>' : ''}</tr>
        </thead>
        <tbody>
          ${displayRows.length === 0
    ? `<tr><td class="recipes-result-grid-empty" colspan="${String(columns.length + 1)}">
        No rows yet. Add a row to get started.
      </td></tr>`
    : bodyEntries.map(({ row, rowIndex, groupLabel, groupCount }) => groupLabel !== undefined
      ? `<tr class="recipes-result-group-row"><th scope="rowgroup" colspan="${
        String(columns.length + (canCompose ? 1 : 0) + (selectable ? 1 : 0))}">${
        e(groupLabel)} <span
        class="recipes-result-group-count">${String(groupCount ?? 0)}</span></th></tr>`
      : `
            <tr ${RECIPES_ROUTE_RESULT_GRID_ROW_ATTR}="${String(rowIndex)}">
              ${!selectable ? '' : (() => {
        // ⛔ A ROW WITH NO ID GETS NO CHECKBOX — not a disabled one and not an
        // unchecked one. Either would read as "you may pick this", and what it
        // would submit is a blank the receiving `foreach` writes against
        // nothing while the run reports success.
        const id = tableSelectRowId(selectDescriptor!, row);
        if (id === null) return '<td class="recipes-result-select-cell"></td>';
        return `<td class="recipes-result-select-cell"><input type="checkbox"
                ${RECIPES_ROUTE_ACTION_ATTR}="result-select-toggle"
                ${RECIPES_ROUTE_RESULT_SELECT_ATTR}="${e(selectKey(recipeId, selectDescriptor!))}"
                ${RECIPES_ROUTE_RESULT_SELECT_ROW_ATTR}="${e(id)}"
                aria-label="Select ${e(id)}"${
          isTableRowSelected(selectState!, id) ? ' checked' : ''}${
          selectState!.busy ? ' disabled' : ''} /></td>`;
      })()}
              ${columns.map((column) => {
                const cell = tableFieldValue(row, column.field);
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
  // D-282 B6 — the action bar under a selectable table. The COUNT is in the
  // status line because the count is what an owner checks before pressing a
  // button that acts on all of them.
  if (selectDescriptor !== null) {
    if (selectDescriptor.unresolved !== undefined) {
      // ⛔ Named, not generic. "This table cannot be selected" would send
      // someone to reinstall a pack that is already installed; the cause is a
      // schema with no single identity column, which the AUTHOR fixes with
      // `select.id_field`.
      return `${table}
    <p class="recipes-detail-note">Rows here cannot be selected: this table's entity declares
     no single id column, so nothing says which record a tick means. The recipe can name one
     with <code>select.id_field</code>.</p>`;
    }
    const key = e(selectKey(recipeId, selectDescriptor));
    return `<div class="recipes-result-select" ${RECIPES_ROUTE_RESULT_SELECT_ATTR}="${key}">
    ${table}
    <div class="recipes-result-grid-footer">
      <span class="recipes-result-grid-status" aria-live="polite"
        data-selected="${String(selectState!.selected.length)}">${
      e(tableSelectStatus(selectState!))}</span>
      <div class="recipes-result-actions">
        <button type="button" class="recipes-button recipes-button--primary"
          ${RECIPES_ROUTE_ACTION_ATTR}="result-select-submit"
          ${RECIPES_ROUTE_RESULT_SELECT_ATTR}="${key}"${
      canSubmitTableSelect(selectState!)
        ? ''
        : selectState!.busy
          ? ' aria-disabled="true" aria-busy="true"'
          : ' aria-disabled="true" tabindex="-1"'}>${e(
      selectState!.busy ? 'Working…' : selectDescriptor.submit)}</button>
      </div>
    </div>
    ${selectState!.error === null ? '' : `<p role="alert" class="recipes-result-file-error">${
      e(selectState!.error)}</p>`}
  </div>`;
  }
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
  /** D-display-mode P3 — see `renderTableResultSection`'s note. */
  suppressActions = false,
  selectStates: ReadonlyMap<string, OutputTableSelectState> = new Map(),
): string => {
  // ⛔ D-292 — A TABLE WHOSE STEP WAS SKIPPED IS NOT A BROKEN TABLE. D-282 B3 split
  // "no columns" (a block error) from "no rows" (an empty state); a THIRD case sat
  // inside the first. `skip_when` on the producing `to_table` step leaves the section's
  // data `null`, which drew *"the recipe declared none and no entity schema supplied
  // any"* — false (the step declares its columns; it just did not run) — on every run
  // where the author meant the block to be absent: every clean import printed that note
  // twice ("unreadable cells", "refused rows"), and a check-only preview table skipped
  // on real imports made it three. Absent data with no entity to derive columns from
  // means the author chose not to show this block; honour it by drawing nothing.
  if (
    section.type === 'table'
    && (section.data === null || section.data === undefined)
    && !isResolvedRecordColumnsDescriptor(section.record_columns)
  ) {
    return '';
  }
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
            suppressActions,
            selectStates,
          )
        : section.type === 'checklist'
          ? renderChecklistResultSection(section, registry)
          : section.type === 'copyable'
            ? renderCopyableResultSection(section)
            : section.type === 'ai_analysis'
              ? renderAiAnalysisBlock(section.data)
              : section.type === 'button'
                ? renderResultActionControls(section.data, registry)
                : section.type === 'file_preview'
                  ? renderFilePreviewResultSection(section)
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
  renderReferenceIdentity({
    label: installedRecipeName(installed, recipeId),
    value: recipeId,
  });

export const renderRecipeResultPanel = (
  panel: RecipesResultPanelSnapshot | null,
  installed: ReadonlyArray<ServerRecipeListEntry>,
  registry: ResultActionRegistry,
  filterStates: ReadonlyMap<string, RecipesResultFilterState>,
  gridStates: ReadonlyMap<string, OutputTableEditState> = new Map(),
  recordRefPickers = false,
  presentation: RecipeResultPanelPresentation = {},
  selectStates: ReadonlyMap<string, OutputTableSelectState> = new Map(),
): string => {
  const renderName = panel === null
    ? ''
    : installedRecipeName(installed, panel.render_recipe_id);
  const empty = panel === null
    ? '<p class="recipes-detail-note">No current-session result yet. Run a Recipe to render its returned output here.</p>'
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
  // Only where the status says "Run returned errors": a hold and a terminated
  // run say what they are already.
  const failureReason = result !== null && status === 'Run returned errors'
    ? runFailureReason(result.errors)
    : null;
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
  // Offered only when there is output to enlarge. A fullscreen button above an
  // empty panel enlarges nothing, and the host module answers `unsupported`
  // anyway where the platform or an iframe refuses.
  // D-display-mode P1 — offered only where the host wired the prefs rpc, so a
  // surface without it shows no control rather than a dead one.
  const displayModeControl = presentation.display_mode === undefined
    ? ''
    : `<button type="button" class="recipes-button recipes-result-display-toggle"
        ${RECIPES_ROUTE_ACTION_ATTR}="toggle-result-display-mode"
        aria-pressed="${presentation.display_mode ? 'true' : 'false'}">${
    presentation.display_mode ? 'Stop updating' : 'Keep updating'}</button>`;
  const fullscreenControl = result === null || sections.length === 0
    ? ''
    : `<button type="button" class="recipes-button recipes-result-fullscreen-toggle"
        ${RECIPES_ROUTE_ACTION_ATTR}="toggle-result-fullscreen"
        aria-pressed="false">Fullscreen</button>`;
  const body = result === null
    ? empty
    : resultTerminated(result)
      ? '<p class="recipes-detail-note">The run stopped before producing renderable output.</p>'
      : resultAwaitingApproval(result)
        // The page follows the run (`held-run-follow.ts`): once the hold is
        // answered, the run's own result — or that it was declined — replaces this.
        ? '<p class="recipes-detail-note">This run is waiting for approval. Once it is approved, its result shows here.</p>'
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
              presentation.display_mode === true,
              selectStates,
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
        <span><strong>Origin:</strong> ${renderProvenance({
          primary: resultOriginLabel(panel.origin),
          kind: 'source',
        })}</span>
        <span><strong>Source recipe:</strong> ${panel.source_recipe_id === null
          ? 'None (related-list navigation)'
          : renderResultRecipeIdentity(installed, panel.source_recipe_id)}</span>
      </p>`;
  const heading = presentation.heading === null
    ? ''
    : `<h2 class="recipes-detail-section-title">${e(presentation.heading ?? 'Result')}</h2>`;
  const runFacts = result === null
    ? null
    : formatRecipeRunFacts(result.run_facts);
  const runMetrics = result === null
    || presentation.show_run_metrics === false
    || runFacts !== null
    ? ''
    : ` · ${e(String(result.duration_ms))} ms · ${e(plural(result.steps.length, 'step'))}`;
  return `
    <section class="recipes-detail-section recipes-result-panel" ${RECIPE_RESULT_HOST_ATTR}${
    presentation.display_mode === true ? ` ${RESULT_DISPLAY_MODE_ATTR}` : ''}
      ${RECIPES_ROUTE_RESULT_PANEL_ATTR}="${panel === null ? '' : e(panel.render_recipe_id)}">
      ${heading}
      ${result !== null
        ? `<div class="recipes-result-receipt" role="status" aria-live="polite" aria-atomic="true">
            <p class="recipes-result-status">${e(status)}${renderName !== '' ? ` · ${e(renderName)}` : ''}${runMetrics}</p>
            ${runFacts === null
              ? ''
              : `<p class="recipes-result-facts" ${RECIPES_ROUTE_RESULT_FACTS_ATTR}>${e(runFacts)}</p>`}
            ${failureReason === null
              ? ''
              : `<p class="recipes-result-reason" ${RECIPES_ROUTE_RESULT_REASON_ATTR}>${e(failureReason)}</p>`}
          </div>`
        : ''}
      ${refusedNote}
      ${provenance}
      ${returnControl}
      ${fullscreenControl}
      ${displayModeControl}
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
    return 'The file that came back is a different one.';
  }
  if (actual.blob_hash !== expected.sha256) {
    return 'The file that came back does not match the fingerprint you checked.';
  }
  if (actual.mime_type !== expected.mime_type) {
    return 'The file that came back is a different kind.';
  }
  if (actual.filename !== expected.filename) {
    return 'The file that came back has a different name.';
  }
  if (actual.size_bytes !== expected.size_bytes) {
    return 'The file that came back is a different size.';
  }
  if (typeof actual.bytes_b64 !== 'string' || actual.bytes_b64.length === 0) {
    return 'Nothing came back at all.';
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
    throw new Error('This browser cannot safely open the file.');
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
    throw new Error('The file is not the size it said it was.');
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
