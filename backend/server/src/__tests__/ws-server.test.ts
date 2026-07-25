import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
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

const connectWs = (port: number, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

const nextMessage = (ws: WebSocket): Promise<any> =>
  new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
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

  it('rejects connections without auth', async () => {
    await expect(new Promise((_, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.on('error', reject);
      ws.on('close', () => reject(new Error('closed')));
    })).rejects.toBeDefined();
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

import Database from 'better-sqlite3';
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
