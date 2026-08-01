/** D-067 end-to-end — the pre-run check actually rejects at dispatch.
 *
 *  The unit tests next door pin the finder. This pins the WIRING: that
 *  `handleExecute` consults it, refuses before the executor is built, and
 *  returns the declared error code. A finder nobody calls is what D-067 was for
 *  its whole life — the decision existed, the check did not.
 *
 *  ⚠ The load-bearing case is `admits a compatible pin`. Every rejection
 *  assertion here is equally satisfied by a handler that refuses EVERY recipe,
 *  which would be a dead server that looks like a working gate. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';

import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

/** Current v3; anything pinned below v2 is a declared break. */
const READER_MANIFEST = {
  slug: 'reader',
  name: 'Reader',
  description: 'test ingredient',
  author: 'test',
  kind: 'http',
  version: 3,
  min_version: 2,
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: { value: 'value' },
} as unknown as IngredientManifest;

const recipeWithPin = (recipe_id: string, pin: number): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id, description: 'test', author: 'test',
      supported_platforms: ['test'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'read', ingredient: 'reader', ingredient_version: pin, input: {} }],
    output: { sidebar: [] },
  }) as unknown as RecipeDefinition;

const connectAndRegister = (port: number, instanceId: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-realm`);
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', instance_id: instanceId }));
      const onMsg = (data: unknown) => {
        const m = JSON.parse(String(data));
        if (m.type === 'registered') { ws.off('message', onMsg); resolve(ws); }
      };
      ws.on('message', onMsg);
    });
  });

const rpcExecute = (
  ws: WebSocket, requestId: string, args: Record<string, unknown>,
): Promise<{ error?: unknown; result: {
  success: boolean;
  steps: unknown[];
  errors: Array<{ code: string; message: string; details?: unknown }>;
} }> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('rpc timeout')), 5000);
    const onMsg = (data: unknown) => {
      const m = JSON.parse(String(data));
      if (m.type === 'rpc_result' && m.request_id === requestId) {
        clearTimeout(timeout); ws.off('message', onMsg); resolve(m);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'rpc', request_id: requestId, method: 'execute', args }));
  });

describe('D-067 pre-run compatibility check (wired)', () => {
  let server: RunningServer;
  let ws: WebSocket;
  let counter = 0;
  const nextId = () => `d067-${++counter}`;

  beforeAll(async () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(READER_MANIFEST);
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(recipeWithPin('d067-stale', 1));      // below min_version
    recipeStore.register(recipeWithPin('d067-compatible', 2)); // at min_version

    server = await startServer(0, {
      executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
    });
    server.wsServer.maxInstances = 0;
    ws = await connectAndRegister(server.port, 'ext-d067');
  });

  afterAll(async () => {
    ws.close();
    await server.close();
  });

  it('REJECTS a stale pin before any step runs', async () => {
    const reply = await rpcExecute(ws, nextId(), { recipe_id: 'd067-stale' });
    expect(reply.error).toBeUndefined();
    expect(reply.result.success).toBe(false);
    expect(reply.result.errors[0]!.code).toBe('INGREDIENT_VERSION_MISMATCH');
    // The point of D-067: nothing executed. A mid-run version throw (which is
    // what shipped before this) would leave earlier steps in `steps`.
    expect(reply.result.steps).toEqual([]);
  });

  it('names the ingredient, both versions, and the remedy', async () => {
    const reply = await rpcExecute(ws, nextId(), { recipe_id: 'd067-stale' });
    const message = reply.result.errors[0]!.message;
    expect(message).toContain("'reader'");
    expect(message).toContain('v1');
    expect(message).toContain('min compatible: v2');
    expect(message).toMatch(/re-pin|reinstall/);
  });

  it('ADMITS a compatible pin — the gate is not a blanket refusal', async () => {
    // The recipe still fails (no live `reader` adapter in this harness), and
    // that is exactly the signal: it got PAST the pre-run gate and failed
    // downstream instead. Asserting "not the version code" rather than
    // "success" keeps this honest without standing up a real ingredient.
    const reply = await rpcExecute(ws, nextId(), { recipe_id: 'd067-compatible' });
    expect(reply.error).toBeUndefined();
    const codes = reply.result.errors.map((e) => e.code);
    expect(codes).not.toContain('INGREDIENT_VERSION_MISMATCH');
  });
});
