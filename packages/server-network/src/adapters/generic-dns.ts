/** D-148 § A.17 — Generic DNS BYO adapter (escape hatch).
 *
 *  For users with a DNS provider not in the closed list. The user
 *  configures a URL template + auth header + an "OK"-substring
 *  matcher; the adapter substitutes `{handle}`, `{ip_v4}`,
 *  `{ip_v6}` into the URL template + does the call.
 *
 *  Trade-off: less polished UX than the named adapters but it
 *  always works. The setup guide at internal design notes
 *  documents this fallback for providers like Hurricane Electric,
 *  Namecheap Dynamic DNS, etc.
 */

import type {
  DdnsAdapter,
  DdnsUpdateInput,
  DdnsUpdateOutput,
} from '../adapter.js';

export interface GenericDnsAdapterConfig {
  /** URL template with `{handle}`, `{ip_v4}`, `{ip_v6}` substitutions. */
  url_template: string;
  /** HTTP method — most providers use GET; some use PATCH. */
  method?: 'GET' | 'POST' | 'PATCH';
  /** Optional auth header — provider-specific shape. */
  auth_header?: { name: string; value: string };
  /** Optional request body template. */
  body_template?: string;
  /** Substring that must appear in the response body for success. */
  ok_substring: string;
  /** Substring that signals the IP is already current. Optional. */
  unchanged_substring?: string;
  ttl_hint?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const interpolate = (
  template: string,
  vars: Record<string, string | undefined>,
): string =>
  template.replace(/\{(handle|ip_v4|ip_v6)\}/g, (_, k: string) => vars[k] ?? '');

export const createGenericDnsAdapter = (
  config: GenericDnsAdapterConfig,
): DdnsAdapter => {
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;

  return {
    kind: 'generic-dns',
    async update(input: DdnsUpdateInput): Promise<DdnsUpdateOutput> {
      const url = interpolate(config.url_template, {
        handle: input.handle,
        ip_v4: input.ip_v4,
        ip_v6: input.ip_v6,
      });
      const headers: Record<string, string> = {};
      if (config.auth_header) {
        headers[config.auth_header.name] = config.auth_header.value;
      }
      if (config.body_template) {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      }
      const res = await fetchImpl(url, {
        method: config.method ?? 'GET',
        headers,
        body: config.body_template
          ? interpolate(config.body_template, {
              handle: input.handle,
              ip_v4: input.ip_v4,
              ip_v6: input.ip_v6,
            })
          : undefined,
      });
      const body = await res.text();
      if (!res.ok || !body.includes(config.ok_substring)) {
        throw new Error(
          `generic_dns_update_failed: HTTP ${res.status} body=${body.slice(0, 256)}`,
        );
      }
      const unchanged =
        config.unchanged_substring !== undefined &&
        body.includes(config.unchanged_substring);
      return {
        updated_at: now(),
        ttl: config.ttl_hint ?? 300,
        unchanged,
        provider_message: body.slice(0, 256),
      };
    },
  };
};
