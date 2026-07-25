/** D-148 § A.6.5 — production `CertSource` adapter backed by
 *  `SqliteTlsDomainStore`.
 *
 *  The cert source feeds two consumers today:
 *   1. The passport-fetch first-pin path — fills `cert_pin_state` so a
 *      freshly-paired client commits its cert pin at pair time instead
 *      of waiting for the first `cert.rotation_notice` after cert
 *      provisioning (D-148 § A.6.5 first-pin acquisition).
 *   2. `tls-cert-renewal` housekeeping task — reads `getCurrentCert()`
 *      every cycle to decide whether the active cert is within the
 *      renewal-window threshold (default 30 days).
 *
 *  Address-hint resolution + fingerprint formatting live in the shared
 *  `./address-hint-resolver.ts` so the sister `TlsRenewalHook` adapter
 *  (`../keys/rotation/tls-renewal-hook.ts`) picks the same canonical
 *  row by construction. A drift would seed pin-fingerprint X while the
 *  renewer rotates cert Y → first-cert-pin compare on the renewed
 *  fingerprint fails as `cert_pin_mismatch`.
 *
 *  Why `list()` not `lookup()`. `lookup()` walks the in-RAM decrypted-
 *  private-key cache (vault must be unlocked + `warmCache()` must have
 *  run). The cert source doesn't need the private key — only the
 *  public fingerprint + expiry. `list()` reads pure SQLite columns, is
 *  synchronous, and works regardless of vault-lock state. The
 *  housekeeping cycle is idle-driven; it must not fail just because
 *  the operator hasn't unlocked the vault since boot.
 *
 *  Substrate-before-wiring. Today's bin.ts hints provider has no DDNS
 *  source and binds LAN plaintext, so the adapter typically returns
 *  null. The follow-up that wires Pro DDNS (`isConfigured` flips true)
 *  + ACME-issued certs into `tls_domains` flips the cert source live.
 *  No code change here when that lands — the alignment is already in.
 *
 *  Spec: `docs/d-148-spec.md` § A.6.5. */

import type { TLSDomainCertSource } from '@recued/contracts';
import type { CertSource } from './cert-source.js';
import type { SqliteTlsDomainStore } from '../tls/domain-store.js';
import {
  resolveCanonicalDomain,
  withSha256Prefix,
  type ServerAddressHintsSnapshot,
} from './address-hint-resolver.js';

// Re-export so existing callers / tests that import the hint shape
// from this module keep their imports stable post-extraction.
export type { ServerAddressHintsSnapshot } from './address-hint-resolver.js';

export interface SqliteCertSourceOptions {
  /** Synchronous hint reader. Production wiring threads
   *  `lanBindAddress` + `actualPort` + (future) DDNS host through here.
   *  Reading on every `getCurrentCert()` call (rather than capturing a
   *  snapshot at construction time) lets the housekeeping cycle observe
   *  listener changes — e.g., after a Pro DDNS toggle without server
   *  restart. */
  readHints: () => ServerAddressHintsSnapshot;
  /** Production source of truth for per-domain certs. */
  store: Pick<SqliteTlsDomainStore, 'list'>;
  /** Restrict which `TLSDomainCertSource` values the adapter considers.
   *  Defaults to allowing every source. Housekeeping's
   *  `tls-cert-renewal` task passes `['pro_acme']` because BYO-uploaded
   *  certs rotate by user re-upload (not via the rotation engine's
   *  ACME helper); auto-renewing one would request an ACME issuance
   *  for a hostname the user manages out-of-band. The passport-fetch
   *  consumer wires this open (all sources) since first-pin acquisition
   *  is correct regardless of provenance. */
  sources?: ReadonlyArray<TLSDomainCertSource>;
}

export const createSqliteBackedCertSource = (
  options: SqliteCertSourceOptions,
): CertSource => {
  const { readHints, store, sources } = options;
  return {
    getCurrentCert(): { fingerprint: string; valid_until: number } | null {
      const row = resolveCanonicalDomain({ readHints, store, sources });
      if (row === null) return null;
      return {
        fingerprint: withSha256Prefix(row.fingerprint),
        valid_until: row.expires_at,
      };
    },
  };
};
