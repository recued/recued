/** D-177 read-gate — EXTERNAL-DOOR transport e2e. The dispatch-layer test
 *  (`d-177-read-gate-timeline-dispatch.test.ts`) proves the timeline case
 *  wires the fence given a `contractOverlay` on its deps; the D-171
 *  transport test proves the composer threads `boundContractId` /
 *  `inboundTokenAuthorize` — but it MOCKS `createMcpHttpDispatch`, so
 *  nothing proved the full production path: a `recued_*` door bearer →
 *  `composeMcpHttpTransport` per-call deps → real dispatch →
 *  `handleToolCall('recued_dataTimeline')` → fence resolved off the BOUND
 *  contract's execution source. This drives the REAL transport composer +
 *  REAL dispatch (the token store, overlay resolver, and record loader
 *  are stubbed seams — the durable stores and the grant rows have
 *  their own unit coverage): the overlay's `resolveReadGrantChecker`
 *  asserts it receives the door's `contract_id` (not the synthetic token
 *  id) and returns a mail-only fence; a `contact:` entity is fenced, a
 *  `mail:` entity reads. */

import { describe, expect, it, vi } from 'vitest';
import {
  MCP_INBOUND_TOKEN_PREFIX,
  isReadableCollection,
  parseGrantEntry,
  type McpInboundTokenRecord,
  type TimelineEntry,
} from '@recued/contracts';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { ChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';
import type { ClientTokenStore } from '../pairing/client-tokens.js';
import { composeMcpHttpTransport } from '../composition/bin/wire-mcp-http-transport.js';
import type { GrantEntryResolver } from '../contract-grant-resolve.js';
import {
  AUTHOR_DEFAULT_ONLY_RESOLVER,
  createReadGrantChecker,
} from '../read-grant-checker.js';

const DOOR_BEARER = `${MCP_INBOUND_TOKEN_PREFIX}doorBearerE2e`;
const DOOR_CONTRACT_ID = 'door-contract-e2e';

type TransportSellerStore = NonNullable<
  Parameters<typeof composeMcpHttpTransport>[0]['sellerStore']
>;

const makeEmptySellerStore = (): TransportSellerStore => ({
  getSettings: vi.fn(),
  getTier: vi.fn(() => null),
  listCustomers: vi.fn(() => []),
  getUsageRollup: vi.fn(() => null),
  recordUsage: vi.fn(),
}) as unknown as TransportSellerStore;

/** A door's slice-5 read fence as explicit grant rows: the listed collections GRANTED,
 *  every other GOVERNED collection REVOKED (a non-governed collection defers to its own
 *  gate). The grant-row replacement for the retired mail-only `scope_restrictions`. */
const collectionFence = (granted: readonly string[]): GrantEntryResolver => {
  const allow = new Set(granted);
  return {
    isGranted: (_c, entry, authorDefault) => {
      const parsed = parseGrantEntry(entry);
      if (parsed.kind === 'collection')
        return isReadableCollection(parsed.value) ? allow.has(parsed.value) : authorDefault;
      return authorDefault;
    },
  };
};

/** The mail-only door fence reused across the e2e cases. */
const MAIL_ONLY: GrantEntryResolver = collectionFence(['mail']);

const mailEntry = (): TimelineEntry => ({
  ts: 1_000,
  source: 'mail',
  kind: 'record',
  payload: { _id: 'msg-1' },
});

const makeDoorRecord = (
  grants: Record<string, boolean> = { recued_dataTimeline: true },
): McpInboundTokenRecord => ({
  token_id: 'door-token-e2e',
  bearer_hash: 'hash',
  label: 'External door',
  created_at: 1_000,
  expires_at: 0,
  revoked_at: null,
  grants,
  concurrency_tier: 3,
  chat_mode: null,
  updated_at: 1_000,
  contract_id: DOOR_CONTRACT_ID,
});

/** Real transport composer + real dispatch. The overlay records every
 *  execution source `resolveReadGrantChecker` sees so the test can pin
 *  that the fence resolves against the BOUND contract id. The timeline
 *  read fence runs off `resolveReadGrantChecker` → `isCollectionReadGranted`
 *  (the collection grant rows), so the harness returns the bound door's
 *  `doorFence` checker and admit-all for any other source (D-187 slice 5/6). */
const makeHarness = (
  doorFence: GrantEntryResolver,
  grants?: Record<string, boolean>,
  contractLive = true,
  options: {
    readonly contractKind?: 'standing' | 'customer_instance';
    readonly sellerStore?: TransportSellerStore;
  } = {},
) => {
  const loader = vi.fn(async () => mailEntry());
  const fenceSources: Array<{ contract_id?: string }> = [];
  const contractOverlay = {
    shouldMeterUse: () => false,
    recordUse: () => {},
    isContractLive: (id: string) => contractLive && id === DOOR_CONTRACT_ID,
    ...(options.contractKind !== undefined
      ? { resolveBoundContractKind: () => options.contractKind }
      : {}),
    resolveReadGrantChecker: (source: { contract_id?: string }) => {
      fenceSources.push(source);
      const resolver =
        source.contract_id === DOOR_CONTRACT_ID ? doorFence : AUTHOR_DEFAULT_ONLY_RESOLVER;
      return createReadGrantChecker(resolver, undefined);
    },
  };
  const executeDeps = {
    recipeStore: { kind: 'recipe-store' },
    executorConfig: { kind: 'executor-config' },
    baseVault: {},
    instanceId: 'test-instance',
    serverName: 'test-server',
    contractOverlay,
    loadCollectionRecord: loader,
  } as unknown as ExecuteHandlerDeps;
  const inboundTokenStore = {
    verifyBearer: vi.fn(() => makeDoorRecord(grants)),
  } as unknown as Pick<ChatInboundTokenStore, 'verifyBearer'>;
  const bundle = composeMcpHttpTransport({
    executeDeps,
    vaultStore: undefined,
    housekeepingStateStore: undefined,
    internalRegistry: undefined,
    clientTokens: undefined,
    inboundTokenStore,
    ...(options.sellerStore ? { sellerStore: options.sellerStore } : {}),
  });
  expect(bundle).toBeDefined();
  return { bundle: bundle!, loader, fenceSources };
};

const callTimeline = async (
  bundle: ReturnType<typeof makeHarness>['bundle'],
  entity_id: string,
) =>
  (await bundle.mcpHttpDeps.dispatch(
    {
      jsonrpc: '2.0',
      id: 'e2e-1',
      method: 'tools/call',
      params: { name: 'recued_dataTimeline', arguments: { entity_id } },
    },
    DOOR_BEARER,
  )) as {
    result?: { content?: Array<{ text?: string }> };
    error?: { code: number; message: string };
  };

/** Generic `tools/call` over the real transport — used by the kill-switch
 *  block to fire an arbitrary native tool (granted OR ungranted) at a dead
 *  bound contract and pin which gate answered. */
const callTool = async (
  bundle: ReturnType<typeof makeHarness>['bundle'],
  name: string,
  args: Record<string, unknown>,
) =>
  (await bundle.mcpHttpDeps.dispatch(
    {
      jsonrpc: '2.0',
      id: 'e2e-tool',
      method: 'tools/call',
      params: { name, arguments: args },
    },
    DOOR_BEARER,
  )) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
    error?: { code: number; message: string };
  };

const parseEntries = (response: {
  result?: { content?: Array<{ text?: string }> };
}): TimelineEntry[] => {
  const text = response.result?.content?.[0]?.text;
  const parsed = JSON.parse(text ?? '{}') as { entries?: TimelineEntry[] };
  return parsed.entries ?? [];
};

describe('D-177 read-gate — external-door transport fences recued_dataTimeline e2e', () => {
  it('a mail-only door is FENCED off a contact: entity through the real transport', async () => {
    const { bundle, loader, fenceSources } = makeHarness(MAIL_ONLY);

    const response = await callTimeline(bundle, 'contact:bob@example.com');

    expect(response.error).toBeUndefined();
    expect(parseEntries(response)).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
    // The fence resolved against the BOUND contract, not the synthetic
    // per-token id — this is the seam step 3's transport made live.
    expect(fenceSources.length).toBeGreaterThan(0);
    expect(fenceSources.every((s) => s.contract_id === DOOR_CONTRACT_ID)).toBe(
      true,
    );
  });

  it('the same mail-only door READS a mail: entity through the real transport', async () => {
    const { bundle, loader } = makeHarness(MAIL_ONLY);

    const response = await callTimeline(bundle, 'mail:msg-1');

    expect(response.error).toBeUndefined();
    expect(loader).toHaveBeenCalledWith('mail', 'msg-1');
    expect(parseEntries(response)).toHaveLength(1);
  });

  it('no grant rows (door authored no restrictions) admits all collections', async () => {
    const { bundle, loader } = makeHarness(AUTHOR_DEFAULT_ONLY_RESOLVER);

    const response = await callTimeline(bundle, 'contact:bob@example.com');

    expect(response.error).toBeUndefined();
    expect(loader).toHaveBeenCalled();
  });

  it('an ungranted tool never reaches the fence (per-tool checklist runs first)', async () => {
    // Deny the timeline tool ITSELF so a pass can't be satisfied by some
    // other error path on an unrelated tool (codex MEDIUM fold) — the
    // assertion pins the checklist denial message + zero fence consults.
    const { bundle, loader, fenceSources } = makeHarness(MAIL_ONLY, {
      recued_dataTimeline: false,
    });

    const response = (await bundle.mcpHttpDeps.dispatch(
      {
        jsonrpc: '2.0',
        id: 'e2e-denied',
        method: 'tools/call',
        params: {
          name: 'recued_dataTimeline',
          arguments: { entity_id: 'mail:msg-1' },
        },
      },
      DOOR_BEARER,
    )) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

    expect(loader).not.toHaveBeenCalled();
    expect(fenceSources).toHaveLength(0);
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain(
      "not granted by this token's per-tool checklist",
    );
  });
});

describe('D-196 R1a — customer-instance pairing through the real MCP transport', () => {
  it('denies a live customer contract with no Seller row before the native tool reads', async () => {
    const sellerStore = makeEmptySellerStore();
    const { bundle, loader, fenceSources } = makeHarness(
      MAIL_ONLY,
      { recued_dataTimeline: true },
      true,
      { contractKind: 'customer_instance', sellerStore },
    );

    const response = await callTool(bundle, 'recued_dataTimeline', {
      entity_id: 'mail:msg-1',
    });

    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('no longer live');
    expect(sellerStore.listCustomers).toHaveBeenCalledWith({
      contract_id: DOOR_CONTRACT_ID,
    });
    expect(loader).not.toHaveBeenCalled();
    expect(fenceSources).toHaveLength(0);
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('keeps an authoritative standing contract with no Seller row byte-compatible', async () => {
    const sellerStore = makeEmptySellerStore();
    const { bundle, loader } = makeHarness(
      MAIL_ONLY,
      { recued_dataTimeline: true },
      true,
      { contractKind: 'standing', sellerStore },
    );

    const response = await callTimeline(bundle, 'mail:msg-1');

    expect(response.error).toBeUndefined();
    expect(parseEntries(response)).toHaveLength(1);
    expect(loader).toHaveBeenCalledWith('mail', 'msg-1');
    expect(sellerStore.listCustomers).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });
});

/** Owner (unbound CLI bearer) harness — a structured `<token_id>.<bearer>`
 *  resolves `kind: 'cli'`, so the per-call deps carry NO `boundContractId`. The
 *  overlay reports EVERY contract dead (`isContractLive: () => false`) to prove
 *  the kill-switch leaves the contract-free owner untouched (the guard requires
 *  a bound id). */
const OWNER_BEARER = `${'o'.repeat(16)}.${'k'.repeat(44)}`;

const makeOwnerHarness = () => {
  const loader = vi.fn(async () => mailEntry());
  const contractOverlay = {
    shouldMeterUse: () => false,
    recordUse: () => {},
    isContractLive: () => false,
    resolveReadGrantChecker: () =>
      createReadGrantChecker(AUTHOR_DEFAULT_ONLY_RESOLVER, undefined),
  };
  const executeDeps = {
    recipeStore: { kind: 'recipe-store' },
    executorConfig: { kind: 'executor-config' },
    baseVault: {},
    instanceId: 'test-instance',
    serverName: 'test-server',
    contractOverlay,
    loadCollectionRecord: loader,
  } as unknown as ExecuteHandlerDeps;
  const clientTokens = {
    verify: vi.fn(async () => ({
      ok: true,
      record: {
        token_id: 'o'.repeat(16),
        client_kind: 'cli',
        client_label: 'CLI',
        issued_at: 1_000,
        last_used_at: null,
        revoked_at: null,
        revocation_reason: null,
        metadata: null,
      },
    })),
    touch: vi.fn(),
  } as unknown as Pick<ClientTokenStore, 'verify' | 'touch'>;
  const bundle = composeMcpHttpTransport({
    executeDeps,
    vaultStore: undefined,
    housekeepingStateStore: undefined,
    internalRegistry: undefined,
    clientTokens,
    inboundTokenStore: undefined,
  });
  expect(bundle).toBeDefined();
  return { bundle: bundle!, loader };
};

describe('D-187 token-lifecycle — a dead bound contract kill-switches the native MCP path', () => {
  it('REFUSES a granted native tool with the liveness reason, before any store read or fence consult', async () => {
    // The door GRANTS recued_dataTimeline and authors a mail-only fence, but its
    // bound contract is DEAD. The structural kill-switch at the top of
    // handleToolCall denies BEFORE the per-tool checklist, the record loader, and
    // the read-grant / fence path.
    const { bundle, loader, fenceSources } = makeHarness(
      MAIL_ONLY,
      { recued_dataTimeline: true },
      false, // contract NOT live
    );

    const response = await callTool(bundle, 'recued_dataTimeline', {
      entity_id: 'mail:msg-1',
    });

    expect(response.result?.isError).toBe(true);
    // The liveness reason, NOT "not granted by checklist" — pins that the
    // structural guard answered, not the transport's `() => false` collapse.
    expect(response.result?.content?.[0]?.text).toContain('no longer live');
    expect(loader).not.toHaveBeenCalled();
    expect(fenceSources).toHaveLength(0);
  });

  it('denies a tool the door does NOT grant with the SAME liveness reason (guard precedes the checklist)', async () => {
    // recued_getAudit is absent from grants → a LIVE door answers "not granted by
    // checklist". A DEAD contract must answer the liveness reason instead,
    // proving the kill-switch fires upstream of the checklist for EVERY native
    // tool name (it returns before the name is even routed).
    const { bundle, loader, fenceSources } = makeHarness(
      MAIL_ONLY,
      { recued_dataTimeline: true },
      false,
    );

    const response = await callTool(bundle, 'recued_getAudit', { limit: 5 });

    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('no longer live');
    expect(response.result?.content?.[0]?.text).not.toContain(
      'per-tool checklist',
    );
    expect(loader).not.toHaveBeenCalled();
    expect(fenceSources).toHaveLength(0);
  });

  it('the SAME granted door READS once its bound contract is LIVE (the kill-switch is the sole cause)', async () => {
    // Identical door + grant + fence; only `contractLive` flips to true. The read
    // now succeeds, isolating the dead contract as the only reason the first case
    // was refused.
    const { bundle, loader } = makeHarness(
      MAIL_ONLY,
      { recued_dataTimeline: true },
      true, // contract live
    );

    const response = await callTool(bundle, 'recued_dataTimeline', {
      entity_id: 'mail:msg-1',
    });

    expect(response.result?.isError).toBeFalsy();
    expect(loader).toHaveBeenCalledWith('mail', 'msg-1');
    expect(parseEntries(response)).toHaveLength(1);
  });

  it('leaves the UNBOUND owner (CLI bearer, no boundContractId) untouched even when every contract is dead', async () => {
    // Regression guard for the `boundContractId !== undefined` clause: dropping
    // it would deny the contract-free owner (boundContractActive undefined). The
    // owner reads despite the overlay reporting every contract dead.
    const { bundle, loader } = makeOwnerHarness();

    const response = (await bundle.mcpHttpDeps.dispatch(
      {
        jsonrpc: '2.0',
        id: 'e2e-owner',
        method: 'tools/call',
        params: {
          name: 'recued_dataTimeline',
          arguments: { entity_id: 'mail:msg-1' },
        },
      },
      OWNER_BEARER,
    )) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

    expect(response.result?.isError).toBeFalsy();
    expect(loader).toHaveBeenCalledWith('mail', 'msg-1');
  });

  it('advertises an EMPTY tools/list catalog for a dead bound contract through the real transport', async () => {
    // The enumeration mirror end-to-end: a dead door connects fine but sees no
    // tools (the guard short-circuits before catalog assembly). Pairs with the
    // dispatch denial above — list + call both fail closed on liveness, and
    // neither relies on the retired `inboundTokenAuthorize = () => false` collapse.
    const { bundle } = makeHarness(
      MAIL_ONLY,
      { recued_dataTimeline: true },
      false, // contract NOT live
    );

    const response = (await bundle.mcpHttpDeps.dispatch(
      { jsonrpc: '2.0', id: 'e2e-list-dead', method: 'tools/list' },
      DOOR_BEARER,
    )) as { result?: { tools?: unknown[] }; error?: unknown };

    expect(response.error).toBeUndefined();
    expect(response.result?.tools).toEqual([]);
  });
});
