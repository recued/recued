import { RpcError, regressionObject, regressionText, regressionBytes, RECIPE_REGRESSION_LIMITS,
  type HandlerSlice, type ServerRpcRegistry, type RecipeRegressionRun, type RecipeRegressionResult } from '@recued/contracts';
import { normalizeRegressionRecipe, runRecipeRegression } from '@recued/engine';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { WsClient } from './ws-server.js';
import { regressionDigest, type RecipeRegressionStore } from './storage/recipe-regression-store.js';

export interface RecipeRegressionDeps { store: RecipeRegressionStore; clientTokens: Pick<ClientTokenStore,'get'> }
type Methods = 'recipe.regression.get' | 'recipe.regression.save' | 'recipe.regression.delete' | 'recipe.regression.run' | 'recipe.regression.cancel';
const revision = (value: unknown, zero = false): number => {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < (zero ? 0 : 1) || value >= Number.MAX_SAFE_INTEGER) throw new RpcError('bad_request','Choose a valid test revision.',400);
  return value;
};
export interface RecipeRegressionRunner {
  runPrepared<T>(runId: string, client: WsClient, prepare: (check: () => void) => Promise<RecipeRegressionRun>,
    complete: (result: RecipeRegressionResult, check: () => void) => Promise<T>): Promise<T>;
  runBatchPrepared<T>(runId: string, client: WsClient, prepare: (check: () => void) => Promise<RecipeRegressionRun[]>,
    complete: (results: RecipeRegressionResult[], check: () => void) => Promise<T>): Promise<T>;
}
export const makeRecipeRegressionHandlers = (deps?: RecipeRegressionDeps): HandlerSlice<ServerRpcRegistry,Methods,WsClient> & RecipeRegressionRunner => {
  const active = new WeakMap<object,{ id: string; abort: AbortController }>(); let activeCount = 0;
  const owner = (client: WsClient): RecipeRegressionDeps => {
    if (!deps) throw new RpcError('not_configured','Saved recipe tests are unavailable on this server.',503);
    const token = client.client_token_id ? deps.clientTokens.get(client.client_token_id) : null;
    const instance = client.token_instance_id ?? client.instance_id;
    if (client.client_kind !== 'webclient' || !token || token.client_kind !== 'webclient' || token.revoked_at !== null
      || !instance || token.metadata?.instance_id !== instance) throw new RpcError('unauthorized','Open saved recipe tests in your paired webclient.',403);
    return deps;
  };
  const input = (raw: unknown, fields: string[]): Record<string,unknown> => {
    if (regressionBytes(raw) > RECIPE_REGRESSION_LIMITS.suite_bytes + 4096) throw new RpcError('bad_request','Use a request smaller than 1 MB.',400);
    return regressionObject(raw,fields);
  };
  const recipeId = (value: unknown): string => regressionText(value,'a recipe id',200);
  const requestId = (value: unknown): string => {
    const id = regressionText(value,'a request id',100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new RpcError('bad_request','Invalid test request id.',400);
    return id;
  };
  const runBatchPrepared: RecipeRegressionRunner['runBatchPrepared'] = async (runId,client,prepare,complete) => {
    const current = owner(client);
    if (active.has(client.ws) || activeCount >= 2) throw new RpcError('conflict','Wait for a running test suite to finish.',409);
      const abort = new AbortController(); active.set(client.ws,{ id: runId,abort }); activeCount++;
      const close = (): void => abort.abort(new RpcError('cancelled','Recipe test suite disconnected.',499));
      const check = (): void => { owner(client); current.store.codec.assertUnlocked(); abort.signal.throwIfAborted(); };
      client.ws.once('close',close);
      const timeout = setTimeout(() => abort.abort(new RpcError('timeout','Recipe test suite exceeded 60 seconds.',408)),RECIPE_REGRESSION_LIMITS.run_ms); timeout.unref();
      const watch = setInterval(() => { try { check(); } catch (error) { abort.abort(error); } },100); watch.unref();
      try {
        const requests = await prepare(check); check();
        const replies: RecipeRegressionResult[] = []; let retained = 0;
        if (!requests.length || requests.length > 20) throw new RpcError('bad_request','Test between 1 and 20 saved recipes.',400);
        for (const request of requests) {
        if (request.run_id !== runId) throw new RpcError('bad_request','The test run identity changed.',400);
        const saved = await current.store.read(request.recipe_id,request.revision,check); check();
        if (!saved.version) throw new RpcError('not_found','Save a test version before running the suite.',404);
        const snapshot = saved.version;
        const result = await runRecipeRegression(snapshot.suite,request.candidate,abort.signal); check();
        // A concurrent deletion or retention prune invalidates this view; a
        // newer retained version does not change the explicitly selected one.
        await current.store.read(request.recipe_id,request.revision,check); check();
        const reply = { ...result,recipe_id: request.recipe_id,revision: request.revision,suite_digest: snapshot.digest,
          baseline_hash: regressionDigest(snapshot.suite.baseline),candidate_hash: regressionDigest(request.candidate) };
        if (regressionBytes(reply) > RECIPE_REGRESSION_LIMITS.result_bytes) throw new RpcError('bad_request','Suite results exceed 4 MB. Use fewer cases or smaller outputs.',400);
        retained += regressionBytes(reply);
        if (retained > RECIPE_REGRESSION_LIMITS.result_bytes) throw new RpcError('bad_request','Pack test results exceed 4 MB. Use smaller suites or outputs.',400);
        replies.push(reply);
        }
        return await complete(replies,check);
      } finally { clearTimeout(timeout); clearInterval(watch); client.ws.off('close',close); active.delete(client.ws); activeCount--; }
  };
  const runPrepared: RecipeRegressionRunner['runPrepared'] = (runId,client,prepare,complete) =>
    runBatchPrepared(runId,client,async check => [await prepare(check)],async (results,check) => complete(results[0]!,check));
  return { runPrepared,runBatchPrepared,methods: ['recipe.regression.get','recipe.regression.save','recipe.regression.delete','recipe.regression.run','recipe.regression.cancel'], handlers: {
    'recipe.regression.get': async (raw,client) => {
      const current = owner(client), value = input(raw,['recipe_id','revision']);
      return current.store.read(recipeId(value.recipe_id),value.revision === undefined ? undefined : revision(value.revision),() => { owner(client); });
    },
    'recipe.regression.save': async (raw,client) => {
      const current = owner(client), value = input(raw,['recipe_id','expected_revision','request_id','suite']);
      return current.store.save({ recipe_id: recipeId(value.recipe_id),expected_revision: revision(value.expected_revision,true),
        request_id: requestId(value.request_id),suite: raw.suite },() => { owner(client); });
    },
    'recipe.regression.delete': async (raw,client) => {
      const current = owner(client), value = input(raw,['recipe_id','expected_revision','request_id']);
      return current.store.remove({ recipe_id: recipeId(value.recipe_id),expected_revision: revision(value.expected_revision,true),
        request_id: requestId(value.request_id) },() => { owner(client); });
    },
    'recipe.regression.cancel': async (raw,client) => {
      owner(client); const value = input(raw,['run_id']), id = requestId(value.run_id), running = active.get(client.ws);
      if (!running || running.id !== id) return { cancelled: false };
      running.abort.abort(new RpcError('cancelled','Recipe test suite cancelled.',499)); return { cancelled: true };
    },
    'recipe.regression.run': async (raw,client) => {
      const current = owner(client), value = input(raw,['recipe_id','revision','run_id','candidate']);
      const request: RecipeRegressionRun = { recipe_id: recipeId(value.recipe_id),revision: revision(value.revision),
        run_id: requestId(value.run_id),candidate: normalizeRegressionRecipe(value.candidate) };
      if (request.candidate.recipe_id !== request.recipe_id) throw new RpcError('bad_request','Compare versions of the same recipe.',400);
      return runPrepared(request.run_id,client,async () => request,async result => result);
    },
  } };
};
