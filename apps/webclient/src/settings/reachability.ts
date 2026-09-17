/** D-148 § A.10 / D-272 — the cloud diagnostic probe: request, call, and the
 *  tri-state folds that read one port's answer out of a response.
 *
 *  ⚠ THIS FILE USED TO BE A PAGE. The Settings → Server → Reachability renderer
 *  lived here and was deleted with its tab: a diagnostic given a destination of
 *  its own, mounted only for probe-havers, projecting a `ReachabilityReport`
 *  that nothing built — and which has since been deleted from contracts along
 *  with its builder. What survives is the PLUMBING — everything Connect a
 *  device calls to ask a question and read the answer — plus the three result
 *  formatters its folded detail block renders through.
 *
 *  ⛔ The name is now wider than the contents and that is deliberate: renaming
 *  the module would move every import in a commit whose point was deletion. */

import {
  HOSTNAME_LISTENER_PORTS,
  isDiagnosticAllowedPort,
  isDiagnosticExtraPort,
  type DiagnosticOwnershipProofMethod,
  type DiagnosticKind,
  type DiagnosticRequest,
  type DiagnosticResponse,
  type DiagnosticResult,
} from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// D-176 Phase 5 — the reachability + diagnostics probes split out of the
// sync-worker (api host) onto the standalone probe Worker at its own subdomain
// (spec § 5; `wrangler.probe.toml`). The api host now 404s `/v1/diagnostics/probe`.
const DEFAULT_DIAGNOSTIC_API_BASE_URL = 'https://probe.recued.com';
const DEFAULT_DIAGNOSTIC_CHECKS: ReadonlyArray<DiagnosticKind> = [
  'detected_public_ip',
  'port_reachability',
  'dns_resolution',
  'tls_handshake',
  'nat_class',
];

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ReachabilityDiagnosticFetch = FetchLike;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const errorMessage = (err: unknown): string =>
  humanizeRpcError(err);

const apiErrorMessage = (body: unknown, status: number): string => {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : null;
    const message =
      typeof body.error.message === 'string' ? body.error.message : null;
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
    if (code) return code;
  }
  return `the check failed: HTTP ${status}`;
};

const readApiData = <T>(body: unknown): T => {
  if (isRecord(body) && 'data' in body) return body.data as T;
  throw new Error('Recued could not read the answer to its check');
};

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

const diagnosticProbeUrl = (baseUrl: string): string =>
  new URL('/v1/diagnostics/probe', normalizeBaseUrl(baseUrl)).toString();

const defaultFetch: FetchLike = async (input, init) => {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof f !== 'function') {
    throw new Error('Recued cannot run the check from here');
  }
  return f(input, init);
};

/** What the probe caller needs to name a target. */
export interface ReachabilityDiagnosticTarget {
  account_id: string;
  hostname: string;
  expected_public_ip?: string;
  acme_challenge_token?: string;
  ownership_probe_method?: DiagnosticOwnershipProofMethod;
  /** Ports to ask `port_reachability` about. Omitted → every hostname listener
   *  port, which is what the Reachability page wants (an operator asks about
   *  every listener).
   *
   *  🔑 A CALLER THAT READS ONE PORT SHOULD ASK ABOUT ONE PORT, and the reason
   *  is wall clock, not bytes. `runDiagnosticChecks` walks
   *  `for (const port of target.ports)` with an `await` inside, each probe under
   *  a 5s timeout — so four ports is four SEQUENTIAL timeouts for a router that
   *  DROPs rather than REJECTs, which is the common case and therefore the
   *  reader this costs. ⛔ The slow path is the FAILING one: the beginner whose
   *  router is shut waits longest.
   *
   *  ⚠ EVERY PORT NAMED HERE MUST BE IN `DIAGNOSTIC_ALLOWED_PORTS`. The worker's
   *  `normalizePorts` THROWS `diagnostic_port_not_allowed` on the first one that
   *  is not — it does not drop it — so naming an unlistable port turns a probe
   *  that would have answered `null` (nobody asked) into a 400 the caller must
   *  render as a failure. See `isProbeAnswerablePort`. */
  ports?: ReadonlyArray<number>;
  /** Checks to run. Omitted → `DEFAULT_DIAGNOSTIC_CHECKS`. Each check is gated
   *  independently in the worker (`target.checks.includes(...)`), so a caller
   *  that reads one payload kind pays for one. `acme_challenge` is appended by
   *  the token, not by this list — the two are independent. */
  checks?: ReadonlyArray<DiagnosticKind>;
  /** D-272 — ONE port outside `DIAGNOSTIC_ALLOWED_PORTS`, for the caller asking
   *  about its own LAN listener (`bind_port` is user-configurable, so it can
   *  never be allowlisted).
   *
   *  ⚠ Use this rather than `ports` for such a port: `ports` is closed-list and
   *  rejects the whole request. `isProbeAnswerablePort` is the predicate for
   *  `ports`; `isProbeAskableExtraPort` is the one for this. */
  extra_port?: number;
}

/** Whether the probe may be asked about this port through `extra_port`.
 *
 *  ⛔ A DIFFERENT QUESTION FROM `isProbeAnswerablePort`, and the two must not be
 *  swapped: that one asks "is this on the closed list", this one asks "is this
 *  inside the one bounded door past it". A LAN port like 7717 fails the first
 *  and passes the second — which is exactly why the door exists. */
export const isProbeAskableExtraPort = (port: number): boolean =>
  isDiagnosticExtraPort(port);

/** Whether the cloud probe is allowed to be ASKED about this port at all.
 *
 *  ⛔ NOT "is it open" — that is `diagnosticPortReachability`. This is the prior
 *  question, and it has to be asked BEFORE narrowing a request to a single port:
 *  a `public_port` the owner moved to, say, 8443 is outside the worker's
 *  allowlist, and a request naming it is rejected whole.
 *
 *  ⇒ A caller that cannot ask must not offer to. Leaving the verdict `null`
 *  (unknown) is right; showing a button that spends 5s and comes back with
 *  "try again in a minute" about a port that will never be answerable is the
 *  "opens then stops" failure in a new place. */
export const isProbeAnswerablePort = (port: number): boolean =>
  isDiagnosticAllowedPort(port);

export const buildReachabilityDiagnosticRequest = (
  target: ReachabilityDiagnosticTarget,
): DiagnosticRequest => {
  const baseChecks = target.checks ?? DEFAULT_DIAGNOSTIC_CHECKS;
  const request: DiagnosticRequest = {
    account_id: target.account_id,
    hostname: target.hostname,
    // ⚠ The ACME check follows the TOKEN, not the check list — a caller that
    // names its own checks and also carries a token still gets it, and a caller
    // that names it twice does not send it twice.
    checks:
      target.acme_challenge_token !== undefined
      && !baseChecks.includes('acme_challenge')
        ? [...baseChecks, 'acme_challenge']
        : [...baseChecks],
    ports: [...(target.ports ?? HOSTNAME_LISTENER_PORTS)],
  };
  // ⚠ Sent as its own field, never merged into `ports` here. The worker folds
  // the two after validating each by its own rule; merging client-side would
  // push an off-list port through the closed-list check and fail the request.
  if (target.extra_port !== undefined) {
    request.extra_port = target.extra_port;
  }
  if (target.expected_public_ip !== undefined) {
    request.expected_public_ip = target.expected_public_ip;
  }
  if (target.acme_challenge_token !== undefined) {
    request.acme_challenge_token = target.acme_challenge_token;
  }
  if (target.ownership_probe_method !== undefined) {
    request.ownership_probe_method = target.ownership_probe_method;
  }
  return request;
};

export type ReachabilityExternalProbeTargetOverride =
  Partial<Omit<ReachabilityDiagnosticTarget, 'account_id'>>;

export type ReachabilityExternalProbeCaller = (
  override?: ReachabilityExternalProbeTargetOverride,
) => Promise<DiagnosticResponse>;

export interface CreateReachabilityDiagnosticProbeCallerOptions {
  resolveTarget: () => Promise<ReachabilityDiagnosticTarget>;
  fetcher?: FetchLike;
  baseUrl?: string;
}

export const createReachabilityDiagnosticProbeCaller = (
  opts: CreateReachabilityDiagnosticProbeCallerOptions,
): ReachabilityExternalProbeCaller =>
  async (override) => {
    const fetcher = opts.fetcher ?? defaultFetch;
    const baseTarget = await opts.resolveTarget();
    const target: ReachabilityDiagnosticTarget = {
      ...baseTarget,
      ...override,
    };
    const request = buildReachabilityDiagnosticRequest(target);
    const res = await fetcher(
      diagnosticProbeUrl(opts.baseUrl ?? DEFAULT_DIAGNOSTIC_API_BASE_URL),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(apiErrorMessage(body, res.status));
    }
    return readApiData<DiagnosticResponse>(body);
  };

/** Tri-state read of ONE port's probe outcome, for a caller that must tell
 *  "checked, refused" from "nobody checked".
 *
 *  ⛔ `null` IS NOT `false`. `diagnosticResponseHasReachablePort` below answers a
 *  different question — "may I show this URL" — where both of those collapse to
 *  no. A checklist cannot collapse them: an unticked box claims the router was
 *  looked at and found shut, and nothing looked.
 *
 *  ⚠ A PORT THE PROBE NEVER CARRIES IS ALWAYS `null`, by construction — and
 *  there are now TWO ways to not carry one. The request names ports (defaulting
 *  to `HOSTNAME_LISTENER_PORTS`, narrowed by callers that read one), and the
 *  worker allows only `DIAGNOSTIC_ALLOWED_PORTS` on top of that. So 7717 has no
 *  answer here and reads as unknown rather than as shut, which is the honest
 *  result: 7717 is the local port, and the question "is it open to the public"
 *  is not asked of it.
 *
 *  ⛔ NARROWING A CALLER'S REQUEST MUST NOT TURN ANOTHER PORT'S `null` INTO A
 *  `false`. It cannot, because this fold sets `checked` only from a result that
 *  NAMES the port — an absent port never reaches the `false` return. A fold
 *  written as `.some(...) === false` over the response would have. */
export const diagnosticPortReachability = (
  response: DiagnosticResponse | null | undefined,
  port: number,
): boolean | null => {
  if (response === null || response === undefined) return null;
  let checked = false;
  for (const result of response.results) {
    if (result.payload.kind !== 'port_reachability') continue;
    if (result.payload.port !== port) continue;
    checked = true;
    if (result.payload.outcome === 'reachable') return true;
  }
  // `blocked` and `no_response` are both "it did not get in" to a reader who is
  // deciding whether to go and change a router setting.
  return checked ? false : null;
};

export const diagnosticResponseHasReachablePort = (
  response: DiagnosticResponse,
  port: number,
): boolean =>
  response.results.some((result) =>
    result.kind === 'port_reachability'
    && result.status === 'pass'
    && result.payload.kind === 'port_reachability'
    && result.payload.port === port
    && result.payload.outcome === 'reachable',
  );

export const diagnosticResponseHasHostnameMatchedTls = (
  response: DiagnosticResponse,
): boolean =>
  response.results.some((result) =>
    result.kind === 'tls_handshake'
    && result.status === 'pass'
    && result.payload.kind === 'tls_handshake'
    && result.payload.cert_valid
    && result.payload.cert_matches_hostname,
  );

export const diagnosticResponseShowsReachableUrl = (
  response: DiagnosticResponse | null | undefined,
  hostname: string,
  port: number,
): boolean => {
  if (response === null || response === undefined) return false;
  if (response.hostname !== hostname) return false;
  if (!diagnosticResponseHasReachablePort(response, port)) return false;
  return port === 443 ? diagnosticResponseHasHostnameMatchedTls(response) : true;
};

/** D-272 — can THIS browser, on THIS network, reach `url`?
 *
 *  🔑 THE ONLY INSTRUMENT THAT CAN SEE NAT HAIRPIN. Everything else on this page
 *  asks the cloud, which is on the wrong side of the router: it reports the port
 *  reachable while the phone in the kitchen fails. This runs where the phone is.
 *
 *  ⚠⚠ MEASURED IN REAL CHROMIUM, 2026-09-16 — the numbers this design rests on,
 *  recorded here because the next reader will otherwise re-reason them from the
 *  spec and get the 404 case wrong:
 *
 *  | target (cross-origin, strict TLS) | result |
 *  |:--|:--|
 *  | 200 / 404 / 500                   | **RESOLVED**, `type: 'opaque'`, `status: 0` |
 *  | trusted cert (real CA)            | **RESOLVED** |
 *  | untrusted cert (self-signed)      | REJECTED `TypeError: Failed to fetch` |
 *  | connection refused                | REJECTED `TypeError` (0 ms) |
 *  | DNS failure                       | REJECTED `TypeError` (~1.2 s) |
 *  | blackholed / DROP                 | never settles — only the abort ends it |
 *
 *  ⇒ **`true` IS A STRONG POSITIVE**: DNS resolved, TCP connected, TLS verified
 *  against a TRUSTED certificate, and an HTTP response came back. That is the
 *  hairpin question, because hairpin failure is a connection-level failure.
 *
 *  ⛔ **`false` NAMES NO CAUSE, AND MUST NOT.** Every rejection is the same
 *  `TypeError`; TLS, refused and DNS are indistinguishable. Timing separates
 *  them a little (0 ms / 1.2 s / the full timeout) and that is NOT built on — it
 *  is environment-dependent, and inventing a router diagnosis from a network
 *  error on this side of the router is the mistake this whole decision keeps
 *  naming.
 *
 *  ⛔ **AND `true` DOES NOT MEAN THE APP IS SERVED THERE.** Opaque hides the
 *  status, so a public 404 resolves exactly like a 200 — and `webclient` is
 *  `{ lan: true, public: false }` by default. Separable on purpose: whether the
 *  path is exposed is locally knowable from the exposure grid; this answers only
 *  whether the address answers at all.
 *
 *  ⚠ The abort is load-bearing. A router that DROPs never sends anything back,
 *  so without it the promise hangs for the browser's own connect timeout.
 *  ⚠ `no-cors` keeps this a plain unauthenticated GET with no preflight and no
 *  credentials — the server needs no CORS header, and none of the paths that
 *  have one (only `/auth/pair`, a POST auth surface) are touched. */
export const ADDRESS_HERE_TIMEOUT_MS = 5000;

export const createAddressReachableFromHereCheck = (
  opts: { fetcher?: FetchLike; timeoutMs?: number } = {},
): ((url: string) => Promise<boolean>) =>
  async (url) => {
    const fetcher = opts.fetcher ?? defaultFetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => { controller.abort(); },
      opts.timeoutMs ?? ADDRESS_HERE_TIMEOUT_MS,
    );
    try {
      await fetcher(url, {
        // ⚠ Every one of these matters. `no-cors` so an ordinary server with no
        // CORS header still answers; `omit` so this can never carry a bearer;
        // `no-store` so a cached hit cannot report reachability that is minutes
        // old — the whole point is "right now".
        mode: 'no-cors',
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
      });
      return true;
    } catch {
      // ⛔ EVERY failure lands here and they are not distinguishable. The caller
      // renders "did not reach", never a reason.
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

export const statusLabel = (status: DiagnosticResult['status']): string =>
  status === 'pass' ? 'Pass' : status === 'warn' ? 'Warn' : 'Fail';

export const formatDiagnosticKind = (kind: DiagnosticKind): string =>
  kind
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');

export const formatDiagnosticPayload = (result: DiagnosticResult): string => {
  const payload = result.payload;
  switch (payload.kind) {
    case 'detected_public_ip':
      return payload.ip
        ? `${payload.ip}${payload.ip_version ? ` (IPv${payload.ip_version})` : ''}`
        : 'Recued saw no public address';
    case 'port_reachability':
      return `Port ${payload.port}: ${payload.outcome}${
        payload.latency_ms !== undefined ? ` (${payload.latency_ms} ms)` : ''
      }`;
    case 'dns_resolution':
      return `${payload.resolved_ips.length > 0 ? payload.resolved_ips.join(', ') : 'No records'}; ${
        payload.matches_expected_ip ? 'matches the address Recued expected' : 'does not match the address Recued expected'
      }`;
    case 'tls_handshake':
      return `cert ${
        payload.cert_valid ? 'valid' : 'invalid'
      }, hostname ${payload.cert_matches_hostname ? 'matches' : 'mismatch'}${
        payload.cert_issuer ? `, ${payload.cert_issuer}` : ''
      }`;
    case 'acme_challenge':
      return `HTTP-01 ${payload.well_known_reachable ? 'reachable' : 'unreachable'}${
        payload.status_code !== undefined ? ` (${payload.status_code})` : ''
      }`;
    case 'nat_class':
      return payload.class;
  }
};
