/** D-148 § A.5.4 — server-side cert-renewal task.
 *
 *  Scheduled in the housekeeping cycle. When the current cert is
 *  within `CERT_RENEWAL_LEAD_TIME_MS` (30 days) of expiry, generates
 *  a fresh CSR (against the active `tls_private_key`), submits it
 *  via `RecuedAcmeClient`, and writes the new cert to disk.
 *
 *  Failure path: emits an audit row + flips
 *  `coverage.sources_degraded: 'cert_renewal_overdue'` on the next
 *  reachability check. The Reachability Doctor surfaces the warning;
 *  user can either retry, switch to a BYO TLS mode, or contact
 *  support.
 *
 *  Free-tier users (mode: `certbot` / `caddy`) skip this task — the
 *  upstream proxy renews. The resolver in `tls-integration.ts` gates
 *  whether this task even runs.
 */

import {
  CERT_RENEWAL_LEAD_TIME_MS,
  CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS,
  CERT_RENEWAL_OVERDUE_DEGRADED_REASON,
  hostnameForHandle,
} from '@recued/contracts';
import type {
  RecuedAcmeClient,
  RecuedAcmeIssueResult,
} from '@recued/server-network';

export interface CertRenewalState {
  cert_pem: string;
  expires_at: number;
  renewal_recommended_at: number;
  /** Per-domain handle the cert was issued for. */
  handle: string;
}

/** Persistence boundary for the renewal task. P5 ships the typed
 *  interface; P6 wires it to the server's existing `server_kv` /
 *  on-disk cert file. */
export interface CertRenewalStore {
  loadCurrent(): Promise<CertRenewalState | null>;
  /** Write the new cert + chain to disk + update the in-memory
   *  TLS context the listeners use. Returns when the new cert is
   *  in effect. */
  applyNew(args: {
    handle: string;
    cert_pem: string;
    issuer_chain_pem: string;
    expires_at: number;
    renewal_recommended_at: number;
  }): Promise<void>;
}

/** Audit hook — fires on each renewal attempt. The caller wires it
 *  to the server's audit emitter. */
export interface CertRenewalAuditEmitter {
  emit(event: {
    kind: 'cert_renewed' | 'cert_renewal_failed' | 'cert_renewal_skipped';
    handle: string;
    fingerprint?: string;
    error_code?: string;
    error_message?: string;
    expires_at?: number;
    occurred_at: number;
  }): void;
}

/** Coverage hook — surfaces `sources_degraded: cert_renewal_overdue`
 *  on the next reachability check when renewal fails AND the cert
 *  is within the user-warning window. */
export interface CoverageDegradedSink {
  flag(reason: typeof CERT_RENEWAL_OVERDUE_DEGRADED_REASON, args: {
    handle: string;
    expires_at: number;
    last_attempt_at: number;
    last_error: string;
  }): void;
  clear(reason: typeof CERT_RENEWAL_OVERDUE_DEGRADED_REASON, args: { handle: string }): void;
}

export interface CertRenewalTaskDeps {
  acme: Pick<RecuedAcmeClient, 'issueCert'>;
  store: CertRenewalStore;
  /** Generate a CSR for the current TLS keypair. Output is a PEM
   *  string with a `BEGIN CERTIFICATE REQUEST` block; the function
   *  must NEVER include any private-key material. The wired-in
   *  implementation lives in the server's TLS module (P6); P5 ships
   *  the dependency injection point + a test stub. */
  generateCsr(args: { handle: string }): string;
  audit: CertRenewalAuditEmitter;
  coverage: CoverageDegradedSink;
  now?: () => number;
}

export interface RunCertRenewalResult {
  /** Outcome discriminator — useful for tests + observability. */
  outcome:
    | 'no_cert'
    | 'not_yet_due'
    | 'renewed'
    | 'renewal_failed'
    | 'skipped_byo_mode';
  /** Updated state after a successful renewal. */
  state?: CertRenewalState;
  /** Last error message when outcome is `renewal_failed`. */
  error?: string;
}

/** D-148 § A.5.4 — the renewal task itself. Returns a structured
 *  outcome rather than throwing so the caller can decide whether to
 *  retry, audit, or surface to the user. */
export const runCertRenewal = async (
  deps: CertRenewalTaskDeps,
): Promise<RunCertRenewalResult> => {
  const now = deps.now ?? Date.now;
  const at = now();

  const current = await deps.store.loadCurrent();
  if (!current) {
    // First-time provisioning — caller wires a separate flow for
    // initial issuance. Renewal task no-ops.
    return { outcome: 'no_cert' };
  }

  if (at < current.renewal_recommended_at) {
    return { outcome: 'not_yet_due', state: current };
  }

  // Generate a fresh CSR against the active TLS keypair. The CSR
  // carries the public-key half + a signature. The private key
  // stays on disk; this function MUST NOT expose it.
  const csr_pem = deps.generateCsr({ handle: current.handle });
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(csr_pem)) {
    // Defensive — `generateCsr` is server-internal but a bug here
    // would be catastrophic. Reject + emit audit + flag coverage
    // (the renewal pipeline is broken; cert WILL expire and public
    // ingress WILL degrade unless the CSR generator is fixed).
    // Codex P5 MEDIUM #2 fold — pre-flight rejection now flags
    // coverage_degraded with the same user-warning-window gate as
    // the ACME-failure path, so the Reachability Doctor surfaces
    // the broken pipeline instead of silently failing.
    const errorMessage = 'CSR generator emitted a PRIVATE KEY block; refusing to send';
    deps.audit.emit({
      kind: 'cert_renewal_failed',
      handle: current.handle,
      error_code: 'csr_contained_private_key',
      error_message: errorMessage,
      occurred_at: at,
    });
    if (current.expires_at - at < CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS) {
      deps.coverage.flag(CERT_RENEWAL_OVERDUE_DEGRADED_REASON, {
        handle: current.handle,
        expires_at: current.expires_at,
        last_attempt_at: at,
        last_error: 'csr_contained_private_key',
      });
    }
    return { outcome: 'renewal_failed', error: 'csr_contained_private_key' };
  }

  let issued: RecuedAcmeIssueResult;
  try {
    // D-176 — legacy single-domain path: order under the default Pro
    // DDNS zone (`<handle>.recued.net` via `hostnameForHandle`). This
    // path is superseded by the per-domain renewer
    // (`acme-domain-renewer.ts`); the explicit `domain` keeps it
    // compiling against the shared `RecuedAcmeClient.issueCert` shape
    // and orders the correct zone if ever revived.
    issued = await deps.acme.issueCert({
      handle: current.handle,
      domain: hostnameForHandle(current.handle),
      csr_pem,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown_error';
    deps.audit.emit({
      kind: 'cert_renewal_failed',
      handle: current.handle,
      error_code: 'acme_unavailable',
      error_message: msg,
      occurred_at: at,
    });
    if (current.expires_at - at < CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS) {
      deps.coverage.flag(CERT_RENEWAL_OVERDUE_DEGRADED_REASON, {
        handle: current.handle,
        expires_at: current.expires_at,
        last_attempt_at: at,
        last_error: msg,
      });
    }
    return { outcome: 'renewal_failed', error: msg };
  }

  await deps.store.applyNew({
    handle: current.handle,
    cert_pem: issued.cert_pem,
    issuer_chain_pem: issued.issuer_chain_pem,
    expires_at: issued.expires_at,
    renewal_recommended_at: issued.renewal_recommended_at,
  });

  // Renewal succeeded — clear any prior `cert_renewal_overdue` flag.
  deps.coverage.clear(CERT_RENEWAL_OVERDUE_DEGRADED_REASON, { handle: current.handle });

  deps.audit.emit({
    kind: 'cert_renewed',
    handle: current.handle,
    expires_at: issued.expires_at,
    occurred_at: at,
  });

  return {
    outcome: 'renewed',
    state: {
      cert_pem: issued.cert_pem,
      expires_at: issued.expires_at,
      renewal_recommended_at: issued.renewal_recommended_at,
      handle: current.handle,
    },
  };
};

/** D-148 § A.5.4 — re-export the constant so the housekeeping
 *  scheduler can use the same renewal-lead window the contract
 *  specifies. */
export { CERT_RENEWAL_LEAD_TIME_MS };
