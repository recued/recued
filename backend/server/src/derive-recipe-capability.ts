/** D-207 slice 1b — the recipe CAPABILITY derivation: the complete, static op/connection
 *  closure a reception door contract is minted from.
 *
 *  ## Why this must be COMPLETE, not best-effort
 *
 *  An ungranted op is a HARD DENY, not a hold (`op_not_granted` is a deny code;
 *  `execute-handler` returns `verdict: 'deny'` and the gateway throws before the ask
 *  path). So the derived closure is load-bearing in a way an advisory list is not:
 *
 *    - UNDER-derive → the visitor's submission dies mid-run at the first op we missed,
 *      and the owner's "this form may: …" consent list was a LIE.
 *    - OVER-derive  → the owner is asked to grant more than the recipe needs.
 *
 *  `buildRecipeOpCoverage` (`mcp-server.ts`) is the closest prior art and is
 *  INSUFFICIENT here on two counts, both silent:
 *    1. it walks ONLY `recipe.steps` — a Recipe has THREE step lists
 *       (`prefetch_steps`, `steps`, `trigger_steps`), and an op reachable from
 *       prefetch or a reactive trigger is just as dispatched as one in the body; and
 *    2. it silently SKIPS anything it cannot resolve, which is exactly the failure mode
 *       we cannot afford — a skipped step is an op with no grant row.
 *
 *  ## Static analyzability is the door's ONE eligibility rule
 *
 *  A recipe CAN dispatch dynamically: `run-ingredient` (`run-ingredient-recipe.ts`) runs
 *  an ingredient whose slug is `{{config.ingredient_slug}}`. There is no static closure
 *  for such a recipe, so its consent list can never be honest. Rather than guess, we
 *  REFUSE it at BIND — never at fire, where the visitor would eat the failure.
 *
 *  Note how this differs from D-200's eligibility rule, and why this one is legitimate:
 *  D-200 admitted a recipe only if it "ends in a literal single-item Stripe line item" —
 *  a payment SHAPE masquerading as a safety property, which is precisely why it could
 *  never generalize. "Statically analyzable" is a genuine safety property: it is what
 *  makes the grant closure honest, it is checkable, and it holds for any recipe in any
 *  domain.
 *
 *  Pure: no I/O, no clock. Spec: D-207 §5.1a / §5.1d. */

import { kernelOpForBackingSlug, parseOpId, type RecipeDefinition } from '@recued/contracts';
import { extractVariableDefault } from '@recued/engine';

/** The authority surface of a recipe — exactly the axes `ContractScope` stores. */
export interface RecipeCapability {
  /** Canonical op ids the recipe dispatches (`op` steps + resolved ingredient ops). */
  readonly operation_ids: readonly string[];
  /** Catalog / kernel ingredient slugs the recipe dispatches. */
  readonly ingredient_ids: readonly string[];
  /** Connection names resolved from the recipe's own connection SLOTS (the >1-connection
   *  disambiguation case). NOT the whole connection axis — see below. */
  readonly connection_names: readonly string[];
  /** Ops / ingredients whose step OMITTED a connection slot, i.e. they ride THE PACK'S
   *  BOUND CONNECTION. The connection genuinely lives in the pack (D-194
   *  `connection_requirements` → enrollment), so the caller must complete the connection
   *  axis by resolving (op → pack → bound connection) for these.
   *
   *  ⚠ Leaving them out would leave `ContractScope.connection_names` EMPTY, and an empty
   *  scope axis is a WILDCARD (`contractScopeMatches`) — the connection fence would not
   *  bite. Reported explicitly so the omission cannot be silent. */
  readonly pack_bound_connection_ops: readonly string[];
  /** op id → the id of the FIRST step that dispatches it.
   *
   *  Attribution only, never authority: the closure is `operation_ids`. This exists so a
   *  bind-time refusal can point the owner AT THE STEP rather than hand them an op id and
   *  leave them to find it — a refusal nobody can act on is a refusal nobody heeds. */
  readonly operation_steps: Readonly<Record<string, string>>;
}

/** Why a recipe cannot back a public door. Each is a BIND-time refusal. */
export type RecipeCapabilityRefusal =
  /** The same canonical/Tier-P lowering used at dispatch could not produce a concrete
   *  recipe under the saved install config. Minting from the authored form would hide
   *  implicit account bindings or grant an operation the engine cannot actually run. */
  | { readonly reason: 'dispatch_unresolvable'; readonly step_id: '<recipe>'; readonly detail: string }
  /** A step's `op` / `ingredient` is templated — the dispatch target is not knowable
   *  until runtime, so no honest closure exists (`run-ingredient` is the canonical
   *  case). */
  | { readonly reason: 'dynamic_dispatch'; readonly step_id: string; readonly field: string }
  /** A step's `connection` resolves to neither a literal nor one of the recipe's own
   *  saved config values — so which credential it will use is not knowable at bind. */
  | { readonly reason: 'dynamic_connection'; readonly step_id: string; readonly ref: string }
  /** A step names a LITERAL connection. Forbidden: non-portable in a published recipe,
   *  and it already fails closed at validate/resolve. */
  | { readonly reason: 'literal_connection'; readonly step_id: string; readonly ref: string };

export type RecipeCapabilityDerivation =
  | { readonly ok: true; readonly capability: RecipeCapability }
  | { readonly ok: false; readonly refusal: RecipeCapabilityRefusal };

/** Maps an ingredient catalog slug + its `input.operation` back to the canonical op
 *  id(s) it covers. Supplied by the caller (`buildPackOpResolution`); when absent, an
 *  ingredient step contributes its slug but no op id. */
export type OpResolver = (
  ingredientSlug: string,
  operation: string,
) => readonly string[];

const TEMPLATE_RE = /\{\{/;
const CONFIG_REF_RE = /^\{\{\s*config\.([A-Za-z0-9_.]+)\s*\}\}$/;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Resolve `{{config.x.y}}` against the RESOLVED INSTALL CONFIG.
 *
 *  ⚠ NOT against `recipe.variables` ALONE. A Recipe is a PURE PAPER RECORD (D-179): its
 *  `variables` block DECLARES the config keys (usually `null` = "required from caller"),
 *  it does not hold their values. The values live in the DISH's `config_overlay` — the
 *  execute-handler feeds `config: { ...installDish.config_overlay, ...request.config }`.
 *  Deriving from `recipe.variables` refused 748 of 933 shipped recipes with
 *  `dynamic_connection`, because every one of them pins its connection as
 *  `"connection": "{{config.<x>}}"` and the published artifact has no value for it.
 *
 *  The caller therefore supplies the resolved config. A reception run's config comes
 *  from the installed dish, never from the visitor, so a config-rooted connection ref IS
 *  static — it just needs the right lookup table.
 *
 *  ⛔ AND THE TABLE IS THE ONE THE RUN READS: the dish OVER the variable defaults
 *  ({@link effectiveConfig}). Reading the dish alone refused a connection the run was
 *  certain to use. */
const resolveConfigPath = (
  config: Record<string, unknown> | undefined,
  path: string,
): unknown => {
  let cur: unknown = config;
  for (const seg of path.split('.')) {
    const rec = asRecord(cur);
    if (rec === undefined) return undefined;
    cur = rec[seg];
  }
  return cur;
};

/** The config a run of this recipe resolves `{{config.*}}` against: the given config
 *  (the dish's) OVER each variable's declared default.
 *
 *  ⛔⛔ WHY THE DEFAULTS. The engine fills every variable the config leaves unset from
 *  its declared default before the first step runs (`execute.ts`, "Populate config from
 *  recipe variables"), so a connection slot whose variable has a literal default is
 *  DECIDED before any dish exists. Resolving against the dish alone refused it as
 *  `dynamic_connection` — and a fresh pack install has no dish yet, so the pack's
 *  webhook door was never minted and every delivery was refused, for a recipe whose run
 *  would have used exactly that connection (found 2026-10-04 with Home Assistant's
 *  `home-assistant` default). The door must be derived from the config the run will
 *  actually use, and this is that config.
 *
 *  ⚠ Layered exactly as the engine does: a key the config sets — even to `null` or
 *  `undefined` — wins over the default, and a null or empty default resolves to nothing,
 *  so the 748-of-933 recipes whose connection setting is blank still refuse until the
 *  owner fills it. */
const effectiveConfig = (
  recipe: RecipeDefinition,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(recipe.variables ?? {})) {
    const fallback = extractVariableDefault(value);
    if (fallback !== undefined) defaults[key] = fallback;
  }
  if (Object.keys(defaults).length === 0) return config;
  return { ...defaults, ...(config ?? {}) };
};

/** Every step across ALL THREE lists. The completeness the whole slice rests on. */
const allSteps = (recipe: RecipeDefinition): ReadonlyArray<Record<string, unknown>> => [
  ...((recipe.prefetch_steps ?? []) as unknown as Record<string, unknown>[]),
  ...((recipe.steps ?? []) as unknown as Record<string, unknown>[]),
  ...((recipe.trigger_steps ?? []) as unknown as Record<string, unknown>[]),
];

/** Derive the complete static capability closure, or refuse the recipe. */
export const deriveRecipeCapability = (
  recipe: RecipeDefinition,
  opts?: {
    /** The RESOLVED install config (the dish's `config_overlay`). The recipe's variable
     *  defaults are layered UNDER it ({@link effectiveConfig}). Absent, with no default
     *  either ⇒ an unconfigured recipe: its `{{config.*}}` connection refuses, which is
     *  correct — an unconfigured recipe cannot back a public door, because which
     *  credential it would reach for is not yet decided. */
    readonly config?: Record<string, unknown>;
    readonly resolveOp?: OpResolver;
  },
): RecipeCapabilityDerivation => {
  const resolveOp = opts?.resolveOp;
  const operations = new Set<string>();
  const ingredients = new Set<string>();
  const connections = new Set<string>();
  const packBound = new Set<string>();
  // op id → the FIRST step that dispatches it. `set`-if-absent, so the attribution names
  // where the op first appears rather than wherever it happened to be seen last.
  const opSteps: Record<string, string> = {};
  const noteOp = (opId: string, stepId: string): void => {
    if (!(opId in opSteps)) opSteps[opId] = stepId;
  };
  const config = effectiveConfig(recipe, asRecord(opts?.config));

  for (const step of allSteps(recipe)) {
    const stepId = isNonEmptyString(step.id) ? step.id : '<unnamed>';

    // ── the dispatch target must be a literal ──────────────────────────────
    for (const field of ['op', 'ingredient'] as const) {
      const value = step[field];
      if (value === undefined) continue;
      if (!isNonEmptyString(value)) continue;
      if (TEMPLATE_RE.test(value)) {
        // `run-ingredient` and friends: the target is chosen at runtime, so no honest
        // closure exists. Refuse at bind rather than fail the visitor at fire.
        return { ok: false, refusal: { reason: 'dynamic_dispatch', step_id: stepId, field } };
      }
    }

    if (isNonEmptyString(step.op)) {
      operations.add(step.op);
      noteOp(step.op, stepId);
    }

    if (isNonEmptyString(step.ingredient)) {
      ingredients.add(step.ingredient);
      const input = asRecord(step.input);
      const operation = input?.operation;
      if (resolveOp && isNonEmptyString(operation) && !TEMPLATE_RE.test(operation)) {
        for (const opId of resolveOp(step.ingredient, operation)) {
          operations.add(opId);
          noteOp(opId, stepId);
        }
      }
    }

    // ── the connection SLOT ────────────────────────────────────────────────
    //
    // `step.connection` is a SLOT, not a connection NAME. Per `steps.ts`: "Never a
    // literal connection name (non-portable in a published canonical recipe — fails
    // closed at validate/resolve). Omitted → THE PACK'S BOUND CONNECTION (composition
    // path), else the recipe's single connection variable. When the recipe declares MORE
    // than one connection variable, every op-step must name its slot."
    //
    // So the connection genuinely lives in the PACK (D-194 `connection_requirements` →
    // enrollment → the pack's bound connection). The recipe carries a slot ONLY to
    // disambiguate when the owner has more than one connection of that vendor. The slot
    // resolves through the install config, which is the dish's `config_overlay`.
    const connection = step.connection;
    if (isNonEmptyString(connection)) {
      if (!TEMPLATE_RE.test(connection)) {
        // A LITERAL connection name is non-portable and already fails closed at
        // validate/resolve. Refuse it here too rather than silently pin a name a
        // published recipe must never carry.
        return {
          ok: false,
          refusal: { reason: 'literal_connection', step_id: stepId, ref: connection },
        };
      }
      const m = CONFIG_REF_RE.exec(connection);
      const resolved = m ? resolveConfigPath(config, m[1]!) : undefined;
      if (isNonEmptyString(resolved) && !TEMPLATE_RE.test(resolved)) {
        connections.add(resolved);
        continue;
      }
      return {
        ok: false,
        refusal: { reason: 'dynamic_connection', step_id: stepId, ref: connection },
      };
    }
    // Connection OMITTED ⇒ the pack's bound connection. That binding is an ENROLLMENT
    // fact, not a recipe fact, so this pure walk cannot see it. The caller completes the
    // connection axis from (op → pack → bound connection); `pack_bound_connection_ops`
    // tells it which ops need that lookup. Under-deriving here would leave the scope's
    // connection axis EMPTY, which `contractScopeMatches` reads as a WILDCARD — the fence
    // would not bite. Reported, never silently skipped.
    if (isNonEmptyString(step.op) || isNonEmptyString(step.ingredient)) {
      packBound.add(isNonEmptyString(step.op) ? step.op : (step.ingredient as string));
    }
  }

  return {
    ok: true,
    capability: {
      // Sorted so the derived scope is STABLE — the upgrade diff (§5.1b) compares this
      // against the stored ContractScope, and an unstable order would look like a
      // capability change on every save and re-prompt the owner for nothing.
      operation_ids: [...operations].sort(),
      ingredient_ids: [...ingredients].sort(),
      connection_names: [...connections].sort(),
      pack_bound_connection_ops: [...packBound].sort(),
      operation_steps: opSteps,
    },
  };
};

/** Derive a door from both representations that participate in one real dispatch.
 *
 * The authored form retains the stable op identity (`core.ai.*`, canonical-convention
 * ops); dispatch lowering retains the concrete catalog/kernel tool and the exact account
 * ref the engine will resolve. Neither representation alone is complete. Union the
 * authority axes, while taking unresolved pack-default diagnostics from the concrete form
 * only (an authored slot-less op may have been resolved successfully). */
export const deriveResolvedRecipeCapability = (
  authoredRecipe: RecipeDefinition,
  dispatchRecipe: RecipeDefinition,
  opts?: Parameters<typeof deriveRecipeCapability>[1],
): RecipeCapabilityDerivation => {
  // The AUTHORED recipe's defaults ride into both derivations: lowering is free to
  // rebuild a recipe, and the dispatch form must resolve the same connection the
  // authored one does, or a door would derive from two different configs.
  const config = effectiveConfig(authoredRecipe, asRecord(opts?.config));
  const resolvedOpts = { ...opts, ...(config === undefined ? {} : { config }) };
  const authored = deriveRecipeCapability(authoredRecipe, resolvedOpts);
  if (!authored.ok) return authored;
  const dispatch = dispatchRecipe === authoredRecipe
    ? authored
    : deriveRecipeCapability(dispatchRecipe, resolvedOpts);
  if (!dispatch.ok) return dispatch;

  const operationSteps: Record<string, string> = { ...authored.capability.operation_steps };
  for (const [opId, stepId] of Object.entries(dispatch.capability.operation_steps)) {
    if (!(opId in operationSteps)) operationSteps[opId] = stepId;
  }
  const dispatchOps = new Set(dispatch.capability.operation_ids);
  const stableAuthoredOps = authored.capability.operation_ids.filter((opId) =>
    dispatchRecipe === authoredRecipe
    || dispatchOps.has(opId)
    // A two-tier id is itself a stable authority identity even when lowering exposes an
    // additional concrete catalog op. A legacy bare canonical (`deal.search`) is only an
    // authoring address; once lowered, the concrete catalog op is the grantable identity.
    || parseOpId(opId) !== null,
  );
  return {
    ok: true,
    capability: {
      operation_ids: [...new Set([
        ...stableAuthoredOps,
        ...dispatch.capability.operation_ids,
      ])].sort(),
      ingredient_ids: [...new Set([
        ...authored.capability.ingredient_ids,
        ...dispatch.capability.ingredient_ids,
      ])].sort(),
      connection_names: [...new Set([
        ...authored.capability.connection_names,
        ...dispatch.capability.connection_names,
      ])].sort(),
      pack_bound_connection_ops: [...dispatch.capability.pack_bound_connection_ops],
      operation_steps: operationSteps,
    },
  };
};

// ════════════════════════════════════════════════════════════════
// The dependency index — the two grant-consent warnings (D-207 §5.1f)
// ════════════════════════════════════════════════════════════════

/** D-207 §5.1f — the reverse index: which installed recipes dispatch a given op.
 *
 *  Backs the OFF-direction warning ("turning this op off will break these recipes"). Its
 *  forward twin — "enabling this recipe will grant these ops" — is
 *  {@link deriveRecipeCapability} itself.
 *
 *  ## Why a WARNING and not a CAP
 *
 *  The tempting fix for `pack.op = off` + `recipe-using-it = on` is to CAP the door's
 *  grants by the owner's. Both ways of doing that are worse than doing nothing:
 *
 *    - cap at ADMISSION → the door contract still SAYS granted (the mint wrote the row),
 *      so the form looks enabled — and then every visitor submission HARD-DENIES at fire
 *      (`op_not_granted` is a deny, not a hold). The owner sees a live form; the visitor
 *      sees a dead one, silently, forever.
 *    - cap at MINT → the door's `granted: true` row persists through a LATER revoke. The
 *      revoke still doesn't revoke, just on a delay.
 *
 *  So the reconciliation belongs at the moment of GRANTING, where the owner can act on
 *  it — not at fire, where only the visitor finds out. Enforcement is unchanged and stays
 *  uniform across door types: an op absent from the door's grant list is a hard deny.
 *  This index does not gate anything. It makes the grant list LEGIBLE.
 *
 *  ## Warn on widening, silent on narrowing
 *
 *  Restricting is always safe (fail-closed), so turning an op OFF or a recipe OFF needs
 *  no consent — only an honest impact list. GRANTING is where consent belongs, which is
 *  why "enable this recipe on a public door" is the direction that must enumerate exactly
 *  what the door will then be able to do.
 *
 *  Pure. Recipes that refuse derivation (dynamic dispatch) contribute nothing and are
 *  reported separately — they can't back a door anyway (§5.1a). */
export interface RecipeOpDependencyIndex {
  /** `operation_id` → the recipe ids that dispatch it. */
  readonly byOp: ReadonlyMap<string, readonly string[]>;
  /** Recipe ids whose capability could not be derived (dynamic dispatch / bad config). */
  readonly underivable: readonly string[];
}

export const buildRecipeOpDependencyIndex = (
  recipes: ReadonlyArray<{ readonly id: string; readonly recipe: RecipeDefinition; readonly config?: Record<string, unknown> }>,
  resolveOp?: OpResolver,
): RecipeOpDependencyIndex => {
  const byOp = new Map<string, string[]>();
  const underivable: string[] = [];
  for (const entry of recipes) {
    const derived = deriveRecipeCapability(entry.recipe, {
      ...(entry.config === undefined ? {} : { config: entry.config }),
      ...(resolveOp === undefined ? {} : { resolveOp }),
    });
    if (!derived.ok) {
      underivable.push(entry.id);
      continue;
    }
    // ⛔⛔ D-247 — THE SAME OP-ID NORMALISATION THE RUNTIME COVERAGE USES, OR THE
    // TWO HALVES OF D11's ROW CONTRADICT EACH OTHER. `operation_ids` records an
    // ingredient step's canonical op only when an `OpResolver` maps it, so a bare
    // kernel step (`ingredient: 'mail-send'`, no `operation`) contributes its SLUG
    // and no op id — while the gate, the coverage predicate and therefore the
    // coverage LEDGER all derive `core.mail.send` from that same slug. Without
    // this the row would read "ran 3× via overdue-invoice-chase" directly above a
    // "still used by" list that does not mention it.
    const opIds = new Set<string>(derived.capability.operation_ids);
    for (const slug of derived.capability.ingredient_ids) {
      const kernelOp = kernelOpForBackingSlug(slug);
      if (kernelOp !== undefined) opIds.add(kernelOp);
    }
    for (const opId of opIds) {
      const list = byOp.get(opId);
      if (list) list.push(entry.id);
      else byOp.set(opId, [entry.id]);
    }
  }
  // Sorted so the warning list is stable between renders.
  for (const list of byOp.values()) list.sort();
  return { byOp, underivable: underivable.sort() };
};
