/** D-148 § A.5.4 + § A.17 — TLS integration mode resolver.
 *
 *  The server can run in one of three TLS modes:
 *
 *    `recued-acme` (Pro) — server holds the TLS keypair locally;
 *      the Recued cloud ACME helper issues + renews certs via
 *      DNS-01 against `<handle>.recued.cloud`.
 *
 *    `certbot` (free) — TLS terminated upstream by certbot-managed
 *      nginx (or Apache). The server's `tls_private_key` slot is
 *      empty; the WS / Webhook / MCP / Reception listeners bind
 *      to plaintext and trust the upstream proxy. Setup guide:
 *      internal design notes.
 *
 *    `caddy` (free) — TLS terminated upstream by Caddy. Caddy
 *      auto-handles ACME (DNS-01 or HTTP-01 if publicly reachable).
 *      Same shape as `certbot`. Setup guide: internal design notes.
 *
 *  The mode discriminator gates which P5 substrate paths run:
 *  `recued-acme` runs the cert-renewal task against the cloud ACME
 *  helper; `certbot` / `caddy` skip the renewal path entirely
 *  (upstream handles it) and rely on Reachability Doctor to
 *  surface upstream cert-expiry warnings.
 *
 *  P6 wires the per-mode listener bind logic; P5 ships the
 *  resolver.
 */

export const TLS_INTEGRATION_MODES = ['recued-acme', 'certbot', 'caddy'] as const;

export type TlsIntegrationMode = (typeof TLS_INTEGRATION_MODES)[number];

export const isTlsIntegrationMode = (s: string): s is TlsIntegrationMode =>
  (TLS_INTEGRATION_MODES as ReadonlyArray<string>).includes(s);

/** Mode-specific configuration. The resolver reads this off the
 *  server's bootstrap config (`config.toml` or env vars) and
 *  returns a typed shape the listener layer can act on. */
export interface TlsIntegrationConfig {
  mode: TlsIntegrationMode;
  /** Path to the cert PEM on disk. Used by `certbot` + `caddy`
   *  modes (read by the upstream proxy, not the server). For
   *  `recued-acme` mode, this is where the Recued ACME client
   *  writes the issued cert. */
  cert_path?: string;
  /** Path to the TLS private key PEM on disk. ONLY set for
   *  `recued-acme` mode — the server holds the keypair. For
   *  `certbot` / `caddy` modes this is empty (the upstream proxy
   *  holds the key). D-148 invariant I-5: the key never leaves
   *  the server, but it also never enters the application — the
   *  TLS termination layer reads it directly. */
  tls_key_path?: string;
  /** Set when mode is `certbot` or `caddy` and the listener should
   *  bind plaintext (TLS terminated upstream). */
  listener_plaintext?: boolean;
}

/** Resolve a typed config from a partial input. Validates the
 *  mode + ensures the per-mode required fields are present. The
 *  input `mode` is `string` (not narrowed to `TlsIntegrationMode`)
 *  so callers can hand off arbitrary user-config strings; this
 *  function's body widens the closed-list check. */
export const resolveTlsIntegration = (
  raw: { mode: string } & Partial<Omit<TlsIntegrationConfig, 'mode'>>,
): TlsIntegrationConfig => {
  if (!isTlsIntegrationMode(raw.mode)) {
    throw new Error(
      `tls_integration_mode_invalid: '${raw.mode}' (allowed: ${TLS_INTEGRATION_MODES.join(', ')})`,
    );
  }
  switch (raw.mode) {
    case 'recued-acme':
      if (!raw.cert_path || !raw.tls_key_path) {
        throw new Error(
          'tls_integration_recued_acme_missing_paths: cert_path + tls_key_path required',
        );
      }
      return {
        mode: 'recued-acme',
        cert_path: raw.cert_path,
        tls_key_path: raw.tls_key_path,
        listener_plaintext: false,
      };
    case 'certbot':
    case 'caddy':
      // Upstream-terminated. The cert_path is informational (the
      // doctor reads it to surface expiry warnings); the
      // tls_key_path MUST be absent because the server doesn't see
      // the key in these modes.
      if (raw.tls_key_path) {
        throw new Error(
          `tls_integration_${raw.mode}_unexpected_key_path: upstream proxy holds the key`,
        );
      }
      return {
        mode: raw.mode,
        cert_path: raw.cert_path,
        listener_plaintext: true,
      };
  }
};
