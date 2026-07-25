/** D-145 PA9 — `source_freshness_degradation` producer tests.
 *
 *  Seventh D-145 PA9 producer impl + first scenario-aggregation Shape B
 *  derived-entity producer in this arc (the prior six are per-record on
 *  work-entity walker scopes). Covers:
 *    - Producer surface contract (topic / kind / is_ai_surface=false /
 *      token=0 / interruptible / tags / scope_read_declaration four-
 *      collection-plus-source-registry-plus-connection shape)
 *    - Registry shape + producer_kind + lifecycle_policy + identity_-
 *      aggregation alignment
 *    - parseConnectionSourceRef pure cases (3-segment ids; multi-dot
 *      connection names; rejecting builtin ids; rejecting empty
 *      segments)
 *    - parseConnectionHealth pure cases (well-formed / malformed JSON /
 *      array-shape / non-status / null inputs)
 *    - reasonsFromConnectionHealth pure cases (auth_failed →
 *      permission_revoked; unreachable → quota_suspended; ok / unknown
 *      / null → empty)
 *    - appendUniqueReason pure cases (deduplication invariant)
 *    - detectDegradationReasons pure cases (enabled flag + missing
 *      connection + health-driven reasons; dedup across signals)
 *    - SQL helpers — `findConnectionByName` probe order +
 *      missing-table tolerance; `computeLastSeenAtForSource` MAX
 *      across four tables + tombstone / orphan exclusion + missing
 *      tables
 *    - Whole-cycle orchestration — happy path / multi-source / sweep
 *      on un-register / no-store abstention / no-sources abstention /
 *      cap enforcement
 *    - Registry value_schema acceptance round-trip on a producer-
 *      emitted payload */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  SOURCE_DEGRADATION_REASON_VALUES,
  SOURCE_FRESHNESS_DEGRADATION_DECLARATION,
  type ConnectionHealth,
  type SourceFreshnessDegradationValue,
  type SourceRegistration,
} from '@recued/contracts';

import {
  SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY,
  SOURCE_FRESHNESS_DEGRADATION_MAX_SOURCES,
  SOURCE_FRESHNESS_DEGRADATION_TOKEN_ESTIMATE,
  SOURCE_FRESHNESS_DEGRADATION_TOPIC,
  appendUniqueReason,
  computeLastSeenAtForSource,
  detectDegradationReasons,
  findConnectionByName,
  getConnectionByKindAndName,
  parseConnectionHealth,
  parseConnectionSourceRef,
  reasonsFromConnectionHealth,
  runSourceFreshnessDegradationCycle,
  sourceFreshnessDegradationScopeReadDeclaration,
  sourceFreshnessDegradationTask,
  sourceFreshnessDegradationTokenEstimate,
  sweepStaleSourceFreshnessRows,
  type SourceFreshnessConnectionLookupRow,
} from '../housekeeping/index.js';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import {
  COMMITMENT_TABLE,
  NOTE_TABLE,
  PROJECT_TABLE,
  TASK_TABLE,
} from '../storage/work-entity-store.js';
import {
  createFileSourceSyncStateStore,
  ensureFileSourceSyncStateSchema,
  initialFileSourceSyncState,
} from '../storage/file-source-sync-state.js';
import {
  createContactSourceSyncStateStore,
  ensureContactSourceSyncStateSchema,
  initialContactSourceSyncState,
} from '../storage/contact-source-sync-state.js';

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

const installWorkEntityTables = (): void => {
  // Minimal columns — only what the producer's `last_seen_at` reads.
  for (const table of [TASK_TABLE, NOTE_TABLE, COMMITMENT_TABLE, PROJECT_TABLE]) {
    db.exec(`
      CREATE TABLE ${table} (
        id           TEXT PRIMARY KEY,
        source_id    TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        sync_state   TEXT NOT NULL DEFAULT 'live',
        deleted_at   INTEGER
      );
    `);
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-srcfresh-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  installConnectionsTable();
  installWorkEntityTables();
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface InsertedConnection {
  kind: 'api' | 'mcp' | 'notification';
  name: string;
  health?: ConnectionHealth;
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
    c.name,
    null,
    '{}',
    'cipher',
    NOW - 30 * ONE_DAY,
    NOW - ONE_DAY,
    null,
    c.health ? JSON.stringify(c.health) : null,
  );
};

interface InsertedEntity {
  table: string;
  id: string;
  source_id: string;
  last_seen_at: number;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned' | 'orphaned';
  deleted_at?: number | null;
}

const insertEntity = (e: InsertedEntity): void => {
  db.prepare(
    `INSERT INTO ${e.table} (id, source_id, last_seen_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.source_id,
    e.last_seen_at,
    e.sync_state ?? 'live',
    e.deleted_at ?? null,
  );
};

interface FakeWorkEntityStore extends Pick<WorkEntityStore, 'listSources'> {
  sources: SourceRegistration[];
}

const buildFakeWorkEntityStore = (
  sources: SourceRegistration[],
): FakeWorkEntityStore => ({
  sources,
  listSources: (kind) =>
    kind === undefined
      ? sources.slice()
      : sources.filter((s) => s.top_tier_kind === kind),
});

const buildCtx = (
  workEntityStore: WorkEntityStore | undefined,
  now: number = NOW,
): HousekeepingContext => ({
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
  ...(workEntityStore !== undefined ? { workEntityStore } : {}),
});

const fakeSource = (
  overrides: Partial<SourceRegistration> & { id: string },
): SourceRegistration => ({
  id: overrides.id,
  top_tier_kind: overrides.top_tier_kind ?? 'task',
  source_kind: overrides.source_kind ?? 'builtin',
  source_label: overrides.source_label ?? overrides.id,
  write_capable: overrides.write_capable ?? true,
  mcp_exposed: overrides.mcp_exposed ?? false,
  registered_at: overrides.registered_at ?? NOW - 30 * ONE_DAY,
  ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
  ...(overrides.schema_extension_blob !== undefined
    ? { schema_extension_blob: overrides.schema_extension_blob }
    : {}),
  ...(overrides.config_blob !== undefined ? { config_blob: overrides.config_blob } : {}),
});

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('sourceFreshnessDegradationTask surface contract', () => {
  it('targets the source_freshness_degradation registry topic', () => {
    expect(sourceFreshnessDegradationTask.topic).toBe(
      'source_freshness_degradation',
    );
    expect(SOURCE_FRESHNESS_DEGRADATION_TOPIC).toBe(
      'source_freshness_degradation',
    );
  });

  it('declares is_ai_surface=false (deterministic)', () => {
    expect(sourceFreshnessDegradationTask.is_ai_surface).toBe(false);
  });

  it('declares meta.kind=enrichment', () => {
    expect(sourceFreshnessDegradationTask.meta.kind).toBe('enrichment');
  });

  it('declares meta.id=enrichment.source_freshness_degradation', () => {
    expect(sourceFreshnessDegradationTask.meta.id).toBe(
      'enrichment.source_freshness_degradation',
    );
  });

  it('declares meta.interruptible=true', () => {
    expect(sourceFreshnessDegradationTask.meta.interruptible).toBe(true);
  });

  it('exposes a zero-token cycle estimate (deterministic)', () => {
    expect(sourceFreshnessDegradationTokenEstimate()).toBe(0);
    expect(sourceFreshnessDegradationTokenEstimate()).toBe(
      SOURCE_FRESHNESS_DEGRADATION_TOKEN_ESTIMATE,
    );
  });

  it('declares scope_read_declaration covering source_registry + connection + 4 work-entity tables + BOTH sync-state tables', () => {
    const collections = sourceFreshnessDegradationScopeReadDeclaration.map(
      (e) => e.collection,
    );
    expect(collections).toEqual([
      'source_registry',
      'connection',
      'data.task',
      'data.note',
      'data.commitment',
      'data.project',
      // D-192 — the file Source freshness read must be disclosed too.
      'file_source_sync_state',
      // D-205 #1 — and so must the CONTACT twin. The producer has read it since #1
      // (it is in `SOURCE_SYNC_STATE_TABLE_BY_KIND`) but did not disclose it —
      // an undeclared read, caught while building #2c. Every table the producer
      // touches must appear here, or the declaration is a lie its consumers trust.
      'contact_source_sync_state',
    ]);
    for (const entry of sourceFreshnessDegradationScopeReadDeclaration) {
      expect(entry.sample_field_paths.length).toBeGreaterThan(0);
    }
  });

  it('authored_by uses the system.housekeeping.<topic> convention', () => {
    expect(SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY).toBe(
      'system.housekeeping.source_freshness_degradation',
    );
  });

  it('declares a defensive per-cycle source cap', () => {
    expect(SOURCE_FRESHNESS_DEGRADATION_MAX_SOURCES).toBeGreaterThan(100);
    expect(SOURCE_FRESHNESS_DEGRADATION_MAX_SOURCES).toBeLessThan(100000);
  });
});

describe('source_freshness_degradation registry entry', () => {
  it('is shape: derived_entity', () => {
    expect(ENRICHMENT_REGISTRY.source_freshness_degradation.shape).toBe(
      'derived_entity',
    );
  });

  it('uses policy: independent', () => {
    expect(ENRICHMENT_REGISTRY.source_freshness_degradation.policy).toBe(
      'independent',
    );
  });

  it('uses producer_kind=housekeeping (PA9 reactive harness lift deferred)', () => {
    expect(
      ENRICHMENT_REGISTRY.source_freshness_degradation.producer_kind,
    ).toBe('housekeeping');
  });

  it('does NOT declare recompute_cadence (standalone task self-manages cadence)', () => {
    const def = ENRICHMENT_REGISTRY.source_freshness_degradation as {
      recompute_cadence?: string;
    };
    expect(def.recompute_cadence).toBeUndefined();
  });

  it('does NOT declare aggregates_from (warehouse-scope enum, not source_registry / connection)', () => {
    const def = ENRICHMENT_REGISTRY.source_freshness_degradation as {
      aggregates_from?: ReadonlyArray<string>;
    };
    expect(def.aggregates_from).toBeUndefined();
  });

  it('temporal_class = stable_truth + identity_aggregation = scenario', () => {
    const def = ENRICHMENT_REGISTRY.source_freshness_degradation;
    expect(def.temporal_class).toBe('stable_truth');
    expect(def.identity_aggregation).toBe('scenario');
  });

  it('lifecycle_policy = recompute_on_drift', () => {
    expect(
      ENRICHMENT_REGISTRY.source_freshness_degradation.lifecycle_policy,
    ).toBe('recompute_on_drift');
  });

  it('default_trust_state=auto, default_pool_policy=free_only (no LLM)', () => {
    const def = ENRICHMENT_REGISTRY.source_freshness_degradation;
    expect(def.default_trust_state).toBe('auto');
    expect(def.default_pool_policy).toBe('free_only');
  });

  it('declaration + registry producer_kind agree on housekeeping', () => {
    expect(SOURCE_FRESHNESS_DEGRADATION_DECLARATION.producer_kind).toBe(
      'housekeeping',
    );
    expect(
      ENRICHMENT_REGISTRY.source_freshness_degradation.producer_kind,
    ).toBe('housekeeping');
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helper — parseConnectionSourceRef
// ────────────────────────────────────────────────────────────────

describe('parseConnectionSourceRef', () => {
  it('parses a vendor.connection.kind id', () => {
    expect(parseConnectionSourceRef('hubspot.conn_1.task')).toEqual({
      vendor: 'hubspot',
      connection_name: 'conn_1',
    });
  });

  it('parses a salesforce id with multi-segment connection name', () => {
    expect(parseConnectionSourceRef('salesforce.prod.us.task')).toEqual({
      vendor: 'salesforce',
      connection_name: 'prod.us',
    });
  });

  it('returns null on a 2-segment id (no connection name slot)', () => {
    expect(parseConnectionSourceRef('recued.task')).toBeNull();
  });

  it('returns null on an empty id', () => {
    expect(parseConnectionSourceRef('')).toBeNull();
  });

  it('returns null on an id whose middle is empty', () => {
    expect(parseConnectionSourceRef('hubspot..task')).toBeNull();
  });

  it('returns null on a single-segment id', () => {
    expect(parseConnectionSourceRef('hubspot')).toBeNull();
  });

  it('returns null on an id with empty vendor', () => {
    expect(parseConnectionSourceRef('.conn_1.task')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helper — parseConnectionHealth
// ────────────────────────────────────────────────────────────────

describe('parseConnectionHealth', () => {
  it('parses a well-formed ok-status payload', () => {
    const parsed = parseConnectionHealth(
      JSON.stringify({ status: 'ok', last_probed_at: NOW }),
    );
    expect(parsed?.status).toBe('ok');
    expect(parsed?.last_probed_at).toBe(NOW);
  });

  it('parses auth_failed / unreachable / unknown statuses', () => {
    expect(parseConnectionHealth(JSON.stringify({ status: 'auth_failed' }))?.status).toBe(
      'auth_failed',
    );
    expect(parseConnectionHealth(JSON.stringify({ status: 'unreachable' }))?.status).toBe(
      'unreachable',
    );
    expect(parseConnectionHealth(JSON.stringify({ status: 'unknown' }))?.status).toBe(
      'unknown',
    );
  });

  it('returns null on a non-string input', () => {
    expect(parseConnectionHealth(null)).toBeNull();
    expect(parseConnectionHealth(undefined)).toBeNull();
  });

  it('returns null on an empty string', () => {
    expect(parseConnectionHealth('')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseConnectionHealth('{not json')).toBeNull();
  });

  it('returns null on an array payload', () => {
    expect(parseConnectionHealth('[]')).toBeNull();
  });

  it('returns null on a payload with unknown status', () => {
    expect(parseConnectionHealth(JSON.stringify({ status: 'borked' }))).toBeNull();
  });

  it('returns null on a payload missing status', () => {
    expect(parseConnectionHealth(JSON.stringify({ last_probed_at: NOW }))).toBeNull();
  });

  it('returns null on a JSON null payload', () => {
    expect(parseConnectionHealth('null')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helper — reasonsFromConnectionHealth
// ────────────────────────────────────────────────────────────────

describe('reasonsFromConnectionHealth', () => {
  it('maps auth_failed → permission_revoked', () => {
    expect(reasonsFromConnectionHealth({ status: 'auth_failed' })).toEqual([
      'permission_revoked',
    ]);
  });

  it('maps unreachable → quota_suspended', () => {
    expect(reasonsFromConnectionHealth({ status: 'unreachable' })).toEqual([
      'quota_suspended',
    ]);
  });

  it('returns empty for ok status', () => {
    expect(reasonsFromConnectionHealth({ status: 'ok' })).toEqual([]);
  });

  it('returns empty for unknown status', () => {
    expect(reasonsFromConnectionHealth({ status: 'unknown' })).toEqual([]);
  });

  it('returns empty for null health', () => {
    expect(reasonsFromConnectionHealth(null)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helper — appendUniqueReason
// ────────────────────────────────────────────────────────────────

describe('appendUniqueReason', () => {
  it('appends a new reason', () => {
    const r: ('permission_revoked' | 'quota_suspended')[] = [];
    appendUniqueReason(r, 'permission_revoked');
    expect(r).toEqual(['permission_revoked']);
  });

  it('skips a duplicate reason', () => {
    const r: ('permission_revoked')[] = ['permission_revoked'];
    appendUniqueReason(r, 'permission_revoked');
    expect(r).toEqual(['permission_revoked']);
  });

  it('preserves insertion order across multiple appends', () => {
    const r: ('permission_revoked' | 'quota_suspended' | 'rate_limit_active')[] = [];
    appendUniqueReason(r, 'permission_revoked');
    appendUniqueReason(r, 'quota_suspended');
    appendUniqueReason(r, 'permission_revoked');
    appendUniqueReason(r, 'rate_limit_active');
    expect(r).toEqual([
      'permission_revoked',
      'quota_suspended',
      'rate_limit_active',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helper — detectDegradationReasons
// ────────────────────────────────────────────────────────────────

const noopResolveConnection = (): SourceFreshnessConnectionLookupRow | null => null;

describe('detectDegradationReasons', () => {
  it('flags permission_revoked on a builtin Source whose enabled=false', () => {
    const source = fakeSource({
      id: 'recued.task',
      source_kind: 'builtin',
      enabled: false,
    });
    expect(detectDegradationReasons(source, noopResolveConnection)).toEqual([
      'permission_revoked',
    ]);
  });

  it('flags permission_revoked on a connection Source with missing backing connection', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: true,
    });
    expect(detectDegradationReasons(source, () => null)).toEqual([
      'permission_revoked',
    ]);
  });

  it('flags permission_revoked on a connection Source whose health is auth_failed', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: true,
    });
    const resolve = (): SourceFreshnessConnectionLookupRow => ({
      kind: 'api',
      name: 'conn_1',
      health_json: JSON.stringify({ status: 'auth_failed' }),
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([
      'permission_revoked',
    ]);
  });

  it('flags quota_suspended on a connection Source whose health is unreachable', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: true,
    });
    const resolve = (): SourceFreshnessConnectionLookupRow => ({
      kind: 'api',
      name: 'conn_1',
      health_json: JSON.stringify({ status: 'unreachable' }),
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([
      'quota_suspended',
    ]);
  });

  it('returns an empty list for a healthy enabled builtin Source', () => {
    const source = fakeSource({
      id: 'recued.task',
      source_kind: 'builtin',
      enabled: true,
    });
    expect(detectDegradationReasons(source, noopResolveConnection)).toEqual([]);
  });

  it('returns an empty list for a healthy connection Source whose health=ok', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: true,
    });
    const resolve = (): SourceFreshnessConnectionLookupRow => ({
      kind: 'api',
      name: 'conn_1',
      health_json: JSON.stringify({ status: 'ok' }),
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([]);
  });

  it('returns an empty list for a connection Source whose health is unknown', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: true,
    });
    const resolve = (): SourceFreshnessConnectionLookupRow => ({
      kind: 'api',
      name: 'conn_1',
      health_json: JSON.stringify({ status: 'unknown' }),
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([]);
  });

  it('returns an empty list when health_json is absent', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: true,
    });
    const resolve = (): SourceFreshnessConnectionLookupRow => ({
      kind: 'api',
      name: 'conn_1',
      health_json: null,
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([]);
  });

  it('deduplicates permission_revoked when enabled=false AND health=auth_failed', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: false,
    });
    const resolve = (): SourceFreshnessConnectionLookupRow => ({
      kind: 'api',
      name: 'conn_1',
      health_json: JSON.stringify({ status: 'auth_failed' }),
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([
      'permission_revoked',
    ]);
  });

  it('emits both reasons when enabled=false AND health=unreachable', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: false,
    });
    const resolve = (): SourceFreshnessConnectionLookupRow => ({
      kind: 'api',
      name: 'conn_1',
      health_json: JSON.stringify({ status: 'unreachable' }),
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([
      'permission_revoked',
      'quota_suspended',
    ]);
  });

  it('skips the connection-resolve branch for builtin Source even with parseable id', () => {
    let called = 0;
    const resolve = (): SourceFreshnessConnectionLookupRow | null => {
      called += 1;
      return null;
    };
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'builtin', // mismatched kind for the id format — still skip
      enabled: true,
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([]);
    expect(called).toBe(0);
  });

  it('skips the connection-resolve branch on a malformed Source id', () => {
    let called = 0;
    const resolve = (): SourceFreshnessConnectionLookupRow | null => {
      called += 1;
      return null;
    };
    const source = fakeSource({
      id: 'hubspot', // single segment — parseConnectionSourceRef returns null
      source_kind: 'connection',
      enabled: true,
    });
    expect(detectDegradationReasons(source, resolve)).toEqual([]);
    expect(called).toBe(0);
  });

  it('every emitted reason is a member of SOURCE_DEGRADATION_REASON_VALUES', () => {
    const source = fakeSource({
      id: 'hubspot.conn_1.task',
      source_kind: 'connection',
      enabled: false,
    });
    const resolve = (): SourceFreshnessConnectionLookupRow => ({
      kind: 'api',
      name: 'conn_1',
      health_json: JSON.stringify({ status: 'unreachable' }),
    });
    const reasons = detectDegradationReasons(source, resolve);
    for (const r of reasons) {
      expect(SOURCE_DEGRADATION_REASON_VALUES).toContain(r);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// SQL helpers — findConnectionByName + getConnectionByKindAndName
// ────────────────────────────────────────────────────────────────

describe('getConnectionByKindAndName', () => {
  it('returns the matching row', () => {
    insertConnection({ kind: 'api', name: 'conn_1' });
    const row = getConnectionByKindAndName(db, 'api', 'conn_1');
    expect(row).not.toBeNull();
    expect(row?.name).toBe('conn_1');
    expect(row?.kind).toBe('api');
  });

  it('returns null when no row matches', () => {
    expect(getConnectionByKindAndName(db, 'api', 'missing')).toBeNull();
  });

  it('returns null when the connections table does not exist', () => {
    db.exec('DROP TABLE connections');
    expect(getConnectionByKindAndName(db, 'api', 'conn_1')).toBeNull();
  });
});

describe('findConnectionByName', () => {
  it('finds an api connection by name', () => {
    insertConnection({ kind: 'api', name: 'hub_alpha' });
    const row = findConnectionByName(db, 'hub_alpha');
    expect(row?.name).toBe('hub_alpha');
    expect(row?.kind).toBe('api');
  });

  it('finds an mcp connection by name when api absent', () => {
    insertConnection({ kind: 'mcp', name: 'mcp_alpha' });
    const row = findConnectionByName(db, 'mcp_alpha');
    expect(row?.kind).toBe('mcp');
  });

  it('finds a notification connection by name when api + mcp absent', () => {
    insertConnection({ kind: 'notification', name: 'noti_alpha' });
    const row = findConnectionByName(db, 'noti_alpha');
    expect(row?.kind).toBe('notification');
  });

  it('returns null when name matches no kind', () => {
    insertConnection({ kind: 'api', name: 'other_name' });
    expect(findConnectionByName(db, 'absent')).toBeNull();
  });

  it('returns the api row when both api + mcp share the same name (api wins probe order)', () => {
    insertConnection({ kind: 'api', name: 'collide' });
    insertConnection({ kind: 'mcp', name: 'collide' });
    const row = findConnectionByName(db, 'collide');
    expect(row?.kind).toBe('api');
  });

  it('reads health_json on the matched row', () => {
    insertConnection({
      kind: 'api',
      name: 'hub_alpha',
      health: { status: 'auth_failed' },
    });
    const row = findConnectionByName(db, 'hub_alpha');
    expect(row?.health_json).not.toBeNull();
    const parsed = parseConnectionHealth(row?.health_json ?? null);
    expect(parsed?.status).toBe('auth_failed');
  });
});

// ────────────────────────────────────────────────────────────────
// SQL helpers — computeLastSeenAtForSource
// ────────────────────────────────────────────────────────────────

describe('computeLastSeenAtForSource', () => {
  it('returns null when no entity rows match the Source', () => {
    expect(computeLastSeenAtForSource(db, 'recued.task')).toBeNull();
  });

  it('returns the MAX(last_seen_at) across all four entity tables', () => {
    insertEntity({
      table: TASK_TABLE,
      id: 't_1',
      source_id: 'recued.task',
      last_seen_at: NOW - 5 * ONE_DAY,
    });
    insertEntity({
      table: NOTE_TABLE,
      id: 'n_1',
      source_id: 'recued.task',
      last_seen_at: NOW - 2 * ONE_DAY,
    });
    insertEntity({
      table: COMMITMENT_TABLE,
      id: 'c_1',
      source_id: 'recued.task',
      last_seen_at: NOW - 10 * ONE_DAY,
    });
    insertEntity({
      table: PROJECT_TABLE,
      id: 'p_1',
      source_id: 'recued.task',
      last_seen_at: NOW - 1 * ONE_DAY,
    });
    expect(computeLastSeenAtForSource(db, 'recued.task')).toBe(NOW - ONE_DAY);
  });

  it('narrows to source_id (rows from other Sources excluded)', () => {
    insertEntity({
      table: TASK_TABLE,
      id: 't_focal',
      source_id: 'src_a',
      last_seen_at: NOW - ONE_DAY,
    });
    insertEntity({
      table: TASK_TABLE,
      id: 't_other',
      source_id: 'src_b',
      last_seen_at: NOW - ONE_HOUR,
    });
    expect(computeLastSeenAtForSource(db, 'src_a')).toBe(NOW - ONE_DAY);
  });

  it('excludes tombstoned rows', () => {
    insertEntity({
      table: TASK_TABLE,
      id: 't_alive',
      source_id: 'src_a',
      last_seen_at: NOW - 2 * ONE_DAY,
    });
    insertEntity({
      table: TASK_TABLE,
      id: 't_tomb',
      source_id: 'src_a',
      last_seen_at: NOW - ONE_HOUR,
      sync_state: 'tombstoned',
    });
    expect(computeLastSeenAtForSource(db, 'src_a')).toBe(NOW - 2 * ONE_DAY);
  });

  it('excludes orphaned rows', () => {
    insertEntity({
      table: TASK_TABLE,
      id: 't_alive',
      source_id: 'src_a',
      last_seen_at: NOW - 2 * ONE_DAY,
    });
    insertEntity({
      table: TASK_TABLE,
      id: 't_orphan',
      source_id: 'src_a',
      last_seen_at: NOW - ONE_HOUR,
      sync_state: 'orphaned',
    });
    expect(computeLastSeenAtForSource(db, 'src_a')).toBe(NOW - 2 * ONE_DAY);
  });

  it('excludes rows with deleted_at populated even when sync_state=live', () => {
    insertEntity({
      table: TASK_TABLE,
      id: 't_alive',
      source_id: 'src_a',
      last_seen_at: NOW - 2 * ONE_DAY,
    });
    insertEntity({
      table: TASK_TABLE,
      id: 't_deleted',
      source_id: 'src_a',
      last_seen_at: NOW - ONE_HOUR,
      deleted_at: NOW - 30 * 60 * 1000,
    });
    expect(computeLastSeenAtForSource(db, 'src_a')).toBe(NOW - 2 * ONE_DAY);
  });

  it('includes stale_unreachable rows', () => {
    insertEntity({
      table: TASK_TABLE,
      id: 't_stale',
      source_id: 'src_a',
      last_seen_at: NOW - 30 * ONE_DAY,
      sync_state: 'stale_unreachable',
    });
    expect(computeLastSeenAtForSource(db, 'src_a')).toBe(NOW - 30 * ONE_DAY);
  });

  it('tolerates missing entity tables gracefully', () => {
    db.exec(`DROP TABLE ${TASK_TABLE}`);
    db.exec(`DROP TABLE ${NOTE_TABLE}`);
    db.exec(`DROP TABLE ${COMMITMENT_TABLE}`);
    db.exec(`DROP TABLE ${PROJECT_TABLE}`);
    expect(computeLastSeenAtForSource(db, 'src_a')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Cycle — happy path
// ────────────────────────────────────────────────────────────────

describe('runSourceFreshnessDegradationCycle — happy paths', () => {
  it('emits one row per registered Source', () => {
    const sources = [
      fakeSource({ id: 'recued.task' }),
      fakeSource({ id: 'recued.note', top_tier_kind: 'note' }),
      fakeSource({ id: 'recued.commitment', top_tier_kind: 'commitment' }),
      fakeSource({ id: 'recued.project', top_tier_kind: 'project' }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    const result = runSourceFreshnessDegradationCycle(ctx);
    expect(result.produced).toBe(4);
    expect(result.swept).toBe(0);

    const rows = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 100,
    });
    expect(rows.length).toBe(4);
    for (const row of rows) {
      const v = row.value as SourceFreshnessDegradationValue;
      expect(v.degraded).toBe(false);
      expect(v.reasons).toEqual([]);
      expect(v.last_seen_at).toBeNull();
      expect(v.computed_at).toBe(NOW);
    }
  });

  it('marks an enabled=false builtin Source as degraded', () => {
    const sources = [
      fakeSource({ id: 'recued.task', enabled: false }),
      fakeSource({ id: 'recued.note', top_tier_kind: 'note', enabled: true }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const disabled = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 100,
    }).find((r) => r._id === 'recued.task');
    expect(disabled).toBeDefined();
    const v = disabled!.value as SourceFreshnessDegradationValue;
    expect(v.degraded).toBe(true);
    expect(v.reasons).toEqual(['permission_revoked']);
  });

  it('marks a connection Source with auth_failed health as degraded', () => {
    insertConnection({
      kind: 'api',
      name: 'conn_1',
      health: { status: 'auth_failed' },
    });
    const sources = [
      fakeSource({
        id: 'hubspot.conn_1.task',
        source_kind: 'connection',
        enabled: true,
      }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const row = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 100,
    })[0];
    const v = row!.value as SourceFreshnessDegradationValue;
    expect(v.degraded).toBe(true);
    expect(v.reasons).toEqual(['permission_revoked']);
  });

  it('marks a connection Source with no backing connection as degraded', () => {
    const sources = [
      fakeSource({
        id: 'hubspot.orphan_conn.task',
        source_kind: 'connection',
        enabled: true,
      }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const row = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 100,
    })[0];
    const v = row!.value as SourceFreshnessDegradationValue;
    expect(v.degraded).toBe(true);
    expect(v.reasons).toEqual(['permission_revoked']);
  });

  it('populates last_seen_at from the per-Source MAX across entity tables', () => {
    insertEntity({
      table: TASK_TABLE,
      id: 't_1',
      source_id: 'recued.task',
      last_seen_at: NOW - 3 * ONE_DAY,
    });
    insertEntity({
      table: PROJECT_TABLE,
      id: 'p_1',
      source_id: 'recued.project',
      last_seen_at: NOW - ONE_HOUR,
    });
    const sources = [
      fakeSource({ id: 'recued.task' }),
      fakeSource({ id: 'recued.project', top_tier_kind: 'project' }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const rows = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 100,
    });
    const taskRow = rows.find((r) => r._id === 'recued.task')!;
    const projectRow = rows.find((r) => r._id === 'recued.project')!;
    expect((taskRow.value as SourceFreshnessDegradationValue).last_seen_at).toBe(
      NOW - 3 * ONE_DAY,
    );
    expect(
      (projectRow.value as SourceFreshnessDegradationValue).last_seen_at,
    ).toBe(NOW - ONE_HOUR);
  });

  it('stamps event_at and authored_by on every emitted row', () => {
    const sources = [fakeSource({ id: 'recued.task' })];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const row = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 100,
    })[0]!;
    expect(row.authored_by).toBe(SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY);
    expect(row.event_at).toBe(NOW);
    expect(row._id).toBe('recued.task');
  });
});

// ────────────────────────────────────────────────────────────────
// Cycle — abstention paths
// ────────────────────────────────────────────────────────────────

describe('runSourceFreshnessDegradationCycle — abstentions', () => {
  it('emits nothing when workEntityStore is undefined', () => {
    const ctx = buildCtx(undefined);
    const result = runSourceFreshnessDegradationCycle(ctx);
    expect(result.produced).toBe(0);
    expect(result.swept).toBe(0);
    expect(
      store.list({
        topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
        fresh_only: false,
        limit: 100,
      }).length,
    ).toBe(0);
  });

  it('emits nothing when no Sources are registered', () => {
    const ctx = buildCtx(buildFakeWorkEntityStore([]) as unknown as WorkEntityStore);
    const result = runSourceFreshnessDegradationCycle(ctx);
    expect(result.produced).toBe(0);
    expect(result.swept).toBe(0);
  });

  it('still sweeps stale rows when the Source list is empty', () => {
    // Pre-populate a row that the empty cycle should remove.
    store.upsert({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      derived_entity_id: 'stale.task',
      value: {
        degraded: false,
        reasons: [],
        last_seen_at: null,
        computed_at: NOW - ONE_DAY,
      },
      authored_by: SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY,
      event_at: NOW - ONE_DAY,
    });
    expect(
      store.list({
        topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
        fresh_only: false,
        limit: 10,
      }).length,
    ).toBe(1);

    const ctx = buildCtx(buildFakeWorkEntityStore([]) as unknown as WorkEntityStore);
    const result = runSourceFreshnessDegradationCycle(ctx);
    expect(result.produced).toBe(0);
    expect(result.swept).toBe(1);
    expect(
      store.list({
        topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
        fresh_only: false,
        limit: 10,
      }).length,
    ).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Cycle — sweep on un-register
// ────────────────────────────────────────────────────────────────

describe('runSourceFreshnessDegradationCycle — sweep', () => {
  it('removes rows whose Source has been un-registered since the prior cycle', () => {
    // First cycle: two Sources.
    let sources = [
      fakeSource({ id: 'recued.task' }),
      fakeSource({ id: 'recued.note', top_tier_kind: 'note' }),
    ];
    let ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    expect(
      store.list({
        topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
        fresh_only: false,
        limit: 10,
      }).length,
    ).toBe(2);

    // Second cycle: only one Source remains.
    sources = [fakeSource({ id: 'recued.task' })];
    ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    const result = runSourceFreshnessDegradationCycle(ctx);
    expect(result.produced).toBe(1);
    expect(result.swept).toBe(1);

    const remaining = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 10,
    });
    expect(remaining.length).toBe(1);
    expect(remaining[0]!._id).toBe('recued.task');
  });

  it('preserves rows whose Source still exists across cycles (upsert in place)', () => {
    const sources = [fakeSource({ id: 'recued.task' })];
    let ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const firstRow = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 10,
    })[0]!;

    ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore,
      NOW + ONE_HOUR);
    const result = runSourceFreshnessDegradationCycle(ctx);
    expect(result.produced).toBe(1);
    expect(result.swept).toBe(0);

    const secondRow = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 10,
    })[0]!;
    // Same logical id; refreshed event_at.
    expect(secondRow._id).toBe(firstRow._id);
    expect(secondRow.event_at).toBe(NOW + ONE_HOUR);
  });

  it('sweepStaleSourceFreshnessRows deletes rows whose id is not in the fresh set', () => {
    store.upsert({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      derived_entity_id: 'keep.task',
      value: { degraded: false, reasons: [], last_seen_at: null, computed_at: NOW },
      authored_by: SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY,
      event_at: NOW,
    });
    store.upsert({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      derived_entity_id: 'drop.task',
      value: { degraded: false, reasons: [], last_seen_at: null, computed_at: NOW },
      authored_by: SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY,
      event_at: NOW,
    });
    const ctx = buildCtx(undefined);
    const { deleted } = sweepStaleSourceFreshnessRows(ctx, new Set(['keep.task']));
    expect(deleted).toBe(1);
    const remaining = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 10,
    });
    expect(remaining.length).toBe(1);
    expect(remaining[0]!._id).toBe('keep.task');
  });
});

// ────────────────────────────────────────────────────────────────
// Cycle — cap
// ────────────────────────────────────────────────────────────────

describe('runSourceFreshnessDegradationCycle — cap', () => {
  it('emits at most SOURCE_FRESHNESS_DEGRADATION_MAX_SOURCES rows per cycle', () => {
    // Build a pathological source list 1 over the cap.
    const cap = SOURCE_FRESHNESS_DEGRADATION_MAX_SOURCES;
    const sources: SourceRegistration[] = [];
    for (let i = 0; i < cap + 1; i++) {
      sources.push(fakeSource({ id: `recued.task.synth_${i}` }));
    }
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    const result = runSourceFreshnessDegradationCycle(ctx);
    expect(result.produced).toBe(cap);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry round-trip
// ────────────────────────────────────────────────────────────────

describe('source_freshness_degradation registry round-trip', () => {
  it('value_schema accepts a healthy producer-emitted payload', () => {
    const sources = [fakeSource({ id: 'recued.task' })];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const row = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 10,
    })[0]!;
    const def = ENRICHMENT_REGISTRY.source_freshness_degradation as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    expect(def.value_schema(row.value).ok).toBe(true);
  });

  it('value_schema accepts a degraded producer-emitted payload', () => {
    insertConnection({
      kind: 'api',
      name: 'conn_1',
      health: { status: 'unreachable' },
    });
    const sources = [
      fakeSource({
        id: 'hubspot.conn_1.task',
        source_kind: 'connection',
        enabled: false,
      }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const row = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 10,
    })[0]!;
    const v = row.value as SourceFreshnessDegradationValue;
    expect(v.degraded).toBe(true);
    expect(v.reasons.length).toBeGreaterThan(0);
    const def = ENRICHMENT_REGISTRY.source_freshness_degradation as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    expect(def.value_schema(v).ok).toBe(true);
  });

  it('every emitted reason is a member of SOURCE_DEGRADATION_REASON_VALUES', () => {
    insertConnection({
      kind: 'api',
      name: 'conn_1',
      health: { status: 'unreachable' },
    });
    const sources = [
      fakeSource({
        id: 'hubspot.conn_1.task',
        source_kind: 'connection',
        enabled: false,
      }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const row = store.list({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      fresh_only: false,
      limit: 10,
    })[0]!;
    const v = row.value as SourceFreshnessDegradationValue;
    for (const r of v.reasons) {
      expect(SOURCE_DEGRADATION_REASON_VALUES).toContain(r);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// D-192 — file Sources read freshness from `file_source_sync_state`
// ────────────────────────────────────────────────────────────────

describe('runSourceFreshnessDegradationCycle — file Sources (D-192)', () => {
  const FILE_SID = 's3.conn_1.file'; // CONNECTION_SOURCE_ID('s3', 'conn_1', 'file')

  const seedFileState = (over: { last_success_at?: number | null; degraded?: boolean }): void => {
    ensureFileSourceSyncStateSchema(db);
    createFileSourceSyncStateStore(db).upsert({
      ...initialFileSourceSyncState(FILE_SID),
      ...over,
    });
  };

  const runForFileSource = (): SourceFreshnessDegradationValue => {
    // A healthy backing connection → no connection-derived reason, so the
    // file-sync signal is the only thing that can mark the Source degraded.
    insertConnection({ kind: 'api', name: 'conn_1' });
    const sources = [
      fakeSource({ id: FILE_SID, top_tier_kind: 'file', source_kind: 'connection', enabled: true }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const row = store
      .list({ topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC, fresh_only: false, limit: 100 })
      .find((r) => r._id === FILE_SID);
    return row!.value as SourceFreshnessDegradationValue;
  };

  it("reads a file Source's last_seen_at from file_source_sync_state (not the empty work-entity walk)", () => {
    seedFileState({ last_success_at: NOW - ONE_HOUR, degraded: false });
    const v = runForFileSource();
    expect(v.last_seen_at).toBe(NOW - ONE_HOUR); // computeLastSeenAtForSource is null here
    expect(v.degraded).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('marks a degraded file sync as partial_api_failure', () => {
    seedFileState({ last_success_at: NOW - ONE_DAY, degraded: true });
    const v = runForFileSource();
    expect(v.last_seen_at).toBe(NOW - ONE_DAY);
    expect(v.degraded).toBe(true);
    expect(v.reasons).toEqual(['partial_api_failure']);
  });

  it('a never-synced file Source (row present, no success yet) keeps last_seen_at null', () => {
    seedFileState({}); // fresh row: last_success_at null, degraded false
    const v = runForFileSource();
    expect(v.last_seen_at).toBeNull();
    expect(v.degraded).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('tolerates the file_source_sync_state table being absent (work-entity-only pair)', () => {
    // No `ensureFileSourceSyncStateSchema` — the table is never installed.
    insertConnection({ kind: 'api', name: 'conn_1' });
    const sources = [
      fakeSource({ id: FILE_SID, top_tier_kind: 'file', source_kind: 'connection', enabled: true }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    expect(() => runSourceFreshnessDegradationCycle(ctx)).not.toThrow();
    const row = store
      .list({ topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC, fresh_only: false, limit: 100 })
      .find((r) => r._id === FILE_SID);
    expect((row!.value as SourceFreshnessDegradationValue).last_seen_at).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// D-205 item #1 — contact Sources read freshness from `contact_source_sync_state`
// ────────────────────────────────────────────────────────────────

describe('runSourceFreshnessDegradationCycle — contact Sources (D-205 item #1)', () => {
  const CONTACT_SID = 'hubspot.conn_1.contact';

  const seedContactState = (
    over: { last_success_at?: number | null; degraded?: boolean },
  ): void => {
    ensureContactSourceSyncStateSchema(db);
    createContactSourceSyncStateStore(db).upsert({
      ...initialContactSourceSyncState(CONTACT_SID),
      ...over,
    });
  };

  const runForContactSource = (): SourceFreshnessDegradationValue => {
    // A healthy backing connection → no connection-derived reason, so the contact-sync
    // signal is the only thing that can mark the Source degraded.
    insertConnection({ kind: 'api', name: 'conn_1' });
    const sources = [
      fakeSource({
        id: CONTACT_SID,
        top_tier_kind: 'contact',
        source_kind: 'connection',
        enabled: true,
      }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    runSourceFreshnessDegradationCycle(ctx);
    const row = store
      .list({ topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC, fresh_only: false, limit: 100 })
      .find((r) => r._id === CONTACT_SID);
    return row!.value as SourceFreshnessDegradationValue;
  };

  it('🔴 marks a DEGRADED contact sync as partial_api_failure — the regression this closes', () => {
    // Before D-205 item #1 this producer had NO contact branch, and nothing recorded a
    // contact Source's health anyway. So a CRM contact Source whose leaf failed EVERY
    // record on EVERY cycle produced exactly this row — `degraded: false, reasons: []`,
    // `last_seen_at: null` — a clean bill of health over total failure. The engine then
    // fed that Source's (empty) contacts into AI context packets without a coverage
    // flag, because nothing anywhere knew it was broken.
    seedContactState({ last_success_at: NOW - ONE_DAY, degraded: true });

    const v = runForContactSource();

    expect(v.degraded).toBe(true);
    expect(v.reasons).toEqual(['partial_api_failure']);
    expect(v.last_seen_at).toBe(NOW - ONE_DAY);
  });

  it("reads a contact Source's last_seen_at from its state row, not the empty work-entity walk", () => {
    // A contact Source has NO rows in the four work-entity tables, so
    // `computeLastSeenAtForSource` is always null for it — exactly as for a file Source.
    // Its own state row is the only freshness anchor it has.
    seedContactState({ last_success_at: NOW - ONE_HOUR, degraded: false });

    const v = runForContactSource();

    expect(v.last_seen_at).toBe(NOW - ONE_HOUR);
    expect(v.degraded).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('a never-synced contact Source keeps last_seen_at null', () => {
    seedContactState({}); // the seeded row: never synced, not degraded
    const v = runForContactSource();
    expect(v.last_seen_at).toBeNull();
    expect(v.degraded).toBe(false);
  });

  it('tolerates the contact_source_sync_state table being absent', () => {
    // No `ensureContactSourceSyncStateSchema` — a work-entity-only pair never installs it.
    insertConnection({ kind: 'api', name: 'conn_1' });
    const sources = [
      fakeSource({
        id: CONTACT_SID,
        top_tier_kind: 'contact',
        source_kind: 'connection',
        enabled: true,
      }),
    ];
    const ctx = buildCtx(buildFakeWorkEntityStore(sources) as unknown as WorkEntityStore);
    expect(() => runSourceFreshnessDegradationCycle(ctx)).not.toThrow();
    const row = store
      .list({ topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC, fresh_only: false, limit: 100 })
      .find((r) => r._id === CONTACT_SID);
    expect((row!.value as SourceFreshnessDegradationValue).last_seen_at).toBeNull();
  });
});
