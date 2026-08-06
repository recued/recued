/** Calendar row access for housekeeping producers.
 *
 *  ⛔ A CALENDAR TABLE HAS NO `hot_fields` COLUMN. D-117 gave calendar its own
 *  table shape — "dedicated hot-field columns (not a JSON blob), a
 *  `record_payload` column carrying the full `CanonicalEvent` JSON"
 *  (`collections/calendar/calendar-table.ts`). Mail kept the JSON blob. Six
 *  producers were written against mail's shape and read `hot_fields` off
 *  `collection_calendar_*`, so every one of them threw `no such column:
 *  hot_fields` on any server that has a calendar — and inside a housekeeping
 *  task that throw is caught, counted, and disables the task for 24 h after
 *  three cycles. They have never produced a row in production.
 *
 *  ⚠ Every test covering them created the calendar fixture with mail's
 *  `hot_fields TEXT NOT NULL` DDL — a table shape `createCalendarCollectionTable`
 *  cannot produce. No test in the repo used the real builder, so the suite
 *  proved only that the producers work against a table production never makes.
 *  Found 2026-08-04 by the long-horizon audit.
 *
 *  This module is the one place that knows how to read a calendar row for a
 *  producer. `contact-backfill.ts` already had the right idea — it reads
 *  `record_payload` and reconstitutes the `CanonicalEvent`.
 *
 *  The projection deliberately returns the SAME hot-field shape the producers'
 *  downstream logic already consumes (`organizer`, `attendees`, `start_at`, …)
 *  so this fix restores their ability to RUN without redefining what any of
 *  them computes. */

import type { CanonicalEvent } from '@recued/contracts';

/** Columns to select for a producer scan. `record_payload` carries the
 *  attendees, which have no dedicated column. */
export const CALENDAR_ROW_SELECT =
  'record_id, received_at, start_at, organizer, summary, location, status, record_payload';

/** The calendar analogue of mail's `hot_fields` for a `LIKE` pre-narrow.
 *  Organizer AND attendee emails both live in the canonical payload, so a
 *  substring pre-filter over it narrows exactly the same candidate set the
 *  mail-side `hot_fields LIKE` narrows — the precise match still happens in JS
 *  afterwards, as it did before. */
export const CALENDAR_LIKE_COLUMN = 'record_payload';

export interface CalendarScanRow {
  record_id: string;
  received_at: number;
  start_at: number;
  organizer: string | null;
  summary: string | null;
  location: string | null;
  status: string | null;
  record_payload: string;
}

/** Project a raw calendar row into the hot-fields-shaped object producers
 *  expect. Returns `null` when `record_payload` is unparseable — the same
 *  defense-in-depth every producer already applies to a malformed
 *  `hot_fields` blob (row skipped, scan continues). */
export const calendarRowHotFields = (
  row: CalendarScanRow,
): Record<string, unknown> | null => {
  let event: CanonicalEvent;
  try {
    event = JSON.parse(row.record_payload) as CanonicalEvent;
  } catch {
    return null;
  }
  return {
    // Typed columns win where they exist — they are what the table indexes
    // and what the watcher keeps current.
    start_at: row.start_at,
    end_at: event.end_at,
    summary: row.summary ?? event.summary,
    status: row.status ?? event.status,
    location: row.location ?? event.location,
    // ⚠ The `organizer` COLUMN is the bare email (CalendarRecordHotFields
    // documents "Organizer email only"); the payload's is `{ email,
    // display_name? }`. Producers feed this to `collectAddresses`, which
    // accepts either, so prefer the column and fall back to the payload.
    organizer: row.organizer ?? event.organizer,
    // No attendees column exists — the payload is the only source.
    attendees: event.attendees ?? [],
  };
};
