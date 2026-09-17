/** D-148 § A.10 — the reachability CHECKS. Not a report.
 *
 *  ⛔ THE REPORT FAMILY IS GONE (2026-09-16). This file used to carry
 *  `ReachabilityReport` and its ten sub-blocks — a whole-network snapshot the
 *  server built about itself, wired to nothing for as long as it existed. It was
 *  deleted along with its builder (`backend/server/src/diagnostics/
 *  reachability.ts`) when the standalone Reachability panel folded into
 *  Settings → Server → Connect a device. ⇒ DO NOT RE-ADD A SNAPSHOT TYPE HERE:
 *  a machine cannot testify to its own reachability, so the answer comes from
 *  the OUTSIDE — the cloud probe worker — one check at a time.
 *
 *  What lives here is that outside-in surface and nothing else: the
 *  `CloudProbe*` request / response pair spoken to `probe.recued.com`, the
 *  `ProbeTarget*` shapes, and the rate-limit constants.
 *
 *  ⚠ THE RECOMMENDATION VOCABULARY WENT TOO, one round later — see the block
 *  below, which is all that is left of it.
 */

import type { PathRole } from './network.js';

/** ⛔⛔ THE RECOMMENDATION VOCABULARY WAS DELETED HERE (2026-09-16), AND IT IS
 *  NOT COMING BACK IN THIS SHAPE. `ReachabilityRecommendationCode` (14 codes),
 *  `REACHABILITY_RECOMMENDATION_CODES`, `ReachabilityRecommendation` and
 *  `ReachabilityPerDomainTlsEntry` lived here from D-148 P1, were widened by
 *  D-149 P1 and again by D-148 FU2 — and had exactly ONE emitter for their whole
 *  life (`diagnostics/per-domain-tls-health.ts`'s rollup) feeding exactly ONE
 *  consumer (`buildReachabilityReport`) that nothing in production ever called.
 *  The report went 2026-09-16; the rollup went with it; these had no producer
 *  left, only two ratchet tests asserting the list's own contents.
 *
 *  🔑 A CLOSED LIST WITH NO PRODUCER IS NOT INERT — IT READS AS A SHIPPED
 *  CONTRACT. D-149 P1's own comment here said it "ships the closed list so the
 *  contract is the single source of truth", with the emission logic to follow in
 *  P3. P3 never came. Three codes sat in a published vocabulary for months
 *  describing checks nothing performs, and the next reader to plan reception
 *  diagnostics would have found a surface and assumed a substrate.
 *
 *  ⇒ THE FACTS SURVIVED; THE VOCABULARY DID NOT. The two health bits this
 *  carried (`chain_valid`, `fingerprint_matches`) are now read by `recued
 *  doctor`, in `DoctorCheck`'s vocabulary, which has a renderer. A diagnostic
 *  needs one severity vocabulary, not two, and the one that survives is the one
 *  someone can see. */

/** D-148 § A.5.5 — cloud-probe request shape. Sent server → cloud
 *  Worker. No auth required (free-tier reachability is open).
 *
 *  D-176 Phase 5 (Slice B2): the per-port dimension is now the ONLY shape.
 *  The 2026-05-11 amendment that collapsed to 443-only `paths` is fully
 *  retired (CLI→MCP wrap means solo ops serve on arbitrary ports), along with
 *  the legacy `per_path` / `ProbePerPathResult` / `PathProber`. Pre-launch, no
 *  runtime compat shim. */
export interface CloudProbeRequest {
  hostname: string;
  /** D-176 port-shaped targets. Each is an explicit (port, transport) the
   *  caller declares for *their own* server — never a range (no scanning). */
  targets?: ReadonlyArray<ProbeTarget>;
  /** Optional client-supplied report id for correlation. */
  report_id?: string;
}

/** D-148 § A.5.5 — cloud-probe response shape. Spec § A.10 reachability
 *  doctor merges these into the doctor's report. */
export interface CloudProbeResponse {
  hostname: string;
  resolved_ip: string | null;
  /** D-176 port-shaped results, one per requested target (empty when the
   *  request declared no targets). */
  per_target: ProbeTargetResult[];
  /** Human-readable remediation hints. */
  recommendations: string[];
  probed_at: number;
}

/** D-176 — probe transport for a port. `tcp` = raw connect (port open +
 *  NAT/firewall-forwarded); `tls` = connect + TLS handshake; `http` = request
 *  + cert/path validation. `connect()` reaches arbitrary public ports; the
 *  Workers platform blocks port 25 / localhost / private IPs / CF ranges. */
export type ProbeTargetKind = 'tcp' | 'tls' | 'http';

/** D-176 — a single (port, transport) the caller asks Recued to verify is
 *  reachable from outside. `role` is an optional hint (e.g. `mcp`). */
export interface ProbeTarget {
  port: number;
  kind: ProbeTargetKind;
  /** Path for an `http` target with no `role` (roled targets resolve their
   *  path via `PATH_FOR_ROLE`). Ignored for `tcp`/`tls`. */
  path?: string;
  role?: PathRole;
}

/** D-176 — per-target reachability + (for tls/http) TLS validation result. */
export interface ProbeTargetResult {
  port: number;
  kind: ProbeTargetKind;
  /** Echoed back from the requested target's `role` hint, when present, so a
   *  consumer (the server-side Reachability Doctor) can map a result back to
   *  the `PathRole` it asked about without re-deriving it from the port. */
  role?: PathRole;
  reachable: boolean;
  /** TLS fields are present only for `tls`/`http` targets — omitted for `tcp`
   *  so "not applicable" stays distinct from a failed TLS validation. */
  tls_valid?: boolean;
  cert_fingerprint?: string | null;
  cert_expires_at?: number | null;
  handshake_ms: number;
  last_error?: string;
}

/** D-148 § A.5.5 / spec line 2058 — cloud-side rate limit for free
 *  reachability probes. Per SOURCE IP, per hour. Shared between the cloud
 *  Worker (P5) and the doctor client-side throttling hint (P6). */
export const FREE_REACHABILITY_PROBE_RATE_LIMIT_PER_HOUR = 60;

/** D-176 Phase 5 § 5 — per (resolved target-IP, port) reachability-probe
 *  rate limit, per minute. Keyed on the RESOLVED target IP + port (not the
 *  hostname), so rotating many hostnames that resolve to one victim IP share
 *  one bucket — this is what stops the arbitrary-port `connect()` probe from
 *  being driven as a port scanner of a single host. Complements (does not
 *  replace) the per-source-IP hourly cap above; both fire independently. */
export const FREE_REACHABILITY_TARGET_RATE_LIMIT_PER_MINUTE = 30;
