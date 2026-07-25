/** D-131 A.20 — `connection_optimal_batch_size` producer tests.
 *
 *  Drives the standalone `connectionOptimalBatchSizeTask` against a
 *  real in-memory `data_enrichment` table + `connections` +
 *  `audit_activities` fixtures. Verifies:
 *   - Surface contract (topic / kind / is_ai_surface=false / token=0)
 *   - Registry entry shape (excludes notification scope)
 *   - Pure helpers (computeOptimalBatchSizeValue across stat scenarios)
 *   - Cycle orchestration — happy path / api+mcp only / notification
 *     filter / sweep on un-enroll / upsert in place
 *   - Recommendation logic (filter to safe rows + p75)
 *   - Bytes coverage (mixed-emission rows)
 *   - Registry value_schema accept / reject
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ConnectionKind,
  type ConnectionOptimalBatchSizeValue,
} from '@recued/contracts';

import {
  CONNECTION_OPTIMAL_BATCH_SIZE_AUTHORED_BY,
  CONNECTION_OPTIMAL_BATCH_SIZE_DURATION_BUDGET_MULT,
  CONNECTION_OPTIMAL_BATCH_SIZE_P50_MIN_SAMPLE_COUNT,
  CONNECTION_OPTIMAL_BATCH_SIZE_P95_MIN_SAMPLE_COUNT,
  CONNECTION_OPTIMAL_BATCH_SIZE_RECOMMENDATION_MIN_SAMPLE,
  CONNECTION_OPTIMAL_BATCH_SIZE_SUPPORTED_KINDS,
  CONNECTION_OPTIMAL_BATCH_SIZE_TOKEN_ESTIMATE,
  CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
  CONNECTION_OPTIMAL_BATCH_SIZE_WINDOW_MS,
  composeConnectionFreshKey,
  computeOptimalBatchSizeValue,
  connectionOptimalBatchSizeScopeReadDeclaration,
  connectionOptimalBatchSizeTask,
  connectionOptimalBatchSizeTokenEstimate,
  runConnectionOptimalBatchSizeCycle,
  sweepStaleOptimalBatchSizeRows,
  type ParsedConnectionAuditRow,
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
  dir = mkdtempSync(join(tmpdir(), 'd-131-conn-batch-'));
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
  bytes_out?: number | null;
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
  if (a.bytes_out !== undefined && a.bytes_out !== null) {
    detail.bytes_out = a.bytes_out;
  }
  if (a.status === 'error') {
    detail.error = { code: 'TEST_ERROR', message: 'fail' };
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

const buildRow = (
  ts: number,
  status: 'ok' | 'error' = 'ok',
  duration_ms: number = 100,
  bytes_out: number | null = null,
): ParsedConnectionAuditRow => ({
  ts,
  status,
  duration_ms,
  error_code: status === 'error' ? 'TEST_ERROR' : null,
  error_message: status === 'error' ? 'fail' : null,
  recipe_id: null,
  step_id: null,
  bytes_in: null,
  bytes_out,
});

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('connectionOptimalBatchSizeTask surface contract', () => {
  it('targets the connection_optimal_batch_size registry topic', () => {
    expect(connectionOptimalBatchSizeTask.topic).toBe('connection_optimal_batch_size');
  });

  it('declares is_ai_surface=false (deterministic)', () => {
    expect(connectionOptimalBatchSizeTask.is_ai_surface).toBe(false);
  });

  it('declares meta.kind=enrichment', () => {
    expect(connectionOptimalBatchSizeTask.meta.kind).toBe('enrichment');
  });

  it('declares meta.id=enrichment.connection_optimal_batch_size', () => {
    expect(connectionOptimalBatchSizeTask.meta.id).toBe(
      'enrichment.connection_optimal_batch_size',
    );
  });

  it('declares meta.interruptible=true', () => {
    expect(connectionOptimalBatchSizeTask.meta.interruptible).toBe(true);
  });

  it('does NOT stamp idle_eligible (D-132 trust gate resolves at runtime)', () => {
    expect(connectionOptimalBatchSizeTask.meta.idle_eligible).toBeUndefined();
  });

  it('exposes a zero-token cycle estimate (deterministic)', () => {
    expect(connectionOptimalBatchSizeTokenEstimate()).toBe(0);
    expect(connectionOptimalBatchSizeTokenEstimate()).toBe(
      CONNECTION_OPTIMAL_BATCH_SIZE_TOKEN_ESTIMATE,
    );
  });

  it('exposes scope_read_declaration over connections + memory with bytes_out path', () => {
    const memory = connectionOptimalBatchSizeScopeReadDeclaration.find(
      (e) => e.collection === 'data.memory',
    );
    expect(memory).toBeDefined();
    expect((memory!.sample_field_paths as ReadonlyArray<string>)).toContain(
      'detail.bytes_out',
    );
  });

  it('SUPPORTED_KINDS includes api + mcp but NOT notification', () => {
    const set = new Set(CONNECTION_OPTIMAL_BATCH_SIZE_SUPPORTED_KINDS);
    expect(set.has('api')).toBe(true);
    expect(set.has('mcp')).toBe(true);
    expect(set.has('notification')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry entry
// ────────────────────────────────────────────────────────────────

describe('connection_optimal_batch_size registry entry', () => {
  it('is shape: per_record', () => {
    expect(ENRICHMENT_REGISTRY.connection_optimal_batch_size.shape).toBe('per_record');
  });

  it('uses policy: aggregate', () => {
    expect(ENRICHMENT_REGISTRY.connection_optimal_batch_size.policy).toBe(
      'aggregate',
    );
  });

  it('valid_scopes covers api + mcp but NOT notification', () => {
    const def = ENRICHMENT_REGISTRY.connection_optimal_batch_size;
    const scopes = new Set(def.valid_scopes as ReadonlyArray<string>);
    expect(scopes.has('connection.api')).toBe(true);
    expect(scopes.has('connection.mcp')).toBe(true);
    expect(scopes.has('connection.notification')).toBe(false);
  });

  it('uses producer_kind=housekeeping', () => {
    expect(ENRICHMENT_REGISTRY.connection_optimal_batch_size.producer_kind).toBe(
      'housekeeping',
    );
  });

  it('declares aggregates_from: ["memory"]', () => {
    expect(
      ENRICHMENT_REGISTRY.connection_optimal_batch_size.aggregates_from,
    ).toEqual(['memory']);
  });

  it('declares recompute_cadence: 7d (matches WINDOW_MS)', () => {
    expect(ENRICHMENT_REGISTRY.connection_optimal_batch_size.recompute_cadence).toBe(
      '7d',
    );
  });

  it('does NOT declare emits_confidence (deterministic)', () => {
    const def = ENRICHMENT_REGISTRY.connection_optimal_batch_size as {
      emits_confidence?: boolean;
    };
    expect(def.emits_confidence).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — computeOptimalBatchSizeValue
// ────────────────────────────────────────────────────────────────

describe('computeOptimalBatchSizeValue', () => {
  it('returns the zero shape for empty input', () => {
    const v = computeOptimalBatchSizeValue([], NOW);
    expect(v.sample_count).toBe(0);
    expect(v.median_duration_ms).toBe(null);
    expect(v.p95_duration_ms).toBe(null);
    expect(v.median_payload_bytes).toBe(null);
    expect(v.p95_payload_bytes).toBe(null);
    expect(v.recommended_max_payload_bytes).toBe(null);
    expect(v.bytes_coverage).toBe(0);
    expect(v.window_ms).toBe(CONNECTION_OPTIMAL_BATCH_SIZE_WINDOW_MS);
    expect(v.computed_at).toBe(NOW);
  });

  it('counts samples and tracks bytes_coverage as a fraction', () => {
    const rows = [
      buildRow(NOW, 'ok', 100, 1000),
      buildRow(NOW, 'ok', 110, 1100),
      buildRow(NOW, 'ok', 120, null),  // no bytes_out
      buildRow(NOW, 'ok', 130, null),
    ];
    const v = computeOptimalBatchSizeValue(rows, NOW);
    expect(v.sample_count).toBe(4);
    expect(v.bytes_coverage).toBe(0.5); // 2 of 4 rows emitted bytes_out
  });

  it('returns null percentiles below the p50 sample-count floor', () => {
    const rows = Array.from(
      { length: CONNECTION_OPTIMAL_BATCH_SIZE_P50_MIN_SAMPLE_COUNT - 1 },
      (_, i) => buildRow(NOW - i * ONE_HOUR, 'ok', 100 + i, 500 + i * 10),
    );
    const v = computeOptimalBatchSizeValue(rows, NOW);
    expect(v.median_duration_ms).toBe(null);
    expect(v.p95_duration_ms).toBe(null);
    expect(v.median_payload_bytes).toBe(null);
    expect(v.recommended_max_payload_bytes).toBe(null);
  });

  it('returns numeric median_duration at the p50 floor', () => {
    const rows = Array.from(
      { length: CONNECTION_OPTIMAL_BATCH_SIZE_P50_MIN_SAMPLE_COUNT },
      (_, i) => buildRow(NOW - i * ONE_HOUR, 'ok', 100 + i, 500 + i * 10),
    );
    const v = computeOptimalBatchSizeValue(rows, NOW);
    expect(v.median_duration_ms).not.toBe(null);
    expect(v.p95_duration_ms).toBe(null); // still below p95 floor
    expect(v.median_payload_bytes).not.toBe(null);
  });

  it('returns numeric p95 at the p95 floor', () => {
    const rows = Array.from(
      { length: CONNECTION_OPTIMAL_BATCH_SIZE_P95_MIN_SAMPLE_COUNT },
      (_, i) => buildRow(NOW - i * ONE_HOUR, 'ok', 100 + i, 500 + i * 10),
    );
    const v = computeOptimalBatchSizeValue(rows, NOW);
    expect(v.median_duration_ms).not.toBe(null);
    expect(v.p95_duration_ms).not.toBe(null);
    expect(v.p95_payload_bytes).not.toBe(null);
  });

  it('p95_duration reflects the actual p95 on a uniform distribution', () => {
    // 20 samples of duration 100, 200, ..., 2000 → p95 (rank 19) = 1900
    const rows = Array.from({ length: 20 }, (_, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', (i + 1) * 100, 1000),
    );
    const v = computeOptimalBatchSizeValue(rows, NOW);
    expect(v.p95_duration_ms).toBe(1900);
    expect(v.median_duration_ms).toBe(1000);
  });

  it('recommendation is null when median_duration_ms is null', () => {
    // sample_count below p50 floor → median_duration null → no budget
    const rows = Array.from({ length: 3 }, (_, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', 100, 1000),
    );
    const v = computeOptimalBatchSizeValue(rows, NOW);
    expect(v.recommended_max_payload_bytes).toBe(null);
  });

  it('recommendation is null when no rows emitted bytes_out', () => {
    const rows = Array.from(
      { length: CONNECTION_OPTIMAL_BATCH_SIZE_P95_MIN_SAMPLE_COUNT },
      (_, i) => buildRow(NOW - i * ONE_HOUR, 'ok', 100, null),
    );
    const v = computeOptimalBatchSizeValue(rows, NOW);
    expect(v.median_duration_ms).not.toBe(null); // duration percentiles work
    expect(v.median_payload_bytes).toBe(null);   // bytes percentiles do not
    expect(v.recommended_max_payload_bytes).toBe(null);
  });

  it('recommendation reflects p75 of safe-and-sized rows', () => {
    // 20 successful rows with bytes_out 100..2000, durations 100ms (well under any 2× median budget)
    const rows = Array.from({ length: 20 }, (_, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', 100, (i + 1) * 100),
    );
    const v = computeOptimalBatchSizeValue(rows, NOW);
    // All 20 rows are safe + sized (status=ok, duration <= 2 * 100). p75 = rank 15 = 1500.
    expect(v.recommended_max_payload_bytes).toBe(1500);
  });

  it('recommendation excludes error-status rows', () => {
    // 20 ok rows with bytes 100..2000; plus 5 large error rows that would skew the p75 if included
    const okRows = Array.from({ length: 20 }, (_, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', 100, (i + 1) * 100),
    );
    const errRows = Array.from({ length: 5 }, (_, i) =>
      buildRow(NOW - (i + 100) * ONE_HOUR, 'error', 100, 50_000),
    );
    const v = computeOptimalBatchSizeValue([...okRows, ...errRows], NOW);
    // Recommendation should ignore the error rows and stay at 1500.
    expect(v.recommended_max_payload_bytes).toBe(1500);
  });

  it('recommendation excludes rows above the duration budget (2× median)', () => {
    // 20 ok rows at 100ms duration with bytes 100..2000 → median = 100, budget = 200.
    // Plus 5 ok rows at 1000ms (above budget) with large bytes 50_000 — must be excluded.
    const safeRows = Array.from({ length: 20 }, (_, i) =>
      buildRow(NOW - i * ONE_HOUR, 'ok', 100, (i + 1) * 100),
    );
    const slowRows = Array.from({ length: 5 }, (_, i) =>
      buildRow(NOW - (i + 100) * ONE_HOUR, 'ok', 1000, 50_000),
    );
    const v = computeOptimalBatchSizeValue([...safeRows, ...slowRows], NOW);
    // Median duration shifts slightly with the slow rows folded in; budget is 2× new median.
    // 25 samples sorted: [100×20, 1000×5] → p50 = sample[ceil(0.5*25) - 1] = sample[12] = 100.
    // Budget = 200. Slow rows excluded. p75 of safe-rows-only is still 1500.
    expect(v.recommended_max_payload_bytes).toBe(1500);
  });

  it('recommendation is null below the recommendation sample floor', () => {
    // Need >= P50 floor for median_duration but < recommendation floor for safe rows.
    // Use sample_count = P50 floor, but only mark a few as bytes-emitting.
    const rows: ParsedConnectionAuditRow[] = [];
    for (let i = 0; i < CONNECTION_OPTIMAL_BATCH_SIZE_P50_MIN_SAMPLE_COUNT; i += 1) {
      rows.push(
        buildRow(
          NOW - i * ONE_HOUR,
          'ok',
          100,
          // Only first (recommendation_min - 1) rows emit bytes_out
          i < CONNECTION_OPTIMAL_BATCH_SIZE_RECOMMENDATION_MIN_SAMPLE - 1
            ? 1000
            : null,
        ),
      );
    }
    const v = computeOptimalBatchSizeValue(rows, NOW);
    expect(v.recommended_max_payload_bytes).toBe(null);
  });

  it('echoes the supplied window_ms into the value', () => {
    const v = computeOptimalBatchSizeValue([], NOW, 99 * ONE_HOUR);
    expect(v.window_ms).toBe(99 * ONE_HOUR);
  });

  it('uses CONNECTION_OPTIMAL_BATCH_SIZE_DURATION_BUDGET_MULT for the budget', () => {
    expect(CONNECTION_OPTIMAL_BATCH_SIZE_DURATION_BUDGET_MULT).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// runConnectionOptimalBatchSizeCycle — end-to-end
// ────────────────────────────────────────────────────────────────

describe('runConnectionOptimalBatchSizeCycle', () => {
  it('produces zero rows when no connections enrolled', () => {
    const out = runConnectionOptimalBatchSizeCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('emits one row per enrolled api + mcp connection (zero shape allowed)', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'github-mcp' });
    const out = runConnectionOptimalBatchSizeCycle(buildCtx());
    expect(out.produced).toBe(2);

    const rows = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.authored_by).toBe(CONNECTION_OPTIMAL_BATCH_SIZE_AUTHORED_BY);
      const v = row.value as ConnectionOptimalBatchSizeValue;
      expect(v.sample_count).toBe(0);
      expect(v.bytes_coverage).toBe(0);
      expect(v.recommended_max_payload_bytes).toBe(null);
    }
  });

  it('SKIPS notification connections (registry valid_scopes excludes them)', () => {
    insertConnection({ kind: 'notification', name: 'slack-personal' });
    const out = runConnectionOptimalBatchSizeCycle(buildCtx());
    expect(out.produced).toBe(0);

    const rows = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(0);
  });

  it('emits api + mcp but skips notification when all three present', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'github-mcp' });
    insertConnection({ kind: 'notification', name: 'slack-personal' });

    runConnectionOptimalBatchSizeCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(2);
    const scopes = rows.map((r) => r.scope).sort();
    expect(scopes).toEqual(['connection.api', 'connection.mcp']);
  });

  it('aggregates stats from matching audit activities', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    for (let i = 0; i < 20; i += 1) {
      insertActivity({
        kind: 'api',
        name: 'hubspot',
        ts: NOW - i * ONE_HOUR,
        status: 'ok',
        duration_ms: 100,
        bytes_out: (i + 1) * 100,
      });
    }
    runConnectionOptimalBatchSizeCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(1);
    const v = rows[0]!.value as ConnectionOptimalBatchSizeValue;
    expect(v.sample_count).toBe(20);
    expect(v.bytes_coverage).toBe(1);
    expect(v.recommended_max_payload_bytes).toBe(1500); // p75 of 100..2000
  });

  it('isolates aggregates per (kind, name) — no cross-pollination', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'api', name: 'salesforce' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok', bytes_out: 1000 });
    insertActivity({ kind: 'api', name: 'salesforce', ts: NOW - ONE_HOUR, status: 'ok', bytes_out: 2000 });

    runConnectionOptimalBatchSizeCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(2);
    const byTarget = new Map(
      rows.map((r) => [r.target_id, r.value as ConnectionOptimalBatchSizeValue] as const),
    );
    expect(byTarget.get('hubspot')!.sample_count).toBe(1);
    expect(byTarget.get('salesforce')!.sample_count).toBe(1);
  });

  it('isolates aggregates per kind — same name across kinds', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok' });
    insertActivity({ kind: 'mcp', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'error' });

    runConnectionOptimalBatchSizeCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(2);
  });

  it('excludes audit rows older than the rolling window', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 100 * ONE_DAY, status: 'ok', bytes_out: 1000 });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok', bytes_out: 500 });

    runConnectionOptimalBatchSizeCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    const v = rows[0]!.value as ConnectionOptimalBatchSizeValue;
    expect(v.sample_count).toBe(1);
  });

  it('upserts in place across runs (stable scope+target_id key)', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok' });
    runConnectionOptimalBatchSizeCycle(buildCtx());
    const firstIds = store
      .list({ topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC, fresh_only: false })
      .map((r) => r._id);

    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 30 * 60 * 1000, status: 'ok' });
    runConnectionOptimalBatchSizeCycle(buildCtx());
    const secondRows = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0]!._id).toBe(firstIds[0]!);
    const v = secondRows[0]!.value as ConnectionOptimalBatchSizeValue;
    expect(v.sample_count).toBe(2);
  });

  it('sweeps rows for un-enrolled connections', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'api', name: 'salesforce' });
    runConnectionOptimalBatchSizeCycle(buildCtx());
    expect(store.countForTopic(CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC)).toBe(2);

    db.prepare(`DELETE FROM connections WHERE kind = ? AND name = ?`).run(
      'api',
      'salesforce',
    );
    const out = runConnectionOptimalBatchSizeCycle(buildCtx());
    expect(out.swept).toBe(1);

    const remaining = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.target_id).toBe('hubspot');
  });

  it('connectionOptimalBatchSizeTask.step returns complete', async () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    const result = await connectionOptimalBatchSizeTask.step(
      buildCtx(),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('round-trips through the registry value_schema (no schema rejection)', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, status: 'ok', bytes_out: 1000 });
    expect(() => runConnectionOptimalBatchSizeCycle(buildCtx())).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep helper — direct
// ────────────────────────────────────────────────────────────────

describe('sweepStaleOptimalBatchSizeRows', () => {
  it('deletes rows whose key is not in the fresh set', () => {
    store.upsert({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      scope: 'connection.api',
      target_id: 'hubspot',
      value: computeOptimalBatchSizeValue([], NOW),
      authored_by: CONNECTION_OPTIMAL_BATCH_SIZE_AUTHORED_BY,
    });
    store.upsert({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      scope: 'connection.api',
      target_id: 'salesforce',
      value: computeOptimalBatchSizeValue([], NOW),
      authored_by: CONNECTION_OPTIMAL_BATCH_SIZE_AUTHORED_BY,
    });

    const fresh = new Set([composeConnectionFreshKey('connection.api', 'hubspot')]);
    const out = sweepStaleOptimalBatchSizeRows(buildCtx(), fresh);
    expect(out.deleted).toBe(1);

    const remaining = store.list({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      fresh_only: false,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.target_id).toBe('hubspot');
  });

  it('preserves all rows when every key is fresh', () => {
    store.upsert({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      scope: 'connection.api',
      target_id: 'hubspot',
      value: computeOptimalBatchSizeValue([], NOW),
      authored_by: CONNECTION_OPTIMAL_BATCH_SIZE_AUTHORED_BY,
    });
    const fresh = new Set([composeConnectionFreshKey('connection.api', 'hubspot')]);
    const out = sweepStaleOptimalBatchSizeRows(buildCtx(), fresh);
    expect(out.deleted).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema round-trip
// ────────────────────────────────────────────────────────────────

describe('connection_optimal_batch_size value_schema', () => {
  const baseValue: ConnectionOptimalBatchSizeValue = {
    sample_count: 20,
    median_duration_ms: 150,
    p95_duration_ms: 500,
    median_payload_bytes: 1000,
    p95_payload_bytes: 2000,
    recommended_max_payload_bytes: 1500,
    bytes_coverage: 0.9,
    window_ms: CONNECTION_OPTIMAL_BATCH_SIZE_WINDOW_MS,
    computed_at: NOW,
  };

  it('accepts a well-formed value', () => {
    const result =
      ENRICHMENT_REGISTRY.connection_optimal_batch_size.value_schema(baseValue);
    expect(result.ok).toBe(true);
  });

  it('accepts the zero shape (all percentiles null, coverage 0)', () => {
    const v: ConnectionOptimalBatchSizeValue = {
      ...baseValue,
      sample_count: 0,
      median_duration_ms: null,
      p95_duration_ms: null,
      median_payload_bytes: null,
      p95_payload_bytes: null,
      recommended_max_payload_bytes: null,
      bytes_coverage: 0,
    };
    const result =
      ENRICHMENT_REGISTRY.connection_optimal_batch_size.value_schema(v);
    expect(result.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const result =
      ENRICHMENT_REGISTRY.connection_optimal_batch_size.value_schema('nope');
    expect(result.ok).toBe(false);
  });

  it('rejects missing sample_count', () => {
    const v = { ...baseValue } as Partial<ConnectionOptimalBatchSizeValue>;
    delete v.sample_count;
    const result =
      ENRICHMENT_REGISTRY.connection_optimal_batch_size.value_schema(v);
    expect(result.ok).toBe(false);
  });

  it('rejects bytes_coverage as null (always-defined contract)', () => {
    const v = { ...baseValue, bytes_coverage: null as unknown as number };
    const result =
      ENRICHMENT_REGISTRY.connection_optimal_batch_size.value_schema(v);
    expect(result.ok).toBe(false);
  });

  it('rejects string median_duration_ms', () => {
    const v = {
      ...baseValue,
      median_duration_ms: '150' as unknown as number,
    };
    const result =
      ENRICHMENT_REGISTRY.connection_optimal_batch_size.value_schema(v);
    expect(result.ok).toBe(false);
  });

  it('rejects NaN computed_at', () => {
    const v = { ...baseValue, computed_at: Number.NaN };
    const result =
      ENRICHMENT_REGISTRY.connection_optimal_batch_size.value_schema(v);
    expect(result.ok).toBe(false);
  });
});
