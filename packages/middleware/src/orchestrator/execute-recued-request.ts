/** D-145 PB3 — `executeRecuedRequest` orchestrator entry point.
 *
 *  Per § B.1.1 + § B.1.2. The single entry point to the engine.
 *  Validates the inbound request, derives an empty plan, dispatches
 *  primitive calls per the orchestration policy supplied by the
 *  caller, validates composition rules, persists, and returns.
 *
 *  PB3 ships the substrate — the orchestrator accepts an inbound
 *  `OrchestrationPolicy` callback that the caller (PB4 tier router /
 *  PB13 dry-run wrapper) supplies. The policy
 *  callback drives the per-primitive call sequence; PB3 enforces
 *  the cross-cutting invariants (request validation + plan IR
 *  scaffolding + composition rule check + persistence).
 *
 *  This is the seam later phases widen as they bring tier-aware
 *  composition + multi-turn loops + Dry Run + Standing Instructions
 *  on top. PB3 keeps the seam typed +
 *  testable in isolation.
 *
 *  Spec: § B.1.1 + § B.1.2 + § B.5. */

import {
  REDACTED_USER_REQUEST_MARKER,
  appendCapacityCheck,
  appendIncludedContext,
  appendOmittedItem,
  appendPrimitiveCall,
  appendProvenanceLink,
  appendTransparencyEvent,
  appendExtractionEvent,
  assertValidRecuedPlan,
  assertValidRecuedRequest,
  type AuditPolicy,
  type CapacityCheck,
  type ContextItem,
  type ExtractionEvent,
  type FailureClass,
  type ModelTier,
  type OmittedItem,
  type PlanStatus,
  type PrimitiveCall,
  type ProvenanceLink,
  type RecuedPlan,
  type RecuedRequest,
  type RecuedPrimitive,
  type TransparencyEventEnvelope,
} from '@recued/contracts';

import {
  CompositionRuleError,
  assertValidComposition,
  preCheckBridgeDispatchAllowed,
  type CompositionRuleViolation,
} from './composition-rules.js';

import type {
  PrimitiveExecuteContext,
  PrimitiveExecuteResult,
} from '../primitives/types.js';
import type {
  PrimitiveIOMap,
  PrimitiveRegistry,
} from '../primitives/registry.js';

// ── PlanDraft — mutable shape the policy assembles into a RecuedPlan ─

/** Mutable draft the policy assembles. The orchestrator wraps every
 *  primitive call so the draft stays consistent with the policy's
 *  decisions. */
export interface PlanDraft {
  plan: RecuedPlan;
  /** Append a `PrimitiveCall` row + the typed result; returns the
   *  result so the policy can chain. The wrapper enforces composition
   *  rules incrementally — each append re-checks the per-call
   *  invariants. PB7 widens the per-call hooks. */
  invoke<K extends RecuedPrimitive>(
    primitive: K,
    input: PrimitiveIOMap[K]['in'],
    ctx?: Partial<PrimitiveExecuteContext>,
  ): Promise<PrimitiveExecuteResult<PrimitiveIOMap[K]['out']>>;
  /** Append a capacity check directly (e.g. when the policy wants to
   *  record a synthesized check without re-running the walker). */
  recordCapacityCheck(check: CapacityCheck): void;
  /** Append an included-context item. */
  includeContext(item: ContextItem): void;
  /** Append an omitted-context entry. */
  omitContext(item: OmittedItem): void;
  /** Append a transparency event envelope. */
  recordTransparencyEvent(event: TransparencyEventEnvelope): void;
  /** Append a user-facing extraction event. */
  recordExtractionEvent(event: ExtractionEvent): void;
  /** Append a provenance link row. */
  recordProvenanceLink(link: ProvenanceLink): void;
  /** Read-only snapshot of the current plan. Useful for policy
   *  decisions that depend on prior call results. */
  snapshot(): RecuedPlan;
}

// ── OrchestrationPolicy — per-request callback ──────────────────────

/** The policy callback drives the primitive sequence per the
 *  orchestration mode (default / multi-turn / dry-run).
 *  PB4 wires the tier inference. PB3 ships the typed seam.
 *
 *  Returns the final fields the orchestrator stamps on the plan
 *  (status, failure_class, user_response, completed_at). The
 *  orchestrator validates the result + applies privacy policy
 *  (redact_user_request stamping).
 *
 *  When the policy THROWS (an unexpected fault, not a planned halt),
 *  the orchestrator maps it to a last-resort status —
 *  `cancelled_capacity_gap` for a `CompositionRuleError`, else
 *  `cancelled_malformed_ai` — and surfaces the error. Expected halts
 *  are the policy's job: it returns the rich PB15 failure taxonomy
 *  via `composeFailureResult`. */
export interface OrchestrationPolicyResult {
  status: PlanStatus;
  failure_class?: FailureClass;
  user_response: string;
}

export type OrchestrationPolicy = (draft: PlanDraft) => Promise<OrchestrationPolicyResult>;

// ── ExecuteRecuedRequestContext — injected dep bundle ───────────────

export interface ExecuteRecuedRequestContext {
  registry: PrimitiveRegistry;
  /** Caller-supplied policy. PB4 / PB13 wire production
   *  policies; PC3 fixtures + tests pass mocks. */
  policy: OrchestrationPolicy;
  /** Persists the final RecuedPlan. PB3 keeps this caller-supplied
   *  so the substrate stays decoupled from the storage layer. PB13
   *  composer wires `createSigningRecuedPlanStore` from
   *  `backend/server/src/recued-plan/`. */
  persist?: (plan: RecuedPlan) => Promise<void>;
  /** Default tier when the policy doesn't override + the request
   *  doesn't carry `model_hint`. */
  default_tier?: ModelTier;
  /** Default AI provider+model id stamped on the plan when the policy
   *  doesn't run any `ai.synthesize` calls. PB4 widens. */
  default_ai_provider?: string;
  default_ai_model_id?: string;
  /** Substrate-default audit policy. The orchestrator merges this
   *  with `request.audit_policy`. */
  default_audit_policy?: AuditPolicy;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: () => number;
  /** Injectable for tests; defaults to `crypto.randomUUID()`. */
  mint_id?: () => string;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_AUDIT_POLICY: AuditPolicy = {
  retain_for_days: 90,
  high_assurance: false,
  redact_user_request: false,
};

const defaultNow = (): number => Date.now();

const mintRandomId = (): string => {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof g?.randomUUID === 'function') return g.randomUUID();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const buildEmptyPlan = (
  request: RecuedRequest,
  defaults: {
    started_at: number;
    audit_policy: AuditPolicy;
    tier: ModelTier;
    provider: string;
    model_id: string;
  },
): RecuedPlan => {
  const goal_id = request.goal_id ?? request.request_id;
  const user_request = defaults.audit_policy.redact_user_request
    ? REDACTED_USER_REQUEST_MARKER
    : request.user_request;
  return {
    plan_id: request.request_id,
    goal_id,
    user_request,
    considered_sources: [],
    capacity_checks: [],
    included_context: [],
    omitted_context: [],
    selection_trace: {
      recipe_candidates_considered: 0,
      recipe_candidates_selected: [],
      recipe_candidates_dropped: [],
      commitment_context_pulled: false,
      commitment_rows_count: 0,
      // D-164 P6.7 — catalog-assembly snapshot defaults; callers
      // leave the catalog empty until a prompt-cache/catalog consumer
      // wires this surface end-to-end.
      catalog_section_counts: {},
      catalog_short_circuited: false,
    },
    model_tier: defaults.tier,
    ai_provider: defaults.provider,
    ai_model_id: defaults.model_id,
    primitive_calls: [],
    status: 'completed', // overwritten by policy result
    user_visible_internal_steps: [],
    user_response: '',
    user_events: [],
    provenance_links: [],
    audit_policy: defaults.audit_policy,
    started_at: defaults.started_at,
    completed_at: defaults.started_at, // overwritten at finalize
  };
};

const mergeAuditPolicy = (
  fallback: AuditPolicy,
  override: Partial<AuditPolicy> | undefined,
): AuditPolicy => ({
  retain_for_days: override?.retain_for_days ?? fallback.retain_for_days,
  high_assurance: override?.high_assurance ?? fallback.high_assurance,
  redact_user_request: override?.redact_user_request ?? fallback.redact_user_request,
});

// ── Orchestrator ────────────────────────────────────────────────────

/** § B.1.1 — engine entry point. PB3 substrate ships the orchestrator
 *  scaffolding + composition rule enforcement + persistence wiring;
 *  the per-tier flow is supplied by the caller's
 *  `OrchestrationPolicy`.
 *
 *  Throws `RecuedRequestValidationError` on malformed input.
 *  Wraps the policy in a try/catch so an unexpected policy throw maps
 *  to a last-resort status (`cancelled_capacity_gap` for a
 *  `CompositionRuleError`, else `cancelled_malformed_ai`). The rich
 *  PB15 failure taxonomy (§ B.15.11) is applied by the policy itself
 *  via `composeFailureResult` for expected halts.
 *
 *  Always returns a validated `RecuedPlan` (or throws if the policy's
 *  result violates `assertValidRecuedPlan` or composition rules). The
 *  caller-supplied `persist` is invoked only AFTER all validations
 *  pass — partial / malformed plans never persist. */
export const executeRecuedRequest = async (
  request: RecuedRequest,
  ctx: ExecuteRecuedRequestContext,
): Promise<RecuedPlan> => {
  assertValidRecuedRequest(request);

  const now = ctx.now ?? defaultNow;
  const mintId = ctx.mint_id ?? mintRandomId;
  const started_at = request.received_at ?? now();
  const audit_policy = mergeAuditPolicy(
    ctx.default_audit_policy ?? DEFAULT_AUDIT_POLICY,
    request.audit_policy,
  );
  const tier = request.model_hint ?? ctx.default_tier ?? 'fast';
  const provider = ctx.default_ai_provider ?? '';
  const model_id = ctx.default_ai_model_id ?? '';

  let plan = buildEmptyPlan(request, {
    started_at,
    audit_policy,
    tier,
    provider,
    model_id,
  });

  const baseExecuteCtx: PrimitiveExecuteContext = {
    run_id: request.request_id,
    ...(request.preview ? { preview: true } : {}),
    now,
    mint_call_id: mintId,
  };

  // PlanDraft seam — every mutation flows through this so the orchestrator
  // can incrementally validate composition + apply per-call hooks (PB7
  // widens).
  const draft: PlanDraft = {
    plan,
    async invoke<K extends RecuedPrimitive>(
      primitive: K,
      input: PrimitiveIOMap[K]['in'],
      partialCtx?: Partial<PrimitiveExecuteContext>,
    ): Promise<PrimitiveExecuteResult<PrimitiveIOMap[K]['out']>> {
      const primitiveImpl = ctx.registry.get(primitive);
      // Codex P1 fold (Dry Run threading): make `preview` STICKY when
      // the request was previewed. Policy override of `preview: false`
      // mid-flight would re-enable adapter side effects — defeats the
      // entire Dry Run discipline of § B.5.4. Compute preview as
      // (request.preview || partial.preview).
      const partialCtxNoPreview = partialCtx
        ? Object.fromEntries(
            Object.entries(partialCtx).filter(([k]) => k !== 'preview'),
          )
        : {};
      const previewSticky =
        baseExecuteCtx.preview === true || partialCtx?.preview === true;
      const mergedCtx: PrimitiveExecuteContext = {
        ...baseExecuteCtx,
        ...partialCtxNoPreview,
        ...(previewSticky ? { preview: true } : {}),
      };

      // Codex P1 fold (composition rule #6): pre-execution gate for
      // bridge.dispatch — refuse to invoke the adapter when no
      // matching capacity_spec ok exists. Without this check the DOM
      // command actuates first and the validator catches the
      // violation only at finalization (after the side effect).
      if (primitive === 'bridge.dispatch') {
        const violation = preCheckBridgeDispatchAllowed(
          plan.primitive_calls,
          mergedCtx.intent_id,
        );
        if (violation) throw new CompositionRuleError([violation]);
      }

      const result = await primitiveImpl.execute(input, mergedCtx);
      plan = appendPrimitiveCall(plan, result.call);
      // capacity_spec rows feed plan.capacity_checks[] for the
      // selection_trace + audit replay.
      if (primitive === 'capacity_spec') {
        const out = result.result as PrimitiveIOMap['capacity_spec']['out'];
        for (const check of out.checks) {
          plan = appendCapacityCheck(plan, check);
        }
      }
      // Re-sync the draft's plan reference after every append so the
      // policy's `snapshot()` call returns the freshest plan.
      draft.plan = plan;
      return result;
    },
    recordCapacityCheck(check: CapacityCheck): void {
      plan = appendCapacityCheck(plan, check);
      draft.plan = plan;
    },
    includeContext(item: ContextItem): void {
      plan = appendIncludedContext(plan, item);
      draft.plan = plan;
    },
    omitContext(item: OmittedItem): void {
      plan = appendOmittedItem(plan, item);
      draft.plan = plan;
    },
    recordTransparencyEvent(event: TransparencyEventEnvelope): void {
      plan = appendTransparencyEvent(plan, event);
      draft.plan = plan;
    },
    recordExtractionEvent(event: ExtractionEvent): void {
      plan = appendExtractionEvent(plan, event);
      draft.plan = plan;
    },
    recordProvenanceLink(link: ProvenanceLink): void {
      plan = appendProvenanceLink(plan, link);
      draft.plan = plan;
    },
    snapshot(): RecuedPlan {
      return plan;
    },
  };

  let policyResult: OrchestrationPolicyResult;
  try {
    policyResult = await ctx.policy(draft);
  } catch (e) {
    const completedAt = now();
    // Codex P1 fold (composition rule #6 + privacy): when the policy
    // failed because draft.invoke pre-checked a composition rule
    // (e.g. bridge.dispatch without a matching capacity_spec ok),
    // surface as a capacity failure rather than the generic
    // synthesis catch-all. Otherwise route through the synthesis
    // failure with a sanitized error class — never raw e.message
    // (Codex P1 #3 — privacy contracts on every persisted RecuedPlan
    // field, § B.2.3).
    const isComposition = e instanceof CompositionRuleError;
    const errorClass = isComposition
      ? 'composition_rule_violation'
      : e instanceof Error
        ? e.constructor.name
        : 'unknown_error';
    plan = {
      ...plan,
      status: isComposition ? 'cancelled_capacity_gap' : 'cancelled_malformed_ai',
      failure_class: isComposition ? 'capacity' : 'synthesis',
      user_response: isComposition
        ? `Engine halted because a required prerequisite was not met (${errorClass}).`
        : `Engine halted while processing the request (${errorClass}).`,
      completed_at: completedAt < started_at ? started_at : completedAt,
    };
    // We refuse to persist policy-throw plans without composition
    // checks first — broken policy outputs go to /dev/null. The
    // caller sees the throw via the returned plan's status.
    assertValidRecuedPlan(plan);
    return plan;
  }

  const completedAt = now();

  // PB13 — preview status auto-stamping per § B.5.4 rule 1.
  //
  //   The substrate invariant is bidirectional:
  //     plan.status === 'preview_no_op'  ⇔  request.preview === true
  //                                          (and no failure halted)
  //
  //   Forward direction (Self-review P1 fold — pre-Codex):
  //     When request.preview === true AND policy returned 'completed',
  //     the orchestrator rewrites plan.status to 'preview_no_op' +
  //     drops failure_class. Prevents a buggy/compromised policy from
  //     masking a Dry Run as a real commit on the audit trail.
  //     Cancelled statuses flow through unchanged — preview can
  //     legitimately halt for substrate-enforced reasons (capacity
  //     gap, SI conflict, privacy hard-fail, cost ceiling, malformed
  //     AI).
  //
  //   Reverse direction (Self-review P1 fold — pre-Codex):
  //     When request.preview !== true AND policy returned
  //     'preview_no_op', the orchestrator rejects the plan as
  //     malformed. A commit-mode policy that claims preview_no_op
  //     would lie to the audit trail — adapters were actually
  //     invoked (no per-call preview gate fired) but the plan
  //     records "no side effects". The substrate refuses to persist
  //     this contradiction; the rejection surfaces through the
  //     existing assertValidRecuedPlan path so callers see the
  //     structured RecuedPlanValidationError shape.
  const isPreviewRequest = request.preview === true;
  if (!isPreviewRequest && policyResult.status === 'preview_no_op') {
    throw new RecuedPlanStatusMismatchError(
      'policy returned preview_no_op without request.preview=true',
      {
        policy_status: policyResult.status,
        request_preview: request.preview === undefined ? null : request.preview,
      },
    );
  }
  const finalStatus: PlanStatus =
    isPreviewRequest && policyResult.status === 'completed'
      ? 'preview_no_op'
      : policyResult.status;
  const finalFailureClass: FailureClass | undefined =
    finalStatus === 'preview_no_op' || finalStatus === 'completed'
      ? undefined
      : policyResult.failure_class;

  plan = {
    ...plan,
    status: finalStatus,
    user_response: policyResult.user_response,
    completed_at: completedAt < started_at ? started_at : completedAt,
    ...(finalFailureClass !== undefined
      ? { failure_class: finalFailureClass }
      : {}),
  };

  // Composition rule check happens BEFORE plan validator so the
  // "wrong primitive sequence" path surfaces with a more specific
  // error message than the generic `RecuedPlanValidationError`.
  assertValidComposition(plan.primitive_calls);

  // Plan validator runs LAST — substrate-level invariant that
  // catches anything the policy did wrong on the structured fields
  // (omitted_context content_stored, persist_policy mismatches,
  // status/failure_class pairing, etc.).
  assertValidRecuedPlan(plan);

  if (ctx.persist) await ctx.persist(plan);
  return plan;
};

// ── PB13 self-review P1 fold — preview-status invariant guard ───────

/** Thrown when the policy returns `preview_no_op` for a request that
 *  was NOT submitted with `preview: true`. Substrate guard against the
 *  inverse-of-auto-stamping path: a commit-mode policy that claims
 *  preview_no_op would lie to the audit trail — adapters were actually
 *  invoked but the plan records "no side effects".
 *
 *  The orchestrator throws this error BEFORE persisting; the caller
 *  sees the structured `meta` with the rejected `policy_status` +
 *  observed `request_preview` value. Closed-shape `meta` keeps the
 *  error privacy-clean (no user content). */
export class RecuedPlanStatusMismatchError extends Error {
  readonly code = 'RECUED_PLAN_STATUS_MISMATCH' as const;
  readonly meta: {
    readonly policy_status: string;
    readonly request_preview: boolean | null;
  };
  constructor(
    message: string,
    meta: { policy_status: string; request_preview: boolean | null },
  ) {
    super(message);
    this.name = 'RecuedPlanStatusMismatchError';
    this.meta = meta;
  }
}

// ── Re-exports for ergonomic imports ────────────────────────────────

export type {
  CompositionRuleViolation,
};
export { CompositionRuleError };
