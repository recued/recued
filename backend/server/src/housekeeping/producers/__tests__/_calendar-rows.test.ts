/** Direct unit coverage for the calendar row projection (audit finding F2).
 *
 *  ⛔ WHY A DIRECT TEST, when six producers already exercise this module.
 *  They exercise it, but they cannot DISCRIMINATE it. The shared fixture
 *  (`__tests__/_calendar-fixture.ts`) writes the typed column and the
 *  `record_payload` from the SAME input, so `row.summary ?? event.summary` has
 *  two operands that always agree. Swapping the precedence, or deleting the
 *  payload fallback outright, keeps every producer test green.
 *
 *  That matters specifically here because F2 was a fixture-vs-production
 *  mismatch: for the whole life of these producers the suite proved they worked
 *  against a table shape `createCalendarCollectionTable` cannot produce. Fixing
 *  the read without pinning WHICH SOURCE each field comes from would leave the
 *  same class of hole one layer down.
 *
 *  Each test below sets the column and the payload to DIFFERENT values, so the
 *  assertion names the winner rather than accepting either. */

import { describe, expect, it } from 'vitest';

import {
  CALENDAR_LIKE_COLUMN,
  CALENDAR_ROW_SELECT,
  calendarRowHotFields,
  type CalendarScanRow,
} from '../_calendar-rows.js';

const mkRow = (
  columns: Partial<CalendarScanRow>,
  payload: Record<string, unknown>,
): CalendarScanRow => ({
  record_id: 'evt-1',
  received_at: 1_700_000_000_000,
  start_at: 1_700_000_100_000,
  organizer: null,
  summary: null,
  location: null,
  status: null,
  ...columns,
  record_payload: JSON.stringify(payload),
});

describe('calendarRowHotFields', () => {
  it('prefers the TYPED COLUMN over the payload for every dual-sourced field', () => {
    // Column and payload deliberately disagree — this is the whole point.
    const row = mkRow(
      {
        start_at: 111,
        summary: 'column-summary',
        status: 'confirmed',
        location: 'column-location',
        organizer: 'column@example.com',
      },
      {
        start_at: 999,
        summary: 'payload-summary',
        status: 'cancelled',
        location: 'payload-location',
        organizer: { email: 'payload@example.com' },
      },
    );
    expect(calendarRowHotFields(row)).toMatchObject({
      start_at: 111,
      summary: 'column-summary',
      status: 'confirmed',
      location: 'column-location',
      organizer: 'column@example.com',
    });
  });

  it('falls back to the PAYLOAD when the nullable column is null', () => {
    // Every one of these columns is nullable in the production DDL, so a row
    // with the value only in the payload is a state the table can really hold.
    const row = mkRow(
      { summary: null, status: null, location: null, organizer: null },
      {
        summary: 'payload-summary',
        status: 'cancelled',
        location: 'payload-location',
        organizer: { email: 'payload@example.com' },
      },
    );
    expect(calendarRowHotFields(row)).toMatchObject({
      summary: 'payload-summary',
      status: 'cancelled',
      location: 'payload-location',
      organizer: { email: 'payload@example.com' },
    });
  });

  it('reads attendees and end_at ONLY from the payload — no column exists', () => {
    const attendees = [
      { email: 'a@example.com' },
      { email: 'b@example.com', display_name: 'B' },
    ];
    const out = calendarRowHotFields(
      mkRow({}, { attendees, end_at: 1_700_000_900_000 }),
    );
    expect(out?.attendees).toEqual(attendees);
    expect(out?.end_at).toBe(1_700_000_900_000);
  });

  it('defaults attendees to [] rather than undefined when the payload omits them', () => {
    // Producers iterate this directly; `undefined` would throw inside the scan,
    // and a housekeeping throw disables the task for 24h after three cycles —
    // the exact failure mode F2 was.
    expect(calendarRowHotFields(mkRow({}, {}))?.attendees).toEqual([]);
  });

  it('returns null on an unparseable payload instead of throwing', () => {
    const row = { ...mkRow({}, {}), record_payload: '{not json' };
    expect(calendarRowHotFields(row)).toBeNull();
  });

  it('SELECTs every column the projection reads, and no field it does not', () => {
    // A field added to the projection but not to the SELECT reads as
    // `undefined` at runtime with no error anywhere — the silent-inertness
    // shape this audit is about. This pins the two lists together.
    const selected = new Set(CALENDAR_ROW_SELECT.split(',').map((c) => c.trim()));
    expect(selected).toEqual(new Set([
      'record_id', 'received_at', 'start_at', 'organizer',
      'summary', 'location', 'status', 'record_payload',
    ]));
    // The LIKE pre-narrow must target a column that is actually selected and
    // actually carries both organizer and attendee emails.
    expect(selected.has(CALENDAR_LIKE_COLUMN)).toBe(true);
    expect(CALENDAR_LIKE_COLUMN).toBe('record_payload');
  });
});
