/** D-145 PB4 — orchestrator tier-policy helper tests.
 *
 *  Bridges selectSynthesisTier + cost-ceiling + tier ↔ PlanStatus +
 *  Transparency Stream emission. Verifies:
 *    - resolveSynthesisTier ok / halt mapping
 *    - cost_ceiling.demoted event emitted on initial-selection demotion
 *    - cost_ceiling.halted event emitted on halt
 *    - SI conflict halt does NOT emit cost_ceiling.halted (different
 *      transparency event class — handled by SI substrate)
 *    - PlanStatus + FailureClass closed-list mapping pinned
 *    - checkMidFlightCostCeiling ok / demoted / halt + Transparency
 *      events
 *    - user_response copy comes from § B.15.10 + § B.15.8 prescribed
 *      wording */

import { describe, it, expect } from 'vitest';

import {
  TIER_POLICY_HALT_TO_FAILURE_CLASS,
  TIER_POLICY_HALT_TO_PLAN_STATUS,
  checkMidFlightCostCeiling,
  resolveSynthesisTier,
} from '../tier-strategy/tier-policy.js';
import type { PlanDraft } from '@recued/middleware/orchestrator/index.js';
import type {
  CapacityCheck,
  ContextItem,
  ExtractionEvent,
  OmittedItem,
  ProvenanceLink,
  RecuedPlan,
  RecuedPrimitive,
  TransparencyEventEnvelope,
} from '@recued/contracts';

const stubDraft = (): {
  draft: PlanDraft;
  events: TransparencyEventEnvelope[];
} => {
  const events: TransparencyEventEnvelope[] = [];
  const plan: RecuedPlan = {
    plan_id: 'p',
    goal_id: 'g',
    user_request: '',
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
      catalog_section_counts: {},
      catalog_short_circuited: false,
    },
    model_tier: 'fast',
    ai_provider: '',
    ai_model_id: '',
    primitive_calls: [],
    status: 'completed',
    user_visible_internal_steps: [],
    user_response: '',
    user_events: [],
    provenance_links: [],
    audit_policy: { retain_for_days: 90, high_assurance: false, redact_user_request: false },
    started_at: 0,
    completed_at: 0,
  };
  const draft: PlanDraft = {
    plan,
    invoke: ((async () => {
      throw new Error('stub.invoke not implemented');
    }) as unknown) as PlanDraft['invoke'],
    recordCapacityCheck(_check: CapacityCheck): void {},
    includeContext(_item: ContextItem): void {},
    omitContext(_item: OmittedItem): void {},
    recordTransparencyEvent(event: TransparencyEventEnvelope): void {
      events.push(event);
    },
    recordExtractionEvent(_event: ExtractionEvent): void {},
    recordProvenanceLink(_link: ProvenanceLink): void {},
    snapshot(): RecuedPlan {
      return plan;
    },
  };
  // Reference-touch unused names so the linter doesn't warn on unused
  // generics/imports in this stub.
  void (null as unknown as RecuedPrimitive);
  return { draft, events };
};

describe('D-145 PB4 — TIER_POLICY_HALT mappings', () => {
  it('standing_instruction_conflict → cancelled_si_conflict + capacity', () => {
    expect(TIER_POLICY_HALT_TO_PLAN_STATUS.standing_instruction_conflict).toBe(
      'cancelled_si_conflict',
    );
    expect(TIER_POLICY_HALT_TO_FAILURE_CLASS.standing_instruction_conflict).toBe('capacity');
  });

  it('cost_ceiling_min_floor → cancelled_cost_ceiling + cost', () => {
    expect(TIER_POLICY_HALT_TO_PLAN_STATUS.cost_ceiling_min_floor).toBe(
      'cancelled_cost_ceiling',
    );
    expect(TIER_POLICY_HALT_TO_FAILURE_CLASS.cost_ceiling_min_floor).toBe('cost');
  });

  it('cost_ceiling_no_lower → cancelled_cost_ceiling + cost', () => {
    expect(TIER_POLICY_HALT_TO_PLAN_STATUS.cost_ceiling_no_lower).toBe(
      'cancelled_cost_ceiling',
    );
    expect(TIER_POLICY_HALT_TO_FAILURE_CLASS.cost_ceiling_no_lower).toBe('cost');
  });
});

describe('D-145 PB4 — resolveSynthesisTier ok path', () => {
  it('returns ok with resolved tier + audit fields (no demotion)', () => {
    const r = resolveSynthesisTier({
      channelDefault: 'fast',
      budget: { remaining_cents: 100, cost_ceiling_cents: 100 },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.baseline_tier).toBe('fast');
      expect(r.demotion_steps).toBe(0);
    }
  });

  it('emits cost_ceiling.demoted event when initial-selection demotes + carries demotion_outcome_summary', () => {
    const { draft, events } = stubDraft();
    const r = resolveSynthesisTier({
      channelDefault: 'reasoning',
      budget: { remaining_cents: 10, cost_ceiling_cents: 100 },
      draft,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.demotion_steps).toBe(1);
      // Codex P2 fold: surface canonical § B.15.10 wording for PB17.
      expect(r.demotion_outcome_summary).toBe(
        'demoted_due_to_cost_ceiling from=reasoning to=mid',
      );
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.event.kind).toBe('cost_ceiling.demoted');
    expect((events[0]!.event as { from_tier: string }).from_tier).toBe('reasoning');
    expect((events[0]!.event as { to_tier: string }).to_tier).toBe('mid');
  });

  it('does NOT emit cost_ceiling.demoted when no demotion happens', () => {
    const { draft, events } = stubDraft();
    resolveSynthesisTier({
      channelDefault: 'fast',
      budget: { remaining_cents: 100, cost_ceiling_cents: 100 },
      draft,
    });
    expect(events).toHaveLength(0);
  });

  it('forwards sessionPref to selectSynthesisTier (D-164 P6.2)', () => {
    // Codex review fold: tier-policy.ts:133-135 forwards sessionPref
    // when present. Test the forwarding by setting sessionPref to a
    // value that DIFFERS from channelDefault — if forwarding works,
    // baseline_tier matches sessionPref; if forwarding silently drops
    // sessionPref, baseline_tier collapses to channelDefault.
    const r = resolveSynthesisTier({
      channelDefault: 'fast',
      sessionPref: 'reasoning',
      budget: { remaining_cents: 100, cost_ceiling_cents: 100 },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.baseline_tier).toBe('reasoning');
    }
  });
});

describe('D-145 PB4 — resolveSynthesisTier halt paths', () => {
  it('SI bound conflict halts → cancelled_si_conflict + user copy + standing_instruction_conflict event', () => {
    const { draft, events } = stubDraft();
    const r = resolveSynthesisTier({
      channelDefault: 'fast',
      siBounds: { min_tier: 'reasoning', max_tier: 'fast' },
      budget: { remaining_cents: 100, cost_ceiling_cents: 100 },
      draft,
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.halt_reason).toBe('standing_instruction_conflict');
      expect(r.status).toBe('cancelled_si_conflict');
      expect(r.failure_class).toBe('capacity');
      expect(r.user_response).toContain('Standing Instructions');
      // SI conflict does NOT carry halt_outcome_summary — no
      // associated AI primitive call to attach it to.
      expect(r.halt_outcome_summary).toBeUndefined();
    }
    // Codex P2 fold: SI conflict halt MUST emit
    // standing_instruction_conflict Transparency Stream event per
    // § B.15.8 (NOT cost_ceiling.halted).
    expect(events).toHaveLength(1);
    expect(events[0]!.event.kind).toBe('standing_instruction_conflict');
    expect(
      (events[0]!.event as { conflict_kind?: string }).conflict_kind,
    ).toBe('tier_bound');
    expect((events[0]!.event as { min_tier?: string }).min_tier).toBe('reasoning');
    expect((events[0]!.event as { max_tier?: string }).max_tier).toBe('fast');
  });

  it('SI conflict event threads conflicting_instruction_ids when supplied (PB10 wire-up surface)', () => {
    const { draft, events } = stubDraft();
    resolveSynthesisTier({
      channelDefault: 'fast',
      siBounds: { min_tier: 'reasoning', max_tier: 'fast' },
      budget: { remaining_cents: 100, cost_ceiling_cents: 100 },
      draft,
      conflicting_instruction_ids: ['si_1', 'si_2'],
    });
    expect(events).toHaveLength(1);
    expect(
      (events[0]!.event as { instruction_ids?: ReadonlyArray<string> })
        .instruction_ids,
    ).toEqual(['si_1', 'si_2']);
  });

  it('cost_ceiling_no_lower halt emits cost_ceiling.halted + maps status + carries halt_outcome_summary', () => {
    const { draft, events } = stubDraft();
    const r = resolveSynthesisTier({
      channelDefault: 'fast',
      budget: { remaining_cents: 0, cost_ceiling_cents: 100 },
      draft,
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.halt_reason).toBe('cost_ceiling_no_lower');
      expect(r.status).toBe('cancelled_cost_ceiling');
      expect(r.failure_class).toBe('cost');
      expect(r.user_response).toContain('budget');
      // Codex P2 fold: cost-ceiling halts surface the canonical
      // outcome_summary so PB17 can stamp it on the synthetic
      // cancelled ai.synthesize PrimitiveCall row per § B.15.10.
      expect(r.halt_outcome_summary).toBe(
        'cancelled_due_to_cost_ceiling reason=no_lower_tier tier=fast',
      );
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.event.kind).toBe('cost_ceiling.halted');
    expect((events[0]!.event as { reason: string }).reason).toBe('no_lower_tier');
  });

  it('cost_ceiling_min_floor halt emits cost_ceiling.halted + maps status', () => {
    const { draft, events } = stubDraft();
    const r = resolveSynthesisTier({
      channelDefault: 'reasoning',
      siBounds: { min_tier: 'mid' },
      budget: { remaining_cents: 5, cost_ceiling_cents: 100 },
      draft,
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.halt_reason).toBe('cost_ceiling_min_floor');
      expect(r.halted_at_tier).toBe('mid');
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.event.kind).toBe('cost_ceiling.halted');
    expect((events[0]!.event as { reason: string }).reason).toBe('min_tier_floor');
  });
});

describe('D-145 PB4 — checkMidFlightCostCeiling', () => {
  it('returns ok when budget covers next call', () => {
    const r = checkMidFlightCostCeiling({
      current_tier: 'mid',
      budget: { remaining_cents: 100, cost_ceiling_cents: 100 },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.estimated_cents).toBe(8);
    }
  });

  it('returns demoted + emits cost_ceiling.demoted on demote + carries canonical outcome_summary', () => {
    const { draft, events } = stubDraft();
    const r = checkMidFlightCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 10, cost_ceiling_cents: 100 },
      draft,
    });
    expect(r.kind).toBe('demoted');
    if (r.kind === 'demoted') {
      expect(r.from_tier).toBe('reasoning');
      expect(r.to_tier).toBe('mid');
      expect(r.demotion_steps).toBe(1);
      expect(r.demotion_outcome_summary).toBe(
        'demoted_due_to_cost_ceiling from=reasoning to=mid',
      );
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.event.kind).toBe('cost_ceiling.demoted');
  });

  it('returns halt + emits cost_ceiling.halted at fast with 0 budget + carries halt_outcome_summary', () => {
    const { draft, events } = stubDraft();
    const r = checkMidFlightCostCeiling({
      current_tier: 'fast',
      budget: { remaining_cents: 0, cost_ceiling_cents: 100 },
      draft,
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.halt_reason).toBe('cost_ceiling_no_lower');
      expect(r.status).toBe('cancelled_cost_ceiling');
      expect(r.user_response).toContain('budget');
      expect(r.halt_outcome_summary).toBe(
        'cancelled_due_to_cost_ceiling reason=no_lower_tier tier=fast',
      );
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.event.kind).toBe('cost_ceiling.halted');
  });

  it('returns halt with min_tier_floor when SI floor blocks demotion + canonical outcome_summary', () => {
    const r = checkMidFlightCostCeiling({
      current_tier: 'mid',
      budget: { remaining_cents: 0, cost_ceiling_cents: 100 },
      siBounds: { min_tier: 'mid' },
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.halt_reason).toBe('cost_ceiling_min_floor');
      expect(r.halt_outcome_summary).toBe(
        'cancelled_due_to_cost_ceiling reason=min_tier_floor tier=mid',
      );
    }
  });

  it('honors next_call_cost_cents override', () => {
    const r = checkMidFlightCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 5, cost_ceiling_cents: 100 },
      next_call_cost_cents: 3,
    });
    expect(r.kind).toBe('ok');
  });
});
