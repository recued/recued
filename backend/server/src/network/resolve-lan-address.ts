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

/** Why a non-empty override was not used. Single member today: the address
 *  is not one this host can bind. */
export type LanOverrideIgnoredReason = 'not_bindable_on_this_host';

export interface ResolvedLanAddress {
  /** The ADVERTISED address — the one a human or a peer would use to reach
   *  this server on the LAN, and what the pairing address hints publish
   *  (`wss://<address>:<port>/ws`). NOT the bind address: see `bind_address`.
   *  When `source === 'ambiguous_lan_candidates'` this is `LOOPBACK_FALLBACK`
   *  (safe fallback while the caller surfaces the ambiguity to the user). */
  address: string;
  /** What the listener actually binds — `createPathListenerSet`'s
   *  `lan_bind_address`.
   *
   *  Diverges from `address` on purpose. Binding a single LAN address means
   *  LOOPBACK IS NOT SERVED: with the listener on `192.168.1.121`, both
   *  `http://127.0.0.1:<port>` and `http://localhost:<port>` are refused. That
   *  kills the one flow that works end to end — the bundled webclient opened
   *  on the server machine, where a loopback origin is a secure context and
   *  Web Crypto is available. A LAN origin is not a secure context, so the
   *  page loads and the app refuses to boot.
   *
   *  So a DETECTED LAN address binds `0.0.0.0` (loopback + every interface),
   *  matching what the public listener has always done, while `address` keeps
   *  naming the LAN IP for hints and docs. An explicit override is bound
   *  verbatim — including `127.0.0.1` to force loopback-only, or `0.0.0.0` to
   *  ask for everything. */
  bind_address: string;
  /** Present iff a non-empty override was supplied and REJECTED, in which
   *  case `address` / `source` describe the detection result used instead.
   *
   *  Why reject rather than obey: a LAN listener that fails to bind is fatal
   *  (`assertLanListenerBoundOrExit` → `process.exit(4)`, deliberately not
   *  restart-looped). The override is typed by hand into Settings and names a
   *  HOST-dependent fact, so it goes stale on its own — a new network, a new
   *  DHCP lease, a VM image moved to another machine. Binding it verbatim
   *  turns any of those into "the server will not start", with the setting
   *  that caused it reachable only through the server that will not start.
   *  Ignoring it loudly keeps the admin channel up; the address is reported
   *  here so the boot log + Reachability Doctor can say what was skipped. */
  override_ignored?: { value: string; reason: LanOverrideIgnoredReason };
  /** Why this address was chosen (rendered by the Reachability Doctor). */
  source: ResolvedLanAddressSource;
  /** Every RFC1918 IPv4 address the detector considered + the
   *  interface name it lived on. Empty when no LAN interface was
   *  found (loopback fallback). Sorted by address for deterministic
   *  output. */
  candidates: ReadonlyArray<{ address: string; iface: string }>;
}

export interface ResolveLanAddressOptions {
  /** The owner's `network.lan_bind_address` — a runtime-config key, set in
   *  `config.toml` or through `server.setConfigField`. (No generic
   *  runtime-config page exists in the webclient yet; the AI / Models page is
   *  the only consumer of that rpc pair today, for `llm.budget`.)
   *  When non-empty it wins over detection, PROVIDED this host can
   *  actually bind it — an address on one of its interfaces, or a
   *  wildcard (`0.0.0.0` / `::`). Anything else is reported through
   *  `override_ignored` and detection proceeds; see that field for why
   *  obeying it verbatim is not safe. */
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

/** Bind every IPv4 interface — what a DETECTED LAN address binds, so the
 *  loopback origin the webclient needs stays served alongside the LAN one.
 *  Matches the public listener, which has always bound `0.0.0.0`.
 *
 *  IPv4-only, deliberately: `localhost` resolves to `::1` first on many
 *  systems, so a dual-stack story would need `::` with ipv6Only off. Callers
 *  advertise `127.0.0.1` rather than `localhost` for exactly this reason. */
const BIND_ALL_IPV4 = '0.0.0.0' as const;

/** Bind-any addresses. Never appear on an interface list, always bindable,
 *  and a deliberate self-hoster choice ("serve on every interface"), so the
 *  override check has to admit them explicitly. */
const WILDCARD_BIND_ADDRESSES: ReadonlyArray<string> = ['0.0.0.0', '::'];

/** Canonical form for comparing a typed-in address to an interface address:
 *  lowercase (IPv6 hex is case-insensitive) and without the `%en0` zone
 *  suffix Node appends to link-local IPv6. */
const normalizeBindAddress = (addr: string): string => {
  const zone = addr.indexOf('%');
  return (zone === -1 ? addr : addr.slice(0, zone)).toLowerCase();
};

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

/** 100.64.0.0/10 — carrier-grade NAT. Not publicly routable: a host on one of
 *  these is behind the ISP's NAT and cannot be reached from the internet, which
 *  is exactly the distinction `isPubliclyRoutableIpv4` exists to make. */
export const isCgnatIpv4 = (addr: string): boolean => {
  const p = parseIpv4(addr);
  return p !== null && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
};

/** ⛔ "NOT PRIVATE" IS NOT THE SAME AS "REACHABLE FROM THE INTERNET", and the
 *  gap is where a warning becomes a false alarm. Loopback, RFC1918, link-local
 *  and CGNAT are all unreachable from outside for different reasons; a check
 *  that only excluded RFC1918 would call a carrier-NAT'd home machine exposed. */
const isPubliclyRoutableIpv4 = (addr: string): boolean =>
  !isLoopbackIpv4(addr)
  && !isRfc1918Ipv4(addr)
  && !isLinkLocalIpv4(addr)
  && !isCgnatIpv4(addr)
  && parseIpv4(addr) !== null;

/** IPv6 global unicast is `2000::/3`. Everything else this cares about —
 *  `::1` loopback, `fe80::/10` link-local, `fc00::/7` ULA — is not routable
 *  from the internet. Deliberately conservative: an address this cannot parse
 *  is NOT reported as public, because a false "you are exposed" costs the
 *  reader a search for a problem they do not have. */
const isPubliclyRoutableIpv6 = (addr: string): boolean => {
  const head = normalizeBindAddress(addr).split(':')[0] ?? '';
  if (head.length === 0) return false;
  const n = Number.parseInt(head, 16);
  if (!Number.isInteger(n)) return false;
  return n >= 0x2000 && n <= 0x3fff;
};

export interface LanBindExposure {
  /** True when this bind puts the LAN listener on at least one address the
   *  internet can route to. ⚠ ROUTABLE, NOT REACHED — a host firewall, a cloud
   *  security group or an unforwarded router can still refuse the connection.
   *  This is the half that can be known here with certainty; the cloud probe
   *  answers the other half. */
  publicly_routable: boolean;
  /** Whether the bind address is a wildcard, i.e. every interface. */
  wildcard: boolean;
  /** The publicly-routable addresses this listener answers on. Sorted, deduped,
   *  and empty when `publicly_routable` is false. */
  public_addresses: ReadonlyArray<string>;
}

/** Does binding `bindAddress` put the LAN listener somewhere the internet can
 *  route to?
 *
 *  🔑 THE QUESTION IS NOT "IS THE BIND A WILDCARD" — that is the DEFAULT.
 *  `resolveLanAddress` returns `0.0.0.0` whenever it finds exactly one RFC1918
 *  address (or several plus a matching default route), which is the ordinary
 *  home case, so warning on the wildcard alone would fire for nearly every
 *  install and teach the reader to ignore it. The finding is the wildcard
 *  **plus a publicly-routable address on this host** — the cloud-VM shape
 *  (a private NIC and a public one), where `0.0.0.0` silently puts a PLAINTEXT
 *  listener carrying `/ws` and `/mcp` on the public address.
 *
 *  ⚠ `0.0.0.0` IS IPv4-ONLY, so it cannot expose an IPv6 address; only the `::`
 *  wildcard does. A non-wildcard bind is on exactly one address and is judged
 *  on that address alone.
 *
 *  ⚠ There is NO source-address filter in the path router, so "LAN-only" is a
 *  property of this bind and nothing else. That is why this has to be computed
 *  rather than assumed. */
export const describeLanBindExposure = (
  bindAddress: string,
  opts: Pick<ResolveLanAddressOptions, 'readInterfaces'> = {},
): LanBindExposure => {
  const bind = normalizeBindAddress(bindAddress);
  const wildcardV4 = bind === '0.0.0.0';
  const wildcardV6 = bind === '::';
  const wildcard = wildcardV4 || wildcardV6;

  if (!wildcard) {
    const isPublic = bind.includes(':')
      ? isPubliclyRoutableIpv6(bind)
      : isPubliclyRoutableIpv4(bind);
    return {
      publicly_routable: isPublic,
      wildcard: false,
      public_addresses: isPublic ? [bind] : [],
    };
  }

  const read = opts.readInterfaces ?? networkInterfaces;
  const found = new Set<string>();
  for (const list of Object.values(read())) {
    if (!list) continue;
    for (const entry of list) {
      if (!entry || entry.internal) continue;
      const addr = entry.address;
      if (typeof addr !== 'string' || addr.length === 0) continue;
      const family = entry.family as unknown;
      const v4 = family === 'IPv4' || family === 4;
      // `::` reaches IPv4 too on a dual-stack socket; `0.0.0.0` never reaches v6.
      if (v4 ? !isPubliclyRoutableIpv4(addr) : (wildcardV4 || !isPubliclyRoutableIpv6(addr))) {
        continue;
      }
      found.add(normalizeBindAddress(addr));
    }
  }
  const public_addresses = [...found].sort();
  return {
    publicly_routable: public_addresses.length > 0,
    wildcard: true,
    public_addresses,
  };
};

/** Resolve the LAN bind address per § A.7.5. Pure-ish — only side
 *  effect is reading the network interface list (or the test override
 *  via `readInterfaces`). */
export const resolveLanAddress = (
  opts: ResolveLanAddressOptions = {},
): ResolvedLanAddress => {
  // Trim whitespace; empty falls through to detection (matches the
  // "Settings clear → re-detect" UX flow).
  const trimmed = typeof opts.override === 'string' ? opts.override.trim() : '';

  const read = opts.readInterfaces ?? networkInterfaces;
  const ifaces = read();

  // Every address this host owns — ALL families, loopback + internal
  // included. This is the bindable set, deliberately wider than the
  // RFC1918 candidate list below: forcing loopback-only, binding a public
  // VPS address, or binding IPv6 are all legitimate overrides that
  // detection would never propose on its own.
  const bindable = new Set<string>(WILDCARD_BIND_ADDRESSES);
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      const addr = entry?.address;
      if (typeof addr === 'string' && addr.length > 0) {
        bindable.add(normalizeBindAddress(addr));
      }
    }
  }

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

  // The override decision sits AFTER the interface read (it needs the
  // bindable set) but BEFORE every detection branch — an accepted override
  // is the answer, and a rejected one only annotates whatever detection
  // then picks. `candidates` is reported either way so the Doctor can show
  // what else was on offer.
  if (trimmed.length > 0) {
    if (bindable.has(normalizeBindAddress(trimmed))) {
      // Verbatim: an explicit override says exactly what to bind, including
      // `127.0.0.1` for loopback-only or `0.0.0.0` for everything.
      return { address: trimmed, bind_address: trimmed, source: 'override', candidates };
    }
  }
  const ignored: Pick<ResolvedLanAddress, 'override_ignored'> =
    trimmed.length > 0
      ? { override_ignored: { value: trimmed, reason: 'not_bindable_on_this_host' } }
      : {};

  if (candidates.length === 0) {
    return {
      address: LOOPBACK_FALLBACK,
      bind_address: LOOPBACK_FALLBACK,
      source: 'loopback_fallback',
      candidates: [],
      ...ignored,
    };
  }

  if (candidates.length === 1) {
    return {
      address: candidates[0]!.address,
      bind_address: BIND_ALL_IPV4,
      source: 'detected',
      candidates,
      ...ignored,
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
            bind_address: BIND_ALL_IPV4,
            source: 'detected_via_default_route',
            candidates,
            ...ignored,
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
    bind_address: LOOPBACK_FALLBACK,
    source: 'ambiguous_lan_candidates',
    candidates,
    ...ignored,
  };
};
