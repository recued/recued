/** D-192 S4c2 — the per-vendor engagement-leaf registry.
 *
 *  The seam that keeps `wireGenericEngagementReconciliation` vendor-agnostic: a
 *  `delta_cursor` engagement vendor registers its thin OData leaf (fetch / parse /
 *  classify + evidence-quality projector + participant edge mapper) here, keyed by
 *  vendor slug, and the generic boot resolves it per declared entity. Empty at
 *  S4c2 — the generic substrate ships + is tested against a FAKE vendor with an
 *  injected leaf; production registers zero generic engagement reconcilers until
 *  S4c3 registers the real Dynamics leaf (`registerEngagementLeaf('dynamics', …)`).
 *
 *  A leaf is per-VENDOR (all of a vendor's `delta_cursor` engagement entities share
 *  the same OData mechanism; the entity name selects the endpoint inside the leaf).
 *  Mirrors `reconciler-registry.ts`'s module-level default-registry pattern —
 *  process-global, boot-populated.
 *
 *  Spec: `docs/d-192-engagement-facet.md` (S4c2); survey Wall-F. */

import type { ConnectionVendorEntity } from '@recued/contracts';

import type { GenericEngagementLeaf } from './generic-engagement-reconciler.js';

/** Build the per-vendor leaf for one declared engagement entity. Vendors with a
 *  single OData mechanism return the same leaf for every entity; the entity name
 *  (`entity.entity`) selects the endpoint inside the leaf's closures. */
export type EngagementLeafBuilder = (entity: ConnectionVendorEntity) => GenericEngagementLeaf;

const leafBuilders = new Map<string, EngagementLeafBuilder>();

/** Register a vendor's engagement-leaf builder. Idempotent overwrite — a
 *  re-registration (hot reload / test reset) replaces the prior builder. */
export const registerEngagementLeaf = (vendor: string, builder: EngagementLeafBuilder): void => {
  leafBuilders.set(vendor, builder);
};

/** Resolve the leaf for a declared engagement entity, or undefined when the
 *  entity's vendor has no registered leaf (declared but not yet reconcilable). */
export const resolveEngagementLeaf = (
  entity: ConnectionVendorEntity,
): GenericEngagementLeaf | undefined => {
  const builder = leafBuilders.get(entity.vendor);
  return builder ? builder(entity) : undefined;
};

/** Test hook — clear the registry between cases. */
export const clearEngagementLeafRegistry = (): void => {
  leafBuilders.clear();
};
