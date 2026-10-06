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
  it('discloses exact owner requests and source snapshots even without an AI summary', () => {
    const m = buildCarriedBriefModel({ source_evidence: { version: 1,
      investigation_request: 'Phone decision: do not contact anyone.', owner_updates: ['Make it shorter.'],
      observations: [{ tool_name: 'mail.read', status: 'ok', result: { hot_fields: { subject: 'Replacement request' },
        received_at_iso: '2026-10-01T00:00:00Z', body: 'Explore documentation only.', body_incomplete: true } },
      { tool_name: 'work.search', status: 'ok', args: { query: 'Cobalt' }, result: { entities: [] } }] } });
    if (m.kind !== 'carrying') throw new Error('Expected visible carry with Clear control');
    expect(m.caveat).toContain('source snapshots');
    expect(m.caveat).not.toContain('not a record of what you said');
    expect(m.rows.filter(r => r.from_owner).map(r => r.text)).toEqual(['Phone decision: do not contact anyone.', 'Make it shorter.']);
    expect(m.rows.find(r => r.text.includes('documentation'))?.text).toContain('partial message');
    expect(m.rows.at(-1)?.text).toContain('0 results in this search');
    for (const row of m.rows) expect(CARRIED_BRIEF_FIELD_LABELS[row.field]).toBeTruthy();
  });
  it('keeps loading, empty and carrying apart', () => {
    // ⛔ "nothing carried" and "we have not asked" look identical on screen and
    //   mean opposite things.
    expect(buildCarriedBriefModel(undefined).kind).toBe('loading');
    expect(buildCarriedBriefModel(null).kind).toBe('empty');
    expect(buildCarriedBriefModel(brief()).kind).toBe('carrying');
  });

  it('carries the caveat WITH the notes, under the name Settings uses', () => {
    const m = buildCarriedBriefModel(brief());
    if (m.kind !== 'carrying') throw new Error('unreachable');
    expect(m.heading).toBe("Chat's running note");
    expect(m.caveat).toMatch(/in its own words/i);
    expect(m.caveat).toMatch(/missing things, or wrong/i);
  });

  /** ⛔ The empty panel printed "Nothing carried yet" over the caveat, and the
   *  caveat — "This is what Chat is carrying forward…" — pointed at nothing, so
   *  it read as a caption for the conversation below. Nothing carried now
   *  means nothing shown: no heading, no caveat, no rows to lend it. */
  it('has nothing to show when nothing is carried', () => {
    for (const input of [null, brief({ constraints: [], findings: [], pending: [], intent: '' })]) {
      expect(buildCarriedBriefModel(input)).toEqual({ kind: 'empty' });
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
    expect(m).toEqual({ kind: 'empty' });
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
