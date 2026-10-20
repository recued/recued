import { expect,it,vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WsClient } from '../ws-server.js';
import { createRecipeStore } from '../recipe-store.js';
import { createRecipeReleaseStore } from '../storage/recipe-release-store.js';
import { recipeReleaseDigest as digest } from '../storage/recipe-release-authority.js';
import { makeRecipeRegressionHandlers } from '../recipe-regression-handler.js';
import { makeRecipeReleaseHandlers } from '../recipe-release-handler.js';
import { regressionFixture,regressionRecipe,regressionRequest } from './recipe-regression-fixture.js';
it('enrolls cancellation before private draft loading and cannot retain a passing receipt after cancellation',async () => {
  const f = regressionFixture(), recipes = createRecipeStore('/no-community',f.db), candidate = regressionRecipe(); recipes.save(candidate,'owner','inline');
  await f.store.save(regressionRequest(),() => {});
  const store = createRecipeReleaseStore(f.db,f.codec,recipes,f.store,() => {});
  await store.save({ recipe_id: candidate.recipe_id,expected_revision: 0,expected_active_digest: digest(candidate),request_id: crypto.randomUUID(),candidate },'owner',() => {});
  const token = await f.clients.issue({ client_kind: 'webclient',metadata: { instance_id: 'owner' } });
  const ws = new EventEmitter(), client: WsClient = { ws,realm: 'realm',instance_id: 'owner',token_instance_id: 'owner',client_token_id: token.token_id,client_kind: 'webclient',display_name: 'Owner',connected_at: 1 };
  const regression = makeRecipeRegressionHandlers({ store: f.store,clientTokens: f.clients });
  const handlers = makeRecipeReleaseHandlers({ store,suites: f.store,clientTokens: f.clients },regression).handlers;
  const first = await handlers['recipe.release.test']({ recipe_id: candidate.recipe_id,expected_revision: 1,draft_revision: 1,run_id: 'first-pass' },client);
  expect(first.qualification).not.toBeNull();
  const review = await handlers['recipe.release.prepare']({ recipe_id: candidate.recipe_id,expected_revision: 1,draft_revision: 1,receipt_id: first.qualification!.receipt_id },client);
  let release: (() => void) | undefined; const open = f.codec.open.bind(f.codec);
  const spy = vi.spyOn(f.codec,'open').mockImplementationOnce(async encrypted => { const material = await open(encrypted); await new Promise<void>(resolve => { release = resolve; }); return material; });
  try {
    const pending = handlers['recipe.release.test']({ recipe_id: candidate.recipe_id,expected_revision: 1,draft_revision: 1,run_id: 'early-cancel' },client);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await regression.handlers['recipe.regression.cancel']({ run_id: 'early-cancel' },{ ...client,ws: new EventEmitter() })).toEqual({ cancelled: false });
    expect(await regression.handlers['recipe.regression.cancel']({ run_id: 'early-cancel' },client)).toEqual({ cancelled: true });
    release!(); await rejection; expect(ws.listenerCount('close')).toBe(0); spy.mockRestore();
    expect((await store.read(candidate.recipe_id,JSON.stringify([token.token_id,'owner']),() => {})).qualification).toBeNull();
    await expect(handlers['recipe.release.activate']({ recipe_id: candidate.recipe_id,expected_revision: 1,review_id: review.review_id,request_id: crypto.randomUUID() },client)).rejects.toMatchObject({ code: 'recipe_release_conflict' });
    expect(recipes.get(candidate.recipe_id)).toEqual(candidate);
  } finally { release?.(); spy.mockRestore(); f.close(); }
});
