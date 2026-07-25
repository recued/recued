/** D-166 Override-Write Slice A1 - contract override RPCs.
 *
 * Covers the Settings-only `collection.contract.*` handler family against the
 * real contract store, plus the live store -> catalog gateway loop and the real
 * createServerHandlerSet -> WS dispatch wiring guard.
 */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  D165_CONTRACT_SCHEMA,
  OWNER_OPERATION_SCOPE,
  OVERRIDE_SCOPE,
  RpcError,
  catalogIngredientViews,
  isPreflightRequiredSignal,
  isReservedLocalRpc,
  overrideRowValue,
  type Actor,
  type ApiExecutionBinding,
  type ConnectionOperationProfile,
  type GatewayCallAudit,
  type IngredientManifest,
  type OperationRiskTier,
  type OperationSpec,
  type OverridePolicyInput,
  type PreflightRequiredSignal,
  type ProviderSurfaces,
} from '@recued/contracts';
import type { ExecutionContext, IngredientExecutor } from '@recued/engine';
import type { AuditLogStore } from '@recued/storage';

import { runCatalogOperation } from '../../../../packages/engine/src/catalog-gateway.js';
import { makeContractHandlers, type ContractRpcDeps } from '../contract-handler.js';
import {
  createContractScanFn,
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import { createServerHandlerSet, type ServerConfig } from '../index.js';

const NOW = 1_714_867_200_000;
const RPC_CTX = undefined as unknown as never;

const GITHUB_SLUG = 'github/issues';
const GITHUB_OP_KEY = 'list';
const GITHUB_OP_ID = `${GITHUB_SLUG}.${GITHUB_OP_KEY}`;
const OTHER_SLUG = 'github/projects';
const SIMPLE_SLUG = 'github/simple';

const PUB_SLUG = 'pub/cat';
const PUB_OP_KEY = 'x';
const PUB_OP_ID = `${PUB_SLUG}.${PUB_OP_KEY}`;

type ContractHandlers = NonNullable<ReturnType<typeof makeContractHandlers>>['handlers'];

let now = NOW;
const openDbs: Database.Database[] = [];
const openHarnesses: RpcHarness[] = [];

beforeEach(() => {
  now = NOW;
});

afterEach(async () => {
  for (const harness of openHarnesses.splice(0)) {
    await harness.close();
  }
  for (const db of openDbs.splice(0).reverse()) {
    db.close();
  }
});

const operation = (
  operation_id: string,
  risk_tier: OperationRiskTier = 'read',
): OperationSpec => ({
  operation_id,
  risk_tier,
  groups: ['recued-core/test.read'],
});

const restBinding = (
  extras: Partial<Extract<ApiExecutionBinding, { kind: 'rest' }>> = {},
): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'GET',
  path_template: '/items/{{id}}',
  ...extras,
});

const surfacesWith = (opKey: string): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.com',
    auth: { kind: 'none' },
    executes: { [opKey]: restBinding() },
  },
});

const catalogManifest = (
  slug: string,
  opKey: string,
  risk_tier: OperationRiskTier = 'read',
): IngredientManifest => ({
  slug,
  name: `Catalog ${slug}`,
  description: 'D-166 override RPC test catalog',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    [opKey]: operation(`${slug}.${opKey}`, risk_tier),
  },
  surfaces: surfacesWith(opKey),
});

const simpleManifest = (slug: string): IngredientManifest => ({
  slug,
  name: `Simple ${slug}`,
  description: 'D-166 override RPC simple-form fixture',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
});

// D-211 Slice 1 fixtures — a write-tier and a destructive-tier op for the
// write-site floor clamp + risk-downgrade confirm gates.
const WRITE_SLUG = 'github/write';
const WRITE_OP_KEY = 'push';
const WRITE_OP_ID = `${WRITE_SLUG}.${WRITE_OP_KEY}`;
const DESTR_SLUG = 'github/destroy';
const DESTR_OP_KEY = 'purge';
const DESTR_OP_ID = `${DESTR_SLUG}.${DESTR_OP_KEY}`;

const manifests = new Map<string, IngredientManifest>([
  [GITHUB_SLUG, catalogManifest(GITHUB_SLUG, GITHUB_OP_KEY)],
  [OTHER_SLUG, catalogManifest(OTHER_SLUG, GITHUB_OP_KEY)],
  [PUB_SLUG, catalogManifest(PUB_SLUG, PUB_OP_KEY)],
  [SIMPLE_SLUG, simpleManifest(SIMPLE_SLUG)],
  [WRITE_SLUG, catalogManifest(WRITE_SLUG, WRITE_OP_KEY, 'write')],
  [DESTR_SLUG, catalogManifest(DESTR_SLUG, DESTR_OP_KEY, 'destructive')],
]);

const getManifest = (slug: string): IngredientManifest | null =>
  manifests.get(slug) ?? null;

const listManifests = (): IngredientManifest[] => [...manifests.values()];

const makeStore = (): ContractStore => {
  const db = new Database(':memory:');
  openDbs.push(db);
  const store = createContractStore(db, { now: () => now });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  return store;
};

const makeHandlerHarness = (
  deps: Partial<ContractRpcDeps> = {},
): { store: ContractStore; handlers: ContractHandlers } => {
  const store = deps.store ?? makeStore();
  const slice = makeContractHandlers({
    store,
    getManifest: deps.getManifest ?? getManifest,
    listManifests: deps.listManifests ?? listManifests,
    // D-211 — thread the optional audit log so the override write/delete
    // reserve-class rows are assertable; absent (most harnesses) they skip.
    ...(deps.auditLog !== undefined ? { auditLog: deps.auditLog } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (!slice) throw new Error('contract handler slice was not created');
  return { store, handlers: slice.handlers };
};

const upsertOverride = (
  handlers: ContractHandlers,
  args: {
    actor: unknown;
    ingredient_id: unknown;
    operation_id?: unknown;
    policy: unknown;
  },
) =>
  handlers['collection.contract.upsertOverride'](
    args as Parameters<ContractHandlers['collection.contract.upsertOverride']>[0],
    RPC_CTX,
  );

const deleteOverride = (
  handlers: ContractHandlers,
  args: { actor: unknown; ingredient_id: unknown; operation_id?: unknown },
) =>
  handlers['collection.contract.deleteOverride'](
    args as Parameters<ContractHandlers['collection.contract.deleteOverride']>[0],
    RPC_CTX,
  );

const listOverrides = (handlers: ContractHandlers, args?: unknown) =>
  handlers['collection.contract.listOverrides'](
    args as Parameters<ContractHandlers['collection.contract.listOverrides']>[0],
    RPC_CTX,
  );

const upsertOwnerOverride = (
  handlers: ContractHandlers,
  args: { ingredient_id: unknown; operation_id: unknown; policy: unknown },
) =>
  handlers['collection.operation.upsertOwnerOverride'](
    args as Parameters<ContractHandlers['collection.operation.upsertOwnerOverride']>[0],
    RPC_CTX,
  );

const deleteOwnerOverride = (
  handlers: ContractHandlers,
  args: { ingredient_id: unknown; operation_id: unknown },
) =>
  handlers['collection.operation.deleteOwnerOverride'](
    args as Parameters<ContractHandlers['collection.operation.deleteOwnerOverride']>[0],
    RPC_CTX,
  );

const listOwnerOverrides = (handlers: ContractHandlers, args?: unknown) =>
  handlers['collection.operation.listOwnerOverrides'](
    args as Parameters<ContractHandlers['collection.operation.listOwnerOverrides']>[0],
    RPC_CTX,
  );

const listOwnerOperations = (handlers: ContractHandlers) =>
  handlers['collection.operation.listOperations'](undefined, RPC_CTX);

const listCatalogOperations = (handlers: ContractHandlers, args?: unknown) =>
  handlers['collection.contract.listCatalogOperations'](
    args as Parameters<ContractHandlers['collection.contract.listCatalogOperations']>[0],
    RPC_CTX,
  );

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
};

const expectRpcCode = async (
  promise: Promise<unknown>,
  code: string,
): Promise<RpcError> => {
  const caught = await captureRejection(promise);
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe(code);
  return caught as RpcError;
};

const viewKey = (view: { actor: string; ingredient_id: string; operation_id: string | null }) =>
  `${view.actor}:${view.ingredient_id}:${view.operation_id ?? '*'}`;

const sortViews = <T extends { actor: string; ingredient_id: string; operation_id: string | null }>(
  views: T[],
): T[] => [...views].sort((a, b) => viewKey(a).localeCompare(viewKey(b)));

describe('D-166 Override-Write Slice A2 - pure catalog operation projection', () => {
  it('projects empty manifest input to an empty picker inventory', () => {
    expect(catalogIngredientViews([])).toEqual([]);
  });

  it('filters out simple-form manifests and keeps only catalog-form ingredients', () => {
    const result = catalogIngredientViews([
      simpleManifest(SIMPLE_SLUG),
      catalogManifest(PUB_SLUG, PUB_OP_KEY),
      catalogManifest(GITHUB_SLUG, GITHUB_OP_KEY),
    ]);

    expect(result.map((entry) => entry.ingredient_id)).toEqual([
      GITHUB_SLUG,
      PUB_SLUG,
    ]);
    expect(result.find((entry) => entry.ingredient_id === SIMPLE_SLUG)).toBeUndefined();
  });

  it('projects an authored approval into the shared operation inventory', () => {
    const manifest = catalogManifest(PUB_SLUG, PUB_OP_KEY, 'write');
    manifest.operations = {
      [PUB_OP_KEY]: {
        ...operation(PUB_OP_ID, 'write'),
        approval: 'always',
      },
    };

    expect(catalogIngredientViews([manifest])[0]?.operations[0]).toMatchObject({
      operation_id: PUB_OP_ID,
      risk_tier: 'write',
      approval: 'always',
    });
  });

  it('sorts ingredients by ingredient_id and operations by operation_id', () => {
    const multiOpManifest: IngredientManifest = {
      ...catalogManifest('aa/catalog', 'zed'),
      operations: {
        zed: operation('aa/catalog.zed'),
        alpha: operation('aa/catalog.alpha'),
        mono: operation('aa/catalog.mono'),
      },
      surfaces: {
        api: {
          transport: 'rest',
          default_base_url: 'https://api.example.com',
          auth: { kind: 'none' },
          executes: {
            zed: restBinding(),
            alpha: restBinding(),
            mono: restBinding(),
          },
        },
      },
    };

    const result = catalogIngredientViews([
      catalogManifest('zz/catalog', 'list'),
      multiOpManifest,
    ]);

    expect(result.map((entry) => entry.ingredient_id)).toEqual([
      'aa/catalog',
      'zz/catalog',
    ]);
    expect(result[0]?.operations.map((op) => op.operation_id)).toEqual([
      'aa/catalog.alpha',
      'aa/catalog.mono',
      'aa/catalog.zed',
    ]);
  });

  it('defaults operation groups to an empty array when omitted', () => {
    const noGroupsManifest: IngredientManifest = {
      ...catalogManifest('groups/catalog', 'list'),
      operations: {
        list: {
          operation_id: 'groups/catalog.list',
          risk_tier: 'read',
        },
      },
    };

    expect(catalogIngredientViews([noGroupsManifest])[0]?.operations[0]).toEqual({
      operation_id: 'groups/catalog.list',
      operation_key: 'list',
      risk_tier: 'read',
      groups: [],
    });
  });

  it('projects fully-qualified operation ids and carries non-read risk tiers', () => {
    expect(catalogIngredientViews([
      catalogManifest('write/catalog', 'mutate', 'write'),
    ])[0]?.operations[0]).toEqual({
      operation_id: 'write/catalog.mutate',
      operation_key: 'mutate',
      risk_tier: 'write',
      groups: ['recued-core/test.read'],
    });
  });
});

describe('D-166 Override-Write Slice A1 - direct handlers', () => {
  it('upserts an ingredient-wide override and lists it with operation_id:null', async () => {
    const { handlers } = makeHandlerHarness();

    const written = await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      policy: { approval: 'always' },
    });

    expect(written).toEqual({
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id: null,
      policy: { approval: 'always' },
      written_at: NOW,
    });
    await expect(listOverrides(handlers)).resolves.toEqual({
      overrides: [written],
    });
  });

  it('upserts an operation-specific override and filters list by second segment ingredient_id', async () => {
    const { store, handlers } = makeHandlerHarness();

    const written = await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: { denied: true },
    });
    await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: OTHER_SLUG,
      operation_id: `${OTHER_SLUG}.${GITHUB_OP_KEY}`,
      policy: { approval: 'always' },
    });

    expect(store.get(OVERRIDE_SCOPE, ['user_self', GITHUB_SLUG, GITHUB_OP_ID])).toMatchObject({
      segments: ['user_self', GITHUB_SLUG, GITHUB_OP_ID],
      value: { denied: true },
      written_at: NOW,
    });
    await expect(listOverrides(handlers, { ingredient_id: GITHUB_SLUG })).resolves.toEqual({
      overrides: [written],
    });
  });

  it('round-trips the stored override policy exactly through listOverrides', async () => {
    const { handlers } = makeHandlerHarness();
    const policy: OverridePolicyInput = {
      denied: true,
      approval: 'always',
      max_risk_without_approval: 'none',
      timeout_ms: 1_250,
      cache_ttl_ms: 0,
    };

    await upsertOverride(handlers, {
      actor: 'contracted_user',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy,
    });

    const listed = await listOverrides(handlers, { ingredient_id: GITHUB_SLUG });
    expect(listed.overrides).toHaveLength(1);
    expect(listed.overrides[0]).toMatchObject({
      actor: 'contracted_user',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy,
      written_at: NOW,
    });
  });

  it('rejects overwriting the same actor-scoped key with a strictly weaker policy', async () => {
    const { handlers } = makeHandlerHarness();
    await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: { approval: 'always' },
    });

    const err = await expectRpcCode(
      upsertOverride(handlers, {
        actor: 'user_self',
        ingredient_id: GITHUB_SLUG,
        operation_id: GITHUB_OP_ID,
        policy: { approval: 'never' },
      }),
      'contract_write_loosens',
    );
    expect(err.details).toEqual({
      loosened_fields: ['approval'],
    });
  });

  it('rejects an invalid actor as bad_request', async () => {
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(
      upsertOverride(handlers, {
        actor: 'bogus',
        ingredient_id: GITHUB_SLUG,
        policy: { denied: true },
      }),
      'bad_request',
    );
  });

  it('rejects an unknown ingredient as bad_request', async () => {
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(
      upsertOverride(handlers, {
        actor: 'user_self',
        ingredient_id: 'github/missing',
        policy: { denied: true },
      }),
      'bad_request',
    );
  });

  it('rejects a non-catalog-form ingredient as bad_request', async () => {
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(
      upsertOverride(handlers, {
        actor: 'user_self',
        ingredient_id: SIMPLE_SLUG,
        policy: { denied: true },
      }),
      'bad_request',
    );
  });

  it('rejects an unknown operation_id as bad_request', async () => {
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(
      upsertOverride(handlers, {
        actor: 'user_self',
        ingredient_id: GITHUB_SLUG,
        operation_id: `${GITHUB_SLUG}.delete`,
        policy: { denied: true },
      }),
      'bad_request',
    );
  });

  it('rejects empty override policies as bad_request', async () => {
    const { handlers } = makeHandlerHarness();

    for (const policy of [{}, { denied: null }]) {
      await expectRpcCode(
        upsertOverride(handlers, {
          actor: 'user_self',
          ingredient_id: GITHUB_SLUG,
          policy,
        }),
        'bad_request',
      );
    }
  });

  it('maps invalid numeric lattice-domain payloads to bad_request, not internal', async () => {
    const badPolicies: ReadonlyArray<Record<string, unknown>> = [
      { timeout_ms: 0 },
      { timeout_ms: 1.5 },
      { cache_ttl_ms: -1 },
    ];

    for (const policy of badPolicies) {
      const { handlers } = makeHandlerHarness();
      const err = await expectRpcCode(
        upsertOverride(handlers, {
          actor: 'user_self',
          ingredient_id: GITHUB_SLUG,
          operation_id: GITHUB_OP_ID,
          policy,
        }),
        'bad_request',
      );
      expect(err.code).not.toBe('internal');
    }
  });

  it('deletes an override, reports idempotent misses, and leaves listOverrides empty', async () => {
    const { handlers } = makeHandlerHarness();
    await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: { denied: true },
    });

    await expect(deleteOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
    })).resolves.toEqual({ deleted: true });
    await expect(listOverrides(handlers, { ingredient_id: GITHUB_SLUG })).resolves.toEqual({
      overrides: [],
    });
    await expect(deleteOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
    })).resolves.toEqual({ deleted: false });
  });

  it('validates delete actor and ingredient_id but does not require the catalog', async () => {
    const { store, handlers } = makeHandlerHarness({
      getManifest: () => null,
    });
    store.put(OVERRIDE_SCOPE, ['user_self', 'retired/catalog'], { denied: true });

    await expectRpcCode(
      deleteOverride(handlers, {
        actor: 'bogus',
        ingredient_id: 'retired/catalog',
      }),
      'bad_request',
    );
    await expectRpcCode(
      deleteOverride(handlers, {
        actor: 'user_self',
        ingredient_id: '   ',
      }),
      'bad_request',
    );
    await expect(deleteOverride(handlers, {
      actor: 'user_self',
      ingredient_id: 'retired/catalog',
    })).resolves.toEqual({ deleted: true });
    await expect(deleteOverride(handlers, {
      actor: 'user_self',
      ingredient_id: 'retired/missing',
    })).resolves.toEqual({ deleted: false });
  });

  it('lists all override rows when called with no args', async () => {
    const { handlers } = makeHandlerHarness();
    const first = await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      policy: { denied: true },
    });
    const second = await upsertOverride(handlers, {
      actor: 'system',
      ingredient_id: OTHER_SLUG,
      operation_id: `${OTHER_SLUG}.${GITHUB_OP_KEY}`,
      policy: { approval: 'always' },
    });

    const listed = await listOverrides(handlers);
    expect(sortViews(listed.overrides)).toEqual(sortViews([first, second]));
  });

  it('returns undefined when contract deps are absent', () => {
    expect(makeContractHandlers(undefined)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// D-211 Slice 1 — write-site floor clamp, risk-downgrade confirm,
// op_hash stamp + stale flag, reserve-class audit (D-211 §2/§8)
// ════════════════════════════════════════════════════════════════

type LoggedActivity = {
  action: string;
  target: string;
  detail?: string;
  timestamp: number;
};

const makeAuditLog = (): { entries: LoggedActivity[]; auditLog: AuditLogStore } => {
  const entries: LoggedActivity[] = [];
  const auditLog = {
    logActivity: async (entry: LoggedActivity) => {
      entries.push(entry);
    },
  } as unknown as AuditLogStore;
  return { entries, auditLog };
};

describe('D-211 global owner operation - write-site clamp', () => {
  it('accepts the single slug-keyed operation of a simple-form ingredient', async () => {
    const { handlers } = makeHandlerHarness();

    await expect(
      upsertOwnerOverride(handlers, {
        ingredient_id: SIMPLE_SLUG,
        operation_id: SIMPLE_SLUG,
        policy: { approval: 'never' },
      }),
    ).resolves.toMatchObject({
      ingredient_id: SIMPLE_SLUG,
      operation_id: SIMPLE_SLUG,
      policy: { approval: 'never' },
    });
  });

  it('rejects any other operation_id for a simple-form ingredient', async () => {
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(
      upsertOwnerOverride(handlers, {
        ingredient_id: SIMPLE_SLUG,
        operation_id: `${SIMPLE_SLUG}.other`,
        policy: { approval: 'never' },
      }),
      'bad_request',
    );
  });

  it('refuses a below-floor approval on a write op; row is not persisted', async () => {
    const { store, handlers } = makeHandlerHarness();

    const err = await expectRpcCode(
      upsertOwnerOverride(handlers, {
        ingredient_id: WRITE_SLUG,
        operation_id: WRITE_OP_ID,
        policy: { approval: 'never' },
      }),
      'owner_operation_below_floor',
    );

    expect(err.details).toEqual({
      floor: 'ask',
      effective_risk: 'write',
      declared_risk: 'write',
    });
    expect(store.get(OWNER_OPERATION_SCOPE, [WRITE_SLUG, WRITE_OP_ID])).toBeNull();
  });

  it('the floor keys off the RECLASSIFIED risk: {risk:read, approval:never} on a write op passes the clamp (with confirm)', async () => {
    const { store, handlers } = makeHandlerHarness();

    await upsertOwnerOverride(handlers, {
      ingredient_id: WRITE_SLUG,
      operation_id: WRITE_OP_ID,
      policy: { risk: 'read', approval: 'never', confirm_risk_downgrade: true },
    });

    const row = store.get(OWNER_OPERATION_SCOPE, [WRITE_SLUG, WRITE_OP_ID]);
    // The confirm flag is wire-only — never stored (D-211 §2).
    expect(row?.value).toMatchObject({ risk: 'read', approval: 'never' });
    expect(row?.value).not.toHaveProperty('confirm_risk_downgrade');
  });

  it('refuses an ask approval on a destructive op (floor always)', async () => {
    const { handlers } = makeHandlerHarness();

    const err = await expectRpcCode(
      upsertOwnerOverride(handlers, {
        ingredient_id: DESTR_SLUG,
        operation_id: DESTR_OP_ID,
        policy: { approval: 'ask' },
      }),
      'owner_operation_below_floor',
    );

    expect(err.details).toMatchObject({ floor: 'always', effective_risk: 'destructive' });
  });
});

describe('D-211 global owner operation - risk-downgrade confirm', () => {
  it('refuses a downward reclass without the confirm flag, naming every consequence; nothing persisted', async () => {
    const { store, handlers } = makeHandlerHarness();

    const err = await expectRpcCode(
      upsertOwnerOverride(handlers, {
        ingredient_id: DESTR_SLUG,
        operation_id: DESTR_OP_ID,
        policy: { risk: 'write' },
      }),
      'owner_operation_risk_downgrade_confirm',
    );

    expect(err.details).toEqual({
      declared_risk: 'destructive',
      previous_risk: 'destructive',
      new_risk: 'write',
      floor_before: 'always',
      floor_after: 'ask',
      session_grantable_after: true,
      delegation_learnable_after: true,
    });
    expect(store.get(OWNER_OPERATION_SCOPE, [DESTR_SLUG, DESTR_OP_ID])).toBeNull();
  });

  it('with confirm_risk_downgrade:true the row persists AND a reserve-class audit row lands', async () => {
    const { entries, auditLog } = makeAuditLog();
    const { store, handlers } = makeHandlerHarness({ auditLog, now: () => now });

    await upsertOwnerOverride(handlers, {
      ingredient_id: DESTR_SLUG,
      operation_id: DESTR_OP_ID,
      policy: { risk: 'write', confirm_risk_downgrade: true },
    });

    const row = store.get(OWNER_OPERATION_SCOPE, [DESTR_SLUG, DESTR_OP_ID]);
    expect(row?.value).toMatchObject({ risk: 'write' });
    expect(row?.value).not.toHaveProperty('confirm_risk_downgrade');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'owner_operation_override_written',
      target: DESTR_OP_ID,
      timestamp: NOW,
    });
    const detail = JSON.parse(entries[0]?.detail ?? '{}');
    expect(detail).toMatchObject({
      ingredient_id: DESTR_SLUG,
      operation_id: DESTR_OP_ID,
      policy: { risk: 'write' },
      prior_policy: null,
      declared_risk: 'destructive',
      previous_risk: 'destructive',
      effective_risk: 'write',
      floor_before: 'always',
      floor_after: 'ask',
    });
    expect(typeof detail.op_hash).toBe('string');
    expect(detail.policy).not.toHaveProperty('confirm_risk_downgrade');
  });

  it('does not reconfirm an already-stored lower risk when only its sibling approval changes', async () => {
    const { handlers } = makeHandlerHarness();

    await upsertOwnerOverride(handlers, {
      ingredient_id: DESTR_SLUG,
      operation_id: DESTR_OP_ID,
      policy: { risk: 'write', confirm_risk_downgrade: true },
    });

    await expect(
      upsertOwnerOverride(handlers, {
        ingredient_id: DESTR_SLUG,
        operation_id: DESTR_OP_ID,
        policy: { risk: 'write', approval: 'ask' },
      }),
    ).resolves.toMatchObject({
      risk: 'write',
      approval: 'ask',
      policy: { risk: 'write', approval: 'ask' },
    });
  });

  it('an UPWARD reclass needs no confirm ({risk}-only input is non-empty and persists)', async () => {
    const { store, handlers } = makeHandlerHarness();

    await expect(
      upsertOwnerOverride(handlers, {
        ingredient_id: GITHUB_SLUG,
        operation_id: GITHUB_OP_ID,
        policy: { risk: 'write' },
      }),
    ).resolves.toMatchObject({
      risk: 'write',
      policy: { risk: 'write' },
    });
    expect(
      store.get(OWNER_OPERATION_SCOPE, [GITHUB_SLUG, GITHUB_OP_ID])?.value,
    ).toMatchObject({ risk: 'write' });
  });

  it('a confirm-flag-only policy is EMPTY (wire-only field carries no ruling)', async () => {
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(
      upsertOwnerOverride(handlers, {
        ingredient_id: GITHUB_SLUG,
        operation_id: GITHUB_OP_ID,
        policy: { confirm_risk_downgrade: true },
      }),
      'bad_request',
    );
  });
});

describe('D-211 global owner operation - op_hash, stale flag, and delete audit', () => {
  it('stamps op_hash on an op-specific write and flips stale when the manifest op changes or vanishes', async () => {
    // A MUTABLE manifest holder so the "pack update" is just a reassignment.
    let manifest = catalogManifest(GITHUB_SLUG, GITHUB_OP_KEY);
    const { handlers } = makeHandlerHarness({
      getManifest: (slug) => (slug === GITHUB_SLUG ? manifest : null),
      listManifests: () => [manifest],
    });

    const written = await upsertOwnerOverride(handlers, {
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: { approval: 'always' },
    });
    expect(typeof written.op_hash).toBe('string');
    expect((written.op_hash ?? '').length).toBe(64); // sha256 hex

    const fresh = await listOwnerOverrides(handlers, { ingredient_id: GITHUB_SLUG });
    expect(fresh.overrides[0]?.op_hash).toBe(written.op_hash);
    // Unchanged op — no stale flag (absent, not false, so the upsert view and
    // the list view stay equal).
    expect(fresh.overrides[0]?.stale).toBeUndefined();

    // Pack update changes the op (risk tier flips) → the ruling is stale.
    manifest = catalogManifest(GITHUB_SLUG, GITHUB_OP_KEY, 'write');
    const changed = await listOwnerOverrides(handlers, { ingredient_id: GITHUB_SLUG });
    expect(changed.overrides[0]?.stale).toBe(true);
    expect(changed.overrides[0]?.op_hash).toBe(written.op_hash); // the stamp is immutable

    // Pack update REMOVES the op → equally stale.
    manifest = catalogManifest(GITHUB_SLUG, 'renamed_op');
    const removed = await listOwnerOverrides(handlers, { ingredient_id: GITHUB_SLUG });
    expect(removed.overrides[0]?.stale).toBe(true);
  });

  it('deleting a row lands an owner-operation audit entry carrying the prior policy; a miss is silent', async () => {
    const { entries, auditLog } = makeAuditLog();
    const { handlers } = makeHandlerHarness({ auditLog });
    await upsertOwnerOverride(handlers, {
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: { approval: 'always' },
    });
    entries.splice(0); // drop the write's own audit entry

    await expect(deleteOwnerOverride(handlers, {
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
    })).resolves.toEqual({ deleted: true });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'owner_operation_override_deleted',
      target: GITHUB_OP_ID,
    });
    const detail = JSON.parse(entries[0]?.detail ?? '{}');
    expect(detail).toMatchObject({
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: null,
      prior_policy: { approval: 'always' },
    });

    // Idempotent miss — no second audit row.
    await expect(deleteOwnerOverride(handlers, {
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
    })).resolves.toEqual({ deleted: false });
    expect(entries).toHaveLength(1);
  });
});

describe('D-211 Slice 1 - review folds: tighten-only rpc translation + server-owned op_hash', () => {
  it('still translates a TIGHTEN-ONLY loosening to contract_write_loosens at the rpc layer', async () => {
    // Review fold #3 — the approval flip removed the only rpc-level proof of
    // the ContractWriteLoosensError → 'contract_write_loosens' translation;
    // max_risk_without_approval is still lattice-gated, so it carries it now.
    const { handlers } = makeHandlerHarness();
    await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: { max_risk_without_approval: 'read' },
    });

    const err = await expectRpcCode(
      upsertOverride(handlers, {
        actor: 'user_self',
        ingredient_id: GITHUB_SLUG,
        operation_id: GITHUB_OP_ID,
        policy: { max_risk_without_approval: 'admin' },
      }),
      'contract_write_loosens',
    );

    expect(err.details).toEqual({
      loosened_fields: ['max_risk_without_approval'],
    });
  });

  it('rejects an {op_hash}-only policy as EMPTY (server-stamped, rules on nothing)', async () => {
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(
      upsertOwnerOverride(handlers, {
        ingredient_id: GITHUB_SLUG,
        operation_id: GITHUB_OP_ID,
        policy: { op_hash: 'smuggled' },
      }),
      'bad_request',
    );
  });

  it('strips a client-supplied op_hash; the server stamp wins on the exact op row', async () => {
    const { store, handlers } = makeHandlerHarness();
    const written = await upsertOwnerOverride(handlers, {
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: { approval: 'always', op_hash: 'smuggled' },
    });
    expect(written.op_hash).toBeDefined();
    expect(written.op_hash).not.toBe('smuggled');
    expect((written.op_hash ?? '').length).toBe(64);
    const opRow = store.get(OWNER_OPERATION_SCOPE, [GITHUB_SLUG, GITHUB_OP_ID]);
    expect((opRow?.value as Record<string, unknown>).op_hash).toBe(written.op_hash);
  });
});

describe('D-211 global owner operation - operation inventory', () => {
  it('lists catalog operations and the exact slug-keyed simple-form operation', async () => {
    const { handlers } = makeHandlerHarness();

    const listed = await listOwnerOperations(handlers);
    expect(listed.ingredients.find(
      (ingredient) => ingredient.ingredient_id === GITHUB_SLUG,
    )?.operations).toEqual([{
      operation_id: GITHUB_OP_ID,
      operation_key: GITHUB_OP_KEY,
      risk_tier: 'read',
    }]);
    expect(listed.ingredients.find(
      (ingredient) => ingredient.ingredient_id === SIMPLE_SLUG,
    )?.operations).toEqual([{
      operation_id: SIMPLE_SLUG,
      operation_key: SIMPLE_SLUG,
      risk_tier: 'read',
    }]);
  });

  it('keeps the operation inventory owner-local with the whole namespace', () => {
    expect(isReservedLocalRpc('collection.operation.listOperations')).toBe(true);
  });
});

describe('D-166 Override-Write Slice A2 - direct catalog operation handler', () => {
  it('lists catalog-form operation inventory and excludes simple-form manifests', async () => {
    const { handlers } = makeHandlerHarness();

    const listed = await listCatalogOperations(handlers, {});

    expect(listed.ingredients.map((entry) => entry.ingredient_id)).toEqual([
      DESTR_SLUG,
      GITHUB_SLUG,
      OTHER_SLUG,
      WRITE_SLUG,
      PUB_SLUG,
    ]);
    expect(listed.ingredients.find((entry) => entry.ingredient_id === SIMPLE_SLUG)).toBeUndefined();
    expect(listed.ingredients.find((entry) => entry.ingredient_id === GITHUB_SLUG)).toEqual({
      ingredient_id: GITHUB_SLUG,
      name: `Catalog ${GITHUB_SLUG}`,
      kind: 'connection',
      operations: [
        {
          operation_id: GITHUB_OP_ID,
          operation_key: GITHUB_OP_KEY,
          risk_tier: 'read',
          groups: ['recued-core/test.read'],
        },
      ],
    });
  });

  it('round-trips a listed operation_id into upsertOverride', async () => {
    const { handlers } = makeHandlerHarness();
    const listed = await listCatalogOperations(handlers);
    const github = listed.ingredients.find((entry) => entry.ingredient_id === GITHUB_SLUG);
    const operation_id = github?.operations[0]?.operation_id;

    expect(operation_id).toBe(GITHUB_OP_ID);
    await expect(upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id,
      policy: { denied: true },
    })).resolves.toMatchObject({
      actor: 'user_self',
      ingredient_id: GITHUB_SLUG,
      operation_id: GITHUB_OP_ID,
      policy: { denied: true },
    });
  });
});

type ExecutorCall = {
  slug: string;
  input: Record<string, unknown>;
  output: Record<string, string> | undefined;
  stepOptions: unknown;
  stepMeta: unknown;
};

const allowedProfile = (): ConnectionOperationProfile => ({
  allowed_operations: [PUB_OP_KEY],
});

const makeGatewayHarness = (store: ContractStore) => {
  const executorCalls: ExecutorCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const fallbackResult = { ok: true };
  const ingredientExecutor: IngredientExecutor = async (
    slug,
    input,
    output,
    stepOptions,
    stepMeta,
  ) => {
    executorCalls.push({ slug, input, output, stepOptions, stepMeta });
    return fallbackResult;
  };
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'd-166-a1' } as any,
    stores: {} as any,
    actor: 'user_self',
    contractScan: createContractScanFn(store),
    ingredientExecutor,
    connectionProfileResolver: () => allowedProfile(),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
  };
  return { ctx, executorCalls, auditCalls, fallbackResult };
};

const runGateway = (ctx: ExecutionContext, manifest?: IngredientManifest) =>
  runCatalogOperation(
    ctx,
    manifest ?? catalogManifest(PUB_SLUG, PUB_OP_KEY),
    PUB_SLUG,
    { operation: PUB_OP_KEY, connection: 'raw-connection' },
    'primary-connection',
    undefined,
    undefined,
    undefined,
  );

/** D-211 — the pub/cat manifest with an AUTHORED `approval: 'always'` on its
 *  read op (the §8(i) baseline hold the owner ruling silences). */
const authoredAlwaysManifest = (): IngredientManifest => ({
  ...catalogManifest(PUB_SLUG, PUB_OP_KEY),
  operations: {
    [PUB_OP_KEY]: { ...operation(PUB_OP_ID), approval: 'always' },
  },
});

describe('D-166 Override-Write Slice A1 - RPC write to gateway read loop', () => {
  it('uses the same store so a handler-written denied override flips the gateway to deny', async () => {
    const store = makeStore();
    const { handlers } = makeHandlerHarness({ store });
    await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: PUB_SLUG,
      operation_id: PUB_OP_ID,
      policy: { denied: true },
    });

    const { ctx, executorCalls, auditCalls } = makeGatewayHarness(store);
    const caught = await captureRejection(runGateway(ctx));

    expect(caught).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(caught)).toBe(false);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      ingredient_id: PUB_SLUG,
      operation_id: PUB_OP_ID,
      failure_mode: 'operation_not_granted',
    });
  });

  it('uses the same store so a handler-written approval override flips the gateway to ask', async () => {
    const store = makeStore();
    const { handlers } = makeHandlerHarness({ store });
    await upsertOverride(handlers, {
      actor: 'user_self',
      ingredient_id: PUB_SLUG,
      operation_id: PUB_OP_ID,
      policy: { approval: 'always' },
    });

    const { ctx, executorCalls, auditCalls } = makeGatewayHarness(store);
    const caught = await captureRejection(runGateway(ctx));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).tool_slug).toBe(PUB_OP_ID);
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('read');
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('D-211 end-to-end: global owner approval:never silences an authored-always read; delete restores the hold', async () => {
    const store = makeStore();
    const { handlers } = makeHandlerHarness({ store });
    const manifest = authoredAlwaysManifest();

    // Baseline — the authored `always` holds the read.
    const before = makeGatewayHarness(store);
    const beforeCaught = await captureRejection(runGateway(before.ctx, manifest));
    expect(isPreflightRequiredSignal(beforeCaught)).toBe(true);
    expect(before.executorCalls).toHaveLength(0);

    // The owner's ruling — the same rpc write the Settings surface issues.
    await upsertOwnerOverride(handlers, {
      ingredient_id: PUB_SLUG,
      operation_id: PUB_OP_ID,
      policy: { approval: 'never' },
    });
    const silenced = makeGatewayHarness(store);
    await expect(runGateway(silenced.ctx, manifest)).resolves.toEqual({ ok: true });
    expect(silenced.executorCalls).toHaveLength(1);
    expect(silenced.auditCalls[0]).toMatchObject({
      outcome: 'success',
      operation_id: PUB_OP_ID,
      approval: 'never',
    });

    // Deleting the ruling restores the authored hold (no row = authored defaults).
    await deleteOwnerOverride(handlers, {
      ingredient_id: PUB_SLUG,
      operation_id: PUB_OP_ID,
    });
    const restored = makeGatewayHarness(store);
    const restoredCaught = await captureRejection(runGateway(restored.ctx, manifest));
    expect(isPreflightRequiredSignal(restoredCaught)).toBe(true);
    expect((restoredCaught as PreflightRequiredSignal).tool_slug).toBe(PUB_OP_ID);
    expect(restored.executorCalls).toHaveLength(0);
    expect(restored.auditCalls).toHaveLength(0);
  });
});

class MemorySocket extends Duplex {
  peer: MemorySocket | undefined;
  remoteAddress = '127.0.0.1';
  remotePort = 12345;
  localAddress = '127.0.0.1';
  localPort = 80;

  _read(): void {
    // Peer writes push directly into this readable side.
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.peer && !this.peer.destroyed) {
      this.peer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) {
      this.peer.push(null);
    }
    callback();
  }

  setTimeout(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }
}

const createSocketPair = (): { client: MemorySocket; server: MemorySocket } => {
  const client = new MemorySocket();
  const server = new MemorySocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
};

const connectWs = (httpServer: HttpServer, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1/ws?token=${encodeURIComponent(token)}`,
      {
        createConnection: () => {
          const pair = createSocketPair();
          process.nextTick(() => {
            httpServer.emit('connection', pair.server as unknown as Socket);
          });
          return pair.client as unknown as Socket;
        },
      },
    );
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      resolve(ws);
    });
    ws.once('error', fail);
    ws.once('unexpected-response', (_req, res) => {
      fail(new Error(`unexpected response ${res.statusCode}`));
    });
  });

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForClose = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
  });

const closeWs = async (ws: WebSocket): Promise<void> => {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = waitForClose(ws);
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
  await Promise.race([
    closed,
    wait(250).then(() => {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    }),
  ]);
};

interface RpcReply {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

const waitForMessage = (
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('waitForMessage timeout'));
    }, 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(msg)) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });

const callRpc = async (
  ws: WebSocket,
  method: string,
  args: unknown = {},
): Promise<RpcReply> => {
  const requestId = `req-${randomUUID()}`;
  const reply = waitForMessage(
    ws,
    (msg) => msg.type === 'rpc_result' && msg.request_id === requestId,
  );
  ws.send(JSON.stringify({
    type: 'rpc',
    request_id: requestId,
    method,
    args,
  }));
  const msg = await reply;
  const error = msg.error as RpcReply['error'] | undefined;
  return {
    ok: error === undefined,
    ...(msg.result !== undefined ? { result: msg.result } : {}),
    ...(error !== undefined ? { error } : {}),
  };
};

interface RpcHarness {
  connect(): Promise<WebSocket>;
  close(): Promise<void>;
}

const createRpcHarness = (config: ServerConfig): RpcHarness => {
  const handlerSet = createServerHandlerSet(config);
  const httpServer = createHttpServer();
  const wsUpgrade = handlerSet.upgradeHandlers.ws;
  if (!wsUpgrade) {
    handlerSet.close();
    throw new Error('ws upgrade handler not composed');
  }
  httpServer.on('upgrade', wsUpgrade);
  handlerSet.wsHandle.maxInstances = 0;

  const openSockets = new Set<WebSocket>();

  return {
    async connect() {
      const ws = await connectWs(httpServer, 'test-realm');
      openSockets.add(ws);
      ws.once('close', () => openSockets.delete(ws));
      return ws;
    },
    async close() {
      for (const ws of [...openSockets]) {
        await closeWs(ws);
      }
      openSockets.clear();
      handlerSet.close();
      httpServer.removeAllListeners();
    },
  };
};

describe('D-166 Override-Write Slice A1 - server wiring', () => {
  it('forwards contractDeps through createServerHandlerSet to real WS dispatch', async () => {
    const store = makeStore();
    store.put(
      OVERRIDE_SCOPE,
      ['user_self', GITHUB_SLUG, GITHUB_OP_ID],
      overrideRowValue({ denied: true }),
    );
    const harness = createRpcHarness({
      contractDeps: {
        store,
        getManifest,
        listManifests,
      },
    });
    openHarnesses.push(harness);

    const ws = await harness.connect();
    const reply = await callRpc(ws, 'collection.contract.listOverrides', {
      ingredient_id: GITHUB_SLUG,
    });

    expect(reply.error?.code).not.toBe('not_configured');
    expect(reply).toMatchObject({
      ok: true,
      result: {
        overrides: [
          {
            actor: 'user_self',
            ingredient_id: GITHUB_SLUG,
            operation_id: GITHUB_OP_ID,
            policy: { denied: true },
            written_at: NOW,
          },
        ],
      },
    });
  });

  it('dispatches listCatalogOperations as a void RPC through the real WS path', async () => {
    const store = makeStore();
    const harness = createRpcHarness({
      contractDeps: {
        store,
        getManifest,
        listManifests,
      },
    });
    openHarnesses.push(harness);

    const ws = await harness.connect();
    const reply = await callRpc(
      ws,
      'collection.contract.listCatalogOperations',
      undefined,
    );

    expect(reply.error?.code).not.toBe('not_configured');
    expect(reply.ok).toBe(true);
    const result = reply.result as { ingredients?: unknown };
    expect(Array.isArray(result.ingredients)).toBe(true);
    const ingredients = result.ingredients as Array<{
      ingredient_id: string;
      name: string;
      kind?: string;
      operations: unknown[];
    }>;
    expect(ingredients.length).toBeGreaterThan(0);
    expect(ingredients).toContainEqual({
      ingredient_id: GITHUB_SLUG,
      name: `Catalog ${GITHUB_SLUG}`,
      kind: 'connection',
      operations: [
        {
          operation_id: GITHUB_OP_ID,
          operation_key: GITHUB_OP_KEY,
          risk_tier: 'read',
          groups: ['recued-core/test.read'],
        },
      ],
    });
  });
});

describe('D-166/D-211 owner-policy RPC - MCP reservation', () => {
  it('keeps contract and global operation-owner methods out of the MCP channel', () => {
    const methods = [
      'collection.contract.upsertOverride',
      'collection.contract.deleteOverride',
      'collection.contract.listOverrides',
      'collection.contract.listCatalogOperations',
      'collection.operation.listOperations',
      'collection.operation.upsertOwnerOverride',
      'collection.operation.deleteOwnerOverride',
      'collection.operation.listOwnerOverrides',
    ] as const;

    for (const method of methods) {
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });
});
