/** D-207 slice 1c / D-209 #1 W2b — the ONE construction of the inputs
 *  `deriveRecipeCapability` needs at a composition root.
 *
 *  Both door families (reception pair-bind, webhook enrollment) derive a
 *  recipe's op/connection closure and mint a door from it. The derivation's
 *  two lookups — (catalog slug, operation) → canonical op ids, and
 *  recipe → resolved install config — MUST be the same functions everywhere
 *  they are consumed: two hand-rolled lambdas are two derivations that can
 *  drift, and a drifted closure mints a door whose consent list lies
 *  (`wire-reception-substrate.ts` states the same rule for bind-vs-run).
 *  This module exists so the reception wiring, the webhook save/install
 *  wiring, and any future door class construct them from one place.
 *
 *  The op resolution is rebuilt PER CALL, never cached at boot: installing a
 *  pack changes it, and a bind/save must see the inventory as it is at that
 *  moment. Bind and save are rare owner-interactive actions over a scan of
 *  tens of packs — the rebuild cost is noise; a stale map would mint a door
 *  whose grants name bindings that no longer exist. */

import { RpcError, type IngredientManifest, type RecipeDefinition } from '@recued/contracts';
import {
  CanonicalOpResolutionError,
  applyKernelOpRunnability,
  carryRetiredConnections,
  catalogSignInReader,
  lowerOpStepRecipe,
  vendorNeutralSettings,
  withSlotSettings,
  type PackOpResolution,
} from '@recued/recipes';

import { servingConnectionsFor } from './canonical-search-fanout.js';
import { deriveBoundConventionFamilies, liveCatalogVendors, liveVendorRegistry } from './connection-convention-families.js';
import { chosenSlots, resolveCanonicalRecipeForDispatch } from './dispatch-canonical-resolve.js';
import { markRecordFollowers, recordRoutedConnection, settingsFromRecordIds } from './record-connection-settle.js';
import type { OpResolver } from './derive-recipe-capability.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { bundledPackManifestOf, catalogSlotsFrom } from './pack-connection-slots.js';
import { effectiveSlotDefault } from './pack-connection-outcomes.js';
import { buildPackOpResolution } from './pack-inventory.js';
import {
  canonicalSlotVariables,
  concreteSlotCandidates,
  derivePickCandidates,
  unboundConcreteConnectionSlots,
} from './pick-candidates.js';
import {
  CONNECTION_CHOICE_INVALID,
  applyConnectionChoices,
  assertChoicesHeld,
  chooseForVendorNeutral,
  connectionSteps,
  runConnectionSlots,
} from './run-connection-choice.js';
import { bindingsForCatalogs, catalogBindingsOf } from './storage/connection-catalog-binding-store.js';

export type DoorRecipeResolution =
  | {
      readonly ok: true;
      readonly recipe: RecipeDefinition;
      /** Concrete ingredient → canonical pack op lookup from the SAME inventory snapshot
       *  that lowered `recipe`. Using it avoids one live pack scan per recipe step and
       *  prevents the closure from observing a different install set than lowering. */
      readonly resolveOp?: OpResolver;
      /** D-320 phase 3 (3b) — the config the run resolves this recipe's connections
       *  against: the one given, settled as the run settles it
       *  (`settleDoorConnections`). Derive the door from this, so it names the
       *  connection the run will use. */
      readonly config?: Record<string, unknown>;
    }
  | { readonly ok: false; readonly reason: string };

/** Resolve the exact concrete recipe form `handleExecute` will dispatch under one saved
 * install config. Doors derive authority from this form, not from an earlier authored
 * op-step representation whose implicit account binding is not visible yet. */
export type DoorRecipeResolver = (
  recipe: RecipeDefinition,
  config: Record<string, unknown>,
) => DoorRecipeResolution;

type ManifestOf = (slug: string) => IngredientManifest | null | undefined;

/** The op id the op-admission gate checks for one catalog operation: the operation's
 *  DECLARED `operation_id`, else its key — the expression `single-operation-admission.ts`,
 *  `admitCatalogOpForSource` and the catalog gateway each use. A first-party
 *  composition declares the SLASH form (`recued-core/home-assistant.state.list`,
 *  `decomposer.ts`); a stamped pack (third party, Records) the dotted
 *  `<publisher>.<pack>.<key>`. */
const gateOperationId = (manifest: IngredientManifest | null | undefined, operation: string): string =>
  manifest?.operations?.[operation]?.operation_id ?? operation;

/** ⛔⛔ A DOOR'S GRANTS ARE SPELLED AS THE GATE READS THEM. This returned
 *  `${packRef}.${operation}`, which is the gate's id only for a stamped pack: every
 *  first-party catalog op a door granted was a row the gate never checked, so each such
 *  dispatch was refused `op_not_granted` (2026-10-10). One id per catalog op, however
 *  many pack refs bind it (a Records catalog is bound under two). */
const resolverFromPackSnapshot = (
  resolution: ReturnType<typeof buildPackOpResolution>,
  manifestOf: ManifestOf,
): OpResolver =>
  (ingredientSlug, operation) => {
    const opIds = new Set<string>();
    for (const binding of resolution.values()) {
      if (binding.catalog_slug === ingredientSlug && binding.operations.has(operation)) {
        opIds.add(gateOperationId(manifestOf(binding.catalog_slug), operation));
      }
    }
    return [...opIds];
  };

type DoorConnectionDeps = Pick<
  ExecuteHandlerDeps,
  | 'connectionOperationProfiles'
  | 'connectionStore'
  | 'contractScan'
  | 'executorConfig'
  | 'packManifestOf'
  | 'dishStore'
  | 'localManifestStore'
>;

/** A door's connections as its run settles them: the recipe in the form the run
 *  dispatches and the config it resolves that form's connections against, or the
 *  run's own reason for refusing before any step used one. */
export type DoorConnectionSettlement =
  | { readonly ok: true; readonly recipe: RecipeDefinition; readonly config: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason: string;
      /** What kind of refusal (D-319 amendment; a door reads only `reason`):
       *  - `unpinned` (`unattendedRun` only): a setting a run on its own would have to
       *    ask about, named in `unpinned`;
       *  - `unserved`: a step's setting no connection can serve;
       *  - `choice`: the dish's choice is no longer on its slot's list;
       *  - `unresolved`: anything else (a pack not installed, a server without its
       *    packs' connections) — not the connection's to answer. */
      readonly kind?: 'unpinned' | 'unserved' | 'choice' | 'unresolved';
      readonly unpinned?: { readonly variable: string };
    };

/** The run's own refusal of a setting it cannot settle with nobody to ask which
 *  (`execute-handler.ts`, `settleUnboundSlot`), said of a run that starts on its own. */
const unpinnedReason = (recipe_id: string, variable: string): string =>
  `Recipe '${recipe_id}' needs a connection for '${variable}', and a run on its own has no one to ask which. `
  + "Choose a default connection on its pack's Access tab, or a connection for the dish it runs.";

/** A value that counts as given, as the run's fill reads one (`pick-candidates.ts`). */
const supplied = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;

/** D-320 phase 3 (3b) — a door follows the slot, as its run does.
 *
 *  A door is derived before any run, from the config the run will be given, so its
 *  connections are settled here by the run's own rules, in the run's order, from the
 *  run's own pieces (`execute-handler.ts`):
 *  1. a step that names no connection reads the setting its slot is given
 *     (`withSlotSettings`);
 *  2. a value saved under a setting's old name is the value of the setting its slot
 *     was given (`carryRetiredConnections`);
 *  3. the main dish's choice (what the runners pass the run,
 *     `composeInstallConnectionsResolver`) is written into each setting of its slot
 *     (`applyConnectionChoices`; a vendor-neutral step's, `chooseForVendorNeutral`),
 *     over a declared default but never over a value the config gives: the runners
 *     pass the main dish's settings as the run's own, and the run's own value wins.
 *     A choice no longer on its slot's list refuses the door, as it refuses every run;
 *  3½. a setting nobody chose takes the connection its step's record id names, when
 *     the config gives that id (D-320 ruling 20d, `record-connection-settle.ts`; the
 *     run also reads its context's, which a door has none of);
 *  4. the steps resolve (`resolveCanonicalRecipeForDispatch`), a vendor-neutral
 *     search whose setting nobody chose reading every connection that serves it
 *     (D-320 ruling 20, `canonical-search-fanout.ts`); its legs' settings join the
 *     config. A door covers what that search reads now; a pre-approval, what its run
 *     will read, or the run is refused as differing from what was reviewed;
 *  5. a setting still empty, with no default, takes the pack's default
 *     (`effectiveSlotDefault`). With none it stays empty, and the door is refused as
 *     unknowable in advance, as a run in the background is;
 *  6. the dish's choice holds on the resolved steps (`assertChoicesHeld`);
 *  7. each record step on a setting nobody chose is marked to follow its record's
 *     connection at the call (D-320 ruling 20g, `markRecordFollowers`). A setting the
 *     run would leave to its records is not left so here: a door or a pre-approval
 *     must know its connections in advance, so it is refused as before.
 *
 *  Before this, the door filled its config by a rule of its own: a declared default
 *  stood over the dish's choice, a value under an old name was missed, a choice the
 *  run refuses was named anyway, and a vendor-neutral step's choice was not applied,
 *  so the door named one connection while every run used another or was refused. */
export const settleDoorConnections = (
  recipe: RecipeDefinition,
  config: Readonly<Record<string, unknown>>,
  deps: DoorConnectionDeps & {
    packs?: PackOpResolution;
    /** The dish whose connection choice applies, in place of the main dish's (a
     *  pre-approval's bound dish); `null` for none. */
    dishChoices?: { choices: Readonly<Record<string, string>>; label: string } | null;
    /** D-319 amendment (owner, 2026-10-11) — settle as a run that starts on its own
     *  does, to arm one (`unattendedConnectionProblem`): a setting the run leaves to its
     *  records is left so (ruling 20g), and one it would refuse, having nobody to ask
     *  which, is refused here, with `unpinned` naming it. Absent ⇒ a door's rules. */
    unattendedRun?: boolean;
  },
): DoorConnectionSettlement => {
  const scan = deps.contractScan;
  const profiles = deps.connectionOperationProfiles;
  const packs = deps.packs;
  const manifests = deps.executorConfig.manifests;
  const packManifestOf = deps.packManifestOf ?? bundledPackManifestOf;
  // D-320 ruling 20e — installed compositions' vendors too, as the run reads them.
  const catalogVendors = liveCatalogVendors(deps.localManifestStore);
  const slotSettings = withSlotSettings(recipe, {
    ...(packs !== undefined ? { packs } : {}),
    signInOf: catalogSignInReader({
      ...(scan !== undefined ? { bindingsOf: catalogBindingsOf(scan) } : {}),
      ...(packs !== undefined ? { packs } : {}),
      packManifestOf,
    }),
  });
  const settled = slotSettings.recipe;
  // Every key of `config` is the run's own (the runners pass the main dish's
  // settings as the run's config), and so is a setting one of them is carried into.
  const carry = carryRetiredConnections(settled, config, slotSettings.bySlot);
  let out: Record<string, unknown> = { ...carry.config };
  const callerKeys = new Set([...Object.keys(config), ...Object.values(carry.carried)]);
  // A pre-approval settles for the dish it was reviewed for; a door, for the main dish.
  const dish = deps.dishChoices !== undefined
    ? deps.dishChoices ?? undefined
    : composeInstallConnectionsResolver(deps.dishStore)(recipe.recipe_id);
  const chosen = dish !== undefined && Object.keys(dish.choices).length > 0 ? dish : undefined;
  const enrolled = (): Set<string> => new Set((profiles?.list() ?? []).map(([name]) => name));
  const slotsOf = (form: RecipeDefinition, store: NonNullable<typeof scan>) => {
    const steps = connectionSteps(form);
    const catalogs = [...new Set(steps.map((step) => step.catalog))];
    const bindings = catalogs.length > 0 ? bindingsForCatalogs(store, catalogs) : [];
    return { bindings, slots: runConnectionSlots(steps, catalogSlotsFrom(bindings, catalogs, packManifestOf, packs)) };
  };
  // A door's refusal is read by its owner alone (a runner reports its own), so it
  // names the list, as the run tells its owner.
  const owner = {
    recipe_id: settled.recipe_id,
    owner: true,
    displayName: (name: string): string | undefined => deps.connectionStore?.get('api', name)?.display_name,
  };
  try {
    if (chosen !== undefined) {
      if (scan === undefined || profiles === undefined) {
        return { ok: false, kind: 'unresolved', reason: "Choosing a run's connection needs a server that keeps its packs' connections." };
      }
      let lowered: RecipeDefinition | undefined;
      try {
        lowered = lowerOpStepRecipe(settled, packs ?? new Map());
      } catch (e) {
        if (!(e instanceof CanonicalOpResolutionError)) throw e;
        lowered = undefined; // the resolve below reports it
      }
      const { bindings, slots } = lowered !== undefined ? slotsOf(lowered, scan) : { bindings: [], slots: [] };
      const bySlot = applyConnectionChoices({
        ...owner,
        slots,
        choices: chosen.choices,
        inherited: false,
        config: out,
        callerKeys,
        bindings,
        enrolled: enrolled(),
        dish: chosen.label,
      });
      out = chooseForVendorNeutral({
        recipe_id: settled.recipe_id,
        variables: canonicalSlotVariables(settled, packs),
        choices: Object.fromEntries(Object.entries(chosen.choices).filter(([slot]) => !bySlot.applied.includes(slot))),
        config: bySlot.config,
        callerKeys,
        candidatesFor: (variable) => derivePickCandidates(settled, variable, {
          profiles,
          manifests,
          vendors: catalogVendors,
          ...(packs !== undefined ? { packs } : {}),
        }).candidates.map((candidate) => candidate.connection_name),
        yieldToCaller: true,
      }).config;
    }
    // The settings someone chose, before the run's own fills (D-320 ruling 20).
    const chosenSettings = chosenSlots(out);
    // A record id the config names settles its step's setting, as in the run
    // (ruling 20d). A door is derived with no run's context, so only the config's.
    out = {
      ...out,
      ...settingsFromRecordIds(settled, { config: out, explicit: chosenSettings }, {
        manifests,
        packs,
        isSetUp: (name) => profiles?.get(name) != null,
      }),
    };
    const resolveWith = (recordRouted: ReadonlyMap<string, string>) => resolveCanonicalRecipeForDispatch(settled, {
      profiles: profiles ?? { get: () => null },
      manifests,
      config: out,
      ...(packs !== undefined ? { packs } : {}),
      vendors: catalogVendors,
      ...(recordRouted.size > 0 ? { recordRouted } : {}),
      fanout: profiles === undefined ? undefined : {
        servingConnections: servingConnectionsFor({
          profiles,
          manifests,
          vendors: catalogVendors,
          ...(chosen !== undefined ? { slotChoices: chosen.choices } : {}),
          ...(scan !== undefined
            ? {
                slotOfCatalog: (catalog: string) => catalogSlotsFrom(
                  bindingsForCatalogs(scan, [catalog]),
                  [catalog],
                  packManifestOf,
                  packs,
                ).get(catalog) ?? catalog,
              }
            : {}),
        }),
        explicit: chosenSettings,
      },
    });
    // A run that starts on its own, as its pick loop goes (`execute-handler.ts`): a
    // setting its steps leave to their records is left so (ruling 20g); any other it
    // refuses when a connection could serve it, having nobody to ask which. With
    // none, the resolve's own reason stands, as in the run.
    const recordRouted = new Map<string, string>();
    let resolved = resolveWith(recordRouted);
    while (
      deps.unattendedRun === true && !resolved.ok && resolved.unbound_slot !== undefined && profiles !== undefined
    ) {
      const { variable } = resolved.unbound_slot;
      if (recordRouted.has(variable)) break;
      const { candidates } = derivePickCandidates(settled, variable, {
        profiles,
        manifests,
        vendors: catalogVendors,
        ...(packs !== undefined ? { packs } : {}),
      });
      const routedBy = recordRoutedConnection(settled, variable, candidates, packs);
      if (routedBy === undefined) {
        if (candidates.length > 0) {
          return { ok: false, kind: 'unpinned', reason: unpinnedReason(settled.recipe_id, variable), unpinned: { variable } };
        }
        break;
      }
      recordRouted.set(variable, routedBy);
      resolved = resolveWith(recordRouted);
    }
    if (!resolved.ok) {
      return { ok: false, kind: resolved.unbound_slot !== undefined ? 'unserved' : 'unresolved', reason: resolved.reason };
    }
    if (resolved.settings !== undefined) out = { ...out, ...resolved.settings };
    if (scan !== undefined && profiles !== undefined) {
      // The run's fill (`packConnectionFor`), per setting, over the catalogs its steps
      // fetch from. Unlike the run, a setting whose step skips itself without one is
      // filled too: a derivation cannot see the skip, and refusing the door would stop
      // runs that go ahead without the step.
      const declared = (resolved.recipe.variables ?? {}) as Readonly<Record<string, { default?: unknown } | undefined>>;
      const empty = new Map<string, string[]>();
      for (const { catalog, variable } of connectionSteps(resolved.recipe)) {
        if (supplied(out[variable]) || supplied(declared[variable]?.default)) continue;
        const catalogs = empty.get(variable) ?? [];
        if (!catalogs.includes(catalog)) catalogs.push(catalog);
        empty.set(variable, catalogs);
      }
      const setUp = empty.size > 0 ? enrolled() : new Set<string>();
      for (const [variable, catalogs] of empty) {
        const connection = effectiveSlotDefault(scan, catalogs, bindingsForCatalogs(scan, catalogs), setUp);
        if (connection !== undefined) out = { ...out, [variable]: connection };
      }
    }
    // A run that starts on its own refuses a concrete step's setting still empty when
    // a connection could serve it, as its fill does (`settleUnboundSlot`); with none,
    // it goes on and the gateway reports the step, as before.
    if (deps.unattendedRun === true && profiles !== undefined) {
      for (const slot of unboundConcreteConnectionSlots(resolved.recipe, out)) {
        if (recordRouted.has(slot.variable)) continue;
        if (concreteSlotCandidates(slot, profiles).length > 0) {
          return {
            ok: false, kind: 'unpinned', reason: unpinnedReason(settled.recipe_id, slot.variable), unpinned: { variable: slot.variable },
          };
        }
      }
    }
    if (chosen !== undefined && scan !== undefined) {
      const { bindings, slots } = slotsOf(resolved.recipe, scan);
      assertChoicesHeld({
        ...owner,
        slots,
        choices: chosen.choices,
        inherited: false,
        dish: chosen.label,
        families: vendorNeutralSettings(settled),
        exempt: new Set([...callerKeys].filter((key) => {
          const value = out[key];
          return typeof value === 'string' && value.trim() !== '';
        })),
        config: out,
        variables: resolved.recipe.variables,
        bindings,
        enrolled: enrolled(),
      });
    }
    // D-320 ruling 20g — the record steps the run lets follow their records, marked
    // as the run marks them. Against the FINAL config: a pre-approved run is given
    // it, so a setting filled here is one the owner reviewed, and its steps stay
    // on it (a door's run fills its own; the mark does not change what a door
    // derives).
    return { ok: true, recipe: markRecordFollowers(resolved.recipe, chosenSlots(out), { manifests }).recipe, config: out };
  } catch (e) {
    if (e instanceof RpcError && e.code === CONNECTION_CHOICE_INVALID) return { ok: false, kind: 'choice', reason: e.message };
    throw e;
  }
};

/** D-319 amendment (owner, 2026-10-11): "scheduled runs should require the
 *  necessary fields for any recipes to run properly". Why a run that starts on its
 *  own, with these settings and its dish's choice of connection, would be refused for
 *  a connection before its first step; `null` when it would not. The run's own
 *  refusals, by its own rules and pieces: no vendor of a family bound for a write
 *  (`applyKernelOpRunnability`), a choice that is no longer on its slot's list, and a
 *  setting it cannot settle with nobody to ask which (`unattendedRun`), and a
 *  vendor-neutral step no connection can serve. Not a concrete step with no
 *  connection that could serve it at all: the run goes on, and the gateway reports
 *  that step if it runs. Not a pack that is not installed: that has its own
 *  refusals, when armed and when run. */
export const unattendedConnectionProblem = (
  recipe: RecipeDefinition,
  config: Readonly<Record<string, unknown>>,
  deps: DoorConnectionDeps & {
    readonly dishChoices: { choices: Readonly<Record<string, string>>; label: string } | null;
  },
): { readonly reason: string; readonly variable?: string } | null => {
  const r1 = applyKernelOpRunnability(
    recipe,
    deriveBoundConventionFamilies(deps.connectionStore, liveVendorRegistry(deps.localManifestStore)),
  );
  if (!r1.ok) {
    return { reason: `Recipe '${recipe.recipe_id}' cannot run — ${r1.blocked.map((b) => `${b.op}: ${b.warning}`).join(' ')}` };
  }
  const packs = deps.contractScan === undefined
    ? undefined
    : buildPackOpResolution(
        () => deps.contractScan!('installed_pack', []),
        (slug) => deps.executorConfig.manifests.get(slug) ?? null,
      );
  const settled = settleDoorConnections(r1.recipe, config, {
    ...deps,
    ...(packs === undefined ? {} : { packs }),
    unattendedRun: true,
  });
  // Not the connection's to answer: a pack not installed, a server without its packs'
  // connections. Those have their own refusals, at arming and at the run.
  if (settled.ok || settled.kind === 'unresolved' || settled.kind === undefined) return null;
  return { reason: settled.reason, ...(settled.unpinned !== undefined ? { variable: settled.unpinned.variable } : {}) };
};

export const composeDoorRecipeResolver = (
  executeDeps: DoorConnectionDeps,
): DoorRecipeResolver =>
  (recipe, config) => {
    const packs = executeDeps.contractScan === undefined
      ? undefined
      : buildPackOpResolution(
          () => executeDeps.contractScan!('installed_pack', []),
          (slug) => executeDeps.executorConfig.manifests.get(slug) ?? null,
        );
    const settled = settleDoorConnections(recipe, config, {
      ...executeDeps,
      ...(packs === undefined ? {} : { packs }),
    });
    return settled.ok
      ? {
          ok: true,
          recipe: settled.recipe,
          config: settled.config,
          ...(packs === undefined
            ? {}
            : { resolveOp: resolverFromPackSnapshot(packs, (slug) => executeDeps.executorConfig.manifests.get(slug)) }),
        }
      : settled;
  };

/** Map an ingredient step's (catalog slug, `input.operation`) back to the
 *  canonical op id(s) it dispatches — so a derived closure names GRANTS, not
 *  just slugs. `undefined` when the contract substrate is absent (dbless /
 *  partial harness): every ingredient step then contributes no op id, and the
 *  door under-derives, which the callers treat as refusal-or-absent. */
export const composeRecipeOpResolver = (
  executeDeps: Pick<ExecuteHandlerDeps, 'contractScan' | 'executorConfig'>,
): OpResolver | undefined => {
  const contractScan = executeDeps.contractScan;
  if (!contractScan) return undefined;
  return (ingredientSlug, operation) => {
    const manifests = executeDeps.executorConfig?.manifests;
    if (manifests === undefined) return [];
    const resolution = buildPackOpResolution(
      () => contractScan('installed_pack', []),
      (slug) => manifests.get(slug) ?? null,
    );
    return resolverFromPackSnapshot(resolution, (slug) => manifests.get(slug))(ingredientSlug, operation);
  };
};

/** An op id's RISK TIER across the installed pack catalogs (the caller falls
 *  back to the kernel registry itself). Returning `undefined` is NOT "safe" —
 *  the reception responding-door fence treats an unclassifiable op as a
 *  refusal, because it cannot prove the op will not hold.
 *
 *  ⚠ BOTH SPELLINGS A DOOR CAN HOLD. A door's catalog ops are the gate's
 *  ({@link gateOperationId}, what the resolver above returns), and a recipe saved
 *  with its Tier-P `op` steps keeps those authored `<publisher>.<pack>.<op>` ids
 *  beside them (`deriveResolvedRecipeCapability`). Classifying only one would have
 *  the bind fence refuse the other as unclassifiable. */
export const composeRecipeOpRiskResolver = (
  executeDeps: Pick<ExecuteHandlerDeps, 'contractScan' | 'executorConfig'>,
): ((opId: string) => string | undefined) | undefined => {
  const contractScan = executeDeps.contractScan;
  if (!contractScan) return undefined;
  return (opId) => {
    const manifests = executeDeps.executorConfig?.manifests;
    if (manifests === undefined) return undefined;
    const resolution = buildPackOpResolution(
      () => contractScan('installed_pack', []),
      (slug) => manifests.get(slug) ?? null,
    );
    for (const [packRef, binding] of resolution) {
      const manifest = manifests.get(binding.catalog_slug);
      const prefix = `${packRef}.`;
      if (opId.startsWith(prefix) && binding.operations.has(opId.slice(prefix.length))) {
        return manifest?.operations?.[opId.slice(prefix.length)]?.risk_tier;
      }
      for (const operation of binding.operations) {
        if (gateOperationId(manifest, operation) === opId) {
          return manifest?.operations?.[operation]?.risk_tier;
        }
      }
    }
    return undefined;
  };
};

/** Resolve a concrete ingredient's installed execution kind for public-door cost policy. */
export const composeRecipeIngredientKindResolver = (
  executeDeps: Pick<ExecuteHandlerDeps, 'executorConfig'>,
): ((ingredientSlug: string) => string | undefined) =>
  (ingredientSlug) => executeDeps.executorConfig.manifests.get(ingredientSlug)?.kind;

/** Resolve a non-kernel canonical op's installed catalog kind. Kernel ops are classified
 *  directly from the closed registry by the cost analyzer.
 *
 *  ⚠ Keyed `<pack_ref>.<operation>` ON PURPOSE, unlike a door's grants: its one reader,
 *  `analyzeReceptionRecipeCost`, looks up a recipe step's own `op` field, which is
 *  always that authored Tier-P form. A lowered step carries `ingredient` instead and is
 *  classified by `composeRecipeIngredientKindResolver`. */
export const composeRecipeOpKindsResolver = (
  executeDeps: Pick<ExecuteHandlerDeps, 'contractScan' | 'executorConfig'>,
): (() => ReadonlyMap<string, string>) | undefined => {
  const contractScan = executeDeps.contractScan;
  if (!contractScan) return undefined;
  return () => {
    const manifests = executeDeps.executorConfig.manifests;
    const resolution = buildPackOpResolution(
      () => contractScan('installed_pack', []),
      (slug) => manifests.get(slug) ?? null,
    );
    const kinds = new Map<string, string>();
    for (const [packRef, binding] of resolution) {
      const kind = manifests.get(binding.catalog_slug)?.kind;
      if (kind === undefined) continue;
      for (const operation of binding.operations) {
        kinds.set(`${packRef}.${operation}`, kind);
      }
    }
    return kinds;
  };
};

/** D-320 phase 3 (3b) — the recipe's main dish's choice of connection per slot, and
 *  its name: what a webhook or public-form run passes as `dish_connections`, since its
 *  `run_id` makes the run skip the main dish. Reading the same dish does not make the
 *  door name the connection the run uses; applying the choice by the same rules does.
 *  `settleDoorConnections` reads it through this function and applies it as the run
 *  does: over a declared default, under a value the dish's settings give, and refused
 *  once its slot's list no longer holds it. */
export const composeInstallConnectionsResolver = (
  dishStore: Pick<NonNullable<ExecuteHandlerDeps['dishStore']>, 'listByRecipe'> | undefined,
): ((recipeId: string) => { readonly choices: Readonly<Record<string, string>>; readonly label: string } | undefined) =>
  (recipeId) => {
    const dish = dishStore?.listByRecipe(recipeId).find((candidate) => candidate.is_default);
    return dish?.connections === undefined
      ? undefined
      : { choices: dish.connections, label: dish.name !== '' ? dish.name : dish.dish_id };
  };

/** D-179 — a recipe's INSTALL config lives on its `is_default` dish; deriving
 *  from `recipe.variables` instead would refuse most of the shipped library
 *  outright (the values live on the dish, not the paper record). The SAME
 *  function must feed the door derivation AND the runner's execute merge, or
 *  the owner consents to a closure the run will not use. */
export const composeInstallConfigResolver = (
  dishStore: Pick<NonNullable<ExecuteHandlerDeps['dishStore']>, 'listByRecipe'> | undefined,
): ((recipeId: string) => Record<string, unknown> | undefined) =>
  (recipeId) =>
    dishStore?.listByRecipe(recipeId).find((dish) => dish.is_default)?.config_overlay;
