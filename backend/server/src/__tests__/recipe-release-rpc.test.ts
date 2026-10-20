import { expect, it } from 'vitest';
import WebSocket from 'ws';
import type { RecipeReleaseView, RecipeReleaseReview } from '@recued/contracts';
import { startServer } from '../server.js';
import { createRecipeStore } from '../recipe-store.js';
import { assertRecipeAuthoringGates } from '../recipe-save-handler.js';
import { createRecipeReleaseStore } from '../storage/recipe-release-store.js';
import { recipeReleaseDigest as digest } from '../storage/recipe-release-authority.js';
import { regressionFixture, regressionRequest, regressionRecipe } from './recipe-regression-fixture.js';
interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket,method: string,args: unknown): Promise<Reply> => new Promise((resolve,reject) => {
  const request_id = crypto.randomUUID(), timer = setTimeout(() => { ws.off('message',receive); reject(new Error('Release RPC timeout: ' + method)); },8000);
  const receive = (data: WebSocket.RawData): void => { const reply = JSON.parse(data.toString()) as Reply;
    if (reply.request_id === request_id) { clearTimeout(timer); ws.off('message',receive); resolve(reply); } };
  ws.on('message',receive); ws.send(JSON.stringify({ type: 'rpc',request_id,method,args }));
});
it('releases only a saved, tested and reviewed draft through paired RPC; ordinary save cannot bypass it',async () => {
  const f = regressionFixture(), recipes = createRecipeStore('/no-community',f.db), active = regressionRecipe(); recipes.save(active,'owner','inline');
  await f.store.save(regressionRequest(),() => {});
  const releaseStore = createRecipeReleaseStore(f.db,f.codec,recipes,f.store,recipe => { assertRecipeAuthoringGates({},recipe); });
  const server = await startServer(0,{ clientTokens: f.clients,recipeListDeps: { store: recipes,serverStartedAt: 0 },recipeSaveDeps: { store: recipes },
    recipeRegressionDeps: { store: f.store,clientTokens: f.clients },recipeReleaseDeps: { store: releaseStore,suites: f.store,clientTokens: f.clients } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli',instance?: string) => {
    const token = await f.clients.issue({ client_kind: kind,...(instance ? { metadata: { instance_id: instance } } : {}) });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`); sockets.push(socket);
    await new Promise<void>((resolve,reject) => { socket.once('open',resolve); socket.once('error',reject); }); return socket;
  };
  try {
    const owner = await connect('webclient','owner'), cli = await connect('cli'), unpaired = await connect('webclient');
    for (const ws of [cli,unpaired]) for (const method of ['get','save','restore','test','prepare','activate']) expect(await rpc(ws,'recipe.release.' + method,{})).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner,'recipe.release.get',{ recipe_id: active.recipe_id,authority: true })).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(owner,'recipe.release.save',{ recipe_id: active.recipe_id,expected_revision: 0,expected_active_digest: digest(active),request_id: 'bad request',candidate: active })).toMatchObject({ error: { code: 'bad_request' } });
    const candidate = regressionRecipe(); candidate.steps[0] = { id: 'count',transform: 'count',input: [] };
    const saved = await rpc(owner,'recipe.release.save',{ recipe_id: active.recipe_id,expected_revision: 0,expected_active_digest: digest(active),request_id: crypto.randomUUID(),candidate });
    expect(saved.error).toBeUndefined(); expect(recipes.get(active.recipe_id)).toEqual(active);
    expect(await rpc(owner,'recipe.save',{ recipe: candidate })).toMatchObject({ error: { code: 'recipe_release_required' } });
    const result = await rpc(owner,'recipe.release.test',{ recipe_id: active.recipe_id,expected_revision: 1,draft_revision: 1,run_id: crypto.randomUUID() });
    expect(result.error).toBeUndefined(); const qualified = result.result as RecipeReleaseView; expect(qualified.qualification).not.toBeNull();
    const prepared = await rpc(owner,'recipe.release.prepare',{ recipe_id: active.recipe_id,expected_revision: 1,draft_revision: 1,receipt_id: qualified.qualification!.receipt_id });
    expect(prepared.error).toBeUndefined(); const review = prepared.result as RecipeReleaseReview; expect(review.changes.length).toBeGreaterThan(0);
    const request = { recipe_id: active.recipe_id,expected_revision: 1,review_id: review.review_id,request_id: crypto.randomUUID() };
    expect(await rpc(owner,'recipe.release.activate',request)).toMatchObject({ result: { managed: true,revision: 2,activated: { sequence: 2,digest: digest(candidate) } } });
    expect(recipes.get(active.recipe_id)).toEqual(candidate);
    expect(await rpc(owner,'recipe.release.activate',request)).toMatchObject({ result: { revision: 2,activated: { sequence: 2 } } });
    const restored = await rpc(owner,'recipe.release.restore',{ recipe_id: active.recipe_id,expected_revision: 2,expected_active_digest: digest(candidate),request_id: crypto.randomUUID(),sequence: 1 });
    expect(restored).toMatchObject({ result: { revision: 3,qualification: null,saved_draft: { recipe: active } } });
    expect(recipes.get(active.recipe_id)).toEqual(candidate);
  } finally { for (const ws of sockets) ws.terminate(); await server.close(); f.close(); }
},20000);
