/** D-149 P5 § A.5.2 — Slot enumeration helpers.
 *
 *  Pure transforms over a `FreeWindow[]` + scheduling-link config →
 *  visitor-safe slot list. The substrate keeps these out of the HTML
 *  renderer so the rendering layer stays purely string-substitution;
 *  the slot math + advance-notice / lead-time gating happens here.
 *
 *  No-leak invariant: this module reads only event-free FreeWindow
 *  intervals + the config's time bounds. Calendar event titles /
 *  attendees / agendas are never inputs — they were already dropped
 *  upstream at `computeFreeWindows` per the redacted-packet substrate.
 *
 *  Spec: docs/d-149-spec.md § A.5.2 + § A.18.6. */

import type {
  FreeWindow,
  SchedulingLinkConfig,
  SchedulingLinkExplicitWindow,
} from '@recued/contracts';

/** A renderable booking slot. The substrate enumerates these from the
 *  free windows + config; the renderer emits them as `<option>` items
 *  in the slot picker. */
export interface SchedulingSlotCandidate {
  readonly start_at: number;
  readonly end_at: number;
  readonly duration_minutes: number;
  readonly display_label: string;
}

/** Step size between adjacent slot start_at candidates. The substrate
 *  steps by `min(duration_minutes, 30)` minutes inside each free
 *  window so adjacent slots don't fully overlap + the visitor's pick
 *  list stays bounded. */
const SLOT_STEP_FLOOR_MINUTES = 30;

const MS_PER_MINUTE = 60 * 1000;

/** Format a slot timestamp for the visitor-facing display. Uses the
 *  configured tz; the substrate falls back to UTC if `Intl.DateTimeFormat`
 *  rejects the tz string (e.g. typo in config). Pure function — the
 *  tz string is treated as opaque to `Intl`. */
const formatSlotLabel = (
  start_at: number,
  end_at: number,
  tz: string,
): string => {
  const safeTz = (() => {
    try {
      // Probe by formatting a known timestamp; if `Intl` throws on a
      // bad zone name we fall back to UTC.
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
      return tz;
    } catch {
      return 'UTC';
    }
  })();
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    hour: 'numeric',
    minute: '2-digit',
  });
  const dayPart = dateFmt.format(new Date(start_at));
  const startPart = timeFmt.format(new Date(start_at));
  const endPart = timeFmt.format(new Date(end_at));
  return `${dayPart} · ${startPart}–${endPart}`;
};

/** Enumerate slot candidates inside the free windows. Steps by
 *  `min(duration, SLOT_STEP_FLOOR_MINUTES)` minutes. Each candidate
 *  is gated by advance-notice + lead-time + the free window's bounds.
 *  Pure function — no clock read inside; caller supplies `now`. */
export const enumerateSchedulingSlots = (input: {
  free_windows: ReadonlyArray<FreeWindow>;
  duration_minutes: number;
  tz: string;
  min_advance_notice_hours: number;
  max_lead_time_days: number;
  now: number;
  /** Cap on the number of candidate slots in the returned list.
   *  Defaults to 200; bounds the rendered `<select>` payload. */
  max_slots?: number;
}): ReadonlyArray<SchedulingSlotCandidate> => {
  const out: SchedulingSlotCandidate[] = [];
  const maxSlots = input.max_slots ?? 200;
  const durationMs = input.duration_minutes * MS_PER_MINUTE;
  const stepMinutes = Math.min(input.duration_minutes, SLOT_STEP_FLOOR_MINUTES);
  const stepMs = stepMinutes * MS_PER_MINUTE;
  const earliestStart = input.now + input.min_advance_notice_hours * 60 * MS_PER_MINUTE;
  const latestStart = input.now + input.max_lead_time_days * 24 * 60 * MS_PER_MINUTE;
  for (const w of input.free_windows) {
    if (out.length >= maxSlots) break;
    // Skip windows that don't fit a single slot.
    if (w.end_at - w.start_at < durationMs) continue;
    // Snap the cursor up to the next tz-local clock-grid boundary so
    // candidates are clock-aligned + `now`-INDEPENDENT (stable across the
    // GET slot-picker render and the POST /book re-enumeration). Anchoring
    // to `w.start_at` is wrong: today's availability window (and a 24/7
    // link's single contiguous window) is clipped at `now` by the look-ahead
    // lower edge, so a start_at-anchored grid rides `now` and every pick
    // then fails `isSlotAmongCandidates` → 409. See `snapUpToTzClockGrid`.
    let cursor = snapUpToTzClockGrid(Math.max(w.start_at, earliestStart), stepMs, input.tz);
    while (cursor + durationMs <= w.end_at) {
      if (cursor > latestStart) break;
      if (cursor < earliestStart) {
        cursor += stepMs;
        continue;
      }
      const endAt = cursor + durationMs;
      out.push({
        start_at: cursor,
        end_at: endAt,
        duration_minutes: input.duration_minutes,
        display_label: formatSlotLabel(cursor, endAt, input.tz),
      });
      if (out.length >= maxSlots) break;
      cursor += stepMs;
    }
  }
  return out;
};

/** Validate a visitor-submitted slot against the enumerated candidate
 *  set. Returns true iff the submitted `(start_at, end_at, duration)`
 *  triple matches one of the enumerated candidates by VALUE. Substrate-
 *  level defense: even if the visitor crafts a payload that bypasses
 *  the client-side `<select>`, the POST handler re-enumerates against
 *  the current free-window snapshot + rejects mismatches. */
export const isSlotAmongCandidates = (input: {
  candidates: ReadonlyArray<SchedulingSlotCandidate>;
  slot_start_at: number;
  slot_end_at: number;
  duration_minutes: number;
}): boolean => {
  for (const c of input.candidates) {
    if (
      c.start_at === input.slot_start_at &&
      c.end_at === input.slot_end_at &&
      c.duration_minutes === input.duration_minutes
    ) {
      return true;
    }
  }
  return false;
};

/** Compute the look-ahead window the GET handler passes to
 *  `computeFreeWindows`. Bounded by config's `max_lead_time_days`
 *  + advance-notice floor; the lower edge is `now` (event-free
 *  conflict check considers any event overlapping the look-ahead). */
export const computeSchedulingLookAheadWindow = (input: {
  config: SchedulingLinkConfig;
  now: number;
}): { window_start: number; window_end: number } => {
  const window_start = input.now;
  const window_end = input.now + input.config.max_lead_time_days * 24 * 60 * MS_PER_MINUTE;
  return { window_start, window_end };
};

// ────────────────────────────────────────────────────────────────
// Codex review fold (P1 #1, 2026-05-13) — apply availability windows
// ────────────────────────────────────────────────────────────────

/** Compute the IANA-offset (in minutes east of UTC) for `at` under
 *  `tz`. Pure function over `Intl.DateTimeFormat` — Node 16+ supports
 *  the full IANA database. Falls back to 0 (UTC) when the tz is
 *  unrecognized; the validator pre-rejects empty tz strings, so the
 *  fallback only fires for malformed-but-validator-passing inputs. */
const tzOffsetMinutes = (at: number, tz: string): number => {
  try {
    // Format the same instant in `tz` + UTC; the delta is the offset.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(at));
    const get = (type: string): number => {
      const part = parts.find((p) => p.type === type);
      return part ? parseInt(part.value, 10) : 0;
    };
    let hour = get('hour');
    // Intl emits 24 for midnight in some locales; normalize.
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return Math.round((asUtc - at) / MS_PER_MINUTE);
  } catch {
    return 0;
  }
};

/** Smallest instant ≥ `at` whose tz-LOCAL wall clock falls on the `stepMs`
 *  grid measured from tz-local midnight — so slots land on stable clock
 *  boundaries (:00 / :30) regardless of where the free window starts.
 *
 *  The enumerator must NOT anchor the grid to a window's own `start_at`:
 *  today's availability window (and a 24/7 link's single contiguous window)
 *  is clipped at `now` by the look-ahead lower edge, so a start_at-anchored
 *  grid rides the arbitrary `now` value and is not clock-aligned. That grid
 *  shifts between the GET slot-picker render and the POST /book re-enumeration
 *  (read `now` milliseconds apart), so every visitor pick then fails
 *  `isSlotAmongCandidates` and the booking 409s. A fixed tz-local clock grid
 *  is `now`-independent → identical across re-render. Already-aligned windows
 *  (e.g. a tz-local 09:00 future-day window) are unchanged (phase 0 → no-op).
 *
 *  Pure — no clock read. A DST jump within a single step is ignored: the
 *  15/30-min step sizes divide evenly into any whole/half-hour offset change,
 *  so the grid phase is preserved across the transition.
 *
 *  Tradeoff (intended): a configured availability window whose start is NOT on
 *  the step grid (e.g. an explicit_window `start_minute` of 9:15 with a 30-min
 *  step) yields its first slot at the next grid boundary (9:30), not at 9:15 —
 *  candidates are clock-aligned by design. A narrow sub-grid window (e.g.
 *  9:15–9:45) can therefore yield no slot; the visitor sees the empty-slot
 *  copy. Grid-aligned hours (the common case — :00 / :15 / :30) are unchanged. */
const snapUpToTzClockGrid = (at: number, stepMs: number, tz: string): number => {
  const oneDayMs = 24 * 60 * MS_PER_MINUTE;
  const wallClockMs = at + tzOffsetMinutes(at, tz) * MS_PER_MINUTE;
  const msIntoDay = ((wallClockMs % oneDayMs) + oneDayMs) % oneDayMs;
  const phase = msIntoDay % stepMs;
  return phase === 0 ? at : at + (stepMs - phase);
};

/** Codex review fold (P1 #1) — intersect a free-window set with the
 *  configured per-day availability windows. The substrate's
 *  `computeFreeWindows` only subtracts calendar-busy events; without
 *  this intersection a link configured for "Mon 9-5" can render slots
 *  at any unbusy time in the look-ahead. The intersection happens at
 *  millisecond granularity in `tz`-local time so a window like
 *  `(day_of_week=1, start_minute=540, end_minute=1020)` becomes
 *  "Monday 09:00-17:00 in `tz`" on every Monday inside
 *  `[window_start, window_end)`.
 *
 *  Standing Instructions are NOT evaluated here — per spec § A.5.2
 *  line 654 the SI eval is engine-side at reactive-trigger time, NOT
 *  visitor-thread path.
 *
 *  D-173 P4.2 — empty `explicit_windows` FAILS CLOSED (returns []), not
 *  open. D-149 returned `free_windows` unchanged here, deferring all
 *  narrowing to an engine-side Standing-Instructions evaluation at
 *  confirmation time. But D-173 makes native scheduling live cold-start
 *  with the null calendar reader (no busy events → `computeFreeWindows`
 *  yields the entire look-ahead as free), and the engine-side SI path is
 *  out of v1 scope (PB10). Passing the full look-ahead through would let
 *  an `available_window_definition` with a `standing_instructions_ref`
 *  but no `explicit_windows[]` advertise EVERY time in the look-ahead as
 *  bookable. Per D7 the native availability source IS `explicit_windows`;
 *  none declared ⇒ no availability ⇒ zero slots. The config validator
 *  still accepts SI-only configs as a forward-compat shape — they simply
 *  surface no visitor slots until explicit windows (or a future real
 *  availability source) land.
 *
 *  Pure function — no I/O, no clock read. */
export const intersectWithAvailabilityWindows = (input: {
  free_windows: ReadonlyArray<FreeWindow>;
  explicit_windows: ReadonlyArray<SchedulingLinkExplicitWindow>;
  tz: string;
  window_start: number;
  window_end: number;
}): ReadonlyArray<FreeWindow> => {
  if (input.explicit_windows.length === 0) return [];
  // Enumerate availability-allowed intervals across every day in the
  // look-ahead range. For each day, for each explicit_window matching
  // that day-of-week, emit `[startOfDay+start_minute, startOfDay+end_minute)`
  // in `tz`-local time, converted back to unix-ms.
  const allowed: Array<FreeWindow> = [];
  // Use a single-day-of-day-walk: step from window_start in 24h chunks
  // until we pass window_end. For each day, compute the day_of_week in
  // `tz` and emit matching windows.
  // Pull the tz-local midnight of `window_start` as the anchor.
  const oneDayMs = 24 * 60 * MS_PER_MINUTE;
  for (let cursor = input.window_start - oneDayMs; cursor < input.window_end + oneDayMs; cursor += oneDayMs) {
    // Compute the tz-local Y/M/D at `cursor` so we can emit a window
    // anchored at tz-local midnight.
    const offsetMinutes = tzOffsetMinutes(cursor, input.tz);
    const tzLocalCursor = cursor + offsetMinutes * MS_PER_MINUTE;
    const d = new Date(tzLocalCursor);
    // Use the UTC accessors because we shifted by the tz offset.
    const tzYear = d.getUTCFullYear();
    const tzMonth = d.getUTCMonth();
    const tzDay = d.getUTCDate();
    const tzDow = d.getUTCDay(); // 0=Sun..6=Sat in tz-local
    for (const w of input.explicit_windows) {
      if (w.day_of_week !== tzDow) continue;
      const startTzLocalMs = Date.UTC(tzYear, tzMonth, tzDay, 0, 0, 0) + w.start_minute * MS_PER_MINUTE;
      const endTzLocalMs = Date.UTC(tzYear, tzMonth, tzDay, 0, 0, 0) + w.end_minute * MS_PER_MINUTE;
      // Convert back from tz-local to UTC ms using the offset at the
      // window's actual start instant (DST-safe-ish — recompute offset
      // at the candidate start so spring-forward / fall-back days
      // intersect against the visitor-displayed wall clock).
      const startUtc = startTzLocalMs - tzOffsetMinutes(startTzLocalMs - offsetMinutes * MS_PER_MINUTE, input.tz) * MS_PER_MINUTE;
      const endUtc = endTzLocalMs - tzOffsetMinutes(endTzLocalMs - offsetMinutes * MS_PER_MINUTE, input.tz) * MS_PER_MINUTE;
      // Clip to the look-ahead window.
      const s = Math.max(startUtc, input.window_start);
      const e = Math.min(endUtc, input.window_end);
      if (e > s) allowed.push({ start_at: s, end_at: e });
    }
  }
  // Sort + merge adjacent allowed intervals (handles DST overlap).
  // Mutable shape locally; convert to readonly at return time.
  allowed.sort((a, b) => a.start_at - b.start_at);
  type MutableInterval = { start_at: number; end_at: number };
  const mergedAllowed: MutableInterval[] = [];
  for (const a of allowed) {
    const last = mergedAllowed[mergedAllowed.length - 1];
    if (last && a.start_at <= last.end_at) {
      last.end_at = Math.max(last.end_at, a.end_at);
    } else {
      mergedAllowed.push({ start_at: a.start_at, end_at: a.end_at });
    }
  }
  // Intersect free_windows with allowed.
  const result: Array<FreeWindow> = [];
  for (const f of input.free_windows) {
    for (const a of mergedAllowed) {
      const s = Math.max(f.start_at, a.start_at);
      const e = Math.min(f.end_at, a.end_at);
      if (e > s) result.push({ start_at: s, end_at: e });
    }
  }
  return result;
};
