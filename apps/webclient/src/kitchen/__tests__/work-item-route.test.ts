/** D-333 — one item of work in progress, opened straight into its editor and kept as typed. */
import { describe, expect, it, vi } from 'vitest';
import type { KitchenImportDraft, RecipeDefinition } from '@recued/contracts';
import { mountKitchenWorkItemRoute, type WorkItemEditorHooks } from '../work-item-route.js';
import { allOf, byText, FakeEl, fakeDocument, rpcError, settle } from './kitchen-fake-dom.js';

const recipeSource = '{"recipe_id":"morning","metadata":{"name":"Morning briefing"}}';
const item = (over: Partial<KitchenImportDraft> = {}): KitchenImportDraft => ({
  draft_id: 'w1', kind: 'recipe', title: 'Morning briefing', source: recipeSource, source_hash: 'h', revision: 4,
  created_at: 1, updated_at: 2, validation: { valid: true, issues: [], total_issues: 0 }, ...over,
});
const editor = (dirty = true) => ({ dispose: vi.fn(), hasUnsavedChanges: () => dirty, hasInFlightWork: () => false });
const statusText = (root: FakeEl): string => allOf(root).find((el) => el.attrs.get('role') === 'status')!.textContent;

const mount = (over: {
  draftId?: string;
  get?: () => Promise<KitchenImportDraft>;
  update?: (id: string, revision: number, source: string) => Promise<KitchenImportDraft>;
  discard?: (id: string, revision: number) => Promise<{ draft_id: string; discarded: true }>;
  confirm?: () => boolean;
  autosaveDelayMs?: number;
} = {}) => {
  const root = new FakeEl('main');
  let hooks: WorkItemEditorHooks | undefined;
  let packHooks: { onMoved(): void } | undefined;
  const create = vi.fn(async (_kind: 'recipe' | 'pack', source: string) => item({ draft_id: 'new-1', revision: 1, source }));
  const update = vi.fn(over.update ?? (async (id: string, revision: number, source: string) => item({ draft_id: id, revision: revision + 1, source })));
  const discard = vi.fn(over.discard ?? (async (draft_id: string) => ({ draft_id, discarded: true as const })));
  const openRecipe = vi.fn((_recipe: RecipeDefinition | undefined, _root: HTMLElement, next: WorkItemEditorHooks) => { hooks = next; return editor(); });
  const openPack = vi.fn((_item: KitchenImportDraft, _root: HTMLElement, next: { onMoved(): void }) => { packHooks = next; return editor(); });
  const onCreated = vi.fn(); const onDiscarded = vi.fn(); const onKind = vi.fn();
  const route = mountKitchenWorkItemRoute({
    root: root as unknown as HTMLElement,
    ...(over.draftId !== undefined ? { draftId: over.draftId } : {}),
    get: over.get ?? (async () => item()),
    create, update, discard, openRecipe, openPack, onCreated, onDiscarded, onKind,
    confirm: over.confirm ?? (() => true),
    document: fakeDocument(),
    autosaveDelayMs: over.autosaveDelayMs ?? 0,
  });
  return { root, route, create, update, discard, openRecipe, openPack, onCreated, onDiscarded, onKind,
    hooks: () => hooks!, packHooks: () => packHooks! };
};
const recipe = (name: string): RecipeDefinition => ({ recipe_id: 'morning', metadata: { name } } as unknown as RecipeDefinition);

describe('Kitchen work in progress — the item page (D-333)', () => {
  it('starts a new recipe that becomes an item at its first change, then keeps its address', async () => {
    const r = mount();
    expect(r.openRecipe).toHaveBeenCalledWith(undefined, expect.anything(), expect.anything());
    expect(byText(r.root, 'button', 'Discard').disabled).toBe(true); // nothing to discard yet
    expect(r.create).not.toHaveBeenCalled();
    r.hooks().onChange(recipe('Morning briefing'));
    await settle();
    expect(r.create).toHaveBeenCalledWith('recipe', `${JSON.stringify(recipe('Morning briefing'), null, 2)}\n`);
    expect(r.onCreated).toHaveBeenCalledWith('new-1');
    expect(byText(r.root, 'h1', 'Morning briefing')).toBeDefined(); // the heading follows the name
    expect(byText(r.root, 'button', 'Discard').disabled).toBe(false);
    r.hooks().onChange(recipe('Morning briefing 2'));
    await settle();
    expect(r.update).toHaveBeenCalledWith('new-1', 1, expect.stringContaining('Morning briefing 2'));
    expect(statusText(r.root)).toBe('Kept as you type');
  });

  it('opens an item straight in the recipe editor, keeps edits, and is done once saved as a recipe', async () => {
    const r = mount({ draftId: 'w1' });
    await settle();
    expect(r.onKind).toHaveBeenCalledWith('recipe');
    expect(r.openRecipe).toHaveBeenCalledWith(JSON.parse(recipeSource), expect.anything(), expect.anything());
    r.hooks().onChange(recipe('Morning briefing'));
    await settle();
    expect(r.update).toHaveBeenCalledWith('w1', 4, expect.any(String));
    r.hooks().onSaved();
    await settle();
    expect(r.discard).toHaveBeenCalledWith('w1', 5); // the revision its last write made
  });

  it('hands a pack to the builder, and the item is done once the builder keeps the work', async () => {
    const r = mount({ draftId: 'w1', get: async () => item({ kind: 'pack', source: '{"name":"Bookings"}' }) });
    await settle();
    expect(r.onKind).toHaveBeenCalledWith('pack');
    expect(r.openPack).toHaveBeenCalled();
    r.packHooks().onMoved();
    await settle();
    expect(r.discard).toHaveBeenCalledWith('w1', 4);
  });

  it('shows source that is not JSON yet, keeps it as typed, and opens the editor once it parses', async () => {
    const r = mount({ draftId: 'w1', get: async () => item({ source: '{"recipe_id":' }) });
    await settle();
    expect(r.openRecipe).not.toHaveBeenCalled();
    const open = byText(r.root, 'button', 'Open in editor');
    expect(open.disabled).toBe(true);
    const source = allOf(r.root).find((el) => el.tag === 'textarea')!;
    source.value = recipeSource; source.dispatch('input');
    expect(open.disabled).toBe(false);
    await settle();
    expect(r.update).toHaveBeenCalledWith('w1', 4, recipeSource);
    open.click();
    expect(r.openRecipe).toHaveBeenCalledWith(JSON.parse(recipeSource), expect.anything(), expect.anything());
  });

  it('discards after confirming and goes back to Kitchen; a cancel keeps it; a stale revision is refused', async () => {
    const r = mount({ draftId: 'w1' });
    await settle();
    byText(r.root, 'button', 'Discard').click();
    await settle();
    expect(r.discard).toHaveBeenCalledWith('w1', 4);
    expect(r.onDiscarded).toHaveBeenCalled();

    const kept = mount({ draftId: 'w1', confirm: () => false });
    await settle();
    byText(kept.root, 'button', 'Discard').click();
    await settle();
    expect(kept.discard).not.toHaveBeenCalled();

    const stale = mount({ draftId: 'w1', discard: async () => { throw rpcError('conflict', 'This changed since you opened it. Reopen it before discarding.'); } });
    await settle();
    byText(stale.root, 'button', 'Discard').click();
    await settle();
    expect(statusText(stale.root)).toBe('This changed since you opened it. Reopen it before discarding.');
    expect(stale.onDiscarded).not.toHaveBeenCalled();
  });

  it('lets the pack builder keep its own work: no claim to keep it as typed, and its edits are guarded', async () => {
    const r = mount({ draftId: 'w1', get: async () => item({ kind: 'pack', source: '{"name":"Bookings"}' }) });
    await settle();
    expect(statusText(r.root)).toBe('Save to keep your changes');
    // Nothing here stopped, but the builder has unsaved edits: leaving asks.
    expect(r.route.hasUnsavedChanges()).toBe(true);
  });

  it('drops edits not yet kept when discarding, so the discard is at the current revision', async () => {
    const r = mount({ draftId: 'w1', autosaveDelayMs: 60_000 });
    await settle();
    r.hooks().onChange(recipe('Morning briefing 2')); // waiting for the pause, not written
    byText(r.root, 'button', 'Discard').click();
    await settle();
    expect(r.update).not.toHaveBeenCalled();
    expect(r.discard).toHaveBeenCalledWith('w1', 4);
    expect(r.onDiscarded).toHaveBeenCalled();
  });

  it('guards source typed after keeping it stopped', async () => {
    const r = mount({
      draftId: 'w1',
      get: async () => item({ source: '{"recipe_id":' }),
      update: async () => { throw rpcError('conflict'); },
    });
    await settle();
    expect(r.route.hasUnsavedChanges()).toBe(false);
    const source = allOf(r.root).find((el) => el.tag === 'textarea')!;
    source.value = '{"recipe_id":"x"'; source.dispatch('input');
    await settle();
    expect(statusText(r.root)).toContain('changed somewhere else');
    expect(r.route.hasUnsavedChanges()).toBe(true);
  });

  it('asks before leaving only when keeping the work stopped', async () => {
    const r = mount({ draftId: 'w1', update: async () => { throw rpcError('conflict'); } });
    await settle();
    expect(r.route.hasUnsavedChanges()).toBe(false); // kept as typed
    r.hooks().onChange(recipe('Morning briefing'));
    await settle();
    expect(statusText(r.root)).toContain('changed somewhere else');
    expect(r.route.hasUnsavedChanges()).toBe(true);
  });
});
