/** D-182 §10 step 8 / R1 — the runtime verb-split applied to a recipe.
 *
 *  The pure recipe-level half of kernel canonical runnability (R1). Slice 2
 *  shipped the per-op primitive `kernelOpRunnability(op, boundFamilies)` in
 *  `@recued/contracts` (`convention → required_connection_kind → is-bound`);
 *  this walks a recipe's steps and APPLIES that verdict to the canonical-
 *  convention op-steps (`core.crm.*` / `core.acct.*`) BEFORE the run:
 *
 *    - read / search, family unbound  → REWRITE the op-step to an empty-result
 *      `transform: 'default'` step KEEPING the op-step's id (so downstream
 *      `{{step.<id>}}` reads see the empty value and the recipe CONTINUES —
 *      downstream-safe), and record a pre-run WARNING for the owner.
 *    - create / update / delete (write / destructive), family unbound → record
 *      a BLOCK (the caller fails closed pre-run — a write must NEVER silently
 *      no-op a side effect because no provider is bound).
 *    - bound family / closed-kind kernel op (`core.ai.*`, `core.notification.*`,
 *      …) / non-kernel op (a bare `deal.search` `CanonicalOpStep`, a Tier-P
 *      `<publisher>.<pack>.<op>`) / a `transform` / `ingredient` / `guard` step →
 *      LEFT UNTOUCHED. `kernelOpRunnability` returns null for anything that is
 *      not a well-formed registered Tier-K op, and `{ runnable: true }` for a
 *      closed-kind or bound-convention op, so only an UNBOUND canonical-
 *      convention op is ever rewritten / blocked.
 *
 *  Scope (read before extending): this is precisely the `core.<convention>.*`
 *  form. The legacy bare canonical op-step (`op: 'deal.search'`) keeps its own
 *  established fail-closed dispatch behavior (the pick-resolution layer + the
 *  `resolveCanonicalRecipeForDispatch` guard) — `kernelOpRunnability` returns
 *  null for it (one-dot id, not `core.*`), so it passes through here untouched.
 *
 *  Pure + portable (no backend import): the bound connection families arrive
 *  INJECTED — the runtime derives them from the live connections on the
 *  connection broadcast (the consumer-side half; there is no persisted derived
 *  state to get stale, so the runtime recomputes per run).
 *
 *  The verb that picks the EMPTY SHAPE is re-parsed off the op id rather than
 *  threaded back from `kernelOpRunnability` (which intentionally returns only
 *  the read/write CLASS): a canonical `search` returns a COLLECTION (downstream
 *  `filter`/`sort`/`to_table`), so its empty value is `[]`; a `read` returns ONE
 *  record (downstream `{{step.<id>.<field>}}`), so its empty value is `{}` (a
 *  missing field reads `undefined` either way — both shapes are null-safe).
 *
 *  Spec: D-182 §3 (R1 verb-split) + §10 step 8.
 */
import {
  isOpStep,
  kernelOpRunnability,
  parseOpId,
  type KernelConnectionFamily,
  type RecipeDefinition,
  type RecipeStep,
  type TransformStep,
} from '@recued/contracts';

/** One unbound canonical-convention op-step the R1 walk acted on. `op` is the
 *  Tier-K op id, `step_id` the recipe step it sits on, `warning` the pre-run
 *  message from `kernelOpRunnability` (surfaced to the owner for a read; the
 *  block reason for a write). */
export interface KernelRunnabilityEntry {
  step_id: string;
  op: string;
  warning: string;
}

/** The result of `applyKernelOpRunnability`:
 *   - `ok: true`  — every unbound canonical op was a READ (rewritten to empty +
 *     warned) or there were none; `recipe` is the (possibly-rewritten) recipe to
 *     run, `warnings` the per-read pre-run notices.
 *   - `ok: false` — ≥1 unbound canonical op was a WRITE/destructive; the caller
 *     fails closed pre-run. `blocked` lists every write op that needs a provider;
 *     `warnings` still carries any read notices found alongside (the run is
 *     blocked regardless, but the messages stay available). */
export type KernelRunnabilityResult =
  | { ok: true; recipe: RecipeDefinition; warnings: KernelRunnabilityEntry[] }
  | { ok: false; blocked: KernelRunnabilityEntry[]; warnings: KernelRunnabilityEntry[] };

/** The canonical verb is the LAST segment of a kernel op's remainder
 *  (`core.crm.deal.search` → `search`); a `search` op yields a collection,
 *  every other read verb a single record. Only ever called for an op
 *  `kernelOpRunnability` already classified as an unbound canonical convention
 *  (so `parseOpId` is a kernel op); the tier narrow keeps it self-safe. */
const isSearchVerb = (op: string): boolean => {
  const parsed = parseOpId(op);
  return parsed?.tier === 'kernel' && parsed.op.split('.').pop() === 'search';
};

/** D-182 §10 step 8 / R1 — apply the verb-split unbound behavior to a recipe's
 *  `core.crm.*` / `core.acct.*` op-steps, given the bound connection families.
 *
 *  Returns the ORIGINAL recipe reference when nothing was rewritten (no canonical
 *  op-step, or every family bound) so an identity check downstream stays true; a
 *  fresh recipe (with the unbound reads replaced by empty-result steps) otherwise.
 *  Walks `steps` only — canonical ops live there (op-steps in `prefetch_steps`
 *  are rejected elsewhere, and `core.watch.*` trigger ops are closed-kind →
 *  always runnable). */
export const applyKernelOpRunnability = (
  recipe: RecipeDefinition,
  boundFamilies: ReadonlySet<KernelConnectionFamily>,
): KernelRunnabilityResult => {
  const warnings: KernelRunnabilityEntry[] = [];
  const blocked: KernelRunnabilityEntry[] = [];
  let changed = false;

  const steps: RecipeStep[] = recipe.steps.map((step): RecipeStep => {
    if (!isOpStep(step)) return step;
    const verdict = kernelOpRunnability(step.op, boundFamilies);
    // null → not a registered Tier-K op (bare canonical / Tier-P / malformed);
    // runnable → closed-kind or a bound convention. Either way: untouched.
    if (verdict === null || verdict.runnable) return step;

    const entry: KernelRunnabilityEntry = {
      step_id: step.id,
      op: step.op,
      warning:
        verdict.warning
        ?? `${verdict.required_connection_kind ?? 'provider'} not connected.`,
    };

    if (verdict.unbound_behavior === 'fail_closed') {
      // Write / destructive (or an unrecognized verb — `kernelOpRunnability`
      // fails safe to `fail_closed`): the run blocks pre-run. The step is left
      // in place (the caller throws before dispatch; it never executes).
      blocked.push(entry);
      return step;
    }

    // empty_result_warn — read / search: rewrite to an empty-result step KEEPING
    // the op-step id, so `{{step.<id>}}` reads the empty value and the recipe
    // continues. `skip_when` is preserved (a recipe that gated the op stays
    // consistent); `fail_on` is DROPPED (an author's `is_empty` fail guard must
    // not turn the downstream-safe empty result into a hard failure — the
    // pre-run warning already informs the owner); `args` / `cache` / `foreach`
    // are dropped (no IO runs).
    warnings.push(entry);
    changed = true;
    const emptyStep: TransformStep = {
      id: step.id,
      transform: 'default',
      value: isSearchVerb(step.op) ? [] : {},
      ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}),
    };
    return emptyStep;
  });

  if (blocked.length > 0) return { ok: false, blocked, warnings };
  return { ok: true, recipe: changed ? { ...recipe, steps } : recipe, warnings };
};
