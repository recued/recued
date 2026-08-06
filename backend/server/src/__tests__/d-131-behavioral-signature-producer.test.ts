/** D-131 A.6 — `behavioral_signature` contact producer tests.
 *
 *  First contact-scope producer; verifies the deterministic aggregate
 *  shape end-to-end against stub `collection_mail_*` + `collection_calendar_*`
 *  tables that mirror the production layout (`collections/table.ts:227`).
 *  The producer scans `sqlite_master` for the prefix and reads via
 *  `json_extract` LIKE filters — same pattern thread_signals uses for
 *  its mail scan, so the test setup mirrors that test.
 *
 *  Coverage:
 *    - Producer surface contract (topic / scope / token estimate / cadence)
 *    - Returns null when the contact has no mail and no calendar
 *    - Mail volume + 30-day rolling stat
 *    - Last inbound timestamp pulled from From-canonicalized senders
 *    - Calendar meeting count (organizer or attendee)
 *    - Mean reply-latency thread pairing
 *    - Address canonicalization (display-name variants, case)
 *    - Aggregation across multiple mail / calendar accounts
 *    - Registry value_schema accepts the produced shape */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ContactRecord,
} from '@recued/contracts';

import {
  behavioralSignatureProducer,
  BEHAVIORAL_SIGNATURE_WINDOW_MS,
} from '../housekeeping/producers/behavioral_signature.js';
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

const MAIL_TABLE = 'collection_mail_11111111aa';
const MAIL_TABLE_2 = 'collection_mail_22222222bb';
const CALENDAR_TABLE = 'collection_calendar_11111111aa';
const CALENDAR_TABLE_2 = 'collection_calendar_22222222bb';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-bsig-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Mirror `collections/table.ts:230` exactly — same column set the
  // producer's SQL reads.
  for (const t of [MAIL_TABLE, MAIL_TABLE_2]) {
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
  // ⛔ Calendar tables get the PRODUCTION shape, not mail's.
  for (const t of [CALENDAR_TABLE, CALENDAR_TABLE_2]) {
    createCalendarFixtureTable(db, t);
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const insertMail = (
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
  ).run(record_id, received_at, received_at, JSON.stringify(hot), 100, record_id);
};

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
  first_seen: NOW - 90 * ONE_DAY,
  last_interaction: NOW,
  interaction_count: 1,
  source: 'email_from',
  created_at: NOW - 90 * ONE_DAY,
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

describe('behavioralSignatureProducer surface contract', () => {
  it('targets the behavioral_signature registry topic', () => {
    expect(behavioralSignatureProducer.topic).toBe('behavioral_signature');
  });

  it('targets the contact source scope', () => {
    expect(behavioralSignatureProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(behavioralSignatureProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 7d recompute cadence matching the registry entry', () => {
    expect(behavioralSignatureProducer.recompute_cadence).toBe('7d');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(behavioralSignatureProducer.ai_surface).toBeUndefined();
  });

  it('exports the 30-day window constant', () => {
    expect(BEHAVIORAL_SIGNATURE_WINDOW_MS).toBe(30 * ONE_DAY);
  });
});

// ────────────────────────────────────────────────────────────────
// Empty / null cases
// ────────────────────────────────────────────────────────────────

describe('behavioralSignatureProducer.produce — null / empty', () => {
  it('returns null when the contact has no mail and no calendar yet', async () => {
    // Manual contact created via contact.upsert ahead of any source.
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('lonely@example.com', { source: 'manual' }),
    );
    expect(out).toBeNull();
  });

  it('returns null when source_record.email is empty', async () => {
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
  });

  it('skips mail rows whose hot_fields fail JSON parse', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'alice@example.com',
      to: ['user@example.com'],
      thread_id: 't1',
    });
    // Forge a row with malformed hot_fields directly so the producer's
    // try/catch path runs.
    db.prepare(
      `INSERT INTO ${MAIL_TABLE} (
         record_id, received_at, modified_at, hot_fields,
         size_bytes, source_id, body_inline, blob_hash
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run('m_bad', NOW, NOW, '{not json}', 100, 'm_bad');

    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    // m_bad is silently dropped; m1 still counts.
    expect((out?.value as { mail_count_total: number }).mail_count_total).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Mail volume + last_inbound_at
// ────────────────────────────────────────────────────────────────

describe('behavioralSignatureProducer.produce — mail volume', () => {
  it('counts inbound + outbound mail involving the contact', async () => {
    // Contact = bob@example.com. User mailbox = user@example.com (inferred).
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 5 * ONE_DAY);
    insertMail(MAIL_TABLE, 'm2', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 't1',
    }, NOW - 4 * ONE_DAY);
    insertMail(MAIL_TABLE, 'm3', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't2',
    }, NOW - 50 * ONE_DAY); // outside 30d window
    // Unrelated mail should NOT count.
    insertMail(MAIL_TABLE, 'm4', {
      from: 'mallory@example.com', to: ['user@example.com'], thread_id: 't9',
    });

    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      mail_count_total: number;
      mail_count_window: number;
      last_inbound_at: number;
    };
    expect(v.mail_count_total).toBe(3);
    expect(v.mail_count_window).toBe(2);
    expect(v.last_inbound_at).toBe(NOW - 5 * ONE_DAY);
  });

  it('denormalizes subject identity — entity always, name only when the row carries one (bench harvest)', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });

    const named = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com', { name: 'Bob Okafor' }),
    );
    const nv = named?.value as { entity: string; name?: string };
    expect(nv.entity).toBe('bob@example.com');
    expect(nv.name).toBe('Bob Okafor');

    const unnamed = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const uv = unnamed?.value as { entity: string; name?: string };
    expect(uv.entity).toBe('bob@example.com');
    expect(Object.hasOwn(uv as object, 'name')).toBe(false);
  });

  it('counts cc-only mail (recipient via CC)', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'alice@example.com', to: ['user@example.com'],
      cc: ['bob@example.com'], thread_id: 't1',
    });
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { mail_count_total: number }).mail_count_total).toBe(1);
  });

  it('aggregates across multiple mail collection tables', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    insertMail(MAIL_TABLE_2, 'm2', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't2',
    });
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { mail_count_total: number }).mail_count_total).toBe(2);
  });

  it('canonicalizes the From header before deciding inbound', async () => {
    // From with display name + case mismatch should still match.
    insertMail(MAIL_TABLE, 'm1', {
      from: 'Bob Smith <BOB@Example.COM>', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 2 * ONE_DAY);
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as { last_inbound_at: number; mail_count_total: number };
    expect(v.mail_count_total).toBe(1);
    expect(v.last_inbound_at).toBe(NOW - 2 * ONE_DAY);
  });

  it('last_inbound_at is null when contact only appears as recipient', async () => {
    // Contact only appears in `to` — never in `from` — so they have
    // never sent the user mail.
    insertMail(MAIL_TABLE, 'm1', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 't1',
    });
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { last_inbound_at: number | null }).last_inbound_at).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Calendar meetings
// ────────────────────────────────────────────────────────────────

describe('behavioralSignatureProducer.produce — calendar', () => {
  it('counts organizer + attendee events; tracks last_meeting_at', async () => {
    insertCalendar(CALENDAR_TABLE, 'e1', {
      summary: 'Sync', organizer: 'bob@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 10 * ONE_DAY, end_at: NOW - 10 * ONE_DAY + 3_600_000,
      status: 'confirmed',
    });
    insertCalendar(CALENDAR_TABLE, 'e2', {
      summary: 'Review', organizer: 'user@example.com',
      attendees: ['user@example.com', 'bob@example.com'],
      start_at: NOW - 60 * ONE_DAY, end_at: NOW - 60 * ONE_DAY + 1_800_000,
      status: 'confirmed',
    });
    insertCalendar(CALENDAR_TABLE, 'e3', {
      summary: 'Standup', organizer: 'user@example.com',
      attendees: ['user@example.com', 'mallory@example.com'],
      start_at: NOW - 1 * ONE_DAY, end_at: NOW,
      status: 'confirmed',
    });

    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      meeting_count_total: number;
      meeting_count_window: number;
      last_meeting_at: number;
    };
    expect(v.meeting_count_total).toBe(2); // bob in e1 + e2; e3 excludes bob
    expect(v.meeting_count_window).toBe(1); // only e1 within 30d (e2 is 60d ago)
    expect(v.last_meeting_at).toBe(NOW - 10 * ONE_DAY);
  });

  it('handles attendees as object[] with email field', async () => {
    insertCalendar(CALENDAR_TABLE, 'e1', {
      summary: 'Sync',
      organizer: { email: 'bob@example.com', display_name: 'Bob' },
      attendees: [
        { email: 'user@example.com', response_status: 'accepted' },
        { email: 'bob@example.com', response_status: 'accepted' },
      ],
      start_at: NOW - 5 * ONE_DAY, end_at: NOW - 5 * ONE_DAY + 3_600_000,
    });

    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { meeting_count_total: number }).meeting_count_total).toBe(1);
  });

  it('aggregates across multiple calendar tables', async () => {
    insertCalendar(CALENDAR_TABLE, 'e1', {
      summary: 'Sync', organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    insertCalendar(CALENDAR_TABLE_2, 'e2', {
      summary: 'Review', organizer: 'user@example.com',
      attendees: ['bob@example.com'],
      start_at: NOW - 2 * ONE_DAY,
    });

    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { meeting_count_total: number }).meeting_count_total).toBe(2);
  });

  it('last_meeting_at is null when no meetings involve the contact', async () => {
    // No calendar tables at all — only mail.
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as { last_meeting_at: number | null; meeting_count_total: number };
    expect(v.meeting_count_total).toBe(0);
    expect(v.last_meeting_at).toBeNull();
  });

  it('cannot store an event with no start_at — production declares it NOT NULL', () => {
    // ⚠ This replaces a test that inserted a calendar row whose `hot_fields`
    // JSON omitted (or non-numerically typed) `start_at`, and asserted the
    // producer dropped it.
    //
    // That input is NOT REPRESENTABLE. Production's calendar table declares
    // `start_at INTEGER NOT NULL` (D-117 typed columns), so the branch is
    // unreachable on any real server; the old test only passed because the
    // fixture was mail-shaped and start_at lived in a JSON blob.
    //
    // Kept as an assertion about the schema rather than deleted: if start_at
    // ever becomes nullable, this reddens and the branch needs a real test.
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${CALENDAR_TABLE} (
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
// Reply latency
// ────────────────────────────────────────────────────────────────

describe('behavioralSignatureProducer.produce — reply latency', () => {
  it('pairs each inbound with the earliest later reply in the same thread', async () => {
    // Bob → user (inbound, t=0). User replies (t=+1d). Bob replies again
    // (t=+2d). Expected: one latency sample of 1 day for the first inbound.
    // For the second inbound, no later user reply → no sample.
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 10 * ONE_DAY);
    insertMail(MAIL_TABLE, 'm2', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 't1',
    }, NOW - 9 * ONE_DAY);
    insertMail(MAIL_TABLE, 'm3', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 8 * ONE_DAY);

    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      mean_reply_latency_ms: number;
      reply_sample_count: number;
    };
    expect(v.reply_sample_count).toBe(1);
    expect(v.mean_reply_latency_ms).toBe(ONE_DAY);
  });

  it('averages multiple reply samples across threads', async () => {
    // Two inbounds in two threads. Both replied to. Mean should be (1d + 3d) / 2.
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 'tA',
    }, NOW - 20 * ONE_DAY);
    insertMail(MAIL_TABLE, 'r1', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 'tA',
    }, NOW - 19 * ONE_DAY);
    insertMail(MAIL_TABLE, 'i2', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 'tB',
    }, NOW - 10 * ONE_DAY);
    insertMail(MAIL_TABLE, 'r2', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 'tB',
    }, NOW - 7 * ONE_DAY);

    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      mean_reply_latency_ms: number;
      reply_sample_count: number;
    };
    expect(v.reply_sample_count).toBe(2);
    expect(v.mean_reply_latency_ms).toBe(2 * ONE_DAY);
  });

  it('null mean + 0 samples when contact never received a reply', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      mean_reply_latency_ms: number | null;
      reply_sample_count: number;
    };
    expect(v.mean_reply_latency_ms).toBeNull();
    expect(v.reply_sample_count).toBe(0);
  });

  it('skips threads with empty thread_id (siblings can\'t group)', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: '',
    });
    insertMail(MAIL_TABLE, 'm2', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: '',
    });
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as { reply_sample_count: number };
    expect(v.reply_sample_count).toBe(0);
  });

  it('ignores forwards that don\'t address the contact in to/cc', async () => {
    // Bob inbound. Then user forwards to mallory (not addressing bob).
    // That isn't a reply to bob — sample count stays 0.
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    insertMail(MAIL_TABLE, 'm2', {
      from: 'user@example.com', to: ['mallory@example.com'], thread_id: 't1',
    }, NOW + ONE_DAY);
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { reply_sample_count: number }).reply_sample_count).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Computed-at timestamp
// ────────────────────────────────────────────────────────────────

describe('behavioralSignatureProducer.produce — computed_at', () => {
  it('stamps the ctx.now() on every emission', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    const fakeNow = 1_777_777_777_777;
    const out = await behavioralSignatureProducer.produce(
      stubCtx(fakeNow),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { computed_at: number }).computed_at).toBe(fakeNow);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('behavioral_signature value_schema', () => {
  it('accepts a fully-populated value', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    insertCalendar(CALENDAR_TABLE, 'e1', {
      summary: 'Sync', organizer: 'bob@example.com',
      attendees: ['user@example.com'],
      start_at: NOW - 3 * ONE_DAY,
    });
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const validation = ENRICHMENT_REGISTRY.behavioral_signature.value_schema(out?.value);
    expect(validation.ok).toBe(true);
  });

  it('accepts a value with null reply latency + null last_meeting_at', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    const out = await behavioralSignatureProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const validation = ENRICHMENT_REGISTRY.behavioral_signature.value_schema(out?.value);
    expect(validation.ok).toBe(true);
  });

  it('rejects a value missing the cursor field', () => {
    const validation = ENRICHMENT_REGISTRY.behavioral_signature.value_schema({
      mail_count_window: 0,
      mail_count_total: 0,
      meeting_count_window: 0,
      meeting_count_total: 0,
      mean_reply_latency_ms: null,
      reply_sample_count: 0,
      last_meeting_at: null,
      last_inbound_at: null,
      // computed_at missing
    });
    expect(validation.ok).toBe(false);
  });

  it('rejects a value where mean_reply_latency_ms is undefined (not the same as null)', () => {
    const validation = ENRICHMENT_REGISTRY.behavioral_signature.value_schema({
      mail_count_window: 0,
      mail_count_total: 0,
      meeting_count_window: 0,
      meeting_count_total: 0,
      mean_reply_latency_ms: undefined,
      reply_sample_count: 0,
      last_meeting_at: null,
      last_inbound_at: null,
      computed_at: NOW,
    });
    expect(validation.ok).toBe(false);
  });
});
