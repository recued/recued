/** D-148 § A.7.5 — LAN bind-address detection (W3.5).
 *
 *  The path-listener-set's LAN listener (port 80, plain HTTP) needs to
 *  bind to the primary local interface IP so LAN clients (other
 *  machines on `192.168.0.0/16` / `10.0.0.0/8` / `172.16.0.0/12`)
 *  can reach `/health`, `/ws`, `/mcp`, etc. Per spec:
 *
 *  > "Default LAN bind for port 80 = the primary local interface IP
 *  >  (e.g., `192.168.1.42`); user can override in Settings → Server →
 *  >  Network. `127.0.0.1` for 'this machine only' mode (rare, but
 *  >  useful for dev)."
 *
 *  This module is the runtime concern the substrate's
 *  `DEFAULT_LAN_BIND_ADDRESS` (`127.0.0.1`) was deliberately
 *  conservative for (Codex W3.4 P1 fold). Production callers (`bin.ts`)
 *  invoke `resolveLanAddress()` and thread the detected IP through
 *  `createPathListenerSet`'s `lan_bind_address`.
 *
 *  Resolution order (first non-empty wins):
 *  1. Explicit `override` argument (Settings → Server → Network).
 *  2. Detected primary IPv4 RFC1918-range interface (skipping loopback,
 *     `internal`, virtual / down / link-local interfaces). The "primary"
 *     interface is picked by walking the default-route gateway when
 *     available; otherwise we surface the candidate set as `ambiguous`
 *     so the caller can prompt for an override rather than guess.
 *  3. Fallback `'127.0.0.1'` (loopback — "this machine only" mode).
 *
 *  Returns the chosen address + the source label + the candidate set
 *  the detection considered. Surface is the input to the Reachability
 *  Doctor's "your LAN listener is bound to X" panel so Mary can see
 *  why a particular interface was picked.
 *
 *  Codex W3.5 P2 fold — earlier revision picked the lexicographically
 *  smallest RFC1918 address, which on hosts with both a Docker bridge
 *  (`172.17.0.1`) and a Wi-Fi `192.168.x` LAN would silently bind to
 *  the Docker network instead of the real LAN. Now multi-candidate
 *  hosts without a default-route hint return `'ambiguous_lan_candidates'`
 *  so the caller (bin.ts boot path / Settings UX) prompts for an
 *  explicit override rather than auto-binding to the wrong interface.
 */

import { networkInterfaces } from 'node:os';

/** Closed list of source labels the resolution returns. The doctor
 *  renders each with its own remediation hint. */
export type ResolvedLanAddressSource =
  | 'override'
  | 'detected'
  | 'detected_via_default_route'
  | 'ambiguous_lan_candidates'
  | 'loopback_fallback';

export interface ResolvedLanAddress {
  /** The chosen bind address — pass through to
   *  `createPathListenerSet`'s `lan_bind_address`. When
   *  `source === 'ambiguous_lan_candidates'` this is
   *  `LOOPBACK_FALLBACK` (safe fallback while the caller surfaces the
   *  ambiguity to the user). */
  address: string;
  /** Why this address was chosen (rendered by the Reachability Doctor). */
  source: ResolvedLanAddressSource;
  /** Every RFC1918 IPv4 address the detector considered + the
   *  interface name it lived on. Empty when no LAN interface was
   *  found (loopback fallback). Sorted by address for deterministic
   *  output. */
  candidates: ReadonlyArray<{ address: string; iface: string }>;
}

export interface ResolveLanAddressOptions {
  /** Settings → Server → Network override. When non-empty, used
   *  verbatim (no validation — the user opted in). */
  override?: string | null | undefined;
  /** Optional default-route gateway IPv4 address. Production callers
   *  on Linux read `/proc/net/route` (or `ip route show default`);
   *  macOS uses `route get default`. When supplied, the resolver
   *  prefers the candidate on the same /24 (or /16 / /8 per RFC1918
   *  block) as the gateway. When omitted, multi-candidate hosts fall
   *  through to `'ambiguous_lan_candidates'`. */
  defaultRouteGateway?: string | null | undefined;
  /** Injection seam for tests. Falls back to `os.networkInterfaces`. */
  readInterfaces?: () => ReturnType<typeof networkInterfaces>;
}

/** Loopback fallback — the substrate's safe default. Matches
 *  `DEFAULT_LAN_BIND_ADDRESS` in `packages/server-tls/src/path-listener-set.ts`
 *  so callers passing through this helper land on the same conservative
 *  scope when no LAN interface is detected. */
export const LOOPBACK_FALLBACK = '127.0.0.1' as const;

const RFC1918_PATTERNS: ReadonlyArray<RegExp> = [
  /^10\./,
  /^192\.168\./,
  // 172.16.0.0/12 — first octet 172, second 16-31 inclusive.
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
];

const isRfc1918Ipv4 = (addr: string): boolean => {
  for (const re of RFC1918_PATTERNS) {
    if (re.test(addr)) return true;
  }
  return false;
};

const isLinkLocalIpv4 = (addr: string): boolean => /^169\.254\./.test(addr);

const isLoopbackIpv4 = (addr: string): boolean => /^127\./.test(addr);

/** Parse an IPv4 address into its four octets. Returns null on
 *  malformed input (the resolver still adds it to `candidates` but
 *  won't use it for gateway matching). */
const parseIpv4 = (addr: string): [number, number, number, number] | null => {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
};

/** True iff the two IPv4 addresses share their first `prefixOctets`
 *  octets. Used to match a candidate to the default-route gateway. */
const sharesPrefix = (a: string, b: string, prefixOctets: 1 | 2 | 3): boolean => {
  const pa = parseIpv4(a);
  const pb = parseIpv4(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < prefixOctets; i++) {
    if (pa[i] !== pb[i]) return false;
  }
  return true;
};

/** Resolve the LAN bind address per § A.7.5. Pure-ish — only side
 *  effect is reading the network interface list (or the test override
 *  via `readInterfaces`). */
export const resolveLanAddress = (
  opts: ResolveLanAddressOptions = {},
): ResolvedLanAddress => {
  // Explicit override always wins. Trim whitespace; empty string falls
  // through to detection (matches the "Settings clear → re-detect"
  // UX flow).
  const trimmed = typeof opts.override === 'string' ? opts.override.trim() : '';
  if (trimmed.length > 0) {
    return {
      address: trimmed,
      source: 'override',
      candidates: [],
    };
  }

  const read = opts.readInterfaces ?? networkInterfaces;
  const ifaces = read();
  const candidates: Array<{ address: string; iface: string }> = [];
  const seen = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (!entry) continue;
      // Skip non-IPv4 (IPv6 LAN binding is a Settings UX concern, not
      // the auto-detection default). Newer Node typings use the
      // string `'IPv4'`; older runtime returned the numeric `4`.
      const family = entry.family as unknown;
      if (family !== 'IPv4' && family !== 4) continue;
      if (entry.internal) continue;
      const addr = entry.address;
      if (typeof addr !== 'string' || addr.length === 0) continue;
      if (isLoopbackIpv4(addr)) continue;
      if (isLinkLocalIpv4(addr)) continue;
      if (!isRfc1918Ipv4(addr)) continue;
      if (seen.has(addr)) continue;
      seen.add(addr);
      candidates.push({ address: addr, iface: name });
    }
  }

  candidates.sort((a, b) => a.address.localeCompare(b.address));

  if (candidates.length === 0) {
    return {
      address: LOOPBACK_FALLBACK,
      source: 'loopback_fallback',
      candidates: [],
    };
  }

  if (candidates.length === 1) {
    return {
      address: candidates[0]!.address,
      source: 'detected',
      candidates,
    };
  }

  // Multiple candidates — try the default-route gateway hint.
  const gateway = typeof opts.defaultRouteGateway === 'string'
    ? opts.defaultRouteGateway.trim()
    : '';
  if (gateway.length > 0) {
    // Match by descending CIDR specificity. /24 first (Wi-Fi /
    // typical home LAN), then /16, then /8. The first candidate
    // whose prefix lines up with the gateway is the primary LAN.
    for (const prefix of [3, 2, 1] as const) {
      for (const c of candidates) {
        if (sharesPrefix(c.address, gateway, prefix)) {
          return {
            address: c.address,
            source: 'detected_via_default_route',
            candidates,
          };
        }
      }
    }
  }

  // Ambiguous — Codex W3.5 P2 fold. The lexicographically smallest
  // RFC1918 address would silently pick a Docker bridge / VPN tunnel
  // over the real LAN. Surface the ambiguity to the caller so the
  // boot path / Settings UX can prompt for an override rather than
  // auto-binding to the wrong interface. Address falls back to
  // loopback as the conservative scope; the Reachability Doctor
  // surfaces both the source label + the candidate list to Mary.
  return {
    address: LOOPBACK_FALLBACK,
    source: 'ambiguous_lan_candidates',
    candidates,
  };
};
