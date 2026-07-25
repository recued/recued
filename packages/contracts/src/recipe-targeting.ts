/** Entity-targeting rule for manual runs — derivation + run-time assessment
 *  (reactive-automation-watch-dispatch design § 8).
 *
 *  A recipe is TARGETED when it requires a record selector with no default:
 *  it reads one specific record the CALLER must supply. Post-D-148 the
 *  extension's implicit page-entity context is gone, so a targeted recipe
 *  run without its target doesn't fail loud — it runs on nothing
 *  (`{{context.entity_id}}` resolves undefined and every downstream step
 *  null-derefs or fabricates). This module is the ONE rule set both
 *  enforcement ends share (the trigger-sugar precedent): the webclient run
 *  modal warns + disables Run until the target is supplied, and the server
 *  execute guard blocks a targeted-without-target dispatch regardless of
 *  caller (webclient / chat / MCP).
 *
 *  Targetedness is DERIVED, never an author flag. Three prongs:
 *
 *    context   a step or output section materially references a
 *              non-engine `{{context.<field>}}` — the field the
 *              extension used to inject from the page (corpus: 69/165
 *              community recipes, almost all `context.entity_id`).
 *              Engine/client-injected fields (`tabs` / `server` /
 *              `bridge` / `event` / `recipe`) never count. A field some
 *              step null-guards in `skip_when` is author-handled
 *              (an authored fallback path) and never counts either —
 *              `fail_on` null-checks are the opposite signal (an authored
 *              REQUIREMENT) and keep the field targeted.
 *    config    a `read` / `update` / `delete` canonical op-step whose
 *              `args.id` record selector resolves from a required
 *              (no-default) recipe variable. A defaulted variable is
 *              self-sufficient; a selector fed from `step.*` / `item.*`
 *              / `trigger.*` is self-resolving (search → act recipes are
 *              non-targeted). An op-step with NO selector at all is an
 *              authoring defect the dispatch-time resolver already
 *              rejects (`deriveRecordSelectorArgs`) — not a run target.
 *    page      a page `trigger` pattern list — the recipe belongs on a
 *              record page. Satisfied by a page-aware caller
 *              (`context.tabs` non-empty) or by supplying every context
 *              target directly (the "run from chat / resolve the entity"
 *              route — off-page runs resolve "the Acme deal" to an id).
 *
 *  `deriveRecipeTargeting` follows the `analyzeRecipe` contract: it TRUSTS
 *  the input and never throws — malformed recipes yield a best-effort
 *  (usually empty) result. Validity is the validator's job.
 */

const ENGINE_CONTEXT_FIELDS: ReadonlySet<string> = new Set([
  'tabs',
  'server',
  'bridge',
  'event',
  'recipe',
]);

/** One caller-suppliable target requirement. */
export interface TargetRequirement {
  /** Which namespace satisfies it: a `context.<key>` field, a
   *  `config.<key>` variable, or the page itself (`key` is `'page'`). */
  kind: 'context' | 'config' | 'page';
  key: string;
}

export interface RecipeTargeting {
  /** True iff the recipe requires at least one caller-supplied target. */
  targeted: boolean;
  /** Deterministic order: context targets (sorted), config targets
   *  (sorted), then the page target. */
  targets: TargetRequirement[];
}

const NON_TARGETED: RecipeTargeting = { targeted: false, targets: [] };

// ── reference walking ───────────────────────────────────────────
// Same ref grammar as `analyzeRecipe` (packages/recipes/src/analyze.ts) —
// mirrored here because the public-boundary direction is recipes →
// contracts, so contracts cannot import the analyzer.
const CONTEXT_REF_RE = /\{\{\s*context\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

const contextRootsIn = (value: unknown, into: Set<string>): void => {
  if (value === undefined) return;
  const serialized = JSON.stringify(value) ?? '';
  for (const match of serialized.matchAll(CONTEXT_REF_RE)) {
    const root = match[1];
    if (root && !ENGINE_CONTEXT_FIELDS.has(root)) into.add(root);
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stepsOf = (recipe: Record<string, unknown>): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = [];
  for (const phase of ['trigger_steps', 'prefetch_steps', 'steps'] as const) {
    const list = recipe[phase];
    if (!Array.isArray(list)) continue;
    for (const step of list) {
      const rec = asRecord(step);
      if (rec) out.push(rec);
    }
  }
  return out;
};

const ABSENCE_OPERATOR_RE = /\bis_(?:not_)?(?:null|empty)\b/;
const ABSENCE_OPERATORS: ReadonlySet<string> = new Set([
  'is_null',
  'is_not_null',
  'is_empty',
  'is_not_empty',
]);

/** Context roots a step's `skip_when` absence-checks (`is_null` /
 *  `is_empty` and negations, string or object condition form). Either
 *  direction marks the author as having thought about absence — a
 *  skip-on-missing fallback or a run-only-when-missing alternate path. */
const nullGuardedRootsIn = (skipWhen: unknown, into: Set<string>): void => {
  let text: string | null = null;
  if (typeof skipWhen === 'string') {
    text = skipWhen;
  } else {
    const cond = asRecord(skipWhen);
    if (
      cond
      && typeof cond.field === 'string'
      && typeof cond.operator === 'string'
      && ABSENCE_OPERATORS.has(cond.operator)
    ) {
      text = cond.field + ' ' + cond.operator;
    }
  }
  if (text === null || !ABSENCE_OPERATOR_RE.test(text)) return;
  for (const match of text.matchAll(CONTEXT_REF_RE)) {
    const root = match[1];
    if (root) into.add(root);
  }
};

// ── required-variable check ─────────────────────────────────────
// Mirrors the engine preflight's `findMissingVariables` requiredness
// (packages/engine/src/preflight.ts): `null` = required no default;
// a ValueHint object is required when not `optional` and carrying no
// `default`; every primitive / array shorthand has a default.
const isRequiredVariable = (spec: unknown): boolean => {
  if (spec === null) return true;
  const hint = asRecord(spec);
  if (!hint) return false;
  return hint.optional !== true && hint.default === undefined;
};

const OP_TARGET_VERB_RE = /^[a-z_]+\.(read|update|delete)$/;
const CONFIG_REF_RE = /\{\{\s*config\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Derive whether a recipe requires caller-supplied targets, and which.
 *  Trusts the input — never throws, returns best-effort output. */
export const deriveRecipeTargeting = (input: unknown): RecipeTargeting => {
  const recipe = asRecord(input);
  if (!recipe) return NON_TARGETED;

  const steps = stepsOf(recipe);
  const contextRoots = new Set<string>();
  const nullGuarded = new Set<string>();
  const configKeys = new Set<string>();
  const variables = asRecord(recipe.variables) ?? {};

  for (const step of steps) {
    nullGuardedRootsIn(step.skip_when, nullGuarded);

    // Material use only — a ref that appears solely inside the step's own
    // conditions is gating, not consumption.
    const material: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step)) {
      if (key !== 'skip_when' && key !== 'fail_on') material[key] = value;
    }
    contextRootsIn(material, contextRoots);

    // Op prong — read/update/delete record selector fed from caller config.
    if (typeof step.op === 'string' && OP_TARGET_VERB_RE.test(step.op)) {
      const args = asRecord(step.args);
      const id = args?.id;
      if (typeof id === 'string') {
        for (const match of id.matchAll(CONFIG_REF_RE)) {
          const variable = match[1];
          if (variable && isRequiredVariable(variables[variable])) configKeys.add(variable);
        }
      }
    }
  }
  contextRootsIn(recipe.output, contextRoots);

  const targets: TargetRequirement[] = [];
  for (const key of [...contextRoots].sort()) {
    if (!nullGuarded.has(key)) targets.push({ kind: 'context', key });
  }
  for (const key of [...configKeys].sort()) targets.push({ kind: 'config', key });
  if (Array.isArray(recipe.trigger) && recipe.trigger.length > 0) {
    targets.push({ kind: 'page', key: 'page' });
  }

  return targets.length > 0 ? { targeted: true, targets } : NON_TARGETED;
};

// ── run-time assessment ─────────────────────────────────────────

export interface TargetAssessment {
  ok: boolean;
  /** Unsatisfied requirements, in `targets` order. Empty when `ok`. */
  missing: TargetRequirement[];
}

/** A value satisfies a target when it is present and non-empty — an
 *  empty-string entity id is as absent as no id. */
const supplied = (value: unknown): boolean =>
  value !== undefined
  && value !== null
  && !(typeof value === 'string' && value.trim() === '');

/** Assess a run's caller-supplied config + context against the recipe's
 *  derived targets. The page target is satisfied by a page-aware caller
 *  (non-empty `context.tabs`) or — when the recipe also carries context
 *  targets — by supplying all of them (the entity arrived another way). */
export const assessRunTargets = (
  targeting: RecipeTargeting,
  config: Record<string, unknown> | undefined,
  context: Record<string, unknown> | undefined,
): TargetAssessment => {
  if (!targeting.targeted) return { ok: true, missing: [] };
  const cfg = config ?? {};
  const ctx = context ?? {};

  const contextTargets = targeting.targets.filter((t) => t.kind === 'context');
  const contextSatisfied = contextTargets.every((t) => supplied(ctx[t.key]));
  const tabs = ctx.tabs;
  const pageSatisfied =
    (Array.isArray(tabs) && tabs.length > 0)
    || (contextTargets.length > 0 && contextSatisfied);

  const missing = targeting.targets.filter((t) => {
    if (t.kind === 'context') return !supplied(ctx[t.key]);
    if (t.kind === 'config') return !supplied(cfg[t.key]);
    return !pageSatisfied;
  });
  return { ok: missing.length === 0, missing };
};

/** One caller-facing sentence for a blocked targeted run — shared verbatim
 *  by the server guard's `recipe_target_required` error and the run
 *  modal's warning, so every surface (and the chat/MCP model reading a
 *  tool result) sees the same teaching: name the exact key(s) to pass and
 *  the resolve-then-rerun route. Tuning this is a model-facing change —
 *  read + append internal design notes. */
export const buildTargetRequiredMessage = (
  recipeId: string,
  missing: ReadonlyArray<TargetRequirement>,
): string => {
  const contextKeys = missing.filter((t) => t.kind === 'context').map((t) => 'context.' + t.key);
  const configKeys = missing.filter((t) => t.kind === 'config').map((t) => 'config.' + t.key);
  const pageOnly = missing.length > 0 && missing.every((t) => t.kind === 'page');

  if (pageOnly) {
    return `Recipe '${recipeId}' runs on a matching page — open the page in a connected browser, or supply the target record via context.`;
  }
  const supply = [...contextKeys, ...configKeys];
  return (
    `Recipe '${recipeId}' needs a target record — none was supplied. `
    + `Set ${supply.join(' and ')} to the record's id, then re-run; `
    + `resolve the record first (e.g. search for it) if you only have a name.`
  );
};
