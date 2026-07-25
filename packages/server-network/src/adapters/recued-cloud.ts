/** D-148 § A.5.2 — Recued cloud DDNS adapter (Pro).
 *
 *  Signs the update payload with `server_identity_key` and POSTs to
 *  `<cloud_base>/v1/ddns/update`. The cloud verifies the signature,
 *  enforces the 5-minute replay window, and updates the DNS record
 *  for `<handle>.recued.cloud`.
 *
 *  Test injection: the caller passes a `fetch` shape so unit tests
 *  can intercept the POST without binding to network.
 */

import type {
  DdnsUpdateRequest,
  DdnsUpdateResponse,
} from '@recued/contracts';
import type {
  DdnsAdapter,
  DdnsUpdateInput,
  DdnsUpdateOutput,
} from '../adapter.js';

export interface RecuedCloudAdapterConfig {
  /** Base URL for Recued cloud — production is `https://api.recued.cloud`.
   *  Tests inject a mock URL paired with a custom `fetch`. */
  cloud_base_url: string;
  /** Pro subscription bearer (rotates with subscription lifecycle). */
  pro_subscription_token: string;
  publisher_id: string;
  /** Sign function — given canonical payload bytes, return a base64
   *  Ed25519 signature over the payload. The caller wires this to
   *  `backend/server/src/keys/`'s `ed25519Sign` against the active
   *  `server_identity_key`. The adapter never holds the private key
   *  directly; it only knows the function reference. */
  sign(payload: Uint8Array): string;
  /** Optional fetch override; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional `Date.now()` override for tests. */
  now?: () => number;
}

const buildSignedBytes = (req: DdnsUpdateRequest): Uint8Array => {
  // Canonical-JSON serialization — keys sorted alphabetically.
  // Mirrors `canonicalJsonBytes` in `backend/api/src/shared/crypto.ts`
  // so signed bytes are byte-identical across both sides.
  const sorted = {
    handle: req.handle,
    ip_v4: req.ip_v4,
    ip_v6: req.ip_v6 ?? null,
    publisher_id: req.publisher_id,
    timestamp: req.timestamp,
  };
  return new TextEncoder().encode(JSON.stringify(sorted));
};

export const createRecuedCloudAdapter = (
  config: RecuedCloudAdapterConfig,
): DdnsAdapter => {
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;

  return {
    kind: 'recued-cloud',
    async update(input: DdnsUpdateInput): Promise<DdnsUpdateOutput> {
      const timestamp = now();
      const payload: DdnsUpdateRequest = {
        publisher_id: config.publisher_id,
        handle: input.handle,
        ip_v4: input.ip_v4,
        ip_v6: input.ip_v6,
        signature: '',
        timestamp,
      };
      const signedBytes = buildSignedBytes(payload);
      payload.signature = config.sign(signedBytes);

      const url = config.cloud_base_url.replace(/\/+$/, '') + '/v1/ddns/update';
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.pro_subscription_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`recued_cloud_ddns_update_failed: HTTP ${res.status} ${text}`);
      }
      const json = (await res.json()) as { data: DdnsUpdateResponse };
      return {
        updated_at: json.data.ddns_record_updated_at,
        ttl: json.data.ttl,
        unchanged: json.data.unchanged === true,
        provider_message: json.data.warnings.join('; ') || undefined,
      };
    },
  };
};
