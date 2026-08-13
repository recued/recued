/** D-131 A.18 — `connection_health_trend` producer tests.
 *
 *  Drives the standalone `connectionHealthTrendTask` against a real
 *  in-memory `data_enrichment` table + `connections` + `audit_activities`
 *  fixtures. Verifies:
 *   - Surface contract (topic / kind / is_ai_surface=false / token=0)
 *   - Pure helpers (percentile / computeHealthTrendValue stats / sweep)
 *   - Connection scan + missing-table tolerance
 *   - Audit aggregation per (kind, name) + window cutoff + JSON-parse
 *     defenses
 *   - Whole-cycle orchestration — happy path / multi-kind isolation /
 *     zero-call shape / sweep on un-enroll
 *   - Registry value_schema accept / reject
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ConnectionHealthTrendValue,
  type ConnectionKind,
} from '@recued/contracts';

import {
  CONNECTION_HEALTH_TREND_AUTHORED_BY,
  CONNECTION_HEALTH_TREND_TOPIC,
  CONNECTION_HEALTH_TREND_WINDOW_MS,
  CONNECTION_HEALTH_TREND_P50_MIN_SAMPLE_COUNT,
  CONNECTION_HEALTH_TREND_P95_MIN_SAMPLE_COUNT,
  CONNECTION_HEALTH_TREND_TOKEN_ESTIMATE,
  CONNECTION_HEALTH_TREND_MAX_CONNECTIONS_SCANNED,
  CONNECTION_HEALTH_TREND_SCOPE_FOR_KIND,
  collectActivitiesForConnection,
  composeConnectionHealthTrendFreshKey,
  computeHealthTrendValue,
  connectionHealthTrendPercentile,
  connectionHealthTrendScopeReadDeclaration,
  connectionHealthTrendTask,
  connectionHealthTrendTokenEstimate,
  runConnectionHealthTrendCycle,
  scanEnrolledConnections,
  sweepStaleHealthTrendRows,
} from '../housekeeping/index.js';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

const installConnectionsTable = (): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      name           TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK (kind IN ('mcp', 'api', 'notification')),
      subtype        TEXT,
      display_name   TEXT NOT NULL,
      publisher_id   TEXT,
      config_json    TEXT NOT NULL,
      auth_json      TEXT NOT NULL,
      enrolled_at    INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_used_at   INTEGER,
      health_json    TEXT,
      PRIMARY KEY (kind, name)
    );
  `);
};

const installAuditActivitiesTable = (): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_activities (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-conn-health-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  installConnectionsTable();
  installAuditActivitiesTable();
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface InsertedConnection {
  kind: ConnectionKind;
  name: string;
  display_name?: string;
  updated_at?: number;
}

const insertConnection = (c: InsertedConnection): void => {
  db.prepare(
    `INSERT INTO connections (
       name, kind, subtype, display_name, publisher_id,
       config_json, auth_json, enrolled_at, updated_at,
       last_used_at, health_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.name,
    c.kind,
    null,
    c.display_name ?? c.name,
    null,
    '{}',
    'cipher',
    NOW - 30 * ONE_DAY,
    c.updated_at ?? NOW - ONE_DAY,
    null,
    null,
  );
};

interface InsertedActivity {
  kind: ConnectionKind;
  name: string;
  ts: number;
  status?: 'ok' | 'error';
  duration_ms?: number;
  error_code?: string;
  error_message?: string;
}

const ACTION_FOR_KIND: Record<ConnectionKind, string> = {
  api: 'connection_api',
  mcp: 'connection_mcp',
  notification: 'connection_notification',
};

let activityCounter = 0;
const insertActivity = (a: InsertedActivity): void => {
  activityCounter += 1;
  const detail: Record<string, unknown> = {
    status: a.status ?? 'ok',
    duration_ms: a.duration_ms ?? 100,
    intent: 'test',
  };
  if (a.status === 'error') {
    detail.error = {
      code: a.error_code ?? 'TEST_ERROR',
      message: a.error_message ?? 'something went wrong',
    };
  }
  const entry = {
    activity_id: `act-${activityCounter}`,
    timestamp: a.ts,
    action: ACTION_FOR_KIND[a.kind],
    target: a.name,
    detail: JSON.stringify(detail),
  };
  db.prepare(`INSERT INTO audit_activities (key, data) VALUES (?, ?)`).run(
    entry.activity_id,
    JSON.stringify(entry),
  );
};

const buildCtx = (now: number = NOW): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('connectionHealthTrendTask surface contract', () => {
  it('targets the connection_health_trend registry topic', () => {
    expect(connectionHealthTrendTask.topic).toBe('connection_health_trend');
  });

  it('declares is_ai_surface=false (deterministic)', () => {
    expect(connectionHealthTrendTask.is_ai_surface).toBe(false);
  });

  it('declares meta.kind=enrichment', () => {
    expect(connectionHealthTrendTask.meta.kind).toBe('enrichment');
  });

  it('declares meta.id=enrichment.connection_health_trend', () => {
    expect(connectionHealthTrendTask.meta.id).toBe('enrichment.connection_health_trend');
  });

  it('declares meta.interruptible=true', () => {
    expect(connectionHealthTrendTask.meta.interruptible).toBe(true);
  });

  it('does NOT stamp idle_eligible (D-132 trust gate resolves at runtime)', () => {
    expect(connectionHealthTrendTask.meta.idle_eligible).toBeUndefined();
  });

  it('exposes a zero-token cycle estimate (deterministic)', () => {
    expect(connectionHealthTrendTokenEstimate()).toBe(0);
    expect(connectionHealthTrendTokenEstimate()).toBe(CONNECTION_HEALTH_TREND_TOKEN_ESTIMATE);
  });

  it('declares non-empty scope_read_declaration over connections + audit', () => {
    expect(connectionHealthTrendScopeReadDeclaration.length).toBeGreaterThan(0);
    const conn = connectionHealthTrendScopeReadDeclaration.find(
      (e) => e.collection === 'connection',
    );
    const audit = connectionHealthTrendScopeReadDeclaration.find(
      (e) => e.collection === 'data.audit',
    );
    expect(conn).toBeDefined();
    expect(audit).toBeDefined();
    expect((conn!.sample_field_paths as ReadonlyArray<string>).length).toBeGreaterThan(0);
    expect((audit!.sample_field_paths as ReadonlyArray<string>).length).toBeGreaterThan(0);
  });
});

describe('connection_health_trend registry entry', () => {
  it('is shape: per_record', () => {
    expect(ENRICHMENT_REGISTRY.connection_health_trend.shape).toBe('per_record');
  });

  it('uses policy: aggregate', () => {
    expect(ENRICHMENT_REGISTRY.connection_health_trend.policy).toBe('aggregate');
  });

  it('valid_scopes covers all three connection kinds', () => {
    const def = ENRICHMENT_REGISTRY.connection_health_trend;
    expect(def.valid_scopes).toEqual(
      expect.arrayContaining([
        'connection.api',
        'connection.mcp',
        'connection.notification',
      ]),
    );
  });

  it('uses producer_kind=housekeeping', () => {
    expect(ENRICHMENT_REGISTRY.connection_health_trend.producer_kind).toBe('housekeeping');
  });

  it('declares aggregates_from: ["audit"] — the run-provenance trail, never user_memory', () => {
    expect(ENRICHMENT_REGISTRY.connection_health_trend.aggregates_from).toEqual(['audit']);
  });

  it('declares recompute_cadence: 24h', () => {
    expect(ENRICHMENT_REGISTRY.connection_health_trend.recompute_cadence).toBe('24h');
  });

  it('does NOT declare emits_confidence (deterministic, no LLM)', () => {
    const def = ENRICHMENT_REGISTRY.connection_health_trend as { emits_confidence?: boolean };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('does NOT declare default_trust_state (resolver returns "auto" for non-AI)', () => {
    const def = ENRICHMENT_REGISTRY.connection_health_trend as { default_trust_state?: string };
    expect(def.default_trust_state).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Scope mapping
// ────────────────────────────────────────────────────────────────

describe('SCOPE_FOR_CONNECTION_KIND', () => {
  it('maps api → connection.api', () => {
    expect(CONNECTION_HEALTH_TREND_SCOPE_FOR_KIND.api).toBe('connection.api');
  });

  it('maps mcp → connection.mcp', () => {
    expect(CONNECTION_HEALTH_TREND_SCOPE_FOR_KIND.mcp).toBe('connection.mcp');
  });

  it('maps notification → connection.notification', () => {
    expect(CONNECTION_HEALTH_TREND_SCOPE_FOR_KIND.notification).toBe('connection.notification');
  });
});

describe('composeConnectionHealthTrendFreshKey', () => {
  it('concatenates scope + target_id with a separator', () => {
    expect(composeConnectionHealthTrendFreshKey('connection.api', 'hubspot')).toBe(
      'connection.api hubspot',
    );
  });

  it('produces distinct keys across kinds with the same name', () => {
    const a = composeConnectionHealthTrendFreshKey('connection.api', 'hubspot');
    const m = composeConnectionHealthTrendFreshKey('connection.mcp', 'hubspot');
    const n = composeConnectionHealthTrendFreshKey('connection.notification', 'hubspot');
    expect(new Set([a, m, n]).size).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — percentile
// ────────────────────────────────────────────────────────────────

describe('connectionHealthTrendPercentile', () => {
  it('returns null on empty input', () => {
    expect(connectionHealthTrendPercentile([], 0.5)).toBe(null);
  });

  it('returns the only sample on single-element input', () => {
    expect(connectionHealthTrendPercentile([42], 0.5)).toBe(42);
    expect(connectionHealthTrendPercentile([42], 0.95)).toBe(42);
  });

  it('returns p50 of a 10-element input via nearest-rank', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(connectionHealthTrendPercentile(samples, 0.5)).toBe(5);
  });

  it('returns p95 of a 20-element input via nearest-rank', () => {
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(connectionHealthTrendPercentile(samples, 0.95)).toBe(19);
  });

  it('clamps quantile above 1 to the max element', () => {
    expect(connectionHealthTrendPercentile([1, 2, 3], 1.5)).toBe(3);
  });

  it('clamps quantile below 0 to the first element', () => {
    expect(connectionHealthTrendPercentile([1, 2, 3], -0.5)).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — computeHealthTrendValue
// ────────────────────────────────────────────────────────────────

const buildRow = (
  ts: number,
  status: 'ok' | 'error' = 'ok',
  duration_ms: number = 100,
  error_code: string | null = null,
  error_message: string | null = null,
): {
  ts: number;
  status: 'ok' | 'error';
  duration_ms: number;
  error_code: string | null;
  error_message: string | null;
  recipe_id: string | null;
  step_id: string | null;
  bytes_in: number | null;
  bytes_out: number | null;
} => ({
  ts,
  status,
  duration_ms,
  error_code,
  error_message,
  recipe_id: null,
  step_id: null,
  bytes_in: null,
  bytes_out: null,
});

describe('computeHealthTrendValue', () => {
  it('returns the zero-call shape for empty input', () => {
    const v = computeHealthTrendValue([], NOW);
    expect(v.call_count).toBe(0);
    expect(v.error_count).toBe(0);
    expect(v.error_rate).toBe(0);
    expect(v.latency_p50_ms).toBe(null);
    expect(v.latency_p95_ms).toBe(null);
    expect(v.last_call_at).toBe(null);
    expect(v.last_failure).toBe(null);
    expect(v.window_ms).toBe(CONNECTION_HEALTH_TREND_WINDOW_MS);
    expect(v.computed_at).toBe(NOW);
  });

  it('counts calls and folds error_count', () => {
    const rows = [
      buildRow(NOW - ONE_HOUR, 'ok', 100),
      buildRow(NOW - 2 * ONE_HOUR, 'error', 250, 'TIMEOUT', 'request timed out'),
      buildRow(NOW - 3 * ONE_HOUR, 'ok', 150),
    ];
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.call_count).toBe(3);
    expect(v.error_count).toBe(1);
    expect(v.error_rate).toBeCloseTo(1 / 3);
  });

  it('records last_call_at as the most recent ts (any status)', () => {
    const rows = [
      buildRow(NOW - ONE_DAY, 'ok'),
      buildRow(NOW - ONE_HOUR, 'ok'),
      buildRow(NOW - 6 * ONE_HOUR, 'error'),
    ];
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.last_call_at).toBe(NOW - ONE_HOUR);
  });

  it('records last_failure as the most recent error', () => {
    const rows = [
      buildRow(NOW - ONE_DAY, 'error', 200, 'OLD_ERR', 'old failure'),
      buildRow(NOW - ONE_HOUR, 'error', 300, 'NEW_ERR', 'new failure'),
      buildRow(NOW - 30 * 60 * 1000, 'ok', 100),
    ];
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.last_failure).not.toBeNull();
    expect(v.last_failure!.ts).toBe(NOW - ONE_HOUR);
    expect(v.last_failure!.error_code).toBe('NEW_ERR');
    expect(v.last_failure!.error_message).toBe('new failure');
  });

  it('returns null last_failure when no errors in window', () => {
    const rows = [buildRow(NOW - ONE_HOUR, 'ok'), buildRow(NOW - ONE_DAY, 'ok')];
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.last_failure).toBe(null);
  });

  it('defaults last_failure error fields to "" when emitter wrote no error block', () => {
    const rows = [buildRow(NOW, 'error', 100, null, null)];
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.last_failure).not.toBeNull();
    expect(v.last_failure!.error_code).toBe('');
    expect(v.last_failure!.error_message).toBe('');
  });

  it('returns null p50 below the p50 sample-count floor', () => {
    const rows = Array.from({ length: CONNECTION_HEALTH_TREND_P50_MIN_SAMPLE_COUNT - 1 }, (_, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', 100 + i),
    );
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.latency_p50_ms).toBe(null);
    expect(v.latency_p95_ms).toBe(null);
  });

  it('returns numeric p50 at the p50 sample-count floor', () => {
    const rows = Array.from({ length: CONNECTION_HEALTH_TREND_P50_MIN_SAMPLE_COUNT }, (_, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', 100 + i),
    );
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.latency_p50_ms).not.toBe(null);
    expect(v.latency_p95_ms).toBe(null); // still below p95 floor
  });

  it('returns numeric p95 at the p95 sample-count floor', () => {
    const rows = Array.from({ length: CONNECTION_HEALTH_TREND_P95_MIN_SAMPLE_COUNT }, (_, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', 100 + i),
    );
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.latency_p50_ms).not.toBe(null);
    expect(v.latency_p95_ms).not.toBe(null);
  });

  it('p95 reflects the 95th-percentile latency on a uniform distribution', () => {
    // 20 samples of 100, 200, ..., 2000 → p95 = 1900 (rank 19)
    const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    const rows = latencies.map((d, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', d),
    );
    const v = computeHealthTrendValue(rows, NOW);
    expect(v.latency_p95_ms).toBe(1900);
    expect(v.latency_p50_ms).toBe(1000); // rank 10 of 20
  });
});

// ────────────────────────────────────────────────────────────────
// scanEnrolledConnections
// ────────────────────────────────────────────────────────────────

describe('scanEnrolledConnections', () => {
  it('returns empty when no connections enrolled', () => {
    expect(scanEnrolledConnections(buildCtx())).toEqual([]);
  });

  it('returns enrolled connections across all kinds', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'github-mcp' });
    insertConnection({ kind: 'notification', name: 'slack-personal' });
    const out = scanEnrolledConnections(buildCtx());
    expect(out).toHaveLength(3);
    const kinds = out.map((c) => c.kind).sort();
    expect(kinds).toEqual(['api', 'mcp', 'notification']);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i += 1) {
      insertConnection({ kind: 'api', name: `conn-${i}`, updated_at: NOW - i * ONE_HOUR });
    }
    const out = scanEnrolledConnections(buildCtx(), 5);
    expect(out).toHaveLength(5);
  });

  it('returns empty when connections table is missing', () => {
    db.exec('DROP TABLE connections');
    expect(scanEnrolledConnections(buildCtx())).toEqual([]);
  });

  it('orders by updated_at DESC + name ASC', () => {
    insertConnection({ kind: 'api', name: 'older', updated_at: NOW - ONE_DAY });
    insertConnection({ kind: 'api', name: 'newer', updated_at: NOW });
    const out = scanEnrolledConnections(buildCtx());
    expect(out[0]!.name).toBe('newer');
    expect(out[1]!.name).toBe('older');
  });

  it('exposes MAX_CONNECTIONS_SCANNED as a defensive cap', () => {
    expect(CONNECTION_HEALTH_TREND_MAX_CONNECTIONS_SCANNED).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────
// collectActivitiesForConnection
// ────────────────────────────────────────────────────────────────

describe('collectActivitiesForConnection', () => {
  it('returns empty when no audit rows match', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    const out = collectActivitiesForConnection(
      buildCtx(),
      'api',
      'hubspot',
      NOW - CONNECTION_HEALTH_TREND_WINDOW_MS,
    );
    expect(out).toEqual([]);
  });

  it('returns rows matching action + target + cutoff', () => {
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok', duration_ms: 100 });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 2 * ONE_HOUR, status: 'error' });
    const cutoff = NOW - CONNECTION_HEALTH_TREND_WINDOW_MS;
    const out = collectActivitiesForConnection(buildCtx(), 'api', 'hubspot', cutoff);
    expect(out).toHaveLength(2);
  });

  it('excludes rows older than the cutoff', () => {
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 100 * ONE_DAY }); // way old
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR });
    const cutoff = NOW - CONNECTION_HEALTH_TREND_WINDOW_MS;
    const out = collectActivitiesForConnection(buildCtx(), 'api', 'hubspot', cutoff);
    expect(out).toHaveLength(1);
    expect(out[0]!.ts).toBe(NOW - ONE_HOUR);
  });

  it('isolates by kind', () => {
    insertActivity({ kind: 'api', name: 'shared-name', ts: NOW - ONE_HOUR });
    insertActivity({ kind: 'mcp', name: 'shared-name', ts: NOW - ONE_HOUR });
    insertActivity({ kind: 'notification', name: 'shared-name', ts: NOW - ONE_HOUR });

    const cutoff = NOW - CONNECTION_HEALTH_TREND_WINDOW_MS;
    const apiOut = collectActivitiesForConnection(buildCtx(), 'api', 'shared-name', cutoff);
    const mcpOut = collectActivitiesForConnection(buildCtx(), 'mcp', 'shared-name', cutoff);
    const notifOut = collectActivitiesForConnection(buildCtx(), 'notification', 'shared-name', cutoff);

    expect(apiOut).toHaveLength(1);
    expect(mcpOut).toHaveLength(1);
    expect(notifOut).toHaveLength(1);
  });

  it('isolates by target name', () => {
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR });
    insertActivity({ kind: 'api', name: 'salesforce', ts: NOW - ONE_HOUR });
    const cutoff = NOW - CONNECTION_HEALTH_TREND_WINDOW_MS;
    const out = collectActivitiesForConnection(buildCtx(), 'api', 'hubspot', cutoff);
    expect(out).toHaveLength(1);
  });

  it('parses status / duration_ms / error from the detail blob', () => {
    insertActivity({
      kind: 'api',
      name: 'hubspot',
      ts: NOW - ONE_HOUR,
      status: 'error',
      duration_ms: 425,
      error_code: 'RATE_LIMIT',
      error_message: 'too many requests',
    });
    const out = collectActivitiesForConnection(
      buildCtx(),
      'api',
      'hubspot',
      NOW - CONNECTION_HEALTH_TREND_WINDOW_MS,
    );
    expect(out).toHaveLength(1);
    const row = out[0]!;
    expect(row.status).toBe('error');
    expect(row.duration_ms).toBe(425);
    expect(row.error_code).toBe('RATE_LIMIT');
    expect(row.error_message).toBe('too many requests');
  });

  it('skips rows with malformed detail blob (top-level JSON parses, detail does not)', () => {
    // Manufacture an entry whose `data` is valid JSON but `detail` is
    // a malformed string. The audit emitter writes well-formed JSON for
    // both layers; this exercises the inner JSON.parse defense for the
    // forensic case where an external write corrupted the detail blob.
    const broken = {
      activity_id: 'broken-detail',
      timestamp: NOW - ONE_HOUR,
      action: 'connection_api',
      target: 'hubspot',
      detail: 'not-valid-json-{',
    };
    db.prepare(`INSERT INTO audit_activities (key, data) VALUES (?, ?)`).run(
      'broken-detail',
      JSON.stringify(broken),
    );
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 2 * ONE_HOUR });
    const out = collectActivitiesForConnection(
      buildCtx(),
      'api',
      'hubspot',
      NOW - CONNECTION_HEALTH_TREND_WINDOW_MS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ts).toBe(NOW - 2 * ONE_HOUR);
  });

  it('returns empty when audit_activities table is missing', () => {
    db.exec('DROP TABLE audit_activities');
    insertConnection({ kind: 'api', name: 'hubspot' });
    const out = collectActivitiesForConnection(
      buildCtx(),
      'api',
      'hubspot',
      NOW - CONNECTION_HEALTH_TREND_WINDOW_MS,
    );
    expect(out).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// runConnectionHealthTrendCycle — end-to-end
// ────────────────────────────────────────────────────────────────

describe('runConnectionHealthTrendCycle', () => {
  it('produces zero rows when no connections enrolled', () => {
    const out = runConnectionHealthTrendCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('emits one row per enrolled connection (zero-call shape allowed)', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'github-mcp' });
    const out = runConnectionHealthTrendCycle(buildCtx());
    expect(out.produced).toBe(2);

    const rows = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.authored_by).toBe(CONNECTION_HEALTH_TREND_AUTHORED_BY);
      const v = row.value as ConnectionHealthTrendValue;
      expect(v.call_count).toBe(0);
      expect(v.error_rate).toBe(0);
      expect(v.last_call_at).toBe(null);
      expect(v.last_failure).toBe(null);
    }
  });

  it('emits scope=connection.<kind> + target_id=name', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'github-mcp' });
    insertConnection({ kind: 'notification', name: 'slack-personal' });
    runConnectionHealthTrendCycle(buildCtx());

    const rows = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });
    const byScope = new Map(rows.map((r) => [r.scope, r.target_id] as const));
    expect(byScope.get('connection.api')).toBe('hubspot');
    expect(byScope.get('connection.mcp')).toBe('github-mcp');
    expect(byScope.get('connection.notification')).toBe('slack-personal');
  });

  it('aggregates stats from matching audit activities', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok', duration_ms: 100 });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 2 * ONE_HOUR, status: 'ok', duration_ms: 200 });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 3 * ONE_HOUR, status: 'error', duration_ms: 500, error_code: 'TIMEOUT' });

    runConnectionHealthTrendCycle(buildCtx());
    const rows = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(1);
    const v = rows[0]!.value as ConnectionHealthTrendValue;
    expect(v.call_count).toBe(3);
    expect(v.error_count).toBe(1);
    expect(v.error_rate).toBeCloseTo(1 / 3);
    expect(v.last_call_at).toBe(NOW - ONE_HOUR);
    expect(v.last_failure).not.toBeNull();
    expect(v.last_failure!.error_code).toBe('TIMEOUT');
  });

  it('isolates aggregates per (kind, name) — no cross-pollination', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'api', name: 'salesforce' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 2 * ONE_HOUR, status: 'error' });
    insertActivity({ kind: 'api', name: 'salesforce', ts: NOW - ONE_HOUR, status: 'ok' });

    runConnectionHealthTrendCycle(buildCtx());
    const rows = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(2);
    const byTarget = new Map(
      rows.map((r) => [r.target_id, r.value as ConnectionHealthTrendValue] as const),
    );
    expect(byTarget.get('hubspot')!.call_count).toBe(2);
    expect(byTarget.get('hubspot')!.error_count).toBe(1);
    expect(byTarget.get('salesforce')!.call_count).toBe(1);
    expect(byTarget.get('salesforce')!.error_count).toBe(0);
  });

  it('isolates aggregates per kind — same name across kinds', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok' });
    insertActivity({ kind: 'mcp', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'error' });

    runConnectionHealthTrendCycle(buildCtx());
    const rows = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(2);
    const byScope = new Map(
      rows.map((r) => [r.scope, r.value as ConnectionHealthTrendValue] as const),
    );
    expect(byScope.get('connection.api')!.error_count).toBe(0);
    expect(byScope.get('connection.mcp')!.error_count).toBe(1);
  });

  it('excludes audit rows older than the rolling window', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 100 * ONE_DAY, status: 'error' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok' });

    runConnectionHealthTrendCycle(buildCtx());
    const rows = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });
    const v = rows[0]!.value as ConnectionHealthTrendValue;
    expect(v.call_count).toBe(1);
    expect(v.error_count).toBe(0);
  });

  it('upserts in place across runs (stable scope+target_id key)', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok' });
    runConnectionHealthTrendCycle(buildCtx());
    const firstIds = store
      .list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false })
      .map((r) => r._id);

    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 30 * 60 * 1000, status: 'error' });
    runConnectionHealthTrendCycle(buildCtx());
    const secondRows = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });

    expect(secondRows).toHaveLength(1);
    expect(secondRows[0]!._id).toBe(firstIds[0]!);
    const v = secondRows[0]!.value as ConnectionHealthTrendValue;
    expect(v.call_count).toBe(2);
    expect(v.error_count).toBe(1);
  });

  it('sweeps rows for un-enrolled connections', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'api', name: 'salesforce' });
    runConnectionHealthTrendCycle(buildCtx());
    expect(store.countForTopic(CONNECTION_HEALTH_TREND_TOPIC)).toBe(2);

    db.prepare(`DELETE FROM connections WHERE kind = ? AND name = ?`).run('api', 'salesforce');
    const out = runConnectionHealthTrendCycle(buildCtx());
    expect(out.swept).toBe(1);

    const remaining = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.target_id).toBe('hubspot');
  });

  it('sweeps every row when all connections are un-enrolled', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    runConnectionHealthTrendCycle(buildCtx());
    expect(store.countForTopic(CONNECTION_HEALTH_TREND_TOPIC)).toBe(1);

    db.prepare(`DELETE FROM connections`).run();
    const out = runConnectionHealthTrendCycle(buildCtx());
    expect(out.swept).toBe(1);
    expect(store.countForTopic(CONNECTION_HEALTH_TREND_TOPIC)).toBe(0);
  });

  it('connectionHealthTrendTask.step returns complete + zero-cost cursor', async () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    const result = await connectionHealthTrendTask.step(
      buildCtx(),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('round-trips through the registry value_schema', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok', duration_ms: 100 });
    expect(() => runConnectionHealthTrendCycle(buildCtx())).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep helper — direct
// ────────────────────────────────────────────────────────────────

describe('sweepStaleHealthTrendRows', () => {
  it('deletes rows whose key isn\'t in the fresh set', () => {
    // Seed two rows directly via the store
    store.upsert({
      topic: CONNECTION_HEALTH_TREND_TOPIC,
      scope: 'connection.api',
      target_id: 'hubspot',
      value: computeHealthTrendValue([], NOW),
      authored_by: CONNECTION_HEALTH_TREND_AUTHORED_BY,
    });
    store.upsert({
      topic: CONNECTION_HEALTH_TREND_TOPIC,
      scope: 'connection.api',
      target_id: 'salesforce',
      value: computeHealthTrendValue([], NOW),
      authored_by: CONNECTION_HEALTH_TREND_AUTHORED_BY,
    });

    const fresh = new Set([
      composeConnectionHealthTrendFreshKey('connection.api', 'hubspot'),
    ]);
    const out = sweepStaleHealthTrendRows(buildCtx(), fresh);
    expect(out.deleted).toBe(1);

    const remaining = store.list({ topic: CONNECTION_HEALTH_TREND_TOPIC, fresh_only: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.target_id).toBe('hubspot');
  });

  it('preserves all rows when every key is fresh', () => {
    store.upsert({
      topic: CONNECTION_HEALTH_TREND_TOPIC,
      scope: 'connection.api',
      target_id: 'hubspot',
      value: computeHealthTrendValue([], NOW),
      authored_by: CONNECTION_HEALTH_TREND_AUTHORED_BY,
    });
    const fresh = new Set([
      composeConnectionHealthTrendFreshKey('connection.api', 'hubspot'),
    ]);
    const out = sweepStaleHealthTrendRows(buildCtx(), fresh);
    expect(out.deleted).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema round-trip
// ────────────────────────────────────────────────────────────────

describe('connection_health_trend value_schema', () => {
  const baseValue: ConnectionHealthTrendValue = {
    call_count: 10,
    error_count: 2,
    error_rate: 0.2,
    latency_p50_ms: 100,
    latency_p95_ms: 500,
    last_call_at: NOW,
    last_failure: { ts: NOW, error_code: 'TIMEOUT', error_message: 'timed out' },
    window_ms: CONNECTION_HEALTH_TREND_WINDOW_MS,
    computed_at: NOW,
  };

  it('accepts a well-formed value', () => {
    const result = ENRICHMENT_REGISTRY.connection_health_trend.value_schema(baseValue);
    expect(result.ok).toBe(true);
  });

  it('accepts null percentiles + null last_call_at + null last_failure', () => {
    const v: ConnectionHealthTrendValue = {
      ...baseValue,
      latency_p50_ms: null,
      latency_p95_ms: null,
      last_call_at: null,
      last_failure: null,
    };
    const result = ENRICHMENT_REGISTRY.connection_health_trend.value_schema(v);
    expect(result.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const result = ENRICHMENT_REGISTRY.connection_health_trend.value_schema('not an object');
    expect(result.ok).toBe(false);
  });

  it('rejects missing call_count', () => {
    const v = { ...baseValue } as Partial<ConnectionHealthTrendValue>;
    delete v.call_count;
    const result = ENRICHMENT_REGISTRY.connection_health_trend.value_schema(v);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed last_failure', () => {
    const v = {
      ...baseValue,
      last_failure: { ts: 'not a number', error_code: 'X', error_message: 'Y' },
    };
    const result = ENRICHMENT_REGISTRY.connection_health_trend.value_schema(v);
    expect(result.ok).toBe(false);
  });
});
