/** D-333 — changes to a saved recipe are work in progress too. Kitchen keeps them as they are
 *  typed, as one item that names the recipe, until they are saved or discarded. Undoing back
 *  to the saved recipe removes the item: nothing is in progress any more. */
import type {
  KitchenImportDraft, KitchenWorkBase, KitchenWorkItemList, RecipeDefinition,
} from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { createWorkItemAutosave, type WorkItemAutosave, type WorkItemAutosaveStatus } from './work-item-autosave.js';

export interface RecipeChangesCallers {
  list(): Promise<KitchenWorkItemList>;
  get(draftId: string): Promise<KitchenImportDraft>;
  create(source: string, base: KitchenWorkBase): Promise<KitchenImportDraft>;
  update(draftId: string, revision: number, source: string): Promise<KitchenImportDraft>;
  discard(draftId: string, revision: number): Promise<unknown>;
}

/** The changes in progress to a saved recipe: the item, `undefined` when there are none, or
 *  `null` when they cannot be kept here (a server from before D-333, or the list failed). */
export const findRecipeChanges = async (
  callers: RecipeChangesCallers,
  recipeId: string,
): Promise<KitchenImportDraft | undefined | null> => {
  let list: KitchenWorkItemList;
  try { list = await callers.list(); } catch { return null; }
  const found = list.items.find((item) => item.base?.recipe_id === recipeId);
  if (found === undefined) return undefined;
  // Discarded since the list was read: there are none.
  return callers.get(found.draft_id).catch(() => undefined);
};

export interface RecipeChangesKeeper {
  /** Every change the editor makes, as the recipe now stands. */
  changed(recipe: RecipeDefinition): void;
  /** Saved: `saved` is now the recipe, at `base`. Changes made meanwhile are kept against it. */
  saved(base: KitchenWorkBase, saved: RecipeDefinition): void;
  /** Throw the changes away. Resolves once Kitchen no longer has them; rejects with why not. */
  discard(): Promise<void>;
  /** Changes are kept, or on their way to being kept. */
  hasChanges(): boolean;
  /** A write is waiting or in flight. */
  busy(): boolean;
  status(): WorkItemAutosaveStatus;
  /** Keeping them stopped or failed, so leaving would lose what is not kept. */
  stopped(): boolean;
  dispose(): void;
}

export interface RecipeChangesKeeperOptions {
  callers: RecipeChangesCallers;
  base: KitchenWorkBase;
  /** The saved recipe as the editor holds it, to tell when the changes are undone. */
  saved: RecipeDefinition;
  /** Changes already in progress. */
  item?: KitchenImportDraft;
  onStatus?: (status: WorkItemAutosaveStatus) => void;
  delayMs?: number;
}

const pretty = (recipe: unknown): string => `${JSON.stringify(recipe, null, 2)}\n`;

export const createRecipeChangesKeeper = (options: RecipeChangesKeeperOptions): RecipeChangesKeeper => {
  let base = options.base;
  let savedJson = JSON.stringify(options.saved);
  let latest: RecipeDefinition | undefined;
  /** The last item's removal: one item per recipe, so the next waits for it. */
  let settled: Promise<unknown> = Promise.resolve();
  let lastStatus: WorkItemAutosaveStatus = { state: 'idle' };
  const report = (status: WorkItemAutosaveStatus): void => {
    lastStatus = status;
    options.onStatus?.(status);
  };
  const start = (item?: KitchenImportDraft): WorkItemAutosave => {
    const after = settled;
    const forBase = base;
    return createWorkItemAutosave({
      kind: 'recipe',
      ...(item !== undefined ? { item: { draft_id: item.draft_id, revision: item.revision } } : {}),
      create: (_kind, source) => after.then(() => options.callers.create(source, forBase)),
      update: options.callers.update,
      discard: options.callers.discard,
      onStatus: report,
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
    });
  };
  let autosave = start(options.item);
  const hasChanges = (): boolean =>
    autosave.current() !== undefined || autosave.busy() || autosave.unwritten();
  /** Done with the current item: remove it, and keep later changes in a new one. */
  const restart = (): void => {
    settled = autosave.finish();
    autosave = start();
    report({ state: 'idle' });
  };

  return {
    changed(recipe: RecipeDefinition): void {
      latest = recipe;
      if (JSON.stringify(recipe) === savedJson) {
        if (hasChanges()) restart();
        return;
      }
      autosave.changed(pretty(recipe));
    },
    saved(next: KitchenWorkBase, saved: RecipeDefinition): void {
      base = next;
      savedJson = JSON.stringify(saved);
      // The editor moves its own copy to the saved version too.
      if (latest !== undefined && latest.recipe_id === saved.recipe_id) latest = { ...latest, version: saved.version };
      restart();
      // Edits made while it was saving are changes to the version just saved.
      if (latest !== undefined && JSON.stringify(latest) !== savedJson) autosave.changed(pretty(latest));
    },
    async discard(): Promise<void> {
      const ref = await autosave.stop();
      try {
        if (ref !== undefined) await options.callers.discard(ref.draft_id, ref.revision);
      } catch (error) {
        // Keeping stopped with the discard, so what is typed from here is guarded on leave.
        report({ state: 'stopped', message: humanizeRpcError(error) });
        throw error;
      }
      latest = undefined;
      autosave = start();
      report({ state: 'idle' });
    },
    hasChanges,
    busy: () => autosave.busy(),
    status: () => lastStatus,
    stopped: () => lastStatus.state === 'stopped' || lastStatus.state === 'error',
    dispose(): void { autosave.dispose(); },
  };
};
