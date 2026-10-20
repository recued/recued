import { afterEach,expect,it,vi } from 'vitest';
import { PACK_RELEASE_LIMITS,OWNER_CONTRACT_ID,recipeGrantEntry } from '@recued/contracts';
import { packUpdatePlanFixture } from './pack-update-plan-fixture.js';
import { preparePackRestore } from '../pack-install-handler.js';
import { writePackUpdateGroup } from '../pack-update-plan.js';
import { getInstalledPack,recordPackInventory } from '../pack-inventory.js';
import { regressionSuite } from './recipe-regression-fixture.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });
const fixture = async () => {
  const f = await packUpdatePlanFixture(); cleanups.push(f.close);
  const upgrade = () => {
    f.manifest.version++; f.dependency.version++; f.dependencyCandidate.version++; f.dependency.recipes[0]!.version++;
    f.candidates.forEach((recipe,index) => { recipe.version++; f.manifest.recipes[index]!.version++; });
    f.manifest.dependencies![0]!.min_version = f.dependency.version; f.putManifest(); f.putDependency();
  };
  const twoReleases = async () => {
    const first = await f.apply(await f.ready()); upgrade();
    await f.stage(f.request(first.revision)); const proof = await f.qualify();
    const second = await f.apply({ pack_slug: f.manifest.slug,expected_revision: proof.revision,review_id: proof.qualification!.review_id,request_id: crypto.randomUUID() });
    return { first,second,restore: { pack_slug: f.manifest.slug,release_id: first.receipt.release_id!,expected_revision: second.revision,request_id: crypto.randomUUID() } };
  };
  const stageRestore = (request: Parameters<typeof f.updates.stageRestore>[0]) => f.updates.stageRestore(request,f.client.actor,f.client.check,target => preparePackRestore(f.deps,target));
  const applyRestore = (request: Parameters<typeof f.apply>[0]) => f.updates.applyGroup(request,f.client.actor,f.client.check,
    async (target,restore) => { expect(restore).toBe(true); return preparePackRestore(f.deps,target); },
    (target,permit,at) => writePackUpdateGroup(target,f.deps,permit,at));
  const readyRestore = async () => {
    const releases = await twoReleases(); await stageRestore(releases.restore); const tested = await f.qualify();
    return { ...releases,apply: { pack_slug: f.manifest.slug,expected_revision: tested.revision,review_id: tested.qualification!.review_id,request_id: crypto.randomUUID() } };
  };
  return { ...f,upgrade,twoReleases,stageRestore,applyRestore,readyRestore };
};
it('retains immutable encrypted manifests, bodies and versions only with a completed group apply',async () => {
  const f = await fixture(); expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).releases).toBeUndefined();
  const applied = await f.apply(await f.ready()); expect(applied.releases).toHaveLength(1);
  expect(applied.releases![0]).toMatchObject({ release_id: applied.receipt.release_id,sequence: 1,current: true,
    packs: [{ pack_slug: f.dependency.slug,version: 3 },{ pack_slug: f.manifest.slug,version: 2 }] });
  const row = f.db.prepare('SELECT encrypted FROM pack_release_history').get() as { encrypted: string };
  expect(row.encrypted).not.toContain(f.manifest.name);
  const opened = await f.codec.open(row.encrypted) as { releases: Array<{ target: { manifest: unknown; recipes: unknown[] } }> };
  expect(opened.releases[0]!.target.manifest).toEqual(f.manifest);
  expect(opened.releases[0]!.target.recipes).toHaveLength(2);
  f.manifest.name = 'Changed remote artifact'; f.candidates[0]!.ttl = 999;
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).releases![0]).toEqual(applied.releases![0]);
  await expect(f.apply({ pack_slug: f.manifest.slug,expected_revision: applied.revision,review_id: 'old',request_id: applied.receipt.request_id })).rejects.toThrow('request ID');
});
it('stages retained artifacts without installed writes and requires fresh tests before an atomic restore',async () => {
  const f = await fixture(), { first,second,restore } = await f.twoReleases();
  f.deps.packDir = '/no-current-catalog'; f.deps.marketplaceFetch = vi.fn(async () => { throw new Error('No remote fetch during restore'); });
  const staged = await f.stageRestore(restore); expect(staged.qualification).toBeNull(); expect(staged.candidate!.restore!.release_id).toBe(first.receipt.release_id);
  expect(staged.candidate!.packs!.map(pack => [pack.installed_version,pack.version])).toEqual([[4,3],[3,2]]);
  expect(getInstalledPack(f.contracts,f.manifest.slug)!.version).toBe(3);
  await expect(f.applyRestore({ pack_slug: f.manifest.slug,expected_revision: staged.revision,review_id: 'old',request_id: crypto.randomUUID() })).rejects.toThrow();
  expect(await f.stageRestore(restore)).toEqual(staged);
  const tested = await f.qualify(), request = { pack_slug: f.manifest.slug,expected_revision: tested.revision,review_id: tested.qualification!.review_id,request_id: crypto.randomUUID() };
  const result = await f.applyRestore(request); expect(result.applied).toBe(true); expect(result.receipt.restored_release_id).toBe(first.receipt.release_id);
  expect(result.releases).toHaveLength(3); expect(result.releases![0]!.sequence).toBe(3); expect(result.releases![0]!.current).toBe(true);
  expect(getInstalledPack(f.contracts,f.manifest.slug)!.version).toBe(2); expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(3);
  expect(f.deps.marketplaceFetch).not.toHaveBeenCalled(); expect((await f.applyRestore(request)).receipt).toEqual(result.receipt);
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).releases).toHaveLength(3);
  await expect(f.apply({ pack_slug: f.manifest.slug,expected_revision: second.revision,review_id: 'wrong',request_id: second.receipt.request_id })).rejects.toThrow('request ID');
});
it.each(['suite','expiry','owner','key','outside inventory','history'] as const)('holds a restore if %s changes after qualification',async reason => {
  const f = await fixture(), ready = await f.readyRestore();
  if (reason === 'suite') await f.store.save({ recipe_id: f.dependencyActive.recipe_id,expected_revision: 1,request_id: crypto.randomUUID(),suite: { ...regressionSuite(),baseline: f.dependencyActive } },f.client.check);
  if (reason === 'expiry') f.advance(900_001);
  if (reason === 'owner') f.client.actor = 'other-owner';
  if (reason === 'key') f.state.locked = true;
  if (reason === 'outside inventory') recordPackInventory(f.contracts,{ pack_slug: 'new-dependant',publisher: 'recued-core',pack_version: 1,contents: [],installed_at: 1 });
  if (reason === 'history') f.db.prepare('UPDATE pack_release_history SET revision=revision+1 WHERE pack_slug=?').run(f.manifest.slug);
  await expect(f.applyRestore(ready.apply)).rejects.toThrow();
  expect(getInstalledPack(f.contracts,f.manifest.slug)!.version).toBe(3); expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(4);
});
it('refuses old releases after surrounding pack changes and never reconstructs missing history',async () => {
  const f = await fixture(), ready = await f.twoReleases();
  recordPackInventory(f.contracts,{ pack_slug: 'new-dependant',publisher: 'recued-core',pack_version: 1,contents: [],installed_at: 1 });
  await expect(f.stageRestore(ready.restore)).rejects.toThrow('surrounding');
  await expect(f.stageRestore({ ...ready.restore,release_id: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
  expect(getInstalledPack(f.contracts,f.manifest.slug)!.version).toBe(3);
});
it('rolls back release capture, recipes and the completion receipt together',async () => {
  const f = await fixture(), ready = await f.readyRestore(), before = f.db.prepare('SELECT * FROM pack_release_history').all();
  f.db.exec("CREATE TRIGGER fail_release BEFORE UPDATE ON pack_release_history BEGIN SELECT RAISE(ABORT,'release capture failed'); END");
  await expect(f.applyRestore(ready.apply)).rejects.toThrow('release capture failed');
  expect(f.db.prepare('SELECT * FROM pack_release_history').all()).toEqual(before);
  expect(getInstalledPack(f.contracts,f.manifest.slug)!.version).toBe(3);
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).last_apply!.request_id).not.toBe(ready.apply.request_id);
  f.db.exec('DROP TRIGGER fail_release'); expect((await f.applyRestore(ready.apply)).applied).toBe(true);
});
it('bounds retained release ciphertext before applying and leaves the installed group intact',async () => {
  const f = await fixture(), request = await f.ready();
  f.db.prepare("INSERT INTO pack_release_history VALUES('quota',1,CAST(zeroblob(?) AS TEXT))").run(PACK_RELEASE_LIMITS.retained_bytes);
  await expect(f.apply(request)).rejects.toMatchObject({ code: 'pack_update_limit' });
  expect(getInstalledPack(f.contracts,f.manifest.slug)!.version).toBe(1);
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).last_apply).toBeUndefined();
});
it('explicit uninstall purges the private release artifacts and old restore requests cannot revive them',async () => {
  const f = await fixture(), ready = await f.twoReleases(); f.updates.retire(f.manifest.slug);
  expect(f.db.prepare('SELECT * FROM pack_release_history').all()).toEqual([]);
  expect((await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).releases).toBeUndefined();
  await expect(f.stageRestore(ready.restore)).rejects.toThrow();
});
it('preserves an explicit grant revoke through a restore',async () => {
  const f = await fixture(), grants = createContractGrantEntryStore(f.contracts); f.deps.grantEntryStore = grants;
  const entry = recipeGrantEntry(f.dependency.publisher,f.dependencyActive.recipe_id); grants.set(OWNER_CONTRACT_ID,entry,false,1);
  const ready = await f.readyRestore(); await f.applyRestore(ready.apply);
  expect(grants.get(OWNER_CONTRACT_ID,entry)).toBe(false);
});
it('keeps the newest ten immutable releases and monotonic sequences across forward applies',async () => {
  const f = await fixture(); let revision = 0;
  for (let index = 0; index < 11; index++) {
    await f.stage(f.request(revision)); const tested = await f.qualify();
    const result = await f.apply({ pack_slug: f.manifest.slug,expected_revision: tested.revision,review_id: tested.qualification!.review_id,request_id: crypto.randomUUID() });
    revision = result.revision; if (index < 10) f.upgrade();
  }
  const history = (await f.updates.read(f.manifest.slug,f.client.actor,f.client.check)).releases!;
  expect(history).toHaveLength(10); expect(history.map(release => release.sequence)).toEqual([11,10,9,8,7,6,5,4,3,2]);
});
