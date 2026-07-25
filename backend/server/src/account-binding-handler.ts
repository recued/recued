/** D-175 P5 — RPC handlers for the `account.*` binding namespace.
 *
 *  Thin pair-RPC adapter over the `AccountBindingManager`:
 *
 *    - `account.bind` — the webclient relays the Worker-minted binding
 *      token over the pair channel; the manager exchanges it and stores
 *      the returned credential under the conflict gate.
 *    - `account.unbind` — clear the server's binding.
 *    - `account.bindingStatus` — secret-free current binding state.
 *
 *  Auth model. Two layers gate these:
 *
 *    1. **Registered client.** Every `account.*` method requires the
 *       caller to be a REGISTERED paired client (`instance_id` set —
 *       it completed the pairing register handshake). This blocks a
 *       pre-register / legacy raw-bearer WS connection from clearing
 *       the binding (`account.unbind`) or reading owner metadata
 *       (`account.bindingStatus`) — the no-token methods whose only
 *       gate is the caller's identity. (`account.bind` additionally
 *       carries a Worker-verified token; registration is the transport
 *       gate, the token is the account-auth.)
 *    2. **Channel isolation.** `account.` is in
 *       `MCP_RESERVED_RPC_PREFIXES`, so no MCP-channel agent ever
 *       reaches these (the D-138 ratchet asserts the prefix stays
 *       reserved).
 *
 *  The relaying client's `user_id` / `instance_id` are also recorded as
 *  audit provenance.
 *
 *  Composer-side absence (no `deps`) returns `undefined` and the slice
 *  drops silently — the dispatcher's sparse-map lookup then yields
 *  `not_configured` (501) for `account.*`, exactly like every other
 *  optional slice (matches the db-less harness + pre-boot cases).
 */

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { AccountBindingManager } from './account-binding/manager.js';
import type { WsClient } from './ws-server.js';

export interface AccountBindingHandlerDeps {
  /** The orchestration core. Built in `compose-storage-context.ts`
   *  against the booted signing identity + the signed audit sink. */
  manager: AccountBindingManager;
}

export type AccountBindingMethods =
  | 'account.bind'
  | 'account.unbind'
  | 'account.bindingStatus';

/** Require a registered paired client. A connection that hasn't
 *  completed the pairing register handshake has `instance_id === null`;
 *  reject it so an unregistered / pre-register WS connection can neither
 *  drive a binding nor clear / read one. Returns the resolved
 *  instance_id for the actor provenance. */
const requireRegisteredClient = (client: WsClient): string => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'account binding requires a registered paired client',
      401,
    );
  }
  return client.instance_id;
};

/** HandlerSlice factory. Composer-side absence (no `deps`) returns
 *  `undefined` so `account.*` falls through to `not_configured`. */
export const makeAccountBindingHandlers = (
  deps: AccountBindingHandlerDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, AccountBindingMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['account.bind', 'account.unbind', 'account.bindingStatus'],
    handlers: {
      'account.bind': async (args, client) => {
        const instance_id = requireRegisteredClient(client);
        return deps.manager.bind(
          {
            binding_token: args.binding_token,
            ...(args.confirm_rebind !== undefined
              ? { confirm_rebind: args.confirm_rebind }
              : {}),
          },
          { user_id: client.user_id ?? null, instance_id },
        );
      },
      'account.unbind': async (_args, client) => {
        const instance_id = requireRegisteredClient(client);
        return deps.manager.unbind({
          user_id: client.user_id ?? null,
          instance_id,
        });
      },
      'account.bindingStatus': async (_args, client) => {
        requireRegisteredClient(client);
        return deps.manager.status();
      },
    },
  };
};
