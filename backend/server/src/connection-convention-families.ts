/** D-182 §10 step 8 / R1 — the bound kernel-convention families derivation.
 *
 *  The single canonical home for "which `core.crm.*` / `core.acct.*` families
 *  have a vendor bound right now". Both halves of R1 consume it so they CANNOT
 *  drift — enforcement (`handleExecute` rewrites/blocks unbound canonical
 *  op-steps per run) and disclosure (`recipe.runnability` rpc + the
 *  `recipe_runnability_changed` broadcast surface the same verdict to the
 *  recipes view) must agree, or the view would advertise a recipe as runnable
 *  that the run then empties/blocks.
 *
 *  Scans the enrolled `kind: 'api'` connections (the only rows carrying a
 *  vendor), resolves each row's vendor (`resolveConnectionVendor`), and maps it
 *  through the crm_alias/acct_alias registry to a convention family
 *  (`boundConventionFamilies`), de-duping to the family set. A config-supplied
 *  connection is itself an ENROLLED row, so this scan captures it — R1 never
 *  falsely reports "unbound" for a connection the run targets.
 *
 *  Absent store (db-less harness / no connection store) → no families bound →
 *  the correct fail-safe: every canonical read empties + warns, every canonical
 *  write blocks (nothing is connected).
 *
 *  Vendor REGISTRY: the family-mapping registry is a param defaulting to the
 *  frozen built-ins (`CONNECTION_VENDOR_ENTITIES`). Both R1 halves pass the LIVE
 *  merged registry (`liveVendorRegistry` — built-ins + each installed pack's
 *  decomposed `crm_alias`/`acct_alias` entities) so a 3rd-party CRM pack vendor
 *  and the `acct` family (QuickBooks / Xero ship as pack-composition vendors,
 *  NOT built-ins) actually bind. `liveVendorRegistry` lives here, the shared home,
 *  so the run path + the disclosure path + the watch/trigger composers all build
 *  the SAME merged registry and cannot diverge.
 */
import {
  CONNECTION_VENDOR_ENTITIES,
  assertEngagementRegistryInvariants,
  assertNoVendorPrefixClash,
  boundConventionFamilies,
  composeVendorEntityScope,
  getVendorEntityByCrmAlias,
  vendorEntitiesFromComposition,
  type ConnectionVendorEntity,
  type CrmAlias,
  type EnrichmentScope,
  type KernelConnectionFamily,
} from '@recued/contracts';
import { resolveConnectionVendor, type ConnectionStoreSqlite } from './storage/connection-store.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';

/** The built-in vendor ids (HubSpot / Salesforce). A 3rd-party composition must
 *  not CLAIM one — see the whole-pack fail-closed rule in `liveVendorRegistry`. */
const BUILTIN_VENDOR_IDS: ReadonlySet<string> = new Set(
  CONNECTION_VENDOR_ENTITIES.map((e) => e.vendor),
);

/** Build the live vendor-entity registry connections reverse-map against: the
 *  frozen built-ins (FIRST) followed by each installed pack's decomposed
 *  `crm_alias`/`acct_alias` entities (`vendorEntitiesFromComposition`). Recomputed
 *  each call so a runtime install / uninstall is reflected. Absent store →
 *  built-ins only (the fail-safe — today's behaviour).
 *
 *  Mirrors the install resolver's `thirdPartyRegistryMerge`
 *  (`install-composition.ts`) so a runnability verdict can never surface a
 *  provider the dispatch path would reject (a false `runnable`):
 *    - PER MANIFEST + WHOLE-PACK fail-closed — if ANY entity a composition lifts
 *      claims a built-in vendor id, that ENTIRE manifest contributes nothing (the
 *      resolver refuses such a merge wholesale; a per-entity filter would wrongly
 *      keep a mixed manifest's other entities).
 *    - Built-ins listed first + `getVendorEntityByCrmAlias` is first-wins, so a
 *      3rd-party can never shadow a built-in `(vendor, crm_alias)` pair; that same
 *      array-order first-wins resolves any cross-manifest overlap (moot in
 *      practice — a genuine 3rd-party vendor id is distinct by construction). */
export const liveVendorRegistry = (
  store: Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'> | undefined,
): ReadonlyArray<ConnectionVendorEntity> => {
  if (!store) return CONNECTION_VENDOR_ENTITIES;
  const thirdParty: ConnectionVendorEntity[] = [];
  for (const manifest of store.listManifests()) {
    const lifted = vendorEntitiesFromComposition(store.getEntitySchemas(manifest.slug));
    if (lifted.length === 0) continue;
    if (lifted.some((e) => BUILTIN_VENDOR_IDS.has(e.vendor))) continue;
    // D-192 unit-3 — fail-closed on a pack vendor named after a reserved `data.*`
    // sub-namespace (`contact` / `mail` / `memory` / …). Built-ins get this check at
    // boot (`assertNoVendorPrefixClash` on CONNECTION_VENDOR_ENTITIES); re-run it on
    // each lifted set so a pack can't bypass it. Without the guard, once this vendor
    // reaches the read-side alias resolver via the live registry (the unit-3 seam),
    // `matchVendorEnrichmentAlias` would rewrite `data.<reserved>.<entity>.<id>.enrichments.*`
    // and shadow the first-class reserved namespace.
    if (assertNoVendorPrefixClash(lifted).length > 0) continue;
    // D-192 — fail-closed on an engagement-invariant violation in the ACCUMULATED
    // third-party set (already-accepted entities + this manifest's), NOT just this
    // manifest in isolation. The engagement invariants (one sync_kind / one
    // daily_budget / uniform group capability) are per-VENDOR, and two DIFFERENT
    // manifests can declare the SAME third-party vendor id — `wraps_vendor` derives
    // from each composition's connection/slug and `LocalManifestStore` keys installs
    // by slug, not vendor. A per-manifest check would pass both a
    // `dynamics.email sync_kind:'poll'` pack and a `dynamics.task sync_kind:'stream'`
    // pack, and `engagementSyncKind('dynamics')` would then read whichever row sorts
    // first (order-dependent). Validating the candidate merge drops the LATER
    // conflicting manifest (first-manifest-wins, deterministic in listManifests
    // order) so every vendor's engagement facet stays coherent. Runs only the
    // engagement invariants (NOT the full `assertConnectionVendorRegistry`, whose
    // per-entry vendor-id regex rejects the hyphenated ids the decomposer emits);
    // subsumes the per-manifest self-consistency check (lifted ⊆ candidate). The
    // composition validator flags a SINGLE pack's inconsistency at authoring — this
    // is the merge-time belt-and-braces + the cross-pack case the S1 reviewer flagged.
    if (assertEngagementRegistryInvariants([...thirdParty, ...lifted]).length > 0) continue;
    thirdParty.push(...lifted);
  }
  return thirdParty.length === 0
    ? CONNECTION_VENDOR_ENTITIES
    : [...CONNECTION_VENDOR_ENTITIES, ...thirdParty];
};

/** Derive the set of kernel-convention families (`crm` / `acct`) with a vendor
 *  bound, from the live `kind: 'api'` connections. Undefined store → empty set
 *  (fail-safe: nothing connected). `registry` maps a bound vendor to its family —
 *  pass the LIVE merged registry (`liveVendorRegistry(localManifestStore)`) so a
 *  pack-composition vendor (every `acct` vendor; 3rd-party CRM packs) binds;
 *  default is the built-ins (HubSpot / Salesforce only). */
export const deriveBoundConventionFamilies = (
  connectionStore: Pick<ConnectionStoreSqlite, 'list'> | undefined,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): Set<KernelConnectionFamily> => {
  if (connectionStore === undefined) return new Set();
  const vendors: string[] = [];
  for (const row of connectionStore.list({ kind: 'api' })) {
    const vendor = resolveConnectionVendor(row);
    if (vendor !== undefined) vendors.push(vendor);
  }
  return boundConventionFamilies(vendors, registry);
};

/** D-190 — one CRM mirror source for the chat `deal.search` / `contact.search`
 *  fan-out: a bound vendor + the local mirror scope its records project into. */
export interface BoundCrmMirrorSource {
  /** the bound vendor id — the fan-out `ScopeSearchSourceId` (open since D-190). */
  source_id: string;
  /** the materialized mirror scope `connection.api.<vendor>.<entity>`. */
  scope: EnrichmentScope;
}

/** D-190 — the GENERIC replacement for the old hardcoded `[hubspot, salesforce]`
 *  deal/contact source list: the deduped CRM mirror sources for one `crm_alias`,
 *  derived from the user's bound `kind:'api'` connections × the live vendor registry.
 *  Each bound connection's vendor is mapped through `getVendorEntityByCrmAlias` to its
 *  entity, and the mirror scope is `connection.api.<vendor>.<entity>`. ONE source per
 *  (vendor, entity) scope — multiple connections of the same vendor share one mirror
 *  scope, so the set is deduped. Built-ins AND pack-declared CRMs resolve (pass the
 *  live merged registry). Undefined store → empty (nothing connected → no sources).
 *  A connection whose vendor declares no `crm_alias` entity is skipped (not a CRM). */
export const deriveBoundCrmMirrorSources = (
  crmAlias: CrmAlias,
  connectionStore: Pick<ConnectionStoreSqlite, 'list'> | undefined,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): BoundCrmMirrorSource[] => {
  if (connectionStore === undefined) return [];
  const out: BoundCrmMirrorSource[] = [];
  const seen = new Set<string>();
  for (const row of connectionStore.list({ kind: 'api' })) {
    const vendor = resolveConnectionVendor(row);
    if (vendor === undefined) continue;
    const entity = getVendorEntityByCrmAlias(vendor, crmAlias, registry);
    if (entity === null) continue;
    const scope = composeVendorEntityScope(vendor, entity.entity);
    if (seen.has(scope)) continue;
    seen.add(scope);
    out.push({ source_id: vendor, scope });
  }
  return out;
};

/** S1 (CRM mirror freshness) — one entry PER bound CRM connection for a
 *  `crm_alias` (NOT deduped by scope, unlike `deriveBoundCrmMirrorSources`). Two
 *  connections of the same vendor each get their own entry, because freshness
 *  (`synced_at`) is per-connection — each runs its own reconcile task
 *  (`reconciliation.<vendor>.<entity>.<connection_name>`) with its own
 *  `last_run_at`. Carries the `connection_name` (dropped by the deduped mirror-
 *  source derivation) + the vendor / entity / mirror scope. Undefined store →
 *  empty. A connection whose vendor declares no `crm_alias` entity is skipped. */
export interface BoundCrmConnection {
  connection_name: string;
  vendor: string;
  entity: string;
  scope: EnrichmentScope;
}

export const deriveBoundCrmConnections = (
  crmAlias: CrmAlias,
  connectionStore: Pick<ConnectionStoreSqlite, 'list'> | undefined,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): BoundCrmConnection[] => {
  if (connectionStore === undefined) return [];
  const out: BoundCrmConnection[] = [];
  for (const row of connectionStore.list({ kind: 'api' })) {
    const vendor = resolveConnectionVendor(row);
    if (vendor === undefined) continue;
    const entity = getVendorEntityByCrmAlias(vendor, crmAlias, registry);
    if (entity === null) continue;
    out.push({
      connection_name: row.name,
      vendor,
      entity: entity.entity,
      scope: composeVendorEntityScope(vendor, entity.entity),
    });
  }
  return out;
};

/** S1 (CRM mirror freshness) — derive a connection's "last synced" wall-clock from
 *  its reconcile task's housekeeping state row. A run that HAPPENED + did NOT error
 *  ⇒ its `last_run_at` (a yielded reconcile is recorded `pending` with `last_run_at`
 *  set — still synced-as-of-then, so it counts). A last `error` (sync failed) or a
 *  never-run task ⇒ `null` (treat as unknown / stale). Pure + structurally typed so
 *  the chat wiring + tests + the S3 staleness trigger share one definition. */
export const syncedAtFromReconcileState = (
  row: { last_run_at?: number | null; last_status: string } | null | undefined,
): number | null =>
  row != null && row.last_run_at != null && row.last_status !== 'error'
    ? row.last_run_at
    : null;
