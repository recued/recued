import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDeep, type AssetClassPreset, type BulkPackManifest, type ExecutionSource, type RecipeDefinition } from '@recued/contracts';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { lowerOpStepRecipe, parseRecipe, canonicalJsonString, canonicalRecipeDefinition } from '@recued/recipes';
import { createKernelAdapter } from '@recued/ingredients';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createRecipeStore } from '../recipe-store.js';
const disposals: Array<() => void> = []; afterEach(() => disposals.splice(0).forEach(dispose => dispose()));
const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const recipe = (): RecipeDefinition => JSON.parse(readFileSync('community/recipes/record-device-condition-home-assistant.json', 'utf8'));
const fixture = async () => {
  const db = new Database(':memory:'); const dir = mkdtempSync(join(tmpdir(), 'd325-device-')); disposals.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work) });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC' });
  const yours = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db) });
  const pack = JSON.parse(readFileSync('community/packs/home-assistant.json', 'utf8')) as BulkPackManifest;
  const preset = (pack.contents!.find(c => c.type === 'asset_class') as { preset: AssetClassPreset }).preset; yours.classes.syncPack('recued-core', 'home-assistant', [preset]);
  const created = await yours.command({ action: 'asset.create', class_id: 'ha_device', input: { name: 'Porch light' } }, owner);
  const recipes = createRecipeStore(dir, db); recipes.save(recipe(), 'recued-core', 'bundled', Date.now(), 'home-assistant'); yours.bindRecipes(recipes);
  const enrolled = await yours.command({ action: 'binding.save', asset_id: created.id!, recipe_id: recipe().recipe_id, fields: ['observations.unavailable', 'observations.flickering', 'observations.problem', 'readings.battery'] }, owner);
  const kernel = createKernelAdapter(dispatchers);
  const run = async (history: unknown[], state: Record<string, unknown>, logbook: unknown[] = [], definition = recipe()) => {
    const ctx: ExecutionContext = { recipe: lowerOpStepRecipe(definition, new Map([['recued-core.home-assistant', { catalog_slug: 'home-assistant', operations: new Set(['state.read', 'history.list', 'logbook.list']) }]])),
      recipeDefinitionSha256: createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(definition))).digest('hex'),
      stores: { vault: {}, config: { asset_id: created.id, binding_id: enrolled.id, entity_id: 'light.porch' }, context: {}, meta: {}, step: {} },
      ingredientExecutor: async (slug, input, output, options, stepMeta) => {
        const data = resolveDeep(input, ctx.stores) as Record<string, unknown>;
        if (slug === 'home-assistant') {
          expect(options?.cache).toBe('fresh');
          // ⛔ Home Assistant's history view turns minimal mode on when `minimal_response`
          // is present at all — `=false` included — and rows between the first and last
          // then carry no entity_id. A fake that ignored the flag hid a blind flicker check.
          const minimal = data.operation === 'history.list' && JSON.stringify(data).includes('minimal_response');
          const rows = minimal ? history.map((row, index) => index === 0 || index === history.length - 1 ? row
            : { state: (row as { state: unknown }).state, last_changed: (row as { last_changed: unknown }).last_changed }) : history;
          return { result: data.operation === 'state.read' ? state : data.operation === 'history.list' ? [rows] : logbook };
        }
        return kernel({ slug, input: data, output: output ?? {}, risk_tier: 'read', ...(stepMeta ? { stepMeta } : {}) });
      } };
    return { result: await executeRecipe(ctx), steps: ctx.stores.step };
  };
  return { work, yours, recipes, asset_id: created.id!, binding_id: enrolled.id!, run };
};
const point = (at: number, state: string) => ({ entity_id: 'light.porch', state, last_changed: new Date(at).toISOString() });
describe('D-325 real installed recipe observation writers', () => {
  it('enrolls a version and rejects an inline changed recipe at the real kernel/store boundary', async () => {
    const f = await fixture(); expect(parseRecipe(recipe()).ok).toBe(true);
    const now = Date.now(); const changed = recipe(); changed.metadata.description += ' altered';
    const result = await f.run([point(now - 800000, 'unavailable'), point(now - 700000, 'unavailable')], { ...point(now, 'unavailable'), attributes: {} }, [], changed);
    expect(result.result.success).toBe(false); expect(JSON.stringify(result.result.errors)).toContain('bound recipe changed');
    expect(f.work.readAsset(f.asset_id)!.observations.unavailable).toBeNull();
    const binding = f.work.listAssetObservationBindings(f.asset_id)[0]!;
    f.recipes.delete(recipe().recipe_id);
    expect(() => f.work.writeAssetObservations({ binding_id: f.binding_id, actor_ref: binding.actor_ref, recipe_hash: binding.recipe_hash,
      observations: { problem: { active: true, certainty: 'confirmed', as_of: now, evidence: [] } } })).toThrow('no longer installed');
    expect((await f.yours.snapshot({ asset_id: f.asset_id })).observation_bindings![0]?.available).toBe(false);
  });
  it('drops a transient outage, confirms a held outage and writes confirmed device reports immediately', async () => {
    const f = await fixture(); const now = Date.now();
    const transient = await f.run([point(now - 700000, 'on'), point(now - 20000, 'unavailable')], { ...point(now, 'unavailable'), attributes: {} });
    expect(transient.result.errors).toEqual([]); expect(f.work.readAsset(f.asset_id)!.observations.unavailable).toBeNull();
    const held = await f.run([point(now - 800000, 'on'), point(now - 700000, 'unavailable')], { ...point(now, 'unavailable'), attributes: {} });
    expect(held.result.errors).toEqual([]); expect(held.steps.hold, JSON.stringify(held.steps)).toMatchObject({ status: 'settled' }); expect(f.work.readAsset(f.asset_id)!.observations.unavailable).toMatchObject({ active: true, certainty: 'confirmed' });
    const problem = await f.run([point(now - 20000, 'off'), point(now - 10000, 'on')], { ...point(now, 'on'), attributes: { device_class: 'problem' } });
    expect(problem.result.errors).toEqual([]); expect(f.work.readAsset(f.asset_id)!.observations.problem).toMatchObject({ active: true, certainty: 'confirmed' });
  });
  it('leaves unexplained flicker conditional and ignores a fully commanded pattern', async () => {
    const f = await fixture(); const now = Date.now(); const history = Array.from({ length: 11 }, (_, i) => point(now - 120000 + i * 10000, i % 2 ? 'off' : 'on'));
    const unknown = await f.run(history, { ...point(now, 'on'), attributes: {} });
    expect(unknown.result.errors).toEqual([]); expect(unknown.steps.flicker, JSON.stringify(unknown.steps)).toMatchObject({ flickering: true }); expect(f.work.readAsset(f.asset_id)!.observations.flickering).toMatchObject({ active: true, certainty: 'conditional' });
    const causes = history.map(row => ({ entity_id: row.entity_id, state: row.state, when: row.last_changed, context_domain: 'automation' }));
    const commanded = await f.run(history, { ...point(now, 'on'), attributes: {} }, causes);
    expect(commanded.result.errors).toEqual([]); expect(f.work.readAsset(f.asset_id)!.observations.flickering).toMatchObject({ active: false });
  });
});
