/** D-116 Phase 3 — `runtime.testTrigger` rpc handler.
 *
 *  Server-side entry for Kitchen's "Test trigger" flow on warehouse-
 *  routed watchers (mail / file / calendar). Kitchen resolves the
 *  step's `resolved_input` — redacting any `{{vault.*}}` refs — and
 *  forwards the call here. We dispatch through the already-composed
 *  `createWatcherDispatcher` so test-fire and production-fire share
 *  identical semantics.
 *
 *  The server does NOT persist trigger-test results in the main audit
 *  log (per the `dry_run: true` flag contract). Kitchen is responsible
 *  for the `triggered_test`-segregated audit; the server just answers
 *  the rpc.
 *
 *  Ingredient errors are mapped to RpcErrors so the extension's rpc
 *  layer raises a typed RpcError the Kitchen executor can surface as
 *  `Failed: <message>` in the result panel. */

import { IngredientError, type KernelDispatchers } from '@recued/ingredients';
import { RpcError, type TriggerTestRequest, type TriggerTestResult } from '@recued/contracts';
import type { HandlerSlice, ServerRpcRegistry } from '@recued/contracts';

import type { WsClient } from './ws-server.js';

type WatcherDispatcher = NonNullable<KernelDispatchers['watcher']>;

export interface TriggerTestRpcDeps {
  /** Same dispatcher bin.ts composes for the kernel adapter +
   *  `runtime.runWatcher`. Shared binding — test-fire routes through
   *  the identical handler set, so semantics match production ticks. */
  watcherDispatcher: WatcherDispatcher;
  /** Clock override for tests. Production uses `Date.now`. */
  now?: () => number;
}

const validate = (raw: unknown): TriggerTestRequest => {
  if (!raw || typeof raw !== 'object') {
    throw new RpcError('bad_request', 'runtime.testTrigger: payload must be an object', 400);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.recipe_id !== 'string' || !o.recipe_id) {
    throw new RpcError('bad_request', 'runtime.testTrigger: recipe_id required', 400);
  }
  if (typeof o.step_id !== 'string' || !o.step_id) {
    throw new RpcError('bad_request', 'runtime.testTrigger: step_id required', 400);
  }
  if (typeof o.ingredient !== 'string' || !o.ingredient) {
    throw new RpcError('bad_request', 'runtime.testTrigger: ingredient required', 400);
  }
  if (o.dry_run !== true) {
    throw new RpcError('bad_request', 'runtime.testTrigger: dry_run must be true (no commit mode supported)', 400);
  }
  if (!o.resolved_input || typeof o.resolved_input !== 'object' || Array.isArray(o.resolved_input)) {
    throw new RpcError('bad_request', 'runtime.testTrigger: resolved_input must be an object', 400);
  }
  return o as unknown as TriggerTestRequest;
};

export const handleTestTrigger = async (
  deps: TriggerTestRpcDeps,
  rawArgs: unknown,
): Promise<TriggerTestResult> => {
  const req = validate(rawArgs);
  const now = deps.now ?? Date.now;

  let output: Record<string, unknown>;
  try {
    // The dispatcher's slug param is typed as the closed
    // `KernelWatcherSlug` union; unknown slugs bubble back as an
    // IngredientError we map to an RpcError below.
    const raw = await deps.watcherDispatcher({
      slug: req.ingredient as Parameters<WatcherDispatcher>[0]['slug'],
      args: req.resolved_input,
    });
    output = raw as Record<string, unknown>;
  } catch (e) {
    if (e instanceof IngredientError) {
      const status = e.code === 'SERVER_NOT_REACHABLE' ? 503 : 400;
      throw new RpcError(
        e.code === 'SERVER_NOT_REACHABLE' ? 'service_unavailable' : 'bad_request',
        `runtime.testTrigger[${req.ingredient}]: ${e.message}`,
        status,
      );
    }
    throw e;
  }

  return {
    recipe_id: req.recipe_id,
    step_id: req.step_id,
    ingredient: req.ingredient,
    // The Kitchen already redacted vault values before forwarding;
    // the server just echoes what it saw.
    inputs_received: req.resolved_input,
    output,
    should_run: Boolean(output.should_run),
    cached: false,
    at: now(),
  };
};

export const makeTriggerTestRpcHandlers = (
  deps: TriggerTestRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'runtime.testTrigger', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['runtime.testTrigger'],
    handlers: {
      'runtime.testTrigger': async (args) => handleTestTrigger(deps, args),
    },
  };
};
