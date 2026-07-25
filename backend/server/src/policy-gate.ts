/** D-153 P2.C — Engine-boundary policy gate for the `schedule` channel.
 *
 *  P2.A landed the `(channel × actor)` policy matrix substrate (closed
 *  lists + `lookupPolicy(source)`). P2.B layered pure merge + evaluate
 *  primitives on top (`mergePolicyWithContract` +
 *  `evaluateToolAdmissibility` + scope / approval / rate-limit). P2.C
 *  wires those primitives at the Engine dispatch boundary —
 *  per-channel migration starting with `schedule` per spec phase plan
 *  line 632 ("replaces per-channel handler policies one channel at a
 *  time").
 *
 *  `schedule` is the cleanest first channel: `actor: 'system'`, no
 *  contract complications, minimal blast radius. The scheduler is the
 *  upstream producer of the channel-shaped `ExecutionSource` (cron +
 *  source_recipe); it passes the source through
 *  `ExecuteRequest.execution_source`; the execute-handler resolves the
 *  baseline policy + merges null (no contract for system actors) +
 *  walks the recipe's ingredient steps + calls
 *  `evaluateToolAdmissibility` on each.
 *
 *  Aggregation policy: walk every step (trigger_steps + prefetch_steps
 *  + steps) and collect denials rather than short-circuiting on first.
 *  The caller surfaces the full denial list in one shot so the user
 *  reconciles all policy issues at once rather than fix-then-re-run
 *  whack-a-mole.
 *
 *  Spec: docs/d-153-spec.md § (channel × actor) policy matrix lines
 *  414-445 + § Phase plan sketch (P2.C wiring). */

import type {
  AdmissionDecision,
  ContractSnapshot,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';
import {
  admitByOpRisk,
  admitContractToolAccess,
  executionSourceHasContract,
  resolveTrustCeiling,
} from '@recued/contracts';

/** Recipe phase the denied step lived in. Surfaces in error / audit
 *  output so the user can locate the offending step in their recipe
 *  authoring UI. Closed list — three phases mirror the recipe's
 *  declaration order (`trigger_steps` → `prefetch_steps` → `steps`). */
export const POLICY_GATE_STEP_PHASES = [
  'trigger',
  'prefetch',
  'sequential',
] as const;

/** String-literal union derived from `POLICY_GATE_STEP_PHASES`. */
export type PolicyGateStepPhase = (typeof POLICY_GATE_STEP_PHASES)[number];

/** One step that the gate refused. Carries the step id + ingredient
 *  slug for UI surfacing + the underlying `AdmissionDecision` `deny`
 *  variant so callers don't have to re-discriminate. (An `ask` verdict
 *  — D-157 P1 — is not a refusal and never becomes a `PolicyGateDenial`;
 *  see `gateRecipeAgainstPolicy`.) */
export interface PolicyGateDenial {
  readonly step_id: string;
  readonly ingredient: string;
  readonly phase: PolicyGateStepPhase;
  readonly decision: Extract<AdmissionDecision, { readonly verdict: 'deny' }>;
}

/** Outcome of `gateRecipeAgainstPolicy`. `admit: true` when no
 *  ingredient step was denied; `admit: false` carries the aggregated
 *  denial list. Empty `denials` array iff `admit: true`. A step whose
 *  tool draws an `ask` verdict (D-157 P1 — admissible, preflight-gated)
 *  is not a denial: it does not appear in `denials` and does not flip
 *  `admit`. This static gate clears the recipe to run; the per-call
 *  preflight pause is the gateway's concern (D-157 N.3). */
export interface PolicyGateResult {
  readonly admit: boolean;
  readonly denials: ReadonlyArray<PolicyGateDenial>;
}

/** Walks a recipe's ingredient steps and evaluates each against the
 *  `(channel × actor)` policy matrix for the supplied
 *  `ExecutionSource`. Pure (modulo `manifestGetter`); never mutates
 *  the recipe, source, or snapshot.
 *
 *  Steps walked (in declaration order, in the same order the engine
 *  would execute them):
 *    1. `recipe.trigger_steps` — reactive trigger gate phase (D-115).
 *    2. `recipe.prefetch_steps` — parallel prefetch phase.
 *    3. `recipe.steps` — sequential phase.
 *
 *  Each `IngredientStep` (and `PrefetchStep`, which is structurally
 *  always ingredient-based) is resolved via `manifestGetter` to its
 *  manifest's `kind` + `risk_tier`. `TransformStep` and `GuardStep`
 *  carry no ingredient and are skipped — transforms / guards run pure
 *  in-process and don't cross any policy boundary.
 *
 *  Fail-closed on missing manifest: if `manifestGetter(slug)` returns
 *  `undefined`, the gate emits a deny using `'kind_not_allowed'` as
 *  the closest existing code; the `detail` string documents the
 *  missing-manifest cause. Adding a dedicated deny code is substrate
 *  expansion (P2.B / P2.D) — not in scope for P2.C wiring.
 *
 *  Contract handling (P2.C contract-bearing channels):
 *  - System-actor channels (`schedule` / `reactive` / `housekeeping`)
 *    pass `contractSnapshot = undefined`; the gate runs against the
 *    baseline coarse `(allowed_kinds × allowed_risk_tiers)` matrix
 *    cell. (`webhook` reshaped to an `anonymous` DOOR source in
 *    D-209 #1 W3 — contract-bearing when its trigger row is stamped.)
 *  - A source carrying a `contract_id` (`contracted_user`, or a self-
 *    restricted `user_self` — D-161 N.4) MUST supply a `contractSnapshot`
 *    ("every commit whose ExecutionSource carries a `contract_id` MUST
 *    carry a `contract_snapshot` field"). The gate calls
 *    `mergePolicyWithContract(baseline, snapshot)`; the resulting
 *    `EffectivePolicy` admits via the snapshot's `allowed_tools` per-tool
 *    allowlist (the coarse cell fails closed at the baseline floor —
 *    defense in depth).
 *  - Contract-bearing source + missing snapshot: throws. The producer
 *    is responsible for resolving the snapshot before dispatch (per
 *    spec line 443, the Gateway populates it at dispatch time).
 *
 *  D-187 policy-matrix retirement (slice 4) — each step's APPROVAL is now resolved by
 *  `admitByOpRisk` (op-risk × stage-trust), NOT the `(channel × actor)` matrix. The
 *  trust ceiling is resolved once for the recipe (`resolveTrustCeiling(source,
 *  contractSnapshot)`); the per-step decision keys off the manifest `risk_tier` (the
 *  simple-form op-risk). The static walk still surfaces only `deny` verdicts as
 *  denials — but a simple-form op-risk never resolves `deny`, so in practice this walk
 *  now denies ONLY on a missing manifest (the fail-closed path below). D-187 slice 5
 *  deleted the retired matrix-baseline `scan` + per-step overlay-cell resolver args
 *  (slice 4 had left them unconsumed on the signature). The authoritative ACCESS gate
 *  (op-admission, Layer 1) fires per-call at the gateway, not in this pre-run walk. */
export const gateRecipeAgainstPolicy = (
  recipe: RecipeDefinition,
  source: ExecutionSource,
  manifestGetter: (slug: string) => IngredientManifest | undefined,
  contractSnapshot?: ContractSnapshot,
  resolveConfigRef?: (template: string) => string | undefined,
): PolicyGateResult => {
  // A source carrying a contract_id MUST carry a snapshot at this
  // boundary (D-161 N.4 — covers contracted_user AND a self-restricted
  // user_self). The full contracts substrate (open question #21 — issue
  // / revoke / version-bump / lifecycle UI) is deferred; producers
  // building contract-bearing ExecutionSources stub the snapshot until
  // the real Gateway dispatch resolver lands (spec line 443).
  if (executionSourceHasContract(source) && !contractSnapshot) {
    throw new Error(
      `D-153 P2.C gateRecipeAgainstPolicy: a source carrying a contract_id (actor '${source.actor}') requires a ContractSnapshot — the producer must resolve it before dispatch.`,
    );
  }

  // D-187 policy-matrix retirement (slice 4) — the static walk evaluates each step's
  // APPROVAL via `admitByOpRisk` (op-risk × stage-trust), not the matrix. The ceiling
  // is hoisted once for the whole recipe: contract-less owner/automation `admin`, or the
  // contracted LOW default (`read`, so AI writes surface). NOTE: a simple-form op-risk never
  // resolves `deny` (only `admit` / `ask` — there is no provider `default_policy` on a
  // wrapper/kernel manifest), so this static walk in practice now denies ONLY on a
  // missing manifest (fail-closed below). The authoritative ACCESS gate (op-admission,
  // Layer 1) + the catalog per-op gate fire PER-CALL — a step the matrix used to
  // statically reject (an ungranted contracted tool, a destructive chat op) is now
  // gated at dispatch (`op_not_granted`, or always-ask) rather than pre-run. The matrix
  // baseline + overlay are retired; slice 5 dropped the dead `scan` / overlay-cell args.
  // D-209 #1 — the snapshot rides along so a door's AUTHORED ceiling governs the
  // static walk exactly as it will govern each per-call dispatch.
  const ceiling = resolveTrustCeiling(source, contractSnapshot);

  const denials: PolicyGateDenial[] = [];

  // Resolve `{{config.X}}` ingredient refs against `request.config`
  // when the caller supplied a resolver. Kernel recipes (notably
  // `run-ingredient`, dispatched by every MCP per-ingredient tool)
  // pin the actual ingredient at dispatch time via `config.X`. At gate
  // time both the template and the substituted config value are
  // known, so the gate can evaluate the *real* tool slug rather than
  // failing closed on the literal `'{{config.X}}'` (defense in depth
  // preserved: a `{{config.X}}` ref the resolver can't satisfy falls
  // through to the manifest miss → deny). Refs of other shapes
  // (`{{step.X}}`, `{{shared.X}}`, etc.) can't be known pre-execution
  // and fall through unchanged. */
  const resolveIngredientSlug = (ingredient: string): string => {
    if (!resolveConfigRef) return ingredient;
    if (!ingredient.startsWith('{{') || !ingredient.endsWith('}}')) return ingredient;
    const resolved = resolveConfigRef(ingredient);
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : ingredient;
  };

  const evalIngredientStep = (
    stepId: string,
    ingredient: string,
    phase: PolicyGateStepPhase,
  ): void => {
    const slug = resolveIngredientSlug(ingredient);
    const manifest = manifestGetter(slug);
    if (!manifest) {
      // Defense-in-depth fail-closed. A recipe that references an
      // ingredient not in the registry can't be evaluated for
      // admissibility, and that's the wrong direction to default to
      // "admit". Also catches templated ingredient refs like
      // `'{{config.X}}'` whose `config.X` resolves to a slug the
      // server doesn't have a manifest for — the resolver returned a
      // string but the registry doesn't know it, same posture as a
      // hard-coded unknown slug. `'kind_not_allowed'` is the closest
      // existing deny code; the detail string carries the actual
      // cause for UI surfacing.
      denials.push({
        step_id: stepId,
        ingredient: slug,
        phase,
        decision: Object.freeze({
          verdict: 'deny',
          code: 'kind_not_allowed',
          detail: `ingredient manifest '${slug}' not found in registry — fail-closed (gate cannot evaluate admissibility without the manifest's kind + risk_tier)`,
        }),
      });
      return;
    }
    // ACCESS — the contracted per-tool allowlist deny (`tool_not_in_contract`),
    // preserved from the matrix's `evaluateToolAdmissibility`. NOT redundant with the
    // per-call op-admission gate (which is permissive for a wildcard door — this
    // allowlist is its real gate). Contract-free walks carry no snapshot → no gate.
    const accessDeny = admitContractToolAccess(contractSnapshot, slug);
    if (accessDeny !== null && accessDeny.verdict === 'deny') {
      denials.push({ step_id: stepId, ingredient: slug, phase, decision: accessDeny });
      return;
    }
    // D-187 slice 4 — op-risk × stage-trust approval (replaces the matrix
    // `admitWithPolicyMatrix` approval verdict). The outbound-send LIFT inside
    // `admitByOpRisk` is user_self-scoped; in the static walk an `ask` falls through
    // exactly like an `admit` (only `deny` is a denial — see below), so a lifted send is
    // a no-op here and the static + per-call halves stay in lockstep on the same fn.
    const decision = admitByOpRisk({
      slug,
      risk_tier: manifest.risk_tier,
      ceiling,
      source,
    });
    // D-157 P1 — the decision is tri-state. Only a `deny` verdict is a static-gate
    // denial; an `ask` verdict means the step is admissible but a runtime call will
    // need preflight approval — that pause is the gateway's per-call dispatch concern
    // (D-157 N.3), not this pre-execution recipe walk, so `ask` falls through here
    // exactly like `admit`.
    if (decision.verdict === 'deny') {
      denials.push({ step_id: stepId, ingredient: slug, phase, decision });
    }
  };

  for (const step of recipe.trigger_steps ?? []) {
    if ('ingredient' in step && typeof step.ingredient === 'string') {
      evalIngredientStep(step.id, step.ingredient, 'trigger');
    }
  }

  for (const step of recipe.prefetch_steps ?? []) {
    // D-182 Slice 4 — `prefetch_steps` may carry a `PrefetchOpStep` (a two-tier
    // `op`, no `ingredient`); like the `steps` / `trigger_steps` loops above, only
    // concrete ingredient steps are walked here. An op-step is concretized by the
    // lowering pre-pass before dispatch, and its per-call policy is the gateway's
    // dispatch-time concern — same precedence as a sequential op-step.
    if ('ingredient' in step && typeof step.ingredient === 'string') {
      evalIngredientStep(step.id, step.ingredient, 'prefetch');
    }
  }

  for (const step of recipe.steps ?? []) {
    if ('ingredient' in step && typeof step.ingredient === 'string') {
      evalIngredientStep(step.id, step.ingredient, 'sequential');
    }
  }

  return { admit: denials.length === 0, denials };
};

/** Render the denial list as a single-line summary suitable for the
 *  audit row's `errors[0].message` and the user-facing error response.
 *  Format: `'D-153 policy gate denied N step(s): step_id[/phase]
 *  (code: detail); ...'`. Stable enough for log scraping; readable
 *  enough for UI display. */
export const renderPolicyGateDenialSummary = (
  denials: ReadonlyArray<PolicyGateDenial>,
): string => {
  if (denials.length === 0) {
    return 'D-153 policy gate: admit (no denials)';
  }
  const parts = denials.map(
    (d) =>
      `${d.step_id}/${d.phase} [${d.ingredient}] (${d.decision.code}: ${d.decision.detail})`,
  );
  return `D-153 policy gate denied ${denials.length} step(s): ${parts.join('; ')}`;
};
