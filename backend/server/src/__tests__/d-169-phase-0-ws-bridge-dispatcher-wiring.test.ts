/** D-169 P0 follow-on - WS bridge dispatcher production wiring tests. */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import type {
  BridgeCapabilityProfile,
  BridgeIngredientRef,
  BridgeResult,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import { createServerHandlerSet } from '../server.js';
import {
  createClientTokenStore,
  type ClientKind,
  type ClientTokenStore,
} from '../pairing/client-tokens.js';
import {
  createBridgeRegistry,
  type BridgeConnectionRecord,
  type BridgeRegistry,
} from '../bridges/registry.js';
import {
  createBridgeDispatcher,
  createBridgeResultListener,
  type BridgeDispatcher,
  type BridgeTransport,
  type BridgeWireEnvelope,
  type DispatchRequest,
} from '../bridges/dispatcher.js';

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };
const TARGET_PATTERN = '*://app.hubspot.com/*';
const ORIGINAL_WSS_EMIT = WebSocketServer.prototype.emit;

const BRIDGE_CAPABILITIES: BridgeCapabilityProfile = {
  software_version: '1.2.3',
  chrome_version: '126.0.6478.0',
  permissions_granted: ['storage', 'tabs'],
  granted_origins: [TARGET_PATTERN],
  offscreen_supported: true,
  alarms_supported: true,
  user_agent: 'recued-bridge-dispatcher-wiring-test',
};

const SAMPLE_INGREDIENT: BridgeIngredientRef = {
  publisher_id: 'recued-core',
  slug: 'draft-email-reader-hubspot',
  version: '1.0.0',
  surface_kind: 'reading',
  domain_allowlist: [TARGET_PATTERN],
  domain_allowlist_signature: 'PUB',
};

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

const captureNextServerWs = (): Promise<WebSocket> => {
  const originalEmit = WebSocketServer.prototype.emit;
  return new Promise((resolve) => {
    WebSocketServer.prototype.emit = function patchedEmit(
      this: WebSocketServer,
      eventName: string | symbol,
      ...args: unknown[]
    ): boolean {
      if (eventName === 'connection') {
        WebSocketServer.prototype.emit = originalEmit;
        resolve(args[0] as WebSocket);
      }
      return Reflect.apply(originalEmit, this, [eventName, ...args]) as boolean;
    };
  });
};

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const asBridgeCommandEnvelope = (
  msg: Record<string, unknown>,
): Extract<BridgeWireEnvelope, { kind: 'command' }> => {
  expect(msg.kind).toBe('command');
  const envelope = msg as BridgeWireEnvelope;
  if (envelope.kind !== 'command') {
    throw new Error('expected bridge command envelope');
  }
  expect(envelope.command.command_id).toEqual(expect.any(String));
  expect(envelope.command.command_id.length).toBeGreaterThan(0);
  return envelope;
};

const waitForBridgeCommand = async (
  ws: WebSocket,
): Promise<Extract<BridgeWireEnvelope, { kind: 'command' }>> =>
  asBridgeCommandEnvelope(await waitForMessage(ws, (msg) => msg.kind === 'command'));

const okResult = (
  command_id: string,
  outputs: Record<string, unknown> = { text: 'ok' },
): BridgeResult => ({
  command_id,
  status: 'ok',
  outputs,
  duration_ms: 7,
  bridge_version: 'bridge-test-1',
  idempotency_key_seen: false,
});

const sendBridgeResult = (ws: WebSocket, result: BridgeResult): void => {
  ws.send(JSON.stringify({ kind: 'result', result }));
};

const buildRequest = (overrides: Partial<DispatchRequest> = {}): DispatchRequest => ({
  recipe_run_id: 'run-1',
  step_id: 'step-1',
  ingredient: SAMPLE_INGREDIENT,
  action: 'read_dom',
  args: {},
  expects_output_keys: ['text'],
  idempotency_key: 'idem-1',
  timeout_ms: 1_000,
  ...overrides,
});

describe('D-169 P0 follow-on - WS bridge dispatcher production wiring', () => {
  let handlerSet: ReturnType<typeof createServerHandlerSet> | undefined;
  let httpServer: HttpServer | undefined;
  let db: Database.Database | undefined;
  let clientTokens: ClientTokenStore;
  let bridgeRegistry: BridgeRegistry;
  let lastSuccessfulBridgeDispatch:
    (client_token_id: string, target_pattern: string) => Promise<number | null>;
  const openSockets = new Set<WebSocket>();

  const auditLog = {
    lastSuccessfulBridgeDispatch: (
      client_token_id: string,
      target_pattern: string,
    ): Promise<number | null> =>
      lastSuccessfulBridgeDispatch(client_token_id, target_pattern),
    logActivity: async () => {},
  } as unknown as AuditLogStore;

  const currentHandlerSet = (): ReturnType<typeof createServerHandlerSet> => {
    if (!handlerSet) throw new Error('test handler set was not started');
    return handlerSet;
  };

  const currentHttpServer = (): HttpServer => {
    if (!httpServer) throw new Error('test http server was not started');
    return httpServer;
  };

  const dispatcher = (): BridgeDispatcher => {
    const bridgeDispatcher = currentHandlerSet().wsHandle.bridgeDispatcher;
    if (!bridgeDispatcher) throw new Error('bridge dispatcher not composed');
    return bridgeDispatcher;
  };

  beforeAll(async () => {
    db = new Database(':memory:');
    clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    bridgeRegistry = createBridgeRegistry();
    lastSuccessfulBridgeDispatch = async () => null;
    handlerSet = createServerHandlerSet({
      clientTokens,
      bridgeCapabilityDeps: { registry: bridgeRegistry },
      bridgeRegistry,
      bridgeDispatcherAuditLog: auditLog,
    });
    httpServer = createHttpServer();
    const wsUpgrade = currentHandlerSet().upgradeHandlers.ws;
    if (!wsUpgrade) throw new Error('ws upgrade handler not composed');
    httpServer.on('upgrade', wsUpgrade);
    currentHandlerSet().wsHandle.maxInstances = 0;
  });

  beforeEach(() => {
    bridgeRegistry.clear();
    lastSuccessfulBridgeDispatch = async () => null;
  });

  afterEach(async () => {
    WebSocketServer.prototype.emit = ORIGINAL_WSS_EMIT;
    for (const ws of [...openSockets]) {
      await closeWs(ws);
    }
    openSockets.clear();
    currentHandlerSet().wsHandle.revokeAllConnectedInstances();
    await wait(20);
    bridgeRegistry.clear();
    lastSuccessfulBridgeDispatch = async () => null;
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

  const connectStructuredToken = async (
    structured: string,
  ): Promise<{ ws: WebSocket; serverWs: WebSocket }> => {
    const serverWs = captureNextServerWs();
    const ws = await connectWs(currentHttpServer(), structured);
    openSockets.add(ws);
    ws.once('close', () => openSockets.delete(ws));
    return { ws, serverWs: await serverWs };
  };

  const connectStructured = async (
    client_kind: ClientKind,
    client_label?: string,
  ): Promise<{
    ws: WebSocket;
    serverWs: WebSocket;
    token_id: string;
    bearer: string;
    structured: string;
  }> => {
    const issued = await issueStructured(client_kind, client_label);
    const { ws, serverWs } = await connectStructuredToken(issued.structured);
    return { ws, serverWs, ...issued };
  };

  const waitForRegistrySize = (size: number) =>
    waitFor(
      () => bridgeRegistry.list(),
      (records) => records.length === size,
      `bridge registry size ${size}`,
    );

  const seedBridgeEligibility = async (
    token_id: string,
    capabilities: BridgeCapabilityProfile = BRIDGE_CAPABILITIES,
  ): Promise<BridgeConnectionRecord> => {
    const record = (await waitFor(
      () => bridgeRegistry.get(token_id),
      (entry): entry is BridgeConnectionRecord => entry !== null,
      `bridge registry record ${token_id}`,
    ))!;
    const next = {
      ...record,
      capabilities,
      last_seen_at: Date.now(),
    };
    bridgeRegistry.attach(next);
    return next;
  };

  it('dispatches end-to-end through a connected fake bridge and resolves the result frame', async () => {
    const { ws, token_id } = await connectStructured('bridge', 'Kitchen bridge');
    await waitForRegistrySize(1);
    await seedBridgeEligibility(token_id);

    const dispatch_p = dispatcher().dispatch(buildRequest({
      recipe_run_id: 'run-e2e',
      step_id: 'step-e2e',
      idempotency_key: 'idem-e2e',
    }));
    const envelope = await waitForBridgeCommand(ws);
    const result = okResult(envelope.command.command_id, { text: 'bridge output' });
    sendBridgeResult(ws, result);

    await expect(dispatch_p).resolves.toEqual({
      kind: 'completed',
      result,
      bridge_client_token_id: token_id,
      attempts: 1,
    });
  });

  it('ignores a non-bridge client result frame even when it carries a real command_id', async () => {
    const bridge = await connectStructured('bridge', 'Owned bridge');
    const webclient = await connectStructured('webclient', 'Browser');
    await waitForRegistrySize(1);
    await seedBridgeEligibility(bridge.token_id);

    const dispatch_p = dispatcher().dispatch(buildRequest({
      recipe_run_id: 'run-webclient-spoof',
      step_id: 'step-webclient-spoof',
      idempotency_key: 'idem-webclient-spoof',
    }));
    const envelope = await waitForBridgeCommand(bridge.ws);
    const spoofed = okResult(envelope.command.command_id, { text: 'spoofed' });
    sendBridgeResult(webclient.ws, spoofed);

    await expect(Promise.race([
      dispatch_p.then(() => 'resolved'),
      wait(50).then(() => 'pending'),
    ])).resolves.toBe('pending');

    const real = okResult(envelope.command.command_id, { text: 'owned' });
    sendBridgeResult(bridge.ws, real);
    const out = await dispatch_p;
    expect(out).toEqual({
      kind: 'completed',
      result: real,
      bridge_client_token_id: bridge.token_id,
      attempts: 1,
    });
  });

  it('rejects a result frame from the wrong bridge token for an in-flight command', async () => {
    const bridgeA = await connectStructured('bridge', 'Bridge A');
    const bridgeB = await connectStructured('bridge', 'Bridge B');
    await waitForRegistrySize(2);
    await seedBridgeEligibility(bridgeA.token_id);

    const dispatch_p = dispatcher().dispatch(buildRequest({
      recipe_run_id: 'run-wrong-owner',
      step_id: 'step-wrong-owner',
      idempotency_key: 'idem-wrong-owner',
    }));
    const envelope = await waitForBridgeCommand(bridgeA.ws);
    sendBridgeResult(bridgeB.ws, okResult(envelope.command.command_id, { text: 'wrong' }));

    await expect(Promise.race([
      dispatch_p.then(() => 'resolved'),
      wait(50).then(() => 'pending'),
    ])).resolves.toBe('pending');

    const real = okResult(envelope.command.command_id, { text: 'right' });
    sendBridgeResult(bridgeA.ws, real);
    await expect(dispatch_p).resolves.toEqual({
      kind: 'completed',
      result: real,
      bridge_client_token_id: bridgeA.token_id,
      attempts: 1,
    });
  });

  it('targets the current reconnect session when an older same-token bridge socket is still alive', async () => {
    const issued = await issueStructured('bridge', 'Race bridge');
    const first = await connectStructuredToken(issued.structured);
    await waitForRegistrySize(1);
    const firstRecord = await seedBridgeEligibility(issued.token_id);
    const oldMessages: BridgeWireEnvelope[] = [];
    first.ws.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.kind === 'command') oldMessages.push(msg as BridgeWireEnvelope);
    });

    const second = await connectStructuredToken(issued.structured);
    const secondRecord = await waitFor(
      () => bridgeRegistry.get(issued.token_id),
      (record) => record !== null && record.session_id !== firstRecord.session_id,
      'bridge reconnect session',
    );
    bridgeRegistry.attach({
      ...secondRecord!,
      capabilities: BRIDGE_CAPABILITIES,
      last_seen_at: Date.now(),
    });

    const dispatch_p = dispatcher().dispatch(buildRequest({
      recipe_run_id: 'run-reconnect',
      step_id: 'step-reconnect',
      idempotency_key: 'idem-reconnect',
    }));
    const envelope = await waitForBridgeCommand(second.ws);
    expect(oldMessages).toEqual([]);
    const result = okResult(envelope.command.command_id, { text: 'new session' });
    sendBridgeResult(second.ws, result);

    await expect(dispatch_p).resolves.toEqual({
      kind: 'completed',
      result,
      bridge_client_token_id: issued.token_id,
      attempts: 1,
    });
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('returns bridge_online capacity_gap when the matched bridge socket is not open', async () => {
    const { serverWs, token_id } = await connectStructured('bridge', 'Closing bridge');
    await waitForRegistrySize(1);
    await seedBridgeEligibility(token_id);
    const holdOrdering = createDeferred<number | null>();
    let orderingCalls = 0;
    lastSuccessfulBridgeDispatch = async () => {
      orderingCalls++;
      return holdOrdering.promise;
    };

    const dispatch_p = dispatcher().dispatch(buildRequest({
      recipe_run_id: 'run-closing',
      step_id: 'step-closing',
      idempotency_key: 'idem-closing',
    }));
    await waitFor(() => orderingCalls, (calls) => calls === 1, 'dispatch ordering wait');

    serverWs.close();
    expect(serverWs.readyState).toBe(WebSocket.CLOSING);
    holdOrdering.resolve(null);

    const out = await dispatch_p;
    expect(out.kind).toBe('capacity_gap');
    if (out.kind === 'capacity_gap') {
      expect(out.reason).toBe('bridge_online');
      expect(out.capacity_gap).toEqual({ kind: 'bridge_online' });
      expect(out.attempts).toBe(1);
    }
  });

  it('returns bridge_online capacity_gap when the server-side ws.send throws transport_error', async () => {
    const { serverWs, token_id } = await connectStructured('bridge', 'Throwing bridge');
    await waitForRegistrySize(1);
    await seedBridgeEligibility(token_id);
    const originalSend = serverWs.send;
    serverWs.send = (() => {
      throw new Error('synthetic transport failure');
    }) as unknown as WebSocket['send'];

    try {
      const out = await dispatcher().dispatch(buildRequest({
        recipe_run_id: 'run-transport-error',
        step_id: 'step-transport-error',
        idempotency_key: 'idem-transport-error',
      }));
      expect(out.kind).toBe('capacity_gap');
      if (out.kind === 'capacity_gap') {
        expect(out.reason).toBe('bridge_online');
        expect(out.capacity_gap).toEqual({ kind: 'bridge_online' });
        expect(out.attempts).toBe(1);
      }
    } finally {
      serverWs.send = originalSend;
    }
  });

  it('drains pending bridge result waits through listener.clear()', async () => {
    const listener = createBridgeResultListener();
    const pending = listener.awaitResult('cmd-clear', 60_000);
    listener.clear?.();
    await expect(pending).resolves.toBeNull();
  });

  it('reports in-flight command ownership through dispatcher.canResolve()', async () => {
    const registry = createBridgeRegistry();
    const listener = createBridgeResultListener();
    let capturedCommandId: string | undefined;
    const transport: BridgeTransport = {
      async send(_client_token_id, envelope) {
        if (envelope.kind === 'command') {
          capturedCommandId = envelope.command.command_id;
        }
        return { ok: true };
      },
      async cancel() {
        return { ok: true };
      },
    };
    registry.attach({
      client_token_id: 'tok-owner',
      client_label: 'Owner bridge',
      session_id: 'sess-owner',
      online_since: 1_000,
      last_seen_at: 1_000,
      capabilities: BRIDGE_CAPABILITIES,
    });
    const localDispatcher = createBridgeDispatcher({
      registry,
      transport,
      listener,
      now: () => 1_000,
      sleep: async () => {},
    });

    const dispatch_p = localDispatcher.dispatch(buildRequest({
      recipe_run_id: 'run-can-resolve',
      step_id: 'step-can-resolve',
      idempotency_key: 'idem-can-resolve',
    }));
    await waitFor(
      () => capturedCommandId,
      (command_id): command_id is string => typeof command_id === 'string',
      'captured command id',
    );

    expect(localDispatcher.canResolve(capturedCommandId!, 'tok-owner')).toBe(true);
    expect(localDispatcher.canResolve(capturedCommandId!, 'tok-other')).toBe(false);
    expect(localDispatcher.canResolve('cmd-missing', 'tok-owner')).toBe(false);

    const result = okResult(capturedCommandId!, { text: 'owned' });
    listener.resolveResult(result);
    await expect(dispatch_p).resolves.toEqual({
      kind: 'completed',
      result,
      bridge_client_token_id: 'tok-owner',
      attempts: 1,
    });
  });

  it('drops unknown bridge envelope kinds and safely ignores non-bridge unknown kind frames', async () => {
    const bridge = await connectStructured('bridge', 'Unknown-kind bridge');
    const webclient = await connectStructured('webclient', 'Unknown-kind webclient');
    await waitForRegistrySize(1);

    bridge.ws.send(JSON.stringify({ kind: 'whatever', payload: { ignored: true } }));
    webclient.ws.send(JSON.stringify({ kind: 'whatever', payload: { ignored: true } }));
    await wait(30);

    expect(bridge.ws.readyState).toBe(WebSocket.OPEN);
    expect(webclient.ws.readyState).toBe(WebSocket.OPEN);
    expect(bridgeRegistry.get(bridge.token_id)).not.toBeNull();
  });

  it.todo('queue_full at transport-level is not wired for the WS transport - bridge surfaces via result frame');
});
