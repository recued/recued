/** D-145 PB5 — visible multi-turn loop discipline tests.
 *
 *  Per § B.6.1 + § B.6.2 + § B.6.3. Cover per-round Transparency
 *  Stream emission, tier-budget-aware termination, completed/aborted/
 *  max_rounds_exhausted reasons, throw handling, max_rounds_override
 *  clamp.
 */

import { describe, it, expect } from 'vitest';

import {
  buildMultiTurnLoopTerminatedEvent,
  buildMultiTurnRoundCompletedEvent,
  buildMultiTurnRoundStartedEvent,
  MULTI_TURN_LOOP_TERMINATED_KIND,
  MULTI_TURN_ROUND_COMPLETED_KIND,
  MULTI_TURN_ROUND_STARTED_KIND,
  resolveMaxRounds,
  runMultiTurnLoop,
} from '../ai-cooperative/multi-turn-loop.js';
import {
  TIER_PACKET_BUDGETS,
  type CapacityCheck,
  type ContextItem,
  type ExtractionEvent,
  type OmittedItem,
  type ProvenanceLink,
  type RecuedPlan,
  type TransparencyEventEnvelope,
} from '@recued/contracts';
import type { PlanDraft } from '../orchestrator/execute-recued-request.js';

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
  return { draft, events };
};

describe('D-145 PB5 — resolveMaxRounds: tier-budget-aware ceiling', () => {
  it('fast → 1 round', () => {
    expect(resolveMaxRounds('fast')).toBe(TIER_PACKET_BUDGETS.fast.max_rounds);
    expect(resolveMaxRounds('fast')).toBe(1);
  });

  it('mid → 2 rounds', () => {
    expect(resolveMaxRounds('mid')).toBe(TIER_PACKET_BUDGETS.mid.max_rounds);
    expect(resolveMaxRounds('mid')).toBe(2);
  });

  it('reasoning → 3 rounds', () => {
    expect(resolveMaxRounds('reasoning')).toBe(TIER_PACKET_BUDGETS.reasoning.max_rounds);
    expect(resolveMaxRounds('reasoning')).toBe(3);
  });

  it('override clamp: tighter override is honored', () => {
    expect(resolveMaxRounds('reasoning', 1)).toBe(1);
    expect(resolveMaxRounds('mid', 1)).toBe(1);
  });

  it('override never raises beyond tier default', () => {
    expect(resolveMaxRounds('fast', 5)).toBe(1);
    expect(resolveMaxRounds('mid', 10)).toBe(2);
  });

  it('invalid override (NaN / negative / 0) falls back to tier default', () => {
    expect(resolveMaxRounds('reasoning', NaN)).toBe(3);
    expect(resolveMaxRounds('reasoning', -1)).toBe(3);
    expect(resolveMaxRounds('reasoning', 0)).toBe(3);
    expect(resolveMaxRounds('reasoning', Infinity)).toBe(3);
  });

  it('fractional override floors', () => {
    expect(resolveMaxRounds('reasoning', 2.7)).toBe(2);
  });
});

describe('D-145 PB5 — runMultiTurnLoop: per-round Transparency Stream emission', () => {
  it('emits round_started + round_completed for each round + loop_terminated at end (single round, completed)', async () => {
    const { draft, events } = stubDraft();
    const result = await runMultiTurnLoop({
      tier: 'fast',
      draft,
      body: async () => ({ kind: 'completed', tool_calls_executed: 1, alternatives_returned: 0 }),
    });
    expect(result.total_rounds).toBe(1);
    expect(result.termination_reason).toBe('completed');
    expect(events.length).toBe(3);
    expect(events[0]?.event.kind).toBe(MULTI_TURN_ROUND_STARTED_KIND);
    expect(events[1]?.event.kind).toBe(MULTI_TURN_ROUND_COMPLETED_KIND);
    expect(events[2]?.event.kind).toBe(MULTI_TURN_LOOP_TERMINATED_KIND);
  });

  it('emits per-round events across multiple `continue` rounds (mid tier, 2 rounds)', async () => {
    const { draft, events } = stubDraft();
    let rounds = 0;
    const result = await runMultiTurnLoop({
      tier: 'mid',
      draft,
      body: async () => {
        rounds += 1;
        if (rounds === 1) return { kind: 'continue', tool_calls_executed: 2, alternatives_returned: 3 };
        return { kind: 'completed', tool_calls_executed: 1, alternatives_returned: 0 };
      },
    });
    expect(result.total_rounds).toBe(2);
    expect(result.termination_reason).toBe('completed');
    // 2 × (start + completed) + 1 terminated = 5 events
    expect(events.length).toBe(5);
    expect(events[0]?.event.kind).toBe(MULTI_TURN_ROUND_STARTED_KIND);
    expect(events[1]?.event.kind).toBe(MULTI_TURN_ROUND_COMPLETED_KIND);
    expect(events[2]?.event.kind).toBe(MULTI_TURN_ROUND_STARTED_KIND);
    expect(events[3]?.event.kind).toBe(MULTI_TURN_ROUND_COMPLETED_KIND);
    expect(events[4]?.event.kind).toBe(MULTI_TURN_LOOP_TERMINATED_KIND);
  });

  it('round_started event carries round_index + expected_max_rounds + tier', async () => {
    const { draft, events } = stubDraft();
    await runMultiTurnLoop({
      tier: 'reasoning',
      draft,
      body: async () => ({ kind: 'completed', tool_calls_executed: 0, alternatives_returned: 0 }),
    });
    const startedEvent = events[0];
    expect(startedEvent?.event).toMatchObject({
      kind: MULTI_TURN_ROUND_STARTED_KIND,
      round_index: 0,
      expected_max_rounds: 3,
      tier: 'reasoning',
    });
  });

  it('round_completed event carries counts only — never user content', async () => {
    const { draft, events } = stubDraft();
    await runMultiTurnLoop({
      tier: 'mid',
      draft,
      body: async () => ({ kind: 'completed', tool_calls_executed: 4, alternatives_returned: 7 }),
    });
    const completedEvent = events[1];
    expect(completedEvent?.event).toMatchObject({
      kind: MULTI_TURN_ROUND_COMPLETED_KIND,
      round_index: 0,
      tool_calls_executed: 4,
      alternatives_returned: 7,
      outcome: 'completed',
    });
  });

  it('loop_terminated event carries total_rounds + termination_reason', async () => {
    const { draft, events } = stubDraft();
    await runMultiTurnLoop({
      tier: 'mid',
      draft,
      body: async () => ({ kind: 'completed', tool_calls_executed: 0, alternatives_returned: 0 }),
    });
    const terminatedEvent = events[events.length - 1];
    expect(terminatedEvent?.event.kind).toBe(MULTI_TURN_LOOP_TERMINATED_KIND);
    expect(terminatedEvent?.event).toMatchObject({
      kind: MULTI_TURN_LOOP_TERMINATED_KIND,
      total_rounds: 1,
      termination_reason: 'completed',
    });
  });
});

describe('D-145 PB5 — runMultiTurnLoop: termination reasons (closed list)', () => {
  it('completed → loop exits on first `completed` outcome', async () => {
    const { draft } = stubDraft();
    const result = await runMultiTurnLoop({
      tier: 'reasoning',
      draft,
      body: async () => ({ kind: 'completed', tool_calls_executed: 0, alternatives_returned: 0 }),
    });
    expect(result.termination_reason).toBe('completed');
    expect(result.total_rounds).toBe(1);
  });

  it('aborted → loop exits on `aborted` outcome', async () => {
    const { draft, events } = stubDraft();
    const result = await runMultiTurnLoop({
      tier: 'reasoning',
      draft,
      body: async () => ({ kind: 'aborted', tool_calls_executed: 0, alternatives_returned: 0, reason: 'cost ceiling' }),
    });
    expect(result.termination_reason).toBe('aborted');
    expect(result.total_rounds).toBe(1);
    const terminated = events[events.length - 1];
    expect(terminated?.event).toMatchObject({ termination_reason: 'aborted' });
  });

  it('max_rounds_exhausted → loop iterates the full tier budget then exits', async () => {
    const { draft, events } = stubDraft();
    const result = await runMultiTurnLoop({
      tier: 'reasoning',
      draft,
      body: async () => ({ kind: 'continue', tool_calls_executed: 1, alternatives_returned: 1 }),
    });
    expect(result.termination_reason).toBe('max_rounds_exhausted');
    expect(result.total_rounds).toBe(3); // reasoning tier max_rounds
    // 3 × (start + completed) + 1 terminated
    expect(events.length).toBe(7);
  });

  it('max_rounds_exhausted respects tighter override', async () => {
    const { draft } = stubDraft();
    const result = await runMultiTurnLoop({
      tier: 'reasoning',
      max_rounds_override: 1,
      draft,
      body: async () => ({ kind: 'continue', tool_calls_executed: 0, alternatives_returned: 0 }),
    });
    expect(result.termination_reason).toBe('max_rounds_exhausted');
    expect(result.total_rounds).toBe(1);
  });
});

describe('D-145 PB5 — runMultiTurnLoop: throw handling', () => {
  it('body throw → loop_terminated emitted with aborted reason BEFORE rethrow', async () => {
    const { draft, events } = stubDraft();
    const failure = new Error('AI unavailable');
    await expect(
      runMultiTurnLoop({
        tier: 'mid',
        draft,
        body: async () => {
          throw failure;
        },
      }),
    ).rejects.toThrow('AI unavailable');
    // round_started + round_completed (aborted) + loop_terminated
    expect(events.length).toBe(3);
    expect(events[1]?.event).toMatchObject({ outcome: 'aborted' });
    expect(events[2]?.event.kind).toBe(MULTI_TURN_LOOP_TERMINATED_KIND);
    expect(events[2]?.event).toMatchObject({ termination_reason: 'aborted' });
  });

  it('Codex P2 #1 fold: throw-path round_completed payload OMITS counts (audit renders "unknown" not "0")', async () => {
    const { draft, events } = stubDraft();
    await expect(
      runMultiTurnLoop({
        tier: 'mid',
        draft,
        body: async () => {
          throw new Error('partial work happened before throw');
        },
      }),
    ).rejects.toThrow();
    const completedEvent = events[1]?.event as Record<string, unknown>;
    // Counts are omitted from the event (NOT hard-coded to 0)
    expect('tool_calls_executed' in completedEvent).toBe(false);
    expect('alternatives_returned' in completedEvent).toBe(false);
    expect(completedEvent.outcome).toBe('aborted');
    expect(completedEvent.round_index).toBe(0);
  });

  it('body throw on second round → first round events present in audit', async () => {
    const { draft, events } = stubDraft();
    let calls = 0;
    await expect(
      runMultiTurnLoop({
        tier: 'mid',
        draft,
        body: async () => {
          calls += 1;
          if (calls === 1) {
            return { kind: 'continue', tool_calls_executed: 1, alternatives_returned: 0 };
          }
          throw new Error('mid-flight failure');
        },
      }),
    ).rejects.toThrow('mid-flight failure');
    // round 0: started + completed (continue) → 2 events
    // round 1: started + completed (aborted) + loop_terminated → 3 events
    expect(events.length).toBe(5);
    expect(events[1]?.event).toMatchObject({ outcome: 'continue', round_index: 0 });
    expect(events[3]?.event).toMatchObject({ outcome: 'aborted', round_index: 1 });
    // Round 0 event retains its known counts; round 1 (throw) has them omitted.
    const round0Event = events[1]?.event as Record<string, unknown>;
    const round1Event = events[3]?.event as Record<string, unknown>;
    expect(round0Event.tool_calls_executed).toBe(1);
    expect('tool_calls_executed' in round1Event).toBe(false);
  });
});

describe('D-145 PB5 — runMultiTurnLoop: optional draft', () => {
  it('without draft → loop runs but emits zero events (the discipline still terminates correctly)', async () => {
    const result = await runMultiTurnLoop({
      tier: 'reasoning',
      body: async () => ({ kind: 'completed', tool_calls_executed: 0, alternatives_returned: 0 }),
    });
    expect(result.total_rounds).toBe(1);
    expect(result.termination_reason).toBe('completed');
    expect(result.emitted_event_count).toBe(0);
  });
});

describe('D-145 PB5 — Transparency Stream event builders', () => {
  it('buildMultiTurnRoundStartedEvent wire envelope shape', () => {
    const ev = buildMultiTurnRoundStartedEvent({ round_index: 0, expected_max_rounds: 3, tier: 'reasoning' });
    expect(ev.event).toEqual({
      kind: MULTI_TURN_ROUND_STARTED_KIND,
      round_index: 0,
      expected_max_rounds: 3,
      tier: 'reasoning',
    });
    // PB7 wire envelope shape — { event, redaction, emitted_at }
    expect(ev.redaction).toBeDefined();
    expect(typeof ev.emitted_at).toBe('number');
  });

  it('buildMultiTurnRoundCompletedEvent shape (with counts)', () => {
    const ev = buildMultiTurnRoundCompletedEvent({
      round_index: 1,
      tool_calls_executed: 2,
      alternatives_returned: 5,
      outcome: 'continue',
    });
    expect(ev.event.kind).toBe(MULTI_TURN_ROUND_COMPLETED_KIND);
    expect(ev.event).toMatchObject({
      kind: MULTI_TURN_ROUND_COMPLETED_KIND,
      round_index: 1,
      tool_calls_executed: 2,
      alternatives_returned: 5,
      outcome: 'continue',
    });
  });

  it('buildMultiTurnRoundCompletedEvent OMITS counts when undefined (Codex P2 #1 fold)', () => {
    const ev = buildMultiTurnRoundCompletedEvent({
      round_index: 0,
      outcome: 'aborted',
    });
    expect(ev.event).toMatchObject({
      kind: MULTI_TURN_ROUND_COMPLETED_KIND,
      round_index: 0,
      outcome: 'aborted',
    });
    // Confirms `tool_calls_executed` / `alternatives_returned` are NOT
    // in the event object (audit renders "unknown" rather than "0").
    expect('tool_calls_executed' in (ev.event as object)).toBe(false);
    expect('alternatives_returned' in (ev.event as object)).toBe(false);
  });

  it('buildMultiTurnLoopTerminatedEvent shape', () => {
    const ev = buildMultiTurnLoopTerminatedEvent({
      total_rounds: 3,
      termination_reason: 'max_rounds_exhausted',
    });
    expect(ev.event.kind).toBe(MULTI_TURN_LOOP_TERMINATED_KIND);
    expect(ev.event).toMatchObject({
      kind: MULTI_TURN_LOOP_TERMINATED_KIND,
      total_rounds: 3,
      termination_reason: 'max_rounds_exhausted',
    });
  });
});
