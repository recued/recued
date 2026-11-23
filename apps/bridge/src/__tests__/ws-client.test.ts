/** D-148 P3 — WS client lifecycle tests.
 *
 *  Covers spec § A.3.3:
 *    - connect → idle → server kill → reconnect with exponential
 *      backoff (1s, 2s, 4s, ..., 30s cap)
 *    - attempt counter resets on success
 *    - Stop() halts the reconnect loop
 *
 *  Tests inject a deterministic transport factory + sleep so the
 *  loop is fully simulated without real WebSockets. */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  createWsClient as createClient,
  type WsClientHandlers,
  type WsTransport,
  type WsTransportFactory,
} from '../transport/ws-client.js';

interface FakeTransport extends WsTransport {
  closeListeners: Array<(info: { code: number; reason: string }) => void>;
  errorListeners: Array<(err: Error) => void>;
  messageListeners: Array<(payload: string) => void>;
  fakeClose(reason: string): void;
  fakeCloseWith(code: number, reason: string): void;
  /** A frame from the server. */
  fakeSay(payload: string): void;
}

const buildFakeTransport = (): FakeTransport => {
  const transport: FakeTransport = {
    closeListeners: [],
    errorListeners: [],
    messageListeners: [],
    fakeClose(reason) {
      for (const l of [...transport.closeListeners]) l({ code: 1006, reason });
    },
    fakeCloseWith(code, reason) {
      for (const l of [...transport.closeListeners]) l({ code, reason });
    },
    fakeSay(payload) {
      for (const l of [...transport.messageListeners]) l(payload);
    },
    send: vi.fn(),
    close: vi.fn(),
    onMessage(handler) {
      transport.messageListeners.push(handler);
      return () => {
        transport.messageListeners = transport.messageListeners.filter((h) => h !== handler);
      };
    },
    onClose(handler) {
      transport.closeListeners.push(handler);
      return () => {
        transport.closeListeners = transport.closeListeners.filter((h) => h !== handler);
      };
    },
    onError(handler) {
      transport.errorListeners.push(handler);
      return () => {
        transport.errorListeners = transport.errorListeners.filter((h) => h !== handler);
      };
    },
  };
  return transport;
};

const clients = new Set<ReturnType<typeof createClient>>();
const createWsClient: typeof createClient = (options) => {
  const client = createClient(options);
  clients.add(client);
  return client;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  for (const client of clients) await client.stop();
  clients.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => vi.advanceTimersByTimeAsync(0);
const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('D-148 P3 — WS client connect lifecycle', () => {
  it('connect → onConnected fires + isConnected returns true', async () => {
    const transport = buildFakeTransport();
    const sleeps: number[] = [];
    let connected_with: WsTransport | null = null;
    const handlers: WsClientHandlers = {
      onConnected(t) {
        connected_with = t;
      },
    };
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: async () => 'tok-id.bearer-plaintext',
      factory: { async open() { return transport; } },
      handlers,
      sleep: async (ms) => {
        sleeps.push(ms);
        await wait(0);
      },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(client.isConnected()).toBe(true);
    expect(connected_with).toBe(transport);
  });
});

describe('D-148 P3 — exponential backoff on failure', () => {
  it('failures trigger 1s → 2s → 4s ... up to 30s cap', async () => {
    const sleeps: number[] = [];
    const success_transport = buildFakeTransport();
    const factory: WsTransportFactory = {
      async open() {
        if (sleeps.length < 4) {
          throw new Error('synthetic fail');
        }
        return success_transport;
      },
    };
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: async () => 'tok-id.bearer-plaintext',
      factory,
      sleep: async (ms) => {
        sleeps.push(ms);
        await wait(0);
      },
      max_backoff_ms: 30_000,
    });
    await client.start();
    // Advance the injected timers through four retries.
    await vi.advanceTimersByTimeAsync(60);
    expect(sleeps.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('backoff caps at max_backoff_ms', async () => {
    const sleeps: number[] = [];
    const factory: WsTransportFactory = {
      async open() {
        throw new Error('always fail');
      },
    };
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: async () => 'tok-id.bearer-plaintext',
      factory,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length > 8) {
          // Stop the loop to keep the test bounded.
          await client.stop();
        }
        await wait(0);
      },
      max_backoff_ms: 30_000,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(50);
    // Last entry should equal the cap.
    expect(sleeps[sleeps.length - 1]).toBe(30_000);
  });

  it('a session the server spoke on reconnects at once when it drops, from the first wait', async () => {
    const sleeps: number[] = [];
    const sessions: FakeTransport[] = [];
    let opens = 0;
    const factory: WsTransportFactory = {
      async open() {
        opens++;
        // Two failed attempts first, so the wait has grown when the session starts.
        if (opens <= 2) throw new Error('synthetic fail');
        const t = buildFakeTransport();
        sessions.push(t);
        return t;
      },
    };
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: async () => 'tok-id.bearer-plaintext',
      factory,
      sleep: async (ms) => {
        sleeps.push(ms);
        await wait(0);
      },
      max_backoff_ms: 30_000,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(client.isConnected()).toBe(true);
    expect(sleeps).toEqual([1_000, 2_000]);
    // Connected, but the wait is not reset by the open alone.
    expect(client.currentBackoff()).toBe(4_000);
    sessions[0]!.fakeSay('{"type":"registered"}');
    sessions[0]!.fakeClose('server restarted');
    await vi.advanceTimersByTimeAsync(20);
    // Back at once, with no wait, and from the first wait again.
    expect(opens).toBe(4);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(client.currentBackoff()).toBe(1_000);
    await client.stop();
  });
});

describe('2026-11-03 — a refused sign-in, and a connection the server never spoke on', () => {
  for (const [code, why] of [[4401, 'bearer rejected'], [4003, 'instance revoked']] as const) {
    it(`a sign-in refused with ${String(code)} is final: no reconnect, onSignInRefused once, start() does nothing`, async () => {
      const transport = buildFakeTransport();
      let opens = 0;
      const refusals: Array<{ code: number; reason: string }> = [];
      const disconnects: string[] = [];
      const client = createWsClient({
        url: 'wss://test/',
        resolveBearer: async () => 'tok-id.bearer-plaintext',
        factory: { async open() { opens++; return transport; } },
        handlers: {
          onSignInRefused: (info) => { refusals.push(info); },
          onDisconnected: (reason) => { disconnects.push(reason); },
        },
        sleep: async () => { await wait(0); },
      });
      await client.start();
      await vi.advanceTimersByTimeAsync(10);
      transport.fakeCloseWith(code, why);
      await vi.advanceTimersByTimeAsync(20);
      expect(opens).toBe(1);
      expect(refusals).toEqual([{ code, reason: why }]);
      expect(disconnects).toEqual([why]);
      expect(client.refused()).toBe(true);
      expect(client.isConnected()).toBe(false);
      // The keepalive nudges start() every 30 s: it must not bring the refusals back.
      await client.start();
      await vi.advanceTimersByTimeAsync(20);
      expect(opens).toBe(1);
    });
  }

  it('a connection the server closed without a word is a failed attempt: the wait grows', async () => {
    const sleeps: number[] = [];
    let opens = 0;
    const factory: WsTransportFactory = {
      async open() {
        opens++;
        const t = buildFakeTransport();
        // Accepted, then closed at once with nothing said: a refusal by a code this client does
        // not know, or a proxy. It used to bring a reconnect with no wait, every ~40 ms.
        setTimeout(() => t.fakeClose('closed at once'), 0);
        return t;
      },
    };
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: async () => 'tok-id.bearer-plaintext',
      factory,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 5) await client.stop();
        await wait(0);
      },
      max_backoff_ms: 30_000,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(80);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    // One open per wait, and one before the first: never a reconnect without waiting.
    expect(opens).toBeLessThanOrEqual(sleeps.length + 1);
    expect(client.refused()).toBe(false);
  });

  it('a close that is not a refusal (4004, the server switched /ws off) waits and tries again', async () => {
    let opens = 0;
    const refusals: unknown[] = [];
    const first = buildFakeTransport();
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: async () => 'tok-id.bearer-plaintext',
      factory: { async open() { opens++; return opens === 1 ? first : buildFakeTransport(); } },
      handlers: { onSignInRefused: (info) => { refusals.push(info); } },
      sleep: async () => { await wait(0); },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(10);
    first.fakeCloseWith(4004, 'ws path disabled');
    await vi.advanceTimersByTimeAsync(20);
    expect(refusals).toEqual([]);
    expect(opens).toBe(2);
    await client.stop();
  });
});

describe('D-148 P3 — disconnect handler fires', () => {
  it('onDisconnected called when WS closes', async () => {
    const transport = buildFakeTransport();
    const reasons: string[] = [];
    const factory: WsTransportFactory = {
      async open() {
        return transport;
      },
    };
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: async () => 'tok-id.bearer-plaintext',
      factory,
      handlers: {
        onDisconnected(reason) {
          reasons.push(reason);
        },
      },
      sleep: async () => {
        await wait(0);
      },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(10);
    transport.fakeClose('test-close');
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons).toContain('test-close');
  });
});

describe('D-148 P3 — stop halts the reconnect loop', () => {
  it('stop() prevents further open attempts', async () => {
    let opens = 0;
    const factory: WsTransportFactory = {
      async open() {
        opens++;
        throw new Error('always fail');
      },
    };
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: async () => 'tok-id.bearer-plaintext',
      factory,
      sleep: async () => {
        await wait(0);
      },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(10);
    const opens_before = opens;
    await client.stop();
    await vi.advanceTimersByTimeAsync(20);
    // Bound the count; once stopped, no further open attempts schedule.
    expect(opens).toBeLessThanOrEqual(opens_before + 1);
  });
});


describe('WS client — obsolete connections after shutdown or restart', () => {
  it('a bearer resolved after restart cannot open a connection for the old run', async () => {
    const oldBearer = deferred<string>();
    const current = buildFakeTransport();
    const open = vi.fn(async () => current);
    let resolutions = 0;
    const connected = vi.fn();
    const client = createWsClient({
      url: 'wss://test/',
      resolveBearer: () => ++resolutions === 1 ? oldBearer.promise : Promise.resolve('new-bearer'),
      factory: { open },
      handlers: { onConnected: connected },
    });
    await client.start();
    await client.stop();
    await client.start();
    await settle();
    oldBearer.resolve('old-bearer');
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ url: 'wss://test/', auth_bearer: 'new-bearer' });
    expect(connected).toHaveBeenCalledExactlyOnceWith(current);
    expect(client.isConnected()).toBe(true);
  });

  it('a transport opened after stop is closed without becoming active or firing callbacks', async () => {
    const pending = deferred<WsTransport>();
    const late = buildFakeTransport();
    const connected = vi.fn();
    const client = createWsClient({
      url: 'wss://test/', resolveBearer: async () => 'bearer',
      factory: { open: () => pending.promise },
      handlers: { onConnected: connected },
    });
    await client.start();
    await settle();
    await client.stop();
    pending.resolve(late);
    await settle();
    expect(client.isConnected()).toBe(false);
    expect(connected).not.toHaveBeenCalled();
    expect(late.close).toHaveBeenCalledExactlyOnceWith(1000, 'bridge: shutdown');
    expect(() => client.send('after stop')).toThrow(/disconnected/);
  });

  for (const outcome of ['opened', 'rejected'] as const) {
    it(`an old open that ${outcome} after restart cannot replace the new connection or retry`, async () => {
      const pending = deferred<WsTransport>();
      const late = buildFakeTransport();
      const current = buildFakeTransport();
      const open = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(current);
      const sleep = vi.fn(async () => undefined);
      const connected = vi.fn();
      const client = createWsClient({
        url: 'wss://test/', resolveBearer: async () => 'bearer', factory: { open }, sleep,
        handlers: { onConnected: connected },
      });
      await client.start();
      await settle();
      await client.stop();
      await client.start();
      await settle();
      if (outcome === 'opened') pending.resolve(late);
      else pending.reject(new Error('old handshake failed'));
      await settle();
      expect(open).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
      expect(connected).toHaveBeenCalledExactlyOnceWith(current);
      expect(client.isConnected()).toBe(true);
      client.send('new session');
      expect(current.send).toHaveBeenCalledExactlyOnceWith('new session');
      expect(current.close).not.toHaveBeenCalled();
      if (outcome === 'opened') expect(late.close).toHaveBeenCalledExactlyOnceWith(1000, 'bridge: shutdown');
    });
  }

  it('a retry wait from before restart cannot change the new backoff or open another socket', async () => {
    const retry = deferred<void>();
    const current = buildFakeTransport();
    const open = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(current);
    const sleep = vi.fn(() => retry.promise);
    const client = createWsClient({
      url: 'wss://test/', resolveBearer: async () => 'bearer', factory: { open }, sleep,
    });
    await client.start();
    await settle();
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    await client.stop();
    await client.start();
    await settle();
    retry.resolve();
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    expect(client.currentBackoff()).toBe(1_000);
    expect(client.isConnected()).toBe(true);
    expect(current.close).not.toHaveBeenCalled();
  });

  it('queued messages, closes and refusals from a stopped socket cannot affect its replacement', async () => {
    const old = buildFakeTransport();
    const current = buildFakeTransport();
    const open = vi.fn().mockResolvedValueOnce(old).mockResolvedValue(current);
    const message = vi.fn(), disconnected = vi.fn(), refused = vi.fn();
    const client = createWsClient({
      url: 'wss://test/', resolveBearer: async () => 'bearer', factory: { open },
      handlers: { onMessage: message, onDisconnected: disconnected, onSignInRefused: refused },
    });
    await client.start();
    await settle();
    // Save callbacks already queued by a transport: removing listeners alone cannot cancel them.
    const oldMessage = old.messageListeners[0]!;
    const oldClose = old.closeListeners[0]!;
    await client.stop();
    expect(old.messageListeners).toHaveLength(0);
    expect(old.closeListeners).toHaveLength(0);
    expect(old.errorListeners).toHaveLength(0);
    await client.start();
    await settle();
    oldMessage('stale frame');
    oldClose({ code: 1006, reason: 'stale close' });
    oldClose({ code: 4401, reason: 'stale refusal' });
    await settle();
    expect(message).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    expect(refused).not.toHaveBeenCalled();
    expect(client.refused()).toBe(false);
    expect(client.isConnected()).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    current.fakeSay('current frame');
    expect(message).toHaveBeenCalledExactlyOnceWith('current frame');
    client.send('current request');
    expect(current.send).toHaveBeenCalledExactlyOnceWith('current request');
  });

  it('a rejected onConnected from a dropped socket cannot start another reconnect loop', async () => {
    const connectedWork = deferred<void>();
    const first = buildFakeTransport(), current = buildFakeTransport();
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(current);
    const connected = vi.fn().mockImplementationOnce(() => connectedWork.promise);
    const sleep = vi.fn(async () => undefined);
    const client = createWsClient({
      url: 'wss://test/', resolveBearer: async () => 'bearer', factory: { open }, sleep,
      handlers: { onConnected: connected },
    });
    await client.start();
    await settle();
    first.fakeSay('registered');
    first.fakeClose('restart');
    await settle();
    connectedWork.reject(new Error('old subscription failed'));
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    expect(connected).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(true);
    client.send('still current');
    expect(current.send).toHaveBeenCalledExactlyOnceWith('still current');
  });
});
