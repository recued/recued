/** D-192 P3b — wire the declared work-entity Source sync tasks.
 *
 *  Builds the source-mirror fetch deps from the composed `executeDeps`
 *  via the SAME `buildCanonicalPollDeps` builder the generic CRM
 *  reconciler uses (`CanonicalPollDeps` extends
 *  `SourceMirrorFetchDeps` — the vendor-registry seam it adds is
 *  simply unused here; a declared Source projects through its own
 *  declaration, not the CRM registry) and hands them, the connection
 *  store, the Source-identity mirror adapter, and the sync-state
 *  store to `wireWorkEntitySourceSync`.
 *
 *  D-192 P5 — also threads the work-graph edge substrate: the edge
 *  store plus its resolution lookups (contact stack + mirror +
 *  local-row reads). All optional — a composition without them keeps
 *  the H3 hints-only posture.
 *
 *  Placement mirrors `composeCanonicalCrmReconciliation`: post-listener
 *  (executeDeps is composed by then), one housekeeping task per
 *  registered connection-Source with a declaration. A db-less /
 *  keyless boot (no executeDeps / connection store / mirror) collapses
 *  to a no-op.
 *
 *  `resolveCatalogManifest` is the SAME closure the boot wire + write
 *  executor consume (built once in `composeAppContext`, threaded here via
 *  the app context) so registration, write, and sync enumerate ONE
 *  declaration set (pack-declared `work_entity_sources`, then compatibility
 *  fallbacks) and can't drift. Absent → compatibility declarations only. */

import type { ConnectionRow, IngredientManifest } from '@recued/contracts';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { buildCanonicalPollDeps } from '../watch/canonical-poll-deps.js';
import { liveVendorRegistry } from '../connection-convention-families.js';
import { wireWorkEntitySourceSync } from '../work-entity-source-sync.js';
import type { WorkEntityEdgeResolutionDeps } from '../work-entity-edge-resolution.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { WorkEntityEdgeStore } from '../storage/work-entity-edge-store.js';
import type { SourceDependencyEntityStore } from '../storage/source-dependency-entity-store.js';
import type {
  WorkEntitySourceMirrorStore,
  WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';

export interface ComposeWorkEntitySourceSyncInput {
  /** Late-bound — composed by listener-compose time. */
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  connectionStore: ConnectionStoreSqlite | undefined;
  mirror: WorkEntitySourceMirrorStore | undefined;
  syncState: WorkEntitySourceSyncStateStore | undefined;
  /** D-192 P5 — the edge substrate + resolution lookups (optional). */
  edges?: WorkEntityEdgeStore | undefined;
  contactStore?: ContactStore | undefined;
  workEntityStore?: WorkEntityStore | undefined;
  /** D-192 — the container-entity selection store: `resolve: 'persist'`
   *  dependencies resolve their list-scope + CORE #8b hydration read
   *  args here (the sync cycle also POPULATES lone-option selections).
   *  Absent → a Source declaring persist deps config-fails its cycle. */
  dependencyStore?: SourceDependencyEntityStore | undefined;
  /** D-192 — the SAME connection→catalog-manifest resolver the boot wire +
   *  write executor consume (`AppContext.resolveWorkEntityCatalogManifestRef`),
   *  so sync tasks enumerate authoritative pack-declared Sources before the
   *  compatibility registry. Absent → compatibility declarations only. */
  resolveCatalogManifest?: ((row: ConnectionRow) => IngredientManifest | null) | undefined;
  /** D-192 — append this wire's by-name reconcile to the install-hook fan-out
   *  (`AppContext.registerWorkEntitySourceReconcilerRef`), so a pack reinstall
   *  re-derives the sync task (fresh declaration) alongside the Source. Absent →
   *  sync tasks re-derive only on connection upsert/delete + restart. */
  registerReconciler?: ((fn: (connectionName: string) => void) => void) | undefined;
}

export const composeWorkEntitySourceSync = (
  input: ComposeWorkEntitySourceSyncInput,
): void => {
  const executeDeps = input.getExecuteDeps();
  const { connectionStore, mirror, syncState, edges, contactStore, workEntityStore } = input;
  if (
    executeDeps === undefined
    || connectionStore === undefined
    || mirror === undefined
    || syncState === undefined
  ) {
    return; // substrate not wired (db-less / keyless / no work-entity store)
  }

  const edgeResolution: WorkEntityEdgeResolutionDeps = {
    mirror,
    ...(contactStore !== undefined ? { contacts: contactStore } : {}),
    ...(workEntityStore !== undefined ? { workStore: workEntityStore } : {}),
    // D-192 unit-3 — LIVE merged registry (built-ins + installed packs) so a
    // pack-declared CRM's `crm.<alias>` edges resolve. `executeDeps` is
    // non-undefined by the guard above (recompute-on-read per call).
    resolveVendorRegistry: () => liveVendorRegistry(executeDeps.localManifestStore),
  };

  const syncWiring = wireWorkEntitySourceSync({
    connectionStore,
    fetchDeps: buildCanonicalPollDeps(executeDeps, connectionStore),
    mirror,
    syncState,
    ...(edges !== undefined ? { edges, edgeResolution } : {}),
    ...(input.dependencyStore !== undefined
      ? { dependencyStore: input.dependencyStore }
      : {}),
    ...(input.resolveCatalogManifest !== undefined
      ? { resolveCatalogManifest: input.resolveCatalogManifest }
      : {}),
  });
  // Join the install-hook fan-out so a pack reinstall's by-name reconcile
  // re-derives the sync task's declaration closure alongside the Source.
  input.registerReconciler?.(syncWiring.reconcileConnection);
};
