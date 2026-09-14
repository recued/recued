/** External-vendor substrate composer.
 *
 *  External vendors (HubSpot, Salesforce, future Pipedrive / Dynamics /
 *  Zoho) are pluggable. Before this composer existed, `bin.ts`
 *  hand-rolled HubSpot and Salesforce wiring inline — ~485 LOC of
 *  vendor-specific reconciler / webhook-processor / CometD / merge-
 *  client / engagement-substrate construction lived in `cmdServe()`,
 *  intermingled with vendor-agnostic substrate. Every new vendor would
 *  have grown the core composition root linearly. That is the wrong
 *  shape: vendors are plugins, not core.
 *
 *  This composer fixes the shape:
 *
 *    1. Builds the vendor-agnostic OAuth substrate once
 *       (`lookupApiConnection` + `refreshApiConnectionAuth`).
 *    2. Iterates `VENDOR_BOOT_REGISTRY`, calling each vendor's
 *       `boot(deps)` with the shared substrate. Each vendor owns its
 *       own reconcilers, webhook processors, lifecycle wiring,
 *       upstream-merge clients, engagement substrate, and any other
 *       vendor-specific surface.
 *    3. Runs the upstream-merge boot-recovery sweep after every vendor
 *       has registered its merge clients (the sweep iterates
 *       outbox rows in recoverable states and dispatches through the
 *       now-populated registry).
 *    4. Returns a bundle the caller publishes to its late-bound rpc
 *       refs (`apiConnectionLookupRef` / `refreshApiConnectionAuthRef`
 *       / `registerSalesforceCallEntityRef`). The bundle is the SOLE
 *       cmdServe-readable result of vendor wiring.
 *
 *  Adding a new vendor: drop a `data/<slug>/boot.ts` exporting
 *  `bootSlug(deps): Promise<VendorBootBundle>` and append one entry to
 *  `VENDOR_BOOT_REGISTRY` in `data/vendor-boot-registry.ts`. No
 *  change in `bin.ts` or this composer.
 *
 *  Absent `connectionStore` (dbless harnesses) the entire substrate
 *  collapses to a no-op: the caller skips the composer entirely + the
 *  late-bound refs stay undefined → the engagement-health rpc paths
 *  surface clean "not initialized" errors. */

import type { EventBus } from '../../events/bus.js';
import type {
  ConnectionRecord,
  ConnectionAuth,
} from '@recued/contracts';
import { getVendorProvider } from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import { decodeConnectionRow } from '../../storage/connection-row-decode.js';
import type { EngagementStore } from '../../storage/engagement-store.js';
import type { EnrichmentStore } from '../../storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from '../../storage/crm-record-mirror-store.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { UpstreamMergeStore } from '../../storage/upstream-merge-store.js';
import type { KeyManager } from '../../key-manager.js';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import type { AuditLogStore } from '@recued/storage';
import type { ConnectionLookup } from '../../housekeeping/reconciliation/vendor-reconciler.js';
import { makeConnectionRuntimeBaseIssueSink } from '../../connection-runtime-base-issue.js';
import {
  VENDOR_BOOT_REGISTRY,
  type UpstreamMergeRegistry,
  type VendorBootBundle,
  type VendorRefreshAuth,
} from '../../data/vendor-boot-registry.js';

/** Substrate deps. `connectionStore` is required — if it's absent the
 *  caller should skip this composer entirely. Everything else is
 *  optional with documented degradation. */
export interface ComposeVendorSubstrateDeps {
  connectionStore: ConnectionStoreSqlite;
  /** D-269 step 1 — the owner's declared server zone, for D-139 § A.3.7's
   *  engagement timezone fallback. Absent ⇒ the chain skips to UTC, which is
   *  what it did for every engagement before this was supplied at all. */
  prefsTimezone?: () => string | null | undefined;
  keys: KeyManager | undefined;
  engagementStore: EngagementStore | undefined;
  enrichmentStore: EnrichmentStore | undefined;
  /** D-190 — the dedicated CRM record mirror, threaded into each vendor boot so
   *  an in-process webhook funnel (Salesforce CometD) mirrors records on
   *  accelerated changes. Absent ⇒ funnels rely on the reconciliation cycle. */
  crmRecordMirror: CrmRecordMirrorStore | undefined;
  contactStore: ContactStore | undefined;
  upstreamMergeStore: UpstreamMergeStore | undefined;
  upstreamMergeRegistry: UpstreamMergeRegistry | undefined;
  /** Advisory visibility when a provider rotates credentials but supplies a
   * missing or unsafe tenant origin. The response URL itself is never logged. */
  auditLog: Pick<AuditLogStore, 'logActivity'> | undefined;
  warehouseBus: WarehouseEventBus;
  eventBus: EventBus;
}

/** Bundle returned to the caller. Every field is what `bin.ts`
 *  previously assigned to its late-bound `let`-bound refs inline; the
 *  caller now publishes them in one assignment block right after this
 *  call returns. */
export interface VendorSubstrateBundle {
  /** Shared connection lookup — `bin.ts` publishes to
   *  `apiConnectionLookupRef` and feeds the engagement-health rpc deps'
   *  `lookupConnection` closure. */
  lookupConnection: ConnectionLookup;
  /** Shared OAuth2 refresh — `bin.ts` publishes to
   *  `refreshApiConnectionAuthRef`. */
  refreshAuth: VendorRefreshAuth;
  /** D-184 — Salesforce call-entity registration hook — `bin.ts`
   *  publishes to `registerSalesforceCallEntityRef`. Undefined when
   *  Salesforce boot didn't surface one (no engagementStore wired).
   *  Swaps the dual-schema call entity's housekeeping task per reprobe. */
  registerSalesforceCallEntity?: VendorBootBundle['registerSalesforceCallEntity'];
  /** Aggregate drain for background work started by vendor boots. The serve
   *  layer registers it with the process background-service lifecycle. */
  stop?: () => Promise<void>;
}

/** Compose the vendor substrate. Async because each vendor's `boot`
 *  is async (reconcilers + lifecycle wiring may dynamic-import sub-
 *  modules), and because the boot-recovery sweep is async. */
export const composeVendorSubstrate = async (
  deps: ComposeVendorSubstrateDeps,
): Promise<VendorSubstrateBundle> => {
  // D-125 P3.1 / P4.1 — vendor-agnostic AEAD encode/decode primitives.
  // Dynamic-imported here so this composer can sit in `composition/`
  // without forcing the connection-handler module into the boot import
  // graph for callers that don't wire the substrate.
  const { decodeAuthFromStorage, encodeAuthForStorage } = await import('../../connection-handler.js');
  const { refreshOAuth2WithMetadata } = await import('@recued/ingredients');

  const keyProvider = (deps.keys && deps.keys.state() !== 'uninitialized')
    ? deps.keys.keyProvider('connection')
    : undefined;
  const runtimeBaseIssueSink = deps.auditLog
    ? makeConnectionRuntimeBaseIssueSink(deps.auditLog)
    : undefined;

  // Vendor-agnostic OAuth2 refresh. Fired by a vendor's search helper
  // on 401: decodes the current row, runs the refresh dance, encodes
  // + persists the rotated token, returns the fresh `ConnectionAuth`
  // so the helper re-issues the in-flight request without an extra
  // round-trip through `lookupConnection`. The refresh URL lives in
  // `auth.token_endpoint` (set at enrollment per the vendor's
  // sandbox/production flag for Salesforce; the production token URL
  // for HubSpot). Used by every vendor's reconcilers + webhook
  // processors + merge clients.
  const refreshAuth: VendorRefreshAuth = async (
    connection: ConnectionRecord,
  ): Promise<ConnectionAuth> => {
    // A non-oauth2 auth (a static `bearer` — e.g. a HubSpot Service Key) has
    // nothing to refresh: return it UNCHANGED so a vendor client's
    // single-shot-refresh-on-401 path degrades to "retry with the same static
    // token, then surface the honest 401" (an invalid / rotated key), rather
    // than throwing an unhelpful "cannot refresh". A valid static token never
    // 401s, so this branch is only reached when the key is actually bad.
    if (connection.auth.type !== 'oauth2_refresh') {
      return connection.auth;
    }
    const vendor = typeof connection.config.vendor === 'string'
      ? getVendorProvider(connection.config.vendor)
      : null;
    const refreshed = await refreshOAuth2WithMetadata(
      connection.auth,
      globalThis.fetch.bind(globalThis),
      () => Date.now(),
      vendor,
    );
    const fresh = refreshed.auth;
    const existing = deps.connectionStore.get(connection.kind, connection.name);
    if (existing) {
      if (
        refreshed.runtime_base.status === 'missing'
        || refreshed.runtime_base.status === 'invalid'
      ) {
        runtimeBaseIssueSink?.(existing, refreshed.runtime_base);
      }
      const auth_ciphertext = await encodeAuthForStorage(
        fresh,
        { kind: existing.kind, name: existing.name },
        keyProvider,
      );
      let config_json = existing.config_json;
      if (refreshed.runtime_base.status === 'valid') {
        try {
          const parsed: unknown = JSON.parse(existing.config_json);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            config_json = JSON.stringify({
              ...(parsed as Record<string, unknown>),
              base_url: refreshed.runtime_base.base_url,
            });
          }
        } catch {
          // Preserve the rotated credential even if a corrupt config cannot be
          // patched; the ordinary connection error will direct re-enrollment.
        }
      }
      deps.connectionStore.upsert({
        kind: existing.kind,
        name: existing.name,
        ...(existing.subtype !== undefined ? { subtype: existing.subtype } : {}),
        display_name: existing.display_name,
        ...(existing.publisher_id !== undefined
          ? { publisher_id: existing.publisher_id }
          : {}),
        config_json,
        auth_ciphertext,
        enrolled_at: existing.enrolled_at,
        updated_at: Date.now(),
        ...(existing.last_used_at !== undefined
          ? { last_used_at: existing.last_used_at }
          : {}),
        ...(existing.health_json !== undefined
          ? { health_json: existing.health_json }
          : {}),
        // D-165 P3.path-picker — a token refresh restamps the whole row;
        // it MUST carry the existing sub-resource scope forward. Dropping
        // it would persist NULL → consumers default to '/' → the
        // permission boundary silently widens on the next 401 refresh.
        ...(existing.subresource_path !== undefined
          ? { subresource_path: existing.subresource_path }
          : {}),
        // granted-scopes — same restamp hazard: carry the vendor-granted
        // coverage set forward, else a token refresh wipes it to NULL and
        // pack-readiness flips a covered connection to "needs re-auth".
        ...(existing.granted_scopes_json !== undefined
          ? { granted_scopes_json: existing.granted_scopes_json }
          : {}),
      });
    }
    return fresh;
  };

  // Vendor-agnostic connection lookup. Reads the row, decodes the
  // AEAD-encrypted auth, parses the JSON config, returns a fresh
  // `ConnectionRecord`. Shared across vendors — each vendor's search
  // helper reads `connection.config.base_url` / equivalent per-org
  // instance URL itself.
  const lookupConnection: ConnectionLookup = async (name) => {
    const row = deps.connectionStore.get('api', name);
    if (!row) return null;
    const auth = await decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: row.kind, name: row.name },
      keyProvider,
    );
    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.config_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed config — treat as empty; the vendor's search
      // helper will fail at the auth-token read step and the
      // harness yields cleanly.
    }
    const record: ConnectionRecord = {
      name: row.name,
      kind: row.kind,
      display_name: row.display_name,
      config,
      auth,
      enrolled_at: row.enrolled_at,
      updated_at: row.updated_at,
    };
    if (row.subtype !== undefined) record.subtype = row.subtype;
    if (row.publisher_id !== undefined) record.publisher_id = row.publisher_id;
    if (row.last_used_at !== undefined) record.last_used_at = row.last_used_at;
    // D-165 P3.path-picker — hydrate the sub-resource scope so the AEAD-
    // decrypted vendor runtime path matches decodeConnectionRow; gateway
    // path_scope enforcement (later slice) reads it off this record.
    if (row.subresource_path !== undefined) record.subresource_path = row.subresource_path;
    return record;
  };

  // Iterate the vendor registry. Each vendor's `boot(deps)` is
  // independent; v1 has no cross-vendor coordination requirement
  // (HubSpot's reconcilers + Salesforce's reconcilers can register in
  // either order). Bundle outputs aggregate into the substrate bundle
  // — today only Salesforce surfaces `registerSalesforceCallEntity`.
  let registerSalesforceCallEntity: VendorBootBundle['registerSalesforceCallEntity'];
  const vendorStops: Array<{
    slug: (typeof VENDOR_BOOT_REGISTRY)[number]['slug'];
    stop: NonNullable<VendorBootBundle['stop']>;
  }> = [];
  let recoverySweep: Promise<void> | undefined;
  for (const entry of VENDOR_BOOT_REGISTRY) {
    const bundle = await entry.boot({
      connectionStore: deps.connectionStore,
      engagementStore: deps.engagementStore,
      // D-269 — fills D-139 § A.3.7's third fallback step, declared on eleven
      // reconcilers and supplied by nobody until now.
      ...(deps.prefsTimezone ? { prefsTimezone: deps.prefsTimezone } : {}),
      enrichmentStore: deps.enrichmentStore,
      crmRecordMirror: deps.crmRecordMirror,
      upstreamMergeRegistry: deps.upstreamMergeRegistry,
      warehouseBus: deps.warehouseBus,
      lookupConnection,
      refreshAuth,
    });
    if (bundle.registerSalesforceCallEntity !== undefined) {
      registerSalesforceCallEntity = bundle.registerSalesforceCallEntity;
    }
    if (bundle.stop !== undefined) {
      vendorStops.push({ slug: entry.slug, stop: bundle.stop });
    }
  }

  // D-138 P5 — upstream-merge boot recovery sweep. Replays every
  // outbox row in a recoverable state (`vendor_merge_in_flight` /
  // `vendor_merge_succeeded` / `vendor_merge_local_pending`). Vendor
  // calls are idempotent on the row's `idempotency_key` + the local-
  // merge step is idempotent (cascade engine + linkPlatformId +
  // setMergedInto are all idempotent). Best-effort — failures land
  // the row in `vendor_merge_failed` and surface via the broadcast
  // bus. Runs AFTER vendor boots so every merger is registered.
  if (
    deps.upstreamMergeStore !== undefined
    && deps.upstreamMergeRegistry !== undefined
    && deps.contactStore !== undefined
  ) {
    const upstreamMergeStore = deps.upstreamMergeStore;
    const upstreamMergeRegistry = deps.upstreamMergeRegistry;
    const contactStore = deps.contactStore;
    const { runUpstreamMergeRecoverySweep } = await import(
      '../../upstream-merge-handler.js'
    );
    const sweepDeps: import('../../upstream-merge-handler.js').UpstreamMergeRpcDeps = {
      store: upstreamMergeStore,
      contactStore,
      vendorMergers: upstreamMergeRegistry,
      // The recovery sweep needs the same lookup the live rpc uses;
      // we recompose against the connection store + the shared
      // opaque-AEAD-tolerant decode (the live rpc deps composer uses
      // the same helper). Behaviour change vs the prior inline decode:
      // opaque auth ciphertext now resolves to `auth: { type: 'none' }`
      // (the merger surfaces `vendor_auth_expired`) instead of dropping
      // the row to null; the sweep already swallows errors so the
      // observable outcome is identical.
      vendorConnectionLookup: (vendor, name) => {
        const row = deps.connectionStore.get('api', name);
        if (row === null) return null;
        if (row.subtype !== vendor) return null;
        return decodeConnectionRow(row);
      },
      eventBus: deps.eventBus,
    };
    // Pick the first enrolled api connection per vendor as the
    // recovery target — boot recovery doesn't carry the original
    // connection_name through (the row doesn't store it). The
    // happy-path is one connection per vendor; multi-connection
    // setups may need the user to retry from the failure banner
    // instead of relying on the sweep.
    recoverySweep = runUpstreamMergeRecoverySweep(
      sweepDeps,
      (vendor) => {
        const rows = deps.connectionStore.list({ kind: 'api' });
        for (const row of rows) {
          if (row.subtype === vendor) return row.name;
        }
        return null;
      },
    ).then(
      () => undefined,
      () => {
        // Sweep failures are best-effort; per-row failures are captured on
        // the row itself + emitted via the bus. Keep the settled promise so
        // shutdown still waits for every admitted write to finish.
      },
    );
  }

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      // Invoke every stop before awaiting one so each vendor closes admission
      // promptly. Reverse boot order mirrors the server's other lifecycle
      // drains without serializing independent network shutdowns.
      const pending = [...vendorStops].reverse().map(({ slug, stop }) => {
        try {
          return Promise.resolve(stop()).catch((error) => {
            throw new Error(`vendor '${slug}' failed to stop`, { cause: error });
          });
        } catch (error) {
          return Promise.reject(
            new Error(`vendor '${slug}' failed to stop`, { cause: error }),
          );
        }
      });
      if (recoverySweep !== undefined) pending.push(recoverySweep);
      const results = await Promise.allSettled(pending);
      const errors = results
        .filter((result): result is PromiseRejectedResult =>
          result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'one or more vendor background services failed to stop',
        );
      }
    })();
    return stopPromise;
  };

  return {
    lookupConnection,
    refreshAuth,
    ...(registerSalesforceCallEntity !== undefined
      ? { registerSalesforceCallEntity }
      : {}),
    ...(vendorStops.length > 0 || recoverySweep !== undefined ? { stop } : {}),
  };
};
