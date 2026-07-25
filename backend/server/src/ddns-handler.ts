/** R27 delta-B — RPC handler for the `ddns.*` namespace.
 *
 *  User-initiated pause/resume of the server's Pro DDNS publication
 *  (`<handle>.<zone>`), INDEPENDENT of the Pro subscription:
 *
 *    - `ddns.status`     — read the server-local publish flag ({enabled}).
 *    - `ddns.setEnabled` — pause ({enabled:false}) / resume ({enabled:true}).
 *
 *  `setEnabled` is **cloud-first**: it signs + calls the cloud
 *  `/v1/ddns/pause` verb (the REAL effect — the cloud pulls or restores the
 *  A/AAAA records), and only on success flips the server-local flag that
 *  gates the update poller. Cloud-first because the local flag alone is just
 *  "stop refreshing" — the published record keeps resolving until the cloud
 *  pulls it; flipping the flag before the cloud confirmed would leave the UI
 *  saying "paused" while the handle still resolves. On cloud failure the flag
 *  is left unchanged and the error surfaces (the toggle reverts). The cloud
 *  `user_paused` is the durable source of truth and `handleDdnsUpdate`
 *  preserves it, so even a flag-write failure after a cloud success self-heals.
 *
 *  Auth model (mirrors `pro-convenience-handler.ts`):
 *    1. **Registered client.** The caller must be a REGISTERED paired client
 *       (`instance_id` set).
 *    2. **Channel isolation.** `ddns.` is in `MCP_RESERVED_RPC_PREFIXES`, so
 *       no MCP-channel agent reaches it (an external agent must never take a
 *       user's DDNS offline).
 *
 *  Composer-side absence (no `deps`) returns `undefined` so `ddns.*` falls
 *  through to `not_configured` (db-less harness / pre-signing-identity boot),
 *  exactly like `pro_convenience.*` / `account.*`.
 */

import {
  RpcError,
  canonicalizeHandle,
  type DdnsEnabledStatus,
  type DdnsSetEnabledRequest,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { HandleStateStore } from './handle/index.js';
import type { DdnsEnabledStore } from './ddns/ddns-enabled-store.js';
import type { DdnsUpdateClient } from './ddns/update-client.js';
import type { WsClient } from './ws-server.js';

export interface DdnsHandlerDeps {
  /** The server-local publish/pause flag (gates the update poller). */
  enabledStore: DdnsEnabledStore;
  /** Resolves the current reserved handle + publisher_id (the cloud-pause
   *  target). The same handle-state the update poller publishes for. */
  handleStateStore: HandleStateStore;
  /** Cloud client (only `pause` is used here) — signs + calls
   *  `/v1/ddns/pause`. Built against the booted signing identity. */
  pauseClient: Pick<DdnsUpdateClient, 'pause'>;
}

export type DdnsMethods = 'ddns.status' | 'ddns.setEnabled';

/** Only an active/grace subscription has a live DDNS record to pause; a
 *  released handle is already parked. Mirrors the poller's target gate. */
const ACTIVE_HANDLE_STATES = new Set(['active', 'grace']);

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'ddns control requires a registered paired client',
      401,
    );
  }
};

/** The current cloud-pause target (the user's reserved Pro handle), or null
 *  when no live DDNS handle exists — in which case there is nothing to
 *  pause cloud-side and the local flag alone carries the intent. */
const resolveHandleTarget = async (
  store: HandleStateStore,
): Promise<{ publisher_id: string; handle: string } | null> => {
  const state = await store.load();
  if (!state) return null;
  if (!ACTIVE_HANDLE_STATES.has(state.subscription_state)) return null;
  const handle = canonicalizeHandle(state.current_handle);
  if (handle.length === 0) return null;
  return { publisher_id: state.publisher_id, handle };
};

export const makeDdnsHandlers = (
  deps: DdnsHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, DdnsMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['ddns.status', 'ddns.setEnabled'],
    handlers: {
      'ddns.status': async (_args, client): Promise<DdnsEnabledStatus> => {
        requireRegisteredClient(client);
        return { enabled: deps.enabledStore.isEnabled() };
      },
      'ddns.setEnabled': async (
        args: DdnsSetEnabledRequest,
        client,
      ): Promise<DdnsEnabledStatus> => {
        requireRegisteredClient(client);
        // Runtime-validate the untrusted RPC arg BEFORE any side effect: the
        // JSON-RPC boundary is not schema-checked, and this handler derives TWO
        // writes from `enabled` (cloud `paused: !enabled` + the raw local flag).
        // A non-boolean (`{}`, `0`, `"true"`) would otherwise split cloud
        // (paused via truthiness) from the local store, the exact split-brain
        // this feature must avoid. Fail closed with no cloud call + no write.
        if (typeof args?.enabled !== 'boolean') {
          throw new RpcError(
            'ddns_validation_error',
            'ddns.setEnabled requires a boolean `enabled`',
            400,
          );
        }
        const { enabled } = args;

        // Cloud-first: pull/restore the actual record. A null target means no
        // live DDNS handle (nothing published) — skip the cloud call; the
        // local flag still records the intent + gates the poller.
        const target = await resolveHandleTarget(deps.handleStateStore);
        if (target) {
          const result = await deps.pauseClient.pause({
            publisher_id: target.publisher_id,
            handle: target.handle,
            paused: !enabled,
          });
          if (!result.ok) {
            // Do NOT flip the flag — keep local + cloud consistent. Surface
            // the cloud reason so the toggle can revert + show it.
            throw new RpcError(
              'ddns_pause_cloud_failed',
              `cloud ${enabled ? 'resume' : 'pause'} failed: ${result.error}` +
                (result.message ? ` (${result.message})` : ''),
              502,
            );
          }
        }

        deps.enabledStore.setEnabled(enabled);
        return { enabled };
      },
    },
  };
};
