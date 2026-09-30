/** The addresses the internet reaches THIS server at, picked live.
 *
 *  Every link the server hands to someone elsewhere needs one: an ask's
 *  one-click answer, a deep link into the webclient, a vendor sign-in's way
 *  back, a customer's claim. It used to be `RECUED_PUBLIC_BASE_URL` alone — a
 *  terminal setting — so a Pro owner who never set it (the case Pro exists
 *  for) got no link at all, and a server with two names could not tell which
 *  one answers.
 *
 *  Preferred first:
 *   1. `RECUED_PUBLIC_BASE_URL` when set, read at each call. The owner's
 *      explicit choice; only a LAN or local host is refused.
 *   2. Each verified, enabled hostname holding a certificate (or behind a
 *      proxy that holds one), on 443 when it listens there, that serves what
 *      the link opens — its path Public on the Exposure grid, or for a root
 *      link an apex that lands on the webclient (a Pro address in `redirect`
 *      mode, or `serve_webclient` with the webclient servable). Ranked by the
 *      cloud probe: answered over https first, then not known; a fresh
 *      "nothing answers" is left out. Then own domain before Pro address,
 *      then 443.
 *
 *  Three readings, for three kinds of reader:
 *   - `baseUrls(target)` — live and ranked, for a link someone is about to open.
 *   - `handOut(use)` — an address someone KEEPS: a webhook address a vendor
 *     stores, a Reception link that gets printed, a customer's MCP / gateway
 *     address. Never follows the probe, and is kept from its first use, so
 *     adding a name later moves nothing; the owner moves it on the Hostnames
 *     screen. A kept name that stops working is reported, never replaced.
 *   - `ownBaseUrls()` — every address that is this server's own, whatever the
 *     grid or the probe says, for recognising one of ours on the way back in.
 *
 *  ⛔ Only names the fleet issued (`recued_acme` / `recued_acme_custom`) are
 *  probed: the cloud already knows them. Probing a bring-your-own name would
 *  tell the cloud a name it was never given. */

import type Database from 'better-sqlite3';
import {
  HOSTNAME_ADDRESS_USES,
  PATH_ROLES,
  canBindHostname,
  canonicalizeServerPublicUrl,
  isFleetIssuedCertSource,
  isHostnameAddressUse,
  isProDdnsHost,
  normalizeHostname,
  type CloudProbeRequest,
  type CloudProbeResponse,
  type HostnameAddressChoice,
  type HostnameAddressUse,
  type HostnameAddressUseState,
  type HostnameAddressUsesResponse,
  type HostnameProjection,
  type PathResolution,
  type PathRole,
  type RootApexMode,
} from '@recued/contracts';
import { resolvePublicBaseUrl } from './ask-landing-answer-link.js';

/** A path role, or `root`: a webclient deep link (`<base>/#…`), which works
 *  only where the bare `/` lands on the webclient. */
export type PublicAddressTarget = PathRole | 'root';

export const PUBLIC_ADDRESS_TARGETS: ReadonlyArray<PublicAddressTarget> = [
  'root',
  ...PATH_ROLES,
];

export type PublicHostnameRow = Pick<
  HostnameProjection,
  | 'hostname'
  | 'listener_ports'
  | 'enabled'
  | 'ownership_status'
  | 'tls_topology'
  | 'cert_source'
  | 'cert_fingerprint'
  | 'cert_provisioning'
>;

export interface PublicHostnameSource {
  list(): ReadonlyArray<PublicHostnameRow>;
}

/** What the serving process knows right now about how it is served. Bound
 *  once the listener is composed. Until then — early boot, or the stdio MCP
 *  process, which has no listener — the names come from what the serving
 *  process last published. */
export interface PublicAddressFacts {
  /** Whether `role` is Public on the Exposure grid; null before the grid has
   *  been read. */
  pathPublic(role: PathRole): boolean | null;
  apexMode(): RootApexMode;
  /** A verified webclient bundle loaded at boot. */
  webclientBundleLoaded(): boolean;
  publicListenerBound(): boolean;
  /** Re-read what nothing pushes, before a probe round. */
  refresh?(): Promise<void>;
}

/** One probe answer for one name and port, as seen from outside. */
export interface ProbeVerdict {
  readonly hostname: string;
  readonly port: number;
  readonly probed_at: number;
  /** Something answered on the port. */
  readonly port_open: boolean;
  /** An https request there got an answer over a valid certificate chain. */
  readonly https_ok: boolean;
  readonly last_error?: string;
}

/** The name kept for a use, and who kept it. */
export interface AddressPin {
  readonly hostname: string;
  readonly by: 'owner' | 'first_use';
  readonly at: number;
}

export interface PublicAddressStore {
  verdict(hostname: string, port: number): ProbeVerdict | null;
  putVerdict(verdict: ProbeVerdict): void;
  /** What the serving process last worked out for `target`, WITHOUT the
   *  configured address; null when it never published. */
  published(target: PublicAddressTarget): string[] | null;
  publish(byTarget: Readonly<Record<string, readonly string[]>>, at: number): void;
  pins(): Partial<Record<HostnameAddressUse, AddressPin>>;
  /** Keep a name for a use, or forget it (`null`). */
  setPin(use: HostnameAddressUse, pin: AddressPin | null): void;
}

/** How long a verdict counts. Longer than either re-probe interval, so one
 *  missed round does not turn a known answer into "not known". */
export const PROBE_VERDICT_FRESH_MS = 12 * 60 * 60_000;
/** Re-probe a name that answered over https. */
export const PROBE_REACHABLE_EVERY_MS = 6 * 60 * 60_000;
/** Re-probe any other name — a closed port gets fixed, a certificate lands. */
export const PROBE_OTHER_EVERY_MS = 30 * 60_000;

const PROBES_KEY = 'public_address_probes';
const PUBLISHED_KEY = 'public_address_published';
const PINS_KEY = 'public_address_pins';
/** A server has a handful of names; this only stops a removed name's old
 *  verdicts from piling up. */
const MAX_KEPT_VERDICTS = 32;

const isProbeVerdict = (value: unknown): value is ProbeVerdict => {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.hostname === 'string'
    && typeof v.port === 'number'
    && Number.isInteger(v.port)
    && typeof v.probed_at === 'number'
    && typeof v.port_open === 'boolean'
    && typeof v.https_ok === 'boolean'
    && (v.last_error === undefined || typeof v.last_error === 'string');
};

const isAddressPin = (value: unknown): value is AddressPin => {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.hostname === 'string'
    && v.hostname.length > 0
    && (v.by === 'owner' || v.by === 'first_use')
    && typeof v.at === 'number';
};

/** `server_config` rows, like the DDNS IP state: no new table, and that table
 *  is already classed as server state by the restore guard. ⚠ Not
 *  `config.toml`: a kept name is written by the server itself on first use,
 *  and a docker install mounts that file read-only. */
export const createSqlitePublicAddressStore = (
  db: Database.Database,
): PublicAddressStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const readStmt = db.prepare(`SELECT value FROM server_config WHERE key = ?`);
  const writeStmt = db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`);

  const readJson = (key: string): unknown => {
    const row = readStmt.get(key) as { value?: unknown } | undefined;
    if (typeof row?.value !== 'string') return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  };

  // Only the serving process writes verdicts, so one read at first use stays
  // true for the life of the process.
  let verdicts: ProbeVerdict[] | null = null;
  const allVerdicts = (): ProbeVerdict[] => {
    if (verdicts === null) {
      const raw = readJson(PROBES_KEY);
      verdicts = Array.isArray(raw) ? raw.filter(isProbeVerdict) : [];
    }
    return verdicts;
  };

  return {
    verdict: (hostname, port) =>
      allVerdicts().find((v) => v.hostname === hostname && v.port === port) ?? null,
    putVerdict: (verdict) => {
      const next = [
        ...allVerdicts().filter((v) => !(v.hostname === verdict.hostname && v.port === verdict.port)),
        verdict,
      ].slice(-MAX_KEPT_VERDICTS);
      writeStmt.run(PROBES_KEY, JSON.stringify(next));
      verdicts = next;
    },
    published: (target) => {
      const raw = readJson(PUBLISHED_KEY);
      if (raw === null || typeof raw !== 'object') return null;
      const list = (raw as { by_target?: Record<string, unknown> }).by_target?.[target];
      return Array.isArray(list)
        ? list.filter((url): url is string => typeof url === 'string')
        : null;
    },
    publish: (byTarget, at) => {
      writeStmt.run(PUBLISHED_KEY, JSON.stringify({ published_at: at, by_target: byTarget }));
    },
    pins: () => {
      const raw = readJson(PINS_KEY);
      const out: Partial<Record<HostnameAddressUse, AddressPin>> = {};
      if (raw === null || typeof raw !== 'object') return out;
      for (const [use, pin] of Object.entries(raw as Record<string, unknown>)) {
        if (isHostnameAddressUse(use) && isAddressPin(pin)) out[use] = pin;
      }
      return out;
    },
    setPin: (use, pin) => {
      const current = (readJson(PINS_KEY) ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...current };
      if (pin === null) delete next[use];
      else next[use] = pin;
      writeStmt.run(PINS_KEY, JSON.stringify(next));
    },
  };
};

export type ProbeOutcome =
  | { readonly kind: 'verdict'; readonly verdict: ProbeVerdict }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ReachabilityProber {
  probe(hostname: string, port: number): Promise<ProbeOutcome>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The cloud probe (`POST <probe>/v1/reachability/probe`), asked two things
 *  about one port: does anything answer (`tcp`), and does https answer over a
 *  valid chain (`http`, on `/health` — any response counts).
 *
 *  ⚠ Both, because they fail apart. Before a Pro name's certificate is issued
 *  its port can be open while https fails, and the Pro card's "can your server
 *  be reached" means the port. And an https failure beside an open port may be
 *  the probe's own limit rather than the address's, so it never excludes a
 *  name — only "nothing answers at all" does. */
export const createCloudReachabilityProber = (deps: {
  readonly endpoint: () => string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}): ReachabilityProber => {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const now = deps.now ?? Date.now;

  return {
    async probe(hostname, port) {
      const request: CloudProbeRequest = {
        hostname,
        targets: [
          { port, kind: 'http', role: 'health' },
          { port, kind: 'tcp' },
        ],
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status: number;
      let body: unknown;
      try {
        const response = await fetchImpl(deps.endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        status = response.status;
        body = await response.json().catch(() => null);
      } catch (error) {
        return { kind: 'failed', reason: error instanceof Error ? error.message : 'fetch_failed' };
      } finally {
        clearTimeout(timer);
      }

      const verdict = (
        port_open: boolean,
        https_ok: boolean,
        last_error: string | undefined,
      ): ProbeOutcome => ({
        kind: 'verdict',
        verdict: {
          hostname,
          port,
          probed_at: now(),
          port_open,
          https_ok,
          ...(last_error !== undefined ? { last_error } : {}),
        },
      });

      if (status === 429) return { kind: 'rate_limited' };
      const errorCode = (body as { error?: { code?: unknown } } | null)?.error?.code;
      // The name resolves to a private address: nobody outside can reach it,
      // which is an answer, not a failure to get one.
      if (status === 403 && errorCode === 'reachability_private_ip_denied') {
        return verdict(false, false, 'resolves_to_private_ip');
      }
      if (status < 200 || status >= 300) return { kind: 'failed', reason: `http_${String(status)}` };

      const data = (body as { data?: Partial<CloudProbeResponse> } | null)?.data;
      const results = Array.isArray(data?.per_target) ? data.per_target : [];
      const http = results.find((t) => t.kind === 'http' && t.port === port);
      const tcp = results.find((t) => t.kind === 'tcp' && t.port === port);
      if (http === undefined && tcp === undefined) {
        return { kind: 'failed', reason: 'malformed_response' };
      }
      const https_ok = http?.reachable === true;
      const port_open = https_ok || tcp?.reachable === true;
      return verdict(
        port_open,
        https_ok,
        https_ok ? undefined : http?.last_error ?? tcp?.last_error,
      );
    },
  };
};

export interface PublicAddressService {
  /** Live and ranked: the configured address, then each name that serves
   *  `target` right now, best probe answer first. Never a LAN or local host;
   *  empty when there is none. Before the facts are bound, the serving
   *  process's last published answer stands in for the names. */
  baseUrls(target: PublicAddressTarget): string[];
  baseUrl(target: PublicAddressTarget): string | null;
  /** Every address that is this server's own — configured, then each
   *  verified name with a certificate — regardless of the grid or the probe. */
  ownBaseUrls(): string[];
  /** The address handed out for `use`, and who decided it. Reads only. */
  addressUse(use: HostnameAddressUse): HostnameAddressUseState;
  /** The address to hand out for `use` NOW: as `addressUse`, but an
   *  automatic answer is kept from here on (`first_use`). Call it where the
   *  address actually leaves the server. */
  handOut(use: HostnameAddressUse): HostnameAddressUseState;
  /** Keep `hostname` for `use`, or go back to automatic (`null`). Throws
   *  `AddressChoiceError` for a name that cannot be picked. */
  setAddressUse(use: HostnameAddressUse, hostname: string | null): void;
  /** The names that can be picked, own domain first. */
  addressChoices(): HostnameAddressChoice[];
  /** Everything the Hostnames screen shows, except the webhook count. */
  describeAddressUses(): Omit<HostnameAddressUsesResponse, 'registered_webhooks'>;
  /** The Pro address's reachability, for the Pro card; null when unknown. */
  proReachability(): { reachable: boolean } | null;
  bindFacts(facts: PublicAddressFacts): void;
  /** Probe each fleet-issued name that is due, then publish. */
  probeDue(): Promise<void>;
  /** Write the live answers for a reader without facts — the stdio MCP
   *  process, or this one's next boot. No-op until the facts are bound and the
   *  grid read. */
  publish(): void;
}

export interface PublicAddressServiceDeps {
  /** `RECUED_PUBLIC_BASE_URL`, read at each call. */
  readonly configured: () => string | undefined;
  readonly hostnames: PublicHostnameSource;
  readonly store: PublicAddressStore;
  /** Absent ⇒ nothing is probed and every name stays "not known". */
  readonly prober?: ReachabilityProber;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

interface Candidate {
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly pro: boolean;
}

/** A name that cannot be kept for a use. */
export class AddressChoiceError extends Error {}

const LOCAL_SHARE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Reception's own rule for a configured share address: http or https, any
 *  host but a loopback name. Wider than every other use on purpose — an
 *  operator may hand visitors an intranet address. */
export const acceptsReceptionShareBaseUrl = (raw: string | null): raw is string => {
  if (raw === null) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.hostname.length > 0
      && !LOCAL_SHARE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** An https address a vendor or customer may be given: no credentials, no
 *  query, no fragment. A path is fine (a proxy in front). */
const isCleanHttpsBase = (url: string): boolean => {
  if (url.includes('?') || url.includes('#')) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
};

type Standing = 'reachable' | 'unknown' | 'unreachable';

const listenerPort = (row: PublicHostnameRow): number | undefined =>
  row.listener_ports.includes(443) ? 443 : row.listener_ports[0];

const originFor = (hostname: string, port: number): string | null =>
  resolvePublicBaseUrl(port === 443 ? `https://${hostname}` : `https://${hostname}:${String(port)}`);

/** A certificate the server serves, or a proxy in front that holds one. A
 *  failed renewal keeps the certificate it had, so the fingerprint counts. */
const holdsCertificate = (row: PublicHostnameRow): boolean =>
  row.tls_topology === 'upstream_terminated'
  || row.cert_fingerprint !== undefined
  || row.cert_provisioning === 'ready';

const byPreference = (a: Candidate, b: Candidate): number =>
  Number(a.pro) - Number(b.pro) || Number(a.port !== 443) - Number(b.port !== 443);

const STANDING_RANK: Record<Exclude<Standing, 'unreachable'>, number> = {
  reachable: 0,
  unknown: 1,
};

const unique = (values: ReadonlyArray<string | null>): string[] => {
  const out: string[] = [];
  for (const value of values) {
    if (value !== null && !out.includes(value)) out.push(value);
  }
  return out;
};

export const createPublicAddressService = (
  deps: PublicAddressServiceDeps,
): PublicAddressService => {
  const now = deps.now ?? Date.now;
  let facts: PublicAddressFacts | null = null;
  let lastPublished: string | null = null;
  let probing: Promise<void> | null = null;

  const configuredOrigin = (): string | null => resolvePublicBaseUrl(deps.configured());

  /** Every usable name, in registry order. */
  const candidates = (): Candidate[] => {
    const out: Candidate[] = [];
    for (const row of deps.hostnames.list()) {
      if (!canBindHostname(row) || !holdsCertificate(row)) continue;
      const port = listenerPort(row);
      if (port === undefined) continue;
      const origin = originFor(row.hostname, port);
      if (origin === null) continue;
      out.push({ origin, hostname: row.hostname, port, pro: isProDdnsHost(row.hostname) });
    }
    return out;
  };

  const standing = (candidate: Candidate, at: number): Standing => {
    const verdict = deps.store.verdict(candidate.hostname, candidate.port);
    if (verdict === null || at - verdict.probed_at > PROBE_VERDICT_FRESH_MS) return 'unknown';
    if (verdict.https_ok) return 'reachable';
    return verdict.port_open ? 'unknown' : 'unreachable';
  };

  const serves = (bound: PublicAddressFacts, candidate: Candidate, target: PublicAddressTarget): boolean => {
    if (target !== 'root') return bound.pathPublic(target) === true;
    // A root link is `<base>/#…`; the fragment survives the apex's redirect.
    switch (bound.apexMode()) {
      case 'redirect':
        // The apex sends a Pro address to app.recued.com; any other host 404s.
        return candidate.pro;
      case 'serve_webclient':
        return bound.webclientBundleLoaded() && bound.pathPublic('webclient') === true;
      case 'serve_reception':
      case 'not_found':
        return false;
    }
  };

  /** The live, ranked names for `target`, without the configured address. */
  const liveNames = (target: PublicAddressTarget): string[] => {
    const bound = facts;
    if (bound === null) {
      // No listener to ask: take the last published answer, kept to names
      // that are still ours.
      const own = candidates().map((candidate) => candidate.origin);
      return (deps.store.published(target) ?? []).filter((url) => own.includes(url));
    }
    if (!bound.publicListenerBound()) return [];
    const at = now();
    return candidates()
      .filter((candidate) => serves(bound, candidate, target))
      .map((candidate) => ({ candidate, standing: standing(candidate, at) }))
      .filter((entry): entry is { candidate: Candidate; standing: Exclude<Standing, 'unreachable'> } =>
        entry.standing !== 'unreachable')
      .sort((a, b) =>
        STANDING_RANK[a.standing] - STANDING_RANK[b.standing]
        || byPreference(a.candidate, b.candidate))
      .map((entry) => entry.candidate.origin);
  };

  const baseUrls = (target: PublicAddressTarget): string[] =>
    unique([configuredOrigin(), ...liveNames(target)]);

  const addressChoices = (): HostnameAddressChoice[] =>
    candidates()
      .sort(byPreference)
      .map((candidate) => ({ hostname: candidate.hostname, base_url: candidate.origin }));

  /** The configured address, if this use may be given it. */
  const configuredFor = (use: HostnameAddressUse): string | null => {
    const raw = deps.configured()?.trim();
    if (raw === undefined || raw.length === 0) return null;
    if (use === 'reception') {
      const value = raw.replace(/\/+$/, '');
      return acceptsReceptionShareBaseUrl(value) ? value : null;
    }
    const strict = resolvePublicBaseUrl(raw);
    return strict !== null && isCleanHttpsBase(strict) ? strict : null;
  };

  const addressUse = (use: HostnameAddressUse): HostnameAddressUseState => {
    const pin = deps.store.pins()[use];
    const configured = configuredFor(use);
    if (configured !== null) {
      return {
        use,
        source: 'configured',
        base_url: configured,
        ...(pin !== undefined ? { hostname: pin.hostname } : {}),
      };
    }
    const choices = addressChoices();
    if (pin !== undefined) {
      const kept = choices.find((choice) => choice.hostname === pin.hostname);
      return kept !== undefined
        ? { use, source: pin.by, base_url: kept.base_url, hostname: pin.hostname }
        : { use, source: pin.by, base_url: null, hostname: pin.hostname, hostname_unusable: true };
    }
    return { use, source: 'automatic', base_url: choices[0]?.base_url ?? null };
  };

  const handOut = (use: HostnameAddressUse): HostnameAddressUseState => {
    const state = addressUse(use);
    if (state.source !== 'automatic' || state.base_url === null) return state;
    const first = addressChoices()[0];
    if (first === undefined) return state;
    try {
      deps.store.setPin(use, { hostname: first.hostname, by: 'first_use', at: now() });
    } catch (error) {
      // Handing the address out still works; it is simply not kept yet.
      deps.log?.(`keeping the ${use} address failed: ${error instanceof Error ? error.message : String(error)}`);
      return state;
    }
    return { use, source: 'first_use', base_url: state.base_url, hostname: first.hostname };
  };

  const setAddressUse = (use: HostnameAddressUse, hostname: string | null): void => {
    if (hostname === null) {
      deps.store.setPin(use, null);
      return;
    }
    const wanted = normalizeHostname(hostname);
    if (wanted === null) throw new AddressChoiceError(`'${hostname}' is not a hostname`);
    if (!addressChoices().some((choice) => choice.hostname === wanted)) {
      throw new AddressChoiceError(
        `'${wanted}' cannot be used: it must be one of your names that is verified, switched on and has a certificate`,
      );
    }
    deps.store.setPin(use, { hostname: wanted, by: 'owner', at: now() });
  };

  const publish = (): void => {
    const bound = facts;
    if (bound === null || PATH_ROLES.some((role) => bound.pathPublic(role) === null)) return;
    const byTarget: Record<string, string[]> = {};
    for (const target of PUBLIC_ADDRESS_TARGETS) byTarget[target] = liveNames(target);
    const serialized = JSON.stringify(byTarget);
    if (serialized === lastPublished) return;
    try {
      deps.store.publish(byTarget, now());
      lastPublished = serialized;
    } catch (error) {
      deps.log?.(`publish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Fleet-issued names whose last answer is missing or old enough. The
   *  certificate is not required: the Pro card needs the port's answer
   *  before there is one. */
  const dueProbes = (at: number): Array<{ hostname: string; port: number }> => {
    const out: Array<{ hostname: string; port: number }> = [];
    for (const row of deps.hostnames.list()) {
      if (!isFleetIssuedCertSource(row.cert_source) || !canBindHostname(row)) continue;
      const port = listenerPort(row);
      if (port === undefined || originFor(row.hostname, port) === null) continue;
      if (out.some((due) => due.hostname === row.hostname && due.port === port)) continue;
      const verdict = deps.store.verdict(row.hostname, port);
      const every = verdict?.https_ok === true ? PROBE_REACHABLE_EVERY_MS : PROBE_OTHER_EVERY_MS;
      if (verdict === null || at - verdict.probed_at >= every) out.push({ hostname: row.hostname, port });
    }
    return out;
  };

  const runProbeRound = async (): Promise<void> => {
    await facts?.refresh?.();
    const bound = facts;
    // Nothing can answer while the public listener is down, and recording
    // that would hide the name for a while after it comes back up.
    if (deps.prober !== undefined && bound !== null && bound.publicListenerBound()) {
      for (const due of dueProbes(now())) {
        const outcome = await deps.prober.probe(due.hostname, due.port);
        if (outcome.kind === 'verdict') {
          deps.store.putVerdict(outcome.verdict);
        } else if (outcome.kind === 'rate_limited') {
          deps.log?.('probe rate-limited; trying again next round');
          break;
        } else {
          deps.log?.(`probe of ${due.hostname}:${String(due.port)} failed: ${outcome.reason}`);
        }
      }
    }
    publish();
  };

  return {
    baseUrls,
    baseUrl: (target) => baseUrls(target)[0] ?? null,
    ownBaseUrls: () =>
      unique([configuredOrigin(), ...candidates().sort(byPreference).map((c) => c.origin)]),
    addressUse,
    handOut,
    setAddressUse,
    addressChoices,
    describeAddressUses: () => ({
      uses: HOSTNAME_ADDRESS_USES.map((use) => addressUse(use)),
      choices: addressChoices(),
      links_now: {
        app: baseUrls('root')[0] ?? null,
        answers: baseUrls('ask')[0] ?? null,
      },
    }),
    proReachability: () => {
      const pros = deps.hostnames.list().filter((row) =>
        row.cert_source === 'recued_acme' && canBindHostname(row) && isProDdnsHost(row.hostname));
      if (pros.length === 0) return null;
      if (facts !== null && !facts.publicListenerBound()) return { reachable: false };
      const at = now();
      let answered = false;
      for (const row of pros) {
        const port = listenerPort(row);
        if (port === undefined) continue;
        const verdict = deps.store.verdict(row.hostname, port);
        if (verdict === null || at - verdict.probed_at > PROBE_VERDICT_FRESH_MS) continue;
        if (verdict.port_open || verdict.https_ok) return { reachable: true };
        answered = true;
      }
      return answered ? { reachable: false } : null;
    },
    bindFacts: (next) => {
      facts = next;
      publish();
    },
    probeDue: () => {
      probing ??= runProbeRound().finally(() => {
        probing = null;
      });
      return probing;
    },
    publish,
  };
};

/** The listener's facts: the grid is read on refresh and pushed on change;
 *  the rest is read live. */
export const createListenerPublicAddressFacts = (deps: {
  readonly readResolution: () => Promise<Readonly<Record<PathRole, PathResolution>>>;
  readonly apexMode: () => RootApexMode;
  readonly webclientBundleLoaded: boolean;
  readonly publicListenerBound: () => boolean;
}): PublicAddressFacts & {
  setResolution(resolution: Readonly<Record<PathRole, PathResolution>>): void;
} => {
  let resolution: Readonly<Record<PathRole, PathResolution>> | null = null;
  return {
    pathPublic: (role) => (resolution === null ? null : resolution[role]?.public === true),
    apexMode: deps.apexMode,
    webclientBundleLoaded: () => deps.webclientBundleLoaded,
    publicListenerBound: deps.publicListenerBound,
    refresh: async () => {
      try {
        resolution = await deps.readResolution();
      } catch {
        // Keep the last reading; the next round tries again.
      }
    },
    setResolution: (next) => {
      resolution = next;
    },
  };
};

/** The canonical https origins among what the vendor OAuth wiring reports —
 *  one URL, a list, or nothing — deduplicated, preferred first. A value that
 *  is not a clean https origin is dropped (`canonicalizeServerPublicUrl`). */
export const canonicalServerPublicOrigins = (
  raw: string | readonly string[] | null,
): string[] => {
  const values = raw === null ? [] : typeof raw === 'string' ? [raw] : raw;
  return unique(values.map((value) => canonicalizeServerPublicUrl(value)));
};
