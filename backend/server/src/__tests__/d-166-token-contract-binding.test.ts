/** D-166 P2 inbound MCP token-to-contract binding. */

import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_DEFINITION_SCOPE,
  MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES,
  validateMcpInboundTokenInput,
  type ExecutionSource,
  type IngredientManifest,
  type ValidatedMcpInboundTokenInput,
} from '@recued/contracts';

import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { McpDeps } from '../mcp-server.js';
import type { ClientTokenStore } from '../pairing/client-tokens.js';

const mcpServerMocks = vi.hoisted(() => ({
  createMcpHttpDispatch: vi.fn(),
}));

vi.mock('../mcp-server.js', async (importActual) => {
  const actual = await importActual<typeof import('../mcp-server.js')>();
  return {
    ...actual,
    createMcpHttpDispatch: mcpServerMocks.createMcpHttpDispatch,
  };
});

import { _testing } from '../mcp-server.js';
import { composeMcpHttpTransport } from '../composition/bin/wire-mcp-http-transport.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
} from '../storage/chat-inbound-token-store.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import {
  createContractDefinitionStore,
  type MintContractInput,
} from '../storage/contract-definition-store.js';
import {
  createContractStore,
} from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;

type CapturedMcpDeps = Record<string, any>;

const capturedMcpDeps: CapturedMcpDeps[] = [];

const tableColumns = (db: Database.Database): string[] =>
  (db.prepare(`PRAGMA table_info(chat_inbound_tokens)`).all() as { name: string }[])
    .map((col) => col.name);

const tokenValue = (
  overrides: Partial<ValidatedMcpInboundTokenInput> = {},
): ValidatedMcpInboundTokenInput => ({
  label: 'Mary',
  grants: { 'tool.allowed': true, 'tool.denied': false },
  concurrency_tier: 3,
  expires_at: 0,
  chat_mode: null,
  ...overrides,
});

const validPayload = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  label: 'Mary',
  grants: { 'tool.allowed': true },
  concurrency_tier: 3,
  expires_at: 0,
  chat_mode: null,
  ...overrides,
});

const makeIngredient = (slug: string): IngredientManifest => ({
  slug,
  name: slug,
  description: `fixture ${slug}`,
  author: 'recued-core',
  kind: 'http',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['test'],
  input: { url: 'https://example.com/fixture', method: 'GET' },
  output: { body: 'body' },
});

const makeMcpDeps = (
  overrides: Partial<McpDeps> = {},
): McpDeps => {
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(makeIngredient('allowed-alpha'));
  manifests.register(makeIngredient('denied-beta'));
  manifests.register(makeIngredient('allowed-gamma'));
  return {
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests },
    baseVault: {},
    mcpTokenId: 'tok_1',
    ...overrides,
  } as McpDeps;
};

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

const composeDefined = (
  overrides: Partial<Parameters<typeof composeMcpHttpTransport>[0]> = {},
) => {
  const bundle = composeMcpHttpTransport({
    executeDeps: makeExecuteDeps(),
    vaultStore: undefined,
    housekeepingStateStore: undefined,
    internalRegistry: undefined,
    clientTokens: undefined,
    inboundTokenStore: undefined,
    ...overrides,
  });
  expect(bundle).toBeDefined();
  return bundle!;
};

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

const resetMcpDispatchMock = () => {
  capturedMcpDeps.length = 0;
  mcpServerMocks.createMcpHttpDispatch.mockImplementation((deps: CapturedMcpDeps) => {
    capturedMcpDeps.push(deps);
    return vi.fn(async (envelope: unknown, token?: string) => ({
      ok: true,
      envelope,
      token,
    }));
  });
};

const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
  minted_by: 'user:1',
  display_name: 'MCP bound contract',
  scope: {},
  ...overrides,
});

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetMcpDispatchMock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('D-166 P2 token binding store persistence', () => {
  it('round-trips contract_id through issue, get, list, and bearer verification', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);

      const issued = store.issueToken({
        value: tokenValue({ contract_id: 'ct_abc' }),
        now: NOW,
        bearer_plaintext: 'recued_bound_token',
      });

      expect(issued.record.contract_id).toBe('ct_abc');
      expect(store.getTokenById(issued.record.token_id)?.contract_id).toBe('ct_abc');
      expect(store.listTokens()[0]?.contract_id).toBe('ct_abc');
      expect(store.verifyBearer({
        bearer: issued.bearer_plaintext,
        now: NOW + 1,
      })?.contract_id).toBe('ct_abc');
    } finally {
      db.close();
    }
  });

  it('omits contract_id entirely for unbound tokens', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);

      const issued = store.issueToken({
        value: tokenValue(),
        now: NOW,
        bearer_plaintext: 'recued_unbound_token',
      });
      const reread = store.getTokenById(issued.record.token_id);
      const listed = store.listTokens()[0];
      const verified = store.verifyBearer({
        bearer: issued.bearer_plaintext,
        now: NOW + 1,
      });

      expect(issued.record.contract_id).toBeUndefined();
      expect(issued.record).not.toHaveProperty('contract_id');
      expect(reread?.contract_id).toBeUndefined();
      expect(reread).not.toHaveProperty('contract_id');
      expect(listed?.contract_id).toBeUndefined();
      expect(listed).not.toHaveProperty('contract_id');
      expect(verified?.contract_id).toBeUndefined();
      expect(verified).not.toHaveProperty('contract_id');
    } finally {
      db.close();
    }
  });

  it('adds contract_id to an old chat_inbound_tokens table idempotently', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE chat_inbound_tokens (
          token_id          TEXT PRIMARY KEY,
          bearer_hash       TEXT NOT NULL,
          label             TEXT NOT NULL,
          peer_handle       TEXT,
          created_at        INTEGER NOT NULL,
          expires_at        INTEGER NOT NULL,
          revoked_at        INTEGER,
          grants_json       TEXT NOT NULL,
          concurrency_tier  INTEGER NOT NULL,
          chat_mode_json    TEXT NOT NULL,
          updated_at        INTEGER NOT NULL
        );
      `);

      expect(tableColumns(db)).not.toContain('contract_id');
      expect(() => ensureChatInboundTokenSchema(db)).not.toThrow();
      expect(tableColumns(db)).toContain('contract_id');
      expect(() => ensureChatInboundTokenSchema(db)).not.toThrow();
      expect(tableColumns(db).filter((name) => name === 'contract_id')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe('D-166 P2 token binding validator', () => {
  it('accepts a non-empty contract_id and preserves omission as undefined', () => {
    const bound = validateMcpInboundTokenInput(validPayload({ contract_id: 'ct_x' }));
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.value.contract_id).toBe('ct_x');
    }

    const unbound = validateMcpInboundTokenInput(validPayload());
    expect(unbound.ok).toBe(true);
    if (unbound.ok) {
      expect(unbound.value.contract_id).toBeUndefined();
      expect(unbound.value).not.toHaveProperty('contract_id');
    }
  });

  it.each([
    ['empty string', ''],
    ['non-string', 123],
  ] as const)('rejects %s contract_id with contract_id_invalid', (_label, contract_id) => {
    const result = validateMcpInboundTokenInput(validPayload({ contract_id }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'contract_id_invalid')).toBe(true);
    }
  });

  it('exports contract_id_invalid in the closed validation code list', () => {
    expect([...MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES]).toContain('contract_id_invalid');
  });
});

describe('D-166 P2 MCP source and snapshot builders', () => {
  it('stamps a bound contract_id while preserving the MCP token id', () => {
    const boundDeps = makeMcpDeps({ boundContractId: 'ct_1' });
    const boundSource = _testing.buildMcpExecutionSource(boundDeps) as Extract<ExecutionSource, { channel: 'mcp' }>;

    expect(boundSource.mcp_token_id).toBe('tok_1');
    expect(boundSource.contract_id).toBe('ct_1');

    const unboundSource = _testing.buildMcpExecutionSource(makeMcpDeps()) as Extract<ExecutionSource, { channel: 'mcp' }>;
    expect(unboundSource.mcp_token_id).toBe('tok_1');
    expect(unboundSource.contract_id).toBe(unboundSource.mcp_token_id);
  });

  it('fails closed when a bound contract is inactive or liveness is omitted', () => {
    const inactiveDeps = makeMcpDeps({
      boundContractId: 'ct_dead',
      boundContractActive: false,
      inboundTokenAuthorize: (slug) => slug.startsWith('allowed-'),
    });
    const inactiveSource = _testing.buildMcpExecutionSource(inactiveDeps);
    expect(_testing.buildMcpContractSnapshot(inactiveSource, inactiveDeps).allowed_tools)
      .toEqual([]);

    const unresolvedDeps = makeMcpDeps({
      boundContractId: 'ct_unresolved',
      inboundTokenAuthorize: (slug) => slug.startsWith('allowed-'),
    });
    const unresolvedSource = _testing.buildMcpExecutionSource(unresolvedDeps);
    expect(_testing.buildMcpContractSnapshot(unresolvedSource, unresolvedDeps).allowed_tools)
      .toEqual([]);
  });

  it('keeps the normal grant-filtered allowlist for live-bound and unbound tokens', () => {
    const authorize = (slug: string): boolean => slug.startsWith('allowed-');
    const expected = ['allowed-alpha', 'allowed-gamma'];
    const liveDeps = makeMcpDeps({
      boundContractId: 'ct_live',
      boundContractActive: true,
      inboundTokenAuthorize: authorize,
    });
    const liveSource = _testing.buildMcpExecutionSource(liveDeps);
    expect(_testing.buildMcpContractSnapshot(liveSource, liveDeps).allowed_tools)
      .toEqual(expected);

    const unboundDeps = makeMcpDeps({ inboundTokenAuthorize: authorize });
    const unboundSource = _testing.buildMcpExecutionSource(unboundDeps);
    expect(_testing.buildMcpContractSnapshot(unboundSource, unboundDeps).allowed_tools)
      .toEqual(expected);
  });
});

describe('D-166 P2 HTTP transport binding retirement', () => {
  it('does not authenticate raw chat_inbound_tokens through the HTTP MCP transport', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue({ contract_id: 'ct_live' }),
        now: NOW,
        bearer_plaintext: 'recued_live_bound',
      });
      expect(store.verifyBearer({
        bearer: issued.bearer_plaintext,
        now: NOW + 1,
      })?.contract_id).toBe('ct_live');

      const verify = vi.fn(async () => ({ ok: false, record: null }));
      const bundle = composeDefined({
        clientTokens: makeClientTokens(verify),
      });

      expect(await bundle.mcpHttpDeps.verifier(issued.bearer_plaintext)).toBe(false);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

describe('D-166 P2 / D-196 contract overlay liveness probe', () => {
  it('reports live for active standing and customer-instance contracts only', () => {
    const db = new Database(':memory:');
    try {
      let idSeq = 0;
      const store = createContractStore(db, { now: () => NOW });
      const definitionStore = createContractDefinitionStore(store, {
        now: () => NOW,
        newId: () => {
          idSeq += 1;
          return `ct_${idSeq}`;
        },
      });
      const resolver = createContractOverlayResolver({
        definitionStore,
        now: () => NOW,
      });

      const active = definitionStore.mint(mintInput());
      const customerInstance = definitionStore.mint(mintInput());
      store.put(CONTRACT_DEFINITION_SCOPE, [customerInstance.contract_id], {
        ...customerInstance,
        grant_kind: 'customer_instance',
      });
      const customerTemplate = definitionStore.mint(mintInput());
      store.put(CONTRACT_DEFINITION_SCOPE, [customerTemplate.contract_id], {
        ...customerTemplate,
        grant_kind: 'customer_template',
      });
      const revoked = definitionStore.mint(mintInput());
      definitionStore.revoke(revoked.contract_id, 'user revoked');
      const expired = definitionStore.mint(mintInput({ expiry_at: NOW - 1 }));
      const exhausted = definitionStore.mint(mintInput({ max_uses: 1 }));
      definitionStore.recordUse(exhausted.contract_id);

      expect(resolver.isContractLive(active.contract_id)).toBe(true);
      expect(resolver.isContractLive(customerInstance.contract_id)).toBe(true);
      expect(resolver.isContractLive(customerTemplate.contract_id)).toBe(false);
      expect(resolver.isContractLive(revoked.contract_id)).toBe(false);
      expect(resolver.isContractLive(expired.contract_id)).toBe(false);
      expect(resolver.isContractLive(exhausted.contract_id)).toBe(false);
      expect(resolver.isContractLive('ct_never_minted')).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('D-171 slice 3 token contract rebinding store updates', () => {
  it('binds an unbound token and returns contract_id', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue(),
        now: NOW,
        bearer_plaintext: 'recued_rebind_bind',
      });

      const updated = store.updateTokenContract({
        token_id: issued.record.token_id,
        contract_id: 'ct_bound',
        now: NOW + 1,
      });

      expect(updated?.contract_id).toBe('ct_bound');
      expect(updated).toHaveProperty('contract_id', 'ct_bound');
    } finally {
      db.close();
    }
  });

  it('unbinds a bound token and omits contract_id from the returned record', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue({ contract_id: 'ct_old' }),
        now: NOW,
        bearer_plaintext: 'recued_rebind_unbind',
      });

      const updated = store.updateTokenContract({
        token_id: issued.record.token_id,
        contract_id: null,
        now: NOW + 1,
      });

      expect(updated?.contract_id).toBeUndefined();
      expect(updated).not.toHaveProperty('contract_id');
    } finally {
      db.close();
    }
  });

  it('rebinds a bound token to a different contract_id', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue({ contract_id: 'ct_old' }),
        now: NOW,
        bearer_plaintext: 'recued_rebind_switch',
      });

      const updated = store.updateTokenContract({
        token_id: issued.record.token_id,
        contract_id: 'ct_new',
        now: NOW + 1,
      });

      expect(updated?.contract_id).toBe('ct_new');
      expect(store.getTokenById(issued.record.token_id)?.contract_id).toBe('ct_new');
    } finally {
      db.close();
    }
  });

  it('returns null when rebinding a non-existent token_id', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);

      expect(
        store.updateTokenContract({
          token_id: 'tok_missing',
          contract_id: 'ct_new',
          now: NOW + 1,
        }),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it('advances updated_at after rebind', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue({ contract_id: 'ct_old' }),
        now: NOW,
        bearer_plaintext: 'recued_rebind_updated_at',
      });

      const updated = store.updateTokenContract({
        token_id: issued.record.token_id,
        contract_id: 'ct_new',
        now: NOW + 500,
      });

      expect(updated?.updated_at).toBe(NOW + 500);
      expect(updated?.updated_at).toBeGreaterThan(issued.record.updated_at);
    } finally {
      db.close();
    }
  });

  it('preserves bearer_hash across rebind', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue({ contract_id: 'ct_old' }),
        now: NOW,
        bearer_plaintext: 'recued_rebind_bearer_hash',
      });

      const updated = store.updateTokenContract({
        token_id: issued.record.token_id,
        contract_id: 'ct_new',
        now: NOW + 1,
      });

      expect(updated?.bearer_hash).toBe(issued.record.bearer_hash);
      expect(store.getTokenById(issued.record.token_id)?.bearer_hash)
        .toBe(issued.record.bearer_hash);
    } finally {
      db.close();
    }
  });

  it('preserves grants across rebind', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue({
          contract_id: 'ct_old',
          grants: { 'tool.allowed': true, 'tool.denied': false, 'tool.extra': true },
        }),
        now: NOW,
        bearer_plaintext: 'recued_rebind_grants',
      });

      const updated = store.updateTokenContract({
        token_id: issued.record.token_id,
        contract_id: 'ct_new',
        now: NOW + 1,
      });

      expect(updated?.grants).toEqual({
        'tool.allowed': true,
        'tool.denied': false,
        'tool.extra': true,
      });
    } finally {
      db.close();
    }
  });

  it('preserves chat_mode across rebind', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue({
          contract_id: 'ct_old',
          chat_mode: { offered: true },
        }),
        now: NOW,
        bearer_plaintext: 'recued_rebind_chat_mode',
      });

      const updated = store.updateTokenContract({
        token_id: issued.record.token_id,
        contract_id: 'ct_new',
        now: NOW + 1,
      });

      expect(updated?.chat_mode).toEqual({ offered: true });
    } finally {
      db.close();
    }
  });

  it('preserves label across rebind', () => {
    const db = new Database(':memory:');
    try {
      ensureChatInboundTokenSchema(db);
      const store = createChatInboundTokenStore(db);
      const issued = store.issueToken({
        value: tokenValue({
          label: 'Rebind target',
          contract_id: 'ct_old',
        }),
        now: NOW,
        bearer_plaintext: 'recued_rebind_label',
      });

      const updated = store.updateTokenContract({
        token_id: issued.record.token_id,
        contract_id: 'ct_new',
        now: NOW + 1,
      });

      expect(updated?.label).toBe('Rebind target');
    } finally {
      db.close();
    }
  });
});
