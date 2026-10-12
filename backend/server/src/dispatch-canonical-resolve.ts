/** Build step 2 (R2 dispatch) — resolve a canonical recipe's op-steps to concrete,
 *  vendor-bound form AT DISPATCH, from the connection(s) the run supplies.
 *
 *  Spec: internal design notes
 *  §2–3 (R2). The R2 dispatch probe (`__tests__/r2-dispatch-resolve-then-execute-probe
 *  .test.ts`) proved the *downstream* path (gate/audit/engine) reuses unchanged when
 *  fed a pre-resolved recipe with NO persistence coupling; this is the missing
 *  *upstream* half — the dispatcher-side context-builder that produces that concrete
 *  recipe per run.
 *
 *  It is deliberately THIN: the connection→catalog edge already lives in
 *  `ExecuteHandlerDeps` (the operation-profile store carries `catalog_slug`), and the
 *  ctx-building + the canonical→concrete rewrite are the SAME machinery the install
 *  path uses (`resolvePerSlotOpStepRecipe`). The only new decision is *where the
 *  connections come from at run*: the recipe's `type:'connection'` variables, read
 *  from the run's `config` (the existing catalog-recipe convention, resolved at run
 *  instead of frozen at install).
 *
 *  Per-operand connection (R2 step 5, doc §1.3): each op-step binds its own SLOT —
 *  an explicit `connection: "{{config.<var>}}"` ref, or the recipe's single
 *  connection variable (`opStepConnectionSlots`). Each distinct slot resolves its
 *  own connection → operation profile → catalog, so a multi-operand recipe
 *  (compare / move / combine) dispatches each operand against its own platform;
 *  same-platform = the picked connections coincide. A slot whose variable is
 *  unbound at run still fails closed here, but the failure now carries a typed
 *  `unbound_slot` discriminant so the execute-handler's pick-resolution layer
 *  (doc §4 close-out — auto-bind a single capable candidate for interactive
 *  sources, raise the `gateway.pick` ask for several, block headless runs on
 *  the pinned-target rule) can branch without parsing the reason string.
 *
 *  FAIL-CLOSED: every path that can't resolve a concrete binding returns
 *  `{ ok: false, reason }` and changes nothing — the caller keeps rejecting the
 *  unresolved op-step recipe (the `execute-handler` guard). A recipe with no canonical
 *  op-step passes through untouched (`resolved: false`). */

import { isCanonicalOpStep, isPrefetchOpStep } from '@recued/contracts';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { CanonicalOpResolutionError, opStepConnectionSlots } from '@recued/recipes';

import { fanOutCanonicalSearches, type FanoutConnection } from './canonical-search-fanout.js';
import type { LiveCatalogVendors } from './connection-convention-families.js';
import { lowerTwoTierOpSteps, resolvePerSlotOpStepRecipe } from './ingredient-authoring/install-composition.js';
import type { ConnectionOperationProfile } from '@recued/contracts';
import type { PackOpResolution } from '@recued/recipes';

/** The slice of `ExecuteHandlerDeps` the dispatch resolver needs — a connection's
 *  operation profile (→ its bound `catalog_slug`) and the live manifest registry. */
export interface DispatchResolveDeps {
  profiles: { get(connection_name: string): ConnectionOperationProfile | null };
  manifests: { get(slug: string): IngredientManifest | null };
  /** the run's config — the source of the connection(s) the run targets. */
  config: Record<string, unknown>;
  /** D-182 Slice 4 — the Tier-P `pack_ref → catalog` map a recipe's
   *  `<publisher>.<pack>.<op>` op-steps lower against at dispatch (built from the
   *  installed-pack inventory by `buildPackOpResolution`). Omitted ⇒ the empty map
   *  (a kernel-only recipe still lowers; a Tier-P op fails closed). */
  packs?: PackOpResolution;
  /** D-320 ruling 20e — each catalog's vendor and the registry canonical fields map
   *  through, installed compositions included (`liveCatalogVendors`), so a step on
   *  an accounting connection (QuickBooks, Xero) resolves at run as it did at
   *  install. Omitted ⇒ the first-party CRM catalogs and the built-in registry. */
  vendors?: LiveCatalogVendors | undefined;
  /** D-320 ruling 20g — settings the run leaves to their records
   *  (`recordRoutedConnection`): each resolves against the catalog of the
   *  connection given here and stays empty in `config`, so each call takes its
   *  record's connection. */
  recordRouted?: ReadonlyMap<string, string> | undefined;
  /** D-320 ruling 20 — a vendor-neutral search whose slot nobody chose reads every
   *  connection that can serve it (`canonical-search-fanout.ts`). Omitted ⇒ each
   *  search binds its slot's one connection, as before. */
  fanout?: {
    /** The connections serving `<alias>.<verb>` that the run may use, sorted. */
    servingConnections: (alias: string, verb: string) => readonly FanoutConnection[];
    /** The slots someone chose. Omitted ⇒ every slot holding a connection in
     *  `config`: nothing fills a vendor-neutral slot before this resolve, so a value
     *  there was the caller's, a dish's or a choice's. A caller that binds slots and
     *  resolves again (the run's pick loop) passes the set it started from, so a
     *  search does not stop fanning out once another step's slot is bound. */
    explicit?: ReadonlySet<string>;
  } | undefined;
}

export type DispatchResolveResult =
  | {
      ok: true;
      recipe: RecipeDefinition;
      resolved: boolean;
      /** D-320 ruling 20 — the settings a fanned-out search's legs sign in through,
       *  each with its connection. The run reads them from their defaults; a door or
       *  a pre-approval writes them into the config it derives from or reviews
       *  (`settleDoorConnections`), which reads only the authored recipe's. */
      settings?: Record<string, string>;
      /** D-320 ruling 20 — each setting whose searches fanned out, and the
       *  connections they read (for `context.connections`). */
      fanned_out?: Record<string, string[]>;
    }
  | {
      ok: false;
      reason: string;
      /** Present iff the failure is "a connection slot variable was not
       *  supplied in the run's config" — the ONE failure shape the
       *  pick-resolution layer can act on (every other failure is a
       *  recipe/profile/catalog defect a pick cannot fix). Carries the
       *  FIRST unbound variable in slot-derivation order; a multi-slot
       *  recipe converges one ask at a time (doc §1.3 re-run loop). */
      unbound_slot?: { variable: string };
    };

/** D-320 ruling 20 — the slot variables holding a connection name in `config`. */
export const chosenSlots = (config: Readonly<Record<string, unknown>>): ReadonlySet<string> =>
  new Set(Object.entries(config)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key]) => key));

const hasCanonicalOpStep = (recipe: RecipeDefinition): boolean =>
  recipe.steps.some(isCanonicalOpStep) ||
  (recipe.prefetch_steps ?? []).some(isPrefetchOpStep);

/** Resolve a canonical recipe's op-steps at dispatch, from the connection(s) the run
 *  supplies in `config` — one per slot variable. Returns the concrete recipe on
 *  success, a `{ ok:false, reason }` (fail-closed) otherwise. A recipe with no
 *  canonical op-step is returned unchanged (`resolved: false`). Pure of writes —
 *  never persists. */
export const resolveCanonicalRecipeForDispatch = (
  inputRecipe: RecipeDefinition,
  deps: DispatchResolveDeps,
): DispatchResolveResult => {
  // D-182 Slice 5 (Increment 2b) — lower any D-182 two-tier op-step (kernel
  // `core.*` / Tier-P) FIRST, before the slot derivation + fast-path read it: a
  // kernel op is canonical-op-shaped but carries no connection slot, so it must
  // become a concrete kernel step here, never reach `opStepConnectionSlots`.
  // Inert no-op on the current corpus (no two-tier op ids → same recipe ref). A
  // two-tier op with no resolved target fails closed (empty-map seam — Tier-P
  // unsourced yet). After lowering, a kernel-only recipe has no canonical op-step
  // left → it is fully resolved, so `resolved` reflects whether lowering changed it.
  let recipe: RecipeDefinition;
  try {
    recipe = lowerTwoTierOpSteps(inputRecipe, deps.packs);
  } catch (e) {
    if (e instanceof CanonicalOpResolutionError) return { ok: false, reason: e.message };
    throw e;
  }
  // D-320 ruling 20 — searches nobody pointed at a connection become one leg per
  // serving connection and a merge, before the slots are read: a slot whose only
  // steps were such searches then has nothing left to bind, so it is never asked
  // about and a scheduled run is not refused for it.
  let withFanned: { settings?: Record<string, string>; fanned_out?: Record<string, string[]> } = {};
  if (deps.fanout !== undefined) {
    const out = fanOutCanonicalSearches(recipe, {
      explicit: deps.fanout.explicit ?? chosenSlots(deps.config),
      servingConnections: deps.fanout.servingConnections,
      manifests: deps.manifests,
      registry: deps.vendors?.registry,
    });
    if (!out.ok) return { ok: false, reason: out.reason };
    recipe = out.recipe;
    if (out.fanned.length > 0) {
      const fannedOut: Record<string, string[]> = {};
      for (const { setting, connections } of out.fanned) {
        fannedOut[setting] = [...new Set([...(fannedOut[setting] ?? []), ...connections.map((c) => c.connection_name)])];
      }
      withFanned = { settings: out.settings, fanned_out: fannedOut };
    }
  }
  const didLower = recipe !== inputRecipe;
  if (!hasCanonicalOpStep(recipe)) return { ok: true, recipe, resolved: didLower, ...withFanned };

  // Per-operand slot derivation (R2 step 5) — explicit `{{config.<var>}}` refs or
  // the recipe's single connection variable; ambiguity / bad refs fail closed.
  // (D-182 Slice 4 — a kernel / Tier-P prefetch op-step is already lowered to a
  // concrete fetch above, so it derives no slots and needs none; a NON-prefetchable
  // prefetch op-step — canonical-convention / bare canonical — already threw during
  // lowering. The per-slot resolver's prefetch guard stays as defense in depth.)
  const slots = opStepConnectionSlots(recipe);
  if (!slots.ok) return { ok: false, reason: slots.reason };

  // Each distinct slot: run-supplied connection name → operation profile (its
  // bound catalog) → registered catalog manifest.
  const catalogBySlotVariable = new Map<string, IngredientManifest>();
  const catalogSlugs: string[] = [];
  for (const variable of slots.variables) {
    const given = deps.config[variable];
    const connection = typeof given === 'string' && given.length > 0 ? given : deps.recordRouted?.get(variable);
    if (typeof connection !== 'string' || connection.length === 0) {
      return {
        ok: false,
        reason: `connection variable '${variable}' was not supplied at run (config.${variable}) — cannot resolve canonical op-steps at dispatch`,
        unbound_slot: { variable },
      };
    }
    const profile = deps.profiles.get(connection);
    if (!profile || profile.catalog_slug === undefined) {
      return {
        ok: false,
        reason: `connection '${connection}' has no bound catalog (operation profile) to resolve canonical op-steps against`,
      };
    }
    const manifest = deps.manifests.get(profile.catalog_slug);
    if (manifest === null) {
      return {
        ok: false,
        reason: `catalog '${profile.catalog_slug}' for connection '${connection}' is not registered`,
      };
    }
    catalogBySlotVariable.set(variable, manifest);
    if (!catalogSlugs.includes(profile.catalog_slug)) catalogSlugs.push(profile.catalog_slug);
  }

  // Reuse the install-path ctx-building + rewrite, one context per slot.
  // `pack_slug` is error-context only here (the recipe isn't installed into a
  // pack); each slot's bound connection stays `{{config.<var>}}` so the engine
  // re-resolves it from the same config at execute.
  const res = resolvePerSlotOpStepRecipe(
    recipe,
    catalogBySlotVariable,
    `dispatch:${catalogSlugs.join('+')}`,
    // Absent ⇒ each parameter's default: first-party catalogs, built-in registry.
    deps.vendors?.vendorForCatalog,
    deps.vendors?.registry,
  );
  if (!res.ok) return { ok: false, reason: res.message };
  return { ok: true, recipe: res.recipe, resolved: true, ...withFanned };
};
