/** LAN-URL kickstart — `network.local_urls` rpc handler.
 *
 *  A Settings-only read that reports the server's locally-reachable URLs
 *  (loopback + LAN interface addresses, each combined with the live HTTP
 *  listen port) so the webclient Hostnames panel can show a home user how to
 *  reach the server from other devices on their LAN — saving a trip to look
 *  up their LAN IP.
 *
 *  Reuses the CLI pair-flow's `collectLanInterfaces()` enumerator
 *  (`os.networkInterfaces`, internal/loopback excluded, IPv4 + non-link-local
 *  IPv6, deduped) and prepends an explicit loopback row. Plain `http` to match
 *  that enumeration (the LAN listener is not fronted by the public TLS cert).
 *
 *  Channel isolation: `network.` is in `MCP_RESERVED_RPC_PREFIXES`, so an
 *  MCP-channel agent can never enumerate the server's bind addresses — this is
 *  a local-UI read for paired clients only (`requireCallerInstance`). */

import {
  RpcError,
  type HandlerSlice,
  type LocalServerUrl,
  type NetworkLocalUrlsResponse,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { collectLanInterfaces, type EnumerateDeps } from './cli/url-enumerate.js';
import type { WsClient } from './ws-server.js';

export interface NetworkRpcDeps {
  /** Resolver for the server's live HTTP listen port — read at CALL time so it
   *  reflects the ACTUAL bound port. Matters when the configured port is 0
   *  (OS-assigned): production threads the post-bind listener status, so an
   *  ephemeral boot reports the real port instead of `:0`. Combined with each
   *  detected address to build the reachable URLs. */
  getPort: () => number;
  /** Test seam — overrides `os.networkInterfaces` (passed through to
   *  `collectLanInterfaces`). */
  networkInterfaces?: EnumerateDeps['networkInterfaces'];
}

const requireCallerInstance = (
  caller: { instance_id: string | null | undefined } | undefined,
  method: string,
): void => {
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      `${method}: requires a paired client (D-121); rpc dispatched from an unregistered connection`,
      403,
    );
  }
};

/** Build the loopback + LAN reachable URLs for `port`. Loopback first (every
 *  host has it), then each non-internal interface address from
 *  `collectLanInterfaces` (IPv6 bracketed). Plain `http`, matching the CLI
 *  pair-flow LAN enumeration. */
export const buildLocalServerUrls = (
  port: number,
  networkInterfaces?: EnumerateDeps['networkInterfaces'],
): LocalServerUrl[] => {
  const urls: LocalServerUrl[] = [
    { url: `http://localhost:${port}`, kind: 'loopback' },
  ];
  const lan = collectLanInterfaces(
    networkInterfaces ? { networkInterfaces } : {},
  );
  for (const ip of lan) {
    const host = ip.includes(':') ? `[${ip}]` : ip;
    urls.push({ url: `http://${host}:${port}`, kind: 'lan' });
  }
  return urls;
};

export const handleNetworkLocalUrls = async (
  deps: NetworkRpcDeps,
  _args: void,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<NetworkLocalUrlsResponse> => {
  const method = 'network.local_urls';
  requireCallerInstance(caller, method);
  return { urls: buildLocalServerUrls(deps.getPort(), deps.networkInterfaces) };
};

export const makeNetworkHandlers = (
  deps: NetworkRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'network.local_urls', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['network.local_urls'],
    handlers: {
      'network.local_urls': async (args, client) =>
        handleNetworkLocalUrls(
          deps,
          args as void,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
