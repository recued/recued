/** D-182 §10 step 8 / R1 — handleExecute verb-split integration.
 *
 *  Proves the runtime half of kernel canonical runnability: a `core.crm.*` /
 *  `core.acct.*` op-step run with NO provider in its convention family bound
 *  (here: no connection store → no bound families) takes the verb-split —
 *    - read / search → the op-step is rewritten to an empty result, the recipe
 *      RUNS to success on empty data, and `runnability_warnings` discloses it;
 *    - create / update / delete → the run FAILS CLOSED pre-run with the typed
 *      `connection_required` error (a write never silently no-ops).
 *  A recipe with no canonical op-step is inert (no warnings, untouched).
 *
 *  No connection store / no fetch mock is wired — R1 rewrites the read away to a
 *  pure transform before any IO, so the run is fully local. Mirrors the minimal
 *  `context-server.test.ts` harness.
 */
import type {
  ConnectionRow,
  EntitySchemaIngredientInput,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';
import { RpcError } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { LocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

/** A vendor-neutral CRM READ recipe: one `core.crm.deal.search` op + a count of
 *  the result so the empty propagation is observable downstream. */
const CRM_READ_RECIPE = {
  recipe_id: 'r1-crm-read',
  version: 1,
  ttl: 300,
  metadata: { name: 'r1-crm-read', description: 'unit', author: 'test', supported_platforms: [] },
  variables: { crm: { label: 'CRM connection', type: 'connection', connection_kind: 'api' } },
  steps: [
    { id: 'deals', op: 'core.crm.deal.search', args: { limit: 50 } },
    // Count over the (empty) result — proves the empty [] flows through a
    // downstream transform without erroring (downstream-safe).
    { id: 'n', transform: 'count', input: '{{step.deals}}' },
    { id: 'msg', transform: 'template', template: '{{step.n}} deals' },
  ],
  output: { sidebar: [{ type: 'text', source: 'step.msg' }] },
} as unknown as RecipeDefinition;

/** A CRM WRITE recipe: one `core.crm.deal.create` op. */
const CRM_WRITE_RECIPE = {
  recipe_id: 'r1-crm-write',
  version: 1,
  ttl: 300,
  metadata: { name: 'r1-crm-write', description: 'unit', author: 'test', supported_platforms: [] },
  variables: { crm: { label: 'CRM connection', type: 'connection', connection_kind: 'api' } },
  steps: [{ id: 'mk', op: 'core.crm.deal.create', args: { name: 'New deal' } }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** A pure-transform recipe with NO canonical op-step — R1 must be inert. */
const PLAIN_RECIPE = {
  recipe_id: 'r1-plain',
  version: 1,
  ttl: 300,
  metadata: { name: 'r1-plain', description: 'unit', author: 'test', supported_platforms: [] },
  variables: {},
  steps: [{ id: 'noop', transform: 'template', template: 'ran' }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

const makeDeps = (): ExecuteHandlerDeps => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(CRM_READ_RECIPE);
  recipeStore.register(CRM_WRITE_RECIPE);
  recipeStore.register(PLAIN_RECIPE);
  // No connectionStore → no bound convention families → R1 fires.
  return { recipeStore, executorConfig: { manifests }, baseVault: {} };
};

describe('D-182 §10 step 8 / R1 — handleExecute verb-split', () => {
  it('an unbound CRM READ runs to success on an empty result + discloses runnability_warnings', async () => {
    const res = await handleExecute(makeDeps(), { recipe_id: 'r1-crm-read' });
    expect(res.success).toBe(true);
    // The op-step was rewritten to a transform (not an unresolved op / IO step).
    expect(res.steps.find((s) => s.id === 'deals')?.type).toBe('transform');
    expect(res.steps.find((s) => s.id === 'deals')?.skipped).toBe(false);
    // Empty [] propagated downstream without error: count = 0 → "0 deals".
    expect(res.steps.find((s) => s.id === 'n')?.error).toBeFalsy();
    expect(res.output.sidebar[0]?.data).toBe('0 deals');
    // The pre-run warning is surfaced to the owner.
    expect(res.runnability_warnings).toBeDefined();
    expect(res.runnability_warnings).toHaveLength(1);
    expect(res.runnability_warnings?.[0]).toMatch(/crm not connected/i);
  });

  it('an unbound CRM WRITE fails closed pre-run with the typed connection_required error', async () => {
    let caught: unknown;
    try {
      await handleExecute(makeDeps(), { recipe_id: 'r1-crm-write' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RpcError);
    const err = caught as RpcError;
    expect(err.code).toBe('connection_required');
    expect(err.message).toMatch(/core\.crm\.deal\.create/);
    expect(err.message).toMatch(/cannot run/i);
    // The typed payload names the blocked op for an AI caller.
    expect((err.details as { blocked_ops?: string[] } | undefined)?.blocked_ops).toEqual([
      'core.crm.deal.create',
    ]);
  });

  it('a recipe with no canonical op-step is inert — runs, no runnability_warnings', async () => {
    const res = await handleExecute(makeDeps(), { recipe_id: 'r1-plain' });
    expect(res.success).toBe(true);
    expect(res.runnability_warnings).toBeUndefined();
  });
});

// ──────────── Fix 2 — merged registry binds pack-composition vendors ────────────

/** An accounting WRITE recipe (`core.acct.invoice.create`) — `acct` is a
 *  pack-composition-only family (no built-in vendor), so its run-time binding
 *  depends entirely on the merged registry threaded from `localManifestStore`. */
const ACCT_WRITE_RECIPE = {
  recipe_id: 'r1-acct-write',
  version: 1,
  ttl: 300,
  metadata: { name: 'r1-acct-write', description: 'unit', author: 'test', supported_platforms: [] },
  variables: { acct: { label: 'Accounting connection', type: 'connection', connection_kind: 'api' } },
  steps: [{ id: 'mk', op: 'core.acct.invoice.create', args: { amount: 100 } }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** A `kind: 'api'` connection row bound to `vendor`. */
const mkRow = (name: string, vendor: string): ConnectionRow => ({
  pk: `api:${name}`,
  kind: 'api',
  name,
  display_name: name,
  config_json: JSON.stringify({ vendor }),
  auth_ciphertext: '',
  enrolled_at: 0,
  updated_at: 0,
});

const connectionStoreOf = (rows: ConnectionRow[]): ConnectionStoreSqlite =>
  ({
    list: (query?: { kind?: string }) =>
      query?.kind ? rows.filter((r) => r.kind === query.kind) : rows,
  }) as unknown as ConnectionStoreSqlite;

/** A QuickBooks `acct_alias` entity schema the merged registry lifts. */
const qbAcctSchema: EntitySchemaIngredientInput = {
  ingredient_id: 'quickbooks-acct',
  wraps_vendor: 'quickbooks',
  entity_id: 'qbinvoice',
  scope: 'connection.api.quickbooks.qbinvoice',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  acct_alias: 'invoice',
  target_id: { fields: ['id'], template: 'qbinvoice_{id}' },
  meta_fields: [{ key: 'id', type: 'string', source_path: 'id' }],
  source_operations: {},
} as unknown as EntitySchemaIngredientInput;

const manifestStoreOf = (
  schemas: EntitySchemaIngredientInput[],
): Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'> => ({
  listManifests: () => [{ slug: 'qb-pack' } as unknown as IngredientManifest],
  getEntitySchemas: () => schemas,
});

const makeAcctDeps = (opts: { quickbooksConnected: boolean; packInstalled: boolean }): ExecuteHandlerDeps => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(ACCT_WRITE_RECIPE);
  return {
    recipeStore,
    executorConfig: { manifests },
    baseVault: {},
    ...(opts.quickbooksConnected
      ? { connectionStore: connectionStoreOf([mkRow('qb', 'quickbooks')]) }
      : {}),
    ...(opts.packInstalled ? { localManifestStore: manifestStoreOf([qbAcctSchema]) } : {}),
  } as ExecuteHandlerDeps;
};

describe('D-182 §10 step 8 / R1 — handleExecute merged registry (Fix 2)', () => {
  it('a QuickBooks acct WRITE with NO installed pack fails closed (built-ins only → acct unbound)', async () => {
    let caught: unknown;
    try {
      await handleExecute(makeAcctDeps({ quickbooksConnected: true, packInstalled: false }), {
        recipe_id: 'r1-acct-write',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RpcError);
    const err = caught as RpcError;
    expect(err.code).toBe('connection_required');
    expect((err.details as { blocked_ops?: string[] } | undefined)?.blocked_ops).toEqual([
      'core.acct.invoice.create',
    ]);
  });

  it('the SAME WRITE with the QuickBooks pack installed clears R1 (acct family bound via the merged registry)', async () => {
    let caught: unknown;
    try {
      await handleExecute(makeAcctDeps({ quickbooksConnected: true, packInstalled: true }), {
        recipe_id: 'r1-acct-write',
      });
    } catch (e) {
      caught = e;
    }
    // R1 no longer blocks: the merged registry maps the connected `quickbooks`
    // vendor → the `acct` family. The run proceeds PAST R1 to the dispatch resolver,
    // which (no connection profile wired in this minimal harness) can't lower the
    // canonical op — a `bad_request`, NOT the R1 `connection_required`.
    expect(caught).toBeInstanceOf(RpcError);
    const err = caught as RpcError;
    expect(err.code).not.toBe('connection_required');
    expect(err.code).toBe('bad_request');
    expect((err.details as { blocked_ops?: string[] } | undefined)?.blocked_ops).toBeUndefined();
  });
});
