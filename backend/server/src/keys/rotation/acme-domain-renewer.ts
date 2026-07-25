/** D-148 § A.6.5 — production `DomainRenewer` backed by
 *  `RecuedAcmeClient.issueCert(...)` + `SqliteTlsDomainStore.upload(...)`.
 *
 *  Plugs into `createDomainBackedTlsRenewalHook({ renewer })` (see
 *  `./tls-renewal-hook.ts`) — the hook resolves which `tls_domains`
 *  row to operate on (canonical-address picker shared with the cert
 *  source); this renewer performs the actual ACME issuance for that
 *  row + writes the new cert back to the store.
 *
 *  Substrate-retention discipline. The renewer is a thin DI seam over
 *  four production dependencies:
 *
 *    - `acme` — `Pick<RecuedAcmeClient, 'issueCert'>` against the
 *      cloud `/v1/acme/issue-cert` Worker. The Pro auth composition
 *      slice supplies `cloud_base_url + pro_subscription_token +
 *      publisher_id + sign` and constructs the client; this module is
 *      agnostic.
 *    - `store` — `Pick<SqliteTlsDomainStore, 'lookup' | 'upload'>`.
 *      `lookup` reads the existing private key (renewal reuses the
 *      keypair — standard ACME practice; key rotation is a separate
 *      concern); `upload` re-validates + persists the issued cert
 *      under the same `pro_acme` source.
 *    - `generateCsr` — caller-supplied PKCS#10 CSR generator.
 *    - `generatePrivateKeyPem` — optional first-issuance key generator.
 *      Production defaults to a fresh Ed25519 PKCS#8 PEM key, scoped to
 *      the TLS-internal ACME path rather than the identity keypair API.
 *
 *  Error mapping. The renewer surfaces three closed-list reasons that
 *  the wrapping `TlsRenewalHook` passes through:
 *
 *    - `helper_unavailable` — the substrate is not ready for any of:
 *      domain row missing from the cache (vault locked / store hasn't
 *      warmed), CSR generator output containing a PRIVATE KEY block
 *      (defensive — never send), or a non-subscription ACME failure
 *      (network / 5xx / unknown HTTP error).
 *    - `subscription_required` — ACME returned a 4xx that maps to a
 *      Pro-auth-related failure (401 / 402 / 403). Operator-facing
 *      surfaces map this to the Pro entitlement flow.
 *    - `storage_io_error` — `store.upload(...)` threw (validation
 *      gate failure or SQLite write). Rare in steady state — usually
 *      a transient SQLite WAL contention or a mid-flight schema
 *      change.
 *
 *  Spec: D-148 § A.6.5. */

import { generateKeyPairSync } from 'node:crypto';

import { resolveProDdnsHost } from '@recued/contracts';

import type { SqliteTlsDomainStore } from '../../tls/domain-store.js';
import type { DomainRenewer } from './tls-renewal-hook.js';

/** ACME issuer surface — matches the relevant subset of
 *  `RecuedAcmeClient.issueCert()` so tests can pass a stub without
 *  pulling in the full client. Production wiring composes the real
 *  `RecuedAcmeClient` and passes it directly. */
export interface AcmeCertIssuer {
  issueCert(args: { handle: string; domain: string; csr_pem: string }): Promise<{
    cert_pem: string;
    issuer_chain_pem: string;
    expires_at: number;
    renewal_recommended_at: number;
  }>;
}

export interface AcmeDomainRenewerOptions {
  /** ACME issuer (production: `RecuedAcmeClient` instance). */
  acme: AcmeCertIssuer;
  /** Per-domain cert store. `lookup` resolves the existing private key
   *  the CSR generator signs against (renewal reuses the keypair);
   *  `upload` persists the new cert under the same `pro_acme` source. */
  store: Pick<SqliteTlsDomainStore, 'lookup' | 'upload'>;
  /** PKCS#10 CSR generator. Caller-supplied to keep the Node-side
   *  ASN.1 / forge / native-binding choice out of the renewer module.
   *  The legacy `tls/cert-renewal.ts` carries the same seam shape;
   *  whichever production implementation lands wires both consumers. */
  generateCsr(args: { domain: string; private_key_pem: string }): string;
  /** Generate a fresh per-domain TLS private key for first issuance.
   *  Production defaults to an Ed25519 PKCS#8 PEM key; tests can stub
   *  this to assert first-cert issuance without pulling in OpenSSL. */
  generatePrivateKeyPem?: () => string;
}

export interface InitialAcmeDomainIssuer {
  issueInitialDomain(args: { domain: string }): Promise<
    | { ok: true; new_fingerprint: string; cert_expires_at: number }
    | {
        ok: false;
        reason: 'helper_unavailable' | 'subscription_required' | 'storage_io_error';
      }
  >;
}

export type AcmeManagedDomainIssuer = DomainRenewer & InitialAcmeDomainIssuer;

/** Extract the Pro DDNS handle stem from a `tls_domains` row's FQDN.
 *  The cloud `/v1/acme/issue-cert` Worker keys its authority + issuer-
 *  affinity gates on `handle` — the single-label stem (e.g. `alice`,
 *  not `alice.recued.net`) — while the cert itself is ordered for the
 *  full `domain` we pass alongside (D-176). Returns `null` when
 *  the row's domain isn't a Pro DDNS shape (BYO custom domain that
 *  slipped past the `sources: ['pro_acme']` filter, a future ACME-
 *  managed-but-not-Recued-DDNS posture, or a malformed row).
 *
 *  Delegates to `resolveProDdnsHost`, which already enforces the single-
 *  label-handle-of-an-enabled-zone shape the cloud Worker's CN match needs
 *  (multi-label prefixes like `a.b.recued.net` resolve to null). Returns just
 *  the handle stem (e.g. `alice`). Zone-agnostic via the DDNS_ZONES registry. */
const extractHandleStem = (domain: string): string | null =>
  resolveProDdnsHost(domain)?.handle ?? null;

/** Map an ACME failure to one of the closed-list `DomainRenewer`
 *  reasons. `RecuedAcmeClient.issueCert` throws on HTTP error with a
 *  message shaped `recued_acme_issue_failed: HTTP <status> <body>`;
 *  this helper picks out the status to discriminate Pro-auth failures
 *  (401 / 402 / 403) from generic failures. Unknown / fetch / network
 *  errors collapse to `helper_unavailable`. */
const mapAcmeFailure = (
  err: unknown,
): 'helper_unavailable' | 'subscription_required' => {
  const msg = err instanceof Error ? err.message : '';
  // The HTTP-401 / 402 / 403 family signals subscription / auth
  // failures the operator can fix (Settings → Pro → re-authenticate).
  // Match against the prefix `HTTP 40[123]` so the format `HTTP 402 …`
  // (whitespace + body) is preserved without splitting.
  if (/\bHTTP 40[123]\b/.test(msg)) {
    return 'subscription_required';
  }
  return 'helper_unavailable';
};

const generateDefaultTlsPrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
};

export const createAcmeDomainRenewer = (
  options: AcmeDomainRenewerOptions,
): AcmeManagedDomainIssuer => {
  const {
    acme,
    store,
    generateCsr,
    generatePrivateKeyPem = generateDefaultTlsPrivateKeyPem,
  } = options;

  const issueAndUpload = async (
    domain: string,
    private_key_pem: string,
  ): Promise<
    | { ok: true; new_fingerprint: string; cert_expires_at: number }
    | {
        ok: false;
        reason: 'helper_unavailable' | 'subscription_required' | 'storage_io_error';
      }
  > => {
    const handle = extractHandleStem(domain);
    if (handle === null) {
      return { ok: false, reason: 'helper_unavailable' };
    }

    let csr_pem: string;
    try {
      csr_pem = generateCsr({ domain, private_key_pem });
    } catch {
      return { ok: false, reason: 'helper_unavailable' };
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(csr_pem)) {
      return { ok: false, reason: 'helper_unavailable' };
    }

    let issued: Awaited<ReturnType<AcmeCertIssuer['issueCert']>>;
    try {
      // D-176 — pass the full `domain` (the `tls_domains` row's FQDN)
      // so the cloud orders + validates THAT host; `handle` rides along
      // for the cloud's authority + issuer-affinity gates.
      issued = await acme.issueCert({
        handle,
        domain,
        csr_pem,
      });
    } catch (err) {
      return { ok: false, reason: mapAcmeFailure(err) };
    }

    try {
      await store.upload({
        domain,
        source: 'pro_acme',
        cert_pem: issued.cert_pem,
        private_key_pem,
        chain_pem: issued.issuer_chain_pem,
      });
    } catch {
      return { ok: false, reason: 'storage_io_error' };
    }

    const issuedRow = store.lookup(domain);
    if (issuedRow === null) {
      return { ok: false, reason: 'storage_io_error' };
    }
    return {
      ok: true,
      new_fingerprint: issuedRow.fingerprint,
      cert_expires_at: issuedRow.expires_at,
    };
  };

  return {
    async renewDomain(args) {
      const { domain } = args;
      // Read the row's existing private key — renewal reuses the
      // keypair (standard ACME practice; key rotation is a separate
      // concern). `lookup` is synchronous + reads from the in-RAM
      // decrypted cache; a `null` here means the row exists but the
      // cache hasn't warmed yet (vault locked at boot, or a fresh
      // upload mid-cycle that pre-empted the warm). Either way the
      // renewer cannot proceed; `helper_unavailable` lets the
      // operator's `tls.renew` rpc surface a closed-list error code.
      const current = store.lookup(domain);
      if (current === null) {
        return { ok: false, reason: 'helper_unavailable' };
      }

      // Shared issue path validates the Pro DDNS handle stem, generates
      // the CSR, runs the ACME request, uploads the cert, and re-looks
      // up the post-upload row so this renewer depends only on the
      // `lookup` + `upload` slice of the store.
      const renewed = await issueAndUpload(current.domain, current.private_key_pem);
      if (!renewed.ok) return renewed;
      return { ok: true, new_fingerprint: renewed.new_fingerprint };
    },

    async issueInitialDomain(args) {
      const domain = args.domain.trim().toLowerCase();
      const existing = store.lookup(domain);
      if (existing?.source === 'pro_acme') {
        return {
          ok: true,
          new_fingerprint: existing.fingerprint,
          cert_expires_at: existing.expires_at,
        };
      }

      let private_key_pem: string;
      try {
        private_key_pem = generatePrivateKeyPem();
      } catch {
        return { ok: false, reason: 'helper_unavailable' };
      }
      return issueAndUpload(domain, private_key_pem);
    },
  };
};
