/** Pair rpc handlers for the `prefs` sync-namespace.
 *
 *  Two methods, both keyed by the connecting peer's `instance_id`:
 *    prefs.get           → { prefs: InstancePrefs }
 *    prefs.set { patch } → { prefs: InstancePrefs }
 *
 *  The extension authors the values; the server mirrors them on the
 *  paired-instance row. Pair transport only (no cloud, no Pro gate —
 *  D-168 retired the per-feature ProFeature substrate). Consumers
 *  (cache-rpc-handler,
 *  ws peer-push gates) read the persisted view before every decision
 *  so toggling a pref takes effect on the next message without a
 *  reconnect.
 *
 *  Error semantics match the rest of the dispatcher: throw `RpcError`
 *  for coded failures so the envelope normalises to `{ok:false, error}`.
 */

import {
  RpcError,
  sanitizePrefsPatch,
  type HandlerSlice,
  type InstancePrefs,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { PairedInstancesStore } from './paired-instances-store.js';
import type { WsClient } from './ws-server.js';

export interface PrefsRpcDeps {
  store: PairedInstancesStore;
}

/** The connecting peer's instance id — ws-server attaches this to
 *  each rpc dispatch as `ctx.instance_id`. A missing id means the
 *  client hasn't completed the register handshake; reject rather
 *  than silently falling back to "some instance" or defaults. */
export interface PrefsRpcCtx {
  instance_id?: string;
}

const requireInstanceId = (ctx: PrefsRpcCtx): string => {
  if (!ctx.instance_id) {
    throw new RpcError(
      'unauthorized',
      'prefs.* require a registered instance (send register first)',
      401,
    );
  }
  return ctx.instance_id;
};

export const handlePrefsGet = async (
  deps: PrefsRpcDeps,
  _args: Record<string, unknown>,
  ctx: PrefsRpcCtx,
): Promise<{ prefs: InstancePrefs }> => {
  const instanceId = requireInstanceId(ctx);
  return { prefs: deps.store.getPrefs(instanceId) };
};

export const handlePrefsSet = async (
  deps: PrefsRpcDeps,
  args: { patch?: unknown },
  ctx: PrefsRpcCtx,
): Promise<{ prefs: InstancePrefs }> => {
  const instanceId = requireInstanceId(ctx);
  const patch = args.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RpcError('bad_request', '`patch` must be an object', 400);
  }
  // Narrow the incoming patch to known-and-well-typed keys WITHOUT
  // filling defaults. setPrefs then merges only what the caller sent,
  // preserving any prior keys not in this patch.
  const sanitized = sanitizePrefsPatch(patch as Record<string, unknown>);
  const merged = deps.store.setPrefs(instanceId, sanitized);
  return { prefs: merged };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type PrefsMethods = 'prefs.get' | 'prefs.set';

export const makePrefsHandlers = (
  store: PairedInstancesStore | undefined,
): HandlerSlice<ServerRpcRegistry, PrefsMethods, WsClient> | undefined => {
  if (!store) return undefined;
  const deps: PrefsRpcDeps = { store };
  return {
    methods: ['prefs.get', 'prefs.set'],
    handlers: {
      'prefs.get': async (_args, client) =>
        handlePrefsGet(deps, {}, { instance_id: client.instance_id ?? undefined }),
      'prefs.set': async (args, client) =>
        handlePrefsSet(deps, args, { instance_id: client.instance_id ?? undefined }),
    },
  };
};
