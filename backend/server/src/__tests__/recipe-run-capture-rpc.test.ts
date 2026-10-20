import { expect,it,vi } from 'vitest';
import WebSocket from 'ws';
import { MCP_RESERVED_RPC_PREFIXES,type RecipeRunCaptureRead,type RecipeRunCaptureSummary } from '@recued/contracts';
import { createAuditLogStore,createCheckpointStore,createCommitStore,createInMemoryCollection,type AuditEntry,type ActivityEntry } from '@recued/storage';
import type { Checkpoint,Commit } from '@recued/contracts';
import { startServer } from '../server.js';
import { createRecipeRunCaptureStore } from '../storage/recipe-run-capture-store.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { regressionFixture,regressionRecipe } from './recipe-regression-fixture.js';
interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket,method: string,args: unknown): Promise<Reply> => new Promise((resolve,reject) => {
  const request_id = crypto.randomUUID(), timer = setTimeout(() => { ws.off('message',receive); reject(new Error('Capture RPC timed out: ' + method)); },10_000);
  const receive = (data: WebSocket.RawData) => { const reply = JSON.parse(data.toString()) as Reply;
    if (reply.request_id === request_id) { clearTimeout(timer); ws.off('message',receive); resolve(reply); } };
  ws.on('message',receive); ws.send(JSON.stringify({ type: 'rpc',request_id,method,args }));
});
it('captures a real paired recipe execution and imports a reviewed case through the existing encrypted suite store',async () => {
  const f = regressionFixture(), recipes = createRecipeStore('/no-corpus',f.db); recipes.save(regressionRecipe(),'owner','inline');
  const captures = createRecipeRunCaptureStore(f.codec,f.store);
  const manifests = createManifestRegistry('/no-corpus'), checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(),createInMemoryCollection<ActivityEntry>());
  const commitStore = createCommitStore(createInMemoryCollection<Commit>());
  manifests.register({ slug: 'capture-destructive',name: 'Destructive fixture',description: 'Fixture held for real approval.',author: 'test',
    kind: 'http',category: 'action',risk_tier: 'destructive',version: 1,input: { method: 'POST',url: 'https://capture-fixture.invalid/action' },output: { ok: 'ok' } });

  const server = await startServer(0,{ clientTokens: f.clients,recipeRegressionDeps: { store: f.store,clientTokens: f.clients },
    recipeRunCaptureDeps: { store: captures,clientTokens: f.clients },executeDeps: { recipeStore: recipes,executorConfig: { manifests },checkpointStore,auditLog,commitStore,baseVault: { secret: 'never-captured' },instanceId: 'capture-test' } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli',instance?: string) => {
    const token = await f.clients.issue({ client_kind: kind,...(instance ? { metadata: { instance_id: instance } } : {}) });
    const ws = await new Promise<WebSocket>((resolve,reject) => { const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`);
      sockets.push(socket); socket.once('open',() => resolve(socket)); socket.once('error',reject); }); return ws;
  };
  try {
    const owner = await connect('webclient','owner'), other = await connect('webclient','other'), cli = await connect('cli'), unpaired = await connect('webclient');
    for (const client of [cli,unpaired]) for (const method of ['prepare','run','list','get','delete','import']) expect(await rpc(client,'recipe.capture.' + method,{})).toMatchObject({ error: { code: 'unauthorized' } });
    const normal = await rpc(owner,'execute',{ recipe_id: 'regression-test',config: { rows: [] },regression_capture: { enabled: true } }); expect(normal.error).toBeUndefined();
    expect(await rpc(owner,'recipe.capture.list',{ recipe_id: 'regression-test' })).toMatchObject({ result: { captures: [] } });
    expect(await rpc(owner,'recipe.capture.prepare',{ recipe_id: 'regression-test',recipe: regressionRecipe() })).toMatchObject({ error: { code: 'bad_request' } });
    const prepared = await rpc(owner,'recipe.capture.prepare',{ recipe_id: 'regression-test',config: { rows: [1,2] } }); expect(prepared.error).toBeUndefined();
    const id = (prepared.result as RecipeRunCaptureSummary).capture_id;
    expect(await rpc(other,'recipe.capture.run',{ capture_id: id })).toMatchObject({ error: { code: 'not_found' } });
    const completed = await rpc(owner,'recipe.capture.run',{ capture_id: id }); expect(completed).toMatchObject({ result: { execution: { success: true },capture: { state: 'ready',run_outcome: 'passed' } } });
    expect(await rpc(owner,'recipe.capture.run',{ capture_id: id })).toMatchObject({ error: { code: 'capture_started' } });
    const read = (await rpc(owner,'recipe.capture.get',{ capture_id: id })).result as RecipeRunCaptureRead;
    expect(JSON.stringify(read)).not.toContain('never-captured'); expect(f.store.history('regression-test').head_revision).toBe(0);
    const request = { capture_id: id,recipe_digest: read.draft!.recipe_digest,expected_revision: 0,request_id: crypto.randomUUID(),reviewed: true,case: read.draft!.case };
    expect(await rpc(owner,'recipe.capture.import',{ ...request,reviewed: false })).toMatchObject({ error: { code: 'bad_request' } });
    const imported = await rpc(owner,'recipe.capture.import',request); expect(imported).toMatchObject({ result: { head_revision: 1,version: { revision: 1 } } });
    expect((await rpc(owner,'recipe.capture.import',request)).result).toEqual(imported.result);
    expect(await rpc(owner,'recipe.regression.run',{ recipe_id: 'regression-test',revision: 1,run_id: crypto.randomUUID(),candidate: regressionRecipe() })).toMatchObject({ result: { passed: 1,failed: 0 } });
    expect(await rpc(owner,'recipe.capture.delete',{ capture_id: id })).toMatchObject({ result: { deleted: true } });
    expect(f.store.history('regression-test').head_revision).toBe(1); expect(MCP_RESERVED_RPC_PREFIXES).toContain('recipe.');
    const heldRecipe = { ...regressionRecipe(),recipe_id: 'capture-held',variables: {},steps: [{ id: 'hold',ingredient: 'capture-destructive',input: {} }] };
    recipes.save(heldRecipe,'owner','inline');
    const fetch = vi.spyOn(globalThis,'fetch').mockImplementation(async () => { throw new Error('A held capture must not reach a provider'); });
    try {
      const held = (await rpc(owner,'recipe.capture.prepare',{ recipe_id: heldRecipe.recipe_id })).result as RecipeRunCaptureSummary;
      expect(await rpc(owner,'recipe.capture.run',{ capture_id: held.capture_id })).toMatchObject({ result: { execution: { awaiting_approval: true,success: false },capture: { state: 'unavailable',run_outcome: 'held' } } });
      expect(await checkpointStore.list()).toHaveLength(1); expect(fetch).not.toHaveBeenCalled();
      expect(await rpc(owner,'recipe.capture.get',{ capture_id: held.capture_id })).toMatchObject({ result: { draft: null } });
    } finally { fetch.mockRestore(); }

  } finally { for (const socket of sockets) socket.terminate(); await server.close(); f.close(); }
},30000);
