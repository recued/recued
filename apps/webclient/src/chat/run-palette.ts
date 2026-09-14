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

import {
  RefPicker,
  RunModal,
  wireFocusTrap,
  type FocusTrapHandle,
} from '@recued/ui-shared';
import type {
  AutoRunStatusEntry,
  ServerRecipeListEntry,
} from '@recued/contracts';
import {
  autoRunStateOf,
  autoRunToggle,
  classifyRecipeAction,
  type AutoRunState,
  type RecipeReactiveShape,
} from '../recipes/recipe-action-kind.js';

export {
  autoRunStateOf,
  autoRunToggle,
  classifyRecipeAction,
};
export type {
  AutoRunState,
  RecipeActionKind as RecipePaletteActionKind,
  RecipeReactiveShape,
} from '../recipes/recipe-action-kind.js';

// ── pure model ────────────────────────────────────────────────────

const autoRunStateLabel = (state: AutoRunState): string => {
  if (state === 'armed') return 'Armed';
  if (state === 'paused') return 'Paused';
  if (state === 'tripped') return 'Switched off by Recued after too many failures';
  return 'Not switched on';
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
export const RUN_PALETTE_RETRY_ATTR = 'data-recued-run-palette-retry';

const RECIPE_PICKER_ID = 'run-palette-recipe';

export interface RunPaletteOptions {
  /** D-269 step 1 — the server's resolved IANA zone, forwarded to the run
   *  modal's scheduled-activation stamp. Absent ⇒ this browser's, as before. */
  serverTimeZone?: () => string | undefined;
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
  /** First-run recovery when the installed inventory is empty. */
  packsHref?: string;
  /** Fired when the palette closes (the host clears its reference). */
  onClose?: () => void;
}

export interface RunPaletteHandle {
  readonly element: HTMLElement;
  /** Select a recipe by id (drives the action area). The ref-picker's
   *  onChange routes here; tests call it directly. */
  selectRecipe(recipeId: string | null): void;
  /** True while the palette or its nested Run modal owns a recipe write whose
   *  outcome is not yet known. */
  hasInFlightWork(): boolean;
  /** Reclaim focus when the global shortcut is pressed while this same
   *  palette is already open. A nested Run modal keeps ownership. */
  focus(): void;
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
  box-sizing: border-box;
  min-width: 0;
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
  min-height: 36px;
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
[${RUN_PALETTE_CLOSE_ATTR}][aria-disabled="true"] {
  cursor: not-allowed;
  opacity: .65;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-actions {
  display: grid;
  gap: 8px;
  min-width: 0;
  min-height: 24px;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-selected {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  overflow-wrap: anywhere;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-state {
  min-width: 0;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
[${RUN_PALETTE_RESULT_ATTR}] {
  min-width: 0;
  font-size: 12px;
  color: var(--fail);
  overflow-wrap: anywhere;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${RUN_PALETTE_ACTION_ATTR}] {
  appearance: none;
  min-width: 36px;
  min-height: 36px;
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
[${RUN_PALETTE_RETRY_ATTR}][aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.65;
}
[${RUN_PALETTE_ACTION_ATTR}][data-variant="primary"] {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[${RUN_PALETTE_OVERLAY_ATTR}] .ref-picker-input {
  min-height: 36px;
  padding-right: 40px;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .ref-picker-clear {
  right: 0;
  width: 36px;
  height: 36px;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .ref-picker-option {
  box-sizing: border-box;
  min-height: 36px;
  justify-content: center;
}
[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-empty {
  min-width: 0;
  font-size: 13px;
  color: var(--muted);
  overflow-wrap: anywhere;
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
  let focusTrap: FocusTrapHandle | null = null;
  let inventoryState: 'loading' | 'ready' | 'error' = 'loading';
  let inventoryLoadPending = false;
  let autoRunMutationPending = false;
  let restoreAutoRunFocusFor: string | null = null;
  let autoRunNotice: { recipeId: string; text: string } | null = null;
  let closed = false;
  const opener = (doc as Partial<Document>).activeElement as
    | HTMLElement
    | null
    | undefined;

  const overlay = doc.createElement('div');
  overlay.setAttribute(RUN_PALETTE_OVERLAY_ATTR, '');
  const panel = doc.createElement('div');
  panel.className = 'run-palette-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Run a Recipe');
  panel.setAttribute('tabindex', '-1');

  const header = doc.createElement('div');
  header.className = 'run-palette-header';
  const title = doc.createElement('h2');
  title.className = 'run-palette-title';
  title.textContent = 'Run a Recipe';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute(RUN_PALETTE_CLOSE_ATTR, '');
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => requestClose());
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
    if (ev.target === overlay) requestClose();
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
    refPicker?.destroy();
    searchHost.innerHTML = RefPicker.renderRefPicker(
      RefPicker.initialRefPickerState(null),
      {
        pickerId: RECIPE_PICKER_ID,
        placeholder: 'Search Recipes…',
        ariaLabel: 'Recipe',
        emptyText: 'No Recipes match.',
      },
    );
    refPicker = RefPicker.wireRefPicker(searchHost, {
      search: recipeSearch,
      config: {
        pickerId: RECIPE_PICKER_ID,
        placeholder: 'Search Recipes…',
        ariaLabel: 'Recipe',
        emptyText: 'No Recipes match.',
      },
      minChars: 0,
      onChange: (selection) => selectRecipe(selection?.id ?? null),
    });
  };

  const armFocusTrap = (): void => {
    if (closed || focusTrap !== null) return;
    focusTrap = wireFocusTrap({
      document: doc,
      getContainer: () => panel,
      // The caller portals the palette after `wireRunPalette` returns.
      initialFocus: false,
      // The palette temporarily hands focus to the nested Run modal. Restore
      // the original opener once, when the palette itself closes.
      restoreFocus: false,
    });
  };

  const openRunModalFor = (
    entry: ServerRecipeListEntry,
    tab: RunModal.RunModalTab,
  ): void => {
    if (childRunModal !== null) return;
    // Two document-level traps must never compete. The Run modal restores
    // focus to its palette action; its close callback then re-arms this trap.
    focusTrap?.release();
    focusTrap = null;
    childRunModal = RunModal.wireRunModal({
      ...(opts.serverTimeZone ? { serverTimeZone: opts.serverTimeZone } : {}),
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
        armFocusTrap();
      },
    });
    const portal = (doc as { body?: HTMLElement }).body ?? overlay;
    portal.appendChild(childRunModal.element);
  };

  const toggleAutoRun = (recipeId: string, nextEnabled: boolean): void => {
    const update = opts.autoRunUpdate;
    if (update === undefined || autoRunMutationPending) return;
    const activeElement = doc.activeElement;
    restoreAutoRunFocusFor =
      activeElement !== null
      && actionArea.contains(activeElement)
      && activeElement.hasAttribute(RUN_PALETTE_ACTION_ATTR)
        ? recipeId
        : null;
    autoRunNotice = null;
    autoRunMutationPending = true;
    renderActions();
    void (async () => {
      try {
        await update({ recipe_id: recipeId, enabled: nextEnabled });
        if (closed) return;
        await loadAutoRun();
      } catch {
        if (!closed) {
          autoRunNotice = {
            recipeId,
            text: 'Recued could not change that. Try again.',
          };
        }
      } finally {
        const shouldRestoreFocus =
          restoreAutoRunFocusFor === recipeId && selectedId === recipeId;
        restoreAutoRunFocusFor = null;
        autoRunMutationPending = false;
        if (!closed) {
          renderActions();
          const currentFocus = doc.activeElement;
          if (
            shouldRestoreFocus
            && (currentFocus === null || !overlay.contains(currentFocus))
          ) {
            actionArea
              .querySelector<HTMLElement>(`[${RUN_PALETTE_ACTION_ATTR}]`)
              ?.focus({ preventScroll: true });
          }
        }
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
    if (autoRunMutationPending) {
      closeBtn.setAttribute('aria-disabled', 'true');
    } else {
      closeBtn.removeAttribute('aria-disabled');
    }
    actionArea.setAttribute(
      'aria-busy',
      autoRunMutationPending ? 'true' : 'false',
    );
    clearChildren(actionArea);
    if (selectedId === null) {
      const note = doc.createElement('div');
      note.className = 'run-palette-empty';
      note.setAttribute(
        'role',
        inventoryState === 'error' && !inventoryLoadPending
          ? 'alert'
          : 'status',
      );
      note.textContent = inventoryState === 'loading'
        ? 'Loading Recipes…'
        : inventoryState === 'error'
          ? 'Recued could not load your Recipes.'
          : recipes.length === 0
            ? 'You have no Recipes yet.'
            : 'Find a Recipe to run now, on a schedule, or when something happens.';
      actionArea.appendChild(note);
      if (inventoryState === 'error') {
        const retry = actionButton(
          inventoryLoadPending ? 'Trying again…' : 'Try again',
          true,
          () => { void load(true); },
        );
        retry.setAttribute(RUN_PALETTE_RETRY_ATTR, '');
        if (inventoryLoadPending) {
          retry.setAttribute('aria-disabled', 'true');
          retry.setAttribute('aria-busy', 'true');
        }
        actionArea.appendChild(retry);
      }
      if (
        inventoryState === 'ready'
        && recipes.length === 0
        && opts.packsHref !== undefined
      ) {
        const packs = doc.createElement('a');
        packs.setAttribute(RUN_PALETTE_ACTION_ATTR, 'browse-packs');
        packs.setAttribute('href', opts.packsHref);
        packs.textContent = 'Look through starter Packs →';
        packs.addEventListener('click', () => closeSelf());
        actionArea.appendChild(packs);
      }
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
      if (autoRunNotice?.recipeId === selectedId) {
        const result = doc.createElement('div');
        result.setAttribute(RUN_PALETTE_RESULT_ATTR, '');
        result.setAttribute('role', 'status');
        result.textContent = autoRunNotice.text;
        actionArea.appendChild(result);
      }
      const { label, nextEnabled } = autoRunToggle(state);
      const toggle = actionButton(label, true, () => {
        const id = selectedId;
        if (id !== null) toggleAutoRun(id, nextEnabled);
      });
      if (opts.autoRunUpdate === undefined || autoRunMutationPending) {
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
    // Keep the palette's ownership signal alive until the shell handles the
    // link's route change. An unconditional close here could erase a pending
    // auto-run write before Chat's leave guard had a chance to prompt.
    link.addEventListener('click', () => requestClose());
    buttons.appendChild(link);
    actionArea.appendChild(buttons);
  };

  const selectRecipe = (recipeId: string | null): void => {
    if (recipeId !== selectedId) autoRunNotice = null;
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

  const load = async (retrying = false): Promise<void> => {
    if (inventoryLoadPending) return;
    const activeElement = doc.activeElement;
    const restoreRetryFocus =
      retrying
      && activeElement !== null
      && actionArea.contains(activeElement)
      && activeElement.hasAttribute(RUN_PALETTE_RETRY_ATTR);
    inventoryLoadPending = true;
    if (!retrying) {
      inventoryState = 'loading';
      selectedId = null;
      recipes = [];
      refPicker?.destroy();
      refPicker = null;
      searchHost.innerHTML = '';
    }
    renderActions();
    if (restoreRetryFocus) {
      actionArea
        .querySelector<HTMLElement>(`[${RUN_PALETTE_RETRY_ATTR}]`)
        ?.focus({ preventScroll: true });
    }
    try {
      const [{ recipes: loaded }] = await Promise.all([
        opts.recipeList(),
        loadAutoRun(),
      ]);
      if (closed) return;
      recipes = loaded;
      inventoryState = 'ready';
    } catch {
      if (!closed) inventoryState = 'error';
    }
    inventoryLoadPending = false;
    if (closed) return;
    // A search box with no inventory is a dead control. Keep the palette to a
    // single recovery choice until recipes are actually available.
    if (inventoryState === 'ready' && recipes.length > 0) mountPicker();
    const retryStillOwnsFocus =
      restoreRetryFocus
      && doc.activeElement !== null
      && actionArea.contains(doc.activeElement)
      && doc.activeElement.hasAttribute(RUN_PALETTE_RETRY_ATTR);
    renderActions();
    if (retryStillOwnsFocus) {
      const nextOwner = inventoryState === 'ready' && recipes.length > 0
        ? searchHost.querySelector<HTMLElement>(
            `[${RefPicker.REF_PICKER_INPUT_ATTR}]`,
          )
        : actionArea.querySelector<HTMLElement>(
            `[${RUN_PALETTE_RETRY_ATTR}]`,
          );
      (nextOwner ?? closeBtn).focus({ preventScroll: true });
    }
  };

  const onKey = (ev: KeyboardEvent): void => {
    // When a Run modal is stacked above, let IT own Escape.
    if (
      ev.key !== 'Escape'
      || ev.isComposing
      || childRunModal !== null
    ) return;
    if (autoRunMutationPending) {
      ev.preventDefault?.();
      return;
    }
    requestClose();
  };

  const closeSelf = (): void => {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', onKey);
    refPicker?.destroy();
    childRunModal?.destroy();
    childRunModal = null;
    focusTrap?.release();
    focusTrap = null;
    overlay.remove();
    opener?.focus?.();
    opts.onClose?.();
  };
  const requestClose = (): void => {
    if (autoRunMutationPending) return;
    closeSelf();
  };

  // Initial paint — a loading-free shell; the picker + actions fill in
  // once the inventory resolves.
  renderActions();
  doc.addEventListener('keydown', onKey);
  armFocusTrap();
  // By the next microtask the caller has appended `element` to its portal.
  void Promise.resolve().then(() => {
    if (!closed) focusTrap?.focusInitial();
  });
  void load();

  return {
    element: overlay,
    selectRecipe,
    hasInFlightWork: () =>
      !closed
      && (
        autoRunMutationPending
        || childRunModal?.hasInFlightWork() === true
      ),
    focus: () => {
      if (!closed && childRunModal === null) focusTrap?.focusInitial();
    },
    destroy: closeSelf,
  };
};
