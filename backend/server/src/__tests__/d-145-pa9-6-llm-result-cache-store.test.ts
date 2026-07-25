/** D-145 PA9.6 — Content-addressed LLM result cache store tests.
 *
 *  Substrate-only coverage (the wrapper integration is exercised in
 *  `d-145-pa9-6-runai-producer-cache.test.ts`):
 *
 *    - CRUD shape (lookup miss, insertOrIgnore + lookup hit, hit_count
 *      bump on incrementHitCount, delete returns changed-flag).
 *    - First-writer-wins insertOrIgnore (concurrent producers reaching
 *      the same input don't fight).
 *    - gcDanglingRefs walks every row and drops entries whose path no
 *      longer resolves; idempotent across re-runs.
 *    - Path composer + parser round-trip for shape A (mail/contact/...)
 *      AND shape B (derived_entity), incl. the dotted
 *      platform-reference scope (`connection.api.<vendor>.<entity>`).
 *    - Hash helpers are byte-stable across structurally-equivalent
 *      JSON (canonical-JSON discipline shared with `@recued/crypto`).
 *
 *  Spec: docs/d-145-spec.md § A.7.10. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeEnrichmentPath,
  createLlmResultCacheStore,
  ensureHousekeepingSchema,
  hashEnrichmentResult,
  hashLlmInput,
  parseEnrichmentPath,
  readEnrichmentValueFromPath,
  type LlmResultCacheStore,
} from '../housekeeping/index.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let store: LlmResultCacheStore;
let enrichmentStore: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-6-cache-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureHousekeepingSchema(db);
  enrichmentStore = createEnrichmentStore(db);
  store = createLlmResultCacheStore(db);
});

afterEach(() => {
  enrichmentStore.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// 1. Store CRUD
// ────────────────────────────────────────────────────────────────

describe('LlmResultCacheStore — CRUD', () => {
  it('lookup returns null when no row matches', () => {
    expect(store.lookup('missing-hash')).toBeNull();
    expect(store.getRow('missing-hash')).toBeNull();
  });

  it('insertOrIgnore + lookup returns the entry', () => {
    store.insertOrIgnore({
      input_hash: 'h1',
      result_hash: 'r1',
      result_path: 'data.enrichment.summary.mail.msg-1',
      computed_at: 1_700_000_000_000,
    });
    expect(store.lookup('h1')).toEqual({
      input_hash: 'h1',
      result_hash: 'r1',
      result_path: 'data.enrichment.summary.mail.msg-1',
      computed_at: 1_700_000_000_000,
    });
  });

  it('insertOrIgnore is first-writer-wins (subsequent inserts ignored)', () => {
    store.insertOrIgnore({
      input_hash: 'h1',
      result_hash: 'r1',
      result_path: 'data.enrichment.summary.mail.msg-1',
      computed_at: 1_700_000_000_000,
    });
    // Second insert with same input_hash but different result_path —
    // first writer wins, the cache is NOT updated.
    store.insertOrIgnore({
      input_hash: 'h1',
      result_hash: 'r2-different',
      result_path: 'data.enrichment.summary.mail.msg-2',
      computed_at: 1_700_000_001_000,
    });
    const entry = store.lookup('h1');
    expect(entry?.result_path).toBe('data.enrichment.summary.mail.msg-1');
    expect(entry?.result_hash).toBe('r1');
    expect(entry?.computed_at).toBe(1_700_000_000_000);
  });

  it('incrementHitCount bumps hit_count on each call', () => {
    store.insertOrIgnore({
      input_hash: 'h1',
      result_hash: 'r1',
      result_path: 'data.enrichment.summary.mail.msg-1',
      computed_at: 1_700_000_000_000,
    });
    expect(store.getRow('h1')?.hit_count).toBe(0);
    store.incrementHitCount('h1');
    expect(store.getRow('h1')?.hit_count).toBe(1);
    store.incrementHitCount('h1');
    store.incrementHitCount('h1');
    expect(store.getRow('h1')?.hit_count).toBe(3);
  });

  it('incrementHitCount is best-effort on a missing row', () => {
    // No throw on a missing row — concurrent GC may have removed the
    // entry between lookup + increment.
    expect(() => store.incrementHitCount('missing')).not.toThrow();
  });

  it('delete returns true when a row existed + false otherwise', () => {
    store.insertOrIgnore({
      input_hash: 'h1',
      result_hash: 'r1',
      result_path: 'data.enrichment.summary.mail.msg-1',
      computed_at: 1_700_000_000_000,
    });
    expect(store.delete('h1')).toBe(true);
    expect(store.lookup('h1')).toBeNull();
    expect(store.delete('h1')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. gcDanglingRefs
// ────────────────────────────────────────────────────────────────

describe('LlmResultCacheStore — gcDanglingRefs', () => {
  it('drops rows whose resolvePathExists returns false', () => {
    store.insertOrIgnore({
      input_hash: 'live',
      result_hash: 'r',
      result_path: 'data.enrichment.summary.mail.msg-1',
      computed_at: 1_700_000_000_000,
    });
    store.insertOrIgnore({
      input_hash: 'dangling',
      result_hash: 'r',
      result_path: 'data.enrichment.summary.mail.msg-2',
      computed_at: 1_700_000_000_000,
    });

    const result = store.gcDanglingRefs({
      resolvePathExists: (path) => path === 'data.enrichment.summary.mail.msg-1',
    });
    expect(result.rows_deleted).toBe(1);
    expect(store.lookup('live')).not.toBeNull();
    expect(store.lookup('dangling')).toBeNull();
  });

  it('returns 0 rows_deleted when every path resolves', () => {
    store.insertOrIgnore({
      input_hash: 'a',
      result_hash: 'r',
      result_path: 'data.enrichment.summary.mail.msg-1',
      computed_at: 1_700_000_000_000,
    });
    const result = store.gcDanglingRefs({ resolvePathExists: () => true });
    expect(result.rows_deleted).toBe(0);
    expect(store.lookup('a')).not.toBeNull();
  });

  it('is idempotent (re-running yields 0 after the first sweep)', () => {
    store.insertOrIgnore({
      input_hash: 'dangling',
      result_hash: 'r',
      result_path: 'data.enrichment.summary.mail.msg-2',
      computed_at: 1_700_000_000_000,
    });
    expect(store.gcDanglingRefs({ resolvePathExists: () => false }).rows_deleted).toBe(1);
    expect(store.gcDanglingRefs({ resolvePathExists: () => false }).rows_deleted).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. composeEnrichmentPath + parseEnrichmentPath
// ────────────────────────────────────────────────────────────────

describe('composeEnrichmentPath + parseEnrichmentPath round-trip', () => {
  it('shape A — mail scope', () => {
    const path = composeEnrichmentPath({
      topic: 'summary',
      scope: 'mail',
      target_id: 'msg-1',
    });
    expect(path).toBe('data.enrichment.summary.mail.msg-1');
    expect(parseEnrichmentPath(path)).toEqual({
      kind: 'shape_a',
      topic: 'summary',
      scope: 'mail',
      target_id: 'msg-1',
    });
  });

  it('shape A — contact scope', () => {
    const path = composeEnrichmentPath({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
    });
    expect(parseEnrichmentPath(path)).toEqual({
      kind: 'shape_a',
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
    });
  });

  it('shape A — dotted platform-reference scope (D-128)', () => {
    // The platform-reference scope carries multiple dots
    // (`connection.api.<vendor>.<entity>`); the parser uses the
    // topic's registered valid_scopes to pick the right split point.
    // `engagement_silence_duration` is registered against both
    // hubspot.deal and salesforce.opportunity scopes.
    const path = composeEnrichmentPath({
      topic: 'engagement_silence_duration',
      scope: 'connection.api.hubspot.deal',
      target_id: 'deal-123',
    });
    expect(path).toBe(
      'data.enrichment.engagement_silence_duration.connection.api.hubspot.deal.deal-123',
    );
    expect(parseEnrichmentPath(path)).toEqual({
      kind: 'shape_a',
      topic: 'engagement_silence_duration',
      scope: 'connection.api.hubspot.deal',
      target_id: 'deal-123',
    });
  });

  it('shape A — target_id containing dots (email addresses)', () => {
    // Email target_ids carry their own dots; the parser must use
    // valid_scopes (not lastIndexOf-dot) to find the boundary.
    const path = composeEnrichmentPath({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'first.last@example.co.uk',
    });
    expect(parseEnrichmentPath(path)).toEqual({
      kind: 'shape_a',
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'first.last@example.co.uk',
    });
  });

  it('shape B — derived_entity', () => {
    const path = composeEnrichmentPath({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_xyz',
    });
    expect(path).toBe('data.enrichment.topic_cluster.cluster_xyz');
    expect(parseEnrichmentPath(path)).toEqual({
      kind: 'shape_b',
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_xyz',
    });
  });

  it('returns null on malformed paths', () => {
    expect(parseEnrichmentPath('not.an.enrichment.path')).toBeNull();
    expect(parseEnrichmentPath('data.enrichment.')).toBeNull();
    expect(parseEnrichmentPath('data.enrichment.summary')).toBeNull(); // no shape segment
    expect(parseEnrichmentPath('data.enrichment.unknown_topic.mail.msg-1')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Hash helpers
// ────────────────────────────────────────────────────────────────

describe('hash helpers', () => {
  it('hashLlmInput is stable across structurally-equivalent objects', () => {
    const a = { system_prompt: 'be concise', user: 'hello', schema: { type: 'object' } };
    const b = { schema: { type: 'object' }, user: 'hello', system_prompt: 'be concise' };
    expect(hashLlmInput(a)).toBe(hashLlmInput(b));
  });

  it('hashLlmInput differentiates on content change', () => {
    const a = { user: 'hello' };
    const b = { user: 'world' };
    expect(hashLlmInput(a)).not.toBe(hashLlmInput(b));
  });

  it('hashEnrichmentResult is stable across key reordering', () => {
    const a = { summary: 's', key_points: ['a', 'b'] };
    const b = { key_points: ['a', 'b'], summary: 's' };
    expect(hashEnrichmentResult(a)).toBe(hashEnrichmentResult(b));
  });

  it('hash is hex-encoded SHA-256 (64 chars)', () => {
    const h = hashLlmInput({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. readEnrichmentValueFromPath
// ────────────────────────────────────────────────────────────────

describe('readEnrichmentValueFromPath', () => {
  it('returns null for an unresolved shape-A path', () => {
    expect(
      readEnrichmentValueFromPath(
        enrichmentStore,
        'data.enrichment.summary.mail.absent',
      ),
    ).toBeNull();
  });

  it('returns the stored value for a populated shape-A row', () => {
    enrichmentStore.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'msg-1',
      value: { summary: 'short summary', key_points: ['one'] },
      authored_by: 'system.summarizer',
    });
    const value = readEnrichmentValueFromPath(
      enrichmentStore,
      'data.enrichment.summary.mail.msg-1',
    );
    expect(value).toEqual({ summary: 'short summary', key_points: ['one'] });
  });

  it('returns the stored value for a populated shape-B (derived_entity) row', () => {
    const validTopicCluster = {
      topic_name: 'Test Cluster',
      summary: 'Stub cluster for read-from-path test.',
      members: ['msg-1', 'msg-2'],
      thread_ids: ['t-msg-1', 't-msg-2'],
      theme_tokens: ['test'],
      thread_count: 2,
      ai_invoked: true,
      confidence: 0.75,
      computed_at: 1_700_000_000_000,
      window_ms: 90 * 24 * 60 * 60 * 1000,
    };
    enrichmentStore.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_xyz',
      value: validTopicCluster,
      authored_by: 'system',
    });
    const value = readEnrichmentValueFromPath(
      enrichmentStore,
      'data.enrichment.topic_cluster.cluster_xyz',
    );
    expect(value).toEqual(validTopicCluster);
  });

  it('returns null on a malformed path', () => {
    expect(readEnrichmentValueFromPath(enrichmentStore, 'garbage')).toBeNull();
  });
});
