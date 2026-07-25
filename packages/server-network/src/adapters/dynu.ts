/** D-148 § A.17 — Dynu BYO adapter (free).
 *
 *  Dynu's update API is a GET against
 *  `https://api.dynu.com/nic/update?hostname=<host>&myip=<ip>` with
 *  HTTP Basic auth (username + IP-update-password — generated in the
 *  Dynu dashboard; distinct from the account password).
 *
 *  Plain-text response: `good <ip>` / `nochg <ip>` / `nohost` /
 *  `badauth` / `911` per the de-facto DynDNS protocol.
 */

import type {
  DdnsAdapter,
  DdnsUpdateInput,
  DdnsUpdateOutput,
} from '../adapter.js';

export interface DynuAdapterConfig {
  hostname: string;
  username: string;
  /** IP-update password from the Dynu dashboard. NOT the account
   *  password. */
  ip_update_password: string;
  base_url?: string;
  fetch?: typeof fetch;
  now?: () => number;
  ttl_hint?: number;
}

const DEFAULT_BASE_URL = 'https://api.dynu.com/nic/update';

const b64 = (s: string): string => {
  if (typeof btoa === 'function') return btoa(s);
  // Node fallback for non-browser environments.
  return Buffer.from(s, 'utf-8').toString('base64');
};

export const createDynuAdapter = (
  config: DynuAdapterConfig,
): DdnsAdapter => {
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const base = config.base_url ?? DEFAULT_BASE_URL;

  return {
    kind: 'dynu',
    async update(input: DdnsUpdateInput): Promise<DdnsUpdateOutput> {
      const params = new URLSearchParams({
        hostname: config.hostname,
        myip: input.ip_v4,
      });
      if (input.ip_v6) params.set('myipv6', input.ip_v6);
      const url = `${base}?${params.toString()}`;
      const auth = b64(`${config.username}:${config.ip_update_password}`);
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` },
      });
      const body = (await res.text()).trim();
      if (!res.ok || (!body.startsWith('good') && !body.startsWith('nochg'))) {
        throw new Error(`dynu_update_failed: HTTP ${res.status} body=${body}`);
      }
      return {
        updated_at: now(),
        ttl: config.ttl_hint ?? 120,
        unchanged: body.startsWith('nochg'),
        provider_message: body,
      };
    },
  };
};
