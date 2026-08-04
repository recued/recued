/** D-165 — boot-seed the per-connection operation profile store for every
 *  catalog-backed vendor connection. HubSpot was the P1 pilot; Salesforce
 *  (RUNTIME #4) is the second vendor. The vendor→catalog map is the
 *  `CATALOG_VENDOR_SLUGS` registry — adding a third vendor is one entry there
 *  plus its `<slug>.json`.
 *
 *  D-165 P0 shipped the catalog gateway + the (empty) profile store; the
 *  gateway fails closed on a missing profile (`no_connection_profile` →
 *  deny, Invariant 3). Until something grants an operation group, NO catalog
 *  connection can route an operation through the gateway. This wire derives
 *  each connection's profile from its GRANTED operation groups (spec § "P1 —
 *  express its operations as a per-connection profile").
 *
 *  Deny until granted (D-182 §7.1). NOTHING is auto-admitted at enrollment —
 *  read / write / admin / destructive operations ALL stay OFF until their
 *  containing operation group is explicitly granted (Invariant 3, no silent
 *  surface). Read groups are granted at install via the §7.1 grant dialog (a
 *  pack's bound connection — `writePackGrants`) or by the owner via the grant
 *  rpcs (`connection-handler.ts`, the user-facing writer for registered-vendor
 *  connections that enroll outside a pack install). Enrolling a connection
 *  alone grants nothing — its profile is empty (and the store drops it), so the
 *  gateway denies every op until a group is granted. (Pre-§7.1 the boot seed
 *  auto-granted read-tier ops on enrollment; that unconditional read seed is
 *  removed — D-182 §7.1 inc 5c.)
 *
 *  Glue mechanics mirror `wireHubSpotReconciliation` (`data/hubspot/boot.ts`)
 *  and `wireWorkEntitySourceBoot` (`work-entity-source-boot.ts`):
 *
 *    1. At boot, scan every `kind: 'api'` connection whose `config.vendor`
 *       has a registered catalog (`catalogSlugForConnection`) and seed its
 *       profile from THAT vendor's catalog manifest.
 *    2. On `connection.upsert`, RECONCILE the row: (re)seed when it is a
 *       catalog connection, drop the profile when its vendor flipped to a
 *       non-catalog vendor (`hubspot → custom`) so a stale grant never
 *       outlives the connection it described.
 *    3. On `connection.delete`, drop the profile (revokes the grant).
 *
 *  Local-only by construction — the profile store never syncs cloud
 *  (D-090/D-097). The grant is derived live from the loaded catalog
 *  manifest (`getManifest`), so it stays in lock-step with the manifest
 *  JSON rather than duplicating its operation list here.
 *
 *  Known limitations carried by the P0 grant model (NOT introduced here;
 *  they land with the follow-on grant-ownership D / D-166, which P0 already
 *  deferred operation-identity binding to):
 *
 *    - `allowed_operations` holds bare SHORT keys (`contact.read`), and two
 *      catalogs can share one (`contact.read` exists on both the HubSpot and
 *      Salesforce catalogs). The profile store is keyed by connection NAME and
 *      a connection has exactly one vendor, so the right vendor's keys seed per
 *      connection — and to stop a colliding key from being honored across
 *      catalogs (a recipe pointing one catalog's step at the OTHER vendor's
 *      connection), each profile is STAMPED with its `catalog_slug` and the
 *      gateway denies a dispatch whose catalog slug doesn't match
 *      (`catalog_mismatch`, fail-closed BEFORE the grant check — see
 *      `resolveCatalogOperationPolicy`). A vendor-unique key (`opportunity.read`,
 *      `deal.read`) is still caught as `operation_not_granted`. What remains
 *      for the grant-ownership D (D-166) is the FULL pack-owned grant-key model
 *      (`InstalledAgentConnectionGrant`, per-pack effective view) — the
 *      `catalog_slug` stamp is the minimal dispatch-gate guard, not that model.
 *    - This wire is the SOLE writer of catalog profiles today, so it owns
 *      each profile wholesale (set replaces, empty/miss deletes). When the
 *      P3 install planner takes over with `InstalledAgentConnectionGrant`
 *      rows it SUPERSEDES this hand-seeding entirely (per
 *      `connection-operation-profile.ts`), so there is no co-owner to merge
 *      with or clobber today; a routine token-refresh upsert re-seeds the
 *      identical deterministic set.
 *
 *  Spec: D-165 § "P1 — First OAuth provider pilot". */

import type {
  ConnectionOperationProfile,
  ConnectionRow,
  IngredientManifest,
  RiskTier,
} from '@recued/contracts';
// The vendor → catalog-slug registry lives in contracts (the single source of
// truth shared with the grant rpcs + the webclient grant panel — apps/ can't
// import this server module). `catalogSlugForConnection` below adapts it to a
// `ConnectionRow` (a backend type). `deriveDependencyReadAdmissions` is the
// shared source-dependency read admission (D-192 Slice 7) the consent-disclosure
// UIs also call, so the gate and the disclosure can never drift.
import { catalogSlugForVendor, deriveDependencyReadAdmissions } from '@recued/contracts';
import { resolveConnectionVendor, type ConnectionStoreSqlite } from './storage/connection-store.js';
import type { ContractGrantStore } from './storage/contract-grant-store.js';
import type { ConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import {
  createInMemoryConnectionOperationProfileStore,
  type ConnectionOperationProfileStore,
} from './connection-operation-profile.js';

/** Resolve a connection row's vendor — `kind: 'api'` only (other kinds carry no
 *  catalog). Delegates to the shared `resolveConnectionVendor` so the SEED path
 *  here resolves a row's vendor IDENTICALLY to the grant-WRITE path
 *  (`connection-handler.ts:resolveVendorFromConnection`); the D-165 P3.grant
 *  migration keys `contract.grant` on the resulting catalog slug, so any
 *  divergence would strand a grant this reseed never re-merges (config.vendor
 *  first, then the `subtype` fallback — both honoured here too). */
const connectionVendor = (row: ConnectionRow): string | undefined =>
  row.kind === 'api' ? resolveConnectionVendor(row) : undefined;

/** The catalog slug a connection's grants operate against, or undefined when
 *  it is not a catalog-backed vendor (no slug ⇒ the wire leaves it alone).
 *
 *  Also THE authority for "does this connection survive a local-binding removal":
 *  a defined slug means the connection resolves to a REGISTERED vendor catalog,
 *  which WINS over any local binding (see `catalogForConnection`'s `??` order) — so
 *  dropping its pack binding leaves its vendor profile intact. The R2 4c.3 uninstall
 *  disclosure (`listRecipesWorsenedByPackUninstall`) reuses this to avoid FALSELY
 *  reporting a registered-vendor connection's dependents as disabled. */
export const catalogSlugForConnection = (row: ConnectionRow): string | undefined =>
  catalogSlugForVendor(connectionVendor(row));

/** Derive a connection's full `allowed_operations` set from the catalog
 *  manifest + the user's explicitly-granted operation GROUPS.
 *
 *    allowed = { ops of each granted group }
 *            ∪ { READ-tier list_op of each work-entity Source container dependency
 *                whose GROUP-granted bound op cannot run without it }
 *                                        (D-192 Slice 7 — see the block below)
 *
 *  Deny until granted (D-182 §7.1 inc 5c). NOTHING is admitted without an
 *  explicit group grant — read ops included — EXCEPT a granted op's mechanically-
 *  required container reads (the second clause: a `source_dependencies[].list_op`
 *  a granted create/list op cannot run without). That extension is bounded: the
 *  list_op must be RISK-TIER READ (a write is never promoted) and its bound op
 *  must be GROUP-granted (a sibling dependency's admitted read never counts).
 *  Every operation belongs to exactly
 *  one declared group (read ops to a `risk_floor: 'read'` group, the decomposer
 *  guarantees one group per op, the hand-authored vendor catalogs group every
 *  op), so granting a read group is what makes its read ops reachable, exactly
 *  as granting a write group makes `write→ask` reachable. An ungranted
 *  connection derives the empty set → its profile is dropped → the gateway
 *  denies with `no_connection_profile` (fail-closed). A read op declared in NO
 *  group is unreachable by construction (fail-closed; the corpus has none).
 *  Returns short operation keys (the keys of the `operations` map), which is
 *  exactly what `resolveCatalogOperationPolicy` looks up against. A granted
 *  group whose ops the manifest no longer declares is ignored (forward-safe
 *  against manifest drift). Deterministic order (group declaration order,
 *  deduped). */
export const deriveAllowedOperations = (
  manifest: IngredientManifest | null | undefined,
  grantedGroups: ReadonlyArray<string>,
): string[] => {
  const operations = manifest?.operations;
  if (!operations) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Own-property check (not bare `operations[key]`) so a malformed catalog
  // group listing `operations: ['constructor']` can't smuggle an inherited
  // prototype key (`constructor` / `toString`) into `allowed_operations`.
  const add = (key: string): void => {
    if (Object.prototype.hasOwnProperty.call(operations, key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };
  const groups = manifest?.operation_groups;
  if (groups && grantedGroups.length > 0) {
    const grantedSet = new Set(grantedGroups);
    for (const [group_id, groupSpec] of Object.entries(groups)) {
      if (!grantedSet.has(group_id)) continue;
      for (const op of groupSpec.operations ?? []) add(op);
    }
  }
  // D-192 Slice 7 follow-on — a work-entity Source's create-assist / sync must
  // READ its container dependencies (`source_dependencies[].list_op`, e.g. Linear
  // `team.search`) as a mechanical sub-step of a GRANTED Source op: you cannot
  // create an issue without first reading which teams exist. That container-read op
  // sits in its OWN entity group (`linear.team.read`), SEPARATE from the Source's
  // sync/write groups — a group the user cannot be expected to know to grant, so
  // requiring it explicitly would silently break every create (`operation_not_granted`
  // → the dependency resolves `unresolved` → the create config-fails). This is NOT a
  // blanket relaxation of §7.1 "deny until granted": it EXTENDS a granted op to the
  // reads mechanically required to perform it — a dependency's `list_op` (a READ)
  // becomes reachable ONLY when an op it BINDS is already in the granted set, and
  // ONLY the specific list_op. A dependency `create_op` (a WRITE — container
  // create-if-not-picked) is NEVER auto-admitted here; container creation stays an
  // explicit grant. Runs after the group loop so `seen` holds the full granted set.
  const sources = manifest?.work_entity_sources;
  if (sources) {
    // SNAPSHOT the group-granted ops BEFORE any dependency addition. Gating on the
    // live `seen` would let one dependency's admitted list_op transitively satisfy
    // ANOTHER dependency's bound-op gate (codex MED) — a dependency read must be
    // unlocked ONLY by a group grant, never by a sibling dependency. The shared
    // `deriveDependencyReadAdmissions` IS this admission (D-192 Slice 7) — the same
    // function the consent-disclosure UIs call, so the gate and what the UI
    // discloses can never diverge. `riskOfOp` keeps the own-property + read-tier
    // defense (a group listing a prototype key, or a pack naming a write / broad
    // read as a `list_op`, is refused); `add` still dedups against the full
    // granted set + re-checks own-property.
    const grantedOps = new Set(seen);
    const admissions = deriveDependencyReadAdmissions({
      sources,
      riskOfOp: (op) =>
        Object.prototype.hasOwnProperty.call(operations, op)
          ? (operations as Record<string, { risk_tier?: RiskTier }>)[op]?.risk_tier
          : undefined,
      grantedOps,
    });
    for (const admission of admissions) add(admission.list_op);
  }
  return out;
};

export interface WireCatalogOperationProfilesInput {
  /** The connection store to scan + observe. */
  connectionStore: ConnectionStoreSqlite;
  /** The (D-165 P0) profile store the gateway resolves against. */
  profileStore: ConnectionOperationProfileStore;
  /** Resolves a catalog-form ingredient manifest by bare slug —
   *  `executorConfig.manifests.get` (returns `null` when absent). Read
   *  live on every (re)seed so the grant tracks the loaded manifest. */
  getManifest: (slug: string) => IngredientManifest | null | undefined;
  /** D-165 P3.grant migration — durable operation-GROUP grants from the
   *  `contract.grant` store. When wired, the seed derives each connection's
   *  `allowed_operations` from its granted groups (`deriveAllowedOperations`),
   *  so a grant survives every re-seed (token-refresh upsert) + process restart.
   *  The merge UNIONS both grant owners (D-165 P3, Path A — the effective view
   *  per `(ingredient_id, connection_name)`): `listUserGroups` (the `__user__`
   *  manual half) + `listPackOwnedGroups` (every installed pack's grants).
   *  Read-only here (keyed by the connection's catalog slug = ingredient_id); the
   *  grant/revoke rpcs + the install planner are the writers. Omitted → no grants
   *  → empty profile → fail-closed (D-182 §7.1 inc 5c: deny until granted). */
  contractGrantStore?: Pick<ContractGrantStore, 'listUserGroups' | 'listPackOwnedGroups'>;
  /** D-170 gap #2 — connection → local composition-catalog bindings. When wired, a
   *  connection with no registered vendor but a recorded local-catalog binding is ALSO
   *  seeded (its profile resolves the local catalog), so a private/local composition's
   *  catalog is gateway-dispatchable. Registered vendors resolve via `config.vendor`;
   *  local catalogs resolve via this store (keyed by connection name). Omitted →
   *  registered-vendor-only seeding (the pre-gap-#2 behaviour). */
  connectionCatalogBindingStore?: Pick<ConnectionCatalogBindingStore, 'resolveCatalogSlug' | 'list'>;
}

/** The deps subset needed to derive + write ONE connection's operation profile. */
interface ProfileSeedDeps {
  profileStore: ConnectionOperationProfileStore;
  getManifest: (slug: string) => IngredientManifest | null | undefined;
  contractGrantStore?: Pick<ContractGrantStore, 'listUserGroups' | 'listPackOwnedGroups'>;
}

/** Derive + write (or delete) the operation profile for ONE connection bound to
 *  `catalogSlug`. Empty allowed set or no catalog ⇒ DROP the profile (fail-closed —
 *  a missing profile denies with `no_connection_profile`, not a misleading
 *  `operation_not_granted`). The set is derived from the connection's GRANTED
 *  groups (D-182 §7.1 inc 5c — no read-tier auto-grant) UNIONED across both grant
 *  owners per `(ingredient_id, connection_name)` (D-165 P3): `listUserGroups` (the
 *  `__user__` manual half) + `listPackOwnedGroups` (every installed pack's grants);
 *  `deriveAllowedOperations` dedupes. An ungranted connection derives the empty set
 *  → its profile is dropped → deny until granted. The profile is stamped with
 *  `catalogSlug` so the gateway rejects a colliding short key dispatched from a
 *  DIFFERENT catalog (`catalog_mismatch`). */
const applyConnectionProfile = (
  deps: ProfileSeedDeps,
  connectionName: string,
  catalogSlug: string | undefined,
): void => {
  const allowed_operations = catalogSlug
    ? deriveAllowedOperations(deps.getManifest(catalogSlug), [
        ...(deps.contractGrantStore?.listUserGroups(catalogSlug, connectionName) ?? []),
        ...(deps.contractGrantStore?.listPackOwnedGroups(catalogSlug, connectionName) ?? []),
      ])
    : [];
  if (!catalogSlug || allowed_operations.length === 0) {
    deps.profileStore.delete(connectionName);
    return;
  }
  deps.profileStore.set(connectionName, { allowed_operations, catalog_slug: catalogSlug });
};

// D-170 gap #2 live-reconcile — `applyConnectionProfile` is the shared primitive the
// install/uninstall reconcile reuses. A composition install/uninstall changes the
// binding/grants but NOT the connection row, so the `addOnUpsert` observer below never
// fires for it. `wireCatalogOperationProfiles` therefore RETURNS a
// `reconcileConnectionProfile(name)` the install path calls post-commit (for the bound
// `auth.connection`) + the uninstall path calls after the binding is dropped — so a
// local catalog becomes dispatchable / a removed one stops dispatching IMMEDIATELY,
// not only on the next connect (the observer) or boot (Pass 1b). It resolves
// registered-vendor-first (else the binding), then `applyConnectionProfile` derives or
// (fail-closed) drops the profile. Before this was wired the secondary "connect BEFORE
// install" flow was fail-closed until the next reconnect/boot (the gateway denied
// `no_connection_profile`, never over-granting), and uninstall left an unreachable
// stale profile (the catalog was unregistered) — UX latency, never a hole.

/** The handle `wireCatalogOperationProfiles` returns: the immediate-reconcile
 *  primitive the install/uninstall deps drive (D-170 gap #2 live-reconcile). */
export interface CatalogOperationProfileWiring {
  /** (Re)derive ONE connection's operation profile NOW, by name — the install /
   *  uninstall counterpart to the upsert observer (which fires only when the
   *  connection ROW changes, not when a composition install merely writes/drops a
   *  binding). Registered-vendor catalog wins over a local binding; on success the
   *  profile is seeded, on no-resolution (uninstall → binding gone) it is dropped
   *  (fail-closed). Idempotent; safe to call with a name that resolves nothing. */
  reconcileConnectionProfile: (connectionName: string) => void;
}

/** D-165 — wire catalog-operation profile seeding for every catalog-backed
 *  vendor (`CATALOG_VENDOR_SLUGS`: HubSpot P1, Salesforce RUNTIME #4) + D-170 gap #2
 *  local composition catalogs bound to a connection.
 *
 *  Idempotent + safe under multiple calls (each call seeds the passed
 *  profile store + installs its own additive observers). When a connection's
 *  catalog manifest declares no read operations (not loaded, or a
 *  hypothetical write-only catalog), nothing is granted — the store stays
 *  empty and the gateway keeps failing closed, which is the correct posture
 *  (no profile → `no_connection_profile` deny). */
export const wireCatalogOperationProfiles = (
  input: WireCatalogOperationProfilesInput,
): CatalogOperationProfileWiring => {
  // Bind this wire's stores to the shared `applyConnectionProfile` derivation.
  const seedProfileFor = (connectionName: string, catalogSlug: string | undefined): void =>
    applyConnectionProfile(input, connectionName, catalogSlug);

  /** Resolve a connection's catalog: a registered vendor (`config.vendor` →
   *  `CATALOG_VENDOR_SLUGS`) OR a local composition catalog bound to it (D-170 gap #2,
   *  by connection name). A connection has at most one catalog, so the `??` order is
   *  unambiguous — registered vendor WINS over a local binding for the same name. */
  const catalogForConnection = (row: ConnectionRow): string | undefined =>
    catalogSlugForConnection(row)
    ?? input.connectionCatalogBindingStore?.resolveCatalogSlug(row.name);

  // D-170 gap #2 live-reconcile (returned below) — immediate by-NAME reconcile for the
  // install/uninstall deps. Mirrors the observer's resolution but starts from a name
  // (the bound `auth.connection`) rather than a connection row: look up the api row to
  // honor registered-vendor-first precedence (`catalogForConnection`), else resolve the
  // local binding directly (a non-`api` bound connection has no api row). `seedProfileFor`
  // then derives + writes the profile, or DROPS it when nothing resolves (post-uninstall,
  // the binding is gone → fail-closed delete; a registered-vendor connection keeps its
  // vendor profile). Reads stores live, so the caller MUST run it AFTER the install /
  // uninstall transaction commits the binding + grants.
  const reconcileConnectionProfile = (connectionName: string): void => {
    const apiRow = input.connectionStore.get('api', connectionName);
    const slug = apiRow
      ? catalogForConnection(apiRow)
      : input.connectionCatalogBindingStore?.resolveCatalogSlug(connectionName);
    seedProfileFor(connectionName, slug);
  };

  // 1. Boot scan — seed every existing REGISTERED-VENDOR api connection.
  for (const row of input.connectionStore.list({ kind: 'api' })) {
    const slug = catalogSlugForConnection(row);
    if (slug) seedProfileFor(row.name, slug);
  }

  // 1b. Boot — seed every LOCAL-CATALOG-bound connection (D-170 gap #2). Iterated
  //     from the bindings directly so a local-catalog connection is seeded regardless
  //     of its kind / whether it appeared in the api scan above; a binding whose
  //     catalog no longer resolves seeds nothing (deleted, fail-closed). REGISTERED
  //     VENDOR WINS: if the bound connection is itself a registered-vendor api
  //     connection, its vendor catalog takes precedence over the local binding (so a
  //     composition that bound a hubspot connection by name can't shadow the hubspot
  //     profile) — mirrors `catalogForConnection`'s `??` order used by the observer.
  for (const binding of input.connectionCatalogBindingStore?.list() ?? []) {
    const apiRow = input.connectionStore.get('api', binding.connection_name);
    const slug = (apiRow ? catalogSlugForConnection(apiRow) : undefined) ?? binding.catalog_slug;
    seedProfileFor(binding.connection_name, slug);
  }

  // 2. Future enrollments / vendor flips / connect-after-install. RECONCILE on every
  //    upsert: re-seed when the connection resolves a catalog (registered vendor OR a
  //    local binding — so connecting AFTER a composition install lights up its
  //    catalog here), else drop any stale profile. The additive `addOnUpsert` hook
  //    coexists with the vendor reconciliation + work-entity-source wires.
  input.connectionStore.addOnUpsert((row) => {
    const slug = catalogForConnection(row);
    if (slug) {
      seedProfileFor(row.name, slug);
    } else if (row.kind === 'api') {
      // Vendor flipped to a non-catalog vendor (or never was one) and no local
      // binding — drop any stale profile under this name. Deleting absent is a no-op.
      input.profileStore.delete(row.name);
    }
  });

  // 3. Deletions — profiles are keyed by connection NAME while the durable
  //    store is keyed by (kind, name). Revoke after the last same-name row is
  //    gone; if another kind remains, re-derive it with registered-api
  //    precedence. This covers local catalogs bound to MCP connections without
  //    breaking the supported same-name API+MCP coexistence case.
  input.connectionStore.addOnDelete((_kind, name) => {
    const apiRow = input.connectionStore.get('api', name);
    const hasRemainingConnection = apiRow !== null
      || input.connectionStore.list().some((row) => row.name === name);
    if (!hasRemainingConnection) {
      input.profileStore.delete(name);
      return;
    }
    const slug = apiRow
      ? catalogForConnection(apiRow)
      : input.connectionCatalogBindingStore?.resolveCatalogSlug(name);
    seedProfileFor(name, slug);
  });

  return { reconcileConnectionProfile };
};

/** What {@link createSeededCatalogOperationProfileStore} hands back: the seeded
 *  profile store (for the gateway + grant rpcs) AND the live-reconcile primitive
 *  (D-170 gap #2) the install/uninstall deps drive. Both are backed by the SAME
 *  closure, so a reconcile mutates the very store the gateway resolves against. */
export interface SeededCatalogOperationProfiles extends CatalogOperationProfileWiring {
  profileStore: ConnectionOperationProfileStore;
}

/** Boot-composer convenience: create a fresh in-memory profile store,
 *  boot-seed + observer-wire it for every catalog vendor via
 *  `wireCatalogOperationProfiles`, and return it (with the live-reconcile
 *  primitive) ready to hand to `composeExecuteDeps` as
 *  `connectionOperationProfiles` + the install/uninstall deps.
 *
 *  Keeping the seeding side effect HERE (at the boot/caller layer, called
 *  from `compose-execution-context` + `cli-context/mcp`) — rather than
 *  inside `composeExecuteDeps` — matches the existing vendor-boot wires
 *  (`wireHubSpotReconciliation`, `wireWorkEntitySourceBoot`) and keeps the
 *  deps composer side-effect-free: it builds the deps object and must not
 *  call `.list()` / `.addOnUpsert()` on a store the caller may have stubbed.
 *  This is the "caller-provided, seeded store" shape D-165 P0 anticipated
 *  (`connection-operation-profile.ts` header). */
export const createSeededCatalogOperationProfileStore = (input: {
  connectionStore: ConnectionStoreSqlite;
  getManifest: (slug: string) => IngredientManifest | null | undefined;
  /** D-165 P3.grant migration — durable grants from `contract.grant` merged into
   *  every (re)seed: the `__user__` manual half + every installed pack's grants
   *  (UNIONED per `(ingredient_id, connection_name)`). Omit → no grants → empty
   *  profiles (D-182 §7.1 inc 5c: deny until granted). */
  contractGrantStore?: Pick<ContractGrantStore, 'listUserGroups' | 'listPackOwnedGroups'>;
  /** D-170 gap #2 — connection → local composition-catalog bindings, so a
   *  private/local catalog connection is seeded + dispatchable. Omit for
   *  registered-vendor-only seeding. */
  connectionCatalogBindingStore?: Pick<ConnectionCatalogBindingStore, 'resolveCatalogSlug' | 'list'>;
}): SeededCatalogOperationProfiles => {
  const profileStore = createInMemoryConnectionOperationProfileStore();
  const { reconcileConnectionProfile } = wireCatalogOperationProfiles({
    connectionStore: input.connectionStore,
    profileStore,
    getManifest: input.getManifest,
    ...(input.contractGrantStore ? { contractGrantStore: input.contractGrantStore } : {}),
    ...(input.connectionCatalogBindingStore
      ? { connectionCatalogBindingStore: input.connectionCatalogBindingStore }
      : {}),
  });
  return { profileStore, reconcileConnectionProfile };
};
