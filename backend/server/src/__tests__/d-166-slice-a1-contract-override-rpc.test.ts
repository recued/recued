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

const manifests = new Map<string, IngredientManifest>([
  [GITHUB_SLUG, catalogManifest(GITHUB_SLUG, GITHUB_OP_KEY)],
  [OTHER_SLUG, catalogManifest(OTHER_SLUG, GITHUB_OP_KEY)],
  [PUB_SLUG, catalogManifest(PUB_SLUG, PUB_OP_KEY)],
  [SIMPLE_SLUG, simpleManifest(SIMPLE_SLUG)],
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

  it('rejects overwriting the same key with a strictly weaker policy', async () => {
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

describe('D-166 Override-Write Slice A2 - direct catalog operation handler', () => {
  it('lists catalog-form operation inventory and excludes simple-form manifests', async () => {
    const { handlers } = makeHandlerHarness();

    const listed = await listCatalogOperations(handlers, {});

    expect(listed.ingredients.map((entry) => entry.ingredient_id)).toEqual([
      GITHUB_SLUG,
      OTHER_SLUG,
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

const runGateway = (ctx: ExecutionContext) =>
  runCatalogOperation(
    ctx,
    catalogManifest(PUB_SLUG, PUB_OP_KEY),
    PUB_SLUG,
    { operation: PUB_OP_KEY, connection: 'raw-connection' },
    'primary-connection',
    undefined,
    undefined,
    undefined,
  );

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

describe('D-166 Override-Write Slice A1 - MCP reservation', () => {
  it('keeps all collection.contract methods reserved out of the MCP channel', () => {
    const methods = [
      'collection.contract.upsertOverride',
      'collection.contract.deleteOverride',
      'collection.contract.listOverrides',
      'collection.contract.listCatalogOperations',
    ] as const;

    for (const method of methods) {
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });
});
