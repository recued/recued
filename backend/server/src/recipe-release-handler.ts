import { RpcError, regressionObject, regressionText, regressionBytes, RECIPE_RELEASE_LIMITS,
  type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import { normalizeRegressionRecipe } from '@recued/engine';
import type { WsClient } from './ws-server.js';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { RecipeRegressionRunner } from './recipe-regression-handler.js';
import type { RecipeRegressionStore } from './storage/recipe-regression-store.js';
import type { RecipeReleaseStore } from './storage/recipe-release-store.js';

export interface RecipeReleaseDeps {
  store: RecipeReleaseStore; suites: RecipeRegressionStore; clientTokens: Pick<ClientTokenStore,'get'>;
}
type Methods = 'recipe.release.get' | 'recipe.release.save' | 'recipe.release.restore'
  | 'recipe.release.test' | 'recipe.release.prepare' | 'recipe.release.activate';
const number = (raw: unknown, zero = false): number => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < (zero ? 0 : 1) || raw >= Number.MAX_SAFE_INTEGER) throw new RpcError('bad_request','Provide a valid release revision.',400);
  return raw;
};
const id = (raw: unknown): string => regressionText(raw,'an identifier',200);
const requestId = (raw: unknown): string => {
  const value = regressionText(raw,'a request id',100);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new RpcError('bad_request','Invalid release request id.',400);
  return value;
};
export const makeRecipeReleaseHandlers = (deps: RecipeReleaseDeps | undefined, runner: RecipeRegressionRunner): HandlerSlice<ServerRpcRegistry,Methods,WsClient> => {
  const owner = (client: WsClient): { current: RecipeReleaseDeps; actor: string } => {
    if (!deps) throw new RpcError('not_configured','Reviewed recipe releases are unavailable on this server.',503);
    const token = client.client_token_id ? deps.clientTokens.get(client.client_token_id) : null;
    const instance = client.token_instance_id ?? client.instance_id;
    if (client.client_kind !== 'webclient' || !token || token.client_kind !== 'webclient' || token.revoked_at !== null
      || !instance || token.metadata?.instance_id !== instance) throw new RpcError('unauthorized','Use your paired webclient to review recipe releases.',403);
    return { current: deps,actor: JSON.stringify([token.token_id,instance]) };
  };
  const input = (raw: unknown, fields: string[]): Record<string,unknown> => {
    if (regressionBytes(raw) > RECIPE_RELEASE_LIMITS.recipe_bytes + 4096) throw new RpcError('bad_request','Use a release request smaller than 1 MB.',400);
    return regressionObject(raw,fields);
  };
  return { methods: ['recipe.release.get','recipe.release.save','recipe.release.restore','recipe.release.test','recipe.release.prepare','recipe.release.activate'],handlers: {
    'recipe.release.get': async (raw,client) => {
      const { current,actor } = owner(client), value = input(raw,['recipe_id']);
      return current.store.read(id(value.recipe_id),actor,() => { owner(client); });
    },
    'recipe.release.save': async (raw,client) => {
      const { current,actor } = owner(client), value = input(raw,['recipe_id','expected_revision','expected_active_digest','request_id','candidate']);
      return current.store.save({ recipe_id: id(value.recipe_id),expected_revision: number(value.expected_revision,true),
        expected_active_digest: id(value.expected_active_digest),request_id: requestId(value.request_id),candidate: normalizeRegressionRecipe(value.candidate) },actor,() => { owner(client); });
    },
    'recipe.release.restore': async (raw,client) => {
      const { current,actor } = owner(client), value = input(raw,['recipe_id','expected_revision','expected_active_digest','request_id','sequence']);
      return current.store.save({ recipe_id: id(value.recipe_id),expected_revision: number(value.expected_revision,true),expected_active_digest: id(value.expected_active_digest),
        request_id: requestId(value.request_id),sequence: number(value.sequence) },actor,() => { owner(client); });
    },
    'recipe.release.test': async (raw,client) => {
      const { current,actor } = owner(client), value = input(raw,['recipe_id','expected_revision','draft_revision','run_id']);
      const recipe_id = id(value.recipe_id), expected = number(value.expected_revision), draftRevision = number(value.draft_revision), run_id = requestId(value.run_id);
      let attempt = '';
      return runner.runPrepared(run_id,client,async check => {
        const draft = await current.store.beginTest(recipe_id,expected,draftRevision,check); attempt = draft.test_attempt;
        const suite = await current.suites.read(recipe_id,undefined,check); check();
        if (!suite.version) throw new RpcError('not_found','Save a recipe test suite before testing a release draft.',404);
        return { recipe_id,revision: suite.version.revision,run_id,candidate: draft.recipe };
      },async (comparison,check) => {
        const result = await current.store.qualify(recipe_id,expected,draftRevision,comparison,attempt,actor,check); check();
        return { ...result,comparison };
      });
    },
    'recipe.release.prepare': async (raw,client) => {
      const { current,actor } = owner(client), value = input(raw,['recipe_id','expected_revision','draft_revision','receipt_id']);
      return current.store.prepare({ recipe_id: id(value.recipe_id),expected_revision: number(value.expected_revision),draft_revision: number(value.draft_revision),
        receipt_id: requestId(value.receipt_id) },actor,() => { owner(client); });
    },
    'recipe.release.activate': async (raw,client) => {
      const { current,actor } = owner(client), value = input(raw,['recipe_id','expected_revision','review_id','request_id']);
      return current.store.activate({ recipe_id: id(value.recipe_id),expected_revision: number(value.expected_revision),review_id: requestId(value.review_id),
        request_id: requestId(value.request_id) },actor,() => { owner(client); });
    },
  } };
};
