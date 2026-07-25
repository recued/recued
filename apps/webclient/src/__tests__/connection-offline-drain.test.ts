/** Offline fast-fail INTEGRATION — real ws-client + real connection-status
 *  controller + real rpc conn over a fake transport.
 *
 *  The fake-ws unit tests in `rpc-conn.test.ts` cannot exercise the
 *  ws-client's actual offline queue + `drainOutbound`, so they can't tell
 *  a queued-then-DRAINED call (delivered → in-doubt) apart from a queued-
 *  and-NEVER-drained call (safe to retry). This suite wires the three real
 *  modules so the drain genuinely happens, pinning the delivery-disposition
 *  promotion (Codex 2nd-pass HIGH):
 *
 *    - call queued while reconnecting → reconnect drains it to the wire →
 *      drop before reply → offline ⇒ `connection_lost` (outcome unknown).
 *    - call queued while reconnecting → straight to offline, never drained
 *      ⇒ `server_offline` (safe to retry). */

import { describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';

import {
  createWebclientWsClient,
  type WebclientWsState,
  type WebclientWsTransport,
} from '../realtime/ws-client.js';
import { createWebclientConnectionStatus } from '../realtime/connection-status.js';
import {
  createWebclientRpcConn,
  type WebclientRpcRequestEnvelope,
} from '../realtime/rpc-conn.js';

// ──────────────────────────────────────────────────────────────────
// Fakes — a transport whose `connected`/`disconnected` the test drives,
// and two independent timer sets (ws reconnect backoff vs controller grace).
// ──────────────────────────────────────────────────────────────────

const buildFakeTransport = () => {
  const stateListeners = new Set<(s: WebclientWsState) => void>();
  const sent: unknown[] = [];
  const transport: WebclientWsTransport = {
    async open() {
      /* resolves without reaching `connected` — the test fires that */
    },
    async close() {},
    async send(msg) {
      sent.push(msg);
    },
    onMessage() {
      return () => undefined;
    },
    onState(l) {
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    },
  };
  return {
    transport,
    fireState: (s: WebclientWsState) => {
      for (const l of [...stateListeners]) l(s);
    },
    sent: () => sent.slice(),
  };
};

interface TimerSlot {
  handler: () => void;
  cancelled: boolean;
}
const buildFakeTimers = () => {
  const slots: TimerSlot[] = [];
  return {
    setTimer(handler: () => void): { cancel: () => void } {
      const slot: TimerSlot = { handler, cancelled: false };
      slots.push(slot);
      return { cancel: () => { slot.cancelled = true; } };
    },
    fire(idx = 0): void {
      const live = slots.filter((s) => !s.cancelled);
      const target = live[idx];
      if (!target) throw new Error(`no live timer at index ${idx}`);
      target.cancelled = true;
      target.handler();
    },
    liveCount: () => slots.filter((s) => !s.cancelled).length,
  };
};

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const wire = () => {
  const tx = buildFakeTransport();
  const wsTimers = buildFakeTimers();
  const graceTimers = buildFakeTimers();
  const ws = createWebclientWsClient({
    transport: tx.transport,
    resolveServerUrl: async () => 'wss://server.example/ws',
    resolveBearer: async () => 'tok.bearer',
    setTimer: wsTimers.setTimer,
    random: () => 0,
  });
  const status = createWebclientConnectionStatus({
    ws,
    setTimer: graceTimers.setTimer,
  });
  const conn = createWebclientRpcConn({
    ws,
    connectionStatus: status,
    randomId: () => 'req-1',
  });
  return { tx, ws, status, conn, graceTimers };
};

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('offline fast-fail integration (real ws-client queue + drain)', () => {
  it('a queued call that is DRAINED on reconnect then dropped fails as connection_lost', async () => {
    const { tx, ws, conn, graceTimers } = wire();
    await ws.connect(); // transport.open resolves; ws sits in `connecting`

    // Call while not connected → the real ws-client QUEUES it (sent:false).
    const result = conn.call('approval.resolve' as never, { id: 'a1' } as never);
    await flush();
    expect(ws.queuedSends()).toBe(1);
    expect(tx.sent().length).toBe(0); // not yet on the wire

    // Reconnect → ws drains the queued envelope to the transport AND the
    // controller's `connected` promotes the pending entry to in-doubt.
    tx.fireState('connected');
    await flush();
    const drained = tx.sent()[0] as WebclientRpcRequestEnvelope | undefined;
    expect(drained?.method).toBe('approval.resolve'); // genuinely delivered
    expect(ws.queuedSends()).toBe(0);

    // Drop again before any reply, then the grace deadline → offline.
    tx.fireState('disconnected'); // ws-client maps this to `reconnecting`
    await flush();
    graceTimers.fire();

    await result.then(
      () => Promise.reject(new Error('expected connection_lost rejection')),
      (err: unknown) => {
        // Delivered-or-in-doubt — NOT the safe-to-retry code.
        expect((err as RpcError).code).toBe('connection_lost');
      },
    );
    conn.dispose();
  });

  it('a queued call that goes straight to offline (never drained) fails as server_offline', async () => {
    const { ws, conn, graceTimers } = wire();
    await ws.connect(); // ws in `connecting`, never reaches `connected`

    const result = conn.call('approval.list' as never, {} as never);
    await flush();
    expect(ws.queuedSends()).toBe(1);

    // No reconnect ever happens — the boot grace alone takes us offline.
    graceTimers.fire();

    await result.then(
      () => Promise.reject(new Error('expected server_offline rejection')),
      (err: unknown) => {
        // Never delivered → safe-to-retry code.
        expect((err as RpcError).code).toBe('server_offline');
      },
    );
    // The sweep also dropped the queued frame so it can't re-fire later.
    expect(ws.queuedSends()).toBe(0);
    conn.dispose();
  });
});
