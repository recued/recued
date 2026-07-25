/** D-145 PA9 — `preferred_channel_by_contact` producer tests.
 *
 *  First D-145 PA9 producer impl. Covers:
 *    - Producer surface contract (topic / scope / token estimate / cadence)
 *    - decidePreferredChannel pure-function cases (single channel, strict
 *      majority, 50/50 tie → mixed, 33/33/33 split → mixed, empty → mixed,
 *      reserved-channel acceptance for future engagements integration)
 *    - produce() integration: sample-floor abstention, 90d windowing,
 *      mail-dominant / calendar-dominant / mixed outcomes, multi-account
 *      aggregation, malformed hot_fields tolerance
 *    - Registry value_schema acceptance round-trip
 *    - Cascade cadence + scope alignment with the registry */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ContactRecord,
  type PreferredChannelByContactValue,
} from '@recued/contracts';

import {
  decidePreferredChannel,
  preferredChannelByContactProducer,
  PREFERRED_CHANNEL_DOMINANT_THRESHOLD,
  PREFERRED_CHANNEL_SAMPLE_FLOOR,
  PREFERRED_CHANNEL_WINDOW_MS,
  type PreferredChannelKey,
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

const MAIL_TABLE = 'collection_mail_test';
const MAIL_TABLE_2 = 'collection_mail_other';
const CAL_TABLE = 'collection_calendar_test';
const CAL_TABLE_2 = 'collection_calendar_other';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-pcc-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const t of [MAIL_TABLE, MAIL_TABLE_2, CAL_TABLE, CAL_TABLE_2]) {
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
  ).run(record_id, received_at, received_at, JSON.stringify(hot), 200, record_id);
};

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

const sourceFor = (
  email: string,
  overrides: Partial<ContactRecord> = {},
): SourceRecord<ContactRecord> => ({
  target_id: email,
  data: fakeContact(email, overrides),
  cursor_token: email,
});

const expectValue = async (
  ctx: HousekeepingContext,
  email: string,
): Promise<PreferredChannelByContactValue> => {
  const out = await preferredChannelByContactProducer.produce(ctx, sourceFor(email));
  if (out === null) throw new Error(`expected producer output for ${email}, got null`);
  return out.value as PreferredChannelByContactValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('preferredChannelByContactProducer surface contract', () => {
  it('targets the preferred_channel_by_contact registry topic', () => {
    expect(preferredChannelByContactProducer.topic).toBe('preferred_channel_by_contact');
  });

  it('targets the contact source scope', () => {
    expect(preferredChannelByContactProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(preferredChannelByContactProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 7d recompute cadence matching the registry', () => {
    expect(preferredChannelByContactProducer.recompute_cadence).toBe('7d');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(preferredChannelByContactProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for data.contact + data.mail + data.calendar', () => {
    const collections = preferredChannelByContactProducer.scope_read_declaration.map(
      (e) => e.collection,
    );
    expect(collections).toEqual(['data.contact', 'data.mail', 'data.calendar']);
  });

  it('window constant matches the registry aggregate_window_ms (90d)', () => {
    expect(PREFERRED_CHANNEL_WINDOW_MS).toBe(90 * ONE_DAY);
    const def = ENRICHMENT_REGISTRY.preferred_channel_by_contact as {
      aggregate_window_ms?: number;
    };
    expect(def.aggregate_window_ms).toBe(PREFERRED_CHANNEL_WINDOW_MS);
  });

  it('sample floor constant matches the declaration (5)', () => {
    expect(PREFERRED_CHANNEL_SAMPLE_FLOOR).toBe(5);
  });

  it('dominant threshold pins the strict-majority cutoff at 0.5', () => {
    expect(PREFERRED_CHANNEL_DOMINANT_THRESHOLD).toBe(0.5);
  });
});

// ────────────────────────────────────────────────────────────────
// decidePreferredChannel pure-function cases
// ────────────────────────────────────────────────────────────────

describe('decidePreferredChannel', () => {
  it('returns mixed when the breakdown is empty', () => {
    expect(decidePreferredChannel({})).toBe('mixed_no_clear_preference');
  });

  it('returns mixed when every count is zero', () => {
    expect(decidePreferredChannel({ email: 0, meeting: 0 })).toBe(
      'mixed_no_clear_preference',
    );
  });

  it('returns email_preferred when email holds the strict majority', () => {
    expect(decidePreferredChannel({ email: 9, meeting: 1 })).toBe('email_preferred');
  });

  it('returns meeting_preferred when meeting holds the strict majority', () => {
    expect(decidePreferredChannel({ email: 1, meeting: 9 })).toBe('meeting_preferred');
  });

  it('returns the only channel when only one is present', () => {
    expect(decidePreferredChannel({ email: 7 })).toBe('email_preferred');
    expect(decidePreferredChannel({ meeting: 3 })).toBe('meeting_preferred');
  });

  it('returns mixed on an exact 50/50 split (strict-majority test fails)', () => {
    expect(decidePreferredChannel({ email: 5, meeting: 5 })).toBe(
      'mixed_no_clear_preference',
    );
  });

  it('returns mixed when no channel exceeds the dominant threshold', () => {
    // 4/3/3 — top channel has 40% which is not > 50%, so mixed.
    expect(
      decidePreferredChannel({ email: 4, meeting: 3, call: 3 } as Partial<
        Record<PreferredChannelKey, number>
      >),
    ).toBe('mixed_no_clear_preference');
  });

  it('accepts reserved call / text channels when non-zero (future widening)', () => {
    expect(
      decidePreferredChannel({ call: 8, email: 1, meeting: 1 } as Partial<
        Record<PreferredChannelKey, number>
      >),
    ).toBe('call_preferred');
    expect(
      decidePreferredChannel({ text: 8, email: 1, meeting: 1 } as Partial<
        Record<PreferredChannelKey, number>
      >),
    ).toBe('text_preferred');
  });

  it('respects a caller-supplied threshold', () => {
    // 6/4 with default 0.5 threshold → email_preferred. With a 0.7
    // threshold it becomes mixed (60% < 70%).
    expect(decidePreferredChannel({ email: 6, meeting: 4 })).toBe('email_preferred');
    expect(decidePreferredChannel({ email: 6, meeting: 4 }, 0.7)).toBe(
      'mixed_no_clear_preference',
    );
  });

  it('ignores negative / non-finite counts defensively', () => {
    expect(
      decidePreferredChannel({ email: 8, meeting: -3, call: Number.NaN } as Partial<
        Record<PreferredChannelKey, number>
      >),
    ).toBe('email_preferred');
  });
});

// ────────────────────────────────────────────────────────────────
// produce() — abstention paths
// ────────────────────────────────────────────────────────────────

describe('preferredChannelByContactProducer.produce — abstention', () => {
  it('returns null when source_record.email is empty', async () => {
    const out = await preferredChannelByContactProducer.produce(
      stubCtx(),
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
  });

  it('returns null when the contact has zero touches in either source', async () => {
    const out = await preferredChannelByContactProducer.produce(
      stubCtx(),
      sourceFor('quiet@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when combined touches fall under the sample floor (5)', async () => {
    // 2 mails + 2 meetings = 4 < 5 → abstain.
    insertMail(MAIL_TABLE, 'm1', {
      from: 'alice@example.com',
      to: ['user@example.com'],
      received_at: NOW - 2 * ONE_DAY,
    });
    insertMail(MAIL_TABLE, 'm2', {
      from: 'alice@example.com',
      to: ['user@example.com'],
      received_at: NOW - 3 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'c1', {
      organizer: 'user@example.com',
      attendees: ['alice@example.com'],
      start_at: NOW - 4 * ONE_DAY,
    });
    insertCalendar(CAL_TABLE, 'c2', {
      organizer: 'user@example.com',
      attendees: ['alice@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    const out = await preferredChannelByContactProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    expect(out).toBeNull();
  });

  it('ignores activity outside the 90-day rolling window', async () => {
    // 10 mails, all 100d old — outside the window. Combined in-window
    // touches = 0 → abstain.
    for (let i = 0; i < 10; i += 1) {
      insertMail(MAIL_TABLE, `m${i}`, {
        from: 'alice@example.com',
        to: ['user@example.com'],
      }, NOW - (95 + i) * ONE_DAY);
    }
    const out = await preferredChannelByContactProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    expect(out).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// produce() — preference outcomes
// ────────────────────────────────────────────────────────────────

describe('preferredChannelByContactProducer.produce — preference outcomes', () => {
  it('returns email_preferred when mail dominates', async () => {
    for (let i = 0; i < 8; i += 1) {
      insertMail(MAIL_TABLE, `m${i}`, {
        from: 'alice@example.com',
        to: ['user@example.com'],
      }, NOW - (i + 1) * ONE_DAY);
    }
    insertCalendar(CAL_TABLE, 'c1', {
      organizer: 'user@example.com',
      attendees: ['alice@example.com'],
      start_at: NOW - 10 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.preference).toBe('email_preferred');
    expect(value.score_breakdown.email).toBe(8);
    expect(value.score_breakdown.meeting).toBe(1);
    expect(value.score_breakdown.call).toBeUndefined();
    expect(value.score_breakdown.text).toBeUndefined();
    expect(value.computed_at).toBe(NOW);
  });

  it('returns meeting_preferred when calendar dominates', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com',
      to: ['user@example.com'],
    }, NOW - 5 * ONE_DAY);
    for (let i = 0; i < 8; i += 1) {
      insertCalendar(CAL_TABLE, `c${i}`, {
        organizer: 'user@example.com',
        attendees: ['bob@example.com'],
        start_at: NOW - (i + 1) * ONE_DAY,
      });
    }
    const value = await expectValue(stubCtx(), 'bob@example.com');
    expect(value.preference).toBe('meeting_preferred');
    expect(value.score_breakdown.meeting).toBe(8);
    expect(value.score_breakdown.email).toBe(1);
  });

  it('returns mixed_no_clear_preference on a balanced split', async () => {
    for (let i = 0; i < 5; i += 1) {
      insertMail(MAIL_TABLE, `m${i}`, {
        from: 'carol@example.com',
        to: ['user@example.com'],
      }, NOW - (i + 1) * ONE_DAY);
      insertCalendar(CAL_TABLE, `c${i}`, {
        organizer: 'user@example.com',
        attendees: ['carol@example.com'],
        start_at: NOW - (i + 1) * ONE_DAY,
      });
    }
    const value = await expectValue(stubCtx(), 'carol@example.com');
    expect(value.preference).toBe('mixed_no_clear_preference');
    expect(value.score_breakdown.email).toBe(5);
    expect(value.score_breakdown.meeting).toBe(5);
  });

  it('aggregates across multiple per-account collection tables', async () => {
    // 3 mails in table A + 3 mails in table B + 1 meeting = 7 combined,
    // email dominates strictly (6/7 ≈ 86%).
    for (let i = 0; i < 3; i += 1) {
      insertMail(MAIL_TABLE, `a${i}`, {
        from: 'dave@example.com',
        to: ['user@example.com'],
      }, NOW - (i + 1) * ONE_DAY);
      insertMail(MAIL_TABLE_2, `b${i}`, {
        from: 'dave@example.com',
        to: ['user-work@example.com'],
      }, NOW - (i + 10) * ONE_DAY);
    }
    insertCalendar(CAL_TABLE, 'c1', {
      organizer: 'user@example.com',
      attendees: ['dave@example.com'],
      start_at: NOW - 5 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), 'dave@example.com');
    expect(value.preference).toBe('email_preferred');
    expect(value.score_breakdown.email).toBe(6);
    expect(value.score_breakdown.meeting).toBe(1);
  });

  it('skips rows whose hot_fields fail JSON parse without aborting the producer', async () => {
    for (let i = 0; i < 6; i += 1) {
      insertMail(MAIL_TABLE, `m${i}`, {
        from: 'erin@example.com',
        to: ['user@example.com'],
      }, NOW - (i + 1) * ONE_DAY);
    }
    db.prepare(
      `INSERT INTO ${MAIL_TABLE} (
         record_id, received_at, modified_at, hot_fields,
         size_bytes, source_id, body_inline, blob_hash
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run('m_bad', NOW - ONE_DAY, NOW - ONE_DAY, '{not json}', 200, 'm_bad');
    const value = await expectValue(stubCtx(), 'erin@example.com');
    expect(value.preference).toBe('email_preferred');
    expect(value.score_breakdown.email).toBe(6);
  });

  it('only counts rows whose canonical addresses involve the contact (defends LIKE false positives)', async () => {
    // body fragment mentions the email but the canonical From/To/Cc
    // doesn't — must be skipped to match `behavioral_signature`'s
    // canonical-address defense.
    for (let i = 0; i < 6; i += 1) {
      insertMail(MAIL_TABLE, `m${i}`, {
        from: 'frank@example.com',
        to: ['user@example.com'],
      }, NOW - (i + 1) * ONE_DAY);
    }
    insertMail(MAIL_TABLE, 'm_body_only', {
      from: 'other@example.com',
      to: ['user@example.com'],
      body_snippet: 'mentioning frank@example.com in the body',
    }, NOW - 2 * ONE_DAY);
    const value = await expectValue(stubCtx(), 'frank@example.com');
    expect(value.score_breakdown.email).toBe(6);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry round-trip
// ────────────────────────────────────────────────────────────────

describe('preferred_channel_by_contact registry round-trip', () => {
  it('registry topic exists with housekeeping producer_kind', () => {
    const def = ENRICHMENT_REGISTRY.preferred_channel_by_contact;
    expect(def).toBeDefined();
    expect(def.producer_kind).toBe('housekeeping');
  });

  it('value_schema accepts a producer-emitted payload', async () => {
    for (let i = 0; i < 8; i += 1) {
      insertMail(MAIL_TABLE, `m${i}`, {
        from: 'gary@example.com',
        to: ['user@example.com'],
      }, NOW - (i + 1) * ONE_DAY);
    }
    const value = await expectValue(stubCtx(), 'gary@example.com');
    const def = ENRICHMENT_REGISTRY.preferred_channel_by_contact as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    const result = def.value_schema(value);
    expect(result.ok).toBe(true);
  });
});
