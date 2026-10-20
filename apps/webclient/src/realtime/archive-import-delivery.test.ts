import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebclientWsClient, type WebclientWsState, type WebclientWsTransport } from './ws-client.js';
import { createWebclientRpcConn } from './rpc-conn.js';

const INPUT = { path: 'fixture.recued.archive', recoveryKey: 'synthetic fixture key', dry_run: false };
afterEach(() => { vi.useRealTimers(); });
const channel = async (lateFailure: boolean) => {
  const states = new Set<(state: WebclientWsState) => void>();
  const messages = new Set<(message: unknown) => void>();
  const sent: unknown[] = [];
  const state = (next: WebclientWsState) => { for (const listener of states) listener(next); };
  let reject!: (error: Error) => void;
  const transport: WebclientWsTransport = {
    async open() { state('connected'); }, async close() {},
    async send(message) { sent.push(message); if (lateFailure) await new Promise<void>((_resolve, fail) => { reject = fail; }); },
    onState(listener) { states.add(listener); return () => { states.delete(listener); }; },
    onMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
  };
  const ws = createWebclientWsClient({ transport, resolveBearer: async () => 'fixture',
    resolveServerUrl: async () => 'ws://fixture.test/ws', random: () => 0.5 });
  await ws.connect(); return { ws, sent, state, rejectSend: (error: Error) => reject(error), states, messages };
};

describe('destructive archive RPC delivery', () => {
  it('never queues an import during the ordinary reconnect grace window', async () => {
    vi.useFakeTimers(); const c = await channel(false);
    const rpc = createWebclientRpcConn({ ws: c.ws, nonReplayMethods: new Set(['server.archive.import']),
      connectionStatus: { status: () => 'reconnecting', onStatus: () => () => {} } });
    try {
      c.state('reconnecting');
      await expect(rpc.call('server.archive.import', INPUT)).rejects.toMatchObject({ code: 'server_offline' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(c.sent).toEqual([]); expect(c.ws.queuedSends()).toBe(0); expect(rpc.pendingCount()).toBe(0);
    } finally { rpc.dispose(); await c.ws.disconnect(); }
    expect(c.states.size).toBe(0); expect(c.messages.size).toBe(0);
  });

  it('cannot resurrect an abandoned import when a connected send rejects after the offline sweep', async () => {
    vi.useFakeTimers(); const c = await channel(true);
    const rpc = createWebclientRpcConn({ ws: c.ws, nonReplayMethods: new Set(['server.archive.import']),
      connectionStatus: { status: () => c.ws.state() === 'connected' ? 'connected' : 'offline',
        onStatus: listener => c.ws.onState(state => listener(state === 'connected' ? 'connected' : 'offline')) } });
    try {
      const outcome = rpc.call('server.archive.import', INPUT).catch(error => error.code);
      expect(c.sent).toHaveLength(1); c.state('reconnecting');
      expect(await outcome).toBe('connection_lost');
      c.rejectSend(new Error('late failed send')); await vi.advanceTimersByTimeAsync(2000);
      expect(c.sent).toHaveLength(1); expect(c.ws.queuedSends()).toBe(0); expect(rpc.pendingCount()).toBe(0);
    } finally { rpc.dispose(); await c.ws.disconnect(); }
    expect(c.states.size).toBe(0); expect(c.messages.size).toBe(0);
  });
});
