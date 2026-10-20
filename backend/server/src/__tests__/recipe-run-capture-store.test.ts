import { afterEach,expect,it,vi } from 'vitest';
import { NS,RECIPE_RUN_CAPTURE_LIMITS,type NamespaceStores,type RecipeRunCaptureImport } from '@recued/contracts';
import { executeRecipe } from '@recued/engine';
import { createRecipeRunCaptureStore } from '../storage/recipe-run-capture-store.js';
import { regressionFixture,regressionRecipe,regressionRequest } from './recipe-regression-fixture.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });
const fixture = () => {
  const f = regressionFixture(); cleanups.push(f.close); let time = 1000, live = true;
  const check = () => { if (!live) throw new Error('Owner revoked'); };
  const captures = createRecipeRunCaptureStore(f.codec,f.store,() => time);
  const prepare = () => captures.prepare({ recipe_id: 'regression-test',config: { rows: [1,2],api_key: 'private-credential' } },'owner',check);
  const execute: Parameters<typeof captures.run>[3] = async (request,observer) => {
    const stores = Object.fromEntries([...NS].map(key => [key,Object.create(null)])) as NamespaceStores;
    stores.config = request.config ?? {}; stores.context = request.context ?? {}; stores.vault = { secret: 'vault-secret' };
    const result = await executeRecipe({ recipe: regressionRecipe(),stores,ingredientExecutor: async () => { throw new Error('Unexpected provider'); },onTestCaptureInput: observer.input });
    observer.result(result); return { recipe_id: result.recipe_id,recipe_hash: result.recipe_hash,success: result.success,output: result.output,
      steps: result.steps,errors: result.errors,duration_ms: result.duration_ms,run_id: 'recorded-run' };
  };
  const ready = async () => { const first = prepare(); await captures.run(first.capture_id,'owner',check,execute); return captures.read(first.capture_id,'owner',check); };
  const request = async (): Promise<RecipeRunCaptureImport> => { const read = await ready(); return { capture_id: read.capture.capture_id,recipe_digest: read.draft!.recipe_digest,
    expected_revision: 0,request_id: crypto.randomUUID(),reviewed: true,case: read.draft!.case }; };
  return { ...f,captures,prepare,execute,ready,request,check,advance: (ms: number) => { time += ms; },revoke: () => { live = false; } };
};
it('captures only opt-in runs, redacts data and writes no durable suite until explicit import',async () => {
  const f = fixture(), read = await f.ready(); expect(read.capture.state).toBe('ready');
  expect(read.draft!.case.sample.config?.api_key).toBe('[redacted]'); expect(JSON.stringify(read)).not.toContain('vault-secret');
  expect(f.store.history('regression-test').head_revision).toBe(0);
  await expect(f.captures.read(read.capture.capture_id,'another',f.check)).rejects.toMatchObject({ code: 'not_found' });
  const request: RecipeRunCaptureImport = { capture_id: read.capture.capture_id,recipe_digest: read.draft!.recipe_digest,expected_revision: 0,request_id: crypto.randomUUID(),reviewed: true,case: read.draft!.case };
  const imported = await f.captures.import(request,'owner',f.check);
  expect(imported.version!.suite.cases[0]!.sample.config?.api_key).toBe('[redacted]');
  expect(await f.captures.import(request,'owner',f.check)).toEqual(imported);
  await expect(f.captures.import({ ...request,case: { ...request.case,name: 'Changed' } },'owner',f.check)).rejects.toMatchObject({ code: 'capture_conflict' });
});
it('refuses duplicate dispatch even concurrently, then recovers the completed capture',async () => {
  const f = fixture(), first = f.prepare(); let release!: () => void,calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = f.captures.run(first.capture_id,'owner',f.check,async (...args) => { calls++; await gate; return f.execute(...args); });
  await expect(f.captures.run(first.capture_id,'owner',f.check,f.execute)).rejects.toMatchObject({ code: 'capture_started' });
  release(); await pending; expect(calls).toBe(1);
  await expect(f.captures.run(first.capture_id,'owner',f.check,f.execute)).rejects.toMatchObject({ code: 'capture_started' });
  expect((await f.captures.read(first.capture_id,'owner',f.check)).capture.state).toBe('ready');
});
it('preserves the existing suite baseline and cases and holds a concurrent suite change',async () => {
  const f = fixture(); await f.store.save(regressionRequest(),f.check);
  const request = await f.request(); await expect(f.captures.import(request,'owner',f.check)).rejects.toMatchObject({ code: 'conflict' });
  const imported = await f.captures.import({ ...request,expected_revision: 1 },'owner',f.check);
  expect(imported.version!.suite.cases.map(item => item.id)).toEqual(['empty',request.capture_id]);
  expect(imported.version!.suite.baseline).toEqual(regressionRecipe());
});
it('requires exact capture identity, acknowledgement and an unchanged case ID',async () => {
  const f = fixture(), request = await f.request();
  await expect(f.captures.import({ ...request,recipe_digest: 'sha256:' + 'f'.repeat(64) },'owner',f.check)).rejects.toMatchObject({ code: 'capture_conflict' });
  await expect(f.captures.import({ ...request,case: { ...request.case,id: 'different' } },'owner',f.check)).rejects.toMatchObject({ code: 'bad_request' });
  expect(f.store.history('regression-test').head_revision).toBe(0);
});
it('rechecks owner and key availability after private reads and before dispatch',async () => {
  const f = fixture(), first = f.prepare(), open = f.codec.open.bind(f.codec); let calls = 0;
  vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const data = await open(value); f.state.locked = true; return data; });
  await expect(f.captures.run(first.capture_id,'owner',f.check,async (...args) => { calls++; return f.execute(...args); })).rejects.toMatchObject({ code: 'server_locked' });
  expect(calls).toBe(0); f.state.locked = false;
  await expect(f.captures.run(first.capture_id,'owner',f.check,f.execute)).rejects.toMatchObject({ code: 'capture_started' });
  const read = await f.ready();
  vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const data = await open(value); f.revoke(); return data; });
  await expect(f.captures.read(read.capture.capture_id,'owner',f.check)).rejects.toThrow('Owner revoked');
});
it('recording failures preserve the completed live response and leave no importable data',async () => {
  const f = fixture(), first = f.prepare();
  const result = await f.captures.run(first.capture_id,'owner',f.check,async (...args) => { const response = await f.execute(...args); f.state.locked = true; return response; });
  expect(result.execution.success).toBe(true); expect(result.capture.state).toBe('unavailable');
  f.state.locked = false; expect((await f.captures.read(first.capture_id,'owner',f.check)).draft).toBeNull();
});
it('expires captures and bounds prepared requests and concurrent captured runs',async () => {
  const f = fixture(); for (let index = 0; index < RECIPE_RUN_CAPTURE_LIMITS.entries; index++) f.prepare();
  expect(() => f.prepare()).toThrow('32 temporary'); f.advance(RECIPE_RUN_CAPTURE_LIMITS.ttl_ms + 1);
  expect(f.captures.list('regression-test','owner',f.check).captures).toEqual([]);
  const first = f.prepare(),second = f.prepare(),third = f.prepare(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute: typeof f.execute = async (...args) => { await gate; return f.execute(...args); };
  const a = f.captures.run(first.capture_id,'owner',f.check,execute), b = f.captures.run(second.capture_id,'owner',f.check,execute);
  await expect(f.captures.run(third.capture_id,'owner',f.check,execute)).rejects.toMatchObject({ code: 'capture_limit' });
  expect(() => f.captures.remove(first.capture_id,'owner',f.check)).toThrow('Wait for the run'); release(); await Promise.all([a,b]);
  f.captures.remove(first.capture_id,'owner',f.check); await expect(f.captures.read(first.capture_id,'owner',f.check)).rejects.toMatchObject({ code: 'not_found' });
});
it('drops recording after a temporary vault lock even if the live run later returns successfully',async () => {
  const f = fixture(), prepared = f.prepare();
  const completed = await f.captures.run(prepared.capture_id,'owner',f.check,async (...args) => {
    const response = await f.execute(...args); f.state.locked = true;
    await new Promise(resolve => setTimeout(resolve,150)); f.state.locked = false; return response;
  });
  expect(completed.execution.success).toBe(true); expect(completed.capture.state).toBe('unavailable');
  expect((await f.captures.read(prepared.capture_id,'owner',f.check)).draft).toBeNull();
});
it('serializes a reviewed import and retains its exact retry after asynchronous sealing',async () => {
  const f = fixture(), request = await f.request(), seal = f.codec.seal.bind(f.codec);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(f.codec,'seal').mockImplementationOnce(async value => { entered(); await held; return seal(value); });
  const pending = f.captures.import(request,'owner',f.check); await started;
  try { await expect(f.captures.import({ ...request,request_id: crypto.randomUUID() },'owner',f.check)).rejects.toMatchObject({ code: 'capture_conflict' }); }
  finally { release(); }
  const saved = await pending; expect(await f.captures.import(request,'owner',f.check)).toEqual(saved);
});
