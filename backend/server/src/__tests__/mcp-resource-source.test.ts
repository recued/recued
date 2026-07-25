/** mcp-resource poll source (2nd WatchPollSource) — unit + integration.
 *
 *  Covers `deriveDemands` (mcp-pattern parse, enrolled-connection fan +
 *  fail-quiet on non-enrolled, coalescing, interval min-over-prefs),
 *  `poll` (entity decode → readResource → single-record wrap), the
 *  manager-core integration that proves the dedicated `connection.mcp`
 *  event path emits via `event_scope` (NOT the connection-api scope —
 *  which would throw on the base64url entity), and a `composeWatchManager`
 *  wiring test driving the real `connection.mcp` adapter's
 *  `resources/read` over a stub fetch. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventTrigger } from '@recued/contracts';
import {
  MCP_RESOURCE_POLL_SOURCE_ID,
  MCP_RESOURCE_WATCH_VENDOR,
  encodeMcpResourceUri,
  watchKeyOf,
} from '@recued/contracts';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';
import { eventPath, matchesPattern } from '@recued/warehouse-events';

import { composeWatchManager } from '../composition/bin/wire-watch-manager.js';
import {
  createMcpResourcePollSource,
  type McpResourceReadOutcome,
} from '../watch/mcp-resource-source.js';
import { createWatchPollManager, type PollManagerHandle } from '../watch/poll-manager.js';
import { createWatchStore } from '../watch/snapshot-store.js';

const URI = 'file:///notes/todo.md';
const ENC = encodeMcpResourceUri(URI);
const CONN = 'my-server';
const KEY = watchKeyOf(MCP_RESOURCE_WATCH_VENDOR, ENC, CONN);

const trigger = (overrides: Partial<EventTrigger> = {}): EventTrigger => ({
  trigger_id: 't-1',
  recipe_id: 'watch-todo',
  publisher_id: 'local',
  pattern: `data.connection.mcp.${CONN}.resource.${ENC}.updated`,
  enabled: true,
  created_at: 1_000,
  last_fired_at: null,
  last_error: null,
  origin: 'recipe',
  ...overrides,
});

const OPTS = { floorMs: 5 * 60_000, defaultMs: 15 * 60_000 };

describe('createMcpResourcePollSource — deriveDemands', () => {
  it('parses an mcp pattern, fans across the enrolled connection, sets event_scope', () => {
    const source = createMcpResourcePollSource({
      listMcpConnections: () => [CONN, 'other'],
      readResource: async () => ({ ok: true, result: {} }),
    });
    const demands = source.deriveDemands([trigger()], OPTS);
    expect(demands).toHaveLength(1);
    expect(demands[0]).toMatchObject({
      watch_key: KEY,
      vendor: MCP_RESOURCE_WATCH_VENDOR,
      entity: ENC,
      connection_name: CONN,
      recipe_ids: ['watch-todo'],
      interval_ms: OPTS.defaultMs,
      deferred_to: null,
      event_scope: {
        platform: 'connection.mcp',
        slug: CONN,
        entity_type: `resource.${ENC}`,
      },
    });
  });

  it('creates NO demand when the named connection is not an enrolled mcp connection', () => {
    const source = createMcpResourcePollSource({
      listMcpConnections: () => ['someone-else'],
      readResource: async () => ({ ok: true, result: {} }),
    });
    expect(source.deriveDemands([trigger()], OPTS)).toEqual([]);
  });

  it('ignores non-mcp patterns', () => {
    const source = createMcpResourcePollSource({
      listMcpConnections: () => [CONN],
      readResource: async () => ({ ok: true, result: {} }),
    });
    const demands = source.deriveDemands(
      [
        trigger({ trigger_id: 't-mail', pattern: 'data.mail.**.created' }),
        trigger({ trigger_id: 't-api', pattern: 'data.connection.api.hubspot.deal.**' }),
      ],
      OPTS,
    );
    expect(demands).toEqual([]);
  });

  it('coalesces two triggers on the same (connection, resource): merged subscribers, tighter interval', () => {
    const source = createMcpResourcePollSource({
      listMcpConnections: () => [CONN],
      readResource: async () => ({ ok: true, result: {} }),
    });
    const demands = source.deriveDemands(
      [
        trigger({ trigger_id: 't-a', recipe_id: 'recipe-b', watch_interval_ms: 30 * 60_000 }),
        trigger({ trigger_id: 't-b', recipe_id: 'recipe-a', watch_interval_ms: 7 * 60_000 }),
      ],
      OPTS,
    );
    expect(demands).toHaveLength(1);
    expect(demands[0]!.recipe_ids).toEqual(['recipe-a', 'recipe-b']);
    expect(demands[0]!.interval_ms).toBe(7 * 60_000); // min, above the floor
  });

  it('floors the interval below the minimum', () => {
    const source = createMcpResourcePollSource({
      listMcpConnections: () => [CONN],
      readResource: async () => ({ ok: true, result: {} }),
    });
    const demands = source.deriveDemands([trigger({ watch_interval_ms: 60_000 })], OPTS);
    expect(demands[0]!.interval_ms).toBe(OPTS.floorMs);
  });
});

describe('createMcpResourcePollSource — poll', () => {
  it('decodes the entity back to the uri, reads, and wraps one record keyed by the raw uri', async () => {
    const reads: Array<{ connection_name: string; uri: string }> = [];
    const source = createMcpResourcePollSource({
      listMcpConnections: () => [CONN],
      readResource: async (input) => {
        reads.push(input);
        return { ok: true, result: { contents: [{ uri: URI, text: 'hello' }] } };
      },
    });
    const outcome = await source.poll({ vendor: MCP_RESOURCE_WATCH_VENDOR, entity: ENC, connection_name: CONN });
    expect(reads).toEqual([{ connection_name: CONN, uri: URI }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.truncated).toBe(false);
    expect([...outcome.records.keys()]).toEqual([URI]);
    expect(outcome.records.get(URI)).toEqual({ contents: [{ uri: URI, text: 'hello' }] });
  });

  it('passes a read error straight through to the manager error path', async () => {
    const source = createMcpResourcePollSource({
      listMcpConnections: () => [CONN],
      readResource: async (): Promise<McpResourceReadOutcome> => ({
        ok: false,
        kind: 'error',
        reason: 'boom',
      }),
    });
    const outcome = await source.poll({ vendor: MCP_RESOURCE_WATCH_VENDOR, entity: ENC, connection_name: CONN });
    expect(outcome).toEqual({ ok: false, kind: 'error', reason: 'boom' });
  });

  it('wraps a non-object resource result in { value }', async () => {
    const source = createMcpResourcePollSource({
      listMcpConnections: () => [CONN],
      readResource: async () => ({ ok: true, result: 'raw-string' }),
    });
    const outcome = await source.poll({ vendor: MCP_RESOURCE_WATCH_VENDOR, entity: ENC, connection_name: CONN });
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.records.get(URI)).toEqual({ value: 'raw-string' });
  });
});

// ────────────────────────────────────────────────────────────────
// Deterministic timer fake (mirrors watch-poll-manager.test.ts).
// ────────────────────────────────────────────────────────────────
const makeTimers = () => {
  const entries: Array<{ handler: () => void; token: number; cleared: boolean }> = [];
  let next = 1;
  return {
    setTimer: (handler: () => void): unknown => {
      const e = { handler, token: next++, cleared: false };
      entries.push(e);
      return e.token;
    },
    clearTimer: (token: unknown): void => {
      const e = entries.find((x) => x.token === token);
      if (e) e.cleared = true;
    },
    fireLatest: async (): Promise<void> => {
      const live = entries.filter((e) => !e.cleared);
      const e = live[live.length - 1];
      if (!e) throw new Error('no pending timer');
      e.cleared = true;
      e.handler();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
};

describe('mcp-resource source × poll-manager core — connection.mcp emit path', () => {
  it('baselines silently, then emits `updated` on the connection.mcp path the subscriber pattern matches', async () => {
    const db = new Database(':memory:');
    const store = createWatchStore(db);
    const emitted: WarehouseEvent[] = [];
    const bus: WarehouseEventBus = {
      emit: (e) => emitted.push(e),
      subscribe: () => () => {},
      dispose: () => {},
    };
    const timers = makeTimers();
    const reads: McpResourceReadOutcome[] = [];
    const source = createMcpResourcePollSource({
      listMcpConnections: () => [CONN],
      readResource: async () => {
        const next = reads.shift();
        if (!next) throw new Error('test: no scripted read');
        return next;
      },
    });
    const manager: PollManagerHandle = createWatchPollManager({
      store,
      triggersStore: { listEnabled: () => [trigger()] },
      sources: [source],
      bus,
      now: () => 100_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      initialPollDelayMs: 5,
    });

    manager.recompute();
    const entry = manager.listEntries().find((e) => e.watch_key === KEY)!;
    expect(entry.source_id).toBe(MCP_RESOURCE_POLL_SOURCE_ID);
    expect(entry.active).toBe(true);

    // Poll 1 — baseline persists WITHOUT firing.
    reads.push({ ok: true, result: { contents: [{ uri: URI, text: 'v1' }] } });
    await timers.fireLatest();
    expect(emitted).toEqual([]);
    expect(store.snapshotCount(KEY)).toBe(1);

    // Poll 2 — content changes → one `updated` event.
    reads.push({ ok: true, result: { contents: [{ uri: URI, text: 'v2' }] } });
    await timers.fireLatest();
    expect(emitted).toHaveLength(1);
    const ev = emitted[0]!;
    expect(ev.platform).toBe('connection.mcp');
    expect(ev.slug).toBe(CONN);
    expect(ev.entity_type).toBe(`resource.${ENC}`);
    expect(ev.event_kind).toBe('updated');
    expect(ev.record_id).toBe(URI);
    expect(ev.record).toEqual({ contents: [{ uri: URI, text: 'v2' }] });
    expect(ev.prev).toEqual({ contents: [{ uri: URI, text: 'v1' }] });

    // The emitted path matches the subscriber's authored pattern.
    const path = eventPath(ev.platform, ev.slug, ev.entity_type, ev.event_kind);
    expect(matchesPattern(`data.connection.mcp.${CONN}.resource.${ENC}.**`, path)).toBe(true);

    await manager.stop();
    db.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Wiring — composeWatchManager registers the mcp-resource source and
// drives the REAL connection.mcp adapter (resources/read) over a stub
// fetch.
// ────────────────────────────────────────────────────────────────
interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

describe('composeWatchManager — mcp-resource wiring', () => {
  let openDb: Database.Database | undefined;
  let stopFn: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stopFn) await stopFn();
    stopFn = undefined;
    openDb?.close();
    openDb = undefined;
  });

  it('arms an mcp-resource watch and dispatches resources/read with the decoded uri', async () => {
    const db = new Database(':memory:');
    openDb = db;
    const emitted: WarehouseEvent[] = [];
    const warehouseBus: WarehouseEventBus = {
      emit: (e) => emitted.push(e),
      subscribe: () => () => {},
      dispose: () => {},
    };

    const mcpRow = {
      pk: `mcp:${CONN}`,
      kind: 'mcp' as const,
      name: CONN,
      display_name: 'My MCP server',
      subtype: 'sse',
      config_json: '{"transport":"sse","endpoint":"https://mcp.example/server"}',
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    };

    const calls: FetchCall[] = [];
    let resourceText = 'v1';
    const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body == null ? undefined : String(init.body);
      calls.push({
        url: typeof input === 'string' ? input : input.toString(),
        method: (init?.method ?? 'GET').toUpperCase(),
        body,
      });
      const id = body ? (JSON.parse(body) as { id: number }).id : 1;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, result: { contents: [{ uri: URI, text: resourceText }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const connectionStore = {
      list: (q?: { kind?: string }) => (q?.kind === 'mcp' ? [mcpRow] : []),
      get: (kind: string, name: string) => (kind === 'mcp' && name === CONN ? mcpRow : null),
    };

    const executeDeps = {
      executorConfig: {
        manifests: { get: () => undefined },
        connectionMcp: { decodeAuth: async () => ({ type: 'none' as const }), fetchImpl: stubFetch },
      },
      connectionStore,
    } as unknown as Parameters<typeof composeWatchManager>[0]['executeDeps'];

    const bundle = composeWatchManager({
      db,
      warehouseBus,
      executeDeps,
      triggersStore: { listEnabled: () => [trigger()] } as never,
      eventBus: undefined,
      localManifestStore: undefined,
    });
    expect(bundle).toBeDefined();
    const manager = bundle!.manager;
    stopFn = () => manager.stop();

    manager.recompute();
    const entry = manager.listEntries().find((e) => e.watch_key === KEY);
    expect(entry).toBeDefined();
    expect(entry!.source_id).toBe(MCP_RESOURCE_POLL_SOURCE_ID);
    expect(entry!.connection_name).toBe(CONN);

    // Baseline poll via the real adapter — pollNow drives it without the
    // 5s initial-delay timer.
    await manager.pollNow(KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://mcp.example/server');
    const sent = JSON.parse(calls[0]!.body!) as { method: string; params: { uri: string } };
    expect(sent.method).toBe('resources/read');
    expect(sent.params.uri).toBe(URI);
    expect(emitted).toEqual([]); // baseline is silent

    // Content change → an `updated` event on the connection.mcp path.
    resourceText = 'v2';
    await manager.pollNow(KEY);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.platform).toBe('connection.mcp');
    expect(emitted[0]!.event_kind).toBe('updated');
    expect(emitted[0]!.record_id).toBe(URI);
  });
});
