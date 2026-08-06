/** Calendar warehouse fixtures with the REAL table shape.
 *
 *  ⛔ Every calendar fixture in this suite used to be created with MAIL's DDL
 *  — `hot_fields TEXT NOT NULL` — a table shape
 *  `createCalendarCollectionTable` has never produced. D-117 gave calendar
 *  dedicated typed columns plus a `record_payload` column carrying the full
 *  `CanonicalEvent`. So six producers read `hot_fields` off a calendar table,
 *  threw `no such column` on every real server, and every test covering them
 *  passed — because the fixture was the only table in existence with the
 *  column they were reading. Found 2026-08-04 by the long-horizon audit.
 *
 *  Tests keep supplying the same flat `hot` object they always did; this
 *  module maps it onto the production storage shape. Test INTENT is unchanged
 *  — only the shape of the table it is stored in.
 *
 *  ⚠ `calendar-fixture-matches-production.test.ts` asserts this DDL's column
 *  set is IDENTICAL to the real builder's. Without that ratchet this file is
 *  just a second place to be wrong, which is exactly what it exists to fix. */

import type Database from 'better-sqlite3';
import type { CanonicalEvent } from '@recued/contracts';

/** Mirrors `collections/calendar/calendar-table.ts`. */
export const createCalendarFixtureTable = (
  db: Database.Database,
  tableName: string,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      record_id       TEXT PRIMARY KEY,
      source_id       TEXT NOT NULL UNIQUE,
      received_at     INTEGER NOT NULL,
      modified_at     INTEGER NOT NULL,
      size_bytes      INTEGER NOT NULL,
      calendar_id     TEXT NOT NULL,
      summary         TEXT NOT NULL,
      start_at        INTEGER NOT NULL,
      end_at          INTEGER NOT NULL,
      status          TEXT NOT NULL,
      organizer       TEXT,
      ical_uid        TEXT NOT NULL,
      location        TEXT,
      is_all_day      INTEGER NOT NULL,
      is_recurring    INTEGER NOT NULL,
      body_inline     TEXT,
      blob_hash       TEXT,
      etag            TEXT,
      record_payload  TEXT NOT NULL,
      prior_payload   TEXT
    );
  `);
};

const asEmail = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Attendees arrive from tests either as bare email strings or as
 *  `{ email }` objects; the canonical payload always stores objects. */
const toAttendees = (value: unknown): CanonicalEvent['attendees'] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    typeof entry === 'string'
      ? { email: entry, response_status: 'accepted' as const }
      : {
          email: asEmail((entry as { email?: unknown })?.email),
          response_status:
            ((entry as { response_status?: CanonicalEvent['attendees'] extends
              ReadonlyArray<infer A> ? A extends { response_status: infer R } ? R : never : never })
              ?.response_status) ?? ('accepted' as const),
        },
  );
};

export interface CalendarFixtureRow {
  record_id: string;
  /** The same flat hot-field object tests already build. */
  hot: Record<string, unknown>;
  received_at?: number;
  source_id?: string;
}

/** Insert one calendar row in the production storage shape, derived from the
 *  flat `hot` object the test supplies. */
export const insertCalendarFixtureRow = (
  db: Database.Database,
  tableName: string,
  row: CalendarFixtureRow,
): void => {
  const hot = row.hot;
  const received_at = row.received_at ?? Date.now();
  const start_at = typeof hot.start_at === 'number' ? hot.start_at : received_at;
  const end_at = typeof hot.end_at === 'number' ? hot.end_at : start_at + 3_600_000;
  const organizerRaw = hot.organizer;
  const organizerEmail =
    typeof organizerRaw === 'string'
      ? organizerRaw
      : asEmail((organizerRaw as { email?: unknown })?.email);
  const event: CanonicalEvent = {
    // ⛔ REQUIRED by `CanonicalEvent` and easy to omit, because nothing in the
    // producers reads them — which is exactly why the fixture must carry them.
    // A fixture that is not assignable to the production type is the F2 defect
    // in miniature: a shape production cannot produce.
    created_at: typeof hot.created_at === 'number' ? hot.created_at : start_at,
    updated_at: typeof hot.updated_at === 'number' ? hot.updated_at : start_at,
    source_id: row.source_id ?? row.record_id,
    ical_uid: typeof hot.ical_uid === 'string' ? hot.ical_uid : row.record_id,
    calendar_id: typeof hot.calendar_id === 'string' ? hot.calendar_id : 'primary',
    summary: typeof hot.summary === 'string' ? hot.summary : '',
    start_at,
    end_at,
    timezone: typeof hot.timezone === 'string' ? hot.timezone : 'UTC',
    is_all_day: hot.is_all_day === true,
    status:
      (hot.status as CanonicalEvent['status'] | undefined) ?? 'confirmed',
    ...(typeof hot.location === 'string' ? { location: hot.location } : {}),
    ...(organizerEmail !== '' ? { organizer: { email: organizerEmail } } : {}),
    attendees: toAttendees(hot.attendees),
  };
  db.prepare(
    `INSERT OR REPLACE INTO ${tableName} (
       record_id, source_id, received_at, modified_at, size_bytes,
       calendar_id, summary, start_at, end_at, status, organizer,
       ical_uid, location, is_all_day, is_recurring,
       body_inline, blob_hash, etag, record_payload, prior_payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
  ).run(
    row.record_id,
    event.source_id,
    received_at,
    received_at,
    200,
    event.calendar_id,
    event.summary,
    event.start_at,
    event.end_at,
    event.status,
    organizerEmail === '' ? null : organizerEmail,
    event.ical_uid,
    event.location ?? null,
    event.is_all_day ? 1 : 0,
    0,
    JSON.stringify(event),
  );
};
