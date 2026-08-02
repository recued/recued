import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import Database from 'better-sqlite3';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createServerStateStore } from '../server-state.js';
import {
  createClientTokenStore,
  type ClientTokenRecord,
} from '../pairing/client-tokens.js';
import type { WebclientUploadService } from '../upload/webclient-upload-service.js';
import type { ArchiveUploadService } from '../archive/archive-upload-service.js';
import type { WebclientDownloadService } from '../download/webclient-download-service.js';
import {
  DATA_WS_MAX_IN_FLIGHT_GLOBAL,
  RPC_WS_MAX_IN_FLIGHT_GLOBAL,
  RPC_WS_MAX_IN_FLIGHT_PER_CLIENT,
  RPC_WS_MAX_PAYLOAD_BYTES,
  sendBoundedWsJson,
  WS_JSON_MAX_BUFFERED_BYTES,
} from '../ws-server.js';
import WebSocket from 'ws';
import type { RecipeDefinition } from '@recued/contracts';

const RECIPE: RecipeDefinition = {
  recipe_id: 'ws-test',
  version: 1,
  ttl: 60,
  metadata: { name: 'WS Test', description: 't', author: 't', supported_platforms: ['t'] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'x', transform: 'template', template: 'ok' }],
  output: { sidebar: [{ type: 'text', source: 'step.x' }] },
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const connectWsPath = (port: number, path: string, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`,
    );
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

const connectWs = (port: number, token: string): Promise<WebSocket> =>
  connectWsPath(port, '/ws', token);

const nextMessage = (ws: WebSocket): Promise<any> =>
  new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });

const connectUncooperativeRawWs = (port: number, token: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw WebSocket upgrade timed out'));
    }, 3000);
    let response = '';
    const onError = (error: Error): void => {
      clearTimeout(timeout);
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timeout);
      socket.off('error', onError);
      socket.off('data', onData);
      if (!response.startsWith('HTTP/1.1 101')) {
        socket.destroy();
        reject(new Error(`raw WebSocket upgrade failed: ${response.split('\r\n', 1)[0]}`));
        return;
      }
      // Consume TCP data but deliberately never parse/respond to the server's
      // WebSocket close frame. This models a stalled or malicious peer.
      socket.on('error', () => { /* expected during terminal teardown */ });
      resolve(socket);
    };
    socket.on('error', onError);
    socket.on('data', onData);
    socket.once('connect', () => {
      socket.write([
        `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
  });

describe('WebSocket server', () => {
  let server: RunningServer;

  beforeAll(async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(RECIPE);

    server = await startServer(0, {
      executeDeps: {
        recipeStore,
        executorConfig: { manifests },
        baseVault: {},
      },
    });
    // Allow multiple clients for testing
    server.wsServer.maxInstances = 0;
  });

  afterAll(async () => {
    await server.close();
  });

  it('accepts WebSocket connections with auth token', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('terminates a stalled socket instead of extending its JSON send queue', () => {
    let sent = false;
    let terminated = false;
    const result = sendBoundedWsJson({
      readyState: WebSocket.OPEN,
      bufferedAmount: WS_JSON_MAX_BUFFERED_BYTES - 1,
      send: () => { sent = true; },
      terminate: () => { terminated = true; },
    }, { type: 'rpc_result', result: 'too much queued output' }, WebSocket.OPEN);

    expect(result).toEqual({ ok: false, reason: 'backpressure' });
    expect(sent).toBe(false);
    expect(terminated).toBe(true);
  });

  it('routes live heartbeat pushes through the bounded JSON sender', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    const registered = nextMessage(ws);
    ws.send(JSON.stringify({
      type: 'register',
      instance_id: 'backpressured-heartbeat-client',
      display_name: 'Stalled client',
    }));
    await registered;
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount');
    if (!descriptor) throw new Error('ws bufferedAmount descriptor missing');
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('backpressured client stayed open')), 3000);
      ws.once('close', () => { clearTimeout(timeout); resolve(); });
    });

    try {
      Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => WS_JSON_MAX_BUFFERED_BYTES,
      });
      server.wsServer.broadcastServerHeartbeat({ state: 'running' });
      await closed;
    } finally {
      Object.defineProperty(WebSocket.prototype, 'bufferedAmount', descriptor);
      ws.terminate();
    }
  });

  it('rejects connections without auth', async () => {
    await expect(new Promise((_, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.on('error', reject);
      ws.on('close', () => reject(new Error('closed')));
    })).rejects.toBeDefined();
  });

  it('rejects an oversized rpc frame before dispatch and remains available', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    const closed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('oversized frame was not closed')), 3000);
      ws.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    ws.send(JSON.stringify({
      type: 'register',
      instance_id: 'oversized-rpc-client',
      display_name: 'x'.repeat(RPC_WS_MAX_PAYLOAD_BYTES),
    }));
    await expect(closed).resolves.toBe(1009);

    const survivor = await connectWs(server.port, 'test-realm');
    const reply = nextMessage(survivor);
    survivor.send(JSON.stringify({
      type: 'register',
      instance_id: 'post-oversize-client',
      display_name: 'Still healthy',
    }));
    await expect(reply).resolves.toMatchObject({
      type: 'registered',
      instance_id: 'post-oversize-client',
    });
    survivor.close();
  });

  it('registers instance and receives ack', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    const msgP = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-1', display_name: 'Test' }));
    const msg = await msgP;
    expect(msg.type).toBe('registered');
    expect(msg.instance_id).toBe('ext-1');
    ws.close();
  });

  it('tracks client count', async () => {
    await wait(100); // let previous test's connections close
    expect(server.wsServer.clientCount()).toBe(0);
    const ws = await connectWs(server.port, 'test-realm');
    await wait(50);
    expect(server.wsServer.clientCount()).toBe(1);
    ws.close();
    await wait(50);
    expect(server.wsServer.clientCount()).toBe(0);
  });

  it('peerCacheGet ignores non-bridge clients — instant null, no cache_get_request frame', async () => {
    // Regression lock: only a BRIDGE can answer the ext cache protocol.
    // A registered non-bridge client (this legacy-register path carries no
    // client_kind — same shape as webclient / CLI / harness clients) must
    // never be targeted: pre-fix, peerCacheGet picked ANY client with an
    // instance_id and waited its FULL default timeout (8s) for an answer
    // that never comes — stalling every cold step-cache miss 8s-per-step
    // during recipe runs. Post-fix: no bridge online → immediate null.
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-cache-mute' }));
    await nextMessage(ws);
    const frames: any[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));

    const t0 = Date.now();
    // No timeout arg on purpose — exercises the 8_000ms default that the
    // old any-client targeting turned into a guaranteed stall.
    const entry = await server.wsServer.peerCacheGet('v1:step:cold-key');
    expect(entry).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);

    await wait(50);
    expect(frames.filter((f) => f.type === 'cache_get_request')).toHaveLength(0);
    ws.close();
  });

  it('handles AI delegation round-trip', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-ai' }));
    await nextMessage(ws);

    // Extension listens for ai_request and responds
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ai_request') {
        ws.send(JSON.stringify({
          type: 'ai_response',
          request_id: msg.request_id,
          result: { answer: 'hello from extension' },
        }));
      }
    });

    const result = await server.wsServer.delegateAi('ai-classify', { data: 'test' }, 5000);
    expect(result).toEqual({ answer: 'hello from extension' });
    ws.close();
  });

  // ── Generic rpc envelope: extension → server method calls ──

  /** Wait for a message of a specific type (drains earlier messages). */
  const waitForMessage = (ws: WebSocket, predicate: (m: any) => boolean): Promise<any> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('waitForMessage timeout')), 5000);
      const onMessage = (data: any) => {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(msg);
        }
      };
      ws.on('message', onMessage);
    });

  const rpcCall = async (
    ws: WebSocket,
    requestId: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<any> => {
    const replyP = waitForMessage(ws, (m) => m.type === 'rpc_result' && m.request_id === requestId);
    ws.send(JSON.stringify({ type: 'rpc', request_id: requestId, method, args }));
    return replyP;
  };

  it('rpc execute runs the recipe (recipe_id lookup)', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-exec' }));
    await nextMessage(ws);

    const reply = await rpcCall(ws, 'r-101', 'execute', { recipe_id: 'ws-test' });
    expect(reply.error).toBeUndefined();
    expect(reply.result.recipe_id).toBe('ws-test');
    expect(reply.result.success).toBe(true);
    ws.close();
  });

  it('rpc execute runs an inline recipe payload', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-exec-inline' }));
    await nextMessage(ws);

    const reply = await rpcCall(ws, 'r-102', 'execute', { recipe: RECIPE });
    expect(reply.error).toBeUndefined();
    expect(reply.result.recipe_id).toBe('ws-test');
    expect(reply.result.success).toBe(true);
    ws.close();
  });

  it('rpc execute returns error for unknown recipe_id', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-exec-404' }));
    await nextMessage(ws);

    const reply = await rpcCall(ws, 'r-103', 'execute', { recipe_id: 'does-not-exist' });
    expect(reply.error?.code).toBe('recipe_not_found');
    ws.close();
  });

  it('rpc returns unknown_method for an unrecognized method', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-rpc-unk' }));
    await nextMessage(ws);

    const reply = await rpcCall(ws, 'r-104', 'definitely.not.a.thing');
    expect(reply.error?.code).toBe('unknown_method');
    ws.close();
  });

  it('rpc without request_id is dropped silently (next valid call still works)', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-rpc-noid' }));
    await nextMessage(ws);

    ws.send(JSON.stringify({ type: 'rpc', method: 'execute', args: { recipe_id: 'ws-test' } }));
    const reply = await rpcCall(ws, 'r-105', 'execute', { recipe_id: 'ws-test' });
    expect(reply.request_id).toBe('r-105');
    ws.close();
  });
});

describe('WebSocket server shutdown', () => {
  it('does not let a peer that ignores the close handshake block listener drain', async () => {
    const server = await startServer(0);
    const socket = await connectUncooperativeRawWs(server.port, 'test-realm');
    expect(server.wsServer.clientCount()).toBe(1);

    const close = server.close();
    let completedWithinDrainWindow = false;
    try {
      completedWithinDrainWindow = await Promise.race([
        close.then(() => true),
        wait(1000).then(() => false),
      ]);
    } finally {
      socket.destroy();
      await close;
    }

    expect(completedWithinDrainWindow).toBe(true);
  });

  it('disconnects an upload socket that sends another chunk before its ack', async () => {
    const db = new Database(':memory:');
    const clientTokens = createClientTokenStore(db, {
      argon2_params: { t: 1, m: 8, p: 1 },
    });
    const issued = await clientTokens.issue({
      client_kind: 'webclient',
      client_label: 'Chunk pacing test',
      metadata: { instance_id: 'chunk-pacing-owner' },
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const service = {
      handleChunkFrame: async () => {
        calls += 1;
        markStarted();
        await gate;
        return { type: 'upload_error', reason: 'invalid_frame' } as const;
      },
    } as unknown as WebclientUploadService;
    const server = await startServer(0, {
      clientTokens,
      uploadDeps: { service },
    });
    const ws = await connectWsPath(
      server.port,
      '/ws/upload',
      `${issued.token_id}.${issued.bearer}`,
    );
    ws.send(Buffer.from([1]));
    await started;
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('pipelined upload socket stayed open')), 3000);
      ws.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    ws.send(Buffer.from([2]));

    try {
      await closed;
      expect(calls).toBe(1);
    } finally {
      release();
      await server.close();
      ws.terminate();
      db.close();
    }
  });

  it('caps active data-plane work across many sockets', async () => {
    let markFull!: () => void;
    const full = new Promise<void>((resolve) => { markFull = resolve; });
    const releases: Array<() => void> = [];
    let calls = 0;
    const service = {
      handleChunkFrame: async () => {
        calls += 1;
        if (calls === DATA_WS_MAX_IN_FLIGHT_GLOBAL) markFull();
        await new Promise<void>((resolve) => { releases.push(resolve); });
        return { type: 'upload_error', reason: 'invalid_frame' } as const;
      },
    } as unknown as WebclientUploadService;
    let downloadCalls = 0;
    const downloadService = {
      handleStart: async () => {
        downloadCalls += 1;
        await new Promise<void>((resolve) => { releases.push(resolve); });
      },
    } as unknown as WebclientDownloadService;
    const tokenId = 't'.repeat(16);
    const bearer = 'b'.repeat(44);
    const server = await startServer(0, {
      clientTokens: {
        issue: async () => ({ token_id: tokenId, bearer }),
        verify: async () => ({
          ok: true,
          record: {
            token_id: tokenId,
            client_kind: 'webclient',
            client_label: null,
            metadata: { instance_id: 'global-data-owner' },
          } as unknown as ClientTokenRecord,
        }),
        touch: () => {},
        revoke: () => {},
        list: () => [],
      },
      uploadDeps: { service },
      archiveUploadDeps: { service: service as unknown as ArchiveUploadService },
      downloadDeps: { service: downloadService },
    });
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < DATA_WS_MAX_IN_FLIGHT_GLOBAL; i += 1) {
        const ws = await connectWsPath(server.port, '/ws/upload', `${tokenId}.${bearer}`);
        sockets.push(ws);
        ws.send(Buffer.from([i]));
      }
      await full;

      for (const overflowSurface of [
        { path: '/ws/upload', frame: Buffer.from([255]) },
        { path: '/ws/archive-upload', frame: Buffer.from([255]) },
        { path: '/ws/download', frame: JSON.stringify({ type: 'download_start' }) },
      ] as const) {
        const overflow = await connectWsPath(
          server.port,
          overflowSurface.path,
          `${tokenId}.${bearer}`,
        );
        sockets.push(overflow);
        const closed = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(
            `overflow ${overflowSurface.path} socket stayed open`,
          )), 3000);
          overflow.once('close', () => { clearTimeout(timeout); resolve(); });
        });
        overflow.send(overflowSurface.frame);
        await closed;
      }
      expect(calls).toBe(DATA_WS_MAX_IN_FLIGHT_GLOBAL);
      expect(downloadCalls).toBe(0);
    } finally {
      for (const release of releases) release();
      await server.close();
      for (const ws of sockets) ws.terminate();
    }
  });

  it('rejects and drains a bearer verification admitted before close', async () => {
    let markVerifyStarted!: () => void;
    const verifyStarted = new Promise<void>((resolve) => { markVerifyStarted = resolve; });
    let releaseVerify!: () => void;
    const verifyGate = new Promise<{ ok: boolean; record: null }>((resolve) => {
      releaseVerify = () => resolve({ ok: true, record: null });
    });
    let touched = false;
    const server = await startServer(0, {
      clientTokens: {
        issue: async () => ({ token_id: 'unused', bearer: 'unused' }),
        verify: () => {
          markVerifyStarted();
          return verifyGate;
        },
        touch: () => { touched = true; },
        revoke: () => {},
        list: () => [],
      },
    });
    const socket = connect({ host: '127.0.0.1', port: server.port });
    socket.on('error', () => { /* expected when close rejects the upgrade */ });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write([
      `GET /ws?token=${'t'.repeat(16)}.${'b'.repeat(44)} HTTP/1.1`,
      `Host: 127.0.0.1:${server.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
    await verifyStarted;

    const close = server.close();
    let completedBeforeRelease = false;
    try {
      completedBeforeRelease = await Promise.race([
        close.then(() => true),
        wait(50).then(() => false),
      ]);
      releaseVerify();
      await close;
    } finally {
      releaseVerify();
      socket.destroy();
      await Promise.allSettled([close]);
    }

    expect(completedBeforeRelease).toBe(false);
    expect(touched).toBe(false);
  });

  it.each([
    { surface: 'upload', path: '/ws/upload', binary: true },
    { surface: 'archive-upload', path: '/ws/archive-upload', binary: true },
    { surface: 'download', path: '/ws/download', binary: false },
  ] as const)('waits for an admitted $surface data-socket handler', async ({ surface, path, binary }) => {
    const db = new Database(':memory:');
    const clientTokens = createClientTokenStore(db, {
      argon2_params: { t: 1, m: 8, p: 1 },
    });
    const issued = await clientTokens.issue({
      client_kind: 'webclient',
      client_label: 'Data drain test',
      metadata: { instance_id: 'data-drain-owner' },
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const chunkService = {
      handleChunkFrame: async () => {
        markStarted();
        await gate;
        return { type: 'upload_error', reason: 'invalid_frame' } as const;
      },
    };
    const downloadService = {
      handleStart: async () => {
        markStarted();
        await gate;
      },
    };
    const server = await startServer(0, {
      clientTokens,
      ...(surface === 'upload'
        ? { uploadDeps: { service: chunkService as unknown as WebclientUploadService } }
        : {}),
      ...(surface === 'archive-upload'
        ? { archiveUploadDeps: { service: chunkService as unknown as ArchiveUploadService } }
        : {}),
      ...(surface === 'download'
        ? { downloadDeps: { service: downloadService as unknown as WebclientDownloadService } }
        : {}),
    });
    const ws = await connectWsPath(
      server.port,
      path,
      `${issued.token_id}.${issued.bearer}`,
    );
    ws.send(binary ? Buffer.from([1]) : JSON.stringify({ type: 'download_start' }));
    await started;

    const close = server.close();
    let completedBeforeRelease = false;
    try {
      completedBeforeRelease = await Promise.race([
        close.then(() => true),
        wait(50).then(() => false),
      ]);
      release();
      await close;
    } finally {
      release();
      ws.terminate();
      await Promise.allSettled([close]);
      db.close();
    }

    expect(completedBeforeRelease).toBe(false);
  });

  it('bounds admitted rpc work per socket and across sockets', async () => {
    const db = new Database(':memory:');
    const releases: Array<() => void> = [];
    const startedWaiters: Array<() => void> = [];
    const server = await startServer(0, {
      bootstrapDeps: {
        bootstrap: {
          data_path: '/tmp', bind_host: '127.0.0.1', bind_port: 0,
          mcp_port: 0, webhook_port: 0, log_path: '/tmp/recued-test.log',
        },
        state: createServerStateStore(db),
        version: 'test',
        onPauseChanged: () => new Promise<void>((resolve) => {
          releases.push(resolve);
          startedWaiters.shift()?.();
        }),
      },
    });
    const clients: WebSocket[] = [];
    let nextActive = true;

    const admitOne = async (ws: WebSocket, requestId: string): Promise<void> => {
      const started = new Promise<void>((resolve) => { startedWaiters.push(resolve); });
      ws.send(JSON.stringify({
        type: 'rpc',
        request_id: requestId,
        method: 'server.setPaused',
        args: { active: nextActive },
      }));
      nextActive = !nextActive;
      await started;
    };
    const waitForRpcResult = (ws: WebSocket, requestId: string): Promise<any> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('rpc overload reply timed out')), 3000);
        const onMessage = (data: WebSocket.RawData): void => {
          const message = JSON.parse(data.toString());
          if (message.type !== 'rpc_result' || message.request_id !== requestId) return;
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(message);
        };
        ws.on('message', onMessage);
      });

    try {
      expect(RPC_WS_MAX_IN_FLIGHT_GLOBAL % RPC_WS_MAX_IN_FLIGHT_PER_CLIENT).toBe(0);
      const socketCount = RPC_WS_MAX_IN_FLIGHT_GLOBAL / RPC_WS_MAX_IN_FLIGHT_PER_CLIENT;
      for (let socketIndex = 0; socketIndex < socketCount; socketIndex += 1) {
        const ws = await connectWs(server.port, 'test-realm');
        clients.push(ws);
        for (let i = 0; i < RPC_WS_MAX_IN_FLIGHT_PER_CLIENT; i += 1) {
          await admitOne(ws, `held-${socketIndex}-${i}`);
        }
      }

      const perSocketReply = waitForRpcResult(clients[0]!, 'per-socket-overload');
      clients[0]!.send(JSON.stringify({
        type: 'rpc', request_id: 'per-socket-overload',
        method: 'server.setPaused', args: { active: nextActive },
      }));
      await expect(perSocketReply).resolves.toMatchObject({
        error: { code: 'rpc_overloaded' },
      });

      const extraClient = await connectWs(server.port, 'test-realm');
      clients.push(extraClient);
      const globalReply = waitForRpcResult(extraClient, 'global-overload');
      extraClient.send(JSON.stringify({
        type: 'rpc', request_id: 'global-overload',
        method: 'server.setPaused', args: { active: nextActive },
      }));
      await expect(globalReply).resolves.toMatchObject({
        error: { code: 'rpc_overloaded' },
      });
      expect(releases).toHaveLength(RPC_WS_MAX_IN_FLIGHT_GLOBAL);
    } finally {
      for (const release of releases) release();
      await server.close();
      for (const ws of clients) ws.terminate();
      db.close();
    }
  });

  it('waits for an admitted rpc handler before completing listener drain', async () => {
    const db = new Database(':memory:');
    let releaseSideEffect!: () => void;
    const sideEffectGate = new Promise<void>((resolve) => { releaseSideEffect = resolve; });
    let markStarted!: () => void;
    const sideEffectStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const server = await startServer(0, {
      bootstrapDeps: {
        bootstrap: {
          data_path: '/tmp', bind_host: '127.0.0.1', bind_port: 0,
          mcp_port: 0, webhook_port: 0, log_path: '/tmp/recued-test.log',
        },
        state: createServerStateStore(db),
        version: 'test',
        onPauseChanged: async () => {
          markStarted();
          await sideEffectGate;
        },
      },
    });
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({
      type: 'rpc',
      request_id: 'slow-pause',
      method: 'server.setPaused',
      args: { active: true },
    }));
    await sideEffectStarted;

    const close = server.close();
    let completedBeforeRelease = false;
    try {
      completedBeforeRelease = await Promise.race([
        close.then(() => true),
        wait(50).then(() => false),
      ]);
      releaseSideEffect();
      await close;
    } finally {
      releaseSideEffect();
      ws.terminate();
      await Promise.allSettled([close]);
      db.close();
    }

    expect(completedBeforeRelease).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Server without executeDeps — rpc('execute') must reply not_configured
// ────────────────────────────────────────────────────────────────

describe('WebSocket server — rpc without executeDeps', () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer(0); // no executeDeps
    server.wsServer.maxInstances = 0;
  });

  afterAll(async () => {
    await server.close();
  });

  it('rpc execute replies not_configured when executeDeps absent', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-noexec' }));
    await nextMessage(ws);

    const replyP = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
      const onMessage = (data: any) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'rpc_result' && m.request_id === 'r-201') {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(m);
        }
      };
      ws.on('message', onMessage);
    });
    ws.send(JSON.stringify({
      type: 'rpc', request_id: 'r-201',
      method: 'execute', args: { recipe_id: 'foo' },
    }));
    const reply = await replyP;
    expect(reply.error?.code).toBe('not_configured');
    ws.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Schedules CRUD over rpc — full round-trip with a real schedule store
// ────────────────────────────────────────────────────────────────

import { createScheduleStore } from '../schedule-store.js';

describe('WebSocket server — schedules.* rpc', () => {
  let server: RunningServer;

  beforeAll(async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(RECIPE);
    const db = new Database(':memory:');
    const store = createScheduleStore(db);

    server = await startServer(0, {
      executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
      scheduleDeps: { store, instanceId: 'ws-test-server' },
    });
    server.wsServer.maxInstances = 0;
  });

  afterAll(async () => {
    await server.close();
  });

  const waitFor = (ws: WebSocket, requestId: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('rpc timeout')), 3000);
      const onMessage = (data: any) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'rpc_result' && m.request_id === requestId) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(m);
        }
      };
      ws.on('message', onMessage);
    });

  const call = async (ws: WebSocket, id: string, method: string, args: Record<string, unknown> = {}) => {
    const replyP = waitFor(ws, id);
    ws.send(JSON.stringify({ type: 'rpc', request_id: id, method, args }));
    return replyP;
  };

  it('create → list → update → delete round-trips', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-sched' }));
    await nextMessage(ws);

    const created = await call(ws, 's-1', 'schedules.create', {
      recipe_id: 'ws-test', cron_expression: '*/10 * * * *',
    });
    expect(created.error).toBeUndefined();
    const scheduleId = created.result.schedule.schedule_id;
    expect(scheduleId).toMatch(/^sch_/);

    const listed = await call(ws, 's-2', 'schedules.list');
    expect(listed.result.schedules).toHaveLength(1);

    const updated = await call(ws, 's-3', 'schedules.update', {
      schedule_id: scheduleId, enabled: false,
    });
    expect(updated.result.schedule.enabled).toBe(false);

    const deleted = await call(ws, 's-4', 'schedules.delete', { schedule_id: scheduleId });
    expect(deleted.result.deleted).toBe(true);

    const empty = await call(ws, 's-5', 'schedules.list');
    expect(empty.result.schedules).toHaveLength(0);

    ws.close();
  });

  it('schedules.update without schedule_id returns bad_request', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    ws.send(JSON.stringify({ type: 'register', instance_id: 'ext-sched-bad' }));
    await nextMessage(ws);

    const reply = await call(ws, 's-bad', 'schedules.update', { enabled: false });
    expect(reply.error?.code).toBe('bad_request');
    ws.close();
  });
});
