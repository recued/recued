/** D-182 §10 step 8 / R1 — the recipe-runnability DISCLOSURE wire shape.
 *
 *  The read-time signal of whether a recipe's canonical `core.crm.*`/`core.acct.*`
 *  op-steps can run against the CURRENTLY bound connection families — so a surface
 *  can disclose "born blocked — connect a provider" at install and "this disables N
 *  recipes" at uninstall. NOT new enforcement: the run path already fails closed (an
 *  unbound canonical write blocks pre-run; an unbound read empties + warns — the R1
 *  verb-split, `applyKernelOpRunnability` in `@recued/recipes`).
 *
 *  PURE WIRE TYPES — `@recued/contracts` owns them so the `recipe.runnability` rpc +
 *  the `recipe_runnability_changed` broadcast can reference them without importing a
 *  backend module. The backend handler computes each recipe's status from the R1
 *  verb-split and SYNTHESIZES the per-family `DependencyResolution[]` detail
 *  (`synthesizeDependencies`), family-keyed (`crm`/`acct`), so the webclient pills +
 *  the install/uninstall disclosure copy render unchanged. (This is the disclosure
 *  half of the dropped R2 capability-DI model — the per-op provider graph is gone;
 *  these types remain as the R1-fed wire shape.)
 *
 *  RECOVERABLE by construction: runnability is a PURE function of the live
 *  connections — no persisted derived state to get stale. Bind a connection /
 *  install a provider pack and the next recompute lifts the recipe back to
 *  `runnable`; uninstalling a provider NEVER deletes a recipe (doc §1.6, the
 *  forbidden destructive failure) — it only MOVES the recipe's runnability. The
 *  recompute rides the mutation points (connect/disconnect, pack install/uninstall)
 *  and fans over the broadcast bus (D-121).
 */

/** A recipe's derived runnability.
 *    - `runnable` — every declared dependency is satisfied by a bound provider.
 *    - `degraded` — every HARD dependency is satisfied, but ≥1 OPTIONAL dependency
 *      is not (the optional capability's steps degrade-skip; the rest of the recipe
 *      still runs — the degraded run is AUTHORED, doc §1.5).
 *    - `blocked`  — ≥1 HARD dependency is unsatisfied (no bound provider covers it).
 *  A recipe with no `dependencies` is always `runnable` (it calls no provider-backed
 *  capability). A `blocked` recipe is never deleted — bind/grant a provider and the
 *  next recompute recovers it (doc §1.6). */
export type RunnabilityStatus = 'runnable' | 'degraded' | 'blocked';

/** Per-dependency resolution detail within a `RunnabilityResult`. Under R1 the
 *  backend synthesizes one entry per UNBOUND convention family (`crm`/`acct`) the
 *  recipe needs (`synthesizeDependencies`): `capability` = the family, `ops` = the
 *  affected canonical verbs, `providers` empty (the family has no bound provider —
 *  the whole point of a non-`runnable` entry). The field shapes below describe the
 *  full wire contract the webclient disclosure renders. */
export interface DependencyResolution {
  /** The dependency's capability (echoed from the declaration). */
  capability: string;
  /** The ops the dependency requires (echoed from the declaration, de-duplicated). */
  ops: readonly string[];
  /** Whether the dependency is optional (from the declaration's `optional`, default
   *  `false` ⇒ HARD). */
  optional: boolean;
  /** Satisfied iff ≥1 bound provider grants ALL of `ops` for `capability`
   *  (per-provider — doc §1.5: "'has a provider' means all required ops are
   *  covered"). Equivalent to `providers.length > 0`. */
  satisfied: boolean;
  /** The provider ids that EACH grant ALL of `ops` for `capability`. Empty ⇒
   *  unsatisfied. Exactly one ⇒ that provider is the LAST provider — uninstalling it
   *  flips the dependency unsatisfied (blocks a hard dep / degrades an optional one),
   *  the doc §1.6 last-provider determination. >1 ⇒ a read fans out / a write must
   *  pick (doc §1.3; the pick UX is still-open §4). */
  providers: readonly string[];
  /** Ops NOT granted by ANY bound provider for `capability` — the disclosure detail
   *  naming exactly what a new provider must add. May be EMPTY even when
   *  `satisfied` is false: every op is granted somewhere but no single provider
   *  covers them all (cross-provider spread — the per-operand-multi-connection
   *  still-open case, doc §4). So `satisfied` is the authoritative flag;
   *  `unprovided_ops` is the human-facing "why". */
  unprovided_ops: readonly string[];
}

/** The headline R1 status plus the per-family detail that drives install/uninstall
 *  disclosure + the bus broadcast payload. */
export interface RunnabilityResult {
  status: RunnabilityStatus;
  /** One synthesized entry per unbound convention family the recipe needs. Empty
   *  when every needed family is bound (→ `status: 'runnable'`). */
  dependencies: readonly DependencyResolution[];
}

/** A `RunnabilityResult` tagged with the recipe it describes — the per-recipe
 *  wire shape the read surface returns (R2 build step 4c.1, `recipe.runnability`
 *  rpc). One entry per known recipe; the consumer (webclient recipes view) filters
 *  to the non-`runnable` ones for the "born blocked / disables N recipes"
 *  disclosure. `@recued/contracts` owns the type so the rpc registry can reference
 *  it without importing a backend module. */
export interface RecipeRunnabilityEntry extends RunnabilityResult {
  /** The recipe this runnability describes. */
  recipe_id: string;
}

/** A recipe whose R1 runnability STRICTLY WORSENS when a pack is uninstalled — the
 *  unit of the doc §1.6 reverse-walk that powers the uninstall "this disables N
 *  recipes" disclosure. Produced by the backend `listRecipesWorsenedByPackUninstall`
 *  (the registry-shrink diff); surfaced on
 *  `BulkPackUninstallResultLike.would_disable` / `.would_degrade`. `before`/
 *  `after` are the recipe's status with / without the removed providers —
 *  `after` ranks strictly worse (`runnable` < `degraded` < `blocked`), so an
 *  entry is one of: runnable→degraded, runnable→blocked, or degraded→blocked.
 *  The uninstall disclosure splits the walk by `after`: `blocked` →
 *  `would_disable` (the recipes that actually STOP running), `degraded` →
 *  `would_degrade` (still running, an optional capability's steps skip). */
export interface RunnabilityTransition {
  recipe_id: string;
  before: RunnabilityStatus;
  after: RunnabilityStatus;
}
