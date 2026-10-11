/** D-148 § A.5.3 — the server's client for Recued's ACME endpoint (Pro).
 *
 *  `RecuedAcmeClient` sends a locally generated CSR, signed with
 *  `server_identity_key`, to the cloud's `/v1/acme/issue-cert`; the server
 *  composes it in `backend/server/src/keys/rotation/recued-acme-client-factory.ts`.
 *
 *  ⛔ This package also held BYO DDNS adapters (DuckDNS, Cloudflare, Dynu,
 *  generic DNS, Recued Cloud) and three `TLS_INTEGRATION_MODES` until
 *  2026-10-10. Nothing in production ever constructed one, and the setup
 *  guides documented `[ddns]` / `[tls]` sections for them that nothing read,
 *  so they were deleted (decisions-log, "D-148 follow-up (2)"). A provider's
 *  own updater keeps a BYO name current (internal design notes); TLS is
 *  each hostname's certificate choice (internal design notes).
 */

export {
  RecuedAcmeClient,
  type AcmeClientConfig,
  type RecuedAcmeIssueResult,
} from './acme-client.js';
