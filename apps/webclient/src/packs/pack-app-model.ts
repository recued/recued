/** `#packs/<slug>` app surface — which of a pack's recipes are VIEWS you open
 *  and which are OPERATIONS you run.
 *
 *  A recipe-shipping pack is an app: `rental-book` is Buildings / Contracts /
 *  Customers plus "add a building", "record a payment", "raise this month's
 *  charges". Nothing in the manifest says which is which, so this derives it —
 *  and the derivation has to be honest, because a VIEW is auto-run the moment
 *  its tab is selected. Getting it wrong doesn't mis-sort a list; it silently
 *  fires a write.
 *
 *  ── The rule ──────────────────────────────────────────────────────
 *  A recipe is a VIEW iff ALL FOUR hold:
 *    1. it is manual — trigger-driven recipes are lifecycle-managed because
 *       an arbitrary press cannot manufacture their source precondition;
 *    2. it renders a reading surface — a `table` or `record_fields` block, i.e.
 *       there is something to look at;
 *    3. it is PROVABLY read-only, on two independent axes (below); and
 *    4. it needs no input to be meaningful.
 *  A read-only renderer that DOES need input is a LOOKUP, and a recipe that
 *  writes is an OPERATION. Both are reached by pressing them, which opens the
 *  run modal — the form is how you supply the id or the values.
 *
 *  ⚠ (4) follows the ENGINE'S variable rule, not the presence of a guard:
 *  `null`, or a non-optional ValueHint with no `default`, requires caller
 *  input. A guard may instead enforce a result cap or a stored-data invariant;
 *  treating every guard as an input form hid complete zero-config views such
 *  as ledger-book's tag tree. Required-variable semantics keep `show-unit` and
 *  `show-building` out of auto-run tabs without demoting those guarded views.
 *
 *  ⚠ THE TWO AXES ARE BOTH REQUIRED AND THEY CHECK DIFFERENT THINGS.
 *   - `recipeRecordsUsage` reads the pack's Records BINDING — what the op
 *     actually does to stored rows. Behaviour.
 *   - `recipeDeclaredOps().risk` reads the author's declared `RiskTier`.
 *     Declaration.
 *  They agree across every shipped pack, but nothing enforces that (see
 *  `recipe-records-usage.ts`, which exists precisely because `job.create` may
 *  bind `action: 'delete'` and publish clean). Requiring both means a pack that
 *  lies on either axis fails CLOSED — it lands in Operations, which is merely
 *  a worse menu, rather than in Views, which would run it unprompted.
 *
 *  ⛔ AN UNRESOLVED OP IS NOT A READ-ONLY OP. If a recipe names a Tier-P op no
 *  installed pack declares (a missing dependency pack, a version skew, a roster
 *  read that failed), we have NO evidence about what it does — and absence of
 *  evidence must not read as proof of safety. Those land in Operations too.
 *
 *  ⛔ THE OP-STEP SWEEP IS NOT TOTAL, so it is not trusted to be. Across all of
 *  `community/recipes` the only step shapes in use are `transform` (pure), `op`
 *  (analysed above), and `guard` (pure) — but `RecipeStep` ALSO admits
 *  `ingredient` steps, and the kernel ships writing ingredients (`shared-write`,
 *  `enrichment-upsert`, `recued/mail-send`). None appear in the corpus today, so
 *  a classifier that swept only `op` would look correct on every artifact
 *  available to test it and go blind the first time a pack shipped one — a
 *  write, auto-run on tab selection, with nothing on screen having asked.
 *  So an UNRECOGNISED STEP KIND is itself disqualifying: see
 *  `stepsAreAnalysable`. Widening that set is how a new step kind opts in, and
 *  it must be a deliberate act by someone who has decided the kind is pure.
 *
 *  Pure: same pack + same recipes + same roster → same surface.
 */

import {
  deriveRecipeTargeting,
  normalizeBulkPackInstallPlan,
  recipeOutputSections,
  type BulkPackManifest,
  type PackListEntry,
  type ServerRecipeListEntry,
} from '@recued/contracts';

import {
  buildPackOperationIndex,
  recipeDeclaredOps,
  recipeRecordsUsage,
  type PackOperationIndex,
  type RecordsUsagePack,
} from '../recipes/recipe-records-usage.js';
import { classifyRecipeAction } from '../recipes/recipe-action-kind.js';

/** Output blocks that mean "there is something here to read". A `summary` is
 *  deliberately NOT one: every operation in the corpus ends with a `to_summary`
 *  receipt card ("Created building Mill Court"), so counting it would classify
 *  every write as a view. `table` and `record_fields` are the blocks that
 *  present STORED state rather than narrate what just happened. */
const READING_BLOCKS: ReadonlySet<string> = new Set(['table', 'record_fields']);

/** One runnable entry on a pack's app surface. */
export interface PackAppRecipe {
  recipe_id: string;
  /** `metadata.name`, falling back to the id — the label on the tab / button. */
  name: string;
  /** `metadata.description`; empty string when the pack author wrote none. */
  description: string;
  /** The installed row, so the host can hand it straight to the run modal
   *  (which takes a `ServerRecipeListEntry`) without a second lookup. */
  entry: ServerRecipeListEntry;
}

export interface PackAppSurface {
  /** Read-only renderers that need no input. The app's tabs — run on selection. */
  views: PackAppRecipe[];
  /** Read-only renderers that need an argument (a record id, an offer). Not
   *  tabs — pressing one opens the run modal to collect it. Once the shared
   *  result panel lands these are also what a view's row actions target. */
  lookups: PackAppRecipe[];
  /** Recipes that write. Run explicitly, through the modal. */
  operations: PackAppRecipe[];
  /** Trigger-driven recipes. Their source preconditions do not exist at an
   * arbitrary button press, so Pack Use links to lifecycle management instead
   * of auto-running them as views or exposing a manual Run control. */
  automations: PackAppRecipe[];
  /** Recipe slugs the manifest ships that are NOT installed on this server.
   *  REPORTED, never silently dropped: a half-installed pack rendering as a
   *  smaller app is exactly the failure that looks like a working one. */
  missing: string[];
}

/** Recipes the manifest ships, in declaration order, excluding the ones the
 *  pack author marked internal.
 *
 *  `visible` is an optional annotation with no runtime consumer before this
 *  module, so its default is a judgement rather than a lookup: ABSENT reads as
 *  visible. Every v2 pack in the corpus sets it explicitly on every recipe
 *  (`true` for user-facing, `false` for guards like
 *  `<pack>-require-records-runtime`), so the default only governs v1 manifests
 *  — where showing a pack's recipes is far better than showing none. */
const shippedVisibleSlugs = (manifest: BulkPackManifest): string[] => {
  const plan = normalizeBulkPackInstallPlan(manifest);
  const slugs: string[] = [];
  for (const content of plan.contents) {
    if (content.type !== 'recipe') continue;
    if (content.visible === false) continue;
    if (!slugs.includes(content.slug)) slugs.push(content.slug);
  }
  return slugs;
};

/** Does the recipe present stored state to read? */
const rendersReadingSurface = (recipe: ServerRecipeListEntry['recipe']): boolean =>
  recipeOutputSections(recipe).some((section) => READING_BLOCKS.has(section.type));

/** Does the recipe require caller-supplied input or page context?
 *
 *  `deriveRecipeTargeting` is the shared modal/server rule for record and page
 *  targets. The variable sweep then mirrors engine preflight for every other
 *  required input: `null` is required; a ValueHint object is required when it
 *  is not optional and has no default; primitive / array shorthand values are
 *  themselves defaults. Together these keep auto-run tabs self-sufficient. */
const needsAnArgument = (recipe: ServerRecipeListEntry['recipe']): boolean => {
  if (deriveRecipeTargeting(recipe).targeted) return true;
  const variables = (recipe as unknown as { variables?: unknown }).variables;
  if (variables === undefined) return false;
  // Installed recipes are validated, but this is the auto-run classifier: a
  // malformed variable boundary must cost a tab, never be interpreted as
  // "takes no input".
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    return true;
  }
  return Object.values(variables as Record<string, unknown>).some((spec) => {
    if (spec === null) return true;
    if (typeof spec !== 'object' || Array.isArray(spec)) return false;
    const hint = spec as Record<string, unknown>;
    return hint.optional !== true && hint.default === undefined;
  });
};

/** Step kinds whose effects this module can actually account for: `transform`
 *  and `guard` are pure, `op` is what the two read-only axes inspect. A step
 *  matching none of them — an `ingredient` step, or a kind added later — is not
 *  understood, and "not understood" cannot be allowed to read as "harmless".
 *  See the header. */
const stepsAreAnalysable = (steps: unknown): boolean => {
  if (steps === undefined || steps === null) return true;
  if (!Array.isArray(steps)) return false;
  return steps.every((step) => {
    if (step === null || typeof step !== 'object') return false;
    const row = step as Record<string, unknown>;
    return typeof row.transform === 'string'
      || typeof row.op === 'string'
      || row.guard !== undefined;
  });
};

/** Can we PROVE this recipe only reads? See the header — every step kind
 *  understood, both axes clean, and an unresolved op is a no. */
const isProvablyReadOnly = (
  recipe: ServerRecipeListEntry['recipe'],
  roster: PackOperationIndex,
): boolean => {
  const r = recipe as unknown as {
    steps?: unknown; prefetch_steps?: unknown; trigger_steps?: unknown;
  };
  if (
    !stepsAreAnalysable(r.steps)
    || !stepsAreAnalysable(r.prefetch_steps)
    || !stepsAreAnalysable(r.trigger_steps)
  ) {
    return false;
  }
  const declared = recipeDeclaredOps(recipe, roster);
  if (declared.unresolved.length > 0) return false;
  if (declared.risk !== null && declared.risk !== 'read') return false;
  return recipeRecordsUsage(recipe, roster).every((pack) =>
    pack.entities.every((entity) =>
      !entity.effects.includes('write') && !entity.effects.includes('delete')));
};

/** Map the installed pack roster into the shape the usage join reads. Every
 *  installed pack is passed, not just the one being rendered — a pack's recipes
 *  routinely call ops from its DEPENDENCY packs (`email-outbox-pack`,
 *  `tesseract`), and those must resolve or `isProvablyReadOnly` fails closed on
 *  a recipe that is genuinely fine. */
export const rosterForUsage = (
  packs: readonly PackListEntry[],
): RecordsUsagePack[] =>
  packs.map((pack) => ({
    slug: pack.slug,
    publisher: pack.publisher,
    name: pack.name,
    manifest: pack.manifest,
  }));

/** Split one pack's shipped recipes into the app surface.
 *
 *  `installed` is the whole `recipes.list` result; membership comes from the
 *  MANIFEST rather than from each recipe's `metadata.recipe_bundle`, because
 *  the manifest is what the pack declares it ships and is present even for a
 *  pack whose recipes failed to install — which is how `missing` can be
 *  reported at all. */
/** Everything `packAppSurface` would otherwise rebuild on every call: the
 *  installed-recipe lookup and the pack-operation index.
 *
 *  ⛔ BOTH WERE PER-CALL, AND NEITHER DEPENDS ON THE PACK. Classifying one
 *  pack — what the panel does — never noticed. Classifying the whole corpus
 *  rebuilt a Map over every installed recipe 1,048 times and walked a ~26k-op
 *  roster once per recipe, which is ~58 s of the minute that sweep took.
 *  Taking a built index makes the reuse structural: the shape of the call
 *  now says the work is shared. */
export interface PackAppIndex {
  readonly byRecipeId: ReadonlyMap<string, ServerRecipeListEntry>;
  readonly ops: PackOperationIndex;
}

export const buildPackAppIndex = (
  installed: readonly ServerRecipeListEntry[],
  roster: readonly RecordsUsagePack[],
): PackAppIndex => ({
  byRecipeId: new Map(installed.map((entry) => [entry.recipe_id, entry])),
  ops: buildPackOperationIndex(roster),
});

export const packAppSurface = (
  pack: PackListEntry,
  index: PackAppIndex,
): PackAppSurface => {
  const byId = index.byRecipeId;
  const views: PackAppRecipe[] = [];
  const lookups: PackAppRecipe[] = [];
  const operations: PackAppRecipe[] = [];
  const automations: PackAppRecipe[] = [];
  const missing: string[] = [];

  // An uninstalled pack forwards no manifest, so it ships no visible recipes to
  // project — the empty roster is correct, not a lost one.
  for (const slug of shippedVisibleSlugs(pack.manifest ?? { recipes: [] } as never)) {
    const entry = byId.get(slug);
    if (entry === undefined) {
      missing.push(slug);
      continue;
    }
    const metadata = entry.recipe.metadata as
      { name?: unknown; description?: unknown } | undefined;
    const item: PackAppRecipe = {
      recipe_id: entry.recipe_id,
      name: typeof metadata?.name === 'string' && metadata.name.trim() !== ''
        ? metadata.name
        : entry.recipe_id,
      description: typeof metadata?.description === 'string'
        ? metadata.description
        : '',
      entry,
    };
    if (classifyRecipeAction(entry.recipe) !== 'manual') {
      automations.push(item);
      continue;
    }
    const readOnlyRenderer = rendersReadingSurface(entry.recipe)
      && isProvablyReadOnly(entry.recipe, index.ops);
    const bucket = !readOnlyRenderer
      ? operations
      : needsAnArgument(entry.recipe) ? lookups : views;
    bucket.push(item);
  }

  return { views, lookups, operations, automations, missing };
};

/** Whether `#packs/<slug>` should open on the app surface at all.
 *
 *  Gated on OWNING RUNNABLE RECIPES, not on `pack_kind` — 939 of the 951
 *  shipped packs declare `pack_kind: 'app_pack'`, so it is the default value
 *  and separates nothing. A capability pack (`adyen-checkout`, `ripgrep`) ships
 *  ops for other recipes to call and has no app surface; asking whether the
 *  pack itself gives you anything to open answers this exactly. */
export const hasAppSurface = (surface: PackAppSurface): boolean =>
  surface.views.length > 0
  || surface.lookups.length > 0
  || surface.operations.length > 0
  || surface.automations.length > 0;
