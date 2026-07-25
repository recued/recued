/** D-149 P5 § A.5.2 — slot enumeration tests. */

import { describe, expect, it } from 'vitest';
import type { FreeWindow } from '@recued/contracts';
import {
  computeSchedulingLookAheadWindow,
  enumerateSchedulingSlots,
  isSlotAmongCandidates,
} from '../ports/reception/transformations/scheduling-link-slots.js';
import type { SchedulingLinkConfig } from '@recued/contracts';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;
// 30-min-aligned: the enumerator snaps slot candidates to the tz-local clock
// grid, so NOW-relative windows must start on that grid for the step-count
// assertions below to hold (a non-aligned NOW makes the first candidate snap
// forward). `1_700_000_000_000` is 800_000 ms past a 30-min boundary.
const NOW = 1_700_000_000_000 - (1_700_000_000_000 % (30 * 60 * 1000)); // 1_699_999_200_000

describe('D-149 P5 § A.5.2 — enumerateSchedulingSlots', () => {
  it('returns no slots when free_windows is empty', () => {
    const slots = enumerateSchedulingSlots({
      free_windows: [],
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
    });
    expect(slots).toEqual([]);
  });

  it('walks 30-minute steps inside a 2-hour free window', () => {
    const windows: FreeWindow[] = [
      { start_at: NOW + 24 * HOUR, end_at: NOW + 24 * HOUR + 2 * HOUR },
    ];
    const slots = enumerateSchedulingSlots({
      free_windows: windows,
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
    });
    // 4 candidates: starts at +24h, +24h30m, +25h, +25h30m.
    expect(slots.length).toBe(4);
    expect(slots[0]!.duration_minutes).toBe(30);
    expect(slots[0]!.end_at - slots[0]!.start_at).toBe(30 * MINUTE);
  });

  it('respects min_advance_notice_hours', () => {
    const windows: FreeWindow[] = [{ start_at: NOW, end_at: NOW + 4 * HOUR }];
    const slots = enumerateSchedulingSlots({
      free_windows: windows,
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 2,
      max_lead_time_days: 7,
      now: NOW,
    });
    // Earliest slot starts at NOW+2h.
    expect(slots[0]!.start_at).toBeGreaterThanOrEqual(NOW + 2 * HOUR);
  });

  it('respects max_lead_time_days', () => {
    const windows: FreeWindow[] = [
      { start_at: NOW + 10 * DAY, end_at: NOW + 10 * DAY + HOUR },
    ];
    const slots = enumerateSchedulingSlots({
      free_windows: windows,
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
    });
    expect(slots).toEqual([]);
  });

  it('caps the candidate count at max_slots', () => {
    const windows: FreeWindow[] = [
      { start_at: NOW + HOUR, end_at: NOW + HOUR + 8 * HOUR },
    ];
    const slots = enumerateSchedulingSlots({
      free_windows: windows,
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
      max_slots: 5,
    });
    expect(slots.length).toBe(5);
  });

  it('produces a non-empty display_label per slot', () => {
    const windows: FreeWindow[] = [
      { start_at: NOW + 25 * HOUR, end_at: NOW + 25 * HOUR + HOUR },
    ];
    const slots = enumerateSchedulingSlots({
      free_windows: windows,
      duration_minutes: 30,
      tz: 'America/New_York',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
    });
    expect(slots[0]!.display_label.length).toBeGreaterThan(0);
  });

  it('falls back to UTC when the tz is invalid', () => {
    const windows: FreeWindow[] = [
      { start_at: NOW + 25 * HOUR, end_at: NOW + 25 * HOUR + HOUR },
    ];
    const slots = enumerateSchedulingSlots({
      free_windows: windows,
      duration_minutes: 30,
      tz: '<not-a-zone>',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
    });
    expect(slots[0]!.display_label.length).toBeGreaterThan(0);
  });

  // Regression — the now-clipped-window bug. Today's availability window (and a
  // 24/7 link's single contiguous window) is clipped at `now` by the look-ahead
  // lower edge, so `w.start_at` is an arbitrary (non-clock-aligned) `now`. The
  // grid must anchor to the tz-local clock, NOT to `w.start_at`, else every slot
  // is `now + k·step` and shifts between the GET slot-picker render and the POST
  // /book re-enumeration → no slot matches → every booking 409s.
  it('anchors candidates to the clock grid, stable across a later now (GET→POST)', () => {
    const STEP = 30 * MINUTE;
    const nowGet = NOW + 800_017; // deliberately NOT on the 30-min grid
    const get = enumerateSchedulingSlots({
      free_windows: [{ start_at: nowGet, end_at: nowGet + 8 * HOUR }],
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 0,
      max_lead_time_days: 7,
      now: nowGet,
    });
    expect(get.length).toBeGreaterThan(0);
    // (i) every candidate sits on the UTC clock grid — a now-independent address.
    for (const s of get) expect(s.start_at % STEP).toBe(0);

    // (ii) the POST re-enumerates a few seconds later against a window clipped
    // at the NEW now; a GET slot past that now is STILL a candidate (no 409).
    const nowPost = nowGet + 3_137;
    const post = enumerateSchedulingSlots({
      free_windows: [{ start_at: nowPost, end_at: nowPost + 8 * HOUR }],
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 0,
      max_lead_time_days: 7,
      now: nowPost,
    });
    const picked = get.find((s) => s.start_at > nowPost + STEP);
    expect(picked).toBeDefined();
    expect(
      isSlotAmongCandidates({
        candidates: post,
        slot_start_at: picked!.start_at,
        slot_end_at: picked!.end_at,
        duration_minutes: 30,
      }),
    ).toBe(true);
  });
});

describe('D-149 P5 § A.5.2 — isSlotAmongCandidates', () => {
  it('accepts an exact triple match', () => {
    const candidates = enumerateSchedulingSlots({
      free_windows: [{ start_at: NOW + 24 * HOUR, end_at: NOW + 24 * HOUR + HOUR }],
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
    });
    expect(candidates.length).toBeGreaterThan(0);
    const c = candidates[0]!;
    expect(
      isSlotAmongCandidates({
        candidates,
        slot_start_at: c.start_at,
        slot_end_at: c.end_at,
        duration_minutes: c.duration_minutes,
      }),
    ).toBe(true);
  });

  it('rejects a slot whose start_at differs by 1ms', () => {
    const candidates = enumerateSchedulingSlots({
      free_windows: [{ start_at: NOW + 24 * HOUR, end_at: NOW + 24 * HOUR + HOUR }],
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
    });
    const c = candidates[0]!;
    expect(
      isSlotAmongCandidates({
        candidates,
        slot_start_at: c.start_at + 1,
        slot_end_at: c.end_at,
        duration_minutes: c.duration_minutes,
      }),
    ).toBe(false);
  });

  it('rejects a slot with mismatched duration_minutes', () => {
    const candidates = enumerateSchedulingSlots({
      free_windows: [{ start_at: NOW + 24 * HOUR, end_at: NOW + 24 * HOUR + HOUR }],
      duration_minutes: 30,
      tz: 'UTC',
      min_advance_notice_hours: 1,
      max_lead_time_days: 7,
      now: NOW,
    });
    const c = candidates[0]!;
    expect(
      isSlotAmongCandidates({
        candidates,
        slot_start_at: c.start_at,
        slot_end_at: c.end_at,
        duration_minutes: 60,
      }),
    ).toBe(false);
  });
});

describe('D-149 P5 § A.5.2 — computeSchedulingLookAheadWindow', () => {
  it('window_end - window_start === max_lead_time_days', () => {
    const config = {
      max_lead_time_days: 14,
    } as unknown as SchedulingLinkConfig;
    const { window_start, window_end } = computeSchedulingLookAheadWindow({ config, now: NOW });
    expect(window_start).toBe(NOW);
    expect(window_end - window_start).toBe(14 * DAY);
  });
});
