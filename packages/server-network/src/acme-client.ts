/** D-148 § A.5.3 / § A.5.4 — Recued ACME client (Pro tier).
 *
 *  Server-side counterpart to the cloud `/v1/acme/issue-cert` Worker.
 *  Generates the CSR locally (using the existing `tls_private_key`
 *  per § A.8 — never serialized), signs the request body with
 *  `server_identity_key`, POSTs to the cloud, and lands the cert on
 *  disk.
 *
 *  Renewal cadence: triggered by the housekeeping cycle when
 *  `expires_at - now < CERT_RENEWAL_LEAD_TIME_MS` (30 days).
 *  Failure flips `coverage.sources_degraded: 'cert_renewal_overdue'`
 *  per § A.5.4.
 *
 *  Free-tier users use certbot/Caddy instead — `tls-integration.ts`
 *  resolves which mode the server runs in.
 */

import type {
  AcmeIssueCertRequest,
  AcmeIssueCertResponse,
} from '@recued/contracts';

export interface AcmeClientConfig {
  cloud_base_url: string;
  pro_subscription_token: string;
  publisher_id: string;
  /** Sign function — same shape as the DDNS adapter's. Wires to
   *  `server_identity_key` `ed25519Sign`. */
  sign(payload: Uint8Array): string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface RecuedAcmeIssueResult {
  cert_pem: string;
  issuer_chain_pem: string;
  expires_at: number;
  renewal_recommended_at: number;
}

const buildSignedBytes = (req: AcmeIssueCertRequest): Uint8Array => {
  const sorted = {
    csr_pem: req.csr_pem,
    handle: req.handle,
    publisher_id: req.publisher_id,
    timestamp: req.timestamp,
  };
  return new TextEncoder().encode(JSON.stringify(sorted));
};

export class RecuedAcmeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly config: AcmeClientConfig;

  constructor(config: AcmeClientConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
  }

  /** Submit a CSR to the Recued cloud ACME helper and receive a
   *  signed cert. `domain` is the full Pro DDNS FQDN
   *  (`<handle><zone.suffix>`, e.g. `alice.recued.net`) the cert is
   *  for; the cloud orders + validates that exact host (D-176). It
   *  rides the wire UN-signed — the signed CSR already commits to it
   *  and the cloud cross-checks (see `AcmeIssueCertRequest`). Throws on
   *  network or signature failure. */
  async issueCert(args: { handle: string; domain: string; csr_pem: string }): Promise<RecuedAcmeIssueResult> {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(args.csr_pem)) {
      // Defensive client-side check — never let a CSR-bundled
      // private-key payload leave the server. Belt-and-braces with
      // the cloud-side rejection.
      throw new Error('acme_csr_contains_private_key');
    }
    const timestamp = this.now();
    const payload: AcmeIssueCertRequest = {
      publisher_id: this.config.publisher_id,
      handle: args.handle,
      domain: args.domain,
      csr_pem: args.csr_pem,
      signature: '',
      timestamp,
    };
    payload.signature = this.config.sign(buildSignedBytes(payload));

    const url =
      this.config.cloud_base_url.replace(/\/+$/, '') + '/v1/acme/issue-cert';
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.pro_subscription_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`recued_acme_issue_failed: HTTP ${res.status} ${text}`);
    }
    const json = (await res.json()) as { data: AcmeIssueCertResponse };
    return {
      cert_pem: json.data.cert_pem,
      issuer_chain_pem: json.data.issuer_chain_pem,
      expires_at: json.data.expires_at,
      renewal_recommended_at: json.data.renewal_recommended_at,
    };
  }
}
