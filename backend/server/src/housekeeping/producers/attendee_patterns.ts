/** D-131 A.8 — `attendee_patterns` enrichment producer.
 *
 *  Third contact-scope housekeeping producer; first reading
 *  calendar-only. `aggregate` policy keyed on the contact's canonical
 *  email — for each contact, surfaces the de-facto working group by
 *  counting co-attendance across the user's calendar events. Recipes
 *  use it for "what cluster does this person belong to" and to spot
 *  stale ties (top co-attendee dropped to zero in the 90-day window).
 *
 *  Output shape (`AttendeePatternsValue`):
 *    - `events_total`        — all-time event count (organizer or attendee)
 *    - `events_window`       — events involving the contact in the
 *                              trailing window (default 90d; see
 *                              `window_ms`). Renamed from `events_90d`
 *                              at D-136 P3 follow-up.
 *    - `top_co_attendees`    — top N (≤ MAX_TOP_CO_ATTENDEES) other
 *                              contacts sharing events with this
 *                              contact, sorted DESC by count then
 *                              alphabetical for tiebreak
 *    - `last_event_at`       — most recent event start_at, null when none
 *    - `computed_at`         — `ctx.now()` of this run
 *    - `window_ms`           — window aperture in ms (D-136 §A.10)
 *
 *  Window choice: 90 days default for `events_window` (vs 30d on
 *  `behavioral_signature`). Calendar cadence is naturally lumpier
 *  than mail — monthly all-hands, quarterly reviews — so a 30d window
 *  would frequently report zero for contacts who genuinely meet the
 *  user, just not in the last month. 90d catches monthly + most
 *  quarterly cycles while still being short enough to flag stale ties.
 *
 *  User filter: the producer DOES NOT filter the user's own mailbox
 *  out of the co-attendee list. The user's email isn't currently
 *  plumbed to housekeeping context, and identifying it heuristically
 *  (most-frequent email across all events) would couple the producer
 *  to assumptions that don't hold for shared / multi-mailbox setups.
 *  Recipes downstream-filter using their own knowledge of the user's
 *  mail accounts.
 *
 *  Failure modes:
 *    - Contact has no calendar events → `produce` returns `null`;
 *      harness skips. Mail-only contacts (no calendar trail) get a
 *      reply_patterns / behavioral_signature row but not this one.
 *    - Calendar tables absent (fresh server) → SQL scan returns
 *      empty; null return.
 *    - Malformed `hot_fields` JSON → row skipped, aggregation
 *      continues. Same defense-in-depth as A.6 / A.7.
 *
 *  Spec: internal design notes line 46 +
 *        `ENRICHMENT_REGISTRY.attendee_patterns`. */

import {
  type AttendeeCoOccurrence,
  type ContactRecord,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { canonicalOne, collectAddresses } from './_email-addresses.js';
import { contactName } from './_contact-names.js';
import {
  contactAddresses,
  likeAnyParams,
  matchesAnyAddress,
  sqlLikeAny,
} from './_contact-addresses.js';

/** Rolling window for the 90-day stat. Calendar-specific (broader
 *  than the 30d mail windows on A.6 / A.7) per the rationale in the
 *  module docstring. */
const ATTENDEE_PATTERNS_WINDOW_MS = 90 * 86_400_000;

/** Cap on `top_co_attendees`. Recipes wanting the long tail read the
 *  underlying calendar collection directly via `data.calendar` refs. */
const MAX_TOP_CO_ATTENDEES = 10;

/** Hot-field keys read off calendar rows. Mirrors `hashCalendarRecord`
 *  in `source-walkers.ts` (the canonical calendar hash). */
const CAL_ORGANIZER_KEY = 'organizer';
const CAL_ATTENDEES_KEY = 'attendees';
const CAL_START_AT_KEY = 'start_at';

interface CalendarScanRow {
  hot_fields: Record<string, unknown>;
}

/** Find every `collection_calendar_*` table on the live database.
 *  Same prefix-scan approach `behavioral_signature` uses for the
 *  calendar half of its aggregate. */
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
 *  contact's addresses. JSON-LIKE pre-narrow + JS canonical match — same
 *  approach `behavioral_signature` uses for the calendar fold.
 *
 *  D-205 #3.5 — `addresses` is the contact's whole merge group, so a meeting the
 *  person attended under an address they later merged away still counts as
 *  theirs (and their co-attendees still accrue against them). */
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

/** Project an event row's full attendee + organizer set, canonicalized.
 *  Each contact email appears at most once per event regardless of
 *  whether they were the organizer or in `attendees`. */
const eventAttendeeSet = (hot: Record<string, unknown>): Set<string> => {
  const set = new Set<string>();
  collectAddresses(hot[CAL_ORGANIZER_KEY], set);
  collectAddresses(hot[CAL_ATTENDEES_KEY], set);
  return set;
};

/** Sort a co-occurrence list DESC by count then alphabetical for
 *  stable tiebreak. `Array.prototype.sort` mutates in place; this
 *  wrapper keeps the call site self-documenting. */
const sortCoAttendees = (
  list: AttendeeCoOccurrence[],
): AttendeeCoOccurrence[] =>
  list.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });

/** Per-record token estimate. Attendee patterns is fully deterministic
 *  — pure SQL aggregation + Map-based counting. Zero-token,
 *  idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

export const attendeePatternsProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'attendee_patterns',
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
    const ninetyDaysAgo = now - ATTENDEE_PATTERNS_WINDOW_MS;

    const calendar_rows = collectCalendarRows(ctx, addresses);
    if (calendar_rows.length === 0) {
      // Mail-only contact (or pre-source manual entry) — nothing to
      // record. `behavioral_signature` / `reply_patterns` cover those
      // contacts; `attendee_patterns` is opt-in via calendar presence.
      return null;
    }

    const events_total = calendar_rows.length;
    let events_window = 0;
    let last_event_at: number | null = null;
    const coAttendeeCounts = new Map<string, number>();

    for (const row of calendar_rows) {
      const startAtRaw = row.hot_fields[CAL_START_AT_KEY];
      const startAt = typeof startAtRaw === 'number' && Number.isFinite(startAtRaw)
        ? startAtRaw
        : null;
      // Window membership decided on event start_at; rows missing
      // start_at fall through to the count totals but don't
      // contribute to the windowed events count or last_event_at — we
      // can't place them on the timeline. Same convention
      // `behavioral_signature` uses.
      if (startAt !== null) {
        if (startAt >= ninetyDaysAgo) events_window += 1;
        if (last_event_at === null || startAt > last_event_at) {
          last_event_at = startAt;
        }
      }

      const attendees = eventAttendeeSet(row.hot_fields);
      for (const co of attendees) {
        // Exclude the source contact under EVERY address it answers to — an
        // absorbed address is still this person, and excluding only the
        // survivor's would list the contact as their own top co-attendee
        // (D-205 #3.5).
        if (addresses.includes(co)) continue;
        const prior = coAttendeeCounts.get(co) ?? 0;
        coAttendeeCounts.set(co, prior + 1);
      }
    }

    const ranked = sortCoAttendees(
      Array.from(coAttendeeCounts.entries()).map(([emailCo, count]) => ({
        email: emailCo,
        count,
      })),
    );
    // Bench harvest (P1 v6/v11) — denormalize each surviving co-attendee
    // to `{ entity, name }` at producer time (lookups only for the ≤ 10
    // entries that survive the cap, not the whole tally). `email` is
    // already canonical (eventAttendeeSet canonicalizes), so it doubles
    // as the REF<contacts> `entity`; `name` omitted when the directory
    // has none.
    const top_co_attendees: AttendeeCoOccurrence[] = ranked
      .slice(0, MAX_TOP_CO_ATTENDEES)
      .map((co) => {
        const coName = contactName(ctx, co.email);
        return {
          ...co,
          entity: co.email,
          ...(coName !== undefined ? { name: coName } : {}),
        };
      });

    // Bench harvest (P1 v10) — subject identity denormalized onto the
    // value so consumers see WHOSE co-attendance ranking this is.
    const subjectName = source_record.data.name;
    const value: import('@recued/contracts').AttendeePatternsValue = {
      ...(typeof subjectName === 'string' && subjectName.length > 0
        ? { name: subjectName }
        : {}),
      entity: email,
      events_total,
      events_window,
      top_co_attendees,
      last_event_at,
      computed_at: now,
      window_ms: ATTENDEE_PATTERNS_WINDOW_MS,
    };
    return { value };
  },
};

export {
  ATTENDEE_PATTERNS_WINDOW_MS,
  MAX_TOP_CO_ATTENDEES,
};
