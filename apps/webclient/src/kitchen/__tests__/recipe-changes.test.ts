/** D-333 — changes to a saved recipe are kept as one item that names it, and leave Kitchen
 *  once they are saved, undone or discarded. */
import { describe, expect, it, vi } from 'vitest';
import type { KitchenImportDraft, KitchenWorkBase, RecipeDefinition } from '@recued/contracts';
import { createRecipeChangesKeeper, findRecipeChanges, type RecipeChangesCallers } from '../recipe-changes.js';
import { rpcError, settle } from './kitchen-fake-dom.js';

const recipe = (name: string, version = 3): RecipeDefinition =>
  ({ recipe_id: 'morning', version, metadata: { name } }) as unknown as RecipeDefinition;
const item = (over: Partial<KitchenImportDraft>): KitchenImportDraft => ({
  draft_id: 'w1', kind: 'recipe', title: 'Morning', source: '{}', source_hash: 'h', revision: 4,
  created_at: 1, updated_at: 2, validation: { valid: true, issues: [], total_issues: 0 }, ...over,
});

const rig = (over: { item?: KitchenImportDraft; discard?: RecipeChangesCallers['discard'] } = {}) => {
  const calls: string[] = [];
  let made = 0;
  const callers: RecipeChangesCallers = {
    list: vi.fn(async () => ({ items: [] })),
    get: vi.fn(async (draft_id: string) => item({ draft_id })),
    create: vi.fn(async (source: string, base: KitchenWorkBase) => {
      calls.push(`create ${base.recipe_id}@${base.version}`);
      return item({ draft_id: `c${++made}`, revision: 1, source, base });
    }),
    update: vi.fn(async (draft_id: string, revision: number, source: string) => {
      calls.push(`update ${draft_id}@${revision}`);
      return item({ draft_id, revision: revision + 1, source });
    }),
    discard: over.discard ?? vi.fn(async (draft_id: string, revision: number) => {
      calls.push(`discard ${draft_id}@${revision}`);
      return { draft_id, discarded: true as const };
    }),
  };
  const keeper = createRecipeChangesKeeper({
    callers, base: { recipe_id: 'morning', version: 3 }, saved: recipe('Morning'),
    ...(over.item !== undefined ? { item: over.item } : {}), delayMs: 0,
  });
  return { keeper, callers, calls };
};

describe('Kitchen keeps changes to a saved recipe (D-333)', () => {
  it('keeps the first change as an item that names the recipe, and later ones in it', async () => {
    const r = rig();
    expect(r.keeper.hasChanges()).toBe(false);
    r.keeper.changed(recipe('Morning briefing'));
    await settle();
    r.keeper.changed(recipe('Morning briefing!'));
    await settle();
    expect(r.calls).toEqual(['create morning@3', 'update c1@1']);
    expect(r.keeper.hasChanges()).toBe(true);
    expect(r.keeper.status()).toEqual({ state: 'saved' });
  });

  it('continues changes already in progress', async () => {
    const r = rig({ item: item({ draft_id: 'w1', revision: 4 }) });
    expect(r.keeper.hasChanges()).toBe(true);
    r.keeper.changed(recipe('Morning briefing'));
    await settle();
    expect(r.calls).toEqual(['update w1@4']);
  });

  it('removes the item when the changes are undone, and keeps new ones in a new item', async () => {
    const r = rig();
    r.keeper.changed(recipe('Morning briefing'));
    await settle();
    r.keeper.changed(recipe('Morning')); // back to the saved recipe
    await settle();
    expect(r.calls).toEqual(['create morning@3', 'discard c1@1']);
    expect(r.keeper.hasChanges()).toBe(false);
    r.keeper.changed(recipe('Evening'));
    await settle();
    expect(r.calls.at(-1)).toBe('create morning@3');
  });

  it('is done once saved; edits made while it saved are kept against the new version, after the old item goes', async () => {
    let removed!: () => void;
    const calls: string[] = [];
    const r = rig({ discard: async (draft_id: string, revision: number) => {
      calls.push(`discard ${draft_id}@${revision}`);
      await new Promise<void>((resolve) => { removed = resolve; });
      return { draft_id, discarded: true as const };
    } });
    r.keeper.changed(recipe('Morning briefing'));
    await settle();
    r.keeper.changed(recipe('Morning briefing, later')); // typed while the save was on its way
    r.keeper.saved({ recipe_id: 'morning', version: 4 }, recipe('Morning briefing', 4));
    await settle();
    expect(calls).toEqual(['discard c1@1']);
    // One item per recipe: the new one is made only once the old one is removed.
    expect(r.calls).toEqual(['create morning@3']);
    removed();
    await settle();
    expect(r.calls).toEqual(['create morning@3', 'create morning@4']);
    expect(r.keeper.hasChanges()).toBe(true);
  });

  it('leaves nothing in progress after a save with no edits since', async () => {
    const r = rig();
    r.keeper.changed(recipe('Morning briefing'));
    await settle();
    r.keeper.saved({ recipe_id: 'morning', version: 4 }, recipe('Morning briefing', 4));
    await settle();
    expect(r.calls).toEqual(['create morning@3', 'discard c1@1']);
    expect(r.keeper.hasChanges()).toBe(false);
  });

  it('discards kept changes on request; a refused discard stops keeping, so leaving asks', async () => {
    const r = rig();
    r.keeper.changed(recipe('Morning briefing'));
    await settle();
    await r.keeper.discard();
    expect(r.calls.at(-1)).toBe('discard c1@1');
    expect(r.keeper.hasChanges()).toBe(false);

    const refused = rig({ item: item({}), discard: async () => { throw rpcError('conflict', 'This changed since you opened it.'); } });
    await expect(refused.keeper.discard()).rejects.toMatchObject({ code: 'conflict' });
    expect(refused.keeper.stopped()).toBe(true);
    expect(refused.keeper.status()).toEqual({ state: 'stopped', message: 'This changed since you opened it.' });
  });

  it('finds the changes to one recipe, and says when this server cannot keep any', async () => {
    const callers = rig().callers;
    const listed = (items: Array<{ draft_id: string; base?: KitchenWorkBase }>) =>
      ({ items: items.map((entry) => ({ kind: 'recipe' as const, title: 't', revision: 1, created_at: 1, updated_at: 1,
        from: 'Kitchen', ready: true, problems: 0, ...entry })) });
    callers.list = async () => listed([{ draft_id: 'new-1' }, { draft_id: 'w2', base: { recipe_id: 'morning', version: 3 } }]);
    await expect(findRecipeChanges(callers, 'morning')).resolves.toMatchObject({ draft_id: 'w2' });
    await expect(findRecipeChanges(callers, 'evening')).resolves.toBeUndefined();
    callers.get = async () => { throw rpcError('not_found'); }; // discarded since the list was read
    await expect(findRecipeChanges(callers, 'morning')).resolves.toBeUndefined();
    callers.list = async () => { throw rpcError('unknown_method'); };
    await expect(findRecipeChanges(callers, 'morning')).resolves.toBeNull();
  });
});
