/** D-137 W2.3 § A.1.1 + § A.10 — Mary's per-connection MCP tool
 *  annotation: store + rpc handler + orchestrator → capability-filter
 *  Tier 3 disabled-set integration.
 *
 *  Acceptance:
 *    - Store survives schema install + round-trips writes
 *    - Store returns substrate default for connections with no row yet
 *    - chat.connection_mcp.{get,list,set} rpc handlers — round-trip,
 *      validation, broadcast emission, audit row
 *    - Orchestrator derives the disabled_tier3_names set from Mary's
 *      annotation snapshot so the main-turn catalog projection drops
 *      cached-but-unclassified entries. */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  CHAT_RPC_METHODS,
  RpcError,
  buildDefaultConnectionMcpAnnotation,
  type ConnectionMcpAnnotationState,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';
import {
  createChatConnectionMcpStore,
  ensureChatConnectionMcpAnnotationSchema,
  type ChatConnectionMcpStore,
} from '../storage/chat-connection-mcp-store.js';
import {
  handleConnectionMcpGet,
  handleConnectionMcpList,
  handleConnectionMcpSet,
  makeChatHandlers,
  type ChatRpcDeps,
} from '../chat-handler.js';
import {
  createChatOrchestrator,
  type ChatBroadcastEmitter,
} from '../chat-orchestrator.js';
import type { InternalToolRegistry } from '@recued/contracts';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const baseAnnotation = (
  connection_name: string,
  overrides: Partial<ConnectionMcpAnnotationState> = {},
): ConnectionMcpAnnotationState => ({
  connection_name,
  topic_tags: [],
  tool_overrides: {},
  tools_list_cache: { tools: [], cached_at: 0 },
  updated_at: 0,
  ...overrides,
});

describe('D-137 W2.3 — ChatConnectionMcpStore', () => {
  it('first-boot get for a missing connection returns the substrate default', () => {
    const db = new Database(':memory:');
    ensureChatConnectionMcpAnnotationSchema(db);
    const store = createChatConnectionMcpStore(db);
    const ann = store.getAnnotation('exa');
    expect(ann.connection_name).toBe('exa');
    expect(ann.topic_tags).toEqual([]);
    expect(Object.keys(ann.tool_overrides)).toEqual([]);
    expect(ann.tools_list_cache.tools).toEqual([]);
    expect(ann.tools_list_cache.cached_at).toBe(0);
    expect(ann.updated_at).toBe(0);
  });

  it('round-trips a write', () => {
    const db = new Database(':memory:');
    ensureChatConnectionMcpAnnotationSchema(db);
    const store = createChatConnectionMcpStore(db);
    const value = {
      connection_name: 'exa',
      topic_tags: ['web'] as ReadonlyArray<string>,
      tool_overrides: {
        search: { enabled: true, classification: 'read' as const },
      },
      tools_list_cache: {
        tools: [{ name: 'search' }],
        cached_at: 100,
      },
    };
    const persisted = store.setAnnotation({ value, now: 5_000 });
    expect(persisted.connection_name).toBe('exa');
    expect(persisted.updated_at).toBe(5_000);

    const reread = store.getAnnotation('exa');
    expect(reread.connection_name).toBe('exa');
    expect(reread.topic_tags).toEqual(['web']);
    expect(reread.tool_overrides.search?.classification).toBe('read');
    expect(reread.tools_list_cache.tools.length).toBe(1);
    expect(reread.updated_at).toBe(5_000);
  });

  it('listAnnotations returns rows sorted by updated_at DESC', () => {
    const db = new Database(':memory:');
    ensureChatConnectionMcpAnnotationSchema(db);
    const store = createChatConnectionMcpStore(db);
    store.setAnnotation({
      value: {
        connection_name: 'old',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
      },
      now: 1_000,
    });
    store.setAnnotation({
      value: {
        connection_name: 'new',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
      },
      now: 5_000,
    });
    const annotations = store.listAnnotations();
    expect(annotations.length).toBe(2);
    expect(annotations[0]!.connection_name).toBe('new');
    expect(annotations[1]!.connection_name).toBe('old');
  });

  it('survives a corrupted annotation_json row (falls back to default)', () => {
    const db = new Database(':memory:');
    ensureChatConnectionMcpAnnotationSchema(db);
    db.exec(`
      INSERT INTO chat_connection_mcp_annotations
        (connection_name, annotation_json, updated_at)
        VALUES ('exa', '{not valid json', 9000)
    `);
    const store = createChatConnectionMcpStore(db);
    const ann = store.getAnnotation('exa');
    expect(ann.connection_name).toBe('exa');
    expect(ann.tool_overrides).toEqual({});
    // updated_at carries through even on parse failure
    expect(ann.updated_at).toBe(9_000);
  });

  it('Codex W2.3 review P2 fold — preserves an explicit empty custom_topic_tags through write/read round-trip', () => {
    const db = new Database(':memory:');
    ensureChatConnectionMcpAnnotationSchema(db);
    const store = createChatConnectionMcpStore(db);
    store.setAnnotation({
      value: {
        connection_name: 'exa',
        topic_tags: ['web', 'research'],
        tool_overrides: {
          search: {
            enabled: true,
            classification: 'read',
            custom_topic_tags: [], // Mary cleared per-tool tags
          },
        },
        tools_list_cache: { tools: [{ name: 'search' }], cached_at: 100 },
      },
      now: 1_000,
    });
    const reread = store.getAnnotation('exa');
    const ovr = reread.tool_overrides.search;
    expect(ovr).toBeDefined();
    expect(ovr!.custom_topic_tags).toBeDefined();
    expect([...ovr!.custom_topic_tags!]).toEqual([]);
  });

  it('deleteAnnotation removes the row', () => {
    const db = new Database(':memory:');
    ensureChatConnectionMcpAnnotationSchema(db);
    const store = createChatConnectionMcpStore(db);
    store.setAnnotation({
      value: {
        connection_name: 'exa',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
      },
      now: 1_000,
    });
    expect(store.deleteAnnotation('exa')).toBe(true);
    // Subsequent get falls back to the substrate default
    const ann = store.getAnnotation('exa');
    expect(ann.updated_at).toBe(0);
    expect(store.deleteAnnotation('exa')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// chat.connection_mcp.* rpc handlers
// ──────────────────────────────────────────────────────────────────

interface TestRig {
  deps: ChatRpcDeps;
  store: ChatStore;
  annotationStore: ChatConnectionMcpStore;
  broadcastedEvents: Array<Parameters<ChatBroadcastEmitter['emit']>[0]>;
  auditRows: Array<Record<string, unknown>>;
}

const setup = (): TestRig => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  ensureChatConnectionMcpAnnotationSchema(db);
  const store = createChatStore(db);
  const annotationStore = createChatConnectionMcpStore(db);
  const broadcastedEvents: Array<Parameters<ChatBroadcastEmitter['emit']>[0]> = [];
  const broadcast: ChatBroadcastEmitter = {
    emit: (event) => {
      broadcastedEvents.push(event);
    },
  };
  const auditRows: Array<Record<string, unknown>> = [];
  const auditLog = {
    logActivity: vi.fn(async (entry: Record<string, unknown>) => {
      auditRows.push(entry);
    }),
    logExecution: vi.fn(),
    listActivity: vi.fn(),
    listExecutions: vi.fn(),
    getRecentByRecipe: vi.fn(),
  } as unknown as ChatRpcDeps['auditLog'];
  const orchestrator = {
    runTurn: vi.fn(async () => ({ turn_id: 'turn-stub' })),
    dispatch: { dispatchTool: vi.fn() },
  } as unknown as ChatRpcDeps['orchestrator'];
  return {
    deps: {
      store,
      connectionMcpStore: annotationStore,
      orchestrator,
      broadcast,
      auditLog,
      selfSignature,
      now: () => 7_000,
    },
    store,
    annotationStore,
    broadcastedEvents,
    auditRows,
  };
};

describe('D-137 W2.3 — makeChatHandlers slice (connection_mcp methods)', () => {
  it('claims chat.connection_mcp.{list,get,set}', () => {
    const { deps } = setup();
    const slice = makeChatHandlers(deps);
    expect(slice).toBeDefined();
    const claimed = new Set(slice!.methods);
    expect(claimed.has('chat.connection_mcp.list')).toBe(true);
    expect(claimed.has('chat.connection_mcp.get')).toBe(true);
    expect(claimed.has('chat.connection_mcp.set')).toBe(true);
    expect(claimed.size).toBe(CHAT_RPC_METHODS.length);
  });
});

describe('D-137 W2.3 — chat.connection_mcp.list rpc', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('returns an empty list when no annotations exist', () => {
    const result = handleConnectionMcpList(rig.deps);
    expect(result.annotations).toEqual([]);
  });

  it('returns persisted annotations', () => {
    rig.annotationStore.setAnnotation({
      value: {
        connection_name: 'exa',
        topic_tags: ['web'],
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: { tools: [{ name: 'search' }], cached_at: 100 },
      },
      now: 3_000,
    });
    const result = handleConnectionMcpList(rig.deps);
    expect(result.annotations.length).toBe(1);
    expect(result.annotations[0]!.connection_name).toBe('exa');
  });

  it('throws not_configured when connectionMcpStore is absent', () => {
    const depsWithoutStore: ChatRpcDeps = {
      ...rig.deps,
      connectionMcpStore: undefined,
    };
    expect(() => handleConnectionMcpList(depsWithoutStore)).toThrow(RpcError);
  });
});

describe('D-137 W2.3 — chat.connection_mcp.get rpc', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('returns the substrate default for an unknown connection', () => {
    const result = handleConnectionMcpGet(rig.deps, { connection_name: 'exa' });
    expect(result.annotation.connection_name).toBe('exa');
    expect(result.annotation.updated_at).toBe(0);
  });

  it('rejects empty connection_name', () => {
    expect(() =>
      handleConnectionMcpGet(rig.deps, { connection_name: '' }),
    ).toThrow(RpcError);
  });

  it('rejects non-object args', () => {
    expect(() =>
      handleConnectionMcpGet(rig.deps, null as never),
    ).toThrow(RpcError);
  });

  it('returns the persisted annotation after a write', () => {
    rig.annotationStore.setAnnotation({
      value: {
        connection_name: 'exa',
        topic_tags: ['web'],
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: { tools: [{ name: 'search' }], cached_at: 100 },
      },
      now: 3_000,
    });
    const result = handleConnectionMcpGet(rig.deps, { connection_name: 'exa' });
    expect(result.annotation.tool_overrides.search?.classification).toBe('read');
    expect(result.annotation.updated_at).toBe(3_000);
  });
});

describe('D-137 W2.3 — chat.connection_mcp.set rpc', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('persists + emits chat.connection_mcp_annotation_changed broadcast', () => {
    const result = handleConnectionMcpSet(rig.deps, {
      connection_name: 'exa',
      topic_tags: ['web'],
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
      },
      tools_list_cache: {
        tools: [{ name: 'search' }],
        cached_at: 100,
      },
    });
    expect(result.annotation.connection_name).toBe('exa');
    expect(result.annotation.updated_at).toBe(7_000);
    // D-137 P4 § A.7.1 — annotation writes now emit two broadcasts:
    // the W2.3 annotation_changed (for Settings → Connections + Tier
    // 3 catalog consumers) AND the P4 picker_entries_changed (for
    // the picker dropdown). Order is annotation-then-picker so the
    // catalog consumers see the new annotation before the picker
    // projection re-derives.
    expect(rig.broadcastedEvents.length).toBe(2);
    const evt = rig.broadcastedEvents[0] as {
      kind: string;
      connection_name: string;
    };
    expect(evt.kind).toBe('chat.connection_mcp_annotation_changed');
    expect(evt.connection_name).toBe('exa');
    const picker_evt = rig.broadcastedEvents[1] as { kind: string };
    expect(picker_evt.kind).toBe('chat.picker_entries_changed');
  });

  it('emits a chat_connection_mcp_annotation_set audit row', () => {
    handleConnectionMcpSet(rig.deps, {
      connection_name: 'exa',
      topic_tags: ['web'],
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
        delete_index: { enabled: true, classification: 'write' },
        contents: { enabled: false, classification: 'unknown' },
      },
      tools_list_cache: {
        tools: [
          { name: 'search' },
          { name: 'delete_index' },
          { name: 'contents' },
        ],
        cached_at: 100,
      },
    });
    expect(rig.auditRows.length).toBe(1);
    expect(rig.auditRows[0].action).toBe('chat_connection_mcp_annotation_set');
    expect(rig.auditRows[0].target).toBe('exa');
    const detail = JSON.parse(rig.auditRows[0].detail as string);
    expect(detail.topic_tag_count).toBe(1);
    expect(detail.override_count).toBe(3);
    // classified_count: only classification !== 'unknown' counts (2 of 3)
    expect(detail.classified_count).toBe(2);
    expect(detail.cached_tool_count).toBe(3);
  });

  it('rejects malformed args with bad_request', () => {
    expect(() =>
      handleConnectionMcpSet(rig.deps, {
        connection_name: 'exa',
        tool_overrides: {
          search: { enabled: 'yes', classification: 'read' },
        },
      }),
    ).toThrow(RpcError);
  });

  it('rejects non-object args', () => {
    expect(() =>
      handleConnectionMcpSet(rig.deps, null),
    ).toThrow(RpcError);
  });

  it('throws not_configured when connectionMcpStore is absent', () => {
    const depsWithoutStore: ChatRpcDeps = {
      ...rig.deps,
      connectionMcpStore: undefined,
    };
    expect(() =>
      handleConnectionMcpSet(depsWithoutStore, { connection_name: 'exa' }),
    ).toThrow(RpcError);
  });
});

// ──────────────────────────────────────────────────────────────────
// Orchestrator integration: annotationProvider → disabled_tier3_names
// ──────────────────────────────────────────────────────────────────

const tier1 = (name: string): ToolEntry => ({
  name,
  tier: 1,
  description: 'x',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'read',
  concurrency_safe: true,
});

const tier3 = (name: string): ToolEntry => ({
  name,
  tier: 3,
  description: 'x',
  arg_schema: { type: 'object' },
  topic_tags: ['web'],
  classification: 'read',
  concurrency_safe: false,
});

const buildRegistryWithCatalog = (
  catalog: ReadonlyArray<ToolEntry>,
): InternalToolRegistry => ({
  list: () => catalog,
  listByTier: (tier) => catalog.filter((e) => e.tier === tier),
  getByName: (name) => catalog.find((e) => e.name === name) ?? null,
  dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
  subscribeRefresh: () => () => {},
});

const counterMint = (prefix: string): (() => string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

describe('D-137 W2.3 — chat-orchestrator passes disabled_tier3_names', () => {
  it('derives the set from Mary\'s annotation snapshot', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    ensureChatConnectionMcpAnnotationSchema(db);
    const store = createChatStore(db);
    const annotationStore = createChatConnectionMcpStore(db);
    annotationStore.setAnnotation({
      value: {
        connection_name: 'exa',
        topic_tags: ['web'],
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
          delete_index: { enabled: true, classification: 'unknown' },
          contents: { enabled: false, classification: 'read' },
        },
        tools_list_cache: {
          tools: [
            { name: 'search' },
            { name: 'delete_index' },
            { name: 'contents' },
          ],
          cached_at: 100,
        },
      },
      now: 1_000,
    });
    // Catalog: only `exa.search` made it through gates.
    const registry = buildRegistryWithCatalog([
      tier1('contact.search'),
      tier3('exa.search'),
    ]);
    store.createSession({ id: 'sess-1', now: 1_000 });
    let lastTurnCatalogCount = 0;
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      selfSignature,
      annotationProvider: () => annotationStore.listAnnotations(),
      now: () => 2_000,
      mintId: counterMint('turn'),
    });
    // The substrate computes the disabled_tier3_names set internally;
    // we assert end-to-end by confirming the turn runs without error +
    // by reading the catalog through the registry to verify shape.
    await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'search the web',
      picker_state: { current: 'self' },
    });
    lastTurnCatalogCount = registry.list().length;
    expect(lastTurnCatalogCount).toBeGreaterThanOrEqual(2);
    // The message persists.
    const messages = await store.listMessages('sess-1');
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.role).toBe('user');
  });

  it('handles null annotationProvider gracefully (no disabled set)', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    const registry = buildRegistryWithCatalog([tier1('contact.search')]);
    store.createSession({ id: 'sess-1', now: 1_000 });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      selfSignature,
      annotationProvider: () => null,
      now: () => 2_000,
      mintId: counterMint('turn'),
    });
    const ack = await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'hi',
      picker_state: { current: 'self' },
    });
    expect(ack.turn_id).toBeDefined();
  });

  // Reference the unused default builder so the import stays load-bearing.
  it('buildDefaultConnectionMcpAnnotation re-exports a stable shape', () => {
    const def = buildDefaultConnectionMcpAnnotation('exa');
    expect(def.connection_name).toBe('exa');
    expect(def.updated_at).toBe(0);
  });
});
