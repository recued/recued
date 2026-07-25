/** D-148 § A.4.2 — webclient typed rpc conn acceptance.
 *
 *  Drives `createWebclientRpcConn` over a fake `WebclientWsClient` that
 *  records sent envelopes + lets the test fire matching replies. Covers:
 *
 *    - request_id correlation: outbound envelope shape + reply pairing
 *      via the pending map (resolve / reject by code).
 *    - timeout enforcement: a missing reply rejects with
 *      `RpcError('timeout', …)` after the configured window.
 *    - AbortSignal: pre-aborted + mid-flight aborts both reject the
 *      pending caller with `'aborted'`.
 *    - reauth mapping: a `WebclientReauthRequiredError` from `ws.send`
 *      rejects the matching pending caller with
 *      `'webclient_reauth_required'`.
 *    - dispose: rejects every in-flight + detaches the message
 *      subscription so a late reply is a no-op.
 *    - co-existence with the broadcast subscriber: a `kind`-shaped
 *      message reaches the subscriber but not the rpc conn.
 */

import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';
import {
  WebclientReauthRequiredError,
  type WebclientWsClient,
  type WebclientWsState,
} from '../realtime/ws-client.js';
import type { WebclientConnectionStatus } from '../realtime/connection-status.js';
import {
  WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS,
  createWebclientRpcConn,
  type WebclientRpcRequestEnvelope,
  type WebclientRpcResultEnvelope,
} from '../realtime/rpc-conn.js';
import { createBroadcastSubscriber } from '../realtime/subscriber.js';

interface FakeWsControls {
  ws: WebclientWsClient;
  sent(): unknown[];
  fireMessage(message: unknown): void;
  setSendError(err: Error | null): void;
  messageListenerCount(): number;
  /** Drive the ws-client connection state the rpc conn reads to stamp a
   *  pending entry's delivery disposition (`sent`). Defaults to
   *  `'connected'` so the existing tests are unaffected. */
  setState(state: WebclientWsState): void;
  /** How many times `clearSendQueue()` was invoked. */
  clearSendQueueCount(): number;
}

const buildFakeWs = (): FakeWsControls => {
  const sent: unknown[] = [];
  const listeners = new Set<(m: unknown) => void>();
  let sendErr: Error | null = null;
  let connState: WebclientWsState = 'connected';
  let clearCount = 0;
  const ws: WebclientWsClient = {
    state: () => connState,
    queuedSends: () => 0,
    clearSendQueue() {
      clearCount += 1;
    },
    async connect() {},
    async disconnect() {},
    send: vi.fn(async (msg: unknown) => {
      if (sendErr) {
        const err = sendErr;
        sendErr = null;
        throw err;
      }
      sent.push(msg);
    }),
    applyRotatedBearer() {},
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onState() {
      return () => undefined;
    },
  };
  return {
    ws,
    sent: () => sent.slice(),
    fireMessage: (message) => {
      for (const l of [...listeners]) l(message);
    },
    setSendError: (err) => {
      sendErr = err;
    },
    messageListenerCount: () => listeners.size,
    setState: (state) => {
      connState = state;
    },
    clearSendQueueCount: () => clearCount,
  };
};

// A controllable `connection-status` seam — lets a test drive the current
// `status()` + fire the transitions the rpc conn subscribes to.
interface FakeConnStatusControls {
  status: {
    status: () => WebclientConnectionStatus;
    onStatus: (l: (s: WebclientConnectionStatus) => void) => () => void;
  };
  /** Set the value `status()` returns + fire the status listeners so the
   *  rpc conn runs its pending sweep / disposition promotion. */
  set(next: WebclientConnectionStatus): void;
  listenerCount(): number;
}

const buildFakeConnStatus = (
  initial: WebclientConnectionStatus = 'connecting',
): FakeConnStatusControls => {
  let cur = initial;
  const listeners = new Set<(s: WebclientConnectionStatus) => void>();
  return {
    status: {
      status: () => cur,
      onStatus: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    set: (next) => {
      cur = next;
      for (const l of [...listeners]) l(next);
    },
    listenerCount: () => listeners.size,
  };
};

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// ══════════════════════════════════════════════════════════════════
// Request id correlation
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.2 — webclient rpc conn: request id correlation', () => {
  it('sends `{ type: "rpc", request_id, method, args }` and resolves on a matching `rpc_result`', async () => {
    const controls = buildFakeWs();
    let seq = 0;
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => `req-${++seq}`,
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await flush();
    const envelope = controls.sent()[0] as WebclientRpcRequestEnvelope;
    expect(envelope.type).toBe('rpc');
    expect(envelope.request_id).toBe('req-1');
    expect(envelope.method).toBe('reception.endpoints.list');
    expect(envelope.args).toEqual({});
    const reply: WebclientRpcResultEnvelope = {
      type: 'rpc_result',
      request_id: 'req-1',
      result: { endpoints: [] },
    };
    controls.fireMessage(reply);
    await expect(result).resolves.toEqual({ endpoints: [] });
    conn.dispose();
  });

  it('rejects with a typed `RpcError` when the reply carries an error envelope', async () => {
    const controls = buildFakeWs();
    let seq = 0;
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => `req-${++seq}`,
    });
    const result = conn.call(
      'reception.endpoint.create' as never,
      { foo: 'bar' } as never,
    );
    await flush();
    controls.fireMessage({
      type: 'rpc_result',
      request_id: 'req-1',
      error: {
        code: 'preview_required',
        message: 'preview must precede create',
        status: 400,
        details: { hint: 'call preview_draft first' },
      },
    });
    await result.then(
      () => Promise.reject(new Error('expected rejection')),
      (err: unknown) => {
        expect(err).toBeInstanceOf(RpcError);
        const re = err as RpcError;
        expect(re.code).toBe('preview_required');
        expect(re.status).toBe(400);
        expect(re.method).toBe('reception.endpoint.create');
        expect(re.details).toEqual({ hint: 'call preview_draft first' });
      },
    );
    conn.dispose();
  });

  it('drops late replies for already-resolved request ids (no leak, no throw)', async () => {
    const controls = buildFakeWs();
    let seq = 0;
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => `req-${++seq}`,
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await flush();
    controls.fireMessage({
      type: 'rpc_result',
      request_id: 'req-1',
      result: { endpoints: ['first'] },
    });
    await expect(result).resolves.toEqual({ endpoints: ['first'] });
    expect(() =>
      controls.fireMessage({
        type: 'rpc_result',
        request_id: 'req-1',
        result: { endpoints: ['late'] },
      }),
    ).not.toThrow();
    conn.dispose();
  });

  it('non-rpc-result messages do not affect pending entries', async () => {
    const controls = buildFakeWs();
    let seq = 0;
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => `req-${++seq}`,
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await flush();
    // A broadcast-bus envelope — disjoint shape.
    controls.fireMessage({ kind: 'reception.endpoint_changed', op: 'create', endpoint_id: 'ep' });
    expect(conn.pendingCount()).toBe(1);
    controls.fireMessage({ type: 'rpc_result', request_id: 'req-1', result: 'ok' });
    await expect(result).resolves.toBe('ok');
    conn.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Timeouts + abort
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.2 — webclient rpc conn: timeouts + abort', () => {
  it('rejects with `RpcError("timeout")` after the configured window', async () => {
    vi.useFakeTimers();
    try {
      const controls = buildFakeWs();
      const conn = createWebclientRpcConn({
        ws: controls.ws,
        randomId: () => 'req-1',
        default_timeout_ms: 50,
      });
      const result = conn.call('reception.endpoints.list' as never, {} as never);
      // Attach the rejection handler synchronously BEFORE advancing
      // timers — `advanceTimersByTimeAsync` fires the onTimeout reject
      // inside its tick, so a `.then(_, fail)` chained after the
      // advance call attaches too late and Node flags it as
      // unhandled.
      const expected = result.then(
        () => Promise.reject(new Error('expected timeout rejection')),
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(60);
      const err = (await expected) as RpcError;
      expect(err).toBeInstanceOf(RpcError);
      expect(err.code).toBe('timeout');
      expect(err.method).toBe('reception.endpoints.list');
      conn.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('per-call timeout overrides the default', async () => {
    vi.useFakeTimers();
    try {
      const controls = buildFakeWs();
      const conn = createWebclientRpcConn({
        ws: controls.ws,
        randomId: () => 'req-1',
        default_timeout_ms: 5_000,
      });
      const result = conn.call(
        'reception.endpoints.list' as never,
        {} as never,
        { timeout: 25 },
      );
      const expected = result.then(
        () => Promise.reject(new Error('expected timeout rejection')),
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(30);
      const err = (await expected) as RpcError;
      expect(err.code).toBe('timeout');
      conn.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes a sensible default timeout constant', () => {
    expect(WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS).toBeGreaterThan(1000);
  });

  it('rejects synchronously when AbortSignal is already aborted', async () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => 'req-1',
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = conn.call(
      'reception.endpoints.list' as never,
      {} as never,
      { signal: ctrl.signal },
    );
    await result.then(
      () => Promise.reject(new Error('expected abort rejection')),
      (err: unknown) => {
        expect((err as RpcError).code).toBe('aborted');
      },
    );
    expect(controls.sent().length).toBe(0);
    conn.dispose();
  });

  it('aborts in-flight calls', async () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => 'req-1',
    });
    const ctrl = new AbortController();
    const result = conn.call(
      'reception.endpoints.list' as never,
      {} as never,
      { signal: ctrl.signal },
    );
    await flush();
    ctrl.abort();
    await result.then(
      () => Promise.reject(new Error('expected abort rejection')),
      (err: unknown) => {
        expect((err as RpcError).code).toBe('aborted');
      },
    );
    conn.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Reauth + dispose
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.2 — webclient rpc conn: reauth + dispose', () => {
  it('maps `WebclientReauthRequiredError` from ws.send to RpcError("webclient_reauth_required")', async () => {
    const controls = buildFakeWs();
    controls.setSendError(new WebclientReauthRequiredError('bearer rotated'));
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => 'req-1',
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await result.then(
      () => Promise.reject(new Error('expected reauth rejection')),
      (err: unknown) => {
        expect((err as RpcError).code).toBe('webclient_reauth_required');
        expect((err as RpcError).method).toBe('reception.endpoints.list');
      },
    );
    conn.dispose();
  });

  it('maps a generic ws.send error to RpcError("transport")', async () => {
    const controls = buildFakeWs();
    controls.setSendError(new Error('socket closed mid-write'));
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => 'req-1',
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await result.then(
      () => Promise.reject(new Error('expected transport rejection')),
      (err: unknown) => {
        expect((err as RpcError).code).toBe('transport');
      },
    );
    conn.dispose();
  });

  it('dispose() rejects all in-flight callers with transport_disposed and detaches the listener', async () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => 'req-1',
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await flush();
    expect(controls.messageListenerCount()).toBe(1);
    expect(conn.pendingCount()).toBe(1);
    conn.dispose();
    await result.then(
      () => Promise.reject(new Error('expected disposed rejection')),
      (err: Error) => {
        // pending.clear surfaces a plain Error (not RpcError) — that's
        // the contract `createPendingMap` provides + the call-site
        // catches it as the rejected promise.
        expect(err.message).toContain('disposed');
      },
    );
    expect(controls.messageListenerCount()).toBe(0);
  });

  it('dispose() is idempotent', () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws });
    expect(() => {
      conn.dispose();
      conn.dispose();
      conn.dispose();
    }).not.toThrow();
  });

  it('call after dispose rejects with `transport_disposed`', async () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws });
    conn.dispose();
    await conn.call('reception.endpoints.list' as never, {} as never).then(
      () => Promise.reject(new Error('expected disposed rejection')),
      (err: unknown) => {
        expect((err as RpcError).code).toBe('transport_disposed');
      },
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// Co-existence with broadcast subscriber
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.2 — webclient rpc conn: subscriber co-existence', () => {
  it('rpc_result envelopes do not reach the subscriber; broadcast events do not affect the conn', async () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => 'req-1',
    });
    const subscriber = createBroadcastSubscriber();
    const subDetach = controls.ws.onMessage((m) => subscriber.dispatch(m));
    const seen: string[] = [];
    subscriber.on('reception.endpoint_changed', (e) => seen.push(e.kind));

    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await flush();

    // Broadcast: subscriber sees it, conn ignores it.
    controls.fireMessage({
      kind: 'reception.endpoint_changed',
      op: 'create',
      endpoint_id: 'ep-1',
    });
    expect(seen).toEqual(['reception.endpoint_changed']);
    expect(conn.pendingCount()).toBe(1);

    // rpc_result: conn resolves, subscriber ignores (kind undefined).
    controls.fireMessage({ type: 'rpc_result', request_id: 'req-1', result: 'ok' });
    await expect(result).resolves.toBe('ok');
    expect(seen).toEqual(['reception.endpoint_changed']);

    subDetach();
    conn.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Offline fast-fail (connection-status seam)
// ══════════════════════════════════════════════════════════════════

describe('webclient rpc conn: offline fast-fail', () => {
  it('fast-fails a NEW call with server_offline while offline, without sending', async () => {
    const controls = buildFakeWs();
    const status = buildFakeConnStatus('offline');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
      randomId: () => 'req-1',
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await result.then(
      () => Promise.reject(new Error('expected server_offline rejection')),
      (err: unknown) => {
        expect((err as RpcError).code).toBe('server_offline');
        expect((err as RpcError).method).toBe('reception.endpoints.list');
      },
    );
    // Never handed to the transport + never registered as pending.
    expect(controls.sent().length).toBe(0);
    expect(conn.pendingCount()).toBe(0);
    conn.dispose();
  });

  it('fast-fails a NEW call with server_unresponsive while stalled, without sending', async () => {
    const controls = buildFakeWs(); // socket is up (state defaults to 'connected')
    const status = buildFakeConnStatus('stalled');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
      randomId: () => 'req-1',
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await result.then(
      () => Promise.reject(new Error('expected server_unresponsive rejection')),
      (err: unknown) => {
        // Distinct from server_offline so the user sees "isn't responding"
        // (calm, auto-recovering) rather than "can't reach" (socket down).
        expect((err as RpcError).code).toBe('server_unresponsive');
        expect((err as RpcError).method).toBe('reception.endpoints.list');
      },
    );
    expect(controls.sent().length).toBe(0);
    expect(conn.pendingCount()).toBe(0);
    conn.dispose();
  });

  it('rejects a DISPATCHED-while-connected pending call with connection_lost on the offline transition + drops the ws queue', async () => {
    const controls = buildFakeWs(); // state() defaults to 'connected'
    const status = buildFakeConnStatus('connected');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
      randomId: () => 'req-1',
    });
    const result = conn.call('approval.resolve' as never, { id: 'a1' } as never);
    await flush();
    expect(conn.pendingCount()).toBe(1);
    expect(controls.sent().length).toBe(1); // dispatched

    status.set('offline');
    await result.then(
      () => Promise.reject(new Error('expected connection_lost rejection')),
      (err: unknown) => {
        // Sent-but-unacked: outcome unknown — NOT the safe-to-retry code.
        expect((err as RpcError).code).toBe('connection_lost');
        expect((err as RpcError).method).toBe('approval.resolve');
      },
    );
    expect(conn.pendingCount()).toBe(0);
    expect(controls.clearSendQueueCount()).toBe(1);
    conn.dispose();
  });

  it('rejects a QUEUED-while-disconnected pending call with server_offline on the offline transition', async () => {
    const controls = buildFakeWs();
    controls.setState('reconnecting'); // not connected → entry stamped sent:false
    const status = buildFakeConnStatus('reconnecting');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
      randomId: () => 'req-1',
    });
    const result = conn.call('approval.list' as never, {} as never);
    await flush();
    expect(conn.pendingCount()).toBe(1);

    status.set('offline');
    await result.then(
      () => Promise.reject(new Error('expected server_offline rejection')),
      (err: unknown) => {
        // Never transmitted → safe-to-retry code.
        expect((err as RpcError).code).toBe('server_offline');
      },
    );
    expect(controls.clearSendQueueCount()).toBe(1);
    conn.dispose();
  });

  it('does NOT sweep pending calls on the stalled transition (socket is up — they ride to reply/timeout)', async () => {
    const controls = buildFakeWs(); // state() defaults to 'connected'
    const status = buildFakeConnStatus('connected');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
      randomId: () => 'req-1',
    });
    const result = conn.call('approval.list' as never, {} as never);
    await flush();
    expect(conn.pendingCount()).toBe(1);

    // Unlike `offline`, a `stalled` crossing must leave the in-flight call
    // alone — the socket is up so the frame is already out and may still get
    // a (late) reply once the server un-stalls; sweeping it would be wrong.
    status.set('stalled');
    await flush();
    expect(conn.pendingCount()).toBe(1);
    expect(controls.clearSendQueueCount()).toBe(0);

    // A late reply still settles it normally.
    controls.fireMessage({ type: 'rpc_result', request_id: 'req-1', result: 'ok' });
    await expect(result).resolves.toBe('ok');
    conn.dispose();
  });

  it('does NOT fast-fail during a reconnecting blip (only offline trips it)', async () => {
    const controls = buildFakeWs();
    const status = buildFakeConnStatus('reconnecting');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
      randomId: () => 'req-1',
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await flush();
    // A new call while merely reconnecting is sent + stays pending — the
    // ws-client's own queue rides out the blip; we don't reject it.
    expect(conn.pendingCount()).toBe(1);
    // Settle it so the test doesn't leak an unhandled rejection.
    controls.fireMessage({ type: 'rpc_result', request_id: 'req-1', result: 'ok' });
    await expect(result).resolves.toBe('ok');
    conn.dispose();
  });

  it('legacy path (no connectionStatus) never fast-fails — call stays pending', async () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: () => 'req-1',
    });
    const result = conn.call('reception.endpoints.list' as never, {} as never);
    await flush();
    expect(conn.pendingCount()).toBe(1);
    controls.fireMessage({ type: 'rpc_result', request_id: 'req-1', result: 'ok' });
    await expect(result).resolves.toBe('ok');
    conn.dispose();
  });

  it('dispose() detaches the connection-status listener', () => {
    const controls = buildFakeWs();
    const status = buildFakeConnStatus('connected');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
    });
    expect(status.listenerCount()).toBe(1);
    conn.dispose();
    expect(status.listenerCount()).toBe(0);
    // Firing offline after dispose is inert (no throw).
    expect(() => status.set('offline')).not.toThrow();
  });
});
