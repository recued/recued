/** `#packs/<slug>` — the USE surface: an installed pack rendered as the small
 *  app it is, rather than as an inventory of its own permissions.
 *
 *      Rental Book                              [installed] [workflow]
 *      ┌ Use ─────────────────────┬ Manage ──────────────────────────┐
 *      │ Buildings  Contracts  Customers                             │
 *      │ ──────────                                                  │
 *      │ <the selected view's output, run live>                      │
 *      │                                                             │
 *      │ Add a building · Add a customer · Record a payment · …       │
 *      └─────────────────────────────────────────────────────────────┘
 *
 *  VIEWS are the pack's manual read-only rendering recipes, OPERATIONS are
 *  manual tasks, and AUTOMATIONS are trigger-driven recipes linked to their
 *  lifecycle controls. `pack-app-model.ts` derives the split and owns the
 *  reasoning about why a view is safe to run unprompted. This module is the
 *  surface over it.
 *
 *  ── Two things it deliberately does ───────────────────────────────
 *
 *  A view RUNS ON SELECTION. That is the whole difference between an app and a
 *  launcher: opening "Buildings" shows you buildings, it does not show you a
 *  button that shows you buildings. It is only defensible because the model
 *  proves the recipe read-only on two independent axes and fails closed
 *  otherwise — if that proof ever weakens, this auto-run is the thing that
 *  becomes unsafe, not the tab strip.
 *
 *  An operation's RESULT REPLACES THE LAUNCHER, then returning re-runs the open
 *  view after a successful write. Recording a payment therefore leaves its
 *  receipt visible for review and returns to a current contracts list — the
 *  whole business step stays inside the pack instead of disappearing into a
 *  modal status line.
 *
 *  ── Results render through the SHARED panel ───────────────────────
 *
 *  `recipe-result-panel.ts` — the same module the recipes route renders its
 *  results through. That is what makes a view's row actions real: pressing
 *  "Open" on a building row runs `show-building` with that row's id, and the
 *  descriptor was validated by the panel (installed? runnable? no reserved
 *  context keys?) before it ever became a button. ⛔ Do NOT reimplement any of
 *  that here — a second copy of the action validation is the split fence the
 *  renderer package's header warns about.
 *
 *  Row actions, the D-222 filter (search + paging) and verified file artifacts
 *  are all live here. This host owns only STATE and repainting; every decision
 *  that could be got wrong belongs to the shared panel:
 *   - `resultFilterRunConfig` — the dirty-grid refusal, draft validation and
 *     cursor selection, so a filter cannot be laxer here than on the recipes
 *     route.
 *   - `exactResultFileReadError` + `triggerResultFileOpen` — the ref / hash /
 *     MIME / name / size re-check, the PDF-only inline preview rule, and the
 *     decoded byte-length check.
 *  ⛔ If one of those needs to behave differently here, change the SHARED
 *  function and face both callers — do not branch around it.
 *
 *  Editable grids use that same shared-state/shared-renderer split: this host
 *  owns the map and execute call, while `@recued/ui-shared` owns row mutation,
 *  dirty/save transitions and submission shape. Filters receive the real dirty
 *  state, so paging cannot discard an in-progress sheet on this surface.
 */

import type {
  PackListEntry,
  RecipeInvocation,
  ResolvedTableEditDescriptor,
  ResolvedTableSelectDescriptor,
  ServerExecuteResponse,
  ServerRecipeListEntry,
} from '@recued/contracts';

// The ONE interactive result surface — the same code the recipes route renders
// its results through, so a row action here is validated by exactly the checks
// that guard it there.
import {
  RECIPES_ROUTE_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR,
  RECIPES_ROUTE_RESULT_FILE_ATTR,
  RECIPES_ROUTE_RESULT_FILE_MODE_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_ATTR,
  RECIPES_ROUTE_RESULT_GRID_ATTR,
  RECIPES_ROUTE_RESULT_GRID_ROW_ATTR,
  RECIPES_ROUTE_RESULT_SELECT_ATTR,
  RECIPES_ROUTE_RESULT_SELECT_ROW_ATTR,
  RECIPE_RESULT_HOST_ATTR,
  copyRecipeResultValue,
  createResultActionRegistry,
  exactResultFileReadError,
  findRecipeResultCopyTarget,
  findResultTableEdit,
  findResultTableSelect,
  openResultPreviewWindow,
  renderRecipeResultPanel,
  resolvedFilterDescriptor,
  resultFilterRunConfig,
  resultOutputSections,
  triggerResultFileOpen,
  type RecipeOutputAction,
  type RecipesResultPanelSnapshot,
  type RecipesResultFilterState,
  type ResultActionRegistry,
  type ResultFileReadResult,
} from '../recipes/recipe-result-panel.js';
import {
  addRow as gridAddRow,
  anyTableEditDirty,
  beginTableEditSubmit,
  canSubmitTableEdit,
  failTableEditSubmit,
  initialTableEditState,
  initialOutputFilterState,
  outputTableEditConfig,
  outputTableEditInvocation,
  outputFilterInvocation,
  outputFilterKey,
  outputFilterSearchConfig,
  readWidgetValue,
  RefPicker,
  renderReferenceLink,
  removeRow as gridRemoveRow,
  setCell as gridSetCell,
  setOutputFilterDraftValue,
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
} from '@recued/ui-shared';
import {
  captureResultFilterActionFocus,
  captureResultTableEditSubmitFocus,
  readResultTableEditCellInput,
  restoreResultFilterActionFocus,
  restoreResultTableEditSubmitFocus,
  syncResultTableEditChrome,
  wireResultTableEditRefPickers,
} from '../recipes/result-table-edit-host.js';

import { lookupTargetVariable } from './pack-app-model.js';
import type { LaterRunResult } from '../held-run-follow.js';
import type { PackAppRecipe, PackAppSurface } from './pack-app-model.js';
import { projectPackAppNavigation } from './pack-app-navigation.js';
import { serializeShellRoute } from '../shell/route.js';
import {
  PACK_INSTALL_OFFER_STYLES,
  missingPacksFromError,
  renderPackInstallOffer,
} from '../shell/pack-install-offer.js';
import {
  focusListTarget,
  readListScroll,
  restoreListScroll,
  type ListScrollPosition,
} from '../shell/list-preview-continuity.js';

export const PACK_APP_ATTR = 'data-recued-pack-app';
export const PACK_APP_VIEW_TAB_ATTR = 'data-recued-pack-app-view';
export const PACK_APP_VIEW_PANEL_ATTR = 'data-recued-pack-app-view-panel';
export const PACK_APP_OPERATION_ATTR = 'data-recued-pack-app-operation';
export const PACK_APP_AUTOMATION_ATTR = 'data-recued-pack-app-automation';
export const PACK_APP_RESULT_ATTR = 'data-recued-pack-app-result';
export const PACK_APP_STATUS_ATTR = 'data-recued-pack-app-status';
export const PACK_APP_MISSING_ATTR = 'data-recued-pack-app-missing';
export const PACK_APP_EMPTY_ATTR = 'data-recued-pack-app-empty';
export const PACK_APP_REFRESH_ATTR = 'data-recued-pack-app-refresh';
export const PACK_APP_CONTEXT_ATTR = 'data-recued-pack-app-context';

const PACK_APP_VIEW_PANEL_ID = 'recued-pack-app-view-panel';
const packAppViewTabDomId = (recipeId: string): string =>
  `recued-pack-app-view-tab-${encodeURIComponent(recipeId)}`;

/** Execute one recipe. Same shape as the recipes route's caller so a host that
 *  already wires that can pass the identical closure through. */
export type PackAppExecuteCaller = (args: {
  recipe_id: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  invocation?: RecipeInvocation;
}) => Promise<ServerExecuteResponse>;

export type PackAppRecordRefSearchCaller = (
  owner: { publisher: string; pack_slug: string },
  entity: string,
  scope?: Readonly<Record<string, string>>,
) => RefPicker.RefPickerSearchCaller;

export interface MountPackAppViewOptions {
  host: HTMLElement;
  document?: Document;
  /** Route-owned scroll container. Action results return to the exact browse
   *  position instead of only repainting the prior result. */
  scrollRoot?: HTMLElement;
  pack: PackListEntry;
  surface: PackAppSurface;
  /** Runs a view. Absent ⇒ views render as a "not available" note rather than
   *  as tabs that do nothing when pressed. */
  execute?: PackAppExecuteCaller;
  /** Opens the shared Run | Schedule modal for a manual operation. Absent ⇒
   *  manual action rows are omitted (a button with no modal behind it is worse
   *  than no button). Automation lifecycle links remain available. The host
   *  owns the modal so one modal-at-a-time stays true
   *  across the whole route.
   *
   *  `prefill` carries a row action's `config` / `context` — that is how "the
   *  list is the picker" works: pressing Open on a row opens the target recipe
   *  with the chosen id already filled. */
  openRunModal?: (
    entry: ServerRecipeListEntry,
    /** The returned result stays in this pack workspace. This is the lifecycle
     *  seam that turns a modal launcher into an app: run -> rendered receipt /
     *  detail -> return to the refreshed browse view.
     *
     *  `later` rides a result that arrives after the modal closed — a held run
     *  the owner has since approved — naming the result it replaces. */
    onRan?: (result: ServerExecuteResponse, later?: LaterRunResult) => void,
    prefill?: { config?: Record<string, unknown>; context?: Record<string, unknown> },
  ) => void;
  /** The full installed roster. The result panel validates every row action
   *  against it, so an action naming a recipe this server does not have renders
   *  disabled with the reason rather than as a button that fails on press. */
  installedRecipes?: readonly ServerRecipeListEntry[];
  /** `data.file.read` — the authenticated owner read behind a file card's
   *  preview / download. Absent ⇒ those controls render DISABLED with the
   *  reason, which is the panel's own degradation, not a silent dead button. */
  fileRead?: (args: { record_id: string }) => Promise<ResultFileReadResult>;
  /** Pack-owned Records inventory for ref-valued editable cells. Absent keeps
   *  those cells as pasteable ids; present upgrades them to the shared picker. */
  recordRefSearchCaller?: PackAppRecordRefSearchCaller;
  /** Which view to open on mount. Defaults to the first. */
  initialViewId?: string;
  /** D-282 B5 — the record a bookmarked LOOKUP address named
   *  (`#packs/<slug>/use/<lookup>/<target>`). Honoured only when
   *  `initialViewId` is a member of `surface.lookups` RIGHT NOW and that lookup
   *  binds a single variable; otherwise ignored entirely, leaving the first view
   *  open.
   *
   *  ⛔⛔ THE URL IS EVIDENCE OF INTENT, NEVER OF SAFETY. A pack version bump
   *  can move a recipe from lookup to operation, and a stale bookmark must not
   *  be able to run the operation it became. Membership in `surface.lookups` IS
   *  the re-derivation — the same two axes (`rendersReadingSurface` +
   *  `isProvablyReadOnly`) that decide whether a recipe may auto-run as a tab —
   *  so a hydrated address can never do more than a tab already does. */
  initialTarget?: string;
  /** Fired when the open view changes, so the host can reflect it in the hash. */
  onSelectView?: (recipe_id: string) => void;
  /** Fired when a lookup detail opens over the current view, and again with
   *  `null` when it closes. The host mirrors it in the hash, which is what makes
   *  a detail page a place rather than a transient result.
   *
   *  ⚠ LOOKUPS ONLY. An operation's result is never reported here: a URL that
   *  can replay a write is a URL that acts, and this is the boundary that keeps
   *  the address bar out of that business. */
  onOpenLookup?: (open: { readonly recipe_id: string; readonly target: string } | null) => void;
}

export interface PackAppViewMount {
  /** The open view's recipe id, or null when the pack has no views. */
  activeViewId(): string | null;
  /** D-282 B5 — the lookup address this mount ACCEPTED, or null.
   *
   *  🔑 THE HOST NEEDS THIS TO KNOW WHETHER TO CANONICALIZE. A deep link whose
   *  view id is not a tab is normally rewritten to the first view — correct for
   *  a stale tail, and fatal for a lookup address, which is never a tab by
   *  construction. Null here means the address was NOT honoured (gone, now an
   *  operation, or not expressible in one segment) and the host should rewrite
   *  it; non-null means the address is live and must be left alone. */
  hydratedLookup(): { readonly recipe_id: string; readonly target: string } | null;
  /** True while a run, result action, grid save, or file read still owns this
   *  view. Hosts use this to keep navigation from silently disposing it. */
  hasInFlightWork(): boolean;
  /** True while an editable result table contains work not yet saved. */
  hasUnsavedChanges(): boolean;
  /** Re-run the open view after an external refresh signal. In-workspace task
   *  results manage their own return-and-refresh lifecycle. */
  refresh(): void;
  /** Re-parent into a new host, preserving the open view and its rendered
   *  result.
   *
   *  The pack panel repaints wholesale on any controller event (its DD#5
   *  discipline), which replaces the tab panel this view was mounted into. Left
   *  alone, that would silently detach a view someone is reading, or — if the
   *  host remounted instead — re-run the recipe on every unrelated repaint.
   *  Moving the existing node is what makes the panel's repaint model and this
   *  view's run lifecycle coexist. No-op when already in `host`. */
  adopt(host: HTMLElement): void;
  dispose(): void;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;'
      : ch === '<' ? '&lt;'
        : ch === '>' ? '&gt;'
          : ch === '"' ? '&quot;'
            : '&#39;'
  ));

/** Keep at most one current-session result per recipe. Row actions can form a
 *  cycle (A -> B -> A); retaining every link would grow stale actionable
 *  history without bound. This is the same history rule as Recipes. */
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

export const mountPackAppView = (
  opts: MountPackAppViewOptions,
): PackAppViewMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountPackAppView: no document available — pass opts.document');
  }

  const { surface } = opts;
  const navigation = projectPackAppNavigation(
    opts.pack.slug,
    surface,
    opts.initialViewId,
  );
  const root = doc.createElement('div');
  root.setAttribute(PACK_APP_ATTR, opts.pack.slug);

  let activeViewId: string | null = navigation.activeViewId;
  /** D-282 B5 — a one-shot, set only at mount: the bookmarked lookup to open
   *  once the browse view behind it has finished loading. */
  let pendingHydration: (() => void) | null = null;
  let pendingViewTabFocus: string | null = null;
  /** Monotonic run token. A view switch during an in-flight run must not let
   *  the slower answer paint over the newer one — the classic stale-response
   *  overwrite, which here would show Customers under the Contracts tab. */
  let runToken = 0;
  let busy = false;
  let busyOwner: 'refresh' | null = null;
  let error: string | null = null;
  /** Packs a `pack_not_installed` run named — rendered as the shared offer in
   *  place of the bare message. Null for every other failure. */
  let missingPacks: readonly string[] | null = null;
  /** The currently displayed run, including the bounded return chain used when
   *  an action opens a detail/receipt over a browse view. */
  let resultPanel: RecipesResultPanelSnapshot | null = null;
  /** A successful write makes the cached browse result stale. Keep its receipt
   *  visible; refresh when the owner returns to the view. */
  let viewNeedsRefresh = false;
  let disposed = false;
  /** Registry for the CURRENTLY rendered result. Replaced on every paint —
   *  action ids are per-render, so holding an older one would resolve a button
   *  to a descriptor from a result no longer on screen. */
  let registry: ResultActionRegistry | null = null;

  // ── File-artifact state ───────────────────────────────────────────
  // Keyed by the panel's `stableKey`, which survives a re-render; the panel
  // reads all three back through the registry to render busy / error /
  // verified per card.
  let fileBusy: ReadonlySet<string> = new Set();
  let fileErrors: ReadonlyMap<string, string> = new Map();
  let fileVerified: ReadonlySet<string> = new Set();
  /** Bumped whenever the rendered result is replaced. An in-flight read that
   *  resolves after a view switch must not write busy/error state belonging to
   *  a result nobody is looking at any more. */
  let fileGeneration = 0;
  /** Blob URLs handed to a preview tab, with their revoke timers. Revoked on
   *  dispose so a torn-down view cannot leak the bytes it decoded. */
  const objectUrls = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

  // ── Filter + editable-table state ─────────────────────────────────
  let filterStates: ReadonlyMap<string, RecipesResultFilterState> = new Map();
  let gridStates: ReadonlyMap<string, OutputTableEditState> = new Map();
  /** D-282 B6 — per-table selection.
   *
   *  ⚠ Deliberately NOT part of the discard discipline beside it. A selection
   *  is three clicks to rebuild; typed cells are not. Gating navigation on it
   *  would put a confirm in front of every click that leaves a list. */
  let selectStates: ReadonlyMap<string, OutputTableSelectState> = new Map();
  let gridRefPickers: RefPicker.RefPickerHandle[] = [];
  const scrollRoot = opts.scrollRoot ?? opts.host;
  type ReturnFocus =
    | { readonly kind: 'result-action'; readonly id: string }
    | { readonly kind: 'result-action-group'; readonly id: string }
    | { readonly kind: 'operation'; readonly id: string };
  interface ReturnUiFrame {
    readonly previous: RecipesResultPanelSnapshot;
    readonly filters: ReadonlyMap<string, RecipesResultFilterState>;
    readonly focus: ReturnFocus | null;
    readonly scroll: ListScrollPosition;
  }
  /** Keyed by the detail panel that covers a prior list. Each frame owns only
   * the immediate return, so nested row actions restore one level at a time. */
  const returnUiFrames = new WeakMap<RecipesResultPanelSnapshot, ReturnUiFrame>();
  let pendingReturnFocus: ReturnFocus | null = null;
  let pendingReturnScroll: ListScrollPosition | null = null;

  const carryReturnFrame = (
    from: RecipesResultPanelSnapshot,
    to: RecipesResultPanelSnapshot,
  ): void => {
    const frame = returnUiFrames.get(from);
    if (frame !== undefined && to.previous === frame.previous) {
      returnUiFrames.set(to, frame);
    }
  };

  interface ViewRefreshResume {
    readonly config: Record<string, unknown>;
    readonly invocation: RecipeInvocation;
    readonly filters: ReadonlyMap<string, RecipesResultFilterState>;
  }

  /** A mutating row action must refresh its parent list, but an unfiltered
   * refresh would silently throw away the browse context. A rendered list has
   * one authoritative filter invocation; replay its last executed values on
   * page one, then re-apply any still-unsubmitted draft to the fresh controls. */
  const refreshResumeFor = (
    panel: RecipesResultPanelSnapshot,
    filters: ReadonlyMap<string, RecipesResultFilterState>,
  ): ViewRefreshResume | null => {
    const candidates = resultOutputSections(panel.result).flatMap((section) => {
      if (section.type !== 'filter') return [];
      const descriptor = resolvedFilterDescriptor(section);
      if (descriptor === null) return [];
      const key = outputFilterKey(panel.result.recipe_id, descriptor);
      const state = filters.get(key);
      return state === undefined ? [] : [{ descriptor, state }];
    });
    // More than one independent filter has no single honest invocation to
    // replay. Keep the refresh unfiltered in that uncommon ambiguous shape.
    if (candidates.length !== 1) return null;
    const [{ descriptor, state }] = candidates;
    return {
      config: outputFilterSearchConfig(descriptor, {
        executed_values: state.executed_values,
        draft_values: state.executed_values,
        dirty: false,
      }),
      invocation: outputFilterInvocation(descriptor),
      filters,
    };
  };

  const restoreCompatibleFilterDrafts = (
    saved: ReadonlyMap<string, RecipesResultFilterState>,
  ): void => {
    const next = new Map(filterStates);
    for (const [key, fresh] of next) {
      const previous = saved.get(key);
      if (previous === undefined) continue;
      next.set(key, {
        ...fresh,
        draft_values: { ...previous.draft_values },
        dirty: previous.dirty,
      });
    }
    filterStates = next;
  };

  const returnFocusFrom = (opener: HTMLElement | null | undefined): ReturnFocus | null => {
    if (opener === null || opener === undefined) return null;
    const action = opener.getAttribute(RECIPES_ROUTE_ACTION_ATTR);
    if (action === 'run-result-action') {
      const id = opener.getAttribute(RECIPES_ROUTE_RESULT_ACTION_ATTR);
      return id === null ? null : { kind: 'result-action', id };
    }
    if (action === 'run-selected-result-action') {
      const id = opener.getAttribute(RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR);
      return id === null ? null : { kind: 'result-action-group', id };
    }
    const operation = opener.getAttribute(PACK_APP_OPERATION_ATTR);
    return operation === null ? null : { kind: 'operation', id: operation };
  };

  const findReturnFocus = (focus: ReturnFocus | null): HTMLElement | null => {
    if (focus === null) return null;
    if (focus.kind === 'operation') {
      return Array.from(root.querySelectorAll?.(`[${PACK_APP_OPERATION_ATTR}]`) ?? [])
        .find((candidate) =>
          candidate.getAttribute(PACK_APP_OPERATION_ATTR) === focus.id,
        ) as HTMLElement | undefined ?? null;
    }
    const expectedAction = focus.kind === 'result-action'
      ? 'run-result-action'
      : 'run-selected-result-action';
    const keyAttribute = focus.kind === 'result-action'
      ? RECIPES_ROUTE_RESULT_ACTION_ATTR
      : RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR;
    return Array.from(root.querySelectorAll?.(`[${RECIPES_ROUTE_ACTION_ATTR}]`) ?? [])
      .find((candidate) =>
        candidate.getAttribute(RECIPES_ROUTE_ACTION_ATTR) === expectedAction
        && candidate.getAttribute(keyAttribute) === focus.id,
      ) as HTMLElement | undefined ?? null;
  };

  const hasInFlightWork = (): boolean =>
    busy
    || fileBusy.size > 0
    || [...filterStates.values()].some((state) => state.busy)
    || [...gridStates.values()].some((state) => state.busy)
    // ⛔ A bulk action IS in-flight work, even though a selection is not
    // "unsaved changes". Those are different questions: the first keeps the
    // host from disposing a view mid-write, the second asks whether discarding
    // costs the owner anything. A selection answers no to the second and YES
    // to the first while its run is out.
    || [...selectStates.values()].some((state) => state.busy);

  const currentResult = (): ServerExecuteResponse | null =>
    resultPanel?.result ?? null;

  /** Discard everything scoped to the OUTGOING result. Called wherever `result`
   *  is replaced — a stale filter draft or file error carried across would
   *  attach to whichever card happened to land in the same slot. */
  const resetResultScopedState = (next: ServerExecuteResponse | null): void => {
    const states = new Map<string, RecipesResultFilterState>();
    if (next !== null) {
      for (const section of resultOutputSections(next)) {
        if (section.type !== 'filter') continue;
        const descriptor = resolvedFilterDescriptor(section);
        if (descriptor === null) continue;
        states.set(outputFilterKey(next.recipe_id, descriptor), {
          ...initialOutputFilterState(descriptor),
          busy: false,
          busy_action: null,
          error: null,
        });
      }
    }
    filterStates = states;
    gridStates = new Map();
    selectStates = new Map();
    fileBusy = new Set();
    fileErrors = new Map();
    fileVerified = new Set();
    fileGeneration += 1;
  };

  /** The descriptor + live state behind one rendered filter form. */
  const activeFilter = (key: string): {
    descriptor: NonNullable<ReturnType<typeof resolvedFilterDescriptor>>;
    state: RecipesResultFilterState;
  } | null => {
    const result = currentResult();
    if (result === null) return null;
    for (const section of resultOutputSections(result)) {
      if (section.type !== 'filter') continue;
      const descriptor = resolvedFilterDescriptor(section);
      if (descriptor === null) continue;
      if (outputFilterKey(result.recipe_id, descriptor) !== key) continue;
      return {
        descriptor,
        state: filterStates.get(key)
          ?? {
            ...initialOutputFilterState(descriptor),
            busy: false,
            busy_action: null,
            error: null,
          },
      };
    }
    return null;
  };

  /** The descriptor + live state behind one rendered editable table. */
  const activeGrid = (key: string): {
    descriptor: ResolvedTableEditDescriptor;
    data: unknown;
    state: OutputTableEditState;
  } | null => {
    const result = currentResult();
    if (result === null) return null;
    const found = findResultTableEdit(result, key);
    if (found === null) return null;
    return {
      descriptor: found.descriptor,
      data: found.data,
      state: gridStates.get(key)
        ?? initialTableEditState(found.descriptor, found.data),
    };
  };

  /** The descriptor + live state behind one rendered selectable table. */
  const activeSelect = (key: string): {
    descriptor: ResolvedTableSelectDescriptor;
    state: OutputTableSelectState;
  } | null => {
    const result = currentResult();
    if (result === null) return null;
    const found = findResultTableSelect(result, key, result.recipe_id);
    if (found === null) return null;
    return {
      descriptor: found.descriptor,
      state: selectStates.get(key) ?? initialTableSelectState(found.descriptor, found.data),
    };
  };

  const errMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  const runActiveView = (
    owner: 'refresh' | null = null,
    resume: ViewRefreshResume | null = null,
  ): void => {
    const recipeId = activeViewId;
    const execute = opts.execute;
    if (recipeId === null || execute === undefined) return;
    runToken += 1;
    const token = runToken;
    busy = true;
    busyOwner = owner;
    error = null;
    missingPacks = null;
    paint();
    void execute({
      recipe_id: recipeId,
      config: resume?.config ?? {},
      ...(resume === null ? {} : { invocation: resume.invocation }),
    })
      .then((res) => {
        if (disposed || token !== runToken) return;
        resultPanel = {
          route_recipe_id: recipeId,
          source_recipe_id: recipeId,
          render_recipe_id: res.recipe_id,
          origin: 'recipe-detail',
          result: res,
        };
        viewNeedsRefresh = false;
        resetResultScopedState(res);
        if (resume !== null) restoreCompatibleFilterDrafts(resume.filters);
      })
      .catch((err: unknown) => {
        if (disposed || token !== runToken) return;
        resultPanel = null;
        resetResultScopedState(null);
        // A missing pack has an action attached, so it renders as the shared
        // offer; every other failure keeps the plain message.
        missingPacks = missingPacksFromError(err);
        error = errMessage(err);
      })
      .finally(() => {
        if (disposed || token !== runToken) return;
        busy = false;
        busyOwner = null;
        paint();
        // The browse view is loaded; a bookmarked detail may now stack on it.
        // Consumed in `finally` rather than `then` so a FAILED view still opens
        // the record the address asked for — the detail is the thing the person
        // followed a link to see.
        const hydrate = pendingHydration;
        pendingHydration = null;
        hydrate?.();
      });
  };

  /** Re-run the result that is actually on screen. A lookup/action may render
   *  a filter too; routing that filter through `activeViewId` would query the
   *  browse recipe and paint an unrelated answer under the receipt. */
  const runDisplayedResult = (
    filterKey: string,
    override: { config: Record<string, unknown>; invocation: RecipeInvocation },
  ): void => {
    const panelAtDispatch = resultPanel;
    const execute = opts.execute;
    if (panelAtDispatch === null || execute === undefined) return;
    runToken += 1;
    const token = runToken;
    paint();
    void execute({
      recipe_id: panelAtDispatch.render_recipe_id,
      config: override.config,
      invocation: override.invocation,
    })
      .then((res) => {
        if (disposed || token !== runToken || resultPanel !== panelAtDispatch) return;
        const previous = withoutRenderedRecipe(panelAtDispatch.previous, res.recipe_id);
        const nextPanel: RecipesResultPanelSnapshot = {
          route_recipe_id: panelAtDispatch.route_recipe_id,
          source_recipe_id: panelAtDispatch.render_recipe_id,
          render_recipe_id: res.recipe_id,
          origin: 'result-filter',
          result: res,
          ...(previous !== undefined ? { previous } : {}),
        };
        resultPanel = nextPanel;
        carryReturnFrame(panelAtDispatch, nextPanel);
        resetResultScopedState(res);
      })
      .catch((err: unknown) => {
        if (disposed || token !== runToken || resultPanel !== panelAtDispatch) return;
        const state = filterStates.get(filterKey);
        if (state !== undefined) {
          filterStates = new Map(filterStates).set(filterKey, {
            ...state,
            busy: false,
            busy_action: null,
            error: errMessage(err),
          });
        }
      })
      .finally(() => {
        if (disposed || token !== runToken) return;
        paint();
      });
  };

  /** Search / page a rendered filter.
   *
   *  The decision — dirty-grid refusal, draft validation, cursor selection —
   *  is `resultFilterRunConfig`, shared with the recipes route. This host only
   *  supplies state and repaints, which is why a filter cannot be laxer here
   *  than there. The real grid map is passed through, so a Use-tab search
   *  cannot reload and silently discard table edits. */
  const submitFilter = (key: string, mode: 'search' | 'next' | 'previous'): void => {
    const active = activeFilter(key);
    if (active === null || active.state.busy) return;
    if (opts.execute === undefined) {
      filterStates = new Map(filterStates).set(key, {
        ...active.state,
        busy: false,
        busy_action: null,
        error: 'This server cannot run things yet.',
      });
      paint();
      return;
    }
    let run: ReturnType<typeof resultFilterRunConfig>;
    try {
      run = resultFilterRunConfig(
        active.descriptor,
        active.state,
        mode,
        anyTableEditDirty(gridStates),
      );
    } catch (err) {
      filterStates = new Map(filterStates).set(key, {
        ...active.state, error: errMessage(err),
      });
      paint();
      return;
    }
    if (run === null) return; // no cursor that way — not an error
    filterStates = new Map(filterStates).set(key, {
      ...active.state, busy: true, busy_action: mode, error: null,
    });
    runDisplayedResult(key, { config: run.config, invocation: run.invocation });
  };

  const mutateGridRows = (
    key: string,
    update: (
      descriptor: ResolvedTableEditDescriptor,
      state: OutputTableEditState,
    ) => OutputTableEditState,
  ): void => {
    const active = activeGrid(key);
    if (active === null) return;
    const next = update(active.descriptor, active.state);
    if (next === active.state) return;
    gridStates = new Map(gridStates).set(key, next);
    paint();
  };

  /** Save one editable result table without turning the whole Use tab into a
   *  loading screen. The result identity + run token are both checked before a
   *  late response can replace a view the owner has since left. */
  const submitGrid = async (key: string): Promise<void> => {
    const execute = opts.execute;
    const active = activeGrid(key);
    const panelAtDispatch = resultPanel;
    if (
      execute === undefined
      || active === null
      || panelAtDispatch === null
      || !canSubmitTableEdit(active.state)
    ) return;

    runToken += 1;
    const token = runToken;
    gridStates = new Map(gridStates).set(key, beginTableEditSubmit(active.state));
    paint();
    try {
      const nextResult = await execute({
        recipe_id: panelAtDispatch.render_recipe_id,
        config: outputTableEditConfig(active.descriptor, active.state),
        invocation: outputTableEditInvocation(active.descriptor),
      });
      if (disposed || token !== runToken || resultPanel !== panelAtDispatch) return;
      const nextPanel: RecipesResultPanelSnapshot = {
        route_recipe_id: panelAtDispatch.route_recipe_id,
        source_recipe_id: panelAtDispatch.render_recipe_id,
        render_recipe_id: nextResult.recipe_id,
        origin: 'result-filter',
        result: nextResult,
        ...(panelAtDispatch.previous !== undefined
          ? { previous: panelAtDispatch.previous }
          : {}),
      };
      resultPanel = nextPanel;
      carryReturnFrame(panelAtDispatch, nextPanel);
      resetResultScopedState(nextResult);
      paint();
    } catch (err) {
      if (disposed || token !== runToken || resultPanel !== panelAtDispatch) return;
      gridStates = new Map(gridStates).set(
        key,
        failTableEditSubmit(active.state, errMessage(err)),
      );
      paint();
    }
  };

  /** D-282 B6 — act on the picked rows. One run, one array, one audit anchor.
   *
   *  ⛔ NOT N RUNS. Fanning out one execution per selected row from a UI
   *  control would produce N anchors, N approval asks and no transaction — and
   *  a partial failure would leave the owner reading a list of outcomes with no
   *  run to point at. The ids go up as ONE value under the declared variable
   *  and the recipe loops with `foreach`, which is the same shape the editable
   *  grid uses for the same reason.
   *
   *  ⚠ A `foreach` is continue-on-error, so a bulk action over a destructive op
   *  still asks the owner PER ITEM, and a per-item refusal never fails the run.
   *  That is the engine's rule, unchanged by selecting the rows in a table. */
  const submitSelection = async (key: string): Promise<void> => {
    const execute = opts.execute;
    const active = activeSelect(key);
    const panelAtDispatch = resultPanel;
    if (
      execute === undefined
      || active === null
      || panelAtDispatch === null
      || !canSubmitTableSelect(active.state)
    ) return;

    runToken += 1;
    const token = runToken;
    selectStates = new Map(selectStates).set(key, beginTableSelectSubmit(active.state));
    paint();
    try {
      const nextResult = await execute({
        recipe_id: panelAtDispatch.render_recipe_id,
        config: outputTableSelectConfig(active.descriptor, active.state),
        invocation: outputTableSelectInvocation(active.descriptor),
      });
      if (disposed || token !== runToken || resultPanel !== panelAtDispatch) return;
      const nextPanel: RecipesResultPanelSnapshot = {
        route_recipe_id: panelAtDispatch.route_recipe_id,
        source_recipe_id: panelAtDispatch.render_recipe_id,
        render_recipe_id: nextResult.recipe_id,
        origin: 'result-filter',
        result: nextResult,
        ...(panelAtDispatch.previous !== undefined
          ? { previous: panelAtDispatch.previous }
          : {}),
      };
      resultPanel = nextPanel;
      carryReturnFrame(panelAtDispatch, nextPanel);
      resetResultScopedState(nextResult);
      paint();
    } catch (err) {
      if (disposed || token !== runToken || resultPanel !== panelAtDispatch) return;
      // ⛔ The SELECTION SURVIVES a failure. The owner should read the reason
      // and press again, not re-tick five rows to find out whether the second
      // attempt behaves differently.
      selectStates = new Map(selectStates).set(
        key,
        failTableSelectSubmit(active.state, errMessage(err)),
      );
      paint();
    }
  };

  /** Open a verified file artifact.
   *
   *  ⛔ Every check belongs to the shared panel: the preview context is opened
   *  SYNCHRONOUSLY while the click still carries user activation (else the
   *  popup blocker eats it), `exactResultFileReadError` re-checks ref / hash /
   *  MIME / name / size against what the card claimed, and
   *  `triggerResultFileOpen` refuses a non-PDF inline preview and re-checks the
   *  decoded byte length. Nothing here re-decides any of that. */
  const openFile = (fileId: string | null, rawMode: string | null): void => {
    if (fileId === null || (rawMode !== 'preview' && rawMode !== 'download')) return;
    const fileRead = opts.fileRead;
    const registered = registry?.files.get(fileId);
    if (registered === undefined || fileRead === undefined) return;
    if (fileBusy.has(registered.stableKey)) return;

    const previewWindow = rawMode === 'preview' ? openResultPreviewWindow(doc) : undefined;
    if (previewWindow === null) {
      fileErrors = new Map(fileErrors).set(
        registered.stableKey,
        'Your browser blocked the PDF window. Allow pop-ups for this address, or download the file instead.',
      );
      paint();
      return;
    }
    const generationAtOpen = fileGeneration;
    fileBusy = new Set(fileBusy).add(registered.stableKey);
    const cleared = new Map(fileErrors);
    cleared.delete(registered.stableKey);
    fileErrors = cleared;
    paint();

    void fileRead({ record_id: registered.artifact.record_id })
      .then((file) => {
        if (disposed || generationAtOpen !== fileGeneration) {
          previewWindow?.close();
          return;
        }
        const mismatch = exactResultFileReadError(registered.artifact, file);
        if (mismatch !== null) throw new Error(mismatch);
        triggerResultFileOpen(doc, objectUrls, file, rawMode, previewWindow);
        fileVerified = new Set(fileVerified).add(registered.stableKey);
      })
      .catch((err: unknown) => {
        previewWindow?.close();
        if (disposed || generationAtOpen !== fileGeneration) return;
        const nextVerified = new Set(fileVerified);
        nextVerified.delete(registered.stableKey);
        fileVerified = nextVerified;
        fileErrors = new Map(fileErrors).set(registered.stableKey, errMessage(err));
      })
      .finally(() => {
        if (disposed || generationAtOpen !== fileGeneration) return;
        const nextBusy = new Set(fileBusy);
        nextBusy.delete(registered.stableKey);
        fileBusy = nextBusy;
        paint();
      });
  };

  const mayDiscardGridEdits = (): boolean => {
    if (!anyTableEditDirty(gridStates)) return true;
    const confirm = doc.defaultView?.confirm;
    return typeof confirm === 'function'
      && confirm.call(doc.defaultView, 'Throw away your unsaved changes to the table?');
  };

  const selectView = (recipeId: string, focusActivatedTab = false): void => {
    if (!navigation.nodes.some((node) => node.id === recipeId)) return;
    const alreadyShowingView = recipeId === activeViewId
      && resultPanel !== null
      && resultPanel.render_recipe_id === recipeId
      && resultPanel.origin !== 'result-action'
      && resultPanel.previous === undefined;
    if (alreadyShowingView) return;
    if ([...gridStates.values()].some((state) => state.busy)) return;
    if (!mayDiscardGridEdits()) return;
    if (focusActivatedTab) pendingViewTabFocus = recipeId;
    activeViewId = recipeId;
    resultPanel = null;
    viewNeedsRefresh = false;
    error = null;
    missingPacks = null;
    opts.onSelectView?.(recipeId);
    runActiveView();
  };

  const displayedRecipe = (): PackAppRecipe | null => {
    const id = resultPanel?.render_recipe_id ?? activeViewId;
    if (id === null) return null;
    const surfaceEntry = [...surface.views, ...surface.lookups, ...surface.operations]
      .find((entry) => entry.recipe_id === id);
    if (surfaceEntry !== undefined) return surfaceEntry;
    const installed = (opts.installedRecipes ?? []).find((entry) => entry.recipe_id === id);
    if (installed === undefined) return null;
    return {
      recipe_id: id,
      name: installed.recipe.metadata?.name?.trim() || id,
      description: installed.recipe.metadata?.description ?? '',
      entry: installed,
    };
  };

  const showingTaskResult = (): boolean => resultPanel !== null && (
    resultPanel.origin === 'result-action'
    || resultPanel.previous !== undefined
    || resultPanel.render_recipe_id !== activeViewId
  );

  const renderContext = (): string => {
    const recipe = displayedRecipe();
    if (recipe === null) return '';
    const taskResult = showingTaskResult();
    const refreshOwnsWork = busy && busyOwner === 'refresh';
    const refreshAttributes = refreshOwnsWork
      ? ' aria-disabled="true" aria-busy="true"'
      : hasInFlightWork() ? ' disabled' : '';
    const refreshLabel = refreshOwnsWork ? 'Refreshing…' : 'Refresh';
    const refresh = !taskResult && activeViewId !== null && opts.execute !== undefined
      ? `<button type="button" class="rx-btn rx-btn-secondary rx-btn-sm pack-app-refresh"
          ${PACK_APP_REFRESH_ATTR}=""${refreshAttributes}>${refreshLabel}</button>`
      : '';
    const stale = taskResult && viewNeedsRefresh
      ? '<p class="pack-app-context-status">Your browse view will refresh when you return.</p>'
      : '';
    return `<header class="pack-app-context" ${PACK_APP_CONTEXT_ATTR}="${taskResult ? 'task' : 'view'}">
      <div class="pack-app-context-copy">
        <p class="pack-app-context-kind">${taskResult ? 'What happened' : 'Current view'}</p>
        <h2 class="pack-app-context-title">${escapeHtml(recipe.name)}</h2>
        ${recipe.description === '' ? '' : `<p class="pack-app-context-description">${escapeHtml(recipe.description)}</p>`}
        ${stale}
      </div>
      ${refresh}
    </header>`;
  };

  const renderViewTabs = (): string => {
    if (navigation.nodes.length === 0) return '';
    const tabs = navigation.nodes.map((view) => `
      <button type="button" role="tab"
        class="pack-app-view-tab"
        id="${escapeHtml(packAppViewTabDomId(view.id))}"
        aria-controls="${PACK_APP_VIEW_PANEL_ID}"
        aria-selected="${view.id === activeViewId ? 'true' : 'false'}"
        tabindex="${view.id === activeViewId ? '0' : '-1'}"
        title="${escapeHtml(view.description)}"
        ${PACK_APP_VIEW_TAB_ATTR}="${escapeHtml(view.id)}">${escapeHtml(view.label)}</button>
    `).join('');
    return `<nav class="pack-app-views" role="tablist"
      aria-label="${escapeHtml(opts.pack.name)} views">${tabs}</nav>`;
  };

  const renderBody = (): string => {
    if (opts.execute === undefined) {
      return '<p class="pack-app-note">Running recipes is not available on this server yet.</p>';
    }
    if (busy) {
      return `<p class="pack-app-note" ${PACK_APP_STATUS_ATTR}="busy" role="status" aria-live="polite">Loading…</p>`;
    }
    if (missingPacks !== null) {
      return renderPackInstallOffer(missingPacks);
    }
    if (error !== null) {
      return `<p class="pack-app-error" ${PACK_APP_STATUS_ATTR}="error" role="alert">${escapeHtml(error)}</p>`;
    }
    if (resultPanel !== null) {
      const installed = opts.installedRecipes ?? [];
      // `runnability: null` disables every action. This host has no runnability
      // read, so use the installed roster and let execute enforce the server
      // boundary exactly as it does for a top-level task.
      registry = createResultActionRegistry(
        installed,
        new Map(installed.map((r) => [r.recipe_id, { status: 'runnable' } as never])),
        opts.fileRead !== undefined,
        fileBusy,
        fileErrors,
        fileVerified,
      );
      const html = renderRecipeResultPanel(
        resultPanel,
        installed,
        registry,
        filterStates,
        gridStates,
        opts.recordRefSearchCaller !== undefined,
        {
          heading: null,
          show_run_metrics: false,
          return_label: 'back',
        },
        selectStates,
      );
      return `<div ${RECIPE_RESULT_HOST_ATTR} ${PACK_APP_RESULT_ATTR}="${escapeHtml(resultPanel.render_recipe_id)}">${html}</div>`;
    }
    registry = null;
    if (surface.views.length === 0) {
      // Not a defect: some boards are scoped to a selected record. Keep their
      // first task in this workspace, then render its result above.
      return `<p class="pack-app-note" ${PACK_APP_EMPTY_ATTR}="">`
        + (surface.lookups.length > 0
          ? 'Pick what you want to look at below. What comes back stays here.'
          : surface.operations.length > 0
            ? 'Pick something below to start. What comes back stays here.'
            : surface.automations.length > 0
              ? 'Look after the Recipes this Pack starts on its own, below.'
              : 'This Pack has nothing you can do here.')
        + '</p>';
    }
    return '';
  };

  const renderRunnableRow = (
    title: string,
    description: string,
    entries: readonly PackAppRecipe[],
    tone: 'lookup' | 'action',
  ): string => {
    if (entries.length === 0) return '';
    const buttons = entries.map((op) => `
      <button type="button" class="pack-app-operation pack-app-operation--${tone}"
        title="${escapeHtml(op.description)}"
        ${PACK_APP_OPERATION_ATTR}="${escapeHtml(op.recipe_id)}">
        <span class="pack-app-operation-name">${escapeHtml(op.name)}</span>
        ${op.description === '' ? '' : `<span class="pack-app-operation-description">${escapeHtml(op.description)}</span>`}
      </button>
    `).join('');
    return `<section class="pack-app-operations">
      <header class="pack-app-operations-header">
        <h3 class="pack-app-operations-title">${escapeHtml(title)}</h3>
        <p class="pack-app-operations-description">${escapeHtml(description)}</p>
      </header>
      <div class="pack-app-operations-grid">${buttons}</div>
    </section>`;
  };

  const renderAutomations = (): string => {
    if (surface.automations.length === 0) return '';
    const cards = surface.automations.map((automation) => `
      <article class="pack-app-automation-card">
        <span class="pack-app-operation-name">${escapeHtml(automation.name)}</span>
        ${automation.description === '' ? '' : `<span class="pack-app-operation-description">${escapeHtml(automation.description)}</span>`}
        ${renderReferenceLink({
          label: 'Manage',
          referenceId: automation.recipe_id,
          href: serializeShellRoute('automation', automation.recipe_id),
          className: 'pack-app-automation-manage',
          ariaLabel: `Look after what runs on its own for ${automation.name} (${automation.recipe_id})`,
          attributes: { [PACK_APP_AUTOMATION_ATTR]: automation.recipe_id },
        })}
      </article>
    `).join('');
    return `<section class="pack-app-operations">
      <header class="pack-app-operations-header">
        <h3 class="pack-app-operations-title">Automation</h3>
        <p class="pack-app-operations-description">These recipes wait for their own triggers. Review, pause, or arm them in Automation.</p>
      </header>
      <div class="pack-app-operations-grid">${cards}</div>
    </section>`;
  };

  /** Lookups first, then writes. Two rows rather than one: pressing "Tenant
   *  statement" and pressing "End a tenancy" are not the same kind of act, and
   *  one undifferentiated bar of eleven buttons says they are. */
  const renderOperations = (): string => {
    const automations = renderAutomations();
    if (opts.openRunModal === undefined) return automations;
    return renderRunnableRow(
      'Find and look at things',
      'Pick a record or a time, and what comes back stays here.',
      surface.lookups,
      'lookup',
    ) + renderRunnableRow(
      'Get things done',
      'Finish a job, look at what it did, and come back to an updated page.',
      surface.operations,
      'action',
    ) + automations;
  };

  /** A pack whose manifest ships recipes this server does not have is REPORTED.
   *  Silently rendering the smaller app is the failure that looks like success:
   *  the person sees four of six actions and has no way to know. */
  const renderMissing = (): string => {
    if (surface.missing.length === 0) return '';
    return `<p class="pack-app-missing" ${PACK_APP_MISSING_ATTR}="" role="alert">`
      + `${surface.missing.length === 1 ? 'One Recipe this Pack brings is' : `${surface.missing.length} Recipes this Pack brings are`}`
      + ` not installed on this server: ${escapeHtml(surface.missing.join(', '))}.`
      + ' Reinstall the pack from Manage to restore them.</p>';
  };

  const paint = (): void => {
    if (disposed) return;
    const focusedViewId = (
      doc.activeElement as HTMLElement | null | undefined
    )?.getAttribute?.(PACK_APP_VIEW_TAB_ATTR) ?? null;
    const focusedRefresh = (
      doc.activeElement as HTMLElement | null | undefined
    )?.hasAttribute?.(PACK_APP_REFRESH_ATTR) === true;
    const focusedResultFilterAction = captureResultFilterActionFocus(
      doc.activeElement,
    );
    const focusedResultGridSubmitKey = captureResultTableEditSubmitFocus(
      doc.activeElement,
    );
    for (const picker of gridRefPickers.splice(0)) picker.destroy();
    root.innerHTML = `
      ${renderMissing()}
      ${renderContext()}
      ${renderViewTabs()}
      <div class="pack-app-body"
        ${activeViewId === null
          ? ''
          : `${PACK_APP_VIEW_PANEL_ATTR}="" id="${PACK_APP_VIEW_PANEL_ID}"`
            + ` role="tabpanel" aria-labelledby="${escapeHtml(
              packAppViewTabDomId(activeViewId),
            )}"`}>
        ${renderBody()}
      </div>
      ${renderOperations()}
    `;
    const buildSearch = opts.recordRefSearchCaller;
    if (buildSearch !== undefined && resultPanel !== null) {
      gridRefPickers = wireResultTableEditRefPickers(root, {
        search: (entity, scope) => buildSearch(
          { publisher: opts.pack.publisher, pack_slug: opts.pack.slug },
          entity,
          scope,
        ),
        valueAt: (key, rowIndex, column) =>
          activeGrid(key)?.state.rows[rowIndex]?.[column] ?? '',
        onChange: (key, gridRoot, rowIndex, column, value) => {
          const active = activeGrid(key);
          if (active === null) return;
          const next = gridSetCell(
            active.descriptor,
            active.state,
            rowIndex,
            column,
            value,
          );
          gridStates = new Map(gridStates).set(key, next);
          syncResultTableEditChrome(gridRoot, next);
        },
      });
    }
    restoreResultTableEditSubmitFocus(root, focusedResultGridSubmitKey);
    restoreResultFilterActionFocus(root, focusedResultFilterAction);
    if (focusedRefresh) {
      const refresh = root.querySelector(
        `[${PACK_APP_REFRESH_ATTR}]`,
      ) as HTMLElement | null;
      refresh?.focus({ preventScroll: true });
    }
    const restoreViewId = pendingViewTabFocus ?? focusedViewId;
    if (restoreViewId !== null) {
      const queryable = root as HTMLElement & {
        querySelectorAll?: (selector: string) => NodeListOf<HTMLElement>;
      };
      const replacement = (Array.from(
        queryable.querySelectorAll?.(`[${PACK_APP_VIEW_TAB_ATTR}]`) ?? [],
      ) as HTMLElement[]).find((tab) =>
        tab.getAttribute(PACK_APP_VIEW_TAB_ATTR) === restoreViewId,
      );
      replacement?.focus?.({ preventScroll: true });
      if (replacement !== undefined && pendingViewTabFocus === restoreViewId) {
        pendingViewTabFocus = null;
      }
    }
    if (pendingReturnScroll !== null && !busy) {
      const target = findReturnFocus(pendingReturnFocus)
        ?? (activeViewId === null
          ? null
          : Array.from(root.querySelectorAll?.(
              `[${PACK_APP_VIEW_TAB_ATTR}]`,
            ) ?? []).find((candidate) =>
              candidate.getAttribute(PACK_APP_VIEW_TAB_ATTR) === activeViewId,
            ) as HTMLElement | undefined)
        ?? root;
      focusListTarget(target);
      restoreListScroll(scrollRoot, pendingReturnScroll);
      pendingReturnFocus = null;
      pendingReturnScroll = null;
    }
  };

  /** D-282 B5 — is this recipe a lookup that one URL segment can express?
   *
   *  TWO INDEPENDENT QUESTIONS, and both must be asked EVERY time:
   *   1. MAY it run from an address — membership in `surface.lookups`, which is
   *      derived from the roster installed right now. This is the safety half.
   *   2. CAN one segment say which record — `lookupTargetVariable`. This is the
   *      expressiveness half, and it is NOT a permission of any kind.
   *
   *  ⛔ Deriving the first from the second (or from the URL) is the whole hazard:
   *  a pack version bump can turn a lookup into an operation, and the bookmark
   *  will not have changed. */
  const lookupBinding = (
    recipeId: string,
  ): { entry: ServerRecipeListEntry; variable: string } | null => {
    const lookup = surface.lookups.find((item) => item.recipe_id === recipeId);
    if (lookup === undefined) return null;
    const variable = lookupTargetVariable(lookup.entry.recipe);
    if (variable === null) return null;
    return { entry: lookup.entry, variable };
  };

  /** Open a bound lookup on one record, WITHOUT the run modal.
   *
   *  🔑 WHY NOT THE MODAL. A lookup is read-only by exactly the two axes that
   *  let a view auto-run as a tab, so asking the person to confirm a JSON form
   *  before showing them a record is a gate that protects nothing — and it is
   *  also what made the address dishonest: the modal can be edited, so a URL
   *  written from what the row ASKED for could describe a record the screen is
   *  not showing. Running it here means the address and the result come from the
   *  same value. Operations still go through the modal; that is the point of the
   *  split.
   *
   *  ⚠ The panel is stacked over the browse result exactly as a modal-returned
   *  one is (`origin: 'result-action'`, `previous`, the return frame), so Back
   *  to the list, focus restoration and scroll all behave identically. */
  const runLookup = (
    entry: ServerRecipeListEntry,
    variable: string,
    target: string,
    opener?: HTMLElement | null,
  ): void => {
    const execute = opts.execute;
    if (execute === undefined) {
      error = 'This page cannot open a record on this server.';
      paint();
      return;
    }
    if ([...gridStates.values()].some((state) => state.busy)) {
      error = 'A table is still saving. Wait for it to finish, then try again.';
      paint();
      return;
    }
    if (!mayDiscardGridEdits()) return;
    const originPanel = resultPanel;
    const returnFrame = originPanel === null
      ? null
      : {
          previous: originPanel,
          filters: new Map(filterStates),
          focus: returnFocusFrom(opener ?? doc.activeElement as HTMLElement | null),
          scroll: readListScroll(scrollRoot),
        } satisfies ReturnUiFrame;
    runToken += 1;
    const token = runToken;
    busy = true;
    busyOwner = null;
    error = null;
    missingPacks = null;
    paint();
    void execute({ recipe_id: entry.recipe_id, config: { [variable]: target } })
      .then((res) => {
        if (disposed || token !== runToken) return;
        const previous = withoutRenderedRecipe(originPanel ?? undefined, res.recipe_id);
        const nextPanel: RecipesResultPanelSnapshot = {
          route_recipe_id: activeViewId ?? entry.recipe_id,
          source_recipe_id: originPanel?.render_recipe_id ?? null,
          render_recipe_id: res.recipe_id,
          origin: 'result-action',
          result: res,
          ...(previous !== undefined ? { previous } : {}),
        };
        resultPanel = nextPanel;
        if (returnFrame !== null && previous === returnFrame.previous) {
          returnUiFrames.set(nextPanel, returnFrame);
        }
        resetResultScopedState(res);
        // Reported only on the way OUT of a successful run: an address that
        // names a record nothing could load is a bookmark that fails twice.
        opts.onOpenLookup?.({ recipe_id: entry.recipe_id, target });
      })
      .catch((err: unknown) => {
        if (disposed || token !== runToken) return;
        missingPacks = missingPacksFromError(err);
        error = errMessage(err);
      })
      .finally(() => {
        if (disposed || token !== runToken) return;
        busy = false;
        busyOwner = null;
        paint();
      });
  };

  const openPackRecipe = (
    entry: ServerRecipeListEntry,
    prefill?: { config?: Record<string, unknown>; context?: Record<string, unknown> },
    sourceRecipeId: string | null = entry.recipe_id,
    returnOpener?: HTMLElement | null,
  ): void => {
    const open = opts.openRunModal;
    if (open === undefined) {
      // The operations row is gated on this same caller, so a rendered button
      // whose open path is unwired means the two disagree — say so rather than
      // absorbing the press.
      error = 'This page cannot open a run on this server.';
      paint();
      return;
    }
    if ([...gridStates.values()].some((state) => state.busy)) {
      error = 'A table is still saving. Wait for it to finish, then try again.';
      paint();
      return;
    }
    // A completed task replaces the current result. Refuse to make a dirty
    // editable table collateral damage of that navigation.
    if (!mayDiscardGridEdits()) return;
    const explicitlyReadOnly = [...surface.views, ...surface.lookups]
      .some((candidate) => candidate.recipe_id === entry.recipe_id);
    // A target outside the derived read-only sets is treated as a possible
    // write. That costs a refresh; treating an unknown target as a lookup could
    // leave stored state stale after a row action.
    const mayWrite = !explicitlyReadOnly;
    const originPanel = resultPanel;
    const returnFrame = originPanel === null
      ? null
      : {
          previous: originPanel,
          filters: new Map(filterStates),
          focus: returnFocusFrom(returnOpener ?? doc.activeElement as HTMLElement | null),
          scroll: readListScroll(scrollRoot),
        } satisfies ReturnUiFrame;
    open(entry, (nextResult, later) => {
      if (disposed) return;
      // A held run finishing after the owner approved it replaces its "held"
      // note — only while that note is still what this page shows. An owner
      // who has moved on is not pulled back to it.
      if (later !== undefined && resultPanel?.result !== later.replaces) return;
      runToken += 1;
      busy = false;
      busyOwner = null;
      error = null;
      missingPacks = null;
      const previous = withoutRenderedRecipe(
        resultPanel ?? undefined,
        nextResult.recipe_id,
      );
      const nextPanel: RecipesResultPanelSnapshot = {
        route_recipe_id: activeViewId ?? entry.recipe_id,
        source_recipe_id: sourceRecipeId,
        render_recipe_id: nextResult.recipe_id,
        origin: 'result-action',
        result: nextResult,
        ...(previous !== undefined ? { previous } : {}),
      };
      resultPanel = nextPanel;
      if (returnFrame !== null && previous === returnFrame.previous) {
        returnUiFrames.set(nextPanel, returnFrame);
      }
      if (
        activeViewId !== null
        && mayWrite
        && nextResult.success === true
        && nextResult.awaiting_approval !== true
        && nextResult.run_terminated === undefined
      ) {
        viewNeedsRefresh = true;
      }
      resetResultScopedState(nextResult);
      paint();
    }, prefill);
  };

  const restorePreviousResult = (): void => {
    const currentPanel = resultPanel;
    const previous = currentPanel?.previous;
    if (previous === undefined) return;
    if ([...gridStates.values()].some((state) => state.busy)) return;
    if (!mayDiscardGridEdits()) return;
    const returnsToBrowseView = activeViewId !== null
      && previous.render_recipe_id === activeViewId
      && previous.previous === undefined
      && previous.origin !== 'result-action';
    // D-282 B5 — the address follows what is on screen. Leaving a lookup puts
    // the view's own hash back, so Back out of a bookmarked detail lands
    // somewhere that describes what the person is now looking at. Reported
    // BEFORE the branch below, because both of its arms leave the detail.
    if (lookupBinding(currentPanel!.render_recipe_id) !== null) {
      opts.onOpenLookup?.(null);
    }
    const returnFrame = currentPanel === null
      ? undefined
      : returnUiFrames.get(currentPanel);
    if (returnFrame !== undefined && returnFrame.previous === previous) {
      pendingReturnFocus = returnFrame.focus;
      pendingReturnScroll = returnFrame.scroll;
    }
    if (viewNeedsRefresh && returnsToBrowseView) {
      resultPanel = null;
      error = null;
      missingPacks = null;
      runActiveView(
        null,
        returnFrame === undefined
          ? null
          : refreshResumeFor(returnFrame.previous, returnFrame.filters),
      );
      return;
    }
    resultPanel = previous;
    resetResultScopedState(previous.result);
    if (returnFrame !== undefined && returnFrame.previous === previous) {
      filterStates = new Map(returnFrame.filters);
    }
    error = null;
    missingPacks = null;
    paint();
  };

  /** Run one validated result action — the row-action path.
   *
   *  The descriptor comes from the registry, never from the DOM: the button
   *  carries an opaque id and the panel only put it there after checking the
   *  target is installed and runnable. A `confirm` string is honoured before
   *  anything opens, because a row action may be destructive. */
  const runResultAction = (
    actionId: string | null,
    opener?: HTMLElement | null,
  ): void => {
    if (actionId === null || registry === null) return;
    const action: RecipeOutputAction | undefined = registry.actions.get(actionId);
    if (action === undefined) return;
    const entry = (opts.installedRecipes ?? []).find(
      (r) => r.recipe_id === action.recipe_id,
    );
    if (entry === undefined) return;
    if (action.confirm !== undefined) {
      const confirm = doc.defaultView?.confirm;
      if (typeof confirm === 'function' && !confirm.call(doc.defaultView, action.confirm)) {
        return;
      }
    }
    // A bound lookup opens in place — see `runLookup`. Everything else (an
    // operation, a lookup with several arguments, an action carrying page
    // context) still goes through the modal, which is where an argument this
    // address cannot express gets collected.
    const binding = lookupBinding(action.recipe_id);
    const config = action.config ?? {};
    const keys = Object.keys(config);
    const value = binding === null ? undefined : config[binding.variable];
    if (
      binding !== null
      && keys.length === 1
      && keys[0] === binding.variable
      && typeof value === 'string'
      && value.trim().length > 0
      && Object.keys(action.context ?? {}).length === 0
    ) {
      runLookup(binding.entry, binding.variable, value, opener);
      return;
    }
    openPackRecipe(entry, {
      config,
      context: action.context ?? {},
    }, resultPanel?.render_recipe_id ?? null, opener);
  };

  const onClick = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    if (target === null || typeof target.closest !== 'function') return;

    const copy = findRecipeResultCopyTarget(target);
    if (copy !== null) {
      ev.preventDefault();
      void copyRecipeResultValue(copy, doc);
      return;
    }

    const restore = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="restore-result-panel"]`,
    ) as HTMLElement | null;
    if (restore !== null) {
      restorePreviousResult();
      return;
    }

    // Result-panel controls first — they live INSIDE the rendered view, so a
    // tab/operation lookup would never match them anyway, but ordering it this
    // way keeps the intent legible.
    const resultAction = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="run-result-action"]`,
    ) as HTMLElement | null;
    if (resultAction !== null) {
      runResultAction(
        resultAction.getAttribute(RECIPES_ROUTE_RESULT_ACTION_ATTR),
        resultAction,
      );
      return;
    }
    const grouped = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="run-selected-result-action"]`,
    ) as HTMLElement | null;
    if (grouped !== null) {
      const groupId = grouped.getAttribute(RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR);
      const select = groupId === null ? null : root.querySelector(
        `[${RECIPES_ROUTE_RESULT_ACTION_SELECT_ATTR}="${groupId}"]`,
      ) as HTMLSelectElement | null;
      runResultAction(select?.value ?? null, grouped);
      return;
    }
    const fileBtn = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="open-result-file"]`,
    ) as HTMLElement | null;
    if (fileBtn !== null) {
      openFile(
        fileBtn.getAttribute(RECIPES_ROUTE_RESULT_FILE_ATTR),
        fileBtn.getAttribute(RECIPES_ROUTE_RESULT_FILE_MODE_ATTR),
      );
      return;
    }
    const gridAdd = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="result-grid-add"]`,
    ) as HTMLElement | null;
    if (gridAdd !== null) {
      const key = gridAdd.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR);
      if (key !== null) mutateGridRows(key, gridAddRow);
      return;
    }
    const gridRemove = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="result-grid-remove"]`,
    ) as HTMLElement | null;
    if (gridRemove !== null) {
      const key = gridRemove.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR);
      const rowIndex = Number(gridRemove.getAttribute(RECIPES_ROUTE_RESULT_GRID_ROW_ATTR));
      if (key !== null && Number.isSafeInteger(rowIndex) && rowIndex >= 0) {
        mutateGridRows(key, (descriptor, state) =>
          gridRemoveRow(descriptor, state, rowIndex));
      }
      return;
    }
    const gridSubmit = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="result-grid-submit"]`,
    ) as HTMLElement | null;
    if (gridSubmit !== null) {
      const key = gridSubmit.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR);
      if (key !== null) void submitGrid(key);
      return;
    }
    // D-282 B6. ⛔ The BUTTON is matched before the checkbox below, because the
    // action bar's control carries the same section attribute as every tick
    // box — matching the generic one first would swallow the press.
    const selectSubmit = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="result-select-submit"]`,
    ) as HTMLElement | null;
    if (selectSubmit !== null) {
      const key = selectSubmit.getAttribute(RECIPES_ROUTE_RESULT_SELECT_ATTR);
      if (key !== null) void submitSelection(key);
      return;
    }
    const selectBox = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="result-select-toggle"]`,
    ) as HTMLElement | null;
    if (selectBox !== null) {
      const key = selectBox.getAttribute(RECIPES_ROUTE_RESULT_SELECT_ATTR);
      const row = selectBox.getAttribute(RECIPES_ROUTE_RESULT_SELECT_ROW_ATTR);
      if (key !== null && row !== null) {
        const active = activeSelect(key);
        if (active !== null) {
          // ⛔ THE INTENT COMES FROM STATE, NOT FROM `input.checked`. Both hosts
          // repaint the panel wholesale from state, and one of them calls
          // `preventDefault()` on every dispatched action — which REVERTS a
          // checkbox the browser had already ticked. Reading the control would
          // make the two surfaces disagree about what a click meant; deriving
          // it means the box is purely a rendering of the selection.
          selectStates = new Map(selectStates).set(
            key,
            row === '*'
              ? setAllTableSelection(
                active.state,
                tableSelectAllState(active.state) !== 'all',
              )
              : toggleTableSelection(active.state, row),
          );
          paint();
        }
      }
      return;
    }
    const search = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}="result-filter-search"]`,
    ) as HTMLElement | null;
    if (search !== null) {
      const key = search.getAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR);
      if (key !== null) submitFilter(key, 'search');
      return;
    }
    const page = target.closest(
      `[${RECIPES_ROUTE_ACTION_ATTR}^="result-filter-page:"]`,
    ) as HTMLElement | null;
    if (page !== null) {
      const key = page.getAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR);
      const action = page.getAttribute(RECIPES_ROUTE_ACTION_ATTR) ?? '';
      if (key !== null) submitFilter(key, action.endsWith(':next') ? 'next' : 'previous');
      return;
    }

    const tab = target.closest(`[${PACK_APP_VIEW_TAB_ATTR}]`) as HTMLElement | null;
    if (tab !== null) {
      const id = tab.getAttribute(PACK_APP_VIEW_TAB_ATTR);
      if (id !== null) selectView(id, true);
      return;
    }
    const refresh = target.closest(`[${PACK_APP_REFRESH_ATTR}]`) as HTMLElement | null;
    if (refresh !== null) {
      if (!hasInFlightWork() && mayDiscardGridEdits()) {
        runActiveView('refresh');
      }
      return;
    }
    const op = target.closest(`[${PACK_APP_OPERATION_ATTR}]`) as HTMLElement | null;
    if (op !== null) {
      const id = op.getAttribute(PACK_APP_OPERATION_ATTR);
      const entry = [...surface.lookups, ...surface.operations].find(
        (o: PackAppRecipe) => o.recipe_id === id,
      )?.entry;
      // ⛔ A button that answers nothing is the worst failure this surface has.
      // The lookup runs over the SAME list the buttons were rendered from, so a
      // miss should be impossible — which is exactly why it must not be silent
      // if it ever happens. "Nothing happened" is unreportable and undebuggable;
      // a named refusal is both.
      if (entry === undefined) {
        error = id === null
          ? 'That button does not know what it points at. Open this Pack again.'
          : `“${id}” is no longer in this pack’s installed roster. Reopen this pack, or reinstall it from Manage.`;
        paint();
        return;
      }
      openPackRecipe(entry, undefined, entry.recipe_id, op);
    }
  };

  const onKeyDown = (ev: Event): void => {
    const event = ev as KeyboardEvent;
    const target = event.target as HTMLElement | null;
    if (target === null || typeof target.closest !== 'function') return;
    const tab = target.closest(`[${PACK_APP_VIEW_TAB_ATTR}]`) as HTMLElement | null;
    const currentId = tab?.getAttribute(PACK_APP_VIEW_TAB_ATTR) ?? null;
    if (currentId === null) return;
    const currentIndex = navigation.nodes.findIndex(
      (view) => view.id === currentId,
    );
    if (currentIndex < 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % navigation.nodes.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + navigation.nodes.length)
        % navigation.nodes.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = surface.views.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextId = navigation.nodes[nextIndex]?.id;
    if (nextId !== undefined && nextId !== currentId) {
      selectView(nextId, true);
    }
  };

  /** Keep a filter's draft in step with what is typed.
   *
   *  ⛔ NO REPAINT. Re-rendering on a keystroke would replace the very input
   *  being typed into and drop the caret; the state is already updated and the
   *  next paint (submit) shows it. Same rule the recipes route follows. */
  const onInput = (ev: Event): void => {
    const target = ev.target as (HTMLElement & { dataset?: DOMStringMap }) | null;
    if (target === null || typeof target.closest !== 'function') return;
    const gridInput = readResultTableEditCellInput(target);
    if (gridInput !== null) {
      const active = activeGrid(gridInput.key);
      if (active !== null) {
        const next = gridSetCell(
          active.descriptor,
          active.state,
          gridInput.rowIndex,
          gridInput.column,
          gridInput.value,
        );
        gridStates = new Map(gridStates).set(gridInput.key, next);
        syncResultTableEditChrome(gridInput.gridRoot, next);
      }
      return;
    }
    const form = target.closest(`[${RECIPES_ROUTE_RESULT_FILTER_ATTR}]`) as HTMLElement | null;
    const key = form?.getAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR) ?? null;
    const variableKey = target.dataset?.varKey;
    if (key === null || variableKey === undefined || variableKey.length === 0) return;
    const active = activeFilter(key);
    if (active === null || active.state.busy) return;
    filterStates = new Map(filterStates).set(key, {
      ...setOutputFilterDraftValue(
        active.descriptor, active.state, variableKey, readWidgetValue(target),
      ),
      busy: false,
      busy_action: null,
      error: null,
    });
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  // D-282 B5 — resolve the bookmarked address against the roster installed NOW.
  // A miss (the recipe is gone, became an operation, or takes an argument no
  // single segment can express) silently leaves the first view open, which is
  // the same place an unknown tail has always landed.
  const requestedLookup = opts.initialTarget === undefined
    || opts.initialTarget.trim().length === 0
    || opts.initialViewId === undefined
    ? null
    : lookupBinding(opts.initialViewId);
  if (requestedLookup !== null) {
    const target = opts.initialTarget!;
    pendingHydration = () => {
      runLookup(requestedLookup.entry, requestedLookup.variable, target);
    };
  }

  opts.host.appendChild(root);
  paint();
  // Open on the first view already loaded — the app-not-launcher promise.
  //
  // D-282 B5 — a bookmarked detail runs AFTER the browse view, not instead of
  // it. Chaining is what puts the list behind the record: it is the panel the
  // detail stacks on, so "Back to the list" exists on a cold load exactly as it
  // does when a row was pressed. Both runs happen either way — the first view
  // is unconditional — so the chain costs order, not work.
  if (pendingHydration !== null && activeViewId !== null && opts.execute !== undefined) {
    runActiveView();
  } else {
    runActiveView();
    const hydrate = pendingHydration;
    pendingHydration = null;
    hydrate?.();
  }

  return {
    activeViewId: () => activeViewId,
    hydratedLookup: () => (requestedLookup === null || opts.initialTarget === undefined
      ? null
      : { recipe_id: requestedLookup.entry.recipe_id, target: opts.initialTarget }),
    hasInFlightWork,
    hasUnsavedChanges: () => anyTableEditDirty(gridStates),
    refresh: () => {
      if (hasInFlightWork()) return;
      if (mayDiscardGridEdits()) runActiveView('refresh');
    },
    adopt: (host: HTMLElement) => {
      if (disposed || root.parentNode === host) return;
      host.appendChild(root);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const picker of gridRefPickers.splice(0)) picker.destroy();
      // Bump both tokens so an in-flight run or file read cannot paint into a
      // torn-down root.
      runToken += 1;
      fileGeneration += 1;
      // Revoke any blob URL still alive, so a disposed view does not leak the
      // decoded bytes of a verified file for the rest of the session.
      const view = doc.defaultView as unknown as
        { URL?: { revokeObjectURL(url: string): void } } | null | undefined;
      for (const [url, timeout] of objectUrls) {
        globalThis.clearTimeout(timeout);
        try {
          view?.URL?.revokeObjectURL(url);
        } catch {
          /* a closed window may already have dropped it */
        }
      }
      objectUrls.clear();
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onInput);
      try {
        opts.host.removeChild(root);
      } catch {
        root.remove();
      }
    },
  };
};

export const PACK_APP_STYLES = `
${PACK_INSTALL_OFFER_STYLES}
[${PACK_APP_ATTR}] { display: grid; gap: 16px; }
[${PACK_APP_ATTR}] .pack-app-context {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 16px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--surface-subtle);
}
[${PACK_APP_ATTR}] .pack-app-context-copy { display: grid; gap: 4px; min-width: 0; }
[${PACK_APP_ATTR}] .pack-app-context-kind {
  margin: 0; color: var(--fg-subtle); font-size: 11px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase;
}
[${PACK_APP_ATTR}] .pack-app-context-title { margin: 0; font-size: 18px; line-height: 1.25; }
[${PACK_APP_ATTR}] .pack-app-context-description,
[${PACK_APP_ATTR}] .pack-app-context-status {
  margin: 0; color: var(--fg-muted); font-size: 13px; line-height: 1.45;
}
[${PACK_APP_ATTR}] .pack-app-context-status { color: var(--accent); font-weight: 550; }
[${PACK_APP_ATTR}] .pack-app-refresh { flex: 0 0 auto; }
[${PACK_APP_ATTR}] .pack-app-views {
  display: flex; flex-wrap: wrap; gap: 4px;
  border-bottom: 1px solid var(--border);
}
[${PACK_APP_ATTR}] .pack-app-view-tab {
  box-sizing: border-box; appearance: none; min-height: 36px;
  border: none; background: none; cursor: pointer;
  font: inherit; font-size: 13px; font-weight: 550; color: var(--fg-muted);
  padding: 8px 12px; border-bottom: 2px solid transparent; margin-bottom: -1px;
  border-radius: var(--wc-radius, 6px) var(--wc-radius, 6px) 0 0;
}
[${PACK_APP_ATTR}] .pack-app-view-tab:hover { color: var(--fg); background: var(--surface-subtle); }
[${PACK_APP_ATTR}] .pack-app-view-tab[aria-selected="true"] {
  color: var(--accent); border-bottom-color: var(--accent);
}
[${PACK_APP_ATTR}] .pack-app-view-tab:focus-visible {
  outline: none; box-shadow: 0 0 0 3px var(--accent-weak);
}
[${PACK_APP_ATTR}] .pack-app-body { min-height: 60px; }
[${PACK_APP_ATTR}] .pack-app-note { margin: 0; color: var(--fg-muted); font-size: 13px; }
[${PACK_APP_ATTR}] .pack-app-error { margin: 0; color: var(--danger); font-size: 13px; }
[${PACK_APP_ATTR}] .pack-app-missing {
  margin: 0; padding: 10px 12px; font-size: 13px; color: var(--fg);
  border: 1px solid var(--danger); border-radius: 8px; background: var(--surface-subtle);
}
[${PACK_APP_ATTR}] .pack-app-operations {
  display: grid; gap: 12px; padding-top: 16px; border-top: 1px solid var(--border);
}
[${PACK_APP_ATTR}] .pack-app-operations-header { display: grid; gap: 3px; }
[${PACK_APP_ATTR}] .pack-app-operations-description {
  margin: 0; color: var(--fg-muted); font-size: 12px; line-height: 1.4;
}
[${PACK_APP_ATTR}] .pack-app-operations-title {
  margin: 0; font-size: 14px; font-weight: 650; color: var(--fg);
}
[${PACK_APP_ATTR}] .pack-app-operations-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 10px;
}
[${PACK_APP_ATTR}] .pack-app-operation {
  appearance: none; display: grid; gap: 5px; align-content: start; min-height: 76px;
  padding: 12px; text-align: left; font: inherit; color: var(--fg); cursor: pointer;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
}
[${PACK_APP_ATTR}] .pack-app-automation-card {
  display: grid; gap: 5px; align-content: start; min-height: 76px;
  padding: 12px; color: var(--fg);
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
}
[${PACK_APP_ATTR}] .pack-app-automation-manage {
  width: fit-content; margin-top: 4px; font-size: 12px; font-weight: 650;
}
[${PACK_APP_ATTR}] .pack-app-operation:hover {
  border-color: var(--border-strong); background: var(--surface-subtle);
}
[${PACK_APP_ATTR}] .pack-app-operation--action { border-left: 3px solid var(--accent); }
[${PACK_APP_ATTR}] .pack-app-operation:focus-visible {
  outline: none; box-shadow: 0 0 0 3px var(--accent-weak);
}
[${PACK_APP_ATTR}] .pack-app-operation-name { font-size: 13px; font-weight: 650; }
[${PACK_APP_ATTR}] .pack-app-operation-description {
  color: var(--fg-muted); font-size: 12px; line-height: 1.4;
}
@media (max-width: 560px) {
  [${PACK_APP_ATTR}] .pack-app-context { padding: 12px; }
  [${PACK_APP_ATTR}] .pack-app-view-tab {
    min-height: 44px; padding: 8px 9px; font-size: 12px;
  }
}

`;
