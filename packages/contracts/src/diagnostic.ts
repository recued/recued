/** D-152 P1 - free diagnostic suite contracts.
 *
 * The cloud worker probes only hostnames already authorized by the user's
 * hostname registry or an active pending-verification row. These contracts keep
 * the payloads closed-list and secret-free; worker policy enforces ownership,
 * private-IP deny, port allowlisting, rebinding checks, and rate limits.
 */

import { HOSTNAME_LISTENER_PORTS } from './hostname.js';

export const DIAGNOSTIC_KINDS = [
  'detected_public_ip',
  'port_reachability',
  'dns_resolution',
  'tls_handshake',
  'acme_challenge',
  'nat_class',
] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

export const DIAGNOSTIC_STATUSES = ['pass', 'warn', 'fail'] as const;
export type DiagnosticStatus = (typeof DIAGNOSTIC_STATUSES)[number];

export const DIAGNOSTIC_PORT_OUTCOMES = [
  'reachable',
  'blocked',
  'no_response',
] as const;
export type DiagnosticPortOutcome = (typeof DIAGNOSTIC_PORT_OUTCOMES)[number];

export const DIAGNOSTIC_NAT_CLASSES = [
  'direct',
  'full_cone_nat',
  'restricted_nat',
  'port_restricted_nat',
  'symmetric_nat',
  'cgnat',
  'firewalled',
] as const;
export type DiagnosticNatClass = (typeof DIAGNOSTIC_NAT_CLASSES)[number];

export const DIAGNOSTIC_OWNERSHIP_PROOF_METHODS = [
  'http_token',
  'dns_txt',
] as const;
export type DiagnosticOwnershipProofMethod =
  (typeof DIAGNOSTIC_OWNERSHIP_PROOF_METHODS)[number];

/** D-152 A.5.1 - D-148 closed listener ports plus HTTP-01 port 80. */
export const DIAGNOSTIC_ALLOWED_PORTS = [
  80,
  ...HOSTNAME_LISTENER_PORTS,
] as const;
export type DiagnosticAllowedPort = (typeof DIAGNOSTIC_ALLOWED_PORTS)[number];

export const DIAGNOSTIC_ACCOUNT_RATE_LIMIT_PER_HOUR = 100;
export const DIAGNOSTIC_TARGET_RATE_LIMIT_PER_MINUTE = 10;

export interface DiagnosticRequest {
  /** Cloud account id. Used for per-account and per-target rate limiting. */
  account_id: string;
  /** MUST be authorized by hostname registry or active pending verification. */
  hostname: string;
  checks: ReadonlyArray<DiagnosticKind>;
  /** Ports for `port_reachability`. Defaults to D-148 public listener ports.
   *  Closed-list: every entry must be in `DIAGNOSTIC_ALLOWED_PORTS` or the
   *  request is rejected WHOLE (`normalizePorts` throws rather than filtering). */
  ports?: ReadonlyArray<number>;
  /** D-272 — ONE additional port, outside the allowlist, chosen by the caller.
   *
   *  🔑 WHY IT HAS TO EXIST. The server's own LAN listener port (`bind_port`,
   *  default 7717) is user-configurable, so it can never be on a closed list —
   *  and "is my LAN listener reachable from the internet" is a real question:
   *  `resolveLanAddress` binds the `0.0.0.0` wildcard for the ordinary host,
   *  there is no source-address filter, and that listener is PLAINTEXT.
   *
   *  ⛔ NAMED FOR WHAT THE WORKER CAN KNOW, WHICH IS "one more port". It is
   *  NOT called `lan_port` or `listener_port`: the worker cannot verify that
   *  anything listens there, and a name asserting what the receiver cannot
   *  check is the exact failure this decision has been chasing.
   *
   *  ⚠ THE CAP IS THE POINT, AND IT IS STRUCTURAL. A scalar, not an array —
   *  so widening the allowlist adds at most ONE probe per request rather than
   *  turning `ports` into a sweep. Combined with the existing limits (100/hour
   *  per source IP, 10/minute per target, and a production authorizer that
   *  accepts only `<handle>.recued.cloud`) the reachable scan rate rises from
   *  ~500 to ~600 port-probes/hour against a host the caller has proven a
   *  claim to. That is the whole of the security cost, stated so it can be
   *  disagreed with.
   *
   *  ⚠ RANGE-BOUND TO 1024-65535, which is not arbitrary: binding below 1024
   *  needs privileges, so a self-hosted listener is essentially always above
   *  it — and the bound excludes 22 / 25 / 110 / 143 / 445 / 465 / 587 / 993 /
   *  995 for free. 80 and 443 need no exception; they are already allowlisted. */
  extra_port?: number;
  /** Optional expected IP for DNS matching. Defaults to the observed public IP. */
  expected_public_ip?: string;
  /** Optional ACME HTTP-01 token to fetch under `/.well-known/acme-challenge/`. */
  acme_challenge_token?: string;
  /** Optional BYO ownership proof observation. The worker returns only the
   * observed token hash, never the raw token content. */
  ownership_probe_method?: DiagnosticOwnershipProofMethod;
}

export type DiagnosticPayload =
  | { kind: 'detected_public_ip'; ip: string | null; ip_version: 4 | 6 | null }
  | {
      kind: 'port_reachability';
      port: number;
      outcome: DiagnosticPortOutcome;
      latency_ms?: number;
    }
  | {
      kind: 'dns_resolution';
      resolved_ips: ReadonlyArray<string>;
      matches_expected_ip: boolean;
    }
  | {
      kind: 'tls_handshake';
      cert_valid: boolean;
      cert_matches_hostname: boolean;
      cert_expires_at: number | null;
      cert_issuer: string | null;
    }
  | {
      kind: 'acme_challenge';
      well_known_reachable: boolean;
      status_code?: number;
    }
  | { kind: 'nat_class'; class: DiagnosticNatClass };

export interface DiagnosticResult {
  kind: DiagnosticKind;
  status: DiagnosticStatus;
  payload: DiagnosticPayload;
  remediation_hint?: string;
}

export interface DiagnosticResponse {
  account_id: string;
  hostname: string;
  detected_public_ip: string | null;
  resolved_ips: ReadonlyArray<string>;
  results: ReadonlyArray<DiagnosticResult>;
  /** Present only when `ownership_probe_method` was requested and the worker
   * observed token material it could hash. */
  observed_token_hash?: string;
  probed_at: number;
}

export type DiagnosticErrorCode =
  | 'diagnostic_validation_error'
  | 'diagnostic_hostname_invalid'
  | 'diagnostic_target_unauthorized'
  | 'diagnostic_private_ip_denied'
  | 'diagnostic_port_not_allowed'
  | 'diagnostic_dns_rebinding'
  | 'diagnostic_rate_limited';

export const isDiagnosticKind = (value: unknown): value is DiagnosticKind =>
  typeof value === 'string'
  && (DIAGNOSTIC_KINDS as readonly string[]).includes(value);

/** D-272 — the bound on `DiagnosticRequest.extra_port`. Unprivileged range
 *  only; see that field for why the cap and the range are the security story. */
export const DIAGNOSTIC_EXTRA_PORT_MIN = 1024;
export const DIAGNOSTIC_EXTRA_PORT_MAX = 65535;

export const isDiagnosticExtraPort = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= DIAGNOSTIC_EXTRA_PORT_MIN
  && value <= DIAGNOSTIC_EXTRA_PORT_MAX;

export const isDiagnosticAllowedPort = (value: unknown): value is DiagnosticAllowedPort =>
  typeof value === 'number'
  && Number.isInteger(value)
  && (DIAGNOSTIC_ALLOWED_PORTS as readonly number[]).includes(value);

export const isDiagnosticOwnershipProofMethod = (
  value: unknown,
): value is DiagnosticOwnershipProofMethod =>
  typeof value === 'string'
  && (DIAGNOSTIC_OWNERSHIP_PROOF_METHODS as readonly string[]).includes(value);
