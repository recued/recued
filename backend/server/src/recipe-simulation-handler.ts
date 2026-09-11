/** Owner-only, temporary sample execution. Never installs or runs live recipes. */
import { RpcError, type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import { simulateRecipe } from '@recued/engine';
import { parseRecipe } from '@recued/recipes';
import type { WsClient } from './ws-server.js';

type Methods = 'recipe.simulate' | 'recipe.simulate.cancel';
const requireClient = (client: WsClient): void => {
  if (!client.instance_id || client.client_kind !== 'webclient') {
    throw new RpcError('unauthorized', 'Recipe tests require a paired webclient.', 401);
  }
};
const requireId = (id: unknown): string => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
    throw new RpcError('bad_request', 'Provide a valid recipe test id.', 400);
  }
  return id;
};

export const makeRecipeSimulationHandlers = (): HandlerSlice<ServerRpcRegistry, Methods, WsClient> => {
  // RPC dispatch makes a fresh identity projection for each request. The socket
  // is the stable connection key, so another tab cannot cancel this test.
  const active = new WeakMap<object, { id: string; abort: AbortController }>();
  return {
    methods: ['recipe.simulate', 'recipe.simulate.cancel'],
    handlers: {
      'recipe.simulate': async (req, client) => {
        requireClient(client);
        const id = requireId(req?.simulation_id);
        if (active.has(client.ws)) throw new RpcError('conflict', 'Wait for the current recipe test to finish.', 409);
        if (Buffer.byteLength(JSON.stringify(req), 'utf8') > 2_000_000) {
          throw new RpcError('bad_request', 'Use a sample smaller than 2 MB.', 400);
        }
        if (!req.sample || typeof req.sample !== 'object' || Array.isArray(req.sample)) {
          throw new RpcError('bad_request', 'Sample data must be a JSON object.', 400);
        }
        const parsed = parseRecipe(req.recipe);
        if (!parsed.ok) {
          throw new RpcError('bad_request', parsed.issues.map(issue => issue.message).join('\n'), 400);
        }
        const abort = new AbortController();
        const close = (): void => abort.abort(new RpcError('cancelled', 'Recipe test cancelled.', 499));
        active.set(client.ws, { id, abort });
        client.ws.once('close', close);
        const timeout = setTimeout(() => abort.abort(new RpcError('timeout', 'Recipe test exceeded 30 seconds.', 408)), 30_000);
        timeout.unref();
        try {
          return await simulateRecipe(parsed.recipe, req.sample, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) throw abort.signal.reason;
          throw new RpcError('bad_request', error instanceof Error ? error.message : 'Recipe test failed.', 400);
        } finally {
          clearTimeout(timeout);
          client.ws.off('close', close);
          active.delete(client.ws);
        }
      },
      'recipe.simulate.cancel': async (req, client) => {
        requireClient(client);
        const id = requireId(req?.simulation_id);
        const pending = active.get(client.ws);
        if (!pending || pending.id !== id) return { cancelled: false };
        pending.abort.abort(new RpcError('cancelled', 'Recipe test cancelled.', 499));
        return { cancelled: true };
      },
    },
  };
};
