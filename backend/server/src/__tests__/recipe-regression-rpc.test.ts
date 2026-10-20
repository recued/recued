import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { MCP_RESERVED_RPC_PREFIXES, type RecipeRegressionRead, type RecipeRegressionRun } from '@recued/contracts';
import { startServer } from '../server.js';
import { regressionFixture,regressionRequest,regressionRecipe } from './recipe-regression-fixture.js';
interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket,method: string,args: unknown): Promise<Reply> => new Promise((resolve,reject) => {
  const request_id = crypto.randomUUID(), timer = setTimeout(() => { ws.off('message',receive); reject(new Error('Recipe suite RPC timed out: ' + method)); },8000);
  const receive = (data: WebSocket.RawData): void => { const reply = JSON.parse(data.toString()) as Reply;
    if (reply.request_id === request_id) { clearTimeout(timer); ws.off('message',receive); resolve(reply); } };
  ws.on('message',receive); ws.send(JSON.stringify({ type: 'rpc',request_id,method,args }));
});
it('runs saved suites through actual paired RPC with no provider or recipe-execution dependencies',async () => {
  const f = regressionFixture(), server = await startServer(0,{ clientTokens: f.clients,recipeRegressionDeps: { store: f.store,clientTokens: f.clients } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli',instance?: string) => {
    const token = await f.clients.issue({ client_kind: kind,...(instance ? { metadata: { instance_id: instance } } : {}) });
    const ws = await new Promise<WebSocket>((resolve,reject) => { const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`);
      sockets.push(socket); socket.once('open',() => resolve(socket)); socket.once('error',reject); });
    return { ws,token };
  };
  try {
    const owner = await connect('webclient','owner'), other = await connect('webclient','other'), cli = await connect('cli'), unpaired = await connect('webclient');
    const request = regressionRequest();
    for (const client of [cli,unpaired]) for (const method of ['get','save','delete','run','cancel']) {
      expect(await rpc(client.ws,'recipe.regression.' + method,{})).toMatchObject({ error: { code: 'unauthorized' } });
    }
    expect(await rpc(owner.ws,'recipe.regression.save',{ ...request,source: { owner: true } })).toMatchObject({ error: { code: 'bad_request' } });
    const first = await rpc(owner.ws,'recipe.regression.save',request); expect(first.error).toBeUndefined();
    const saved = first.result as RecipeRegressionRead;
    expect(saved).toMatchObject({ head_revision: 1,version: { revision: 1 } });
    expect((await rpc(owner.ws,'recipe.regression.save',request)).result).toEqual(saved);
    const changed = regressionRecipe(); changed.steps[0] = { id: 'count',transform: 'count',input: [1] };
    const run: RecipeRegressionRun = { recipe_id: request.recipe_id,revision: 1,run_id: crypto.randomUUID(),candidate: changed };
    expect(await rpc(owner.ws,'recipe.regression.run',run)).toMatchObject({ result: { passed: 0,failed: 1,changed: 1,revision: 1,suite_digest: saved.version!.digest,
      candidate_hash: expect.stringMatching(/^sha256:/),baseline_hash: expect.stringMatching(/^sha256:/) } });
    expect(await rpc(owner.ws,'recipe.regression.run',{ ...run,candidate: { ...changed,recipe_id: 'another' } })).toMatchObject({ error: { code: 'bad_request' } });
    const long = regressionRecipe(); long.steps = Array.from({ length: 300 },(_,index) => ({ id: 'step' + index,transform: 'count',input: [] }));
    const pending = rpc(owner.ws,'recipe.regression.run',{ ...run,candidate: long });
    expect(await rpc(owner.ws,'recipe.regression.run',run)).toMatchObject({ error: { code: 'conflict' } });
    expect(await rpc(other.ws,'recipe.regression.cancel',{ run_id: run.run_id })).toMatchObject({ result: { cancelled: false } });
    expect(await rpc(owner.ws,'recipe.regression.cancel',{ run_id: 'wrong' })).toMatchObject({ result: { cancelled: false } });
    expect(await rpc(owner.ws,'recipe.regression.cancel',{ run_id: run.run_id })).toMatchObject({ result: { cancelled: true } });
    expect(await pending).toMatchObject({ error: { code: 'cancelled' } });
    expect(await rpc(owner.ws,'recipe.regression.run',run)).toMatchObject({ result: { failed: 1 } });
    const open = f.codec.open.bind(f.codec);
    vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const material = await open(value); f.clients.revoke(owner.token.token_id,'Revoked during test loading'); return material; });
    expect(await rpc(owner.ws,'recipe.regression.get',{ recipe_id: request.recipe_id })).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(other.ws,'recipe.regression.get',{ recipe_id: request.recipe_id })).toMatchObject({ result: { head_revision: 1 } });
    expect(await rpc(other.ws,'recipe.regression.delete',{ recipe_id: request.recipe_id,expected_revision: 1,request_id: crypto.randomUUID() }))
      .toMatchObject({ result: { version: null,versions: [] } });
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('recipe.');
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('core_records','commits','preapproval_executions','recipes')").all()).toEqual([]);
  } finally { for (const socket of sockets) socket.terminate(); await server.close(); f.close(); }
},20000);
