/** D-269 step 3 follow-on — "10pm–8am" is not a legible statement of a window.
 *
 *  ⛔⛔ THE OWNER'S POINT, WHICH IS THE WHOLE TEST. A wall-clock window lives in
 *  the SERVER's zone, and the times alone hide two things at once: WHICH 8am,
 *  and whether the viewer's clock even crosses midnight at the same end. A
 *  22:00→07:00 Hong Kong window is 15:00→00:00 in London — it crosses at the
 *  close in one and at the open in the other.
 *
 *  ⇒ So the surface shows what was SET and what it ACTUALLY MEANS, with full
 *  dates in both clocks. */

import { describe, expect, it } from 'vitest';
import {
  resolveQuietHoursOccurrence,
  defaultQuietHoursPolicy,
} from '@recued/contracts';
import { twoClockWindowPreview } from '@recued/ui-shared';

const HK = 'Asia/Hong_Kong';
const LDN = 'Europe/London';
const NIGHT_POLICY = { from_minute: 22 * 60, to_minute: 7 * 60 };

/** 10:00 Hong Kong on Mon 15 June — before that night's window opens. */
const MORNING = Date.parse('2026-06-15T02:00:00Z');
/** 02:00 Hong Kong on Tue 16 June — inside it. */
const INSIDE = Date.parse('2026-06-15T18:00:00Z');

describe('D-269 — the occurrence is CONCRETE, not two wall times', () => {
  it('🔑 resolves real instants, and the close lands on the NEXT local day', () => {
    const occ = resolveQuietHoursOccurrence(NIGHT_POLICY, HK, MORNING)!;
    expect(new Date(occ.start).toISOString()).toBe('2026-06-15T14:00:00.000Z'); // 22:00 HK Mon
    expect(new Date(occ.end).toISOString()).toBe('2026-06-15T23:00:00.000Z');   // 07:00 HK Tue
    expect(occ.end).toBeGreaterThan(occ.start);
    expect(occ.active).toBe(false);
  });

  it('⚠ shows the occurrence you are IN, not always the next one', () => {
    // Asked at 02:00 inside the window, "the next occurrence" is tonight —
    // true and useless. What the owner wants to read is "quiet until 07:00
    // this morning".
    const occ = resolveQuietHoursOccurrence(NIGHT_POLICY, HK, INSIDE)!;
    expect(occ.active).toBe(true);
    expect(occ.start).toBeLessThanOrEqual(INSIDE);
    expect(occ.end).toBeGreaterThan(INSIDE);
  });

  it('an empty window has no occurrence to draw', () => {
    expect(resolveQuietHoursOccurrence({ from_minute: 60, to_minute: 60 }, HK, MORNING))
      .toBeNull();
  });

  it('a same-day window resolves within one local date', () => {
    const occ = resolveQuietHoursOccurrence({ from_minute: 13 * 60, to_minute: 14 * 60 }, HK, MORNING)!;
    expect(occ.end - occ.start).toBe(60 * 60 * 1000);
  });

  it('⚠ the close is the local WALL TIME, not start + duration', () => {
    // Across a DST transition the window is not a fixed number of hours.
    // "I sleep until 7" means 7, not "nine hours after 10". London springs
    // forward 2026-03-29, so that night's 22:00→07:00 is one hour SHORT.
    const beforeUk = Date.parse('2026-03-28T12:00:00Z');
    const occ = resolveQuietHoursOccurrence(NIGHT_POLICY, LDN, beforeUk)!;
    expect(occ.end - occ.start).toBe(8 * 60 * 60 * 1000);
  });
});

describe('D-269 — the display the owner asked for', () => {
  const view = (clientZone: string, at: number) => {
    const occ = resolveQuietHoursOccurrence(NIGHT_POLICY, HK, at)!;
    return twoClockWindowPreview({
      serverZone: HK, clientZone, start: occ.start, end: occ.end, active: occ.active,
      fromMinute: NIGHT_POLICY.from_minute, toMinute: NIGHT_POLICY.to_minute,
      locale: 'en-GB',
    });
  };

  it('states what was SET, zone-free, exactly as typed', () => {
    expect(view(HK, MORNING).declared_text).toBe('22:00 → 07:00');
  });

  it('⛔⛔ BOTH ROWS CARRY DATES — that is the part the times hide', () => {
    const v = view(LDN, MORNING);
    expect(v.rows).toHaveLength(2);
    for (const row of v.rows) {
      // A date, not just a clock time. The row without one is the row a reader
      // assumes is "today", and here that guess is wrong half the time.
      expect(row.start_text).toMatch(/\d{1,2}\s+\w{3}/);
      expect(row.end_text).toMatch(/\d{1,2}\s+\w{3}/);
    }
  });

  it('⛔⛔ THE TWO ZONES CROSS MIDNIGHT AT DIFFERENT ENDS — the reason dates are mandatory', () => {
    const v = view(LDN, MORNING);
    const [server, browser] = v.rows;
    // Server: Mon 22:00 → Tue 07:00 — crosses.
    expect(server!.crosses_date).toBe(true);
    // Browser: Mon 15:00 → Tue 00:00 — 00:00 is already the next day, so it
    // crosses too, but at the OPEN end of the reading rather than the close.
    // Either way the bare times "15:00 → 00:00" say nothing about which day.
    expect(browser!.crosses_date).toBe(true);
    expect(v.diverged).toBe(true);
  });

  it('⚠ a viewer in the SERVER\'s zone still gets dates — no collapse for a window', () => {
    // The opposite call from the instant preview, where an identical second row
    // is noise. For a window the date IS the content, so both rows always show.
    const v = view(HK, MORNING);
    expect(v.rows).toHaveLength(2);
    expect(v.diverged).toBe(false);
    expect(v.rows[0]!.crosses_date).toBe(true);
  });

  it('the rows stay asymmetric — the browser row is a translation, not a control', () => {
    expect(view(LDN, MORNING).rows.map((r) => r.role))
      .toEqual(['authoritative', 'translation']);
  });

  it('reports whether the owner is inside the window right now', () => {
    expect(view(HK, MORNING).active).toBe(false);
    expect(view(HK, INSIDE).active).toBe(true);
  });

  it('the default window is the familiar one', () => {
    const d = defaultQuietHoursPolicy();
    expect(d.from_minute).toBe(22 * 60);
    expect(d.to_minute).toBe(7 * 60);
  });
});
