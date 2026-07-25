/** D-148 § A.4.2 + § A.4.4 — production browser WebSocket transport.
 *
 *  Asserts the contract `createBrowserWebclientTransport` adapts:
 *
 *   - `open()` resolves on the WS `open` event + reaches state
 *     'connected'; pre-upgrade close/error rejects.
 *   - Auth close codes (1008 / 4001 / 4401) map to
 *     `WebclientReauthRequiredError` both pre-open (reject) and
 *     post-open (state 'reauth_required').
 *   - `send()` JSON-stringifies; receives JSON-parse + dispatch.
 *   - Non-text frames + unparseable JSON dropped.
 *   - `close()` is idempotent + emits state 'disconnected'.
 *   - URL builder appends `?token=<bearer>` (URL-encoded) — preserves
 *     pre-existing query string.
 */

import { describe, expect, it } from 'vitest';

import {
  WEBCLIENT_AUTH_CLOSE_CODES,
  WEBCLIENT_WS_SUBPROTOCOL,
  buildDefaultConnectUrl,
  createBrowserWebclientTransport,
  type BrowserWebSocketConstructor,
  type BrowserWebSocketLike,
} from '../realtime/browser-transport.js';
import {
  WebclientReauthRequiredError,
  type WebclientWsState,
} from '../realtime/ws-client.js';

interface FakeWsControls {
  readonly Ctor: BrowserWebSocketConstructor;
  /** The most-recently-constructed fake socket. */
  current(): FakeSocket | null;
  /** Constructor arguments captured at construction time. */
  constructorArgs(): Array<{ url: string; protocols: string | ReadonlyArray<string> | undefined }>;
}

interface FakeSocket extends BrowserWebSocketLike {
  fireOpen(): void;
  fireClose(code?: number, reason?: string): void;
  fireError(): void;
  fireMessage(data: unknown): void;
  /** Captured `send()` payloads. */
  sent(): string[];
  /** Captured `close()` invocations. */
  closes(): Array<{ code?: number; reason?: string }>;
}

const buildFakeWs = (): FakeWsControls => {
  const args: Array<{ url: string; protocols: string | ReadonlyArray<string> | undefined }> = [];
  const instances: FakeSocket[] = [];

  class FakeWebSocket implements FakeSocket {
    readyState = 0;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
    private readonly sentPayloads: string[] = [];
    private readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

    constructor(url: string, protocols?: string | ReadonlyArray<string>) {
      args.push({ url, protocols });
      instances.push(this);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
      set.add(listener);
      this.listeners.set(type, set);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
      this.sentPayloads.push(data);
    }

    close(code?: number, reason?: string): void {
      this.closeCalls.push({ code, reason });
      this.readyState = 3;
    }

    private fire(type: string, event: unknown): void {
      const set = this.listeners.get(type);
      if (!set) return;
      for (const l of [...set]) l(event);
    }

    fireOpen(): void {
      this.readyState = 1;
      this.fire('open', {});
    }
    fireClose(code?: number, reason?: string): void {
      this.readyState = 3;
      this.fire('close', { code, reason });
    }
    fireError(): void {
      this.fire('error', {});
    }
    fireMessage(data: unknown): void {
      this.fire('message', { data });
    }
    sent(): string[] {
      return [...this.sentPayloads];
    }
    closes(): Array<{ code?: number; reason?: string }> {
      return [...this.closeCalls];
    }
  }

  return {
    Ctor: FakeWebSocket as unknown as BrowserWebSocketConstructor,
    current: () => instances[instances.length - 1] ?? null,
    constructorArgs: () => [...args],
  };
};

describe('D-148 § A.4 — production browser WS transport', () => {
  it('exports the documented constants', () => {
    expect(WEBCLIENT_WS_SUBPROTOCOL).toBe('recued.v1');
    expect(WEBCLIENT_AUTH_CLOSE_CODES.has(1008)).toBe(true);
    expect(WEBCLIENT_AUTH_CLOSE_CODES.has(4001)).toBe(true);
    // D-156 P9 added 4003 (instance_revoked) so that rotation-driven
    // revocation surfaces through the `onReauthRequired` funnel
    // instead of looping reconnect against the revoked bearer.
    expect(WEBCLIENT_AUTH_CLOSE_CODES.has(4003)).toBe(true);
    expect(WEBCLIENT_AUTH_CLOSE_CODES.has(4401)).toBe(true);
    expect(WEBCLIENT_AUTH_CLOSE_CODES.has(1000)).toBe(false);
  });

  describe('buildDefaultConnectUrl', () => {
    it('appends ?token= when server URL has no query', () => {
      expect(
        buildDefaultConnectUrl({ server_url: 'wss://alice.example/ws', bearer: 'secret' }),
      ).toBe('wss://alice.example/ws?token=secret');
    });
    it('appends &token= when server URL already has a query', () => {
      expect(
        buildDefaultConnectUrl({ server_url: 'wss://alice.example/ws?v=1', bearer: 'secret' }),
      ).toBe('wss://alice.example/ws?v=1&token=secret');
    });
    it('URL-encodes the bearer (handles `+`, `/`, `=`)', () => {
      const url = buildDefaultConnectUrl({
        server_url: 'wss://alice.example/ws',
        bearer: 'a+b/c=d',
      });
      expect(url).toBe('wss://alice.example/ws?token=a%2Bb%2Fc%3Dd');
    });
  });

  it('open() resolves on `open` event + reaches state `connected`', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const states: WebclientWsState[] = [];
    transport.onState((s) => states.push(s));

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    expect(states).toEqual(['connecting']);
    const ws = fake.current();
    expect(ws).not.toBeNull();
    ws!.fireOpen();
    await opening;
    expect(states).toEqual(['connecting', 'connected']);

    // Constructor was called with the correct URL + subprotocol.
    const callArgs = fake.constructorArgs();
    expect(callArgs.length).toBe(1);
    expect(callArgs[0].url).toBe('wss://x/ws?token=t1');
    expect(callArgs[0].protocols).toBe('recued.v1');
  });

  it('rejects open() when WS closes before `open`', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const states: WebclientWsState[] = [];
    transport.onState((s) => states.push(s));

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireClose(1006, 'network');
    await expect(opening).rejects.toThrow(/closed before open/);
    expect(states).toEqual(['connecting', 'disconnected']);
  });

  it('rejects open() with WebclientReauthRequiredError when close code is an auth code', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireClose(4001, 'server not enrolled');
    await expect(opening).rejects.toBeInstanceOf(WebclientReauthRequiredError);
  });

  it('D-156 P9 — rejects open() with WebclientReauthRequiredError on 4003 instance_revoked close', async () => {
    // Rotation-driven revocation (`revokeAllConnectedInstances` after a
    // `server_identity_key` rotation) closes connected sockets with
    // code 4003. Pre-P9 the rotation engine emitted a `pair_required`
    // broadcast BEFORE the close so the webclient surfaced re-pair
    // while the WS was still alive; P9 retired that broadcast, so 4003
    // is now the sole reauth signal — the transport must route it
    // through `WebclientReauthRequiredError` or the ws-client loops
    // reconnect against the revoked bearer.
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireClose(4003, 'instance revoked');
    await expect(opening).rejects.toBeInstanceOf(WebclientReauthRequiredError);
  });

  it('rejects open() when WS errors before `open`', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireError();
    await expect(opening).rejects.toThrow(/error before open/);
  });

  it('post-open close with auth code defers reauth — next open() rejects with WebclientReauthRequiredError', async () => {
    // Codex P2 fold — the ws-client's onState handler only halts the
    // reconnect loop when `open()` rejects with
    // `WebclientReauthRequiredError`. The transport therefore must NOT
    // emit `reauth_required` state directly on post-open auth close
    // (that would route to `queueReconnect()` and spin). It defers the
    // signal until the very next `open()` call.
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const states: WebclientWsState[] = [];
    transport.onState((s) => states.push(s));

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireOpen();
    await opening;
    ws.fireClose(4401, 'bearer rejected');
    // Transport state transitions to 'disconnected', NOT 'reauth_required'.
    expect(states.at(-1)).toBe('disconnected');
    // Next open() rejects with the typed reauth error so the
    // ws-client's existing `open()`-rejection path fires.
    await expect(
      transport.open({ server_url: 'wss://x/ws', bearer: 't1' }),
    ).rejects.toBeInstanceOf(WebclientReauthRequiredError);
  });

  it('reauth flag clears after one open() rejection — fresh bearer can reconnect', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    fake.current()!.fireOpen();
    await opening;
    fake.current()!.fireClose(4001, 'server not enrolled');

    // First open after auth-close rejects with reauth error.
    await expect(
      transport.open({ server_url: 'wss://x/ws', bearer: 't2' }),
    ).rejects.toBeInstanceOf(WebclientReauthRequiredError);
    // Subsequent open succeeds normally (caller has rotated the bearer
    // + `applyRotatedBearer()` already kicked the ws-client back into
    // reconnect — this is the second attempt with a fresh bearer).
    const next = transport.open({ server_url: 'wss://x/ws', bearer: 't3' });
    fake.current()!.fireOpen();
    await expect(next).resolves.toBeUndefined();
  });

  it('Codex P1 fold — clearAuthBlock() drops the sticky reauth flag so the NEXT open() with a fresh bearer succeeds', async () => {
    // Token-rotation scenario: server pushes new bearer + closes the
    // OLD WS with an auth code. Without clearAuthBlock(), the FIRST
    // reconnect attempt (with the freshly-persisted bearer) would
    // reject with the deferred reauth signal — sending the client
    // back to reauth_required even though the bearer is fresh.
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 'old' });
    fake.current()!.fireOpen();
    await opening;
    fake.current()!.fireClose(4401, 'bearer rejected');

    // Rotation handler persists the fresh bearer + calls
    // ws.applyRotatedBearer() which fans to transport.clearAuthBlock().
    transport.clearAuthBlock?.();

    // Next open() with the fresh bearer succeeds — no reauth rejection.
    const next = transport.open({ server_url: 'wss://x/ws', bearer: 'fresh' });
    fake.current()!.fireOpen();
    await expect(next).resolves.toBeUndefined();
  });

  it('Codex P1 fold — clearAuthBlock() is a no-op when no sticky flag is set', () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    // Never opened — no sticky flag. Clear must not throw.
    expect(() => transport.clearAuthBlock?.()).not.toThrow();
  });

  it('post-open close with normal code emits state `disconnected`', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const states: WebclientWsState[] = [];
    transport.onState((s) => states.push(s));

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireOpen();
    await opening;
    ws.fireClose(1000, 'normal');
    expect(states.at(-1)).toBe('disconnected');
  });

  it('send() JSON-stringifies + dispatches via the WS', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireOpen();
    await opening;

    await transport.send({ type: 'rpc', request_id: 'r1', method: 'foo', args: { a: 1 } });
    expect(ws.sent()).toEqual([
      JSON.stringify({ type: 'rpc', request_id: 'r1', method: 'foo', args: { a: 1 } }),
    ]);
  });

  it('send() before open throws', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    await expect(transport.send({ a: 1 })).rejects.toThrow(/disconnected/);
  });

  it('onMessage receives JSON-parsed envelopes', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireOpen();
    await opening;
    ws.fireMessage(JSON.stringify({ type: 'rpc_result', request_id: 'r1', result: { ok: true } }));
    expect(received).toEqual([
      { type: 'rpc_result', request_id: 'r1', result: { ok: true } },
    ]);
  });

  it('onMessage drops non-text frames + unparseable JSON', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));

    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireOpen();
    await opening;

    ws.fireMessage(new ArrayBuffer(8)); // binary — dropped
    ws.fireMessage('not json {{{'); // unparseable — dropped
    ws.fireMessage(JSON.stringify({ kind: 'execution' })); // valid — delivered
    expect(received).toEqual([{ kind: 'execution' }]);
  });

  it('close() is idempotent + closes the underlying socket', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    const ws = fake.current()!;
    ws.fireOpen();
    await opening;

    await transport.close();
    expect(ws.closes()).toEqual([{ code: 1000, reason: 'webclient: orderly shutdown' }]);

    // Second close is a no-op.
    await transport.close();
    expect(ws.closes().length).toBe(1);
  });

  it('open() after a previous close() opens a fresh socket', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    let opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    fake.current()!.fireOpen();
    await opening;
    await transport.close();
    opening = transport.open({ server_url: 'wss://x/ws', bearer: 't2' });
    fake.current()!.fireOpen();
    await opening;
    expect(fake.constructorArgs().length).toBe(2);
    expect(fake.constructorArgs()[1].url).toBe('wss://x/ws?token=t2');
  });

  it('throws when globalThis.WebSocket is unavailable + no override', () => {
    const original = (globalThis as { WebSocket?: BrowserWebSocketConstructor }).WebSocket;
    try {
      delete (globalThis as { WebSocket?: BrowserWebSocketConstructor }).WebSocket;
      expect(() => createBrowserWebclientTransport()).toThrow(/WebSocket unavailable/);
    } finally {
      if (original) {
        (globalThis as { WebSocket?: BrowserWebSocketConstructor }).WebSocket = original;
      }
    }
  });

  it('open() refuses a second concurrent attach', async () => {
    const fake = buildFakeWs();
    const transport = createBrowserWebclientTransport({ webSocket: fake.Ctor });
    const opening = transport.open({ server_url: 'wss://x/ws', bearer: 't1' });
    fake.current()!.fireOpen();
    await opening;
    await expect(
      transport.open({ server_url: 'wss://x/ws', bearer: 't2' }),
    ).rejects.toThrow(/already attached/);
  });
});
