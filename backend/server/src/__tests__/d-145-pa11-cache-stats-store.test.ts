/** D-145 PA11 — `LlmResultCacheStore.stats()` + `clearAll()` tests.
 *
 *  Substrate-only coverage for the two methods PA11 adds:
 *    - `stats()` — total + per-topic rollup derived from each row's
 *      `result_path`; malformed paths bucket under `_malformed`; sort
 *      order is entry_count desc, hit_count desc, topic asc.
 *    - `clearAll()` — idempotent drop; returns rows_deleted count.
 *
 *  The existing PA9.6 store test file (`d-145-pa9-6-llm-result-cache-
 *  store.test.ts`) covers CRUD + insertOrIgnore + gcDanglingRefs +
 *  path round-trip. This file pins only the PA11-introduced surface. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeEnrichmentPath,
  createLlmResultCacheStore,
  ensureHousekeepingSchema,
  type LlmResultCacheStore,
} from '../housekeeping/index.js';

let dir: string;
let db: Database.Database;
let store: LlmResultCacheStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa11-stats-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureHousekeepingSchema(db);
  store = createLlmResultCacheStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// stats()
// ────────────────────────────────────────────────────────────────

describe('LlmResultCacheStore.stats()', () => {
  it('returns zero rollup + empty per_topic on an empty cache', () => {
    const stats = store.stats();
    expect(stats.total_entries).toBe(0);
    expect(stats.total_hits).toBe(0);
    expect(stats.per_topic).toEqual([]);
  });

  it('buckets per-row totals by topic parsed from result_path', () => {
    store.insertOrIgnore({
      input_hash: 'h_summary_1',
      result_hash: 'r1',
      result_path: composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'mail_id_1',
      }),
      computed_at: 1_700_000_000,
    });
    store.insertOrIgnore({
      input_hash: 'h_summary_2',
      result_hash: 'r2',
      result_path: composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'mail_id_2',
      }),
      computed_at: 1_700_000_001,
    });
    store.insertOrIgnore({
      input_hash: 'h_purpose_1',
      result_hash: 'r3',
      result_path: composeEnrichmentPath({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'mail_id_1',
      }),
      computed_at: 1_700_000_002,
    });

    // Bump some hits to verify aggregation.
    store.incrementHitCount('h_summary_1');
    store.incrementHitCount('h_summary_1');
    store.incrementHitCount('h_purpose_1');

    const stats = store.stats();
    expect(stats.total_entries).toBe(3);
    expect(stats.total_hits).toBe(3);
    expect(stats.per_topic).toEqual([
      { topic: 'summary', entry_count: 2, hit_count: 2 },
      { topic: 'purpose', entry_count: 1, hit_count: 1 },
    ]);
  });

  it('sorts per_topic by entry_count desc, hit_count desc, topic asc', () => {
    // Topic A: 1 entry, 5 hits.
    store.insertOrIgnore({
      input_hash: 'a1',
      result_hash: 'ra1',
      result_path: composeEnrichmentPath({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'a1',
      }),
      computed_at: 1,
    });
    for (let i = 0; i < 5; i++) store.incrementHitCount('a1');

    // Topic B: 2 entries, 0 hits.
    store.insertOrIgnore({
      input_hash: 'b1',
      result_hash: 'rb1',
      result_path: composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'b1',
      }),
      computed_at: 2,
    });
    store.insertOrIgnore({
      input_hash: 'b2',
      result_hash: 'rb2',
      result_path: composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'b2',
      }),
      computed_at: 3,
    });

    // Topic C: 2 entries, 0 hits — ties with topic B on entry_count
    // and hit_count; topic asc breaks the tie ('action_items' before
    // 'summary' alphabetically).
    store.insertOrIgnore({
      input_hash: 'c1',
      result_hash: 'rc1',
      result_path: composeEnrichmentPath({
        topic: 'action_items',
        scope: 'mail',
        target_id: 'c1',
      }),
      computed_at: 4,
    });
    store.insertOrIgnore({
      input_hash: 'c2',
      result_hash: 'rc2',
      result_path: composeEnrichmentPath({
        topic: 'action_items',
        scope: 'mail',
        target_id: 'c2',
      }),
      computed_at: 5,
    });

    const stats = store.stats();
    // Topic B + C tie on entry_count (2) + hit_count (0); topic asc
    // puts 'action_items' before 'summary'. Topic A has entry_count 1
    // so it lands last despite higher hit_count.
    expect(stats.per_topic.map((t) => t.topic)).toEqual([
      'action_items',
      'summary',
      'purpose',
    ]);
  });

  it('buckets rows with unparseable result_path under _malformed', () => {
    store.insertOrIgnore({
      input_hash: 'good1',
      result_hash: 'rg1',
      result_path: composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'mail_x',
      }),
      computed_at: 1,
    });
    store.insertOrIgnore({
      input_hash: 'bad1',
      result_hash: 'rb1',
      result_path: 'data.enrichment.bogus_topic.something',
      computed_at: 2,
    });
    store.insertOrIgnore({
      input_hash: 'bad2',
      result_hash: 'rb2',
      result_path: 'totally not a path',
      computed_at: 3,
    });

    const stats = store.stats();
    expect(stats.total_entries).toBe(3);
    const buckets = Object.fromEntries(
      stats.per_topic.map((row) => [row.topic, row]),
    );
    expect(buckets['_malformed']).toEqual({
      topic: '_malformed',
      entry_count: 2,
      hit_count: 0,
    });
    expect(buckets['summary']?.entry_count).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// clearAll()
// ────────────────────────────────────────────────────────────────

describe('LlmResultCacheStore.clearAll()', () => {
  it('returns rows_deleted: 0 against an empty cache', () => {
    expect(store.clearAll()).toEqual({ rows_deleted: 0 });
  });

  it('drops every row + reports the count', () => {
    for (let i = 0; i < 4; i++) {
      store.insertOrIgnore({
        input_hash: `h_${i}`,
        result_hash: `r_${i}`,
        result_path: composeEnrichmentPath({
          topic: 'summary',
          scope: 'mail',
          target_id: `mail_${i}`,
        }),
        computed_at: i,
      });
    }
    expect(store.stats().total_entries).toBe(4);
    expect(store.clearAll()).toEqual({ rows_deleted: 4 });
    expect(store.stats().total_entries).toBe(0);
    expect(store.lookup('h_0')).toBeNull();
  });

  it('is idempotent across repeat calls', () => {
    store.insertOrIgnore({
      input_hash: 'h1',
      result_hash: 'r1',
      result_path: composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'mail_1',
      }),
      computed_at: 1,
    });
    expect(store.clearAll()).toEqual({ rows_deleted: 1 });
    expect(store.clearAll()).toEqual({ rows_deleted: 0 });
  });
});
