/** D-145 PB5 — `enforceFixedSlots` substrate runtime gate tests.
 *
 *  Per § B.6.5 + § B.6.7 + § B.6.8 + § B.6.9. Cover the named-entity
 *  preservation table (B.6.7), drift detection across each slot kind,
 *  unknown-field detection, empty alternatives passthrough.
 */

import { describe, it, expect } from 'vitest';

import { enforceFixedSlots, sanitizeSlotForAudit } from '../ai-cooperative/enforce-fixed-slots.js';
import type { ActionRequest, ActionResult } from '@recued/contracts';

interface ScheduleArgs {
  person?: string;
  date?: string;
  time?: string;
  venue?: string;
  vendor_role?: string;
}

const reqOf = (
  args: ScheduleArgs,
  fixed: ReadonlyArray<keyof ScheduleArgs>,
): ActionRequest<ScheduleArgs> => ({ args, fixed_slots: fixed });

const altsOf = (
  ...alts: Array<{ args: ScheduleArgs; confidence: number; annotation?: string }>
): ActionResult<ScheduleArgs> => ({
  result: alts[0]?.args ?? null,
  alternatives: alts,
});

describe('D-145 PB5 — enforceFixedSlots: B.6.7 named-entity preservation table', () => {
  it('"Date with girlfriend Tue 2pm" — person fixed, date+time vary → alternatives keep person', () => {
    const req = reqOf({ person: 'Mary', date: '2026-05-12', time: '14:00' }, ['person']);
    const res = altsOf(
      { args: { person: 'Mary', date: '2026-05-13', time: '18:00' }, confidence: 0.9 },
      { args: { person: 'Mary', date: '2026-05-14', time: '12:00' }, confidence: 0.8 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(2);
    expect(violations.length).toBe(0);
  });

  it('"Date with girlfriend" — alternative substitutes a different person → DROPPED with fixed_slot_drift', () => {
    const req = reqOf({ person: 'Mary', date: '2026-05-12', time: '14:00' }, ['person']);
    const res = altsOf(
      { args: { person: 'Mary', date: '2026-05-13', time: '18:00' }, confidence: 0.9 },
      // alt 1 substitutes "Sarah" — substrate MUST drop this
      { args: { person: 'Sarah', date: '2026-05-12', time: '14:00' }, confidence: 0.8 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(survivors[0]?.original_index).toBe(0);
    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('fixed_slot_drift');
    expect(violations[0]?.slot).toBe('person');
    expect(violations[0]?.alternative_index).toBe(1);
  });

  it('"Schedule call with Bob Tue 2pm" — person + date fixed, only time varies', () => {
    const req = reqOf({ person: 'Bob', date: '2026-05-12', time: '14:00' }, ['person', 'date']);
    const res = altsOf(
      { args: { person: 'Bob', date: '2026-05-12', time: '15:00' }, confidence: 0.9 },
      { args: { person: 'Bob', date: '2026-05-12', time: '16:00' }, confidence: 0.8 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(2);
    expect(violations.length).toBe(0);
  });

  it('"Schedule call with Bob Tue 2pm" — alternative shifts to Wed → DROPPED (date drift)', () => {
    const req = reqOf({ person: 'Bob', date: '2026-05-12', time: '14:00' }, ['person', 'date']);
    const res = altsOf(
      { args: { person: 'Bob', date: '2026-05-12', time: '15:00' }, confidence: 0.9 },
      { args: { person: 'Bob', date: '2026-05-13', time: '14:00' }, confidence: 0.7 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(violations[0]?.slot).toBe('date');
  });

  it('"Find me a florist for Saturday" — vendor_role + date fixed, specific vendor varies', () => {
    const req = reqOf({ vendor_role: 'florist', date: '2026-05-16' }, ['vendor_role', 'date']);
    const res = altsOf(
      { args: { vendor_role: 'florist', date: '2026-05-16', venue: 'Bloom Co' }, confidence: 0.9 },
      { args: { vendor_role: 'florist', date: '2026-05-16', venue: 'Petal Lane' }, confidence: 0.8 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(2);
    expect(violations.length).toBe(0);
  });

  it('"Find me a florist for Saturday" — alternative substitutes a baker → DROPPED (vendor_role drift)', () => {
    const req = reqOf({ vendor_role: 'florist', date: '2026-05-16' }, ['vendor_role', 'date']);
    const res = altsOf(
      { args: { vendor_role: 'florist', date: '2026-05-16', venue: 'Bloom Co' }, confidence: 0.9 },
      { args: { vendor_role: 'baker', date: '2026-05-16', venue: 'Bread House' }, confidence: 0.85 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(violations[0]?.slot).toBe('vendor_role');
  });

  it('"Book the Italian place Sat 7pm" — venue + date + time all fixed → alternatives empty case (B.6.9)', () => {
    const req = reqOf(
      { venue: 'Trattoria', date: '2026-05-16', time: '19:00' },
      ['venue', 'date', 'time'],
    );
    const res: ActionResult<ScheduleArgs> = {
      result: null,
      alternatives: [],
      conflict: 'venue is closed for that date',
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(0);
    expect(violations.length).toBe(0);
  });
});

describe('D-145 PB5 — enforceFixedSlots: edge cases + invariants', () => {
  it('empty fixed_slots → all alternatives pass (B.6.7 — nothing semantically fixed)', () => {
    const req = reqOf({ date: '2026-05-12', time: '10:00' }, []);
    const res = altsOf(
      { args: { date: '2026-05-13', time: '11:00' }, confidence: 0.9 },
      { args: { date: '2026-05-14', time: '12:00' }, confidence: 0.7 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(2);
    expect(violations.length).toBe(0);
  });

  it('empty alternatives → empty survivors + zero violations (B.6.9 passthrough)', () => {
    const req = reqOf({ person: 'Mary' }, ['person']);
    const res: ActionResult<ScheduleArgs> = { result: null };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors).toEqual([]);
    expect(violations).toEqual([]);
  });

  it('emits fixed_slot_unknown_field when fixed_slots names a missing key', () => {
    // Note: test deliberately provides an args shape that does NOT have `nonexistent`
    type Args = { person: string };
    const req: ActionRequest<Args> = {
      args: { person: 'Mary' },
      // Cast to `keyof Args` for the test — runtime validator should
      // catch typos / stale ingredient code regardless of TS narrowing.
      fixed_slots: ['nonexistent' as keyof Args],
    };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [{ args: { person: 'Mary' }, confidence: 0.9 }],
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(0);
    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('fixed_slot_unknown_field');
    expect(violations[0]?.slot).toBe('nonexistent');
  });

  it('emits one violation per drifting slot — all violations land in audit trail', () => {
    const req = reqOf(
      { person: 'Mary', date: '2026-05-12', venue: 'Cafe' },
      ['person', 'date', 'venue'],
    );
    const res = altsOf(
      // Drifts on all three slots simultaneously
      { args: { person: 'Sarah', date: '2026-05-13', venue: 'Bistro' }, confidence: 0.7 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(0);
    expect(violations.length).toBe(3);
    expect(new Set(violations.map((v) => v.slot))).toEqual(
      new Set(['person', 'date', 'venue']),
    );
  });

  it('preserves survivor confidence + annotation + original_index', () => {
    const req = reqOf({ person: 'Mary' }, ['person']);
    const res = altsOf(
      { args: { person: 'Mary' }, confidence: 0.5, annotation: 'low confidence' },
      { args: { person: 'Sarah' }, confidence: 0.9 }, // dropped
      { args: { person: 'Mary' }, confidence: 0.8, annotation: 'good fit' },
    );
    const { survivors } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(2);
    expect(survivors[0]?.original_index).toBe(0);
    expect(survivors[0]?.confidence).toBe(0.5);
    expect(survivors[0]?.annotation).toBe('low confidence');
    expect(survivors[1]?.original_index).toBe(2);
    expect(survivors[1]?.annotation).toBe('good fit');
  });

  it('deep-equality: nested object slot values match correctly', () => {
    interface NestedArgs {
      person: { name: string; relationship: string };
      date: string;
    }
    const req: ActionRequest<NestedArgs> = {
      args: { person: { name: 'Mary', relationship: 'gf' }, date: '2026-05-12' },
      fixed_slots: ['person'],
    };
    const res: ActionResult<NestedArgs> = {
      result: null,
      alternatives: [
        // Same nested object → match
        { args: { person: { name: 'Mary', relationship: 'gf' }, date: '2026-05-13' }, confidence: 0.9 },
        // Different relationship → drift
        { args: { person: { name: 'Mary', relationship: 'colleague' }, date: '2026-05-13' }, confidence: 0.7 },
      ],
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('fixed_slot_drift');
  });

  it('deep-equality: array slot values match by deep equality', () => {
    interface ListArgs {
      participants: ReadonlyArray<string>;
      date: string;
    }
    const req: ActionRequest<ListArgs> = {
      args: { participants: ['Bob', 'Maya'], date: '2026-05-12' },
      fixed_slots: ['participants'],
    };
    const res: ActionResult<ListArgs> = {
      result: null,
      alternatives: [
        { args: { participants: ['Bob', 'Maya'], date: '2026-05-13' }, confidence: 0.9 },
        { args: { participants: ['Bob'], date: '2026-05-12' }, confidence: 0.7 }, // missing Maya
        { args: { participants: ['Maya', 'Bob'], date: '2026-05-12' }, confidence: 0.6 }, // ordered differently
      ],
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    // Ordering matters — shorter array drops, reordered drops
    expect(survivors.length).toBe(1);
    expect(violations.length).toBe(2);
  });

  it('substrate refuses to fabricate alternatives (§ B.6.9)', () => {
    // When every input alternative drops, the substrate returns ZERO
    // survivors — never invents replacements.
    const req = reqOf({ person: 'Mary' }, ['person']);
    const res = altsOf(
      { args: { person: 'A' }, confidence: 0.9 },
      { args: { person: 'B' }, confidence: 0.8 },
      { args: { person: 'C' }, confidence: 0.7 },
    );
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(0);
    expect(violations.length).toBe(3);
    // Substrate did NOT add a synthetic "Mary" alternative.
  });

  it('missing alternatives field (undefined) → zero survivors / zero violations', () => {
    const req = reqOf({ person: 'Mary' }, ['person']);
    const res: ActionResult<ScheduleArgs> = { result: { person: 'Mary' } };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors).toEqual([]);
    expect(violations).toEqual([]);
  });
});

describe('D-145 PB5 — Codex P1 #1 fold: deep-equality robustness', () => {
  it('Date comparison: equivalent timestamps match', () => {
    interface Args { meeting_at: Date }
    const req: ActionRequest<Args> = {
      args: { meeting_at: new Date('2026-05-12T14:00:00Z') },
      fixed_slots: ['meeting_at'],
    };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        // Different Date instance, equivalent timestamp → MATCH
        { args: { meeting_at: new Date('2026-05-12T14:00:00Z') }, confidence: 0.9 },
        // Different timestamp → DRIFT
        { args: { meeting_at: new Date('2026-05-13T14:00:00Z') }, confidence: 0.7 },
      ],
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(violations.length).toBe(1);
  });

  it('RegExp comparison: same source + flags match', () => {
    interface Args { pattern: RegExp }
    const req: ActionRequest<Args> = {
      args: { pattern: /foo/i },
      fixed_slots: ['pattern'],
    };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        { args: { pattern: /foo/i }, confidence: 0.9 }, // match
        { args: { pattern: /bar/i }, confidence: 0.7 }, // drift
        { args: { pattern: /foo/g }, confidence: 0.5 }, // drift on flag
      ],
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(violations.length).toBe(2);
  });

  it('Map / Set: distinct instances treated as not-equal (substrate stays closed)', () => {
    interface Args { tags: Set<string> }
    const sharedSet = new Set(['a', 'b']);
    const req: ActionRequest<Args> = {
      args: { tags: sharedSet },
      fixed_slots: ['tags'],
    };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        // Same reference → match
        { args: { tags: sharedSet }, confidence: 0.9 },
        // Different Set with same contents → NOT-EQUAL (substrate closed)
        { args: { tags: new Set(['a', 'b']) }, confidence: 0.7 },
      ],
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(violations.length).toBe(1);
  });

  it('NaN comparison: treats NaN === NaN', () => {
    interface Args { value: number }
    const req: ActionRequest<Args> = {
      args: { value: Number.NaN },
      fixed_slots: ['value'],
    };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        { args: { value: Number.NaN }, confidence: 0.9 },
      ],
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(violations.length).toBe(0);
  });

  it('circular plain object: WeakMap seen-pair guard prevents stack overflow', () => {
    interface Args { node: Record<string, unknown> }
    // Construct two structurally-equal cyclic objects
    const a: Record<string, unknown> = { name: 'root' };
    a.self = a;
    const b: Record<string, unknown> = { name: 'root' };
    b.self = b;
    const req: ActionRequest<Args> = {
      args: { node: a },
      fixed_slots: ['node'],
    };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        // Reference-different but structurally-equal cyclic objects.
        // Substrate must terminate without stack overflow.
        { args: { node: b }, confidence: 0.9 },
      ],
    };
    // The key assertion: this returns without throwing — the seen-pair
    // guard prevents infinite recursion.
    expect(() => enforceFixedSlots(req, res)).not.toThrow();
    const { survivors } = enforceFixedSlots(req, res);
    // Whether the cycle compares equal or not is secondary; what
    // matters is termination.
    expect(survivors.length).toBeGreaterThanOrEqual(0);
  });

  it('class instances (non-plain prototypes) treated as not-equal unless reference-identical', () => {
    class Box { constructor(public v: number) {} }
    interface Args { box: Box }
    const sharedBox = new Box(42);
    const req: ActionRequest<Args> = {
      args: { box: sharedBox },
      fixed_slots: ['box'],
    };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        { args: { box: sharedBox }, confidence: 0.9 }, // match
        { args: { box: new Box(42) }, confidence: 0.7 }, // not-equal
      ],
    };
    const { survivors, violations } = enforceFixedSlots(req, res);
    expect(survivors.length).toBe(1);
    expect(violations.length).toBe(1);
  });
});

describe('D-145 PB5 — Codex P1 #2 fold: sanitizeSlotForAudit', () => {
  it('legitimate JS identifiers pass through unchanged', () => {
    expect(sanitizeSlotForAudit('person')).toBe('person');
    expect(sanitizeSlotForAudit('vendor_role')).toBe('vendor_role');
    expect(sanitizeSlotForAudit('participants_2')).toBe('participants_2');
    expect(sanitizeSlotForAudit('_internal')).toBe('_internal');
  });

  it('replaces non-identifier chars with underscore', () => {
    expect(sanitizeSlotForAudit('person.name')).toBe('person_name');
    expect(sanitizeSlotForAudit('a b c')).toBe('a_b_c');
    expect(sanitizeSlotForAudit('<script>')).toBe('_script_');
  });

  it('prepends underscore when starting with digit', () => {
    expect(sanitizeSlotForAudit('0day')).toBe('_0day');
    expect(sanitizeSlotForAudit('123')).toBe('_123');
  });

  it('truncates over-long names with truncation marker', () => {
    const long = 'x'.repeat(120);
    const out = sanitizeSlotForAudit(long);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles non-string input via <invalid> sentinel', () => {
    expect(sanitizeSlotForAudit(undefined)).toBe('<invalid>');
    expect(sanitizeSlotForAudit(null)).toBe('<invalid>');
    expect(sanitizeSlotForAudit(42)).toBe('<invalid>');
    expect(sanitizeSlotForAudit('')).toBe('<invalid>');
  });

  it('integration: violations carry sanitized slot name (not raw AI input)', () => {
    interface Args { person: string }
    const req: ActionRequest<Args> = {
      args: { person: 'Mary' },
      // Simulate AI emitting a malicious / malformed slot name
      fixed_slots: ['<script>alert(1)</script>' as keyof Args],
    };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [{ args: { person: 'Mary' }, confidence: 0.9 }],
    };
    const { violations } = enforceFixedSlots(req, res);
    expect(violations.length).toBe(1);
    expect(violations[0]?.kind).toBe('fixed_slot_unknown_field');
    // The slot value in the audit payload is the SANITIZED form
    expect(violations[0]?.slot).not.toContain('<');
    expect(violations[0]?.slot).not.toContain('>');
    expect(violations[0]?.slot).not.toContain('(');
    expect(violations[0]?.slot).toMatch(/^[A-Za-z_][A-Za-z0-9_]*…?$/);
  });
});
