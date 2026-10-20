import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { D165_CONTRACT_SCHEMA } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { createPackRepairStore } from '../storage/pack-repair-store.js';
for (const point of ['before-commit', 'after-commit'] as const) it(`recovers local repair after process death ${point} without replaying effects`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-pack-repair-crash-')), filename = join(dir, 'realm.db'), root = fileURLToPath(new URL('../../../../', import.meta.url));
  const open = () => {
    const db = new Database(filename), recipes = createRecipeStore('/no-catalog', db), contracts = createContractStore(db);contracts.seedSchema(D165_CONTRACT_SCHEMA);
    const codec = createPreapprovalCodec(() => new Uint8Array(32).fill(7));
    return { db, contracts, repairs: createPackRepairStore(db, codec, { recipeStore: recipes, contractStore: contracts, packDir: dir, now: () => 1000 }, () => 1000) };
  };
  let f = open();
  try {
    f.contracts.put('grant', ['orphan', 'catalog', 'connection', 'read'], { allowed: true });
    const plan = await f.repairs.review({ inventory_key: 'orphan', request_id: 'review' }, 'owner', () => {});
    const request = { review_id: plan.review_id, request_id: 'apply', acknowledge_local_cleanup: true };f.db.close();
    const source = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);
    const program = [
      `import Database from ${source('node_modules/better-sqlite3/lib/index.js')};`,
      `import { createRecipeStore } from ${source('backend/server/src/recipe-store.ts')};`,
      `import { createContractStore } from ${source('backend/server/src/storage/contract-store.ts')};`,
      `import { createPreapprovalCodec } from ${source('backend/server/src/storage/preapproval-codec.ts')};`,
      `import { createPackRepairStore } from ${source('backend/server/src/storage/pack-repair-store.ts')};`,
      `const db = new Database(${JSON.stringify(filename)}), recipes = createRecipeStore('/no-catalog',db), contracts = createContractStore(db);`,
      `const store = createPackRepairStore(db,createPreapprovalCodec(() => new Uint8Array(32).fill(7)),{recipeStore:recipes,contractStore:contracts,packDir:${JSON.stringify(dir)},now:()=>1000},()=>1000);`,
      ...(point === 'before-commit' ? [`db.function('crash_repair',()=>process.exit(86));db.exec("CREATE TRIGGER crash_repair BEFORE UPDATE ON pack_repair_reviews BEGIN SELECT crash_repair(); END");`] : []),
      `await store.apply(${JSON.stringify(request)},'owner',()=>{});process.exit(87);`,
    ].join('\n');
    const child = join(dir, 'child.mts');writeFileSync(child, program);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href, child], { cwd: root, encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stderr + result.stdout).toBe(point === 'before-commit' ? 86 : 87);
    f = open();expect(f.contracts.scan('grant', ['orphan'])).toHaveLength(point === 'before-commit' ? 1 : 0);
    if (point === 'before-commit') f.db.exec('DROP TRIGGER crash_repair');
    const retained = await f.repairs.inspect('owner', () => {});expect(retained.recent_repairs).toHaveLength(point === 'before-commit' ? 0 : 1);
    const completed = await f.repairs.apply(request, 'owner', () => {});expect(completed.receipt.request_id).toBe('apply');
    expect(f.contracts.scan('grant', ['orphan'])).toHaveLength(0);
    const privateHistory = await f.repairs.inspect('another-owner', () => {});expect(privateHistory.recent_repairs).toEqual([]);
  } finally { if (f.db.open) f.db.close();rmSync(dir, { recursive: true, force: true }); }
}, 30000);
