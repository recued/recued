import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BulkPackManifest,type PackUpdateApply } from '@recued/contracts';
import { runRecipeRegression } from '@recued/engine';
import { packUpdateFixture } from './pack-update-fixture.js';
import { regressionRecipe,regressionSuite } from './recipe-regression-fixture.js';
import { recordPackInventory } from '../pack-inventory.js';
import { preparePackUpdate } from '../pack-install-handler.js';
import { writePackUpdateGroup } from '../pack-update-plan.js';
import { recordsManifestReviewHash } from '../records/index.js';
import { recipeReleaseDigest as digest } from '../storage/recipe-release-authority.js';

export const packUpdatePlanFixture = async () => {
  const f = await packUpdateFixture();
  const dependencyActive = { ...regressionRecipe(),recipe_id: 'required-recipe' };
  const dependencyCandidate = { ...structuredClone(dependencyActive),version: 7,ttl: 20 };
  const dependency: BulkPackManifest = { ...structuredClone(f.manifest),slug: 'required-pack',name: 'Required fixture pack',version: 3,
    recipes: [{ slug: dependencyActive.recipe_id,version: 7 }] };
  f.recipes.save(dependencyActive,dependency.publisher,'pair-sync',1,dependency.slug);
  recordPackInventory(f.contracts,{ pack_slug: dependency.slug,publisher: dependency.publisher,pack_version: 1,contents: [],installed_at: 1 });
  const suite = regressionSuite(); suite.baseline = dependencyActive;
  await f.store.save({ recipe_id: dependencyActive.recipe_id,expected_revision: 0,request_id: crypto.randomUUID(),suite },f.client.check);
  const getBundled = f.recipes.getBundled.bind(f.recipes);
  f.recipes.getBundled = id => id === dependencyCandidate.recipe_id ? dependencyCandidate : getBundled(id);
  f.manifest.dependencies = [{ type: 'pack',slug: dependency.slug,min_version: 3 }]; f.putManifest();
  const putDependency = () => writeFileSync(join(f.dir,dependency.slug + '.json'),JSON.stringify(dependency)); putDependency();
  const request = (expected_revision = 0) => ({ ...f.request(expected_revision),include_dependencies: true });
  const prepare = (hash = recordsManifestReviewHash(f.manifest)) => preparePackUpdate(f.deps,f.manifest.slug,'bundled',hash,{ includeDependencies: true });
  const stage = (value = request()) => f.updates.stage(value,f.client.actor,f.client.check,() => prepare(value.expected_manifest_hash));
  const qualify = async () => {
    const view = await f.updates.read(f.manifest.slug,f.client.actor,f.client.check);
    const started = await f.updates.beginTest(f.manifest.slug,view.revision,f.client.check), results = [];
    for (const entry of started.recipes) {
      const suite = (await f.store.read(entry.slug,undefined,f.client.check)).version!;
      results.push({ ...await runRecipeRegression(suite.suite,entry.recipe!.recipe),recipe_id: entry.slug,revision: suite.revision,
        suite_digest: suite.digest,baseline_hash: digest(suite.suite.baseline),candidate_hash: digest(entry.recipe!.recipe) });
    }
    return f.updates.qualify(f.manifest.slug,view.revision,started.attempt,results,f.client.actor,f.client.check);
  };
  const apply = (request: PackUpdateApply) => f.updates.applyGroup(request,f.client.actor,f.client.check,() => prepare(),
    (target,permit,at) => writePackUpdateGroup(target,f.deps,permit,at));
  const ready = async () => {
    await stage(); const view = await qualify();
    return { pack_slug: f.manifest.slug,expected_revision: view.revision,review_id: view.qualification!.review_id,request_id: crypto.randomUUID() };
  };
  return { ...f,dependency,dependencyActive,dependencyCandidate,putDependency,prepare,qualify,apply,ready,stage,request };
};
