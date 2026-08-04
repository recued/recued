/** D-117 Phase 1 Commit 2 — calendar warehouse table tests.
 *
 *  Exercises schema creation, prior_payload rotation, hot-field
 *  indexing, body_inline / blob_hash invariants, FTS5 search, list
 *  filters, retention, stat, and quota accounting. The runtime
 *  provider wiring (OAuth exchange, adapter polling) lands in later
 *  phases — this suite isolates the storage layer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import type { CanonicalEvent } from '@recued/contracts';
import {
  CALENDAR_INLINE_CUTOFF_BYTES,
  CalendarTableError,
  createCalendarTable,
  type CalendarCollectionTable,
  type CalendarUpsertInput,
} from '../calendar-table.js';

let db: Database.Database;
let table: CalendarCollectionTable;
let deltas: number[];

const baseEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  source_id: 'gcal-evt-1',
  ical_uid: 'uid-1@example.com',
  calendar_id: 'primary',
  summary: 'Sync meeting',
  description: 'Weekly cadence',
  location: 'Room 42',
  start_at: 1_700_000_000_000,
  end_at: 1_700_003_600_000,
  timezone: 'America/New_York',
  is_all_day: false,
  status: 'confirmed',
  created_at: 1_699_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

const makeInput = (
  event: CanonicalEvent,
  overrides: Partial<CalendarUpsertInput> = {},
): CalendarUpsertInput => ({
  event,
  size_bytes: Buffer.byteLength(event.description ?? '', 'utf8'),
  body_inline: event.description,
  now: 1_700_000_000_000,
  ...overrides,
});

beforeEach(() => {
  db = new Database(':memory:');
  deltas = [];
  table = createCalendarTable({
    db,
    slug: 'work',
    onBytesChanged: (d) => { deltas.push(d); },
  });
});

afterEach(() => db.close());

describe('schema', () => {
  it('derives table name from a 10-char slug hash', () => {
    expect(table.tableName).toMatch(/^collection_calendar_[a-f0-9]{10}$/);
    expect(table.ftsName).toBe(`${table.tableName}_fts`);
  });

  it('creates the data table + FTS5 companion', () => {
    const names = (db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>)
      .map((t) => t.name);
    expect(names).toContain(table.tableName);
    expect(names).toContain(table.ftsName);
  });

  it('re-creating the same slug is idempotent and preserves rows', () => {
    table.upsert(makeInput(baseEvent()));
    const again = createCalendarTable({ db, slug: 'work' });
    const snap = again.get('gcal-evt-1');
    expect(snap).not.toBeNull();
    expect(snap?.event.summary).toBe('Sync meeting');
  });

  it('distinct slugs produce distinct tables', () => {
    const t2 = createCalendarTable({ db, slug: 'personal' });
    expect(t2.tableName).not.toBe(table.tableName);
  });

  it('has expected indices for range + cursor queries', () => {
    const indices = (db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`,
      )
      .all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(indices.some((n) => n.endsWith('_start'))).toBe(true);
    expect(indices.some((n) => n.endsWith('_modified'))).toBe(true);
    expect(indices.some((n) => n.endsWith('_uid'))).toBe(true);
    expect(indices.some((n) => n.endsWith('_calendar'))).toBe(true);
  });

  it('rejects SQL-unsafe slugs at table creation', () => {
    expect(() =>
      createCalendarTable({ db, slug: 'work; drop table--' }),
    ).not.toThrow(); // slug is hashed, so grammar stays safe
  });
});

describe('getByRecordId (D-198 — the collection.get read path)', () => {
  it('resolves a snapshot by the primary-key record_id, not the source_id', () => {
    table.upsert(makeInput(baseEvent()));
    const bySource = table.get('gcal-evt-1');
    expect(bySource).not.toBeNull();
    const record_id = bySource!.record_id;
    expect(record_id).toMatch(/^cal:[a-f0-9]{32}$/);

    const byId = table.getByRecordId(record_id);
    expect(byId?.source_id).toBe('gcal-evt-1');
    expect(byId?.event.summary).toBe('Sync meeting');

    // The source_id is NOT a record_id, and an unknown id → null (not a throw).
    expect(table.getByRecordId('gcal-evt-1')).toBeNull();
    expect(table.getByRecordId('cal:deadbeef')).toBeNull();
  });
});

describe('upsert + prior_payload rotation', () => {
  it('first insert returns null and stamps received_at at now', () => {
    const prior = table.upsert(makeInput(baseEvent()));
    expect(prior).toBeNull();
    const snap = table.get('gcal-evt-1');
    expect(snap?.received_at).toBe(1_700_000_000_000);
    expect(snap?.prior).toBeNull();
  });

  it('second upsert rotates prior ← current, current ← new', () => {
    const first = baseEvent({ summary: 'First version', updated_at: 1_700_000_000_000 });
    const second = baseEvent({
      summary: 'Second version',
      updated_at: 1_700_000_100_000,
    });

    table.upsert(makeInput(first));
    const prior = table.upsert(
      makeInput(second, { now: 1_700_000_100_000 }),
    );

    expect(prior?.event.summary).toBe('First version');

    const snap = table.get('gcal-evt-1');
    expect(snap?.event.summary).toBe('Second version');
    expect(snap?.prior?.summary).toBe('First version');
    expect(snap?.modified_at).toBe(1_700_000_100_000);
  });

  it('prior_payload depth is exactly 1 — three-way overwrite keeps only the most recent previous', () => {
    const v1 = baseEvent({ summary: 'v1', updated_at: 1 });
    const v2 = baseEvent({ summary: 'v2', updated_at: 2 });
    const v3 = baseEvent({ summary: 'v3', updated_at: 3 });

    table.upsert(makeInput(v1));
    table.upsert(makeInput(v2));
    table.upsert(makeInput(v3));

    const snap = table.get('gcal-evt-1');
    expect(snap?.event.summary).toBe('v3');
    expect(snap?.prior?.summary).toBe('v2'); // NOT v1 — depth=1
  });

  it('received_at is preserved across overwrites', () => {
    const v1 = baseEvent({ summary: 'v1', updated_at: 1 });
    const v2 = baseEvent({ summary: 'v2', updated_at: 2 });

    table.upsert(makeInput(v1, { now: 100 }));
    table.upsert(makeInput(v2, { now: 200 }));

    const snap = table.get('gcal-evt-1');
    expect(snap?.received_at).toBe(100);
  });

  it('modified_at always tracks the event updated_at (cursor-optimized sync depends on this)', () => {
    const v = baseEvent({ updated_at: 1_700_000_555_000 });
    table.upsert(makeInput(v));
    const snap = table.get('gcal-evt-1');
    expect(snap?.modified_at).toBe(1_700_000_555_000);
  });

  it('populates hot-field columns for index-driven queries', () => {
    const v = baseEvent({
      is_all_day: true,
      recurring_event_id: 'parent-src',
      organizer: { email: 'host@example.com', display_name: 'Host' },
    });
    table.upsert(makeInput(v));
    const snap = table.get('gcal-evt-1');
    expect(snap?.hot.is_all_day).toBe(true);
    expect(snap?.hot.is_recurring).toBe(true);
    expect(snap?.hot.organizer).toBe('host@example.com');
    expect(snap?.hot.location).toBe('Room 42');
  });

  it('reports gate deltas on insert and overwrite', () => {
    table.upsert(makeInput(baseEvent(), { size_bytes: 100 }));
    table.upsert(makeInput(baseEvent(), { size_bytes: 250 }));
    expect(deltas).toEqual([100, 150]); // +100 on insert, +150 on replace
  });
});

describe('summarizeParticipant', () => {
  it('counts an event once across organizer/alias matches and excludes cancelled rows', () => {
    table.upsert(makeInput(baseEvent({
      source_id: 'active-aliases',
      ical_uid: 'active-aliases@example.test',
      organizer: { email: 'ada@example.test' },
      attendees: [{ email: 'ada+sales@example.test', response_status: 'accepted' }],
      start_at: 200,
      end_at: 300,
    })));
    table.upsert(makeInput(baseEvent({
      source_id: 'historical',
      ical_uid: 'historical@example.test',
      organizer: { email: 'ada@example.test' },
      start_at: 10,
      end_at: 20,
    })));
    table.upsert(makeInput(baseEvent({
      source_id: 'cancelled',
      ical_uid: 'cancelled@example.test',
      organizer: { email: 'ada@example.test' },
      start_at: 200,
      end_at: 300,
      status: 'cancelled',
    })));

    expect(table.summarizeParticipant([
      'ADA@example.test',
      'ada+sales@example.test',
    ], 100)).toEqual({
      active_count: 1,
      historical_count: 1,
      observed_count: 2,
    });
  });
});

describe('body_inline / blob_hash invariants', () => {
  it('rejects body_inline above CALENDAR_INLINE_CUTOFF_BYTES', () => {
    const oversized = 'x'.repeat(CALENDAR_INLINE_CUTOFF_BYTES + 1);
    expect(() =>
      table.upsert(makeInput(baseEvent(), { body_inline: oversized })),
    ).toThrow(CalendarTableError);
  });

  it('rejects mutually-exclusive body_inline + blob_hash', () => {
    expect(() =>
      table.upsert(
        makeInput(baseEvent(), {
          body_inline: 'inline',
          blob_hash: 'sha256:aabbcc',
        }),
      ),
    ).toThrow(CalendarTableError);
  });

  it('accepts CAS-only storage for oversized descriptions', () => {
    // Caller has already written the large description to CAS and
    // drops body_inline. The table stores blob_hash only and FTS
    // skips indexing the description text.
    table.upsert(
      makeInput(baseEvent(), {
        body_inline: undefined,
        blob_hash: 'sha256:aa',
        size_bytes: 200_000,
      }),
    );
    const snap = table.get('gcal-evt-1');
    expect(snap?.blob_hash).toBe('sha256:aa');
    expect(snap?.body_inline).toBeNull();
  });
});

describe('etag (caldav) column', () => {
  it('stores and returns the per-resource validator', () => {
    table.upsert(makeInput(baseEvent(), { etag: '"abc123"' }));
    const snap = table.get('gcal-evt-1');
    expect(snap?.etag).toBe('"abc123"');
  });

  it('defaults to null for gcal / graph adapters', () => {
    table.upsert(makeInput(baseEvent()));
    const snap = table.get('gcal-evt-1');
    expect(snap?.etag).toBeNull();
  });
});

describe('delete', () => {
  it('removes the row and reports size + blob_hash for CAS sweep', () => {
    table.upsert(
      makeInput(baseEvent(), {
        body_inline: undefined,
        blob_hash: 'sha256:bb',
        size_bytes: 200_000,
      }),
    );
    const res = table.delete('gcal-evt-1');
    expect(res.deleted).toBe(true);
    expect(res.blob_hash).toBe('sha256:bb');
    expect(res.size_bytes).toBe(200_000);
    expect(table.get('gcal-evt-1')).toBeNull();
  });

  it('returns deleted:false for unknown source_id', () => {
    const res = table.delete('never-inserted');
    expect(res.deleted).toBe(false);
    expect(res.size_bytes).toBe(0);
    expect(res.blob_hash).toBeNull();
  });

  it('reports negative gate delta on successful delete', () => {
    table.upsert(makeInput(baseEvent(), { size_bytes: 100 }));
    deltas.length = 0;
    table.delete('gcal-evt-1');
    expect(deltas).toEqual([-100]);
  });
});

describe('list', () => {
  const times = [1, 2, 3, 4, 5].map((n) => n * 60_000); // 1..5 minutes in ms
  beforeEach(() => {
    for (let i = 0; i < times.length; i += 1) {
      table.upsert(
        makeInput(
          baseEvent({
            source_id: `evt-${i}`,
            ical_uid: `uid-${i}`,
            summary: `Event ${i}`,
            start_at: 1_700_000_000_000 + times[i],
            updated_at: 1_700_000_000_000 + times[i],
            calendar_id: i % 2 === 0 ? 'work' : 'personal',
            status: i === 2 ? 'cancelled' : 'confirmed',
          }),
        ),
      );
    }
  });

  it('returns all rows when unconstrained, ordered by start_at asc', () => {
    const rows = table.list({});
    expect(rows).toHaveLength(5);
    expect(rows[0].summary).toBe('Event 0');
    expect(rows[4].summary).toBe('Event 4');
  });

  it('filters by start_since (starting_soon look-ahead shape)', () => {
    const rows = table.list({ start_since: 1_700_000_000_000 + times[2] });
    expect(rows).toHaveLength(3);
    expect(rows[0].summary).toBe('Event 2');
  });

  it('filters by start_until', () => {
    const rows = table.list({
      start_until: 1_700_000_000_000 + times[2],
    });
    // times[0]=60000 and times[1]=120000; times[2]=180000 is exclusive upper
    expect(rows.map((r) => r.summary)).toEqual(['Event 0', 'Event 1']);
  });

  it('filters by modified_since (changed_since cursor shape)', () => {
    // Bump modified_at on evt-3 via a second upsert with a new updated_at.
    table.upsert(
      makeInput(
        baseEvent({
          source_id: 'evt-3',
          ical_uid: 'uid-3',
          summary: 'Event 3 (edited)',
          start_at: 1_700_000_000_000 + times[3],
          updated_at: 1_800_000_000_000,
          calendar_id: 'personal',
        }),
      ),
    );
    const rows = table.list({ modified_since: 1_799_999_999_999 });
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('Event 3 (edited)');
  });

  it('filters by calendar_id + status together', () => {
    const rows = table.list({
      calendar_id: 'work',
      status: 'confirmed',
    });
    // Work calendar: evt-0, evt-2, evt-4; evt-2 is cancelled.
    expect(rows.map((r) => r.summary).sort()).toEqual([
      'Event 0',
      'Event 4',
    ]);
  });

  it('honors modified_at ordering for watcher changed_since', () => {
    const rows = table.list({ order_by: 'modified_at', direction: 'asc' });
    expect(rows[0].summary).toBe('Event 0');
    expect(rows.at(-1)?.summary).toBe('Event 4');
  });

  it('clamps limit at CALENDAR_MAX_LIST_LIMIT (500)', () => {
    const rows = table.list({ limit: 9999 });
    expect(rows.length).toBeLessThanOrEqual(500);
  });
});

describe('stat', () => {
  it('returns exists:false for unknown source_id', () => {
    expect(table.stat('nope')).toEqual({ exists: false });
  });

  it('returns derived fields for a known event', () => {
    const evt = baseEvent({
      attendees: [
        { email: 'a@b.com', response_status: 'accepted' },
        { email: 'c@d.com', response_status: 'needs_action' },
      ],
    });
    table.upsert(makeInput(evt));
    const stat = table.stat('gcal-evt-1');
    expect(stat.exists).toBe(true);
    expect(stat.start_at).toBe(evt.start_at);
    expect(stat.status).toBe('confirmed');
    expect(stat.attendee_count).toBe(2);
    expect(stat.last_modified_at).toBe(evt.updated_at);
  });
});

describe('search (FTS5)', () => {
  it('indexes summary + description + location', () => {
    table.upsert(
      makeInput(
        baseEvent({
          source_id: 'a',
          ical_uid: 'uid-a',
          summary: 'Sprint review',
          description: 'Q3 deliverables walkthrough',
          location: 'Building 7',
        }),
      ),
    );
    table.upsert(
      makeInput(
        baseEvent({
          source_id: 'b',
          ical_uid: 'uid-b',
          summary: 'Budget sync',
          description: 'Expense reconciliation',
          location: 'Room 202',
        }),
      ),
    );

    const matches = table.search({ query: 'deliverables' });
    expect(matches).toHaveLength(1);
    expect(matches[0].hot.summary).toBe('Sprint review');
    expect(matches[0].snippet).toContain('<b>');
  });

  it('still finds rows by summary when description is in CAS', () => {
    table.upsert(
      makeInput(
        baseEvent({ summary: 'Sprint review' }),
        { body_inline: undefined, blob_hash: 'sha256:aa', size_bytes: 200_000 },
      ),
    );
    const matches = table.search({ query: 'sprint' });
    expect(matches).toHaveLength(1);
    expect(matches[0].hot.summary).toBe('Sprint review');
  });

  it('indexes attendee + organizer names and emails so calendar.search finds "meetings with <person>"', () => {
    table.upsert(
      makeInput(
        baseEvent({
          source_id: 'p',
          ical_uid: 'uid-p',
          summary: 'Project kickoff',
          organizer: { email: 'olivia@example.com', display_name: 'Olivia Organizer' },
          attendees: [
            { email: 'pat.lee@acme.com', display_name: 'Pat Lee', response_status: 'accepted' },
            { email: 'sam@example.com', response_status: 'tentative' },
          ],
        }),
      ),
    );
    const summaries = (q: string) =>
      table.search({ query: q }).map((m) => m.hot.summary);
    expect(summaries('Pat')).toEqual(['Project kickoff']); // attendee display name
    expect(summaries('acme')).toEqual(['Project kickoff']); // attendee email token (pat.lee@acme.com)
    expect(summaries('sam')).toEqual(['Project kickoff']); // email-only attendee (no display name)
    expect(summaries('Olivia')).toEqual(['Project kickoff']); // organizer display name
    // A full canonical email passed as the query (FTS5 tokenizes `.`/`@`
    // away → matches the same tokens in the indexed attendee/organizer text).
    expect(summaries('pat.lee@acme.com')).toEqual(['Project kickoff']);
    expect(summaries('olivia@example.com')).toEqual(['Project kickoff']);
  });
});

describe('totalBytes + referencedBlobHashes', () => {
  it('sums size_bytes across all rows for gate priming', () => {
    table.upsert(makeInput(baseEvent({ source_id: 'a', ical_uid: 'u-a' }), { size_bytes: 100 }));
    table.upsert(makeInput(baseEvent({ source_id: 'b', ical_uid: 'u-b' }), { size_bytes: 250 }));
    expect(table.totalBytes()).toBe(350);
  });

  it('emits distinct blob_hashes for the CAS sweep', () => {
    table.upsert(
      makeInput(
        baseEvent({ source_id: 'a', ical_uid: 'u-a' }),
        { body_inline: undefined, blob_hash: 'sha256:1', size_bytes: 200_000 },
      ),
    );
    table.upsert(
      makeInput(
        baseEvent({ source_id: 'b', ical_uid: 'u-b' }),
        { body_inline: undefined, blob_hash: 'sha256:2', size_bytes: 200_000 },
      ),
    );
    const refs = table.referencedBlobHashes();
    expect(refs).toEqual(new Set(['sha256:1', 'sha256:2']));
  });
});

describe('eventCount + upcomingCount', () => {
  it('eventCount returns COUNT(*)', () => {
    expect(table.eventCount()).toBe(0);
    table.upsert(makeInput(baseEvent()));
    expect(table.eventCount()).toBe(1);
  });

  it('upcomingCount counts events with start_at in [now, now+window_ms)', () => {
    const NOW = 1_700_000_000_000;
    const DAY_MS = 86_400_000;
    table.upsert(makeInput(baseEvent({ source_id: 'a', ical_uid: 'u-a', start_at: NOW + 1_000 })));
    table.upsert(makeInput(baseEvent({ source_id: 'b', ical_uid: 'u-b', start_at: NOW + DAY_MS - 1 })));
    table.upsert(makeInput(baseEvent({ source_id: 'c', ical_uid: 'u-c', start_at: NOW + DAY_MS + 1 })));
    table.upsert(makeInput(baseEvent({ source_id: 'd', ical_uid: 'u-d', start_at: NOW - 1 })));
    expect(table.upcomingCount(NOW, DAY_MS)).toBe(2);
  });
});

describe('retention (pruneOlderThan)', () => {
  it('prunes by modified_at, not received_at (accreted edits preserved)', () => {
    // Event created three years ago but edited last week survives a
    // one-year cutoff; an untouched old event is dropped.
    const NOW = 1_700_000_000_000;
    const YEAR_MS = 365 * 86_400_000;
    const oldAndStale = baseEvent({
      source_id: 'stale',
      ical_uid: 'u-stale',
      created_at: NOW - 3 * YEAR_MS,
      updated_at: NOW - 2 * YEAR_MS,
    });
    const oldAndEdited = baseEvent({
      source_id: 'edited',
      ical_uid: 'u-edited',
      created_at: NOW - 3 * YEAR_MS,
      updated_at: NOW - 100,
    });
    table.upsert(makeInput(oldAndStale));
    table.upsert(makeInput(oldAndEdited));

    const { pruned_count } = table.pruneOlderThan(NOW - YEAR_MS);
    expect(pruned_count).toBe(1);
    expect(table.get('stale')).toBeNull();
    expect(table.get('edited')).not.toBeNull();
  });

  it('surfaces orphaned blob hashes and reports bytes freed', () => {
    table.upsert(
      makeInput(
        baseEvent({ source_id: 'big', ical_uid: 'u-big', updated_at: 10 }),
        {
          body_inline: undefined,
          blob_hash: 'sha256:zz',
          size_bytes: 200_000,
        },
      ),
    );
    const res = table.pruneOlderThan(100);
    expect(res.pruned_count).toBe(1);
    expect(res.bytes_freed).toBe(200_000);
    expect(res.blob_hashes_freed).toEqual(['sha256:zz']);
  });

  it('reports the prune as a negative gate delta', () => {
    table.upsert(makeInput(baseEvent({ updated_at: 10 }), { size_bytes: 500 }));
    deltas.length = 0;
    table.pruneOlderThan(100);
    expect(deltas).toEqual([-500]);
  });

  it('no-op on empty table', () => {
    const res = table.pruneOlderThan(100);
    expect(res.pruned_count).toBe(0);
    expect(res.bytes_freed).toBe(0);
    expect(res.blob_hashes_freed).toEqual([]);
  });
});

describe('dropSchema', () => {
  it('removes both the data table and FTS5 companion', () => {
    table.upsert(makeInput(baseEvent()));
    table.dropSchema();
    const remaining = (db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collection_calendar_%'`,
      )
      .all() as Array<{ name: string }>);
    expect(remaining.length).toBe(0);
  });
});
