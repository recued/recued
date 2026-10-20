import { afterEach,expect,it,vi } from 'vitest';
import { packRemovalFixture,installRemovalRecords as installRecords } from './pack-removal-fixture.js';
import { getInstalledPack,removePackInventory } from '../pack-inventory.js';
const closes: Array<() => void> = [];afterEach(() => { for (const close of closes.splice(0)) close();vi.restoreAllMocks(); });
const fixture = async () => { const f = await packRemovalFixture();closes.push(f.close);return f; };
it('reviews local inventory without deleting and reuses exact review request identities',async () => {
  const f = await fixture(),request = f.request(),plan = await f.review(request);
  expect(plan.pack.version).toBe(1);expect(plan.recipes).toHaveLength(2);expect(plan.blockers).toEqual([]);
  expect(f.recipes.listForPack(f.manifest.slug)).toHaveLength(2);expect(await f.review(request)).toEqual(plan);
  await expect(f.review({ ...request,pack_slug: 'other' })).rejects.toThrow('request ID');
  expect((f.db.prepare('SELECT encrypted FROM pack_removal_reviews').pluck().get() as string)).not.toContain(f.actor);
});
it('removes once and recovers a completed receipt after a lost reply',async () => {
  const f = await fixture(),plan = await f.review(),request = { review_id: plan.review_id,request_id: crypto.randomUUID() },execute = vi.fn(f.execute);
  const result = await f.removals.apply(request,f.actor,f.check,execute);
  expect(result.receipt.result.ok).toBe(true);expect(getInstalledPack(f.contracts,f.manifest.slug)).toBeNull();expect(f.recipes.listForPack(f.manifest.slug)).toEqual([]);
  expect(await f.removals.apply(request,f.actor,f.check,execute)).toEqual(result);expect(execute).toHaveBeenCalledTimes(1);
  await expect(f.apply({ ...request,request_id: crypto.randomUUID() })).rejects.toThrow('another removal attempt');
  await expect(f.removals.apply(request,'other-owner',f.check,execute)).rejects.toMatchObject({ code: 'not_found' });
});
it('blocks direct and transitive dependants in both reviewed and legacy deletion',async () => {
  const f = await fixture();f.install('middle',[{ type: 'pack',slug: f.manifest.slug }]);f.install('top',[{ type: 'pack',slug: 'middle' }]);
  const plan = await f.review();expect(plan.dependants).toMatchObject([{ pack_slug: 'middle',direct: true },{ pack_slug: 'top',direct: false }]);
  const execute = vi.fn(f.execute);await expect(f.removals.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() },f.actor,f.check,execute)).rejects.toThrow('unblocked');expect(execute).not.toHaveBeenCalled();
  await expect(f.execute({ pack_slug: f.manifest.slug },{ check() {},beforeMutation() {} })).rejects.toThrow('dependent packs');
});
it('requires explicit acknowledgement for unknown dependency metadata',async () => {
  const f = await fixture();f.install('older');const plan = await f.review();expect(plan.unknown_dependencies).toMatchObject([{ pack_slug: 'older' }]);
  const request = { review_id: plan.review_id,request_id: crypto.randomUUID() };
  await expect(f.apply(request)).rejects.toThrow('unknown dependency');expect((await f.apply({ ...request,acknowledge_unknown_dependencies: true })).receipt.result.ok).toBe(true);
});
it.each(['inventory','recipe','expiry','key'] as const)('holds deletion if %s changes after review',async kind => {
  const f = await fixture(),plan = await f.review();
  if (kind === 'inventory') f.install('new-pack',[]);
  if (kind === 'recipe') f.recipes.save({ ...f.active[0]!,ttl: 999 },'recued-core','pair-sync',2,f.manifest.slug);
  if (kind === 'expiry') f.advance(300_001);
  if (kind === 'key') f.state.locked = true;
  await expect(f.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() })).rejects.toThrow();expect(f.recipes.listForPack(f.manifest.slug)).toHaveLength(2);
});
it('checks drift again after sealing the consumed review and before any effect',async () => {
  const f = await fixture(),plan = await f.review(),seal = f.codec.seal.bind(f.codec);
  vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => { const encrypted = await seal(value);f.install('arrived-during-seal',[]);return encrypted; });
  const execute = vi.fn(f.execute);await expect(f.removals.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() },f.actor,f.check,execute)).rejects.toThrow('changed');
  expect(execute).not.toHaveBeenCalled();expect(f.db.prepare('SELECT phase FROM pack_removal_reviews').pluck().get()).toBe('reviewed');
});
it('preserves a shared ingredient and holds removing its remaining provider',async () => {
  const f = await fixture();f.install('one',[],['shared']);f.install('two',[],['shared']);f.install('consumer',[{ type: 'ingredient',slug: 'shared' }]);
  const plan = await f.review(f.request('one'));expect(plan.ingredients.shared).toEqual(['shared']);expect(plan.blockers).toEqual([]);
  await f.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() });expect(f.contracts.get('installed_ingredient',['shared'])).not.toBeNull();
  expect((await f.review(f.request('two'))).dependants).toMatchObject([{ pack_slug: 'consumer' }]);
});
it('never retries effects after an unconfirmed attempt and requires inspecting a fresh review',async () => {
  const f = await fixture(),plan = await f.review(),request = { review_id: plan.review_id,request_id: crypto.randomUUID() },execute = vi.fn(async () => { throw new Error('process interrupted'); });
  await expect(f.removals.apply(request,f.actor,f.check,execute)).rejects.toThrow('interrupted');
  await expect(f.removals.apply(request,f.actor,f.check,execute)).rejects.toMatchObject({ code: 'pack_removal_in_doubt' });expect(execute).toHaveBeenCalledTimes(1);
  const next = await f.review();expect(next.prior_attempt_unconfirmed).toBe(true);
  const nextRequest = { review_id: next.review_id,request_id: crypto.randomUUID() };await expect(f.apply(nextRequest)).rejects.toThrow('unconfirmed');
  expect((await f.apply({ ...nextRequest,acknowledge_incomplete_attempt: true })).receipt.result.ok).toBe(true);
});
it('retains failed outcomes as receipts instead of repeating partial cleanup',async () => {
  const f = await fixture(),plan = await f.review(),request = { review_id: plan.review_id,request_id: crypto.randomUUID() };
  const execute = vi.fn(async () => ({ ok: false as const,removed: { recipes: [],body_grants: [] },failure: { code: 'unexpected' as const,message: 'partial cleanup failed' } }));
  const result = await f.removals.apply(request,f.actor,f.check,execute);expect(result.receipt.result.ok).toBe(false);
  expect(await f.removals.apply(request,f.actor,f.check,execute)).toEqual(result);expect(execute).toHaveBeenCalledTimes(1);
});
it('reuses the winning review under concurrent exact retries',async () => {
  const f = await fixture(),request = f.request();const [first,second] = await Promise.all([f.review(request),f.review(request)]);
  expect(first).toEqual(second);expect(f.db.prepare('SELECT count(*) FROM pack_removal_reviews').pluck().get()).toBe(1);
});
it('bounds retained reviews and refuses pruned identifiers',async () => {
  const f = await fixture(),ids: string[] = [];
  for (let i = 0; i < 201; i++) ids.push((await f.review()).review_id);
  const retained = f.db.prepare('SELECT review_id FROM pack_removal_reviews').pluck().all() as string[];expect(retained).toHaveLength(200);
  const pruned = ids.find(id => !retained.includes(id))!;await expect(f.apply({ review_id: pruned,request_id: crypto.randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
  expect(f.recipes.listForPack(f.manifest.slug)).toHaveLength(2);
});
it('rechecks owner authority after sealing and before consuming the review',async () => {
  const f = await fixture(),plan = await f.review(),seal = f.codec.seal.bind(f.codec);let allowed = true;
  vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => { const encrypted = await seal(value);allowed = false;return encrypted; });
  const execute = vi.fn(f.execute),check = () => { if (!allowed) throw new Error('owner revoked'); };
  await expect(f.removals.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() },f.actor,check,execute)).rejects.toThrow('revoked');
  expect(execute).not.toHaveBeenCalled();expect(f.recipes.listForPack(f.manifest.slug)).toHaveLength(2);
});
it('selects full Records identities, retains their data, and preserves another same-name publisher',async () => {
  const f = await fixture(),first = await installRecords(f,'publisher-a'),second = await installRecords(f,'publisher-b');
  const ambiguous = await f.review(f.request('same-records'));expect(ambiguous.blockers).toMatchObject([{ code: 'ambiguous' }]);expect(ambiguous.publisher_choices).toEqual(['publisher-a','publisher-b']);
  const plan = await f.review({ ...f.request(second.catalog),publisher: 'publisher-b' });expect(plan.records).toEqual({ disposition: 'retain',...second.owner });expect(plan.blockers).toEqual([]);
  const result = await f.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() });expect(result.receipt.result.ok).toBe(true);
  expect(second.records.getNamespace(second.owner)?.state.state).toBe('orphaned');expect(second.records.ownerGet(second.owner,'item','kept')).toMatchObject({ title: 'Keep publisher-b' });
  expect(first.records.getNamespace(first.owner)?.state.state).toBe('ready');expect(getInstalledPack(f.contracts,first.catalog)).not.toBeNull();expect(f.recipes.listForPack(first.catalog)).toHaveLength(1);
});
it('holds Records mutation if installed state changes while execution quiesces',async () => {
  const f = await fixture(),record = await installRecords(f,'publisher-a'),plan = await f.review(f.request('same-records'));
  const wait = record.records.waitForNamespaceQuiescence.bind(record.records);
  vi.spyOn(record.records,'waitForNamespaceQuiescence').mockImplementationOnce(async args => { const result = await wait(args);f.install('arrived-during-drain',[]);return result; });
  const result = await f.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() });expect(result.receipt.result.ok).toBe(false);
  expect(record.records.getNamespace(record.owner)?.state.state).toBe('ready');expect(f.recipes.listForPack(record.catalog)).toHaveLength(1);
});
it('keeps the installed publisher identity when the current catalog publisher differs',async () => {
  const f = await fixture();f.manifest.publisher = 'different-catalog-publisher';f.putManifest();const plan = await f.review();expect(plan.pack.publisher).toBe('recued-core');
  const execute = vi.fn(f.execute);await f.removals.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() },f.actor,f.check,execute);
  expect(execute.mock.calls[0]![1]).toMatchObject({ identity: { publisher: 'recued-core',version: 1 } });
});
it('reserves one physical Records installation across authored-name and catalog-ID reviews',async () => {
  const f = await fixture(),record = await installRecords(f,'publisher-a');
  const publicPlan = await f.review(f.request('same-records')),internalPlan = await f.review(f.request(record.catalog));
  let entered!: () => void,release!: () => void;const started = new Promise<void>(resolve => { entered = resolve; }),gate = new Promise<void>(resolve => { release = resolve; });
  const running = f.removals.apply({ review_id: publicPlan.review_id,request_id: crypto.randomUUID() },f.actor,f.check,async (target,controls) => { entered();await gate;return f.execute(target,controls); });
  await started;const other = vi.fn(f.execute);
  await expect(f.removals.apply({ review_id: internalPlan.review_id,request_id: crypto.randomUUID() },f.actor,f.check,other)).rejects.toMatchObject({ code: 'pack_removal_busy' });
  expect(other).not.toHaveBeenCalled();release();expect((await running).receipt.result.ok).toBe(true);
});
it('recovers an old receipt without removing or misreporting a later installation',async () => {
  const f = await fixture(),plan = await f.review(),request = { review_id: plan.review_id,request_id: crypto.randomUUID() },execute = vi.fn(f.execute);
  const first = await f.removals.apply(request,f.actor,f.check,execute);expect(first.installed_now).toBe(false);
  f.install(f.manifest.slug,[]);const recovered = await f.removals.apply(request,f.actor,f.check,execute);
  expect(recovered.receipt).toEqual(first.receipt);expect(recovered.installed_now).toBe(true);expect(execute).toHaveBeenCalledTimes(1);expect(getInstalledPack(f.contracts,f.manifest.slug)).not.toBeNull();
});

it('holds an older review after a different attempt becomes unconfirmed without changing inventory',async () => {
  const f = await fixture(),older = await f.review(),interrupted = await f.review();
  await expect(f.removals.apply({ review_id: interrupted.review_id,request_id: crypto.randomUUID() },f.actor,f.check,
    async () => { throw new Error('interrupted before effects'); })).rejects.toThrow('interrupted');
  const execute = vi.fn(f.execute);
  await expect(f.removals.apply({ review_id: older.review_id,request_id: crypto.randomUUID(),acknowledge_incomplete_attempt: true },
    f.actor,f.check,execute)).rejects.toMatchObject({ code: 'pack_removal_conflict' });
  expect(execute).not.toHaveBeenCalled();expect(f.recipes.listForPack(f.manifest.slug)).toHaveLength(2);
});
it('holds an older review after a confirmed failed attempt even when no effects landed',async () => {
  const f = await fixture(),older = await f.review(),failed = await f.review();
  await f.removals.apply({ review_id: failed.review_id,request_id: crypto.randomUUID() },f.actor,f.check,async () =>
    ({ ok: false,removed: { recipes: [],body_grants: [] },failure: { code: 'unexpected',message: 'No effect landed.' } }));
  const execute = vi.fn(f.execute);
  await expect(f.removals.apply({ review_id: older.review_id,request_id: crypto.randomUUID() },f.actor,f.check,execute))
    .rejects.toMatchObject({ code: 'pack_removal_conflict' });expect(execute).not.toHaveBeenCalled();
});
it('clears the unconfirmed warning after an inspected fresh attempt completes',async () => {
  const f = await fixture(),interrupted = await f.review();
  await expect(f.removals.apply({ review_id: interrupted.review_id,request_id: crypto.randomUUID() },f.actor,f.check,
    async () => { throw new Error('interrupted before effects'); })).rejects.toThrow('interrupted');
  const fresh = await f.review();expect(fresh.prior_attempt_unconfirmed).toBe(true);
  await f.apply({ review_id: fresh.review_id,request_id: crypto.randomUUID(),acknowledge_incomplete_attempt: true });
  f.install(f.manifest.slug,[]);expect((await f.review()).prior_attempt_unconfirmed).toBe(false);
});

it('rejects a review if another attempt starts while that review is sealed',async () => {
  const f = await fixture(),first = await f.review(),seal = f.codec.seal.bind(f.codec);
  vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => {
    const encrypted = await seal(value);
    await f.removals.apply({ review_id: first.review_id,request_id: crypto.randomUUID() },f.actor,f.check,async () =>
      ({ ok: false,removed: { recipes: [],body_grants: [] },failure: { code: 'unexpected',message: 'No effect landed.' } }));
    return encrypted;
  });
  await expect(f.review()).rejects.toMatchObject({ code: 'pack_removal_conflict' });
  expect(f.recipes.listForPack(f.manifest.slug)).toHaveLength(2);
});
it('keeps the preceding unconfirmed attempt while bounding repeated fresh reviews',async () => {
  const f = await fixture(),first = await f.review();
  await expect(f.removals.apply({ review_id: first.review_id,request_id: crypto.randomUUID() },f.actor,f.check,
    async () => { throw new Error('interrupted before effects'); })).rejects.toThrow('interrupted');
  let latest = first;
  for (let i = 0; i < 201; i++) latest = await f.review();
  expect(latest.prior_attempt_unconfirmed).toBe(true);
  expect(f.db.prepare('SELECT count(*) FROM pack_removal_reviews').pluck().get()).toBe(200);
  const request = { review_id: latest.review_id,request_id: crypto.randomUUID() };await expect(f.apply(request)).rejects.toThrow('unconfirmed');
  expect((await f.apply({ ...request,acknowledge_incomplete_attempt: true })).receipt.result.ok).toBe(true);
},20000);

it('holds a same-name ordinary pack and retained Records namespace for an explicit publisher choice',async () => {
  const f = await fixture(),record = await installRecords(f,'records-publisher'),installed = await f.review(f.request(record.catalog));
  await f.apply({ review_id: installed.review_id,request_id: crypto.randomUUID() });
  f.install('same-records',[],[],'ordinary-publisher');f.recipes.save({ ...f.active[0]!,recipe_id: 'ordinary-recipe' },'ordinary-publisher','pair-sync',1,'same-records');
  const plan = await f.review(f.request('same-records'));expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'ambiguous' }));
  expect(plan.publisher_choices).toEqual(['ordinary-publisher','records-publisher']);
  const selected = await f.review({ ...f.request('same-records'),publisher: 'ordinary-publisher' });expect(selected.records).toBeUndefined();
  expect((await f.apply({ review_id: selected.review_id,request_id: crypto.randomUUID() })).receipt.result.ok).toBe(true);
  expect(f.recipes.getStored('ordinary-recipe')).toBeNull();expect(record.records.ownerGet(record.owner,'item','kept')).toMatchObject({ title: 'Keep records-publisher' });
});
it('uses the Records namespace identity when its inventory is missing beside a same-name ordinary pack',async () => {
  const f = await fixture(),record = await installRecords(f,'records-publisher');removePackInventory(f.contracts,record.catalog);
  f.install('same-records',[],[],'ordinary-publisher');f.recipes.save({ ...f.active[0]!,recipe_id: 'ordinary-recipe' },'ordinary-publisher','pair-sync',1,'same-records');
  const plan = await f.review({ ...f.request('same-records'),publisher: 'records-publisher' });
  expect(plan.pack).toEqual({ inventory_key: record.catalog,pack_slug: 'same-records',publisher: 'records-publisher',version: 1 });
  expect(plan.blockers).toEqual([]);expect(plan.recipes).toEqual(['recipe-records-publisher']);
  expect((await f.apply({ review_id: plan.review_id,request_id: crypto.randomUUID() })).receipt.result.ok).toBe(true);
  expect(record.records.getNamespace(record.owner)?.state.state).toBe('orphaned');expect(getInstalledPack(f.contracts,'same-records')).not.toBeNull();
  expect(f.recipes.getStored('ordinary-recipe')).not.toBeNull();
});

it('holds a review if inventory changes while installed identities resolve',async () => {
  const f = await fixture(),pending = f.review();f.install('arrived-during-identity-resolution',[]);
  await expect(pending).rejects.toMatchObject({ code: 'pack_removal_conflict' });
  expect(f.recipes.listForPack(f.manifest.slug)).toHaveLength(2);
});
