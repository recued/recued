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
  type NetworkPortMappingResponse,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { collectLanInterfaces, type EnumerateDeps } from './cli/url-enumerate.js';
import { describeLanBindExposure } from './network/resolve-lan-address.js';
import type { PortMappingStatus } from './network/port-mapping-supervisor.js';
import type { WsClient } from './ws-server.js';

export interface NetworkRpcDeps {
  /** Resolver for the server's live HTTP listen port — read at CALL time so it
   *  reflects the ACTUAL bound port. Matters when the configured port is 0
   *  (OS-assigned): production threads the post-bind listener status, so an
   *  ephemeral boot reports the real port instead of `:0`. Combined with each
   *  detected address to build the reachable URLs. */
  getPort: () => number;
  /** The PUBLIC TLS port being SERVED. Optional so an embedding that has no
   *  listener set — tests, the bare `startServer` harness — simply omits the
   *  field rather than inventing 443.
   *
   *  ⚠ THIS COMMENT SAID "CONFIGURED, NOT BOUND" UNTIL 2026-09-17, on the
   *  reasoning that the public listener does not bind until a path is made
   *  public so there is no post-bind number to read. That half is still true AT
   *  BOOT — but `public_port` became live-editable, and production now threads
   *  `boundPublicPort`, which moves only when a rebind succeeded. Reporting the
   *  raw config key here is the defect this whole field exists to avoid: a
   *  failed rebind would have every client surface advertising a dead port. */
  getPublicPort?: () => number;
  /** D-273 — the owner's CONFIGURED `public_port`, whatever it currently says.
   *
   *  ⛔ SEPARATE FROM `getPublicPort` ON PURPOSE, and the pair is the point.
   *  This one is the wish and that one is the truth; the handler reports the
   *  difference and only the difference. Folding them into one accessor would
   *  make the caller choose which to send, which is exactly the choice that went
   *  wrong before (`network.local_urls` read the config key and started handing
   *  out an address on a port nothing was bound to).
   *
   *  Optional: absent → the server never claims a divergence, which is right for
   *  an embedding that has no runtime config to diverge from. */
  getRequestedPublicPort?: () => number | undefined;
  /** D-272 — the address the LAN listener actually BOUND, read at call time.
   *
   *  ⛔ NOT THE ADVERTISED LAN IP. `resolveLanAddress` returns two different
   *  addresses on purpose: what to advertise (the LAN IP) and what to BIND
   *  (`0.0.0.0` for a detected LAN address, so loopback stays served too). Only
   *  the second one answers "what else can reach this listener", and reporting
   *  the first would say `192.168.x.x` about a socket that is on every
   *  interface. Absent → the field is omitted rather than guessed. */
  getLanBindAddress?: () => string | undefined;
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
  const lanPort = deps.getPort();
  const publicPort = deps.getPublicPort?.();
  const requestedPublicPort = deps.getRequestedPublicPort?.();
  const lanBindAddress = deps.getLanBindAddress?.();
  // D-273 — report the WISH only when it is not the TRUTH.
  //
  // ⛔ THE COMPARISON LIVES HERE, not in the accessor, so the rule is visible
  // where the field is built. An accessor that returned undefined when the two
  // agree would put "is there a divergence" in the composition root, one layer
  // away from the only place that can see both numbers.
  //
  // ⚠ BOTH MUST BE PRESENT. An embedding with no runtime config supplies no
  // requested port; claiming a divergence against an absent value would report
  // a failed port change on every server that simply cannot answer.
  const portDiverged =
    publicPort !== undefined
    && requestedPublicPort !== undefined
    && requestedPublicPort !== publicPort;
  return {
    urls: buildLocalServerUrls(lanPort, deps.networkInterfaces),
    lan_port: lanPort,
    // ⛔ OMITTED, never defaulted. A client that receives no `public_port` can
    // tell "this server did not say" from "this server says 443"; one that
    // receives a 443 we invented here cannot.
    ...(publicPort !== undefined ? { public_port: publicPort } : {}),
    // ⛔ ONLY WHEN THEY DIFFER. Sending it always would make every client carry
    // a second port it must then compare — and a client that forgot to compare
    // would show a "your port did not apply" warning on every healthy server.
    ...(portDiverged ? { public_port_requested: requestedPublicPort } : {}),
    // ⛔ SAME RULE, AND IT MATTERS MORE HERE. Omitting is "nobody looked";
    // inventing `publicly_routable: false` would be this server telling its
    // owner it is not exposed on the strength of having failed to check.
    ...(lanBindAddress !== undefined
      ? {
          lan_exposure: describeLanBindExposure(
            lanBindAddress,
            deps.networkInterfaces ? { readInterfaces: deps.networkInterfaces } : {},
          ),
        }
      : {}),
  };
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

// ── D-273 — automatic port mapping status ──────────────────────────────────

/** Project the supervisor's status onto the wire.
 *
 *  ⛔ OMISSION IS THE TRI-STATE, AND EVERY FIELD HERE HONOURS IT. A client that
 *  receives no `support` can tell "this server did not look" from "this server
 *  looked and the router cannot"; one that receives an invented `'unsupported'`
 *  cannot. Same for `outcome`, `cgnat` and `held_by`. This is the same rule the
 *  public port and `lan_exposure` already follow on `network.local_urls`, and
 *  the reason is the same: the router step says something DIFFERENT for each of
 *  the three, so collapsing two of them makes one of those sentences a lie. */
export const projectPortMappingStatus = (
  status: PortMappingStatus | null,
  enabled: boolean,
  protocol?: 'igd' | 'nat-pmp',
): NetworkPortMappingResponse => {
  if (status === null) return { enabled };
  const support = status.support;
  const last = status.last;
  return {
    enabled,
    ...(support !== null && support.kind !== 'unknown' ? { support: support.kind } : {}),
    // ⚠ Only reported when the gateway actually told us its external address —
    // `cgnat: false` from a router we never reached would read as an all-clear
    // nobody earned.
    ...(support?.cgnat !== undefined ? { cgnat: support.cgnat } : {}),
    ...(protocol !== undefined ? { protocol } : {}),
    ...(last !== null ? { outcome: last.outcome } : {}),
    // ⛔ `held_by` HAS BEEN IN THE CONTRACT SINCE P3 WITH NOTHING TO FILL IT.
    // Only the IGD path can know it, and the IGD path had no caller — so the
    // router step could never name the machine holding the port.
    ...(last?.heldBy !== undefined ? { held_by: last.heldBy } : {}),
    ...(last?.record != null ? { external_port: last.record.externalPort } : {}),
    ...(status.checkedAt !== null ? { checked_at: status.checkedAt } : {}),
    ...(status.unavailable !== null ? { unavailable: status.unavailable } : {}),
    ...(last?.error !== undefined
      ? { detail: last.error }
      : support?.detail !== undefined ? { detail: support.detail } : {}),
  };
};

export interface PortMappingRpcDeps {
  /** Read at CALL time — the supervisor reconciles on its own clock, and a
   *  snapshot taken at compose time would report the state before the first
   *  reconcile forever. */
  getStatus: () => PortMappingStatus | null;
  isEnabled: () => boolean;
  getProtocol?: () => 'igd' | 'nat-pmp' | undefined;
}

export const handleNetworkPortMapping = async (
  deps: PortMappingRpcDeps,
  _args: void,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<NetworkPortMappingResponse> => {
  // ⛔ PAIRED CLIENTS ONLY, like its sibling — and it matters more here. This
  // reports whether a hole is open in the owner's firewall, which is not a fact
  // an unregistered connection has any business reading.
  requireCallerInstance(caller, 'network.port_mapping');
  return projectPortMappingStatus(
    deps.getStatus(),
    deps.isEnabled(),
    deps.getProtocol?.(),
  );
};

export const makePortMappingHandlers = (
  deps: PortMappingRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'network.port_mapping', WsClient> | undefined => {
  // ⚠ ITS OWN SLICE, not folded into `makeNetworkHandlers`. The two answer
  // different questions from different sources, and a server composed without a
  // database has the URL read and no supervisor — so one slice gated on both
  // deps would take the working half down with the missing one.
  if (!deps) return undefined;
  return {
    methods: ['network.port_mapping'],
    handlers: {
      'network.port_mapping': async (args, client) =>
        handleNetworkPortMapping(
          deps,
          args as void,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
