import type { RecipeDefinition } from '@recued/contracts';
import type { FieldDraft } from './value-editor.js';

export interface EditorSnapshot {
  recipe: RecipeDefinition;
  fields: Record<string, FieldDraft>;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const signature = (value: EditorSnapshot): string => JSON.stringify(value);

export const createEditorHistory = (initial: EditorSnapshot, limit = 80) => {
  let current = copy(initial);
  const past: EditorSnapshot[] = [];
  const future: EditorSnapshot[] = [];
  let group: string | undefined;
  let lastEdit = 0;
  return {
    record(next: EditorSnapshot, editGroup?: string, now = Date.now()): void {
      if (signature(current) === signature(next)) return;
      if (!editGroup || editGroup !== group || now - lastEdit > 1000) {
        past.push(current);
        if (past.length > limit) past.shift();
      }
      current = copy(next);
      future.length = 0;
      group = editGroup;
      lastEdit = now;
    },
    undo(): EditorSnapshot | null {
      const previous = past.pop();
      if (!previous) return null;
      future.push(current);
      current = previous;
      group = undefined;
      return copy(current);
    },
    redo(): EditorSnapshot | null {
      const next = future.pop();
      if (!next) return null;
      past.push(current);
      current = next;
      group = undefined;
      return copy(current);
    },
    breakGroup(): void { group = undefined; },
    updateVersion(recipeId: string, version: number): void {
      // A save receipt changes the server revision, not the author's edits.
      // Undo must not resurrect the prior revision or create a phantom change.
      for (const snapshot of [current, ...past, ...future]) {
        if (snapshot.recipe.recipe_id === recipeId) snapshot.recipe.version = version;
      }
    },
    get canUndo(): boolean { return past.length > 0; },
    get canRedo(): boolean { return future.length > 0; },
  };
};

export interface DraftRecovery {
  /** Includes the paired server/profile and the original route identity. */
  key: string;
  savedKey?: (recipeId: string) => string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}
export interface RecoveredDraft { base: RecipeDefinition; snapshot: EditorSnapshot }
const storageKey = (recovery: DraftRecovery): string => `recued.kitchen.draft.v1:${recovery.key}`;
const MAX_DRAFT_BYTES = 2_000_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hasEditorShape = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.recipe_id !== 'string' || !isRecord(value.metadata)
    || !isRecord(value.variables) || !Array.isArray(value.steps)) return false;
  return ['steps', 'prefetch_steps', 'trigger_steps'].every(key => value[key] === undefined
    || (Array.isArray(value[key]) && value[key].every(step => isRecord(step) && typeof step.id === 'string')));
};

export const readEditorDraft = (recovery: DraftRecovery | undefined): RecoveredDraft | null => {
  if (!recovery) return null;
  try {
    const raw = recovery.storage.getItem(storageKey(recovery));
    if (!raw || raw.length > MAX_DRAFT_BYTES) return null;
    const value = JSON.parse(raw) as RecoveredDraft;
    if (!hasEditorShape(value.base) || !hasEditorShape(value.snapshot?.recipe)
      || !isRecord(value.snapshot.fields)) return null;
    if (!Object.entries(value.snapshot.fields).every(([key, field]) => {
      const parts: unknown = JSON.parse(key);
      return Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string')
        && field && typeof field.text === 'string' && typeof field.error === 'string';
    })) return null;
    return value;
  } catch { return null; }
};

export const writeEditorDraft = (
  recovery: DraftRecovery | undefined, draft: RecoveredDraft | null,
): boolean => {
  if (!recovery) return false;
  try {
    if (draft === null) recovery.storage.removeItem(storageKey(recovery));
    else {
      const raw = JSON.stringify(draft);
      if (raw.length > MAX_DRAFT_BYTES) return false;
      recovery.storage.setItem(storageKey(recovery), raw);
    }
    return true;
  } catch { return false; }
};
