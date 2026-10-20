import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECIPE_RELEASE_LIMITS, type RecipeReleaseActivate } from '@recued/contracts';
import { runRecipeRegression } from '@recued/engine';
import { createRecipeStore } from '../recipe-store.js';
import { assertRecipeAuthoringGates } from '../recipe-save-handler.js';
import { createRecipeReleaseStore } from '../storage/recipe-release-store.js';
import { recipeReleaseDigest as digest } from '../storage/recipe-release-authority.js';
import { regressionFixture, regressionRecipe, regressionRequest } from './recipe-regression-fixture.js';

const fixtures: Array<{ close(): void }> = [];
const check = () => {}, actor = 'paired-owner';
const fixture = async () => {
  const f = regressionFixture(), recipes = createRecipeStore('/no-community',f.db), active = regressionRecipe();
  recipes.save(active,'owner','inline'); await f.store.save(regressionRequest(),check);
  let time = 1000;
  const releases = createRecipeReleaseStore(f.db,f.codec,recipes,f.store,recipe => { assertRecipeAuthoringGates({},recipe); },() => time);
  const value = { ...f,recipes,releases,active,advance: (ms: number) => { time += ms; } }; fixtures.push(value); return value;
};
afterEach(async () => { for (const pending of fixtures.splice(0)) (await pending).close(); vi.restoreAllMocks(); });
const draft = async (f: Awaited<ReturnType<typeof fixture>>, revision = 0, length = 1) => {
  const candidate = regressionRecipe(); candidate.steps[0] = { id: 'count',transform: 'count',input: Array(length).fill(1) };
  return f.releases.save({ recipe_id: candidate.recipe_id,expected_revision: revision,expected_active_digest: digest(f.recipes.get(candidate.recipe_id)),
    request_id: crypto.randomUUID(),candidate },actor,check);
};
const qualify = async (f: Awaited<ReturnType<typeof fixture>>, revision: number) => {
  const state = await f.releases.read(f.active.recipe_id,actor,check), candidate = await f.releases.beginTest(f.active.recipe_id,revision,state.draft!.revision,check);
  const suite = (await f.store.read(f.active.recipe_id,undefined,check)).version!;
  const result = await runRecipeRegression(suite.suite,candidate.recipe);
  return f.releases.qualify(f.active.recipe_id,revision,candidate.revision,{ ...result,recipe_id: f.active.recipe_id,revision: suite.revision,
    suite_digest: suite.digest,baseline_hash: digest(suite.suite.baseline),candidate_hash: candidate.digest },candidate.test_attempt,actor,check);
};
const ready = async (f: Awaited<ReturnType<typeof fixture>>, revision: number): Promise<RecipeReleaseActivate> => {
  const state = await qualify(f,revision); expect(state.qualification).not.toBeNull();
  const review = await f.releases.prepare({ recipe_id: f.active.recipe_id,expected_revision: revision,draft_revision: state.draft!.revision,receipt_id: state.qualification!.receipt_id },actor,check);
  return { recipe_id: f.active.recipe_id,expected_revision: revision,review_id: review.review_id,request_id: crypto.randomUUID() };
};
it('saves private drafts without changing the active recipe and blocks every ordinary recipe writer',async () => {
  const f = await fixture(), saved = await draft(f);
  expect(f.recipes.get(f.active.recipe_id)).toEqual(f.active); expect(saved.draft!.recipe).not.toEqual(f.active);
  expect(JSON.stringify(f.db.prepare('SELECT * FROM recipe_release_tracks').all())).not.toContain('Fixture comparisons.');
  expect(() => f.recipes.save(saved.draft!.recipe,'owner','inline')).toThrow('reviewed releases');
  expect(() => f.recipes.register(saved.draft!.recipe)).toThrow('reviewed releases');
  expect(() => f.recipes.compareAndSaveLocalRecipe!({ recipe: saved.draft!.recipe,expected_recipe_json: JSON.stringify(f.active) })).toThrow('reviewed releases');
  expect(() => f.recipes.compareAndSaveLocalRecipe!({ recipe: saved.draft!.recipe,expected_recipe_json: JSON.stringify(f.active),release: { permit: {},commit: check } })).toThrow('reviewed releases');
});
it('snapshots the candidate and request identity before private loading can yield',async () => {
  const f = await fixture(), candidate = regressionRecipe();
  const request = { recipe_id: candidate.recipe_id,expected_revision: 0,expected_active_digest: digest(f.active),request_id: crypto.randomUUID(),candidate };
  const snapshot = structuredClone(request), pending = f.releases.save(request,actor,check);
  request.candidate.ttl = 50; request.request_id = crypto.randomUUID();
  const saved = await pending; expect(saved.saved_draft!.recipe).toEqual(snapshot.candidate);
  expect(await f.releases.save(snapshot,actor,check)).toEqual(saved);
});
it('requires passing assertions, the latest suite and a fresh review before activation',async () => {
  const f = await fixture(); await draft(f);
  expect((await qualify(f,1)).qualification).toBeNull();
  await expect(f.releases.prepare({ recipe_id: f.active.recipe_id,expected_revision: 1,draft_revision: 1,receipt_id: 'forged' },actor,check)).rejects.toMatchObject({ code: 'recipe_release_conflict' });
  // Explicit expectations accept the intentional change; the baseline is updated too.
  const request = regressionRequest(1); request.suite.baseline.steps[0] = { id: 'count',transform: 'count',input: [1] };
  request.suite.cases[0]!.assertions[1] = { kind: 'value',phase: 'sequential',step_id: 'count',field: 'output',path: [],expected: 1 };
  await f.store.save(request,check); const activation = await ready(f,1);
  const signal = vi.fn(() => expect(f.db.prepare('SELECT revision FROM recipe_release_tracks').pluck().get()).toBe(2)); f.recipes.addOnMutated(signal);
  const result = await f.releases.activate(activation,actor,check);
  expect(result.activated!.sequence).toBe(2); expect(f.recipes.get(f.active.recipe_id)).toEqual(result.activated!.recipe); expect(signal).toHaveBeenCalledTimes(1);
  expect((await f.releases.activate(activation,actor,check)).activated).toEqual(result.activated); expect(signal).toHaveBeenCalledTimes(1);
  const restored = await f.releases.save({ recipe_id: f.active.recipe_id,expected_revision: 2,expected_active_digest: result.active!.digest,request_id: crypto.randomUUID(),sequence: 1 },actor,check);
  expect(restored.draft!.recipe).toEqual(f.active); expect(f.recipes.get(f.active.recipe_id)).toEqual(result.activated!.recipe); expect(restored.qualification).toBeNull();
});
it.each(['draft','suite','expiry','qualification_expiry','actor'] as const)('rejects an activation after %s changes',async change => {
  const f = await fixture(); await draft(f,0,0); const activation = await ready(f,1);
  if (change === 'draft') await draft(f,1,2);
  if (change === 'suite') await f.store.save(regressionRequest(1),check);
  if (change === 'expiry') f.advance(RECIPE_RELEASE_LIMITS.review_ms + 1);
  if (change === 'qualification_expiry') f.advance(RECIPE_RELEASE_LIMITS.qualification_ms + 1);
  await expect(f.releases.activate(activation,change === 'actor' ? 'another-device' : actor,check)).rejects.toMatchObject({ code: 'recipe_release_conflict' });
  expect(f.recipes.get(f.active.recipe_id)).toEqual(f.active);
});
it('rechecks crypto replies, owner authority and the original active body before committing drafts',async () => {
  const f = await fixture(), original = f.codec.seal.bind(f.codec);
  vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => { const sealed = await original(value); f.recipes.save({ ...f.active,ttl: 10 },'owner','inline'); return sealed; });
  await expect(draft(f)).rejects.toMatchObject({ code: 'recipe_release_conflict' });
  expect((await f.releases.read(f.active.recipe_id,actor,check)).managed).toBe(false);
  await draft(f); let admitted = true; const open = f.codec.open.bind(f.codec);
  vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const sealed = await open(value); admitted = false; return sealed; });
  await expect(f.releases.read(f.active.recipe_id,actor,() => { if (!admitted) throw new Error('Revoked'); })).rejects.toThrow('Revoked');
});
it('rolls the active recipe and release history back together on a finalizer failure',async () => {
  const f = await fixture(); await draft(f,0,0); const activation = await ready(f,1);
  f.db.exec("CREATE TRIGGER fail_release_update BEFORE UPDATE ON recipe_release_tracks BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END");
  const mutated = vi.fn(); f.recipes.addOnMutated(mutated);
  await expect(f.releases.activate(activation,actor,check)).rejects.toThrow('fixture commit failure');
  expect(f.recipes.get(f.active.recipe_id)).toEqual(f.active); expect(mutated).not.toHaveBeenCalled();
  expect((await f.releases.read(f.active.recipe_id,actor,check)).revision).toBe(1);
});
it('supports stable save retries, one concurrent winner, retention and deletion tombstones',async () => {
  const f = await fixture(), candidate = f.active, request = { recipe_id: candidate.recipe_id,expected_revision: 0,expected_active_digest: digest(candidate),request_id: crypto.randomUUID(),candidate };
  const first = await f.releases.save(request,actor,check); expect(await f.releases.save(request,actor,check)).toEqual(first);
  const choices = await Promise.allSettled([draft(f,1,1),draft(f,1,2)]); expect(choices.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  for (let revision = 2; revision < 23; revision++) await draft(f,revision,0);
  expect((await f.releases.read(candidate.recipe_id,actor,check)).drafts).toHaveLength(20);
  expect(f.recipes.delete(candidate.recipe_id)).toBe(true);
  expect(f.db.prepare('SELECT revision,deleted,encrypted FROM recipe_release_tracks').get()).toEqual({ revision: 24,deleted: 1,encrypted: '' });
  f.recipes.save(candidate,'owner','inline');
  await expect(f.releases.save(request,actor,check)).rejects.toMatchObject({ code: 'recipe_release_conflict' });
});
it('refuses quota overflow without advancing the saved draft or changing the active recipe',async () => {
  const f = await fixture(); const first = await draft(f,0,0);
  f.db.prepare("INSERT INTO recipe_release_tracks VALUES('quota',1,'hash',1,0,CAST(zeroblob(32000000) AS TEXT),'')").run();
  await expect(draft(f,1,1)).rejects.toMatchObject({ code: 'recipe_release_limit' });
  expect((await f.releases.read(f.active.recipe_id,actor,check)).draft).toEqual(first.draft);
  expect(f.recipes.get(f.active.recipe_id)).toEqual(f.active);
});
it('keeps draft history and activation retry receipts across a database reopen',async () => {
  const directory = mkdtempSync(join(tmpdir(),'recued-release-reopen-')), path = join(directory,'realm.sqlite');
  let f = regressionFixture(path);
  try {
    const recipes = createRecipeStore('/no-community',f.db), active = regressionRecipe(); recipes.save(active,'owner','inline');
    await f.store.save(regressionRequest(),check);
    let releases = createRecipeReleaseStore(f.db,f.codec,recipes,f.store,recipe => { assertRecipeAuthoringGates({},recipe); });
    await releases.save({ recipe_id: active.recipe_id,expected_revision: 0,expected_active_digest: digest(active),request_id: 'persistent-draft',candidate: active },actor,check);
    const tested = await releases.beginTest(active.recipe_id,1,1,check), suite = (await f.store.read(active.recipe_id,undefined,check)).version!;
    const comparison = await runRecipeRegression(suite.suite,tested.recipe);
    const qualified = await releases.qualify(active.recipe_id,1,1,{ ...comparison,recipe_id: active.recipe_id,revision: suite.revision,
      suite_digest: suite.digest,baseline_hash: digest(suite.suite.baseline),candidate_hash: tested.digest },tested.test_attempt,actor,check);
    const review = await releases.prepare({ recipe_id: active.recipe_id,expected_revision: 1,draft_revision: 1,receipt_id: qualified.qualification!.receipt_id },actor,check);
    const activation = { recipe_id: active.recipe_id,expected_revision: 1,review_id: review.review_id,request_id: 'persistent-activation' };
    const activated = await releases.activate(activation,actor,check);
    const before = await releases.read(active.recipe_id,actor,check); f.close(); f = regressionFixture(path);
    const reopened = createRecipeStore('/no-community',f.db); releases = createRecipeReleaseStore(f.db,f.codec,reopened,f.store,recipe => { assertRecipeAuthoringGates({},recipe); });
    expect(await releases.read(active.recipe_id,actor,check)).toEqual(before);
    expect((await releases.activate(activation,actor,check)).activated).toEqual(activated.activated);
    expect(() => reopened.save({ ...active,ttl: 50 },'owner','inline')).toThrow('reviewed releases');
  } finally { f.close(); rmSync(directory,{ recursive: true,force: true }); }
});
