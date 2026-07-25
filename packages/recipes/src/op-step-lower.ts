/** D-182 Slice 5 (Increment 2a + 2b) — the op-step LOWERING dispatcher + the
 *  recipe-level pass.
 *
 *  The engine never runs a bare op-step (Increment 1 doc). `lowerOpStep` lowers
 *  ONE PURE D-182 `OpStep` toward the forms the existing engine +
 *  connection-agnostic resolver already run:
 *    - closed-kind Tier-K (`core.ai.prompt`, …)      → a concrete kernel
 *      `IngredientStep` (Increment 1, `resolveKernelClosedKindOpStep`).
 *    - canonical-convention Tier-K (`core.crm.*` /    → a BARE `CanonicalOpStep`
 *      `core.acct.*`)                                   the existing resolver
 *      (`resolveConnectionAgnosticRecipe`) finishes (run-resolved per the bound
 *      connection's vendor).
 *    - Tier-P pack op (`recued-core.whisper.*`)       → `lowerOpStep` returns
 *      `null` (it is not pure). `lowerPackOpStep` (Increment 2b) lowers it given a
 *      `PackOpResolution` map (`pack_ref` → its installed catalog slug + ops),
 *      which is install/dispatch state the caller assembles.
 *    - malformed / unknown kernel op                  → `null`.
 *
 *  `lowerOpStepRecipe` (Increment 2b) is the recipe-level pass: it maps every
 *  step — kernel + canonical via `lowerOpStep`, Tier-P via `lowerPackOpStep` —
 *  leaving `transform` / `guard` / already-concrete `ingredient` steps untouched,
 *  and a LEGACY bare canonical op (`deal.search` — a two-segment id, not a D-182
 *  two-tier id) passing through unchanged so the existing
 *  `resolveConnectionAgnosticRecipe` finishes it. The output is a recipe the
 *  EXISTING engine + connection-agnostic resolver already run (Increment-2 plan).
 *  It is INERT on the current corpus — no recipe carries a two-tier `op` id until
 *  the Slice-4 recipe rewrite — so it is safe to wire as a pre-pass before
 *  `resolveConnectionAgnosticRecipe` at the install + dispatch sites.
 *
 *  Spec: D-182 §3/§6. Pickup:
 *  internal design notes.
 */
import {
  ACCT_ALIAS_VALUES,
  CRM_ALIAS_VALUES,
  getKernelDomain,
  isOpStep,
  isPrefetchOpStep,
  parseOpId,
  type CanonicalOpStep,
  type IngredientStep,
  type OpStep,
  type PrefetchOpStep,
  type PrefetchStep,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';
import { CanonicalOpResolutionError } from './connection-agnostic.js';
import { resolveKernelClosedKindOpStep } from './op-step-kernel.js';

/** The alias set per canonical convention. The convention head (`core.<crm|acct>`)
 *  is EXPLICIT in the op id, so the family must belong to THAT convention's set —
 *  the lowering validates it rather than discarding the convention and letting the
 *  downstream resolver re-guess crm-vs-acct from `isAcct`-first membership (a
 *  mis-conventioned `core.crm.invoice.read` would otherwise route silently). The
 *  two sets are disjoint today (`deal`/`contact`/`account` vs
 *  `invoice`/`bill`/…/`ledger_account`); the validation does not rely on that. */
const CONVENTION_ALIAS_SETS: Readonly<Record<string, ReadonlySet<string>>> = {
  crm: new Set<string>(CRM_ALIAS_VALUES),
  acct: new Set<string>(ACCT_ALIAS_VALUES),
};

/** Lower a Tier-K canonical-convention op-step (`core.crm.deal.read` /
 *  `core.acct.invoice.search`) to the bare `CanonicalOpStep` (`deal.read`) the
 *  existing resolver consumes. Strips the `core.<convention>.` head, VALIDATES the
 *  family is an alias of that convention (fail closed on a mis-conventioned op),
 *  and carries every other field through unchanged (`args` / `connection` slot /
 *  `foreach` / passthrough knobs). Verb validity is left to the downstream
 *  resolver (`parseCanonicalOp` / `parseCanonicalAcctOp`) — one source of verb
 *  truth. Returns `null` when `step.op` is not a canonical-convention kernel op. */
// NOTE — `parseOpId` admits `_` in an OPERATION-remainder segment (`OP_SEGMENT_RE`),
//   so the underscore-bearing acct alias `ledger_account` is addressable as
//   `core.acct.ledger_account.<verb>` (the alias stays underscore to keep the
//   warehouse entity-id identity `acct_alias === entity_id`). The address HEAD
//   (publisher/pack/domain) is still strict SLUG_RE (no underscore).
const lowerCanonicalConventionOpStep = (step: OpStep): CanonicalOpStep | null => {
  const parsed = parseOpId(step.op);
  if (parsed === null || parsed.tier !== 'kernel') return null;
  if (getKernelDomain(parsed.domain)?.class !== 'canonical_convention') return null;
  const aliasSet = CONVENTION_ALIAS_SETS[parsed.domain];
  // A convention domain registered in KERNEL_DOMAINS but absent from this map
  // (a future convention wired before its alias set) — fail closed, never admit.
  if (aliasSet === undefined) {
    throw new CanonicalOpResolutionError(
      `canonical-convention op '${step.op}' (step '${step.id}') names convention ` +
        `'${parsed.domain}' with no known alias set — extend CONVENTION_ALIAS_SETS`,
    );
  }
  const family = parsed.op.split('.')[0];
  if (!aliasSet.has(family)) {
    throw new CanonicalOpResolutionError(
      `canonical op '${step.op}' (step '${step.id}') is mis-conventioned — family ` +
        `'${family}' is not a '${parsed.domain}' alias`,
    );
  }
  // `OpStep` and `CanonicalOpStep` are structurally identical (BaseStep + op /
  // args / connection / foreach); the lowering only drops the convention head from
  // the op id.
  return { ...step, op: parsed.op };
};

/** D-182 Slice 5 — the unified op-step lowering dispatcher (Increment 1 + 2a).
 *  Tries the closed-kind kernel rewrite, then the canonical-convention lowering.
 *  Returns `null` for a Tier-P pack op (Increment 2b) or a malformed/unknown op,
 *  so a caller can fall through or fail closed. PURE; throws only on a
 *  mis-conventioned canonical op (an authoring error). */
export const lowerOpStep = (step: OpStep): RecipeStep | null =>
  resolveKernelClosedKindOpStep(step) ?? lowerCanonicalConventionOpStep(step);

// ────────────────────────────────────────────────────────────────
// Increment 2b — Tier-P pack-op resolution + the recipe-level pass
// ────────────────────────────────────────────────────────────────

/** The installed-catalog binding a Tier-P `pack_ref` resolves to — the one fact
 *  `lowerPackOpStep` needs to lower a pack op: the decomposed catalog ingredient
 *  the pack's ops dispatch through, and the ops that catalog declares (for the
 *  fail-closed membership check). Assembled by the caller from install / dispatch
 *  state (the pack's decomposed catalog `IngredientManifest` — its `slug` +
 *  `operations` keys). */
export interface PackOpBinding {
  /** the decomposed catalog ingredient slug (the Gateway dispatch target — the
   *  same `ingredient:` value the tool-op rewrite emits). */
  catalog_slug: string;
  /** the pack-local operation ids the catalog declares (`audio.transcribe`). The
   *  op-step's `operation` must be a member — fail closed otherwise. */
  operations: ReadonlySet<string>;
}

/** `pack_ref` (`<publisher>.<pack>`, matching `ParsedPackOp.pack_ref`) → its
 *  installed catalog binding. A recipe's `depends_on` can name several packs, so
 *  the single-pack `PackResolutionContext` doesn't fit — this is the multi-pack
 *  lookup the recipe-level pass threads through. */
export type PackOpResolution = ReadonlyMap<string, PackOpBinding>;

/** D-182 Slice 5 (Increment 2b) — lower a Tier-P pack op-step
 *  (`recued-core.whisper.audio.transcribe`) to its concrete catalog fetch. The
 *  pack analogue of the tool-op single-fetch (`resolveToolOpStep`): a pack op
 *  names a catalog operation DIRECTLY and dispatches PASS-THROUGH (the op-step's
 *  `args` ride the fetch verbatim, the raw catalog response is the op's
 *  observable output `{{step.<id>.result…}}`) — no vendor→canonical projection.
 *  So it lowers to ONE `IngredientStep` KEEPING the op-step id (no `__raw` split).
 *  Returns `null` when `step.op` is not a well-formed Tier-P op (so the dispatcher
 *  falls through to the kernel/canonical lowering). Throws
 *  `CanonicalOpResolutionError` (fail closed) when the named pack has no resolved
 *  binding (not installed / not in `depends_on`) or declares no such operation.
 *
 *  The per-instance `connection` (a `{{config.<var>}}` ref) rides onto the
 *  concrete step verbatim for an `http` / `connection` / `mcp` pack op; a `cli` /
 *  `ai` / `entity` pack op carries none (§3) and the lowered step omits it — the
 *  downstream Gateway resolves the connection exactly as for any catalog op. */
const lowerPackOpStep = (step: OpStep, packs: PackOpResolution): IngredientStep | null => {
  const parsed = parseOpId(step.op);
  if (parsed === null || parsed.tier !== 'pack') return null;
  const binding = packs.get(parsed.pack_ref);
  if (binding === undefined) {
    throw new CanonicalOpResolutionError(
      `Tier-P op '${step.op}' (step '${step.id}') names pack '${parsed.pack_ref}', which has no ` +
        `resolved catalog binding — declare it in depends_on and install the pack`,
    );
  }
  if (!binding.operations.has(parsed.operation)) {
    throw new CanonicalOpResolutionError(
      `pack '${parsed.pack_ref}' (step '${step.id}') declares no operation '${parsed.operation}' ` +
        `in catalog '${binding.catalog_slug}'`,
    );
  }
  return {
    id: step.id,
    ingredient: binding.catalog_slug,
    ...(step.connection !== undefined ? { connection: step.connection } : {}),
    input: { operation: parsed.operation, args: step.args ?? {} },
    ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}),
    ...(step.fail_on !== undefined ? { fail_on: step.fail_on } : {}),
    ...(step.cache !== undefined ? { cache: step.cache } : {}),
    ...(step.foreach !== undefined ? { foreach: step.foreach } : {}),
    // Carry the step-level PII shorthand onto the concrete catalog step (parity
    // with the kernel lowering) — a pack `ai` op that opts into bare-name PII
    // protection keeps it through the lowering.
    ...(step.pii_fields !== undefined ? { pii_fields: step.pii_fields } : {}),
    // D-113 approval knobs — a write/destructive pack op-step keeps its authored
    // prompt / timeout through the lowering (engine reads them off the concrete step).
    ...(step.timeout_ms !== undefined ? { timeout_ms: step.timeout_ms } : {}),
    ...(step.on_timeout !== undefined ? { on_timeout: step.on_timeout } : {}),
    ...(step.prompt !== undefined ? { prompt: step.prompt } : {}),
  };
};

/** D-182 Slice 4 — project a lowered concrete `IngredientStep` (the output of the
 *  kernel / Tier-P lowering, which both target a SINGLE pass-through fetch) onto a
 *  `PrefetchStep`, carrying only the knobs prefetch honours. `optional` is sourced
 *  from the ORIGINAL prefetch op-step (it is NOT a field on `IngredientStep` — the
 *  sequential lowering drops it because op-steps are sequential-only). The
 *  top-level `connection` rides through verbatim (a Tier-P `http`/`connection`/`mcp`
 *  op carries one; a kernel op carries none) — the prefetch runner reads it the
 *  same way step-runner does (`s.connection ?? input.connection`). */
const ingredientStepToPrefetchStep = (
  concrete: IngredientStep,
  optional: boolean | undefined,
): PrefetchStep => ({
  id: concrete.id,
  ingredient: concrete.ingredient,
  ...(concrete.connection !== undefined ? { connection: concrete.connection } : {}),
  ...(concrete.input !== undefined ? { input: concrete.input } : {}),
  ...(concrete.output !== undefined ? { output: concrete.output } : {}),
  ...(optional !== undefined ? { optional } : {}),
  ...(concrete.skip_when !== undefined ? { skip_when: concrete.skip_when } : {}),
  ...(concrete.fail_on !== undefined ? { fail_on: concrete.fail_on } : {}),
  ...(concrete.cache !== undefined ? { cache: concrete.cache } : {}),
});

/** D-182 Slice 4 — lower a `PrefetchOpStep` (a two-tier `op` in `prefetch_steps`)
 *  to a concrete `PrefetchStep`. Owner decision (a): "read ops ALLOWED in prefetch
 *  — that is what it is designed for." Only ops that lower to a SINGLE fetch are
 *  admissible there:
 *
 *    - kernel CLOSED-KIND (`core.ai.*`, `core.storage.*`, …) → a concrete kernel
 *      `IngredientStep` (`resolveKernelClosedKindOpStep`) → `PrefetchStep`;
 *    - Tier-P pack op (`recued-core.hubspot.deal.read`) → a concrete catalog
 *      `IngredientStep` (`lowerPackOpStep`, pass-through raw read) → `PrefetchStep`.
 *
 *  REJECTED (throws `CanonicalOpResolutionError`, fail closed — these decompose
 *  into a fetch + a projection TRANSFORM that prefetch's ingredient-calls-only
 *  phase cannot hold):
 *
 *    - a canonical-convention kernel op (`core.crm.*` / `core.acct.*`);
 *    - a legacy bare canonical / malformed op (`deal.search`, `parseOpId === null`).
 *
 *  A `PrefetchOpStep` is structurally an `OpStep` minus the sequential-only knobs
 *  it never carries (`foreach` / `pii_fields` / approval) plus `optional` — so it
 *  feeds the existing `OpStep` lowerings unchanged, and `optional` is re-attached
 *  from the original on the way out. */
const lowerPrefetchOpStep = (step: PrefetchOpStep, packs: PackOpResolution): PrefetchStep => {
  const parsed = parseOpId(step.op);
  if (parsed === null) {
    throw new CanonicalOpResolutionError(
      `prefetch op-step '${step.id}' op '${step.op}' is not a two-tier op id — a bare canonical op ` +
        `decomposes into a fetch + a projection and must live in steps, not prefetch_steps`,
    );
  }
  if (parsed.tier === 'kernel' && getKernelDomain(parsed.domain)?.class === 'canonical_convention') {
    throw new CanonicalOpResolutionError(
      `prefetch op-step '${step.id}' op '${step.op}' is a canonical-convention op — it decomposes into ` +
        `a fetch + a projection transform and must live in steps, not prefetch_steps (use the vendor's ` +
        `Tier-P raw read for a single prefetch fetch)`,
    );
  }
  // A `PrefetchOpStep` carries only fields the `OpStep` lowerings read (`op` /
  // `args` / `connection` + BaseStep knobs); `optional` is excess and ignored
  // there, re-attached below.
  const asOpStep = step as unknown as OpStep;
  const concrete =
    parsed.tier === 'kernel'
      ? resolveKernelClosedKindOpStep(asOpStep)
      : lowerPackOpStep(asOpStep, packs);
  if (concrete === null) {
    throw new CanonicalOpResolutionError(
      `prefetch op-step '${step.id}' op '${step.op}' is a well-formed two-tier op id but resolves to no ` +
        `kernel op or installed pack binding`,
    );
  }
  return ingredientStepToPrefetchStep(concrete, step.optional);
};

/** D-182 Slice 5 (Increment 2b) — the recipe-level lowering pass. Maps every step:
 *
 *    - a `transform` / `guard` / already-concrete `ingredient` step → UNTOUCHED
 *      (`isOpStep` is false for them — the `transform` / `guard` / `ingredient`
 *      discriminant excludes each);
 *    - an op-step whose `op` does NOT parse as a two-tier id (a LEGACY bare
 *      canonical op like `deal.search` / `web.search` — two segments) → passed
 *      through unchanged, for the existing `resolveConnectionAgnosticRecipe` to
 *      finish (the two paths compose: this pass runs FIRST, that one second);
 *    - a closed-kind kernel op (`core.ai.prompt`) → a concrete kernel
 *      `IngredientStep` (Increment 1);
 *    - a canonical-convention kernel op (`core.crm.deal.read`) → a bare
 *      `CanonicalOpStep` (`deal.read`) the connection-agnostic resolver finishes
 *      (Increment 2a);
 *    - a Tier-P pack op → a concrete catalog `IngredientStep` via `lowerPackOpStep`
 *      + `packs`.
 *
 *  A well-formed TWO-TIER id that resolves to no kernel op or installed pack
 *  binding (an unknown kernel domain/op, the excluded `core.ai.embed`, or a
 *  Tier-P op whose pack/op is absent) fails closed with
 *  `CanonicalOpResolutionError` — never silently passed through (a two-tier id is
 *  unambiguously a D-182 op the engine cannot run unresolved).
 *
 *  Pure. INERT on the current corpus (no recipe carries a two-tier `op` id until
 *  the Slice-4 rewrite), so it is safe to wire as a pre-pass before
 *  `resolveConnectionAgnosticRecipe`.
 *
 *  D-182 Slice 4 — `prefetch_steps` are ALSO lowered now (owner decision (a):
 *  "read ops ALLOWED in prefetch"). A kernel closed-kind / Tier-P prefetch op-step
 *  → a concrete `PrefetchStep` (single fetch — `lowerPrefetchOpStep`); a
 *  canonical-convention or legacy bare canonical prefetch op-step → THROW (it
 *  decomposes into a fetch + projection that prefetch can't hold — it must live in
 *  `steps`). A concrete `PrefetchStep` (already an `ingredient`) passes through.
 *
 *  D-182 watcher prototype — `trigger_steps` are ALSO lowered now, identically to
 *  `steps` (the trigger phase runs through the same `runStep`): a `core.watch.*`
 *  watcher op-step rewrites to its concrete kernel watcher ingredient. */
export const lowerOpStepRecipe = (
  recipe: RecipeDefinition,
  packs: PackOpResolution,
): RecipeDefinition => {
  const steps: RecipeStep[] = recipe.steps.map((step) => lowerSequentialStep(step, packs));
  // D-182 watcher prototype — `trigger_steps` lower the SAME way as `steps`. A
  // reactive recipe's trigger phase runs through the engine's `runStep` path
  // (execute.ts `runTriggerSteps`), so a watcher op-step (`core.watch.time`)
  // must be rewritten to its concrete kernel ingredient (`time-watcher`) before
  // execution exactly like a sequential op-step. (The trigger-position
  // restriction — a `core.watch.*` op belongs ONLY in `trigger_steps`, and a
  // non-watcher op there must still produce the `should_run` gate — is a
  // validator concern, not a lowering one; the lowering is shape-preserving.)
  const triggerSteps = recipe.trigger_steps?.map((step) => lowerSequentialStep(step, packs));
  // `prefetch_steps` is typed non-optional but real recipes / fixtures may omit
  // it (the engine + resolver both defend with `?? []`); preserve its presence —
  // map only when it exists, and don't inject an empty array where there was none.
  const prefetchSteps = recipe.prefetch_steps?.map((step) =>
    isPrefetchOpStep(step) ? lowerPrefetchOpStep(step, packs) : step,
  );
  return {
    ...recipe,
    steps,
    ...(triggerSteps !== undefined ? { trigger_steps: triggerSteps } : {}),
    ...(prefetchSteps !== undefined ? { prefetch_steps: prefetchSteps } : {}),
  };
};

/** Lower ONE sequential-position step (a `steps` or `trigger_steps` entry):
 *
 *    - a `transform` / `guard` / already-concrete `ingredient` step → UNTOUCHED;
 *    - a legacy bare canonical op (`deal.search` — fewer than three segments,
 *      `parseOpId === null`) → passed through for `resolveConnectionAgnosticRecipe`;
 *    - a well-formed two-tier op (kernel closed-kind / canonical-convention /
 *      Tier-P) → its concrete lowering;
 *    - a two-tier id that resolves to nothing → THROW (fail closed).
 *
 *  Shared by `steps` + `trigger_steps` so the trigger phase lowers identically
 *  to the sequential phase (both run through the engine's `runStep`). */
const lowerSequentialStep = (step: RecipeStep, packs: PackOpResolution): RecipeStep => {
  if (!isOpStep(step)) return step;
  if (parseOpId(step.op) === null) return step;
  const lowered = lowerOpStep(step) ?? lowerPackOpStep(step, packs);
  if (lowered === null) {
    throw new CanonicalOpResolutionError(
      `op-step '${step.id}' op '${step.op}' is a well-formed two-tier op id but resolves to no ` +
        `kernel op or installed pack binding`,
    );
  }
  return lowered;
};
