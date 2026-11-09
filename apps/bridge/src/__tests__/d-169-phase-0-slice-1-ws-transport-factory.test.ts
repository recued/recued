/** D-169 P0 Slice 1 — browser WebSocket transport factory tests.
 *
 *  Covers `apps/bridge/src/boot/ws-transport-factory.ts`:
 *   - URL composition (the bearer is NOT on the URL; query preserved)
 *   - Subprotocol passed to the WebSocket constructor
 *   - open() resolves on `open` event
 *   - open() rejects on pre-open close
 *   - open() rejects on pre-open error
 *   - returned transport forwards send/close/onMessage/onClose/onError
 *   - binary message frames are dropped (text-only wire)
 *   - missing globalThis.WebSocket raises at factory construction
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BRIDGE_WS_SUBPROTOCOL,
  buildDefaultBridgeConnectUrl,
  createBrowserBridgeTransportFactory,
  type BrowserWebSocketConstructor,
  type BrowserWebSocketLike,
} from '../boot/ws-transport-factory.js';
import { decodeBearerSubprotocol } from '@recued/contracts';

interface FakeWebSocket extends BrowserWebSocketLike {
  url: string;
  protocols: string | ReadonlyArray<string> | undefined;
  sent: string[];
  closedWith: { code?: number; reason?: string } | null;
  fireOpen(): void;
  fireMessage(data: unknown): void;
  fireClose(info: { code?: number; reason?: string }): void;
  fireError(): void;
}

const buildFakeSocketFactory = (): {
  ctor: BrowserWebSocketConstructor;
  /** All sockets the ctor has produced, in construction order. */
  sockets: FakeWebSocket[];
} => {
  const sockets: FakeWebSocket[] = [];

  class FakeSocket implements BrowserWebSocketLike {
    readyState = 0;
    url: string;
    protocols: string | ReadonlyArray<string> | undefined;
    sent: string[] = [];
    closedWith: { code?: number; reason?: string } | null = null;
    listeners: Record<string, Array<(event: unknown) => void>> = {
      open: [],
      close: [],
      error: [],
      message: [],
    };
    constructor(url: string, protocols?: string | ReadonlyArray<string>) {
      this.url = url;
      this.protocols = protocols;
      sockets.push(this as unknown as FakeWebSocket);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(code?: number, reason?: string): void {
      this.closedWith = { code, reason };
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners[type]?.push(listener);
    }
    removeEventListener(type: string, listener: (event: unknown) => void): void {
      const ls = this.listeners[type];
      if (ls) this.listeners[type] = ls.filter((l) => l !== listener);
    }
    fireOpen(): void {
      this.readyState = 1;
      for (const l of [...this.listeners.open]) l({});
    }
    fireMessage(data: unknown): void {
      for (const l of [...this.listeners.message]) l({ data });
    }
    fireClose(info: { code?: number; reason?: string }): void {
      for (const l of [...this.listeners.close]) l(info);
    }
    fireError(): void {
      for (const l of [...this.listeners.error]) l({});
    }
  }

  return {
    ctor: FakeSocket as unknown as BrowserWebSocketConstructor,
    sockets,
  };
};

// ⛔ THE CONTRACT INVERTED HERE, DELIBERATELY — and this closes D-169 F4. These
// cases used to assert `?token=<bearer>` on the URL. F4's document-and-defer
// argued the residual was bounded by `wss://` enforcement and a
// non-terminating cloud; both hold, and neither was the whole problem. A URL is
// captured by reverse-proxy and access logs, crash reports and browser
// telemetry AT THE ENDPOINT, where TLS has already been terminated
// legitimately — and `client_tokens` has no expiry column, so anything that
// leaked stayed valid until revoked by hand. The bearer is a request header now.
describe('D-169 P0 Slice 1 — buildDefaultBridgeConnectUrl', () => {
  it('returns the URL untouched', () => {
    expect(buildDefaultBridgeConnectUrl({ url: 'wss://alice.recued.cloud:8443/ws' }))
      .toBe('wss://alice.recued.cloud:8443/ws');
  });

  it('preserves an existing query string without adding to it', () => {
    expect(buildDefaultBridgeConnectUrl({ url: 'wss://host/ws?client=bridge' }))
      .toBe('wss://host/ws?client=bridge');
  });
});

describe('D-169 P0 Slice 1 — createBrowserBridgeTransportFactory', () => {
  let webSocket: BrowserWebSocketConstructor;
  let sockets: FakeWebSocket[];

  beforeEach(() => {
    const f = buildFakeSocketFactory();
    webSocket = f.ctor;
    sockets = f.sockets;
  });

  it('throws at factory construction when globalThis.WebSocket is missing + no override given', () => {
    // Temporarily delete the global; restore after.
    const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      expect(() => createBrowserBridgeTransportFactory()).toThrow(/globalThis\.WebSocket unavailable/);
    } finally {
      if (saved !== undefined) (globalThis as { WebSocket?: unknown }).WebSocket = saved;
    }
  });

  it('opens a WebSocket against the composed URL + subprotocol; resolves on open', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok-1' });
    expect(sockets.length).toBe(1);
    expect(sockets[0].url).toBe('wss://host/ws');
    // The assertion that matters: the secret is nowhere in the URL. A regression
    // that re-added `?token=` would still open fine and still pass every other
    // case in this file — this is the one that would notice.
    expect(sockets[0].url).not.toContain('tok-1');
    expect(sockets[0].url).not.toContain('token=');

    const protocols = sockets[0].protocols as ReadonlyArray<string>;
    // Version marker FIRST — `ws` echoes the client's first offered value back
    // in a response header by default, so bearer-first would leak it there.
    expect(protocols[0]).toBe(BRIDGE_WS_SUBPROTOCOL);
    expect(decodeBearerSubprotocol(protocols)).toBe('tok-1');
    sockets[0].fireOpen();
    const transport = await openP;
    expect(transport).toBeDefined();
    expect(typeof transport.send).toBe('function');
  });

  it('rejects open() when WS closes before open', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    sockets[0].fireClose({ code: 1006, reason: 'network' });
    await expect(openP).rejects.toThrow(/closed before open/);
  });

  it('rejects open() when WS errors before open', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    sockets[0].fireError();
    await expect(openP).rejects.toThrow(/error before open/);
  });

  it('forwards send → socket.send', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    sockets[0].fireOpen();
    const transport = await openP;
    transport.send('hello');
    expect(sockets[0].sent).toEqual(['hello']);
  });

  it('forwards close → socket.close with code + reason', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    sockets[0].fireOpen();
    const transport = await openP;
    transport.close(1000, 'bye');
    expect(sockets[0].closedWith).toEqual({ code: 1000, reason: 'bye' });
  });

  it('fans inbound text frames to onMessage subscribers; drops binary frames', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    sockets[0].fireOpen();
    const transport = await openP;
    const received: string[] = [];
    transport.onMessage((p) => received.push(p));
    sockets[0].fireMessage('text-1');
    sockets[0].fireMessage(new Uint8Array([1, 2, 3])); // binary — dropped
    sockets[0].fireMessage('text-2');
    expect(received).toEqual(['text-1', 'text-2']);
  });

  it('fans post-open close events to onClose subscribers with code + reason', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    sockets[0].fireOpen();
    const transport = await openP;
    const closes: Array<{ code: number; reason: string }> = [];
    transport.onClose((info) => closes.push(info));
    sockets[0].fireClose({ code: 4003, reason: 'instance_revoked' });
    expect(closes).toEqual([{ code: 4003, reason: 'instance_revoked' }]);
  });

  it('fans post-open error events to onError subscribers', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    sockets[0].fireOpen();
    const transport = await openP;
    const errors: Error[] = [];
    transport.onError((e) => errors.push(e));
    sockets[0].fireError();
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it('unsubscribe returned from onMessage/onClose/onError actually removes the listener', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket });
    const openP = factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    sockets[0].fireOpen();
    const transport = await openP;
    const received: string[] = [];
    const unsub = transport.onMessage((p) => received.push(p));
    sockets[0].fireMessage('one');
    unsub();
    sockets[0].fireMessage('two');
    expect(received).toEqual(['one']);
  });

  it('honors a custom subprotocol via options — and still carries the bearer', async () => {
    const factory = createBrowserBridgeTransportFactory({ webSocket, subprotocol: 'recued.v2' });
    void factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    const protocols = sockets[0].protocols as ReadonlyArray<string>;
    // Overriding the version marker must not drop the auth carrier — they share
    // one list now, so a naive override could silently unauthenticate the client.
    expect(protocols[0]).toBe('recued.v2');
    expect(decodeBearerSubprotocol(protocols)).toBe('tok');
  });

  it('honors a custom URL builder via options', async () => {
    // ⚠ The custom builder no longer RECEIVES the bearer — `buildConnectUrl`
    // takes `{ url }` only, so a caller cannot put the secret back on the URL
    // even deliberately. That is the point: this seam existed for URL
    // heuristics, and it was also the shape that made `?token=` easy to keep.
    const factory = createBrowserBridgeTransportFactory({
      webSocket,
      buildConnectUrl: ({ url }) => `${url}?client=bridge`,
    });
    void factory.open({ url: 'wss://host/ws', auth_bearer: 'tok' });
    expect(sockets[0].url).toBe('wss://host/ws?client=bridge');
    expect(sockets[0].url).not.toContain('tok');
    expect(decodeBearerSubprotocol(sockets[0].protocols as ReadonlyArray<string>)).toBe('tok');
  });
});
