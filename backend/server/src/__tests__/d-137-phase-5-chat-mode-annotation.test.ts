/** D-137 P5 § A.7.1 + § A.10 — `chat_mode` annotation extension.
 *
 *  Substrate-level acceptance for:
 *    - `buildDefaultConnectionMcpAnnotation` defaults `chat_mode: null`.
 *    - Validator accepts `null` / `{ offered }` / `{ offered, session_cap }`
 *      and surfaces five closed-list issue codes for malformed inputs.
 *    - Validator preserves the `absent → preserve prior` merge posture
 *      parallel to `recued_signature` (omitting `chat_mode` ⇒
 *      `value.chat_mode === undefined` ⇒ store keeps prior persisted).
 *    - Store parse + merge: writing without `chat_mode` preserves the
 *      prior value; writing with `null` clears; writing with an object
 *      stamps the new value; corrupted JSON falls back to `null`.
 *
 *  Maps to the P5 spec text "Connection-record schema extension:
 *  chat_mode: { offered, session_cap } | null." The P4
 *  `'peer_chat'` PickerEntryKind stays present on the closed list but
 *  the emitter still ignores it (Direction C runtime post-D-145). */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildDefaultConnectionMcpAnnotation,
  validateConnectionMcpAnnotationInput,
  type ConnectionMcpAnnotationState,
  type RecuedServerSignature,
} from '@recued/contracts';
import {
  createChatConnectionMcpStore,
  ensureChatConnectionMcpAnnotationSchema,
} from '../storage/chat-connection-mcp-store.js';
import {
  createChatStore,
  ensureChatSchema,
} from '../storage/chat-store.js';
import {
  handlePickerRefresh,
  type ChatRpcDeps,
} from '../chat-handler.js';
import type { ChatBroadcastEmitter } from '../chat-orchestrator.js';

describe('D-137 P5 — buildDefaultConnectionMcpAnnotation', () => {
  it('returns chat_mode: null in the substrate default', () => {
    const ann = buildDefaultConnectionMcpAnnotation('exa');
    expect(ann.chat_mode).toBeNull();
  });
});

describe('D-137 P5 — validateConnectionMcpAnnotationInput chat_mode', () => {
  const baseInput = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    connection_name: 'bob',
    topic_tags: [],
    tool_overrides: {},
    tools_list_cache: { tools: [], cached_at: 0 },
    ...overrides,
  });

  it('omits chat_mode from the validated payload when caller did not include it', () => {
    const r = validateConnectionMcpAnnotationInput(baseInput());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.prototype.hasOwnProperty.call(r.value, 'chat_mode')).toBe(false);
    }
  });

  it('preserves explicit null in the validated payload', () => {
    const r = validateConnectionMcpAnnotationInput(baseInput({ chat_mode: null }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.prototype.hasOwnProperty.call(r.value, 'chat_mode')).toBe(true);
      expect(r.value.chat_mode).toBeNull();
    }
  });

  it('accepts { offered: true } without session_cap', () => {
    const r = validateConnectionMcpAnnotationInput(baseInput({
      chat_mode: { offered: true },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.chat_mode).toEqual({ offered: true });
    }
  });

  it('accepts { offered, session_cap } with both fields', () => {
    const r = validateConnectionMcpAnnotationInput(baseInput({
      chat_mode: {
        offered: true,
        session_cap: { per_day: 10, concurrent: 3 },
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.chat_mode).toEqual({
        offered: true,
        session_cap: { per_day: 10, concurrent: 3 },
      });
    }
  });

  it('rejects chat_mode as a non-object / non-null value', () => {
    const r = validateConnectionMcpAnnotationInput(baseInput({ chat_mode: 'on' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'chat_mode_shape_invalid')).toBe(true);
    }
  });

  it('rejects chat_mode without a boolean offered', () => {
    const r = validateConnectionMcpAnnotationInput(baseInput({
      chat_mode: { offered: 'yes' },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'chat_mode_offered_invalid')).toBe(true);
    }
  });

  it('rejects malformed session_cap shape', () => {
    const r = validateConnectionMcpAnnotationInput(baseInput({
      chat_mode: { offered: true, session_cap: 'cap-string' },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'chat_mode_session_cap_shape_invalid')).toBe(true);
    }
  });

  it('rejects non-integer / negative session_cap.per_day', () => {
    const r1 = validateConnectionMcpAnnotationInput(baseInput({
      chat_mode: { offered: true, session_cap: { per_day: 1.5, concurrent: 2 } },
    }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.some((i) => i.code === 'chat_mode_session_cap_per_day_invalid')).toBe(true);
    }
    const r2 = validateConnectionMcpAnnotationInput(baseInput({
      chat_mode: { offered: true, session_cap: { per_day: -1, concurrent: 2 } },
    }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.issues.some((i) => i.code === 'chat_mode_session_cap_per_day_invalid')).toBe(true);
    }
  });

  it('rejects non-integer / negative session_cap.concurrent', () => {
    const r1 = validateConnectionMcpAnnotationInput(baseInput({
      chat_mode: { offered: true, session_cap: { per_day: 5, concurrent: -3 } },
    }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.some((i) => i.code === 'chat_mode_session_cap_concurrent_invalid')).toBe(true);
    }
  });
});

describe('D-137 P5 — chat-connection-mcp-store chat_mode parse + merge', () => {
  const newDb = () => {
    const db = new Database(':memory:');
    ensureChatConnectionMcpAnnotationSchema(db);
    return db;
  };

  it('first-boot getAnnotation returns chat_mode: null on the substrate default', () => {
    const db = newDb();
    const store = createChatConnectionMcpStore(db);
    const ann = store.getAnnotation('bob');
    expect(ann.chat_mode).toBeNull();
  });

  it('setAnnotation without chat_mode preserves the prior persisted value (parallel to recued_signature merge)', () => {
    const db = newDb();
    const store = createChatConnectionMcpStore(db);
    // First write — set chat_mode to an object.
    store.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
        chat_mode: { offered: true, session_cap: { per_day: 5, concurrent: 2 } },
      },
      now: 1_000,
    });
    // Second write — chat_mode field absent. The store MUST preserve
    // the prior value (legacy callers from before P5 mustn't accidentally
    // clear chat-mode).
    const persisted = store.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: ['new-tag'],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
      },
      now: 2_000,
    });
    expect(persisted.topic_tags).toEqual(['new-tag']);
    expect(persisted.chat_mode).toEqual({
      offered: true,
      session_cap: { per_day: 5, concurrent: 2 },
    });
  });

  it('setAnnotation with chat_mode: null clears the prior value', () => {
    const db = newDb();
    const store = createChatConnectionMcpStore(db);
    store.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
        chat_mode: { offered: true },
      },
      now: 1_000,
    });
    const cleared = store.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
        chat_mode: null,
      },
      now: 2_000,
    });
    expect(cleared.chat_mode).toBeNull();
    const reread = store.getAnnotation('bob');
    expect(reread.chat_mode).toBeNull();
  });

  it('setAnnotation with chat_mode object replaces the prior value', () => {
    const db = newDb();
    const store = createChatConnectionMcpStore(db);
    store.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
        chat_mode: { offered: true, session_cap: { per_day: 10, concurrent: 3 } },
      },
      now: 1_000,
    });
    const updated = store.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
        chat_mode: { offered: false },
      },
      now: 2_000,
    });
    expect(updated.chat_mode).toEqual({ offered: false });
  });

  it('parses a persisted chat_mode JSON blob (round-trip via getAnnotation)', () => {
    const db = newDb();
    const store = createChatConnectionMcpStore(db);
    store.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
        chat_mode: { offered: true, session_cap: { per_day: 7, concurrent: 4 } },
      },
      now: 1_000,
    });
    const reread = store.getAnnotation('bob');
    expect(reread.chat_mode).toEqual({
      offered: true,
      session_cap: { per_day: 7, concurrent: 4 },
    });
  });

  it('falls back to chat_mode: null on a corrupted blob (defensive narrowing)', () => {
    const db = newDb();
    db.exec(`
      INSERT INTO chat_connection_mcp_annotations
        (connection_name, annotation_json, updated_at)
        VALUES ('bob', '{"chat_mode": "garbage"}', 9000)
    `);
    const store = createChatConnectionMcpStore(db);
    const ann: ConnectionMcpAnnotationState = store.getAnnotation('bob');
    expect(ann.chat_mode).toBeNull();
  });

  it('Codex review P2 fold — fail-closed on malformed nested session_cap (negative per_day)', () => {
    // Pre-fold the parser dropped the cap silently but kept
    // `offered: true`, converting "chat-mode offered with cost-
    // controls" into "chat-mode offered uncapped." Post-fold the
    // parser collapses the whole chat_mode to null when ANY part of
    // session_cap is malformed.
    const db = newDb();
    db.exec(`
      INSERT INTO chat_connection_mcp_annotations
        (connection_name, annotation_json, updated_at)
        VALUES ('bob', '{"chat_mode": {"offered": true, "session_cap": {"per_day": -1, "concurrent": 2}}}', 9000)
    `);
    const store = createChatConnectionMcpStore(db);
    expect(store.getAnnotation('bob').chat_mode).toBeNull();
  });

  it('Codex review P2 fold — fail-closed on non-integer session_cap.concurrent', () => {
    const db = newDb();
    db.exec(`
      INSERT INTO chat_connection_mcp_annotations
        (connection_name, annotation_json, updated_at)
        VALUES ('bob', '{"chat_mode": {"offered": true, "session_cap": {"per_day": 5, "concurrent": 2.5}}}', 9000)
    `);
    const store = createChatConnectionMcpStore(db);
    expect(store.getAnnotation('bob').chat_mode).toBeNull();
  });

  it('Codex review P2 fold — keeps { offered: true } when session_cap field is absent (uncapped intent)', () => {
    // Distinct from the malformed cap path: when there is NO
    // session_cap field at all, "offered uncapped" is the explicit
    // intent and must round-trip.
    const db = newDb();
    db.exec(`
      INSERT INTO chat_connection_mcp_annotations
        (connection_name, annotation_json, updated_at)
        VALUES ('bob', '{"chat_mode": {"offered": true}}', 9000)
    `);
    const store = createChatConnectionMcpStore(db);
    expect(store.getAnnotation('bob').chat_mode).toEqual({ offered: true });
  });
});

describe('D-137 P5 — Codex review P2 fold: chat.picker.refresh threads chat_mode', () => {
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

  const setup = () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    ensureChatConnectionMcpAnnotationSchema(db);
    const annotationStore = createChatConnectionMcpStore(db);
    const store = createChatStore(db);
    const broadcastedEvents: unknown[] = [];
    const broadcast: ChatBroadcastEmitter = {
      emit: (event) => broadcastedEvents.push(event),
    };
    const auditLog = {
      logActivity: vi.fn(async () => {}),
      listRecent: vi.fn(),
      listExecutionAttempts: vi.fn(),
      getRecentByRecipe: vi.fn(),
    } as unknown as ChatRpcDeps['auditLog'];
    const deps: ChatRpcDeps = {
      store,
      connectionMcpStore: annotationStore,
      orchestrator: {
        runTurn: vi.fn(async () => ({ turn_id: 'turn-stub' })),
        dispatch: { dispatchTool: vi.fn() },
      } as unknown as ChatRpcDeps['orchestrator'],
      broadcast,
      auditLog,
      selfSignature,
      now: () => 7_000,
    };
    return { deps, annotationStore, broadcastedEvents };
  };

  it('persists a supplied chat_mode probe result on refresh', () => {
    const { deps, annotationStore } = setup();
    const result = handlePickerRefresh(deps, {
      connection_name: 'bob',
      recued_signature: bobSignature,
      tools_list_cache: { tools: [], cached_at: 1_000 },
      chat_mode: {
        offered: true,
        session_cap: { per_day: 10, concurrent: 3 },
      },
    });
    expect(result.annotation.chat_mode).toEqual({
      offered: true,
      session_cap: { per_day: 10, concurrent: 3 },
    });
    expect(annotationStore.getAnnotation('bob').chat_mode).toEqual({
      offered: true,
      session_cap: { per_day: 10, concurrent: 3 },
    });
  });

  it('explicit chat_mode: null clears the prior persisted value', () => {
    const { deps, annotationStore } = setup();
    // Seed prior chat_mode via a direct setAnnotation.
    annotationStore.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
        chat_mode: { offered: true, session_cap: { per_day: 5, concurrent: 2 } },
      },
      now: 1_000,
    });
    // Refresh with chat_mode: null should clear.
    const result = handlePickerRefresh(deps, {
      connection_name: 'bob',
      recued_signature: bobSignature,
      tools_list_cache: { tools: [], cached_at: 2_000 },
      chat_mode: null,
    });
    expect(result.annotation.chat_mode).toBeNull();
  });

  it('absent chat_mode on refresh preserves the prior persisted value', () => {
    const { deps, annotationStore } = setup();
    // Seed prior chat_mode.
    annotationStore.setAnnotation({
      value: {
        connection_name: 'bob',
        topic_tags: [],
        tool_overrides: {},
        tools_list_cache: { tools: [], cached_at: 0 },
        chat_mode: { offered: true },
      },
      now: 1_000,
    });
    // Refresh WITHOUT chat_mode field — prior value survives.
    const result = handlePickerRefresh(deps, {
      connection_name: 'bob',
      recued_signature: bobSignature,
      tools_list_cache: { tools: [], cached_at: 2_000 },
    });
    expect(result.annotation.chat_mode).toEqual({ offered: true });
  });
});
