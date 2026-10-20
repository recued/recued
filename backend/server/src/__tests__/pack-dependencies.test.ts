import { afterEach,expect,it } from 'vitest';
import { packRemovalFixture } from './pack-removal-fixture.js';
import { capturePackDependencies,packDependencyGraph,readPackDependencies } from '../pack-dependencies.js';
const closes: Array<() => void> = [];afterEach(() => { for (const close of closes.splice(0)) close(); });
const fixture = async () => { const f = await packRemovalFixture();closes.push(f.close);return f; };
it('distinguishes unknown older inventory from observed dependency-free manifests',async () => {
  const f = await fixture();f.install('older');f.install('observed',[]);
  expect(readPackDependencies(f.contracts.get('installed_pack',['older'])!)).toBeNull();
  expect(readPackDependencies(f.contracts.get('installed_pack',['observed'])!)).toEqual({ schema_version: 1,dependencies: [] });
  expect(packDependencyGraph(f.contracts).unknown.map(pack => pack.pack_slug)).toEqual(['older']);
});
it('captures the actual dependency identity/version and keeps declarations after catalog changes',async () => {
  const f = await fixture();f.install('provider',[]);f.install('consumer',[{ type: 'pack',slug: 'provider',min_version: 1 }]);
  const snapshot = readPackDependencies(f.contracts.get('installed_pack',['consumer'])!)!;
  expect(snapshot.dependencies[0]).toEqual({ type: 'pack',slug: 'provider',min_version: 1,installed: [{ inventory_key: 'provider',publisher: 'recued-core',version: 1 }] });
  expect(packDependencyGraph(f.contracts).dependants(['provider'])).toMatchObject([{ pack_slug: 'consumer',direct: true,via: ['provider'] }]);
  expect(capturePackDependencies(f.contracts,[])).toEqual({ schema_version: 1,dependencies: [] });
});
it('finds transitive dependants without looping on cycles',async () => {
  const f = await fixture();f.install('a',[]);f.install('b',[{ type: 'pack',slug: 'a' },{ type: 'pack',slug: 'c' }]);f.install('c',[{ type: 'pack',slug: 'b' }]);
  expect(packDependencyGraph(f.contracts).dependants(['a'])).toMatchObject([{ pack_slug: 'b',direct: true },{ pack_slug: 'c',direct: false,via: ['b','a'] }]);
});
it('keeps shared ingredient alternatives available until their last provider is removed',async () => {
  const f = await fixture();f.install('one',[],['shared']);f.install('two',[],['shared']);f.install('consumer',[{ type: 'ingredient',ingredient_id: 'shared' }]);
  expect(packDependencyGraph(f.contracts).dependants(['one'])).toEqual([]);
  expect(packDependencyGraph(f.contracts).dependants(['one','two'])).toMatchObject([{ pack_slug: 'consumer',direct: true }]);
});
it('does not treat another provider as required when the consumer owns the ingredient itself',async () => {
  const f = await fixture();f.install('one',[],['shared']);f.install('consumer',[{ type: 'ingredient',slug: 'shared' }],['shared']);
  expect(packDependencyGraph(f.contracts).dependants(['one'])).toEqual([]);
});
it('binds an observed Records dependency to its installed full identity',async () => {
  const f = await fixture();f.install('records-first',[],[],'publisher-one','shared-records');f.install('consumer',[{ type: 'pack',slug: 'shared-records' }]);
  f.install('records-second',[],[],'publisher-two','shared-records');
  expect(packDependencyGraph(f.contracts).dependants(['records-first'])).toMatchObject([{ pack_slug: 'consumer' }]);
  expect(packDependencyGraph(f.contracts).dependants(['records-second'])).toEqual([]);
});
it('treats malformed persisted evidence as unknown rather than declaring it dependency-free',async () => {
  const f = await fixture();f.install('broken',[]);const row = f.contracts.get('installed_pack',['broken'])!;
  f.contracts.put('installed_pack',['broken'],{ ...row.value as object,dependency_snapshot: { schema_version: 1,dependencies: [{ type: 'pack',slug: '',installed: [] }] } });
  expect(packDependencyGraph(f.contracts).unknown.map(pack => pack.pack_slug)).toContain('broken');
});
it('records oversized declaration lists as unknown without leaving stale older evidence',async () => {
  const f = await fixture();f.install('large',[]);f.install('large',Array.from({ length: 257 },(_,i) => ({ type: 'pack',slug: 'dependency-'+i })));
  expect(readPackDependencies(f.contracts.get('installed_pack',['large'])!)).toBeNull();expect(packDependencyGraph(f.contracts).unknown.map(pack => pack.pack_slug)).toContain('large');
});
