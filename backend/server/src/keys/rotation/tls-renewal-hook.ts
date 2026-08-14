/** D-148 § A.6.5 — production `TlsRenewalHook` adapter backed by
 *  `SqliteTlsDomainStore` + an injected per-domain renewer.
 *
 *  Plugs into `RotationEngineOptions.tls` so `engine.renewTls(...)`
 *  (operator `tls.renew` rpc + housekeeping `tls-cert-renewal` task)
 *  reaches a real production path rather than the boot-time
 *  `key_not_loaded` default. The adapter resolves the canonical
 *  `tls_domains` row matching the address `selectServerUrl` will pick
 *  for paired clients (shared with `./pairing/address-hint-resolver.ts`
 *  so the cert source + the renewal hook never disagree on which row
 *  to operate on), then delegates the actual issuance to the injected
 *  `renewer`.
 *
 *  Renewer split. The renewer abstracts over the Pro / free-tier ACME
 *  paths:
 *    - Pro tier wires `RecuedAcmeClient.issueCert(...)` against the
 *      cloud `/v1/acme/issue-cert` helper, persists the new cert via
 *      `SqliteTlsDomainStore.upload({ source: 'pro_acme', ... })`, and
 *      reports the resulting fingerprint.
 *    - Free tier wires a local certbot/caddy reload + `tls_domains`
 *      upload through the existing `tls_domain.upload` rpc surface.
 *    - Test fakes pass a stub that emits canned `new_fingerprint`s.
 *
 *  Today's bin.ts composes the adapter with `renewer: null` because
 *  the Pro ACME composition (subscription token, publisher id, signer
 *  wiring) hasn't landed yet. The hook returns `helper_unavailable`
 *  unconditionally in that posture — the operator's `tls.renew` rpc
 *  reaches a clean closed-list error code instead of an undefined
 *  slot's `key_not_loaded`. The `tls-cert-renewal` housekeeping task
 *  registration stays gated on a separate `tlsRenewerConfigured`
 *  literal (see `bin.ts`) so the task doesn't emit one failed audit row
 *  per cooldown cycle (6h) while the renewer is still null.
 *
 *  Source filter. The adapter accepts the same optional `sources`
 *  filter as the cert source (`['pro_acme']` for ACME-managed-only
 *  flows; omitted for "first-pin acquisition + future BYO-renewer"
 *  fan-out). Production wiring in bin.ts pins `['pro_acme']` so a BYO-
 *  uploaded cert near expiry doesn't get sent to the ACME renewer —
 *  BYO rotates via operator re-upload through `tls_domain.upload` rpc.
 *
 *  Spec: D-148 § A.6.5. */

import type { TLSDomainCertSource } from '@recued/contracts';

import {
  resolveCanonicalDomain,
  withSha256Prefix,
  type ServerAddressHintsSnapshot,
} from '../../pairing/address-hint-resolver.js';
import type { SqliteTlsDomainStore } from '../../tls/domain-store.js';
import type { TlsRenewalFailureReason, TlsRenewalHook } from './index.js';

/** Per-domain renewer contract. The hook resolves which domain to
 *  renew; the renewer is responsible for the actual issuance + writing
 *  the new cert into `tls_domains` (so `getCurrentCert()` reflects the
 *  fresh row on subsequent cycles).
 *
 *  Return shape mirrors `TlsRenewalHook.renew()` minus
 *  `previous_fingerprint` (the hook fills that from the resolved row's
 *  pre-renewal fingerprint — the renewer doesn't need to read it). */
export interface DomainRenewer {
  renewDomain(args: { domain: string }): Promise<
    | {
        ok: true;
        new_fingerprint: string;
        /** D-235 P4 — the renewed cert's expiry, so a caller tracking per-row
         *  renewal state does not have to re-read the store (or, worse, call
         *  `issueInitialDomain` as a read) to learn when to come back. The
         *  renewer already holds this from its post-upload lookup; it simply
         *  used to drop it. */
        cert_expires_at: number;
      }
    | {
        ok: false;
        reason: TlsRenewalFailureReason;
      }
  >;
}

export interface DomainBackedTlsRenewalHookOptions {
  /** Synchronous hint reader — same shape the cert source consumes. */
  readHints: () => ServerAddressHintsSnapshot;
  /** Source of truth for per-domain rows. Only `list()` is used (sync,
   *  vault-lock-independent). */
  store: Pick<SqliteTlsDomainStore, 'list'>;
  /** Renewer for the resolved domain. `null` when production ACME
   *  wiring hasn't landed — the hook returns `helper_unavailable`
   *  without consulting the store. The substrate-shipped null posture
   *  lets `RotationEngineOptions.tls` stay populated (`tls.renew` rpc
   *  reaches a clean error code) while keeping the housekeeping task
   *  registration externally gated. */
  renewer: DomainRenewer | null;
  /** Restrict which `TLSDomainCertSource` values the adapter considers.
   *  Defaults to every source. Housekeeping production wiring pins
   *  `['pro_acme']` so BYO certs don't get sent to the ACME renewer. */
  sources?: ReadonlyArray<TLSDomainCertSource>;
}

export const createDomainBackedTlsRenewalHook = (
  options: DomainBackedTlsRenewalHookOptions,
): TlsRenewalHook => {
  const { readHints, store, renewer, sources } = options;
  return {
    async renew() {
      // No renewer wired → return `helper_unavailable` ahead of the
      // store probe. Keeps the substrate dependency-free at the
      // null-renewer posture (no list() call when nothing can be
      // renewed) + makes the `null` branch zero-cost on tight callers
      // (operator clicks "Renew now" 5× in 2s while the renewer is
      // still unwired).
      if (renewer === null) {
        return { ok: false, reason: 'helper_unavailable' };
      }
      const row = resolveCanonicalDomain({ readHints, store, sources });
      if (row === null) {
        // No matching ACME-managed row for the address paired clients
        // will hit. Three sub-cases collapse here: LAN-only/IP-only
        // posture (no domain row at all), BYO-only posture (filtered
        // out by `sources: ['pro_acme']`), or a Pro DDNS handle whose
        // ACME cert hasn't been provisioned yet. All three are "no
        // ACME work to do" from the rotation engine's perspective →
        // `helper_unavailable` lets the operator's `tls.renew` rpc
        // surface a closed-list error code rather than `key_not_loaded`.
        return { ok: false, reason: 'helper_unavailable' };
      }
      const previous_fingerprint = withSha256Prefix(row.fingerprint);
      const result = await renewer.renewDomain({ domain: row.domain });
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }
      return {
        ok: true,
        new_fingerprint: withSha256Prefix(result.new_fingerprint),
        previous_fingerprint,
      };
    },
  };
};
