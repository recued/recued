import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_INBOUND_TOKEN_PREFIX,
  type McpInboundTokenRecord,
} from '@recued/contracts';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type {
  ClientTokenRecord,
  ClientTokenStore,
} from '../pairing/client-tokens.js';
import type { ChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';

const mcpServerMocks = vi.hoisted(() => ({
  createMcpHttpDispatch: vi.fn(),
}));

vi.mock('../mcp-server.js', () => ({
  createMcpHttpDispatch: mcpServerMocks.createMcpHttpDispatch,
}));

import { composeMcpHttpTransport } from '../composition/bin/wire-mcp-http-transport.js';

type CapturedMcpDeps = Record<string, any>;
type CapturedDispatcher = ReturnType<typeof vi.fn>;

const TOKEN_ID = 'A'.repeat(16);
const BEARER = 'B'.repeat(44);
const STRUCTURED = `${TOKEN_ID}.${BEARER}`;
const INBOUND_BEARER = `${MCP_INBOUND_TOKEN_PREFIX}customerBearer123`;

const dispatchSpies: CapturedDispatcher[] = [];

const makeExecuteDeps = (
  overrides: Partial<ExecuteHandlerDeps> = {},
): ExecuteHandlerDeps =>
  ({
    recipeStore: { kind: 'recipe-store' } as any,
    executorConfig: { kind: 'executor-config' } as any,
    baseVault: {},
    instanceId: 'test-instance',
    serverName: 'test-server',
    ...overrides,
  }) as ExecuteHandlerDeps;

const makeClientTokenRecord = (
  overrides: Partial<ClientTokenRecord> = {},
): ClientTokenRecord => ({
  token_id: TOKEN_ID,
  client_kind: 'cli',
  client_label: 'CLI',
  issued_at: 1_000,
  last_used_at: null,
  revoked_at: null,
  revocation_reason: null,
  metadata: null,
  ...overrides,
});

const makeClientTokens = (
  verify: ClientTokenStore['verify'] = vi.fn(async () => ({
    ok: false,
    record: null,
  })),
): Pick<ClientTokenStore, 'verify' | 'touch'> =>
  ({
    verify,
    touch: vi.fn(),
  }) as unknown as Pick<ClientTokenStore, 'verify' | 'touch'>;

const makeInboundTokenRecord = (
  overrides: Partial<McpInboundTokenRecord> = {},
): McpInboundTokenRecord => ({
  token_id: 'inbound-customer-1',
  bearer_hash: 'hash',
  label: 'Customer door',
  created_at: 1_000,
  expires_at: 0,
  revoked_at: null,
  grants: { recued_getAudit: true },
  concurrency_tier: 3,
  chat_mode: null,
  contract_id: 'ct_customer_1',
  updated_at: 1_000,
  ...overrides,
});

const makeInboundTokenStore = (
  record: McpInboundTokenRecord,
): Pick<ChatInboundTokenStore, 'verifyBearer'> => ({
  verifyBearer: vi.fn(() => record),
});

const makeEmptySellerStore = () => ({
  getSettings: vi.fn(),
  getTier: vi.fn(() => null),
  listCustomers: vi.fn(() => []),
  getUsageRollup: vi.fn(() => null),
  recordUsage: vi.fn(),
}) as unknown as NonNullable<Parameters<typeof composeMcpHttpTransport>[0]['sellerStore']>;

const makeDeps = (
  overrides: Partial<Parameters<typeof composeMcpHttpTransport>[0]> = {},
): Parameters<typeof composeMcpHttpTransport>[0] => ({
  executeDeps: makeExecuteDeps(),
  vaultStore: undefined,
  housekeepingStateStore: undefined,
  internalRegistry: undefined,
  clientTokens: undefined,
  inboundTokenStore: undefined,
  ...overrides,
});

const composeDefined = (
  overrides: Partial<Parameters<typeof composeMcpHttpTransport>[0]> = {},
) => {
  const bundle = composeMcpHttpTransport(makeDeps(overrides));

  expect(bundle).toBeDefined();

  return bundle!;
};

const lastCapturedDeps = (): CapturedMcpDeps => {
  const calls = mcpServerMocks.createMcpHttpDispatch.mock.calls;

  expect(calls.length).toBeGreaterThan(0);

  return calls[calls.length - 1][0] as CapturedMcpDeps;
};

const lastDispatcher = (): CapturedDispatcher => {
  expect(dispatchSpies.length).toBeGreaterThan(0);

  return dispatchSpies[dispatchSpies.length - 1];
};

const resetMcpDispatchMock = () => {
  dispatchSpies.length = 0;
  mcpServerMocks.createMcpHttpDispatch.mockImplementation(
    (_deps: CapturedMcpDeps) => {
      const dispatcher = vi.fn(async (envelope: unknown, token?: string) => ({
        ok: true,
        envelope,
        token,
      }));
      dispatchSpies.push(dispatcher);
      return dispatcher;
    },
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  resetMcpDispatchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composeMcpHttpTransport gate matrix', () => {
  it('returns undefined when both bearer stores are absent', () => {
    const bundle = composeMcpHttpTransport(makeDeps());

    expect(bundle).toBeUndefined();
  });

  it('returns a canonical client-token bundle when clientTokens is present', () => {
    const bundle = composeDefined({ clientTokens: makeClientTokens() });

    expect(bundle.mcpHttpDeps.verifier).toBeTypeOf('function');
    expect(bundle.mcpHttpDeps.dispatch).toBeTypeOf('function');
    expect(bundle.logBootBanner).toBeTypeOf('function');
  });
});

describe('composeMcpHttpTransport verifier', () => {
  it('returns true for a valid structured cli client token', async () => {
    const record = makeClientTokenRecord();
    const verify = vi.fn(async () => ({ ok: true, record }));
    const clientTokens = makeClientTokens(verify);
    const bundle = composeDefined({ clientTokens });

    expect(await bundle.mcpHttpDeps.verifier(STRUCTURED)).toBe(true);
    expect(verify).toHaveBeenCalledWith(TOKEN_ID, BEARER);
    expect(clientTokens.touch).toHaveBeenCalledWith(TOKEN_ID);
    expect(bundle.mcpHttpDeps.resolveConcurrencyLimit(STRUCTURED)).toBeUndefined();
  });

  it('projects an inbound door token authored concurrency tier', async () => {
    const record = makeInboundTokenRecord({ concurrency_tier: 5 });
    const inboundTokenStore = makeInboundTokenStore(record);
    const bundle = composeDefined({ inboundTokenStore });

    expect(await bundle.mcpHttpDeps.verifier(INBOUND_BEARER)).toBe(true);
    expect(bundle.mcpHttpDeps.resolveConcurrencyLimit(INBOUND_BEARER)).toBe(5);
    expect(inboundTokenStore.verifyBearer).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['webclient', makeClientTokenRecord({ client_kind: 'webclient' })],
    ['bridge', makeClientTokenRecord({ client_kind: 'bridge' })],
  ] as const)('rejects a structured %s client token on the MCP port', async (_label, record) => {
    const bundle = composeDefined({
      clientTokens: makeClientTokens(vi.fn(async () => ({ ok: true, record }))),
    });

    expect(await bundle.mcpHttpDeps.verifier(STRUCTURED)).toBe(false);
  });

  it.each([
    ['env-var bearer', 'env-token'],
    ['opaque store bearer', 'recued_opaque_mcp_token'],
    ['off-shape structured probe', 'a.b'],
    ['empty string', ''],
  ] as const)('rejects non-canonical %s without consulting clientTokens.verify', async (_label, token) => {
    const verify = vi.fn(async () => ({ ok: true, record: makeClientTokenRecord() }));
    const bundle = composeDefined({ clientTokens: makeClientTokens(verify) });

    expect(await bundle.mcpHttpDeps.verifier(token)).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns false when clientTokens.verify rejects the structured bearer', async () => {
    const verify = vi.fn(async () => ({ ok: false, record: null }));
    const bundle = composeDefined({ clientTokens: makeClientTokens(verify) });

    expect(await bundle.mcpHttpDeps.verifier(STRUCTURED)).toBe(false);
    expect(verify).toHaveBeenCalledWith(TOKEN_ID, BEARER);
  });
});

describe('composeMcpHttpTransport base MCP deps', () => {
  it.each([
    ['vaultStore'],
    ['housekeepingStateStore'],
    ['internalRegistry'],
  ] as const)('omits %s when the ref is absent', async (key) => {
    const bundle = composeDefined({
      clientTokens: makeClientTokens(vi.fn(async () => ({
        ok: true,
        record: makeClientTokenRecord(),
      }))),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: key, method: 'tools/list' },
      STRUCTURED,
    );

    expect(key in lastCapturedDeps()).toBe(false);
  });

  it.each([
    ['vaultStore'],
    ['housekeepingStateStore'],
    ['internalRegistry'],
  ] as const)('spreads %s with identity preserved when the ref is present', async (key) => {
    const ref = { kind: key };
    const bundle = composeDefined({
      clientTokens: makeClientTokens(vi.fn(async () => ({
        ok: true,
        record: makeClientTokenRecord(),
      }))),
      [key]: ref,
    } as Partial<Parameters<typeof composeMcpHttpTransport>[0]>);

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: key, method: 'tools/list' },
      STRUCTURED,
    );

    expect(lastCapturedDeps()[key]).toBe(ref);
  });

  it('spreads executeDeps fields into the per-call MCP deps', async () => {
    const bundle = composeDefined({
      clientTokens: makeClientTokens(vi.fn(async () => ({
        ok: true,
        record: makeClientTokenRecord(),
      }))),
      executeDeps: makeExecuteDeps({ instanceId: 'test-instance' }),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'execute-deps', method: 'tools/list' },
      STRUCTURED,
    );

    expect(lastCapturedDeps().instanceId).toBe('test-instance');
  });
});

describe('composeMcpHttpTransport dispatch routing', () => {
  it('threads the canonical client token id and positive owner claim into MCP deps', async () => {
    const bundle = composeDefined({
      clientTokens: makeClientTokens(vi.fn(async () => ({
        ok: true,
        record: makeClientTokenRecord({ token_id: TOKEN_ID }),
      }))),
    });
    const envelope = { jsonrpc: '2.0', id: 'route', method: 'tools/list' };

    await bundle.mcpHttpDeps.dispatch(envelope, STRUCTURED);

    expect(lastCapturedDeps().mcpTokenId).toBe(TOKEN_ID);
    expect(lastCapturedDeps().ownerAdmitAll).toBe(true);
    expect(lastCapturedDeps()).not.toHaveProperty('inboundTokenAuthorize');
    expect(lastDispatcher()).toHaveBeenCalledWith(envelope, undefined);
  });

  it.each([
    ['undefined bearer', undefined],
    ['empty-string bearer', ''],
  ] as const)('does not return -32001 for dispatch with %s', async (_label, token) => {
    const verify = vi.fn(async () => ({ ok: true, record: makeClientTokenRecord() }));
    const bundle = composeDefined({ clientTokens: makeClientTokens(verify) });
    const envelope = { jsonrpc: '2.0', id: 'no-bearer', method: 'tools/list' };

    const result = await bundle.mcpHttpDeps.dispatch(envelope, token);

    expect(result).toMatchObject({ ok: true });
    expect(verify).not.toHaveBeenCalled();
    expect('mcpTokenId' in lastCapturedDeps()).toBe(false);
    expect(lastCapturedDeps()).not.toHaveProperty('ownerAdmitAll');
    expect(lastDispatcher()).toHaveBeenCalledWith(envelope, undefined);
  });
});

describe('composeMcpHttpTransport customer-instance authority', () => {
  it('marks a live customer-instance contract inactive when its Seller row is missing', async () => {
    const record = makeInboundTokenRecord();
    const sellerStore = makeEmptySellerStore();
    const resolveBoundContractKind = vi.fn(() => 'customer_instance' as const);
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: {
          isContractLive: vi.fn(() => true),
          resolveBoundContractKind,
        } as any,
      }),
      inboundTokenStore: makeInboundTokenStore(record),
      sellerStore,
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'orphan-customer', method: 'tools/call' },
      INBOUND_BEARER,
    );

    expect(resolveBoundContractKind).toHaveBeenCalledWith('ct_customer_1');
    expect(sellerStore.listCustomers).toHaveBeenCalledWith({
      contract_id: 'ct_customer_1',
    });
    expect(lastCapturedDeps().boundContractActive).toBe(false);
    expect(lastCapturedDeps()).not.toHaveProperty('customerUsage');
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('keeps an authoritative ordinary standing contract neutral without a Seller row', async () => {
    const record = makeInboundTokenRecord({ contract_id: 'ct_standing_1' });
    const sellerStore = makeEmptySellerStore();
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: {
          isContractLive: vi.fn(() => true),
          resolveBoundContractKind: vi.fn(() => 'standing'),
        } as any,
      }),
      inboundTokenStore: makeInboundTokenStore(record),
      sellerStore,
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'ordinary-standing', method: 'tools/list' },
      INBOUND_BEARER,
    );

    expect(lastCapturedDeps().boundContractActive).toBe(true);
    expect(sellerStore.listCustomers).not.toHaveBeenCalled();
    expect(lastCapturedDeps()).not.toHaveProperty('customerUsage');
  });
});

describe('composeMcpHttpTransport revoked-mid-flight handling', () => {
  it.each([
    ['number id', { jsonrpc: '2.0', id: 42, method: 'tools/list' }, 42],
    ['string id', { jsonrpc: '2.0', id: 'abc-1', method: 'tools/list' }, 'abc-1'],
    ['null id', { jsonrpc: '2.0', id: null, method: 'tools/list' }, null],
    ['array envelope', [], null],
    ['non-object envelope', 'not-an-object', null],
  ] as const)('returns -32001 with %s preserved as expected', async (_label, envelope, expectedId) => {
    const record = makeClientTokenRecord();
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, record })
      .mockResolvedValueOnce({ ok: false, record: null });
    const bundle = composeDefined({ clientTokens: makeClientTokens(verify) });

    expect(await bundle.mcpHttpDeps.verifier(STRUCTURED)).toBe(true);

    const result = await bundle.mcpHttpDeps.dispatch(envelope, STRUCTURED);

    expect(result).toEqual({
      jsonrpc: '2.0',
      id: expectedId,
      error: {
        code: -32001,
        message: expect.stringMatching(/revoked|Token state changed/),
      },
    });
    expect(mcpServerMocks.createMcpHttpDispatch).not.toHaveBeenCalled();
  });
});

describe('composeMcpHttpTransport logBootBanner', () => {
  it('logs the canonical-token banner only when invoked', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const bundle = composeDefined({ clientTokens: makeClientTokens() });

    expect(logSpy).not.toHaveBeenCalled();

    bundle.logBootBanner();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      '[mcp] HTTP transport enabled — canonical client_tokens (client_kind=cli)',
    );
  });
});

describe('composeMcpHttpTransport vault-lock gate (tools/call refused while locked)', () => {
  const resolvingClientTokens = () =>
    makeClientTokens(vi.fn(async () => ({ ok: true, record: makeClientTokenRecord() })));

  const toolsCall = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'recued_runRecipe' },
  };

  it('refuses tools/call while the vault is LOCKED (−32002; execution never reached)', async () => {
    const bundle = composeDefined({
      clientTokens: resolvingClientTokens(),
      isVaultUnlocked: () => false,
    });

    const res = (await bundle.mcpHttpDeps.dispatch(toolsCall, STRUCTURED)) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string };
    };

    expect(res.error.code).toBe(-32002);
    expect(res.error.message).toMatch(/locked/i);
    expect(res.id).toBe(7);
    // The per-call dispatcher (which reaches handleExecute) is never even
    // constructed — the gate short-circuits before any execution.
    expect(dispatchSpies).toHaveLength(0);
  });

  it('allows tools/call once the vault is UNLOCKED (reaches execution)', async () => {
    const bundle = composeDefined({
      clientTokens: resolvingClientTokens(),
      isVaultUnlocked: () => true,
    });

    await bundle.mcpHttpDeps.dispatch(toolsCall, STRUCTURED);

    expect(dispatchSpies).toHaveLength(1);
    expect(lastDispatcher()).toHaveBeenCalledTimes(1);
  });

  it('does NOT gate tools/list while locked — connect + discover stays open', async () => {
    const bundle = composeDefined({
      clientTokens: resolvingClientTokens(),
      isVaultUnlocked: () => false,
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 8, method: 'tools/list' },
      STRUCTURED,
    );

    expect(dispatchSpies).toHaveLength(1);
  });

  it('absent predicate (dbless / no vault to seal) leaves tools/call open', async () => {
    const bundle = composeDefined({ clientTokens: resolvingClientTokens() });

    await bundle.mcpHttpDeps.dispatch(toolsCall, STRUCTURED);

    expect(dispatchSpies).toHaveLength(1);
  });
});
