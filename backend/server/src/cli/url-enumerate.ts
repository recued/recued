/** D-121 Phase 5 — URL enumeration for `recued-server pair` / `status`.
 *
 *  CLI prints every URL the user might recognise so the operator can
 *  pick the one that matches their network mental model. Three sources:
 *
 *    - `configured` — hostname from the server config (when set).
 *    - `LAN` — local interface IPs from `os.networkInterfaces()`.
 *    - `public IP` — best-effort GET to `api.ipify.org`, cached for
 *      1 day in `~/.recued/state.json` to avoid hammering the probe.
 *
 *  No SSH-context magic — the same output everywhere (per spec
 *  § "SSH context handling"). Tests stub the env via `EnumerateDeps`.
 */

import { networkInterfaces, hostname } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type UrlSource = 'configured' | 'LAN' | 'public IP';

export interface ResolvedUrl {
  /** Absolute URL — `http://` for non-TLS LAN/loopback, `https://` for
   *  configured hostnames + the public-IP probe (which we display as
   *  `https://` because that's the conventional ops shape; users on
   *  plain http get the LAN row). */
  url: string;
  source: UrlSource;
}

export interface EnumerateConfig {
  /** Configured hostname from the server config file. Optional. When
   *  set, emits a `configured` row at the top of the list. */
  configuredHostname?: string;
  /** Configured TLS state — drives the `https:` vs `http:` choice for
   *  configured hostnames + public IPs. Defaults to true (operators
   *  typically front public servers with TLS). */
  configuredTls?: boolean;
  /** Server's HTTP listen port. Used for non-TLS LAN URLs. */
  port: number;
}

export interface EnumerateDeps {
  /** Override `os.networkInterfaces` for tests. */
  networkInterfaces?: typeof networkInterfaces;
  /** Override the public-IP probe. Returning `null` means "skip the
   *  public-IP row" (test isolation default). */
  fetchPublicIp?: () => Promise<string | null>;
  /** Override the cache file path. Defaults to `~/.recued/state.json`. */
  cachePath?: string;
  /** Current time, ms — defaults to `Date.now`. */
  now?: () => number;
}

/** TTL for the cached public-IP row, ms. 1 day per spec. */
export const PUBLIC_IP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_CACHE_PATH = join(homedir(), '.recued', 'state.json');

interface CacheEntry {
  ip: string;
  fetched_at: number;
}

const readCache = (path: string): CacheEntry | null => {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ip = parsed.public_ip as Record<string, unknown> | undefined;
    if (!ip || typeof ip.ip !== 'string' || typeof ip.fetched_at !== 'number') return null;
    return { ip: ip.ip, fetched_at: ip.fetched_at };
  } catch {
    return null;
  }
};

const writeCache = (path: string, entry: CacheEntry): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    let prior: Record<string, unknown> = {};
    try {
      prior = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      prior = {};
    }
    const next = { ...prior, public_ip: { ip: entry.ip, fetched_at: entry.fetched_at } };
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    /* swallow — cache is best-effort */
  }
};

/** Best-effort public-IP resolver via `api.ipify.org` — IPv4 OR IPv6
 *  depending on the host's preferred address family. Returns null on
 *  network / parse / validation failure. Used by the pair-flow CLI's
 *  "what's my IP" display where the address family doesn't matter. */
export const fetchIpify = async (): Promise<string | null> => {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { method: 'GET' });
    if (!res.ok) return null;
    const body = await res.json() as { ip?: string };
    if (typeof body.ip !== 'string') return null;
    if (!/^[0-9.]+$|^[0-9a-fA-F:]+$/.test(body.ip)) return null;
    return body.ip;
  } catch {
    return null;
  }
};

/** Dotted-quad regex for strict IPv4 validation. Matches four
 *  octets in 0-255; rejects leading zeros (per RFC 1123). Tighter
 *  than the loose `/^[0-9.]+$/` accept-list in `fetchIpify`. */
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPV4_REGEX = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

/** IPv4-only public-IP resolver via `api4.ipify.org` (the dual-stack
 *  endpoint at `api.ipify.org` returns IPv6 on IPv6-preferred hosts,
 *  which would land in the DDNS update's `ip_v4` field and fail the
 *  cloud's `IPV4_REGEX` validation with `ddns_validation_error`).
 *  Returns null on network / parse / validation failure — including
 *  the defense-in-depth case where `api4.ipify.org` returns an
 *  unexpected non-IPv4 string. */
export const fetchPublicIpv4 = async (): Promise<string | null> => {
  try {
    const res = await fetch('https://api4.ipify.org?format=json', { method: 'GET' });
    if (!res.ok) return null;
    const body = await res.json() as { ip?: string };
    if (typeof body.ip !== 'string') return null;
    if (!IPV4_REGEX.test(body.ip)) return null;
    return body.ip;
  } catch {
    return null;
  }
};

/** Resolve a public IP, hitting the cache where possible. */
export const resolvePublicIp = async (
  deps: EnumerateDeps = {},
): Promise<string | null> => {
  const cachePath = deps.cachePath ?? DEFAULT_CACHE_PATH;
  const now = (deps.now ?? Date.now)();
  const cached = readCache(cachePath);
  if (cached && now - cached.fetched_at < PUBLIC_IP_CACHE_TTL_MS) {
    return cached.ip;
  }
  const probe = deps.fetchPublicIp ?? fetchIpify;
  const fresh = await probe();
  if (fresh) {
    writeCache(cachePath, { ip: fresh, fetched_at: now });
    return fresh;
  }
  // Fall back to the stale cache if the probe failed — better-than-nothing.
  return cached?.ip ?? null;
};

/** Collect LAN IPs (IPv4 + IPv6 link-locals/uniques) from the OS. */
export const collectLanInterfaces = (
  deps: EnumerateDeps = {},
): string[] => {
  const ifaces = (deps.networkInterfaces ?? networkInterfaces)();
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (entry.internal) continue;
      // IPv4 unicast + IPv6 globally addressable
      if (entry.family === 'IPv4') out.push(entry.address);
      else if (entry.family === 'IPv6' && !entry.address.startsWith('fe80:')) out.push(entry.address);
    }
  }
  return Array.from(new Set(out));
};

/** Build the final enumeration list. Order: configured first, then LAN,
 *  then public IP. Test by stubbing `deps.networkInterfaces` +
 *  `deps.fetchPublicIp`. */
export const enumerateServerUrls = async (
  config: EnumerateConfig,
  deps: EnumerateDeps = {},
): Promise<ResolvedUrl[]> => {
  const out: ResolvedUrl[] = [];
  if (config.configuredHostname && config.configuredHostname.length > 0) {
    const proto = config.configuredTls === false ? 'http' : 'https';
    out.push({ url: `${proto}://${config.configuredHostname}`, source: 'configured' });
  }

  for (const ip of collectLanInterfaces(deps)) {
    // IPv6 needs square brackets in URLs.
    const host = ip.includes(':') ? `[${ip}]` : ip;
    out.push({ url: `http://${host}:${config.port}`, source: 'LAN' });
  }

  const publicIp = await resolvePublicIp(deps);
  if (publicIp) {
    const host = publicIp.includes(':') ? `[${publicIp}]` : publicIp;
    out.push({ url: `https://${host}:${config.port}`, source: 'public IP' });
  }
  return out;
};

/** Format the enumeration as the spec's two-column block:
 *
 *      https://my-server.example.com         configured
 *      http://192.168.1.42:8080               LAN
 *      https://203.0.113.42:8080              public IP
 *
 *  Single space-padded alignment; right column never wider than the
 *  longest source label (which is `public IP` at 9 chars). */
export const formatUrlList = (urls: ResolvedUrl[]): string => {
  if (urls.length === 0) return '  (no reachable URLs detected — check network config)';
  const maxUrl = urls.reduce((n, r) => Math.max(n, r.url.length), 0);
  return urls
    .map((r) => `  ${r.url.padEnd(maxUrl + 4, ' ')}${r.source}`)
    .join('\n');
};

/** Default-host helper for the spec's "Hostname unavailable" fallback. */
export const localHostname = (): string => {
  try {
    return hostname() || 'localhost';
  } catch {
    return 'localhost';
  }
};
