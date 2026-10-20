import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { recordPackInventory, getInstalledPack } from '../pack-inventory.js';
import { INSTALL_MANIFEST_MARKER_HEADER, PACK_UPDATE_LIMITS } from '@recued/contracts';
import { handlePacksInstall, preparePackUpdate, installPackBySlug } from '../pack-install-handler.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createRecipeRegressionStore } from '../storage/recipe-regression-store.js';
import { createPackUpdateStore } from '../storage/pack-update-store.js';
import { packUpdateFixture } from './pack-update-fixture.js';
import { regressionSuite } from './recipe-regression-fixture.js';

const fixtures: Array<Awaited<ReturnType<typeof packUpdateFixture>>> = [];
const fixture = async () => { const value = await packUpdateFixture(); fixtures.push(value); return value; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); });
it('preserves ordinary unenrolled updates while the vault is locked',async () => {
  const f = await fixture(); f.state.locked = true;
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).managed).toBe(false);
  expect((await handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: ['install_bulk_pack'] })).result.ok).toBe(true);
});
it('encrypts an immutable staged candidate without replacing installed recipes and protects every writer',async () => {
  const f = await fixture(), request = f.request(), view = await f.stage(request);
  expect(view.managed).toBe(true); expect(view.revision).toBe(1); expect(view.candidate!.recipes).toHaveLength(2);
  expect(f.recipes.get(f.active[0]!.recipe_id)).toEqual(f.active[0]);
  expect(JSON.stringify(f.db.prepare('SELECT * FROM pack_update_tracks').all())).not.toContain('Fixture comparisons');
  expect(await f.stage(request)).toEqual(view);
  await expect(f.stage()).rejects.toMatchObject({ code: 'pack_update_conflict' });
  expect(() => f.recipes.save(f.candidates[0]!,'recued-core','pair-sync',2,f.manifest.slug)).toThrow('staged update');
  expect(() => f.recipes.save(f.candidates[0]!,'recued-core','pair-sync',2,f.manifest.slug,{})).toThrow('staged update');
  expect(() => f.recipes.register(f.candidates[0]!)).toThrow('staged update');
  await expect(handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: [] })).rejects.toMatchObject({ code: 'pack_update_required' });
});
it('updates only the exact tested bodies, keeps ordinary install choices, and reports the applied candidate',async () => {
  const f = await fixture(); await f.stage(); const qualified = await f.qualify(); expect(qualified.qualification!.passed).toBe(2);
  const result = await handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: [],regression_review_id: qualified.qualification!.review_id });
  expect(result.result.ok).toBe(true);
  for (const recipe of f.candidates) expect(f.recipes.get(recipe.recipe_id)).toEqual(recipe);
  const view = await f.updates.read(f.manifest.slug,f.client.actor,f.client.check); expect(view.applied).toBe(true); expect(view.qualification).toBeNull();
  await expect(handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: [],regression_review_id: qualified.qualification!.review_id })).rejects.toMatchObject({ code: 'pack_update_conflict' });
});
it.each(['suite','expiry','actor','candidate','restage','baseline'] as const)('refuses an update when %s changes after tests pass',async reason => {
  const f = await fixture(); await f.stage(); const qualified = await f.qualify();
  if (reason === 'suite') { const suite = regressionSuite(); suite.baseline = f.active[0]!;
    await f.store.save({ recipe_id: f.active[0]!.recipe_id,expected_revision: 1,request_id: crypto.randomUUID(),suite },() => {}); }
  if (reason === 'expiry') f.advance(PACK_UPDATE_LIMITS.qualification_ms + 1);
  if (reason === 'actor') f.client.actor = 'another-client';
  if (reason === 'candidate') f.candidates[0]!.ttl = 99;
  if (reason === 'restage') await f.stage(f.request(1));
  if (reason === 'baseline') { const before = f.contracts.get('installed_pack',[f.manifest.slug])!.value;
    if (!before || typeof before !== 'object') throw new Error('Missing fixture inventory');
    f.contracts.put('installed_pack',[f.manifest.slug],{ ...before,installed_at: 99 }); }
  await expect(handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: [],regression_review_id: qualified.qualification!.review_id })).rejects.toMatchObject({ code: 'pack_update_conflict' });
  for (const recipe of f.active) expect(f.recipes.get(recipe.recipe_id)).toEqual(recipe);
});
it('requires every candidate recipe to pass',async () => {
  const f = await fixture(); f.candidates[1]!.steps[0] = { id: 'count',transform: 'count',input: [1] }; await f.stage();
  expect((await f.qualify()).qualification).toBeNull();
  await expect(handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: [],regression_review_id: 'forged' })).rejects.toMatchObject({ code: 'pack_update_conflict' });
});
it('invalidates older passing proof before the next private test read and rechecks key availability',async () => {
  const f = await fixture(); await f.stage(); const passing = await f.qualify();
  const open = f.codec.open.bind(f.codec); vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { throw new Error('Cancelled private read'); });
  await expect(f.updates.beginTest(f.manifest.slug,1,f.client.check)).rejects.toThrow('Cancelled');
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).qualification).toBeNull();
  await expect(handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: [],regression_review_id: passing.qualification!.review_id })).rejects.toMatchObject({ code: 'pack_update_conflict' });
  vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const result = await open(value); f.state.locked = true; return result; });
  await expect(f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).rejects.toMatchObject({ code: 'server_locked' });
});
it('reserves added recipe IDs before activation, then purges protection on explicit retirement',async () => {
  const f = await fixture(); f.recipes.delete(f.active[1]!.recipe_id); await f.stage();
  expect(() => f.recipes.register(f.candidates[1]!)).toThrow('staged update');
  expect(() => f.recipes.save(f.candidates[1]!,'owner','inline')).toThrow('staged update');
  f.updates.retire(f.manifest.slug);
  expect(f.db.prepare('SELECT deleted,encrypted FROM pack_update_tracks').get()).toEqual({ deleted: 1,encrypted: '' });
  expect(f.db.prepare('SELECT count(*) FROM pack_update_members').pluck().get()).toBe(0);
  f.recipes.save(f.candidates[1]!,'owner','inline');
  await expect(f.stage(f.request())).rejects.toMatchObject({ code: 'pack_update_conflict' });
});
it('keeps the previous recipes on engine rollback and allows rollback after owner authority is lost',async () => {
  const f = await fixture(); await f.stage(); const passing = await f.qualify();
  // The adapter snapshots check at authorization; make the captured check observe revocation.
  let live = true; f.client.check = () => { if (!live) throw new Error('Revoked owner'); };
  f.recipes.addOnMutated(id => { if (id === f.active[0]!.recipe_id) live = false; });
  const result = await handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: [],regression_review_id: passing.qualification!.review_id });
  expect(result.result.ok).toBe(false); expect(result.result.rolled_back).toHaveLength(1);
  for (const recipe of f.active) expect(f.recipes.get(recipe.recipe_id)).toEqual(recipe);
});
it('does not enroll unsupported pack contents or stage changed server manifests',async () => {
  const f = await fixture(), hash = f.request().expected_manifest_hash; f.manifest.name = 'Changed'; f.putManifest();
  await expect(preparePackUpdate(f.deps,f.manifest.slug,'bundled',hash)).rejects.toMatchObject({ code: 'pack_update_conflict' });
  f.manifest.pre_install = true; f.putManifest();
  await expect(f.stage()).rejects.toMatchObject({ code: 'pack_update_unsupported' });
  expect(f.updates.managed(f.manifest.slug)).toBe(false);
});
it('stages marketplace bodies without install markers and applies the same tested candidate by slug',async () => {
  const f = await fixture(), requests: boolean[] = [];
  f.deps.marketplaceFetch = async (input,init) => {
    requests.push(new Headers(init?.headers).get(INSTALL_MANIFEST_MARKER_HEADER) === '1');
    const url = new URL(String(input));
    if (url.pathname.startsWith('/packs/')) return new Response(JSON.stringify(f.manifest));
    const recipe = f.candidates.find(recipe => url.pathname === `/recipes/${recipe.recipe_id}.json`);
    return recipe ? new Response(JSON.stringify({ recipe_id: recipe.recipe_id,publisher_id: 'recued-core',version: recipe.version,recipe })) : new Response('{}',{ status: 404 });
  };
  const request = { ...f.request(),source: 'marketplace' as const };
  await f.updates.stage(request,f.client.actor,f.client.check,() => preparePackUpdate(f.deps,f.manifest.slug,'marketplace',request.expected_manifest_hash));
  expect(requests.length).toBe(3); expect(requests.every(marked => !marked)).toBe(true);
  const qualified = await f.qualify();
  const result = await installPackBySlug(f.deps,{ slug: f.manifest.slug,expected_manifest_hash: request.expected_manifest_hash,
    granted_permissions: ['install_bulk_pack'],regression_review_id: qualified.qualification!.review_id });
  expect(result.result.ok).toBe(true); expect(requests.filter(Boolean)).toHaveLength(3);
});
it('retains private stages and fresh proof across an on-disk database reopen',async () => {
  const f = await fixture(); await f.stage(); const before = await f.qualify(), path = join(f.dir,'reopened.sqlite');
  await f.db.backup(path);
  const db = new Database(path);
  try {
    const recipes = createRecipeStore('/no-community',db), contracts = createContractStore(db), suites = createRecipeRegressionStore(db,f.codec);
    const reopened = createPackUpdateStore(db,f.codec,recipes,contracts,suites,() => 1000);
    expect(await reopened.read(f.manifest.slug,f.client.actor,f.client.check)).toEqual(before);
    expect(() => recipes.save(f.candidates[0]!,'recued-core','pair-sync',2,f.manifest.slug)).toThrow('staged update');
  } finally { db.close(); }
});
it('rechecks crypto authority and storage quotas without advancing the saved stage',async () => {
  const f = await fixture(), original = f.codec.seal.bind(f.codec);
  vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => { const sealed = await original(value); f.state.locked = true; return sealed; });
  await expect(f.stage()).rejects.toMatchObject({ code: 'server_locked' }); expect(f.updates.managed(f.manifest.slug)).toBe(false);
  f.state.locked = false; await f.stage();
  f.db.prepare("INSERT INTO pack_update_tracks VALUES('quota',1,0,CAST(zeroblob(32000000) AS TEXT),'')").run();
  await expect(f.stage(f.request(1))).rejects.toMatchObject({ code: 'pack_update_limit' });
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).revision).toBe(1);
  for (const recipe of f.active) expect(f.recipes.get(recipe.recipe_id)).toEqual(recipe);
});

it('rejects a changed protected manifest before installing its added dependency',async () => {
  const f = await fixture(); await f.stage(); const passing = await f.qualify();
  const extra = { ...structuredClone(f.active[0]!),recipe_id: 'dependency-recipe' };
  const getBundled = f.recipes.getBundled.bind(f.recipes); f.recipes.getBundled = id => id === extra.recipe_id ? extra : getBundled(id);
  const dependency = { ...structuredClone(f.manifest),slug: 'unreviewed-dependency',version: 1,recipes: [{ slug: extra.recipe_id,version: 1 }] };
  writeFileSync(join(f.dir,dependency.slug + '.json'),JSON.stringify(dependency));
  const manifest = { ...f.manifest,dependencies: [{ type: 'pack' as const,slug: dependency.slug }] };
  await expect(handlePacksInstall(f.deps,{ manifest,granted_permissions: ['install_bulk_pack'],regression_review_id: passing.qualification!.review_id }))
    .rejects.toMatchObject({ code: 'pack_update_conflict' });
  expect(getInstalledPack(f.contracts,dependency.slug)).toBeNull();
  for (const recipe of f.active) expect(f.recipes.get(recipe.recipe_id)).toEqual(recipe);
});
it('admits only one apply callback for the same passing update at a time',async () => {
  const f = await fixture(); await f.stage(); const passing = await f.qualify();
  const target = await preparePackUpdate(f.deps,f.manifest.slug,'bundled',f.request().expected_manifest_hash);
  const [first,second] = await Promise.all([1,2].map(() => f.updates.authorize(target.manifest,target.recipes,passing.qualification!.review_id,f.client.actor,f.client.check)));
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered = 0; const pending = first!(async () => { entered++; await held; });
  try {
    await expect(second!(async () => { entered++; })).rejects.toMatchObject({ code: 'pack_update_conflict' });
    expect(entered).toBe(1);
  } finally { release(); await pending; }
  // Failed or abandoned installs release the slot so an unchanged proof can retry.
  await second!(async () => { entered++; }); expect(entered).toBe(2);
});

it('holds dependency changes that appear while the apply preflight is awaiting',async () => {
  const f = await fixture(), extra = { ...structuredClone(f.active[0]!),recipe_id: 'dependency-recipe' };
  const getBundled = f.recipes.getBundled.bind(f.recipes); f.recipes.getBundled = id => id === extra.recipe_id ? extra : getBundled(id);
  const dependency = { ...structuredClone(f.manifest),slug: 'existing-dependency',version: 1,recipes: [{ slug: extra.recipe_id,version: 1 }] };
  writeFileSync(join(f.dir,dependency.slug + '.json'),JSON.stringify(dependency));
  recordPackInventory(f.contracts,{ pack_slug: dependency.slug,publisher: dependency.publisher,pack_version: 1,contents: [],installed_at: 1 });
  f.manifest.dependencies = [{ type: 'pack',slug: dependency.slug }]; f.putManifest();
  await f.stage(); const passing = await f.qualify();
  f.deps.warmMarketplaceRecipes = async () => { f.contracts.delete('installed_pack',[dependency.slug]); };
  await expect(handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: ['install_bulk_pack'],regression_review_id: passing.qualification!.review_id }))
    .rejects.toMatchObject({ code: 'pack_update_conflict' });
  expect(getInstalledPack(f.contracts,dependency.slug)).toBeNull(); expect(f.recipes.getStored(extra.recipe_id)).toBeNull();
  for (const recipe of f.active) expect(f.recipes.get(recipe.recipe_id)).toEqual(recipe);
});

it('retires the tombstone and recipe reservations in one transaction',async () => {
  const f = await fixture(); await f.stage();
  const before = f.db.prepare('SELECT * FROM pack_update_tracks').all();
  const members = f.db.prepare('SELECT * FROM pack_update_members ORDER BY recipe_id').all();
  f.db.exec("CREATE TRIGGER fail_retirement BEFORE DELETE ON pack_update_members BEGIN SELECT RAISE(ABORT,'Retirement write failed'); END");
  expect(() => f.updates.retire(f.manifest.slug)).toThrow('Retirement write failed');
  expect(f.db.prepare('SELECT * FROM pack_update_tracks').all()).toEqual(before);
  expect(f.db.prepare('SELECT * FROM pack_update_members ORDER BY recipe_id').all()).toEqual(members);
  f.db.exec('DROP TRIGGER fail_retirement'); f.updates.retire(f.manifest.slug);
  expect(f.updates.managed(f.manifest.slug)).toBe(false);
  expect(f.db.prepare('SELECT count(*) FROM pack_update_members').pluck().get()).toBe(0);
});
