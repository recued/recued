/** D-169 P0 follow-on - WS-upgrade bridge registry attach wiring. */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import type { BridgeCapabilityProfile } from '@recued/contracts';

import { createServerHandlerSet } from '../server.js';
import {
  createClientTokenStore,
  type ClientKind,
  type ClientTokenStore,
} from '../pairing/client-tokens.js';
import {
  createBridgeRegistry,
  type BridgeRegistry,
} from '../bridges/registry.js';

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };

const EMPTY_BRIDGE_CAPABILITIES: BridgeCapabilityProfile = {
  software_version: '',
  chrome_version: '',
  permissions_granted: [],
  granted_origins: [],
  offscreen_supported: false,
  alarms_supported: false,
};

const UPDATED_BRIDGE_CAPABILITIES: BridgeCapabilityProfile = {
  software_version: '1.2.3',
  chrome_version: '126.0.6478.0',
  permissions_granted: ['storage', 'tabs'],
  granted_origins: ['*://app.hubspot.com/*'],
  offscreen_supported: true,
  alarms_supported: true,
  user_agent: 'recued-bridge-test',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MemorySocket extends Duplex {
  peer: MemorySocket | undefined;
  remoteAddress = '127.0.0.1';
  remotePort = 12345;
  localAddress = '127.0.0.1';
  localPort = 80;

  _read(): void {
    // Peer writes push directly into this readable side.
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.peer && !this.peer.destroyed) {
      this.peer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) {
      this.peer.push(null);
    }
    callback();
  }

  setTimeout(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }
}

const createSocketPair = (): { client: MemorySocket; server: MemorySocket } => {
  const client = new MemorySocket();
  const server = new MemorySocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
};

const connectWs = (httpServer: HttpServer, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1/ws?token=${encodeURIComponent(token)}`,
      {
        createConnection: () => {
          const pair = createSocketPair();
          process.nextTick(() => {
            httpServer.emit('connection', pair.server as unknown as Socket);
          });
          return pair.client as unknown as Socket;
        },
      },
    );
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      resolve(ws);
    });
    ws.once('error', fail);
    ws.once('unexpected-response', (_req, res) => {
      fail(new Error(`unexpected response ${res.statusCode}`));
    });
  });

const waitForClose = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
  });

const closeWs = async (ws: WebSocket): Promise<void> => {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = waitForClose(ws);
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
  await closed;
};

const waitFor = async <T>(
  read: () => T,
  done: (value: T) => boolean,
  label: string,
): Promise<T> => {
  const deadline = Date.now() + 1_500;
  let last = read();
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
    }
    await wait(10);
    last = read();
  }
  return last;
};

const waitForMessage = (
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('waitForMessage timeout'));
    }, 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(msg)) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });

const rpcCall = async (
  ws: WebSocket,
  request_id: string,
  method: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const reply = waitForMessage(
    ws,
    (msg) => msg.type === 'rpc_result' && msg.request_id === request_id,
  );
  ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
  return reply;
};

describe('D-169 P0 follow-on - WS upgrade bridgeRegistry.attach', () => {
  let handlerSet: ReturnType<typeof createServerHandlerSet> | undefined;
  let httpServer: HttpServer | undefined;
  let db: Database.Database | undefined;
  let clientTokens: ClientTokenStore;
  let bridgeRegistry: BridgeRegistry;
  const openSockets = new Set<WebSocket>();

  const currentHandlerSet = (): ReturnType<typeof createServerHandlerSet> => {
    if (!handlerSet) throw new Error('test handler set was not started');
    return handlerSet;
  };

  const currentHttpServer = (): HttpServer => {
    if (!httpServer) throw new Error('test http server was not started');
    return httpServer;
  };

  beforeAll(async () => {
    db = new Database(':memory:');
    clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    bridgeRegistry = createBridgeRegistry();
    handlerSet = createServerHandlerSet({
      clientTokens,
      bridgeCapabilityDeps: { registry: bridgeRegistry },
      bridgeRegistry,
    });
    httpServer = createHttpServer();
    const wsUpgrade = currentHandlerSet().upgradeHandlers.ws;
    if (!wsUpgrade) throw new Error('ws upgrade handler not composed');
    httpServer.on('upgrade', wsUpgrade);
    currentHandlerSet().wsHandle.maxInstances = 0;
  });

  beforeEach(() => {
    bridgeRegistry.clear();
  });

  afterEach(async () => {
    for (const ws of [...openSockets]) {
      await closeWs(ws);
    }
    openSockets.clear();
    handlerSet?.wsHandle.revokeAllConnectedInstances();
    await wait(20);
    bridgeRegistry.clear();
  });

  afterAll(async () => {
    handlerSet?.close();
    httpServer?.removeAllListeners();
    db?.close();
  });

  const issueStructured = async (
    client_kind: ClientKind,
    client_label?: string,
  ): Promise<{ token_id: string; bearer: string; structured: string }> => {
    const opts: { client_kind: ClientKind; client_label?: string } = { client_kind };
    if (client_label !== undefined) opts.client_label = client_label;
    const issued = await clientTokens.issue(opts);
    return {
      ...issued,
      structured: `${issued.token_id}.${issued.bearer}`,
    };
  };

  const connectStructured = async (
    client_kind: ClientKind,
    client_label?: string,
  ): Promise<{ ws: WebSocket; token_id: string; bearer: string }> => {
    const issued = await issueStructured(client_kind, client_label);
    const ws = await connectWs(currentHttpServer(), issued.structured);
    openSockets.add(ws);
    ws.once('close', () => openSockets.delete(ws));
    return { ws, token_id: issued.token_id, bearer: issued.bearer };
  };

  const waitForRegistrySize = (size: number) =>
    waitFor(
      () => bridgeRegistry.list(),
      (records) => records.length === size,
      `bridge registry size ${size}`,
    );

  const registerInstance = async (
    ws: WebSocket,
    instance_id: string,
  ): Promise<void> => {
    const registered = waitForMessage(
      ws,
      (msg) => msg.type === 'registered' && msg.instance_id === instance_id,
    );
    ws.send(JSON.stringify({
      type: 'register',
      instance_id,
      display_name: 'Test bridge',
    }));
    await registered;
  };

  it('attaches one registry record for a structured client_kind=bridge upgrade', async () => {
    const before = Date.now();
    const { ws, token_id } = await connectStructured('bridge', 'Kitchen bridge');
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const records = await waitForRegistrySize(1);
    const after = Date.now();
    const record = records[0]!;
    expect(record.client_token_id).toBe(token_id);
    expect(record.client_label).toBe('Kitchen bridge');
    expect(record.session_id).toMatch(UUID_RE);
    expect(record.online_since).toBeGreaterThanOrEqual(before - 1_000);
    expect(record.online_since).toBeLessThanOrEqual(after + 1_000);
    expect(record.last_seen_at).toBe(record.online_since);
    expect(record.capabilities).toEqual(EMPTY_BRIDGE_CAPABILITIES);
  });

  it('updates the attached registry record via bridge.capabilityProfile.push', async () => {
    const { ws, token_id } = await connectStructured('bridge', 'Capability bridge');
    const [attached] = await waitForRegistrySize(1);

    const beforePush = Date.now();
    const reply = await rpcCall(
      ws,
      'bridge-cap-1',
      'bridge.capabilityProfile.push',
      { profile: UPDATED_BRIDGE_CAPABILITIES },
    );

    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ ok: true });
    const record = bridgeRegistry.get(token_id);
    expect(record).not.toBeNull();
    expect(record?.capabilities).toEqual(UPDATED_BRIDGE_CAPABILITIES);
    expect(record?.session_id).toBe(attached.session_id);
    expect(record?.online_since).toBe(attached.online_since);
    expect(record?.last_seen_at).toBeGreaterThanOrEqual(beforePush - 1_000);
  });

  it('does not attach a structured client_kind=webclient upgrade', async () => {
    const { ws } = await connectStructured('webclient', 'Browser');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await wait(20);
    expect(bridgeRegistry.list()).toEqual([]);
  });

  it('does not attach a structured client_kind=cli upgrade', async () => {
    const { ws } = await connectStructured('cli', 'CLI');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await wait(20);
    expect(bridgeRegistry.list()).toEqual([]);
  });

  it('rejects a legacy raw-bearer upgrade', async () => {
    await expect(connectWs(currentHttpServer(), 'somerawbearer')).rejects.toThrow(
      /unexpected response 401|Unexpected server response: 401/,
    );
    await wait(20);
    expect(bridgeRegistry.list()).toEqual([]);
  });

  it('detaches the bridge registry record on normal websocket close', async () => {
    const { ws } = await connectStructured('bridge', 'Normal close bridge');
    await waitForRegistrySize(1);

    await closeWs(ws);
    await waitForRegistrySize(0);
  });

  it('detaches when revokeConnectedInstance closes a registered bridge instance', async () => {
    const { ws, token_id } = await connectStructured('bridge', 'Revoked bridge');
    await waitForRegistrySize(1);
    await registerInstance(ws, 'bridge-instance-revoked');

    const closed = waitForClose(ws);
    const result = currentHandlerSet().wsHandle.revokeConnectedInstance('bridge-instance-revoked');
    expect(result).toEqual({ revoked: true, client_token_id: token_id });
    await closed;
    await waitForRegistrySize(0);
  });

  it('detaches when revokeAllConnectedInstances closes the bridge socket', async () => {
    const { ws } = await connectStructured('bridge', 'Revoke all bridge');
    await waitForRegistrySize(1);

    const closed = waitForClose(ws);
    expect(currentHandlerSet().wsHandle.revokeAllConnectedInstances()).toBe(1);
    await closed;
    await waitForRegistrySize(0);
  });

  it('detaches when closeAllForWsLockout closes the bridge socket', async () => {
    const { ws } = await connectStructured('bridge', 'Lockout bridge');
    await waitForRegistrySize(1);

    const closed = waitForClose(ws);
    expect(currentHandlerSet().wsHandle.closeAllForWsLockout('manual lockout')).toBe(1);
    await closed;
    await waitForRegistrySize(0);
  });

  it('keeps a newer reconnect record when the old bridge socket closes later', async () => {
    const { ws, token_id } = await connectStructured('bridge', 'Race bridge');
    const [first] = await waitForRegistrySize(1);
    const secondSessionId = randomUUID();
    bridgeRegistry.attach({
      ...first,
      session_id: secondSessionId,
      online_since: first.online_since + 1,
      last_seen_at: first.last_seen_at + 1,
    });

    await closeWs(ws);
    await waitFor(
      () => currentHandlerSet().wsHandle.clientCount(),
      (count) => count === 0,
      'old bridge websocket close processed',
    );

    const record = await waitFor(
      () => bridgeRegistry.get(token_id),
      (current) => current?.session_id === secondSessionId,
      'newer bridge registry session',
    );
    expect(record?.client_token_id).toBe(token_id);
    expect(record?.client_label).toBe('Race bridge');
    expect(record?.session_id).toBe(secondSessionId);
  });
});
