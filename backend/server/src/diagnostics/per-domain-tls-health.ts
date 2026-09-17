/** D-148 FU2 — per-domain TLS health: apply the verifier seam to a stored row.
 *
 *  ⛔ THE ROLLUP IS GONE (2026-09-16). This file used to end in
 *  `buildPerDomainTlsHealth`, which turned these rows into
 *  `ReachabilityPerDomainTlsEntry[]` plus a `ReachabilityRecommendation[]` feed
 *  for `buildReachabilityReport`. That report was deleted, and the rollup was
 *  shaped for it at EVERY level, not just in its return type:
 *
 *    — Its severity bands were the report's. It called a cert `error` at 7 days
 *      to expiry; `recued doctor` calls that `warn`, because an exit code of 1
 *      means BROKEN INSTALL and a renewal with a week left to run is not one.
 *    — Its remediation copy pointed at "Settings → Server → TLS Certificates" —
 *      a web page on the server whose health is in question, offered to someone
 *      who ran a terminal command.
 *    — Its recommendations carried no domain field, so a consumer with more than
 *      one row could only match them back by parsing the message text.
 *
 *  ⇒ Wiring it into the doctor would have meant overriding its severities,
 *  rewriting its copy and calling it once per row to keep the correlation — at
 *  which point nothing of it was left but the two booleans `verifyDomainHealth`
 *  already returns. The doctor reads those directly now.
 *
 *  🔑 WHAT SURVIVED IS THE PART THAT DOES IO-SHAPED WORK: the verifier seam +
 *  fingerprint comparison, which is the half that needed a seam in the first
 *  place. `recued doctor` (`cli-context/doctor.ts`) is its caller.
 *
 *  ⚠ `accept_self_signed` mirrors the store's `acceptSelfSigned` constructor
 *  option (Codex FU2 P2 #1 fold). When the store accepted a self-signed BYO cert
 *  at upload, re-verifying with `false` surfaces a phantom chain failure on
 *  every health check. */

import type { TLSDomainCertSource } from '@recued/contracts';

/** A stored row with the verifier seam applied: chain verified, fingerprint
 *  computed and compared. What `verifyDomainHealth` returns and what
 *  `recued doctor` reports from.
 *
 *  ⚠ `chain_valid` and `fingerprint_matches` ARE THE POINT OF THIS TYPE. They
 *  cost a trust-store walk and a hash to produce, and for as long as this file
 *  had a rollup on the end of it the doctor computed both and read neither. */
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

/** Verifier seam — `recued doctor` wires `verifyChain` from
 *  `../tls/cert-verifiers.ts` and node's own `X509Certificate.fingerprint256`.
 *  Tests stub with deterministic outputs so the unit test never depends on the
 *  system trust store; `doctor-cli.test.ts` drives the REAL verifiers against a
 *  generated self-signed cert, which is the only way to prove the seam is
 *  connected to anything.
 *
 *  `accept_self_signed` mirrors the store's `acceptSelfSigned`
 *  constructor option (Codex FU2 P2 #1 fold). When the store
 *  accepted a self-signed BYO cert at upload, re-verifying with
 *  `false` would surface a phantom `tls_chain_invalid_for_domain`
 *  on every health check. Caller passes the store's setting
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
