/** D-346 B — a pack other packs use can be uninstalled, after a warning (ruling 2).
 *
 *  The reviewed removal used to refuse ("Remove the dependent packs first"). Now
 *  its plan names the packs that use the pack and the actions that stop (`stops`:
 *  the actions whose `depends_on` names it, the rule a run's refusal applies), and
 *  the reviewed apply goes ahead. Every other way to uninstall still keeps known
 *  dependants intact. And the scope's check (W2, "verify first"): an action
 *  refused while its pack is gone works again once the pack is back, because a run
 *  reads the installed packs at each run and nothing remembers the removal. */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';

import { buildPackOpResolution, getInstalledPack, missingPackDependencies } from '../pack-inventory.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import { packRemovalFixture } from './pack-removal-fixture.js';
import { regressionRecipe } from './recipe-regression-fixture.js';

const USED = 'reviewed-pack';
const REF = `recued-core.${USED}`;

const recipe = (recipe_id: string, name: string, depends_on?: string[]): RecipeDefinition => ({
  ...regressionRecipe(),
  recipe_id,
  metadata: { ...regressionRecipe().metadata, name },
  ...(depends_on !== undefined ? { depends_on } : {}),
}) as RecipeDefinition;

/** The fixture's pack, used by two packs and by one of the owner's own recipes. */
const usedByOthers = async () => {
  const f = await packRemovalFixture();
  f.install('uses-reviewed', [{ type: 'pack', slug: USED }]);
  f.recipes.save(recipe('weekly-digest', 'Weekly digest', [REF]), 'recued-core', 'pair-sync', 1, 'uses-reviewed');
  f.recipes.save(recipe('stands-alone', 'Stands alone'), 'recued-core', 'pair-sync', 1, 'uses-reviewed');
  f.install('lists-only', [{ type: 'pack', slug: USED }]);
  f.recipes.save(recipe('my-check', 'My own check', [REF]), 'recued-core', 'pair-sync', 1, null);
  return f;
};

describe('D-346 B — the reviewed removal of a pack other packs use', () => {
  it('names the packs and the actions that stop, and blocks nothing', async () => {
    const f = await usedByOthers();
    try {
      const plan = await f.review();
      expect(plan.blockers).toEqual([]);
      expect(plan.dependants.map((pack) => pack.pack_slug).sort()).toEqual(['lists-only', 'uses-reviewed']);
      expect(plan.stops).toEqual([
        { pack_slug: 'lists-only', actions: [] },
        { pack_slug: 'uses-reviewed', actions: [{ recipe_id: 'weekly-digest', name: 'Weekly digest' }] },
        { pack_slug: null, actions: [{ recipe_id: 'my-check', name: 'My own check' }] },
      ]);
    } finally { f.close(); }
  });

  it('a pack nothing uses stops nothing', async () => {
    const f = await packRemovalFixture();
    try {
      expect((await f.review()).stops).toEqual([]);
    } finally { f.close(); }
  });

  it('confirmed, it removes the pack and leaves the packs that use it installed', async () => {
    const f = await usedByOthers();
    try {
      const plan = await f.review();
      const { receipt } = await f.apply({ review_id: plan.review_id, request_id: crypto.randomUUID() });
      expect(receipt.result.ok).toBe(true);
      expect(getInstalledPack(f.contracts, USED)).toBeNull();
      expect(getInstalledPack(f.contracts, 'uses-reviewed')).not.toBeNull();
      expect(getInstalledPack(f.contracts, 'lists-only')).not.toBeNull();
      expect(f.recipes.get('weekly-digest')).not.toBeNull();
      expect(f.recipes.get('my-check')).not.toBeNull();
    } finally { f.close(); }
  });

  it('⛔ every other way to uninstall still keeps them: a direct uninstall refuses', async () => {
    const f = await usedByOthers();
    try {
      await expect(handlePacksUninstall(f.deps, { pack_slug: USED })).rejects.toMatchObject({
        code: 'conflict',
        message: expect.stringContaining('Remove dependent packs first'),
      });
      expect(getInstalledPack(f.contracts, USED)).not.toBeNull();
    } finally { f.close(); }
  });

  // D-333 — a copy of a pack is a pack of its own (`local-authoring.<slug>-copy`), and
  // a recipe uses it only once switched ("Use my copy"), which rewrites its
  // `depends_on`. So the warning follows the switch: what names the copy goes with it.
  it('with your copy of it: a recipe switched to the copy is not named when the original goes, and is when the copy goes', async () => {
    const f = await usedByOthers();
    try {
      const COPY = `${USED}-copy`;
      f.install(COPY, [], [], 'local-authoring');
      f.recipes.save(recipe('weekly-digest-mine', 'Weekly digest, on my copy', [`local-authoring.${COPY}`]),
        'local-authoring', 'pair-sync', 1, null);

      const original = await f.review();
      expect(original.stops).toEqual([
        { pack_slug: 'lists-only', actions: [] },
        { pack_slug: 'uses-reviewed', actions: [{ recipe_id: 'weekly-digest', name: 'Weekly digest' }] },
        { pack_slug: null, actions: [{ recipe_id: 'my-check', name: 'My own check' }] },
      ]);

      const copy = await f.review(f.request(COPY));
      expect(copy.blockers).toEqual([]);
      expect(copy.pack).toMatchObject({ pack_slug: COPY, publisher: 'local-authoring' });
      expect(copy.stops).toEqual([
        { pack_slug: null, actions: [{ recipe_id: 'weekly-digest-mine', name: 'Weekly digest, on my copy' }] },
      ]);
    } finally { f.close(); }
  });

  it('an action refused while its pack is gone runs again once the pack is back', async () => {
    const f = await usedByOthers();
    try {
      // The pack with its one op catalog, as an install records it.
      const catalog = { slug: 'reviewed-catalog', operations: { 'reviewed.read': {} } } as unknown as IngredientManifest;
      f.install(USED, [], [catalog.slug]);
      const missing = () => missingPackDependencies(
        f.recipes.get('weekly-digest')!,
        buildPackOpResolution(() => f.contracts.scan('installed_pack'), (id) => (id === catalog.slug ? catalog : null)),
      );
      expect(missing()).toEqual([]);

      const plan = await f.review();
      expect((await f.apply({ review_id: plan.review_id, request_id: crypto.randomUUID() })).receipt.result.ok).toBe(true);
      // What a run of it reads: refused before it starts, naming the pack.
      expect(missing()).toEqual([REF]);

      // Installed again (its access chosen in its own dialog): nothing remembers the removal.
      f.install(USED, [], [catalog.slug]);
      expect(missing()).toEqual([]);
    } finally { f.close(); }
  });
});
