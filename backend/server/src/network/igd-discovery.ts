/** D-273 P2 — SSDP discovery: find the router's IGD description.
 *
 *  🔑 WHY IGD REACHES WHERE NAT-PMP CANNOT. SSDP is multicast, so it needs no
 *  gateway address — which is exactly the gap that leaves NAT-PMP
 *  Linux/macOS-only, because `readDefaultRouteGateway()` returns undefined on
 *  win32. Discovery asks the network rather than asking a host.
 *
 *  ⛔⛔ AND THAT IS ALSO THE RISK: AN SSDP REPLY IS UNAUTHENTICATED AND ANY LAN
 *  DEVICE CAN SEND ONE. The reply carries a `LOCATION` URL that we would then
 *  fetch, so a hostile or broken peer on the network chooses a URL this server
 *  requests. `isPlausibleIgdLocation` is the bound: a router's description lives
 *  on a private address, and nothing else is worth following. */

import { isIP } from 'node:net';

export const SSDP_MULTICAST_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;

/** ⚠ ASKED FOR IN ORDER. Most consumer routers answer `:1`; `:2` exists on newer
 *  IPv6-capable gear and answers nothing on older. Searching both and taking the
 *  first that replies costs one extra datagram and covers both fleets. */
export const IGD_SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
] as const;

/** Seconds a device may wait before replying (SSDP `MX`). Replies are spread
 *  randomly across this window to avoid a stampede, so the COLLECTION WINDOW
 *  must be at least this long — a shorter one silently misses the slow half of
 *  the fleet and reports "no router found". */
export const SSDP_MX_SECONDS = 2;

/** Build an M-SEARCH datagram.
 *
 *  ⛔ CRLF IS MANDATORY AND SO IS THE TRAILING BLANK LINE. SSDP is HTTPU: many
 *  routers drop an LF-only message without a word, which reads exactly like a
 *  router that does not support UPnP.
 *  ⛔ `MAN` MUST BE QUOTED. `MAN: ssdp:discover` unquoted is rejected by a large
 *  slice of devices — another silent no-answer. */
export const buildSsdpSearch = (args: {
  searchTarget: string;
  mxSeconds?: number;
}): string =>
  [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_MULTICAST_ADDRESS}:${String(SSDP_PORT)}`,
    'MAN: "ssdp:discover"',
    `MX: ${String(args.mxSeconds ?? SSDP_MX_SECONDS)}`,
    `ST: ${args.searchTarget}`,
    '',
    '',
  ].join('\r\n');

export interface SsdpReply {
  searchTarget: string;
  location: string;
  /** Unique Service Name — the device identity, used to dedupe a device that
   *  answers more than once (multi-homed routers routinely do). */
  usn: string;
}

/** Parse an SSDP reply. Returns null for anything that is not a usable answer.
 *
 *  ⚠ HEADER NAMES ARE CASE-INSENSITIVE AND VENDORS USE EVERY CASING — `LOCATION`,
 *  `Location`, `location` all appear in the wild. Matching one spelling works
 *  against one fleet. */
export const parseSsdpReply = (raw: string): SsdpReply | null => {
  const lines = raw.split(/\r?\n/);
  if (!/^HTTP\/1\.\d\s+200\b/i.test(lines[0] ?? '')) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  const location = headers.get('location');
  const searchTarget = headers.get('st');
  if (location === undefined || location.length === 0) return null;
  if (searchTarget === undefined || searchTarget.length === 0) return null;
  return { location, searchTarget, usn: headers.get('usn') ?? '' };
};

/** Is this host a LITERAL address in a private or link-local range?
 *
 *  ⛔⛔ A NAME IS NOT AN ADDRESS, AND THIS USED TO ACCEPT ONE. The check here was
 *  three unanchored prefix regexes run against the hostname STRING, so
 *  `10.evil.com` and `192.168.1.attacker.example` both passed — ordinary DNS
 *  names that resolve wherever their owner points them. The function's own
 *  comment described the threat it was failing to stop.
 *
 *  ⇒ A DNS name is refused outright rather than resolved and checked. Resolving
 *  it would only move the hole: the name can answer differently between the
 *  check and the fetch, and nothing here can hold a resolution still. Routers
 *  advertise literals; a LOCATION that needs DNS is not one we will follow.
 *
 *  ⚠ IPv6 is matched on its textual prefix — `fe80::/10` and `fc00::/7` — which
 *  also rejects the mapped forms (`::ffff:10.0.0.1`) by construction, since
 *  those start `::`. The `%zone` strip is belt-and-braces only: a LOCATION
 *  carrying a zone id never reaches here, because `new URL` throws on a zoned
 *  literal before any address check runs. */
const isPrivateIpLiteral = (host: string): boolean => {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const zoneless = bare.replace(/%.*$/, '');
  const version = isIP(zoneless);
  if (version === 0) return false;
  if (version === 4) {
    const parts = zoneless.split('.').map((n) => Number(n));
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // A router with no DHCP lands on link-local; normal enough to accept.
    if (a === 169 && b === 254) return true;
    return false;
  }
  return /^fe[89ab]/i.test(zoneless) || /^f[cd]/i.test(zoneless);
};

/** Is this a URL we are willing to fetch on the strength of a multicast reply?
 *
 *  ⛔⛔ THE ANSWER CAME FROM AN UNAUTHENTICATED DATAGRAM. Any device on the
 *  network can reply to an M-SEARCH, and whatever `LOCATION` it names is a URL
 *  this server then requests. A router's description lives on a PRIVATE address;
 *  a LAN peer advertising a public one is broken or hostile, and following it
 *  would make this server fetch an attacker-chosen URL on their behalf.
 *
 *  ⚠ Loopback is refused too. A description served from 127.0.0.1 is not a
 *  router on this network — it is something on this host claiming to be one. */
export const isPlausibleIgdLocation = (location: string): boolean => {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isPrivateIpLiteral(url.hostname);
};

/** The host a discovered device lives at, for confining everything derived from
 *  its description back to it. Null when the location is not one we would
 *  follow in the first place. */
export const igdDeviceHost = (location: string): string | null => {
  try {
    const url = new URL(location);
    return isPlausibleIgdLocation(location) ? url.hostname : null;
  } catch {
    return null;
  }
};

export interface SsdpTransport {
  /** Send one M-SEARCH and collect every reply arriving within the window.
   *
   *  ⚠ `bindAddress` IS LOAD-BEARING ON A MULTI-HOMED HOST. Multicast leaves by
   *  ONE interface, and a host with a Docker bridge, a VPN tunnel and a real LAN
   *  will happily send it out the wrong one — where no router is listening, and
   *  the result is indistinguishable from a router that does not do UPnP. This
   *  is the same ambiguity `resolveLanAddress` already solves for binding, and
   *  its answer is what should be passed here. */
  search(args: {
    message: string;
    windowMs: number;
    bindAddress?: string;
  }): Promise<ReadonlyArray<string>>;
}

export interface IgdDiscoveryResult {
  location: string;
  searchTarget: string;
  usn: string;
}

/** Search for an IGD, trying each target in turn.
 *
 *  ⚠ First plausible reply wins. Several devices can answer — and on a network
 *  with more than one router that is a genuine ambiguity — but picking the first
 *  is what every IGD client does, and the alternative (asking the owner which
 *  router is theirs) is a UI, not a protocol decision. Recorded rather than
 *  silently assumed. */
export const discoverIgd = async (args: {
  transport: SsdpTransport;
  bindAddress?: string;
  mxSeconds?: number;
  /** Defaults to the MX window plus a little, never less — see `SSDP_MX_SECONDS`. */
  windowMs?: number;
}): Promise<IgdDiscoveryResult | null> => {
  const mxSeconds = args.mxSeconds ?? SSDP_MX_SECONDS;
  const windowMs = Math.max(args.windowMs ?? 0, mxSeconds * 1000 + 500);
  for (const searchTarget of IGD_SEARCH_TARGETS) {
    const replies = await args.transport.search({
      message: buildSsdpSearch({ searchTarget, mxSeconds }),
      windowMs,
      ...(args.bindAddress !== undefined ? { bindAddress: args.bindAddress } : {}),
    });
    const seen = new Set<string>();
    for (const raw of replies) {
      const reply = parseSsdpReply(raw);
      if (reply === null) continue;
      // ⚠ Deduped on USN: a multi-homed router answers the same search more than
      // once, and counting those as different devices would make "several
      // routers replied" the normal case.
      if (reply.usn.length > 0 && seen.has(reply.usn)) continue;
      if (reply.usn.length > 0) seen.add(reply.usn);
      if (reply.searchTarget !== searchTarget) continue;
      if (!isPlausibleIgdLocation(reply.location)) continue;
      return reply;
    }
  }
  return null;
};
