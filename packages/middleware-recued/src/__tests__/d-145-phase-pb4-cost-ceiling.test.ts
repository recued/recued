/** D-145 PB4 — mid-flight cost ceiling tests.
 *
 *  Per § B.15.10. evaluateCostCeiling demote/halt logic + the
 *  Transparency Stream event helpers (cost_ceiling.demoted,
 *  cost_ceiling.halted) per § B.8.2. */

import { describe, it, expect } from 'vitest';

import {
  COST_CEILING_DEMOTION_OUTCOME_PHRASE,
  COST_CEILING_HALT_OUTCOME_PHRASE,
  buildCostCeilingDemotedEvent,
  buildCostCeilingHaltedEvent,
  buildStandingInstructionConflictEvent,
  evaluateCostCeiling,
  formatCostCeilingDemotionOutcomeSummary,
  formatCostCeilingHaltOutcomeSummary,
  transparencyHaltReason,
} from '../tier-strategy/cost-ceiling.js';

describe('D-145 PB4 — evaluateCostCeiling — ok path', () => {
  it('returns ok when budget covers next call', () => {
    const r = evaluateCostCeiling({
      current_tier: 'mid',
      budget: { remaining_cents: 100, cost_ceiling_cents: 1_000 },
    });
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.estimated_cents).toBe(8); // TIER_ESTIMATED_COST_CENTS.mid
    }
  });

  it('honors next_call_cost_cents override (cheaper than substrate default)', () => {
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 5, cost_ceiling_cents: 100 },
      next_call_cost_cents: 3, // overrides the 70¢ substrate default
    });
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.estimated_cents).toBe(3);
    }
  });
});

describe('D-145 PB4 — evaluateCostCeiling — demote path', () => {
  it('demotes one step when current tier exceeds budget', () => {
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 10, cost_ceiling_cents: 100 },
    });
    expect(r.outcome).toBe('demote');
    if (r.outcome === 'demote') {
      expect(r.from_tier).toBe('reasoning');
      expect(r.to_tier).toBe('mid');
      expect(r.demotion_steps).toBe(1);
    }
  });

  it('demotes 2 steps when budget too tight for both reasoning + mid', () => {
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 5, cost_ceiling_cents: 100 },
    });
    expect(r.outcome).toBe('demote');
    if (r.outcome === 'demote') {
      expect(r.from_tier).toBe('reasoning');
      expect(r.to_tier).toBe('fast');
      expect(r.demotion_steps).toBe(2);
    }
  });
});

describe('D-145 PB4 — evaluateCostCeiling — halt path', () => {
  it('halts cost_ceiling_no_lower at fast with 0 budget', () => {
    const r = evaluateCostCeiling({
      current_tier: 'fast',
      budget: { remaining_cents: 0, cost_ceiling_cents: 100 },
    });
    expect(r.outcome).toBe('halt');
    if (r.outcome === 'halt') {
      expect(r.reason).toBe('cost_ceiling_no_lower');
      expect(r.halted_at_tier).toBe('fast');
    }
  });

  it('halts cost_ceiling_min_floor when SI min_tier prevents demotion', () => {
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 5, cost_ceiling_cents: 100 },
      siBounds: { min_tier: 'mid' },
    });
    expect(r.outcome).toBe('halt');
    if (r.outcome === 'halt') {
      expect(r.reason).toBe('cost_ceiling_min_floor');
      expect(r.halted_at_tier).toBe('mid');
    }
  });
});

describe('D-145 PB4 — Codex P1 fold: next_call_cost_cents threading through walker', () => {
  it('honors next_call_cost_cents at fast-path AND walker (no false ok)', () => {
    // Caller says: this round will cost 50¢ at reasoning. Budget 30¢ +
    // substrate-default mid 8¢ — without the fix the walker would
    // return ok at mid (8¢ ≤ 30¢) using the substrate default; but
    // the caller's per-tier estimate still applies AT the current
    // tier; fall-through demotes correctly.
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 30, cost_ceiling_cents: 100 },
      next_call_cost_cents: 50,
    });
    expect(r.outcome).toBe('demote');
    if (r.outcome === 'demote') {
      // Walker uses caller's 50¢ for current (reasoning), substrate
      // 8¢ for mid → mid fits 30¢ budget.
      expect(r.from_tier).toBe('reasoning');
      expect(r.to_tier).toBe('mid');
    }
  });

  it('halts no_lower when caller-supplied next_call_cost_cents over fast tier with 0 budget', () => {
    const r = evaluateCostCeiling({
      current_tier: 'fast',
      budget: { remaining_cents: 0, cost_ceiling_cents: 100 },
      next_call_cost_cents: 5,
    });
    expect(r.outcome).toBe('halt');
    if (r.outcome === 'halt') {
      expect(r.reason).toBe('cost_ceiling_no_lower');
      expect(r.halted_at_tier).toBe('fast');
    }
  });
});

describe('D-145 PB4 — Codex P2 fold: latency + token ceiling signals (§ C.3.6)', () => {
  it('elapsed_wall_clock_ms over reasoning p95 → halt (lower tiers tighter)', () => {
    // Reasoning p95 wall-clock = 20_000ms; if we are already at
    // 19_500 + next call p50 (8_000) → projected = 27_500ms > 20_000.
    // Demotion CANNOT help: mid p95 is 4_000, fast p95 is 1_500 —
    // tighter still. Halt at the current tier.
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 1000, cost_ceiling_cents: 1000 },
      elapsed_wall_clock_ms: 19_500,
    });
    expect(r.outcome).toBe('halt');
    if (r.outcome === 'halt') {
      expect(r.halted_at_tier).toBe('reasoning');
      expect(r.reason).toBe('cost_ceiling_no_lower');
    }
  });

  it('tokens_used_so_far over reasoning p95 → halt', () => {
    // Reasoning p95 token cost = 50_000; if 49_000 used + next call
    // p50 (16_000) → projected 65_000 > 50_000 → halt. Lower tiers
    // have tighter token ceilings (mid 10_000, fast 2_000) — demotion
    // never helps for cumulative-resource ceilings.
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 1000, cost_ceiling_cents: 1000 },
      tokens_used_so_far: 49_000,
    });
    expect(r.outcome).toBe('halt');
    if (r.outcome === 'halt') {
      expect(r.halted_at_tier).toBe('reasoning');
    }
  });

  it('honors next_call_wall_clock_ms override (under ceiling → ok)', () => {
    // Reasoning p95 wall-clock = 20_000; elapsed 5_000 + override 1_000
    // → projected 6_000 ≤ 20_000 → ok at reasoning.
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 1000, cost_ceiling_cents: 1000 },
      elapsed_wall_clock_ms: 5_000,
      next_call_wall_clock_ms: 1_000,
    });
    expect(r.outcome).toBe('ok');
  });

  it('honors next_call_tokens override', () => {
    // Reasoning p95 tokens 50_000; tokens_used 30_000 + override 5_000
    // → projected 35_000 ≤ 50_000 → ok.
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 1000, cost_ceiling_cents: 1000 },
      tokens_used_so_far: 30_000,
      next_call_tokens: 5_000,
    });
    expect(r.outcome).toBe('ok');
  });

  it('cents demotion still works when latency + tokens are clean', () => {
    // No latency / token signals; cents budget tight → demotes as
    // before (cents-only walker).
    const r = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { remaining_cents: 10, cost_ceiling_cents: 100 },
    });
    expect(r.outcome).toBe('demote');
  });
});

describe('D-145 PB4 — Codex P2 fold: outcome_summary helpers (§ B.15.10)', () => {
  it('formatCostCeilingDemotionOutcomeSummary uses prescribed wording', () => {
    expect(formatCostCeilingDemotionOutcomeSummary('reasoning', 'mid')).toBe(
      'demoted_due_to_cost_ceiling from=reasoning to=mid',
    );
    expect(formatCostCeilingDemotionOutcomeSummary('mid', 'fast')).toBe(
      'demoted_due_to_cost_ceiling from=mid to=fast',
    );
  });

  it('formatCostCeilingHaltOutcomeSummary uses prescribed wording', () => {
    expect(formatCostCeilingHaltOutcomeSummary('cost_ceiling_no_lower', 'fast')).toBe(
      'cancelled_due_to_cost_ceiling reason=no_lower_tier tier=fast',
    );
    expect(formatCostCeilingHaltOutcomeSummary('cost_ceiling_min_floor', 'mid')).toBe(
      'cancelled_due_to_cost_ceiling reason=min_tier_floor tier=mid',
    );
  });

  it('canonical phrases pinned at substrate level (PB17 reads)', () => {
    expect(COST_CEILING_DEMOTION_OUTCOME_PHRASE).toBe('demoted_due_to_cost_ceiling');
    expect(COST_CEILING_HALT_OUTCOME_PHRASE).toBe('cancelled_due_to_cost_ceiling');
  });
});

describe('D-145 PB4 — Codex P2 fold: standing_instruction_conflict event (§ B.15.8)', () => {
  it('emits closed-list kind with tier_bound discriminator', () => {
    const env = buildStandingInstructionConflictEvent({
      conflict_kind: 'tier_bound',
      min_tier: 'reasoning',
      max_tier: 'fast',
    });
    expect(env.event.kind).toBe('standing_instruction_conflict');
    expect(env.event).toMatchObject({
      kind: 'standing_instruction_conflict',
      conflict_kind: 'tier_bound',
      min_tier: 'reasoning',
      max_tier: 'fast',
      instruction_ids: [],
    });
  });

  it('threads instruction_ids when supplied (PB10 wire-up surface)', () => {
    const env = buildStandingInstructionConflictEvent({
      conflict_kind: 'tier_bound',
      min_tier: 'reasoning',
      max_tier: 'fast',
      instruction_ids: ['si_1', 'si_2'],
    });
    expect(
      (env.event as { instruction_ids: ReadonlyArray<string> }).instruction_ids,
    ).toEqual(['si_1', 'si_2']);
  });

  it('emits empty instruction_ids array when an empty list is supplied', () => {
    const env = buildStandingInstructionConflictEvent({
      conflict_kind: 'tier_bound',
      instruction_ids: [],
    });
    expect(
      (env.event as { instruction_ids: ReadonlyArray<string> }).instruction_ids,
    ).toEqual([]);
  });
});

describe('D-145 PB4 — Transparency Stream event helpers (§ B.8.2)', () => {
  it('buildCostCeilingDemotedEvent emits closed-list kind', () => {
    const env = buildCostCeilingDemotedEvent({
      from_tier: 'reasoning',
      to_tier: 'mid',
      demotion_steps: 1,
    });
    expect(env.event.kind).toBe('cost_ceiling.demoted');
    expect(env.event).toMatchObject({
      kind: 'cost_ceiling.demoted',
      from_tier: 'reasoning',
      to_tier: 'mid',
      demotion_steps: 1,
    });
  });

  it('buildCostCeilingDemotedEvent omits demotion_steps when undefined', () => {
    const env = buildCostCeilingDemotedEvent({ from_tier: 'mid', to_tier: 'fast' });
    expect(env.event.kind).toBe('cost_ceiling.demoted');
    expect(env.event).toMatchObject({
      kind: 'cost_ceiling.demoted',
      from_tier: 'mid',
      to_tier: 'fast',
    });
    expect('demotion_steps' in env.event).toBe(false);
  });

  it('buildCostCeilingHaltedEvent emits closed-list kind + min_tier_floor reason', () => {
    const env = buildCostCeilingHaltedEvent({
      reason: 'min_tier_floor',
      halted_at_tier: 'mid',
    });
    expect(env.event.kind).toBe('cost_ceiling.halted');
    expect(env.event).toMatchObject({
      kind: 'cost_ceiling.halted',
      reason: 'min_tier_floor',
      halted_at_tier: 'mid',
    });
  });

  it('buildCostCeilingHaltedEvent emits no_lower_tier reason', () => {
    const env = buildCostCeilingHaltedEvent({
      reason: 'no_lower_tier',
      halted_at_tier: 'fast',
    });
    expect(env.event.kind).toBe('cost_ceiling.halted');
  });

  it('transparencyHaltReason maps internal halt reasons to closed-list narrative', () => {
    expect(transparencyHaltReason('cost_ceiling_min_floor')).toBe('min_tier_floor');
    expect(transparencyHaltReason('cost_ceiling_no_lower')).toBe('no_lower_tier');
  });
});
