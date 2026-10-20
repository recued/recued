import { RpcError, regressionObject, regressionText, regressionBytes,
  type HandlerSlice, type ServerRpcRegistry, type RecipeRunCaptureRequest, type RecipeRunCaptureImport } from '@recued/contracts';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { WsClient } from './ws-server.js';
import { handleRpcExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import type { RecipeRunCaptureStore } from './storage/recipe-run-capture-store.js';
export interface RecipeRunCaptureDeps { store: RecipeRunCaptureStore; clientTokens: Pick<ClientTokenStore,'get'> }
type Methods = 'recipe.capture.prepare' | 'recipe.capture.run' | 'recipe.capture.list' | 'recipe.capture.get' | 'recipe.capture.delete' | 'recipe.capture.import';
const identifier = (raw: unknown): string => {
  const value = regressionText(raw,'a capture identifier',200);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new RpcError('bad_request','Invalid capture identifier.',400); return value;
};
export const makeRecipeRunCaptureHandlers = (deps?: RecipeRunCaptureDeps,execute?: ExecuteHandlerDeps): HandlerSlice<ServerRpcRegistry,Methods,WsClient> => {
  const owner = (client: WsClient) => {
    if (!deps || !execute) throw new RpcError('not_configured','Recipe run capture is unavailable on this server.',503);
    const check = (): void => {
      const token = client.client_token_id ? deps.clientTokens.get(client.client_token_id) : null, instance = client.token_instance_id ?? client.instance_id;
      if (client.client_kind !== 'webclient' || !token || token.client_kind !== 'webclient' || token.revoked_at !== null || !instance || token.metadata?.instance_id !== instance) {
        throw new RpcError('unauthorized','Use your paired webclient to capture recipe runs.',403);
      }
    };
    check(); return { store: deps.store,execute,check,actor: JSON.stringify([client.client_token_id,client.token_instance_id ?? client.instance_id]) };
  };
  const input = (raw: unknown,keys: string[]) => {
    if (regressionBytes(raw) > 1_000_000) throw new RpcError('bad_request','Keep capture requests under 1 MB.',400); return regressionObject(raw,keys);
  };
  return { methods: ['recipe.capture.prepare','recipe.capture.run','recipe.capture.list','recipe.capture.get','recipe.capture.delete','recipe.capture.import'],handlers: {
    'recipe.capture.prepare': async (raw,client) => {
      const { store,actor,check } = owner(client), value = input(raw,['recipe_id','config','context','dish_id','connections']);
      const request: RecipeRunCaptureRequest = { recipe_id: regressionText(value.recipe_id,'an installed recipe ID') };
      for (const key of ['config','context'] as const) if (value[key] !== undefined) request[key] = regressionObject(value[key]);
      if (value.dish_id !== undefined) request.dish_id = regressionText(value.dish_id,'a dish ID');
      if (value.connections !== undefined) request.connections = Object.fromEntries(Object.entries(regressionObject(value.connections)).map(([key,value]) => [key,regressionText(value,'a connection name')]));
      return store.prepare(request,actor,check);
    },
    'recipe.capture.run': async (raw,client) => {
      const { store,execute,actor,check } = owner(client), value = input(raw,['capture_id']);
      return store.run(identifier(value.capture_id),actor,check,(request,observer) => handleRpcExecute(execute,{ ...request },client,{ regression_capture: observer }));
    },
    'recipe.capture.list': async (raw,client) => {
      const { store,actor,check } = owner(client), value = input(raw,['recipe_id']); return store.list(regressionText(value.recipe_id,'a recipe ID'),actor,check);
    },
    'recipe.capture.get': async (raw,client) => {
      const { store,actor,check } = owner(client), value = input(raw,['capture_id']); return store.read(identifier(value.capture_id),actor,check);
    },
    'recipe.capture.delete': async (raw,client) => {
      const { store,actor,check } = owner(client), value = input(raw,['capture_id']); return store.remove(identifier(value.capture_id),actor,check);
    },
    'recipe.capture.import': async (raw,client) => {
      const { store,actor,check } = owner(client), value = input(raw,['capture_id','recipe_digest','expected_revision','request_id','reviewed','case']);
      if (value.reviewed !== true || typeof value.expected_revision !== 'number' || !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0
        || value.expected_revision >= Number.MAX_SAFE_INTEGER || typeof value.recipe_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.recipe_digest)) throw new RpcError('bad_request','Review the capture and provide its exact recipe digest and saved-test revision.',400);
      const request: RecipeRunCaptureImport = { capture_id: identifier(value.capture_id),recipe_digest: value.recipe_digest,expected_revision: value.expected_revision,
        request_id: identifier(value.request_id),reviewed: true,case: raw.case };
      return store.import(request,actor,check);
    },
  } };
};
