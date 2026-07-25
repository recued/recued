/** Shell-frame Step 4c — the [▶ Run a recipe] command-palette (§D.L1).
 *
 *  A popover (portaled to body) with a type-to-filter recipe combobox (the
 *  shared ref-picker over the installed-recipe list). The action follows
 *  the selected recipe's TYPE:
 *   - manual    → [Run] · [Schedule] — both open the shared Run|Schedule
 *                 modal (the 4a `RunModal`) on the matching tab.
 *   - reactive  → a state-aware auto-run toggle: off/paused → [Arm],
 *                 armed → [Pause], tripped → [Re-arm] (drives `auto_run.update`).
 *   - reactive without an auto-run mechanism (pure event-triggers) → a
 *                 "Manage in Automation →" deep-link (the toggle doesn't apply).
 *
 *  Layered like the run-modal: a pure model (classification + toggle
 *  decision, exported for tests) + the DOM wiring. The wiring exposes an
 *  imperative `selectRecipe` so the flow is testable without driving the
 *  ref-picker's internals (the repo has no jsdom; the ref-picker mounts
 *  inert against a string-rendered host and `selectRecipe` is the seam).
 */

import { RefPicker, RunModal } from '@recued/ui-shared';
import type {
  AutoRunStatusEntry,
  ServerRecipeListEntry,
} from '@recued/contracts';

// ── pure model ────────────────────────────────────────────────────

/** The action a recipe offers in the palette. */
export type RecipePaletteActionKind = 'manual' | 'autorun' | 'managed-reactive';

/** The auto-run arm state, derived from the `auto_run.list` entry. */
export type AutoRunState = 'armed' | 'paused' | 'tripped' | 'off';

interface RecipeReactiveShape {
  auto_run?: unknown;
  event_triggers?: unknown;
  trigger_steps?: unknown;
}

/** Classify a recipe by its definition (same axes as the recipes route's
 *  `deriveTriggerKind`): an `auto_run` recipe is toggled here; a recipe
 *  reactive only via event-triggers is managed in the Automation surface;
 *  everything else is a manual run. */
export const classifyRecipeAction = (
  def: RecipeReactiveShape,
): RecipePaletteActionKind => {
  if (def.auto_run !== undefined) return 'autorun';
  const eventTriggers = Array.isArray(def.event_triggers)
    ? def.event_triggers.length
    : 0;
  const triggerSteps = Array.isArray(def.trigger_steps)
    ? def.trigger_steps.length
    : 0;
  return eventTriggers > 0 || triggerSteps > 0 ? 'managed-reactive' : 'manual';
};

/** Map an `auto_run.list` entry (or its absence) to the arm state. */
export const autoRunStateOf = (
  entry: AutoRunStatusEntry | undefined,
): AutoRunState => {
  if (entry === undefined) return 'off';
  if (entry.auto_disabled) return 'tripped';
  if (!entry.enabled) return 'paused';
  return 'armed';
};

/** The toggle button for an arm state: its label + the `enabled` it sets. */
export const autoRunToggle = (
  state: AutoRunState,
): { label: string; nextEnabled: boolean } => {
  if (state === 'armed') return { label: 'Pause', nextEnabled: false };
  if (state === 'tripped') return { label: 'Re-arm', nextEnabled: true };
  return { label: 'Arm', nextEnabled: true }; // off | paused
};

const autoRunStateLabel = (state: AutoRunState): string => {
  if (state === 'armed') return 'Armed';
  if (state === 'paused') return 'Paused';
  if (state === 'tripped') return 'Tripped (auto-disabled after failures)';
  return 'Not armed';
};

const displayName = (entry: ServerRecipeListEntry): string =>
  entry.recipe.metadata?.name?.trim() || entry.recipe_id;

// ── DOM wiring ────────────────────────────────────────────────────

export const RUN_PALETTE_STYLES_MARKER = 'data-recued-run-palette-styles';
export const RUN_PALETTE_OVERLAY_ATTR = 'data-recued-run-palette';
export const RUN_PALETTE_CLOSE_ATTR = 'data-recued-run-palette-close';
export const RUN_PALETTE_ACTION_ATTR = 'data-recued-run-palette-action';
export const RUN_PALETTE_SEARCH_ATTR = 'data-recued-run-palette-search';
export const RUN_PALETTE_RESULT_ATTR = 'data-recued-run-palette-result';

const RECIPE_PICKER_ID = 'run-palette-recipe';

export interface RunPaletteOptions {
  document?: Document;
  /** The installed-recipe inventory — full entries (for classification +
   *  the Run modal). */
  recipeList: () => Promise<{ recipes: ReadonlyArray<ServerRecipeListEntry> }>;
  /** Run-modal callers (manual path). */
  execute?: RunModal.RunModalExecuteCaller;
  schedulesList?: RunModal.RunModalSchedulesListCaller;
  schedulesCreate?: RunModal.RunModalSchedulesCreateCaller;
  schedulesUpdate?: RunModal.RunModalSchedulesUpdateCaller;
  schedulesDelete?: RunModal.RunModalSchedulesDeleteCaller;
  /** Reactive (auto-run) callers. */
  autoRunList?: () => Promise<{ entries: AutoRunStatusEntry[] }>;
  autoRunUpdate?: (args: {
    recipe_id: string;
    enabled: boolean;
  }) => Promise<unknown>;
  /** Deep-link builder to the Automation surface for a pure event-trigger
   *  recipe — passed the recipe id so it can filter to that recipe's rules
   *  (recipes-route parity: `serializeShellRoute('automation', recipe_id)`). */
  automationHref?: (recipeId: string) => string;
  /** Fired when the palette closes (the host clears its reference). */
  onClose?: () => void;
}

export interface RunPaletteHandle {
  readonly element: HTMLElement;
  /** Select a recipe by id (drives the action area). The ref-picker's
   *  onChange routes here; tests call it directly. */
  selectRecipe(recipeId: string | null): void;
  destroy(): void;
}

const RUN_PALETTE_CHROME_STYLES = `
[${RUN_PALETTE_OVERLAY_ATTR}] {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: start center;
  padding: 56px 16px 16px;
  background: rgba(24, 33, 36, .28);
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-panel {
  width: min(560px, 100%);
  max-height: calc(100vh - 80px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 24px 48px rgba(24, 33, 36, .18);
  padding: 14px;
  display: grid;
  gap: 12px;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}
[${RUN_PALETTE_CLOSE_ATTR}] {
  margin-left: auto;
  appearance: none;
  min-height: 30px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-actions {
  display: grid;
  gap: 8px;
  min-height: 24px;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-selected {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-state {
  font-size: 12px;
  color: var(--muted);
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${RUN_PALETTE_ACTION_ATTR}] {
  appearance: none;
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
[${RUN_PALETTE_ACTION_ATTR}]:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
[${RUN_PALETTE_ACTION_ATTR}][data-variant="primary"] {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-empty {
  font-size: 13px;
  color: var(--muted);
}
`;

const injectStyles = (doc: Document): void => {
  if (doc.head.querySelector(`style[${RUN_PALETTE_STYLES_MARKER}]`) !== null) {
    return;
  }
  const style = doc.createElement('style');
  style.setAttribute(RUN_PALETTE_STYLES_MARKER, '');
  style.textContent = [RefPicker.REF_PICKER_STYLES, RUN_PALETTE_CHROME_STYLES].join(
    '\n',
  );
  doc.head.appendChild(style);
};

const clearChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

export const wireRunPalette = (opts: RunPaletteOptions): RunPaletteHandle => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'wireRunPalette: no document available — pass `opts.document` for non-browser environments',
    );
  }
  injectStyles(doc);

  let recipes: ReadonlyArray<ServerRecipeListEntry> = [];
  let autoRunEntries: ReadonlyArray<AutoRunStatusEntry> = [];
  let selectedId: string | null = null;
  let refPicker: RefPicker.RefPickerHandle | null = null;
  let childRunModal: RunModal.RunModalHandle | null = null;
  let closed = false;

  const overlay = doc.createElement('div');
  overlay.setAttribute(RUN_PALETTE_OVERLAY_ATTR, '');
  const panel = doc.createElement('div');
  panel.className = 'run-palette-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Run a recipe');

  const header = doc.createElement('div');
  header.className = 'run-palette-header';
  const title = doc.createElement('h2');
  title.className = 'run-palette-title';
  title.textContent = 'Run a recipe';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute(RUN_PALETTE_CLOSE_ATTR, '');
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => closeSelf());
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const searchHost = doc.createElement('div');
  searchHost.setAttribute(RUN_PALETTE_SEARCH_ATTR, '');
  panel.appendChild(searchHost);

  const actionArea = doc.createElement('div');
  actionArea.className = 'run-palette-actions';
  panel.appendChild(actionArea);

  overlay.appendChild(panel);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeSelf();
  });

  const recipeOptions = (): ReadonlyArray<RefPicker.RefPickerOption> =>
    recipes.map((entry) => {
      const name = displayName(entry);
      const named = name !== entry.recipe_id;
      return {
        id: entry.recipe_id,
        label: name,
        ...(named ? { sublabel: entry.recipe_id } : {}),
      };
    });

  const recipeSearch = (
    query: string,
  ): Promise<readonly RefPicker.RefPickerOption[]> =>
    Promise.resolve(RefPicker.filterRefOptions(recipeOptions(), query));

  const mountPicker = (): void => {
    searchHost.innerHTML = RefPicker.renderRefPicker(
      RefPicker.initialRefPickerState(null),
      {
        pickerId: RECIPE_PICKER_ID,
        placeholder: 'Search recipes…',
        ariaLabel: 'Recipe',
        emptyText: 'No matching recipes.',
      },
    );
    refPicker = RefPicker.wireRefPicker(searchHost, {
      search: recipeSearch,
      config: {
        pickerId: RECIPE_PICKER_ID,
        placeholder: 'Search recipes…',
        ariaLabel: 'Recipe',
        emptyText: 'No matching recipes.',
      },
      minChars: 0,
      onChange: (selection) => selectRecipe(selection?.id ?? null),
    });
  };

  const openRunModalFor = (
    entry: ServerRecipeListEntry,
    tab: RunModal.RunModalTab,
  ): void => {
    if (childRunModal !== null) return;
    childRunModal = RunModal.wireRunModal({
      recipe: entry,
      document: doc,
      initialTab: tab,
      ...(opts.execute !== undefined ? { execute: opts.execute } : {}),
      ...(opts.schedulesList !== undefined
        ? { schedulesList: opts.schedulesList }
        : {}),
      ...(opts.schedulesCreate !== undefined
        ? { schedulesCreate: opts.schedulesCreate }
        : {}),
      ...(opts.schedulesUpdate !== undefined
        ? { schedulesUpdate: opts.schedulesUpdate }
        : {}),
      ...(opts.schedulesDelete !== undefined
        ? { schedulesDelete: opts.schedulesDelete }
        : {}),
      onClose: () => {
        // Closing the modal returns to the palette (still open behind it).
        childRunModal?.destroy();
        childRunModal = null;
      },
    });
    const portal = (doc as { body?: HTMLElement }).body ?? overlay;
    portal.appendChild(childRunModal.element);
  };

  const toggleAutoRun = (recipeId: string, nextEnabled: boolean): void => {
    const update = opts.autoRunUpdate;
    if (update === undefined) return;
    void (async () => {
      try {
        await update({ recipe_id: recipeId, enabled: nextEnabled });
        if (closed) return;
        await loadAutoRun();
        if (closed) return;
        renderActions();
      } catch {
        // Soft — leave the action area; a re-select re-reads state.
      }
    })();
  };

  const actionButton = (
    label: string,
    primary: boolean,
    onClick: () => void,
  ): HTMLElement => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute(RUN_PALETTE_ACTION_ATTR, '');
    if (primary) button.setAttribute('data-variant', 'primary');
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  };

  const renderActions = (): void => {
    clearChildren(actionArea);
    if (selectedId === null) {
      const note = doc.createElement('div');
      note.className = 'run-palette-empty';
      note.textContent = 'Find a recipe to run, schedule, or arm.';
      actionArea.appendChild(note);
      return;
    }
    const entry = recipes.find((r) => r.recipe_id === selectedId);
    if (entry === undefined) return;

    const name = doc.createElement('div');
    name.className = 'run-palette-selected';
    name.textContent = displayName(entry);
    actionArea.appendChild(name);

    const kind = classifyRecipeAction(entry.recipe as RecipeReactiveShape);
    const buttons = doc.createElement('div');
    buttons.className = 'run-palette-buttons';

    if (kind === 'manual') {
      buttons.appendChild(
        actionButton('Run', true, () => openRunModalFor(entry, 'run')),
      );
      buttons.appendChild(
        actionButton('Schedule', false, () => openRunModalFor(entry, 'schedule')),
      );
      actionArea.appendChild(buttons);
      return;
    }

    if (kind === 'autorun') {
      const state = autoRunStateOf(
        autoRunEntries.find((e) => e.recipe_id === selectedId),
      );
      const stateLine = doc.createElement('div');
      stateLine.className = 'run-palette-state';
      stateLine.textContent = autoRunStateLabel(state);
      actionArea.appendChild(stateLine);
      const { label, nextEnabled } = autoRunToggle(state);
      const toggle = actionButton(label, true, () => {
        const id = selectedId;
        if (id !== null) toggleAutoRun(id, nextEnabled);
      });
      if (opts.autoRunUpdate === undefined) {
        (toggle as HTMLButtonElement).disabled = true;
      }
      buttons.appendChild(toggle);
      actionArea.appendChild(buttons);
      return;
    }

    // managed-reactive — a pure event-trigger recipe: arm/disarm lives in
    // the Automation surface.
    const link = doc.createElement('a');
    link.setAttribute(RUN_PALETTE_ACTION_ATTR, '');
    link.textContent = 'Manage in Automation →';
    if (opts.automationHref !== undefined) {
      link.setAttribute('href', opts.automationHref(entry.recipe_id));
    }
    link.addEventListener('click', () => closeSelf());
    buttons.appendChild(link);
    actionArea.appendChild(buttons);
  };

  const selectRecipe = (recipeId: string | null): void => {
    selectedId = recipeId;
    renderActions();
  };

  const loadAutoRun = async (): Promise<void> => {
    if (opts.autoRunList === undefined) return;
    try {
      const { entries } = await opts.autoRunList();
      if (closed) return;
      autoRunEntries = entries;
    } catch {
      // Soft — reactive recipes show "Not armed" without the live state.
    }
  };

  const load = async (): Promise<void> => {
    try {
      const [{ recipes: loaded }] = await Promise.all([
        opts.recipeList(),
        loadAutoRun(),
      ]);
      if (closed) return;
      recipes = loaded;
    } catch {
      // Soft — an empty palette (the ref-picker shows "No matching recipes").
    }
    if (closed) return;
    mountPicker();
    renderActions();
  };

  const onKey = (ev: KeyboardEvent): void => {
    // When a Run modal is stacked above, let IT own Escape.
    if (ev.key === 'Escape' && childRunModal === null) closeSelf();
  };

  const closeSelf = (): void => {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', onKey);
    refPicker?.destroy();
    childRunModal?.destroy();
    overlay.remove();
    opts.onClose?.();
  };

  // Initial paint — a loading-free shell; the picker + actions fill in
  // once the inventory resolves.
  renderActions();
  doc.addEventListener('keydown', onKey);
  void load();

  return {
    element: overlay,
    selectRecipe,
    destroy: closeSelf,
  };
};
