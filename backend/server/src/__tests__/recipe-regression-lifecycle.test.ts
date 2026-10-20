import { afterEach,expect,it,vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runRecipeRegression } from '@recued/engine';
import type { WsClient } from '../ws-server.js';
import { makeRecipeRegressionHandlers } from '../recipe-regression-handler.js';
import { regressionFixture,regressionRequest,regressionRecipe } from './recipe-regression-fixture.js';
vi.mock('@recued/engine',async original => ({ ...await original<typeof import('@recued/engine')>(),runRecipeRegression: vi.fn() }));
const fixtures: ReturnType<typeof regressionFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const f of fixtures.splice(0)) f.close(); });
it.each(['disconnect','deadline','revocation','vault_lock'] as const)('aborts a suite on %s and releases its timers and connection slot',async reason => {
  vi.mocked(runRecipeRegression).mockReset();
  const f = regressionFixture(); fixtures.push(f); await f.store.save(regressionRequest(),() => {});
  const token = await f.clients.issue({ client_kind: 'webclient',metadata: { instance_id: 'owner' } });
  const encrypted = f.db.prepare('SELECT encrypted FROM recipe_regression_versions').pluck().get() as string;
  const material = await f.codec.open(encrypted); vi.spyOn(f.codec,'open').mockResolvedValue(material);
  const ws = new EventEmitter();
  const client: WsClient = { ws,realm: 'realm',instance_id: 'owner',token_instance_id: 'owner',client_token_id: token.token_id,
    client_kind: 'webclient',display_name: 'Owner',connected_at: 1 };
  vi.useFakeTimers();
  vi.mocked(runRecipeRegression).mockImplementationOnce((_suite,_recipe,signal) => new Promise((_resolve,reject) => {
    signal!.addEventListener('abort',() => reject(signal!.reason),{ once: true });
  }));
  const handlers = makeRecipeRegressionHandlers({ store: f.store,clientTokens: f.clients }).handlers;
  const request = { recipe_id: 'regression-test',revision: 1,run_id: 'run',candidate: regressionRecipe() };
  const pending = handlers['recipe.regression.run'](request,client);
  const rejection = expect(pending).rejects.toMatchObject({ code: reason === 'deadline' ? 'timeout' : reason === 'vault_lock' ? 'server_locked' : reason === 'revocation' ? 'unauthorized' : 'cancelled' });
  await vi.waitFor(() => expect(runRecipeRegression).toHaveBeenCalled());
  if (reason === 'disconnect') ws.emit('close');
  else if (reason === 'deadline') await vi.advanceTimersByTimeAsync(60_000);
  else { if (reason === 'revocation') f.clients.revoke(token.token_id,'Revoked during suite'); else f.state.locked = true; await vi.advanceTimersByTimeAsync(100); }
  await rejection;
  expect(ws.listenerCount('close')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  if (reason !== 'revocation') {
    f.state.locked = false;
    vi.mocked(runRecipeRegression).mockResolvedValueOnce({ cases: [],passed: 0,failed: 0,changed: 0 });
    await expect(handlers['recipe.regression.run'](request,client)).resolves.toMatchObject({ revision: 1 });
    expect(vi.getTimerCount()).toBe(0);
  }
});
