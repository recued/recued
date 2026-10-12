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
  ACCT_ALIAS_VALUES,
  CATALOG_VENDOR_SLUGS,
  CONNECTION_VENDOR_ENTITIES,
  CRM_ALIAS_VALUES,
  getVendorEntityByAcctAlias,
  getVendorEntityByCrmAlias,
  isCanonicalOpStep,
  profileForCatalog,
} from '@recued/contracts';
import type {
  AcctAlias,
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
import type { LiveCatalogVendors } from './connection-convention-families.js';

const CRM_ALIAS_SET: ReadonlySet<string> = new Set(CRM_ALIAS_VALUES);
const ACCT_ALIAS_SET: ReadonlySet<string> = new Set(ACCT_ALIAS_VALUES);

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

/** D-320 §3.5 — the settings a recipe's vendor-neutral op-steps (`core.crm.*`, a
 *  bare `deal.search`) read their connection from: the ones dispatch resolves by
 *  the connection's vendor, so they name no slot until a connection is given.
 *  Empty when the recipe has none, or when its op-steps do not lower or its slot
 *  walk fails (the dispatch resolve owns that error). */
export const canonicalSlotVariables = (
  recipe: RecipeDefinition,
  packs?: PackOpResolution,
): string[] => {
  let lowered: RecipeDefinition;
  try {
    lowered = lowerOpStepRecipe(recipe, packs ?? EMPTY_PACK_OP_RESOLUTION);
  } catch (e) {
    if (e instanceof CanonicalOpResolutionError) return [];
    throw e;
  }
  const slots = opStepConnectionSlots(lowered);
  return slots.ok ? [...slots.variables] : [];
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
  /** D-320 ruling 20e — each catalog's vendor and the registry its aliases map
   *  through, installed compositions included (`liveCatalogVendors`), so an
   *  accounting connection (QuickBooks, Xero) serves the `acct` family. Omitted ⇒
   *  the first-party CRM catalogs only. */
  vendors?: LiveCatalogVendors | undefined;
}

/** The vendor entity behind a canonical alias (`deal`, `invoice`), CRM or
 *  accounting, in `registry`. */
const entityForAlias = (
  vendor: string,
  alias: string,
  registry: LiveCatalogVendors['registry'],
): string | undefined => (CRM_ALIAS_SET.has(alias)
  ? getVendorEntityByCrmAlias(vendor, alias as CrmAlias, registry)?.entity
  : ACCT_ALIAS_SET.has(alias)
    ? getVendorEntityByAcctAlias(vendor, alias as AcctAlias, registry)?.entity
    : undefined) ?? undefined;

/** The vendor a catalog serves, by `vendors` or else as a first-party catalog. */
const vendorOfCatalog = (catalogSlug: string, vendors: LiveCatalogVendors | undefined): string | undefined =>
  vendors?.vendorForCatalog(catalogSlug) ?? VENDOR_BY_CATALOG.get(catalogSlug);

/** Derive the capable candidates for one unbound slot. Empty when the
 *  slot's ops parse to no known crm_alias or acct_alias, the slot walk fails, or no
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

  const parsed: { alias: string; verb: string }[] = [];
  for (const op of operations) {
    const dot = op.indexOf('.');
    const alias = dot > 0 ? op.slice(0, dot) : '';
    const verb = dot > 0 ? op.slice(dot + 1) : '';
    if (verb.length === 0 || !(CRM_ALIAS_SET.has(alias) || ACCT_ALIAS_SET.has(alias))) {
      // Not a well-formed canonical op — no catalog can serve it; the
      // re-run's resolve owns the precise error.
      return { candidates: [], operations };
    }
    parsed.push({ alias, verb });
  }

  const registry = deps.vendors?.registry ?? CONNECTION_VENDOR_ENTITIES;
  const candidates: PickCandidate[] = [];
  for (const [name, profile] of deps.profiles.list()) {
    const catalogSlug = profile.catalog_slug;
    if (catalogSlug === undefined) continue;
    const vendor = vendorOfCatalog(catalogSlug, deps.vendors);
    if (vendor === undefined) continue;
    const manifest = deps.manifests.get(catalogSlug);
    const opsTable = manifest?.operations;
    if (opsTable === undefined) continue;
    const servesAll = parsed.every(({ alias, verb }) => {
      const entity = entityForAlias(vendor, alias, registry);
      return entity !== undefined
        && Object.prototype.hasOwnProperty.call(opsTable, `${entity}.${verb}`);
    });
    if (servesAll) {
      candidates.push({ connection_name: name, catalog_slug: catalogSlug, vendor });
    }
  }
  candidates.sort((a, b) => a.connection_name.localeCompare(b.connection_name));
  return { candidates, operations };
};

/** D-320 ruling 20 — the enrolled connections whose catalog serves ONE canonical
 *  op (`<alias>.<verb>`), by the rule `derivePickCandidates` applies to a whole
 *  slot: a vendor's catalog (first-party, or an installed composition's with
 *  `vendors`) whose operations table holds the vendor entity's `<entity>.<verb>`.
 *  Sorted by connection name. A search nobody pointed at a connection reads every
 *  one of them (`canonical-search-fanout.ts`). */
export const connectionsServingCanonicalOp = (
  alias: string,
  verb: string,
  deps: Pick<PickCandidateDeps, 'profiles' | 'manifests' | 'vendors'>,
): Array<PickCandidate & { vendor: string }> => {
  if (!(CRM_ALIAS_SET.has(alias) || ACCT_ALIAS_SET.has(alias)) || verb.length === 0) return [];
  const registry = deps.vendors?.registry ?? CONNECTION_VENDOR_ENTITIES;
  const out: Array<PickCandidate & { vendor: string }> = [];
  for (const [name, profile] of deps.profiles.list()) {
    const catalogSlug = profile.catalog_slug;
    if (catalogSlug === undefined) continue;
    const vendor = vendorOfCatalog(catalogSlug, deps.vendors);
    if (vendor === undefined) continue;
    const opsTable = deps.manifests.get(catalogSlug)?.operations;
    if (opsTable === undefined) continue;
    const entity = entityForAlias(vendor, alias, registry);
    if (entity === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(opsTable, `${entity}.${verb}`)) {
      out.push({ connection_name: name, catalog_slug: catalogSlug, vendor });
    }
  }
  return out.sort((a, b) => a.connection_name.localeCompare(b.connection_name));
};

/** A pure `{{config.<var>}}` connection ref — the only shape a slot binds through. */
const PURE_CONFIG_REF = /^\{\{\s*config\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

const isSupplied = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;

/** One CONCRETE step slot the run left unbound: a catalog fetch whose
 *  `connection` is a pure `{{config.<var>}}` ref to a declared
 *  `type:'connection'` variable with no value — run config (dish overlays
 *  included) and default both empty. An install-resolved canonical op
 *  (`<id>__raw`) carries exactly this, and so does every vendor catalog recipe:
 *  3,744 steps across the shipped corpus (2026-10-08).
 *
 *  ⛔ Before this, only CANONICAL op-steps reached the pick layer. A recipe
 *  resolved at install no longer has one, so its empty slot went straight to the
 *  gateway: a pack's view auto-ran and showed "operation … on connection ''
 *  denied (no_connection_profile)" (driven live 2026-10-08, the HubSpot pack). */
export interface ConcreteConnectionSlot {
  variable: string;
  /** The catalogs its steps fetch from (`ingredient`), in step order. */
  catalogs: string[];
  /** Their `input.operation` ids — the ask shows them; a candidate must allow them. */
  operations: string[];
  /** D-320 ruling 10 — the same operations grouped by the catalog that declares
   *  them, so a candidate is checked against each catalog's own grant. Absent on a
   *  hand-built one-catalog slot, whose `operations` are all that catalog's. */
  operations_by_catalog?: Readonly<Record<string, readonly string[]>>;
}

/** The concrete slots a run leaves unbound, in step order (prefetch, steps,
 *  trigger steps). A step whose `skip_when` reads the variable treats "empty" as
 *  "leave me out" — an OPTIONAL connection — so that variable is never a slot:
 *  binding it would run a step the owner chose to skip. (None of the 3,744
 *  shipped steps does this; a hand-written recipe may.) */
export const unboundConcreteConnectionSlots = (
  recipe: RecipeDefinition,
  config: Readonly<Record<string, unknown>>,
): ConcreteConnectionSlot[] => {
  const declared = (recipe.variables ?? {}) as Readonly<
    Record<string, { type?: unknown; default?: unknown } | undefined>
  >;
  const slots = new Map<string, ConcreteConnectionSlot>();
  const optional = new Set<string>();
  const steps = [
    ...(recipe.prefetch_steps ?? []),
    ...recipe.steps,
    ...(recipe.trigger_steps ?? []),
  ] as ReadonlyArray<Readonly<Record<string, unknown>>>;
  for (const step of steps) {
    if (typeof step.connection !== 'string' || typeof step.ingredient !== 'string') continue;
    const variable = PURE_CONFIG_REF.exec(step.connection.trim())?.[1];
    if (variable === undefined) continue;
    const declaration = declared[variable];
    if (declaration?.type !== 'connection') continue;
    if (isSupplied(config[variable]) || isSupplied(declaration.default)) continue;
    if (step.skip_when !== undefined && JSON.stringify(step.skip_when).includes(`config.${variable}`)) {
      optional.add(variable);
      continue;
    }
    const slot = slots.get(variable) ?? { variable, catalogs: [], operations: [], operations_by_catalog: {} };
    if (!slot.catalogs.includes(step.ingredient)) slot.catalogs.push(step.ingredient);
    const operation = (step.input as Readonly<Record<string, unknown>> | undefined)?.operation;
    if (typeof operation === 'string' && !slot.operations.includes(operation)) {
      slot.operations.push(operation);
    }
    if (typeof operation === 'string') {
      const byCatalog = slot.operations_by_catalog as Record<string, string[]>;
      const ops = byCatalog[step.ingredient] ?? (byCatalog[step.ingredient] = []);
      if (!ops.includes(operation)) ops.push(operation);
    }
    slots.set(variable, slot);
  }
  return [...slots.values()].filter((slot) => !optional.has(slot.variable));
};

/** The enrolled connections that can serve a concrete slot: a profile that
 *  serves EVERY catalog the slot's steps fetch from, each granting the
 *  operations called from it. An unstamped legacy profile is never matched to a
 *  catalog. Sorted by connection name.
 *
 *  D-320 ruling 10 — a slot may span several catalogs (the Wise suite's
 *  `create-transfer-draft-wise` fetches from four on one connection). Before, a
 *  connection served one catalog, so such a slot had no candidate at all. */
export const concreteSlotCandidates = (
  slot: ConcreteConnectionSlot,
  profiles: Pick<ConnectionOperationProfileStore, 'list'>,
): PickCandidate[] => {
  if (slot.catalogs.length === 0) return [];
  const first = slot.catalogs[0]!;
  const vendor = VENDOR_BY_CATALOG.get(first);
  const operationsFor = (catalog: string): readonly string[] =>
    slot.operations_by_catalog?.[catalog] ?? (slot.catalogs.length === 1 ? slot.operations : []);
  const candidates: PickCandidate[] = [];
  for (const [name, profile] of profiles.list()) {
    const servesEvery = slot.catalogs.every((catalog) => {
      const grant = profileForCatalog(profile, catalog);
      return grant?.catalog_slug === catalog
        && operationsFor(catalog).every((op) => grant.allowed_operations.includes(op));
    });
    if (!servesEvery) continue;
    candidates.push({ connection_name: name, catalog_slug: first, ...(vendor !== undefined ? { vendor } : {}) });
  }
  candidates.sort((a, b) => a.connection_name.localeCompare(b.connection_name));
  return candidates;
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
