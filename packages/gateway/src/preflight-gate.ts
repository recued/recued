/** D-157 P1 slice 4 — preflight admission probe + per-call signal raise.
 *
 *  Slice 3 added the engine's pause/resume mechanism — the engine catches
 *  `PreflightRequiredSignal`, snapshots `step.*`, returns
 *  `awaiting_approval`. Slice 4 makes the gateway actually RAISE that
 *  signal on a real `'ask'` verdict at its dispatch boundary.
 *
 *  Two pieces here:
 *
 *   - `evaluatePreflightAdmission` — pure helper that wraps
 *     `lookupPolicy` + `mergePolicyWithContract` + `evaluateToolAdmissibility`
 *     for a single tool call. The host builds an `evaluateAdmission`
 *     closure over a per-run policy + manifest registry and passes it on
 *     `CommitGatewayDeps`; the closure asks this helper for the verdict.
 *
 *   - `raiseOnAsk` — inspect an `AdmissionDecision` and throw
 *     `PreflightRequiredSignal` when `verdict === 'ask'`. The commit
 *     gateway calls this immediately after the depth check, BEFORE
 *     writing any pending commit (an `ask` means the dispatch is paused,
 *     not in flight — there is nothing to record). `'admit'` is the
 *     bare success; `'deny'` falls through to the depth/dispatch path
 *     where it surfaces as a normal gate denial — D-157 's static
 *     pre-run walk (`gateRecipeAgainstPolicy`) catches `'deny'`
 *     verdicts up front, so a per-call `'deny'` here is the rare race
 *     (policy mutated between pre-walk and dispatch) and is treated as
 *     a fatal error rather than a silent pause.
 *
 *  Spec: docs/d-157-spec.md § N.3 / A.2 / I-4 / TR-4. */

import {
  PreflightRequiredSignal,
  admitByOpRisk,
  admitContractToolAccess,
  evaluateScopeRestrictions,
  executionSourceHasContract,
  resolveTrustCeiling,
} from '@recued/contracts';
import type {
  AdmissionDecision,
  ContractSnapshot,
  ExecutionSource,
  IngredientKind,
  RiskTier,
} from '@recued/contracts';

/** The minimum shape `evaluatePreflightAdmission` needs about the
 *  tool being dispatched — slug + the manifest-resolved kind + risk_tier.
 *  Mirrors `ToolUnderEvaluation` from `@recued/contracts` so the host's
 *  closure can pass straight through. */
export interface PreflightTool {
  readonly slug: string;
  readonly kind: IngredientKind;
  readonly risk_tier: RiskTier;
}

/** Evaluate a single tool dispatch against the `(channel × actor ×
 *  contract_id)` policy matrix. Pure — no I/O, no clock; reuses the
 *  `@recued/contracts` policy primitives the static pre-run walk
 *  (`gateRecipeAgainstPolicy`) already uses, so per-call admission stays
 *  in lockstep with the recipe-level admission. The two gates share the
 *  same policy + the same verdict semantics; they differ only in *when*
 *  they fire (pre-run vs. per-call) — necessary because `evaluate*`
 *  cannot see a tool's resolved args at static-walk time, and a per-call
 *  probe is the only point where the gateway can pause before crossing
 *  the boundary.
 *
 *  Contract-scoped actors MUST carry a snapshot — `mergePolicyWithContract`
 *  refines the baseline by the snapshot's `allowed_tools` allowlist. A
 *  contract-scoped source with no snapshot throws (same posture as
 *  `gateRecipeAgainstPolicy`); the host is the producer of both and
 *  resolves the snapshot before dispatch.
 *
 *  D-187 policy-matrix retirement (slice 4) — APPROVAL is now `admitByOpRisk`
 *  (op-risk × stage-trust), NOT the matrix `admitWithPolicyMatrix`. The op-risk is the
 *  tool's `risk_tier` (a simple-form ingredient IS its own op — read→never/admit,
 *  write/admin→ask, destructive→always); the stage-trust ceiling is contract-less
 *  owner/automation `admin` (behavior-preserving) or the contract's trust derived from
 *  the snapshot's `approval_required` (`resolveTrustCeiling`). The outbound-send LIFT
 *  inside `admitByOpRisk` (user_self-scoped) keeps the "every external send surfaces"
 *  promise the matrix `escalateOutboundSend` used to. The catalog gateway remains the
 *  authoritative per-OPERATION gate for catalog-form dispatches (`effective_risk_tier`);
 *  this simple-form probe keys off the manifest `risk_tier` and only RELAXES under
 *  trust, so it can never over-admit a catalog op the gateway would ask for.
 *
 *  M-ENFORCE-2 — `args.scope_path`, when supplied (the host derives it per-call
 *  via `deriveDispatchScope(tool, input)` — the `data.*` / `connection.*` path
 *  the dispatch targets), is gated DIRECTLY against the contract snapshot's
 *  `scope_restrictions` via `evaluateScopeRestrictions`. D-187 slice 5 re-homed the
 *  per-door fence off the retired `policy_matrix` overlay cell onto the unified
 *  `contract_grant` store: the host derives the snapshot's `scope_restrictions` from
 *  the door's `data.<collection>` grant rows, so there is no longer a matrix baseline
 *  cell to merge (the `scan` / `overlay_cell` args are gone). A scope DENY
 *  short-circuits the tool decision — it wins over an otherwise-`'ask'`/`'admit'`
 *  verdict, because a path outside the fence is refused regardless of approval. The
 *  check is pure pass/fail (never `'ask'`); a snapshot with no `scope_restrictions`
 *  (or a contract-free source, which carries no snapshot) admits every path, so
 *  absent / `null` `scope_path` (the kinds that touch no gated scope) is a no-op.
 *  Enforced PER-CALL only: the static pre-run walk can't see a templated
 *  `connection_kind` / resolved scope, so the resolved-args dispatch boundary is the
 *  authoritative (and complete) enforcement point. */
export const evaluatePreflightAdmission = (args: {
  readonly source: ExecutionSource;
  readonly tool: PreflightTool;
  readonly contract_snapshot?: ContractSnapshot;
  readonly scope_path?: string | null;
}): AdmissionDecision => {
  if (executionSourceHasContract(args.source) && !args.contract_snapshot) {
    throw new Error(
      `D-157 P1 evaluatePreflightAdmission: a source carrying a contract_id (actor '${args.source.actor}') requires a ContractSnapshot — the host must resolve it before dispatch.`,
    );
  }
  // M-ENFORCE-2 — scope fence first: a path outside the snapshot's `scope_restrictions`
  // is a hard deny that wins over the tool decision's `'ask'` / `'admit'`. D-187 slice 5:
  // the per-door fence is the contract snapshot's `scope_restrictions` (derived from the
  // door's `data.<collection>` grant rows by the host), so the probe fences directly
  // against it — no matrix baseline to merge. A contract-free source carries no snapshot
  // and is admit-all here. Computed only when a `scope_path` is present.
  if (
    args.scope_path !== undefined
    && args.scope_path !== null
    && args.contract_snapshot
  ) {
    const scopeDecision = evaluateScopeRestrictions(
      args.contract_snapshot.scope_restrictions,
      args.scope_path,
    );
    if (scopeDecision.verdict === 'deny') return scopeDecision;
  }
  // ACCESS — the contracted per-tool allowlist deny (`tool_not_in_contract`), preserved
  // from the matrix's `evaluateToolAdmissibility`. NOT redundant with the op-admission
  // gate: that gate is PERMISSIVE for a wildcard door (its real gate IS this allowlist).
  // Contract-free dispatches carry no snapshot → null → no gate.
  const accessDeny = admitContractToolAccess(args.contract_snapshot, args.tool.slug);
  if (accessDeny) return accessDeny;
  // D-187 slice 4 — APPROVAL = op-risk × stage-trust, replacing the matrix's
  // `admitWithPolicyMatrix` approval verdict. The op-risk is the tool's `risk_tier` (a
  // simple-form ingredient IS its own op); the ceiling is contract-less owner/automation
  // `admin` or the contracted LOW default (`read`) so an AI's writes/admin surface. The
  // outbound-send LIFT inside `admitByOpRisk` (user_self-scoped) keeps the send-approval
  // promise. The matrix's coarse `allowed_kinds` / `allowed_risk_tiers` gate is retired
  // (Layer-1 access + owner/system trust subsume it); its per-door `scope_restrictions`
  // are re-homed onto the snapshot (fenced above).
  return admitByOpRisk({
    slug: args.tool.slug,
    risk_tier: args.tool.risk_tier,
    // D-209 #1 — the snapshot rides along so a door's AUTHORED ceiling (its
    // `max_risk_without_approval`) governs, not the flat contracted default.
    ceiling: resolveTrustCeiling(args.source, args.contract_snapshot),
    source: args.source,
  });
};

/** When `decision.verdict === 'ask'`, throw `PreflightRequiredSignal` —
 *  the engine catches the signal in its step-loop, snapshots `step.*`,
 *  and ends the execution with `awaiting_approval` (I-4 — no held call).
 *  The signal's optional `detail` carries the decision's reason so a
 *  debug log surface (server logs, codex traces) sees *why* the run
 *  paused without depending on it for control flow.
 *
 *  `'admit'` and `'deny'` are no-ops here — `'admit'` is the bare
 *  success path; a per-call `'deny'` is a defense-in-depth surface for
 *  a race the static pre-run walk should have caught (policy mutated
 *  between pre-walk and dispatch) and the host re-raises it as a
 *  normal gate denial. This helper deliberately *only* fires on
 *  `'ask'` — the gateway's single concern at the dispatch boundary. */
export const raiseOnAsk = (
  decision: AdmissionDecision,
  context: {
    slug: string;
    /** D-177 P5a (N.10) — the held call's P1b action identity + resolved-
     *  args wire projection, when the Gateway computed them. Ride the
     *  signal so the host can register the hold as a batch-ask member
     *  (hashes) and render the reviewable item (`args_preview` → summary).
     *  Absent on a non-canonicalizable payload — such a hold is never a
     *  batch member (per-hold ask, exactly pre-P5a). */
    arg_shape_hash?: string;
    canonical_payload_hash?: string;
    args_preview?: Record<string, unknown>;
    /** D-177 P5b (N.11) — the open-projection pinned/varies summary, when
     *  the Gateway's walk classified the held call. Rides the signal as
     *  the host's `grant_mode: 'open'` feasibility marker + the ask body's
     *  rendering lines; absent on a refused walk (the offer stays exact). */
    open_projection_preview?: {
      pinned: ReadonlyArray<{ label: string; value: string }>;
      varying: ReadonlyArray<{ label: string; origin: string }>;
    };
    /** D-202 Slice 1b — mark this ask QUALITY-relevant: the commit Gateway sets
     *  it when the three-conjunct gate's verdict was `quality_not_delegated`
     *  (authorization admitted; only a missing quality delegation held the send).
     *  Rides the signal → `awaiting_approval` → `Checkpoint.quality_relevant` so
     *  the answer-path resumer records the owner's reject-driven quality signal.
     *  Absent on every non-quality ask (behaviour-preserving). */
    quality_relevant?: boolean;
  },
): void => {
  if (decision.verdict !== 'ask') return;
  // Attach the structured `(tool_slug, risk_tier, reason)` trio so the
  // engine — and the host raising the `notification.ask` — see the *why*
  // without parsing the message. The message stays human-readable for
  // log surfaces; structured fields drive the eventual ask body via
  // `ExecutionResult.awaiting_approval` (D-157 § A.2 step 3).
  throw new PreflightRequiredSignal(
    `tool '${context.slug}' requires preflight approval `
      + `(risk_tier='${decision.risk_tier}'): ${decision.detail}`,
    {
      tool_slug: context.slug,
      risk_tier: decision.risk_tier,
      reason: decision.detail,
      // D-165 follow-on (op-identity binding) — the ingredient identity for
      // `Checkpoint.approved_target`. The simple-form gate has no
      // operation / connection axis, so only the slug is captured; the
      // commit-gateway's resume admission stays position+slug-bound.
      ingredient_slug: context.slug,
      ...(context.arg_shape_hash !== undefined
        ? { arg_shape_hash: context.arg_shape_hash }
        : {}),
      ...(context.canonical_payload_hash !== undefined
        ? { canonical_payload_hash: context.canonical_payload_hash }
        : {}),
      ...(context.args_preview !== undefined
        ? { args_preview: context.args_preview }
        : {}),
      ...(context.open_projection_preview !== undefined
        ? { open_projection_preview: context.open_projection_preview }
        : {}),
      // D-202 Slice 1b — forward the quality-relevance marker verbatim. Only
      // attached when the caller flagged it (a `quality_not_delegated` ask);
      // absent otherwise so no signal is recorded on non-quality asks.
      ...(context.quality_relevant !== undefined
        ? { quality_relevant: context.quality_relevant }
        : {}),
    },
  );
};
