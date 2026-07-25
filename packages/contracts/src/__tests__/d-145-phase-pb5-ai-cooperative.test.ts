/** D-145 PB5 — AI-cooperative substrate contracts tests.
 *
 *  Covers § B.6.6 (ActionRequest / ActionResult shapes), § B.6.8
 *  (fixed_slot_drift / fixed_slot_unknown_field invariant kinds),
 *  § B.6.1 (multi-turn event kinds + termination reasons), § B.6.11
 *  (validator-gate manifest declaration constants), substrate
 *  self-check (`assertAiCooperativeInvariants`). */

import { describe, it, expect } from 'vitest';

import {
  AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS,
  AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS,
  AI_COOPERATIVE_VALIDATOR_ISSUE_KIND_SET,
  FIXED_SLOT_INVARIANT_VIOLATION_KINDS,
  FIXED_SLOT_INVARIANT_VIOLATION_KIND_SET,
  MULTI_TURN_EVENT_KINDS,
  MULTI_TURN_EVENT_KIND_SET,
  MULTI_TURN_TERMINATION_REASONS,
  MULTI_TURN_TERMINATION_REASON_SET,
  assertAiCooperativeInvariants,
  type ActionRequest,
  type ActionResult,
  type AiCooperativeManifestDeclaration,
  type AiCooperativeValidatorIssueKind,
  type FixedSlotInvariantViolation,
  type FixedSlotInvariantViolationKind,
  type MultiTurnEventKind,
  type MultiTurnTerminationReason,
  type ProcessedActionResult,
} from '../ai-cooperative.js';

describe('D-145 PB5 — closed-list pins', () => {
  it('FIXED_SLOT_INVARIANT_VIOLATION_KINDS is exactly 2 entries', () => {
    expect(FIXED_SLOT_INVARIANT_VIOLATION_KINDS.length).toBe(2);
    expect(new Set(FIXED_SLOT_INVARIANT_VIOLATION_KINDS)).toEqual(
      new Set(['fixed_slot_drift', 'fixed_slot_unknown_field']),
    );
  });

  it('FIXED_SLOT_INVARIANT_VIOLATION_KIND_SET membership matches array', () => {
    for (const kind of FIXED_SLOT_INVARIANT_VIOLATION_KINDS) {
      expect(FIXED_SLOT_INVARIANT_VIOLATION_KIND_SET.has(kind)).toBe(true);
    }
  });

  it('MULTI_TURN_EVENT_KINDS is exactly 3 entries with `recued.multi_turn.` prefix', () => {
    expect(MULTI_TURN_EVENT_KINDS.length).toBe(3);
    expect(new Set(MULTI_TURN_EVENT_KINDS)).toEqual(
      new Set([
        'recued.multi_turn.round_started',
        'recued.multi_turn.round_completed',
        'recued.multi_turn.loop_terminated',
      ]),
    );
    for (const kind of MULTI_TURN_EVENT_KINDS) {
      expect(kind.startsWith('recued.multi_turn.')).toBe(true);
    }
  });

  it('MULTI_TURN_EVENT_KIND_SET pinned in lockstep with array', () => {
    expect(MULTI_TURN_EVENT_KIND_SET.size).toBe(MULTI_TURN_EVENT_KINDS.length);
  });

  it('MULTI_TURN_TERMINATION_REASONS is exactly 3 entries', () => {
    expect(MULTI_TURN_TERMINATION_REASONS.length).toBe(3);
    expect(new Set(MULTI_TURN_TERMINATION_REASONS)).toEqual(
      new Set(['completed', 'max_rounds_exhausted', 'aborted']),
    );
  });

  it('MULTI_TURN_TERMINATION_REASON_SET pinned in lockstep with array', () => {
    expect(MULTI_TURN_TERMINATION_REASON_SET.size).toBe(
      MULTI_TURN_TERMINATION_REASONS.length,
    );
  });

  it('AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS is exactly 4 entries', () => {
    expect(AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS.length).toBe(4);
    expect(new Set(AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS)).toEqual(
      new Set([
        'ai_cooperative_declaration_missing',
        'ai_cooperative_fixed_slots_not_honored',
        'ai_cooperative_opt_out_rationale_required',
        'ai_cooperative_declaration_contradictory',
      ]),
    );
  });

  it('AI_COOPERATIVE_VALIDATOR_ISSUE_KIND_SET pinned in lockstep with array', () => {
    expect(AI_COOPERATIVE_VALIDATOR_ISSUE_KIND_SET.size).toBe(
      AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS.length,
    );
  });

  it('AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS is positive', () => {
    expect(AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS).toBeGreaterThan(0);
  });
});

describe('D-145 PB5 — assertAiCooperativeInvariants', () => {
  it('passes on the substrate constants (smoke)', () => {
    expect(() => assertAiCooperativeInvariants()).not.toThrow();
  });
});

describe('D-145 PB5 — type shapes (compile-time + runtime smoke)', () => {
  it('ActionRequest carries args + fixed_slots', () => {
    const req: ActionRequest<{ person: string; date: string; time: string }> = {
      args: { person: 'Mary', date: '2026-05-12', time: '12:00' },
      fixed_slots: ['person'],
    };
    expect(req.fixed_slots).toEqual(['person']);
  });

  it('ActionResult carries result | null + alternatives + meta', () => {
    const res: ActionResult<{ x: number }> = {
      result: { x: 1 },
      alternatives: [{ args: { x: 1 }, confidence: 0.9 }],
      meta: { rounds_avoided: 2 },
    };
    expect(res.result).toEqual({ x: 1 });
    expect(res.alternatives?.length).toBe(1);
  });

  it('ProcessedActionResult carries surviving alts + violations', () => {
    const violation: FixedSlotInvariantViolation = {
      kind: 'fixed_slot_drift',
      slot: 'person',
      alternative_index: 0,
    };
    const out: ProcessedActionResult<{ x: number }> = {
      original_result: null,
      conflict: 'no acceptable',
      alternatives: [],
      violations: [violation],
    };
    expect(out.violations.length).toBe(1);
    expect(out.violations[0]?.kind).toBe('fixed_slot_drift');
  });

  it('AiCooperativeManifestDeclaration declares_alternatives shape', () => {
    const declared: AiCooperativeManifestDeclaration = {
      declares_alternatives: true,
      fixed_slots_honored: true,
    };
    const optedOut: AiCooperativeManifestDeclaration = {
      declares_alternatives: false,
      opt_out_rationale: 'pure inference, no alternatives possible',
    };
    expect(declared.declares_alternatives).toBe(true);
    expect(optedOut.declares_alternatives).toBe(false);
  });

  it('FixedSlotInvariantViolationKind / MultiTurnEventKind / MultiTurnTerminationReason / AiCooperativeValidatorIssueKind compile-time-derived from arrays', () => {
    const kind: FixedSlotInvariantViolationKind = 'fixed_slot_drift';
    const evt: MultiTurnEventKind = 'recued.multi_turn.round_started';
    const reason: MultiTurnTerminationReason = 'completed';
    const issue: AiCooperativeValidatorIssueKind = 'ai_cooperative_declaration_missing';
    expect(kind).toBe('fixed_slot_drift');
    expect(evt).toBe('recued.multi_turn.round_started');
    expect(reason).toBe('completed');
    expect(issue).toBe('ai_cooperative_declaration_missing');
  });
});
