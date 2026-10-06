/** D-167 chat provider-threading — global chat-model default, per-session
 *  override / inherit lifecycle, and the PII egress provider-threading
 *  light-up via layer-derived provider.
 *
 *  Three layers under test:
 *    1. chat-store — the per-pair `chat_config` default + the
 *       `model_routing_overridden` resolution (effective = override ?
 *       stored : global, resolved at read time).
 *    2. chat-handler — get / set / clear rpc + validation + the
 *       `chat.default_model_pref_changed` broadcast.
 *    3. provider-threading — an INHERITED `byok` session resolves the
 *       routed provider from the slot-derived layer + reads LIVE config
 *       (the global-default inherit flow). D-191 retired force-local
 *       egress, so the opt-out→local-adapter cases were removed.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  IngredientManifest,
  WebChatTab,
} from '@recued/contracts';
import {
  createQuotaTracker,
  type AdapterKey,
  type AdapterRegistry,
  type LLMAdapter,
  type LLMCompletionOptions,
  type LLMConfig,
  type LLMMessage,
} from '@recued/llm';

import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';
import {
  handleClearModelPref,
  handleGetDefaultModelPref,
  handleSetDefaultModelPref,
  handleSetModelPref,
  type ChatRpcDeps,
} from '../chat-handler.js';
import type { ChatBroadcastEmitter } from '../chat-orchestrator.js';
import type { ChatOrchestrator } from '../chat-orchestrator.js';
import { composeChatOrchestrator } from '../composition/bin/wire-chat-orchestrator.js';
import type { ComposeChatOrchestratorDeps } from '../composition/bin/wire-chat-orchestrator.js';
import type { EventBus } from '../events/bus.js';
import type { KeyManager } from '../key-manager.js';

// D-174 R28 Slice A — a config the source_id resolver maps over: slot_1 is a
// REMOTE BYOK slot (anthropic), slot_2 is a LOCAL slot (local base_url), and a
// free pool entry. `getDefaultModelPref` resolves a stored source_id against
// THIS (live) config at read time.
const RESOLVER_CONFIG: LLMConfig = {
  slot_1: {
    provider: 'anthropic',
    model: 'claude',
    api_key: 'k',
    speed: 'fast',
    supports_json: true,
  },
  slot_2: {
    provider: 'openai-compatible',
    model: 'local-q',
    api_key: 'k',
    base_url: 'http://127.0.0.1:11434/v1',
    speed: 'quality',
    supports_json: true,
  },
  free_pool: [
    {
      id: 'fp1',
      type: 'api',
      provider: 'openai-compatible',
      model: 'llama',
      api_key: 'k',
      speed: 'fast',
      supports_json: true,
      enabled: true,
    },
  ],
};

// ────────────────────────────────────────────────────────────────
// 1. chat-store — global default source_id + live resolution + inherit
// ────────────────────────────────────────────────────────────────

describe('D-174 R28 Slice A — chat-store default source_id + live resolve', () => {
  let db: Database.Database;
  let store: ChatStore;
  // Mutable so a test can prove the resolver reads the LIVE config.
  let liveConfig: LLMConfig;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    liveConfig = RESOLVER_CONFIG;
    store = createChatStore(db, undefined, () => liveConfig);
  });
  afterEach(() => db.close());

  it('unset → raw source_id null; resolved pref is the comfort fallback (byok / 0)', () => {
    expect(store.getDefaultModelSourceId()).toEqual({ source_id: null, updated_at: 0 });
    expect(store.getDefaultModelPref()).toEqual({ layer: 'byok', updated_at: 0 });
  });

  it('setDefaultModelSourceId persists + round-trips the RAW source_id', () => {
    expect(store.setDefaultModelSourceId('slot_1', 100)).toEqual({
      source_id: 'slot_1',
      updated_at: 100,
    });
    expect(store.getDefaultModelSourceId()).toEqual({ source_id: 'slot_1', updated_at: 100 });
  });

  it('resolves a slot source_id to {layer, model_hint} by speed (always byok)', () => {
    store.setDefaultModelSourceId('slot_1', 1); // remote → byok, fast
    expect(store.getDefaultModelPref()).toEqual({
      layer: 'byok',
      model_hint: 'fast',
      source_id: 'slot_1', // D-191 Phase 6 — echoes the picked slot for the pin
      updated_at: 1,
    });
    store.setDefaultModelSourceId('slot_2', 2); // local base_url → byok (locality is display-only), quality
    expect(store.getDefaultModelPref()).toEqual({
      layer: 'byok',
      model_hint: 'quality',
      source_id: 'slot_2',
      updated_at: 2,
    });
  });

  it('resolves free_pool to {layer:free_pool} with NO model_hint', () => {
    store.setDefaultModelSourceId('free_pool', 3);
    expect(store.getDefaultModelPref()).toEqual({
      layer: 'free_pool',
      source_id: 'free_pool', // D-191 Phase 6 — echoed (free_pool carries no slot pin)
      updated_at: 3,
    });
  });

  it('resolution is LIVE — a config change is reflected without a re-set', () => {
    store.setDefaultModelSourceId('slot_1', 1);
    expect(store.getDefaultModelPref().model_hint).toBe('fast'); // slot_1 fast
    // Flip slot_1's speed; the resolver must read the NEW config at read time
    // (D-191: locality no longer changes the layer, so prove LIVE via the hint).
    liveConfig = {
      ...RESOLVER_CONFIG,
      slot_1: { ...RESOLVER_CONFIG.slot_1!, speed: 'quality' },
    };
    expect(store.getDefaultModelPref().model_hint).toBe('quality'); // re-resolved live
  });

  it('a new session with no explicit routing INHERITS the resolved default', () => {
    store.setDefaultModelSourceId('free_pool', 1);
    const created = store.createSession({ id: 's1', now: 1 });
    expect(created.model_routing).toEqual({
      current: 'free_pool',
      source_id: 'free_pool', // D-191 Phase 6 — inherits the global default's pick
      overridden: false,
    });
    expect(store.getSession('s1')!.model_routing).toEqual({
      current: 'free_pool',
      source_id: 'free_pool',
      overridden: false,
    });
  });

  it('changing the default source re-applies to inherited sessions but not overridden ones', () => {
    store.createSession({ id: 'inherit', now: 1 }); // inherits the comfort 'byok'
    store.createSession({ id: 'override', now: 1 });
    store.setModelPref('override', { current: 'byok' }); // explicit override
    store.setDefaultModelSourceId('free_pool', 2); // move the global default

    const inherited = store.getSession('inherit')!.model_routing;
    expect(inherited.current).toBe('free_pool'); // re-applied at read time
    expect(inherited.overridden).toBe(false);

    const overridden = store.getSession('override')!.model_routing;
    expect(overridden.current).toBe('byok'); // sticky — immune to the change
    expect(overridden.overridden).toBe(true);
  });

  it('setModelPref marks the session overridden + immune to default changes', () => {
    store.createSession({ id: 's', now: 1 });
    store.setModelPref('s', { current: 'byok' });
    expect(store.getSession('s')!.model_routing).toEqual({
      current: 'byok',
      overridden: true,
    });
    store.setDefaultModelSourceId('free_pool', 2);
    expect(store.getSession('s')!.model_routing.current).toBe('byok');
  });

  it('clearModelPref reverts to inherit + drops stale provider / model_id', () => {
    store.setDefaultModelSourceId('slot_2', 1); // slot_2 (local base_url → byok)
    store.createSession({
      id: 's',
      now: 1,
      model_routing: { current: 'byok', provider: 'anthropic', model_id: 'claude' },
    });
    expect(store.getSession('s')!.model_routing).toMatchObject({
      current: 'byok',
      provider: 'anthropic',
      overridden: true,
    });
    store.clearModelPref('s');
    const routing = store.getSession('s')!.model_routing;
    expect(routing.current).toBe('byok'); // inherits the resolved default (slot_2 → byok)
    expect(routing.overridden).toBe(false);
    expect(routing.provider).toBeUndefined();
    expect(routing.model_id).toBeUndefined();
  });

  it('a corrupt stored source_id reads as null → resolved pref falls back to byok', () => {
    // Write an off-list value directly to simulate corruption.
    db.prepare(
      'INSERT OR REPLACE INTO chat_config (key, value) VALUES (?, ?)',
    ).run('default_model_routing_source_id', 'garbage');
    expect(store.getDefaultModelSourceId().source_id).toBeNull();
    expect(store.getDefaultModelPref().layer).toBe('byok');
    expect(store.createSession({ id: 's', now: 1 }).model_routing.current).toBe('byok');
  });

  it('a stale source_id (chosen slot removed) degrades to the comfort layer', () => {
    store.setDefaultModelSourceId('slot_2', 1);
    expect(store.getDefaultModelPref().layer).toBe('byok'); // slot_2 present → byok
    liveConfig = { slot_1: RESOLVER_CONFIG.slot_1! }; // remove slot_2
    // The raw source_id is unchanged (still 'slot_2'), but it no longer resolves
    // to a configured slot → bare comfort fallback, no hint.
    expect(store.getDefaultModelSourceId().source_id).toBe('slot_2');
    expect(store.getDefaultModelPref()).toEqual({ layer: 'byok', updated_at: 1 });
  });
});

// ────────────────────────────────────────────────────────────────
// 2. chat-handler — get / set / clear rpc + validation + broadcast
// ────────────────────────────────────────────────────────────────

describe('D-174 R28 Slice A — chat.default_model_pref rpc + clear', () => {
  let db: Database.Database;
  let store: ChatStore;
  let events: Array<Parameters<ChatBroadcastEmitter['emit']>[0]>;
  let deps: ChatRpcDeps;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    store = createChatStore(db, undefined, () => RESOLVER_CONFIG);
    events = [];
    deps = {
      store,
      orchestrator: { runTurn: vi.fn() } as unknown as ChatOrchestrator,
      broadcast: {
        emit: (event: Parameters<ChatBroadcastEmitter['emit']>[0]) =>
          void events.push(event),
      },
      auditLog: undefined,
      selfSignature: {
        server_kind: 'recued' as const,
        version: '1.0.0',
        instance_id: 'instance-test',
      },
    } as unknown as ChatRpcDeps;
  });
  afterEach(() => db.close());

  it('get returns the persisted RAW source_id', () => {
    store.setDefaultModelSourceId('slot_1', 42);
    expect(handleGetDefaultModelPref(deps)).toEqual({ source_id: 'slot_1', updated_at: 42 });
  });

  it('get returns null source_id when no default is chosen', () => {
    expect(handleGetDefaultModelPref(deps)).toEqual({ source_id: null, updated_at: 0 });
  });

  it('set persists source_id + emits source_id + a resolved {layer,model_hint} snapshot', () => {
    const out = handleSetDefaultModelPref(deps, { source_id: 'slot_2' });
    expect(out).toMatchObject({ source_id: 'slot_2' });
    expect(store.getDefaultModelSourceId().source_id).toBe('slot_2');
    const fired = events.find((e) => e.kind === 'chat.default_model_pref_changed');
    // slot_2 is a local base_url → byok + quality → the broadcast carries the
    // resolved snapshot (D-191: locality is display-only, the layer is byok).
    expect(fired).toMatchObject({
      kind: 'chat.default_model_pref_changed',
      source_id: 'slot_2',
      layer: 'byok',
      model_hint: 'quality',
    });
  });

  it('set rejects an off-list source_id', () => {
    expect(() => handleSetDefaultModelPref(deps, { source_id: 'turbo' })).toThrow(
      /slot_1 \| slot_2 \| free_pool/,
    );
    // No partial write / broadcast on rejection.
    expect(store.getDefaultModelSourceId().source_id).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('clear reverts the session to inherit + broadcasts model_pref overridden:false', () => {
    store.createSession({ id: 's', now: 1 });
    store.setModelPref('s', { current: 'byok' });
    handleClearModelPref(deps, { session_id: 's' });
    expect(store.getSession('s')!.model_routing.overridden).toBe(false);
    const fired = events.find(
      (e) => e.kind === 'chat.session_changed' && e.field === 'model_pref',
    ) as { value?: { current: string; overridden: boolean } } | undefined;
    expect(fired?.value).toMatchObject({ overridden: false });
  });

  it('set_model_pref broadcasts model_pref overridden:true', () => {
    store.createSession({ id: 's', now: 1 });
    handleSetModelPref(deps, { session_id: 's', model_pref: { current: 'byok' } });
    const fired = events.find(
      (e) => e.kind === 'chat.session_changed' && e.field === 'model_pref',
    ) as { value?: { current: string; overridden: boolean } } | undefined;
    expect(fired?.value).toMatchObject({ current: 'byok', overridden: true });
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Provider-threading — an INHERITED byok session resolves the routed
//    provider from the slot-derived layer + reads LIVE config. (D-191
//    retired force-local egress; the opt-out→local cases were removed.)
// ────────────────────────────────────────────────────────────────

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

// slot_1 = remote BYOK (openai), slot_2 = local. A byok turn derives its
// egress provider from slot_1 (openai); a provider-scoped opt-out for openai
// must force local-only routing → only slot_2 (local) is reachable.
const cloudAndLocalConfig: LLMConfig = {
  slot_1: {
    provider: 'openai',
    model: 'remote-byok-fast',
    api_key: 'sk-cloud',
    speed: 'fast',
    supports_json: true,
  },
  slot_2: {
    provider: 'openai-compatible',
    model: 'local-fast',
    api_key: 'sk-local',
    base_url: 'http://127.0.0.1:11434/v1',
    speed: 'fast',
    supports_json: true,
  },
};

interface Harness {
  registry: AdapterRegistry;
  cloudCalls: Array<{ messages: readonly LLMMessage[]; options: LLMCompletionOptions }>;
  localCalls: Array<{ messages: readonly LLMMessage[]; options: LLMCompletionOptions }>;
}

const adapterHarness = (localText: string): Harness => {
  const cloudCalls: Harness['cloudCalls'] = [];
  const localCalls: Harness['localCalls'] = [];
  // The cloud adapter is a tripwire — any call is a PII leak under an active
  // opt-out, so it throws to turn the test red.
  const cloud: LLMAdapter = {
    provider: 'openai',
    complete: vi.fn(async (_slot, messages, options) => {
      cloudCalls.push({ messages, options });
      throw new Error('D-167 light-up: cloud egress leak under a PII opt-out');
    }),
  };
  const local: LLMAdapter = {
    provider: 'openai-compatible',
    complete: vi.fn(async (_slot, messages, options) => {
      localCalls.push({ messages, options });
      return { text: localText, usage: ZERO_USAGE };
    }),
  };
  const registry: AdapterRegistry = (key: AdapterKey): LLMAdapter =>
    key === 'openai-compatible' ? local : cloud;
  return { registry, cloudCalls, localCalls };
};

const eventBus = (): EventBus =>
  ({
    cursor: vi.fn(() => 0),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn((event: unknown) => ({ ...(event as Record<string, unknown>), cursor: 1 })),
    replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  }) as unknown as EventBus;

const inertLateGetters = () => ({
  getContactStore: vi.fn(() => undefined),
  getCollectionRegistry: vi.fn(() => undefined),
  getEnrichmentStore: vi.fn(() => undefined),
  getConnectionStore: vi.fn(() => undefined),
  getExecutorConfig: vi.fn(() => undefined),
  getExecuteDeps: vi.fn(() => undefined),
  getScheduleDeps: vi.fn(() => undefined),
});

const freePoolAndLocalConfig: LLMConfig = {
  free_pool: [
    {
      id: 'remote-free',
      type: 'api',
      provider: 'openai',
      model: 'remote-free-fast',
      api_key: 'sk-cloud',
      speed: 'fast',
      supports_json: true,
      enabled: true,
    },
  ],
  slot_2: cloudAndLocalConfig.slot_2,
};

const composeDeps = (
  db: Database.Database,
  registry: AdapterRegistry,
  llmConfig: LLMConfig = cloudAndLocalConfig,
): ComposeChatOrchestratorDeps =>
  ({
    db,
    keys: undefined as KeyManager | undefined,
    eventBus: eventBus(),
    auditLog: undefined,
    serverInstanceId: 'server-test',
    recipeStore: {
      ids: vi.fn(() => []),
      get: vi.fn(() => null),
      getStored: vi.fn(() => null),
      listStored: vi.fn(() => []),
    } as never,
    llmConfig,
    getLlmConfig: () => llmConfig,
    llmQuota: createQuotaTracker(),
    llmAdapterRegistry: registry,
    emptyTabProbe: async (): Promise<Set<WebChatTab>> => new Set(),
    pairedInstances: undefined,
    ...inertLateGetters(),
  }) as ComposeChatOrchestratorDeps;

const classifyOk: AIOutput = { response: 'local ok', events: [], tool_calls: [] };

describe('D-167 — provider-threading lights up for an INHERITED byok chat', () => {
  const openDbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of openDbs.splice(0).reverse()) db.close();
  });
  const makeDb = (): Database.Database => {
    const db = new Database(':memory:');
    openDbs.push(db);
    return db;
  };

  it('D-174 R28 — the chat call reads LIVE config (getLlmConfig), not the boot snapshot', async () => {
    const db = makeDb();
    const harness = adapterHarness(JSON.stringify(classifyOk));
    // Boot snapshot is UNDEFINED (as if no LLM was configured at boot); the LIVE
    // resolver (the existing composeDeps getLlmConfig, = cloudAndLocalConfig)
    // supplies the real config. A boot-snapshot read would throw
    // AI_LLM_UNAVAILABLE and make zero adapter calls — so a recorded call proves
    // the chat turn routes against live config (a slot saved after boot applies
    // without a restart).
    const deps: ComposeChatOrchestratorDeps = {
      ...composeDeps(db, harness.registry),
      llmConfig: undefined,
    };
    const bundle = composeChatOrchestrator(deps);
    bundle.chatStore.setDefaultModelSourceId('slot_2', 1); // local-badged default
    bundle.chatStore.createSession({ id: 'sess', now: 1 });

    await bundle.orchestrator.runTurn({
      session_id: 'sess',
      message: 'hello',
      picker_state: { current: 'self' },
    });

    expect(harness.localCalls.length + harness.cloudCalls.length).toBeGreaterThanOrEqual(1);
  });
});
