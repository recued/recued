/** D-131 A.19 — `connection_last_used_pattern` producer tests.
 *
 *  Drives the standalone `connectionLastUsedPatternTask` against a real
 *  in-memory `data_enrichment` table + `connections` + `audit_activities`
 *  fixtures. Verifies:
 *   - Surface contract (topic / kind / is_ai_surface=false / token=0)
 *   - Pure helpers (emptyHourHistogram / computeLastUsedPatternValue
 *     stats / sweep)
 *   - Cycle orchestration — happy path / multi-kind isolation /
 *     zero-call shape / sweep on un-enroll / upsert-in-place
 *   - Recipe-attribution semantics (recipe_id null → unattributed)
 *   - Hour histogram (UTC bucketing)
 *   - Recipes array truncation with `distinct_recipes` echo
 *   - Registry value_schema accept / reject
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ConnectionLastUsedPatternValue,
  type ConnectionKind,
} from '@recued/contracts';

import {
  CONNECTION_LAST_USED_PATTERN_AUTHORED_BY,
  CONNECTION_LAST_USED_PATTERN_TOPIC,
  CONNECTION_LAST_USED_PATTERN_TOKEN_ESTIMATE,
  CONNECTION_LAST_USED_PATTERN_WINDOW_MS,
  MAX_RECIPES_IN_BREAKOUT,
  computeLastUsedPatternValue,
  composeConnectionFreshKey,
  connectionLastUsedPatternScopeReadDeclaration,
  connectionLastUsedPatternTask,
  connectionLastUsedPatternTokenEstimate,
  emptyHourHistogram,
  runConnectionLastUsedPatternCycle,
  sweepStaleLastUsedPatternRows,
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

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z (UTC hour 22)
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
  dir = mkdtempSync(join(tmpdir(), 'd-131-conn-last-used-'));
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
  recipe_id?: string | null;
  step_id?: string | null;
  status?: 'ok' | 'error';
  duration_ms?: number;
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
  if (a.recipe_id !== undefined && a.recipe_id !== null) {
    detail.recipe_id = a.recipe_id;
  }
  if (a.step_id !== undefined && a.step_id !== null) {
    detail.step_id = a.step_id;
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
  recipe_id: string | null,
): ParsedConnectionAuditRow => ({
  ts,
  status: 'ok',
  duration_ms: 100,
  error_code: null,
  error_message: null,
  recipe_id,
  step_id: null,
  bytes_in: null,
  bytes_out: null,
});

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('connectionLastUsedPatternTask surface contract', () => {
  it('targets the connection_last_used_pattern registry topic', () => {
    expect(connectionLastUsedPatternTask.topic).toBe('connection_last_used_pattern');
  });

  it('declares is_ai_surface=false (deterministic)', () => {
    expect(connectionLastUsedPatternTask.is_ai_surface).toBe(false);
  });

  it('declares meta.kind=enrichment', () => {
    expect(connectionLastUsedPatternTask.meta.kind).toBe('enrichment');
  });

  it('declares meta.id=enrichment.connection_last_used_pattern', () => {
    expect(connectionLastUsedPatternTask.meta.id).toBe(
      'enrichment.connection_last_used_pattern',
    );
  });

  it('declares meta.interruptible=true', () => {
    expect(connectionLastUsedPatternTask.meta.interruptible).toBe(true);
  });

  it('does NOT stamp idle_eligible (D-132 trust gate resolves at runtime)', () => {
    expect(connectionLastUsedPatternTask.meta.idle_eligible).toBeUndefined();
  });

  it('exposes a zero-token cycle estimate (deterministic)', () => {
    expect(connectionLastUsedPatternTokenEstimate()).toBe(0);
    expect(connectionLastUsedPatternTokenEstimate()).toBe(
      CONNECTION_LAST_USED_PATTERN_TOKEN_ESTIMATE,
    );
  });

  it('declares non-empty scope_read_declaration over connections + audit', () => {
    expect(connectionLastUsedPatternScopeReadDeclaration.length).toBeGreaterThan(0);
    const conn = connectionLastUsedPatternScopeReadDeclaration.find(
      (e) => e.collection === 'connection',
    );
    const audit = connectionLastUsedPatternScopeReadDeclaration.find(
      (e) => e.collection === 'data.audit',
    );
    expect(conn).toBeDefined();
    expect(audit).toBeDefined();
    expect((conn!.sample_field_paths as ReadonlyArray<string>).length).toBeGreaterThan(0);
    expect(
      (audit!.sample_field_paths as ReadonlyArray<string>).length,
    ).toBeGreaterThan(0);
  });

  it('audit scope_read_declaration includes detail.recipe_id (per-recipe breakout signal)', () => {
    const audit = connectionLastUsedPatternScopeReadDeclaration.find(
      (e) => e.collection === 'data.audit',
    );
    expect((audit!.sample_field_paths as ReadonlyArray<string>)).toContain(
      'detail.recipe_id',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Registry entry
// ────────────────────────────────────────────────────────────────

describe('connection_last_used_pattern registry entry', () => {
  it('is shape: per_record', () => {
    expect(ENRICHMENT_REGISTRY.connection_last_used_pattern.shape).toBe('per_record');
  });

  it('uses policy: aggregate', () => {
    expect(ENRICHMENT_REGISTRY.connection_last_used_pattern.policy).toBe('aggregate');
  });

  it('valid_scopes covers all three connection kinds', () => {
    const def = ENRICHMENT_REGISTRY.connection_last_used_pattern;
    expect(def.valid_scopes).toEqual(
      expect.arrayContaining([
        'connection.api',
        'connection.mcp',
        'connection.notification',
      ]),
    );
  });

  it('uses producer_kind=housekeeping', () => {
    expect(ENRICHMENT_REGISTRY.connection_last_used_pattern.producer_kind).toBe(
      'housekeeping',
    );
  });

  it('declares aggregates_from: ["audit"] - the run-provenance trail, never user_memory', () => {
    expect(ENRICHMENT_REGISTRY.connection_last_used_pattern.aggregates_from).toEqual([
      'audit',
    ]);
  });

  it('declares recompute_cadence: 24h', () => {
    expect(ENRICHMENT_REGISTRY.connection_last_used_pattern.recompute_cadence).toBe(
      '24h',
    );
  });

  it('does NOT declare emits_confidence (deterministic, no LLM)', () => {
    const def = ENRICHMENT_REGISTRY.connection_last_used_pattern as {
      emits_confidence?: boolean;
    };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('does NOT declare default_trust_state (resolver returns "auto" for non-AI)', () => {
    const def = ENRICHMENT_REGISTRY.connection_last_used_pattern as {
      default_trust_state?: string;
    };
    expect(def.default_trust_state).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — emptyHourHistogram
// ────────────────────────────────────────────────────────────────

describe('emptyHourHistogram', () => {
  it('returns a 24-element array of zeroes', () => {
    const h = emptyHourHistogram();
    expect(h).toHaveLength(24);
    expect(h.every((v) => v === 0)).toBe(true);
  });

  it('returns a fresh array each call (callers can mutate)', () => {
    const a = emptyHourHistogram();
    const b = emptyHourHistogram();
    a[0] = 5;
    expect(b[0]).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — computeLastUsedPatternValue
// ────────────────────────────────────────────────────────────────

describe('computeLastUsedPatternValue', () => {
  it('returns the zero-call shape for empty input', () => {
    const v = computeLastUsedPatternValue([], NOW);
    expect(v.call_count).toBe(0);
    expect(v.last_used_at).toBe(null);
    expect(v.recipes).toEqual([]);
    expect(v.distinct_recipes).toBe(0);
    expect(v.unattributed_call_count).toBe(0);
    expect(v.hour_histogram).toEqual(emptyHourHistogram());
    expect(v.window_ms).toBe(CONNECTION_LAST_USED_PATTERN_WINDOW_MS);
    expect(v.computed_at).toBe(NOW);
  });

  it('counts total calls and tracks last_used_at as the most recent ts', () => {
    const rows = [
      buildRow(NOW - ONE_HOUR, 'recipe-a'),
      buildRow(NOW - 2 * ONE_HOUR, 'recipe-a'),
      buildRow(NOW - 6 * ONE_HOUR, 'recipe-b'),
    ];
    const v = computeLastUsedPatternValue(rows, NOW);
    expect(v.call_count).toBe(3);
    expect(v.last_used_at).toBe(NOW - ONE_HOUR);
  });

  it('aggregates per-recipe call_count + per-recipe last_used_at', () => {
    const rows = [
      buildRow(NOW - ONE_HOUR, 'recipe-a'),
      buildRow(NOW - 5 * ONE_HOUR, 'recipe-a'),
      buildRow(NOW - 6 * ONE_HOUR, 'recipe-b'),
    ];
    const v = computeLastUsedPatternValue(rows, NOW);
    const a = v.recipes.find((r) => r.recipe_id === 'recipe-a');
    const b = v.recipes.find((r) => r.recipe_id === 'recipe-b');
    expect(a).toBeDefined();
    expect(a!.call_count).toBe(2);
    expect(a!.last_used_at).toBe(NOW - ONE_HOUR);
    expect(b).toBeDefined();
    expect(b!.call_count).toBe(1);
    expect(b!.last_used_at).toBe(NOW - 6 * ONE_HOUR);
  });

  it('sorts recipes by call_count desc', () => {
    const rows = [
      buildRow(NOW - ONE_HOUR, 'recipe-quiet'),
      buildRow(NOW - 2 * ONE_HOUR, 'recipe-loud'),
      buildRow(NOW - 3 * ONE_HOUR, 'recipe-loud'),
      buildRow(NOW - 4 * ONE_HOUR, 'recipe-loud'),
    ];
    const v = computeLastUsedPatternValue(rows, NOW);
    expect(v.recipes[0]!.recipe_id).toBe('recipe-loud');
    expect(v.recipes[0]!.call_count).toBe(3);
    expect(v.recipes[1]!.recipe_id).toBe('recipe-quiet');
    expect(v.recipes[1]!.call_count).toBe(1);
  });

  it('breaks call_count ties via recipe_id asc', () => {
    const rows = [
      buildRow(NOW - ONE_HOUR, 'recipe-zebra'),
      buildRow(NOW - 2 * ONE_HOUR, 'recipe-alpha'),
      buildRow(NOW - 3 * ONE_HOUR, 'recipe-marlin'),
    ];
    const v = computeLastUsedPatternValue(rows, NOW);
    // All three have call_count=1; tie-break alphabetically.
    expect(v.recipes.map((r) => r.recipe_id)).toEqual([
      'recipe-alpha',
      'recipe-marlin',
      'recipe-zebra',
    ]);
  });

  it('counts null-recipe_id rows into unattributed_call_count', () => {
    const rows = [
      buildRow(NOW - ONE_HOUR, null), // direct rpc / probe / agent
      buildRow(NOW - 2 * ONE_HOUR, null),
      buildRow(NOW - 3 * ONE_HOUR, 'recipe-a'),
    ];
    const v = computeLastUsedPatternValue(rows, NOW);
    expect(v.call_count).toBe(3);
    expect(v.unattributed_call_count).toBe(2);
    expect(v.recipes).toHaveLength(1);
    expect(v.recipes[0]!.recipe_id).toBe('recipe-a');
  });

  it('preserves the sum invariant: recipes total + unattributed = call_count', () => {
    const rows = [
      buildRow(NOW - ONE_HOUR, 'a'),
      buildRow(NOW - 2 * ONE_HOUR, 'a'),
      buildRow(NOW - 3 * ONE_HOUR, 'b'),
      buildRow(NOW - 4 * ONE_HOUR, null),
    ];
    const v = computeLastUsedPatternValue(rows, NOW);
    const sum = v.recipes.reduce((acc, r) => acc + r.call_count, 0);
    expect(sum + v.unattributed_call_count).toBe(v.call_count);
  });

  it('truncates recipes to MAX_RECIPES_IN_BREAKOUT but reports true distinct_recipes', () => {
    const rows: ParsedConnectionAuditRow[] = [];
    for (let i = 0; i < MAX_RECIPES_IN_BREAKOUT + 5; i += 1) {
      rows.push(buildRow(NOW - i * ONE_HOUR, `recipe-${i}`));
    }
    const v = computeLastUsedPatternValue(rows, NOW);
    expect(v.recipes).toHaveLength(MAX_RECIPES_IN_BREAKOUT);
    expect(v.distinct_recipes).toBe(MAX_RECIPES_IN_BREAKOUT + 5);
  });

  it('honours an explicit max_recipes argument', () => {
    const rows: ParsedConnectionAuditRow[] = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(buildRow(NOW - i * ONE_HOUR, `recipe-${i}`));
    }
    const v = computeLastUsedPatternValue(rows, NOW, undefined, 2);
    expect(v.recipes).toHaveLength(2);
    expect(v.distinct_recipes).toBe(5);
  });

  it('buckets calls into the correct UTC hour', () => {
    // NOW = 1_700_000_000_000 = 2023-11-14T22:13:20.000Z (UTC hour 22)
    // NOW - ONE_HOUR = 21
    // NOW - 2*ONE_HOUR = 20
    const rows = [
      buildRow(NOW, 'recipe-a'),                  // hour 22
      buildRow(NOW - ONE_HOUR, 'recipe-a'),       // hour 21
      buildRow(NOW - 2 * ONE_HOUR, 'recipe-a'),   // hour 20
      buildRow(NOW - 2 * ONE_HOUR, 'recipe-b'),   // hour 20 again
    ];
    const v = computeLastUsedPatternValue(rows, NOW);
    expect(v.hour_histogram[22]).toBe(1);
    expect(v.hour_histogram[21]).toBe(1);
    expect(v.hour_histogram[20]).toBe(2);
    // Sum of the histogram equals the call_count.
    expect(v.hour_histogram.reduce((a, b) => a + b, 0)).toBe(v.call_count);
  });

  it('returns a 24-element histogram even on empty input', () => {
    const v = computeLastUsedPatternValue([], NOW);
    expect(v.hour_histogram).toHaveLength(24);
  });

  it('echoes the supplied window_ms into the value', () => {
    const v = computeLastUsedPatternValue([], NOW, 99 * ONE_HOUR);
    expect(v.window_ms).toBe(99 * ONE_HOUR);
  });
});

// ────────────────────────────────────────────────────────────────
// runConnectionLastUsedPatternCycle — end-to-end
// ────────────────────────────────────────────────────────────────

describe('runConnectionLastUsedPatternCycle', () => {
  it('produces zero rows when no connections enrolled', () => {
    const out = runConnectionLastUsedPatternCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('emits one row per enrolled connection (zero-call shape allowed)', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'github-mcp' });
    const out = runConnectionLastUsedPatternCycle(buildCtx());
    expect(out.produced).toBe(2);

    const rows = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.authored_by).toBe(CONNECTION_LAST_USED_PATTERN_AUTHORED_BY);
      const v = row.value as ConnectionLastUsedPatternValue;
      expect(v.call_count).toBe(0);
      expect(v.last_used_at).toBe(null);
      expect(v.recipes).toEqual([]);
      expect(v.distinct_recipes).toBe(0);
      expect(v.unattributed_call_count).toBe(0);
    }
  });

  it('emits scope=connection.<kind> + target_id=name', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'github-mcp' });
    insertConnection({ kind: 'notification', name: 'slack-personal' });
    runConnectionLastUsedPatternCycle(buildCtx());

    const rows = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    const byScope = new Map(rows.map((r) => [r.scope, r.target_id] as const));
    expect(byScope.get('connection.api')).toBe('hubspot');
    expect(byScope.get('connection.mcp')).toBe('github-mcp');
    expect(byScope.get('connection.notification')).toBe('slack-personal');
  });

  it('aggregates recipe attribution from matching audit activities', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, recipe_id: 'detect-deal-risk-hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 2 * ONE_HOUR, recipe_id: 'detect-deal-risk-hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 3 * ONE_HOUR, recipe_id: 'sync-pipeline-hubspot' });

    runConnectionLastUsedPatternCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(1);
    const v = rows[0]!.value as ConnectionLastUsedPatternValue;
    expect(v.call_count).toBe(3);
    expect(v.distinct_recipes).toBe(2);
    expect(v.last_used_at).toBe(NOW - ONE_HOUR);
    const detect = v.recipes.find((r) => r.recipe_id === 'detect-deal-risk-hubspot');
    expect(detect).toBeDefined();
    expect(detect!.call_count).toBe(2);
  });

  it('counts un-attributed (no recipe_id) audit rows into unattributed_call_count', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, recipe_id: 'detect-deal-risk-hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 2 * ONE_HOUR }); // direct probe
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 3 * ONE_HOUR }); // mcp agent

    runConnectionLastUsedPatternCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    const v = rows[0]!.value as ConnectionLastUsedPatternValue;
    expect(v.call_count).toBe(3);
    expect(v.recipes).toHaveLength(1);
    expect(v.unattributed_call_count).toBe(2);
  });

  it('isolates aggregates per (kind, name) — no cross-pollination', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'api', name: 'salesforce' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, recipe_id: 'r1' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 2 * ONE_HOUR, recipe_id: 'r1' });
    insertActivity({ kind: 'api', name: 'salesforce', ts: NOW - ONE_HOUR, recipe_id: 'r2' });

    runConnectionLastUsedPatternCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    const byTarget = new Map(
      rows.map((r) => [r.target_id, r.value as ConnectionLastUsedPatternValue] as const),
    );
    expect(byTarget.get('hubspot')!.call_count).toBe(2);
    expect(byTarget.get('hubspot')!.distinct_recipes).toBe(1);
    expect(byTarget.get('salesforce')!.call_count).toBe(1);
    expect(byTarget.get('salesforce')!.distinct_recipes).toBe(1);
  });

  it('isolates aggregates per kind — same name across kinds', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'mcp', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, recipe_id: 'r-api' });
    insertActivity({ kind: 'mcp', name: 'hubspot', ts: NOW - ONE_HOUR, recipe_id: 'r-mcp' });

    runConnectionLastUsedPatternCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(2);
    const byScope = new Map(
      rows.map((r) => [r.scope, r.value as ConnectionLastUsedPatternValue] as const),
    );
    expect(byScope.get('connection.api')!.recipes[0]!.recipe_id).toBe('r-api');
    expect(byScope.get('connection.mcp')!.recipes[0]!.recipe_id).toBe('r-mcp');
  });

  it('excludes audit rows older than the rolling window', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 100 * ONE_DAY, recipe_id: 'old-recipe' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, recipe_id: 'new-recipe' });

    runConnectionLastUsedPatternCycle(buildCtx());
    const rows = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    const v = rows[0]!.value as ConnectionLastUsedPatternValue;
    expect(v.call_count).toBe(1);
    expect(v.distinct_recipes).toBe(1);
    expect(v.recipes[0]!.recipe_id).toBe('new-recipe');
  });

  it('upserts in place across runs (stable scope+target_id key)', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, recipe_id: 'r1' });
    runConnectionLastUsedPatternCycle(buildCtx());
    const firstIds = store
      .list({ topic: CONNECTION_LAST_USED_PATTERN_TOPIC, fresh_only: false })
      .map((r) => r._id);

    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - 30 * 60 * 1000, recipe_id: 'r2' });
    runConnectionLastUsedPatternCycle(buildCtx());
    const secondRows = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0]!._id).toBe(firstIds[0]!);
    const v = secondRows[0]!.value as ConnectionLastUsedPatternValue;
    expect(v.call_count).toBe(2);
    expect(v.distinct_recipes).toBe(2);
  });

  it('sweeps rows for un-enrolled connections', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertConnection({ kind: 'api', name: 'salesforce' });
    runConnectionLastUsedPatternCycle(buildCtx());
    expect(store.countForTopic(CONNECTION_LAST_USED_PATTERN_TOPIC)).toBe(2);

    db.prepare(`DELETE FROM connections WHERE kind = ? AND name = ?`).run(
      'api',
      'salesforce',
    );
    const out = runConnectionLastUsedPatternCycle(buildCtx());
    expect(out.swept).toBe(1);

    const remaining = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.target_id).toBe('hubspot');
  });

  it('sweeps every row when all connections are un-enrolled', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    runConnectionLastUsedPatternCycle(buildCtx());
    expect(store.countForTopic(CONNECTION_LAST_USED_PATTERN_TOPIC)).toBe(1);

    db.prepare(`DELETE FROM connections`).run();
    const out = runConnectionLastUsedPatternCycle(buildCtx());
    expect(out.swept).toBe(1);
    expect(store.countForTopic(CONNECTION_LAST_USED_PATTERN_TOPIC)).toBe(0);
  });

  it('connectionLastUsedPatternTask.step returns complete + zero-cost cursor', async () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    const result = await connectionLastUsedPatternTask.step(
      buildCtx(),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('round-trips through the registry value_schema (no schema rejection)', () => {
    insertConnection({ kind: 'api', name: 'hubspot' });
    insertActivity({ kind: 'api', name: 'hubspot', ts: NOW - ONE_HOUR, recipe_id: 'r1' });
    expect(() => runConnectionLastUsedPatternCycle(buildCtx())).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep helper — direct
// ────────────────────────────────────────────────────────────────

describe('sweepStaleLastUsedPatternRows', () => {
  it('deletes rows whose key is not in the fresh set', () => {
    store.upsert({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      scope: 'connection.api',
      target_id: 'hubspot',
      value: computeLastUsedPatternValue([], NOW),
      authored_by: CONNECTION_LAST_USED_PATTERN_AUTHORED_BY,
    });
    store.upsert({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      scope: 'connection.api',
      target_id: 'salesforce',
      value: computeLastUsedPatternValue([], NOW),
      authored_by: CONNECTION_LAST_USED_PATTERN_AUTHORED_BY,
    });

    const fresh = new Set([composeConnectionFreshKey('connection.api', 'hubspot')]);
    const out = sweepStaleLastUsedPatternRows(buildCtx(), fresh);
    expect(out.deleted).toBe(1);

    const remaining = store.list({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      fresh_only: false,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.target_id).toBe('hubspot');
  });

  it('preserves all rows when every key is fresh', () => {
    store.upsert({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      scope: 'connection.api',
      target_id: 'hubspot',
      value: computeLastUsedPatternValue([], NOW),
      authored_by: CONNECTION_LAST_USED_PATTERN_AUTHORED_BY,
    });
    const fresh = new Set([composeConnectionFreshKey('connection.api', 'hubspot')]);
    const out = sweepStaleLastUsedPatternRows(buildCtx(), fresh);
    expect(out.deleted).toBe(0);
  });

  it('does not touch rows under a different topic', () => {
    // Seed an A.18 row alongside an A.19 row; sweep should only act on
    // the A.19 topic.
    store.upsert({
      topic: 'connection_health_trend',
      scope: 'connection.api',
      target_id: 'hubspot',
      value: { call_count: 0, error_count: 0, error_rate: 0, latency_p50_ms: null, latency_p95_ms: null, last_call_at: null, last_failure: null, window_ms: 1000, computed_at: NOW },
      authored_by: 'system.housekeeping.connection_health_trend',
    });
    store.upsert({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      scope: 'connection.api',
      target_id: 'hubspot',
      value: computeLastUsedPatternValue([], NOW),
      authored_by: CONNECTION_LAST_USED_PATTERN_AUTHORED_BY,
    });
    const fresh = new Set<string>(); // empty — would sweep all A.19 rows
    sweepStaleLastUsedPatternRows(buildCtx(), fresh);
    // A.18 row survives.
    expect(store.countForTopic('connection_health_trend')).toBe(1);
    expect(store.countForTopic(CONNECTION_LAST_USED_PATTERN_TOPIC)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema round-trip
// ────────────────────────────────────────────────────────────────

describe('connection_last_used_pattern value_schema', () => {
  const baseValue: ConnectionLastUsedPatternValue = {
    call_count: 5,
    last_used_at: NOW,
    recipes: [
      { recipe_id: 'r1', call_count: 3, last_used_at: NOW },
      { recipe_id: 'r2', call_count: 1, last_used_at: NOW - ONE_HOUR },
    ],
    distinct_recipes: 2,
    unattributed_call_count: 1,
    hour_histogram: emptyHourHistogram(),
    window_ms: CONNECTION_LAST_USED_PATTERN_WINDOW_MS,
    computed_at: NOW,
  };

  it('accepts a well-formed value', () => {
    const result =
      ENRICHMENT_REGISTRY.connection_last_used_pattern.value_schema(baseValue);
    expect(result.ok).toBe(true);
  });

  it('accepts null last_used_at + empty recipes (zero-call shape)', () => {
    const v: ConnectionLastUsedPatternValue = {
      ...baseValue,
      call_count: 0,
      last_used_at: null,
      recipes: [],
      distinct_recipes: 0,
      unattributed_call_count: 0,
    };
    const result =
      ENRICHMENT_REGISTRY.connection_last_used_pattern.value_schema(v);
    expect(result.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const result =
      ENRICHMENT_REGISTRY.connection_last_used_pattern.value_schema('not an object');
    expect(result.ok).toBe(false);
  });

  it('rejects missing call_count', () => {
    const v = { ...baseValue } as Partial<ConnectionLastUsedPatternValue>;
    delete v.call_count;
    const result = ENRICHMENT_REGISTRY.connection_last_used_pattern.value_schema(v);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed recipes (non-string recipe_id)', () => {
    const v = {
      ...baseValue,
      recipes: [{ recipe_id: 123, call_count: 1, last_used_at: NOW }],
    };
    const result = ENRICHMENT_REGISTRY.connection_last_used_pattern.value_schema(v);
    expect(result.ok).toBe(false);
  });

  it('rejects hour_histogram with wrong length', () => {
    const v = { ...baseValue, hour_histogram: [0, 0, 0] };
    const result = ENRICHMENT_REGISTRY.connection_last_used_pattern.value_schema(v);
    expect(result.ok).toBe(false);
  });

  it('rejects hour_histogram with non-number entries', () => {
    const arr = emptyHourHistogram() as unknown as number[];
    arr[0] = 'oops' as unknown as number;
    const v = { ...baseValue, hour_histogram: arr };
    const result = ENRICHMENT_REGISTRY.connection_last_used_pattern.value_schema(v);
    expect(result.ok).toBe(false);
  });

  it('rejects null hour_histogram', () => {
    const v = { ...baseValue, hour_histogram: null };
    const result = ENRICHMENT_REGISTRY.connection_last_used_pattern.value_schema(v);
    expect(result.ok).toBe(false);
  });
});
