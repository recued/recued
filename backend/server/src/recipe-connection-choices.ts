/** D-320 §3.5 / ruling 12 — the slots a recipe signs in through where the owner
 *  has a choice of connection, for the recipe tools chat and MCP list
 *  (`Tier2RecipeEntry.connection_slots` → the `connections` argument).
 *
 *  A slot offers a choice when two or more connections are on its list: bound to
 *  every one of the recipe's catalogs in that slot (`slotList`), and set up. A
 *  recipe whose packs sign in once gets no argument, so the catalog pays for it
 *  only where it means something; the run reads the same list
 *  (`applyConnectionChoices`) and the same default (`storedSlotDefault`).
 *
 *  ⚠ A vendor-neutral op-step (`core.crm.*`: 18 steps in 15 shipped recipes,
 *  measured 2026-10-10) names no catalog until a connection is given, so it
 *  offers none here. A run may still name one (`chooseForVendorNeutral`). */

import {
  retiredConnectionsOf,
  type IngredientManifest,
  type RecipeDefinition,
  type RpcResponse,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { CanonicalOpResolutionError, lowerOpStepRecipe, type Tier2ConnectionSlot } from '@recued/recipes';

import { effectiveSlotDefault, type RemovalOutcomeKind } from './pack-connection-outcomes.js';
import { bundledPackManifestOf, catalogSlotsFrom, type PackManifestOf } from './pack-connection-slots.js';
import { buildPackOpResolution } from './pack-inventory.js';
import { connectionSteps, runConnectionSlots, slotList } from './run-connection-choice.js';
import { catalogSignInReader, withSlotSettings } from './slot-settings.js';
import { allCatalogBindings, type BindingScan } from './storage/connection-catalog-binding-store.js';
import { storedSlotDefault } from './storage/pack-connection-default-store.js';

export interface RecipeConnectionChoicesDeps {
  contractScan: BindingScan;
  manifests: { get(slug: string): IngredientManifest | null };
  /** Connections set up on this server (each has an operation profile). */
  enrolled: ReadonlySet<string>;
  /** The owner's alias for a connection. */
  displayName: (connection_name: string) => string | undefined;
  packManifestOf?: PackManifestOf;
}

/** The slots a recipe signs in through, as `packs.connections.recipe` lists them. */
type RecipeConnectionSlot = RpcResponse<ServerRpcRegistry, 'packs.connections.recipe'>['slots'][number];

/** A reader for one listing: it reads the bindings and the installed packs once,
 *  and each recipe's slots from them. `minimum` is the list length a slot needs to
 *  be read at all: 2 for a choice, 0 for every slot. */
const slotsReader = (
  deps: RecipeConnectionChoicesDeps,
  minimum: number,
): ((recipe: RecipeDefinition) => RecipeConnectionSlot[]) => {
  const bindings = allCatalogBindings(deps.contractScan)
    .filter((binding) => deps.enrolled.has(binding.connection_name));
  // A catalog with two or more set-up connections is the only place a choice can
  // be; with none, no recipe needs reading for one.
  const perCatalog = new Map<string, Set<string>>();
  for (const binding of bindings) {
    const names = perCatalog.get(binding.catalog_slug) ?? new Set<string>();
    names.add(binding.connection_name);
    perCatalog.set(binding.catalog_slug, names);
  }
  const shared = new Set([...perCatalog].filter(([, names]) => names.size >= 2).map(([catalog]) => catalog));
  if (minimum >= 2 && shared.size === 0) return () => [];
  const packs = buildPackOpResolution(
    () => deps.contractScan('installed_pack', []),
    (slug) => deps.manifests.get(slug),
  );
  const packManifestOf = deps.packManifestOf ?? bundledPackManifestOf;
  // D-320 phase 3 (3a) — a step that names no connection reads its slot's
  // setting, as the run gives it (`slot-settings.ts`).
  const signInOf = catalogSignInReader({ scan: deps.contractScan, packs, packManifestOf });
  return (recipe) => {
    let lowered: RecipeDefinition;
    try {
      lowered = lowerOpStepRecipe(withSlotSettings(recipe, { packs, signInOf }).recipe, packs);
    } catch (e) {
      if (e instanceof CanonicalOpResolutionError) return [];
      throw e;
    }
    const steps = connectionSteps(lowered);
    if (minimum >= 2 && !steps.some((step) => shared.has(step.catalog))) return [];
    const catalogs = [...new Set(steps.map((step) => step.catalog))];
    const own = bindings.filter((binding) => catalogs.includes(binding.catalog_slug));
    const out: RecipeConnectionSlot[] = [];
    for (const slot of runConnectionSlots(steps, catalogSlotsFrom(own, catalogs, packManifestOf, packs))) {
      const list = slotList(slot, own, deps.enrolled);
      if (list.length < minimum) continue;
      // One on the list is the default by itself (phase 1); two or more take the
      // stored one, by the rule a run uses.
      const theDefault = list.length === 1
        ? list[0]
        : storedSlotDefault(
          deps.contractScan,
          slot.catalogs,
          own.filter((binding) => slot.catalogs.includes(binding.catalog_slug)),
        );
      // D-320 phase 3 (ruling 18) — and a setting's old name the recipe maps to the
      // slot, so the dish form shows a value a dish saved under it, and leaves it out.
      const renamed = Object.entries(retiredConnectionsOf(recipe))
        .filter(([, mapped]) => mapped === slot.slot)
        .map(([old]) => old);
      out.push({
        slot: slot.slot,
        variables: [...slot.variables, ...renamed.filter((old) => !slot.variables.includes(old))],
        connections: list.map((connection_name) => ({
          connection_name,
          display_name: deps.displayName(connection_name) ?? connection_name,
          is_default: connection_name === theDefault,
        })),
      });
    }
    return out;
  };
};

/** D-320 §3.4 — every slot a recipe signs in through, with its list and default:
 *  what the dish form and the run dialog offer (`packs.connections.recipe`). */
export const recipeConnectionSlots = (
  deps: RecipeConnectionChoicesDeps,
): ((recipe: RecipeDefinition) => RecipeConnectionSlot[]) => slotsReader(deps, 0);

/** D-320 §3.5 — the slots where the owner has a choice, for the recipe tools'
 *  `connections` argument: two or more connections on the list. */
export const recipeConnectionChoices = (
  deps: RecipeConnectionChoicesDeps,
): ((recipe: RecipeDefinition) => Tier2ConnectionSlot[]) => {
  const read = slotsReader(deps, 2);
  return (recipe) => read(recipe).map(({ slot, connections }) => ({ slot, connections }));
};

/** A binding row, as `allCatalogBindings` reads it. */
type CatalogBindingRow = ReturnType<typeof allCatalogBindings>[number];

export interface RecipeRemovalQuestion {
  contractScan: BindingScan;
  manifests: { get(slug: string): IngredientManifest | null };
  packManifestOf?: PackManifestOf;
  /** The installed recipes. */
  recipes: Iterable<RecipeDefinition>;
  /** The connection leaving. */
  connection: string;
  /** Whether one of its bindings leaves with it: a pack's list it is taken off. A
   *  deleted connection's bindings stay (D-320 2h); it leaves `enrolledAfter`. */
  leaves: (binding: CatalogBindingRow) => boolean;
  /** The connections set up now, and afterwards. */
  enrolled: ReadonlySet<string>;
  enrolledAfter: ReadonlySet<string>;
  /** The pack deciding a pack's list: its holder when it borrows (ruling 9). */
  deciderOf: (pack: string) => string;
  /** Whether the removal reaches a slot of these catalogs at all: deleting one row of a
   *  same-named pair leaves the other serving the catalogs of its kind. */
  reachesSlot: (catalogs: readonly string[]) => boolean;
}

/** One recipe's slot, and where its runs go. Connection and pack names, to be named
 *  by the caller. */
export interface RecipeRemoval {
  recipe_id: string;
  recipe_name: string;
  slot: string;
  packs: string[];
  outcome: Exclude<RemovalOutcomeKind, 'no_list'>;
  before?: string;
  after?: string;
  remaining: string[];
}

/** D-320 audit — where removing a connection leaves each installed recipe whose
 *  sign-in spans two or more packs' lists (ruling 14: a family with no core pack keeps
 *  a list per pack). The packs' own answers (`removalOutcome`) each read one list,
 *  which is right for a recipe reading one pack and wrong for one reading two: its run
 *  needs a connection on both. `workspace-map-shortcut` reads `shortcut-workspace` and
 *  `shortcut-planning`; taking a connection off the first's list "moves to" the other
 *  there, while the recipe finds no connection on both lists and stops.
 *
 *  Worked out with the run's own pieces over the whole slot: the recipe read as the
 *  run reads it (`slotsReader`), its default by the run's rule (`effectiveSlotDefault`),
 *  counted only when bound to every one of the slot's catalogs, as a stored one must be
 *  (`storedSlotDefault`), and the connections on every list (`slotList`). A recipe
 *  whose slot is one pack's list is left out: its pack's answer is its own. */
export const recipeRemovalEffects = (q: RecipeRemovalQuestion): RecipeRemoval[] => {
  const all = allCatalogBindings(q.contractScan);
  const touched = new Set(all.filter((b) => b.connection_name === q.connection).map((b) => b.catalog_slug));
  if (touched.size === 0) return [];
  const packs = buildPackOpResolution(
    () => q.contractScan('installed_pack', []),
    (slug) => q.manifests.get(slug),
  );
  const packManifestOf = q.packManifestOf ?? bundledPackManifestOf;
  const signInOf = catalogSignInReader({ scan: q.contractScan, packs, packManifestOf });
  const without = all.filter((b) => !(b.connection_name === q.connection && q.leaves(b)));
  const out: RecipeRemoval[] = [];
  for (const recipe of q.recipes) {
    let lowered: RecipeDefinition;
    try {
      lowered = lowerOpStepRecipe(withSlotSettings(recipe, { packs, signInOf }).recipe, packs);
    } catch (e) {
      if (e instanceof CanonicalOpResolutionError) continue;
      throw e;
    }
    const steps = connectionSteps(lowered);
    if (!steps.some((step) => touched.has(step.catalog))) continue;
    const catalogs = [...new Set(steps.map((step) => step.catalog))];
    const own = all.filter((b) => catalogs.includes(b.catalog_slug));
    for (const slot of runConnectionSlots(steps, catalogSlotsFrom(own, catalogs, packManifestOf, packs))) {
      const ofSlot = own.filter((b) => slot.catalogs.includes(b.catalog_slug));
      if (!ofSlot.some((b) => b.connection_name === q.connection)) continue;
      const deciders = [...new Set(ofSlot.map((b) => q.deciderOf(b.installed_pack_id)))].sort();
      if (deciders.length < 2 || !q.reachesSlot(slot.catalogs)) continue;
      const runsOn = (bindings: readonly CatalogBindingRow[], enrolled: ReadonlySet<string>) => {
        const these = bindings.filter((b) => slot.catalogs.includes(b.catalog_slug));
        const list = slotList(slot, these, enrolled);
        const theDefault = effectiveSlotDefault(q.contractScan, slot.catalogs, these, enrolled);
        return { on: theDefault !== undefined && list.includes(theDefault) ? theDefault : undefined, list };
      };
      const before = runsOn(all, q.enrolled);
      const after = runsOn(without, q.enrolledAfter);
      const outcome: RecipeRemoval['outcome'] = after.on !== undefined
        ? (after.on === before.on ? 'unchanged' : 'moves')
        : after.list.length > 0
          // Two or more on every list and none the default; with none before, nothing changes.
          ? (before.on === undefined ? 'unchanged' : 'no_default')
          : (before.on === undefined && before.list.length === 0 ? 'unchanged' : 'stops');
      out.push({
        recipe_id: recipe.recipe_id,
        recipe_name: recipe.metadata?.name ?? recipe.recipe_id,
        slot: slot.slot,
        packs: deciders,
        outcome,
        ...(before.on !== undefined ? { before: before.on } : {}),
        ...(after.on !== undefined ? { after: after.on } : {}),
        remaining: after.list,
      });
    }
  }
  return out.sort((a, b) => a.recipe_name.localeCompare(b.recipe_name) || a.slot.localeCompare(b.slot));
};
