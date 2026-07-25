/** D-175 P8 — RPC handler for the `pro_convenience.*` namespace.
 *
 *  Thin pair-RPC adapter over the `ProConvenienceProvisioner`:
 *
 *    - `pro_convenience.status` — secret-free per-item {handle, ddns, acme}
 *      status the webclient's Settings → Account "Pro convenience bundle"
 *      reads off its paired server.
 *
 *  Auth model (mirrors `account-binding-handler.ts`):
 *
 *    1. **Registered client.** The caller must be a REGISTERED paired
 *       client (`instance_id` set). A pre-register / raw-bearer WS
 *       connection must not enumerate the server's Pro provisioning
 *       posture.
 *    2. **Channel isolation.** `pro_convenience.` is in
 *       `MCP_RESERVED_RPC_PREFIXES`, so no MCP-channel agent ever reaches
 *       it (the D-175 P8 ratchet asserts the prefix stays reserved).
 *
 *  The response is secret-free by construction — the provisioner emits
 *  only coarse states + the already-secret-free `account_id` /
 *  `publisher_handle` / public `<handle>.recued.cloud` hostname. The
 *  `server_scoped_credential` + entitlement claim never reach this layer.
 *
 *  Composer-side absence (no `deps`) returns `undefined` and the slice
 *  drops silently — the dispatcher then yields `not_configured` (501) for
 *  `pro_convenience.*` (matches the db-less harness + pre-boot cases,
 *  exactly like `account.*`).
 */

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { ProConvenienceProvisioner } from './pro-convenience/provisioner.js';
import type { WsClient } from './ws-server.js';

export interface ProConvenienceHandlerDeps {
  /** The status/gate engine. Built in `compose-storage-context.ts`
   *  against the account-binding manager (binding read) + the pending
   *  entitlement seam. */
  provisioner: ProConvenienceProvisioner;
}

export type ProConvenienceMethods = 'pro_convenience.status';

/** Require a registered paired client (mirrors the `account.*` gate). A
 *  connection that hasn't completed the pairing register handshake has
 *  `instance_id === null`; reject it so an unregistered WS connection
 *  cannot read the Pro provisioning posture. */
const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'pro convenience status requires a registered paired client',
      401,
    );
  }
};

/** HandlerSlice factory. Composer-side absence (no `deps`) returns
 *  `undefined` so `pro_convenience.*` falls through to `not_configured`. */
export const makeProConvenienceHandlers = (
  deps: ProConvenienceHandlerDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, ProConvenienceMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['pro_convenience.status'],
    handlers: {
      'pro_convenience.status': async (_args, client) => {
        requireRegisteredClient(client);
        return deps.provisioner.status();
      },
    },
  };
};
