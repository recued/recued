/** D-148 § A.6.5 + § A.9 — passport.fetch substrate composer.
 *
 *  Builds `PassportFetchRpcDeps` for the rpc surface the webclient's
 *  post-WS-connect verify path calls on every successful reconnect.
 *  Threads the signed projection through `verifyPassportCertAttestation`
 *  to seed / promote / re-pair its pinned cert lineage. The handler
 *  delegates to `exportServerPassport` against the same
 *  `PassportBlockProviders` shape `passport.export` consumes — minus
 *  the audit row + history store wiring per the audit-exemption
 *  rationale in `passport/fetch-handler.ts` (reconnect cadence would
 *  flood the ledger).
 *
 *  The verify primitive consumes exactly two fields from the response:
 *    1. `identity.server_public_key` — replay-defense against a
 *       passport signed by a different identity that's been swapped
 *       into the mismatched signature transcript.
 *    2. `network.cert_fingerprint` — the observed-cert claim the
 *       pin-state transition (`seeded` / `promoted` / `idempotent` /
 *       `observed_fingerprint_unknown`) gates on.
 *  The rest of the projection is signed-over but unread; the
 *  capability / recovery / key_health blocks ship conservative
 *  defaults because `support_redacted` collapses most of them into
 *  summaries (clients_by_kind) or strips them entirely.
 *
 *  Two live-read seams matter:
 *    1. `loadNetwork` resolves the cert source per-call via
 *       `certStack.getPassportCertSourceRef()` — the production cert
 *       source materialises in `certStack.composeLate(...)` AFTER
 *       this composer runs. Reading through the accessor keeps deps
 *       construction here + observation-time fresh. The passport
 *       accessor differs from `getTlsCertSourceRef()` (Codex
 *       2026-05-17 P1 fold): it includes DDNS in readHints + omits
 *       the `pro_acme` source filter so BYO certs + DDNS-keyed certs
 *       both resolve.
 *    2. `serverIdentity` getter (Codex 2026-05-17 P1 fold) reads
 *       through `identityRef.identity.serverIdentityKey()` per call —
 *       the identity manager's mutable cache means a rotation between
 *       deps construction + an rpc call signs with the LIVE keypair.
 *       Pre-fold this field captured the boot-time keypair by value,
 *       so post-rotation fetch responses would have shipped a stale
 *       signature against `loadIdentity()`'s live public key — every
 *       verify path would reject as `signature_invalid` until restart.
 *
 *  Gate: `db && signingIdentity` → otherwise `undefined`, and the
 *  caller drops the slice from `createServerHandlerSet`. The rpc
 *  surface returns `not_configured`; the webclient bootstrap surfaces
 *  the failure via `onPassportFetchVerifyError` with `stage: 'rpc'`
 *  and keeps its pin state intact.
 *
 *  Channel-isolation invariant: `passport.` is in
 *  `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot reach
 *  this surface even when wired. */

import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';
import type { BootedServerIdentity } from '../../identity/boot.js';
import type { CertStack } from './wire-cert-stack.js';
import type { PassportFetchRpcDeps } from '../../passport/fetch-handler.js';
import type { PassportUserRpcDeps } from '../../passport/export-handler.js';
import { createPassportAuditEmitter } from '../../passport/index.js';
import { createSqlitePassportHistoryStore } from '../../passport/history-store.js';
import { DEFAULT_EXPOSURE_STATE } from '../../exposure/index.js';
import type { ExposureStateMachine } from '../../exposure/index.js';
import type { PairedInstancesStore } from '../../paired-instances-store.js';
import type { ServerPassportNetworkBlock } from '@recued/contracts';

/** Inputs. Both gate handles are passed as `T | undefined` so the
 *  caller can feed the same let-binding refs it holds today. `certStack`
 *  is required (it's always built by the time this composer is invoked
 *  in cmdServe — composeCertStack runs upstream). */
export interface ComposePassportFetchSubstrateDeps {
  readonly db: Database.Database | undefined;
  readonly signingIdentity: BootedServerIdentity | undefined;
  readonly certStack: CertStack;
  /** R26.4 Delta 2 — audit sink for the user-initiated `passport.export`
   *  high-assurance row. Absent (db-less harness, or a boot whose audit
   *  log hasn't composed) → the user-export bundle is `undefined` and
   *  `passport.export` / `passport.history.list` return `not_configured`,
   *  while `passport.fetch` (which needs no audit) stays live. */
  readonly auditLog?: AuditLogStore | undefined;
  /** Late-bound accessor for the live `ExposureStateMachine` (composed in
   *  `composeLate`, downstream of this composer — read per-call). Lets
   *  `loadNetwork` report the REAL exposure posture
   *  (`derived_preset_label` / `per_path` / `public_mcp_acknowledgement`)
   *  instead of a hardcoded `lan_only` stub. Optional — absent (db-less
   *  harness, or a test that doesn't wire it) → `loadNetwork` falls back to
   *  the conservative `DEFAULT_EXPOSURE_STATE`. */
  readonly getExposureMachine?: () => ExposureStateMachine | undefined;
  /** Paired-instances store, for the passport `clients` roster. Optional —
   *  absent (db-less harness / a test that doesn't wire it) → `loadClients`
   *  returns an empty roster (the prior honest default). Read via the
   *  cross-user `listAllActive()` since this composer holds no user_id. */
  readonly pairedInstances?: PairedInstancesStore | undefined;
}

/** Bundle. `passportFetchDeps` mirrors the let-binding bin.ts threads
 *  into `createServerHandlerSet`; `passportUserRpcDeps` (R26.4 Delta 2)
 *  carries the export + history-list deps as a single sibling field. */
export interface PassportFetchSubstrateBundle {
  readonly passportFetchDeps: PassportFetchRpcDeps;
  /** Present iff `db && auditLog` — the user-export half needs the audit
   *  sink + the history store; the fetch half needs neither. */
  readonly passportUserRpcDeps: PassportUserRpcDeps | undefined;
}

/** Compose the passport.fetch substrate. Returns `undefined` when
 *  either gate handle is missing so the caller spreads `{}` into the
 *  handler-set args (db-less harness path; pre-identity-boot path). */
export const composePassportFetchSubstrate = (
  deps: ComposePassportFetchSubstrateDeps,
): PassportFetchSubstrateBundle | undefined => {
  if (!deps.db || !deps.signingIdentity) {
    return undefined;
  }

  const identityRef = deps.signingIdentity;
  const certStack = deps.certStack;
  const db = deps.db;
  const getExposureMachine = deps.getExposureMachine;
  const pairedInstances = deps.pairedInstances;

  const passportFetchDeps: PassportFetchRpcDeps = {
    providers: {
      loadIdentity: async () => {
        const serverKey = identityRef.identity.serverIdentityKey();
        const publisherKey = identityRef.identity.publisherIdentityKey();
        // `publisher_id` is the LIVE server-identity fingerprint, sourced from
        // the key — NOT from the handle state. Under D-175 the ratified
        // identity contract is `publisher_id == server_fingerprint ==
        // serverIdentity().public_key_fingerprint`, which exists from first
        // boot: a handle reservation merely anchors that fingerprint to a name
        // at the cloud, it does not mint the publisher_id. `HandleState`'s own
        // `publisher_id` is '' pre-reservation and can lag the live key across
        // a `server_identity_key` rotation, so reading it here would (a) emit
        // an empty `publisher_id` that the import consumer rejects as
        // `identity_block_incomplete`, and (b) risk diverging from
        // `server_identity_fingerprint` above — the field the import commit
        // treats as the canonical (verified) old publisher_id. Sourcing both
        // from the live key keeps them equal by construction.
        //
        // `current_handle` + `handle_history` ARE the genuine handle lineage —
        // read from the HandleStateMachine when it has materialised a
        // reservation (it comes online in `certStack.composeLate(...)`, so
        // read it through the ref per-call). Absent a materialised machine, or
        // a machine with no reservation yet, an empty handle + empty history is
        // the honest pre-reservation default. `support_redacted` strips
        // `publisher_id` + `handle_history` entirely (keeping only
        // `current_handle`); the full lineage rides only in
        // `enterprise_audit` / `migration_full`.
        // The handle lineage is the ONLY fallible read in this provider, and
        // `passport.fetch` (the reconnect cert-pin verify) reaches it on every
        // WS reconnect — yet that verify consumes only `server_public_key` +
        // `cert_fingerprint` (see file header), never the handle fields. A
        // no-reservation server re-hits the store on every call (the state
        // machine caches only a non-null state — handle/index.ts loadOrInit),
        // so a transient store error (e.g. SQLITE_BUSY under a concurrent
        // housekeeping write) must NOT fail the reconnect. Degrade to empty
        // handle fields on error; publisher_id + the keys are always available.
        //
        // This never silently drops REAL lineage from a `migration_full`
        // export: any server that HAS history has had a reservation, so its
        // `current()` is served from the in-memory cache warmed at boot
        // (`wire-cert-stack` composeLate) and cannot reject — the catch only
        // fires for the no-reservation case (no lineage to lose) or a
        // catastrophic DB failure (which already fails every other rpc loudly).
        const handleState = await (async () => {
          try {
            return (await certStack.getHandleStateMachineRef()?.current()) ?? null;
          } catch {
            return null;
          }
        })();
        return {
          server_public_key: serverKey.public_key_b64,
          server_identity_fingerprint: serverKey.public_key_fingerprint,
          publisher_id: serverKey.public_key_fingerprint,
          current_handle: handleState?.current_handle ?? '',
          // Map each history row to the passport's `{ handle, reserved_at,
          // released_at? }` subset — the closed-list `reason`, free-text `note`
          // (potential PII), and transfer-counterparty stay server-internal;
          // the passport carries a portable lineage summary, not audit detail.
          // `released_at` is type-guarded (not just `!== undefined`): the
          // SQLite store validator (sqlite-store.ts) doesn't check its type, so
          // this is the boundary that keeps a malformed persisted value out of
          // the SIGNED passport.
          handle_history: (handleState?.handle_history ?? []).map((h) => ({
            handle: h.handle,
            reserved_at: h.reserved_at,
            ...(typeof h.released_at === 'number' ? { released_at: h.released_at } : {}),
          })),
          publisher_identity_fingerprint:
            publisherKey.public_key_fingerprint,
        };
      },
      loadNetwork: async () => {
        // Codex 2026-05-17 P1 fold (slice 117) — use the passport-
        // specific cert source, not `tlsCertSourceRef`. The housekeeping-
        // facing `tlsCertSourceRef` filters to `pro_acme` AND reads
        // hints with LAN-only entries, so on a Pro/DDNS deployment
        // (cert row keyed on `<handle>.recued.cloud`, no LAN row) the
        // resolver returns null → `cert_fingerprint: ''` → webclient
        // verify primitive rejects every reconnect as
        // `cert_fingerprint_missing`. The passport source omits the
        // sources filter AND includes DDNS in hints when the handle
        // state machine has a reserved `current_handle`. See
        // `cert-stack.ts:getPassportCertSourceRef` JSDoc.
        const cert = certStack
          .getPassportCertSourceRef()
          ?.getCurrentCert();
        // Read the live exposure posture from the ExposureStateMachine
        // (composed in `composeLate`, downstream — read through the getter
        // per-call). Same cold-read guard as `loadIdentity`: `passport.fetch`
        // (the reconnect cert-pin verify) hits this every reconnect and
        // `current()` touches the store on a cold read, so a transient store
        // error must NOT fail the reconnect — fall back to the conservative
        // `DEFAULT_EXPOSURE_STATE` (lan_only). The verify primitive consumes
        // only `cert_fingerprint` from this block; `derived_preset_label` /
        // `per_path` / `public_mcp_acknowledgement` are the security-meaningful
        // exposure posture, carried in `support_redacted` + the wider profiles.
        const exposure = await (async () => {
          try {
            return (await getExposureMachine?.()?.current()) ?? DEFAULT_EXPOSURE_STATE;
          } catch {
            return DEFAULT_EXPOSURE_STATE;
          }
        })();
        return {
          // LAN URLs stay empty by design: `support_redacted` strips them
          // anyway, and the "how to reach this server" hint belongs on the
          // Hostnames panel (a discovery surface), not in a signed attestation
          // — populating them would leak the bind address into the wider
          // profiles. (Tracked separately as a Hostnames-panel follow-up.)
          lan_urls: [],
          // cert_fingerprint absent → verify primitive surfaces
          // `cert_fingerprint_missing` (routed to onError with
          // stage: 'verify'); the webclient's pin state stays intact
          // for the next reconnect cycle.
          cert_fingerprint: cert?.fingerprint ?? '',
          cert_expires_at: cert?.valid_until ?? 0,
          derived_preset_label: exposure.derived_preset_label,
          public_mcp_acknowledgement: exposure.public_mcp_acknowledgement,
          // Map the live per-path resolution to the passport's per-path entry
          // shape. Iterating the resolution Record (not a hand-listed literal)
          // means a new `PathRole` is covered automatically — no drift with the
          // exposure substrate. The D-149 reception extras
          // (`enabled_endpoint_count` / `enabled_endpoint_kinds`) stay unset:
          // a separate enumerator's concern, as before.
          per_path: Object.fromEntries(
            Object.entries(exposure.resolution).map(([role, resolution]) => [
              role,
              { resolution: { lan: resolution.lan, public: resolution.public } },
            ]),
          ) as ServerPassportNetworkBlock['per_path'],
        };
      },
      // Whole-server roster via the cross-user `listAllActive()` — this
      // composer holds no canonical user_id (it arrives per-client on the WS
      // handshake), and the realm is bound by the recovery key, not user_id.
      // Synchronous better-sqlite3 read, guarded so a transient store error
      // degrades to an empty roster rather than failing the reconnect-time
      // passport.fetch (`support_redacted` collapses this to per-kind counts;
      // the full roster rides only in enterprise_audit / migration_full).
      // PairedInstance → the passport entry subset: ClientKind is exactly
      // bridge|webclient|cli so `kind` maps 1:1; `user_id` is deliberately NOT
      // carried; active rows have `revoked_at` NULL so it's omitted. `added_at`
      // is unix SECONDS (store convention) → ×1000 to ms, matching the
      // passport's other timestamps (exported_at, handle reserved_at).
      loadClients: () => {
        try {
          return (pairedInstances?.listAllActive() ?? []).map((r) => ({
            client_id: r.instance_id,
            client_kind: r.kind,
            client_label: r.display_name,
            paired_at: r.added_at * 1000,
          }));
        } catch {
          return [];
        }
      },
      loadCapabilities: () => ({
        software_version: 'recued',
        os: process.platform,
        arch: process.arch,
        storage_size_bytes: 0,
        ai_pool_configured: false,
        byok_slots_configured: 0,
        scheduled_recipes_count: 0,
        reactive_recipes_count: 0,
        installed_packs: [],
        connections: [],
      }),
      loadRecovery: () => ({
        backup_status: 'unconfigured',
        filevault_recovery_key_status: 'absent',
      }),
      loadKeyHealth: () => ({
        master_dek: { status: 'healthy' },
        sub_dek: { status: 'healthy' },
        server_identity_key: { status: 'healthy' },
        publisher_identity_key: { status: 'healthy' },
        tls_private_key: { status: 'healthy' },
        webclient_token: { status: 'healthy' },
        webhook_secret: { status: 'healthy' },
      }),
    },
    // Per-call getter (Codex 2026-05-17 P1 fold, slice 117) —
    // `serverIdentityKey()` reads through to the identity manager's
    // mutable cache, so an `adoptServerIdentity` / `rotateServerIdentity`
    // between deps construction + an rpc call signs with the LIVE
    // keypair.
    serverIdentity: () => identityRef.identity.serverIdentityKey(),
  };

  // R26.4 Delta 2 — the user-export half reuses the SAME providers +
  // per-call identity getter, adding only the real audit emitter + the
  // durable history store. Gated on `auditLog` (the `passport.exported`
  // high-assurance row has nowhere to land without it); `db` is already
  // non-undefined past the top gate.
  let passportUserRpcDeps: PassportUserRpcDeps | undefined;
  if (deps.auditLog) {
    const history = createSqlitePassportHistoryStore(db);
    const audit = createPassportAuditEmitter(deps.auditLog);
    passportUserRpcDeps = {
      export: {
        providers: passportFetchDeps.providers,
        serverIdentity: passportFetchDeps.serverIdentity,
        audit,
        history,
      },
      historyList: { history },
      // R26.4 Delta 5 — passport import commit. Reuses the SAME per-call
      // identity getter + audit emitter; adds a live handle-state reader so
      // the commit can report whether the provisioner-owned cloud re-anchor
      // is still pending. The handle state machine materialises in
      // `certStack.composeLate(...)`, so read it through the ref per-call.
      import: {
        serverIdentity: passportFetchDeps.serverIdentity,
        audit,
        loadHandleState: async () => {
          const hsm = certStack.getHandleStateMachineRef();
          if (!hsm) return null;
          const st = await hsm.current();
          return st
            ? { publisher_id: st.publisher_id, current_handle: st.current_handle }
            : null;
        },
      },
    };
  }

  return { passportFetchDeps, passportUserRpcDeps };
};
