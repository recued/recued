/** Static analysis for recipes.
 *
 *  Extracts the "what does this recipe need and what does it do?" metadata
 *  without running the recipe. Meant for:
 *    - Install flow: needs ingredient slugs (fetch manifests) + config
 *      variables (prompt user) + trigger domains (request permissions)
 *    - Marketplace: step counts, AI call count (cost tier), platforms, tags
 *    - Kitchen UI: variable list to render the settings panel
 *    - Engine preflight: unique ingredient slugs to resolve before execution
 *  ⚠ None of them calls it (checked 2026-10-06): it is exported from
 *  `@recued/recipes` and tested, and nothing in backend/, apps/ or supabase/
 *  imports it.
 *
 *  CONTRACT: this function TRUSTS the input. If you pass a malformed recipe,
 *  you get a best-effort summary — fields may be empty arrays, counts may be
 *  zero, but nothing throws. If correctness matters, run validateRecipe first.
 *
 *  All returned arrays are deduped and sorted for deterministic output.
 */

import { getKernelOp, stripCorePrefix } from '@recued/contracts';

import { aiStepDispatch } from './step-dispatch.js';

export interface RecipeSummary {
  /** Unique, sorted list of every ingredient a prefetch or sequential step
   *  dispatches to: an ingredient step's slug, and the backing ingredient of a
   *  kernel op step (`op: "core.ai.summarize"` → `core-ai-summarize`). */
  ingredient_slugs: string[];
  /** Unique, sorted list of every `op` a prefetch or sequential step names
   *  (`core.ai.summarize`, `recued-core.recurly.account.read`). A pack op
   *  resolves to an ingredient only against installed packs, so it is here and
   *  not in `ingredient_slugs`. */
  op_ids: string[];
  /** Subset of ingredient_slugs that are AI functions (`ai-*`, or a `core-ai-*`
   *  alias). */
  ai_function_slugs: string[];
  /** Unique, sorted list of `config.X` variable names referenced anywhere
   *  in the recipe. These are the variables the install flow must prompt for. */
  config_variables: string[];
  /** Unique, sorted list of `context.X` fields referenced. These come from
   *  the page/extension state, not user input. */
  context_refs: string[];
  /** Unique, sorted list of `meta.X` references. */
  meta_refs: string[];
  /** From `metadata.supported_platforms`, or empty array if unset/invalid. */
  platforms: string[];
  /** Sorted list of trigger pattern domains (the host part of each pattern).
   *  E.g. `["app.hubspot.com", "lightning.force.com"]`. Used by the install
   *  flow to request Chrome host permissions. */
  trigger_domains: string[];
  /** Number of prefetch steps. */
  prefetch_step_count: number;
  /** Number of sequential steps. */
  sequential_step_count: number;
  /** Number of sequential steps that call an AI function, in either form
   *  (`ingredient: "ai-*"` or `op: "core.ai.*"`). */
  ai_call_count: number;
  /** True iff ai_call_count > 0. */
  has_ai: boolean;
  /** TTL in seconds. Zero if missing/invalid. */
  ttl: number;
}

/** Analyze a recipe and return a summary of its dependencies and shape.
 *  Trusts the input — never throws, returns best-effort output. */
export const analyzeRecipe = (input: unknown): RecipeSummary => {
  const empty: RecipeSummary = {
    ingredient_slugs: [],
    op_ids: [],
    ai_function_slugs: [],
    config_variables: [],
    context_refs: [],
    meta_refs: [],
    platforms: [],
    trigger_domains: [],
    prefetch_step_count: 0,
    sequential_step_count: 0,
    ai_call_count: 0,
    has_ai: false,
    ttl: 0,
  };

  if (!input || typeof input !== 'object' || Array.isArray(input)) return empty;
  const r = input as Record<string, unknown>;

  const prefetch = Array.isArray(r.prefetch_steps)
    ? (r.prefetch_steps as Array<Record<string, unknown>>)
    : [];
  const steps = Array.isArray(r.steps)
    ? (r.steps as Array<Record<string, unknown>>)
    : [];
  const meta = (r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata))
    ? (r.metadata as Record<string, unknown>)
    : {};

  // ── Ingredient slugs + ops (both phases) ──────────────────────
  // ⛔ An op step names no ingredient, and every shipped recipe writes its calls
  // as op steps; this read `ingredient` alone, so a shipped recipe analysed as
  // calling nothing and as making no AI call.
  const ingredientSet = new Set<string>();
  const opSet = new Set<string>();
  for (const s of [...prefetch, ...steps]) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.ingredient === 'string' && s.ingredient) ingredientSet.add(s.ingredient);
    if (typeof s.op === 'string' && s.op) {
      opSet.add(s.op);
      const backing = getKernelOp(s.op)?.backing_slug;
      if (backing !== undefined) ingredientSet.add(backing);
    }
  }
  const ingredient_slugs = [...ingredientSet].sort();
  const op_ids = [...opSet].sort();
  const ai_function_slugs = ingredient_slugs.filter((s) => stripCorePrefix(s).startsWith('ai-'));

  // ── Reference walker (config, context, meta) ──────────────────
  // One pass over the serialized JSON instead of deep recursion — cheap, and
  // unlike phase-1 reference validation we don't need path tracking.
  const serialized = JSON.stringify(r);
  const configSet = new Set<string>();
  const contextSet = new Set<string>();
  const metaSet = new Set<string>();

  const refRe = /\{\{\s*([a-z_]+)\.([a-zA-Z_][a-zA-Z0-9_.]*?)(?::[a-z]+)?\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = refRe.exec(serialized)) !== null) {
    const ns = match[1];
    const path = match[2];
    // First segment is the variable / field name; nested paths collapse to the root
    const rootField = path.split('.')[0];
    if (!rootField) continue;
    if (ns === 'config') configSet.add(rootField);
    else if (ns === 'context') contextSet.add(rootField);
    else if (ns === 'meta') metaSet.add(rootField);
  }

  // ── Platforms ─────────────────────────────────────────────────
  const platforms = Array.isArray(meta.supported_platforms)
    ? (meta.supported_platforms as unknown[])
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];

  // ── Trigger domains ───────────────────────────────────────────
  const triggerDomains = new Set<string>();
  if (Array.isArray(r.trigger)) {
    for (const pat of r.trigger) {
      if (typeof pat !== 'string' || !pat) continue;
      const domain = extractDomain(pat);
      if (domain) triggerDomains.add(domain);
    }
  }

  // ── AI call count ─────────────────────────────────────────────
  const aiCallCount = steps.filter((s) => aiStepDispatch(s) !== undefined).length;

  // ── TTL ───────────────────────────────────────────────────────
  const ttl = typeof r.ttl === 'number' && Number.isFinite(r.ttl) ? r.ttl : 0;

  return {
    ingredient_slugs,
    op_ids,
    ai_function_slugs,
    config_variables: [...configSet].sort(),
    context_refs: [...contextSet].sort(),
    meta_refs: [...metaSet].sort(),
    platforms: [...platforms].sort(),
    trigger_domains: [...triggerDomains].sort(),
    prefetch_step_count: prefetch.length,
    sequential_step_count: steps.length,
    ai_call_count: aiCallCount,
    has_ai: aiCallCount > 0,
    ttl,
  };
};

/** Extract the host portion from a Chrome match pattern / URL glob.
 *  Examples:
 *    "app.hubspot.com/contacts/*\/deal/*"           → "app.hubspot.com"
 *    "*.lightning.force.com/*\/email*"              → "*.lightning.force.com"
 *    "https://app.pipedrive.com/deal/*"             → "app.pipedrive.com"
 *    "gmail.com/mail/u/0/*"                         → "gmail.com"
 *  Returns null if no domain can be recognized (no dot in the host segment). */

const extractDomain = (pattern: string): string | null => {
  let rest = pattern.trim();
  // Strip optional scheme
  const schemeMatch = rest.match(/^[a-z]+:\/\//i);
  if (schemeMatch) rest = rest.slice(schemeMatch[0].length);
  // Host ends at the first slash
  const slashIdx = rest.indexOf('/');
  const host = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  if (!host || !host.includes('.')) return null;
  return host;
};
