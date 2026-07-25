/** D-148 § A.6.5 — first-pin acquisition substrate.
 *
 *  Provides the current TLS leaf cert (fingerprint + expiry) for any
 *  composer that needs to surface a cert pin pre-binding. Post-D-156 P9
 *  the consumers are the cert-pin stack (passport-fetch first-pin) and
 *  the TLS renewal housekeeping task — pair-blob mint went away with the
 *  rest of the D-148 § A.2.1 substrate.
 *
 *  The hook is intentionally narrow:
 *   - synchronous — TLS state is in-RAM at handshake-time anyway
 *     (`SqliteTlsDomainStore.lookup` is sync via `decryptedCache`).
 *   - returns `null` for LAN-only / pre-cert-bind servers — consumers
 *     leave their fingerprint fields absent + the receiving client's
 *     `cert_pin_state` stays null until the first rotation notice.
 *   - returns `{ fingerprint, valid_until }` for a bound cert —
 *     `fingerprint` is the SHA-256 of the active leaf cert (`sha256:`
 *     prefixed); `valid_until` is Unix-ms when the cert expires
 *     (production wires this from `TLSDomainCertListEntry.expires_at`).
 *
 *  Multi-domain note. A server with several TLS hostnames hosts one
 *  cert per hostname; this hook returns the cert the source believes
 *  is the canonical first-pin target. **Adapter alignment constraint
 *  (Codex P2 fold):** the webclient's `selectServerUrl` prefers
 *  `server_address_hints.lan[0]` before `ddns` today, so an adapter
 *  that unconditionally returns the DDNS cert here would seed a
 *  fingerprint that doesn't match the address the client actually
 *  connects to — first cert-pin compare would reject the legitimate
 *  server as `cert_pin_mismatch`. Production wiring MUST either return
 *  the cert bound to the same hint `selectServerUrl` will pick, OR
 *  return null until the multi-domain model widens this field to
 *  domain-scoped pins. The policy lives in the adapter, not here;
 *  tests pass a fixed stub. */
export interface CertSource {
  getCurrentCert(): { fingerprint: string; valid_until: number } | null;
}
