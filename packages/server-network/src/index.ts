/** D-148 § A.5 + § A.17 — server-side network adapter package.
 *
 *  P5 implementation of the BYO DDNS adapter abstraction + the
 *  Recued cloud DDNS / ACME client. Same shape regardless of
 *  provider so the user-server picks at onboarding and the rest of
 *  the substrate stays identical.
 *
 *  Adapters shipped at P5:
 *    - `recued-cloud` (Pro tier; signed POST to `/v1/ddns/update`).
 *    - `duckdns` (free; HTTP GET with token).
 *    - `cloudflare` (free; REST API with API token).
 *    - `dynu` (free; HTTP GET with username + password).
 *    - `generic-dns` (escape hatch; user supplies an arbitrary URL
 *      template + auth header).
 *
 *  All adapters implement `DdnsAdapter` so the cert-renewal task /
 *  Reachability Doctor / handle-change flow don't care which one is
 *  configured.
 *
 *  TLS integration:
 *    - The Recued cloud adapter uses CSR-only ACME via
 *      `RecuedAcmeClient`.
 *    - The certbot integration is opaque (server reads the cert
 *      from a configured path).
 *    - The Caddy integration is opaque (TLS terminated upstream).
 *    - The setup guides under `docs/setup-byo-{ddns,tls}.md`
 *      document each path.
 */

export {
  DDNS_ADAPTER_KINDS,
  type DdnsAdapter,
  type DdnsAdapterKind,
  type DdnsUpdateInput,
  type DdnsUpdateOutput,
  isDdnsAdapterKind,
} from './adapter.js';

export {
  createRecuedCloudAdapter,
  type RecuedCloudAdapterConfig,
} from './adapters/recued-cloud.js';

export {
  createDuckDnsAdapter,
  type DuckDnsAdapterConfig,
} from './adapters/duckdns.js';

export {
  createCloudflareAdapter,
  type CloudflareAdapterConfig,
} from './adapters/cloudflare.js';

export {
  createDynuAdapter,
  type DynuAdapterConfig,
} from './adapters/dynu.js';

export {
  createGenericDnsAdapter,
  type GenericDnsAdapterConfig,
} from './adapters/generic-dns.js';

export {
  RecuedAcmeClient,
  type AcmeClientConfig,
  type RecuedAcmeIssueResult,
} from './acme-client.js';

export {
  TLS_INTEGRATION_MODES,
  type TlsIntegrationMode,
  type TlsIntegrationConfig,
  resolveTlsIntegration,
  isTlsIntegrationMode,
} from './tls-integration.js';
