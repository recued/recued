/** D-137 P4 § A.7 + § A.7.1 — Cross-server picker (MCP-scope-switch).
 *
 *  Substrate-level acceptance for the P4 slice:
 *    - `buildPickerEntries` projects Self + per-peer Recued entries
 *      (peer's recued_signature + ≥1 visible tool gates).
 *    - `compareRecuedVersions` returns the closed-list delta (`same`
 *      / `older` / `newer` / `unknown`).
 *    - `chat.picker.entries` rpc returns the live projection (always
 *      `'self'`; peer entries surface per the gates).
 *    - `chat.picker.refresh` rpc round-trips a probe result + emits
 *      both broadcasts + the audit row + preserves Mary's per-tool
 *      classifications.
 *    - `chat.session.set_picker` rpc rejects peer targets that don't
 *      correspond to a live picker entry (no annotation / no
 *      recued_signature / zero classified tools).
 *    - Orchestrator routes dispatch through the PeerDispatcher when
 *      picker is on a peer; tags message + provenance with the peer
 *      name; falls back to `connection_unavailable` when the
 *      dispatcher is unwired.
 *    - Connection-mcp annotation writes emit
 *      `chat.picker_entries_changed` alongside the existing
 *      `chat.connection_mcp_annotation_changed`. */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  CHAT_RPC_METHODS,
  RpcError,
  buildPickerEntries,
  compareRecuedVersions,
  isValidPickerTarget,
  type ChatDispatchResult,
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
  handlePickerEntries,
  handlePickerRefresh,
  handleSetPicker,
  handleSend,
  makeChatHandlers,
  type ChatRpcDeps,
} from '../chat-handler.js';
import {
  createChatOrchestrator,
  type ChatBroadcastEmitter,
  type PeerDispatcher,
} from '../chat-orchestrator.js';
import type { InternalToolRegistry } from '@recued/contracts';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-self',
};

const bobSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.1.0',
  instance_id: 'inst-bob',
};

const olderBobSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '0.9.0',
  instance_id: 'inst-bob-old',
};

const baseAnnotation = (
  connection_name: string,
  overrides: Partial<ConnectionMcpAnnotationState> = {},
): ConnectionMcpAnnotationState => ({
  connection_name,
  topic_tags: [],
  tool_overrides: {},
  tools_list_cache: { tools: [], cached_at: 0 },
  recued_signature: null,
  updated_at: 0,
  ...overrides,
});

// ════════════════════════════════════════════════════════════════
// Pure helper acceptance — `buildPickerEntries` /
// `compareRecuedVersions` / `isValidPickerTarget`.
// ════════════════════════════════════════════════════════════════

describe('D-137 P4 — compareRecuedVersions', () => {
  it('returns "same" when versions match', () => {
    expect(compareRecuedVersions('1.0.0', '1.0.0')).toBe('same');
  });
  it('returns "newer" when peer is higher', () => {
    expect(compareRecuedVersions('1.0.0', '1.1.0')).toBe('newer');
    expect(compareRecuedVersions('1.0.0', '2.0.0')).toBe('newer');
  });
  it('returns "older" when peer is lower', () => {
    expect(compareRecuedVersions('1.1.0', '1.0.0')).toBe('older');
    expect(compareRecuedVersions('2.0.0', '1.9.5')).toBe('older');
  });
  it('strips a semver suffix from the comparison', () => {
    expect(compareRecuedVersions('1.0.0-rc.1', '1.0.0')).toBe('same');
    expect(compareRecuedVersions('1.0.0', '1.0.0+meta')).toBe('same');
  });
  it('returns "unknown" for unparseable strings', () => {
    expect(compareRecuedVersions('latest', '1.0.0')).toBe('unknown');
    expect(compareRecuedVersions('1.0.0', '')).toBe('unknown');
    expect(compareRecuedVersions('', '1.0.0')).toBe('unknown');
    expect(compareRecuedVersions('1.x.0', '1.0.0')).toBe('unknown');
  });
  it('treats shorter strings as zero-padded', () => {
    expect(compareRecuedVersions('1.0', '1.0.0')).toBe('same');
    expect(compareRecuedVersions('1', '1.0.0')).toBe('same');
    expect(compareRecuedVersions('1.0.1', '1.0')).toBe('older');
  });
});

describe('D-137 P4 — buildPickerEntries', () => {
  it('always emits Self at index 0 with empty annotations', () => {
    const entries = buildPickerEntries([], selfSignature, 'Self');
    expect(entries.length).toBe(1);
    expect(entries[0]!.id).toBe('self');
    expect(entries[0]!.label).toBe('Self');
    expect(entries[0]!.kind).toBe('self');
  });

  it('skips peer with no recued_signature (generic MCP — stays in connections drawer)', () => {
    const entries = buildPickerEntries(
      [
        baseAnnotation('exa', {
          tools_list_cache: {
            tools: [{ name: 'search' }],
            cached_at: 100,
          },
          tool_overrides: {
            search: { enabled: true, classification: 'read' },
          },
        }),
      ],
      selfSignature,
      'Self',
    );
    expect(entries.length).toBe(1);
    expect(entries[0]!.id).toBe('self');
  });

  it('skips peer with recued_signature but zero classified tools', () => {
    const entries = buildPickerEntries(
      [
        baseAnnotation('bob', {
          recued_signature: bobSignature,
          tools_list_cache: {
            tools: [{ name: 'search' }],
            cached_at: 100,
          },
          // No classification — tool is invisible per the spec
          tool_overrides: {},
        }),
      ],
      selfSignature,
      'Self',
    );
    expect(entries.length).toBe(1);
  });

  it('emits peer entry with version_delta + tool count when signature + classified tools', () => {
    const entries = buildPickerEntries(
      [
        baseAnnotation('bob', {
          recued_signature: bobSignature,
          tools_list_cache: {
            tools: [
              { name: 'contact.search' },
              { name: 'deal.search' },
            ],
            cached_at: 100,
          },
          tool_overrides: {
            'contact.search': { enabled: true, classification: 'read' },
            'deal.search': { enabled: true, classification: 'read' },
          },
        }),
      ],
      selfSignature,
      'Self',
    );
    expect(entries.length).toBe(2);
    expect(entries[1]!.id).toBe('connection.mcp.bob');
    expect(entries[1]!.label).toBe('bob (data)');
    expect(entries[1]!.kind).toBe('peer_data');
    expect(entries[1]!.signature).toEqual(bobSignature);
    expect(entries[1]!.version_delta).toBe('newer');
    expect(entries[1]!.available_tool_count).toBe(2);
  });

  it('orders peer entries by connection_name ascending (stable list)', () => {
    const entries = buildPickerEntries(
      [
        baseAnnotation('zelda', {
          recued_signature: bobSignature,
          tools_list_cache: { tools: [{ name: 'search' }], cached_at: 100 },
          tool_overrides: { search: { enabled: true, classification: 'read' } },
        }),
        baseAnnotation('alice', {
          recued_signature: bobSignature,
          tools_list_cache: { tools: [{ name: 'search' }], cached_at: 100 },
          tool_overrides: { search: { enabled: true, classification: 'read' } },
        }),
      ],
      selfSignature,
      'Self',
    );
    expect(entries.map((e) => e.id)).toEqual([
      'self',
      'connection.mcp.alice',
      'connection.mcp.zelda',
    ]);
  });

  it('older peer surfaces version_delta="older"', () => {
    const entries = buildPickerEntries(
      [
        baseAnnotation('bob', {
          recued_signature: olderBobSignature,
          tools_list_cache: { tools: [{ name: 'search' }], cached_at: 100 },
          tool_overrides: { search: { enabled: true, classification: 'read' } },
        }),
      ],
      selfSignature,
      'Self',
    );
    expect(entries[1]!.version_delta).toBe('older');
  });
});

describe('D-137 P4 — isValidPickerTarget', () => {
  it('always accepts "self"', () => {
    expect(isValidPickerTarget('self', [], selfSignature)).toBe(true);
  });
  it('rejects peer target without a matching annotation', () => {
    expect(
      isValidPickerTarget('connection.mcp.bob', [], selfSignature),
    ).toBe(false);
  });
  it('rejects peer target whose annotation lacks recued_signature', () => {
    expect(
      isValidPickerTarget(
        'connection.mcp.exa',
        [baseAnnotation('exa', {
          tools_list_cache: { tools: [{ name: 'search' }], cached_at: 100 },
          tool_overrides: { search: { enabled: true, classification: 'read' } },
        })],
        selfSignature,
      ),
    ).toBe(false);
  });
  it('accepts live peer with signature + classified tools', () => {
    const annotations = [
      baseAnnotation('bob', {
        recued_signature: bobSignature,
        tools_list_cache: { tools: [{ name: 'search' }], cached_at: 100 },
        tool_overrides: { search: { enabled: true, classification: 'read' } },
      }),
    ];
    expect(
      isValidPickerTarget('connection.mcp.bob', annotations, selfSignature),
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// Rpc handler acceptance — chat.picker.entries + chat.picker.refresh +
// tighter chat.session.set_picker validation.
// ════════════════════════════════════════════════════════════════

interface TestRig {
  deps: ChatRpcDeps;
  annotationStore: ChatConnectionMcpStore;
  store: ChatStore;
  broadcastedEvents: unknown[];
  auditRows: Array<{ action: string; target: string; detail?: string }>;
}

const setup = (): TestRig => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  ensureChatConnectionMcpAnnotationSchema(db);
  const store = createChatStore(db);
  const annotationStore = createChatConnectionMcpStore(db);
  const broadcastedEvents: unknown[] = [];
  const broadcast: ChatBroadcastEmitter = {
    emit: (event) => broadcastedEvents.push(event),
  };
  const auditRows: Array<{ action: string; target: string; detail?: string }> = [];
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

describe('D-137 P4 — makeChatHandlers slice (picker methods)', () => {
  it('claims chat.picker.{entries,refresh}', () => {
    const rig = setup();
    const slice = makeChatHandlers(rig.deps);
    expect(slice).toBeDefined();
    const claimed = new Set(slice!.methods);
    expect(claimed.has('chat.picker.entries')).toBe(true);
    expect(claimed.has('chat.picker.refresh')).toBe(true);
    expect(claimed.size).toBe(CHAT_RPC_METHODS.length);
  });
});

describe('D-137 P4 — chat.picker.entries rpc', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('returns Self-only when no peers contracted', () => {
    const result = handlePickerEntries(rig.deps);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.id).toBe('self');
  });

  it('returns Self + peer entry after a live annotation lands', () => {
    rig.annotationStore.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {
          'contact.search': { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'contact.search' }],
          cached_at: 100,
        },
        recued_signature: bobSignature,
      },
      now: 5_000,
    });
    const result = handlePickerEntries(rig.deps);
    expect(result.entries.length).toBe(2);
    expect(result.entries[1]!.id).toBe('connection.mcp.bob');
    expect(result.entries[1]!.signature).toEqual(bobSignature);
  });

  it('falls back to Self-only when connectionMcpStore is absent', () => {
    const depsWithoutStore: ChatRpcDeps = {
      ...rig.deps,
      connectionMcpStore: undefined,
    };
    const result = handlePickerEntries(depsWithoutStore);
    expect(result.entries.length).toBe(1);
  });
});

describe('D-137 P4 — chat.picker.refresh rpc', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
  });

  it('rejects empty connection_name', () => {
    expect(() =>
      handlePickerRefresh(rig.deps, {
        connection_name: '',
        recued_signature: bobSignature,
        tools_list_cache: { tools: [], cached_at: 0 },
      }),
    ).toThrow(RpcError);
  });

  it('rejects missing recued_signature field', () => {
    expect(() =>
      handlePickerRefresh(rig.deps, {
        connection_name: 'bob',
        tools_list_cache: { tools: [], cached_at: 0 },
      }),
    ).toThrow(RpcError);
  });

  it('rejects missing tools_list_cache field', () => {
    expect(() =>
      handlePickerRefresh(rig.deps, {
        connection_name: 'bob',
        recued_signature: bobSignature,
      }),
    ).toThrow(RpcError);
  });

  it('rejects malformed recued_signature (server_kind not "recued")', () => {
    expect(() =>
      handlePickerRefresh(rig.deps, {
        connection_name: 'bob',
        recued_signature: { server_kind: 'generic', version: '1.0.0', instance_id: 'x' },
        tools_list_cache: { tools: [], cached_at: 0 },
      }),
    ).toThrow(RpcError);
  });

  it('round-trips a probe result + persists signature + cache', () => {
    const result = handlePickerRefresh(rig.deps, {
      connection_name: 'bob',
      recued_signature: bobSignature,
      tools_list_cache: {
        tools: [{ name: 'contact.search' }],
        cached_at: 5_500,
      },
    });
    expect(result.annotation.connection_name).toBe('bob');
    expect(result.annotation.recued_signature).toEqual(bobSignature);
    expect(result.annotation.tools_list_cache.tools.length).toBe(1);
    expect(result.annotation.tools_list_cache.cached_at).toBe(5_500);
    expect(result.entries.length).toBe(1);  // Self only — no classification yet
    expect(result.entries[0]!.id).toBe('self');
  });

  it('preserves existing classification + topic tags across refresh', () => {
    // Mary classifies a tool first
    rig.annotationStore.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: ['mail'],
        tool_overrides: {
          'contact.search': { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'contact.search' }],
          cached_at: 100,
        },
        recued_signature: bobSignature,
      },
      now: 1_000,
    });
    // Refresh with new probe data — should preserve overrides + tags
    const result = handlePickerRefresh(rig.deps, {
      connection_name: 'bob',
      recued_signature: bobSignature,
      tools_list_cache: {
        tools: [
          { name: 'contact.search' },
          { name: 'deal.search' },
        ],
        cached_at: 7_000,
      },
    });
    expect(result.annotation.topic_tags).toEqual(['mail']);
    expect(result.annotation.tool_overrides['contact.search']).toBeDefined();
    expect(result.annotation.tools_list_cache.tools.length).toBe(2);
    // The new tool stays invisible until classified — picker still
    // surfaces the peer (one classified tool).
    expect(result.entries.length).toBe(2);
    expect(result.entries[1]!.id).toBe('connection.mcp.bob');
    expect(result.entries[1]!.available_tool_count).toBe(1);
  });

  it('emits both broadcasts + audit row', () => {
    handlePickerRefresh(rig.deps, {
      connection_name: 'bob',
      recued_signature: bobSignature,
      tools_list_cache: { tools: [], cached_at: 0 },
    });
    expect(rig.broadcastedEvents.length).toBe(2);
    expect((rig.broadcastedEvents[0] as { kind: string }).kind).toBe(
      'chat.connection_mcp_annotation_changed',
    );
    expect((rig.broadcastedEvents[1] as { kind: string }).kind).toBe(
      'chat.picker_entries_changed',
    );
    const audit = rig.auditRows.find((r) => r.action === 'chat_picker_refreshed');
    expect(audit).toBeDefined();
    expect(audit!.target).toBe('bob');
  });

  it('clearing signature via null disables the peer in picker', () => {
    rig.annotationStore.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
        recued_signature: bobSignature,
      },
      now: 1_000,
    });
    // Peer initially visible
    const before = handlePickerEntries(rig.deps);
    expect(before.entries.length).toBe(2);
    // Refresh clears the signature
    const result = handlePickerRefresh(rig.deps, {
      connection_name: 'bob',
      recued_signature: null,
      tools_list_cache: { tools: [{ name: 'search' }], cached_at: 200 },
    });
    expect(result.annotation.recued_signature).toBeNull();
    expect(result.entries.length).toBe(1);
  });

  it('throws not_configured when connectionMcpStore is absent', () => {
    const depsWithoutStore: ChatRpcDeps = {
      ...rig.deps,
      connectionMcpStore: undefined,
    };
    expect(() =>
      handlePickerRefresh(depsWithoutStore, {
        connection_name: 'bob',
        recued_signature: bobSignature,
        tools_list_cache: { tools: [], cached_at: 0 },
      }),
    ).toThrow(RpcError);
  });
});

describe('D-137 P4 — chat.session.set_picker peer-target validation', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = setup();
    rig.store.createSession({ id: 'sess-1', now: 1_000 });
  });

  it('accepts "self" target', () => {
    expect(() =>
      handleSetPicker(rig.deps, {
        session_id: 'sess-1',
        picker_state: { current: 'self' },
      }),
    ).not.toThrow();
  });

  it('rejects peer target with no annotation row', () => {
    expect(() =>
      handleSetPicker(rig.deps, {
        session_id: 'sess-1',
        picker_state: { current: 'connection.mcp.bob' },
      }),
    ).toThrow(RpcError);
  });

  it('rejects peer target whose annotation lacks recued_signature', () => {
    rig.annotationStore.setAnnotation({
      value: {
        connection_name: 'exa',
        topic_tags: [],
        tool_overrides: { search: { enabled: true, classification: 'read' } },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
      },
      now: 1_000,
    });
    expect(() =>
      handleSetPicker(rig.deps, {
        session_id: 'sess-1',
        picker_state: { current: 'connection.mcp.exa' },
      }),
    ).toThrow(RpcError);
  });

  it('accepts peer target with full live picker entry', () => {
    rig.annotationStore.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {
          'contact.search': { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'contact.search' }],
          cached_at: 100,
        },
        recued_signature: bobSignature,
      },
      now: 1_000,
    });
    expect(() =>
      handleSetPicker(rig.deps, {
        session_id: 'sess-1',
        picker_state: { current: 'connection.mcp.bob' },
      }),
    ).not.toThrow();
  });

  it('chat.send applies the same peer-target gate', async () => {
    await expect(
      handleSend(rig.deps, {
        session_id: 'sess-1',
        message: 'hi',
        picker_state: { current: 'connection.mcp.ghost' },
      }),
    ).rejects.toThrow(RpcError);
  });
});

// ════════════════════════════════════════════════════════════════
// Orchestrator acceptance — peer-target dispatch routing.
// ════════════════════════════════════════════════════════════════

const buildRegistry = (): InternalToolRegistry => {
  const entries: ToolEntry[] = [
    {
      name: 'contact.search',
      tier: 1,
      description: 'local',
      arg_schema: { type: 'object' },
      topic_tags: [],
      classification: 'read',
      concurrency_safe: true,
    },
  ];
  return {
    list: () => entries,
    listByTier: (tier) => entries.filter((e) => e.tier === tier),
    getByName: (name) => entries.find((e) => e.name === name) ?? null,
    dispatch: async () =>
      ({ ok: true, result: { source: 'local' } } as ChatDispatchResult),
    subscribeRefresh: () => () => undefined,
  };
};

describe('D-137 P4 — orchestrator peer dispatch routing', () => {
  it('peer-target dispatch routes through PeerDispatcher + tags channel mcp_wire', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'sess-1', now: 1_000 });
    const broadcastedEvents: unknown[] = [];
    const broadcast: ChatBroadcastEmitter = {
      emit: (event) => broadcastedEvents.push(event),
    };
    const auditRows: Array<{ action: string; detail?: string }> = [];
    const auditLog = {
      logActivity: vi.fn(async (entry) => {
        auditRows.push({ action: entry.action, detail: entry.detail });
      }),
      listRecent: vi.fn(),
      listExecutionAttempts: vi.fn(),
      getRecentByRecipe: vi.fn(),
    } as never;
    const peerToolEntry: ToolEntry = {
      name: 'bob.contact.search',
      tier: 3,
      description: "Bob's contact search",
      arg_schema: { type: 'object' },
      topic_tags: [],
      classification: 'read',
      concurrency_safe: false,
    };
    const peerDispatcher: PeerDispatcher = {
      dispatch: vi.fn(async (args) =>
        ({
          ok: true,
          result: { source: args.peer_name, tool: args.tool_name },
        } as ChatDispatchResult),
      ),
      listToolEntries: vi.fn(() => [peerToolEntry]),
      getPeerSignature: vi.fn(() => bobSignature),
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: buildRegistry(),
      broadcast,
      auditLog,
      selfSignature,
      peerDispatcher,
      mintId: () => 'turn-X',
    });
    const result = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'bob.contact.search',
      arg_values: { q: 'Peter' },
      picker_target: 'connection.mcp.bob',
    });
    expect(result.ok).toBe(true);
    expect(peerDispatcher.dispatch).toHaveBeenCalledWith({
      peer_name: 'bob',
      tool_name: 'bob.contact.search',
      arg_values: { q: 'Peter' },
    });
    const audit = auditRows.find((r) => r.action === 'chat_tool_call');
    const detail = JSON.parse(audit!.detail as string);
    expect(detail.channel).toBe('mcp_wire');
    expect(detail.tier).toBe(3);
    expect(detail.peer_name).toBe('bob');
  });

  it('peer-target dispatch returns connection_unavailable when peerDispatcher is unwired', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'sess-1', now: 1_000 });
    const broadcastedEvents: unknown[] = [];
    const broadcast: ChatBroadcastEmitter = {
      emit: (event) => broadcastedEvents.push(event),
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: buildRegistry(),
      broadcast,
      selfSignature,
      mintId: () => 'turn-X',
    });
    const result = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'bob.contact.search',
      arg_values: {},
      picker_target: 'connection.mcp.bob',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('connection_unavailable');
    }
    const completed = broadcastedEvents.find(
      (e) => (e as { kind: string }).kind === 'chat.tool_call_completed',
    );
    expect(completed).toBeDefined();
  });

  it('peer write tool routes through plan-approval gate (Codex review P1 fold #1)', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'sess-1', now: 1_000 });
    const broadcastedEvents: unknown[] = [];
    const broadcast: ChatBroadcastEmitter = {
      emit: (event) => broadcastedEvents.push(event),
    };
    const peerToolEntry: ToolEntry = {
      name: 'bob.mail.send',
      tier: 3,
      description: "Bob's outbound mail",
      arg_schema: { type: 'object' },
      topic_tags: ['mail'],
      classification: 'write',
      concurrency_safe: false,
    };
    const peerDispatch = vi.fn(
      async () => ({
        ok: true,
        result: { ok: true },
        // This address belongs to Bob's execution host. Mary's local Logs
        // route must not claim it can open the remote audit row.
        run_id: 'bob-remote-run-1',
      } as ChatDispatchResult),
    );
    const peerDispatcher: PeerDispatcher = {
      dispatch: peerDispatch,
      listToolEntries: vi.fn(() => [peerToolEntry]),
      getPeerSignature: vi.fn(() => bobSignature),
    };
    const { planApproval } = await import('@recued/gateway');
    const planApprovalStore = planApproval.createPlanApprovalStore();
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: buildRegistry(),
      broadcast,
      selfSignature,
      peerDispatcher,
      planApprovalStore,
      mintId: () => 'plan-1',
    });
    const result = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'bob.mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'connection.mcp.bob',
    });
    // First call must surface awaiting_approval — gate intercepts
    // BEFORE the outbound dispatch fires.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('awaiting_approval');
    }
    expect(peerDispatch).not.toHaveBeenCalled();
    const proposed = broadcastedEvents.find(
      (e) => (e as { kind: string }).kind === 'chat.plan_proposed',
    );
    expect(proposed).toBeDefined();

    const approved = planApprovalStore.resolve('plan-1', 'approved', Date.now());
    expect(approved?.status).toBe('approved');
    const continued = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-Y',
      tool_name: 'bob.mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'connection.mcp.bob',
    });

    expect(continued.ok).toBe(true);
    expect(peerDispatch).toHaveBeenCalledTimes(1);
    expect(
      planApprovalStore.listForSession('sess-1').find(
        (record) => record.plan.plan_id === 'plan-1',
      )?.execution,
    ).toEqual({
      status: 'completed',
      turn_id: 'turn-Y',
      result_ref: 'sess-1:turn-Y:bob.mail.send',
    });
    expect(
      broadcastedEvents.filter(
        (event) =>
          (
            (event as { kind?: unknown }).kind === 'chat.tool_call_started'
            || (event as { kind?: unknown }).kind === 'chat.tool_call_completed'
          )
          && (event as { turn_id?: unknown }).turn_id === 'turn-Y',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'chat.tool_call_started',
        plan_id: 'plan-1',
      }),
      expect.objectContaining({
        kind: 'chat.tool_call_completed',
        status: 'ok',
        plan_id: 'plan-1',
      }),
    ]);
    const completion = broadcastedEvents.find(
      (event) =>
        (event as { kind?: unknown }).kind === 'chat.tool_call_completed'
        && (event as { turn_id?: unknown }).turn_id === 'turn-Y',
    );
    expect(completion).not.toHaveProperty('run_id');
  });

  it('peer-target dispatch with unwired dispatcher does NOT leak Self catalog (Codex review P1 fold #2)', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'sess-1', now: 1_000 });
    const broadcast: ChatBroadcastEmitter = { emit: vi.fn() };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: buildRegistry(),
      broadcast,
      selfSignature,
      mintId: () => 'turn-X',
    });
    // `contact.search` IS a local Tier 1 primitive. If the
    // orchestrator's peer routing degraded to a local lookup, this
    // dispatch would succeed via the InternalToolRegistry. The fold
    // requires peer-target dispatches to bypass the local registry
    // entirely + surface `connection_unavailable` instead.
    const result = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'contact.search',
      arg_values: {},
      picker_target: 'connection.mcp.bob',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('connection_unavailable');
    }
  });

  it('peer-routed dispatch broadcasts tier 3 (Codex review P2 fold)', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'sess-1', now: 1_000 });
    const broadcastedEvents: unknown[] = [];
    const broadcast: ChatBroadcastEmitter = {
      emit: (event) => broadcastedEvents.push(event),
    };
    const peerToolEntry: ToolEntry = {
      name: 'bob.contact.search',
      tier: 3,
      description: "Bob's contact search",
      arg_schema: { type: 'object' },
      topic_tags: [],
      classification: 'read',
      concurrency_safe: false,
    };
    const peerDispatcher: PeerDispatcher = {
      dispatch: vi.fn(async () =>
        ({ ok: true, result: { source: 'bob' } } as ChatDispatchResult),
      ),
      listToolEntries: vi.fn(() => [peerToolEntry]),
      getPeerSignature: vi.fn(() => bobSignature),
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: buildRegistry(),
      broadcast,
      selfSignature,
      peerDispatcher,
      mintId: () => 'turn-X',
    });
    await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'bob.contact.search',
      arg_values: {},
      picker_target: 'connection.mcp.bob',
    });
    const started = broadcastedEvents.find(
      (e) => (e as { kind: string }).kind === 'chat.tool_call_started',
    );
    expect((started as { tier: number }).tier).toBe(3);
  });

  it('self-target dispatch still routes to InternalToolRegistry (regression guard)', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'sess-1', now: 1_000 });
    const broadcastedEvents: unknown[] = [];
    const broadcast: ChatBroadcastEmitter = {
      emit: (event) => broadcastedEvents.push(event),
    };
    const auditRows: Array<{ action: string; detail?: string }> = [];
    const auditLog = {
      logActivity: vi.fn(async (entry) => {
        auditRows.push({ action: entry.action, detail: entry.detail });
      }),
      listRecent: vi.fn(),
      listExecutionAttempts: vi.fn(),
      getRecentByRecipe: vi.fn(),
    } as never;
    const peerDispatcher: PeerDispatcher = {
      dispatch: vi.fn(),
      listToolEntries: vi.fn(),
      getPeerSignature: vi.fn(),
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: buildRegistry(),
      broadcast,
      auditLog,
      selfSignature,
      peerDispatcher,
      mintId: () => 'turn-X',
    });
    const result = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'contact.search',
      arg_values: { q: 'Peter' },
      picker_target: 'self',
    });
    expect(result.ok).toBe(true);
    // Peer dispatcher must NOT be called on Self target.
    expect(peerDispatcher.dispatch).not.toHaveBeenCalled();
    const audit = auditRows.find((r) => r.action === 'chat_tool_call');
    const detail = JSON.parse(audit!.detail as string);
    expect(detail.channel).toBe('internal_function_call');
  });
});
