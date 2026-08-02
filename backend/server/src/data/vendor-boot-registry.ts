/** Vendor boot registry — the explicit list of pluggable external
 *  vendors the server wires at boot.
 *
 *  Before this registry, `bin.ts` knew about HubSpot and Salesforce by
 *  name: ~485 lines of vendor-specific reconciler / webhook-processor /
 *  CometD / merge-client / engagement-substrate construction lived
 *  inline inside `cmdServe()`, mixed with vendor-agnostic substrate
 *  (OAuth refresh + connection lookup). Every additional vendor would
 *  have grown the core composition root linearly.
 *
 *  The registry inverts that. `cmdServe()` iterates this list once
 *  through `composeVendorSubstrate(...)`; each vendor module owns its
 *  own boot wire under `data/<slug>/boot.ts` and decides what to build
 *  internally. Adding a vendor becomes:
 *
 *    1. New `data/<slug>/boot.ts` exporting `bootSlug(deps)`.
 *    2. One entry appended to `VENDOR_BOOT_REGISTRY` below.
 *
 *  No other change in `bin.ts`.
 *
 *  The contract is intentionally minimal: each vendor boot takes a
 *  shared deps bundle (connection store + the OAuth substrate +
 *  optional warehouse stores) and returns whatever late-bound refs
 *  cmdServe needs to publish to rpc deps. Salesforce is the only
 *  vendor today with a late-bound output (`registerSalesforceCallEntity`,
 *  consumed by the engagement-health reprobe rpc to swap the dual-schema
 *  call entity's housekeeping task). A vendor that starts asynchronous
 *  background work also returns a lifecycle stop hook; HubSpot returns an
 *  empty bundle. */

import type { ConnectionRecord, ConnectionAuth } from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { EngagementStore } from '../storage/engagement-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from '../storage/crm-record-mirror-store.js';
import type { ConnectionLookup } from '../housekeeping/reconciliation/vendor-reconciler.js';
import type { VendorMergeClient } from './vendor-merge.js';
import type { UpstreamMergeObjectType } from '@recued/contracts';

/** OAuth2 refresh hook — fired by a vendor's search helper on 401.
 *  Decodes the current row, runs the refresh dance, re-encodes + persists
 *  the rotated token, returns the fresh `ConnectionAuth`. Vendor-agnostic;
 *  the refresh URL lives in `auth.token_endpoint`. The vendor-substrate
 *  composer builds this once and threads it into every vendor boot. */
export type VendorRefreshAuth = (
  connection: ConnectionRecord,
) => Promise<ConnectionAuth>;

/** Per-vendor upstream-merge registry — populated by `boot` calls that
 *  produce merge clients (`hubspot:contact`, `salesforce:lead`, …). The
 *  registry is a single `Map` owned by `bin.ts` (lifted to `upstreamMerge-
 *  RegistryRef`); vendor boots `.set()` into it directly. Optional —
 *  dbless harnesses leave it undefined and vendors skip merge wiring. */
export type UpstreamMergeRegistry = Map<UpstreamMergeObjectType, VendorMergeClient>;

/** Shared boot deps every vendor receives. The composer is responsible
 *  for assembling these from `bin.ts`'s late-bound refs + the shared
 *  OAuth substrate it builds first.
 *
 *  Optional fields degrade gracefully — a vendor that needs
 *  `engagementStore` to register its engagement reconcilers just skips
 *  that registration when absent. The reconciliation wire + webhook
 *  processors still install. */
export interface VendorBootDeps {
  connectionStore: ConnectionStoreSqlite;
  engagementStore: EngagementStore | undefined;
  enrichmentStore: EnrichmentStore | undefined;
  /** D-190 — the dedicated CRM record mirror. A vendor that builds an in-process
   *  webhook funnel (Salesforce CometD) threads it into the funnel so accelerated
   *  changes mirror records immediately. Optional — absent ⇒ the funnel relies on
   *  the reconciliation cycle to mirror on its next pass. */
  crmRecordMirror: CrmRecordMirrorStore | undefined;
  upstreamMergeRegistry: UpstreamMergeRegistry | undefined;
  warehouseBus: WarehouseEventBus;
  /** Vendor-agnostic connection lookup. The composer builds this once
   *  (over `connectionStore` + the AEAD decode pipeline) and shares it
   *  across every vendor boot. */
  lookupConnection: ConnectionLookup;
  /** Vendor-agnostic OAuth2 refresh. Shared across vendors for the
   *  same reason — search helpers throw on 401 and rotate via this
   *  callback. */
  refreshAuth: VendorRefreshAuth;
}

/** Bundle each vendor's `boot` returns. v1 has one optional field
 *  Salesforce supplies for the call-engagement reprobe rpc; HubSpot
 *  returns `{}`. Future vendors append fields here as they need late-
 *  bound surfacing into `bin.ts` rpc deps. */
export interface VendorBootBundle {
  /** Drain background work started by this vendor boot. The vendor substrate
   *  composer aggregates these hooks and the serve layer registers the result
   *  with graceful shutdown before storage closes. */
  stop?: () => Promise<void> | void;
  /** D-184 — Salesforce call-entity registration hook. Captured by the
   *  engagement-health rpc and invoked on each reprobe to register / swap
   *  the dual-schema call entity's HOUSEKEEPING task for the reprobed
   *  connection (voice_call ↔ call_history) without a process restart.
   *  Replaces the pre-D-184 `salesforceCallRunnerBuilder` (which produced
   *  a runonce runner — the runonce stopgap is retired). */
  registerSalesforceCallEntity?: (input: {
    connection: ConnectionRecord;
    winner: 'voice_call' | 'call_history' | null;
    prior: 'voice_call' | 'call_history' | null;
  }) => void | Promise<void>;
}

/** Per-vendor boot entry. Slug is the literal vendor identifier used
 *  by every downstream registry (`reconciler-registry`, `runonce-
 *  registry`, `upstream-merge-registry`); keeping it on the entry lets
 *  the composer log + diagnose without re-deriving from the boot
 *  function.
 *
 *  `boot` is a dynamic-import factory — the underlying
 *  `data/<slug>/boot.ts` module loads on first invocation, not at
 *  registry-module load. This keeps HubSpot + Salesforce out of the
 *  boot import graph for callers that don't wire the substrate (db-
 *  less harnesses, unit-test boots that bypass `cmdServe()`). */
export interface VendorBootEntry {
  slug: 'hubspot' | 'salesforce';
  boot: (deps: VendorBootDeps) => Promise<VendorBootBundle>;
}

/** The canonical vendor list. Order matters only for deterministic
 *  boot logs + audit traces — both vendors are idempotent under
 *  reordering. Add new vendors here; nothing else in `bin.ts` needs
 *  to change.
 *
 *  Each `boot` thunk dynamic-imports its vendor module so the registry
 *  is import-cheap; the actual `bootHubSpot` / `bootSalesforce`
 *  functions (with their per-vendor reconciler / webhook / engagement
 *  graphs) only enter the runtime graph when `composeVendorSubstrate`
 *  iterates the registry. */
export const VENDOR_BOOT_REGISTRY: ReadonlyArray<VendorBootEntry> = [
  {
    slug: 'hubspot',
    boot: async (deps) => {
      const { bootHubSpot } = await import('./hubspot/boot.js');
      return bootHubSpot(deps);
    },
  },
  {
    slug: 'salesforce',
    boot: async (deps) => {
      const { bootSalesforce } = await import('./salesforce/boot.js');
      return bootSalesforce(deps);
    },
  },
];
