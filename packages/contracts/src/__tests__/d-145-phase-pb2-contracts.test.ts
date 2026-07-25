/** D-145 PB2 — RecuedPlan IR contracts surface tests.
 *
 *  Covers § B.5 closed lists + builder helpers + runtime validator +
 *  `ContentStoredFalse` literal + redact-user-request shape. */

import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_INTENT_KINDS,
  CONTEXT_BREADTHS,
  CONTEXT_CLASS_PERSIST_POLICIES,
  CONTEXT_CONTENT_CLASSES,
  CONTEXT_PERSIST_POLICIES,
  FAILURE_CLASSES,
  MODEL_TIERS,
  NARROWING_REASON_CODES,
  OMISSION_REASON_CODES,
  PLAN_STATUSES,
  PRIMITIVE_CALL_STATUSES,
  RECUED_PLAN_MEMORY_KIND,
  RECUED_PLAN_VALIDATION_ISSUE_KINDS,
  RECUED_PRIMITIVES,
  REDACTED_USER_REQUEST_MARKER,
  RecuedPlanValidationError,
  appendCapacityCheck,
  appendExtractionEvent,
  appendIncludedContext,
  appendOmittedItem,
  appendPrimitiveCall,
  appendProvenanceLink,
  appendTransparencyEvent,
  assertValidRecuedPlan,
  redactUserRequest,
  stripPlanSignatureFields,
  validateRecuedPlan,
  type CapacityCheck,
  type ContextItem,
  type OmittedItem,
  type PrimitiveCall,
  type RecuedPlan,
} from '../index.js';

// ─── Fixture builders ────────────────────────────────────────────────

import type {
  ContextSelectionTrace,
} from '../index.js';

const baseSelectionTrace = (): ContextSelectionTrace => ({
  recipe_candidates_considered: 0,
  recipe_candidates_selected: [],
  recipe_candidates_dropped: [],
  commitment_context_pulled: false,
  commitment_rows_count: 0,
  catalog_section_counts: {},
  catalog_short_circuited: false,
});

const buildBasePlan = (overrides: Partial<RecuedPlan> = {}): RecuedPlan => ({
  plan_id: 'plan-001',
  goal_id: 'goal-001',
  user_request: 'what did I commit to last week?',
  considered_sources: [],
  capacity_checks: [],
  included_context: [],
  omitted_context: [],
  selection_trace: baseSelectionTrace(),
  model_tier: 'fast',
  ai_provider: 'anthropic',
  ai_model_id: 'claude-haiku-4-5',
  primitive_calls: [],
  status: 'completed',
  user_visible_internal_steps: [],
  user_response: 'Found 3 commitments from last week.',
  user_events: [],
  provenance_links: [],
  audit_policy: {
    retain_for_days: 90,
    high_assurance: false,
    redact_user_request: false,
  },
  started_at: 1_736_000_000_000,
  completed_at: 1_736_000_001_000,
  ...overrides,
});

// ─── § N.1 — Closed-list ratchets ────────────────────────────────────

describe('D-145 PB2 — § N.1 RecuedPrimitive closed list (10 values)', () => {
  it('contains exactly the 10 PB1 primitives in spec order', () => {
    expect(RECUED_PRIMITIVES).toEqual([
      'capacity_spec',
      'data.fetch',
      'memory.recall',
      'memory.write',
      'enrichment.lookup',
      'ai.synthesize',
      'bridge.dispatch',
      'recipe.invoke',
      'approval.request',
      'provenance.link',
    ]);
    expect(RECUED_PRIMITIVES.length).toBe(10);
  });
});

describe('D-145 PB2 — § N.2 PrimitiveCallStatus (8 values)', () => {
  it('contains exactly the 8 closed-list statuses', () => {
    expect(PRIMITIVE_CALL_STATUSES).toEqual([
      'ok',
      'ok_partial',
      'capacity_gap',
      'capacity_gap_mid_run',
      'error',
      'cancelled',
      'timeout',
      'preview_no_op',
    ]);
  });
});

describe('D-145 PB2 — § N.3 OmissionReasonCode (8 values)', () => {
  it('contains exactly the 8 closed-list reason codes', () => {
    expect(OMISSION_REASON_CODES).toEqual([
      'privacy_class',
      'token_budget',
      'permission_scope',
      'recency_filter',
      'hallucination_risk',
      'cost_tier',
      'capacity_gap',
      'duplication',
    ]);
  });
});

describe('D-145 PB2 — § N.4 ContextContentClass (14 values)', () => {
  it('contains exactly the 14 closed-list classes per § B.2.3', () => {
    expect(CONTEXT_CONTENT_CLASSES).toHaveLength(14);
    expect(CONTEXT_CONTENT_CLASSES).toContain('social_raw_body');
    expect(CONTEXT_CONTENT_CLASSES).toContain('standing_instruction');
    expect(CONTEXT_CONTENT_CLASSES).toContain('contact_alias');
  });

  it('every class has a CONTEXT_CLASS_PERSIST_POLICIES registry entry', () => {
    for (const c of CONTEXT_CONTENT_CLASSES) {
      const allowed = CONTEXT_CLASS_PERSIST_POLICIES[c];
      expect(allowed).toBeDefined();
      expect(allowed.length).toBeGreaterThan(0);
    }
  });

  it("'social_raw_body' admits ONLY 'immediate_use_only' (hard privacy gate)", () => {
    expect(CONTEXT_CLASS_PERSIST_POLICIES.social_raw_body).toEqual([
      'immediate_use_only',
    ]);
  });

  it("'standing_instruction' rejects 'persist' (AI packets route through redaction)", () => {
    const allowed = CONTEXT_CLASS_PERSIST_POLICIES.standing_instruction;
    expect(allowed).not.toContain('persist');
    expect(allowed).toContain('redacted_only');
  });

  it("'contact_alias' rejects 'persist' (AI packets route through redaction)", () => {
    const allowed = CONTEXT_CLASS_PERSIST_POLICIES.contact_alias;
    expect(allowed).not.toContain('persist');
    expect(allowed).toContain('redacted_only');
  });
});

describe('D-145 PB2 — § N.4 ContextPersistPolicy (3 values)', () => {
  it('contains exactly the 3 closed-list policies', () => {
    expect(CONTEXT_PERSIST_POLICIES).toEqual([
      'persist',
      'immediate_use_only',
      'redacted_only',
    ]);
  });
});

describe('D-145 PB2 — § N.5 PlanStatus + FailureClass closed lists', () => {
  it('PLAN_STATUSES has 9 entries in spec order', () => {
    expect(PLAN_STATUSES).toEqual([
      'completed',
      'cancelled_by_user',
      'cancelled_capacity_gap',
      'cancelled_si_conflict',
      'cancelled_no_alternative',
      'cancelled_privacy_violation',
      'cancelled_cost_ceiling',
      'cancelled_malformed_ai',
      'preview_no_op',
    ]);
  });

  it('FAILURE_CLASSES has 7 entries in spec order', () => {
    expect(FAILURE_CLASSES).toEqual([
      'retrieval',
      'omission',
      'synthesis',
      'legibility',
      'capacity',
      'privacy',
      'cost',
    ]);
  });
});

describe('D-145 PB2 — § N.6 ContextSelectionTrace closed lists', () => {
  it('NARROWING_REASON_CODES has 9 entries (D-164 P6b/c retired state_filter; PB2 6 + D-137 P1.3 § A.6.1 widening of 3)', () => {
    expect(NARROWING_REASON_CODES).toHaveLength(9);
    expect(NARROWING_REASON_CODES).toEqual([
      'topic_mismatch',
      'intent_kind_incompatible',
      'low_confidence',
      'cap_exceeded',
      'standing_instruction',
      'privacy_class',
      // D-137 P1.3 § A.6.1 — `filter-tools` per-tier reasons.
      'tier3_disabled',
      'intent_kind_gate',
      'kind_gated',
    ]);
  });

  it('CLASSIFICATION_INTENT_KINDS has 5 entries (Stage 1; D-164 P6b/c retired cognition_create + cognition_update)', () => {
    expect(CLASSIFICATION_INTENT_KINDS).toEqual([
      'commitment_extract',
      'task_extract',
      'recipe_action',
      'query',
      'chat_only',
    ]);
  });

  it('CONTEXT_BREADTHS is exactly narrow + wide', () => {
    expect(CONTEXT_BREADTHS).toEqual(['narrow', 'wide']);
  });
});

describe('D-145 PB2 — § N.9 ModelTier (3 values)', () => {
  it('contains exactly fast / mid / reasoning', () => {
    expect(MODEL_TIERS).toEqual(['fast', 'mid', 'reasoning']);
  });
});

describe('D-145 PB2 — § N.11 RECUED_PLAN_MEMORY_KIND', () => {
  it("locks the memory entry kind to the literal 'recued_plan'", () => {
    expect(RECUED_PLAN_MEMORY_KIND).toBe('recued_plan');
  });
});

describe('D-145 PB2 — § N.12 RecuedPlanValidationIssueKind closed list', () => {
  it('has exactly 20 issue kinds (D-145 Item 1 single-stage collapse dropped primitive_stage_misuse)', () => {
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).toHaveLength(20);
    // D-145 Item 1 — the stage discriminator + its misuse guard retired
    // with the single-stage collapse of ai.synthesize.
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).not.toContain(
      'primitive_stage_misuse' as never,
    );
    // PB6 fold (Codex P2 #3) — re-runs validateExtractionEvent over
    // every plan.user_events row at validateRecuedPlan time so off-list
    // / parsed-JSON / mutated rows never pass the persistence guard.
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).toContain('invalid_user_event');
    // PB7 — same pattern for user_visible_internal_steps. Round-trip
    // integrity check on the wire envelope.
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).toContain('invalid_internal_step');
    // D-164 P6.7 — catalog-assembly snapshot finite-count gate.
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).toContain(
      'invalid_catalog_section_count',
    );
    // D-164 P6.7 — retired alongside the Stage 1 substrate.
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).not.toContain(
      'unknown_intent_kind' as never,
    );
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).not.toContain(
      'unknown_context_breadth' as never,
    );
  });
});

// ─── § B.5.2 — content_stored compile-time invariant ────────────────

describe('D-145 PB2 — § B.5.2 ContentStoredFalse compile-time invariant', () => {
  it('OmittedItem accepts content_stored: false', () => {
    const item: OmittedItem = {
      source_ref: 'data.contact.x.body_inline',
      reason_code: 'privacy_class',
      content_stored: false,
    };
    expect(item.content_stored).toBe(false);
  });

  // Compile-time rejection: the `OmittedItem({ content_stored: true })`
  // synthetic violation lives in the README + is asserted by the
  // lint ratchet at write time. The runtime validator below catches
  // any cast workaround that escapes the type checker.
  it('runtime validator catches `as unknown as OmittedItem` workarounds', () => {
    const violation = {
      source_ref: 'data.contact.x.body_inline',
      reason_code: 'privacy_class',
      content_stored: true, // synthetic violation — bypasses tsc
    } as unknown as OmittedItem;

    const plan = buildBasePlan({ omitted_context: [violation] });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'omitted_item_content_stored_not_false'),
    ).toBeDefined();
  });
});

// ─── § N.12 — Runtime validator ──────────────────────────────────────

describe('D-145 PB2 — runtime validator surface', () => {
  it('a valid baseline plan produces zero issues', () => {
    const plan = buildBasePlan();
    expect(validateRecuedPlan(plan)).toEqual([]);
  });

  it('rejects unknown PlanStatus', () => {
    const plan = buildBasePlan();
    (plan as { status: string }).status = 'definitely_not_a_status';
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'unknown_status')).toBeDefined();
  });

  it('rejects unknown ModelTier', () => {
    const plan = buildBasePlan();
    (plan as { model_tier: string }).model_tier = 'overdrive';
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'unknown_model_tier')).toBeDefined();
  });

  it('rejects unknown FailureClass when supplied', () => {
    const plan = buildBasePlan({
      status: 'cancelled_capacity_gap',
      failure_class: 'totally_invented' as never,
    });
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'unknown_failure_class')).toBeDefined();
  });

  it('requires failure_class when status != completed/preview_no_op', () => {
    const plan = buildBasePlan({ status: 'cancelled_by_user' });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'failure_class_required_when_not_completed'),
    ).toBeDefined();
  });

  it('forbids failure_class when status === completed', () => {
    const plan = buildBasePlan({ failure_class: 'cost' });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'failure_class_forbidden_when_completed'),
    ).toBeDefined();
  });

  it('preview_no_op behaves like completed (no failure_class)', () => {
    const plan = buildBasePlan({ status: 'preview_no_op' });
    expect(validateRecuedPlan(plan)).toEqual([]);
  });

  // ── PB6 fold (Codex P2 #3) — user_events runtime validation ─────
  it('PB6 — flags off-list user_events kind via invalid_user_event', () => {
    const plan = buildBasePlan({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user_events: [{ kind: 'extraction.weird', confidence: 0.9, args: {} } as any],
    });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find(
        (i) => i.kind === 'invalid_user_event' && i.path === 'user_events[0]',
      ),
    ).toBeDefined();
  });

  it('PB6 — flags out-of-range confidence on user_events', () => {
    const plan = buildBasePlan({
      user_events: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { kind: 'extraction.commitment', confidence: 1.5, args: {} } as any,
      ],
    });
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'invalid_user_event')).toBeDefined();
  });

  it('PB6 — flags PB2 open-envelope leftover (no confidence)', () => {
    // Synthetic violation: a parsed-JSON plan from before PB6 narrowed
    // the type. Without the new iteration, this would silently pass
    // the persistence guard.
    const plan = buildBasePlan({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user_events: [{ kind: 'extraction.detected', payload: {} } as any],
    });
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'invalid_user_event')).toBeDefined();
  });

  it('PB6 — null entry in user_events does NOT throw the validator', () => {
    const plan = buildBasePlan({
      user_events: [null as never],
    });
    expect(() => validateRecuedPlan(plan)).not.toThrow();
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'invalid_user_event')).toBeDefined();
  });

  it('PB6 — valid user_events entry produces zero invalid_user_event issues', () => {
    const plan = buildBasePlan({
      user_events: [
        {
          kind: 'extraction.commitment',
          confidence: 0.92,
          args: { text: 'send report Friday' },
        },
        {
          kind: 'resolution.alias',
          confidence: 0.99,
          args: { alias: 'mom', contact_id: 'contact-001' },
        },
      ],
    });
    const issues = validateRecuedPlan(plan);
    expect(issues.filter((i) => i.kind === 'invalid_user_event')).toEqual([]);
  });

  it('PB7 Codex P2 fold — flags invalid envelope.redaction', () => {
    const plan = buildBasePlan({
      user_visible_internal_steps: [
        {
          event: {
            kind: 'extraction.saved',
            entity_kind: 'commitment',
            entity_id: 'c_1',
            confidence: 0.9,
          },
          redaction: 'bogus',
          emitted_at: 1_736_000_000_500,
        } as never,
      ],
    });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.some(
        (i) =>
          i.kind === 'invalid_internal_step' &&
          i.path === 'user_visible_internal_steps[0].redaction',
      ),
    ).toBe(true);
  });

  it('PB7 Codex P2 fold — flags non-finite envelope.emitted_at', () => {
    const plan = buildBasePlan({
      user_visible_internal_steps: [
        {
          event: {
            kind: 'extraction.saved',
            entity_kind: 'commitment',
            entity_id: 'c_1',
            confidence: 0.9,
          },
          redaction: 'none',
          emitted_at: 'not_a_number',
        } as never,
      ],
    });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.some(
        (i) =>
          i.kind === 'invalid_internal_step' &&
          i.path === 'user_visible_internal_steps[0].emitted_at',
      ),
    ).toBe(true);
  });

  it('PB7 Codex P2 fold — flags non-string envelope.provenance_ref', () => {
    const plan = buildBasePlan({
      user_visible_internal_steps: [
        {
          event: {
            kind: 'extraction.saved',
            entity_kind: 'commitment',
            entity_id: 'c_1',
            confidence: 0.9,
          },
          redaction: 'none',
          emitted_at: 1_736_000_000_500,
          provenance_ref: 42,
        } as never,
      ],
    });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.some(
        (i) =>
          i.kind === 'invalid_internal_step' &&
          i.path === 'user_visible_internal_steps[0].provenance_ref',
      ),
    ).toBe(true);
  });

  it('PB7 Codex P2 fold — flags off-list event.kind in envelope', () => {
    const plan = buildBasePlan({
      user_visible_internal_steps: [
        {
          event: { kind: 'no_such_kind' },
          redaction: 'none',
          emitted_at: 1_736_000_000_500,
        } as never,
      ],
    });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.some(
        (i) =>
          i.kind === 'invalid_internal_step' &&
          i.path === 'user_visible_internal_steps[0].event',
      ),
    ).toBe(true);
  });

  it('PB7 Codex P2 fold — accepts valid envelope', () => {
    const plan = buildBasePlan({
      user_visible_internal_steps: [
        {
          event: {
            kind: 'extraction.saved',
            entity_kind: 'commitment',
            entity_id: 'c_1',
            confidence: 0.9,
          },
          redaction: 'none',
          emitted_at: 1_736_000_000_500,
          provenance_ref: 'audit_row_42',
        },
      ],
    });
    const issues = validateRecuedPlan(plan);
    expect(issues.filter((i) => i.kind === 'invalid_internal_step')).toEqual([]);
  });

  it('rejects unknown RecuedPrimitive', () => {
    const call: PrimitiveCall = {
      primitive: 'memory.delete' as never,
      call_id: 'c-1',
      args_summary: 'mock',
      status: 'ok',
      duration_ms: 10,
      outcome_summary: 'mock',
      started_at: 1,
    };
    const plan = buildBasePlan({ primitive_calls: [call] });
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'unknown_primitive')).toBeDefined();
  });

  it('accepts ai.synthesize calls with no stage discriminator (single-stage)', () => {
    const first: PrimitiveCall = {
      primitive: 'ai.synthesize',
      call_id: 'c-s1',
      args_summary: 'synthesis',
      status: 'ok',
      duration_ms: 80,
      outcome_summary: 'composed',
      started_at: 1,
    };
    const second: PrimitiveCall = {
      primitive: 'ai.synthesize',
      call_id: 'c-s2',
      args_summary: 'synthesis',
      status: 'ok',
      duration_ms: 1200,
      outcome_summary: 'response composed',
      started_at: 100,
    };
    const plan = buildBasePlan({ primitive_calls: [first, second] });
    expect(validateRecuedPlan(plan)).toEqual([]);
  });

  it('rejects unknown PrimitiveCallStatus', () => {
    const call: PrimitiveCall = {
      primitive: 'memory.recall',
      call_id: 'c-1',
      args_summary: 'mock',
      status: 'definitely_not' as never,
      duration_ms: 10,
      outcome_summary: 'mock',
      started_at: 1,
    };
    const plan = buildBasePlan({ primitive_calls: [call] });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'unknown_primitive_call_status'),
    ).toBeDefined();
  });

  it('rejects unknown OmissionReasonCode', () => {
    const item = {
      source_ref: 'data.contact.x.private',
      reason_code: 'made_up_reason',
      content_stored: false,
    } as unknown as OmittedItem;
    const plan = buildBasePlan({ omitted_context: [item] });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'unknown_omission_reason_code'),
    ).toBeDefined();
  });

  it('rejects unknown ContextContentClass', () => {
    const item = {
      source_ref: 'data.mail.x',
      content_class: 'definitely_invented',
      persist_policy: 'persist',
    } as unknown as ContextItem;
    const plan = buildBasePlan({ included_context: [item] });
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'unknown_content_class')).toBeDefined();
  });

  it('rejects unknown ContextPersistPolicy', () => {
    const item = {
      source_ref: 'data.mail.x',
      content_class: 'mail_subject_meta',
      persist_policy: 'forever',
    } as unknown as ContextItem;
    const plan = buildBasePlan({ included_context: [item] });
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'unknown_persist_policy')).toBeDefined();
  });

  it('rejects social_raw_body with persist_policy: persist (hardest gate)', () => {
    const item: ContextItem = {
      source_ref: 'social.facebook.x',
      content_class: 'social_raw_body',
      persist_policy: 'persist',
    };
    const plan = buildBasePlan({ included_context: [item] });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'persist_policy_class_mismatch'),
    ).toBeDefined();
  });

  it('accepts social_raw_body with persist_policy: immediate_use_only', () => {
    const item: ContextItem = {
      source_ref: 'social.facebook.x',
      content_class: 'social_raw_body',
      persist_policy: 'immediate_use_only',
      redacted_payload: '3 posts in last 30d, 1 mentions Sicily',
    };
    const plan = buildBasePlan({ included_context: [item] });
    expect(validateRecuedPlan(plan)).toEqual([]);
  });

  it('rejects standing_instruction with persist_policy: persist', () => {
    const item: ContextItem = {
      source_ref: 'standing_instructions.global.x',
      content_class: 'standing_instruction',
      persist_policy: 'persist',
    };
    const plan = buildBasePlan({ included_context: [item] });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'persist_policy_class_mismatch'),
    ).toBeDefined();
  });

  it('rejects redacted_only / immediate_use_only without redacted_payload', () => {
    const item: ContextItem = {
      source_ref: 'standing_instructions.global.x',
      content_class: 'standing_instruction',
      persist_policy: 'redacted_only',
      // redacted_payload omitted — runtime validator catches
    };
    const plan = buildBasePlan({ included_context: [item] });
    const issues = validateRecuedPlan(plan);
    expect(issues.find((i) => i.kind === 'redacted_payload_missing')).toBeDefined();
  });

  it('rejects unknown NarrowingReasonCode', () => {
    const trace = baseSelectionTrace();
    trace.recipe_candidates_dropped.push({
      recipe_slug: 'foo',
      reason_code: 'made_up_reason' as never,
    });
    const plan = buildBasePlan({ selection_trace: trace });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'unknown_narrowing_reason_code'),
    ).toBeDefined();
  });

  it('D-164 P6.7 — rejects non-finite catalog_section_count', () => {
    const trace = baseSelectionTrace();
    (trace as { catalog_section_counts: Record<string, number> }).catalog_section_counts = {
      'entity-query': Number.NaN,
    };
    const plan = buildBasePlan({ selection_trace: trace });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'invalid_catalog_section_count'),
    ).toBeDefined();
  });

  it('D-164 P6.7 — rejects negative catalog_section_count', () => {
    const trace = baseSelectionTrace();
    (trace as { catalog_section_counts: Record<string, number> }).catalog_section_counts = {
      enrichment: -1,
    };
    const plan = buildBasePlan({ selection_trace: trace });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'invalid_catalog_section_count'),
    ).toBeDefined();
  });

  it('rejects unknown NarrowingReasonCode in tools.tier2_dropped_reasons (Codex P2.2 fold)', () => {
    const trace = baseSelectionTrace();
    trace.tools = {
      tier1_selected_count: 0,
      tier1_selected_ids: [],
      tier2_selected_count: 0,
      tier2_selected_ids: [],
      tier2_dropped_count: 1,
      tier2_dropped_reasons: { ['made_up_reason' as never]: 1 },
      tier3_selected_count: 0,
      tier3_selected_ids: [],
      tier3_dropped_count: 0,
      tier3_dropped_reasons: {},
    };
    const plan = buildBasePlan({ selection_trace: trace });
    const issues = validateRecuedPlan(plan);
    const issue = issues.find(
      (i) =>
        i.kind === 'unknown_narrowing_reason_code'
        && i.path?.startsWith('selection_trace.tools.tier2_dropped_reasons'),
    );
    expect(issue).toBeDefined();
  });

  it('rejects unknown NarrowingReasonCode in tools.tier3_dropped_reasons (Codex P2.2 fold)', () => {
    const trace = baseSelectionTrace();
    trace.tools = {
      tier1_selected_count: 0,
      tier1_selected_ids: [],
      tier2_selected_count: 0,
      tier2_selected_ids: [],
      tier2_dropped_count: 0,
      tier2_dropped_reasons: {},
      tier3_selected_count: 0,
      tier3_selected_ids: [],
      tier3_dropped_count: 1,
      tier3_dropped_reasons: { ['nope_not_real' as never]: 1 },
    };
    const plan = buildBasePlan({ selection_trace: trace });
    const issues = validateRecuedPlan(plan);
    const issue = issues.find(
      (i) =>
        i.kind === 'unknown_narrowing_reason_code'
        && i.path?.startsWith('selection_trace.tools.tier3_dropped_reasons'),
    );
    expect(issue).toBeDefined();
  });

  it('accepts a tools block populated only with valid NarrowingReasonCode keys', () => {
    const trace = baseSelectionTrace();
    trace.tools = {
      tier1_selected_count: 1,
      tier1_selected_ids: ['contact.search'],
      tier2_selected_count: 0,
      tier2_selected_ids: [],
      tier2_dropped_count: 2,
      tier2_dropped_reasons: { topic_mismatch: 1, kind_gated: 1 },
      tier3_selected_count: 1,
      tier3_selected_ids: ['exa.search'],
      tier3_dropped_count: 1,
      tier3_dropped_reasons: { tier3_disabled: 1 },
    };
    const plan = buildBasePlan({ selection_trace: trace });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find(
        (i) =>
          i.kind === 'unknown_narrowing_reason_code'
          && i.path?.includes('selection_trace.tools'),
      ),
    ).toBeUndefined();
  });

  it('rejects high_assurance: true without signature', () => {
    const plan = buildBasePlan({
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'high_assurance_signature_missing'),
    ).toBeDefined();
  });

  it('accepts high_assurance: true with signature populated', () => {
    const plan = buildBasePlan({
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
      signature: 'mock-base64-sig',
      signer_fingerprint: 'sha256:abc123',
    });
    expect(validateRecuedPlan(plan)).toEqual([]);
  });

  it('rejects redact_user_request: true with raw user_request', () => {
    const plan = buildBasePlan({
      audit_policy: {
        retain_for_days: 90,
        high_assurance: false,
        redact_user_request: true,
      },
      user_request: 'this is sensitive content',
    });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'redact_user_request_marker_missing'),
    ).toBeDefined();
  });

  it('accepts redact_user_request: true with marker populated', () => {
    const plan = buildBasePlan({
      audit_policy: {
        retain_for_days: 90,
        high_assurance: false,
        redact_user_request: true,
      },
      user_request: REDACTED_USER_REQUEST_MARKER,
    });
    expect(validateRecuedPlan(plan)).toEqual([]);
  });

  it('rejects completed_at < started_at', () => {
    const plan = buildBasePlan({
      started_at: 2_000,
      completed_at: 1_000,
    });
    const issues = validateRecuedPlan(plan);
    expect(
      issues.find((i) => i.kind === 'completed_at_before_started_at'),
    ).toBeDefined();
  });

  it('collects every issue (does not bail on first)', () => {
    const plan = buildBasePlan();
    (plan as { status: string }).status = 'unknown_a';
    (plan as { model_tier: string }).model_tier = 'unknown_b';
    plan.audit_policy.high_assurance = true;
    plan.audit_policy.redact_user_request = true;

    const issues = validateRecuedPlan(plan);
    const kinds = new Set(issues.map((i) => i.kind));
    expect(kinds).toContain('unknown_status');
    expect(kinds).toContain('unknown_model_tier');
    expect(kinds).toContain('high_assurance_signature_missing');
    expect(kinds).toContain('redact_user_request_marker_missing');
  });
});

describe('D-145 PB2 — assertValidRecuedPlan throws on issues', () => {
  it('throws RecuedPlanValidationError with issues exposed', () => {
    const plan = buildBasePlan({ status: 'definitely_not_a_status' as never });
    expect(() => assertValidRecuedPlan(plan)).toThrowError(
      RecuedPlanValidationError,
    );
    try {
      assertValidRecuedPlan(plan);
    } catch (err) {
      expect(err).toBeInstanceOf(RecuedPlanValidationError);
      const issues = (err as RecuedPlanValidationError).issues;
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it('does not throw on a valid plan', () => {
    const plan = buildBasePlan();
    expect(() => assertValidRecuedPlan(plan)).not.toThrow();
  });
});

// ─── § N.13 — Builder helpers ────────────────────────────────────────

describe('D-145 PB2 — § N.13 builder helpers (pure functions)', () => {
  it('appendPrimitiveCall produces a new plan with the call appended', () => {
    const plan = buildBasePlan();
    const call: PrimitiveCall = {
      primitive: 'memory.recall',
      call_id: 'c-1',
      args_summary: 'recent commitments',
      status: 'ok',
      duration_ms: 12,
      outcome_summary: '3 hits',
      started_at: 1_736_000_000_500,
    };
    const next = appendPrimitiveCall(plan, call);
    expect(next.primitive_calls).toHaveLength(1);
    expect(next.primitive_calls[0]).toEqual(call);
    // Pure: input plan unchanged.
    expect(plan.primitive_calls).toHaveLength(0);
  });

  it('appendOmittedItem appends with content_stored: false', () => {
    const plan = buildBasePlan();
    const next = appendOmittedItem(plan, {
      source_ref: 'data.contact.x.body_inline',
      reason_code: 'privacy_class',
      content_stored: false,
    });
    expect(next.omitted_context).toHaveLength(1);
    expect(next.omitted_context[0]!.content_stored).toBe(false);
  });

  it('appendIncludedContext appends a typed ContextItem', () => {
    const plan = buildBasePlan();
    const next = appendIncludedContext(plan, {
      source_ref: 'data.mail.x.subject',
      content_class: 'mail_subject_meta',
      persist_policy: 'persist',
    });
    expect(next.included_context).toHaveLength(1);
  });

  it('appendTransparencyEvent + appendExtractionEvent + appendProvenanceLink', () => {
    let plan = buildBasePlan();
    // PB7 narrowed `TransparencyEventEnvelope` to the closed wire
    // shape `{ event, redaction, emitted_at, provenance_ref? }` per
    // § B.8.2.1. Old open `{ kind, payload? }` envelope retired.
    plan = appendTransparencyEvent(plan, {
      // D-164 P6.7 — `engine.stage1_classified` retired; the new
      // main-turn substrate emits `engine.catalog_assembled` instead.
      event: {
        kind: 'engine.catalog_assembled',
        section_counts: { 'entity-query': 2, recipes: 4 },
      },
      redaction: 'hidden',
      emitted_at: 1_736_000_000_500,
    });
    // PB6 narrowed `ExtractionEvent` to the closed taxonomy
    // (extraction.purchase / .plan / .commitment / .task / .note /
    // .preference / .commitment_status_check + resolution.alias /
    // .contact_created_mention_only / .network_domain_inferred). Old
    // open-envelope `{ kind: 'extraction.detected' }` shape is
    // retired; tests construct the closed shape with confidence + args.
    plan = appendExtractionEvent(plan, {
      kind: 'extraction.commitment',
      confidence: 0.92,
      args: { commitment_text: 'send report Friday', due: '2026-05-15' },
    });
    plan = appendProvenanceLink(plan, {
      memory_id: plan.plan_id,
      entity_id: 'mail-msg-1',
      kind: 'execution.action',
      ts: 1_736_000_000_900,
    });
    expect(plan.user_visible_internal_steps).toHaveLength(1);
    expect(plan.user_events).toHaveLength(1);
    expect(plan.provenance_links).toHaveLength(1);
  });

  it('appendCapacityCheck appends the typed CapacityCheck', () => {
    const plan = buildBasePlan();
    const check: CapacityCheck = {
      kind: 'bridge_online',
      capacity_key: 'bridge_online',
      ok: true,
      cached: false,
      checked_at: 1_736_000_000_100,
    };
    const next = appendCapacityCheck(plan, check);
    expect(next.capacity_checks).toHaveLength(1);
    expect(next.capacity_checks[0]).toEqual(check);
  });
});

// ─── § N.14 — redactUserRequest ──────────────────────────────────────

describe('D-145 PB2 — § N.14 redactUserRequest helper', () => {
  it('replaces user_request with the marker + flips the flag', () => {
    const plan = buildBasePlan({
      user_request: 'sensitive customer data: card 4111-1111-1111-1111',
    });
    const redacted = redactUserRequest(plan);
    expect(redacted.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
    expect(redacted.audit_policy.redact_user_request).toBe(true);
    // Pure: input unchanged.
    expect(plan.user_request).toContain('4111');
    expect(plan.audit_policy.redact_user_request).toBe(false);
  });

  it('redacted plan validates clean', () => {
    const plan = redactUserRequest(buildBasePlan({ user_request: 'sensitive' }));
    expect(validateRecuedPlan(plan)).toEqual([]);
  });
});

// ─── § N.15 — stripPlanSignatureFields ───────────────────────────────

describe('D-145 PB2 — § N.15 stripPlanSignatureFields (signing prep)', () => {
  it('removes signature + signer_fingerprint fields', () => {
    const plan = buildBasePlan({
      signature: 'mock-sig',
      signer_fingerprint: 'sha256:abc',
    });
    const stripped = stripPlanSignatureFields(plan);
    expect((stripped as { signature?: string }).signature).toBeUndefined();
    expect(
      (stripped as { signer_fingerprint?: string }).signer_fingerprint,
    ).toBeUndefined();
  });

  it('returns the same reference when nothing to strip', () => {
    const plan = buildBasePlan();
    expect(stripPlanSignatureFields(plan)).toBe(plan);
  });
});
