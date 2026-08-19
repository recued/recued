/** D-145 PB5 — substrate ratchet tests.
 *
 *  Pins:
 *    - FIXED_SLOT_INVARIANT_VIOLATION_KINDS = exactly 2 entries
 *    - MULTI_TURN_EVENT_KINDS = exactly 3 entries (recued.multi_turn.* prefix)
 *    - MULTI_TURN_TERMINATION_REASONS = exactly 4 entries
 *    - AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS = exactly 4 entries
 *    - enforceFixedSlots invariant: drops alternatives that drift from
 *      `fixed_slots` exactly + emits one violation per dropped slot
 *    - `fixed-slots-preserved.ratchet` — every alternative survives if
 *      and only if every fixed_slot field-value matches; substrate
 *      runtime gate is the canonical enforcement point per § B.6.8 +
 *      D-145 spec invariant 15. */

import { describe, it, expect } from 'vitest';

import {
  AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS,
  FIXED_SLOT_INVARIANT_VIOLATION_KINDS,
  MULTI_TURN_EVENT_KINDS,
  MULTI_TURN_TERMINATION_REASONS,
  type ActionRequest,
  type ActionResult,
} from '@recued/contracts';
import { enforceFixedSlots } from '../ai-cooperative/enforce-fixed-slots.js';
import { runMultiTurnLoop } from '../ai-cooperative/multi-turn-loop.js';
import {
  FIXED_SLOT_DRIFT_EVENT_KIND,
  processActionResult,
} from '../ai-cooperative/process-action-result.js';

describe('D-145 PB5 — closed-list ratchets', () => {
  it('FIXED_SLOT_INVARIANT_VIOLATION_KINDS pinned at 2 entries', () => {
    expect(FIXED_SLOT_INVARIANT_VIOLATION_KINDS.length).toBe(2);
    expect(new Set(FIXED_SLOT_INVARIANT_VIOLATION_KINDS)).toEqual(
      new Set(['fixed_slot_drift', 'fixed_slot_unknown_field']),
    );
  });

  it('MULTI_TURN_EVENT_KINDS pinned at 3 entries with recued.multi_turn.* prefix', () => {
    expect(MULTI_TURN_EVENT_KINDS.length).toBe(3);
    for (const k of MULTI_TURN_EVENT_KINDS) {
      expect(k.startsWith('recued.multi_turn.')).toBe(true);
    }
  });

  it('MULTI_TURN_TERMINATION_REASONS pinned at 4 entries', () => {
    // ⚠ SECOND ratchet over this one list — the contracts package pins it too.
    // Widening the list reds BOTH, and updating only one leaves a live pin
    // asserting the old size. `output_unreadable` was added deliberately: a
    // turn whose last packet could not be parsed used to report `completed`.
    expect(MULTI_TURN_TERMINATION_REASONS.length).toBe(4);
    expect(new Set(MULTI_TURN_TERMINATION_REASONS)).toEqual(
      new Set([
        'completed',
        'output_unreadable',
        'max_rounds_exhausted',
        'aborted',
      ]),
    );
  });

  it('AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS pinned at 4 entries', () => {
    expect(AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS.length).toBe(4);
  });
});

describe('D-145 PB5 — fixed-slots-preserved.ratchet (D-145 invariant 15)', () => {
  // The named ratchet asserts that every alternative returned by every
  // kernel ingredient preserves `fixed_slots` field-values exactly;
  // substrate runtime validator drops drifting alternatives + emits
  // `fixed_slot_drift` invariant violation.

  it('every survivor preserves every fixed_slot value exactly', () => {
    interface Args { person: string; date: string; time: string; venue?: string }
    const cases: Array<{
      req: ActionRequest<Args>;
      res: ActionResult<Args>;
      expect_survivors: number;
      expect_drift_count: number;
    }> = [
      // Case 1: fixed person, alternatives all preserve
      {
        req: { args: { person: 'Mary', date: '2026-05-12', time: '12:00' }, fixed_slots: ['person'] },
        res: {
          result: null,
          alternatives: [
            { args: { person: 'Mary', date: '2026-05-13', time: '12:00' }, confidence: 0.9 },
            { args: { person: 'Mary', date: '2026-05-14', time: '13:00' }, confidence: 0.7 },
          ],
        },
        expect_survivors: 2,
        expect_drift_count: 0,
      },
      // Case 2: alternative drifts on person → 1 drop
      {
        req: { args: { person: 'Mary', date: '2026-05-12', time: '12:00' }, fixed_slots: ['person'] },
        res: {
          result: null,
          alternatives: [
            { args: { person: 'Mary', date: '2026-05-13', time: '12:00' }, confidence: 0.9 },
            { args: { person: 'Sarah', date: '2026-05-13', time: '13:00' }, confidence: 0.7 },
          ],
        },
        expect_survivors: 1,
        expect_drift_count: 1,
      },
      // Case 3: vendor_role + date fixed, vendor varies (B.6.7)
      {
        req: { args: { person: 'florist', date: '2026-05-16', time: '' }, fixed_slots: ['person', 'date'] },
        res: {
          result: null,
          alternatives: [
            { args: { person: 'florist', date: '2026-05-16', time: '', venue: 'A' }, confidence: 0.9 },
            { args: { person: 'florist', date: '2026-05-16', time: '', venue: 'B' }, confidence: 0.8 },
            { args: { person: 'florist', date: '2026-05-17', time: '', venue: 'C' }, confidence: 0.6 }, // date drift
          ],
        },
        expect_survivors: 2,
        expect_drift_count: 1,
      },
    ];
    for (const c of cases) {
      const { survivors, violations } = enforceFixedSlots(c.req, c.res);
      expect(survivors.length).toBe(c.expect_survivors);
      expect(violations.length).toBe(c.expect_drift_count);
      // Survivors must EXACTLY match fixed_slots values
      for (const s of survivors) {
        for (const slot of c.req.fixed_slots) {
          const slotKey = slot as keyof typeof s.args;
          expect(s.args[slotKey]).toEqual(c.req.args[slotKey]);
        }
      }
    }
  });

  it('processActionResult emits exactly one event per violation (audit completeness)', () => {
    interface Args { person: string }
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        { args: { person: 'A' }, confidence: 0.9 },
        { args: { person: 'B' }, confidence: 0.8 },
        { args: { person: 'C' }, confidence: 0.7 },
      ],
    };
    const { events } = processActionResult(req, res);
    expect(events.length).toBe(3);
    for (const e of events) {
      expect(e.event.kind).toBe(FIXED_SLOT_DRIFT_EVENT_KIND);
    }
  });

  it('substrate refuses to fabricate alternatives (§ B.6.9 invariant)', () => {
    interface Args { person: string }
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    // Original returns empty + conflict — substrate MUST NOT add anything
    const res: ActionResult<Args> = { result: null, alternatives: [], conflict: 'no slot' };
    const { processed } = processActionResult(req, res);
    expect(processed.alternatives).toEqual([]);
    expect(processed.violations).toEqual([]);
    expect(processed.conflict).toBe('no slot');
  });
});

describe('D-145 PB5 — multi-turn loop discipline ratchet', () => {
  it('runMultiTurnLoop is deterministic across iterations (closed-list outcomes)', async () => {
    const observed: Array<{ total_rounds: number; termination_reason: string }> = [];
    for (let i = 0; i < 25; i++) {
      const result = await runMultiTurnLoop({
        tier: 'mid',
        body: async (round_index) => {
          if (round_index === 0) return { kind: 'continue', tool_calls_executed: 1, alternatives_returned: 2 };
          return { kind: 'completed', tool_calls_executed: 1, alternatives_returned: 0 };
        },
      });
      observed.push({ total_rounds: result.total_rounds, termination_reason: result.termination_reason });
    }
    const first = observed[0]!;
    for (const o of observed) {
      expect(o).toEqual(first);
    }
  });
});
