/** D-148 § A.10 — Reachability Doctor.
 *
 *  Self-service diagnostic that renders the resolved network state
 *  of the user's server: NAT topology, DDNS resolution, cert health,
 *  per-port handshake results, per-vendor webhook health, paired
 *  bridge / webclient state, and a closed-list recommendation feed.
 *
 *  P1 ships the contract; P5 wires the cloud-probe Worker; P6 wires
 *  the server-side doctor + Settings → Server → Reachability page.
 */

import type { PathRole, TLSDomainCertSource } from './network.js';
import type { BridgeCapabilityProfile } from './bridge.js';
export type { BridgeCapabilityProfile } from './bridge.js';

/** D-148 § A.10 + D-149 § A.8 + D-148 FU2 — closed list of
 *  recommendation codes the doctor emits. Each code maps to a
 *  remediation hint surfaced in the UI. Add a code only with a
 *  corresponding remediation entry.
 *
 *  D-149 P1 widens the closed list with three Reception-port codes
 *  per § A.8: `reception_listener_silent` (port listening but no
 *  traffic in N days), `reception_endpoint_unreachable` (synthetic
 *  probe failed for at least one enabled endpoint), and
 *  `reception_cert_san_missing_hostname` (cert SAN doesn't cover the
 *  Reception port's hostname). The doctor's per-emission logic for
 *  these three codes lands in P3 alongside the registry that knows
 *  which endpoints are enabled; P1 ships the closed list so the
 *  contract is the single source of truth.
 *
 *  D-148 FU2 widens with `tls_chain_invalid_for_domain` — emitted
 *  per-row when a `TLSDomainStore.list()` entry's leaf+chain stops
 *  terminating at a system trust root (intermediate CA expired, OS
 *  trust store update, etc.). The existing `tls_renewal_overdue` /
 *  `tls_renewal_imminent` / `cert_fingerprint_mismatch` codes are
 *  REUSED for per-domain emissions (spec § A.6.3 line 885: the codes
 *  key on domain, not on a single cert); the doctor's message
 *  carries the domain. */
export type ReachabilityRecommendationCode =
  | 'tls_renewal_overdue'
  | 'tls_renewal_imminent'
  | 'ddns_ip_mismatch'
  | 'webhook_inbound_silent'
  | 'webhook_hmac_failure'
  | 'bridge_offline'
  | 'cert_fingerprint_mismatch'
  | 'path_unreachable_from_cloud'
  | 'nat_traversal_required'
  | 'exposure_resolution_inconsistent'
  | 'reception_listener_silent'
  | 'reception_endpoint_unreachable'
  | 'reception_cert_san_missing_hostname'
  | 'tls_chain_invalid_for_domain';

export const REACHABILITY_RECOMMENDATION_CODES: ReadonlyArray<ReachabilityRecommendationCode> = [
  'tls_renewal_overdue',
  'tls_renewal_imminent',
  'ddns_ip_mismatch',
  'webhook_inbound_silent',
  'webhook_hmac_failure',
  'bridge_offline',
  'cert_fingerprint_mismatch',
  'path_unreachable_from_cloud',
  'nat_traversal_required',
  'exposure_resolution_inconsistent',
  'reception_listener_silent',
  'reception_endpoint_unreachable',
  'reception_cert_san_missing_hostname',
  'tls_chain_invalid_for_domain',
] as const;

export interface ReachabilityNetworkBlock {
  public_ipv4?: string;
  public_ipv6?: string;
  /** How the public IP was determined. `cloud_probe` means the cloud
   *  Worker reported it; `stun` means a STUN bind; `manual` means
   *  user supplied it. */
  detected_via: 'stun' | 'cloud_probe' | 'manual';
  behind_nat: boolean;
  upnp_status?: 'enabled' | 'disabled' | 'unsupported';
}

export interface ReachabilityDnsBlock {
  handle?: string;
  ddns_resolves: boolean;
  resolved_to_expected_ip: boolean;
  resolution_ms: number;
  last_ddns_update: number;
}

export interface ReachabilityTlsBlock {
  cert_fingerprint: string;
  expires_at: number;
  days_until_expiry: number;
  issuer: string;
  san: string[];
  valid_for_handle: boolean;
  renewal_overdue: boolean;
}

export interface ReachabilityHandshakeTest {
  passed: boolean;
  ms: number;
  error?: string;
}

/** D-149 § A.8 — Reception-specific reachability fields. Populated
 *  only on the `reception` per-port row; undefined for the WS /
 *  webhook / MCP roles. The `last_endpoint_health_check` summarises
 *  the synthetic per-endpoint probe outcome (P3 wires the actual
 *  probe; P1 ships the contract). */
export interface ReachabilityReceptionSpecific {
  /** Count of currently enabled Reception endpoints. */
  enabled_endpoint_count: number;
  /** Aggregate of synthetic per-endpoint probe outcomes:
   *  - `'all_passed'` — every enabled endpoint responded as expected.
   *  - `'some_failed'` — at least one enabled endpoint's synthetic
   *    probe failed (raises `reception_endpoint_unreachable`).
   *  - `'not_run'` — no synthetic probe attempted (LAN-only deploy
   *    or doctor invoked without external probe). */
  last_endpoint_health_check: 'all_passed' | 'some_failed' | 'not_run';
  /** True iff the cert SAN list covers the Reception port's
   *  hostname. False raises `reception_cert_san_missing_hostname`. */
  cert_san_includes_reception_hostname: boolean;
}

/** D-148 § A.10 — per-path reachability entry (Amendment 2026-05-11;
 *  supersedes per-port). One row per `PathRole`. The doctor reports
 *  per-path listening + per-listener (lan/public) reachability +
 *  handshake outcome. */
export interface ReachabilityPathEntry {
  role: PathRole;
  /** True iff the path serves on the LAN listener (port 80 plain
   *  HTTP) under the current resolution. */
  lan_listening: boolean;
  /** True iff the path serves on the public listener (port 443 TLS)
   *  under the current resolution. */
  public_listening: boolean;
  /** Set when external cloud probe attempted against the public
   *  listener for this path; absent when LAN-only. */
  cloud_probe_reachable?: boolean;
  last_inbound_at?: number;
  handshake_test: ReachabilityHandshakeTest;
  /** D-149 § A.8 — Reception-specific reachability summary. Populated
   *  only when `role === 'reception'`; undefined for the other roles. */
  reception_specific?: ReachabilityReceptionSpecific;
}

export interface ReachabilityHmacTest {
  passed: boolean;
  error?: string;
}

export interface ReachabilityWebhookEntry {
  integration: string;
  configured: boolean;
  last_inbound_at?: number;
  last_failed_at?: number;
  hmac_test: ReachabilityHmacTest;
}

export interface ReachabilityBridgeEntry {
  client_label?: string;
  online: boolean;
  last_seen_at: number;
  capabilities: BridgeCapabilityProfile;
}

export interface ReachabilityWebclientEntry {
  client_label?: string;
  online: boolean;
  last_seen_at: number;
}

export interface ReachabilityRecommendation {
  severity: 'info' | 'warning' | 'error';
  code: ReachabilityRecommendationCode;
  message: string;
  remediation?: string;
}

/** D-148 FU2 — per-domain TLS health entry. One row per
 *  `TLSDomainStore.list()` entry, with the standard cert metadata
 *  plus two health bits the Reachability Doctor verifies at report
 *  time: `chain_valid` (leaf+chain still terminate at a system trust
 *  root) and `fingerprint_matches` (stored `fingerprint` field matches
 *  hash(cert_pem) — row-tamper detection). Emits up to four
 *  per-domain recommendations: `tls_renewal_overdue` /
 *  `tls_renewal_imminent` (expiry windows; codes reused from the
 *  single-cert path); `cert_fingerprint_mismatch` (stored row vs
 *  computed cert mismatch; code reused from the MITM detection path);
 *  `tls_chain_invalid_for_domain` (new FU2 code). */
export interface ReachabilityPerDomainTlsEntry {
  domain: string;
  /** SHA-256 hex of the leaf cert as stored (lowercase, no separators). */
  fingerprint: string;
  /** Unix-ms; from the cert's notAfter. */
  expires_at: number;
  /** Days remaining until expiry at health-check time. Negative when
   *  already expired. */
  days_until_expiry: number;
  /** Issuer common-name from the leaf cert. */
  issuer: string;
  /** Cert source — `pro_acme` (auto-renewed) or `byo_upload` (user-
   *  managed). Drives the remediation copy. */
  source: TLSDomainCertSource;
  /** True iff the leaf + chain still verify against the system trust
   *  store at health-check time. False raises
   *  `tls_chain_invalid_for_domain`. */
  chain_valid: boolean;
  /** True iff `hash(cert_pem)` matches the stored fingerprint. False
   *  raises `cert_fingerprint_mismatch` for this domain (row-tamper
   *  detection — distinct from the MITM detection's
   *  `cert_fingerprint_mismatch` which compares cloud-probe to local). */
  fingerprint_matches: boolean;
  /** Unix-ms of last successful renewal — `pro_acme` rows only. */
  last_renewed_at?: number;
}

export interface ReachabilityReport {
  report_id: string;
  generated_at: number;
  server_passport_fingerprint: string;
  network: ReachabilityNetworkBlock;
  dns: ReachabilityDnsBlock;
  tls: ReachabilityTlsBlock;
  /** D-148 FU2 — per-domain TLS health rollup from
   *  `TLSDomainStore.list()`. Optional: present only when the server
   *  has BYO / pro_acme per-domain certs configured. The single-cert
   *  `tls` block above remains the primary cert (server identity);
   *  this array carries additional per-domain certs that serve via
   *  SNI dispatch on the public listener. */
  per_domain_tls?: ReachabilityPerDomainTlsEntry[];
  per_path: ReachabilityPathEntry[];
  webhooks: ReachabilityWebhookEntry[];
  bridges: ReachabilityBridgeEntry[];
  webclients: ReachabilityWebclientEntry[];
  recommendations: ReachabilityRecommendation[];
}

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
