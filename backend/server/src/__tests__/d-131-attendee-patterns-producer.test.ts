/** D-131 A.8 — `attendee_patterns` contact producer tests.
 *
 *  Third contact-scope producer; first reading calendar-only.
 *  Verifies the deterministic co-attendance aggregate end-to-end
 *  against stub `collection_calendar_*` tables that mirror the
 *  production layout (`collections/table.ts:227`).
 *
 *  Coverage:
 *    - Producer surface contract (topic / scope / token estimate / cadence)
 *    - Returns null when contact has no calendar trail
 *    - Co-attendee counting + source contact exclusion
 *    - 90d windowing (events_window) + last_event_at
 *    - top_co_attendees ordering (count DESC, alphabetical tiebreak)
 *    - top_co_attendees cap at MAX_TOP_CO_ATTENDEES
 *    - Address canonicalization (display-name + case + object form)
 *    - Multi-account aggregation (multiple calendar_*  tables)
 *    - Missing start_at degrades gracefully
 *    - Registry value_schema acceptance */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type AttendeePatternsValue,
  type ContactRecord,
} from '@recued/contracts';

import {
  attendeePatternsProducer,
  ATTENDEE_PATTERNS_WINDOW_MS,
  MAX_TOP_CO_ATTENDEES,
} from '../housekeeping/producers/attendee_patterns.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import {
  createCalendarFixtureTable,
  insertCalendarFixtureRow,
} from './_calendar-fixture.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

const CAL_TABLE = 'collection_calendar_11111111aa';
const CAL_TABLE_2 = 'collection_calendar_22222222bb';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-ap-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const t of [CAL_TABLE, CAL_TABLE_2]) {
    createCalendarFixtureTable(db, t);
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const insertCalendar = (
  table: string,
  record_id: string,
  hot: Record<string, unknown>,
  received_at = NOW,
): void => {
  insertCalendarFixtureRow(db, table, { record_id, hot, received_at });
};

const stubCtx = (now: number = NOW): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const fakeContact = (email: string, overrides: Partial<ContactRecord> = {}): ContactRecord => ({
  _id: email,
  _collection: 'contact',
  email,
  first_seen: NOW - 180 * ONE_DAY,
  last_interaction: NOW,
  interaction_count: 1,
  source: 'calendar_attendee',
  created_at: NOW - 180 * ONE_DAY,
  updated_at: NOW,
  ...overrides,
});

const sourceFor = (email: string, overrides: Partial<ContactRecord> = {}): SourceRecord<ContactRecord> => ({
  target_id: email,
  data: fakeContact(email, overrides),
  cursor_token: email,
});

// ────────────────────────────────────────────────────────────────
// Producer surface contract
// ────────────────────────────────────────────────────────────────

describe('attendeePatternsProducer surface contract', () => {
  it('targets the attendee_patterns registry topic', () => {
    expect(attendeePatternsProducer.topic).toBe('attendee_patterns');
  });

  it('targets the contact source scope', () => {
    expect(attendeePatternsProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(attendeePatternsProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 7d recompute cadence matching the registry', () => {
    expect(attendeePatternsProducer.recompute_cadence).toBe('7d');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(attendeePatternsProducer.ai_surface).toBeUndefined();
  });

  it('exports the 90-day window constant', () => {
    expect(ATTENDEE_PATTERNS_WINDOW_MS).toBe(90 * ONE_DAY);
  });

  it('exports the top-co-attendees cap', () => {
    expect(MAX_TOP_CO_ATTENDEES).toBe(10);
  });
});

// ────────────────────────────────────────────────────────────────
// Null / empty cases
// ────────────────────────────────────────────────────────────────

describe('attendeePatternsProducer.produce — null / empty', () => {
  it('returns null when the contact has no calendar trail', async () => {
    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('mail-only@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when source_record.email is empty', async () => {
    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
  });

  it('skips calendar rows whose record_payload fails JSON parse', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync',
      organizer: 'bob@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    // A row whose canonical payload will not parse. `record_payload` is the
    // calendar analogue of mail's `hot_fields` blob — the column that actually
    // exists on the table production creates.
    db.prepare(
      `INSERT INTO ${CAL_TABLE} (
         record_id, source_id, received_at, modified_at, size_bytes,
         calendar_id, summary, start_at, end_at, status, organizer,
         ical_uid, location, is_all_day, is_recurring,
         body_inline, blob_hash, etag, record_payload, prior_payload
       ) VALUES (?, ?, ?, ?, ?, 'primary', 'bad', ?, ?, 'confirmed', NULL,
                 'uid-bad', NULL, 0, 0, NULL, NULL, NULL, '{not json}', NULL)`,
    ).run('e_bad', 'e_bad', NOW, NOW, 200, NOW, NOW);

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as AttendeePatternsValue).events_total).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Co-attendee counting + source-contact exclusion
// ────────────────────────────────────────────────────────────────

describe('attendeePatternsProducer.produce — co-attendee counting', () => {
  it('counts each event-pair once per event; excludes the source contact', async () => {
    // Bob + Alice + Carol on three events.
    for (let i = 0; i < 3; i++) {
      insertCalendar(CAL_TABLE, `e${i}`, {
        summary: 'Sync',
        organizer: 'user@example.com',
        attendees: ['user@example.com', 'bob@example.com', 'alice@example.com', 'carol@example.com'],
        start_at: NOW - (10 + i) * ONE_DAY,
      });
    }

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.events_total).toBe(3);
    // Bob attended 3 events with: user, alice, carol — each shows up
    // 3 times. Bob himself is excluded.
    const counts = new Map(v.top_co_attendees.map((c) => [c.email, c.count]));
    expect(counts.get('bob@example.com')).toBeUndefined();
    expect(counts.get('user@example.com')).toBe(3);
    expect(counts.get('alice@example.com')).toBe(3);
    expect(counts.get('carol@example.com')).toBe(3);
  });

  it('denormalizes co-attendees to { entity, name } via the contacts directory (bench harvest)', async () => {
    // A name-capable contacts directory: alice is named, carol is not
    // listed at all — her co-occurrence keeps entity but gains no name.
    db.exec(`CREATE TABLE IF NOT EXISTS contacts (email TEXT PRIMARY KEY, name TEXT)`);
    db.prepare(`INSERT INTO contacts (email, name) VALUES (?, ?)`)
      .run('alice@example.com', 'Alice Njoku');

    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'A',
      organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'alice@example.com', 'carol@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com', { name: 'Bob Okafor' }),
    );
    const v = out?.value as AttendeePatternsValue;

    // Subject identity on the value itself.
    expect(v.entity).toBe('bob@example.com');
    expect(v.name).toBe('Bob Okafor');

    // Every surviving co-occurrence carries entity (= its canonical email);
    // name appears only for directory-named contacts.
    for (const co of v.top_co_attendees) {
      expect(co.entity).toBe(co.email);
    }
    const byEmail = new Map(v.top_co_attendees.map((c) => [c.email, c]));
    expect(byEmail.get('alice@example.com')?.name).toBe('Alice Njoku');
    expect(Object.hasOwn(byEmail.get('carol@example.com') as object, 'name')).toBe(false);
  });

  it('co-attendee counts diverge when participants vary across events', async () => {
    // Event 1: bob + alice + user
    // Event 2: bob + carol + user
    // Alice = 1, Carol = 1, User = 2.
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'A',
      organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'alice@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'e2', {
      summary: 'B',
      organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'carol@example.com'],
      start_at: NOW - 3 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    const counts = new Map(v.top_co_attendees.map((c) => [c.email, c.count]));
    expect(counts.get('user@example.com')).toBe(2);
    expect(counts.get('alice@example.com')).toBe(1);
    expect(counts.get('carol@example.com')).toBe(1);
  });

  it('1:1 events with the user produce a single-entry co-attendee list', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: '1:1',
      organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.top_co_attendees).toHaveLength(1);
    expect(v.top_co_attendees[0]?.email).toBe('user@example.com');
  });

  it('counts contact even when listed only as organizer (not in attendees)', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Bob organizes',
      organizer: 'bob@example.com',
      attendees: ['user@example.com', 'alice@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.events_total).toBe(1);
    const counts = new Map(v.top_co_attendees.map((c) => [c.email, c.count]));
    expect(counts.get('alice@example.com')).toBe(1);
    expect(counts.get('user@example.com')).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 90-day window + last_event_at
// ────────────────────────────────────────────────────────────────

describe('attendeePatternsProducer.produce — 90d window + last_event_at', () => {
  it('counts only events with start_at >= now - 90d in events_window', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Recent',
      organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 30 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'e2', {
      summary: 'Old',
      organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 120 * ONE_DAY, // outside 90d
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.events_total).toBe(2);
    expect(v.events_window).toBe(1);
  });

  it('last_event_at is the most recent start_at across all events', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Older',
      organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW - 30 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'e2', {
      summary: 'Newer',
      organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as AttendeePatternsValue).last_event_at).toBe(NOW - 5 * ONE_DAY);
  });

  it('cannot store an event with no start_at — production declares it NOT NULL', () => {
    // ⚠ This replaces a test that inserted a calendar row whose `hot_fields`
    // JSON omitted `start_at`, and asserted the producer counted it toward
    // events_total but not events_window / last_event_at.
    //
    // That input is NOT REPRESENTABLE. Production's calendar table declares
    // `start_at INTEGER NOT NULL` (D-117 typed columns), so the producer's
    // missing-timestamp branch is unreachable on any real server. The old
    // test only passed because the fixture was mail-shaped and start_at lived
    // inside a JSON blob where it could simply be absent.
    //
    // The knowledge is kept as an assertion about the schema rather than
    // deleted: if start_at ever becomes nullable, this reddens and the
    // defensive branch needs a real test again.
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${CAL_TABLE} (
             record_id, source_id, received_at, modified_at, size_bytes,
             calendar_id, summary, start_at, end_at, status, organizer,
             ical_uid, location, is_all_day, is_recurring,
             body_inline, blob_hash, etag, record_payload, prior_payload
           ) VALUES (?, ?, ?, ?, ?, 'primary', 'NoStart', NULL, ?, 'confirmed',
                     NULL, 'uid-nostart', NULL, 0, 0, NULL, NULL, NULL, '{}', NULL)`,
        )
        .run('e_nostart', 'e_nostart', NOW, NOW, 200, NOW),
    ).toThrow(/NOT NULL/i);
  });
});

// ────────────────────────────────────────────────────────────────
// Sorting + cap
// ────────────────────────────────────────────────────────────────

describe('attendeePatternsProducer.produce — sort + cap', () => {
  it('sorts top_co_attendees by count DESC then alphabetical', async () => {
    // Bob is on every event. Different others appear at different
    // counts; same-count ones use alpha tiebreak.
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'A', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'zane@example.com', 'alice@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'e2', {
      summary: 'B', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'alice@example.com'],
      start_at: NOW - 4 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'e3', {
      summary: 'C', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 3 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    // Counts: user=3, alice=2, zane=1
    // Order should be: user, alice, zane
    expect(v.top_co_attendees.map((c) => c.email)).toEqual([
      'user@example.com',
      'alice@example.com',
      'zane@example.com',
    ]);
  });

  it('breaks count ties alphabetically', async () => {
    // Three contacts each with count 1: bea, ada, cal.
    // Alpha order: ada, bea, cal.
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'A', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'bea@example.com', 'ada@example.com', 'cal@example.com'],
      start_at: NOW - 1 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    // user has count 1 too; alpha-sorts among them: ada, bea, cal, user.
    expect(v.top_co_attendees.map((c) => c.email)).toEqual([
      'ada@example.com',
      'bea@example.com',
      'cal@example.com',
      'user@example.com',
    ]);
  });

  it('caps top_co_attendees at MAX_TOP_CO_ATTENDEES', async () => {
    // 15 unique co-attendees with count 1 each. Should cap at 10.
    const otherEmails = Array.from({ length: 15 }, (_, i) => `other${i}@example.com`);
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Big', organizer: 'user@example.com',
      attendees: ['bob@example.com', ...otherEmails],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.top_co_attendees.length).toBe(MAX_TOP_CO_ATTENDEES);
  });
});

// ────────────────────────────────────────────────────────────────
// Address canonicalization
// ────────────────────────────────────────────────────────────────

describe('attendeePatternsProducer.produce — canonicalization', () => {
  it('handles attendees as object[] with email field', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync',
      organizer: { email: 'user@example.com', display_name: 'Me' },
      attendees: [
        { email: 'user@example.com', response_status: 'accepted' },
        { email: 'bob@example.com', response_status: 'accepted' },
        { email: 'alice@example.com', response_status: 'tentative' },
      ],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.events_total).toBe(1);
    const counts = new Map(v.top_co_attendees.map((c) => [c.email, c.count]));
    expect(counts.get('alice@example.com')).toBe(1);
    expect(counts.get('user@example.com')).toBe(1);
  });

  it('case-insensitive matching of source contact email', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync',
      organizer: 'Bob Smith <BOB@Example.COM>',
      attendees: ['user@example.com', 'BOB@Example.COM'],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.events_total).toBe(1);
    // Bob excluded; only user remains.
    expect(v.top_co_attendees.map((c) => c.email)).toEqual(['user@example.com']);
  });

  it('canonicalizes co-attendee variants to the same email', async () => {
    // Same alice across two events with different display name forms;
    // should produce a single co-attendee entry with count 2.
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'A', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'Alice <alice@example.com>'],
      start_at: NOW - 5 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'e2', {
      summary: 'B', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'ALICE@Example.COM'],
      start_at: NOW - 3 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    const counts = new Map(v.top_co_attendees.map((c) => [c.email, c.count]));
    expect(counts.get('alice@example.com')).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Multi-account aggregation
// ────────────────────────────────────────────────────────────────

describe('attendeePatternsProducer.produce — multi-account', () => {
  it('aggregates across multiple collection_calendar_* tables', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'A', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE_2, 'e2', {
      summary: 'B', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'alice@example.com'],
      start_at: NOW - 3 * ONE_DAY,
    });

    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.events_total).toBe(2);
    const counts = new Map(v.top_co_attendees.map((c) => [c.email, c.count]));
    expect(counts.get('user@example.com')).toBe(2);
    expect(counts.get('alice@example.com')).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// computed_at + registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('attendeePatternsProducer — computed_at + registry', () => {
  it('stamps ctx.now() on every emission', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync', organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW,
    });
    const fakeNow = 1_999_999_999_999;
    const out = await attendeePatternsProducer.produce(
      stubCtx(fakeNow),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as AttendeePatternsValue).computed_at).toBe(fakeNow);
  });

  it('registry value_schema accepts a fully-populated value', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com', 'alice@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const validation = ENRICHMENT_REGISTRY.attendee_patterns.value_schema(out?.value);
    expect(validation.ok).toBe(true);
  });

  it('registry value_schema accepts a value with empty top_co_attendees', async () => {
    // Bob attended a "ghost event" — calendar imported with bob in
    // attendees but everyone else missing or filtered. Co-attendee
    // list is empty; row should still validate.
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'GhostEvent',
      organizer: 'bob@example.com',
      attendees: ['bob@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    const out = await attendeePatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as AttendeePatternsValue;
    expect(v.top_co_attendees).toEqual([]);
    const validation = ENRICHMENT_REGISTRY.attendee_patterns.value_schema(out?.value);
    expect(validation.ok).toBe(true);
  });

  it('registry value_schema rejects a value missing computed_at', () => {
    const validation = ENRICHMENT_REGISTRY.attendee_patterns.value_schema({
      events_total: 0,
      events_window: 0,
      top_co_attendees: [],
      last_event_at: null,
      // computed_at missing
    });
    expect(validation.ok).toBe(false);
  });

  it('registry value_schema rejects malformed top_co_attendees entries', () => {
    const validation = ENRICHMENT_REGISTRY.attendee_patterns.value_schema({
      events_total: 1,
      events_window: 1,
      top_co_attendees: [{ email: 'alice@example.com' /* count missing */ }],
      last_event_at: NOW,
      computed_at: NOW,
    });
    expect(validation.ok).toBe(false);
  });
});
