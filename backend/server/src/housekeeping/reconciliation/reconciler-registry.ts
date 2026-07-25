/** D-128 Phase 2 — Reconciler registry.
 *
 *  Per-process `Map<EnrichmentScope, VendorReconciler>` populated by
 *  vendor Ds at boot. The connection-enrollment path
 *  (`collection.connection.upsert` for a kind=api connection) reads
 *  this registry to know which reconcilers cover the new connection
 *  and registers one `HousekeepingTaskInstance` per `(reconciler,
 *  connection_name)` via `buildVendorReconciliationTask`.
 *
 *  D-128 ships an empty registry — no vendor reconcilers exist until
 *  D-129 (HubSpot) populates `(hubspot, deal)` / `(hubspot, contact)` /
 *  `(hubspot, company)` and D-130 (Salesforce) adds Opportunity /
 *  Contact / Account / Lead.
 *
 *  Spec: D-128 §A.3. */

import {
  composeVendorEntityScope,
  type EnrichmentScope,
} from '@recued/contracts';

import type { VendorReconciler } from './vendor-reconciler.js';

export interface ReconcilerRegistry {
  /** Register a reconciler. Throws on duplicate `(vendor, entity)`. */
  register(reconciler: VendorReconciler): void;
  /** Look up a reconciler by canonical scope string. */
  get(scope: EnrichmentScope): VendorReconciler | undefined;
  /** Look up by vendor + entity pair (saves the caller composing the
   *  scope when they already have the parts). */
  getByVendorEntity(vendor: string, entity: string): VendorReconciler | undefined;
  /** D-128 P3 — every reconciler registered for `vendor`. The webhook
   *  funnel iterates this list per inbound delivery: each reconciler's
   *  `WebhookProcessor.parseEvents` filters the payload for its own
   *  entity, so a HubSpot payload with mixed deal + contact events
   *  fans out across every entity reconciler from the same vendor.
   *  Returns insertion order (stable across requests). */
  listByVendor(vendor: string): ReadonlyArray<VendorReconciler>;
  /** Every registered reconciler. Stable order: insertion order. */
  list(): ReadonlyArray<VendorReconciler>;
  /** Drop every entry. Tests + module reload only. */
  clear(): void;
}

export const createReconcilerRegistry = (): ReconcilerRegistry => {
  const byScope = new Map<EnrichmentScope, VendorReconciler>();

  return {
    register(reconciler) {
      const scope = composeVendorEntityScope(reconciler.vendor, reconciler.entity);
      if (byScope.has(scope)) {
        throw new Error(
          `reconciler '${scope}' already registered (vendor='${reconciler.vendor}', entity='${reconciler.entity}')`,
        );
      }
      byScope.set(scope, reconciler);
    },
    get(scope) {
      return byScope.get(scope);
    },
    getByVendorEntity(vendor, entity) {
      return byScope.get(composeVendorEntityScope(vendor, entity));
    },
    listByVendor(vendor) {
      const out: VendorReconciler[] = [];
      for (const recon of byScope.values()) {
        if (recon.vendor === vendor) out.push(recon);
      }
      return out;
    },
    list() {
      return [...byScope.values()];
    },
    clear() {
      byScope.clear();
    },
  };
};

const defaultRegistry = createReconcilerRegistry();

/** D-128 — register a reconciler in the per-process default registry.
 *  Vendor Ds call this at boot; D-128 ships zero callers. */
export const registerVendorReconciler = (reconciler: VendorReconciler): void => {
  defaultRegistry.register(reconciler);
};

export const getVendorReconciler = (
  scope: EnrichmentScope,
): VendorReconciler | undefined => defaultRegistry.get(scope);

export const getVendorReconcilerByVendorEntity = (
  vendor: string,
  entity: string,
): VendorReconciler | undefined =>
  defaultRegistry.getByVendorEntity(vendor, entity);

export const listVendorReconcilers = (): ReadonlyArray<VendorReconciler> =>
  defaultRegistry.list();

/** D-128 P3 — every reconciler registered for `vendor` in the
 *  per-process default registry. Drives the webhook-funnel fan-out
 *  when bin.ts wires the receiver against the default registry. */
export const listVendorReconcilersByVendor = (
  vendor: string,
): ReadonlyArray<VendorReconciler> =>
  defaultRegistry.listByVendor(vendor);

/** D-128 — drop every entry from the default registry. Tests + module
 *  reload only — production code never calls this. Vendor Ds register
 *  on `bin.ts` boot once; the registry is otherwise append-only. */
export const clearDefaultReconcilerRegistry = (): void => {
  defaultRegistry.clear();
};

/** D-130 P5.2 — escape hatch for the per-process default registry. The
 *  webhook funnel takes a full `ReconcilerRegistry` (it calls
 *  `listByVendor` plus other methods over time); the bin wire passes
 *  this default singleton when bridging the in-process CometD
 *  subscriber's events into the funnel. Tests construct dedicated
 *  registries via `createReconcilerRegistry`. */
export const getDefaultReconcilerRegistry = (): ReconcilerRegistry => defaultRegistry;
