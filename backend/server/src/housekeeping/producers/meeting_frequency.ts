/** D-131 A.9 — `meeting_frequency` enrichment producer.
 *
 *  Fourth and final contact-scope deterministic-aggregate producer
 *  (closes the A.6 / A.7 / A.8 / A.9 quartet). Calendar-only
 *  `aggregate` policy keyed on the contact's canonical email — for
 *  each contact, surfaces rolling per-week / per-month cadence plus a
 *  90d trend signal. Recipes use the trend as a leading indicator for
 *  projects ramping up (`'accelerating'`) or cooling down
 *  (`'decelerating'`).
 *
 *  Output shape (`MeetingFrequencyValue`):
 *    - `events_total`            — all-time event count (organizer or attendee)
 *    - `events_window_short`     — events involving the contact in the
 *                                  short window (default 30d; see
 *                                  `window_ms`). Renamed from
 *                                  `events_30d` at D-136 P3 follow-up.
 *    - `events_window_long`      — events involving the contact in the
 *                                  long window (default 90d; 3 × short).
 *                                  Renamed from `events_90d`.
 *    - `per_week_window_short`   — events_window_short * 7 / 30
 *    - `per_month_window_long`   — events_window_long / 3
 *    - `trend`                   — 'accelerating' | 'stable' | 'decelerating' | null
 *    - `last_event_at`           — most recent event start_at, null when none
 *    - `computed_at`             — `ctx.now()` of this run
 *    - `window_ms`               — short-window aperture in ms (D-136 §A.10)
 *
 *  Trend math:
 *    - baseline_events = events_window_long - events_window_short
 *      (events that fell into the long window but not the short one)
 *    - if (baseline_events + events_window_short) < 2: trend = null
 *      (combined sample too small for a meaningful comparison)
 *    - baseline_rate = baseline_events / 2  (60-day window = 2 months)
 *    - recent_rate   = events_window_short  (30-day window = 1 month)
 *    - effective_baseline = max(baseline_rate, 0.5)  (avoid div spikes
 *      on very low baselines — without this, "0 → 1 event" would
 *      report ratio=∞ which isn't actionable signal)
 *    - ratio = recent_rate / effective_baseline
 *    - ratio >= 1.5: 'accelerating'
 *    - ratio <= 0.5: 'decelerating'
 *    - else:         'stable'
 *
 *  Window choice: 30d short for `per_week_window_short` /
 *  recent-trend-half (a 30d window divides cleanly into ≈ 4.286
 *  weeks); 90d long for `per_month_window_long` / wider context
 *  (catches monthly + most quarterly cycles, same rationale as
 *  `attendee_patterns`).
 *
 *  Failure modes:
 *    - Contact has no calendar events → `produce` returns `null`;
 *      harness skips. Mail-only contacts get the other quartet rows
 *      but not this one.
 *    - Calendar tables absent (fresh server) → SQL scan returns
 *      empty; null return.
 *    - Malformed `hot_fields` JSON → row skipped, aggregation
 *      continues. Same defense as A.6 / A.7 / A.8.
 *
 *  Spec: internal design notes line 47 +
 *        `ENRICHMENT_REGISTRY.meeting_frequency`. */

import {
  type ContactRecord,
  type MeetingFrequencyValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { collectAddresses } from './_email-addresses.js';
import {
  contactAddresses,
  likeAnyParams,
  matchesAnyAddress,
  sqlLikeAny,
} from './_contact-addresses.js';

/** 30-day rolling window for the per-week + recent-trend-half. */
const WINDOW_30D_MS = 30 * 86_400_000;

/** 90-day rolling window for the per-month + wider context. */
const WINDOW_90D_MS = 90 * 86_400_000;

/** Combined-sample minimum for `trend` to be non-null. Below this the
 *  signal is too noisy — one event in a 90-day window doesn't
 *  establish a baseline either way. */
const TREND_MIN_COMBINED_SAMPLE = 2;

/** Floor on baseline rate to avoid div-by-zero spikes. With this
 *  floor, "0 baseline + 2 recent" computes ratio = 2/0.5 = 4
 *  → accelerating, which is the right call ("you went from no
 *  meetings to 2/month"). Without it, the same input would compute
 *  ratio = ∞ — same outcome categorically, but the explicit floor
 *  documents intent. */
const TREND_BASELINE_FLOOR_PER_MONTH = 0.5;

/** Acceleration threshold — recent rate ≥ 1.5× effective baseline
 *  flips trend to `'accelerating'`. Chosen so a contact going from
 *  1 meeting/month to 2 meetings/month registers as accelerating
 *  (ratio = 2.0 ≥ 1.5) without flagging modest noise (1.2× would
 *  fire too often on a single extra meeting). */
const TREND_ACCEL_THRESHOLD = 1.5;

/** Deceleration threshold — recent rate ≤ 0.5× effective baseline
 *  flips trend to `'decelerating'`. Symmetric pair to
 *  `TREND_ACCEL_THRESHOLD` (0.5 = 1/2; 1.5 ≈ 3/2). A contact going
 *  from 4 meetings/month to 2 meetings/month registers as decelerating
 *  (ratio = 0.5 = 0.5). */
const TREND_DECEL_THRESHOLD = 0.5;

/** Hot-field keys read off calendar rows. Mirrors `hashCalendarRecord`
 *  in `source-walkers.ts` (the canonical calendar hash). */
const CAL_ORGANIZER_KEY = 'organizer';
const CAL_ATTENDEES_KEY = 'attendees';
const CAL_START_AT_KEY = 'start_at';

interface CalendarScanRow {
  hot_fields: Record<string, unknown>;
}

/** Find every `collection_calendar_*` table on the live database.
 *  Same prefix-scan approach `attendee_patterns` uses. */
const listCalendarCollectionTables = (ctx: HousekeepingContext): string[] => {
  const rows = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_calendar_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
};

/** Pull every calendar row whose canonical addresses involve ANY of the
 *  contact's addresses. JSON-LIKE pre-narrow + JS canonical match — same shape
 *  as `attendee_patterns.collectCalendarRows`.
 *
 *  D-205 #3.5 — `addresses` is the contact's whole merge group, so a meeting the
 *  person was invited to under an address they later merged away still counts. */
const collectCalendarRows = (
  ctx: HousekeepingContext,
  addresses: readonly string[],
): CalendarScanRow[] => {
  if (addresses.length === 0) return [];
  const out: CalendarScanRow[] = [];
  for (const table of listCalendarCollectionTables(ctx)) {
    const rows = ctx.db
      .prepare(
        `SELECT hot_fields FROM "${table}"
          WHERE ${sqlLikeAny('hot_fields', addresses.length)}`,
      )
      .all(...likeAnyParams(addresses)) as Array<{ hot_fields: string }>;
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.hot_fields) as Record<string, unknown>;
      } catch {
        continue;
      }
      const all = new Set<string>();
      collectAddresses(parsed[CAL_ORGANIZER_KEY], all);
      collectAddresses(parsed[CAL_ATTENDEES_KEY], all);
      if (matchesAnyAddress(all, addresses)) {
        out.push({ hot_fields: parsed });
      }
    }
  }
  return out;
};

/** Categorize the trend given recent + baseline event counts. Returns
 *  `null` when the combined sample is too small. Pure function for
 *  ease of unit testing in isolation. */
export const categorizeTrend = (
  events_window_short: number,
  baseline_events: number,
): MeetingFrequencyValue['trend'] => {
  if (events_window_short + baseline_events < TREND_MIN_COMBINED_SAMPLE) return null;
  const baseline_rate_per_month = baseline_events / 2;
  const recent_rate_per_month = events_window_short;
  const effective_baseline = Math.max(
    baseline_rate_per_month,
    TREND_BASELINE_FLOOR_PER_MONTH,
  );
  const ratio = recent_rate_per_month / effective_baseline;
  if (ratio >= TREND_ACCEL_THRESHOLD) return 'accelerating';
  if (ratio <= TREND_DECEL_THRESHOLD) return 'decelerating';
  return 'stable';
};

/** Per-record token estimate. Meeting frequency is fully deterministic
 *  — pure SQL aggregation + arithmetic. Zero-token, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

export const meetingFrequencyProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'meeting_frequency',
  source_scope: 'contact',
  scope_read_declaration: [
    {
      collection: 'data.contact',
      // `merged_into`: the calendar scan reads the merge graph to widen itself
      // across the contact's absorbed addresses (D-205 #3.5).
      sample_field_paths: ['email', 'merged_into'],
    },
    {
      collection: 'data.calendar',
      sample_field_paths: ['organizer', 'attendees', 'start_at'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '7d',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;
    // D-205 #3.5 — every address this contact answers to.
    const addresses = contactAddresses(ctx, email);
    if (addresses.length === 0) return null;
    const now = ctx.now();
    const thirtyDaysAgo = now - WINDOW_30D_MS;
    const ninetyDaysAgo = now - WINDOW_90D_MS;

    const calendar_rows = collectCalendarRows(ctx, addresses);
    if (calendar_rows.length === 0) {
      // Mail-only contact (or pre-source manual entry) — nothing to
      // record. The other quartet members cover those contacts;
      // `meeting_frequency` is opt-in via calendar presence.
      return null;
    }

    const events_total = calendar_rows.length;
    let events_window_short = 0;
    let events_window_long = 0;
    let last_event_at: number | null = null;

    for (const row of calendar_rows) {
      const startAtRaw = row.hot_fields[CAL_START_AT_KEY];
      const startAt = typeof startAtRaw === 'number' && Number.isFinite(startAtRaw)
        ? startAtRaw
        : null;
      // Window membership decided on event start_at; rows missing
      // start_at fall through to events_total but don't contribute to
      // window counts (we can't place them on the timeline). Same
      // convention `attendee_patterns` uses.
      if (startAt !== null) {
        if (startAt >= thirtyDaysAgo) events_window_short += 1;
        if (startAt >= ninetyDaysAgo) events_window_long += 1;
        if (last_event_at === null || startAt > last_event_at) {
          last_event_at = startAt;
        }
      }
    }

    const per_week_window_short = (events_window_short * 7) / 30;
    const per_month_window_long = events_window_long / 3;
    const baseline_events = events_window_long - events_window_short;
    const trend = categorizeTrend(events_window_short, baseline_events);

    // Bench harvest (P1 v12a) — subject identity denormalized onto the
    // value so consumers see WHOSE cadence this is without a lookup.
    // `name` comes from the contact row in hand; omitted when the
    // directory has none (never fabricated).
    const subjectName = source_record.data.name;
    const value: MeetingFrequencyValue = {
      ...(typeof subjectName === 'string' && subjectName.length > 0
        ? { name: subjectName }
        : {}),
      entity: email,
      events_total,
      events_window_short,
      events_window_long,
      per_week_window_short,
      per_month_window_long,
      trend,
      last_event_at,
      computed_at: now,
      window_ms: WINDOW_30D_MS,
    };
    return { value };
  },
};

export {
  WINDOW_30D_MS as MEETING_FREQUENCY_WINDOW_30D_MS,
  WINDOW_90D_MS as MEETING_FREQUENCY_WINDOW_90D_MS,
  TREND_MIN_COMBINED_SAMPLE,
  TREND_BASELINE_FLOOR_PER_MONTH,
  TREND_ACCEL_THRESHOLD,
  TREND_DECEL_THRESHOLD,
};
