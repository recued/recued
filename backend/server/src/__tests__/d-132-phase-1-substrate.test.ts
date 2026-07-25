/** D-132 Phase 1 — substrate test pass.
 *
 *  Verifies the trust-state + pool-policy substrate end-to-end:
 *    - Schema migrations (idempotent, additive columns, new table)
 *    - Trust-store CRUD (read with default, write override, list,
 *      bumpManualRunCount, promotion-suggestion idempotency)
 *    - Registry default helpers (resolveEnrichmentTrustDefault,
 *      resolveEnrichmentPoolPolicyDefault, assertEnrichmentTrustDefaults)
 *    - Manifest validator (scope_read_declaration required, non-empty,
 *      sample_field_paths non-empty)
 *    - Existing producers' scope_read_declaration shape is well-formed
 *    - Pause-AI + BYOK-allowed pass-through helpers
 *    - Last-N error ring buffer append + read */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  MANUAL_RUN_THRESHOLD,
  PAUSE_DURATIONS_MS,
  PAUSE_UNTIL_RESUME_TIMESTAMP,
  POOL_POLICY_DEFAULT,
  TRUST_DEFAULT_AI,
  TRUST_DEFAULT_DETERMINISTIC,
  TRUST_ERROR_HISTORY_SIZE,
  assertEnrichmentTrustDefaults,
  resolveEnrichmentPoolPolicyDefault,
  resolveEnrichmentTrustDefault,
  type EnrichmentTopic,
  type HousekeepingErrorEntry,
} from '@recued/contracts';

import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import {
  appendTaskErrorEntry,
  createTrustStore,
  isAiPaused,
  isByokAllowedForBackground,
  readTaskErrorHistory,
} from '../housekeeping/trust-store.js';

import {
  actionItemsProducer,
  attendeePatternsProducer,
  behavioralSignatureProducer,
  embeddingProducer,
  meetingFrequencyProducer,
  purposeProducer,
  replyPatternsProducer,
  summaryProducer,
  threadSignalsProducer,
} from '../housekeeping/index.js';

// ────────────────────────────────────────────────────────────────
// Fixture
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-132-p1-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureHousekeepingSchema(db);
  // The trust-store assumes a singleton config row exists.
  db.prepare(
    `INSERT INTO housekeeping_config (
       id, preset, cycle_budget_ms, cycle_interval_minutes, updated_at
     ) VALUES ('singleton', 'balanced', 60000, 15, ?)`,
  ).run(NOW);
  // And a few state rows so the error-history helpers have something
  // to update.
  db.prepare(
    `INSERT INTO housekeeping_state (task_id, cursor_json, last_status)
     VALUES (?, ?, 'pending')`,
  ).run('enrichment.summary', JSON.stringify({ kind: 'complete' }));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

describe('D-132 trust-state constants', () => {
  it('AI surfaces default to manual', () => {
    expect(TRUST_DEFAULT_AI).toBe('manual');
  });

  it('deterministic surfaces default to auto', () => {
    expect(TRUST_DEFAULT_DETERMINISTIC).toBe('auto');
  });

  it('pool policy default is free_then_byok', () => {
    expect(POOL_POLICY_DEFAULT).toBe('free_then_byok');
  });

  it('promotion suggestion threshold is 3', () => {
    expect(MANUAL_RUN_THRESHOLD).toBe(3);
  });

  it('error ring buffer size is 3', () => {
    expect(TRUST_ERROR_HISTORY_SIZE).toBe(3);
  });

  it('pause durations include the four documented presets', () => {
    expect(PAUSE_DURATIONS_MS['1h']).toBe(60 * 60_000);
    expect(PAUSE_DURATIONS_MS['4h']).toBe(4 * 60 * 60_000);
    expect(PAUSE_DURATIONS_MS['24h']).toBe(24 * 60 * 60_000);
    expect(PAUSE_UNTIL_RESUME_TIMESTAMP).toBeGreaterThan(NOW);
  });
});

// ────────────────────────────────────────────────────────────────
// Schema migration
// ────────────────────────────────────────────────────────────────

describe('ensureHousekeepingSchema D-132 additions', () => {
  it('creates enrichment_trust table', () => {
    const cols = db
      .prepare(`PRAGMA table_info(enrichment_trust)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('topic')).toBe(true);
    expect(names.has('trust_state')).toBe(true);
    expect(names.has('pool_policy')).toBe(true);
    expect(names.has('manual_run_count')).toBe(true);
    expect(names.has('promotion_suggested_at')).toBe(true);
    expect(names.has('promotion_dismissed_at')).toBe(true);
    expect(names.has('updated_at')).toBe(true);
  });

  it('adds allow_byok_background + pause_background_ai_until to housekeeping_config', () => {
    const cols = db
      .prepare(`PRAGMA table_info(housekeeping_config)`)
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const byok = cols.find((c) => c.name === 'allow_byok_background');
    const pause = cols.find((c) => c.name === 'pause_background_ai_until');
    expect(byok).toBeDefined();
    expect(byok?.notnull).toBe(1);
    expect(pause).toBeDefined();
    // Pause-until is nullable — null = not paused.
    expect(pause?.notnull).toBe(0);
  });

  it('adds last_errors_json to housekeeping_state', () => {
    const cols = db
      .prepare(`PRAGMA table_info(housekeeping_state)`)
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'last_errors_json')).toBe(true);
  });

  it('is idempotent on re-run', () => {
    expect(() => ensureHousekeepingSchema(db)).not.toThrow();
    // Re-run twice for good measure
    ensureHousekeepingSchema(db);
    const cols = db
      .prepare(`PRAGMA table_info(housekeeping_config)`)
      .all() as Array<{ name: string }>;
    // No duplicate columns
    const names = cols.map((c) => c.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry default resolvers
// ────────────────────────────────────────────────────────────────

describe('resolveEnrichmentTrustDefault', () => {
  it('falls back to manual for an AI-surface housekeeping topic', () => {
    // `summary` is producer_kind: 'housekeeping' with no
    // default_trust_state declared in the registry.
    expect(resolveEnrichmentTrustDefault('summary' as EnrichmentTopic, true)).toBe('manual');
  });

  it('falls back to auto for a deterministic housekeeping topic', () => {
    expect(resolveEnrichmentTrustDefault('thread_signals' as EnrichmentTopic, false)).toBe('auto');
  });

  it('reactive producers always default to auto', () => {
    // contact_timeline_rollup is producer_kind: 'reactive' (deterministic
    // today; the auto default holds regardless of ai_surface flag).
    expect(resolveEnrichmentTrustDefault('contact_timeline_rollup' as EnrichmentTopic, true)).toBe('auto');
    expect(resolveEnrichmentTrustDefault('contact_timeline_rollup' as EnrichmentTopic, false)).toBe('auto');
  });
});

describe('resolveEnrichmentPoolPolicyDefault', () => {
  it('falls back to free_then_byok absent registry override', () => {
    expect(resolveEnrichmentPoolPolicyDefault('summary' as EnrichmentTopic)).toBe('free_then_byok');
  });
});

describe('assertEnrichmentTrustDefaults', () => {
  it('accepts valid combinations', () => {
    expect(() => assertEnrichmentTrustDefaults('summary' as EnrichmentTopic, true)).not.toThrow();
    expect(() => assertEnrichmentTrustDefaults('thread_signals' as EnrichmentTopic, false)).not.toThrow();
  });

  it('rejects auto default on AI-surface housekeeping topic', () => {
    // Strawman registry mutation: temporarily inject default_trust_state: 'auto'
    // on a housekeeping topic. The function reads from the registry directly,
    // so we mutate one entry, assert the throw, then restore.
    const original = (ENRICHMENT_REGISTRY as Record<string, { default_trust_state?: string }>).summary
      .default_trust_state;
    (ENRICHMENT_REGISTRY as Record<string, { default_trust_state?: string }>).summary.default_trust_state = 'auto';
    try {
      expect(() => assertEnrichmentTrustDefaults('summary' as EnrichmentTopic, true)).toThrow(
        /enrichment_trust_default_inconsistent/,
      );
    } finally {
      (ENRICHMENT_REGISTRY as Record<string, { default_trust_state?: string }>).summary.default_trust_state = original;
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Trust-store CRUD
// ────────────────────────────────────────────────────────────────

describe('createTrustStore — CRUD', () => {
  it('read() returns synthesized registry default when no row exists', () => {
    const store = createTrustStore(db);
    const row = store.read('summary' as EnrichmentTopic, true);
    expect(row.trust_state).toBe('manual');
    expect(row.pool_policy).toBe('free_then_byok');
    expect(row.manual_run_count).toBe(0);
    expect(row.promotion_suggested_at).toBeNull();
    expect(row.promotion_dismissed_at).toBeNull();
  });

  it('write() persists the patched fields + bumps updated_at', () => {
    const store = createTrustStore(db);
    store.write('summary' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, NOW);
    const row = store.read('summary' as EnrichmentTopic, true);
    expect(row.trust_state).toBe('auto');
    expect(row.pool_policy).toBe('free_only');
    expect(row.updated_at).toBe(NOW);
  });

  it('write() preserves prior fields not in the patch', () => {
    const store = createTrustStore(db);
    store.write('summary' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, NOW);
    store.write('summary' as EnrichmentTopic, { pool_policy: 'byok_only' }, NOW + 1);
    const row = store.read('summary' as EnrichmentTopic, true);
    expect(row.trust_state).toBe('auto'); // preserved
    expect(row.pool_policy).toBe('byok_only'); // updated
  });

  it('write() rejects unknown topic', () => {
    const store = createTrustStore(db);
    expect(() => store.write('bogus_topic' as EnrichmentTopic, { trust_state: 'auto' }, NOW)).toThrow(
      /enrichment_topic_unknown/,
    );
  });

  it('bumpManualRunCount() increments + persists', () => {
    const store = createTrustStore(db);
    expect(store.bumpManualRunCount('summary' as EnrichmentTopic, true, NOW)).toBe(1);
    expect(store.bumpManualRunCount('summary' as EnrichmentTopic, true, NOW + 1)).toBe(2);
    expect(store.bumpManualRunCount('summary' as EnrichmentTopic, true, NOW + 2)).toBe(3);
  });

  it('markPromotionSuggested() is idempotent — only sets the timestamp once', () => {
    const store = createTrustStore(db);
    store.markPromotionSuggested('summary' as EnrichmentTopic, NOW);
    store.markPromotionSuggested('summary' as EnrichmentTopic, NOW + 1000);
    const row = store.read('summary' as EnrichmentTopic, true);
    expect(row.promotion_suggested_at).toBe(NOW);
  });

  it('markPromotionDismissed() persists', () => {
    const store = createTrustStore(db);
    store.markPromotionDismissed('summary' as EnrichmentTopic, NOW);
    const row = store.read('summary' as EnrichmentTopic, true);
    expect(row.promotion_dismissed_at).toBe(NOW);
  });

  it('list() returns persisted rows only — synthesised defaults skipped', () => {
    const store = createTrustStore(db);
    store.write('summary' as EnrichmentTopic, { trust_state: 'auto' }, NOW);
    const rows = store.list();
    expect(rows.length).toBe(1);
    expect(rows[0]?.topic).toBe('summary');
  });
});

// ────────────────────────────────────────────────────────────────
// Pause-AI + BYOK-allowed pass-throughs
// ────────────────────────────────────────────────────────────────

describe('pause-AI + BYOK-allowed pass-throughs', () => {
  it('isAiPaused returns false when pause_background_ai_until is null', () => {
    expect(isAiPaused(db, NOW)).toBe(false);
  });

  it('isAiPaused returns true when timestamp is in the future', () => {
    db.prepare(
      `UPDATE housekeeping_config SET pause_background_ai_until = ? WHERE id = 'singleton'`,
    ).run(NOW + 60_000);
    expect(isAiPaused(db, NOW)).toBe(true);
  });

  it('isAiPaused returns false when timestamp has elapsed', () => {
    db.prepare(
      `UPDATE housekeeping_config SET pause_background_ai_until = ? WHERE id = 'singleton'`,
    ).run(NOW - 60_000);
    expect(isAiPaused(db, NOW)).toBe(false);
  });

  it('isByokAllowedForBackground reflects the column', () => {
    expect(isByokAllowedForBackground(db)).toBe(false);
    db.prepare(
      `UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`,
    ).run();
    expect(isByokAllowedForBackground(db)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Error ring buffer
// ────────────────────────────────────────────────────────────────

describe('last_errors_json ring buffer', () => {
  it('appends + reads back', () => {
    const e: HousekeepingErrorEntry = { ts: NOW, message: 'first' };
    appendTaskErrorEntry(db, 'enrichment.summary', e);
    expect(readTaskErrorHistory(db, 'enrichment.summary')).toEqual([e]);
  });

  it('newest-first ordering + caps at TRUST_ERROR_HISTORY_SIZE', () => {
    for (let i = 0; i < 5; i++) {
      appendTaskErrorEntry(db, 'enrichment.summary', { ts: NOW + i, message: `e${i}` });
    }
    const history = readTaskErrorHistory(db, 'enrichment.summary');
    expect(history.length).toBe(TRUST_ERROR_HISTORY_SIZE);
    expect(history[0]?.message).toBe('e4'); // newest first
    expect(history[1]?.message).toBe('e3');
    expect(history[2]?.message).toBe('e2');
  });

  it('readTaskErrorHistory returns [] when no row', () => {
    expect(readTaskErrorHistory(db, 'enrichment.nonexistent')).toEqual([]);
  });

  it('treats malformed JSON as empty', () => {
    db.prepare(
      `UPDATE housekeeping_state SET last_errors_json = 'not json' WHERE task_id = ?`,
    ).run('enrichment.summary');
    expect(readTaskErrorHistory(db, 'enrichment.summary')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Manifest scope_read_declaration — existing producers
// ────────────────────────────────────────────────────────────────

describe('existing producers declare scope_read_declaration', () => {
  const producers = [
    { name: 'summary', producer: summaryProducer },
    { name: 'purpose', producer: purposeProducer },
    { name: 'action_items', producer: actionItemsProducer },
    { name: 'embedding', producer: embeddingProducer },
    { name: 'thread_signals', producer: threadSignalsProducer },
    { name: 'behavioral_signature', producer: behavioralSignatureProducer },
    { name: 'reply_patterns', producer: replyPatternsProducer },
    { name: 'attendee_patterns', producer: attendeePatternsProducer },
    { name: 'meeting_frequency', producer: meetingFrequencyProducer },
  ];

  for (const { name, producer } of producers) {
    it(`${name} declares non-empty scope_read_declaration`, () => {
      expect(producer.scope_read_declaration).toBeDefined();
      expect(producer.scope_read_declaration.length).toBeGreaterThan(0);
      for (const entry of producer.scope_read_declaration) {
        expect(entry.collection).toMatch(/^data\./);
        expect(entry.sample_field_paths.length).toBeGreaterThan(0);
      }
    });
  }
});
