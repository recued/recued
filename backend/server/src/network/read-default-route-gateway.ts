/** Default-route gateway probe — the hint `resolveLanAddress` needs to pick
 *  the REAL LAN out of several RFC1918 candidates.
 *
 *  `resolveLanAddress` has accepted a `defaultRouteGateway` since the W3.5 P2
 *  fold, and its docstring named exactly this: "production callers on Linux
 *  read `/proc/net/route` (or `ip route show default`); macOS uses
 *  `route get default`". Nothing supplied it, so every multi-homed host — a
 *  laptop with a Docker bridge, a VM host, anything running Internet Sharing —
 *  fell straight through to `ambiguous_lan_candidates` and bound loopback.
 *  This module is that caller.
 *
 *  Contract: NEVER throws, NEVER blocks for long. It runs on the boot path
 *  before the listener binds, and a host whose routing table can't be read is
 *  a host that resolves ambiguously — the same place it was already going.
 *  Every failure returns undefined.
 *
 *  Both readers are injectable. The parsers are pure and exported so the
 *  fixture cases (Docker bridge, VPN tunnel, no default route) are testable
 *  without a routing table — the platform seams are the only impure part. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Hard ceiling on the macOS `route` subprocess. A wedged binary must not
 *  hold up the listener bind; the ambiguous path is a fine outcome. */
const ROUTE_COMMAND_TIMEOUT_MS = 1_000;

const PROC_NET_ROUTE = '/proc/net/route';

/** Dotted-quad shape check. Guards against `route get default` printing a
 *  non-address gateway (`link#14` on a direct/point-to-point route) and
 *  against a truncated `/proc/net/route` row. */
const isDottedQuadIpv4 = (value: string): boolean => {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
};

/** `/proc/net/route` stores addresses as LITTLE-ENDIAN hex — the gateway
 *  `010011AC` is `172.17.0.1`, not `1.0.17.172`. Reversing the byte pairs is
 *  the whole trick, and getting it backwards yields a plausible-looking
 *  address that matches nothing. */
const hexLeToIpv4 = (hex: string): string | undefined => {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return undefined;
  const octets: number[] = [];
  for (let i = 0; i < 8; i += 2) octets.push(parseInt(hex.slice(i, i + 2), 16));
  return octets.reverse().join('.');
};

/** Parse Linux `/proc/net/route`. Columns (tab-separated, one header row):
 *  `Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT`.
 *  The default route is the row whose Destination is all-zero; among several
 *  (multi-homed hosts publish one per interface) the lowest Metric wins,
 *  which is the same preference the kernel itself applies. */
export const parseProcNetRouteGateway = (contents: string): string | undefined => {
  let best: { gateway: string; metric: number } | undefined;
  for (const line of contents.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const [, destination, gateway, , , , metricRaw] = cols;
    if (destination !== '00000000') continue;
    if (!gateway || gateway === '00000000') continue;
    const addr = hexLeToIpv4(gateway);
    if (!addr || !isDottedQuadIpv4(addr)) continue;
    const metric = Number(metricRaw);
    const rank = Number.isFinite(metric) ? metric : Number.MAX_SAFE_INTEGER;
    if (!best || rank < best.metric) best = { gateway: addr, metric: rank };
  }
  return best?.gateway;
};

/** Parse BSD/macOS `route -n get default`, whose output is a key/value block:
 *
 *      route to: default
 *   destination: default
 *       gateway: 192.168.1.1
 *     interface: en0
 *
 *  A host with no default route prints `route: writing to routing socket:
 *  not in table` and no `gateway:` line ⇒ undefined. */
export const parseRouteGetDefaultGateway = (output: string): string | undefined => {
  for (const line of output.split('\n')) {
    const match = /^\s*gateway:\s*(\S+)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1]!;
    // `link#14` (point-to-point / direct route) is a valid gateway line that
    // is not an address — no prefix to match a candidate against.
    return isDottedQuadIpv4(value) ? value : undefined;
  }
  return undefined;
};

export interface DefaultRouteGatewayReaders {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Linux: read `/proc/net/route`. May throw — treated as "no hint". */
  readProcNetRoute?: () => string;
  /** macOS/BSD: run `route -n get default`. May throw — treated as "no hint". */
  runRouteGetDefault?: () => string;
}

/** Best-effort default-route gateway for this host, or undefined.
 *
 *  Platform-scoped on purpose: on Linux the file read is cheap and
 *  dependency-free; on macOS/BSD there is no such file, so it costs one
 *  short-lived subprocess. Everything else (win32, unknown) returns undefined
 *  rather than guessing — the caller degrades to the ambiguity surface it
 *  already had. */
export const readDefaultRouteGateway = (
  readers: DefaultRouteGatewayReaders = {},
): string | undefined => {
  const platform = readers.platform ?? process.platform;
  try {
    if (platform === 'linux') {
      const read = readers.readProcNetRoute
        ?? (() => readFileSync(PROC_NET_ROUTE, 'utf8'));
      return parseProcNetRouteGateway(read());
    }
    if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
      const run = readers.runRouteGetDefault
        ?? (() =>
          execFileSync('route', ['-n', 'get', 'default'], {
            encoding: 'utf8',
            timeout: ROUTE_COMMAND_TIMEOUT_MS,
            // Never let the probe's own stderr reach the boot log — "not in
            // table" is an ordinary answer, not a server problem.
            stdio: ['ignore', 'pipe', 'ignore'],
          }));
      return parseRouteGetDefaultGateway(run());
    }
    return undefined;
  } catch {
    // Unreadable /proc (container without procfs), no `route` binary, a
    // timeout, a non-zero exit — all mean the same thing: no hint.
    return undefined;
  }
};
