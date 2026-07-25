/** Doc §4 close-out — pick-candidate derivation for an UNBOUND
 *  connection slot.
 *
 *  Host-side (not in the `@recued/gateway` pick leaf) because it needs
 *  the recipes-package slot walk (`opStepConnectionSlots`) + the
 *  contracts registry mapping — the same layering boundary that keeps
 *  saga compensation derivation out of the gateway leaf. Kept SEPARATE
 *  from `pick-server-wiring.ts` (the re-run dispatcher) because the
 *  execute-handler imports the derivation while the dispatcher imports
 *  the execute-handler — one module would be an import cycle.
 *
 *  Candidate predicate (tier-1, mirror-of-resolve): a connection
 *  qualifies for a slot iff its enrolled profile is stamped with a
 *  catalog whose operations can serve EVERY canonical op the slot's
 *  op-steps declare — `<crm_alias>.<verb>` → the catalog vendor's
 *  registry entity → `<entity>.<verb> ∈ manifest.operations`. This is
 *  deliberately the OP-SET check only: a candidate that later fails
 *  field projection / query derivation fails closed at the re-run's
 *  full resolve with the precise reason (disambiguation never weakens
 *  fail-closed). */

import { randomUUID } from 'node:crypto';

import {
  CATALOG_VENDOR_SLUGS,
  CRM_ALIAS_VALUES,
  getVendorEntityByCrmAlias,
  isCanonicalOpStep,
} from '@recued/contracts';
import type {
  CrmAlias,
  IngredientManifest,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import {
  CanonicalOpResolutionError,
  lowerOpStepRecipe,
  opStepConnectionSlots,
  type PackOpResolution,
} from '@recued/recipes';
import type { PickAskInput, PickCandidate } from '@recued/gateway';

import type { ConnectionOperationProfileStore } from './connection-operation-profile.js';

const CRM_ALIAS_SET: ReadonlySet<string> = new Set(CRM_ALIAS_VALUES);

/** D-182 Slice 5 (Increment 2b) — the empty pack-op resolution map. Pick-candidate
 *  derivation lowers the recipe's two-tier op-steps (kernel `core.*` → concrete;
 *  canonical-convention `core.crm.*` → bare `<alias>.<verb>`) so `slotOperations`
 *  parses the SAME concrete op the dispatch resolver does — otherwise a
 *  `core.crm.deal.search` op would parse to alias `core` and suppress every
 *  candidate. Tier-P stays unsourced (empty map); a Tier-P / unresolvable op throws
 *  and yields no candidates (the re-run's full resolve owns the precise error).
 *  INERT on the current corpus (bare canonical ops are 2-segment passthroughs). */
const EMPTY_PACK_OP_RESOLUTION: PackOpResolution = new Map();

/** Reverse of `CATALOG_VENDOR_SLUGS` (catalog slug → vendor). First-party
 *  catalogs only — a third-party catalog-form profile has no registry
 *  vendor mapping, so it never qualifies as a pick candidate today (its
 *  op-steps resolve through the registry-merge install path instead). */
const VENDOR_BY_CATALOG: ReadonlyMap<string, string> = new Map(
  Object.entries(CATALOG_VENDOR_SLUGS).map(([vendor, slug]) => [slug, vendor]),
);

/** The canonical ops bound to `variable` in slot-derivation order, or
 *  null when the slot walk itself fails (a recipe defect — the caller
 *  keeps the original resolve failure). */
const slotOperations = (
  recipe: RecipeDefinition,
  variable: string,
): string[] | null => {
  const slots = opStepConnectionSlots(recipe);
  if (!slots.ok) return null;
  const ops: string[] = [];
  const steps: RecipeStep[] = recipe.steps;
  for (const step of steps) {
    if (!isCanonicalOpStep(step)) continue;
    if (slots.slotByStepId.get(step.id) !== variable) continue;
    if (!ops.includes(step.op)) ops.push(step.op);
  }
  return ops;
};

/** What `derivePickCandidates` needs — the enrolled profile universe +
 *  the live manifest registry (both already on `ExecuteHandlerDeps`). */
export interface PickCandidateDeps {
  profiles: Pick<ConnectionOperationProfileStore, 'list'>;
  manifests: { get(slug: string): IngredientManifest | null };
  /** D-182 Slice 4 — the Tier-P `pack_ref → catalog` map (built from the
   *  installed-pack inventory). A recipe MIXING a Tier-K canonical CRM op (which
   *  needs a pick) with a Tier-P op must lower the Tier-P op to concrete so the
   *  slot-op parse still sees the canonical op; without it the Tier-P op would
   *  throw under the empty map and suppress every candidate. Omitted ⇒ empty. */
  packs?: PackOpResolution;
}

/** Derive the capable candidates for one unbound slot. Empty when the
 *  slot's ops parse to no known crm_alias, the slot walk fails, or no
 *  enrolled profile's catalog serves the full op set. Sorted by
 *  connection name so ask options render deterministically. */
export const derivePickCandidates = (
  recipe: RecipeDefinition,
  variable: string,
  deps: PickCandidateDeps,
): { candidates: PickCandidate[]; operations: string[] } => {
  // D-182 Slice 5 (Increment 2b) — lower the recipe's two-tier op-steps so the
  // slot-op parse below sees the SAME concrete op the dispatch resolver lowers to
  // (`core.crm.deal.search` → `deal.search`), not the unlowered id (which would
  // parse to alias `core` and suppress every candidate). A Tier-P / unresolvable
  // op throws under the empty map → no candidates (the re-run's full resolve owns
  // the precise error, per this module's fail-closed contract).
  let lowered: RecipeDefinition;
  try {
    lowered = lowerOpStepRecipe(recipe, deps.packs ?? EMPTY_PACK_OP_RESOLUTION);
  } catch (e) {
    if (e instanceof CanonicalOpResolutionError) return { candidates: [], operations: [] };
    throw e;
  }
  const operations = slotOperations(lowered, variable);
  if (operations === null || operations.length === 0) {
    return { candidates: [], operations: [] };
  }

  const parsed: { alias: CrmAlias; verb: string }[] = [];
  for (const op of operations) {
    const dot = op.indexOf('.');
    const alias = dot > 0 ? op.slice(0, dot) : '';
    const verb = dot > 0 ? op.slice(dot + 1) : '';
    if (verb.length === 0 || !CRM_ALIAS_SET.has(alias)) {
      // Not a well-formed canonical op — no catalog can serve it; the
      // re-run's resolve owns the precise error.
      return { candidates: [], operations };
    }
    parsed.push({ alias: alias as CrmAlias, verb });
  }

  const candidates: PickCandidate[] = [];
  for (const [name, profile] of deps.profiles.list()) {
    const catalogSlug = profile.catalog_slug;
    if (catalogSlug === undefined) continue;
    const vendor = VENDOR_BY_CATALOG.get(catalogSlug);
    if (vendor === undefined) continue;
    const manifest = deps.manifests.get(catalogSlug);
    const opsTable = manifest?.operations;
    if (opsTable === undefined) continue;
    const servesAll = parsed.every(({ alias, verb }) => {
      const entity = getVendorEntityByCrmAlias(vendor, alias)?.entity;
      return entity !== undefined && entity !== null
        && Object.prototype.hasOwnProperty.call(opsTable, `${entity}.${verb}`);
    });
    if (servesAll) {
      candidates.push({ connection_name: name, catalog_slug: catalogSlug, vendor });
    }
  }
  candidates.sort((a, b) => a.connection_name.localeCompare(b.connection_name));
  return { candidates, operations };
};

/** Assemble the gateway leaf's `PickAskInput` for one unbound slot —
 *  mints the pick id (the deterministic re-run key) and snapshots the
 *  run identity. `recipe_id` re-runs by id iff the request named one;
 *  an inline request persists the canonical recipe verbatim. */
export const buildPickAskInputForSlot = (input: {
  recipe: RecipeDefinition;
  /** True when the request carried `recipe_id` (vs an inline recipe). */
  byId: boolean;
  variable: string;
  config: Record<string, unknown>;
  candidates: readonly PickCandidate[];
  operations: readonly string[];
}): PickAskInput => ({
  pick_id: randomUUID(),
  ...(input.byId
    ? { recipe_id: input.recipe.recipe_id }
    : { recipe: input.recipe }),
  // The human display name lives at `metadata.name` on shipped recipes
  // (top-level `name` is not a RecipeDefinition field).
  recipe_label:
    (input.recipe as { metadata?: { name?: string } }).metadata?.name
    ?? input.recipe.recipe_id,
  variable: input.variable,
  operations: [...input.operations],
  config: input.config,
  candidates: [...input.candidates],
});
