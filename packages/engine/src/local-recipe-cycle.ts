/** D-232 — the cycle guard for gateway-routed local recipe invocation.
 *
 *  The owner's requirement was two rules: a recipe cannot route back to itself,
 *  and cannot route back to its sender. Both are the SAME rule read at
 *  different depths — the target must not already be on the call stack — and
 *  stating it that way is what makes it correct rather than merely compliant:
 *
 *      A → A          self          (depth 1)
 *      A → B → A      sender        (depth 2)
 *      A → B → C → A  neither, and lethal all the same
 *
 *  ⛔ ENUMERATING THE TWO NAMED CASES WOULD MISS THE THIRD. A guard that
 *  compares the target against `self` and `caller` admits every cycle longer
 *  than two hops, and those are the ones nobody notices while authoring: the
 *  loop closes through a recipe a third party wrote.
 *
 *  🔑 Why a SET on the context and not the depth counter that already exists.
 *  `dispatch_depth` (`MAX_DISPATCH_DEPTH`) does bound recursion — a cycle
 *  eventually hits the ceiling. But it bounds it at 32 wasted dispatches, each
 *  one a real commit with real side effects, and it reports
 *  `DispatchDepthExceededError`, which reads as "too deep" when the truth is
 *  "you built a loop". The set refuses the FIRST repeat and names both ends.
 *
 *  The shape is `SlotRequest.held_lanes` (D-181 §5) — the lane governor threads
 *  the same ancestor-set through the same dispatch tree for the same
 *  non-reentrancy reason. Copied deliberately.
 */

/** Raised when a local recipe invocation would re-enter a recipe already on the
 *  call stack. Carries both ends so the message can say WHICH loop, not just
 *  that there is one — an operator reading this needs the pair to fix it. */
export class RecipeCycleError extends Error {
  readonly code = 'recipe_cycle';
  readonly target_recipe_id: string;
  /** The stack at the moment of refusal, in no guaranteed order (it is a set).
   *  Present for the operator, never for control flow. */
  readonly held_recipes: readonly string[];

  constructor(target_recipe_id: string, held: Iterable<string>) {
    const stack = [...held];
    super(
      `Recipe cycle refused: '${target_recipe_id}' is already running in this `
      + `call (stack: ${stack.join(' → ') || '<empty>'}).`,
    );
    this.name = 'RecipeCycleError';
    this.target_recipe_id = target_recipe_id;
    this.held_recipes = stack;
  }
}

/** True when dispatching `target` would re-enter a recipe already on the stack.
 *
 *  ⚠ `held` is the ancestor set INCLUDING the currently-running recipe, so the
 *  self case needs no separate branch. A host that forgets to seed the running
 *  recipe into the set turns this into a sender-only guard that silently admits
 *  `A → A` — which is why {@link seedHeldRecipes} exists and is used at the one
 *  place a run starts. */
export const wouldCycle = (
  target: string,
  held: ReadonlySet<string> | undefined,
): boolean => held !== undefined && held.has(target);

/** The ancestor set a nested run inherits: everything held now, plus the
 *  target. Pure, so the caller cannot mutate a parent's set by accident — the
 *  bug that would let a sibling's invocation leak into another branch of the
 *  tree and refuse a call that is perfectly legal. */
export const extendHeldRecipes = (
  held: ReadonlySet<string> | undefined,
  target: string,
): ReadonlySet<string> => new Set([...(held ?? []), target]);

/** Seed the set at the ROOT of a run. Separate from
 *  {@link extendHeldRecipes} only to give the call site a name that says what
 *  it is for: an omitted seed is the difference between a guard that refuses
 *  `A → A` and one that does not, and nothing downstream can tell the two
 *  apart. */
export const seedHeldRecipes = (
  recipe_id: string | undefined,
): ReadonlySet<string> => new Set(recipe_id === undefined ? [] : [recipe_id]);

/** Throw unless `target` is safe to dispatch. The gateway's one call site. */
export const assertNoRecipeCycle = (
  target: string,
  held: ReadonlySet<string> | undefined,
): void => {
  if (wouldCycle(target, held)) throw new RecipeCycleError(target, held ?? []);
};

/** Raised when a nested local run did not COMPLETE — it paused for approval, or
 *  otherwise came back as something other than a finished result. */
export class NestedRunNotCompletedError extends Error {
  readonly code = 'nested_run_not_completed';
  readonly target_recipe_id: string;
  readonly gated_step_id?: string;

  constructor(target_recipe_id: string, gated_step_id?: string) {
    super(
      `Local recipe '${target_recipe_id}' did not complete`
      + (gated_step_id === undefined ? '' : ` — it is awaiting approval at step '${gated_step_id}'`)
      + '. Nested pause/resume is not implemented; the caller cannot continue.',
    );
    this.name = 'NestedRunNotCompletedError';
    this.target_recipe_id = target_recipe_id;
    if (gated_step_id !== undefined) this.gated_step_id = gated_step_id;
  }
}

/** ⛔ THE THREE-VALUED OUTCOME PROBLEM, held shut.
 *
 *  A recipe's outcome is `{result, pending, pointers}` — it completed, it is
 *  held, or it left references to something not yet available. The gateway's
 *  contract is per-OP-STEP and single-valued: return this step's value. Those
 *  do not compose, and the gap does not announce itself, because `executeRecipe`
 *  RETURNS a paused run rather than throwing:
 *
 *      { success: false, output: <empty>, errors: [], awaiting_approval: {...} }
 *
 *  Handed back as a step value that reads as an ordinary object, so the caller
 *  runs on. Both `errors` arrays are empty, so the caller reports SUCCESS for
 *  work that never happened — the same shape as a stub that returns `{ok:true}`
 *  without doing anything.
 *
 *  Until the caller's checkpoint can carry the callee's, this refuses. */
export const assertNestedRunCompleted = (
  target_recipe_id: string,
  result: unknown,
): void => {
  if (result === null || typeof result !== 'object') return;
  const r = result as Record<string, unknown>;
  const awaiting = r.awaiting_approval;
  if (awaiting !== undefined && awaiting !== null) {
    const gated = (awaiting as Record<string, unknown>).gated_step_id;
    throw new NestedRunNotCompletedError(
      target_recipe_id,
      typeof gated === 'string' ? gated : undefined,
    );
  }
  // A run that reports failure without errors is the same hazard wearing a
  // different face — `success: false` with nothing to explain it would
  // otherwise flow onward as a truthy step value.
  if (r.success === false && Array.isArray(r.errors) && r.errors.length === 0) {
    throw new NestedRunNotCompletedError(target_recipe_id);
  }
};
