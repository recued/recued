import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createAuditLogStore, createInMemoryCollection, type AuditEntry, type ActivityEntry } from '@recued/storage';
import type { RecipeDefinition } from '@recued/contracts';
import WebSocket from 'ws';

const RECIPE: RecipeDefinition = {
  recipe_id: 'audit-test-recipe',
  version: 1,
  ttl: 60,
  metadata: { name: 'Audit Test', description: 'test', author: 'test', supported_platforms: ['test'] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'msg', transform: 'template', template: 'hello' }],
  output: { sidebar: [{ type: 'text', source: 'step.msg' }] },
};

/** Open a WS connection, register, and return a small rpc helper.
 *  Audit log is appended inside handleExecute regardless of caller, so
 *  rpc('execute', ...) exercises the same write path the HTTP route used to. */
const connectAndRegister = (port: number, instanceId: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-realm`);
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', instance_id: instanceId }));
      const onMsg = (data: any) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'registered') {
          ws.off('message', onMsg);
          resolve(ws);
        }
      };
      ws.on('message', onMsg);
    });
  });

const rpcExecute = (ws: WebSocket, requestId: string, args: Record<string, unknown>): Promise<any> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('rpc timeout')), 3000);
    const onMsg = (data: any) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'rpc_result' && m.request_id === requestId) {
        clearTimeout(timeout);
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'rpc', request_id: requestId, method: 'execute', args }));
  });

describe('audit log', () => {
  let server: RunningServer;
  let ws: WebSocket;
  let auditLog: ReturnType<typeof createAuditLogStore>;
  let counter = 0;
  const nextId = () => `audit-${++counter}`;

  beforeAll(async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(RECIPE);

    auditLog = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );

    server = await startServer(0, {
      executeDeps: {
        recipeStore,
        executorConfig: { manifests },
        baseVault: {},
        auditLog,
      },
    });
    server.wsServer.maxInstances = 0;
    ws = await connectAndRegister(server.port, 'ext-audit');
  });

  afterAll(async () => {
    ws.close();
    await server.close();
  });

  it('appends an audit entry after execution', async () => {
    const reply = await rpcExecute(ws, nextId(), { recipe_id: 'audit-test-recipe' });
    expect(reply.error).toBeUndefined();
    expect(reply.result.success).toBe(true);

    const entries = await auditLog.listRecent(10);
    expect(entries.length).toBe(1);
    expect(entries[0].recipe_id).toBe('audit-test-recipe');
    expect(entries[0].commit_status).toBe('succeeded');
    expect(entries[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('multiple executions accumulate entries', async () => {
    await rpcExecute(ws, nextId(), { recipe_id: 'audit-test-recipe' });
    await rpcExecute(ws, nextId(), { recipe_id: 'audit-test-recipe' });
    const entries = await auditLog.listRecent(10);
    expect(entries.length).toBe(3); // 1 from earlier + 2 new
  });

  it('auditLog.clearAll empties the store', async () => {
    await auditLog.clearAll();
    const entries = await auditLog.listRecent(10);
    expect(entries.length).toBe(0);
  });
});
