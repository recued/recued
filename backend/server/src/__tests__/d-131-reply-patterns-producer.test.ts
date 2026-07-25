/** D-131 A.7 — `reply_patterns` contact producer tests.
 *
 *  Second contact-scope producer; verifies the deterministic
 *  distribution + 30d-rate aggregate end-to-end against stub
 *  `collection_mail_*` tables that mirror the production layout
 *  (`collections/table.ts:227`). Mirrors the A.6 setup exactly —
 *  same approach `thread_signals` and `behavioral_signature` use to
 *  scan via `sqlite_master`.
 *
 *  Coverage:
 *    - Producer surface contract (topic / scope / token estimate / cadence)
 *    - Returns null when contact has no mail (manual contact, calendar-only)
 *    - inbound_count_window windowing
 *    - reply_sample_count_window (replies counted by inbound's window membership)
 *    - reply_rate_window (rate = numerator / denominator; null on zero inbound)
 *    - All-time mean / p50 / p95
 *    - p95 stays null below 5 samples
 *    - nearestRankPercentile helper edge cases
 *    - Address canonicalization (display-name + case)
 *    - Aggregation across multiple mail tables
 *    - Registry value_schema acceptance */

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
  replyPatternsProducer,
  REPLY_PATTERNS_WINDOW_MS,
  P95_MIN_SAMPLE_COUNT,
  percentile,
} from '../housekeeping/producers/reply_patterns.js';
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-rp-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
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

describe('replyPatternsProducer surface contract', () => {
  it('targets the reply_patterns registry topic', () => {
    expect(replyPatternsProducer.topic).toBe('reply_patterns');
  });

  it('targets the contact source scope', () => {
    expect(replyPatternsProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(replyPatternsProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 7d recompute cadence matching the registry', () => {
    expect(replyPatternsProducer.recompute_cadence).toBe('7d');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(replyPatternsProducer.ai_surface).toBeUndefined();
  });

  it('exports the 30-day window constant', () => {
    expect(REPLY_PATTERNS_WINDOW_MS).toBe(30 * ONE_DAY);
  });

  it('exports the p95 sample-count threshold', () => {
    expect(P95_MIN_SAMPLE_COUNT).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────
// Nearest-rank percentile helper
// ────────────────────────────────────────────────────────────────

describe('percentile (nearest-rank)', () => {
  it('returns null on empty input', () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it('returns the only value for any quantile on a 1-sample array', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it('p50 of [100, 200] is 100 (rank 1: ceil(0.5*2)=1)', () => {
    // Nearest-rank avoids interpolation — recipe authors who write
    // "p50 < 4h" want a real sample value, not an averaged ghost.
    expect(percentile([100, 200], 0.5)).toBe(100);
  });

  it('p95 of [1..20] is 19 (rank 19: ceil(0.95*20)=19)', () => {
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(samples, 0.95)).toBe(19);
  });

  it('p100 returns the max', () => {
    expect(percentile([1, 5, 10], 1)).toBe(10);
  });

  it('clamps quantiles outside [0, 1]', () => {
    expect(percentile([1, 5, 10], -0.5)).toBe(1);
    expect(percentile([1, 5, 10], 1.5)).toBe(10);
  });
});

// ────────────────────────────────────────────────────────────────
// Null / empty cases
// ────────────────────────────────────────────────────────────────

describe('replyPatternsProducer.produce — null / empty', () => {
  it('returns null when the contact has no mail at all', async () => {
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('lonely@example.com', { source: 'manual' }),
    );
    expect(out).toBeNull();
  });

  it('returns null when source_record.email is empty', async () => {
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
  });

  it('returns null when contact only appears as recipient (no inbound, no replies)', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 't1',
    });
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    // Contact is only a recipient — never sent inbound mail. No
    // reply signal worth recording.
    expect(out).toBeNull();
  });

  it('skips mail rows with malformed hot_fields JSON', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    db.prepare(
      `INSERT INTO ${MAIL_TABLE} (
         record_id, received_at, modified_at, hot_fields,
         size_bytes, source_id, body_inline, blob_hash
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run('m_bad', NOW, NOW, '{not json}', 100, 'm_bad');

    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    // m_bad silent-drops; m1 still produces a row.
    expect((out?.value as { inbound_count_window: number }).inbound_count_window).toBe(1);
  });

  it('denormalizes subject identity — entity always, name only when the row carries one (bench harvest)', async () => {
    insertMail(MAIL_TABLE, 'm1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });

    const named = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com', { name: 'Bob Okafor' }),
    );
    const v = named?.value as { entity: string; name?: string };
    expect(v.entity).toBe('bob@example.com');
    expect(v.name).toBe('Bob Okafor');

    const unnamed = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const u = unnamed?.value as { entity: string; name?: string };
    expect(u.entity).toBe('bob@example.com');
    expect(Object.hasOwn(u as object, 'name')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 30-day inbound window + reply_rate
// ────────────────────────────────────────────────────────────────

describe('replyPatternsProducer.produce — 30d window + reply_rate', () => {
  it('counts inbound mail in the last 30d (inbound = sender canonicalizes to contact)', async () => {
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 5 * ONE_DAY);
    insertMail(MAIL_TABLE, 'i2', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't2',
    }, NOW - 60 * ONE_DAY); // outside window
    // Outbound (user → bob) doesn't count as inbound.
    insertMail(MAIL_TABLE, 'o1', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 't3',
    }, NOW - 1 * ONE_DAY);

    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { inbound_count_window: number }).inbound_count_window).toBe(1);
  });

  it('reply_rate_window is replied / total inbound, both within 30d', async () => {
    // 4 inbounds in 30d, 1 replied → 0.25.
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 'tA',
    }, NOW - 20 * ONE_DAY);
    insertMail(MAIL_TABLE, 'r1', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 'tA',
    }, NOW - 19 * ONE_DAY);
    insertMail(MAIL_TABLE, 'i2', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 'tB',
    }, NOW - 15 * ONE_DAY);
    insertMail(MAIL_TABLE, 'i3', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 'tC',
    }, NOW - 10 * ONE_DAY);
    insertMail(MAIL_TABLE, 'i4', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 'tD',
    }, NOW - 5 * ONE_DAY);

    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      inbound_count_window: number;
      reply_sample_count_window: number;
      reply_rate_window: number;
    };
    expect(v.inbound_count_window).toBe(4);
    expect(v.reply_sample_count_window).toBe(1);
    expect(v.reply_rate_window).toBeCloseTo(0.25, 5);
  });

  it('reply_rate_window is null when no inbound in window', async () => {
    // Inbound exists but is older than 30d.
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 60 * ONE_DAY);
    insertMail(MAIL_TABLE, 'r1', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 't1',
    }, NOW - 59 * ONE_DAY);

    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      inbound_count_window: number;
      reply_rate_window: number | null;
      reply_sample_count: number;
    };
    expect(v.inbound_count_window).toBe(0);
    expect(v.reply_rate_window).toBeNull();
    // All-time samples still count — distribution remains useful.
    expect(v.reply_sample_count).toBe(1);
  });

  it('reply within window even if reply itself arrives after window edge', async () => {
    // Inbound is 25d ago (in window). Reply is hypothetically NOW
    // (still in window). Either way, the windowing check uses the
    // INBOUND'S timestamp — recipes track "did the user reply to
    // mail received 25 days ago" semantics.
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 25 * ONE_DAY);
    insertMail(MAIL_TABLE, 'r1', {
      from: 'user@example.com', to: ['bob@example.com'], thread_id: 't1',
    }, NOW - 1 * ONE_DAY);

    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { reply_sample_count_window: number }).reply_sample_count_window).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// All-time distribution: mean / p50 / p95
// ────────────────────────────────────────────────────────────────

describe('replyPatternsProducer.produce — distribution', () => {
  it('mean averages all-time samples; rounds to nearest ms', async () => {
    // Three pairs: 1d / 2d / 3d → mean = 2d.
    for (let i = 0; i < 3; i++) {
      insertMail(MAIL_TABLE, `i${i}`, {
        from: 'bob@example.com', to: ['user@example.com'], thread_id: `t${i}`,
      }, NOW - (50 + i) * ONE_DAY);
      insertMail(MAIL_TABLE, `r${i}`, {
        from: 'user@example.com', to: ['bob@example.com'], thread_id: `t${i}`,
      }, NOW - (50 + i) * ONE_DAY + (i + 1) * ONE_DAY);
    }
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      mean_reply_latency_ms: number;
      reply_sample_count: number;
    };
    expect(v.reply_sample_count).toBe(3);
    expect(v.mean_reply_latency_ms).toBe(2 * ONE_DAY);
  });

  it('p50 is the median — nearest-rank picks the middle sample on odd counts', async () => {
    // 5 samples: 1d, 2d, 3d, 4d, 5d → p50 should be 3d.
    for (let i = 0; i < 5; i++) {
      insertMail(MAIL_TABLE, `i${i}`, {
        from: 'bob@example.com', to: ['user@example.com'], thread_id: `t${i}`,
      }, NOW - (60 + i) * ONE_DAY);
      insertMail(MAIL_TABLE, `r${i}`, {
        from: 'user@example.com', to: ['bob@example.com'], thread_id: `t${i}`,
      }, NOW - (60 + i) * ONE_DAY + (i + 1) * ONE_DAY);
    }
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      p50_reply_latency_ms: number;
      reply_sample_count: number;
    };
    expect(v.reply_sample_count).toBe(5);
    expect(v.p50_reply_latency_ms).toBe(3 * ONE_DAY);
  });

  it('p95 returns the tail latency once samples reach the threshold', async () => {
    // 10 samples: 1..10 days. ceil(0.95*10) = 10 → p95 = 10d.
    for (let i = 0; i < 10; i++) {
      insertMail(MAIL_TABLE, `i${i}`, {
        from: 'bob@example.com', to: ['user@example.com'], thread_id: `t${i}`,
      }, NOW - (90 + i) * ONE_DAY);
      insertMail(MAIL_TABLE, `r${i}`, {
        from: 'user@example.com', to: ['bob@example.com'], thread_id: `t${i}`,
      }, NOW - (90 + i) * ONE_DAY + (i + 1) * ONE_DAY);
    }
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      p95_reply_latency_ms: number;
      reply_sample_count: number;
    };
    expect(v.reply_sample_count).toBe(10);
    expect(v.p95_reply_latency_ms).toBe(10 * ONE_DAY);
  });

  it('p95 stays null below the 5-sample threshold; p50 still populated', async () => {
    // 4 samples: below the floor for p95 but p50 still meaningful.
    for (let i = 0; i < 4; i++) {
      insertMail(MAIL_TABLE, `i${i}`, {
        from: 'bob@example.com', to: ['user@example.com'], thread_id: `t${i}`,
      }, NOW - (60 + i) * ONE_DAY);
      insertMail(MAIL_TABLE, `r${i}`, {
        from: 'user@example.com', to: ['bob@example.com'], thread_id: `t${i}`,
      }, NOW - (60 + i) * ONE_DAY + (i + 1) * ONE_DAY);
    }
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      reply_sample_count: number;
      p50_reply_latency_ms: number;
      p95_reply_latency_ms: number | null;
    };
    expect(v.reply_sample_count).toBe(4);
    expect(v.p50_reply_latency_ms).not.toBeNull();
    expect(v.p95_reply_latency_ms).toBeNull();
  });

  it('mean / p50 / p95 are null when there are no reply samples but inbound exists', async () => {
    // Single inbound, no reply ever — the producer still emits the
    // inbound_count_window signal so recipes can read "they wrote, no
    // reply yet" without joining a second topic.
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 1 * ONE_DAY);

    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const v = out?.value as {
      inbound_count_window: number;
      reply_sample_count: number;
      mean_reply_latency_ms: number | null;
      p50_reply_latency_ms: number | null;
      p95_reply_latency_ms: number | null;
      reply_rate_window: number;
    };
    expect(v.inbound_count_window).toBe(1);
    expect(v.reply_sample_count).toBe(0);
    expect(v.mean_reply_latency_ms).toBeNull();
    expect(v.p50_reply_latency_ms).toBeNull();
    expect(v.p95_reply_latency_ms).toBeNull();
    expect(v.reply_rate_window).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Address canonicalization
// ────────────────────────────────────────────────────────────────

describe('replyPatternsProducer.produce — canonicalization', () => {
  it('treats display-name + case-mixed From as inbound', async () => {
    insertMail(MAIL_TABLE, 'i1', {
      from: 'Bob Smith <BOB@Example.COM>', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 5 * ONE_DAY);
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { inbound_count_window: number }).inbound_count_window).toBe(1);
  });

  it('treats case-mixed To list entries as addressing the contact for reply pairing', async () => {
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 5 * ONE_DAY);
    insertMail(MAIL_TABLE, 'r1', {
      from: 'user@example.com', to: ['BOB@Example.COM'], thread_id: 't1',
    }, NOW - 4 * ONE_DAY);
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { reply_sample_count: number }).reply_sample_count).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Multi-account aggregation
// ────────────────────────────────────────────────────────────────

describe('replyPatternsProducer.produce — multi-account', () => {
  it('aggregates across multiple collection_mail_* tables', async () => {
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 5 * ONE_DAY);
    insertMail(MAIL_TABLE_2, 'i2', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't2',
    }, NOW - 3 * ONE_DAY);

    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { inbound_count_window: number }).inbound_count_window).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// computed_at + registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('replyPatternsProducer — computed_at + registry', () => {
  it('stamps ctx.now() on every emission', async () => {
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    });
    const fakeNow = 1_888_888_888_888;
    const out = await replyPatternsProducer.produce(
      stubCtx(fakeNow),
      sourceFor('bob@example.com'),
    );
    expect((out?.value as { computed_at: number }).computed_at).toBe(fakeNow);
  });

  it('registry value_schema accepts a fully-populated value', async () => {
    for (let i = 0; i < 6; i++) {
      insertMail(MAIL_TABLE, `i${i}`, {
        from: 'bob@example.com', to: ['user@example.com'], thread_id: `t${i}`,
      }, NOW - (50 + i) * ONE_DAY);
      insertMail(MAIL_TABLE, `r${i}`, {
        from: 'user@example.com', to: ['bob@example.com'], thread_id: `t${i}`,
      }, NOW - (50 + i) * ONE_DAY + (i + 1) * ONE_DAY);
    }
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const validation = ENRICHMENT_REGISTRY.reply_patterns.value_schema(out?.value);
    expect(validation.ok).toBe(true);
  });

  it('registry value_schema accepts a value with null reply_rate / latency fields', async () => {
    // Single inbound, no reply yet → most fields null. Still a valid
    // shape for the registry validator.
    insertMail(MAIL_TABLE, 'i1', {
      from: 'bob@example.com', to: ['user@example.com'], thread_id: 't1',
    }, NOW - 60 * ONE_DAY); // outside 30d so reply_rate_window is null
    const out = await replyPatternsProducer.produce(
      stubCtx(),
      sourceFor('bob@example.com'),
    );
    const validation = ENRICHMENT_REGISTRY.reply_patterns.value_schema(out?.value);
    expect(validation.ok).toBe(true);
  });

  it('registry value_schema rejects a value missing computed_at', () => {
    const validation = ENRICHMENT_REGISTRY.reply_patterns.value_schema({
      inbound_count_window: 0,
      reply_sample_count_window: 0,
      reply_rate_window: null,
      reply_sample_count: 0,
      mean_reply_latency_ms: null,
      p50_reply_latency_ms: null,
      p95_reply_latency_ms: null,
      // computed_at missing
    });
    expect(validation.ok).toBe(false);
  });

  it('registry value_schema rejects a value where reply_rate_window is undefined (vs null)', () => {
    const validation = ENRICHMENT_REGISTRY.reply_patterns.value_schema({
      inbound_count_window: 0,
      reply_sample_count_window: 0,
      reply_rate_window: undefined,
      reply_sample_count: 0,
      mean_reply_latency_ms: null,
      p50_reply_latency_ms: null,
      p95_reply_latency_ms: null,
      computed_at: NOW,
    });
    expect(validation.ok).toBe(false);
  });
});
