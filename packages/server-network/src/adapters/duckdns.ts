/** D-148 § A.17 — DuckDNS BYO adapter (free).
 *
 *  DuckDNS' update API is a GET against
 *  `https://www.duckdns.org/update?domains=<sub>&token=<token>&ip=<ip>`.
 *  The response is plaintext: `OK` or `KO`. No structured response.
 */

import type {
  DdnsAdapter,
  DdnsUpdateInput,
  DdnsUpdateOutput,
} from '../adapter.js';

export interface DuckDnsAdapterConfig {
  /** Bare subdomain (no `.duckdns.org`). */
  subdomain: string;
  /** DuckDNS account token from https://www.duckdns.org/. */
  token: string;
  /** Override the base URL for tests. Defaults to the production
   *  endpoint. */
  base_url?: string;
  /** TTL hint for the doctor (DuckDNS doesn't return a TTL — they
   *  apply 60s server-side). */
  ttl_hint?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const DEFAULT_BASE_URL = 'https://www.duckdns.org/update';

export const createDuckDnsAdapter = (
  config: DuckDnsAdapterConfig,
): DdnsAdapter => {
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const base = config.base_url ?? DEFAULT_BASE_URL;

  return {
    kind: 'duckdns',
    async update(input: DdnsUpdateInput): Promise<DdnsUpdateOutput> {
      const params = new URLSearchParams({
        domains: config.subdomain,
        token: config.token,
        ip: input.ip_v4,
      });
      if (input.ip_v6) params.set('ipv6', input.ip_v6);
      const url = `${base}?${params.toString()}`;
      const res = await fetchImpl(url, { method: 'GET' });
      const body = (await res.text()).trim();
      if (!res.ok || body !== 'OK') {
        throw new Error(`duckdns_update_failed: HTTP ${res.status} body=${body}`);
      }
      return {
        updated_at: now(),
        ttl: config.ttl_hint ?? 60,
        // DuckDNS' `OK` doesn't differentiate between "applied" and
        // "no-op" — substrate dedup happens client-side.
        unchanged: false,
        provider_message: 'OK',
      };
    },
  };
};
