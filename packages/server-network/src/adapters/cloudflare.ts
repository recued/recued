/** D-148 § A.17 — Cloudflare DNS BYO adapter (free).
 *
 *  Cloudflare's DNS API requires a Zone ID + Record ID + an API
 *  Token scoped to `Zone.DNS:Edit` for one zone. The server-side
 *  config carries all three; the adapter PATCHes the record on
 *  IP change.
 */

import type {
  DdnsAdapter,
  DdnsUpdateInput,
  DdnsUpdateOutput,
} from '../adapter.js';

export interface CloudflareAdapterConfig {
  /** Cloudflare Zone ID (from the dashboard's zone overview page). */
  zone_id: string;
  /** A-record ID inside the zone (one PATCH targets one record;
   *  the adapter is configured per record). */
  record_id: string;
  /** Optional second record ID for AAAA (IPv6). */
  record_id_v6?: string;
  /** API Token scoped to `Zone.DNS:Edit` for this zone only. */
  api_token: string;
  /** TTL applied at update. Cloudflare's free plan accepts 60-86400. */
  ttl?: number;
  /** Fetch override for tests. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Override base URL for tests. */
  base_url?: string;
}

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';

export const createCloudflareAdapter = (
  config: CloudflareAdapterConfig,
): DdnsAdapter => {
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const base = config.base_url ?? DEFAULT_BASE_URL;
  const ttl = config.ttl ?? 300;

  return {
    kind: 'cloudflare',
    async update(input: DdnsUpdateInput): Promise<DdnsUpdateOutput> {
      const headers = {
        Authorization: `Bearer ${config.api_token}`,
        'Content-Type': 'application/json',
      };
      const aRes = await fetchImpl(
        `${base}/zones/${config.zone_id}/dns_records/${config.record_id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            type: 'A',
            name: input.handle,
            content: input.ip_v4,
            ttl,
            proxied: false,
          }),
        },
      );
      if (!aRes.ok) {
        const text = await aRes.text().catch(() => '');
        throw new Error(`cloudflare_update_failed: HTTP ${aRes.status} ${text}`);
      }
      if (input.ip_v6 && config.record_id_v6) {
        const aaaaRes = await fetchImpl(
          `${base}/zones/${config.zone_id}/dns_records/${config.record_id_v6}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              type: 'AAAA',
              name: input.handle,
              content: input.ip_v6,
              ttl,
              proxied: false,
            }),
          },
        );
        if (!aaaaRes.ok) {
          const text = await aaaaRes.text().catch(() => '');
          throw new Error(`cloudflare_aaaa_update_failed: HTTP ${aaaaRes.status} ${text}`);
        }
      }
      return {
        updated_at: now(),
        ttl,
        unchanged: false,
      };
    },
  };
};
