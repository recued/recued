import { afterEach,expect,it,vi } from 'vitest';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL,fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { D165_CONTRACT_SCHEMA } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { createPackRemovalStore } from '../storage/pack-removal-store.js';
import { recordPackInventory,getInstalledPack } from '../pack-inventory.js';
import { regressionRecipe } from './recipe-regression-fixture.js';
const dirs: string[] = [];afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{ recursive: true,force: true }); });
for (const point of ['before-effects','after-effects'] as const) it(`holds a consumed removal after process death ${point}`,async () => {
  const dir = mkdtempSync(join(tmpdir(),'recued-pack-removal-crash-'));dirs.push(dir);const filename = join(dir,'realm.db'),root = fileURLToPath(new URL('../../../../',import.meta.url));
  const open = () => {
    const db = new Database(filename),recipes = createRecipeStore('/no-catalog',db),contracts = createContractStore(db);contracts.seedSchema(D165_CONTRACT_SCHEMA);
    const codec = createPreapprovalCodec(() => new Uint8Array(32).fill(7)),deps = { recipeStore: recipes,contractStore: contracts,packDir: dir,now: () => 1000 };
    return { db,recipes,contracts,removals: createPackRemovalStore(db,codec,deps,() => 1000) };
  };
  let f = open();const recipe = { ...regressionRecipe(),recipe_id: 'owned' };
  f.recipes.save(recipe,'recued-core','pair-sync',1,'crash-pack');recordPackInventory(f.contracts,{ pack_slug: 'crash-pack',publisher: 'recued-core',pack_version: 1,contents: [],dependencies: [],installed_at: 1 });
  const plan = await f.removals.review({ pack_slug: 'crash-pack',request_id: 'review' },'owner',() => {}),request = { review_id: plan.review_id,request_id: 'apply' };f.db.close();
  const source = (path: string) => JSON.stringify(pathToFileURL(join(root,path)).href);
  const program = [
    `import Database from ${source('node_modules/better-sqlite3/lib/index.js')};`,
    `import { createRecipeStore } from ${source('backend/server/src/recipe-store.ts')};`,
    `import { createContractStore } from ${source('backend/server/src/storage/contract-store.ts')};`,
    `import { createPreapprovalCodec } from ${source('backend/server/src/storage/preapproval-codec.ts')};`,
    `import { createPackRemovalStore } from ${source('backend/server/src/storage/pack-removal-store.ts')};`,
    `import { handlePacksUninstall } from ${source('backend/server/src/pack-uninstall-handler.ts')};`,
    `const db = new Database(${JSON.stringify(filename)}),recipes = createRecipeStore('/no-catalog',db),contracts = createContractStore(db);`,
    `const deps = { recipeStore: recipes,contractStore: contracts,packDir: ${JSON.stringify(dir)},now: () => 1000 };`,
    `const store = createPackRemovalStore(db,createPreapprovalCodec(() => new Uint8Array(32).fill(7)),deps,() => 1000);`,
    `await store.apply(${JSON.stringify(request)},'owner',() => {},async (target,controls) => {`,
    point === 'before-effects' ? 'controls.beforeMutation();process.exit(86);' : 'await handlePacksUninstall(deps,target,controls);process.exit(87);',
    '});',
  ].join('\n');const path = join(dir,'child.mts');writeFileSync(path,program);
  const result = spawnSync(process.execPath,['--import',pathToFileURL(join(root,'node_modules/tsx/dist/loader.mjs')).href,path],{ cwd: root,encoding: 'utf8',timeout: 20000 });
  expect(result.status,result.stderr+result.stdout).toBe(point === 'before-effects' ? 86 : 87);
  f = open();try {
    expect(getInstalledPack(f.contracts,'crash-pack') !== null).toBe(point === 'before-effects');
    expect(f.recipes.listForPack('crash-pack')).toEqual(point === 'before-effects' ? ['owned'] : []);
    const execute = vi.fn();await expect(f.removals.apply(request,'owner',() => {},execute)).rejects.toMatchObject({ code: 'pack_removal_in_doubt' });expect(execute).not.toHaveBeenCalled();
  } finally { f.db.close(); }
},30000);
