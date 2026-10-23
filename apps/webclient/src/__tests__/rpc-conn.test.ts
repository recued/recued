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
import { RPC_WS_MAX_IN_FLIGHT_PER_CLIENT, RpcError } from '@recued/contracts';
import {
  WebclientReauthRequiredError,
  type WebclientWsClient,
  type WebclientWsState,
} from '../realtime/ws-client.js';
import type { WebclientConnectionStatus } from '../realtime/connection-status.js';
import {
  WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS,
  WEBCLIENT_RPC_OVERLOAD_RETRY_INITIAL_MS,
  createWebclientRpcConn,
  type WebclientRpcRequestEnvelope,
  type WebclientRpcResultEnvelope,
} from '../realtime/rpc-conn.js';
import { createBroadcastSubscriber } from '../realtime/subscriber.js';
import { createManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

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
  /** Like `setState`, and also tells the `onState` listeners, as the real
   *  ws-client does on each transition (a new socket on `connected`). */
  transition(state: WebclientWsState): void;
  stateListenerCount(): number;
  /** How many times `clearSendQueue()` was invoked. */
  clearSendQueueCount(): number;
}

const buildFakeWs = (): FakeWsControls => {
  const sent: unknown[] = [];
  const listeners = new Set<(m: unknown) => void>();
  const stateListeners = new Set<(s: WebclientWsState) => void>();
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
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
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
    transition: (state) => {
      connState = state;
      for (const l of [...stateListeners]) l(state);
    },
    stateListenerCount: () => stateListeners.size,
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

describe('OAuth metadata checks over the browser RPC transport', () => {
  it('receives a file-source preparation after the normal page-read timeout', async () => {
    vi.useFakeTimers();
    const controls = buildFakeWs(); const conn = createWebclientRpcConn({ ws: controls.ws, randomId: () => 'file-preparation' });
    try {
      let result: unknown;
      const checking = createManagedOAuthCaller(conn.call)({ action: 'file_authentication_prepare', name: 'drive', expected_updated_at: 2 })
        .then(value => { result = value; }, error => { result = error; });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(result).toBeUndefined(); expect(conn.pendingCount()).toBe(1);
      const response = { action: 'file_authentication_prepare', name: 'drive', updated_at: 3, file_source: null };
      controls.fireMessage({ type: 'rpc_result', request_id: 'file-preparation', result: response });
      await checking; expect(result).toEqual(response); expect(conn.pendingCount()).toBe(0);
    } finally { conn.dispose(); vi.useRealTimers(); }
  });
  it.each([
    { action: 'collection_authentication_app_context', platform: 'mail', slug: 'gmail', intent: 'reauthorize' },
    { action: 'collection_authentication_app_review', authorization_id: 'authorization', code: 'code', redirect_uri: 'https://localhost/callback' },
    { action: 'collection_authentication_app_apply', review_id: 'review', fingerprint: 'fingerprint', attempt_id: 'attempt' },
    { action: 'collection_authentication_review', platform: 'calendar', slug: 'calendar', connection_name: 'native-calendar' },
    { action: 'collection_authentication_apply', review_id: 'review', fingerprint: 'fingerprint', attempt_id: 'attempt' },
    { action: 'account_impact', flow_id: 'flow', claim_secret: 'claim' },
    { action: 'review_direct_authentication', selections: [{ name: 'drive', expected_updated_at: 2 }], source_name: 'native-drive' },
    { action: 'apply_authentication_switch', attempt_id: 'file-migration-001', name: 'drive', expected_updated_at: 2,
      verification_url: 'https://www.googleapis.com/drive/v3/about', auth: { type: 'direct_oauth', authorization_receipt: 'receipt', requested_scopes: [] } },
  ] satisfies import('@recued/contracts').ManagedOAuthRequest[])('waits for the repeated metadata checks during $action, with a finite timeout', async request => {
    vi.useFakeTimers(); const controls = buildFakeWs(); const conn = createWebclientRpcConn({ ws: controls.ws });
    try {
      let result: unknown;
      const checking = createManagedOAuthCaller(conn.call)(request).then(value => { result = value; }, error => { result = error; });
      await vi.advanceTimersByTimeAsync(210_000);
      expect(result).toBeUndefined(); expect(conn.pendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(600_000);
      await checking; expect(result).toMatchObject({ code: 'timeout' }); expect(conn.pendingCount()).toBe(0);
    } finally { conn.dispose(); vi.useRealTimers(); }
  });
});

describe('ordinary broker RPC page reads', () => {
  it('keeps the normal timeout', async () => {
    vi.useFakeTimers(); const controls = buildFakeWs(); const conn = createWebclientRpcConn({ ws: controls.ws });
    try {
      const checking = createManagedOAuthCaller(conn.call)({ action: 'profiles' }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await checking).toMatchObject({ code: 'timeout' }); expect(conn.pendingCount()).toBe(0);
    } finally { conn.dispose(); vi.useRealTimers(); }
  });
});

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

// ══════════════════════════════════════════════════════════════════
// In-flight limit + `rpc_overloaded`
// ══════════════════════════════════════════════════════════════════

/** The server refuses a socket's 65th running call with this, before it runs
 *  (`ws-server.ts`). A Settings page load sent 88 calls against a live server. */
describe('webclient rpc conn: in-flight limit', () => {
  const ids = (controls: FakeWsControls): string[] =>
    controls.sent().map((m) => (m as WebclientRpcRequestEnvelope).request_id);
  const answer = (controls: FakeWsControls, id: string, result: unknown): void => {
    controls.fireMessage({ type: 'rpc_result', request_id: id, result });
  };
  const refuse = (controls: FakeWsControls, id: string): void => {
    controls.fireMessage({
      type: 'rpc_result',
      request_id: id,
      error: { code: 'rpc_overloaded', message: 'Too many RPC calls are already running; retry shortly.' },
    });
  };
  /** The call's failure, typed; a call that succeeds fails the test. */
  const failure = (call: Promise<unknown>): Promise<RpcError> =>
    call.then(
      () => { throw new Error('expected the call to fail'); },
      (err: unknown) => err as RpcError,
    );
  const sequence = (): (() => string) => {
    let seq = 0;
    return () => `req-${++seq}`;
  };

  it('by default sends as many calls at once as the server runs per socket, and holds the next', () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: sequence() });
    const calls = Array.from({ length: RPC_WS_MAX_IN_FLIGHT_PER_CLIENT + 1 }, () =>
      conn.call('reception.endpoints.list' as never, {} as never));
    for (const c of calls) c.catch(() => undefined);
    expect(ids(controls)).toHaveLength(RPC_WS_MAX_IN_FLIGHT_PER_CLIENT);
    expect(conn.pendingCount()).toBe(RPC_WS_MAX_IN_FLIGHT_PER_CLIENT + 1);
    answer(controls, 'req-1', 'one');
    expect(ids(controls)).toHaveLength(RPC_WS_MAX_IN_FLIGHT_PER_CLIENT + 1);
    expect(ids(controls).at(-1)).toBe(`req-${RPC_WS_MAX_IN_FLIGHT_PER_CLIENT + 1}`);
    conn.dispose();
  });

  it('holds calls past the limit and sends each as an earlier one settles, in call order', async () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: sequence(), max_in_flight: 2 });
    const calls = [1, 2, 3, 4].map(() => conn.call('reception.endpoints.list' as never, {} as never));
    expect(ids(controls)).toEqual(['req-1', 'req-2']);
    answer(controls, 'req-2', 'two');
    expect(ids(controls)).toEqual(['req-1', 'req-2', 'req-3']);
    answer(controls, 'req-1', 'one');
    expect(ids(controls)).toEqual(['req-1', 'req-2', 'req-3', 'req-4']);
    answer(controls, 'req-3', 'three');
    answer(controls, 'req-4', 'four');
    await expect(Promise.all(calls)).resolves.toEqual(['one', 'two', 'three', 'four']);
    conn.dispose();
  });

  it('sends a refused call again after a short wait, and the caller only sees the answer', async () => {
    vi.useFakeTimers();
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: () => 'req-1' });
    try {
      let settled: unknown = 'pending';
      const result = conn.call('reception.endpoints.list' as never, {} as never);
      void result.then((v) => { settled = v; }, (e: unknown) => { settled = e; });
      refuse(controls, 'req-1');
      await vi.advanceTimersByTimeAsync(WEBCLIENT_RPC_OVERLOAD_RETRY_INITIAL_MS - 1);
      expect(ids(controls)).toEqual(['req-1']);
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(ids(controls)).toEqual(['req-1', 'req-1']);
      answer(controls, 'req-1', { endpoints: [] });
      await expect(result).resolves.toEqual({ endpoints: [] });
    } finally {
      conn.dispose();
      vi.useRealTimers();
    }
  });

  it('waits twice as long after each refusal, and at the call\'s timeout fails `rpc_overloaded` (it did not run), not `timeout`', async () => {
    vi.useFakeTimers();
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: () => 'req-1', default_timeout_ms: 2_000 });
    try {
      const failed = conn.call('approval.resolve' as never, {} as never).then(
        () => { throw new Error('expected a refusal'); },
        (err: unknown) => err as RpcError,
      );
      refuse(controls, 'req-1'); // t=0
      await vi.advanceTimersByTimeAsync(250); // t=250
      expect(ids(controls)).toHaveLength(2);
      refuse(controls, 'req-1');
      await vi.advanceTimersByTimeAsync(499); // t=749
      expect(ids(controls)).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1); // t=750
      expect(ids(controls)).toHaveLength(3);
      refuse(controls, 'req-1');
      await vi.advanceTimersByTimeAsync(1_000); // t=1750
      expect(ids(controls)).toHaveLength(4);
      refuse(controls, 'req-1');
      await vi.advanceTimersByTimeAsync(250); // t=2000, the call's timeout
      const err = await failed;
      expect(err.code).toBe('rpc_overloaded');
      expect(conn.pendingCount()).toBe(0);
      expect(humanizeRpcError(err)).toBe('Your server is busy right now. Try again in a moment.');
      // The resend that was due at t=3750 never goes out.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ids(controls)).toHaveLength(4);
    } finally {
      conn.dispose();
      vi.useRealTimers();
    }
  });

  it('a refused call keeps its place ahead of calls made after it', async () => {
    vi.useFakeTimers();
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: sequence(), max_in_flight: 1 });
    try {
      const a = conn.call('reception.endpoints.list' as never, {} as never);
      const b = conn.call('reception.endpoints.list' as never, {} as never);
      expect(ids(controls)).toEqual(['req-1']);
      refuse(controls, 'req-1'); // its slot is free, so B goes
      expect(ids(controls)).toEqual(['req-1', 'req-2']);
      const c = conn.call('reception.endpoints.list' as never, {} as never);
      await vi.advanceTimersByTimeAsync(WEBCLIENT_RPC_OVERLOAD_RETRY_INITIAL_MS);
      expect(ids(controls)).toEqual(['req-1', 'req-2']); // A is due; B holds the slot
      answer(controls, 'req-2', 'b');
      expect(ids(controls)).toEqual(['req-1', 'req-2', 'req-1']); // A before C
      answer(controls, 'req-1', 'a');
      expect(ids(controls)).toEqual(['req-1', 'req-2', 'req-1', 'req-3']);
      answer(controls, 'req-3', 'c');
      await expect(Promise.all([a, b, c])).resolves.toEqual(['a', 'b', 'c']);
    } finally {
      conn.dispose();
      vi.useRealTimers();
    }
  });

  it('calls sent on a socket since replaced hold none of the new socket\'s slots', () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: sequence(), max_in_flight: 2 });
    const calls = [1, 2, 3, 4, 5].map(() => conn.call('reception.endpoints.list' as never, {} as never));
    for (const c of calls) c.catch(() => undefined);
    expect(ids(controls)).toEqual(['req-1', 'req-2']);
    // The socket drops. req-1 and req-2 went with it, and their replies can no
    // longer come; counted against the next socket they would hold both of its
    // slots until their own timeouts, and the page would wait 30 s after every
    // reconnect. The waiting calls go to the ws-client's queue for the next
    // socket instead.
    controls.transition('reconnecting');
    expect(ids(controls)).toEqual(['req-1', 'req-2', 'req-3', 'req-4']);
    controls.transition('connected'); // req-3 and req-4 hold its two slots
    expect(ids(controls)).toEqual(['req-1', 'req-2', 'req-3', 'req-4']);
    conn.dispose();
  });

  it('counts calls another listener sends as a socket opens against that socket', () => {
    // The connection-status controller hears `connected` before this conn does,
    // and re-arms its subscriptions at once: those calls are on the NEW socket.
    // Booked to the old one, they let 70 of Settings' calls out at once.
    const controls = buildFakeWs();
    controls.setState('reconnecting');
    let conn: ReturnType<typeof createWebclientRpcConn> | null = null;
    controls.ws.onState((state) => {
      const c = conn;
      if (state !== 'connected' || c === null) return;
      for (let i = 0; i < 3; i += 1) {
        c.call('approval.subscribe' as never, {} as never).catch(() => undefined);
      }
    });
    conn = createWebclientRpcConn({ ws: controls.ws, randomId: sequence(), max_in_flight: 2 });
    controls.transition('connected');
    expect(ids(controls)).toEqual(['req-1', 'req-2']);
    conn.dispose();
  });

  it('calls queued while disconnected count against the socket they will reach', () => {
    const controls = buildFakeWs();
    controls.setState('reconnecting');
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: sequence(), max_in_flight: 2 });
    const calls = [1, 2, 3].map(() => conn.call('reception.endpoints.list' as never, {} as never));
    for (const c of calls) c.catch(() => undefined);
    // Two go into the ws-client's offline queue; the third waits.
    expect(ids(controls)).toEqual(['req-1', 'req-2']);
    controls.transition('connected'); // the queue drains onto this socket
    expect(ids(controls)).toEqual(['req-1', 'req-2']);
    answer(controls, 'req-1', 'one');
    expect(ids(controls)).toEqual(['req-1', 'req-2', 'req-3']);
    conn.dispose();
  });

  it('on going offline, a call still waiting for a slot fails as not delivered and is never sent', async () => {
    const controls = buildFakeWs();
    const status = buildFakeConnStatus('connected');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
      randomId: sequence(),
      max_in_flight: 1,
    });
    const sentCall = failure(conn.call('approval.resolve' as never, {} as never));
    const heldCall = failure(conn.call('approval.resolve' as never, {} as never));
    // A `connected` status marks every call handed over as delivered; the
    // waiting one was not handed over.
    status.set('reconnecting');
    status.set('connected');
    status.set('offline');
    expect((await sentCall).code).toBe('connection_lost');
    expect((await heldCall).code).toBe('server_offline');
    controls.transition('connected');
    expect(ids(controls)).toEqual(['req-1']);
    conn.dispose();
  });

  it('on going offline, a refused call waiting to be sent again fails as not delivered: it did not run', async () => {
    vi.useFakeTimers();
    const controls = buildFakeWs();
    const status = buildFakeConnStatus('connected');
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      connectionStatus: status.status,
      randomId: () => 'req-1',
    });
    try {
      const failed = failure(conn.call('approval.resolve' as never, {} as never));
      refuse(controls, 'req-1');
      status.set('offline');
      expect((await failed).code).toBe('server_offline');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ids(controls)).toEqual(['req-1']);
    } finally {
      conn.dispose();
      vi.useRealTimers();
    }
  });

  it('a call that fails to send, times out or is aborted frees its slot for the next', async () => {
    vi.useFakeTimers();
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: sequence(),
      max_in_flight: 1,
      default_timeout_ms: 1_000,
    });
    try {
      controls.setSendError(new Error('socket write failed'));
      const a = failure(conn.call('reception.endpoints.list' as never, {} as never));
      const b = failure(conn.call('reception.endpoints.list' as never, {} as never));
      const abortC = new AbortController();
      const c = failure(conn.call('reception.endpoints.list' as never, {} as never, { signal: abortC.signal, timeout: 5_000 }));
      const d = conn.call('reception.endpoints.list' as never, {} as never, { timeout: 5_000 });
      expect((await a).code).toBe('transport');
      expect(ids(controls)).toEqual(['req-2']); // A never reached the socket
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await b).code).toBe('timeout');
      expect(ids(controls)).toEqual(['req-2', 'req-3']);
      abortC.abort();
      expect((await c).code).toBe('aborted');
      expect(ids(controls)).toEqual(['req-2', 'req-3', 'req-4']);
      answer(controls, 'req-4', 'd');
      await expect(d).resolves.toBe('d');
    } finally {
      conn.dispose();
      vi.useRealTimers();
    }
  });

  it('a waiting call can be aborted, and is never sent', async () => {
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: sequence(), max_in_flight: 1 });
    const first = conn.call('reception.endpoints.list' as never, {} as never);
    const abort = new AbortController();
    const held = failure(conn.call('reception.endpoints.list' as never, {} as never, { signal: abort.signal }));
    abort.abort();
    expect((await held).code).toBe('aborted');
    answer(controls, 'req-1', 'one');
    await expect(first).resolves.toBe('one');
    expect(ids(controls)).toEqual(['req-1']);
    expect(conn.pendingCount()).toBe(0);
    conn.dispose();
  });

  it('a call that waits out its whole timeout for a slot fails `timeout` and says it was not sent', async () => {
    vi.useFakeTimers();
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({
      ws: controls.ws,
      randomId: sequence(),
      max_in_flight: 1,
      default_timeout_ms: 1_000,
    });
    try {
      const first = conn.call('reception.endpoints.list' as never, {} as never, { timeout: 5_000 });
      const held = failure(conn.call('reception.endpoints.list' as never, {} as never));
      await vi.advanceTimersByTimeAsync(1_000);
      const err = await held;
      expect(err.code).toBe('timeout');
      expect(err.message).toContain('was not sent');
      answer(controls, 'req-1', 'one');
      await expect(first).resolves.toBe('one');
      expect(ids(controls)).toEqual(['req-1']);
    } finally {
      conn.dispose();
      vi.useRealTimers();
    }
  });

  it('dispose fails waiting calls, cancels a due resend and stops following sockets', async () => {
    vi.useFakeTimers();
    const controls = buildFakeWs();
    const conn = createWebclientRpcConn({ ws: controls.ws, randomId: sequence(), max_in_flight: 1 });
    try {
      const calls = [1, 2, 3].map(() =>
        conn.call('reception.endpoints.list' as never, {} as never).catch((e: unknown) => e));
      refuse(controls, 'req-1'); // B goes out; A waits to be sent again; C waits
      expect(ids(controls)).toEqual(['req-1', 'req-2']);
      expect(controls.stateListenerCount()).toBe(1);
      conn.dispose();
      expect(await Promise.all(calls)).toHaveLength(3);
      expect(conn.pendingCount()).toBe(0);
      expect(controls.stateListenerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      controls.transition('connected');
      expect(ids(controls)).toEqual(['req-1', 'req-2']);
    } finally {
      vi.useRealTimers();
    }
  });
});
