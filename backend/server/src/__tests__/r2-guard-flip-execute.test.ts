/** Build step 2 (R2) — the execute-handler guard-flip, end-to-end.
 *
 *  Spec: internal design notes §3.
 *  The `r2-dispatch-resolve-then-execute-probe` test fed a PRE-resolved recipe inline;
 *  this proves the wiring: `handleExecute` given a *canonical* recipe (op-step + a
 *  `type:'connection'` variable) RESOLVES it at dispatch from the connection the run
 *  supplies in `config`, then runs it through the real gate + audit. And the fail-closed
 *  control: the same recipe WITHOUT a supplied connection is still rejected.
 */

import type {
  ConnectionOperationProfile,
  ConnectionRow,
  IngredientManifest,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import { CATALOG_VENDOR_SLUGS } from '@recued/contracts';
import type { ConnectionAdapterStore } from '@recued/ingredients';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createInMemoryConnectionOperationProfileStore } from '../connection-operation-profile.js';

const CATALOG_SLUG = CATALOG_VENDOR_SLUGS.hubspot; // real bundled slug → default vendor resolution
const CONNECTION = 'hubspot1';
const OP_ID = `recued-core/${CATALOG_SLUG}.deal.search`;

const RAW_SEARCH_RESULT = {
  results: [
    { id: '1', properties: { dealname: 'D1', amount: 10000, dealstage: 'Prospect', hubspot_owner_id: 'o_A', hs_is_closed: false } },
  ],
};

const catalogManifest = (): IngredientManifest =>
  ({
    slug: CATALOG_SLUG,
    name: 'HubSpot Catalog',
    description: 'R2 guard-flip fixture',
    author: 'recued-core',
    kind: 'connection',
    category: 'data',
    risk_tier: 'read',
    version: 1,
    input: { operation: null, args: null },
    output: { result: 'result' },
    operations: {
      'deal.search': { operation_id: OP_ID, risk_tier: 'read', groups: ['hubspot.deals.read'], approval: 'never' },
    },
    surfaces: {
      api: {
        transport: 'rest',
        default_base_url: 'https://api.hubapi.com',
        auth: { kind: 'none' },
        search_style: 'hubspot_search',
        result_path: 'results',
        executes: { 'deal.search': { kind: 'rest', method: 'POST', path_template: '/crm/v3/objects/deals/search' } },
      },
    },
  }) as unknown as IngredientManifest;

/** Canonical recipe: a `type:'connection'` variable + one canonical op-step. The
 *  GUARD must lower this at dispatch from `config.conn`. */
const canonicalWithConn = (): RecipeDefinition =>
  ({
    recipe_id: 'r2-guard-flip-canonical',
    version: 1,
    ttl: 300,
    metadata: { name: 'r2-guard-flip-canonical', description: 'R2 guard-flip', author: 'probe', supported_platforms: [] },
    variables: { conn: { label: 'CRM connection', type: 'connection' } },
    prefetch_steps: [],
    steps: [{ id: 'deals', op: 'deal.search', args: { limit: 50 } } as unknown as RecipeStep],
    output: { sidebar: [] },
  }) as unknown as RecipeDefinition;

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

const setup = (): { deps: ExecuteHandlerDeps; log: AuditLogStore } => {
  const registry = createManifestRegistry('/nonexistent');
  registry.register(catalogManifest());
  const log = auditLog();
  const profileSeed: Record<string, ConnectionOperationProfile> = {
    [CONNECTION]: { allowed_operations: ['deal.search'], catalog_slug: CATALOG_SLUG },
  };
  const deps: ExecuteHandlerDeps = {
    recipeStore: createRecipeStore('/nonexistent'),
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
    instanceId: 'r2-guard-flip-1',
    auditLog: log,
    connectionOperationProfiles: createInMemoryConnectionOperationProfileStore(profileSeed),
  };
  return { deps, log };
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

describe('R2 build step 2 — execute-handler guard-flip (canonical recipe resolved at dispatch)', () => {
  it('the guard resolves a canonical recipe at dispatch when config supplies the connection → it runs', async () => {
    const { deps, log } = setup();
    const res = await handleExecute(deps, {
      recipe: canonicalWithConn(),
      trigger_source: 'manual',
      config: { conn: CONNECTION },
    });
    expect(res.success).toBe(true);
    // dispatched through the real gate/audit against the supplied connection.
    const rows = await gatewayRows(log);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(CONNECTION);
    const detail = JSON.parse(rows[0]?.detail ?? '{}') as { outcome: string; operation_id: string };
    expect(detail.outcome).toBe('success');
    expect(detail.operation_id).toBe(OP_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fail-closed control: the same canonical recipe with NO supplied connection is rejected', async () => {
    const { deps } = setup();
    await expect(
      handleExecute(deps, { recipe: canonicalWithConn(), trigger_source: 'manual', config: {} }),
    ).rejects.toThrow(/needs a connection[\s\S]*must be pinned/i);
  });
});
