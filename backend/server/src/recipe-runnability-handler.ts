/** `recipe.runnability` rpc handler — the DISCLOSURE half of D-182 step 8 R1.
 *
 *  The READ SURFACE the run path already enforces (`handleExecute` rewrites unbound
 *  canonical reads to empty + warns, blocks unbound canonical writes). For every
 *  known recipe it returns the R1 verb-split verdict against the CURRENTLY bound
 *  convention families — `runnable` / `degraded` / `blocked` — derived from the
 *  SAME `deriveBoundConventionFamilies` the run uses, so the view can never
 *  advertise a recipe runnable that the run then empties/blocks. The webclient
 *  recipes view reads this on mount + re-reads on the `recipe_runnability_changed`
 *  broadcast to render the "CRM not connected — add a provider" disclosure.
 *
 *  RE-GROUNDED FROM CAPABILITY-DI (D-182 §3): the dropped R2 model derived status
 *  from each recipe's declared `dependencies` graph against gathered providers'
 *  per-op grants. D-182 drops capability-DI — status is now the kernel-derived R1
 *  check (convention family bound iff a vendor in it is enrolled), computed by
 *  `applyKernelOpRunnability` per recipe. The wire shape (`RecipeRunnabilityEntry`)
 *  is UNCHANGED — its `dependencies` detail is synthesized from the R1 entries
 *  (`synthesizeDependencies`) so the webclient + the install/uninstall disclosure
 *  copy keep rendering with no contract change. The recipe `dependencies` field +
 *  the capability-DI types are deleted in the coordinated cleanup slice (it touches
 *  the peer-owned webclient + community recipes). Until then the install `born_*` +
 *  uninstall reverse-walk (`listRecipesWorsenedByPackUninstall` + `liveRegistry`)
 *  still run the capability-DI path below.
 *
 *  DISCLOSURE, NOT enforcement — the D-157 gate + the run-path R1 already fail
 *  closed; this only surfaces the derived state. RECOMPUTED-ON-READ: a pure
 *  function of the current connections (no persisted derived state to get stale);
 *  the connection mutation handlers fire `recomputeAndEmit()` so a connect /
 *  disconnect re-fans the fresh snapshot.
 *
 *  Channel posture: a thin local-UI rpc beside `recipe.list`, NOT in
 *  `MCP_TOOL_CATALOG` — runnability discloses which convention families have no
 *  bound provider (connection topology), which stays off the MCP-channel agent
 *  surface. Absent deps (dbless harness / no connection store) → the slice is
 *  omitted and the rpc returns `not_configured`, exactly like `recipe.list`.
 */
import {
  classifyCanonicalVerb,
  isKernelConnectionFamily,
  parseOpId,
  type ConnectionVendorEntity,
  type DependencyResolution,
  type HandlerSlice,
  type KernelConnectionFamily,
  type RecipeDefinition,
  type RecipeRunnabilityEntry,
  type RunnabilityStatus,
  type RunnabilityTransition,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { applyKernelOpRunnability, type KernelRunnabilityEntry } from '@recued/recipes';
import {
  deriveBoundConventionFamilies,
  liveVendorRegistry,
} from './connection-convention-families.js';
import { missingPackDependencies } from './pack-inventory.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { RecipeStore } from './recipe-store.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import type { WsClient } from './ws-server.js';

export interface RecipeRunnabilityHandlerDeps {
  /** Bound connections — the family derivation scans `kind: 'api'`. */
  connectionStore: Pick<ConnectionStoreSqlite, 'list'>;
  /** Recipes to evaluate (their canonical `core.crm.*`/`core.acct.*` op-steps). */
  recipeStore: Pick<RecipeStore, 'get' | 'ids'>;
  /** D-170 installed-manifest store — source of pack-composition CRM/acct vendors'
   *  decomposed entity schemas, feeding the merged vendor registry
   *  (`liveVendorRegistry`). Read LIVE per request (recompute-on-read) so it
   *  reflects packs installed / uninstalled after boot. Absent (dbless / pre-D-170
   *  boot) → built-in HubSpot / Salesforce vendors only. */
  localManifestStore?: Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'>;
  /** The refcount-aware set of LOCAL composition catalog ids a `pack_slug` uninstall
   *  would delete (`privateByoDropIds` — a catalog another pack still lists survives).
   *  The reverse-walk removes their pack-composition vendors from the post-uninstall
   *  registry to find which recipes' convention families become unbound. Absent
   *  (dbless / no contract store) → the reverse-walk discloses nothing. */
  localCatalogDropIdsForPack?: (pack_slug: string) => readonly string[];
  /** The `<publisher>.<pack>` refs currently resolvable — i.e. installed AND
   *  binding a catalog. A recipe declaring one that is absent cannot LOWER
   *  (`lowerSequentialStep` throws before step 1), so it is `blocked` no matter
   *  what its connection families say.
   *
   *  ⚠ Absent (dbless / no contract store) ⇒ the pack arm discloses nothing
   *  rather than claiming every pack is missing. Same fail-open posture as the
   *  scheduler's fire-time gate, and for the same reason: "cannot tell" must not
   *  render as "nothing here works". */
  installedPackRefs?: () => ReadonlySet<string>;
}

/** Poll-manager / G6 — re-exported from the shared convention-families home so the
 *  watch composer + the event-trigger composer resolve the SAME live merged registry
 *  (built-ins + installed pack-composition vendors) that R1's run + disclosure halves
 *  bind against; without it a 3rd-party vendor's watch would fail config ("no
 *  projectable canonical fields") even though install + runnability resolve it. */
export { liveVendorRegistry };

const liveRegistry = (
  deps: RecipeRunnabilityHandlerDeps,
): ReadonlyArray<ConnectionVendorEntity> => liveVendorRegistry(deps.localManifestStore);

// ────────────────────────────────────────────────────────────────
// D-182 §10 step 8 / R1 — the disclosure half, re-grounded on the verb-split
// ────────────────────────────────────────────────────────────────

/** The convention family + write-class of ONE unbound canonical op entry. Every
 *  entry `applyKernelOpRunnability` produces is a `core.crm.*` / `core.acct.*` op
 *  (closed-kind + bound-family ops never enter the entry lists), so the parsed
 *  domain IS the convention family. An unrecognized verb counts as a write (HARD)
 *  — consistent with the R1 gatherer's fail-closed default for a malformed verb.
 *  null for anything that doesn't parse as a kernel convention op (defensive). */
const entryFamilyVerb = (
  entry: KernelRunnabilityEntry,
): { family: KernelConnectionFamily; verb: string; write: boolean } | null => {
  const parsed = parseOpId(entry.op);
  if (parsed === null || parsed.tier !== 'kernel' || !isKernelConnectionFamily(parsed.domain)) {
    return null;
  }
  const verb = parsed.op.split('.').pop() ?? '';
  return { family: parsed.domain, verb, write: classifyCanonicalVerb(verb) !== 'read' };
};

/** Synthesize the wire-shape `DependencyResolution[]` from the R1 entries, so the
 *  unchanged `RecipeRunnabilityEntry` shape (and the webclient pills +
 *  install/uninstall disclosure copy that read it) keep rendering with NO contract
 *  change. One entry per unbound convention family: `capability` = the family
 *  (`crm`/`acct`), `ops` = the affected canonical verbs, `optional` = read-only (a
 *  write/destructive op in the family makes it HARD → drives the
 *  "(optional — those steps skip)" suffix in `runnabilityDisclosureLines`). Always
 *  unsatisfied with empty `providers` — the whole point is the family has no bound
 *  provider; `unprovided_ops` echoes `ops` so the disclosure names exactly what a
 *  provider must add. */
const synthesizeDependencies = (
  entries: readonly KernelRunnabilityEntry[],
): DependencyResolution[] => {
  const byFamily = new Map<KernelConnectionFamily, { verbs: Set<string>; hard: boolean }>();
  for (const entry of entries) {
    const fv = entryFamilyVerb(entry);
    if (fv === null) continue;
    const slot = byFamily.get(fv.family) ?? { verbs: new Set<string>(), hard: false };
    slot.verbs.add(fv.verb);
    if (fv.write) slot.hard = true;
    byFamily.set(fv.family, slot);
  }
  return [...byFamily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, slot]) => {
      const ops = [...slot.verbs].sort();
      return {
        capability: family,
        ops,
        optional: !slot.hard,
        satisfied: false,
        providers: [],
        unprovided_ops: ops,
      };
    });
};

/** A recipe's R1 status alone (the status half of `kernelRunnability`, without the
 *  synthesized per-family detail): an unbound write/destructive canonical op →
 *  `blocked`; only unbound canonical reads → `degraded`; every canonical family
 *  bound (or no canonical op) → `runnable`. Used by the reverse-walk's before/after
 *  diff. */
const kernelStatusOf = (
  recipe: RecipeDefinition,
  boundFamilies: ReadonlySet<KernelConnectionFamily>,
): RunnabilityStatus => {
  const verdict = applyKernelOpRunnability(recipe, boundFamilies);
  if (!verdict.ok) return 'blocked';
  return verdict.warnings.length > 0 ? 'degraded' : 'runnable';
};

/** `runnable` < `degraded` < `blocked` — a higher rank is a worse state. */
const STATUS_RANK: Record<RunnabilityStatus, number> = { runnable: 0, degraded: 1, blocked: 2 };

/** R1 disclosure for ONE recipe (the verb-split applied read-only). Maps the three
 *  `applyKernelOpRunnability` outcomes to the wire status: an unbound
 *  write/destructive canonical op → `blocked` (the run fails closed pre-run); only
 *  unbound canonical reads → `degraded` (the run continues on empty data + warns);
 *  every canonical family bound (or no canonical op) → `runnable`. A blocked recipe
 *  may also carry degraded reads in another family, so its synthesized detail spans
 *  both the blocked + warned entries. */
/** One `DependencyResolution` per pack the recipe declares but cannot resolve.
 *
 *  The MISSING-PACK decision itself is `pack-inventory`'s `missingPackDependencies`
 *  — the same call the run path and the scheduler's fire-time gate make. This
 *  only projects that answer into the disclosure's wire shape. A local
 *  re-implementation here would be a second source of truth for the one property
 *  every surface must agree on, and the disagreement would be invisible: each
 *  surface would look self-consistent while naming different packs.
 *
 *  `capability` holds the pack_ref; the disclosure tells packs from connection
 *  families with `isKernelConnectionFamily`. Always HARD (`optional: false`) — a
 *  missing pack does not degrade a run, it stops it starting. `unprovided_ops`
 *  stays empty: there is no partial coverage to describe, the pack is absent. */
const missingPackDeps = (
  recipe: RecipeDefinition,
  installed: ReadonlySet<string>,
): DependencyResolution[] =>
  missingPackDependencies(recipe, installed).map((ref) => ({
    capability: ref,
    ops: [],
    optional: false,
    satisfied: false,
    providers: [],
    unprovided_ops: [],
  }));

const kernelRunnability = (
  recipe_id: string,
  recipe: RecipeDefinition,
  boundFamilies: ReadonlySet<KernelConnectionFamily>,
  installedPacks: ReadonlySet<string> | null,
): RecipeRunnabilityEntry => {
  // A missing pack outranks every family verdict: the recipe cannot lower, so
  // no amount of connection binding makes it runnable. Listed FIRST so the
  // disclosure leads with the thing the owner can actually fix.
  const packDeps = installedPacks === null
    ? []
    : missingPackDeps(recipe, installedPacks);
  const verdict = applyKernelOpRunnability(recipe, boundFamilies);
  if (!verdict.ok) {
    return {
      recipe_id,
      status: 'blocked',
      dependencies: [
        ...packDeps,
        ...synthesizeDependencies([...verdict.blocked, ...verdict.warnings]),
      ],
    };
  }
  if (packDeps.length > 0) {
    // Blocked on the pack even though every family it needs is bound — and the
    // family warnings still ride along, so fixing the pack does not then reveal
    // a second problem the disclosure had been hiding.
    return {
      recipe_id,
      status: 'blocked',
      dependencies: [...packDeps, ...synthesizeDependencies(verdict.warnings)],
    };
  }
  if (verdict.warnings.length > 0) {
    return { recipe_id, status: 'degraded', dependencies: synthesizeDependencies(verdict.warnings) };
  }
  return { recipe_id, status: 'runnable', dependencies: [] };
};

/** Compute every known recipe's R1 disclosure against the live bound convention
 *  families — the SAME `deriveBoundConventionFamilies` the run path uses, so the
 *  disclosure can never advertise a recipe as runnable that the run then
 *  empties/blocks. Family-COARSE: per-op grants play no part (R1 asks "is a vendor
 *  in the family bound at all", not which ops are granted). The webclient filters to
 *  the non-`runnable` entries for disclosure. */
const computeKernelRunnabilityForAll = (
  deps: RecipeRunnabilityHandlerDeps,
): RecipeRunnabilityEntry[] => {
  // The LIVE merged registry (built-ins + installed pack-composition vendors) so a
  // connected QuickBooks/Xero (`acct`) or 3rd-party CRM vendor binds its family —
  // the SAME registry the run path passes, so disclosure can't disagree.
  const boundFamilies = deriveBoundConventionFamilies(deps.connectionStore, liveRegistry(deps));
  // Resolved ONCE per read, not per recipe — the inventory scan is the expensive
  // half and it cannot change mid-walk. `null` (dep unwired) disables the pack
  // arm entirely rather than treating every pack as missing.
  const installedPacks = deps.installedPackRefs?.() ?? null;
  const out: RecipeRunnabilityEntry[] = [];
  for (const recipe_id of deps.recipeStore.ids()) {
    const recipe = deps.recipeStore.get(recipe_id);
    if (recipe === null) continue;
    out.push(kernelRunnability(recipe_id, recipe, boundFamilies, installedPacks));
  }
  return out;
};

/** Compute every known recipe's R1 disclosure (status + the synthesized per-family
 *  detail) for the `recipe.runnability` rpc + the `recipe_runnability_changed`
 *  broadcast. */
export const listRecipeRunnability = (
  deps: RecipeRunnabilityHandlerDeps,
): { recipes: RecipeRunnabilityEntry[] } => ({
  recipes: computeKernelRunnabilityForAll(deps),
});

/** The reverse-walk read powering the uninstall "this disables N recipes"
 *  disclosure (doc §1.6), re-grounded on the kernel R1 verb-split (the dropped
 *  capability-DI provider diff is gone). Which known recipes WORSEN when `pack_slug`
 *  is uninstalled? Recomputes each recipe's R1 status against the bound convention
 *  families BEFORE vs AFTER the uninstall, and returns the strict worsenings.
 *  Recompute-on-read; the caller (`packs.uninstall`) splits the result by `after`
 *  (blocked → `would_disable`, degraded → `would_degrade`) + drops its own deleted
 *  recipes.
 *
 *  R1 is FAMILY-COARSE — a recipe's runnability turns on whether a vendor in its
 *  `core.crm.*`/`core.acct.*` family is enrolled at all, not which per-op grants it
 *  holds. So the only thing an uninstall changes for R1 is the MERGED VENDOR
 *  REGISTRY: uninstall does NOT delete connection rows; it deletes the pack's
 *  locally-provisioned composition catalogs (`privateByoDropIds`, refcount-aware →
 *  a catalog another pack still lists survives). Each deleted catalog's
 *  pack-composition vendor leaves the registry, so EVERY enrolled connection
 *  carrying that vendor — whether or not it was bound to this pack — loses its
 *  family mapping. Built-in vendors (HubSpot / Salesforce) are unaffected.
 *  GRANT-shrink (a surviving connection losing this pack's op-grants) is INERT under
 *  R1 — it never changes which families are bound — so the former overlay simulation
 *  (and its profile / grant deps) is gone.
 *
 *  Diff the BEFORE / AFTER bound-family sets per recipe and return the strictly-
 *  worse ones (`STATUS_RANK`). The pack drops no local catalog (recipe-only pack /
 *  built-in-vendor binding) → the registry is unchanged → `[]` without walking
 *  recipes. Absent drop-ids callback or manifest store (dbless) → `[]`. */
/** Recipes that will not LOWER once `pack_slug` is gone — the Tier-P arm.
 *
 *  ⛔ WHY THIS IS SEPARATE FROM THE FAMILY WALK BELOW. R1 runnability is a pure
 *  function of bound CONNECTION families, and both of that walk's short-circuits
 *  (`dropIds.size === 0`, `afterFamilies.size === beforeFamilies.size`) are true
 *  for a pack that enrols no connection. So uninstalling a local-CLI pack —
 *  docling, whisper, ffmpeg, officecli — disclosed NOTHING while its dependent
 *  recipes were about to stop working. 121 of the shipped packs are `service_kind:
 *  cli`, and 34 recipes depend on one. An empty would-disable list reads as
 *  "nothing is affected", not "I did not look", which is the worst way for a
 *  disclosure to be wrong.
 *
 *  A recipe naming a Tier-P op of this pack does not degrade — it cannot start.
 *  `lowerSequentialStep` throws `CanonicalOpResolutionError` for "a two-tier id
 *  that resolves to nothing" BEFORE step 1, so the honest transition is
 *  `→ blocked` regardless of what the family walk would have said.
 *
 *  Keyed on `depends_on`, which is the recipe's declared `<publisher>.<pack>`
 *  list and is now enforced corpus-wide against the ops each recipe actually
 *  calls (`recipe-depends-on-coverage`). Before that enforcement 137 recipes
 *  under-declared and this walk would have missed them.
 *
 *  ⚠ Matched on the pack SLUG, not the publisher-qualified ref. That is
 *  deliberate and consistent: `installed_pack` is itself keyed by `pack_slug`
 *  alone (contract-schema `segments: ['pack_slug']`), so two publishers' packs
 *  with one slug cannot coexist in the inventory anyway. Qualifying here would
 *  claim a precision the inventory does not have. */
const listRecipesBlockedByPackUninstall = (
  deps: RecipeRunnabilityHandlerDeps,
  pack_slug: string,
  boundFamilies: ReadonlySet<KernelConnectionFamily>,
): RunnabilityTransition[] => {
  const out: RunnabilityTransition[] = [];
  for (const recipe_id of deps.recipeStore.ids()) {
    const recipe = deps.recipeStore.get(recipe_id);
    if (recipe === null) continue;
    const dependsOn = (recipe as { depends_on?: unknown }).depends_on;
    if (!Array.isArray(dependsOn)) continue;
    const namesPack = dependsOn.some((entry) =>
      typeof entry === 'string' && entry.slice(entry.indexOf('.') + 1) === pack_slug);
    if (!namesPack) continue;
    const before = kernelStatusOf(recipe, boundFamilies);
    // Already blocked for a connection reason → uninstalling does not WORSEN it.
    if (before === 'blocked') continue;
    out.push({ recipe_id, before, after: 'blocked' });
  }
  return out;
};

export const listRecipesWorsenedByPackUninstall = (
  deps: RecipeRunnabilityHandlerDeps,
  pack_slug: string,
): RunnabilityTransition[] => {
  // The Tier-P arm runs FIRST and unconditionally — it must not sit behind the
  // family walk's short-circuits, which is exactly the bug it fixes.
  const boundNow = deriveBoundConventionFamilies(deps.connectionStore, liveRegistry(deps));
  const blocked = listRecipesBlockedByPackUninstall(deps, pack_slug, boundNow);
  const seen = new Set(blocked.map((t) => t.recipe_id));

  // The local composition catalogs uninstall would actually delete (refcount-aware).
  // No droppable catalog (or no manifest store to drop from) → the merged registry
  // is unchanged → no R1 family can become unbound → nothing worsens.
  const dropIds = new Set(deps.localCatalogDropIdsForPack?.(pack_slug) ?? []);
  const store = deps.localManifestStore;
  if (dropIds.size === 0 || store === undefined) return blocked;

  const beforeFamilies = deriveBoundConventionFamilies(deps.connectionStore, liveRegistry(deps));
  const afterFamilies = deriveBoundConventionFamilies(
    deps.connectionStore,
    // The post-uninstall merged registry: the SAME live derivation with the dropped
    // pack-composition catalogs removed (their vendor entities gone). `getEntitySchemas`
    // is only ever called for a surviving slug, so it delegates straight through.
    liveVendorRegistry({
      listManifests: () => store.listManifests().filter((m) => !dropIds.has(m.slug)),
      getEntitySchemas: (slug, version) => store.getEntitySchemas(slug, version),
    }),
  );
  // Removing registry vendors can only SHRINK the bound set; an unchanged set worsens
  // nothing (the dropped catalogs' vendors had no enrolled connection, or another
  // connection still binds the same family). The Tier-P findings still stand.
  if (afterFamilies.size === beforeFamilies.size) return blocked;

  const out: RunnabilityTransition[] = [...blocked];
  for (const recipe_id of deps.recipeStore.ids()) {
    // A recipe already reported by the Tier-P arm is at `blocked`, the worst
    // rank — the family walk cannot worsen it further, and listing it twice
    // would double-count the disclosure the surface renders.
    if (seen.has(recipe_id)) continue;
    const recipe = deps.recipeStore.get(recipe_id);
    if (recipe === null) continue;
    const before = kernelStatusOf(recipe, beforeFamilies);
    const after = kernelStatusOf(recipe, afterFamilies);
    if (STATUS_RANK[after] > STATUS_RANK[before]) out.push({ recipe_id, before, after });
  }
  return out;
};

export type RecipeRunnabilityMethods = 'recipe.runnability';

export const makeRecipeRunnabilityHandlers = (
  deps: RecipeRunnabilityHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, RecipeRunnabilityMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['recipe.runnability'],
    handlers: {
      'recipe.runnability': async () => listRecipeRunnability(deps),
    },
  };
};

/** R2 build step 4c.4 — the reactive emit half. A narrow emitter the mutation
 *  handlers (connection connect/disconnect, operation-group grant/revoke, pack
 *  install/uninstall) drive AFTER their mutation commits: recompute every recipe's
 *  runnability and fan the fresh snapshot on the `recipe_runnability_changed` bus
 *  kind so paired clients re-render the recipes view's status. */
export interface RecipeRunnabilityBroadcaster {
  /** Recompute every recipe's runnability + broadcast the fresh snapshot.
   *  BEST-EFFORT — never throws (the mutation handlers call this AFTER they
   *  commit; a recompute / emit failure must never surface to or roll back the
   *  mutation that triggered it). */
  recomputeAndEmit(): void;
}

/** Build a broadcaster over the SAME deps the read surface uses, so the pushed
 *  snapshot is identical to what a `recipe.runnability` re-read would return.
 *  `emit` takes the runnability event MINUS the bus-stamped `cursor` (the
 *  `ServerEventInput` shape); the bin composer binds it to `EventBus.emit`. */
export const makeRecipeRunnabilityBroadcaster = (
  deps: RecipeRunnabilityHandlerDeps,
  emit: (event: {
    kind: 'recipe_runnability_changed';
    recipes: readonly RecipeRunnabilityEntry[];
  }) => void,
): RecipeRunnabilityBroadcaster => ({
  recomputeAndEmit: () => {
    try {
      emit({ kind: 'recipe_runnability_changed', recipes: listRecipeRunnability(deps).recipes });
    } catch {
      /* best-effort — a recompute / broadcast failure must never surface to the
       * mutation that triggered it. */
    }
  },
});
