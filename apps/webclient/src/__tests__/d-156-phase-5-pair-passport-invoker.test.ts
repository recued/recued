/** D-156 P5 — pair-passport-invoker (one-shot passport.fetch) tests.
 *
 *  Drives `createWebclientPairPassportInvoker` through the documented
 *  paths — happy-path open/send/receive/close, rpc error response,
 *  timeout, transport drop — using a deterministic fake transport
 *  that mirrors the WebclientWsTransport shape (the same fake the
 *  pair-consume-invoker tests use, adapted for the passport-fetch
 *  envelope shape).
 */

import { describe, it, expect, vi } from 'vitest';
import type { ServerPassportProjection } from '@recued/contracts';

import {
  createWebclientPairPassportInvoker,
  PairPassportRpcError,
} from '../auth/pair-passport-invoker.js';
import type {
  WebclientWsState,
  WebclientWsTransport,
} from '../realtime/ws-client.js';

// ════════════════════════════════════════════════════════════════
// Fake transport
// ════════════════════════════════════════════════════════════════

interface FakeTransport extends WebclientWsTransport {
  sent: unknown[];
  pushMessage(m: unknown): void;
  openArgs: Array<{ server_url: string; bearer: string }>;
  openResolved: boolean;
  closeCalled: number;
}

const makeFakeTransport = (
  options: { failOpen?: Error; delayOpenMs?: number } = {},
): FakeTransport => {
  const sent: unknown[] = [];
  const openArgs: Array<{ server_url: string; bearer: string }> = [];
  const messageListeners = new Set<(m: unknown) => void>();
  const stateListeners = new Set<(s: WebclientWsState) => void>();
  let closeCalled = 0;
  let openResolved = false;

  const transport: FakeTransport = {
    sent,
    openArgs,
    get openResolved() {
      return openResolved;
    },
    get closeCalled() {
      return closeCalled;
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    async open(args) {
      openArgs.push(args);
      if (options.failOpen) throw options.failOpen;
      if (options.delayOpenMs) {
        await new Promise((r) => setTimeout(r, options.delayOpenMs));
      }
      openResolved = true;
    },
    async send(envelope) {
      sent.push(envelope);
    },
    async close() {
      closeCalled++;
    },
    pushMessage(m) {
      for (const fn of [...messageListeners]) fn(m);
    },
  };
  return transport;
};

const buildPassport = (): ServerPassportProjection =>
  ({
    identity: { server_public_key: 'PUBKEY', current_handle: 'alice' },
    network: { cert_fingerprint: 'CF1', cert_expires_at: 2_000_000_000 },
  }) as unknown as ServerPassportProjection;

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('createWebclientPairPassportInvoker — happy path', () => {
  it('opens transport with server_url + bearer, sends passport.fetch envelope, resolves with response', async () => {
    const transport = makeFakeTransport();
    const invoke = createWebclientPairPassportInvoker({
      transportFactory: () => transport,
      randomId: () => 'req-fixed',
    });
    const promise = invoke({
      server_url: 'wss://alice.example/ws',
      bearer: 'realm-bearer',
    });
    // Yield so the open() resolves + the send() lands.
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.openArgs).toEqual([
      { server_url: 'wss://alice.example/ws', bearer: 'realm-bearer' },
    ]);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toEqual({
      type: 'rpc',
      request_id: 'req-fixed',
      method: 'passport.fetch',
      args: {},
    });

    transport.pushMessage({
      type: 'rpc_result',
      request_id: 'req-fixed',
      result: { passport: buildPassport() },
    });
    const response = await promise;
    expect(response.passport).toEqual(buildPassport());
    expect(transport.closeCalled).toBe(1);
  });

  it('ignores stray rpc_result envelopes with non-matching request_id', async () => {
    const transport = makeFakeTransport();
    const invoke = createWebclientPairPassportInvoker({
      transportFactory: () => transport,
      randomId: () => 'req-A',
    });
    const promise = invoke({ server_url: 'wss://x', bearer: 'b' });
    await new Promise((r) => setTimeout(r, 0));
    // Wrong request_id — should be ignored.
    transport.pushMessage({
      type: 'rpc_result',
      request_id: 'req-B',
      result: { passport: buildPassport() },
    });
    // Matching response — should resolve.
    transport.pushMessage({
      type: 'rpc_result',
      request_id: 'req-A',
      result: { passport: buildPassport() },
    });
    const response = await promise;
    expect(response.passport).toBeDefined();
  });
});

describe('createWebclientPairPassportInvoker — failure modes', () => {
  it('rejects with PairPassportRpcError on rpc-error response', async () => {
    const transport = makeFakeTransport();
    const invoke = createWebclientPairPassportInvoker({
      transportFactory: () => transport,
      randomId: () => 'req-X',
    });
    const promise = invoke({ server_url: 'wss://x', bearer: 'b' });
    await new Promise((r) => setTimeout(r, 0));
    transport.pushMessage({
      type: 'rpc_result',
      request_id: 'req-X',
      error: {
        code: 'not_configured',
        message: 'passport providers not composed',
      },
    });
    await expect(promise).rejects.toBeInstanceOf(PairPassportRpcError);
    await expect(promise).rejects.toMatchObject({
      code: 'not_configured',
      message: 'passport providers not composed',
    });
    expect(transport.closeCalled).toBe(1);
  });

  it('rejects with Error when rpc_result carries neither result nor error', async () => {
    const transport = makeFakeTransport();
    const invoke = createWebclientPairPassportInvoker({
      transportFactory: () => transport,
      randomId: () => 'req-Y',
    });
    const promise = invoke({ server_url: 'wss://x', bearer: 'b' });
    await new Promise((r) => setTimeout(r, 0));
    transport.pushMessage({
      type: 'rpc_result',
      request_id: 'req-Y',
    });
    await expect(promise).rejects.toThrow(
      /carried neither result nor error/,
    );
    expect(transport.closeCalled).toBe(1);
  });

  it('rejects on transport.open failure', async () => {
    const transport = makeFakeTransport({
      failOpen: new Error('handshake refused'),
    });
    const invoke = createWebclientPairPassportInvoker({
      transportFactory: () => transport,
    });
    await expect(
      invoke({ server_url: 'wss://x', bearer: 'b' }),
    ).rejects.toThrow(/handshake refused/);
    // open() rejected before send() ran.
    expect(transport.sent).toHaveLength(0);
    expect(transport.closeCalled).toBe(1);
  });

  it('rejects on timeout when server never replies', async () => {
    const transport = makeFakeTransport();
    const invoke = createWebclientPairPassportInvoker({
      transportFactory: () => transport,
      timeout_ms: 5,
      randomId: () => 'req-T',
    });
    await expect(
      invoke({ server_url: 'wss://x', bearer: 'b' }),
    ).rejects.toThrow(/did not respond within 5ms/);
    expect(transport.closeCalled).toBe(1);
  });

  it('does not ship envelope when timer fires during handshake (Codex parity fold)', async () => {
    const transport = makeFakeTransport({ delayOpenMs: 20 });
    const invoke = createWebclientPairPassportInvoker({
      transportFactory: () => transport,
      timeout_ms: 5,
      randomId: () => 'req-Z',
    });
    await expect(
      invoke({ server_url: 'wss://x', bearer: 'b' }),
    ).rejects.toThrow(/did not respond within 5ms/);
    // open() resolved AFTER the timer fired; the envelope must NOT
    // ship (mirrors pair-consume-invoker's same fold).
    expect(transport.sent).toHaveLength(0);
    expect(transport.closeCalled).toBe(1);
  });
});

describe('PairPassportRpcError', () => {
  it('carries code + status + details from the error envelope', () => {
    const err = new PairPassportRpcError('forbidden', 'no auth', 403, {
      origin: 'rpc',
    });
    expect(err.code).toBe('forbidden');
    expect(err.message).toBe('no auth');
    expect(err.status).toBe(403);
    expect(err.details).toEqual({ origin: 'rpc' });
  });
});
