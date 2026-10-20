import { connectionRevision } from '../connection-revision.js';
import { describe, expect, it, vi } from 'vitest';
import type { EntitySchemaIngredientInput, GatewayCallAudit, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { executeRecipe } from '@recued/engine';
import { createInMemoryStore } from '@recued/cache';
import { withIngredientCache } from '@recued/ingredients';
import { recordOutputSourceCache } from '../record-output-source-cache.js';
import { createRecordOutputSources } from '../record-output-source.js';

const catalog = 'publisher-crm';
const manifest: IngredientManifest = {
  slug: catalog, name: 'CRM', description: '', author: 'publisher', kind: 'connection',
  category: 'action', risk_tier: 'read', input: {}, output: {},
  operations: { 'contact.read': { operation_id: `${catalog}.contact.read`, risk_tier: 'read', groups: [] } },
  surfaces: { api: { transport: 'rest', default_base_url: 'https://api.example.test',
    auth: { kind: 'none' }, executes: { 'contact.read': { kind: 'rest', method: 'GET', path_template: '/contacts/{{id}}' } } } },
};
const schema: EntitySchemaIngredientInput = {
  ingredient_id: catalog, wraps_vendor: 'hubspot', entity_id: 'contact',
  scope: 'connection.api.hubspot.contact', projection_mode: 'platform_reference', schema_mode: 'static',
  target_id: { fields: ['id'], template: 'contact_{id}' }, meta_fields: [],
  source_operations: { get: { catalog, operation: 'contact.read' } },
};
const recipe: RecipeDefinition = {
  recipe_id: 'contact-page', version: 1, ttl: 0, variables: {}, requires: [catalog], prefetch_steps: [],
  metadata: { name: 'Contact', description: '', author: 'publisher', supported_platforms: ['hubspot', 'salesforce'] },
  steps: [{ id: 'fetch', ingredient: catalog, ingredient_version: 3,
    input: { operation: 'contact.read', connection: 'sales', args: { id: '42' } } },
    { id: 'derived', type: 'transform', transform: 'coalesce', values: ['{{step.fetch}}'] }],
  output: { render: [{ type: 'record_fields', entity: 'contact', source: 'step.fetch' },
    { type: 'record_fields', entity: 'contact', source: 'step.derived' }, { type: 'json', source: 'step.fetch' }] },
};
const event = (overrides: Partial<GatewayCallAudit> = {}): GatewayCallAudit => ({
  ingredient_id: catalog, operation_id: `${catalog}.contact.read`, operation_group: null,
  connection_name: 'sales', risk_tier: 'read', surface_kind: 'api', approval: 'never',
  outcome: 'success', recipe_id: recipe.recipe_id, step_id: 'fetch', ...overrides,
});
const setup = (schemas: readonly EntitySchemaIngredientInput[] = [schema], vendor: string | null = 'hubspot') => {
  const getManifest = vi.fn(() => manifest);
  const getSchemas = vi.fn(() => schemas);
  const trace = createRecordOutputSources({ recipe, manifest: getManifest,
    schemas: getSchemas, connectionVendor: () => vendor });
  return { trace, getManifest, getSchemas };
};

describe('record output source evidence', () => {
  it('requires an observed successful call and the exact pinned schema operation', () => {
    const { trace, getManifest, getSchemas } = setup();
    expect(trace.source('contact', 'fetch')).toBeUndefined();
    trace.observe(event());
    expect(trace.source('contact', 'fetch')).toEqual({ kind: 'api', platform: 'hubspot', connection_name: 'sales', entity: 'contact' });
    expect(getManifest).toHaveBeenCalledWith(catalog, 3);
    expect(getSchemas).toHaveBeenCalledWith(catalog, 3);
    expect(trace.source('company', 'fetch')).toBeUndefined();
    expect(trace.source('contact', 'derived')).toBeUndefined();
    expect(setup().trace.source('contact', 'fetch')).toBeUndefined();
  });

  it.each([
    { outcome: 'failed' }, { surface_kind: 'connector' }, { recipe_id: 'another-recipe' },
    { step_id: 'unknown' }, { operation_id: `${catalog}.company.read` }, { connection_name: 'bad_connection' },
  ] as Partial<GatewayCallAudit>[])('leaves unmatched evidence manual: %j', override => {
    const { trace } = setup();
    trace.observe(event(override));
    expect(trace.source('contact', 'fetch')).toBeUndefined();
  });

  it('refuses competing accounts and failures, while repeated evidence for one call is stable', () => {
    const { trace } = setup();
    trace.observe(event()); trace.observe(event());
    expect(trace.source('contact', 'fetch')).toBeDefined();
    trace.observe(event({ connection_name: 'personal' }));
    expect(trace.source('contact', 'fetch')).toBeUndefined();
    const failed = setup().trace;
    failed.observe(event()); failed.observe(event({ outcome: 'failed' }));
    expect(failed.source('contact', 'fetch')).toBeUndefined();
    const mixed = setup().trace;
    mixed.observe(event()); mixed.observe(event({ surface_kind: 'connector' }));
    expect(mixed.source('contact', 'fetch')).toBeUndefined();
  });

  it('requires a matching vendor, scope, catalog, operation, and one declaration', () => {
    for (const candidate of [
      { ...schema, ingredient_id: 'publisher/other' },
      { ...schema, wraps_vendor: 'salesforce' }, { ...schema, scope: 'connection.api.salesforce.contact' },
      { ...schema, source_operations: { get: { catalog: 'publisher/other', operation: 'contact.read' } } },
      { ...schema, source_operations: { get: { catalog, operation: 'company.read' } } },
    ]) {
      const { trace } = setup([candidate]); trace.observe(event());
      expect(trace.source('contact', 'fetch')).toBeUndefined();
    }
    for (const trace of [setup([schema, schema]).trace, setup([schema], null).trace]) {
      trace.observe(event()); expect(trace.source('contact', 'fetch')).toBeUndefined();
    }
  });

  it('snapshots provenance at call completion and returns independent descriptors', () => {
    const currentManifest = structuredClone(manifest);
    const currentSchema = structuredClone(schema);
    let vendor = 'hubspot';
    const trace = createRecordOutputSources({ recipe, manifest: () => currentManifest,
      schemas: () => [currentSchema], connectionVendor: () => vendor });
    trace.observe(event());
    vendor = 'salesforce';
    currentSchema.wraps_vendor = 'salesforce';
    currentSchema.scope = 'connection.api.salesforce.contact';
    currentManifest.operations = {};
    const first = trace.source('contact', 'fetch')!;
    expect(first.platform).toBe('hubspot');
    first.platform = 'changed';
    expect(trace.source('contact', 'fetch')?.platform).toBe('hubspot');
    trace.observe(event());
    expect(trace.source('contact', 'fetch')).toBeUndefined();
  });

  it('treats changed proof on a repeated call and metadata lookup failures as unproven', () => {
    let vendor = 'hubspot';
    const trace = createRecordOutputSources({ recipe, manifest: () => manifest,
      schemas: () => [{ ...schema, wraps_vendor: vendor, scope: `connection.api.${vendor}.contact` }],
      connectionVendor: () => vendor });
    trace.observe(event());
    vendor = 'salesforce';
    trace.observe(event());
    expect(trace.source('contact', 'fetch')).toBeUndefined();
    const unavailable = createRecordOutputSources({ recipe, manifest: () => { throw new Error('unavailable'); },
      schemas: () => [schema], connectionVendor: () => 'hubspot' });
    expect(() => unavailable.observe(event())).not.toThrow();
    expect(unavailable.source('contact', 'fetch')).toBeUndefined();
  });

  it('carries real gateway evidence in progressive and final engine output without tagging derived values', async () => {
    const { trace } = setup();
    const progress: unknown[] = [];
    const result = await executeRecipe({
      recipe, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: async () => ({ id: '42', email: 'ana@example.test' }),
      manifestGetter: () => manifest,
      connectionProfileResolver: () => ({ catalog_slug: catalog, allowed_operations: ['contact.read'] }),
      entityFields: () => [{ key: 'id', type: 'string', required: true }, { key: 'email', type: 'string', required: true }],
      onGatewayCall: trace.observe, recordOutputSource: trace.source,
      onProgress: event => { if (event.type === 'render_ready') progress.push(event.render); },
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.output.render[0]?.record_source).toEqual({ kind: 'api', platform: 'hubspot', connection_name: 'sales', entity: 'contact' });
    expect(result.output.render[1]?.record_source).toBeUndefined();
    expect(result.output.render[2]?.record_source).toBeUndefined();
    expect(progress).toContainEqual(result.output.render);
  });
});


describe('API record provenance across real gateway cache hits', () => {
  const fixture = () => {
    const cache = createInMemoryStore();
    let currentManifest: IngredientManifest = structuredClone({ ...manifest, category: 'data' });
    let currentSchemas = [structuredClone(schema)];
    let identity: unknown = { enrollment: 1, credential: 'fixture-account-a' };
    let vendor = 'hubspot';
    const raw = vi.fn(async () => ({ id: '42', email: 'ana@example.test' }));
    const run = async (options: { evidence?: boolean; fresh?: boolean; otherRecipe?: boolean; proofFailure?: 'read' | 'write' } = {}) => {
      const currentRecipe = { ...recipe, ...(options.otherRecipe ? { recipe_id: 'another-page' } : {}),
        ...(options.fresh ? { steps: recipe.steps.map(step => ({ ...step, cache: 'fresh' as const })) } : {}) };
      const trace = createRecordOutputSources({ recipe: currentRecipe, manifest: () => currentManifest,
        schemas: () => currentSchemas, connectionVendor: () => vendor, connectionIdentity: () => identity,
        ...(options.evidence === false ? {} : { cacheEvidence: options.proofFailure ? {
          get: () => { throw new Error('receipt read unavailable'); },
          set: () => { throw new Error('receipt write unavailable'); },
        } : recordOutputSourceCache(cache) }) });
      const statuses: string[] = [];
      const executor = withIngredientCache(raw, { store: cache, recipe_id: currentRecipe.recipe_id,
        recipe_ttl: 300, manifestLoader: async () => currentManifest, resultEvidence: trace.resultEvidence,
        onStatus: status => statuses.push(status) });
      const progress: unknown[] = [];
      const result = await executeRecipe({ recipe: currentRecipe,
        stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} }, ingredientExecutor: executor,
        manifestGetter: () => currentManifest,
        connectionProfileResolver: () => ({ catalog_slug: catalog, allowed_operations: ['contact.read'] }),
        entityFields: () => [{ key: 'id', type: 'string', required: true }],
        onGatewayCall: trace.observe, recordOutputSource: trace.source,
        onProgress: event => { if (event.type === 'render_ready') progress.push(event.render); },
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      return { result, statuses, progress };
    };
    return { raw, run, cache,
      identity: (value: unknown) => { identity = value; },
      schema: (value: EntitySchemaIngredientInput[]) => { currentSchemas = value; },
      manifest: (value: IngredientManifest) => { currentManifest = value; },
      vendor: (value: string) => { vendor = value; },
    };
  };

  it('preserves source metadata through a hit and a second recipe without another provider call', async () => {
    const f = fixture();
    const first = await f.run();
    const hit = await f.run();
    const other = await f.run({ otherRecipe: true });
    expect(first.statuses).toContain('miss');
    expect(hit.statuses).toContain('hit');
    expect(other.statuses).toContain('hit');
    expect(f.raw).toHaveBeenCalledOnce();
    const source = { kind: 'api', platform: 'hubspot', connection_name: 'sales', entity: 'contact',
      connection_revision: connectionRevision({ enrollment: 1, credential: 'fixture-account-a' }) };
    for (const run of [first, hit, other]) {
      expect(run.result.output.render[0]?.record_source).toEqual(source);
      expect(run.result.output.render[1]?.record_source).toBeUndefined();
      expect(run.progress).toContainEqual(run.result.output.render);
    }
  });

  it.each(['account', 'schema', 'manifest', 'vendor'] as const)('leaves cached values manual after %s drift', async change => {
    const f = fixture();
    await f.run();
    if (change === 'account') f.identity({ enrollment: 2, credential: 'fixture-account-b' });
    if (change === 'schema') f.schema([{ ...schema, target_id: { fields: ['id'], template: 'changed_{id}' } }]);
    if (change === 'manifest') f.manifest({ ...manifest, category: 'data', description: 'changed binding contract' });
    if (change === 'vendor') {
      f.vendor('salesforce'); f.schema([{ ...schema, wraps_vendor: 'salesforce', scope: 'connection.api.salesforce.contact' }]);
    }
    const hit = await f.run();
    expect(hit.statuses).toContain('hit');
    expect(hit.result.output.render[0]?.data).toEqual({ id: '42', email: 'ana@example.test' });
    expect(hit.result.output.render[0]?.record_source).toBeUndefined();
    expect(f.raw).toHaveBeenCalledOnce();
  });

  it.each([['lookup', 'account'], ['refresh', 'account'], ['lookup', 'schema'], ['refresh', 'schema']] as const)(
    'rejects binding drift during cache %s (%s)', async (phase, change) => {
    const f = fixture();
    await f.run();
    const changeAccount = () => {
      if (change === 'account') f.identity({ enrollment: 2, credential: 'replacement' });
      else f.schema([{ ...schema, target_id: { fields: ['id'], template: 'changed_{id}' } }]);
    };
    if (phase === 'lookup') {
      const get = f.cache.get.bind(f.cache);
      vi.spyOn(f.cache, 'get').mockImplementationOnce(async key => {
        const entry = await get(key); changeAccount(); return entry;
      });
    } else {
      const set = f.cache.set.bind(f.cache);
      vi.spyOn(f.cache, 'set').mockImplementation(async entry => { await set(entry); changeAccount(); });
      if (f.cache.touch) {
        const touch = f.cache.touch.bind(f.cache);
        vi.spyOn(f.cache, 'touch').mockImplementation(async (key, at) => { await touch(key, at); changeAccount(); });
      }
    }
    const hit = await f.run();
    expect(hit.statuses).toContain('hit');
    expect(hit.result.output.render[0]?.data).toEqual({ id: '42', email: 'ana@example.test' });
    expect(hit.result.output.render[0]?.record_source).toBeUndefined();
    expect(f.raw).toHaveBeenCalledOnce();
  });

  it('does not infer proof for legacy cache entries and restores it after an actual cache miss', async () => {
    const f = fixture();
    await f.run({ evidence: false });
    const hit = await f.run();
    expect(hit.statuses).toContain('hit');
    expect(hit.result.output.render[0]?.record_source).toBeUndefined();
    const fresh = await f.run({ fresh: true });
    expect(fresh.result.output.render[0]?.record_source).toBeDefined();
    // Fresh bypasses cache writes, so it does not retroactively attest the old entry.
    expect((await f.run()).result.output.render[0]?.record_source).toBeUndefined();
    await f.cache.clear();
    expect((await f.run()).result.output.render[0]?.record_source).toBeDefined();
    expect((await f.run()).result.output.render[0]?.record_source).toBeDefined();
    expect(f.raw).toHaveBeenCalledTimes(3);
  });

  it.each(['read', 'write'] as const)('keeps receipt %s failures manual without failing the run', async failure => {
    const f = fixture();
    if (failure === 'read') await f.run();
    const run = await f.run({ proofFailure: failure });
    expect(run.result.output.render[0]?.data).toEqual({ id: '42', email: 'ana@example.test' });
    expect(run.result.output.render[0]?.record_source).toBeUndefined();
    expect(f.raw).toHaveBeenCalledOnce();
  });

  it('refuses a receipt when enrollment changes during the provider request', async () => {
    const f = fixture();
    f.raw.mockImplementationOnce(async () => {
      f.identity({ enrollment: 2 });
      return { id: '42', email: 'ana@example.test' };
    });
    expect((await f.run()).result.output.render[0]?.record_source).toBeUndefined();
    expect((await f.run()).result.output.render[0]?.record_source).toBeUndefined();
    expect(f.raw).toHaveBeenCalledOnce();
  });
});
