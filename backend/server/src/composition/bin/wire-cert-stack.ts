/** D-148 § A.5.3 / § A.5.6 / § A.6.5 — TLS / identity composition stack.
 *
 *  Factored out of `bin.ts` (slice 103) so the inline composition for
 *  the rotation engine + Pro auth state machine + handle state machine
 *  + production cert source + production ACME renewer lives in one
 *  module rather than ~530 lines of sequential wiring inside `cmdServe`.
 *
 *  Two-phase composer. The same call site that materialises `db` +
 *  `signingIdentityRef` + `auditLog` + `eventBus` + `runtimeConfig`
 *  inside `cmdServe` invokes `composeCertStack(...)` to build the early
 *  surfaces (rotation engine + Pro auth state machine + setters), then
 *  later — after `tlsDomainStore` + `lanBindAddress` + `actualPort`
 *  materialise — invokes `.composeLate({...})` on the returned object
 *  to fill the cert source + production ACME renewer + handle state
 *  machine. The early phase is what `createServerHandlerSet` needs
 *  (for `tlsRenewDeps` + `proAuthDeps`); the late phase is what the
 *  `tls-cert-renewal` housekeeping registration needs.
 *
 *  Lateral-binding refs. `tlsRenewalHookRef` is forward-declared inside
 *  the composer so the rotation engine's `tls.renew()` slot can capture
 *  a stable closure that resolves the hook lazily; the same hook ref
 *  fills inside `composeLate` once the dependency chain materialises.
 *  Mirrors the same pattern bin.ts has used since the 88th slice — the
 *  engine composition lands first, the renewer + cert source chain
 *  lands later, and the engine's `tls` slot delegates to a proxy that
 *  returns `helper_unavailable` until fill.
 *
 *  Setters for the Pro auth + handle UI slices. The composer returns
 *  `setProAuthResolver` / `setPublisherIdResolver` so a future Settings
 *  → Pro / Settings → Handle UI rpc handler slice can populate the
 *  refs without re-composing the stack. The setters live as
 *  composer-local functions because the only callers are constructed
 *  inside the same `cmdServe` boot path.
 *
 *  Engine-driven `server_identity_key` rotation. The cert-stack wires
 *  the hooks the engine's `rotateServerIdentity` flow needs:
 *  - `save(next)` → `adoptServerIdentity(next)` (slice 103) so the
 *    in-memory keypair cache + `onServerIdentityRotated` listener stay
 *    coherent with direct callers of `rotateServerIdentity()`.
 *  - `revokeAllPairedClients()` → `pairedInstances.revokeAllActive()`
 *    inside a transaction; returns the captured instance_id list back
 *    to the engine for the `repair_client_ids` audit field.
 *  - `closeActiveSessions()` → `closeAllActiveSessions()` closure
 *    (captures `wsHandleForLockoutRef.revokeAllConnectedInstances()`
 *    lazily in bin.ts so the WS listener composes after the cert
 *    stack). Fan-out uses code 4003 + `instance_revoked` semantics.
 *    Post-D-156 P9: the `pair_required` broadcast slot is gone; the
 *    natural disconnect → unpaired-state → pair-form remount path
 *    handles `server_identity_key` rotation recovery (see the D-156
 *    spec § Q2 resolution + the webclient's `onReauthRequired` funnel).
 */

import type Database from 'better-sqlite3';

import {
  createCertRotationBroadcaster,
  createInMemoryCompromiseLedger,
  createRotationEngine,
  type RotationEngine,
  type TlsRenewalHook,
} from '../../keys/rotation/index.js';
import { createSqliteCompromiseLedger } from '../../keys/rotation/compromise-ledger-store.js';
import {
  createInMemoryTlsRenewCooldownStore,
  createSqliteTlsRenewCooldownStore,
} from '../../keys/rotation/tls-renew-cooldown-store.js';
import {
  buildKeyHealthView,
  type KeyRotationRpcDeps,
} from '../../keys/rotation/key-rotate-handler.js';
import type { CertSource } from '../../pairing/cert-source.js';
import { createSqliteBackedCertSource } from '../../pairing/sqlite-cert-source.js';
import type { ServerAddressHintsSnapshot } from '../../pairing/address-hint-resolver.js';
import { createDomainBackedTlsRenewalHook } from '../../keys/rotation/tls-renewal-hook.js';
import {
  createAcmeDomainRenewer,
  type AcmeManagedDomainIssuer,
} from '../../keys/rotation/acme-domain-renewer.js';
import {
  createRecuedAcmeClientFromRefs,
  selectProAuth,
  type AcmeRequestSigner,
  type ProAuthResolver,
  type PublisherIdResolver,
} from '../../keys/rotation/recued-acme-client-factory.js';
import { generateCsr } from '../../keys/rotation/generate-csr.js';
import {
  createHandleStateMachine,
  type HandleState,
  type HandleStateMachine,
  type HandleBroadcaster,
} from '../../handle/index.js';
import { createSqliteHandleStateStore } from '../../handle/sqlite-store.js';
import { createRecuedCloudHandleClient } from '../../handle/recued-cloud-client.js';
import {
  createProAuthStateMachine,
  type ProAuthState,
  type ProAuthStateMachine,
} from '../../pro-auth/index.js';
import { createSqliteProAuthStore } from '../../pro-auth/sqlite-store.js';
import {
  createHttpProEntitlementSource,
  resolveProEntitlementMintUrl,
  resolveProEntitlementPublicKey,
  type ProEntitlementSource,
} from '../../pro-convenience/entitlement-source.js';

import { hostnameForHandle, resolveProDdnsHost } from '@recued/contracts';
import type { KeyClass, RotationAvailability } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { ClientTokenStore } from '../../pairing/client-tokens.js';
import type { BootedServerIdentity } from '../../identity/boot.js';
import type { EventBus } from '../../events/bus.js';
import type { PairedInstancesStore } from '../../paired-instances-store.js';
import type { SqliteTlsDomainStore } from '../../tls/domain-store.js';

export interface CertStackEarlyDeps {
  /** `undefined` for daemon-only subcommands (start / stop / status /
   *  restart). When undefined the composer returns no rotation engine
   *  + no Pro auth machine; downstream wiring drops cleanly. */
  db: Database.Database | undefined;
  /** Wrapping signing audit log (see `bin.ts` ~ line 568). `undefined`
   *  iff `db` is undefined — the rotation engine's `effects.recordAudit`
   *  slot needs an audit sink, so the engine itself only composes when
   *  both `db` AND `auditLog` are present. */
  auditLog: AuditLogStore | undefined;
  /** Booted server identity. `undefined` for daemon-only subcommands
   *  (no `bootSigningIdentity()` was called). Engine composition
   *  pre-empts on `auditLog && db` so the closures that read
   *  `signingIdentity` are only reachable from cmdServe paths where the
   *  boot completed before the composer ran. */
  signingIdentity: BootedServerIdentity | undefined;
  eventBus: EventBus;
  /** Recued cloud API base URL (default `https://api.recued.cloud`). */
  cloudBaseUrl: string;
  /** Paired-instances substrate. The rotation engine's
   *  `revokeAllPairedClients` hook calls `revokeAllActive()` and
   *  returns the resulting instance_id list back to the engine for
   *  the `repair_client_ids` audit field + the bus replay window.
   *  `undefined` in daemon-only / dbless subcommands — the engine
   *  hook surfaces an empty id list there since no pair state exists. */
  pairedInstances: PairedInstancesStore | undefined;
  /** Per-client bearer-token substrate. The same engine hook that
   *  marks `paired_instances` rows revoked also calls
   *  `clientTokens.revokeAll(...)` so the bearer credentials behind
   *  every active WS session get retired in lockstep — otherwise a
   *  paired device whose pair-record is revoked could still re-auth
   *  against the rotated identity using its surviving bearer (the
   *  per-row revoke-at column on `client_tokens` is the substrate's
   *  authoritative gate; the WS-handshake bearer probe rejects on
   *  revoked rows). Constructor docstring on `ClientTokenStore.revokeAll`
   *  flags this exact use as the canonical caller. `undefined` in
   *  daemon-only / dbless subcommands — same dropout as
   *  `pairedInstances`. */
  clientTokens: ClientTokenStore | undefined;
  /** Closure that closes every currently-connected WS session with
   *  the `instance_revoked` semantic (code 4003 + vault-wipe message).
   *  Invoked from the engine's `closeActiveSessions` hook on
   *  `server_identity_key` rotation — after `revokeAllPairedClients`
   *  marks the DB rows revoked, this drives the WS-layer fan-out.
   *  Captured as a closure rather than a direct `WsServerHandle` ref
   *  because the listener composes AFTER the cert stack inside
   *  `cmdServe`; bin.ts passes a lazy resolver that reads the same
   *  `wsHandleForLockoutRef` the `closeAllForWsLockout` lockout flow
   *  already uses. Returns 0 when the listener isn't running. */
  closeAllActiveSessions: () => number;
  /** Environment view for D-175 P8b entitlement endpoint/public-key
   *  overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface CertStackLateDeps {
  /** SQLite-backed `tls_domains` row store. `undefined` in a dbless
   *  test harness — the late composer no-ops. */
  tlsDomainStore: SqliteTlsDomainStore | undefined;
  /** Where the server is REACHABLE on the LAN — not what the listener bound,
   *  which is `0.0.0.0` whenever a LAN address was detected. Feeds the hints
   *  reader the cert source + renewer share, and those hints are dialled
   *  (`wss://<addr>:<port>/ws`), so a wildcard here would publish nonsense. */
  lanAdvertisedAddress: string;
  /** Listener port the WS server actually opened on. */
  actualPort: number;
}

export interface CertStack {
  /** Production rotation engine. `undefined` when `db` or `auditLog`
   *  is absent. */
  rotationEngine: RotationEngine | undefined;
  /** R26.4 Delta 3 — `key.rotate` + `key.health` rpc deps (same engine +
   *  the compromise-ledger-backed health view). `undefined` whenever
   *  `rotationEngine` is. */
  keyRotateDeps: KeyRotationRpcDeps | undefined;
  /** Pro auth state machine. `undefined` when `db` is absent. */
  proAuthStateMachineRef: ProAuthStateMachine | undefined;

  /** Late-bound setters. Pro auth UI rpc + handle UI rpc handlers
   *  invoke these to populate the lateral-binding refs that the ACME
   *  factory closes over. The setters overwrite — single resolver per
   *  slot. Passing `null` clears so signed-out / released states route
   *  back through the closed-list `subscription_required` /
   *  `helper_unavailable` surfaces. */
  setProAuthResolver: (resolver: ProAuthResolver | null) => void;
  setPublisherIdResolver: (resolver: PublisherIdResolver | null) => void;

  /** Run the late composition. MUST be called once, after the
   *  dependency chain (`tlsDomainStore` + `lanBindAddress` +
   *  `actualPort`) materialises. Idempotent: late-double-call is a
   *  defensive no-op. */
  composeLate: (deps: CertStackLateDeps) => Promise<void>;

  /** Late accessors. All return `undefined` before `composeLate` is
   *  called (or in dbless harnesses where the late composer no-ops). */
  getTlsCertSourceRef: () => CertSource | undefined;
  getTlsRenewalHookRef: () => TlsRenewalHook | undefined;
  getInitialAcmeDomainIssuerRef: () => AcmeManagedDomainIssuer | undefined;
  getHandleStateMachineRef: () => HandleStateMachine | undefined;
  /** D-175 — the binding-entitlement resolver the ACME `proAuth` gates
   *  on, exposed so the Pro-convenience handle provisioner can gate the
   *  initial reservation on the SAME ownership claim (no second source).
   *  `undefined` for daemon-only subcommands (no booted identity). */
  getBindingEntitlementSource: () => ProEntitlementSource | undefined;
  /** D-148 § A.9 / slice 117 (Codex P1 fold) — passport-side cert
   *  source. Differs from `tlsCertSourceRef` in two ways:
   *
   *    1. `readHints` includes the DDNS hostname
   *       (`<current_handle>.recued.cloud`) when the handle state
   *       machine has a reserved row + a non-empty current_handle.
   *       Pro/DDNS deployments without a LAN row resolve through the
   *       DDNS branch instead of returning null + signing
   *       `cert_fingerprint: ''` (which would make the webclient verify
   *       primitive reject every reconnect as
   *       `cert_fingerprint_missing`).
   *    2. No `sources` filter — both `pro_acme` and `byo_upload`
   *       certs are eligible. The housekeeping `tls-cert-renewal`
   *       consumer filters to `pro_acme` because BYO certs rotate via
   *       user re-upload, but `passport.fetch` reports whichever cert
   *       is actively serving regardless of provenance.
   *
   *  The DDNS hostname snapshot is updated by the handle state
   *  machine's `onStateChanged` listener so post-reservation
   *  / `handle_change` transitions surface to the next fetch call
   *  without restart. `undefined` before composeLate or in dbless
   *  harnesses (same `tlsDomainStore` gate as `tlsCertSourceRef`).
   *
   *  D-156 P9 retired the pair-blob mint alias (`getPairBlobMintCertSourceRef`)
   *  that previously aliased this ref. Passport-fetch is now the sole
   *  consumer; the LAN-first / DDNS-fallback / no-source-filter semantics
   *  documented above remain unchanged. */
  getPassportCertSourceRef: () => CertSource | undefined;
  /** True iff the late composer wired the production ACME renewer.
   *  Gates the `tls-cert-renewal` housekeeping registration so the
   *  task only arms when the renewer has somewhere to renew. */
  getTlsRenewerConfigured: () => boolean;
}

/** Compose the full TLS / identity stack. See file header for the
 *  two-phase contract + lateral-binding rationale. */
export const composeCertStack = async (
  earlyDeps: CertStackEarlyDeps,
): Promise<CertStack> => {
  const {
    db,
    auditLog,
    signingIdentity,
    eventBus,
    cloudBaseUrl,
    pairedInstances,
    clientTokens,
    closeAllActiveSessions,
    env = process.env,
  } = earlyDeps;

  // D-148 § A.6.5 — cert-rotation broadcaster + rotation engine. See
  // the bin.ts in-line composition this code factored out of for the
  // full per-slot rationale; the comment-density here is intentionally
  // lower because the composer's role is wiring, not the substrate
  // contract. The substrate factories' own header comments remain the
  // authoritative reference for what each slot does.
  const certRotationBroadcaster = createCertRotationBroadcaster({ bus: eventBus });
  // R26.4 Delta 3 — durable compromise ledger when a db is present so a
  // compromise flag survives restart (the one case the in-memory ledger
  // drops: a class marked compromised that can't auto-rotate on this
  // realm — e.g. `master_dek` on self-host — keeps its alert until the
  // operator resolves it). Dbless subcommands fall back to in-memory.
  const rotationCompromiseLedger = db
    ? createSqliteCompromiseLedger(db)
    : createInMemoryCompromiseLedger();

  // Shared TLS-renewal cooldown clock. Durable when a db is present: a
  // cooldown a restart clears is a cooldown an impatient operator clears,
  // and the thing it protects — the CA's per-week duplicate-certificate
  // allowance — does not reset when the process does.
  const tlsRenewCooldown = db
    ? createSqliteTlsRenewCooldownStore(db)
    : createInMemoryTlsRenewCooldownStore();

  // Forward-declared so the rotation engine composition can capture a
  // closure that resolves the hook lazily. The fill site is inside
  // `composeLate(...)` further down — same pattern bin.ts has used for
  // the engine's `tls` slot since the 88th slice.
  let tlsRenewalHookRef: TlsRenewalHook | undefined;

  // D-148 § A.5.3 / § A.6.5 + D-175 P8b — Pro auth + publisher_id
  // resolver refs. The ACME factory consumes both lazily per renewal
  // cycle. Pro auth is now binding-preferred AND binding-authoritative-
  // when-present: the resolver first mints + locally verifies a short-lived
  // entitlement claim from the stored account binding; if a binding is
  // stored but its entitlement fails (unbind/rebind/revoked/unreachable) it
  // fails CLOSED; only a server with NO binding falls back to the manual
  // `pro.authenticate` token (the D-148 migration path), never a second
  // actuator. See `selectProAuth`.
  let proAuthResolverRef: ProAuthResolver | undefined;
  let publisherIdResolverRef: PublisherIdResolver | undefined;
  const bindingEntitlementSource = signingIdentity
    ? createHttpProEntitlementSource({
        loadBinding: () => signingIdentity.keyStore.loadAccountBinding(),
        getEndpointUrl: () =>
          resolveProEntitlementMintUrl({
            override: env.RECUED_PRO_ENTITLEMENT_MINT_URL,
            cloudBaseUrl,
          }),
        getPublicKeyB64: () =>
          resolveProEntitlementPublicKey({
            override: env.RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64,
            cloudBaseUrl,
          }),
      })
    : undefined;
  const resolveBindingProAuth: ProAuthResolver = async () => {
    const verified = await bindingEntitlementSource?.resolveClaim();
    return verified
      ? {
          pro_subscription_token: verified.entitlement_claim,
          source: 'binding_entitlement',
        }
      : null;
  };
  const hasStoredBinding = (): boolean => {
    if (!signingIdentity) return false;
    try {
      return signingIdentity.keyStore.loadAccountBinding() != null;
    } catch {
      // Indeterminate binding state → treat as present so we fail closed
      // (no manual-token fallback) rather than risk actuating after a
      // possible unbind/rebind.
      return true;
    }
  };
  const resolveProAuth: ProAuthResolver = async () => {
    const bindingAuth = await resolveBindingProAuth();
    const manualAuth = proAuthResolverRef ? await proAuthResolverRef() : null;
    // Binding-authoritative-when-present: a bound server whose entitlement
    // failed fails closed; only an unbound server uses the manual token.
    return selectProAuth({
      bindingAuth,
      hasStoredBinding: hasStoredBinding(),
      manualAuth,
    });
  };
  const resolvePublisherId: PublisherIdResolver = () =>
    publisherIdResolverRef ? publisherIdResolverRef() : null;
  const setProAuthResolver = (resolver: ProAuthResolver | null): void => {
    proAuthResolverRef = resolver ?? undefined;
  };
  const setPublisherIdResolver = (resolver: PublisherIdResolver | null): void => {
    publisherIdResolverRef = resolver ?? undefined;
  };

  // D-148 § A.5.3 — Ed25519 signer for the production ACME factory.
  // Closes over `signingIdentity` — the booted identity at composer
  // call time. Reaching this closure with `signingIdentity === undefined`
  // is structurally unreachable from any cmdServe rpc path (the
  // composer only composes the engine when `db && auditLog`, and both
  // are gated on the same lifecycle-lock-claim → bootSigningIdentity
  // sequence as `signingIdentity` itself).
  const signWithServerIdentity: AcmeRequestSigner = (payload) => {
    if (!signingIdentity) {
      throw new Error(
        'D-148 § A.5.3 — ACME signer invoked before identity boot. ' +
          '`bootSigningIdentity()` runs inside cmdServe after the ' +
          'lifecycle lock claim; this branch should be unreachable ' +
          'from any renewer path.',
      );
    }
    return signingIdentity.identity.signWithServerIdentity(payload);
  };

  const rotationEngine: RotationEngine | undefined = db && auditLog
    ? createRotationEngine({
        server_identity: {
          load: async () => {
            if (!signingIdentity) {
              throw new Error(
                'D-148 § A.6.5 — rotation engine invoked before identity boot. ' +
                  '`bootSigningIdentity()` runs inside cmdServe after the lifecycle ' +
                  'lock claim; this branch should be unreachable from any rpc.',
              );
            }
            return signingIdentity.identity.serverIdentityKey();
          },
          // D-148 § A.6.5 — engine-driven save. Slice 103 unification
          // step: route the persistence through `adoptServerIdentity`
          // so the in-memory keypair cache + `onServerIdentityRotated`
          // listener pipeline stay coherent with direct callers of
          // `ServerIdentity.rotateServerIdentity()`. The primitive
          // acquires the same per-class rotation mutex, persists via
          // the underlying `ServerKeyStore`, swaps the cached keypair
          // reference, then fires the listener — single source of
          // truth for the in-memory rotation path. The engine's
          // `effects.recordAudit` slot emits the audit row
          // independently of the listener (its production wiring lives
          // on the engine; the `onServerIdentityRotated` listener is
          // reserved for future cache-invalidation hooks). D-156 P9
          // retired the `effects.broadcastPairRequired` slot —
          // recovery flows through the webclient's `onReauthRequired`
          // funnel after the bearer revoke below.
          save: async (next) => {
            if (!signingIdentity) {
              throw new Error(
                'D-148 § A.6.5 — rotation engine invoked before identity boot. ' +
                  '`bootSigningIdentity()` runs inside cmdServe after the lifecycle ' +
                  'lock claim; this branch should be unreachable from any rpc.',
              );
            }
            await signingIdentity.identity.adoptServerIdentity(next);
          },
          // D-148 § A.6.5 — DB-side revoke. Two substrates fan out
          // here in lockstep: `paired_instances` (the device-pairing
          // roster — the user-visible "what devices are paired" list
          // backing Settings → Devices) AND `client_tokens` (the per-
          // client bearer credentials the WS handshake probes on
          // every connect). Revoking only the first would leave the
          // bearer rows active — a paired device with a surviving
          // bearer could re-auth against the rotated identity even
          // though its pair-record was revoked, undermining the
          // re-pair-required acceptance line of § A.6.5. The
          // `client_tokens.revokeAll` docstring explicitly names this
          // rotation flow as the canonical caller; running both inside
          // the same hook keeps the two substrates' active-set stays
          // in step.
          //
          // Engine surface: the returned `revoked_client_ids` carries
          // the `paired_instances.instance_id` list — that's what the
          // audit row's `repair_client_ids` field renders in Settings
          // → Audit + Key Health (device-level identity, not bearer-
          // level). The bearer revoke count is observed via the
          // `client_tokens` substrate's own surfaces.
          //
          // `pairedInstances === undefined` / `clientTokens === undefined`
          // only inside the dbless subcommand paths (start / stop /
          // status / restart) where the rotation engine itself doesn't
          // compose — the empty fallback is defensive belt-and-
          // suspenders.
          revokeAllPairedClients: async () => {
            const revoked_client_ids = pairedInstances
              ? pairedInstances.revokeAllActive()
              : [];
            if (clientTokens) {
              clientTokens.revokeAll('server_identity_rotated');
            }
            return { revoked_client_ids };
          },
          // D-148 § A.6.5 — WS-side fan-out. Captures the lazy closer
          // closure from bin.ts so the WS listener can compose after
          // the cert stack inside `cmdServe`. Returns 0 before the
          // listener is up — the engine still completes the rotation;
          // the next handshake from any disconnected client fails the
          // bearer check, the webclient's `onReauthRequired` funnel
          // wipes local state, and the pair-form remounts naturally
          // (D-156 P9 retired the bus-side re-pair broadcast).
          closeActiveSessions: async () => {
            return { closed_session_count: closeAllActiveSessions() };
          },
        },
        // D-148 § A.6.5 — lateral-binding `TlsRenewalHook` proxy.
        // Delegates to `tlsRenewalHookRef` after `composeLate(...)` fills
        // it; returns `helper_unavailable` before fill so the engine
        // surfaces a closed-list reason rather than `key_not_loaded`.
        tls: {
          async renew() {
            if (!tlsRenewalHookRef) {
              return { ok: false, reason: 'helper_unavailable' };
            }
            return tlsRenewalHookRef.renew();
          },
        },
        compromise_ledger: rotationCompromiseLedger,
        tls_renew_cooldown: tlsRenewCooldown,
        effects: {
          recordAudit: async (entry) => {
            const detail = {
              op: entry.op,
              key_class: entry.key_class,
              rotated_at: entry.rotated_at,
              ...(entry.new_fingerprint !== undefined
                ? { new_fingerprint: entry.new_fingerprint }
                : {}),
              ...(entry.repair_client_ids && entry.repair_client_ids.length > 0
                ? { repair_client_ids: entry.repair_client_ids }
                : {}),
              ...(entry.reencrypted_blob_count !== undefined
                ? { reencrypted_blob_count: entry.reencrypted_blob_count }
                : {}),
              compromise: entry.compromise,
              triggered_by_client_id: entry.triggered_by_client_id,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
              ...(entry.revert === true ? { revert: true } : {}),
            };
            await auditLog.logActivity({
              activity_id: '',
              timestamp: entry.rotated_at,
              action: 'key_rotation',
              target: entry.key_class,
              detail: JSON.stringify(detail),
            });
          },
          broadcast: async () => {
            // No `key_rotation` ServerEvent variant yet — the audit row
            // above is the persistent record; live client wakeups land
            // through `cert.rotation_notice` (renewTls / revertCert)
            // and `token.rotated` (per-client token rotation) today.
          },
          broadcastCertRotationNotice: certRotationBroadcaster.broadcastCertRotationNotice,
          broadcastCertRotationReverted: certRotationBroadcaster.broadcastCertRotationReverted,
        },
      })
    : undefined;

  // R26.4 Delta 3 (D-148 § A.11) — per-class rotation availability,
  // derived from which engine hooks this composer actually wired above.
  // `server_identity` + the lateral `tls` hook + `compromise_ledger` are
  // always wired inside the `db && auditLog` branch; `master_dek` /
  // `master_dek_reencryptor` / `publisher_identity` / `webclient_tokens`
  // / `webhook_secrets` are NOT (their substrates are dormant on a
  // self-host realm — System B / Master DEK is uninitialized). The Key
  // Health page reads this map to enable / point-elsewhere / grey each
  // class's action up front rather than surfacing `key_not_loaded` on
  // click. If a future slice wires one of the dormant hooks above, flip
  // the matching entry here in lockstep.
  //   - server_identity_key → `available`         (rotateServerIdentity wired)
  //   - tls_private_key      → `managed_elsewhere` (rotates via tls.renew / cert panel)
  //   - webclient_token      → `managed_elsewhere` (rotates via token.rotate / Settings → Clients)
  //   - everything else      → `unavailable`       (hook not composed → key_not_loaded)
  const rotationAvailability: Record<KeyClass, RotationAvailability> = {
    master_dek: 'unavailable',
    sub_dek: 'unavailable',
    server_identity_key: 'available',
    publisher_identity_key: 'unavailable',
    tls_private_key: 'managed_elsewhere',
    webclient_token: 'managed_elsewhere',
    webhook_secret: 'unavailable',
  };

  // R26.4 Delta 3 — `key.rotate` + `key.health` rpc deps. Reuses the SAME
  // composed `rotationEngine` (no second engine) + reads `compromise_alert`
  // back from the same compromise ledger the engine writes to. Gated on
  // the engine (absent → `keyRotateDeps` undefined → `key.*` returns
  // `not_configured`, exactly like `tls.renew`).
  const keyRotateDeps: KeyRotationRpcDeps | undefined = rotationEngine
    ? {
        engine: rotationEngine,
        loadHealthView: () =>
          buildKeyHealthView({
            availability: rotationAvailability,
            isCompromised: (key_class) => rotationCompromiseLedger.isMarked(key_class),
          }),
      }
    : undefined;

  // D-148 § A.5.3 / § A.6.5 — Pro auth state machine. SQLite-backed;
  // composes only when `db` is set. Restore-on-boot via the eager
  // `current()` call seeds `proAuthSnapshot` from the persisted row;
  // `setProAuthResolver(() => snapshot ? {...} : null)` wires the ACME
  // factory's resolver. The `onStateChanged` listener fires on
  // `pro.authenticate` / `pro.signOut` rpc invocations.
  let proAuthStateMachineRef: ProAuthStateMachine | undefined;
  let proAuthSnapshot: ProAuthState | null = null;
  if (db) {
    proAuthStateMachineRef = createProAuthStateMachine({
      store: createSqliteProAuthStore({ db }),
      onStateChanged: (state) => {
        proAuthSnapshot = state;
      },
    });
    proAuthSnapshot = await proAuthStateMachineRef.current();
    setProAuthResolver(() =>
      proAuthSnapshot
        ? {
            pro_subscription_token: proAuthSnapshot.pro_subscription_token,
            source: 'manual_token',
          }
        : null,
    );
  }

  // Late phase state.
  let tlsCertSourceRef: CertSource | undefined;
  let passportCertSourceRef: CertSource | undefined;
  let initialAcmeDomainIssuerRef: AcmeManagedDomainIssuer | undefined;
  let handleStateMachineRef: HandleStateMachine | undefined;
  let publisherIdSnapshot: string | null = null;
  // D-148 § A.9 / slice 117 (Codex P1 fold) — sync snapshot of the
  // canonical DDNS hostname (`<current_handle><default-zone.suffix>`).
  // Captured from the handle state machine's `onStateChanged` listener
  // so the passport cert source's `readHints` callback observes post-
  // reservation / `handle_change` transitions without restart. Stays
  // null in: (a) pre-reservation boots, (b) post-`released`-lifecycle
  // states (per `computeHandleSnapshot`'s gates), (c) dbless harnesses
  // where the handle state machine never composes. The passport
  // composer below treats null as "no DDNS in hints" — the resolver
  // falls through to LAN-only resolution.
  let currentDdnsHostSnapshot: string | null = null;
  let lateComposed = false;

  const computeDdnsHost = (state: HandleState | null): string | null => {
    if (!state) return null;
    if (state.subscription_state === 'released') return null;
    if (!state.current_handle || state.current_handle.length === 0) return null;
    // D-176 — resolve through the enabled-zone registry (default
    // `.recued.net`) rather than the retired `.recued.cloud` hardcode,
    // so the passport read-hints DDNS host matches the zone ACME +
    // DDNS actually use.
    return hostnameForHandle(state.current_handle);
  };

  /** D-235 — the bare handle the custom-domain order rides on, DERIVED from the
   *  same snapshot rather than kept as a second field. A parallel
   *  `currentHandleSnapshot` would be one more thing that can disagree with the
   *  DDNS host by one state transition; `resolveProDdnsHost` is the exact
   *  inverse of `hostnameForHandle`, so this round-trips and cannot drift.
   *  Null whenever the DDNS host is null — released subscription, no handle
   *  yet, or the state machine never composed — which is precisely when a
   *  custom-domain order should decline rather than guess. */
  const currentOwnHandle = (): string | null =>
    currentDdnsHostSnapshot === null
      ? null
      : resolveProDdnsHost(currentDdnsHostSnapshot)?.handle ?? null;

  const computeHandleSnapshot = (state: HandleState | null): string | null => {
    // Codex P2 fold #1 (from the 101st slice) — snapshot only carries
    // publisher_id when the local pair STILL OWNS a current_handle AND
    // the cloud-side lifecycle hasn't released the row. After
    // transfer-out / `'released'` lifecycle the substrate keeps
    // `publisher_id` (stable per § A.5.1) but zeroes `current_handle`;
    // returning `null` instead lands cleanly on
    // `publisher_id_unavailable` → `helper_unavailable`.
    if (!state) return null;
    if (state.subscription_state === 'released') return null;
    if (!state.current_handle || state.current_handle.length === 0) return null;
    if (!state.publisher_id || state.publisher_id.length === 0) return null;
    return state.publisher_id;
  };

  const composeLate = async (lateDeps: CertStackLateDeps): Promise<void> => {
    if (lateComposed) return;
    lateComposed = true;
    const { tlsDomainStore, lanAdvertisedAddress, actualPort } = lateDeps;

    // D-148 § A.6.5 — production cert-source composition. `sources:
    // ['pro_acme']` filters BYO-uploaded certs out of the housekeeping
    // consumer. The passport-side composer below omits the filter so
    // first-pin acquisition covers BYO too.
    if (tlsDomainStore) {
      tlsCertSourceRef = createSqliteBackedCertSource({
        readHints: () => ({
          lan: [`wss://${lanAdvertisedAddress}:${actualPort}/ws`],
        }),
        store: tlsDomainStore,
        // D-235 — BOTH fleet-issued sources. The filter's job is to keep
        // user-managed BYO certs out of this consumer, not to name one source;
        // a custom domain the fleet issued and renews belongs on the same side
        // of that line as the Pro DDNS host.
        sources: ['pro_acme', 'pro_acme_custom'],
      });

      // D-148 § A.9 / slice 117 (Codex P1 fold) — passport-side cert
      // source. See `getPassportCertSourceRef` JSDoc on the CertStack
      // interface for the two intentional deltas from
      // `tlsCertSourceRef`: DDNS in readHints + no source filter.
      //
      // The readHints closure re-reads `currentDdnsHostSnapshot` on
      // every call, so a `handle_changed` listener fire that mutates
      // the snapshot lets the very next `passport.fetch` call resolve
      // through the new hostname without re-composing the source.
      // Same for `lanBindAddress` / `actualPort` (snapshotted at
      // composeLate fill time — listener changes are out of scope for
      // this phase; LAN listener rotations would require a wider seam).
      const passportReadHints = (): ServerAddressHintsSnapshot => {
        const hints: ServerAddressHintsSnapshot = {
          lan: [`wss://${lanAdvertisedAddress}:${actualPort}/ws`],
        };
        if (currentDdnsHostSnapshot !== null) {
          hints.ddns = `wss://${currentDdnsHostSnapshot}:${actualPort}/ws`;
        }
        return hints;
      };
      passportCertSourceRef = createSqliteBackedCertSource({
        readHints: passportReadHints,
        store: tlsDomainStore,
        // No `sources` filter — both `pro_acme` + `byo_upload` rows
        // count. Webclient's pinned cert was first acquired at pair
        // time from whichever cert was actively serving; passport must
        // report from the same provenance-agnostic pool.
      });

      // D-148 § A.6.5 — production `TlsRenewalHook`. Hints reader +
      // source filter mirror `tlsCertSourceRef` so the two adapters
      // always agree on which canonical row to operate on — drift
      // would break the first-cert-pin compare on rotated fingerprints
      // (`cert_pin_mismatch`).
      const acmeDomainIssuer = createAcmeDomainRenewer({
        acme: createRecuedAcmeClientFromRefs({
          cloud_base_url: cloudBaseUrl,
          proAuth: resolveProAuth,
          publisherId: resolvePublisherId,
          sign: signWithServerIdentity,
        }),
        store: tlsDomainStore,
        generateCsr,
        // D-235 — read at CALL time, not captured: the handle state machine
        // composes AFTER this line (line ~735 below), so a captured value would
        // pin null and silently disable every custom-domain order with
        // everything typed and green. Same shape as `resolveProAuth` /
        // `resolvePublisherId` above, and the same defect they were fixing.
        resolveOwnHandle: currentOwnHandle,
      });
      initialAcmeDomainIssuerRef = acmeDomainIssuer;

      tlsRenewalHookRef = createDomainBackedTlsRenewalHook({
        readHints: () => ({
          lan: [`wss://${lanAdvertisedAddress}:${actualPort}/ws`],
        }),
        store: tlsDomainStore,
        renewer: acmeDomainIssuer,
        // D-235 — see the note on the cert source above. ⚠ This makes the
        // EXISTING hook renew a custom domain only when it is the canonical
        // address a client connects to (`resolveCanonicalDomain` picks exactly
        // one row). A server with the Pro DDNS host as its canonical address
        // and N custom domains alongside still needs the per-row walker; that
        // is P4, and until it lands those rows are issued but not renewed.
        sources: ['pro_acme', 'pro_acme_custom'],
      });
    }

    // D-148 § A.5.6 — handle state machine. SQLite-backed; composes
    // only when `db`, `signingIdentity`, AND `auditLog` are all set.
    // The boot-time `current()` call seeds `publisherIdSnapshot` from
    // the persisted blob so a handle reserved on a prior run
    // propagates immediately. `setPublisherIdResolver(...)` wires the
    // ACME factory's resolver.
    //
    // Broadcast bus: the substrate's `HandleBroadcaster.broadcast(...)`
    // emits `{ type: 'handle_changed', ... }`. There is no
    // `'handle_changed'` kind in `ALL_BROADCAST_EVENT_KINDS` yet — the
    // future Settings → Handle UI rpc slice extends the union + drives
    // a webclient handler that refreshes the user-visible label. For
    // now, the broadcaster swallows; no client-visible mutation paths
    // reach `changeHandle` / `transferHandleOut` (the rpc handlers
    // haven't shipped) so the broadcast site stays dormant.
    if (db && signingIdentity && auditLog) {
      const identity = signingIdentity.identity;
      const handleBroadcaster: HandleBroadcaster = {
        broadcast() {
          // No-op pending the wire-event union widen — see comment above.
        },
      };
      handleStateMachineRef = createHandleStateMachine({
        store: createSqliteHandleStateStore({ db }),
        cloud: createRecuedCloudHandleClient({ cloud_base_url: cloudBaseUrl }),
        audit: { log: (entry) => auditLog.logActivity(entry) },
        broadcaster: handleBroadcaster,
        serverIdentity: () => identity.serverIdentityKey(),
        onStateChanged: (state) => {
          publisherIdSnapshot = computeHandleSnapshot(state);
          currentDdnsHostSnapshot = computeDdnsHost(state);
        },
      });
      const boot = await handleStateMachineRef.current();
      publisherIdSnapshot = computeHandleSnapshot(boot);
      currentDdnsHostSnapshot = computeDdnsHost(boot);
      setPublisherIdResolver(() => publisherIdSnapshot);
    }
  };

  return {
    rotationEngine,
    keyRotateDeps,
    proAuthStateMachineRef,
    setProAuthResolver,
    setPublisherIdResolver,
    composeLate,
    getTlsCertSourceRef: () => tlsCertSourceRef,
    getPassportCertSourceRef: () => passportCertSourceRef,
    getTlsRenewalHookRef: () => tlsRenewalHookRef,
    getInitialAcmeDomainIssuerRef: () => initialAcmeDomainIssuerRef,
    getHandleStateMachineRef: () => handleStateMachineRef,
    getBindingEntitlementSource: () => bindingEntitlementSource,
    getTlsRenewerConfigured: () => tlsRenewalHookRef !== undefined,
  };
};
