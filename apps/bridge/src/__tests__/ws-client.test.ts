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

import { describe, it, expect } from 'vitest';
import {
  createWsClient,
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
    send: () => undefined,
    close: () => undefined,
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

const buildScriptedFactory = (
  outcomes: Array<'fail' | FakeTransport>,
  log: { sleeps: number[] },
): { factory: WsTransportFactory; opens: number } => {
  let i = 0;
  const factory: WsTransportFactory = {
    async open() {
      const next = outcomes[i++];
      if (next === 'fail' || next === undefined) {
        throw new Error('synthetic open failure');
      }
      return next;
    },
  };
  return { factory, opens: i };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await wait(20);
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
    // Wait long enough for at least 4 backoff retries to schedule.
    await wait(60);
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
    await wait(50);
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
    await wait(20);
    expect(client.isConnected()).toBe(true);
    expect(sleeps).toEqual([1_000, 2_000]);
    // Connected, but the wait is not reset by the open alone.
    expect(client.currentBackoff()).toBe(4_000);
    sessions[0]!.fakeSay('{"type":"registered"}');
    sessions[0]!.fakeClose('server restarted');
    await wait(20);
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
      await wait(10);
      transport.fakeCloseWith(code, why);
      await wait(20);
      expect(opens).toBe(1);
      expect(refusals).toEqual([{ code, reason: why }]);
      expect(disconnects).toEqual([why]);
      expect(client.refused()).toBe(true);
      expect(client.isConnected()).toBe(false);
      // The keepalive nudges start() every 30 s: it must not bring the refusals back.
      await client.start();
      await wait(20);
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
    await wait(80);
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
    await wait(10);
    first.fakeCloseWith(4004, 'ws path disabled');
    await wait(20);
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
    await wait(10);
    transport.fakeClose('test-close');
    await wait(10);
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
    await wait(10);
    const opens_before = opens;
    await client.stop();
    await wait(20);
    // Bound the count; once stopped, no further open attempts schedule.
    expect(opens).toBeLessThanOrEqual(opens_before + 1);
  });
});
