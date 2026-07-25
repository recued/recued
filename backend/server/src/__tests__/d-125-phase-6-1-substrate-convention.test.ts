/** D-125 Phase 6.1 — Enrichment substrate convention (storage surface).
 *
 *  Convention-only widening: the storage layer + resolver accept the
 *  three new `connection.*` scopes without SQL migration. Registry
 *  + helper tests live in
 *  `packages/contracts/src/__tests__/d-125-phase-6-1-substrate.test.ts`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeEnrichmentScope,
  type ConnectionHealthTrendValue,
  type ConnectionLastUsedPatternValue,
} from '@recued/contracts';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createEnrichmentResolver } from '../storage/enrichment-resolver.js';

/** Build a minimally-valid ConnectionHealthTrendValue for substrate
 *  round-trip tests. The values are arbitrary — the test cares about
 *  the wire shape (scope / target_id / topic round-trip), not the
 *  numeric content. Each call mints a fresh object so callers can
 *  override fields per scenario. */
const buildHealthTrendValue = (
  overrides: Partial<ConnectionHealthTrendValue> = {},
): ConnectionHealthTrendValue => ({
  call_count: 1,
  error_count: 0,
  error_rate: 0,
  latency_p50_ms: null,
  latency_p95_ms: null,
  last_call_at: 1_700_000_000_000,
  last_failure: null,
  window_ms: 7 * 24 * 60 * 60 * 1000,
  computed_at: 1_700_000_000_000,
  ...overrides,
});

/** Build a minimally-valid ConnectionLastUsedPatternValue. Mirrors
 *  `buildHealthTrendValue` — substrate round-trip cares about the wire
 *  shape, not the numeric content. A.19 tightened the registry schema
 *  off the `acceptObject` placeholder, so substrate tests must produce
 *  shape-conformant values. */
const buildLastUsedPatternValue = (
  overrides: Partial<ConnectionLastUsedPatternValue> = {},
): ConnectionLastUsedPatternValue => ({
  call_count: 0,
  last_used_at: null,
  recipes: [],
  distinct_recipes: 0,
  unattributed_call_count: 0,
  hour_histogram: Array.from({ length: 24 }, () => 0),
  window_ms: 30 * 24 * 60 * 60 * 1000,
  computed_at: 1_700_000_000_000,
  ...overrides,
});

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-125-p6-1-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-125 P6.1 — Store accepts connection.<kind> upserts', () => {
  it('upsert + list round-trips a connection.api scope row', () => {
    const value = buildHealthTrendValue({ error_rate: 0.02 });
    const out = store.upsert({
      topic: 'connection_health_trend',
      scope: composeEnrichmentScope('connection', 'api'),
      target_id: 'hubspot',
      value,
      authored_by: 'housekeeping.connection-health-v1',
    });
    expect(out.scope).toBe('connection.api');
    expect(out.target_id).toBe('hubspot');

    const rows = store.list({
      topic: 'connection_health_trend',
      scope: 'connection.api',
      target_id: 'hubspot',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toEqual(value);
  });

  it('rejects connection_optimal_batch_size on connection.notification (not in valid_scopes)', () => {
    expect(() =>
      store.upsert({
        topic: 'connection_optimal_batch_size',
        scope: 'connection.notification',
        target_id: 'team-slack',
        value: { batch_size: 16 },
        authored_by: 'housekeeping.optimal-batch-v1',
      }),
    ).toThrow(/enrichment_scope_unsupported/);
  });
});

describe('D-125 P6.1 — Resolver walks compound connection.<kind> paths', () => {
  it('resolves data.enrichment.connection.api.<name>.<topic> to the value', () => {
    const value = buildHealthTrendValue({ error_rate: 0.02 });
    store.upsert({
      topic: 'connection_health_trend',
      scope: 'connection.api',
      target_id: 'hubspot',
      value,
      authored_by: 'housekeeping.connection-health-v1',
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['connection', 'api', 'hubspot', 'connection_health_trend']);
    expect(out.kind).toBe('value');
    if (out.kind === 'value') {
      expect(out.value).toEqual(value);
    }
  });

  it('returns null for unknown connection kind', () => {
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['connection', 'service', 'foo', 'connection_health_trend']);
    expect(out.kind).toBe('null');
  });

  it('returns the per-record bag when no topic is supplied', () => {
    store.upsert({
      topic: 'connection_health_trend',
      scope: 'connection.mcp',
      target_id: 'gh-mcp',
      value: buildHealthTrendValue(),
      authored_by: 'housekeeping.connection-health-v1',
    });
    // `connection_last_used_pattern` registry schema tightened in A.19
    // — substrate tests now produce shape-conformant values via
    // `buildLastUsedPatternValue`.
    store.upsert({
      topic: 'connection_last_used_pattern',
      scope: 'connection.mcp',
      target_id: 'gh-mcp',
      value: buildLastUsedPatternValue({
        hour_histogram: (() => {
          const h = Array.from({ length: 24 }, () => 0);
          h[2] = 4;
          h[3] = 12;
          h[4] = 18;
          return h;
        })(),
      }),
      authored_by: 'housekeeping.last-used-v1',
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['connection', 'mcp', 'gh-mcp']);
    expect(out.kind).toBe('list');
    if (out.kind === 'list') {
      const topics = out.records.map((r) => r.topic).sort();
      expect(topics).toEqual(['connection_health_trend', 'connection_last_used_pattern']);
    }
  });
});
