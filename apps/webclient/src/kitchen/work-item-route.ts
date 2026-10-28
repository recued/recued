/** D-333 — one item of Kitchen's work in progress, opened straight into its editor.
 *
 *  Kitchen keeps unfinished work, not drafts as things of their own: an item exists from
 *  its first change until it is saved as the real thing (a recipe, an installed pack) or
 *  discarded. This page opens it in the recipe editor or the pack builder, keeps it as it
 *  is typed, and offers Discard. Only source that is not JSON yet opens as plain source. */
import type { KitchenDraftDiscardResult, KitchenImportDraft, RecipeDefinition } from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { createWorkItemAutosave, type WorkItemAutosave, type WorkItemAutosaveStatus } from './work-item-autosave.js';

interface Editor {
  dispose(): void;
  hasUnsavedChanges(): boolean;
  hasInFlightWork(): boolean;
}

export const KITCHEN_WORK_ITEM_ATTR = 'data-recued-kitchen-work';

export interface WorkItemEditorHooks {
  /** The recipe changed: keep it as work in progress. */
  onChange(recipe: RecipeDefinition): void;
  /** It was saved as a recipe: the work in progress is done. */
  onSaved(): void;
}

export interface WorkItemRouteOptions {
  root: HTMLElement;
  /** An item already in progress; absent for a new recipe, which becomes one at its first change. */
  draftId?: string;
  get: (id: string) => Promise<KitchenImportDraft>;
  create: (kind: KitchenImportDraft['kind'], source: string) => Promise<KitchenImportDraft>;
  update: (id: string, revision: number, source: string) => Promise<KitchenImportDraft>;
  discard: (id: string, revision: number) => Promise<KitchenDraftDiscardResult>;
  /** Mount the recipe editor (`undefined` = a new, blank recipe). */
  openRecipe: (recipe: RecipeDefinition | undefined, root: HTMLElement, hooks: WorkItemEditorHooks) => Editor;
  /** Mount the pack builder; `onMoved` once the builder keeps the work itself. */
  openPack: (item: KitchenImportDraft, root: HTMLElement, hooks: { onMoved(): void }) => Editor;
  /** New work became an item: keep its address from here on. */
  onCreated?: (draftId: string) => void;
  /** Discarded: go back to Kitchen. */
  onDiscarded?: () => void;
  /** An item in progress loaded: whether it is a recipe or a pack. */
  onKind?: (kind: KitchenImportDraft['kind']) => void;
  confirm?: (message: string) => boolean;
  document?: Document;
  autosaveDelayMs?: number;
}

const parsed = (source: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(source) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
};

const statusText = (status: WorkItemAutosaveStatus, created: boolean): string => {
  if (status.state === 'saving') return 'Keeping your changes…';
  if (status.state === 'saved') return 'Kept as you type';
  if (status.state === 'stopped' || status.state === 'error') return status.message;
  return created ? 'Kept as you type' : 'Kept from your first change';
};

export const mountKitchenWorkItemRoute = (options: WorkItemRouteOptions): Editor => {
  const doc = options.document ?? options.root.ownerDocument;
  const confirmDiscard = options.confirm ?? ((message: string) => doc.defaultView?.confirm(message) ?? false);
  const host = doc.createElement('section');
  host.setAttribute(KITCHEN_WORK_ITEM_ATTR, '');
  host.style.cssText = 'max-width:1200px;margin:0 auto;padding:16px 24px 0;box-sizing:border-box;';
  const header = doc.createElement('header');
  header.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;';
  const heading = doc.createElement('h1');
  heading.style.cssText = 'margin:0;font-size:20px;';
  heading.textContent = options.draftId === undefined ? 'New recipe' : 'Loading…';
  const meta = doc.createElement('p');
  meta.style.cssText = 'margin:0;flex:1 1 240px;color:var(--fg-muted);';
  const what = doc.createElement('span');
  const status = doc.createElement('span'); status.setAttribute('role', 'status');
  meta.append(what, status);
  const discard = doc.createElement('button'); discard.type = 'button'; discard.textContent = 'Discard'; discard.disabled = true;
  header.append(heading, meta, discard);
  const body = doc.createElement('div');
  host.append(header, body);
  options.root.append(host);

  let disposed = false;
  let item: KitchenImportDraft | undefined;
  let editor: Editor | undefined;
  let autosave: WorkItemAutosave | undefined;
  let lastStatus: WorkItemAutosaveStatus = { state: 'idle' };
  let busy = false;
  /** The pack builder keeps its own work, with its own Save; nothing here keeps it as typed. */
  let inBuilder = false;

  const kindWord = (kind: KitchenImportDraft['kind']): string => kind === 'recipe' ? 'Recipe' : 'Pack';
  const showStatus = (next: WorkItemAutosaveStatus): void => {
    lastStatus = next;
    if (disposed) return;
    status.textContent = inBuilder && next.state !== 'stopped' && next.state !== 'error'
      ? 'Save to keep your changes'
      : statusText(next, autosave?.current() !== undefined);
  };
  const startAutosave = (kind: KitchenImportDraft['kind'], existing?: KitchenImportDraft): WorkItemAutosave => {
    const created = createWorkItemAutosave({
      kind,
      ...(existing ? { item: { draft_id: existing.draft_id, revision: existing.revision } } : {}),
      create: options.create,
      update: options.update,
      discard: options.discard,
      onCreated: (next) => {
        item = next;
        if (!disposed) { discard.disabled = false; options.onCreated?.(next.draft_id); }
      },
      onStatus: showStatus,
      ...(options.autosaveDelayMs !== undefined ? { delayMs: options.autosaveDelayMs } : {}),
    });
    return created;
  };
  const recipeHooks = (): WorkItemEditorHooks => ({
    onChange: (recipe) => {
      const name = recipe.metadata?.name;
      if (!disposed && typeof name === 'string' && name.trim()) heading.textContent = name.trim();
      autosave?.changed(`${JSON.stringify(recipe, null, 2)}\n`);
    },
    onSaved: () => { void autosave?.finish(); },
  });

  /** Source that is not JSON yet: plain source, kept as it is typed. */
  const openSource = (current: KitchenImportDraft): void => {
    const note = doc.createElement('p');
    note.textContent = 'This is not JSON yet. Fix it here, then open it in the editor.';
    const label = doc.createElement('label'); label.textContent = 'Source';
    const source = doc.createElement('textarea'); source.setAttribute('aria-label', 'Source');
    source.spellcheck = false; source.rows = 20; source.value = current.source;
    source.style.cssText = 'width:100%;max-width:100%;box-sizing:border-box;font-family:monospace;';
    label.append(source);
    const open = doc.createElement('button'); open.type = 'button'; open.textContent = 'Open in editor';
    const sync = (): void => { open.disabled = parsed(source.value) === undefined; };
    source.addEventListener('input', () => { autosave?.changed(source.value); sync(); });
    open.addEventListener('click', () => {
      const value = parsed(source.value);
      if (!value || !item) return;
      body.replaceChildren();
      openEditor({ ...item, source: source.value }, value);
    });
    sync();
    body.append(note, label, open);
  };

  const openEditor = (current: KitchenImportDraft, value: Record<string, unknown>): void => {
    try {
      editor = current.kind === 'recipe'
        ? options.openRecipe(value as unknown as RecipeDefinition, body, recipeHooks())
        : options.openPack(current, body, {
          // The builder keeps the work from its first save: this item is done.
          onMoved: () => { void autosave?.finish(); },
        });
      inBuilder = current.kind === 'pack';
      showStatus(lastStatus);
    } catch (error) {
      status.textContent = humanizeRpcError(error);
      openSource(current);
    }
  };

  discard.addEventListener('click', () => {
    const keeping = autosave;
    if (busy || keeping === undefined || keeping.current() === undefined) return;
    if (!confirmDiscard('Discard this? It is removed from Kitchen and cannot be brought back.')) return;
    busy = true; discard.disabled = true; status.textContent = 'Discarding…';
    // Edits not written yet go with it; a write in flight lands first, so the discard is current.
    void keeping.stop().then((ref) => ref && options.discard(ref.draft_id, ref.revision)).then(() => {
      if (disposed) return;
      editor?.dispose(); editor = undefined;
      options.onDiscarded?.();
    }).catch((error: unknown) => {
      if (disposed) return;
      const code = (error as { code?: string } | null)?.code;
      // Keeping edits stopped with the discard, so what is typed from here is guarded on leave.
      showStatus({ state: 'stopped', message: code === 'unknown_method' || code === 'not_configured'
        ? 'Update your Recued server to discard work in progress.' : humanizeRpcError(error) });
      busy = false; discard.disabled = false;
    });
  });

  if (options.draftId === undefined) {
    what.textContent = 'Recipe in progress · ';
    autosave = startAutosave('recipe');
    showStatus({ state: 'idle' });
    editor = options.openRecipe(undefined, body, recipeHooks());
  } else {
    void options.get(options.draftId).then((result) => {
      if (disposed) return;
      item = result;
      options.onKind?.(result.kind);
      heading.textContent = result.title;
      what.textContent = `${kindWord(result.kind)} in progress · `;
      autosave = startAutosave(result.kind, result);
      showStatus({ state: 'idle' });
      discard.disabled = false;
      const value = parsed(result.source);
      if (value) openEditor(result, value);
      else openSource(result);
    }).catch((error: unknown) => {
      if (disposed) return;
      heading.textContent = 'Kitchen';
      status.textContent = humanizeRpcError(error);
    });
  }

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      autosave?.dispose(); // writes the last edits now
      editor?.dispose();
      host.remove();
    },
    hasUnsavedChanges: () => {
      // The pack builder keeps its own work, so its own rule decides.
      if (inBuilder) return editor?.hasUnsavedChanges() ?? false;
      // Kept as typed, so leaving loses nothing unless keeping it stopped or failed.
      if (lastStatus.state !== 'stopped' && lastStatus.state !== 'error') return false;
      return editor ? editor.hasUnsavedChanges() : (autosave?.unwritten() ?? false);
    },
    hasInFlightWork: () => busy || (autosave?.busy() ?? false) || (editor?.hasInFlightWork() ?? false),
  };
};
