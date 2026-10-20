import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regressionFixture,regressionRequest } from './recipe-regression-fixture.js';
const fixtures: ReturnType<typeof regressionFixture>[] = [], dirs: string[] = [];
const fixture = (file?: string) => { const f = regressionFixture(file); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); for (const dir of dirs.splice(0)) rmSync(dir,{ recursive: true,force: true }); });
const check = () => {};
it('persists encrypted immutable versions and reloads them in another database connection',async () => {
  const dir = mkdtempSync(join(tmpdir(),'recued-recipe-tests-')); dirs.push(dir); const path = join(dir,'realm.sqlite'), f = fixture(path);
  const request = regressionRequest(); request.suite.cases[0]!.sample.config = { private: 'private-fixture-marker' };
  const first = await f.store.save(request,check); expect(first.version).toMatchObject({ revision: 1,suite: request.suite });
  const dump = JSON.stringify(f.db.prepare('SELECT * FROM recipe_regression_versions').all()); expect(dump).not.toContain('private-fixture-marker'); expect(dump).not.toContain('Private test suite');
  f.close(); const reopened = fixture(path);
  expect(await reopened.store.read(request.recipe_id,1,check)).toEqual(first);
  const newer = await reopened.store.save({ ...request,expected_revision: 1,request_id: crypto.randomUUID(),suite: { ...request.suite,title: 'New version' } },check);
  expect(newer).toMatchObject({ head_revision: 2,version: { revision: 2 } });
  expect((await reopened.store.read(request.recipe_id,1,check)).version).toEqual(first.version);
});
it('deduplicates lost and simultaneous save replies and rejects request rebinding',async () => {
  const f = fixture(), request = regressionRequest();
  const [first,second] = await Promise.all([f.store.save(request,check),f.store.save(request,check)]);
  expect(first).toEqual(second); expect(f.store.history(request.recipe_id).head_revision).toBe(1);
  expect(await f.store.save(request,check)).toEqual(first);
  await expect(f.store.save({ ...request,suite: { ...request.suite,title: 'Different intent' } },check)).rejects.toMatchObject({ code: 'recipe_regression_conflict' });
  expect(f.db.prepare('SELECT count(*) FROM recipe_regression_versions').pluck().get()).toBe(1);
});
it('allows one winner for two different changes based on the same revision',async () => {
  const f = fixture(), request = regressionRequest();
  const results = await Promise.allSettled([f.store.save(request,check),f.store.save({ ...request,request_id: crypto.randomUUID() },check)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(f.store.history(request.recipe_id).head_revision).toBe(1);
});
it('retains only 20 versions while revisions remain monotonic across deletion',async () => {
  const f = fixture();
  for (let index = 0; index < 22; index++) await f.store.save(regressionRequest(index),check);
  expect(f.store.history('regression-test')).toMatchObject({ head_revision: 22,versions: expect.any(Array) });
  expect(f.store.history('regression-test').versions).toHaveLength(20);
  await expect(f.store.read('regression-test',1,check)).rejects.toBeDefined();
  const deletion = { recipe_id: 'regression-test',expected_revision: 22,request_id: crypto.randomUUID() };
  expect(f.store.remove(deletion,check)).toEqual({ head_revision: 23,versions: [],version: null });
  expect(f.store.remove(deletion,check)).toEqual({ head_revision: 23,versions: [],version: null });
  expect(await f.store.read('regression-test',undefined,check)).toEqual({ head_revision: 23,versions: [],version: null });
  await expect(f.store.save(regressionRequest(0),check)).rejects.toBeDefined();
  expect((await f.store.save(regressionRequest(23),check)).version!.revision).toBe(24);
});
it.each(['seal','open'] as const)('rechecks authority after %s yields',async method => {
  const f = fixture(), request = regressionRequest(); let admitted = true;
  const validate = () => { if (!admitted) throw new Error('Device was revoked'); };
  if (method === 'open') await f.store.save(request,validate);
  if (method === 'seal') {
    const original = f.codec.seal.bind(f.codec);
    vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => { const result = await original(value); admitted = false; return result; });
    await expect(f.store.save(request,validate)).rejects.toThrow('Device was revoked');
    expect(f.store.history(request.recipe_id).head_revision).toBe(0);
  } else {
    const original = f.codec.open.bind(f.codec);
    vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const result = await original(value); admitted = false; return result; });
    await expect(f.store.read(request.recipe_id,1,validate)).rejects.toThrow('Device was revoked');
  }
});
it('refuses a deleted snapshot after decryption and never returns its private case values',async () => {
  const f = fixture(), request = regressionRequest(); await f.store.save(request,check);
  const open = f.codec.open.bind(f.codec);
  vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const result = await open(value);
    f.store.remove({ recipe_id: request.recipe_id,expected_revision: 1,request_id: crypto.randomUUID() },check); return result; });
  await expect(f.store.read(request.recipe_id,1,check)).rejects.toBeDefined();
  expect(await f.store.read(request.recipe_id,undefined,check)).toMatchObject({ version: null });
});
it('does not pair an old latest-version body with a newer head after decryption yields',async () => {
  const f = fixture(), request = regressionRequest(); await f.store.save(request,check);
  const open = f.codec.open.bind(f.codec);
  vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const result = await open(value);
    await f.store.save(regressionRequest(1),check); return result; });
  await expect(f.store.read(request.recipe_id,undefined,check)).rejects.toMatchObject({ code: 'recipe_regression_conflict' });
  expect(await f.store.read(request.recipe_id,1,check)).toMatchObject({ head_revision: 2,version: { revision: 1 } });
  expect(await f.store.read(request.recipe_id,undefined,check)).toMatchObject({ head_revision: 2,version: { revision: 2 } });
});
it('refuses swapped ciphertext and proof metadata, and cannot save or read while locked',async () => {
  const f = fixture(), request = regressionRequest(); await f.store.save(request,check); await f.store.save(regressionRequest(1),check);
  f.db.prepare('UPDATE recipe_regression_versions SET encrypted=(SELECT encrypted FROM recipe_regression_versions WHERE revision=2) WHERE revision=1').run();
  await expect(f.store.read(request.recipe_id,1,check)).rejects.toBeDefined();
  f.db.prepare("UPDATE recipe_regression_versions SET request_hash='changed' WHERE revision=2").run();
  await expect(f.store.read(request.recipe_id,2,check)).rejects.toBeDefined();
  f.state.locked = true;
  await expect(f.store.read(request.recipe_id,undefined,check)).rejects.toMatchObject({ code: 'server_locked' });
  await expect(f.store.save(regressionRequest(2),check)).rejects.toMatchObject({ code: 'server_locked' });
  expect(() => f.store.remove({ recipe_id: request.recipe_id,expected_revision: 2,request_id: crypto.randomUUID() },check)).toThrow();
});
it('checks idempotency before the live-suite limit and rejects another suite without a partial save',async () => {
  const f = fixture(), request = regressionRequest(), first = await f.store.save(request,check);
  const insert = f.db.prepare('INSERT INTO recipe_regression_heads VALUES(?,1,0,?,?)');
  for (let index = 0; index < 99; index++) insert.run('other-' + index,'request-' + index,'hash');
  expect(await f.store.save(request,check)).toEqual(first);
  const extra = regressionRequest(); extra.recipe_id = 'overflow'; extra.suite.baseline.recipe_id = 'overflow';
  await expect(f.store.save(extra,check)).rejects.toMatchObject({ code: 'recipe_regression_limit' });
  expect(f.store.history('overflow')).toEqual({ head_revision: 0,versions: [] });
});
it('rolls history pruning back if the retained encrypted-byte limit rejects a save',async () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) await f.store.save(regressionRequest(index),check);
  f.db.prepare("INSERT INTO recipe_regression_versions VALUES('quota-fixture',1,'hash',CAST(zeroblob(32000000) AS TEXT),0,'quota-request','hash')").run();
  await expect(f.store.save(regressionRequest(20),check)).rejects.toMatchObject({ code: 'recipe_regression_limit' });
  expect(f.store.history('regression-test').head_revision).toBe(20);
  expect((await f.store.read('regression-test',1,check)).version!.revision).toBe(1);
});
