import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LLM_GATEWAY_PAID_ACK_VERSION,
  MCP_INBOUND_TOKEN_PREFIX,
  type McpInboundTokenRecord,
  type SellerCustomer,
  type SellerSettings,
  type SellerTier,
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
const COLON_STRUCTURED = `${TOKEN_ID}:${BEARER}`;
const INBOUND_TOKEN_ID = 'inbound-token-1';
const INBOUND_BEARER = `${MCP_INBOUND_TOKEN_PREFIX}doorBearer123`;
const GRANTED_TOOL = 'recued_getAudit';
const DENIED_TOOL = 'recued_saveRecipe';
const MISSING_TOOL = 'recued_dataTimeline';

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
  token_id: INBOUND_TOKEN_ID,
  bearer_hash: 'hash',
  label: 'External door',
  created_at: 1_000,
  expires_at: 0,
  revoked_at: null,
  grants: {
    [GRANTED_TOOL]: true,
    [DENIED_TOOL]: false,
  },
  concurrency_tier: 3,
  chat_mode: null,
  updated_at: 1_000,
  ...overrides,
});

const makeInboundTokenStore = (
  verifyBearer: ChatInboundTokenStore['verifyBearer'] = vi.fn(() => null),
): Pick<ChatInboundTokenStore, 'verifyBearer'> =>
  ({
    verifyBearer,
  }) as unknown as Pick<ChatInboundTokenStore, 'verifyBearer'>;

const makeSellerSettings = (
  overrides: Partial<SellerSettings> = {},
): SellerSettings => ({
  default_grace_hours: 72,
  sender_mail_instance_id: null,
  status_policy_json: {},
  email_policy_json: {},
  llm_gateway_paid_ack_at: 1_000,
  llm_gateway_paid_ack_version: LLM_GATEWAY_PAID_ACK_VERSION,
  created_at: 1_000,
  updated_at: 1_000,
  ...overrides,
});

const makeSellerTier = (
  overrides: Partial<SellerTier> = {},
): SellerTier => ({
  tier_id: 'tier_basic',
  door_id: 'door_mcp',
  lifecycle_source: 'stripe',
  entitlement_key: 'basic',
  display_name: 'Basic',
  template_contract_id: 'ct_template_basic',
  external_entitlement_id: null,
  usage_policy_json: {},
  pass_duration_seconds: null,
  customer_status_enabled_default: false,
  active: true,
  created_at: 1_000,
  updated_at: 1_000,
  ...overrides,
});

const makeSellerCustomer = (
  overrides: Partial<SellerCustomer> = {},
): SellerCustomer => ({
  customer_id: 'seller_customer_1',
  lifecycle_source: 'stripe',
  source_customer_id: 'cus_1',
  door_id: 'door_mcp',
  email: null,
  tier_id: 'tier_basic',
  contract_id: 'ct_customer_1',
  inbound_token_id: INBOUND_TOKEN_ID,
  mcp_token_id: INBOUND_TOKEN_ID,
  external_subscription_id: null,
  source_status: 'active',
  current_period_end: Date.now() + 60_000,
  grace_until: Date.now() + 3 * 60 * 60_000,
  access_state: 'active',
  claim_email_sent_at: null,
  claim_email_marker: null,
  status_email_sent_at: null,
  status_email_marker: null,
  created_at: 1_000,
  updated_at: 1_000,
  ...overrides,
});

const makeSellerStore = (
  overrides: {
    settings?: SellerSettings;
    tier?: SellerTier | null;
    customers?: SellerCustomer[];
    usageUnits?: number;
  } = {},
) => ({
  getSettings: vi.fn(() => overrides.settings ?? makeSellerSettings()),
  getTier: vi.fn(() => (overrides.tier === undefined ? makeSellerTier() : overrides.tier)),
  listCustomers: vi.fn(() => overrides.customers ?? []),
  getUsageRollup: vi.fn((input: {
    contract_id: string;
    usage_kind: 'tool_call' | 'chat_turn';
    period_granularity: 'day' | 'month';
    period_start: number;
  }) =>
    overrides.usageUnits === undefined || input.usage_kind !== 'tool_call'
      ? null
      : {
          contract_id: input.contract_id,
          usage_kind: input.usage_kind,
          period_granularity: input.period_granularity,
          period_start: input.period_start,
          units: overrides.usageUnits,
          created_at: 1_000,
          updated_at: 1_000,
        }),
  recordUsage: vi.fn((input: {
    contract_id: string;
    usage_kind: 'tool_call' | 'chat_turn';
    period_granularity: 'day' | 'month';
    period_start: number;
    units: number;
    now: number;
  }) => ({
    contract_id: input.contract_id,
    usage_kind: input.usage_kind,
    period_granularity: input.period_granularity,
    period_start: input.period_start,
    units: input.units,
    created_at: input.now,
    updated_at: input.now,
  })),
}) as NonNullable<Parameters<typeof composeMcpHttpTransport>[0]['sellerStore']>;

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

describe('D-171 external-door HTTP MCP transport gate matrix', () => {
  it('returns an inbound-token bundle when only inboundTokenStore is present', () => {
    const bundle = composeDefined({ inboundTokenStore: makeInboundTokenStore() });

    expect(bundle.mcpHttpDeps.verifier).toBeTypeOf('function');
    expect(bundle.mcpHttpDeps.dispatch).toBeTypeOf('function');
    expect(bundle.logBootBanner).toBeTypeOf('function');
  });

  it('returns undefined when neither bearer store is present', () => {
    const bundle = composeMcpHttpTransport(makeDeps());

    expect(bundle).toBeUndefined();
  });
});

describe('D-171 external-door HTTP MCP transport verifier', () => {
  it('accepts a valid recued_* bearer via inboundTokenStore.verifyBearer', async () => {
    const record = makeInboundTokenRecord();
    const verifyBearer = vi.fn(() => record);
    const bundle = composeDefined({
      inboundTokenStore: makeInboundTokenStore(verifyBearer),
    });

    expect(await bundle.mcpHttpDeps.verifier(INBOUND_BEARER)).toBe(true);
    expect(verifyBearer).toHaveBeenCalledTimes(1);
    expect(verifyBearer).toHaveBeenCalledWith({
      bearer: INBOUND_BEARER,
      now: expect.any(Number),
    });
  });

  it('rejects a non-prefixed opaque bearer without consulting verifyBearer', async () => {
    const verifyBearer = vi.fn(() => makeInboundTokenRecord());
    const bundle = composeDefined({
      inboundTokenStore: makeInboundTokenStore(verifyBearer),
    });

    expect(await bundle.mcpHttpDeps.verifier('opaque-door-bearer')).toBe(false);
    expect(verifyBearer).not.toHaveBeenCalled();
  });

  it.each([
    ['dotted', STRUCTURED],
    ['colon', COLON_STRUCTURED],
  ] as const)('rejects a %s structured-looking bearer without consulting inboundTokenStore', async (
    _label,
    bearer,
  ) => {
    const verifyBearer = vi.fn(() => makeInboundTokenRecord());
    const bundle = composeDefined({
      inboundTokenStore: makeInboundTokenStore(verifyBearer),
    });

    expect(await bundle.mcpHttpDeps.verifier(bearer)).toBe(false);
    expect(verifyBearer).not.toHaveBeenCalled();
  });

  it('rejects a dotted bearer when clientTokens is absent', async () => {
    const verifyBearer = vi.fn(() => makeInboundTokenRecord());
    const bundle = composeDefined({
      inboundTokenStore: makeInboundTokenStore(verifyBearer),
    });

    expect(await bundle.mcpHttpDeps.verifier(STRUCTURED)).toBe(false);
    expect(verifyBearer).not.toHaveBeenCalled();
  });
});

describe('D-171 external-door HTTP MCP dispatch deps', () => {
  it('threads token id, peer handle, grants, and no bound-contract fields', async () => {
    const record = makeInboundTokenRecord({
      token_id: 'door-token-peer',
      peer_handle: 'peer-mary',
    });
    const bundle = composeDefined({
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });
    const envelope = { jsonrpc: '2.0', id: 'inbound-peer', method: 'tools/list' };

    await bundle.mcpHttpDeps.dispatch(envelope, INBOUND_BEARER);

    const deps = lastCapturedDeps();
    expect(deps.mcpTokenId).toBe('door-token-peer');
    expect(deps.agentId).toBe('peer-mary');
    expect(deps.inboundTokenAuthorize).toBeTypeOf('function');
    expect(deps.inboundTokenAuthorize(GRANTED_TOOL)).toBe(true);
    expect(deps.inboundTokenAuthorize(DENIED_TOOL)).toBe(false);
    expect(deps.inboundTokenAuthorize(MISSING_TOOL)).toBe(false);
    expect(deps).not.toHaveProperty('boundContractId');
    expect(deps).not.toHaveProperty('boundContractActive');
    expect(lastDispatcher()).toHaveBeenCalledWith(envelope, undefined);
  });

  it('falls back to an inbound_<token_id> agent id when peer_handle is absent', async () => {
    const record = makeInboundTokenRecord({ token_id: 'door-token-fallback' });
    const bundle = composeDefined({
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'inbound-fallback', method: 'tools/list' },
      INBOUND_BEARER,
    );

    expect(lastCapturedDeps().agentId).toBe('inbound_door-token-fallback');
  });
});

describe('D-171 external-door HTTP MCP bound-contract deps', () => {
  it('marks a live bound contract active while keeping grants-driven authorization', async () => {
    const isContractLive = vi.fn(() => true);
    const record = makeInboundTokenRecord({ contract_id: 'contract-live' });
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: { isContractLive } as any,
      } as any),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'bound-live', method: 'tools/list' },
      INBOUND_BEARER,
    );

    const deps = lastCapturedDeps();
    expect(isContractLive).toHaveBeenCalledWith('contract-live');
    expect(deps.boundContractId).toBe('contract-live');
    expect(deps.boundContractActive).toBe(true);
    expect(deps.inboundTokenAuthorize(GRANTED_TOOL)).toBe(true);
    expect(deps.inboundTokenAuthorize(DENIED_TOOL)).toBe(false);
    expect(deps.inboundTokenAuthorize(MISSING_TOOL)).toBe(false);
  });

  it('leaves ordinary non-seller inbound tokens on the generic contract liveness path', async () => {
    const isContractLive = vi.fn(() => true);
    const sellerStore = makeSellerStore({ customers: [] });
    const record = makeInboundTokenRecord({ contract_id: 'contract-live' });
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: { isContractLive } as any,
      } as any),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
      sellerStore,
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'bound-live-non-seller', method: 'tools/list' },
      INBOUND_BEARER,
    );

    expect(sellerStore.listCustomers).toHaveBeenCalledWith({ contract_id: 'contract-live' });
    expect(lastCapturedDeps().boundContractActive).toBe(true);
    expect(lastCapturedDeps()).not.toHaveProperty('customerUsage');
    expect(lastCapturedDeps()).not.toHaveProperty('customerStatus');
  });

  it('keeps a live seller customer bound contract active when seller admission admits', async () => {
    const isContractLive = vi.fn(() => true);
    const customer = makeSellerCustomer({ contract_id: 'ct_customer_1' });
    const sellerStore = makeSellerStore({ customers: [customer] });
    const record = makeInboundTokenRecord({ contract_id: 'ct_customer_1' });
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: { isContractLive } as any,
      } as any),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
      sellerStore,
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'bound-live-seller', method: 'tools/list' },
      INBOUND_BEARER,
    );

    expect(lastCapturedDeps().boundContractId).toBe('ct_customer_1');
    expect(lastCapturedDeps().boundContractActive).toBe(true);
  });

  it('threads a customer usage hook for admitted seller customer tool calls', async () => {
    const isContractLive = vi.fn(() => true);
    const customer = makeSellerCustomer({ contract_id: 'ct_customer_1' });
    const tier = makeSellerTier({
      usage_policy_json: { tool_call: { period_limit: 5 } },
    });
    const sellerStore = makeSellerStore({ customers: [customer], tier, usageUnits: 2 });
    const record = makeInboundTokenRecord({ contract_id: 'ct_customer_1' });
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: { isContractLive } as any,
      } as any),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
      sellerStore,
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'seller-usage', method: 'tools/call' },
      INBOUND_BEARER,
    );

    const usage = lastCapturedDeps().customerUsage;
    expect(usage).toBeDefined();
    expect(lastCapturedDeps().customerContractGrants).toBe(true);
    expect(usage.reserve({
      tool_name: GRANTED_TOOL,
      usage_kind: 'tool_call',
      units: 1,
    })).toMatchObject({
      admitted: true,
    });

    usage.commit();

    expect(sellerStore.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      contract_id: 'ct_customer_1',
      usage_kind: 'tool_call',
      period_granularity: 'month',
      units: 1,
    }));
  });

  it('threads a self-scoped customer status hook for admitted seller customers', async () => {
    const isContractLive = vi.fn(() => true);
    const customer = makeSellerCustomer({ contract_id: 'ct_customer_1' });
    const tier = makeSellerTier({
      usage_policy_json: { tool_call: { period_limit: 5 } },
    });
    const sellerStore = makeSellerStore({ customers: [customer], tier, usageUnits: 2 });
    const record = makeInboundTokenRecord({ contract_id: 'ct_customer_1' });
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: { isContractLive } as any,
      } as any),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
      sellerStore,
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'seller-status', method: 'tools/list' },
      INBOUND_BEARER,
    );

    const status = lastCapturedDeps().customerStatus;
    expect(status).toBeDefined();
    expect(status.getStatus()).toMatchObject({
      usage: {
        tool_call: {
          consumed: 2,
          period_limit: 5,
        },
        chat_turn: {
          consumed: 0,
        },
      },
      status: {
        lifecycle_source: 'stripe',
        tier: 'basic',
        source_status: 'active',
        access_state: 'active',
      },
    });
  });

  it('keeps the bearer valid but marks the bound contract inactive when seller admission denies', async () => {
    const isContractLive = vi.fn(() => true);
    const customer = makeSellerCustomer({
      contract_id: 'ct_customer_1',
      access_state: 'closed',
    });
    const sellerStore = makeSellerStore({ customers: [customer] });
    const record = makeInboundTokenRecord({ contract_id: 'ct_customer_1' });
    const verifyBearer = vi.fn(() => record);
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: { isContractLive } as any,
      } as any),
      inboundTokenStore: makeInboundTokenStore(verifyBearer),
      sellerStore,
    });

    expect(await bundle.mcpHttpDeps.verifier(INBOUND_BEARER)).toBe(true);
    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'bound-denied-seller', method: 'tools/list' },
      INBOUND_BEARER,
    );

    const deps = lastCapturedDeps();
    expect(deps.boundContractId).toBe('ct_customer_1');
    expect(deps.boundContractActive).toBe(false);
    expect(deps.inboundTokenAuthorize(GRANTED_TOOL)).toBe(true);
    expect(deps).not.toHaveProperty('customerStatus');
  });

  it('does not thread customer usage for a dead seller customer bound contract', async () => {
    const isContractLive = vi.fn(() => false);
    const customer = makeSellerCustomer({ contract_id: 'ct_customer_1' });
    const tier = makeSellerTier({
      usage_policy_json: { tool_call: { rate_limit_per_min: 1 } },
    });
    const sellerStore = makeSellerStore({ customers: [customer], tier });
    const record = makeInboundTokenRecord({ contract_id: 'ct_customer_1' });
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: { isContractLive } as any,
      } as any),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
      sellerStore,
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'bound-dead-seller-usage', method: 'tools/call' },
      INBOUND_BEARER,
    );

    const deps = lastCapturedDeps();
    expect(deps.boundContractId).toBe('ct_customer_1');
    expect(deps.boundContractActive).toBe(false);
    expect(deps).not.toHaveProperty('customerUsage');
    expect(deps).not.toHaveProperty('customerStatus');
  });

  it('threads boundContractActive:false for a dead bound contract while inboundTokenAuthorize stays a pure checklist', async () => {
    const isContractLive = vi.fn(() => false);
    const record = makeInboundTokenRecord({ contract_id: 'contract-dead' });
    const bundle = composeDefined({
      executeDeps: makeExecuteDeps({
        contractOverlay: { isContractLive } as any,
      } as any),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'bound-dead', method: 'tools/list' },
      INBOUND_BEARER,
    );

    const deps = lastCapturedDeps();
    expect(isContractLive).toHaveBeenCalledWith('contract-dead');
    expect(deps.boundContractId).toBe('contract-dead');
    // D-187 token-lifecycle — the dead contract fails closed via the structural
    // kill-switches in handleToolCall (dispatch) + handleToolsList (enumeration),
    // both keyed on this boundContractActive:false. inboundTokenAuthorize is NOT
    // collapsed to () => false: it reflects ONLY the token's own checklist, so a
    // GRANTED tool reads true here (the guards deny the call / empty the catalog).
    // End-to-end fail-closed is pinned by d-177-read-gate-external-door-e2e.
    expect(deps.boundContractActive).toBe(false);
    expect(deps.inboundTokenAuthorize(GRANTED_TOOL)).toBe(true);
  });

  it('threads boundContractActive:false (fail-closed) for a bound token when contractOverlay is absent', async () => {
    const record = makeInboundTokenRecord({ contract_id: 'contract-unresolved' });
    const bundle = composeDefined({
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'bound-no-overlay', method: 'tools/list' },
      INBOUND_BEARER,
    );

    const deps = lastCapturedDeps();
    expect(deps.boundContractId).toBe('contract-unresolved');
    // Absent overlay ⇒ liveness unresolved ⇒ boundContractActive:false (fail-
    // closed); the structural guards deny on it. The checklist closure is
    // unaffected — it still reflects the token's grants (GRANTED_TOOL → true).
    expect(deps.boundContractActive).toBe(false);
    expect(deps.inboundTokenAuthorize(GRANTED_TOOL)).toBe(true);
  });
});

describe('D-171 external-door HTTP MCP revoked-mid-flight handling', () => {
  it('returns -32001 when verifier accepts but dispatch re-resolution misses', async () => {
    const record = makeInboundTokenRecord();
    const verifyBearer = vi
      .fn()
      .mockReturnValueOnce(record)
      .mockReturnValueOnce(null);
    const bundle = composeDefined({
      inboundTokenStore: makeInboundTokenStore(verifyBearer),
    });
    const envelope = { jsonrpc: '2.0', id: 'revoked-inbound', method: 'tools/list' };

    expect(await bundle.mcpHttpDeps.verifier(INBOUND_BEARER)).toBe(true);

    const result = await bundle.mcpHttpDeps.dispatch(envelope, INBOUND_BEARER);

    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 'revoked-inbound',
      error: {
        code: -32001,
        message: expect.stringMatching(/revoked|Token state changed/),
      },
    });
    expect(mcpServerMocks.createMcpHttpDispatch).not.toHaveBeenCalled();
  });
});

// D-187 §6 (step 7) — the level-1 DOOR-TYPE gate at connection establishment:
// reject a connection whose door type the bound contract isn't enabled for. The
// HTTP MCP transport is the `mcp` (tools) door, so it gates on door type `'mcp'`.
describe('D-187 step 7 — HTTP MCP transport door-type gate', () => {
  const overlay = (extra: Record<string, any>) =>
    makeExecuteDeps({ contractOverlay: extra as any } as any);

  it('rejects (-32001) a LIVE bound contract NOT enabled for the mcp door', async () => {
    const isContractLive = vi.fn(() => true);
    const permitsDoorType = vi.fn(() => false); // e.g. door_types: ['mcp_chat']
    const record = makeInboundTokenRecord({ contract_id: 'contract-chat-only' });
    const bundle = composeDefined({
      executeDeps: overlay({ isContractLive, permitsDoorType }),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    const result = await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'door-gate', method: 'tools/list' },
      INBOUND_BEARER,
    );

    expect(permitsDoorType).toHaveBeenCalledWith('contract-chat-only', 'mcp');
    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 'door-gate',
      error: {
        code: -32001,
        message: expect.stringMatching(/not enabled for the mcp door/),
      },
    });
    // Rejected at the connection level — never reaches the tool dispatcher.
    expect(mcpServerMocks.createMcpHttpDispatch).not.toHaveBeenCalled();
  });

  it('admits a LIVE bound contract enabled for the mcp door', async () => {
    const isContractLive = vi.fn(() => true);
    const permitsDoorType = vi.fn(() => true);
    const record = makeInboundTokenRecord({ contract_id: 'contract-mcp' });
    const bundle = composeDefined({
      executeDeps: overlay({ isContractLive, permitsDoorType }),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'ok', method: 'tools/list' },
      INBOUND_BEARER,
    );

    expect(permitsDoorType).toHaveBeenCalledWith('contract-mcp', 'mcp');
    const deps = lastCapturedDeps();
    expect(deps.boundContractId).toBe('contract-mcp');
    expect(deps.boundContractActive).toBe(true);
  });

  it('admits a LIVE bound contract when the overlay omits permitsDoorType (wildcard fallback)', async () => {
    // A test/legacy overlay with only isContractLive ⇒ `?? true` ⇒ no rejection
    // (behaviour-preserving — absent door-type machinery never fences anyone).
    const isContractLive = vi.fn(() => true);
    const record = makeInboundTokenRecord({ contract_id: 'contract-legacy' });
    const bundle = composeDefined({
      executeDeps: overlay({ isContractLive }),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'legacy', method: 'tools/list' },
      INBOUND_BEARER,
    );

    const deps = lastCapturedDeps();
    expect(deps.boundContractId).toBe('contract-legacy');
    expect(deps.boundContractActive).toBe(true);
  });

  it('does NOT door-reject a DEAD bound contract — it takes the deny-all kill-switch path', async () => {
    const isContractLive = vi.fn(() => false);
    // Even if door-type would say "not permitted", the gate is LIVE-only: a dead
    // contract skips the -32001 door rejection (the deny-all path owns it,
    // preserving audit attribution).
    const permitsDoorType = vi.fn(() => false);
    const record = makeInboundTokenRecord({ contract_id: 'contract-dead' });
    const bundle = composeDefined({
      executeDeps: overlay({ isContractLive, permitsDoorType }),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    const result = await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'dead', method: 'tools/list' },
      INBOUND_BEARER,
    );

    // Not a door-type rejection — `permitsDoorType` is never consulted for a dead
    // contract; the dead contract is denied by the structural liveness kill-
    // switches (handleToolCall dispatch + handleToolsList empty catalog), which
    // consume boundContractActive:false. The checklist closure stays pure (a
    // GRANTED tool reads true; liveness is a separate axis).
    expect(permitsDoorType).not.toHaveBeenCalled();
    expect(result).not.toMatchObject({ error: { code: -32001 } });
    const deps = lastCapturedDeps();
    expect(deps.boundContractActive).toBe(false);
    expect(deps.inboundTokenAuthorize(GRANTED_TOOL)).toBe(true);
  });

  it('preserves the JSON-RPC id on the door rejection (number id; null for no id)', async () => {
    const isContractLive = vi.fn(() => true);
    const permitsDoorType = vi.fn(() => false);
    const record = makeInboundTokenRecord({ contract_id: 'contract-chat-only' });
    const bundle = composeDefined({
      executeDeps: overlay({ isContractLive, permitsDoorType }),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    const numbered = await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 42, method: 'tools/list' },
      INBOUND_BEARER,
    );
    expect(numbered).toMatchObject({ id: 42, error: { code: -32001 } });

    // A notification-shaped envelope (no id) → null id per JSON-RPC.
    const noId = await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', method: 'tools/list' },
      INBOUND_BEARER,
    );
    expect(noId).toMatchObject({ id: null, error: { code: -32001 } });
  });

  it('skips the door-type gate for an UNBOUND inbound token (no contract_id)', async () => {
    const isContractLive = vi.fn(() => true);
    const permitsDoorType = vi.fn(() => false);
    const record = makeInboundTokenRecord(); // no contract_id
    const bundle = composeDefined({
      executeDeps: overlay({ isContractLive, permitsDoorType }),
      inboundTokenStore: makeInboundTokenStore(vi.fn(() => record)),
    });

    await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'unbound', method: 'tools/list' },
      INBOUND_BEARER,
    );

    // No contract binding ⇒ neither liveness nor door-type is consulted.
    expect(permitsDoorType).not.toHaveBeenCalled();
    expect(isContractLive).not.toHaveBeenCalled();
    expect(mcpServerMocks.createMcpHttpDispatch).toHaveBeenCalled();
  });
});

describe('D-171 external-door HTTP MCP boot banner', () => {
  it.each([
    [
      'clientTokens only',
      { clientTokens: makeClientTokens() },
      '[mcp] HTTP transport enabled — canonical client_tokens (client_kind=cli)',
    ],
    [
      'inboundTokenStore only',
      { inboundTokenStore: makeInboundTokenStore() },
      '[mcp] HTTP transport enabled — inbound door tokens (chat_inbound_tokens)',
    ],
    [
      'both token families',
      {
        clientTokens: makeClientTokens(),
        inboundTokenStore: makeInboundTokenStore(),
      },
      '[mcp] HTTP transport enabled — canonical client_tokens (client_kind=cli) + inbound door tokens (chat_inbound_tokens)',
    ],
  ] as const)('logs the %s variant', (_label, overrides, expected) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const bundle = composeDefined(overrides);

    expect(logSpy).not.toHaveBeenCalled();

    bundle.logBootBanner();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expected);
  });
});
