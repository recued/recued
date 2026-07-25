/** Poll-manager / G6 — `watch.*` rpc handlers.
 *
 *  Three methods:
 *    watch.list     merged watch-key status (trigger-derived demand ⋈
 *                   user pause toggle ⋈ persisted poll state ⋈
 *                   reconciler deference ⋈ live loop roster) + the
 *                   push-source governance rows (`sources` — the
 *                   WatchSource model's push half; empty when no
 *                   providers registered)
 *    watch.update   { watch_key, enabled } — pause / resume
 *    watch.run_now  { watch_key } — poll one key immediately (the
 *                   Run-Now affordance; housekeeping's per-topic Run
 *                   Now is the gesture precedent)
 *
 *  The list is the governance read for "which connection-entity pairs
 *  does the server poll on my behalf, how often, for which recipes" —
 *  the watch row of the #automation surface. Pause disarms the poll
 *  loop without touching the subscriber triggers (the same key re-arms
 *  on resume and diffs against its kept snapshot, so changes made
 *  while paused fire as `updated` on the first resumed poll). Resume
 *  also clears the error-cap counter — re-arming an error-capped watch
 *  is the same user gesture as un-pausing it (the auto-run posture).
 *
 *  Registered like every db-gated family: the composer returns no deps
 *  without a db, the slice stays unregistered, and the methods read as
 *  unavailable. The manager handle is late-bound-shaped for posture
 *  parity with auto-run, though the watch manager composes before the
 *  WS server in practice. */

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
  type WatchSourceStatusEntry,
  type WatchStatusEntry,
} from '@recued/contracts';
import type { WsClient } from '../ws-server.js';
import type { PollManagerHandle } from './poll-manager.js';
import type { WatchSourceRegistry } from './source-registry.js';

export interface WatchRpcDeps {
  /** Late-bound live manager handle. */
  getManager: () => PollManagerHandle | undefined;
  /** Push-source governance registry (WatchSource model). Optional —
   *  absent (or empty) registry lists no `sources` rows; the poll half
   *  works standalone. */
  getSourceRegistry?: () => Pick<WatchSourceRegistry, 'list'> | undefined;
}

const requireManager = (deps: WatchRpcDeps): PollManagerHandle => {
  const manager = deps.getManager();
  if (manager === undefined) {
    throw new RpcError('not_configured', 'Watch substrate is not configured', 503);
  }
  return manager;
};

export const listWatches = (
  deps: WatchRpcDeps,
): { watches: WatchStatusEntry[]; sources: WatchSourceStatusEntry[] } => ({
  watches: requireManager(deps).listEntries(),
  sources: deps.getSourceRegistry?.()?.list() ?? [],
});

export const updateWatch = (
  deps: WatchRpcDeps,
  body: { watch_key?: unknown; enabled?: unknown },
): { entry: WatchStatusEntry } => {
  const watch_key = typeof body.watch_key === 'string' ? body.watch_key : null;
  if (!watch_key) {
    throw new RpcError('bad_request', 'watch_key is required', 400);
  }
  if (typeof body.enabled !== 'boolean') {
    throw new RpcError('bad_request', 'enabled must be a boolean', 400);
  }
  const entry = requireManager(deps).setEnabled(watch_key, body.enabled);
  if (entry === null) {
    throw new RpcError('not_found', `No watch '${watch_key}'`, 404);
  }
  return { entry };
};

/** Run one key's poll immediately and return the refreshed entry.
 *
 *  Honesty over silence: `pollNow` itself no-ops on a key without an
 *  armed loop, so the handler pre-checks the governance entry and
 *  names WHY a run-now can't happen (`conflict`) instead of returning
 *  a stale entry that looks like a successful run. The one deliberate
 *  silent case: a poll already in flight — `pollNow`'s tick yields to
 *  it (the in-flight poll IS the run the user asked for; its result
 *  lands normally). */
export const runNowWatch = async (
  deps: WatchRpcDeps,
  body: { watch_key?: unknown },
): Promise<{ entry: WatchStatusEntry }> => {
  const watch_key = typeof body.watch_key === 'string' ? body.watch_key : null;
  if (!watch_key) {
    throw new RpcError('bad_request', 'watch_key is required', 400);
  }
  const manager = requireManager(deps);
  const before = manager.listEntries().find((w) => w.watch_key === watch_key);
  if (before === undefined) {
    throw new RpcError('not_found', `No watch '${watch_key}'`, 404);
  }
  if (!before.active) {
    const why = before.deferred_to !== null
      ? `it is covered by the higher-fidelity '${before.deferred_to}' source`
      : !before.enabled
        ? 'it is paused — resume it first'
        : 'it has no armed poll loop (connection missing or no subscribers)';
    throw new RpcError('conflict', `Watch '${watch_key}' cannot run now: ${why}`, 409);
  }
  await manager.pollNow(watch_key);
  const entry = manager.listEntries().find((w) => w.watch_key === watch_key) ?? before;
  return { entry };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type WatchMethods = 'watch.list' | 'watch.update' | 'watch.run_now';

export const makeWatchHandlers = (
  deps: WatchRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, WatchMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['watch.list', 'watch.update', 'watch.run_now'],
    handlers: {
      'watch.list': async () => listWatches(deps),
      'watch.update': async (args) => updateWatch(deps, args),
      'watch.run_now': async (args) => runNowWatch(deps, args),
    },
  };
};
