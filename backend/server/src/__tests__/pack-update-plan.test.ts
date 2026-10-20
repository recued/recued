import { afterEach,expect,it,vi } from 'vitest';
import { rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALL_MANIFEST_MARKER_HEADER,type BulkPackManifest,type ValueHint } from '@recued/contracts';
import { packUpdatePlanFixture } from './pack-update-plan-fixture.js';
import { regressionRecipe,regressionSuite } from './recipe-regression-fixture.js';
import { recordPackInventory,getInstalledPack } from '../pack-inventory.js';
import { handlePacksInstall,preparePackUpdate } from '../pack-install-handler.js';
import { writePackUpdateGroup } from '../pack-update-plan.js';
import { recordsManifestReviewHash } from '../records/index.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createPackUpdateStore } from '../storage/pack-update-store.js';
import { createReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });
const fixture = async () => { const f = await packUpdatePlanFixture(); cleanups.push(f.close); return f; };
const pairRecipe = (f: Awaited<ReturnType<typeof fixture>>) => {
  ensureReceptionSchema(f.db);
  const pairs = createReceptionIntakeRecipePairStore(f.db);
  pairs.upsert({ endpoint_id: 'fixture-endpoint',now: 1,binding: { version: 3,
    recipe_id: f.dependencyActive.recipe_id,recipe_version: 1,pair_revision: 'd200-pair-v3-' + 'a'.repeat(64) } });
  f.deps.getReceptionPairs = () => ({ pairs,endpoints: { findById: () => null },now: () => 1000 });
};

it.each(['prior webhook','prior template','candidate template','Reception pair'] as const)('holds ordinary setup for a %s before reserving a dependency group',async reason => {
  const f = await fixture();
  const template: ValueHint = { label: 'Template',type: 'mail_template',starter: { name: 'Fixture parcels',type: 'shipment',
    entrance: { conditions: [{ field: 'from',op: 'is',value: 'ship@example.test' }],variables: ['tracking_number'] },
    rules: [{ target: { variable: 'tracking_number' },source: 'body',find: { kind: 'after_label',label: 'Tracking:' } }],html: false,ai: { enabled: false } } };
  if (reason === 'prior webhook') f.dependencyActive.webhook_triggers = [{ binding: 'delivery',event_types: ['delivery'] }];
  if (reason === 'prior template') f.dependencyActive.variables = { template };
  if (reason === 'candidate template') f.dependencyCandidate.variables = { template };
  if (reason === 'Reception pair') pairRecipe(f);
  if (reason.startsWith('prior')) f.recipes.save(f.dependencyActive,f.dependency.publisher,'pair-sync',1,f.dependency.slug);
  await expect(f.stage()).rejects.toMatchObject({ code: 'pack_update_unsupported' });
  expect(f.updates.managed(f.manifest.slug)).toBe(false);
  expect(f.db.prepare('SELECT * FROM pack_update_plan_packs').all()).toEqual([]);
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyActive);
});
it('holds a Reception binding created after source review and crypto, before the first recipe write',async () => {
  const f = await fixture(), request = await f.ready(), seal = f.codec.seal.bind(f.codec), notify = vi.fn();
  f.recipes.addOnMutated(notify);
  vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => { const encrypted = await seal(value); pairRecipe(f); return encrypted; });
  await expect(f.apply(request)).rejects.toMatchObject({ code: 'pack_update_unsupported' });
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyActive);
  expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(1);
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).last_apply).toBeUndefined();
  expect(notify).not.toHaveBeenCalled();
});
it('refreshes runnability once after all group versions and the receipt commit, even if that sink fails',async () => {
  const f = await fixture(), request = await f.ready();
  const observed: unknown[] = [];
  const refresh = vi.fn(() => {
    observed.push([f.db.inTransaction,getInstalledPack(f.contracts,f.dependency.slug)!.version,getInstalledPack(f.contracts,f.manifest.slug)!.version]);
    throw new Error('fixture notification failure');
  });
  f.deps.recipeRunnabilityBroadcast = { recomputeAndEmit: refresh };
  const result = await f.apply(request); expect(result.applied).toBe(true); expect(refresh).toHaveBeenCalledTimes(1);
  expect(observed).toEqual([[false,3,2]]);
  expect((await f.apply(request)).receipt).toEqual(result.receipt); expect(refresh).toHaveBeenCalledTimes(1);
});
it.each(['packs','recipes','requirements'] as const)('bounds marketplace %s before fetching any recipe bodies',async limit => {
  const f = await fixture(), recipeRequests: string[] = [];
  if (limit === 'recipes') for (let index = 0; index < 18; index++) f.manifest.recipes.push({ slug: 'extra-recipe-' + index,version: 7 });
  for (let index = 0; index < (limit === 'packs' ? 7 : limit === 'requirements' ? 64 : 0); index++) {
    const dependency = { ...structuredClone(f.dependency),slug: 'market-limit-' + index,recipes: [{ slug: 'market-recipe-' + index,version: 7 }] };
    f.manifest.dependencies!.push({ type: 'pack',slug: dependency.slug,min_version: limit === 'requirements' ? 1 : 3 });
    writeFileSync(join(f.dir,dependency.slug + '.json'),JSON.stringify(dependency));
    recordPackInventory(f.contracts,{ pack_slug: dependency.slug,publisher: dependency.publisher,pack_version: 1,contents: [],installed_at: 1 });
  }
  f.deps.marketplaceFetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/packs/')) return new Response(JSON.stringify(f.manifest));
    recipeRequests.push(url.pathname);
    const recipe = { ...structuredClone(f.dependencyCandidate),recipe_id: url.pathname.slice('/recipes/'.length,-'.json'.length) };
    return new Response(JSON.stringify({ recipe_id: recipe.recipe_id,publisher_id: f.dependency.publisher,version: recipe.version,recipe }));
  };
  await expect(preparePackUpdate(f.deps,f.manifest.slug,'marketplace',recordsManifestReviewHash(f.manifest),{ includeDependencies: true }))
    .rejects.toMatchObject({ code: 'pack_update_limit' });
  expect(recipeRequests).toEqual([]); expect(f.updates.managed(f.manifest.slug)).toBe(false);
});
it('stages and applies marketplace-only dependency bodies without install counters',async () => {
  const f = await fixture(), markers: boolean[] = [];
  rmSync(join(f.dir,f.dependency.slug + '.json'));
  f.deps.marketplaceFetch = async (input,init) => {
    markers.push(new Headers(init?.headers).get(INSTALL_MANIFEST_MARKER_HEADER) === '1');
    const url = new URL(String(input));
    if (url.pathname.startsWith('/packs/')) return new Response(JSON.stringify(url.pathname.endsWith('/' + f.manifest.slug + '.json') ? f.manifest : f.dependency));
    const recipe = [...f.candidates,f.dependencyCandidate].find(recipe => url.pathname === '/recipes/' + recipe.recipe_id + '.json');
    return recipe ? new Response(JSON.stringify({ recipe_id: recipe.recipe_id,publisher_id: f.dependency.publisher,version: recipe.version,recipe })) : new Response('{}',{ status: 404 });
  };
  const request = { ...f.request(),source: 'marketplace' as const };
  const prepare = () => preparePackUpdate(f.deps,f.manifest.slug,'marketplace',request.expected_manifest_hash,{ includeDependencies: true });
  const staged = await f.updates.stage(request,f.client.actor,f.client.check,prepare); expect(staged.candidate!.packs).toHaveLength(2);
  const view = await f.qualify(), apply = { pack_slug: f.manifest.slug,expected_revision: view.revision,review_id: view.qualification!.review_id,request_id: crypto.randomUUID() };
  const result = await f.updates.applyGroup(apply,f.client.actor,f.client.check,prepare,(target,permit,at) => writePackUpdateGroup(target,f.deps,permit,at));
  expect(result.applied).toBe(true); expect(markers).toHaveLength(10); expect(markers.every(marked => !marked)).toBe(true);
});

it('stages every required upgrade without writes, preserves independent pack versions, and reserves the group',async () => {
  const f = await fixture(), staged = await f.stage();
  expect(staged.candidate!.packs).toEqual([
    { pack_slug: f.dependency.slug,name: f.dependency.name,installed_version: 1,version: 3,dependencies: [] },
    { pack_slug: f.manifest.slug,name: f.manifest.name,installed_version: 1,version: 2,dependencies: [f.dependency.slug] },
  ]);
  expect(staged.candidate!.recipes).toHaveLength(3);
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyActive);
  expect(f.updates.managed(f.dependency.slug)).toBe(true);
  await expect(f.updates.read(f.dependency.slug,f.client.actor,f.client.check)).rejects.toThrow('complete plan');
  expect(() => f.recipes.save(f.dependencyCandidate,f.dependency.publisher,'pair-sync',2,f.dependency.slug)).toThrow('staged update');
  expect(() => f.recipes.register(f.dependencyCandidate)).toThrow('staged update');
  expect(JSON.stringify(f.db.prepare('SELECT * FROM pack_update_tracks').all())).not.toContain(f.dependency.name);
});
it('applies the complete reviewed group once and releases its temporary dependency reservations',async () => {
  const f = await fixture(), request = await f.ready(), notifications: unknown[] = [];
  f.recipes.addOnMutated(() => notifications.push([getInstalledPack(f.contracts,f.manifest.slug)!.version,getInstalledPack(f.contracts,f.dependency.slug)!.version]));
  const result = await f.apply(request);
  expect(result.applied).toBe(true); expect(result.receipt.packs).toEqual([{ pack_slug: f.dependency.slug,version: 3 },{ pack_slug: f.manifest.slug,version: 2 }]);
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyCandidate);
  expect(notifications).toEqual([[2,3],[2,3],[2,3]]);
  expect((await f.apply(request)).receipt).toEqual(result.receipt); expect(notifications).toHaveLength(3);
  expect(f.updates.managed(f.dependency.slug)).toBe(false); expect(f.updates.managed(f.manifest.slug)).toBe(true);
  expect(f.db.prepare('SELECT * FROM pack_update_plan_packs').all()).toEqual([]);
  await expect(f.apply({ ...request,review_id: 'different' })).rejects.toThrow('request ID');
});
it('requires every dependency suite and refuses partial or changed test evidence',async () => {
  const f = await fixture(); await f.stage(); f.dependencyCandidate.steps[0] = { id: 'count',transform: 'count',input: [1] };
  // A fresh stage binds the changed dependency; its own suite must pass too.
  await f.stage(f.request(1)); expect((await f.qualify()).qualification).toBeNull();
  await f.store.remove({ recipe_id: f.dependencyCandidate.recipe_id,expected_revision: 1,request_id: crypto.randomUUID() },f.client.check);
  const started = await f.updates.beginTest(f.manifest.slug,2,f.client.check); expect(started.recipes).toHaveLength(3);
  expect((await f.store.read(f.dependencyCandidate.recipe_id,undefined,f.client.check)).version).toBeNull();
});
it.each(['candidate','suite','inventory','expired','owner','key'] as const)('holds the complete group if %s changes',async reason => {
  const f = await fixture(), request = await f.ready();
  if (reason === 'candidate') f.dependencyCandidate.ttl = 88;
  if (reason === 'suite') { const suite = regressionSuite(); suite.baseline = f.dependencyActive;
    await f.store.save({ recipe_id: f.dependencyActive.recipe_id,expected_revision: 1,request_id: crypto.randomUUID(),suite },f.client.check); }
  if (reason === 'inventory') { const prior = f.contracts.get('installed_pack',[f.dependency.slug])!.value as Record<string,unknown>;
    f.contracts.put('installed_pack',[f.dependency.slug],{ ...prior,installed_at: 100 }); }
  if (reason === 'expired') f.advance(900_001);
  if (reason === 'owner') f.client.actor = 'other';
  if (reason === 'key') f.state.locked = true;
  await expect(f.apply(request)).rejects.toThrow();
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyActive);
  expect(f.recipes.get(f.active[0]!.recipe_id)).toEqual(f.active[0]);
  expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(1);
});
it('rolls back recipes, versions, variable retirement, grants and the receipt on any write failure',async () => {
  const f = await fixture(); f.dependencyActive.variables = { removed: 'kept' }; f.recipes.save(f.dependencyActive,f.dependency.publisher,'pair-sync',1,f.dependency.slug);
  f.deps.grantEntryStore = createContractGrantEntryStore(f.contracts);
  const request = await f.ready(), beforeRetired = f.recipes.retiredVariables!(f.dependencyActive.recipe_id), before = f.contracts.scan('contract_grant'), notify = vi.fn(); f.recipes.addOnMutated(notify);
  const refresh = vi.fn(); f.deps.recipeRunnabilityBroadcast = { recomputeAndEmit: refresh };
  f.db.exec("CREATE TRIGGER fail_group_recipe BEFORE UPDATE ON recipes WHEN NEW.recipe_id='update-first' BEGIN SELECT RAISE(ABORT,'fixture group failure'); END");
  await expect(f.apply(request)).rejects.toThrow('fixture group failure');
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyActive); expect(f.recipes.retiredVariables!(f.dependencyActive.recipe_id)).toEqual(beforeRetired);
  expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(1); expect(f.contracts.scan('contract_grant')).toEqual(before);
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).last_apply).toBeUndefined(); expect(notify).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  f.db.exec('DROP TRIGGER fail_group_recipe'); expect((await f.apply(request)).applied).toBe(true);
});
it('rechecks authority after crypto and source resolution, before the first group write',async () => {
  const f = await fixture(), request = await f.ready(), seal = f.codec.seal.bind(f.codec);
  vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => { const encrypted = await seal(value); f.state.locked = true; return encrypted; });
  await expect(f.apply(request)).rejects.toMatchObject({ code: 'server_locked' });
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyActive);
});
it('keeps ordinary install and caller-supplied permits outside the group authority',async () => {
  const f = await fixture(), request = await f.ready(), target = await f.prepare();
  await expect(handlePacksInstall(f.deps,{ manifest: f.manifest,granted_permissions: ['install_bulk_pack'],regression_review_id: request.review_id }))
    .rejects.toMatchObject({ code: 'pack_update_required' });
  expect(() => writePackUpdateGroup(target,f.deps,{},1000)).toThrow('staged update');
  expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(1);
});
it('releases an abandoned plan without removing root protection or saved tests',async () => {
  const f = await fixture(), apply = await f.ready();
  const request = { pack_slug: f.manifest.slug,expected_revision: 1,request_id: crypto.randomUUID() };
  const released = await f.updates.releaseGroup(request,f.client.actor,f.client.check);
  expect(released).toMatchObject({ managed: true,revision: 2,candidate: null,qualification: null });
  expect(await f.updates.releaseGroup(request,f.client.actor,f.client.check)).toEqual(released);
  expect(f.updates.managed(f.dependency.slug)).toBe(false); expect(f.store.history(f.dependencyActive.recipe_id).head_revision).toBe(1);
  await expect(f.apply(apply)).rejects.toThrow();
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyActive);
  expect(() => f.recipes.save(f.candidates[0]!,f.manifest.publisher,'pair-sync',2,f.manifest.slug)).toThrow('staged update');
  expect((await f.stage(f.request(2))).candidate!.packs).toHaveLength(2);
});
it('preserves protection a dependency already had after the group commits',async () => {
  const f = await fixture(), request = { pack_slug: f.dependency.slug,source: 'bundled' as const,expected_revision: 0,
    expected_manifest_hash: recordsManifestReviewHash(f.dependency),request_id: crypto.randomUUID() };
  await f.updates.stage(request,f.client.actor,f.client.check,() => preparePackUpdate(f.deps,f.dependency.slug,'bundled',request.expected_manifest_hash));
  await f.apply(await f.ready()); expect(f.updates.managed(f.dependency.slug)).toBe(true);
  expect(() => f.recipes.save(f.dependencyCandidate,f.dependency.publisher,'pair-sync',2,f.dependency.slug)).toThrow('staged update');
  expect((await f.updates.read(f.dependency.slug,f.client.actor,f.client.check)).qualification).toBeNull();
});
it('deduplicates a shared transitive dependency and applies it before its dependants',async () => {
  const f = await fixture(), active = { ...regressionRecipe(),recipe_id: 'shared-recipe' }, candidate = { ...structuredClone(active),version: 2 };
  const shared: BulkPackManifest = { ...structuredClone(f.dependency),slug: 'shared-pack',name: 'Shared fixture pack',version: 2,recipes: [{ slug: active.recipe_id,version: 2 }] };
  f.recipes.save(active,shared.publisher,'pair-sync',1,shared.slug);
  recordPackInventory(f.contracts,{ pack_slug: shared.slug,publisher: shared.publisher,pack_version: 1,contents: [],installed_at: 1 });
  const suite = regressionSuite(); suite.baseline = active;
  await f.store.save({ recipe_id: active.recipe_id,expected_revision: 0,request_id: crypto.randomUUID(),suite },f.client.check);
  const get = f.recipes.getBundled.bind(f.recipes); f.recipes.getBundled = id => id === candidate.recipe_id ? candidate : get(id);
  writeFileSync(join(f.dir,shared.slug + '.json'),JSON.stringify(shared));
  f.dependency.dependencies = [{ type: 'pack',slug: shared.slug,min_version: 2 }]; f.putDependency();
  f.manifest.dependencies!.push({ type: 'pack',slug: shared.slug,min_version: 2 }); f.putManifest();
  const request = await f.ready(), view = await f.updates.read(f.manifest.slug,f.client.actor,f.client.check);
  expect(view.candidate!.packs!.map(pack => pack.pack_slug)).toEqual([shared.slug,f.dependency.slug,f.manifest.slug]);
  expect(view.qualification!.suites).toHaveLength(4);
  expect((await f.apply(request)).receipt.packs.map(pack => pack.pack_slug)).toEqual([shared.slug,f.dependency.slug,f.manifest.slug]);
});
it('refuses overlapping plans and holds the old proof when a dependency is uninstalled',async () => {
  const f = await fixture(), request = await f.ready();
  const next = { ...f.request(),pack_slug: f.dependency.slug,expected_manifest_hash: recordsManifestReviewHash(f.dependency) };
  await expect(f.updates.stage(next,f.client.actor,f.client.check,() => preparePackUpdate(f.deps,f.dependency.slug,'bundled',next.expected_manifest_hash)))
    .rejects.toThrow('complete plan');
  f.updates.retire(f.dependency.slug); f.contracts.delete('installed_pack',[f.dependency.slug]);
  await expect(f.apply(request)).rejects.toThrow();
  expect(f.updates.managed(f.manifest.slug)).toBe(true); expect(f.db.prepare('SELECT * FROM pack_update_plan_packs').all()).toEqual([]);
});
it('admits only one group apply while its source check is awaiting',async () => {
  const f = await fixture(), request = await f.ready(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const pending = f.updates.applyGroup(request,f.client.actor,f.client.check,async () => { entered(); await gate; return f.prepare(); },
    (target,permit,at) => writePackUpdateGroup(target,f.deps,permit,at));
  await started;
  try { await expect(f.apply(request)).rejects.toThrow('already applying');
    await expect(f.updates.releaseGroup({ pack_slug: f.manifest.slug,expected_revision: 1,request_id: crypto.randomUUID() },f.client.actor,f.client.check)).rejects.toThrow('apply'); }
  finally { release(); }
  expect((await pending).applied).toBe(true);
});
it('rejects a participant from another realm before it can mutate either realm',async () => {
  const f = await fixture(), other = await fixture(), request = await f.ready();
  f.deps.grantEntryStore = createContractGrantEntryStore(other.contracts);
  const before = other.contracts.scan('contract_grant');
  await expect(f.apply(request)).rejects.toThrow('same realm');
  expect(other.contracts.scan('contract_grant')).toEqual(before);
  expect(f.recipes.get(f.dependencyActive.recipe_id)).toEqual(f.dependencyActive);
  const foreign = createPackUpdateStore(f.db,f.codec,f.recipes,other.contracts,f.store,() => 1000);
  await expect(foreign.applyGroup(request,'owner',() => {},() => f.prepare(),() => {})).rejects.toThrow('same realm');
});
it('bounds the changed dependency graph before storing or resolving recipe bodies',async () => {
  const f = await fixture(); let previous = f.dependency;
  for (let index = 0; index < 7; index++) {
    const next = { ...structuredClone(f.dependency),slug: 'limit-pack-' + index,dependencies: [] };
    previous.dependencies = [{ type: 'pack',slug: next.slug,min_version: 3 }];
    writeFileSync(join(f.dir,previous.slug + '.json'),JSON.stringify(previous)); previous = next;
  }
  writeFileSync(join(f.dir,previous.slug + '.json'),JSON.stringify(previous));
  await expect(f.stage()).rejects.toMatchObject({ code: 'pack_update_limit' });
  expect(f.updates.managed(f.manifest.slug)).toBe(false); expect(f.db.prepare('SELECT * FROM pack_update_plan_packs').all()).toEqual([]);
});
it('keeps ten completion receipts across restages and refuses a pruned operation without writing',async () => {
  const f = await fixture(); let oldest: Awaited<ReturnType<typeof f.ready>> | undefined;
  const notifications = vi.fn(); f.recipes.addOnMutated(notifications);
  for (let index = 0; index < 11; index++) {
    await f.stage(f.request(index)); const view = await f.qualify();
    const request = { pack_slug: f.manifest.slug,expected_revision: index + 1,review_id: view.qualification!.review_id,request_id: crypto.randomUUID() };
    oldest ??= request; await f.apply(request);
    if (index < 10) {
      f.manifest.version++; f.dependency.version++; f.dependencyCandidate.version++; f.dependency.recipes[0]!.version++;
      f.candidates.forEach((recipe,index) => { recipe.version++; f.manifest.recipes[index]!.version++; });
      f.manifest.dependencies![0]!.min_version = f.dependency.version; f.putManifest(); f.putDependency();
    }
  }
  const row = f.db.prepare('SELECT encrypted FROM pack_update_tracks WHERE pack_slug=?').get(f.manifest.slug) as { encrypted: string };
  const envelope = await f.codec.open(row.encrypted) as { receipts: unknown[] }; expect(envelope.receipts).toHaveLength(10);
  expect(notifications).toHaveBeenCalledTimes(33); await expect(f.apply(oldest!)).rejects.toThrow(); expect(notifications).toHaveBeenCalledTimes(33);
});
it.each(['missing','membership','composition','cycle','floor'] as const)('holds an unsupported %s dependency plan before enrollment',async reason => {
  const f = await fixture();
  if (reason === 'missing') { f.contracts.delete('installed_pack',[f.dependency.slug]); }
  if (reason === 'membership') f.dependency.recipes.push({ slug: f.active[0]!.recipe_id,version: 2 });
  if (reason === 'composition') f.contracts.put('installed_pack',[f.dependency.slug],{ pack_slug: f.dependency.slug,publisher: f.dependency.publisher,version: '1',installed_at: 1,ingredient_ids: ['catalog'] });
  if (reason === 'cycle') f.dependency.dependencies = [{ type: 'pack',slug: f.manifest.slug,min_version: 2 }];
  if (reason === 'floor') f.dependency.min_recued_version = '999.1.1';
  f.putDependency(); await expect(f.stage()).rejects.toThrow();
  expect(f.updates.managed(f.manifest.slug)).toBe(false);
});
