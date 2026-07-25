/** D-131 A.9 — `meeting_frequency` contact producer tests.
 *
 *  Fourth contact-scope producer; closes the deterministic-aggregate
 *  quartet (A.6 / A.7 / A.8 / A.9). Verifies the per-week / per-month
 *  cadence + trend categorization end-to-end against stub
 *  `collection_calendar_*` tables that mirror the production layout
 *  (`collections/table.ts:227`).
 *
 *  Coverage:
 *    - Producer surface contract (topic / scope / token estimate / cadence)
 *    - Returns null when contact has no calendar trail
 *    - Per-week / per-month rate calculation
 *    - 30d / 90d windowing + last_event_at
 *    - Trend categorization (accelerating / stable / decelerating / null)
 *    - categorizeTrend pure-function unit cases
 *    - Address canonicalization across display-name + case + object form
 *    - Multi-account aggregation
 *    - Missing start_at degrades gracefully
 *    - Registry value_schema acceptance + rejection */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ContactRecord,
  type MeetingFrequencyValue,
} from '@recued/contracts';

import {
  categorizeMeetingFrequencyTrend,
  meetingFrequencyProducer,
  MEETING_FREQUENCY_WINDOW_30D_MS,
  MEETING_FREQUENCY_WINDOW_90D_MS,
  TREND_ACCEL_THRESHOLD,
  TREND_BASELINE_FLOOR_PER_MONTH,
  TREND_DECEL_THRESHOLD,
  TREND_MIN_COMBINED_SAMPLE,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

const CAL_TABLE = 'collection_calendar_test';
const CAL_TABLE_2 = 'collection_calendar_other';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-mf-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const t of [CAL_TABLE, CAL_TABLE_2]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${t} (
        record_id   TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        hot_fields  TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        source_id   TEXT NOT NULL,
        body_inline TEXT,
        blob_hash   TEXT
      );
    `);
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
  db.prepare(
    `INSERT INTO ${table} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(record_id, received_at, received_at, JSON.stringify(hot), 200, record_id);
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

describe('meetingFrequencyProducer surface contract', () => {
  it('targets the meeting_frequency registry topic', () => {
    expect(meetingFrequencyProducer.topic).toBe('meeting_frequency');
  });

  it('targets the contact source scope', () => {
    expect(meetingFrequencyProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(meetingFrequencyProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 7d recompute cadence matching the registry', () => {
    expect(meetingFrequencyProducer.recompute_cadence).toBe('7d');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(meetingFrequencyProducer.ai_surface).toBeUndefined();
  });

  it('exports the 30-day window constant', () => {
    expect(MEETING_FREQUENCY_WINDOW_30D_MS).toBe(30 * ONE_DAY);
  });

  it('exports the 90-day window constant', () => {
    expect(MEETING_FREQUENCY_WINDOW_90D_MS).toBe(90 * ONE_DAY);
  });

  it('exposes the trend threshold constants', () => {
    expect(TREND_MIN_COMBINED_SAMPLE).toBe(2);
    expect(TREND_BASELINE_FLOOR_PER_MONTH).toBe(0.5);
    expect(TREND_ACCEL_THRESHOLD).toBe(1.5);
    expect(TREND_DECEL_THRESHOLD).toBe(0.5);
  });
});

// ────────────────────────────────────────────────────────────────
// Null / empty cases
// ────────────────────────────────────────────────────────────────

describe('meetingFrequencyProducer.produce — null / empty', () => {
  it('returns null when the contact has no calendar trail', async () => {
    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('mail-only@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when source_record.email is empty', async () => {
    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
  });

  it('skips calendar rows whose hot_fields fail JSON parse', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync',
      organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    db.prepare(
      `INSERT INTO ${CAL_TABLE} (
         record_id, received_at, modified_at, hot_fields,
         size_bytes, source_id, body_inline, blob_hash
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run('e_bad', NOW, NOW, '{not json}', 200, 'e_bad');

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).events_total).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Counts + windows
// ────────────────────────────────────────────────────────────────

describe('meetingFrequencyProducer.produce — counts + windows', () => {
  it('counts events_window_short / events_window_long / events_total separately', async () => {
    // 4 events: 1 in last 30d, 2 more in 30-90d window, 1 outside 90d.
    insertCalendar(CAL_TABLE, 'recent', {
      summary: 'Recent', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 10 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'mid1', {
      summary: 'Mid1', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 45 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'mid2', {
      summary: 'Mid2', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 75 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'old', {
      summary: 'Old', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 120 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as MeetingFrequencyValue;
    expect(v.events_total).toBe(4);
    expect(v.events_window_long).toBe(3);
    expect(v.events_window_short).toBe(1);
  });

  it('denormalizes subject identity — entity always, name only when the row carries one (bench harvest)', async () => {
    insertCalendar(CAL_TABLE, 'recent', {
      summary: 'Recent', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 10 * ONE_DAY,
    });

    const named = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com', { name: 'Bob Okafor' }),
    );
    const v = named?.value as MeetingFrequencyValue;
    expect(v.entity).toBe('bob@example.com');
    expect(v.name).toBe('Bob Okafor');

    const unnamed = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const u = unnamed?.value as MeetingFrequencyValue;
    expect(u.entity).toBe('bob@example.com');
    expect(Object.hasOwn(u as object, 'name')).toBe(false);
  });

  it('per_week_window_short = events_window_short * 7 / 30', async () => {
    // 3 events in last 30d → 3 * 7 / 30 = 0.7 per week.
    for (let i = 0; i < 3; i++) {
      insertCalendar(CAL_TABLE, `e${i}`, {
        summary: 'Sync', organizer: 'user@example.com',
        attendees: ['user@example.com', 'bob@example.com'],
        start_at: NOW - (5 + i) * ONE_DAY,
      });
    }

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as MeetingFrequencyValue;
    expect(v.per_week_window_short).toBeCloseTo(0.7, 5);
  });

  it('per_month_window_long = events_window_long / 3', async () => {
    // 6 events all in last 90d → 6 / 3 = 2 per month.
    for (let i = 0; i < 6; i++) {
      insertCalendar(CAL_TABLE, `e${i}`, {
        summary: 'Sync', organizer: 'user@example.com',
        attendees: ['user@example.com', 'bob@example.com'],
        start_at: NOW - (5 + i * 12) * ONE_DAY,
      });
    }

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as MeetingFrequencyValue;
    expect(v.per_month_window_long).toBeCloseTo(2, 5);
  });

  it('last_event_at is the most recent start_at across all events', async () => {
    insertCalendar(CAL_TABLE, 'older', {
      summary: 'Older', organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW - 30 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'newer', {
      summary: 'Newer', organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).last_event_at).toBe(NOW - 5 * ONE_DAY);
  });

  it('events with missing start_at count toward events_total but not windows', async () => {
    insertCalendar(CAL_TABLE, 'noTime', {
      summary: 'NoStart', organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      // start_at missing
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as MeetingFrequencyValue;
    expect(v.events_total).toBe(1);
    expect(v.events_window_short).toBe(0);
    expect(v.events_window_long).toBe(0);
    expect(v.last_event_at).toBeNull();
  });

  it('counts contact even when listed only as organizer', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Bob organizes',
      organizer: 'bob@example.com',
      attendees: ['user@example.com', 'alice@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).events_total).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Trend categorization
// ────────────────────────────────────────────────────────────────

describe('categorizeMeetingFrequencyTrend pure function', () => {
  it('returns null when combined sample below TREND_MIN_COMBINED_SAMPLE', () => {
    expect(categorizeMeetingFrequencyTrend(0, 0)).toBeNull();
    expect(categorizeMeetingFrequencyTrend(1, 0)).toBeNull();
    expect(categorizeMeetingFrequencyTrend(0, 1)).toBeNull();
  });

  it('flags 0 baseline + 2 recent as accelerating (floor prevents div-by-zero spike)', () => {
    // baseline_rate = 0, effective = 0.5, ratio = 2/0.5 = 4 → accelerating
    expect(categorizeMeetingFrequencyTrend(2, 0)).toBe('accelerating');
  });

  it('flags 4 baseline + 0 recent as decelerating', () => {
    // baseline_rate = 4/2 = 2, ratio = 0/2 = 0 → decelerating
    expect(categorizeMeetingFrequencyTrend(0, 4)).toBe('decelerating');
  });

  it('flags 2 baseline + 2 recent as accelerating (recent rate 2× baseline rate)', () => {
    // baseline_rate = 1, recent_rate = 2, ratio = 2 → accelerating
    expect(categorizeMeetingFrequencyTrend(2, 2)).toBe('accelerating');
  });

  it('flags 4 baseline + 2 recent as stable (recent rate equals baseline rate)', () => {
    // baseline_rate = 2, recent_rate = 2, ratio = 1 → stable
    expect(categorizeMeetingFrequencyTrend(2, 4)).toBe('stable');
  });

  it('flags 8 baseline + 2 recent as decelerating (ratio = 0.5)', () => {
    // baseline_rate = 4, recent_rate = 2, ratio = 0.5 → decelerating
    expect(categorizeMeetingFrequencyTrend(2, 8)).toBe('decelerating');
  });

  it('flags 6 baseline + 3 recent as stable (recent rate equals baseline)', () => {
    // baseline_rate = 3, recent_rate = 3, ratio = 1 → stable
    expect(categorizeMeetingFrequencyTrend(3, 6)).toBe('stable');
  });

  it('uses 1.5× threshold exactly for accelerating boundary', () => {
    // baseline_rate = 2, recent_rate = 3, ratio = 1.5 → accelerating
    expect(categorizeMeetingFrequencyTrend(3, 4)).toBe('accelerating');
    // baseline_rate = 2, recent_rate = 2.99... can't make a clean
    // boundary case at integer events; verify just-below via 4 + 2:
    // baseline_rate = 1, recent_rate = 2 = 2× → accelerating
    expect(categorizeMeetingFrequencyTrend(2, 2)).toBe('accelerating');
  });
});

describe('meetingFrequencyProducer.produce — trend integration', () => {
  it('reports trend = null when no events in either window', async () => {
    insertCalendar(CAL_TABLE, 'old', {
      summary: 'Old', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 200 * ONE_DAY, // outside 90d
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as MeetingFrequencyValue;
    expect(v.events_window_short).toBe(0);
    expect(v.events_window_long).toBe(0);
    expect(v.trend).toBeNull();
  });

  it('reports trend = accelerating when recent rate spikes', async () => {
    // 3 events in last 30d, 0 in baseline window → accelerating.
    for (let i = 0; i < 3; i++) {
      insertCalendar(CAL_TABLE, `e${i}`, {
        summary: 'Recent', organizer: 'user@example.com',
        attendees: ['user@example.com', 'bob@example.com'],
        start_at: NOW - (5 + i) * ONE_DAY,
      });
    }

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).trend).toBe('accelerating');
  });

  it('reports trend = decelerating when recent rate drops', async () => {
    // 0 events in last 30d, 4 in baseline window → decelerating.
    for (let i = 0; i < 4; i++) {
      insertCalendar(CAL_TABLE, `e${i}`, {
        summary: 'Older', organizer: 'user@example.com',
        attendees: ['user@example.com', 'bob@example.com'],
        start_at: NOW - (45 + i * 5) * ONE_DAY,
      });
    }

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).trend).toBe('decelerating');
  });

  it('reports trend = stable when recent matches baseline rate', async () => {
    // 1 event in last 30d (= 1/month), 2 in baseline 60d (= 1/month) → stable.
    insertCalendar(CAL_TABLE, 'recent', {
      summary: 'Recent', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 10 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'mid1', {
      summary: 'Mid1', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 45 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'mid2', {
      summary: 'Mid2', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 70 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).trend).toBe('stable');
  });

  it('reports trend = null with single-event total (below combined-sample minimum)', async () => {
    insertCalendar(CAL_TABLE, 'lone', {
      summary: 'Lone', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 10 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).trend).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Address canonicalization
// ────────────────────────────────────────────────────────────────

describe('meetingFrequencyProducer.produce — canonicalization', () => {
  it('handles attendees as object[] with email field', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync',
      organizer: { email: 'user@example.com', display_name: 'Me' },
      attendees: [
        { email: 'user@example.com', response_status: 'accepted' },
        { email: 'bob@example.com', response_status: 'accepted' },
      ],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).events_total).toBe(1);
  });

  it('case-insensitive matching of source contact email', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync',
      organizer: 'Bob Smith <BOB@Example.COM>',
      attendees: ['user@example.com', 'BOB@Example.COM'],
      start_at: NOW - 5 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).events_total).toBe(1);
  });

  it('matches contact across multiple display-name variants', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'A', organizer: 'user@example.com',
      attendees: ['user@example.com', 'Bob Smith <bob@example.com>'],
      start_at: NOW - 5 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'e2', {
      summary: 'B', organizer: 'user@example.com',
      attendees: ['user@example.com', '"Smith, Bob" <bob@example.com>'],
      start_at: NOW - 3 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).events_total).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Multi-account aggregation
// ────────────────────────────────────────────────────────────────

describe('meetingFrequencyProducer.produce — multi-account', () => {
  it('aggregates across multiple collection_calendar_* tables', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'A', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE_2, 'e2', {
      summary: 'B', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 3 * ONE_DAY,
    });

    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as MeetingFrequencyValue;
    expect(v.events_total).toBe(2);
    expect(v.events_window_short).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// computed_at + registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('meetingFrequencyProducer — computed_at + registry', () => {
  it('stamps ctx.now() on every emission', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync', organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW,
    });
    const fakeNow = 1_999_999_999_999;
    const out = await meetingFrequencyProducer.produce(
      stubCtx(fakeNow),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as MeetingFrequencyValue).computed_at).toBe(fakeNow);
  });

  it('registry value_schema accepts a fully-populated value', async () => {
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'e2', {
      summary: 'Sync', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 50 * ONE_DAY,
    });
    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const validation = ENRICHMENT_REGISTRY.meeting_frequency.value_schema(out?.value);
    expect(validation.ok).toBe(true);
  });

  it('registry value_schema accepts a value with trend = null', async () => {
    // Single event → trend null.
    insertCalendar(CAL_TABLE, 'e1', {
      summary: 'Sync', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    const out = await meetingFrequencyProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as MeetingFrequencyValue;
    expect(v.trend).toBeNull();
    const validation = ENRICHMENT_REGISTRY.meeting_frequency.value_schema(out?.value);
    expect(validation.ok).toBe(true);
  });

  it('registry value_schema rejects a value missing computed_at', () => {
    const validation = ENRICHMENT_REGISTRY.meeting_frequency.value_schema({
      events_total: 0,
      events_window_short: 0,
      events_window_long: 0,
      per_week_window_short: 0,
      per_month_window_long: 0,
      trend: null,
      last_event_at: null,
      // computed_at missing
    });
    expect(validation.ok).toBe(false);
  });

  it('registry value_schema rejects an unknown trend literal', () => {
    const validation = ENRICHMENT_REGISTRY.meeting_frequency.value_schema({
      events_total: 1,
      events_window_short: 1,
      events_window_long: 1,
      per_week_window_short: 0.23,
      per_month_window_long: 0.33,
      trend: 'rocketing', // not in the closed set
      last_event_at: NOW,
      computed_at: NOW,
    });
    expect(validation.ok).toBe(false);
  });

  it('registry value_schema rejects malformed numeric fields', () => {
    const validation = ENRICHMENT_REGISTRY.meeting_frequency.value_schema({
      events_total: '1', // wrong type
      events_window_short: 1,
      events_window_long: 1,
      per_week_window_short: 0.23,
      per_month_window_long: 0.33,
      trend: null,
      last_event_at: NOW,
      computed_at: NOW,
    });
    expect(validation.ok).toBe(false);
  });
});
