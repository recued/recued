/** D-121 Phase 6 — WS server `events.subscribe` rpc + push integration.
 *
 *  Spins up a real ws-server with the event bus wired through, opens
 *  a registered client, subscribes via the rpc envelope, then asserts
 *  the server pushes `server_event` envelopes when the bus emits.
 *  Covers the wire shape end-to-end so the rpc handler + push helper
 *  are verified together. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createEventBus } from '../events/bus.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

const connectWs = (port: number, bearer: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(bearer)}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

const nextMessage = (ws: WebSocket): Promise<any> =>
  new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });

const collectMessages = (ws: WebSocket, count: number, timeoutMs = 1000): Promise<any[]> =>
  new Promise((resolve, reject) => {
    const out: any[] = [];
    const timeout = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error(`timed out after ${timeoutMs}ms; got ${out.length} of ${count}`));
    }, timeoutMs);
    const onMsg = (data: any): void => {
      out.push(JSON.parse(data.toString()));
      if (out.length >= count) {
        clearTimeout(timeout);
        ws.removeListener('message', onMsg);
        resolve(out);
      }
    };
    ws.on('message', onMsg);
  });

describe('D-121 Phase 6 — WS events.subscribe rpc integration', () => {
  let server: RunningServer;
  let bus: ReturnType<typeof createEventBus>;
  let db: Database.Database;
  let clientTokens: ReturnType<typeof createClientTokenStore>;

  beforeAll(async () => {
    bus = createEventBus();
    db = new Database(':memory:');
    clientTokens = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    server = await startServer(0, {
      executeDeps: {
        recipeStore,
        executorConfig: { manifests },
        baseVault: {},
      },
      eventsDeps: { bus },
      clientTokens,
    });
    server.wsServer.maxInstances = 0;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  /** A connection whose token carries no paired device (or the one named). */
  const connectWithToken = async (instance_id?: string): Promise<WebSocket> => {
    const issued = await clientTokens.issue({
      client_kind: 'webclient',
      ...(instance_id !== undefined ? { metadata: { instance_id } } : {}),
    });
    return connectWs(server.port, `${issued.token_id}.${issued.bearer}`);
  };

  /** A paired device: its identity comes from its token. */
  const registerClient = (instance_id: string): Promise<WebSocket> => connectWithToken(instance_id);

  const callRpc = async (
    ws: WebSocket,
    method: string,
    args: Record<string, unknown>,
  ): Promise<any> => {
    const request_id = `r-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const onMsg = (data: any): void => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'rpc_result' && msg.request_id === request_id) {
          ws.removeListener('message', onMsg);
          resolve(msg);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
    });
  };

  it('events.subscribe ack returns cursor + replay_count', async () => {
    const ws = await registerClient('ext-sub-1');
    const reply = await callRpc(ws, 'events.subscribe', { kinds: ['memory'] });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ cursor: expect.any(Number), replay_count: 0, fell_off_ring: false });
    ws.close();
  });

  it('rejects an unregistered socket without installing a bus subscription', async () => {
    // Let the preceding test's close callback remove its registered listener;
    // this assertion is about the new socket never increasing the count.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const before = bus.subscriberCount();
    expect(before).toBe(0);
    const ws = await connectWithToken();
    const reply = await callRpc(ws, 'events.subscribe', { kinds: ['execution'] });

    expect(reply.error?.code).toBe('unauthorized');
    expect(bus.subscriberCount()).toBe(before);
    ws.close();
  });

  it('rejects empty kinds with bad_request', async () => {
    const ws = await registerClient('ext-sub-2');
    const reply = await callRpc(ws, 'events.subscribe', { kinds: [] });
    expect(reply.error?.code).toBe('bad_request');
    ws.close();
  });

  it('rejects a non-numeric or negative cursor_since with bad_request (no full-ring replay)', async () => {
    const ws = await registerClient('ext-sub-2b');
    // A non-numeric cursor_since would slip past `?? cursor` and force a
    // synchronous full-ring replay (amplification); a negative one likewise.
    const bad = await callRpc(ws, 'events.subscribe', { kinds: ['memory'], cursor_since: 'x' });
    expect(bad.error?.code).toBe('bad_request');
    const neg = await callRpc(ws, 'events.subscribe', { kinds: ['memory'], cursor_since: -1 });
    expect(neg.error?.code).toBe('bad_request');
    // A valid non-negative cursor_since still works.
    const ok = await callRpc(ws, 'events.subscribe', { kinds: ['memory'], cursor_since: 0 });
    expect(ok.error).toBeUndefined();
    ws.close();
  });

  it('pushes server_event envelopes for matching kinds', async () => {
    const ws = await registerClient('ext-sub-3');
    const subAck = await callRpc(ws, 'events.subscribe', { kinds: ['memory'] });
    expect(subAck.result).toBeDefined();

    const collectP = collectMessages(ws, 2);
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r-a' });
    bus.emit({ kind: 'memory', subkind: 'link', id: 'r-b' });
    const msgs = await collectP;
    expect(msgs.every((m) => m.type === 'server_event')).toBe(true);
    expect(msgs.map((m) => m.event.subkind)).toEqual(['audit', 'link']);
    ws.close();
  });

  it('does not push events outside subscribed kinds', async () => {
    const ws = await registerClient('ext-sub-4');
    await callRpc(ws, 'events.subscribe', { kinds: ['memory'] });

    const seen: any[] = [];
    const onMsg = (data: any): void => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'server_event') seen.push(msg);
    };
    ws.on('message', onMsg);

    bus.emit({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1' });
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r-c' });
    // Wait briefly for both to land
    await new Promise((r) => setTimeout(r, 50));
    ws.removeListener('message', onMsg);
    expect(seen).toHaveLength(1);
    expect(seen[0].event.kind).toBe('memory');
    ws.close();
  });

  it('replays via cursor_since when reconnecting', async () => {
    const ws = await registerClient('ext-sub-5');
    const startCursor = bus.cursor();
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'replay-a' });
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'replay-b' });

    const collectP = collectMessages(ws, 2);
    const subAck = await callRpc(ws, 'events.subscribe', {
      kinds: ['memory'],
      cursor_since: startCursor,
    });
    expect(subAck.result.replay_count).toBe(2);
    const msgs = await collectP;
    expect(msgs.map((m) => m.event.id)).toEqual(['replay-a', 'replay-b']);
    ws.close();
  });

  it('drops the subscription on WS close (no leaked subscribers)', async () => {
    // Drain any close-handler tail from prior tests.
    await new Promise((r) => setTimeout(r, 50));
    const before = bus.subscriberCount();
    const ws = await registerClient('ext-sub-6');
    await callRpc(ws, 'events.subscribe', { kinds: ['memory'] });
    expect(bus.subscriberCount()).toBe(before + 1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.subscriberCount()).toBe(before);
  });

  it('a paired connection is never sent a delegated chat request, even after it sends register', async () => {
    // Chat delegation went to "registered extensions", and any connection
    // could make itself one with `register` — then receive each delegated
    // request's input. `register` is retired (2026-10-23), so no connection
    // is an extension and delegation finds none.
    const a = await registerClient('ext-chat-a');
    const frames: Array<{ type?: string }> = [];
    a.on('message', (data) => frames.push(JSON.parse(data.toString())));
    a.send(JSON.stringify({ type: 'register', instance_id: 'ext-chat-a' }));
    await new Promise((r) => setTimeout(r, 50));

    await expect(server.wsServer.delegateChat('some-slug', { x: 1 }, 500))
      .rejects.toThrow('No extension connected');
    expect(frames.filter((f) => f.type === 'chat_broadcast')).toHaveLength(0);
    a.close();
  });
});
