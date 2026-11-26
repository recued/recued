import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDeep, type AssetWriterSelection, type ConnectionRow, type ExecutionSource, type RecipeDefinition } from '@recued/contracts';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { canonicalJsonString, canonicalRecipeDefinition, lowerOpStepRecipe } from '@recued/recipes';
import { createKernelAdapter } from '@recued/ingredients';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createRecipeStore } from '../recipe-store.js';
import { createDishStore } from '../dish-store.js';
import { createScheduleStore } from '../schedule-store.js';
import { createHouseholdHomeAssistant } from '../situations/household-home-assistant.js';
import { createAssetWriterSetup } from '../situations/asset-writer-setup.js';
import { stampExecuteResponseAuditRun, type ExecuteRequest, type ExecuteResponse } from '../types.js';
import type { DishHandlerDeps } from '../dish-handler.js';
import type { AuditLogStore } from '@recued/storage';
import { createConnectionStore } from '../storage/connection-store.js';
import { connectionRevisionGuard } from '../connection-revision.js';

const disposals: Array<() => void> = [];
afterEach(() => disposals.splice(0).forEach(dispose => dispose()));
const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const fixture = (nativeAccountIdentity = false) => {
  const db = new Database(':memory:'); const dir = mkdtempSync(join(tmpdir(), 'writer-setup-'));
  disposals.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const put = (id: string) => work.writeAsset({ id, source_id: 'recued.asset', name: id, source: { kind: 'owner', ref: 'owner' },
    readings: { battery: null }, observations: {}, settings: {} });
  put('alarm'); put('other');
  const recipe = JSON.parse(readFileSync('community/recipes/record-device-condition-home-assistant.json', 'utf8')) as RecipeDefinition;
  writeFileSync(join(dir, `${recipe.recipe_id}.json`), JSON.stringify(recipe));
  const recipes = createRecipeStore(dir, db); recipes.save(recipe, 'recued-core', 'bundled', Date.now(), 'home-assistant');
  const dishes: DishHandlerDeps = { store: createDishStore(db), checkConnectionChoices: (id: string, choices: Readonly<Record<string, string>>) => {
    if (id !== recipe.recipe_id || choices['home-assistant'] !== 'house') throw new Error('Wrong connection');
  } };
  const schedules = { store: createScheduleStore(db), dishStore: dishes.store, recipeStore: recipes, cronFloorMs: 300_000, instanceId: 'test-instance' };
  const connections: ConnectionRow[] = [{ pk: 'api:house', name: 'house', display_name: 'Our home', kind: 'api', enrolled_at: 100,
    updated_at: 100, config_json: JSON.stringify({ base_url: 'http://home-assistant.local:8123' }), auth_ciphertext: 'private-token' }];
  const connectionStore = nativeAccountIdentity ? createConnectionStore(db) : undefined;
  connectionStore?.upsert(connections[0]!);
  let unlocked = true; let sample = '84'; let sourceRead = async () => {};
  const source = createHouseholdHomeAssistant({ db, work, connections: () => connectionStore?.list({ kind: 'api' }) ?? connections,
    ...(connectionStore ? { authSourceId: (name: string) => connectionStore.getAuthSourceId?.('api', name) } : {}),
    credential: async () => 'token', isVaultUnlocked: () => unlocked,
    fetch: async () => { await sourceRead(); return new Response(JSON.stringify([
      { entity_id: 'sensor.alarm_battery', state: sample, attributes: { friendly_name: 'Hall alarm battery', device_class: 'battery', unit_of_measurement: '%' } },
      { entity_id: 'binary_sensor.motion', state: 'on', attributes: { device_class: 'motion' } },
      { entity_id: 'person.someone', state: 'home', attributes: {} },
    ])); } });
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work) }); const kernel = createKernelAdapter(dispatchers);
  let service: ReturnType<typeof createAssetWriterSetup>; let beforeRun = async () => {}; let calls = 0;
  const execute = vi.fn(async (raw: ExecuteRequest): Promise<ExecuteResponse> => {
    const request = service.prepareRun(raw); const run_id = `setup_run_${++calls}`; await beforeRun();
    connectionRevisionGuard(request.connection_revisions, name => connectionStore?.get('api', name) ?? connections.find(row => row.name === name),
      name => connectionStore?.getAuthSourceId?.('api', name))?.();
    const config = dishes.store.get(request.dish_id!)!.config_overlay;
    const ctx: ExecutionContext = {
      recipe: lowerOpStepRecipe(recipe, new Map([['recued-core.home-assistant', { catalog_slug: 'home-assistant', operations: new Set(['state.read', 'history.list', 'logbook.list']) }]])),
      run_id, recipeDefinitionSha256: createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(recipe))).digest('hex'),
      stores: { vault: {}, config, context: {}, meta: {}, step: {} },
      ingredientExecutor: async (slug, input, output, options, stepMeta) => {
        const args = resolveDeep(input, ctx.stores) as Record<string, unknown>;
        if (slug === 'home-assistant') return { result: args.operation === 'state.read'
          ? { entity_id: config.entity_id, state: sample, attributes: { device_class: 'battery', unit_of_measurement: '%' } }
          : [] };
        return kernel({ slug, input: args, output: output ?? {}, risk_tier: 'read', ...(stepMeta ? { stepMeta } : {}) });
      },
    };
    const result = await executeRecipe(ctx);
    if (!result.success) throw new Error(JSON.stringify(result.errors));
    return stampExecuteResponseAuditRun({ recipe_id: recipe.recipe_id, recipe_hash: 'test', success: result.success,
      output: { render: [], sidebar: [] }, steps: [], errors: result.errors, duration_ms: 1 }, run_id);
  });
  const boot = () => createAssetWriterSetup({ db, work, recipes, dishes, schedules, source, execute, isVaultUnlocked: () => unlocked });
  service = boot();
  const selection = (id = 'alarm'): AssetWriterSelection => ({ asset_id: id, definition_id: 'home-assistant-device',
    connection: source.writerConnections()[0]!, source_id: 'sensor.alarm_battery', fields: ['readings.battery'], interval_minutes: 15 });
  const configure = async (id = 'alarm', request_id = 'setup-request') => service.change({ action: 'configure', review: await service.preview(selection(id)), request_id }, owner);
  return { db, work, service, source, recipes, recipe, dishes, schedules, connections, execute, selection, configure, boot,
    sample(value: string) { sample = value; }, seal() { unlocked = false; },
    beforeRun(value: () => Promise<void>) { beforeRun = value; }, sourceRead(value: () => Promise<void>) { sourceRead = value; } };
};

describe('guided source setup', () => {
  it('uses the connection store’s account identity for source reads and its first execution check', async () => {
    const f = fixture(true);
    const configured = await f.configure();
    expect(configured.state).toBe('scheduled');
    expect(configured.deliveries[0]!.delivery).toMatchObject({ status: 'recorded', last_submission: { outcome: 'accepted' } });
  });
  it('runs the installed recipe with only the approved field, records native delivery and isolates each asset’s settings', async () => {
    const f = fixture(); const options = await f.service.read({ asset_id: 'alarm', connection: f.selection().connection });
    expect(options.sources?.map(source => source.id)).toEqual(['sensor.alarm_battery']);
    expect(JSON.stringify(options)).not.toContain('private-token');
    const first = await f.configure();
    expect(first).toMatchObject({ state: 'scheduled', deliveries: [{ path: 'readings.battery', delivery: { status: 'recorded', last_submission: { outcome: 'accepted' } } }] });
    expect(f.work.readAsset('alarm')!.readings.battery?.value).toBe(84);
    expect(f.work.readAsset('alarm')!.observations).toEqual({});
    const other = await f.configure('other', 'other-request');
    expect(f.dishes.store.list()).toHaveLength(2); expect(f.schedules.store.list()).toHaveLength(2);
    expect(f.dishes.store.list().map(dish => dish.config_overlay.asset_id).sort()).toEqual(['alarm', 'other']);
    const paused = await f.service.change({ action: 'pause', asset_id: 'alarm', setup_id: first.id, revision: first.revision }, owner);
    expect(paused.state).toBe('paused'); expect((await f.service.read({ asset_id: 'other' })).setups[0]!.state).toBe('scheduled');
    const resumed = await f.service.change({ action: 'resume', asset_id: 'alarm', setup_id: first.id, revision: paused.revision }, owner);
    expect(resumed.state).toBe('scheduled'); expect(resumed.id).not.toBe(other.id);
    f.work.writeAsset({ id: 'alarm', source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, readings: {
      battery: { value: 71, unit: '%', as_of: Date.now(), evidence: [] } } });
    f.sample('65');
    const run = await f.service.change({ action: 'run', asset_id: 'alarm', setup_id: first.id, revision: resumed.revision }, owner);
    expect(run.deliveries[0]!.delivery).toMatchObject({ last_submission: { outcome: 'manual_priority' }, last_accepted: expect.any(Object) });
    expect(f.work.readAsset('alarm')!.readings.battery?.value).toBe(71);
    const before = f.dishes.store.listByRecipe(f.recipe.recipe_id).find(dish => dish.config_overlay.asset_id === 'alarm')!;
    const replacement = await f.service.preview({ ...f.selection(), interval_minutes: 30 });
    const updated = await f.service.change({ action: 'configure', review: replacement, request_id: 'updated-request' }, owner);
    expect(updated.interval_minutes).toBe(30);
    expect(f.dishes.store.list()).toHaveLength(2); expect(f.schedules.store.list()).toHaveLength(2);
    expect(f.dishes.store.get(before.dish_id)?.is_default).toBe(before.is_default);
    f.work.writeAsset({ id: 'alarm', source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, status: 'retired' });
    expect(() => f.service.prepareRun({ recipe_id: f.recipe.recipe_id, dish_id: before.dish_id })).toThrow(/active local asset/);
    expect((await f.service.read({ asset_id: 'alarm' })).setups[0]!.state).toBe('needs_review');
    const stopped = await f.service.change({ action: 'pause', asset_id: 'alarm', setup_id: updated.id, revision: updated.revision }, owner);
    expect(stopped.scheduled).toBe(false);
  });

  it('retires unsupported managed adapters without deleting assets or leaving schedules active', async () => {
    const f = fixture(); const setup = await f.configure();
    const stored = f.db.prepare('SELECT value FROM asset_writer_setup WHERE id=?').get(setup.id) as { value: string };
    const retired = JSON.parse(stored.value);
    retired.review.selection.definition_id = 'retired-adapter';
    f.db.prepare('UPDATE asset_writer_setup SET value=? WHERE id=?').run(JSON.stringify(retired), setup.id);
    const reloaded = f.boot();
    expect(f.schedules.store.list()[0]!.enabled).toBe(false);
    expect(f.dishes.store.list()[0]!.enabled).toBe(false);
    expect(f.work.listAssetObservationBindings('alarm')[0]!.enabled).toBe(false);
    expect(f.work.readAsset('alarm')!.readings.battery?.value).toBe(84);
    expect((await reloaded.read({ asset_id: 'alarm' })).setups).toEqual([]);
  });

  it('rolls back the entire local setup if a schedule cannot be saved', async () => {
    const f = fixture(); const review = await f.service.preview(f.selection());
    f.db.exec("CREATE TRIGGER refuse_schedule BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT,'schedule rejected'); END");
    await expect(f.service.change({ action: 'configure', review, request_id: 'atomic-request' }, owner)).rejects.toThrow('schedule rejected');
    expect(f.dishes.store.list()).toEqual([]); expect(f.work.listAssetObservationBindings('alarm')).toEqual([]);
    expect((await f.service.read({ asset_id: 'alarm' })).setups).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  });

  it('reuses an approved request after a lost response and a service restart, without running or scheduling twice', async () => {
    const f = fixture(); const review = await f.service.preview(f.selection());
    const input = { action: 'configure' as const, review, request_id: 'replayed-request' };
    const result = await f.service.change(input, owner); const reloaded = f.boot();
    expect((await reloaded.change(input, owner)).id).toBe(result.id);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.dishes.store.list()).toHaveLength(1); expect(f.schedules.store.list()).toHaveLength(1);
  });

  it('does not start the schedule when the owner pauses during the first check', async () => {
    const f = fixture(); let release!: () => void;
    f.beforeRun(() => new Promise<void>(resolve => { release = resolve; }));
    const review = await f.service.preview(f.selection()); const input = { action: 'configure' as const, review, request_id: 'pending-request' };
    const running = f.service.change(input, owner);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    const replay = await f.service.change(input, owner); expect(replay.state).toBe('running');
    await f.service.change({ action: 'pause', asset_id: 'alarm', setup_id: replay.id, revision: replay.revision }, owner);
    release(); expect((await running).state).toBe('paused'); expect(f.schedules.store.list()[0]!.enabled).toBe(false);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses stale previews and rechecks the account after source reads before creating anything', async () => {
    const f = fixture(); const review = await f.service.preview(f.selection());
    f.work.writeAsset({ id: 'alarm', source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, settings: { hold_ms: 120_000 } });
    await expect(f.service.change({ action: 'configure', review, request_id: 'stale-request' }, owner)).rejects.toThrow(/changed/);
    const fresh = await f.service.preview(f.selection());
    f.sourceRead(async () => { f.connections[0]!.enrolled_at++; });
    await expect(f.service.change({ action: 'configure', review: fresh, request_id: 'account-request' }, owner)).rejects.toThrow(/changed/);
    expect(f.dishes.store.list()).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  });

  it('pins the reviewed account on every run and refuses recipe, settings and account drift', async () => {
    const f = fixture(); await f.configure(); const dish = f.dishes.store.list()[0]!;
    const request = { recipe_id: f.recipe.recipe_id, dish_id: dish.dish_id };
    expect(f.service.prepareRun(request).connection_revisions).toEqual({ house: f.selection().connection.revision });
    expect(f.service.prepareRun({ recipe_id: f.recipe.recipe_id })).toMatchObject({
      config: dish.config_overlay, connections: { 'home-assistant': 'house' }, connection_revisions: { house: f.selection().connection.revision } });
    expect(() => f.service.prepareRun({ ...request, config: { entity_id: 'sensor.somewhere_else' } })).toThrow(/Review/);
    expect(() => f.service.prepareRun({ recipe_id: 'another-recipe', recipe: f.recipe })).toThrow(/Review/);
    f.dishes.store.set({ ...dish, dish_id: 'dsh_unreviewed', is_default: false,
      config_overlay: { ...dish.config_overlay, entity_id: 'sensor.somewhere_else' } });
    expect(() => f.service.prepareRun({ recipe_id: f.recipe.recipe_id, dish_id: 'dsh_unreviewed' })).toThrow(/reviewed setup/);
    f.recipes.save({ ...f.recipe, metadata: { ...f.recipe.metadata, description: 'Changed' } }, 'recued-core', 'bundled', Date.now(), 'home-assistant');
    expect(() => f.service.prepareRun(request)).toThrow(/supported version/);
    f.recipes.save(f.recipe, 'recued-core', 'bundled', Date.now(), 'home-assistant');
    f.connections[0]!.auth_ciphertext = 'different-private-token';
    expect(() => f.service.prepareRun(request)).toThrow(/connection changed/);
    expect((await f.service.read({ asset_id: 'alarm' })).setups[0]!.state).toBe('needs_review');
  });

  it('leaves the schedule off when a successful envelope actually means waiting for approval', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce(stampExecuteResponseAuditRun({ recipe_id: f.recipe.recipe_id, recipe_hash: 'test', success: true, awaiting_approval: true,
      output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 1 }, 'held-check'));
    const result = await f.configure();
    expect(result.state).toBe('paused'); expect(result.last_run?.outcome).toBe('waiting'); expect(result.can_resume).toBe(false);
    expect(f.schedules.store.list()[0]!.enabled).toBe(false); expect(result.deliveries[0]!.delivery.status).toBe('no_receipt');
    await expect(f.service.change({ action: 'resume', asset_id: 'alarm', setup_id: result.id, revision: result.revision }, owner)).rejects.toThrow(/successful check/);
    await expect(f.service.change({ action: 'run', asset_id: 'alarm', setup_id: result.id, revision: result.revision }, owner)).rejects.toThrow(/waiting check/);
    let phase = 'in_doubt';
    f.dishes.auditLog = { get: async (id: string) => { expect(id).toBe('held-check'); return { dish_id: f.dishes.store.list()[0]!.dish_id, commit_status: phase }; } } as unknown as AuditLogStore;
    expect((await f.service.read({ asset_id: 'alarm' })).setups[0]).toMatchObject({ can_resume: false, last_run: { outcome: 'unknown' } });
    phase = 'succeeded';
    const settled = (await f.service.read({ asset_id: 'alarm' })).setups[0]!;
    expect(settled).toMatchObject({ state: 'paused', can_resume: true, last_run: { outcome: 'succeeded' } });
  });

  it('rejects a concurrent request id reused for a different review after source discovery yields', async () => {
    const f = fixture();
    const first = await f.service.preview(f.selection());
    const other = await f.service.preview({ ...f.selection(), interval_minutes: 30 });
    let release!: () => void; let reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.sourceRead(async () => { reads++; await gate; });
    const saved = f.service.change({ action: 'configure', review: first, request_id: 'shared-request' }, owner);
    const conflicting = f.service.change({ action: 'configure', review: other, request_id: 'shared-request' }, owner).then(() => null, error => error as Error);
    await vi.waitFor(() => expect(reads).toBe(2)); release();
    expect((await saved).interval_minutes).toBe(15);
    expect(await conflicting).toMatchObject({ message: expect.stringContaining('different review') });
    expect(f.dishes.store.list()).toHaveLength(1); expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a late audit read from replacing the status of a newer check', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce(stampExecuteResponseAuditRun({ recipe_id: f.recipe.recipe_id, recipe_hash: 'test', success: false, awaiting_approval: true,
      output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 1 }, 'older-check'));
    const configured = await f.configure();
    f.dishes.auditLog = { get: async () => ({ dish_id: f.dishes.store.list()[0]!.dish_id, commit_status: 'in_doubt' }) } as unknown as AuditLogStore;
    await f.service.read({ asset_id: 'alarm' });
    let auditRelease!: () => void; let runRelease!: () => void;
    const auditGate = new Promise<void>(resolve => { auditRelease = resolve; });
    const runGate = new Promise<void>(resolve => { runRelease = resolve; });
    f.dishes.auditLog.get = async () => { await auditGate; return { dish_id: f.dishes.store.list()[0]!.dish_id, commit_status: 'succeeded' } as Awaited<ReturnType<AuditLogStore['get']>>; };
    const earlierRead = f.service.read({ asset_id: 'alarm' });
    f.beforeRun(() => runGate);
    const checking = f.service.change({ action: 'run', asset_id: 'alarm', setup_id: configured.id, revision: configured.revision }, owner);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    auditRelease(); const interim = await earlierRead; runRelease(); await checking;
    expect(interim.setups[0]).toMatchObject({ state: 'running', can_resume: false, last_run: { outcome: 'running' } });
  });
});
