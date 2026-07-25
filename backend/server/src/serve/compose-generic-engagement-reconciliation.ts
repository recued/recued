/** D-192 S4c2 — wire the generic `delta_cursor` engagement reconciliation glue.
 *
 *  The engagement-plane sibling of `composeCanonicalCrmReconciliation` (D-190):
 *  hands the connection store, the shared connection lookup, the engagement store,
 *  the live merged registry, and the per-vendor leaf resolver to
 *  `wireGenericEngagementReconciliation`.
 *
 *  MUST run AFTER the bespoke vendor boots (so the generic wire skips hb/sf and its
 *  `bespokeScopes` snapshot is complete). A db-less / keyless boot (no `executeDeps`
 *  / connection store / engagement store / vendor lookup) collapses to a no-op.
 *
 *  At S4c2 the leaf registry is empty, so this registers zero generic engagement
 *  reconcilers in production — the substrate is inert until S4c3 registers the
 *  Dynamics OData leaf. The wire is placed now (de-risking S4c3 to a leaf-register). */

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { liveVendorRegistry } from '../recipe-runnability-handler.js';
import { wireGenericEngagementReconciliation } from '../data/generic-engagement-reconciler-boot.js';
import { resolveEngagementLeaf } from '../data/engagement-leaf-registry.js';
import { registerDynamicsEngagementLeaf } from '../data/dynamics/engagement-leaf.js';
import type { DynamicsFetch } from '../data/dynamics/odata-delta.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { ContactRedirectLookup, EngagementStore } from '../storage/engagement-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { ConnectionLookup } from '../housekeeping/reconciliation/vendor-reconciler.js';

export interface ComposeGenericEngagementReconciliationInput {
  /** Late-bound — `executeDeps` is composed by listener-compose time, so this
   *  returns a value by the post-listener stage. */
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  connectionStore: ConnectionStoreSqlite | undefined;
  engagementStore: EngagementStore | undefined;
  /** The shared vendor connection lookup published by `composeVendorSubstrate`. */
  lookupConnection: ConnectionLookup | undefined;
  /** The personal contact graph — backs the D-138 `resolveContactRedirect` for the
   *  Dynamics leaf's `data.contact` email edges (merged-contact survivor resolution).
   *  Optional: absent ⇒ the leaf's default `() => null` (unmerged linkage still
   *  works; only merged-contact redirects degrade). */
  contactStore: ContactStore | undefined;
}

export const composeGenericEngagementReconciliation = (
  input: ComposeGenericEngagementReconciliationInput,
): void => {
  const executeDeps = input.getExecuteDeps();
  const { connectionStore, engagementStore, lookupConnection } = input;
  if (
    executeDeps === undefined
    || connectionStore === undefined
    || engagementStore === undefined
    || lookupConnection === undefined
  ) {
    return; // substrate not wired (db-less / keyless / no vendor substrate)
  }

  // Register the built-in delta_cursor engagement leaves so the boot resolves them
  // for a bound connection. Dynamics 365 is the first (D-192 S4c3); more delta
  // vendors register the same way. Idempotent + inert until a matching connection is
  // enrolled. The Dynamics leaf's `data.contact` email edges (`sender`/`torecipients`)
  // route through the D-138 `resolveContactRedirect` (merged-contact survivor
  // resolution — the same contact-store wrapper `buildEngagementsResolverDeps` uses),
  // so a Dynamics email scores under its contact end-to-end. `prefsTimezone` stays
  // default (Dataverse stamps UTC → the tz hint is inferred either way).
  const contactStore = input.contactStore;
  const dynamicsFetch: DynamicsFetch = (url, init) => globalThis.fetch(url, init);
  registerDynamicsEngagementLeaf({
    fetch: dynamicsFetch,
    ...(contactStore !== undefined
      ? {
          resolveContactRedirect: ((email): { merged_into?: string } | null => {
            const row = contactStore.get(email);
            if (row === null) return null;
            return row.merged_into !== undefined ? { merged_into: row.merged_into } : {};
          }) satisfies ContactRedirectLookup,
        }
      : {}),
  });

  wireGenericEngagementReconciliation({
    connectionStore,
    lookupConnection,
    engagementStore,
    resolveRegistry: () => liveVendorRegistry(executeDeps.localManifestStore),
    resolveLeaf: resolveEngagementLeaf,
  });
};
