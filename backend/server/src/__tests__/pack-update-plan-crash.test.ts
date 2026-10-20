import { expect,it,vi } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packUpdatePlanFixture } from './pack-update-plan-fixture.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createRecipeRegressionStore } from '../storage/recipe-regression-store.js';
import { createPackUpdateStore } from '../storage/pack-update-store.js';
import { getInstalledPack } from '../pack-inventory.js';

it.each(['before','after'] as const)('recovers the exact local truth when the process exits %s the group commit',async point => {
  const f = await packUpdatePlanFixture();
  try {
    const request = await f.ready(), path = join(f.dir,'crash.sqlite'); await f.db.backup(path);
    const payload = join(f.dir,'payload.json'), worker = join(f.dir,'worker.mts');
    writeFileSync(payload,JSON.stringify({ request,candidates: [...f.candidates,f.dependencyCandidate],manifest: f.manifest }));
    const source = (file: string) => JSON.stringify(resolve('backend/server/src',file));
    writeFileSync(worker,[
      `import Database from ${JSON.stringify(resolve('node_modules/better-sqlite3/lib/index.js'))};`,
      `import { readFileSync } from 'node:fs';`,
      `import { createRecipeStore } from ${source('recipe-store.ts')};`,
      `import { createContractStore } from ${source('storage/contract-store.ts')};`,
      `import { createRecipeRegressionStore } from ${source('storage/recipe-regression-store.ts')};`,
      `import { createPreapprovalCodec } from ${source('storage/preapproval-codec.ts')};`,
      `import { createPackUpdateStore } from ${source('storage/pack-update-store.ts')};`,
      `import { preparePackUpdate } from ${source('pack-install-handler.ts')};`,
      `import { writePackUpdateGroup } from ${source('pack-update-plan.ts')};`,
      `import { recordsManifestReviewHash } from ${source('records/index.ts')};`,
      `const [path,payload,point,packDir] = process.argv.slice(2);`,
      `const data = JSON.parse(readFileSync(payload,'utf8')), db = new Database(path);`,
      `const recipes = createRecipeStore('/no-community',db), contracts = createContractStore(db);`,
      `const codec = createPreapprovalCodec(() => new Uint8Array(32).fill(7)), suites = createRecipeRegressionStore(db,codec);`,
      `const updates = createPackUpdateStore(db,codec,recipes,contracts,suites,() => 1000);`,
      `const bundled = recipes.getBundled.bind(recipes); recipes.getBundled = id => data.candidates.find(recipe => recipe.recipe_id === id) ?? bundled(id);`,
      `const deps = { recipeStore: recipes,contractStore: contracts,packDir };`,
      `if (point === 'before') { const save = recipes.save.bind(recipes); recipes.save = (...args) => { save(...args); process.exit(86); }; }`,
      `else recipes.addOnMutated(() => process.exit(87));`,
      `await updates.applyGroup(data.request,'owner',() => {},() => preparePackUpdate(deps,data.manifest.slug,'bundled',recordsManifestReviewHash(data.manifest),{ includeDependencies: true }),`,
      `  (target,permit,at) => writePackUpdateGroup(target,deps,permit,at));`,
      `throw new Error('Expected the fixture process to exit at the commit boundary.');`,
    ].join('\n'));
    const child = spawnSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),'--tsconfig',resolve('tsconfig.test.json'),worker,path,payload,point,f.dir],
      { encoding: 'utf8',timeout: 30_000,maxBuffer: 200_000 });
    expect(child.error,child.stderr).toBeUndefined(); expect(child.status,child.stdout + child.stderr).toBe(point === 'before' ? 86 : 87);
    const db = new Database(path);
    try {
      const recipes = createRecipeStore('/no-community',db), contracts = createContractStore(db), suites = createRecipeRegressionStore(db,f.codec);
      const updates = createPackUpdateStore(db,f.codec,recipes,contracts,suites,() => 1000);
      const view = await updates.read(f.manifest.slug,'owner',() => {});
      expect(getInstalledPack(contracts,f.manifest.slug)!.version).toBe(point === 'before' ? 1 : 2);
      expect(getInstalledPack(contracts,f.dependency.slug)!.version).toBe(point === 'before' ? 1 : 3);
      expect(recipes.get(f.dependencyActive.recipe_id)).toEqual(point === 'before' ? f.dependencyActive : f.dependencyCandidate);
      if (point === 'before') {
        expect(view.releases).toBeUndefined(); expect(db.prepare('SELECT * FROM pack_release_history').all()).toEqual([]);
        expect(view.last_apply).toBeUndefined(); expect(view.qualification).not.toBeNull();
        expect(view.applied).toBe(false); // Reopening never resumes the write.
      } else {
        expect(view.releases).toHaveLength(1); expect(view.releases![0]!.release_id).toBe(view.last_apply!.release_id);
        const prepare = vi.fn(async () => { throw new Error('A completed operation must not resolve or dispatch again'); });
        const write = vi.fn();
        const recovered = await updates.applyGroup(request,'owner',() => {},prepare,write);
        expect(recovered.receipt).toEqual(view.last_apply); expect(recovered.applied).toBe(true);
        expect(prepare).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      }
    } finally { db.close(); }
  } finally { f.close(); }
},45000);
