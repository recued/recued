/** D-148 § A.6.5 — Recued ACME client factory backed by Pro auth refs.
 *
 *  Bridges three of the four Pro auth composition deps the 95th
 *  handover called out (Pro subscription token + publisher_id + signer)
 *  into a single `AcmeCertIssuer` substrate the renewer consumes. The
 *  fourth dep — Node-side `generateCsr` PKCS#10 emitter — lands in a
 *  separate slice and is the gate that flips `tlsRenewerConfigured` to
 *  true in `bin.ts`.
 *
 *  The renewer (`createAcmeDomainRenewer`, 95th) accepts an
 *  `AcmeCertIssuer` (`Pick<RecuedAcmeClient, 'issueCert'>`). The
 *  renewer doesn't care HOW the issuer resolves the Pro auth state — it
 *  calls `issueCert({ handle, csr_pem })` and maps the result onto its
 *  closed-list reason space (`helper_unavailable` /
 *  `subscription_required` / `storage_io_error`). The factory's job is
 *  to keep that bridge stable across two state-rotation surfaces:
 *
 *    - **Pro subscription lifecycle.** The bearer token rotates with
 *      the user's subscription renewal cadence. Re-authentication
 *      mints a fresh token; the substrate picks it up on the next
 *      renewal cycle without rebooting.
 *    - **Handle reservation lifecycle.** The `publisher_id` is stable
 *      per § A.5.1 but the user may transfer / re-reserve the handle
 *      (D-148 P8). The factory re-reads the resolver each cycle so a
 *      handle transfer that mints a new publisher_id is observed
 *      cleanly.
 *
 *  Per-call construction. `RecuedAcmeClient`'s constructor takes static
 *  `pro_subscription_token` + `publisher_id` strings. Constructing the
 *  client once at boot would freeze those values for the process
 *  lifetime — re-auth + handle change would require a restart. The
 *  factory wraps construction in the `issueCert` closure so each
 *  issuance reads the current state. Construction cost is negligible
 *  next to the cloud round-trip the issuance triggers (single HTTP POST
 *  with a CSR body).
 *
 *  Closed-list failure mapping. The factory pre-empts the cloud round-
 *  trip when substrate state is missing and synthesises an error that
 *  the renewer's existing `mapAcmeFailure` regex (`/\bHTTP 40[123]\b/`)
 *  routes to the right reason without modifying the renewer:
 *
 *    - `proAuth() === null` → `recued_acme_issue_failed: HTTP 401
 *      pro_auth_unavailable` → renewer maps to `subscription_required`
 *      (operator surfaces in Settings → Pro → authenticate).
 *    - `publisherId() === null` → `recued_acme_issue_failed: HTTP 400
 *      publisher_id_unavailable` → renewer maps to `helper_unavailable`
 *      (operator surfaces in Settings → Handle → reserve).
 *
 *  The synthetic HTTP status codes mirror the shape the cloud helper
 *  itself emits (`recued_acme_issue_failed: HTTP <status> <body>` —
 *  see `RecuedAcmeClient.issueCert`), so the error path is shape-
 *  indistinguishable from a real cloud-side rejection at the renewer's
 *  mapping layer. The body suffix (`pro_auth_unavailable` /
 *  `publisher_id_unavailable`) names the substrate gap for log
 *  consumers + audit scrapers without changing the routing logic.
 *
 *  Spec: D-148 § A.5.3 + § A.6.5. */

import { RecuedAcmeClient } from '@recued/server-network';

import type { AcmeCertIssuer } from './acme-domain-renewer.js';

/** Snapshot of the Pro subscription state — the bearer token the
 *  cloud helper validates on each `/v1/acme/issue-cert` call. The
 *  future Pro auth slice populates this through the resolver setter
 *  once the user completes the Pro authentication flow; the default
 *  resolver returns `null` so substrate-readiness gates surface
 *  cleanly. */
export interface ProAuthSnapshot {
  /** Bearer token. Sent as `Authorization: Bearer <token>` on each
   *  cloud helper call. Rotates with subscription lifecycle. */
  pro_subscription_token: string;
  /** Secret-free provenance for the resolver decision. */
  source?: 'binding_entitlement' | 'manual_token';
}

/** Pro auth state resolver. Returns the current snapshot or `null`
 *  when the user hasn't completed Pro authentication. Read per-call so
 *  a re-authenticated session lands on the next renewal cycle without
 *  rebooting the server. */
export type ProAuthResolver = () => ProAuthSnapshot | null | Promise<ProAuthSnapshot | null>;

/** D-175 P8b — Pro auth source selection. Binding-preferred AND
 *  binding-authoritative-when-present:
 *
 *    1. A resolved binding entitlement wins (the preferred path).
 *    2. Otherwise, if a binding credential IS stored but its entitlement
 *       did not resolve (account unbind/rebind, revoked owner, expired
 *       claim, or an unreachable mint), FAIL CLOSED — do NOT fall back to
 *       the legacy manual token. This is what makes account-ownership
 *       revocation actually stop actuation (D-175: "binding proves the
 *       account owns the conveniences"); a manual-token fallback here would
 *       keep a just-unbound server provisioning.
 *    3. Only a server with NO binding falls back to the manual
 *       `pro.authenticate` token — the D-148 migration path.
 *
 *  Pure + exported so the (otherwise closure-internal) cert-stack resolver
 *  decision is unit-testable. */
export const selectProAuth = (params: {
  bindingAuth: ProAuthSnapshot | null;
  hasStoredBinding: boolean;
  manualAuth: ProAuthSnapshot | null;
}): ProAuthSnapshot | null => {
  if (params.bindingAuth) return params.bindingAuth;
  if (params.hasStoredBinding) return null;
  return params.manualAuth;
};

/** Publisher_id resolver. Returns the user's stable opaque publisher
 *  id from the reserved-handle slice (D-148 P8) or `null` when no
 *  handle has been reserved. Read per-call to support handle transfer
 *  / re-reservation rotation cleanly. */
export type PublisherIdResolver = () => string | null;

/** Ed25519 signer producing a base64 signature. Same shape as
 *  `AcmeClientConfig.sign` from `@recued/server-network`. Wires to
 *  `ServerIdentity.signWithServerIdentity` directly — `ed25519Sign`
 *  returns base64 already, so no adapter is needed. */
export type AcmeRequestSigner = (payload: Uint8Array) => string;

export interface RecuedAcmeClientFactoryOptions {
  /** Cloud helper base URL — production `https://api.recued.cloud`.
   *  Future slice plumbs this through the same env / config knob that
   *  the DDNS adapter consumes. */
  cloud_base_url: string;
  /** Pro auth state resolver (lazy, per-call). */
  proAuth: ProAuthResolver;
  /** Publisher_id resolver (lazy, per-call). */
  publisherId: PublisherIdResolver;
  /** Ed25519 signer (base64 output). */
  sign: AcmeRequestSigner;
  /** Optional fetch override (tests). Pass-through to
   *  `RecuedAcmeClient`. */
  fetch?: typeof fetch;
  /** Optional `Date.now()` override (tests). Pass-through to
   *  `RecuedAcmeClient`. */
  now?: () => number;
}

/** Build an `AcmeCertIssuer` substrate the renewer consumes. Per-call
 *  resolves Pro auth + publisher_id then constructs a fresh
 *  `RecuedAcmeClient` for the issuance. Substrate state rotation
 *  (Pro re-auth / handle change) lands on the next call automatically. */
export const createRecuedAcmeClientFromRefs = (
  options: RecuedAcmeClientFactoryOptions,
): AcmeCertIssuer => {
  return {
    async issueCert(args) {
      const auth = await options.proAuth();
      if (auth === null) {
        // Synthetic HTTP 401 — the renewer's `mapAcmeFailure` regex
        // matches `\bHTTP 401\b` and maps to `subscription_required`.
        // The error body suffix names the substrate gap for log
        // consumers; the routing decision is the HTTP status alone.
        throw new Error(
          'recued_acme_issue_failed: HTTP 401 pro_auth_unavailable',
        );
      }
      const publisher_id = options.publisherId();
      if (publisher_id === null) {
        // Synthetic HTTP 400 — falls through the renewer's 401/402/403
        // pattern to the `helper_unavailable` default. Operator surface
        // is Settings → Handle (reserve a handle) rather than
        // Settings → Pro (re-authenticate).
        throw new Error(
          'recued_acme_issue_failed: HTTP 400 publisher_id_unavailable',
        );
      }
      const client = new RecuedAcmeClient({
        cloud_base_url: options.cloud_base_url,
        pro_subscription_token: auth.pro_subscription_token,
        publisher_id,
        sign: options.sign,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      return client.issueCert(args);
    },
  };
};
