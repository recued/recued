/** D-247 D15 — what installing this pack will make the AI able to reach.
 *
 *  ## Why the SERVER answers this
 *
 *  ⛔⛔ THE MANIFEST CANNOT. `chat_exposed` lives on the recipe BODY, and 0 of
 *  2,310 shipped recipe refs across 340 packs carry one — `normalizeBulkPackInstallPlan`
 *  yields `{slug, version}` and the body is resolved at install time. A picker
 *  reasoning from the manifest alone can show a COUNT and cannot say WHICH.
 *
 *  ⇒ And it resolves through `resolvePackRecipeBodies`, the SAME function the
 *  install runs, for the reason `grant-op-universe.ts` states about its own
 *  derivation: *"the derivation IS the gate's read path, and two private copies
 *  would drift."* A preview that named different recipes from the ones the
 *  install enables is worse than no preview — the owner would have consented to a
 *  list that was never true.
 *
 *  ## ⛔ NO PRECISE-LOOKING FALLBACK
 *
 *  If the bodies cannot be resolved the preview says so (`resolved: false`) and
 *  the picker renders nothing rather than a number it cannot verify. A count the
 *  picker cannot stand behind is the assurance-shaped non-assurance this
 *  substrate refuses.
 *
 *  ## The three classes (D10) are CONSENT COPY, never a gate
 *
 *  Nothing rests on getting the class right except the sentence the owner reads:
 *  under D2 an open adapter's raw op stays OFF, and under D4 its destructive call
 *  still asks. ⚠ Which is also why an underivable closure reports `'unknown'`
 *  rather than guessing — a wrong label here is a wrong sentence, and a confident
 *  wrong sentence is worse than an honest blank. */

import {
  KERNEL_OP_REGISTRY,
  type BulkPackManifest,
  type IngredientManifest,
  type OperationRiskTier,
  type RecipeDefinition,
} from '@recued/contracts';
import { normalizeBulkPackInstallPlan } from '@recued/contracts';
import { isRecipeChatExposed } from '@recued/recipes';

import { deriveRecipeCapability } from './derive-recipe-capability.js';
import { resolvePackRecipeBodies } from './pack-install-handler.js';
import type { MarketplaceRecipeResult } from '@recued/marketplace';
import type { RecipeStore } from './recipe-store.js';

/** D10's discriminator. `unknown` is a real answer, not a fallback. */
export type RecipeGrantClass =
  | 'constraining'
  | 'read_adapter'
  | 'open_adapter'
  | 'unknown';

export interface PackInstallPreviewRecipe {
  readonly publisher_id: string;
  readonly recipe_id: string;
  readonly name: string;
  readonly grant_class: RecipeGrantClass;
  /** The highest risk tier in the recipe's closure, or null when underivable. */
  readonly top_risk: OperationRiskTier | null;
  /** The closure, for the "grants X with no added constraint" sentence. */
  readonly operation_ids: readonly string[];
}

export interface PackInstallPreview {
  /** ⛔ false ⇒ the bodies could not be resolved. The picker must render NOTHING
   *  rather than a count, and the install proceeds under existing pack-level
   *  consent, unchanged. */
  readonly resolved: boolean;
  readonly will_enable: readonly PackInstallPreviewRecipe[];
  /** Refs that resolved but are NOT chat-exposed, so the install writes them
   *  closed. Surfaced as a count only — the owner is deciding about what opens. */
  readonly hidden_count: number;
}

export const RISK_RANK: Record<OperationRiskTier, number> = {
  read: 0, write: 1, admin: 2, destructive: 3,
};

const KERNEL_RISK = new Map<string, OperationRiskTier>(
  KERNEL_OP_REGISTRY.map((e) => [e.op, e.risk]),
);

/** Resolve one op's risk tier, or undefined when nothing here knows it. */
const riskFor = (
  opId: string,
  ingredientSlugs: readonly string[],
  getManifest: (slug: string) => IngredientManifest | undefined,
): OperationRiskTier | undefined => {
  const kernel = KERNEL_RISK.get(opId);
  if (kernel !== undefined) return kernel;
  // A catalog op's tier lives on the declaring manifest. Walk the recipe's own
  // slugs rather than the whole registry — a same-named op on an ingredient this
  // recipe does not use would be the wrong answer, not a近 one.
  for (const slug of ingredientSlugs) {
    const manifest = getManifest(slug);
    const ops = manifest?.operations;
    if (ops === undefined) continue;
    for (const entry of Object.values(ops)) {
      const declared = (entry as { operation_id?: string }).operation_id;
      const tier = (entry as { risk_tier?: OperationRiskTier }).risk_tier;
      if (declared === opId && tier !== undefined) return tier;
    }
    if (manifest?.risk_tier !== undefined && opId.endsWith(slug)) return manifest.risk_tier;
  }
  return undefined;
};

/** True when the recipe NARROWS what its ops can do — the D10 `constraining`
 *  test, read off the authored body. */
const isConstraining = (recipe: RecipeDefinition, opCount: number): boolean => {
  if (opCount >= 2) return true;
  const steps = [...(recipe.steps ?? []), ...(recipe.prefetch_steps ?? [])] as ReadonlyArray<
    Record<string, unknown>
  >;
  for (const step of steps) {
    if (step.skip_when !== undefined || step.fail_on !== undefined) return true;
    // A transform step reshapes or filters — that is a constraint on what the
    // caller can get back, which is the point of the class.
    if (typeof step.transform === 'string') return true;
    const input = step.input;
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      // A LITERAL arg (not a `{{ref}}`) is a pin: the caller cannot choose it.
      for (const v of Object.values(input as Record<string, unknown>)) {
        if (typeof v === 'string' && !v.includes('{{')) return true;
        if (typeof v === 'number' || typeof v === 'boolean') return true;
      }
    }
  }
  return false;
};

/** D-247 D15.1 — the highest risk tier in a recipe's closure, or `null` when the
 *  closure is underivable or no tier resolves.
 *
 *  ⛔⛔ SHARED BY THE PREVIEW AND THE SEED ON PURPOSE. The preview tells the owner
 *  which tier a recipe sits at; the seed decides whether their chosen ceiling
 *  covers it. Two derivations would let the dialog promise one thing and the
 *  install write another — and the owner would have no way to see the
 *  disagreement. */
export const recipeTopRisk = (
  recipe: RecipeDefinition,
  getManifest: (slug: string) => IngredientManifest | undefined,
): OperationRiskTier | null => {
  const derived = deriveRecipeCapability(recipe);
  if (!derived.ok) return null;
  const tiers = derived.capability.operation_ids
    .map((op) => riskFor(op, derived.capability.ingredient_ids, getManifest))
    .filter((t): t is OperationRiskTier => t !== undefined);
  return tiers.length === 0
    ? null
    : tiers.reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a));
};

export interface PackInstallPreviewDeps {
  readonly recipeStore: Pick<RecipeStore, 'getBundled'>;
  readonly resolveMarketplaceRecipe?: (slug: string) => Promise<MarketplaceRecipeResult | null>;
  readonly getManifest: (slug: string) => IngredientManifest | undefined;
}

export const buildPackInstallPreview = async (
  manifest: BulkPackManifest,
  deps: PackInstallPreviewDeps,
): Promise<PackInstallPreview> => {
  let resolvedRefs;
  try {
    const plan = normalizeBulkPackInstallPlan(manifest);
    resolvedRefs = await resolvePackRecipeBodies(plan, manifest.publisher, deps);
  } catch {
    // ⛔ Fail to UNRESOLVED, never to an empty list. "Nothing will be enabled" and
    // "we could not tell" are different sentences and the owner acts on them
    // differently.
    return { resolved: false, will_enable: [], hidden_count: 0 };
  }

  const will_enable: PackInstallPreviewRecipe[] = [];
  let hidden_count = 0;
  for (const ref of resolvedRefs) {
    const body = ref.recipe?.recipe;
    if (body == null) return { resolved: false, will_enable: [], hidden_count: 0 };
    // Pack content, so `user_authored` is false — the same call the seed makes.
    if (!isRecipeChatExposed(body, { user_authored: false })) {
      hidden_count += 1;
      continue;
    }
    const derived = deriveRecipeCapability(body);
    if (!derived.ok) {
      will_enable.push({
        publisher_id: ref.recipe!.publisher_id,
        recipe_id: ref.recipe!.recipe_id,
        name: body.metadata?.name ?? ref.recipe!.recipe_id,
        grant_class: 'unknown',
        top_risk: null,
        operation_ids: [],
      });
      continue;
    }
    const ops = [...derived.capability.operation_ids];
    const slugs = derived.capability.ingredient_ids;
    const tiers = ops
      .map((op) => riskFor(op, slugs, deps.getManifest))
      .filter((t): t is OperationRiskTier => t !== undefined);
    const top_risk = tiers.length === 0
      ? null
      : tiers.reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a));
    const grant_class: RecipeGrantClass = isConstraining(body, ops.length)
      ? 'constraining'
      : top_risk === null
        ? 'unknown'
        : top_risk === 'read'
          ? 'read_adapter'
          : 'open_adapter';
    will_enable.push({
      publisher_id: ref.recipe!.publisher_id,
      recipe_id: ref.recipe!.recipe_id,
      name: body.metadata?.name ?? ref.recipe!.recipe_id,
      grant_class,
      top_risk,
      operation_ids: ops,
    });
  }
  return { resolved: true, will_enable, hidden_count };
};
