import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D165_CONTRACT_SCHEMA, type BulkPackManifest, type PackUpdateStage } from '@recued/contracts';
import { runRecipeRegression } from '@recued/engine';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createPackUpdateStore } from '../storage/pack-update-store.js';
import { preparePackUpdate, type PackInstallRpcDeps } from '../pack-install-handler.js';
import { recordPackInventory } from '../pack-inventory.js';
import { recordsManifestReviewHash } from '../records/index.js';
import { recipeReleaseDigest as digest } from '../storage/recipe-release-authority.js';
import { regressionFixture, regressionRecipe, regressionSuite } from './recipe-regression-fixture.js';

export const packUpdateFixture = async () => {
  const f = regressionFixture(), dir = mkdtempSync(join(tmpdir(),'recued-pack-update-'));
  const recipes = createRecipeStore('/no-community',f.db), contracts = createContractStore(f.db); contracts.seedSchema(D165_CONTRACT_SCHEMA);
  const active = ['update-first','update-second'].map(recipe_id => ({ ...regressionRecipe(),recipe_id }));
  const candidates = active.map(recipe => ({ ...structuredClone(recipe),version: 2,ttl: 10 }));
  const manifest: BulkPackManifest = { manifest_version: 1,slug: 'reviewed-pack',publisher: 'recued-core',name: 'Reviewed fixture pack',
    description: 'Use fixture recipes to check an update.',version: 2,requires: ['install_bulk_pack'],recipes: candidates.map(recipe => ({ slug: recipe.recipe_id,version: 2 })),tags: [] };
  const putManifest = () => writeFileSync(join(dir,manifest.slug + '.json'),JSON.stringify(manifest)); putManifest();
  for (const recipe of active) {
    recipes.save(recipe,'recued-core','pair-sync',1,manifest.slug);
    const suite = regressionSuite(); suite.baseline = structuredClone(recipe);
    await f.store.save({ recipe_id: recipe.recipe_id,expected_revision: 0,request_id: randomUUID(),suite },() => {});
  }
  recordPackInventory(contracts,{ pack_slug: manifest.slug,publisher: manifest.publisher,pack_version: 1,contents: [],installed_at: 1 });
  const getBundled = recipes.getBundled.bind(recipes); recipes.getBundled = id => candidates.find(recipe => recipe.recipe_id === id) ?? getBundled(id);
  let time = 1000;
  const updates = createPackUpdateStore(f.db,f.codec,recipes,contracts,f.store,() => time);
  const client = { actor: 'owner',check: () => {} };
  const deps: PackInstallRpcDeps = { recipeStore: recipes,contractStore: contracts,packDir: dir,packUpdateStore: updates,packUpdateClient: client,now: () => time };
  const request = (expected_revision = 0): PackUpdateStage => ({ pack_slug: manifest.slug,source: 'bundled',expected_revision,
    expected_manifest_hash: recordsManifestReviewHash(manifest),request_id: randomUUID() });
  const stage = (value = request()) => updates.stage(value,client.actor,client.check,() => preparePackUpdate(deps,manifest.slug,'bundled',value.expected_manifest_hash));
  const qualify = async () => {
    const view = await updates.read(manifest.slug,client.actor,client.check);
    const started = await updates.beginTest(manifest.slug,view.revision,client.check), results = [];
    for (const entry of started.target.recipes) {
      const suite = (await f.store.read(entry.slug,undefined,client.check)).version!;
      results.push({ ...await runRecipeRegression(suite.suite,entry.recipe!.recipe),recipe_id: entry.slug,revision: suite.revision,suite_digest: suite.digest,
        baseline_hash: digest(suite.suite.baseline),candidate_hash: digest(entry.recipe!.recipe) });
    }
    return updates.qualify(manifest.slug,view.revision,started.attempt,results,client.actor,client.check);
  };
  return { ...f,dir,recipes,contracts,active,candidates,manifest,deps,updates,client,stage,qualify,request,putManifest,
    advance: (ms: number) => { time += ms; },close: () => { f.close(); rmSync(dir,{ recursive: true,force: true }); } };
};
