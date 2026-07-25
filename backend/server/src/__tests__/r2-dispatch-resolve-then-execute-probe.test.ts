/** R2 dispatch probe — resolve-then-execute-transient (the empirical seal).
 *
 *  Spec: docs/unified-pack-exploration/recipe-identity-and-dependency-resolution.md §3
 *  (and connection-agnostic-op-contract.md §3, which DECIDED R1 / deferred R2).
 *
 *  The op-contract's two probes proved **R1** (install-time bake) at the ENGINE
 *  level (`packages/engine/.../connection-agnostic-op-probe.test.ts`). This file
 *  seals **R2** at the SERVER level — the half R1 left untested: that a canonical
 *  recipe can be resolved to concrete form *at dispatch* (from the connection the
 *  run chose), executed INLINE through the real `handleExecute` → gate → audit
 *  path, and **never persisted**.
 *
 *  What it proves, with no live creds (fixture fetch):
 *   1. An inline recipe still carrying a canonical op-step is REJECTED — the
 *      fail-closed placeholder for "no dispatch resolver yet"
 *      (`execute-handler.ts:476-485`).
 *   2. Resolve-at-dispatch (build `PackResolutionContext` FROM the connection →
 *      `resolveConnectionAgnosticRecipe`) → the concrete recipe runs inline and
 *      SUCCEEDS — `handleExecute` consults the recipe store not at all.
 *   3. The gate ran and dispatched: a `connection_gateway` audit row stamps
 *      `op × connection` (target = the connection, detail.operation_id = the
 *      resolved vendor op, outcome = success) — i.e. the gate/audit path is reused
 *      unchanged, keyed on `(connection, op)`, NOT on recipe identity/persistence.
 *   4. The transient recipe is never written to the recipe store.
 *
 *  Mutation-sensitivity: drop the resolve-at-dispatch step (pass the canonical
 *  recipe straight to `handleExecute`) and test 2 flips to the test-1 rejection —
 *  proving the transient resolve is exactly what makes a canonical recipe runnable
 *  off-install.
 */

import type {
  ConnectionOperationProfile,
  ConnectionRow,
  EntityFieldRow,
  IngredientManifest,
  OperationRow,
  OperationSpec,
  PackResolutionContext,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import type { ConnectionAdapterStore } from '@recued/ingredients';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import { resolveConnectionAgnosticRecipe } from '@recued/recipes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createInMemoryConnectionOperationProfileStore } from '../connection-operation-profile.js';

const CATALOG_SLUG = 'hubspot-full';
const CONNECTION = 'hubspot1';
const OP_KEY = 'deal.search';
const OP_ID = 'recued-core/hubspot-full.deal.search';
const RECIPE_ID = 'surface-open-deals-canonical-r2';

// ── Fixture: the raw HubSpot search body the mocked fetch returns ──
const RAW_SEARCH_RESULT = {
  results: [
    { id: '1', properties: { dealname: 'D1', amount: 10000, dealstage: 'Prospect', hubspot_owner_id: 'owner_A', hs_is_closed: false } },
    { id: '2', properties: { dealname: 'D2', amount: 20000, dealstage: 'Qualified', hubspot_owner_id: 'owner_B', hs_is_closed: false } },
  ],
};

/** Catalog-form manifest — a non-empty `operations` map routes the resolved op
 *  through the D-165 gateway; `kind: 'connection'` + a `surfaces.api` REST binding
 *  dispatches over the connection adapter (mocked fetch). The op is `read` /
 *  `approval: never` so it admits + dispatches without a pause. */
const catalogManifest = (): IngredientManifest =>
  ({
    slug: CATALOG_SLUG,
    name: 'HubSpot Full',
    description: 'R2 probe catalog.',
    author: 'recued-core',
    kind: 'connection',
    category: 'data',
    risk_tier: 'read',
    version: 1,
    input: { operation: null, args: null },
    output: { result: 'result' },
    operations: {
      [OP_KEY]: {
        operation_id: OP_ID,
        risk_tier: 'read',
        groups: ['hubspot.deals.read'],
        approval: 'never',
      },
    } satisfies Record<string, OperationSpec>,
    surfaces: {
      api: {
        transport: 'rest',
        default_base_url: 'https://api.hubapi.com',
        auth: { kind: 'none' },
        executes: {
          [OP_KEY]: { kind: 'rest', method: 'POST', path_template: '/crm/v3/objects/deals/search' },
        },
      },
    },
  }) as unknown as IngredientManifest;

/** The ONE connection-agnostic recipe — a single canonical `deal.search` op-step,
 *  NO connection, NO vendor field names. The dispatch resolver injects the
 *  connection + projection. */
const canonicalRecipe = (): RecipeDefinition =>
  ({
    recipe_id: RECIPE_ID,
    version: 1,
    ttl: 300,
    metadata: {
      name: RECIPE_ID,
      description: 'R2 probe — connection-agnostic canonical recipe.',
      author: 'probe',
      supported_platforms: [],
    },
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'deals', op: OP_KEY, args: { limit: 200 } } as unknown as RecipeStep],
    output: { sidebar: [] },
  }) as RecipeDefinition;

const operationRow = (operation: string, httpVerb: 'get' | 'post'): OperationRow => {
  const family = operation.slice(0, operation.indexOf('.'));
  return {
    family,
    operation,
    verb: httpVerb,
    surface: 'api',
    binding: { kind: 'rest', method: httpVerb === 'get' ? 'GET' : 'POST', path_template: `/mock/${operation}` },
    risk_tier: 'read',
    approval: 'never',
    groups: [`${family}.read`],
    reviewed: true,
  };
};

const entityField = (
  row: Pick<EntityFieldRow, 'entity' | 'field_path' | 'maps_to' | 'type'>,
): EntityFieldRow => ({ reviewed: true, ...row });

// ── The dispatcher-side helper R2 needs (doc §3): given the connection chosen at
//    run time, derive the PackResolutionContext and resolve the canonical recipe
//    to concrete — transiently. The connection→catalog (+ installed_pack_id) edge
//    is the binding store row at dispatch; vendor is `CATALOG_VENDOR_SLUGS`. Here
//    they are a literal map so the test stays creds-free, but the SHAPE is the
//    real one (every field derives from `connection`).
const CONNECTION_TO_CATALOG: Record<string, string> = { [CONNECTION]: CATALOG_SLUG };

const resolveAtDispatch = (
  canonical: RecipeDefinition,
  connection: string,
  registry: ReturnType<typeof createManifestRegistry>,
): RecipeDefinition => {
  const catalogSlug = CONNECTION_TO_CATALOG[connection];
  if (!catalogSlug) throw new Error(`R2 probe: no catalog bound to connection '${connection}'`);
  if (registry.get(catalogSlug) === null) throw new Error(`R2 probe: catalog '${catalogSlug}' not registered`);
  const ctx: PackResolutionContext = {
    pack_slug: 'pack/recued-core/hubspot',
    vendor: 'hubspot',
    connection, // ← THE RUN'S chosen connection (not an install-time pin)
    catalog_slug: catalogSlug,
    result_path: 'results',
    search_style: 'hubspot_search',
    operation_families: [operationRow('deal.search', 'post'), operationRow('deal.read', 'get')],
    entity_fields: [
      entityField({ entity: 'Deal', maps_to: 'name', field_path: 'properties.dealname', type: 'string' }),
      entityField({ entity: 'Deal', maps_to: 'stage', field_path: 'properties.dealstage', type: 'string' }),
      entityField({ entity: 'Deal', maps_to: 'amount', field_path: 'properties.amount', type: 'number' }),
      entityField({ entity: 'Deal', maps_to: 'owner', field_path: 'properties.hubspot_owner_id', type: 'string' }),
      entityField({ entity: 'Deal', maps_to: 'is_closed', field_path: 'properties.hs_is_closed', type: 'boolean' }),
    ],
  };
  return resolveConnectionAgnosticRecipe(canonical, ctx).recipe;
};

/** Minimal connection store — one base_url'd `api` row per requested name so the
 *  catalog's REST surface binding resolves through the connection-api handler to
 *  the mocked global fetch. */
const connectionRowStore = (): ConnectionAdapterStore => ({
  get: (kind, name) =>
    kind === 'api'
      ? ({
          pk: `api:${name}`,
          kind: 'api',
          name,
          display_name: name,
          config_json: JSON.stringify({ base_url: 'https://api.hubapi.com' }),
          auth_ciphertext: '',
          enrolled_at: 0,
          updated_at: 0,
        } as ConnectionRow)
      : null,
});

const auditLog = (): AuditLogStore =>
  createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());

const gatewayRows = async (log: AuditLogStore): Promise<ActivityEntry[]> =>
  (await log.listActivities()).filter((a) => a.action === 'connection_gateway');

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

interface Harness {
  deps: ExecuteHandlerDeps;
  recipeStore: ReturnType<typeof createRecipeStore>;
  registry: ReturnType<typeof createManifestRegistry>;
  log: AuditLogStore;
}

const setup = (): Harness => {
  const registry = createManifestRegistry('/nonexistent');
  registry.register(catalogManifest());
  // No db, and we never register/save the recipe — the inline path must run it
  // without ever consulting the store (the "never persisted" claim).
  const recipeStore = createRecipeStore('/nonexistent');
  const log = auditLog();
  const profileSeed: Record<string, ConnectionOperationProfile> = {
    [CONNECTION]: { allowed_operations: [OP_KEY], catalog_slug: CATALOG_SLUG },
  };
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: {
      manifests: registry,
      connectionStore: connectionRowStore(),
      connectionApi: {
        decodeAuth: async () => ({ type: 'none' }),
        persistAuth: async () => {},
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    },
    baseVault: {},
    instanceId: 'r2-probe-1',
    auditLog: log,
    connectionOperationProfiles: createInMemoryConnectionOperationProfileStore(profileSeed),
  };
  return { deps, recipeStore, registry, log };
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => RAW_SEARCH_RESULT,
      text: async () => JSON.stringify(RAW_SEARCH_RESULT),
    }) as unknown as Response,
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('R2 dispatch probe — resolve-then-execute-transient (server gate/audit reuse, no persist)', () => {
  it('1 · an inline recipe still carrying a canonical op-step is rejected (the fail-closed placeholder)', async () => {
    const { deps } = setup();
    await expect(
      handleExecute(deps, { recipe: canonicalRecipe(), trigger_source: 'manual', config: {} }),
    ).rejects.toThrow(/canonical op-step/i);
  });

  it('2 · resolve-at-dispatch (ctx FROM the connection) → concrete recipe runs inline + SUCCEEDS', async () => {
    const { deps, registry } = setup();
    const concrete = resolveAtDispatch(canonicalRecipe(), CONNECTION, registry);
    // The transient resolve produced a concrete recipe — no canonical op-step left.
    expect(concrete.steps.some((s) => typeof (s as { op?: unknown }).op === 'string')).toBe(false);

    const res = await handleExecute(deps, { recipe: concrete, trigger_source: 'manual', config: {} });
    expect(res.success).toBe(true);
    expect(res.recipe_id).toBe(RECIPE_ID);
    // the canonical fetch step ran (not skipped)
    expect(res.steps.find((s) => s.id === 'deals')?.skipped).toBe(false);
  });

  it('3 · the gate ran + dispatched: audit stamps op × connection (keyed on connection, not recipe persistence)', async () => {
    const { deps, registry, log } = setup();
    const concrete = resolveAtDispatch(canonicalRecipe(), CONNECTION, registry);
    const res = await handleExecute(deps, { recipe: concrete, trigger_source: 'manual', config: {} });
    expect(res.success).toBe(true);

    const rows = await gatewayRows(log);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(CONNECTION); // ← connection dimension
    const detail = JSON.parse(rows[0]?.detail ?? '{}') as { outcome: string; operation_id: string };
    expect(detail.outcome).toBe('success');
    expect(detail.operation_id).toBe(OP_ID); // ← op dimension (recipe dimension = res.recipe_id above)
    // a real dispatch reached the wire exactly once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('4 · the transiently-resolved recipe was never persisted to the recipe store', async () => {
    const { deps, recipeStore, registry } = setup();
    const concrete = resolveAtDispatch(canonicalRecipe(), CONNECTION, registry);
    await handleExecute(deps, { recipe: concrete, trigger_source: 'manual', config: {} });

    // inline execution consulted the store not at all — the recipe is unknown to it.
    expect(recipeStore.get(RECIPE_ID)).toBeNull();
    expect(recipeStore.ids()).not.toContain(RECIPE_ID);
  });
});
