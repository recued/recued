/** D-148 FU2 — per-domain TLS health rollup for the Reachability
 *  Doctor.
 *
 *  Walks pre-verified per-domain rows + emits one
 *  `ReachabilityPerDomainTlsEntry` per domain plus up to four
 *  recommendations:
 *
 *    - `tls_renewal_overdue` — expiry <= 7d (existing closed-list
 *      code; reused per spec § A.6.3 line 885: "code keys on domain,
 *      not on a single cert"; message carries the domain).
 *    - `tls_renewal_imminent` — 7d < expiry <= 14d (existing code,
 *      same per-domain reuse).
 *    - `cert_fingerprint_mismatch` — `hash(cert_pem)` ≠ stored
 *      `fingerprint` field (row-tamper detection; reuses the
 *      MITM-detection code with a per-domain message).
 *    - `tls_chain_invalid_for_domain` — new FU2 code; emitted when
 *      the leaf + chain stop terminating at a system trust root
 *      (intermediate CA expired, OS trust store update, etc.).
 *
 *  Discipline mirrors the existing reachability doctor: the
 *  substrate is PURE assembly (no IO, no system trust store access).
 *  Callers (eventually bin.ts after the doctor rpc wires) construct
 *  `PerDomainTlsHealthInput[]` from store rows via the
 *  `verifyDomainHealth` helper, which is where verifier seam +
 *  fingerprint helper are called — separating the two preserves the
 *  "doctor is pure assembly" invariant from § A.10.
 *
 *  Window constants — same shared values as the single-cert path
 *  (re-exported from `./reachability.ts`). Per-domain emissions
 *  match the spec § A.6.3 line 872 wording: "30 / 14 / 7 day
 *  windows"; today's substrate emits at 14 / 7, matching the
 *  existing path. A future spec amendment can add the 30-day info
 *  band without contract churn (just a new severity tier). */

import type {
  ReachabilityPerDomainTlsEntry,
  ReachabilityRecommendation,
  TLSDomainCertSource,
} from '@recued/contracts';

/** Pre-verified per-domain row. Caller has already applied the
 *  verifier seam (chain verification) + computed the fingerprint;
 *  this substrate just maps to entries + recommendations. */
export interface PerDomainTlsHealthInput {
  domain: string;
  fingerprint: string;
  expires_at: number;
  issuer: string;
  source: TLSDomainCertSource;
  chain_valid: boolean;
  fingerprint_matches: boolean;
  last_renewed_at?: number;
}

/** Verifier seam — production caller wires
 *  `verifyChain` from `../tls/cert-verifiers.ts` +
 *  `computeCertFingerprint` from `@recued/server-tls`. Tests stub
 *  with deterministic outputs so the substrate test never depends
 *  on the system trust store.
 *
 *  `accept_self_signed` mirrors the store's `acceptSelfSigned`
 *  constructor option (Codex FU2 P2 #1 fold). When the store
 *  accepted a self-signed BYO cert at upload, re-verifying with
 *  `false` would surface a phantom `tls_chain_invalid_for_domain`
 *  on every reachability report. Caller passes the store's setting
 *  so the upload-time gate and the health-check gate stay aligned. */
export interface VerifyDomainHealthDeps {
  verifyChain: (
    cert_pem: string,
    chain_pem: string | undefined,
    opts: { accept_self_signed: boolean },
  ) => boolean;
  computeFingerprint: (cert_pem: string) => string;
  /** Mirrors the store's constructor `acceptSelfSigned`. Default
   *  false. Production callers thread the store's option through
   *  so per-domain health-check uses the same gate the upload
   *  validator did. */
  accept_self_signed?: boolean;
}

/** Raw store row — same shape as `SqliteTlsDomainStore`'s
 *  `listForHealthCheck()` output (public cert + chain bytes, plus
 *  the standard list-entry metadata). Private key material is NEVER
 *  carried — the type doesn't even mention it. */
export interface SqliteTlsDomainHealthRow {
  domain: string;
  cert_pem: string;
  chain_pem?: string;
  fingerprint: string;
  expires_at: number;
  issuer: string;
  source: TLSDomainCertSource;
  last_renewed_at?: number;
}

/** Apply the verifier seam to a store row + produce a
 *  `PerDomainTlsHealthInput`. Production callers use this to bridge
 *  from `SqliteTlsDomainStore.listForHealthCheck()` to the substrate
 *  inputs. */
export const verifyDomainHealth = (
  row: SqliteTlsDomainHealthRow,
  deps: VerifyDomainHealthDeps,
): PerDomainTlsHealthInput => {
  const computedFp = deps.computeFingerprint(row.cert_pem);
  const fingerprint_matches = computedFp !== '' && computedFp === row.fingerprint;
  const chain_valid = deps.verifyChain(row.cert_pem, row.chain_pem, {
    accept_self_signed: deps.accept_self_signed === true,
  });
  const out: PerDomainTlsHealthInput = {
    domain: row.domain,
    fingerprint: row.fingerprint,
    expires_at: row.expires_at,
    issuer: row.issuer,
    source: row.source,
    chain_valid,
    fingerprint_matches,
  };
  if (row.last_renewed_at !== undefined) out.last_renewed_at = row.last_renewed_at;
  return out;
};

/** Window before cert expiry where the doctor flags the renewal as
 *  imminent (`tls_renewal_imminent`) — 14 days. Mirrors the
 *  single-cert path's value in `./reachability.ts`. */
export const PER_DOMAIN_TLS_RENEWAL_IMMINENT_WINDOW_DAYS = 14;
/** Window before cert expiry where the doctor flags the renewal as
 *  overdue (`tls_renewal_overdue`) — 7 days. Mirrors the
 *  single-cert path's value. */
export const PER_DOMAIN_TLS_RENEWAL_OVERDUE_WINDOW_DAYS = 7;

const MS_PER_DAY = 86_400_000;

const remediationForSource = (source: TLSDomainCertSource, domain: string): string =>
  source === 'pro_acme'
    ? `Trigger an ACME renewal for '${domain}' via Settings → Server → TLS Certificates.`
    : `Upload a renewed cert for '${domain}' via Settings → Server → TLS Certificates.`;

/** Codex FU2 P2 #3 fold — imminent (warning-band) remediation
 *  must distinguish auto-managed certs from BYO. The webclient
 *  fallback for plain `tls_renewal_imminent` says "renewal will run
 *  automatically", which is only true for `pro_acme`. BYO rows in
 *  the 8-14d window get explicit upload-renewal copy so Mary acts
 *  before the cert reaches the error window. */
const imminentRemediationForSource = (
  source: TLSDomainCertSource,
  domain: string,
): string =>
  source === 'pro_acme'
    ? `Auto-renewal will run for '${domain}' within the next 14 days. No action required.`
    : `Upload a renewed cert for '${domain}' via Settings → Server → TLS Certificates before the expiry window enters the error band.`;

/** Pure assembly: walk pre-verified inputs + produce per-domain
 *  entries + the per-domain recommendation feed. The caller (the
 *  reachability doctor) merges these into the report. */
export const buildPerDomainTlsHealth = (
  inputs: ReadonlyArray<PerDomainTlsHealthInput>,
  opts: { now_ms: number },
): {
  entries: ReachabilityPerDomainTlsEntry[];
  recommendations: ReachabilityRecommendation[];
} => {
  const entries: ReachabilityPerDomainTlsEntry[] = [];
  const recommendations: ReachabilityRecommendation[] = [];
  for (const input of inputs) {
    const days_until_expiry = Math.floor((input.expires_at - opts.now_ms) / MS_PER_DAY);
    const entry: ReachabilityPerDomainTlsEntry = {
      domain: input.domain,
      fingerprint: input.fingerprint,
      expires_at: input.expires_at,
      days_until_expiry,
      issuer: input.issuer,
      source: input.source,
      chain_valid: input.chain_valid,
      fingerprint_matches: input.fingerprint_matches,
    };
    if (input.last_renewed_at !== undefined) entry.last_renewed_at = input.last_renewed_at;
    entries.push(entry);

    // Expiry windows — codes reuse the single-cert path's
    // `tls_renewal_overdue` / `tls_renewal_imminent`; message carries
    // the domain (spec § A.6.3 line 885).
    if (days_until_expiry <= PER_DOMAIN_TLS_RENEWAL_OVERDUE_WINDOW_DAYS) {
      recommendations.push({
        severity: 'error',
        code: 'tls_renewal_overdue',
        message: `TLS cert for '${input.domain}' expires in ${days_until_expiry} day(s)`,
        remediation: remediationForSource(input.source, input.domain),
      });
    } else if (days_until_expiry <= PER_DOMAIN_TLS_RENEWAL_IMMINENT_WINDOW_DAYS) {
      recommendations.push({
        severity: 'warning',
        code: 'tls_renewal_imminent',
        message: `TLS cert for '${input.domain}' expires in ${days_until_expiry} day(s)`,
        remediation: imminentRemediationForSource(input.source, input.domain),
      });
    }

    // Row-tamper detection — stored `fingerprint` field disagrees
    // with `hash(cert_pem)`. Reuses `cert_fingerprint_mismatch`
    // (the MITM detection code) with a per-domain message.
    if (!input.fingerprint_matches) {
      recommendations.push({
        severity: 'error',
        code: 'cert_fingerprint_mismatch',
        message: `Stored cert for '${input.domain}' does not hash to its expected fingerprint — possible row tampering`,
        remediation: `Re-upload a known-good cert for '${input.domain}' via Settings → Server → TLS Certificates.`,
      });
    }

    // Chain verification at health-check time. Different failure
    // mode than expiry — intermediate CA expired, OS trust store
    // update, or the chain bundle was incomplete at upload (which
    // the upload validator should have caught, but the
    // health-check is the defence-in-depth).
    if (!input.chain_valid) {
      recommendations.push({
        severity: 'error',
        code: 'tls_chain_invalid_for_domain',
        message: `Cert chain for '${input.domain}' does not terminate at a system trust root`,
        remediation: `Re-upload the cert + the issuer's intermediate chain via Settings → Server → TLS Certificates.`,
      });
    }
  }
  return { entries, recommendations };
};
