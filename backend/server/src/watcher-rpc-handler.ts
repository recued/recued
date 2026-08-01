/** D-115 Phase 6D — `runtime.runWatcher` rpc handler.
 *
 *  Forwarder for the extension's watcher dispatcher. The extension keeps
 *  `time-watcher`, `recipe-watcher`, and `http-watcher`
 *  local (pure), and rpcs `mail-watcher` / `file-watcher` /
 *  `calendar-watcher` here so the server can answer them off the warehouse.
 *
 *  ⛔ D-228 — `webhook-watcher` and `time-relative-watcher` are NO LONGER
 *  forwardable (they were, and that was the hole): both key per-recipe state on
 *  a `recipe_id` this transport cannot vouch for. See the fence below.
 *
 *  This is a thin pass-through. `createWatcherDispatcher` already maps
 *  every slug to its handler (or to `SERVER_NOT_REACHABLE` when a dep
 *  is missing). We surface IngredientErrors as RpcErrors so the
 *  ext-side conn raises a typed RpcError the kernel adapter can map
 *  back to an ingredient-tier failure. */

import {
  IngredientError,
  RECIPE_KEYED_WATCHER_SLUGS,
  type KernelDispatchers,
  type KernelWatcherSlug,
} from '@recued/ingredients';
import { RpcError } from '@recued/contracts';
import type { HandlerSlice, ServerRpcRegistry } from '@recued/contracts';

import type { WsClient } from './ws-server.js';

type WatcherDispatcher = NonNullable<KernelDispatchers['watcher']>;

export interface WatcherRpcDeps {
  /** Same dispatcher composed inside `executorConfig.kernelDispatchers.watcher`.
   *  Bin.ts hoists the binding so the rpc handler and the in-process
   *  kernel adapter share one source of truth. */
  watcherDispatcher: WatcherDispatcher;
}

export const handleRunWatcher = async (
  deps: WatcherRpcDeps,
  args: { slug: string; args: Record<string, unknown> },
): Promise<Record<string, unknown> & { should_run: boolean }> => {
  if (typeof args.slug !== 'string' || args.slug.length === 0) {
    throw new RpcError(
      'bad_request',
      'runtime.runWatcher: slug must be a non-empty string',
      400,
    );
  }
  if (args.args === null || typeof args.args !== 'object') {
    throw new RpcError(
      'bad_request',
      'runtime.runWatcher: args must be an object',
      400,
    );
  }
  // ⛔⛔ D-228 — A WATCHER THAT KEYS PER-RECIPE STATE CANNOT CROSS THIS
  // TRANSPORT. `webhook-watcher` drains (and DELETES) a per-`(recipe_id, slug)`
  // queue; `time-relative-watcher` writes a durable firing ledger. Both key that
  // state on `recipe_id`, and the kernel adapter supplies it from ENGINE-owned
  // `stepMeta` precisely so a caller cannot choose it.
  //
  // This handler is a thin pass-through with no engine context — it has no
  // identity to supply, so it must not pretend to. Forwarding would let a caller
  // name ANOTHER recipe's queue and both read its contents (headers, body,
  // source IP — a webhook's authorization and signature headers) and destroy
  // them, leaving the owning recipe to miss those deliveries permanently.
  //
  // ⚠ Refusing costs nothing today: no client calls `runtime.runWatcher`, and
  // D-148 P12 retired client-side execution, so a paired client has no business
  // consuming a trigger queue the server's own engine owns. The other six
  // watchers take explicit args and mutate nothing — they stay forwardable, so
  // this is a narrow fence, not a retirement of the rpc.
  if (RECIPE_KEYED_WATCHER_SLUGS.has(args.slug as KernelWatcherSlug)) {
    throw new RpcError(
      'bad_request',
      `runtime.runWatcher[${args.slug}]: this watcher keys per-recipe state and `
        + 'requires engine-owned recipe identity, which this transport cannot supply. '
        + 'It runs on the server as part of the owning recipe.',
      400,
    );
  }
  try {
    // The dispatcher's slug param is typed as the closed
    // `KernelWatcherSlug` union; the runtime switch rejects unknown
    // slugs with a SERVER_NOT_REACHABLE IngredientError, which we
    // re-raise as a typed RpcError below.
    const out = await deps.watcherDispatcher({
      slug: args.slug as Parameters<WatcherDispatcher>[0]['slug'],
      args: args.args,
    });
    return out as Record<string, unknown> & { should_run: boolean };
  } catch (e) {
    if (e instanceof IngredientError) {
      // Map ingredient errors to a typed rpc error so the ext-side
      // kernel adapter raises a watcher failure (not a transport
      // crash) and the trigger phase counts it toward the circuit
      // breaker. The 503 status mirrors `SERVER_NOT_REACHABLE`'s
      // semantic (server can't service this slug right now).
      const status = e.code === 'SERVER_NOT_REACHABLE' ? 503 : 400;
      throw new RpcError(
        e.code === 'SERVER_NOT_REACHABLE' ? 'service_unavailable' : 'bad_request',
        `runtime.runWatcher[${args.slug}]: ${e.message}`,
        status,
      );
    }
    throw e;
  }
};

export const makeWatcherRpcHandlers = (
  deps: WatcherRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'runtime.runWatcher', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['runtime.runWatcher'],
    handlers: {
      'runtime.runWatcher': async (args) =>
        handleRunWatcher(deps, args as Parameters<typeof handleRunWatcher>[1]),
    },
  };
};
