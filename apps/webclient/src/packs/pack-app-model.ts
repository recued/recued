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
 *  ⚠ That act was taken once, for the `ingredient` steps INSTALL produces. An
 *  installed recipe's ops are lowered onto ingredients, so an unreadable
 *  ingredient step made every installed read an operation. An ingredient step
 *  now counts as the op it runs, when that is exactly knowable: a pack catalog
 *  plus `input.operation`, or a kernel backing slug, which the registry maps
 *  one-to-one onto its op. The op's declared risk then decides, so a
 *  `mail-send` step is judged as `core.mail.send`, a write. Any other
 *  ingredient step is still disqualifying.
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
  isProvablyReadOnly,
  recipeSpendsPerRun,
  buildPackOperationIndex,
  recipeDeclaredOps,
  recipeRecordsUsage,
  type PackOperationIndex,
  type RecordsUsagePack,
} from '@recued/contracts';
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

/** The variables the engine will demand from the caller — `null`, or a
 *  non-optional ValueHint with no `default`. `null` when the boundary itself is
 *  malformed, which must never read as "takes no input".
 *
 *  ⛔ ONE RULE, TWO CALLERS. `needsAnArgument` asks whether the list is empty;
 *  D-282 B5 asks which variable a URL's value binds to. Deriving the second from
 *  a second copy is how a recipe becomes a tab on one axis and a lookup on the
 *  other. */
export const requiredVariables = (
  recipe: ServerRecipeListEntry['recipe'],
): string[] | null => {
  const variables = (recipe as unknown as { variables?: unknown }).variables;
  if (variables === undefined) return [];
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    return null;
  }
  const required: string[] = [];
  for (const [key, spec] of Object.entries(variables as Record<string, unknown>)) {
    if (spec === null) return null;
    if (typeof spec !== 'object' || Array.isArray(spec)) continue;
    const hint = spec as Record<string, unknown>;
    if (hint.optional !== true && hint.default === undefined) required.push(key);
  }
  return required;
};

/** Does one run of this recipe spend the owner something? The server's
 *  projection wins; a row that still carries its steps (an older server) is
 *  answered locally.
 *
 *  ⛔ ABSENT BOTH, IT SPENDS. A list row has carried no steps since the body came
 *  off the list, so a local answer from it is always "does not spend": the gate
 *  was off, masked only while the effect half failed every lowered kernel step
 *  first. Answering "spends" costs a button where a tab would have been; the
 *  other answer costs the owner's tokens on every tab switch and data burst. */
const spendsPerRun = (entry: ServerRecipeListEntry, ops: PackOperationIndex): boolean =>
  entry.spends_per_run
  ?? (Array.isArray((entry.recipe as { steps?: unknown }).steps)
    ? recipeSpendsPerRun(entry.recipe as never, ops)
    : true);

/** Is this recipe proven free of effects? The same rule as `spendsPerRun`: the
 *  server's projection wins, and a row that still carries its steps (an older
 *  server) is answered locally.
 *
 *  ⛔ ABSENT BOTH, IT IS NOT PROVEN. The fallback used to judge the row itself,
 *  cast past the parameter type, and a row with no steps passes every check
 *  over nothing: any recipe, a delete included, came back read-only and ran as
 *  a view (2026-09-24 audit). Only a server composed without the pack roster
 *  sends a row with neither, and a button is the safe answer there. */
const provablyReadOnly = (entry: ServerRecipeListEntry, ops: PackOperationIndex): boolean =>
  entry.provably_read_only
  ?? (Array.isArray((entry.recipe as { steps?: unknown }).steps)
    ? isProvablyReadOnly(entry.recipe as never, ops)
    : false);

/** Does the recipe require caller-supplied input or page context?
 *
 *  `deriveRecipeTargeting` is the shared modal/server rule for record and page
 *  targets. The variable sweep then mirrors engine preflight for every other
 *  required input: `null` is required; a ValueHint object is required when it
 *  is not optional and has no default; primitive / array shorthand values are
 *  themselves defaults. Together these keep auto-run tabs self-sufficient. */
const needsAnArgument =(recipe: ServerRecipeListEntry['recipe']): boolean => {
  if (deriveRecipeTargeting(recipe).targeted) return true;
  const required = requiredVariables(recipe);
  // Installed recipes are validated, but this is the auto-run classifier: a
  // malformed variable boundary must cost a tab, never be interpreted as
  // "takes no input".
  return required === null || required.length > 0;
};

/** The ONE variable a URL tail may bind for a lookup — or null, meaning this
 *  lookup is not addressable and its argument must be collected by the modal.
 *
 *  🔑 D-282 B5. A detail page is a place: `#packs/rental-book/use/show-building/
 *  bld_42` should be bookmarkable, shareable, and a real Back step. That is only
 *  honest when the address names exactly one thing, so this refuses every case
 *  where a single segment would be a guess:
 *
 *   - MORE THAN ONE required variable — the segment cannot say which it fills,
 *     and filling the first would run a different query than the one the URL
 *     appears to describe.
 *   - ZERO required variables — nothing to bind. (A lookup can land here by
 *     being TARGETED, below.)
 *   - A MALFORMED variable boundary (`requiredVariables` → null) — the same
 *     fail-closed reading `needsAnArgument` takes.
 *   - TARGETED. `deriveRecipeTargeting` says the argument comes from page /
 *     record CONTEXT, which a hash cannot carry. Binding the variable alone
 *     would run it with half its input, which fails in the recipe rather than
 *     here, where the reason is legible.
 *
 *  ⛔ THIS IS NOT A PERMISSION CHECK, AND MUST NEVER BE READ AS ONE. It answers
 *  "can one segment express this argument", nothing more. Whether the recipe may
 *  be run from a URL at all is `surface.lookups` membership — the read-only
 *  proof — and the caller checks that SEPARATELY, against the roster installed
 *  right now. A pack version bump can move a recipe from lookup to operation,
 *  and this function would not notice. */
export const lookupTargetVariable = (
  recipe: ServerRecipeListEntry['recipe'],
): string | null => {
  if (deriveRecipeTargeting(recipe).targeted) return null;
  const required = requiredVariables(recipe);
  if (required === null || required.length !== 1) return null;
  return required[0]!;
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

/** ⛔⛔ TAKES A PACK WHOSE MANIFEST IS IN HAND, AND THE TYPE IS THE GUARD.
 *  `packs.list` sends no manifest for ANY pack (`PackListEntry.manifest`), so an
 *  absent one means "not fetched yet", never "ships nothing". This used to read
 *  it as the second (`?? { recipes: [] }`): an installed pack classified to an
 *  empty surface while its manifest was in flight, the panel took that for an
 *  answer, and a bookmarked detail address was discarded before the real
 *  surface arrived. The caller decides what "not yet" looks like. */
export const packAppSurface = (
  pack: PackListEntry & { manifest: BulkPackManifest },
  index: PackAppIndex,
): PackAppSurface => {
  const byId = index.byRecipeId;
  const views: PackAppRecipe[] = [];
  const lookups: PackAppRecipe[] = [];
  const operations: PackAppRecipe[] = [];
  const automations: PackAppRecipe[] = [];
  const missing: string[] = [];

  for (const slug of shippedVisibleSlugs(pack.manifest)) {
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
    // ⛔ THE SERVER'S ANSWER WINS. It computes this against the whole bundled
    // roster with the step bodies in hand; this client has neither reliably —
    // `packs.list` no longer forwards manifests, so the local roster resolves
    // almost nothing and the local rule fails CLOSED on genuine views. The
    // local compute stays only for a server too old to project it, and only
    // while the row still carries `steps` (see `provablyReadOnly`).
    // ⛔⛔ D-282 — TWO QUESTIONS, AND A RECIPE MUST ANSWER BOTH TO RUN WITHOUT
    // BEING ASKED. A view RUNS ON SELECTION and B4 re-runs it on every data
    // burst, so the bar is not "is this a reading surface" but:
    //
    //   1. May I run it at all without asking?  — an EFFECT question,
    //      `isProvablyReadOnly`, now across BOTH op tiers.
    //   2. May I run it REPEATEDLY without spending? — a COST question, which
    //      no risk tier can answer: every `core.ai.*` op is `risk: 'read'` and
    //      correctly so, while costing tokens on each run.
    //
    // Either answer being no sends the recipe to `operations`, where a person
    // presses a button — their attention is needed for it anyway. Measured at
    // the change: 396 views → 233, with 49 kernel-writing and 114 AI-spending
    // recipes moving to a button.
    //
    // ⛔ The cost half comes from the server too (`spends_per_run`). It used to be
    // computed here from the row, which has carried no steps since the body came
    // off the list, so it always answered "does not spend" — see `spendsPerRun`.
    const effectFree = rendersReadingSurface(entry.recipe) && provablyReadOnly(entry, index.ops);
    if (!effectFree) {
      operations.push(item);
      continue;
    }
    if (needsAnArgument(entry.recipe)) {
      // ⚠ A LOOKUP ANSWERS ONLY THE FIRST QUESTION, AND THAT IS NOT LENIENCY.
      // Question 2 is "may I run it REPEATEDLY without spending", and nothing
      // repeats a lookup: `activeViewId` is only ever a view tab, so B4's
      // redraw cannot reach one, and B5's bookmark hydration is a ONE-SHOT set
      // at mount. It runs on a row press or a followed link — attention is
      // present each time. Gating it on cost too would have demoted 65 detail
      // pages to launcher rows with a hand-typed id, which is B5 undone for a
      // repeat that cannot happen.
      lookups.push(item);
      continue;
    }
    // A view is the one thing that runs with nobody asking — on selection, and
    // again on every coalesced data burst (B4) — so it must answer BOTH.
    (spendsPerRun(entry, index.ops) ? operations : views).push(item);
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
