import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { MCP_RESERVED_RPC_PREFIXES, type RecipeDefinition } from '@recued/contracts';
import { startServer } from '../server.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';

interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket, method: string, args: unknown): Promise<Reply> => new Promise((resolve, reject) => {
  const request_id = crypto.randomUUID();
  const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error(`RPC timeout: ${method}`)); }, 5000);
  const receive = (data: WebSocket.RawData): void => {
    const reply: Reply = JSON.parse(data.toString());
    if (reply.request_id !== request_id) return;
    clearTimeout(timeout); ws.off('message', receive); resolve(reply);
  };
  ws.on('message', receive);
  ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
});
const definition = (steps: RecipeDefinition['steps']): RecipeDefinition => ({
  recipe_id: 'sample-test', version: 1, ttl: 0,
  metadata: { name: 'Sample test', description: 'Sample-only execution.', author: 'owner', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps, output: { render: [] },
});

it('runs sample transforms through paired sockets, substitutes external calls, and binds cancellation to the originating connection', async () => {
  const db = new Database(':memory:');
  const tokens = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
  // No execution, provider, recipe-store or warehouse dependencies are wired.
  const server = await startServer(0, { clientTokens: tokens });
  const sockets: WebSocket[] = [];
  const connect = async (instance?: string, client_kind: 'webclient' | 'bridge' = 'webclient'): Promise<WebSocket> => {
    const token = await tokens.issue({ client_kind, client_label: 'Simulation test',
      ...(instance ? { metadata: { instance_id: instance } } : {}),
    });
    return new Promise((resolve, reject) => {
      const bearer = encodeURIComponent(`${token.token_id}.${token.bearer}`);
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${bearer}`);
      sockets.push(ws); ws.once('open', () => resolve(ws)); ws.once('error', reject);
    });
  };
  try {
    const owner = await connect('owner');
    const other = await connect('other');
    const unpaired = await connect();
    const bridge = await connect('bridge', 'bridge');
    const recipe = definition([
      { id: 'read', op: 'core.records.list', args: {} },
      { id: 'count', transform: 'count', input: '{{step.read}}' },
      { id: 'send', ingredient: 'catalog-fetch', input: { operation: 'send' } },
    ]);
    const request = { simulation_id: 'sample', recipe,
      sample: { mocks: { read: { result: ['a', 'b'] }, send: { result: { id: 'fixture-only' } } } } };
    expect(await rpc(unpaired, 'recipe.simulate', request)).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(bridge, 'recipe.simulate', request)).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner, 'recipe.simulate', request)).toMatchObject({ result: { status: 'passed', steps: [
      { id: 'read', mocked: true, output: ['a', 'b'] },
      { id: 'count', mocked: false, output: 2 },
      { id: 'send', mocked: true, output: { id: 'fixture-only' } },
    ] } });
    expect(await rpc(owner, 'recipe.simulate', { ...request, sample: {} }))
      .toMatchObject({ result: { status: 'failed', steps: [
        { id: 'read', status: 'failed' }, { id: 'count', status: 'blocked' }, { id: 'send', status: 'blocked' },
      ] } });
    expect(await rpc(owner, 'recipe.simulate', { ...request, recipe: null })).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(owner, 'recipe.simulate', { ...request, sample: [] })).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(owner, 'recipe.simulate', { ...request, sample: { config: 'invalid' } }))
      .toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(owner, 'recipe.simulate', {
      simulation_id: 'oversized-result',
      recipe: {
        ...definition(Array.from({ length: 15 }, (_, index) => ({
          id: `copy${index}`, transform: 'coalesce', values: ['{{config.payload}}', index],
        }))),
        variables: { payload: '' },
      },
      sample: { config: { payload: 'x'.repeat(900_000) } },
    })).toMatchObject({ error: { code: 'bad_request', message: expect.stringContaining('Sample results exceed 2 MB') } });

    const running = rpc(owner, 'recipe.simulate', { ...request, simulation_id: 'long',
      recipe: definition(Array.from({ length: 300 }, (_, index) => ({ id: `step${index}`, transform: 'count', input: [] }))),
    });
    // This response also proves the first request has entered the simulator.
    expect(await rpc(owner, 'recipe.simulate', request)).toMatchObject({ error: { code: 'conflict' } });
    expect(await rpc(other, 'recipe.simulate.cancel', { simulation_id: 'long' })).toMatchObject({ result: { cancelled: false } });
    expect(await rpc(unpaired, 'recipe.simulate.cancel', { simulation_id: 'long' })).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner, 'recipe.simulate.cancel', { simulation_id: 'wrong' })).toMatchObject({ result: { cancelled: false } });
    expect(await rpc(owner, 'recipe.simulate.cancel', { simulation_id: 'long' })).toMatchObject({ result: { cancelled: true } });
    expect(await running).toMatchObject({ error: { code: 'cancelled' } });
    expect(await rpc(owner, 'recipe.simulate', request)).toMatchObject({ result: { status: 'passed' } });
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('recipe.');
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close(); db.close();
  }
}, 15000);
