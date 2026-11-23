/** D-169 P0 Slice 3 - bridge typed rpc conn acceptance.
 *
 *  Drives `createBridgeRpcConn` through its injected send callback and
 *  explicit `dispatchInbound(...)` path. The coverage mirrors the
 *  webclient rpc conn tests, with bridge-specific assertions for sync
 *  send throws, bootstrap-owned inbound dispatch, typed dispose, and
 *  AbortSignal cleanup after every settle path. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';
import {
  BRIDGE_RPC_DEFAULT_TIMEOUT_MS,
  createBridgeRpcConn,
  type BridgeRpcRequestEnvelope,
  type BridgeRpcResultEnvelope,
} from '../realtime/rpc-conn.js';

type PromiseState =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; reason: unknown };

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const readPromiseState = async <T>(promise: Promise<T>): Promise<PromiseState> => {
  let state: PromiseState = { status: 'pending' };
  promise.then(
    (value) => {
      state = { status: 'fulfilled', value };
    },
    (reason) => {
      state = { status: 'rejected', reason };
    },
  );
  await flushMicrotasks();
  return state;
};

const catchUnhandled = async (
  run: () => void | Promise<void>,
): Promise<unknown[]> => {
  const unhandled: unknown[] = [];
  const handler = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  try {
    await run();
    await flushMicrotasks();
    return unhandled;
  } finally {
    process.off('unhandledRejection', handler);
  }
};

const expectRejected = async <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    (value) => {
      throw new Error(`expected rejection, got ${String(value)}`);
    },
    (err: unknown) => err,
  );

const expectRpcError = (
  err: unknown,
  code: string,
  method: string,
): RpcError => {
  expect(err).toBeInstanceOf(RpcError);
  const rpc = err as RpcError;
  expect(rpc.code).toBe(code);
  expect(rpc.method).toBe(method);
  return rpc;
};

interface ConnFixture {
  conn: ReturnType<typeof createBridgeRpcConn>;
  send: (envelope: BridgeRpcRequestEnvelope) => void;
  sent: () => BridgeRpcRequestEnvelope[];
}

const buildConn = (
  options: {
    default_timeout_ms?: number;
    randomId?: () => string;
    useDefaultRandomId?: boolean;
    send?: (envelope: BridgeRpcRequestEnvelope) => void;
  } = {},
): ConnFixture => {
  const sent: BridgeRpcRequestEnvelope[] = [];
  let seq = 0;
  const send = vi.fn((envelope: BridgeRpcRequestEnvelope) => {
    if (options.send) {
      options.send(envelope);
      return;
    }
    sent.push(envelope);
  });
  const connOptions: Parameters<typeof createBridgeRpcConn>[0] = {
    send,
    default_timeout_ms: options.default_timeout_ms ?? 100,
  };
  if (!options.useDefaultRandomId) {
    connOptions.randomId = options.randomId ?? (() => `req-${++seq}`);
  }
  return {
    conn: createBridgeRpcConn(connOptions),
    send,
    sent: () => sent.slice(),
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('D-169 P0 Slice 3 - createBridgeRpcConn request/reply correlation', () => {
  it('sends rpc envelopes and resolves only the matching rpc_result', async () => {
    const { conn, sent } = buildConn();

    expect(conn.pendingCount()).toBe(0);
    const result = conn.call('some.method' as never, { foo: 'bar' } as never);
    expect(conn.pendingCount()).toBe(1);
    expect(sent()[0]).toEqual({
      type: 'rpc',
      request_id: 'req-1',
      method: 'some.method',
      args: { foo: 'bar' },
    });

    conn.dispatchInbound({ type: 'rpc_result', request_id: 'other', result: 'wrong' });
    expect(conn.pendingCount()).toBe(1);
    expect((await readPromiseState(result)).status).toBe('pending');

    conn.dispatchInbound({
      type: 'rpc_result',
      request_id: 'req-1',
      result: { ok: true },
    });
    await expect(result).resolves.toEqual({ ok: true });
    expect(conn.pendingCount()).toBe(0);
  });

  it('rejects with typed RpcError fields from a matching error reply', async () => {
    const { conn } = buildConn();
    const result = conn.call('some.errorMethod' as never, { foo: 'bar' } as never);

    conn.dispatchInbound({
      type: 'rpc_result',
      request_id: 'req-1',
      error: {
        code: 'preview_required',
        message: 'preview must precede create',
        status: 400,
        details: { hint: 'call preview first' },
      },
    });

    const err = expectRpcError(
      await expectRejected(result),
      'preview_required',
      'some.errorMethod',
    );
    expect(err.message).toBe('preview must precede create');
    expect(err.status).toBe(400);
    expect(err.details).toEqual({ hint: 'call preview first' });
    expect(conn.pendingCount()).toBe(0);
  });
});

describe('D-169 P0 Slice 3 - createBridgeRpcConn args and ids', () => {
  it('defaults undefined and null payloads to empty args', async () => {
    const { conn, sent } = buildConn();

    const undefinedPayload = conn.call('args.undefined' as never, undefined as never);
    expect(sent()[0].args).toEqual({});
    conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-1', result: 'ok' });
    await expect(undefinedPayload).resolves.toBe('ok');

    const nullPayload = conn.call('args.null' as never, null as never);
    expect(sent()[1].args).toEqual({});
    conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-2', result: 'ok' });
    await expect(nullPayload).resolves.toBe('ok');
  });

  it('forwards object payloads verbatim', async () => {
    const { conn, sent } = buildConn();
    const payload = { foo: 'bar', nested: { n: 1 } };

    const result = conn.call('args.object' as never, payload as never);
    expect(sent()[0].args).toBe(payload);
    conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-1', result: 'ok' });
    await expect(result).resolves.toBe('ok');
  });

  it('honors deterministic randomId injection', async () => {
    const ids = ['seq-a', 'seq-b'];
    const { conn, sent } = buildConn({ randomId: () => ids.shift() ?? 'seq-c' });

    const first = conn.call('ids.one' as never, {} as never);
    const second = conn.call('ids.two' as never, {} as never);

    expect(sent().map((e) => e.request_id)).toEqual(['seq-a', 'seq-b']);
    conn.dispatchInbound({ type: 'rpc_result', request_id: 'seq-a', result: 1 });
    conn.dispatchInbound({ type: 'rpc_result', request_id: 'seq-b', result: 2 });
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  it('uses crypto.randomUUID on the default id path', async () => {
    const randomUUID = vi.fn(() => 'crypto-req');
    vi.stubGlobal('crypto', { randomUUID });
    const { conn, sent } = buildConn({ useDefaultRandomId: true });

    const result = conn.call('ids.crypto' as never, {} as never);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(sent()[0].request_id).toBe('crypto-req');

    conn.dispatchInbound({ type: 'rpc_result', request_id: 'crypto-req', result: 'ok' });
    await expect(result).resolves.toBe('ok');
  });

  it('keeps Conn<R> type projection callable at runtime', async () => {
    const { conn, sent } = buildConn({ randomId: () => 'typed-req' });

    const result = conn.call('some.method' as never, { foo: 'bar' } as never);
    expect(sent()[0]).toMatchObject({
      type: 'rpc',
      request_id: 'typed-req',
      method: 'some.method',
      args: { foo: 'bar' },
    });

    conn.dispatchInbound({ type: 'rpc_result', request_id: 'typed-req', result: { ok: true } });
    await expect(result).resolves.toEqual({ ok: true });
  });
});

describe('D-169 P0 Slice 3 - createBridgeRpcConn timeout and abort', () => {
  it('rejects with RpcError("timeout") after the configured default timeout', async () => {
    vi.useFakeTimers();
    const { conn } = buildConn({ default_timeout_ms: 100 });
    const ctrl = new AbortController();
    const result = conn.call(
      'slow.method' as never,
      {} as never,
      { signal: ctrl.signal },
    );
    const rejected = expectRejected(result);

    expect(conn.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(conn.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const err = expectRpcError(await rejected, 'timeout', 'slow.method');
    expect(err.message).toContain('100ms');
    expect(conn.pendingCount()).toBe(0);

    const before = await readPromiseState(result);
    const unhandled = await catchUnhandled(async () => {
      ctrl.abort();
      await flushMicrotasks();
    });
    const after = await readPromiseState(result);
    expect(unhandled).toEqual([]);
    expect(after.status).toBe(before.status);
    expectRpcError((after as { reason: unknown }).reason, 'timeout', 'slow.method');

    expect(() =>
      conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-1', result: 'late' }),
    ).not.toThrow();
  });

  it('rejects pre-aborted calls immediately and never invokes send', async () => {
    const { conn, send } = buildConn();
    const ctrl = new AbortController();
    ctrl.abort();

    const result = conn.call(
      'abort.before' as never,
      {} as never,
      { signal: ctrl.signal },
    );

    expectRpcError(await expectRejected(result), 'aborted', 'abort.before');
    expect(send).not.toHaveBeenCalled();
    expect(conn.pendingCount()).toBe(0);
  });

  it('rejects mid-flight aborts with RpcError("aborted")', async () => {
    const { conn } = buildConn();
    const ctrl = new AbortController();
    const result = conn.call(
      'abort.midflight' as never,
      {} as never,
      { signal: ctrl.signal },
    );
    const rejected = expectRejected(result);

    expect(conn.pendingCount()).toBe(1);
    ctrl.abort();

    expectRpcError(await rejected, 'aborted', 'abort.midflight');
    expect(conn.pendingCount()).toBe(0);

    const before = await readPromiseState(result);
    const unhandled = await catchUnhandled(async () => {
      ctrl.abort();
      await flushMicrotasks();
    });
    const after = await readPromiseState(result);
    expect(unhandled).toEqual([]);
    expect(after.status).toBe(before.status);
    expectRpcError((after as { reason: unknown }).reason, 'aborted', 'abort.midflight');
  });

  it('post-settle abort is inert after resolve and error-reply settle paths', async () => {
    const { conn } = buildConn();

    const resolveCtrl = new AbortController();
    const resolved = conn.call(
      'abort.afterResolve' as never,
      {} as never,
      { signal: resolveCtrl.signal },
    );
    conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-1', result: { ok: true } });
    await expect(resolved).resolves.toEqual({ ok: true });
    expect(conn.pendingCount()).toBe(0);
    expect(await catchUnhandled(async () => resolveCtrl.abort())).toEqual([]);
    await expect(resolved).resolves.toEqual({ ok: true });

    const rejectCtrl = new AbortController();
    const rejected = conn.call(
      'abort.afterError' as never,
      {} as never,
      { signal: rejectCtrl.signal },
    );
    const captured = expectRejected(rejected);
    conn.dispatchInbound({
      type: 'rpc_result',
      request_id: 'req-2',
      error: { code: 'remote_error', message: 'remote failed' },
    });
    expectRpcError(await captured, 'remote_error', 'abort.afterError');
    expect(conn.pendingCount()).toBe(0);
    expect(await catchUnhandled(async () => rejectCtrl.abort())).toEqual([]);
    expectRpcError(await expectRejected(rejected), 'remote_error', 'abort.afterError');
  });
});

describe('Bridge RPC connection loss', () => {
  it('rejects pending calls with unknown outcomes, releases their resources and accepts fresh calls', async () => {
    vi.useFakeTimers();
    const { conn, sent } = buildConn({ default_timeout_ms: 1_000 });
    const firstAbort = new AbortController(), secondAbort = new AbortController();
    const removeFirst = vi.spyOn(firstAbort.signal, 'removeEventListener');
    const removeSecond = vi.spyOn(secondAbort.signal, 'removeEventListener');
    const first = conn.call('lost.write' as never, {} as never, { signal: firstAbort.signal });
    const second = conn.call('lost.read' as never, {} as never, { signal: secondAbort.signal });
    const firstRejected = expectRejected(first), secondRejected = expectRejected(second);
    try {
      expect(conn.pendingCount()).toBe(2);
      conn.transportDisconnected();
      conn.transportDisconnected();
      const error = expectRpcError(await firstRejected, 'connection_lost', 'lost.write');
      expect(error.message).toContain('outcome is unknown');
      expectRpcError(await secondRejected, 'connection_lost', 'lost.read');
      expect(conn.pendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(removeFirst).toHaveBeenCalledOnce();
      expect(removeSecond).toHaveBeenCalledOnce();

      const fresh = conn.call('fresh.call' as never, {} as never);
      // A late success or failure from the old connection must not settle the new call.
      conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-1', result: 'old success' });
      conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-2', error: { code: 'old', message: 'old error' } });
      expect((await readPromiseState(fresh)).status).toBe('pending');
      expect(conn.pendingCount()).toBe(1);
      conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-3', result: 'fresh result' });
      await expect(fresh).resolves.toBe('fresh result');
      firstAbort.abort();
      secondAbort.abort();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(conn.pendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(sent().map(entry => entry.method)).toEqual(['lost.write', 'lost.read', 'fresh.call']);
    } finally {
      conn.dispose();
    }
  });
});

describe('D-169 P0 Slice 3 - createBridgeRpcConn dispose', () => {
  it('rejects all in-flight callers with typed transport_disposed and is idempotent', async () => {
    const { conn } = buildConn();
    const one = conn.call('dispose.one' as never, {} as never);
    const two = conn.call('dispose.two' as never, {} as never);
    const observed: unknown[] = [];
    const oneRejected = one.catch((err: unknown) => {
      observed.push(err);
      return err;
    });
    const twoRejected = expectRejected(two);

    expect(conn.pendingCount()).toBe(2);
    conn.dispose();
    conn.dispose();

    expectRpcError(await oneRejected, 'transport_disposed', 'dispose.one');
    expectRpcError(await twoRejected, 'transport_disposed', 'dispose.two');
    expect(observed).toHaveLength(1);
    expect(conn.pendingCount()).toBe(0);

    expect(() =>
      conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-1', result: 'late' }),
    ).not.toThrow();
  });

  it('rejects calls after dispose and leaves pendingCount at zero', async () => {
    const { conn } = buildConn();
    conn.dispose();

    const err = expectRpcError(
      await expectRejected(conn.call('dispose.after' as never, {} as never)),
      'transport_disposed',
      'dispose.after',
    );
    expect(err.message).toBe('bridge rpc conn is disposed');
    expect(conn.pendingCount()).toBe(0);
  });
});

describe('D-169 P0 Slice 3 - createBridgeRpcConn send errors', () => {
  it('maps Error throws from send to RpcError("transport") and clears pending', async () => {
    const { conn } = buildConn({
      send: () => {
        throw new Error('socket closed mid-write');
      },
    });

    const result = conn.call('send.error' as never, {} as never);
    const err = expectRpcError(await expectRejected(result), 'transport', 'send.error');
    expect(err.message).toBe('socket closed mid-write');
    expect(conn.pendingCount()).toBe(0);
  });

  it('maps non-Error throws from send with String(err) and clears pending', async () => {
    const { conn } = buildConn({
      send: () => {
        throw 'bridge offline';
      },
    });

    const result = conn.call('send.string' as never, {} as never);
    const err = expectRpcError(await expectRejected(result), 'transport', 'send.string');
    expect(err.message).toBe('bridge offline');
    expect(conn.pendingCount()).toBe(0);
  });
});

describe('D-169 P0 Slice 3 - createBridgeRpcConn inbound edge cases', () => {
  it('ignores non-rpc_result frames and unknown request ids without settling', async () => {
    const { conn } = buildConn();
    const result = conn.call('edge.pending' as never, {} as never);

    expect(() => conn.dispatchInbound({ kind: 'command', command: {} })).not.toThrow();
    expect(() =>
      conn.dispatchInbound({ type: 'rpc_result', request_id: 'unknown', result: 'late' }),
    ).not.toThrow();
    expect(conn.pendingCount()).toBe(1);
    expect((await readPromiseState(result)).status).toBe('pending');

    conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-1', result: 'ok' });
    await expect(result).resolves.toBe('ok');
    expect(conn.pendingCount()).toBe(0);
  });

  it.each([
    [{}],
    [{ code: 123, message: null }],
  ])('maps malformed error envelope %j to rpc_unknown', async (error) => {
    const { conn } = buildConn();
    const result = conn.call('edge.malformedError' as never, {} as never);

    conn.dispatchInbound({
      type: 'rpc_result',
      request_id: 'req-1',
      error,
    } as BridgeRpcResultEnvelope);

    const err = expectRpcError(
      await expectRejected(result),
      'rpc_unknown',
      'edge.malformedError',
    );
    expect(err.message).toBe('rpc reply carried malformed error envelope');
    expect(conn.pendingCount()).toBe(0);
  });

  it('resolves undefined when a matching reply carries neither error nor result', async () => {
    const { conn } = buildConn();
    const result = conn.call('edge.undefinedResult' as never, {} as never);

    conn.dispatchInbound({ type: 'rpc_result', request_id: 'req-1' });

    await expect(result).resolves.toBeUndefined();
    expect(conn.pendingCount()).toBe(0);
  });

  it('exposes the default timeout constant used by production callers', () => {
    expect(BRIDGE_RPC_DEFAULT_TIMEOUT_MS).toBe(30_000);
  });
});
