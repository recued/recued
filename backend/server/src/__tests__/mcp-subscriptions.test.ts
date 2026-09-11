/** Case 2 — Recued serving `subscriptions/listen`.
 *
 *  🔑 THE FIRST TEST CLOSES THE LOOP. Case 1 built a client that asks an MCP
 *  server what it pushes; case 2 makes Recued a server that answers. Pointing
 *  `probeMcpPushSupport` at Recued's OWN door is therefore the strongest test
 *  available: two independently written halves, one real socket, and any
 *  disagreement about the acknowledgement frame, the SSE framing or the
 *  `_meta` requirements fails here rather than against someone's vendor.
 *
 *  Everything runs through the REAL `createMcpPortHandler` over a real HTTP
 *  server, because the streaming branch IS transport behaviour — headers,
 *  flush, the response staying open, the close handler — and a hand-called
 *  function would test none of it. */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeMcpPushSupport } from '@recued/ingredients';
import {
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
  MCP_TOOLS_LIST_CHANGED_METHOD,
} from '@recued/ingredients/mcp-protocol.js';
import { createRateLimiter } from '../ports/common/rate-limit.js';
import {
  createMcpPortHandler,
  MCP_MAX_LISTEN_STREAMS_PER_TOKEN,
} from '../ports/mcp/handler.js';
import {
  createMcpSubscriptions,
  MCP_CATALOG_FINGERPRINT_INTERVAL_MS,
} from '../mcp-subscriptions.js';

const TOKEN = 'test-mcp-bearer';
const CLIENT = { name: 'recued-case1-client', version: '1.0.0' };

interface Harness {
  url: string;
  /** Advance the clock one interval and fire the periodic re-check — the
   *  cadence the real timer produces, where the 10s interval always clears the
   *  2s floor. Opens that happen WITHOUT a tick share a clock instant, so the
   *  floor absorbs them, which is the behaviour it exists for. */
  tick(): void;
  close(): Promise<void>;
}

/** A door with the real handler, the real subscriptions port, and a dispatch
 *  whose `tools/list` answer the test controls. */
const startDoor = async (opts: {
  tools: () => unknown;
  /** Return a JSON-RPC error envelope instead of a result. */
  fail?: () => boolean;
  onDispatch?: (method: string) => void;
} ): Promise<Harness> => {
  const dispatch = async (envelope: unknown): Promise<unknown> => {
    const method = (envelope as { method?: string }).method ?? '';
    const id = (envelope as { id?: unknown }).id ?? null;
    opts.onDispatch?.(method);
    if (method === 'tools/list') {
      if (opts.fail?.()) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'boom' } };
      }
      return { jsonrpc: '2.0', id, result: { resultType: 'complete', tools: opts.tools() } };
    }
    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  };

  const ticks: (() => void)[] = [];
  let clock = 1_000_000;
  const subscriptions = createMcpSubscriptions({
    dispatch,
    // Capture the interval instead of waiting 10s of wall clock.
    scheduleInterval: (fn, ms) => {
      expect(ms).toBe(MCP_CATALOG_FINGERPRINT_INTERVAL_MS);
      ticks.push(fn);
      return () => { ticks.splice(ticks.indexOf(fn), 1); };
    },
    now: () => clock,
  });

  const handler = createMcpPortHandler({
    verifier: (token) => token === TOKEN,
    limiter: createRateLimiter({ capacity: 1_000, refill_window_ms: 60_000 }),
    dispatch,
    subscriptions,
  });
  const server: Server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready); });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    tick: () => {
      clock += MCP_CATALOG_FINGERPRINT_INTERVAL_MS;
      for (const fn of [...ticks]) fn();
    },
    // ⚠ `close()` alone hangs: every open listen stream is a live socket, and
    // that is the whole point of the feature. Drop them explicitly.
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
};

/** Open a listen stream with a filter, as a modern client must. */
const listen = async (url: string, notifications: unknown): Promise<Response> => {
  const params = {
    notifications,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': CLIENT,
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_MODERN_PROTOCOL_VERSION,
      'Mcp-Method': 'subscriptions/listen',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'subscriptions/listen', params }),
  });
};

/** Collect frames from a live stream into an array as they arrive. */
const collect = (res: Response): { frames: Record<string, unknown>[]; stop: () => void } => {
  const frames: Record<string, unknown>[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += decoder.decode(value as Uint8Array, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line !== undefined) frames.push(JSON.parse(line.slice(6)));
        cut = buffer.indexOf('\n\n');
      }
    }
  })();
  return { frames, stop: () => { stopped = true; void reader.cancel().catch(() => undefined); } };
};

let door: Harness | undefined;
afterEach(async () => {
  await door?.close();
  door = undefined;
});

describe("case 1's client probing case 2's server", () => {
  it('🎯 reports Recued as pushing, with tools-list-changed and nothing else', async () => {
    door = await startDoor({ tools: () => [{ name: 'recued_listRecipes' }] });
    const result = await probeMcpPushSupport(
      globalThis.fetch.bind(globalThis),
      door.url,
      { authorization: `Bearer ${TOKEN}` },
      5_000,
      CLIENT,
    );
    expect(result.reason).toBeUndefined();
    expect(result.acknowledged).toEqual({ toolsListChanged: true });
    // ⇒ and the omission is the point: no resources surface exists, so none is
    // advertised. A client learns that in one frame instead of by waiting.
    expect(result.acknowledged?.resourceSubscriptions).toBeUndefined();
    expect(result.acknowledged?.promptsListChanged).toBeUndefined();
  });
});

describe('the acknowledgement is the contract', () => {
  it('⛔ omits what this host cannot serve, however much the client asks for', async () => {
    door = await startDoor({ tools: () => [] });
    const res = await listen(door.url, {
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: ['file:///anything'],
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const stream = collect(res);
    await vi.waitFor(() => { expect(stream.frames).toHaveLength(1); });
    expect(stream.frames[0]!.method).toBe(MCP_SUBSCRIPTIONS_ACKNOWLEDGED_METHOD);
    expect((stream.frames[0]!.params as { notifications: unknown }).notifications)
      .toEqual({ toolsListChanged: true });
    stream.stop();
  });

  it('⛔ still opens a stream and acknowledges NOTHING for a filter it honours none of', async () => {
    // Refusing would be indistinguishable from "this server does not implement
    // the method", and those are different facts. The empty ack IS the answer.
    door = await startDoor({ tools: () => [] });
    const res = await listen(door.url, { resourceSubscriptions: ['file:///x'] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const stream = collect(res);
    await vi.waitFor(() => { expect(stream.frames).toHaveLength(1); });
    expect((stream.frames[0]!.params as { notifications: unknown }).notifications).toEqual({});
    stream.stop();
  });
});

describe('what a client is actually told', () => {
  it('pushes tools/list_changed when the catalog moves, and stays silent when it does not', async () => {
    let tools: unknown[] = [{ name: 'recued_listRecipes' }];
    door = await startDoor({ tools: () => tools });
    const res = await listen(door.url, { toolsListChanged: true });
    const stream = collect(res);
    // The ack, then the baseline is taken — the client's own arrival is not a change.
    await vi.waitFor(() => { expect(stream.frames).toHaveLength(1); });
    door.tick();
    await new Promise((r) => setTimeout(r, 60));
    expect(stream.frames).toHaveLength(1);

    tools = [{ name: 'recued_listRecipes' }, { name: 'recued_ingredient_new-thing' }];
    door.tick();
    await vi.waitFor(() => { expect(stream.frames).toHaveLength(2); });
    expect(stream.frames[1]!.method).toBe(MCP_TOOLS_LIST_CHANGED_METHOD);
    // The subscription id echoes the request that opened the feed.
    expect((stream.frames[1]!.params as { _meta: Record<string, unknown> })
      ._meta['io.modelcontextprotocol/subscriptionId']).toBe(42);
    stream.stop();
  });

  it('⛔ a FAILED catalog read is not an empty catalog', async () => {
    // The trap this guards: hashing an error envelope as "no tools" pushes a
    // spurious change AND settles the baseline wrong, so the real catalog then
    // looks like a second change when the error clears.
    let tools: unknown[] = [{ name: 'a' }];
    let failing = false;
    door = await startDoor({ tools: () => tools, fail: () => failing });
    const res = await listen(door.url, { toolsListChanged: true });
    const stream = collect(res);
    await vi.waitFor(() => { expect(stream.frames).toHaveLength(1); });

    failing = true;
    door.tick();
    await new Promise((r) => setTimeout(r, 60));
    expect(stream.frames).toHaveLength(1); // no spurious "it changed"

    // ⇒ and when the error clears with the SAME catalog, still nothing — the
    // baseline was never corrupted.
    failing = false;
    door.tick();
    await new Promise((r) => setTimeout(r, 60));
    expect(stream.frames).toHaveLength(1);
    stream.stop();
  });
});

describe('cost and caps', () => {
  it('⚠ checks the catalog ONCE per bearer, not once per stream', async () => {
    // Otherwise the per-token stream cap multiplies the cost of the very thing
    // it bounds.
    const methods: string[] = [];
    door = await startDoor({
      tools: () => [{ name: 'a' }],
      onDispatch: (m) => { if (m === 'tools/list') methods.push(m); },
    });
    const a = collect(await listen(door.url, { toolsListChanged: true }));
    await vi.waitFor(() => { expect(a.frames).toHaveLength(1); });
    const afterFirst = methods.length;
    const b = collect(await listen(door.url, { toolsListChanged: true }));
    await vi.waitFor(() => { expect(b.frames).toHaveLength(1); });
    // The second stream inherits the baseline — no second build on open.
    expect(methods.length).toBe(afterFirst);

    // ⇒ and one tick serves both streams with one catalog read.
    door.tick();
    await new Promise((r) => setTimeout(r, 60));
    expect(methods.length).toBe(afterFirst + 1);
    a.stop();
    b.stop();
  });

  it('refuses a stream past the per-token cap', async () => {
    door = await startDoor({ tools: () => [] });
    const open: { stop: () => void }[] = [];
    for (let i = 0; i < MCP_MAX_LISTEN_STREAMS_PER_TOKEN; i++) {
      const res = await listen(door.url, { toolsListChanged: true });
      expect(res.status).toBe(200);
      open.push(collect(res));
    }
    const overflow = await listen(door.url, { toolsListChanged: true });
    expect(overflow.status).toBe(503);
    await overflow.text();
    for (const stream of open) stream.stop();
  });
});
