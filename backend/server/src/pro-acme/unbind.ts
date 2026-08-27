/** D-148 follow-up #5 — Pro auto-managed `<handle>.recued.cloud` unbind
 *  substrate.
 *
 *  Tears down two coupled effects in one operator-initiated transaction:
 *
 *    1. Releases the Pro DDNS subdomain at the cloud helper (POST /v1/ddns/...
 *       — see § A.5.2). The cloud side stops resolving `<handle>.recued.cloud`
 *       to the user's server's IP.
 *    2. Removes the auto-managed cert row from `SqliteTlsDomainStore` (W3.6).
 *       The local TLS termination drops the Pro hostname from its SNI table.
 *
 *  Why two-step + audit between them. The cloud DDNS release is the
 *  external, irreversible effect — once the cloud helper accepts the
 *  release request, the public hostname stops resolving. The signed audit
 *  row MUST be emitted BEFORE the local cert removal (mirrors W3.5
 *  exposure: audit-first so the durable record survives a crash mid-
 *  transition). If audit emit throws, the cloud-side release is already
 *  in but local state is unchanged — retry hits step 1 idempotently +
 *  re-fires audit + cleanup. If cert removal throws after audit success,
 *  the local row is an orphan (Pro-managed cert for a no-longer-managed
 *  DDNS hostname); housekeeping cleans up + retry is safe (the
 *  idempotent step-1 release + duplicate audit row are tolerable for
 *  compliance review since each carries a distinct timestamp).
 *
 *  The substrate is composition-friendly: each effect is a separate
 *  interface so tests can inject stubs (failing DDNS / failing audit /
 *  failing cert remove) and verify the tagged union result. Production
 *  wiring is deferred per the FU2 / W3.FU pattern — the substrate ships
 *  with its rpc handler + tests; bin.ts composes the production
 *  `DdnsHandleControl` once the cloud-side release endpoint lands.
 *
 *  Spec: D-148 § A.5.2 (DDNS update API) + § A.6.3 (`pro_acme`
 *  cert source + unbinding requirement) + § A.7.4 (high-assurance audit
 *  invariants). */

import { resolveProDdnsHost } from '@recued/contracts';
import type { SqliteTlsDomainStore } from '../tls/domain-store.js';

/** Cloud DDNS helper abstraction. Production wires the `POST /v1/ddns/...`
 *  release-handle endpoint; tests inject a stub that records calls + can
 *  fail-on-demand.
 *
 *  **Idempotency contract.** Releasing a missing handle MUST resolve
 *  successfully (returning `{ released: false }`). The unbind path
 *  re-enters this method on retry after a partial failure between steps,
 *  and we don't want the second call to surface a confusing "handle not
 *  found" when the operator's intent is "release this handle".
 *
 *  **Failure contract.** Transient failures (network reset / cloud
 *  quota / signature reject) throw — the rpc handler surfaces these as
 *  `pro_acme_ddns_release_failed`. The substrate does NOT swallow
 *  errors at this layer; the caller decides whether retry is safe. */
export interface DdnsHandleControl {
  release(args: {
    handle: string;
    reason?: string;
  }): Promise<{ released: boolean }>;
}

/** Audit sink for the high-assurance `pro_acme_unbound` row. Implementations
 *  must route the entry through `createSigningAuditLog` (FU6) so the
 *  Ed25519 signature over `server_identity_key` lands on the row before
 *  it persists. The substrate-side caller doesn't construct the signature
 *  itself — it just passes the fields. */
export interface ProAcmeAuditSink {
  recordAudit(payload: {
    action: 'pro_acme_unbound';
    /** Canonical lowercase + trimmed domain the cert row was keyed
     *  under. Mirrors `tls_domain.remove`'s W3.6 P2 canonicalisation. */
    domain: string;
    /** Handle stem the cloud DDNS release fired against —
     *  `alice.recued.cloud` → `alice`. Carried in the audit row so the
     *  cloud-side correlation is recoverable. */
    handle: string;
    /** Paired-client instance_id that issued the rpc. The state-machine
     *  pattern in W3.5 calls this `changed_by_client_id`; we mirror the
     *  field name for compliance-review uniformity. */
    unbound_by_client_id: string;
    /** Operator-supplied free-text reason. Optional. */
    reason?: string;
  }): Promise<void>;
}

/** Closed-list options bundle for the substrate. Mirrors the
 *  `ExposureStateMachineOptions` pattern from W3.5. */
export interface ProAcmeUnbindOptions {
  store: SqliteTlsDomainStore;
  ddns: DdnsHandleControl;
  effects: ProAcmeAuditSink;
}

/** Tagged-union result. The rpc handler maps these to wire responses /
 *  `RpcError`s with the closed `NetworkErrorCode` codes pinned in
 *  `packages/contracts/src/network.ts`. */
export type ProAcmeUnbindResult =
  | {
      ok: true;
      /** True iff a row was deleted. False on the idempotent-retry path
       *  where the first call completed the teardown + the second call
       *  observed the row already absent. */
      released: boolean;
      domain: string;
      handle: string;
    }
  | {
      ok: false;
      error: 'pro_acme_not_found' | 'pro_acme_ddns_release_failed';
      domain: string;
    };

/** Derive the handle stem from the canonical Pro domain.
 *  `alice.recued.net` → `alice`. Returns null if the domain is not a handle in
 *  an ENABLED fleet zone — defends against a bad-data row whose
 *  `source: 'pro_acme'` was set but whose domain is malformed.
 *
 *  ⛔ THE ZONE COMES FROM `resolveProDdnsHost`, NEVER A LOCAL CONSTANT. This
 *  hardcoded `'.recued.cloud'` until 2026-08-26, months after the fleet zone
 *  moved: `network.ts` has `.recued.net` enabled and `.recued.cloud` commented
 *  out. So every live Pro domain failed to derive, and the caller turned that
 *  into `pro_acme_not_found` — an owner releasing their handle was told it did
 *  not exist, and the DDNS record was never released.
 *
 *  🔑 It survived because the null branch is DOCUMENTED as data corruption. A
 *  guard that explains its own failure as someone else's bad data reads as
 *  defensive rather than broken, so the message discouraged the check it
 *  needed. The zone list is a single source of truth precisely so a second copy
 *  cannot drift out from under it.
 *
 *  Exported for tests; the rpc handler uses the substrate's tagged
 *  union and never sees this helper directly. */
export const deriveProAcmeHandle = (canonicalDomain: string): string | null => {
  const resolved = resolveProDdnsHost(canonicalDomain);
  if (resolved === null) return null;
  // Defend against accidental sub-subdomains (`evil.alice.recued.net`).
  // Pro handles are flat — one label, then the zone suffix.
  if (resolved.handle.length === 0 || resolved.handle.includes('.')) return null;
  return resolved.handle;
};

/** Canonicalise a domain identifier the same way `SqliteTlsDomainStore`
 *  does at the upload boundary (W3.6 P2 fold). Lowercase + trim so that
 *  `'  Alice.Recued.Cloud '` matches the stored `'alice.recued.cloud'`
 *  row. */
export const canonicaliseProAcmeDomain = (raw: string): string =>
  raw.trim().toLowerCase();

/** Substrate entry point. Tagged-union result; never throws on
 *  closed-list error outcomes (`pro_acme_not_found`,
 *  `pro_acme_ddns_release_failed`). Implementation-level exceptions
 *  from the store (`store.remove`) or the audit sink propagate — those
 *  are bugs the caller should observe + retry.
 *
 *  Ordering invariant (DO NOT REORDER):
 *
 *    1. Validate input → `pro_acme_not_found` if domain doesn't exist
 *       OR exists with non-`pro_acme` source.
 *    2. Cloud DDNS release. Failure surfaces as
 *       `pro_acme_ddns_release_failed`. The cert row stays in place;
 *       the user retries.
 *    3. Audit emit (high-assurance signed). Errors propagate — the
 *       FU6 signing layer's fail-loud thunk catches missing identity
 *       boot; persistence failures are the storage layer's bugs.
 *    4. Cert removal. Errors propagate.
 *
 *  Step 2 BEFORE step 3 because the audit row is the durable record of
 *  cloud-side intent — if step 2 fails, no cloud effect happened, so we
 *  don't want a "released alice" audit row claiming an event that never
 *  occurred. Step 3 BEFORE step 4 because the audit must exist before
 *  any internal state changes (mirrors W3.5's audit-first invariant). */
export const proAcmeUnbind = async (
  opts: ProAcmeUnbindOptions,
  args: {
    domain: string;
    unbound_by_client_id: string;
    reason?: string;
  },
): Promise<ProAcmeUnbindResult> => {
  const canonical = canonicaliseProAcmeDomain(args.domain);

  // Step 1 — validate. The store's `list()` is canonical (lowercase
  // domain key) per W3.6; match by canonical form.
  const existing = opts.store.list().find((e) => e.domain === canonical);
  // ⚠ D-235 — DELIBERATELY NARROW, do NOT widen to `isFleetIssuedTlsDomainSource`.
  //   This flow tears down a Pro DDNS SUBDOMAIN plus its cert; a
  //   `pro_acme_custom` row has no DDNS subdomain to release (the user owns the
  //   zone), so there is nothing here for it to do and `deriveProAcmeHandle`
  //   would fail on it a few lines below anyway. Un-enrolling a custom domain
  //   is `collection.hostname.remove`.
  if (!existing || existing.source !== 'pro_acme') {
    return { ok: false, error: 'pro_acme_not_found', domain: canonical };
  }

  // The handle stem MUST derive cleanly from a Pro row. A malformed
  // domain on a `pro_acme` row is data corruption (the upload path
  // wouldn't have accepted it); surface as `pro_acme_not_found` to keep
  // the closed-list error surface tight. The compliance trail is the
  // un-emitted audit + the still-present row — operator can inspect the
  // store directly to recover.
  const handle = deriveProAcmeHandle(canonical);
  if (!handle) {
    return { ok: false, error: 'pro_acme_not_found', domain: canonical };
  }

  // Step 2 — cloud DDNS release. Failure here leaves both the cloud
  // record AND the local cert in place; the user retries the rpc.
  try {
    await opts.ddns.release({
      handle,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    });
  } catch {
    return {
      ok: false,
      error: 'pro_acme_ddns_release_failed',
      domain: canonical,
    };
  }

  // Step 3 — audit emit BEFORE cert removal. The signed row is the
  // durable record of the operator's intent; if the substrate crashes
  // between step 3 and step 4 the orphan cert row is recoverable from
  // housekeeping + retry is idempotent (step 1 re-fires `pro_acme_not_found`
  // since the row is... wait, the row IS still there since step 4 hasn't
  // run. Retry path: cloud release idempotent → audit emit (duplicate ok) →
  // cert remove). Duplicate audit rows on retry carry distinct timestamps
  // and remain compliance-tractable.
  await opts.effects.recordAudit({
    action: 'pro_acme_unbound',
    domain: canonical,
    handle,
    unbound_by_client_id: args.unbound_by_client_id,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
  });

  // Step 4 — local cert removal. The substrate's `remove` is idempotent
  // (W3.6); double-call on retry is a no-op.
  await opts.store.remove(canonical);

  return { ok: true, released: true, domain: canonical, handle };
};
