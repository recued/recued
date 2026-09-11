/** The owner-visible carry. ⛔ The framing is the feature as much as the rows
 *  are: the brief is an INTERPRETATION asserting values at 98.4% accuracy, so a
 *  surface that showed it as fact would lend a wrong value the credibility of
 *  being displayed. These pin that the caveat cannot be rendered away. */

import { describe, expect, it } from 'vitest';

import {
  buildCarriedBriefModel,
  CARRIED_BRIEF_FIELD_LABELS,
} from '../chat/carried-brief.js';

const brief = (over: Record<string, unknown> = {}) => ({
  intent: 'price the Meridian job',
  constraints: ['Bonded-warehouse levy is 318 units — verbal, in no block'],
  findings: ['Block 01 records mooring rotation'],
  pending: ['add up the four charges'],
  completed: [],
  ...over,
});

describe('carried-brief projection', () => {
  it('keeps loading, empty and carrying apart', () => {
    // ⛔ "nothing carried" and "we have not asked" look identical on screen and
    //   mean opposite things.
    expect(buildCarriedBriefModel(undefined).kind).toBe('loading');
    expect(buildCarriedBriefModel(null).kind).toBe('empty');
    expect(buildCarriedBriefModel(brief()).kind).toBe('carrying');
  });

  it('carries the caveat in every non-loading state', () => {
    for (const input of [null, brief(), brief({ constraints: [], findings: [], pending: [], intent: '' })]) {
      const m = buildCarriedBriefModel(input);
      if (m.kind === 'loading') throw new Error('unreachable');
      expect(m.caveat).toMatch(/in its own words/i);
      expect(m.caveat).toMatch(/incomplete or wrong/i);
    }
  });

  it('puts owner-originated content FIRST and flags it', () => {
    const m = buildCarriedBriefModel(brief());
    if (m.kind !== 'carrying') throw new Error('unreachable');
    // intent frames, then what the OWNER said — the field a reader can check
    // against their own memory, and the one nothing can re-derive.
    expect(m.rows[0]?.field).toBe('intent');
    expect(m.rows[1]?.field).toBe('constraints');
    expect(m.rows[1]?.from_owner).toBe(true);
    expect(m.rows.filter(r => r.from_owner).map(r => r.field)).toEqual(['constraints']);
  });

  it('a brief with only empty fields is EMPTY, not a heading over nothing', () => {
    const m = buildCarriedBriefModel(brief({ intent: '  ', constraints: [], findings: [], pending: [] }));
    // ⚠ Narrow before reading `rows`: the loading variant has none, and vitest
    //   would not have said so — `typecheck:tests` is the gate that does.
    if (m.kind !== 'empty') throw new Error('expected empty');
    expect(m.rows).toEqual([]);
  });

  it('drops non-string junk rather than rendering it', () => {
    const m = buildCarriedBriefModel(brief({ constraints: ['real', 42, null, '  '] }));
    if (m.kind !== 'carrying') throw new Error('unreachable');
    expect(m.rows.filter(r => r.field === 'constraints').map(r => r.text)).toEqual(['real']);
  });

  it('a non-object brief reads as empty, never as a crash', () => {
    for (const junk of ['a string', 42, [], true]) {
      expect(buildCarriedBriefModel(junk).kind).toBe('empty');
    }
  });

  it('every field the projection can emit has an owner-facing label', () => {
    const m = buildCarriedBriefModel(brief());
    if (m.kind !== 'carrying') throw new Error('unreachable');
    for (const row of m.rows) expect(CARRIED_BRIEF_FIELD_LABELS[row.field]).toBeTruthy();
  });
});
