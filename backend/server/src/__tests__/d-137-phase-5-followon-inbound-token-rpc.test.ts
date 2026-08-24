/** D-137 P5 follow-on § A.9 — `chat.inbound_token.*` rpc surface +
 *  verifier swap-in.
 *
 *  Substrate-level acceptance for:
 *    - `makeChatHandlers` claims every `chat.inbound_token.*` method.
 *    - `chat.inbound_token.list` returns the persisted rows.
 *    - `chat.inbound_token.get` returns the persisted record OR `null`.
 *    - `chat.inbound_token.issue` validates input + persists + audits
 *      + broadcasts + returns the bearer plaintext exactly once.
 *    - `chat.inbound_token.issue` raises 400 on peer_handle conflict
 *      (spec § A.9 "one token per peer initially") with the
 *      `PEER_HANDLE_CONFLICT_PREFIX` message.
 *    - `chat.inbound_token.update_grants` validates shape + 404s on
 *      missing row + audits with grants_added_count / grants_removed_count.
 *    - `chat.inbound_token.revoke` is idempotent + only audits + only
 *      broadcasts on the FIRST revoke (state change).
 *    - `chat.inbound_token.delete` hard-deletes + emits broadcast with
 *      `record: null`.
 *    - All `chat.inbound_token.*` rpcs return 501 (`not_configured`)
 *      when the store is unwired.
 *    - 13-code validator ratchet survives the rpc surface.
 *    - `MCP_RESERVED_RPC_PREFIXES` reservation: every method matches
 *      the `chat.inbound_token.` prefix (channel-isolation invariant).
 *
 *  Acceptance maps to spec § P5 follow-on next-steps:
 *    - rpc family ships
 *    - Settings UI uses `chat.inbound_token.list` / `get` / `issue` /
 *      `update_grants` / `revoke` / `delete`
 *    - audit emission for the three reserved kinds
 *    - broadcast emission for the four mutating ops
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  CHAT_RPC_METHODS,
  MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES,
  MCP_RESERVED_RPC_PREFIXES,
  OWNER_CONTRACT_ID,
  PUBLIC_CONTRACT_ID,
  RpcError,
  isReservedLocalRpc,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import {
  createChatStore,
  ensureChatSchema,
} from '../storage/chat-store.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
  generateMcpInboundTokenBearer,
  type ChatInboundTokenStore,
} from '../storage/chat-inbound-token-store.js';
import {
  handleInboundTokenDelete,
  handleInboundTokenGet,
  handleInboundTokenIssue,
  handleInboundTokenList,
  handleInboundTokenRevoke,
  handleInboundTokenToolCatalog,
  handleInboundTokenUpdateContract,
  handleInboundTokenUpdateGrants,
  makeChatHandlers,
  type ChatRpcDeps,
} from '../chat-handler.js';
import type { ChatBroadcastEmitter } from '../chat-orchestrator.js';
import {
  enqueueMcpRecipeCallback,
  sweepMcpRecipeCallbackRetention,
} from '../mcp-recipe-callback.js';
import {
  createSharedStore,
  type SharedStore,
} from '../storage/shared-store.js';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-self',
};

interface TestRig {
  deps: ChatRpcDeps;
  inboundTokenStore: ChatInboundTokenStore;
  callbackStore: SharedStore;
  broadcastedEvents: Array<{
    kind: string;
    op?: string;
    token_id?: string;
    record?: unknown;
  }>;
  auditRows: Array<{ action: string; target: string; detail?: string }>;
}

const setup = (): TestRig => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  ensureChatInboundTokenSchema(db);
  const store = createChatStore(db);
  const callbackStore = createSharedStore({
    db,
    // Callback values are CAS-inline by contract, so this test never calls a
    // blob method; the production SharedStore logic and schema remain real.
    blobs: {} as never,
    now: () => 10_000,
  });
  let inboundTokenStore: ChatInboundTokenStore;
  inboundTokenStore = createChatInboundTokenStore(db, {
    onAuthorityChanged: (token_id) =>
      sweepMcpRecipeCallbackRetention({
        store: callbackStore,
        inboundTokenStore,
        token_id,
        now: () => 10_000,
      }).then(() => undefined),
  });
  const broadcastedEvents: TestRig['broadcastedEvents'] = [];
  const broadcast: ChatBroadcastEmitter = {
    emit: (event) => broadcastedEvents.push(event as TestRig['broadcastedEvents'][number]),
  };
  const auditRows: TestRig['auditRows'] = [];
  const auditLog = {
    logActivity: vi.fn(async (entry) => {
      auditRows.push({
        action: entry.action,
        target: entry.target,
        detail: entry.detail,
      });
    }),
    listRecent: vi.fn(),
    listExecutionAttempts: vi.fn(),
    getRecentByRecipe: vi.fn(),
  } as unknown as ChatRpcDeps['auditLog'];
  const orchestrator = {
    runTurn: vi.fn(async () => ({ turn_id: 'turn-stub' })),
    dispatch: { dispatchTool: vi.fn() },
  } as unknown as ChatRpcDeps['orchestrator'];
  return {
    deps: {
      store,
      inboundTokenStore,
      orchestrator,
      broadcast,
      auditLog,
      selfSignature,
      now: () => 10_000,
      // ⛔ ALWAYS-CONTRACTED: issuance mints a carrier when the caller names no
      // contract, and REFUSES if the minter is unwired rather than falling back
      // to an unbound token. A harness that omits this is not exercising the
      // shipped path.
      mintTokenContract: ({ label }: { label: string }) => `ct_for_${label}`,
    },
    inboundTokenStore,
    callbackStore,
    broadcastedEvents,
    auditRows,
  };
};

const CALLBACK_TOOL = 'recued-core/callback-query';

const issueCallbackToken = async (rig: TestRig) =>
  handleInboundTokenIssue(rig.deps, validIssuanceArgs({
    contract_id: 'ct_callbacks',
    grants: {
      [CALLBACK_TOOL]: true,
      'recued-core/retained-query': true,
    },
  }));

const queueCallback = async (
  rig: TestRig,
  token_id: string,
  query_tool = CALLBACK_TOOL,
): Promise<void> => {
  const result = await enqueueMcpRecipeCallback(
    {
      store: rig.callbackStore,
      inboundTokenStore: rig.inboundTokenStore,
      isContractLive: () => true,
      permitsMcpDoor: () => true,
      now: () => 10_000,
      newCallbackRef: () => `mcpcb_${query_tool === CALLBACK_TOOL ? 'callback1' : 'retained1'}`,
    },
    {
      destination_contract_id: 'ct_callbacks',
      topic: query_tool === CALLBACK_TOOL ? 'mail.callback' : 'mail.retained',
      query_tool,
      arguments: { record_id: 'mail:lifecycle' },
      ttl_seconds: 3600,
      source_recipe_id: 'mail-callback-watch',
    },
  );
  expect(result.queued_to).toBe(1);
  const rows = await rig.callbackStore.list(`mcp.recipe-callback.${token_id}`);
  const values = await Promise.all(
    rows.map(async (row) => (await rig.callbackStore.read(row.key))?.value),
  );
  expect(values).toEqual(expect.arrayContaining([
    expect.objectContaining({ target_token_id: token_id, query_tool }),
  ]));
};

const callbackValues = async (
  rig: TestRig,
  token_id: string,
): Promise<unknown[]> => {
  const rows = await rig.callbackStore.list(`mcp.recipe-callback.${token_id}`);
  return Promise.all(rows.map(async (row) => (await rig.callbackStore.read(row.key))?.value));
};

const validIssuanceArgs = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  label: 'Mary',
  peer_handle: 'mary',
  grants: { 'mail.search': true, 'recipe.run': false },
  concurrency_tier: 5,
  expires_at: 0,
  chat_mode: null,
  ...overrides,
});

describe('D-137 P5 follow-on — channel-isolation invariant', () => {
  it('MCP_RESERVED_RPC_PREFIXES includes chat.inbound_token.', () => {
    expect([...MCP_RESERVED_RPC_PREFIXES]).toContain('chat.inbound_token.');
  });

  it('every chat.inbound_token.* method is reserved local-UI only', () => {
    const methods = CHAT_RPC_METHODS.filter((m) => m.startsWith('chat.inbound_token.'));
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });
});

describe('D-137 P5 follow-on — makeChatHandlers slice claims all inbound-token methods', () => {
  it('claims chat.inbound_token.{list,get,issue,update_grants,revoke,delete,tool_catalog}', () => {
    const rig = setup();
    const slice = makeChatHandlers(rig.deps);
    expect(slice).toBeDefined();
    const claimed = new Set(slice!.methods);
    expect(claimed.has('chat.inbound_token.list')).toBe(true);
    expect(claimed.has('chat.inbound_token.get')).toBe(true);
    expect(claimed.has('chat.inbound_token.issue')).toBe(true);
    expect(claimed.has('chat.inbound_token.update_grants')).toBe(true);
    expect(claimed.has('chat.inbound_token.revoke')).toBe(true);
    expect(claimed.has('chat.inbound_token.delete')).toBe(true);
    // D-171 slice 2c — the grant checklist's live self tool catalog.
    expect(claimed.has('chat.inbound_token.tool_catalog')).toBe(true);
    expect(claimed.size).toBe(CHAT_RPC_METHODS.length);
  });
});

describe('D-171 slice 2c — chat.inbound_token.tool_catalog', () => {
  const toolFixture = (over: Partial<ToolEntry> = {}): ToolEntry => ({
    name: 'mail.search',
    tier: 1,
    description: 'Search the personal mail warehouse.',
    arg_schema: {},
    topic_tags: [],
    classification: 'read',
    concurrency_safe: true,
    ...over,
  });

  it('returns the provider catalog verbatim', () => {
    const rig = setup();
    const catalog: ToolEntry[] = [
      toolFixture({ name: 'mail.search', classification: 'read' }),
      toolFixture({ name: 'recipe.run', classification: 'write', concurrency_safe: false }),
    ];
    const deps: ChatRpcDeps = { ...rig.deps, catalogProvider: () => catalog };
    const result = handleInboundTokenToolCatalog(deps);
    expect(result.catalog).toEqual(catalog);
  });

  it('reads the provider per-call (catalog reshapes live without a restart)', () => {
    const rig = setup();
    let live: ToolEntry[] = [toolFixture({ name: 'mail.search' })];
    const deps: ChatRpcDeps = { ...rig.deps, catalogProvider: () => live };
    expect(handleInboundTokenToolCatalog(deps).catalog).toHaveLength(1);
    // Simulate an install / connection edit reshaping the registry.
    live = [...live, toolFixture({ name: 'calendar.search' })];
    expect(handleInboundTokenToolCatalog(deps).catalog).toHaveLength(2);
  });

  it('returns 501 when the catalog provider is unwired (dbless harness)', () => {
    // `setup()` deps deliberately omit `catalogProvider`.
    const rig = setup();
    expect(rig.deps.catalogProvider).toBeUndefined();
    expect(() => handleInboundTokenToolCatalog(rig.deps)).toThrow(RpcError);
  });

  it('is reserved local-UI only (channel-isolation invariant)', () => {
    // The grant catalog enumerates the owner's full self tool surface — an
    // external MCP agent must never read it. The `chat.inbound_token.` prefix
    // reservation covers it (asserted generically above; pinned here too).
    expect(isReservedLocalRpc('chat.inbound_token.tool_catalog')).toBe(true);
  });
});

describe('D-137 P5 follow-on — chat.inbound_token.list', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('returns empty list on empty store', () => {
    const result = handleInboundTokenList(rig.deps);
    expect(result.tokens).toEqual([]);
  });

  it('returns persisted rows', async () => {
    await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    const result = handleInboundTokenList(rig.deps);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].label).toBe('Mary');
  });

  it('returns 501 when store is unwired', () => {
    const depsWithoutStore: ChatRpcDeps = { ...rig.deps, inboundTokenStore: undefined };
    expect(() => handleInboundTokenList(depsWithoutStore)).toThrow(RpcError);
  });
});

describe('D-137 P5 follow-on — chat.inbound_token.get', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('returns null on missing token_id', () => {
    const result = handleInboundTokenGet(rig.deps, { token_id: 'nope' });
    expect(result.token).toBeNull();
  });

  it('returns the persisted row when found', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    const result = handleInboundTokenGet(rig.deps, { token_id: issued.record.token_id });
    expect(result.token).not.toBeNull();
    expect(result.token!.label).toBe('Mary');
  });

  it('rejects empty token_id', () => {
    expect(() =>
      handleInboundTokenGet(rig.deps, { token_id: '' }),
    ).toThrow(RpcError);
  });
});

describe('D-137 P5 follow-on — chat.inbound_token.issue', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('returns IssuedMcpInboundToken envelope with bearer plaintext', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    expect(issued.record.label).toBe('Mary');
    expect(issued.record.peer_handle).toBe('mary');
    expect(issued.record.token_id).toMatch(/^[0-9a-f]{16}$/);
    expect(issued.bearer_plaintext.startsWith('recued_')).toBe(true);
  });

  it('emits chat.inbound_token_changed broadcast op:"issue" without bearer plaintext', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    const fan = rig.broadcastedEvents.find(
      (e) => e.kind === 'chat.inbound_token_changed',
    );
    expect(fan).toBeDefined();
    expect(fan!.op).toBe('issue');
    expect(fan!.token_id).toBe(issued.record.token_id);
    // Bearer plaintext NEVER enters the broadcast — the renderer never
    // sees it twice; the issuance response is the only surface.
    const serialized = JSON.stringify(fan);
    expect(serialized.includes(issued.bearer_plaintext)).toBe(false);
  });

  it('emits chat_inbound_token_issued audit row with non-secret summary stats', async () => {
    await handleInboundTokenIssue(
      rig.deps,
      validIssuanceArgs({
        grants: { a: true, b: true, c: false },
      }),
    );
    const audit = rig.auditRows.find((r) => r.action === 'chat_inbound_token_issued');
    expect(audit).toBeDefined();
    const detail = JSON.parse(audit!.detail!);
    expect(detail.label).toBe('Mary');
    expect(detail.peer_handle).toBe('mary');
    expect(detail.grants_total).toBe(3);
    expect(detail.grants_allowed_count).toBe(2);
    // No bearer plaintext / hash in the audit detail.
    expect(audit!.detail!.includes('recued_')).toBe(false);
    expect(audit!.detail!.includes('bearer_hash')).toBe(false);
  });

  it('rejects validation errors as 400 bad_request with joined codes', async () => {
    try {
      await handleInboundTokenIssue(rig.deps, { label: '', grants: 'bad' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      if (err instanceof RpcError) {
        expect(err.code).toBe('bad_request');
        // Issue codes from the closed list surface in the message.
        const message = err.message;
        expect(message.includes('label_invalid')).toBe(true);
        expect(message.includes('grants_shape_invalid')).toBe(true);
      }
    }
  });

  it('raises 400 bad_request on peer_handle conflict (spec § A.9 one token per peer)', async () => {
    await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    try {
      await handleInboundTokenIssue(
        rig.deps,
        validIssuanceArgs({ label: 'Mary v2' }),
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      if (err instanceof RpcError) {
        expect(err.code).toBe('bad_request');
        expect(err.message.includes('peer_handle_conflict')).toBe(true);
      }
    }
  });

  it('returns 501 when store is unwired', async () => {
    const depsWithoutStore: ChatRpcDeps = { ...rig.deps, inboundTokenStore: undefined };
    await expect(
      handleInboundTokenIssue(depsWithoutStore, validIssuanceArgs()),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('D-137 P5 follow-on — chat.inbound_token.update_grants', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('updates the persisted row + emits broadcast + audits diff stats', async () => {
    const issued = await handleInboundTokenIssue(
      rig.deps,
      validIssuanceArgs({
        grants: { 'mail.search': true, 'recipe.run': false },
      }),
    );
    rig.broadcastedEvents.length = 0;
    rig.auditRows.length = 0;
    const result = await handleInboundTokenUpdateGrants(rig.deps, {
      token_id: issued.record.token_id,
      grants: { 'mail.search': false, 'recipe.run': true, 'new.tool': true },
    });
    expect(result.token.grants['mail.search']).toBe(false);
    expect(result.token.grants['recipe.run']).toBe(true);
    expect(result.token.grants['new.tool']).toBe(true);
    const fan = rig.broadcastedEvents.find(
      (e) => e.kind === 'chat.inbound_token_changed' && e.op === 'update_grants',
    );
    expect(fan).toBeDefined();
    const audit = rig.auditRows.find(
      (r) => r.action === 'chat_inbound_token_grants_updated',
    );
    expect(audit).toBeDefined();
    const detail = JSON.parse(audit!.detail!);
    expect(detail.grants_added_count).toBe(2); // recipe.run + new.tool flipped true
    expect(detail.grants_removed_count).toBe(1); // mail.search flipped false
  });

  it('returns 404 when token_id missing', async () => {
    await expect(
      handleInboundTokenUpdateGrants(rig.deps, {
        token_id: 'no-such-token',
        grants: { foo: true },
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects non-object grants', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    await expect(
      handleInboundTokenUpdateGrants(rig.deps, {
        token_id: issued.record.token_id,
        grants: 'no',
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects non-boolean grant values', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    await expect(
      handleInboundTokenUpdateGrants(rig.deps, {
        token_id: issued.record.token_id,
        grants: { foo: 'yes' },
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('D-171 2b — sets chat_mode while preserving grants (chat-only edit)', async () => {
    const issued = await handleInboundTokenIssue(
      rig.deps,
      validIssuanceArgs({
        grants: { 'mail.search': true, 'recipe.run': false },
        chat_mode: null,
      }),
    );
    rig.auditRows.length = 0;
    // No `grants` key — the grant map must survive untouched.
    const result = await handleInboundTokenUpdateGrants(rig.deps, {
      token_id: issued.record.token_id,
      chat_mode: { offered: true },
    });
    expect(result.token.chat_mode).toEqual({ offered: true });
    expect(result.token.grants['mail.search']).toBe(true);
    expect(result.token.grants['recipe.run']).toBe(false);
    const audit = rig.auditRows.find(
      (r) => r.action === 'chat_inbound_token_grants_updated',
    );
    const detail = JSON.parse(audit!.detail!);
    expect(detail.chat_mode_edited).toBe(true);
    expect(detail.chat_mode_offered).toBe(true);
    expect(detail.grants_edited).toBe(false);
  });

  it('D-171 2b — preserves chat_mode when omitted (grants-only edit)', async () => {
    const issued = await handleInboundTokenIssue(
      rig.deps,
      validIssuanceArgs({
        grants: { 'mail.search': true },
        chat_mode: { offered: true },
      }),
    );
    // No `chat_mode` key — the prior chat-mode must survive.
    const result = await handleInboundTokenUpdateGrants(rig.deps, {
      token_id: issued.record.token_id,
      grants: { 'mail.search': false, 'recipe.run': true },
    });
    expect(result.token.grants['recipe.run']).toBe(true);
    expect(result.token.chat_mode).toEqual({ offered: true });
  });

  it('D-171 2b — chat_mode null clears chat-mode', async () => {
    const issued = await handleInboundTokenIssue(
      rig.deps,
      validIssuanceArgs({ chat_mode: { offered: true } }),
    );
    const result = await handleInboundTokenUpdateGrants(rig.deps, {
      token_id: issued.record.token_id,
      chat_mode: null,
    });
    expect(result.token.chat_mode).toBeNull();
  });

  it('D-171 2b — rejects a malformed chat_mode', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    await expect(
      handleInboundTokenUpdateGrants(rig.deps, {
        token_id: issued.record.token_id,
        chat_mode: { offered: 'yes' },
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('D-171 2b — rejects an update with neither grants nor chat_mode', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    await expect(
      handleInboundTokenUpdateGrants(rig.deps, {
        token_id: issued.record.token_id,
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('D-171 2b — checks token existence even on a chat-only edit (404)', async () => {
    await expect(
      handleInboundTokenUpdateGrants(rig.deps, {
        token_id: 'no-such-token',
        chat_mode: { offered: true },
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('D-137 P5 follow-on — chat.inbound_token.revoke', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('stamps revoked_at + emits broadcast + audits on first revoke', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    rig.broadcastedEvents.length = 0;
    rig.auditRows.length = 0;
    const result = await handleInboundTokenRevoke(rig.deps, {
      token_id: issued.record.token_id,
    });
    expect(result.revoked).toBe(true);
    expect(result.token.revoked_at).toBe(10_000);
    const fan = rig.broadcastedEvents.find(
      (e) => e.kind === 'chat.inbound_token_changed' && e.op === 'revoke',
    );
    expect(fan).toBeDefined();
    const audit = rig.auditRows.find(
      (r) => r.action === 'chat_inbound_token_revoked',
    );
    expect(audit).toBeDefined();
  });

  it('is idempotent — re-revoke returns revoked:false + no second audit / broadcast', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    await handleInboundTokenRevoke(rig.deps, { token_id: issued.record.token_id });
    rig.broadcastedEvents.length = 0;
    rig.auditRows.length = 0;
    const result = await handleInboundTokenRevoke(rig.deps, {
      token_id: issued.record.token_id,
    });
    expect(result.revoked).toBe(false);
    expect(rig.broadcastedEvents.find((e) => e.kind === 'chat.inbound_token_changed')).toBeUndefined();
    expect(
      rig.auditRows.find((r) => r.action === 'chat_inbound_token_revoked'),
    ).toBeUndefined();
  });

  it('returns 404 on missing token_id', async () => {
    await expect(
      handleInboundTokenRevoke(rig.deps, { token_id: 'nope' }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('D-137 P5 follow-on — chat.inbound_token.delete', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('hard-deletes + emits broadcast with record:null', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    rig.broadcastedEvents.length = 0;
    const result = await handleInboundTokenDelete(rig.deps, {
      token_id: issued.record.token_id,
    });
    expect(result.deleted).toBe(true);
    const fan = rig.broadcastedEvents.find(
      (e) => e.kind === 'chat.inbound_token_changed' && e.op === 'delete',
    );
    expect(fan).toBeDefined();
    expect(fan!.record).toBeNull();
    expect(fan!.token_id).toBe(issued.record.token_id);
    const post = handleInboundTokenGet(rig.deps, { token_id: issued.record.token_id });
    expect(post.token).toBeNull();
  });

  it('returns deleted:false when token never existed (no broadcast)', async () => {
    const result = await handleInboundTokenDelete(rig.deps, { token_id: 'nope' });
    expect(result.deleted).toBe(false);
    expect(rig.broadcastedEvents).toEqual([]);
  });
});

describe('MCP callback mailbox follows inbound-token authority lifecycle', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('selectively scrubs callbacks whose query grant was removed', async () => {
    const issued = await issueCallbackToken(rig);
    await queueCallback(rig, issued.record.token_id);
    await queueCallback(rig, issued.record.token_id, 'recued-core/retained-query');

    await handleInboundTokenUpdateGrants(rig.deps, {
      token_id: issued.record.token_id,
      grants: { 'recued-core/retained-query': true },
    });

    const values = await callbackValues(rig, issued.record.token_id);
    expect(values).toHaveLength(2);
    expect(values).toEqual(expect.arrayContaining([
      expect.objectContaining({ retired: true }),
      expect.objectContaining({ query_tool: 'recued-core/retained-query' }),
    ]));
    expect(JSON.stringify(values.filter(
      (value) => (value as { retired?: unknown }).retired === true,
    ))).not.toContain('mail:lifecycle');
  });

  it('scrubs callbacks immediately on contract rebind and revoke', async () => {
    const rebound = await issueCallbackToken(rig);
    await queueCallback(rig, rebound.record.token_id);
    await handleInboundTokenUpdateContract(rig.deps, {
      token_id: rebound.record.token_id,
      contract_id: 'ct_rebound',
    });
    expect(await callbackValues(rig, rebound.record.token_id)).toEqual([
      expect.objectContaining({ retired: true }),
    ]);

    const secondRig = setup();
    const revoked = await issueCallbackToken(secondRig);
    await queueCallback(secondRig, revoked.record.token_id);
    await handleInboundTokenRevoke(secondRig.deps, {
      token_id: revoked.record.token_id,
    });
    expect(await callbackValues(secondRig, revoked.record.token_id)).toEqual([
      expect.objectContaining({ retired: true }),
    ]);
  });

  it('retries orphan cleanup through an idempotent hard-delete call', async () => {
    const issued = await issueCallbackToken(rig);
    await queueCallback(rig, issued.record.token_id);
    expect(rig.inboundTokenStore.deleteToken(issued.record.token_id)).toBe(true);

    await expect(handleInboundTokenDelete(rig.deps, {
      token_id: issued.record.token_id,
    })).resolves.toEqual({ deleted: false });

    expect(await callbackValues(rig, issued.record.token_id)).toEqual([
      expect.objectContaining({ retired: true }),
    ]);
  });

  it('does not roll back token revocation when callback retention is unavailable', async () => {
    const issued = await issueCallbackToken(rig);
    rig.callbackStore.list = async () => {
      throw new Error('shared store unavailable');
    };
    const result = await handleInboundTokenRevoke(
      rig.deps,
      { token_id: issued.record.token_id },
    );

    expect(result.revoked).toBe(true);
    expect(result.token.revoked_at).toBe(10_000);
  });
});

describe('D-137 P5 follow-on — validator ratchet (15 closed-list codes)', () => {
  it('MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES carries 15 entries', () => {
    // D-166 P2 — `contract_id_invalid` added for the token↔contract binding.
    // Standing closure (MCP arm) — `standing_closure_invalid`. The code exists
    // so the wire can be REFUSED an op list: the closure is derived from the
    // granted recipes, and a caller naming its own is a validation error rather
    // than a quietly-honoured standing authority.
    // ⚠ D-249 briefly added a 16th (`allow_ai_invalid`) and REMOVED it in the
    // same session: the owner ruled that granting a recipe BY NAME is already
    // the consent to what that recipe does, so there was nothing for the wire to
    // carry. The count is a ratchet, not a target — it went back down.
    expect(MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES.length).toBe(15);
  });
});

// ════════════════════════════════════════════════════════════════
// Verifier swap-in acceptance — issued bearer roundtrips to a
// `token_id`-bound MCP dispatch context. The actual MCP HTTP port
// handler wiring lives in bin.ts; here we verify the substrate
// returns the right `mcp_token_id` so the dispatch surface (audit +
// per-token rate limit + per-tool grants) keys on the issued row.
// ════════════════════════════════════════════════════════════════

describe('D-137 P5 follow-on — verifier swap-in: store.verifyBearer threads token_id', () => {
  it('issued bearer matches stored record + carries stable token_id', async () => {
    const rig = setup();
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    const verified = rig.inboundTokenStore.verifyBearer({
      bearer: issued.bearer_plaintext,
      now: 10_000,
    });
    expect(verified).not.toBeNull();
    expect(verified!.token_id).toBe(issued.record.token_id);
    expect(verified!.label).toBe('Mary');
  });

  it('verifyBearer rejects an unrelated bearer (constant-time miss)', async () => {
    const rig = setup();
    await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    const verified = rig.inboundTokenStore.verifyBearer({
      bearer: generateMcpInboundTokenBearer(),
      now: 10_000,
    });
    expect(verified).toBeNull();
  });

  it('verifyBearer rejects a revoked per-pair bearer', async () => {
    const rig = setup();
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    await handleInboundTokenRevoke(rig.deps, { token_id: issued.record.token_id });
    const verified = rig.inboundTokenStore.verifyBearer({
      bearer: issued.bearer_plaintext,
      now: 11_000,
    });
    expect(verified).toBeNull();
  });
});

describe('D-171 slice 3 — chat.inbound_token.update_contract', () => {
  type UpdateContractToken = {
    token_id: string;
    bearer_hash: string;
    contract_id?: string;
    grants: Record<string, boolean>;
  } & Record<string, unknown>;

  const updateContract = (
    deps: ChatRpcDeps,
    args: unknown,
  ): Promise<{ token: UpdateContractToken }> => {
    const handler =
      makeChatHandlers(deps)?.handlers['chat.inbound_token.update_contract'];
    if (!handler) {
      throw new Error('chat.inbound_token.update_contract not registered');
    }
    return handler(args as never, undefined as never) as unknown as Promise<{
      token: UpdateContractToken;
    }>;
  };

  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('returns 501 not_configured when inboundTokenStore is undefined', async () => {
    const depsWithoutStore: ChatRpcDeps = { ...rig.deps, inboundTokenStore: undefined };

    await expect(
      updateContract(depsWithoutStore, {
        token_id: 'tok_missing',
        contract_id: 'ct_bound',
      }),
    ).rejects.toMatchObject({
      code: 'not_configured',
      status: 501,
    });
  });

  it('returns 400 bad_request when args is not an object', async () => {
    await expect(updateContract(rig.deps, 'not-an-object')).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('returns 400 bad_request when token_id is missing', async () => {
    await expect(
      updateContract(rig.deps, { contract_id: 'ct_bound' }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('returns 400 bad_request when token_id is empty string', async () => {
    await expect(
      updateContract(rig.deps, { token_id: '', contract_id: 'ct_bound' }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('returns 400 bad_request when contract_id key is absent', async () => {
    await expect(
      updateContract(rig.deps, { token_id: 'tok_missing' }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('returns 400 bad_request when contract_id is a number', async () => {
    await expect(
      updateContract(rig.deps, { token_id: 'tok_missing', contract_id: 42 }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('returns 400 bad_request when contract_id is an array', async () => {
    await expect(
      updateContract(rig.deps, { token_id: 'tok_missing', contract_id: ['ct_bound'] }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('returns 400 bad_request when contract_id is an empty string', async () => {
    await expect(
      updateContract(rig.deps, { token_id: 'tok_missing', contract_id: '' }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('returns 400 bad_request when contract_id length exceeds 256', async () => {
    await expect(
      updateContract(rig.deps, { token_id: 'tok_missing', contract_id: 'c'.repeat(257) }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('returns 404 not_found when token_id names no row', async () => {
    await expect(
      updateContract(rig.deps, { token_id: 'tok_missing', contract_id: 'ct_bound' }),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  // D-248 Amendment 3 — the two RESERVED SENTINELS can never be bound to a door
  // token. The owner fence shipped with D-187 amendment 3b and was never covered
  // here; the public fence had no call site at all until now
  // (`isReservedOwnerContractId` had five, `isReservedPublicContractId` had ZERO,
  // while its own docstring claimed the pair "can never drift"). Both pinned
  // together so the next drift is a red rather than a discovery.
  it('refuses to bind either reserved sentinel AT ISSUE', async () => {
    // ⛔ THE SECOND BIND PATH. `issue` takes a caller-supplied `contract_id` and its
    // validator checks SHAPE ONLY, so fencing `update_contract` alone left this open
    // one rpc over — including for the OWNER sentinel, whose D-187 fence never
    // covered it. Both pinned here so neither path can regress alone.
    for (const reserved of [OWNER_CONTRACT_ID, PUBLIC_CONTRACT_ID]) {
      await expect(
        handleInboundTokenIssue(rig.deps, {
          ...validIssuanceArgs(),
          contract_id: reserved,
        }),
      ).rejects.toMatchObject({ code: 'bad_request' });
    }
  });

  it('refuses to bind either reserved sentinel to a door token', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    for (const reserved of [OWNER_CONTRACT_ID, PUBLIC_CONTRACT_ID]) {
      await expect(
        updateContract(rig.deps, {
          token_id: issued.record.token_id,
          contract_id: reserved,
        }),
      ).rejects.toMatchObject({ code: 'bad_request' });
    }
  });

  it('binds contract_id and emits update_contract broadcast plus bound audit detail', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    rig.broadcastedEvents.length = 0;
    rig.auditRows.length = 0;

    const result = await updateContract(rig.deps, {
      token_id: issued.record.token_id,
      contract_id: 'ct_bound',
    });

    expect(result.token.contract_id).toBe('ct_bound');
    const fan = rig.broadcastedEvents.find(
      (e) => e.kind === 'chat.inbound_token_changed' && e.op === 'update_contract',
    );
    expect(fan).toBeDefined();
    expect(fan!.token_id).toBe(issued.record.token_id);
    expect(fan!.record).toMatchObject({
      token_id: issued.record.token_id,
      contract_id: 'ct_bound',
    });
    const audit = rig.auditRows.find(
      (r) => r.action === 'chat_inbound_token_contract_updated',
    );
    expect(audit).toBeDefined();
    expect(audit!.target).toBe(issued.record.token_id);
    const detail = JSON.parse(audit!.detail!);
    expect(detail).toEqual({ bound: true, contract_id: 'ct_bound' });
  });

  /** ⛔⛔ UNBINDING IS GONE, and this slot used to prove it worked. A token is
   *  always contracted now: `null` left a live token with no contract row and
   *  only a synthetic `contract_id` naming nothing, which is the confusion the
   *  always-contracted change removes. Removing limits means rebinding to an
   *  UNBOUNDED carrier — the limits are the contract's fields, not its reason
   *  to exist. */
  it('⛔⛔ refuses to unbind — a token is always contracted', async () => {
    const issued = await handleInboundTokenIssue(
      rig.deps,
      validIssuanceArgs({ contract_id: 'ct_old' }),
    );
    await expect(updateContract(rig.deps, {
      token_id: issued.record.token_id,
      contract_id: null,
    })).rejects.toThrow(/always contracted/);
    // …and the binding is untouched: a refused call changes nothing.
    expect(rig.inboundTokenStore.getTokenById(issued.record.token_id)?.contract_id)
      .toBe('ct_old');
  });

  /** …and REBINDING still works, which is the path that replaces unbinding. */
  it('rebinds to an unbounded carrier instead — how limits are removed now', async () => {
    const issued = await handleInboundTokenIssue(
      rig.deps,
      validIssuanceArgs({ contract_id: 'ct_limited' }),
    );
    const result = await updateContract(rig.deps, {
      token_id: issued.record.token_id,
      contract_id: 'ct_unbounded',
    });
    expect(result.token.contract_id).toBe('ct_unbounded');
  });

  it('returns success when update_contract broadcast throws', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    const depsWithThrowingBroadcast: ChatRpcDeps = {
      ...rig.deps,
      broadcast: {
        emit: vi.fn(() => {
          throw new Error('broadcast failed');
        }),
      },
    };

    const result = await updateContract(depsWithThrowingBroadcast, {
      token_id: issued.record.token_id,
      contract_id: 'ct_bound',
    });

    expect(result.token.contract_id).toBe('ct_bound');
  });

  it('returns success when update_contract audit throws', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    const depsWithThrowingAudit: ChatRpcDeps = {
      ...rig.deps,
      auditLog: {
        logActivity: vi.fn(async () => {
          throw new Error('audit failed');
        }),
        listRecent: vi.fn(),
        listExecutionAttempts: vi.fn(),
        getRecentByRecipe: vi.fn(),
      } as unknown as ChatRpcDeps['auditLog'],
    };

    const result = await updateContract(depsWithThrowingAudit, {
      token_id: issued.record.token_id,
      contract_id: 'ct_bound',
    });

    expect(result.token.contract_id).toBe('ct_bound');
  });

  it('preserves bearer_hash across update_contract rebind', async () => {
    const issued = await handleInboundTokenIssue(rig.deps, validIssuanceArgs());
    const prior = rig.inboundTokenStore.getTokenById(issued.record.token_id);
    expect(prior).not.toBeNull();

    const result = await updateContract(rig.deps, {
      token_id: issued.record.token_id,
      contract_id: 'ct_bound',
    });

    expect(result.token.bearer_hash).toBe(prior!.bearer_hash);
    expect(rig.inboundTokenStore.getTokenById(issued.record.token_id)?.bearer_hash)
      .toBe(prior!.bearer_hash);
  });
});
