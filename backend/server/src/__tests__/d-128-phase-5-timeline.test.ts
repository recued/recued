/** D-128 Phase 5 — `data.timeline()` enrichment-row source.
 *
 *  Covers:
 *    - 4-segment platform-reference entity_id parses cleanly (no
 *      contract change beyond the JSDoc — split-on-first-colon
 *      already accommodates dotted scope shapes).
 *    - Enrichment loader surfaces `data_enrichment` rows for
 *      closed-list warehouse scopes (mail / contact / calendar /
 *      file) AND the new platform-reference scopes
 *      (`connection.api.<vendor>.<entity>`).
 *    - Payload carries value + meta + freshness + author.
 *    - Cross-source merge — enrichment rows interleave with memory
 *      / annotation / link rows in one DESC-by-effective-ts feed.
 *    - axis: 'event' uses `COALESCE(event_at, ingested_at)`;
 *      'ingestion' uses `ingested_at` alone.
 *    - since/until window applies against the effective ts.
 *    - Cursor pagination through enrichment-only entries.
 *    - Stale rows still appear (the badge is the renderer's job).
 *    - Graceful degradation when the enrichment store is absent.
 *    - Unsupported `collection` (random scope name) returns no rows
 *      without crashing the loader.
 *
 *  Spec: docs/d-128-spec.md §A.4 + Phase 5. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseTimelineEntityId,
  TIMELINE_SOURCES,
  type EmittedLink,
  type EnrichmentMeta,
  type TimelineEntry,
} from '@recued/contracts';

import {
  createAuditLogStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  ensureMemorySchema,
  getOrCreateRecipeInsight,
} from '../memory-schema.js';
import { insertLinks } from '../memory-links.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import { handleTimelineRequest, type TimelineDeps } from '../mcp/timeline.js';

// ────────────────────────────────────────────────────────────────
// Test harness — minimal sqlite + audit + annotation + enrichment
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let auditLog: AuditLogStore;
let annotationStore: AnnotationStore;
let enrichmentStore: EnrichmentStore;
let insightId: number;
let timeCursor: number;

const setupHarness = (): void => {
  dir = mkdtempSync(join(tmpdir(), 'd128-p5-timeline-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  ensureMemorySchema(db);

  const auditCol = createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  const activityCol = createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  auditLog = createAuditLogStore(auditCol, activityCol);

  const blobs = createBlobStore(join(dir, 'blobs'));
  let annCounter = 0;
  let annClock = 1_000_000;
  annotationStore = createAnnotationStore({
    db,
    blobs,
    now: () => annClock++,
    newId: () => `ann-${++annCounter}`,
  });

  timeCursor = 1_700_000_000_000;
  let enrCounter = 0;
  enrichmentStore = createEnrichmentStore(db, {
    now: () => timeCursor,
    newId: () => `enr-${++enrCounter}`,
  });

  insightId = getOrCreateRecipeInsight(db, {
    hash: 'h-1',
    slug: 'phase-5-recipe',
    version: 1,
    flattened: '{"trigger":{"type":"manual"},"steps":[]}',
  });
};

const teardown = (): void => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
};

beforeEach(() => setupHarness());
afterEach(() => teardown());

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const baseDeps = (): TimelineDeps => ({
  db,
  auditLog,
  annotationStore,
  enrichmentStore,
});

const seedDealHealthScore = (
  target_id: string,
  ts: number,
  overrides: { meta?: EnrichmentMeta | null; event_at?: number; stale?: boolean } = {},
): void => {
  timeCursor = ts;
  const meta: EnrichmentMeta | undefined =
    overrides.meta === null
      ? undefined
      : (overrides.meta ?? {
          snapshot_at: ts,
          snapshot_hash: `fnv1a:${target_id}-${ts}`,
          name: `Deal ${target_id}`,
          status: 'negotiation',
          amount: 50_000,
          owner: 'alice@acme.com',
          key_dates: { close_date: ts + 30 * 24 * 60 * 60 * 1000 },
        });
  const upsertInput: Parameters<EnrichmentStore['upsert']>[0] = {
    topic: 'deal_health_score',
    scope: 'connection.api.hubspot.deal',
    target_id,
    value: {
      score: 78,
      signals: ['recent_activity', 'stage_progress'],
      reasoning: 'Deal is moving through stages on cadence.',
      confidence: 0.82,
    },
    authored_by: 'system.housekeeping.deal_health_score',
    ingredient_slug: 'ai-score',
    model_id: 'gpt-4o-mini',
    ...(meta !== undefined ? { meta } : {}),
    ...(overrides.event_at !== undefined ? { event_at: overrides.event_at } : {}),
  };
  const row = enrichmentStore.upsert(upsertInput);
  if (overrides.stale) {
    enrichmentStore.markStaleForSource(
      'connection.api.hubspot.deal',
      target_id,
    );
  }
  // Reference `row` so a future linter doesn't trim the upsert call.
  void row;
};

const seedContactRollup = (
  target_id: string,
  ts: number,
  overrides: { event_at?: number } = {},
): void => {
  timeCursor = ts;
  const upsertInput: Parameters<EnrichmentStore['upsert']>[0] = {
    topic: 'contact_timeline_rollup',
    scope: 'contact',
    target_id,
    value: {
      interaction_count: 5,
      last_interaction: ts,
      recent_subjects: ['hello'],
      cursor_at: ts,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    },
    authored_by: 'system.housekeeping.contact_timeline_rollup',
    ...(overrides.event_at !== undefined ? { event_at: overrides.event_at } : {}),
  };
  enrichmentStore.upsert(upsertInput);
};

const seedAnnotation = async (
  collection: string,
  id: string,
  key: string,
  value: unknown,
): Promise<void> => {
  await annotationStore.annotate({
    target_collection: collection,
    target_id: id,
    key,
    value,
    authored_by_recipe_id: 'phase-5-recipe',
    recipe_hash: 'h-1',
    source_record_hash: `src:${collection}:${id}`,
  });
};

const seedAuditAndLink = async (
  run_id: string,
  collection: string,
  entity_id: string,
  ts: number,
): Promise<void> => {
  const entry: AuditEntry = {
    run_id,
    recipe_id: 'phase-5-recipe',
    recipe_hash: 'h-1',
    started_at: ts - 50,
    finished_at: ts,
    duration_ms: 50,
    commit_status: 'succeeded',
    config_snapshot: {},
    errors: [],
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: null,
    recipe_insight_id: insightId,
  };
  await auditLog.append(entry);
  const link: EmittedLink = {
    step_id: 'step',
    collection,
    entity_id,
    kind: 'execution.derived',
    access: 'read',
    ts,
  };
  insertLinks(db, { memory_id: run_id, recipe_insight_id: insightId }, [link]);
};

// ────────────────────────────────────────────────────────────────
// Wire-format checks
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — TIMELINE_SOURCES + entity_id parsing', () => {
  it("'enrichment' is registered as a closed-list source", () => {
    expect(TIMELINE_SOURCES).toContain('enrichment');
  });

  it('parseTimelineEntityId accepts a 4-segment platform-reference scope', () => {
    const parsed = parseTimelineEntityId(
      'connection.api.hubspot.deal:hubspot_deal_47291',
    );
    expect(parsed).toEqual({
      collection: 'connection.api.hubspot.deal',
      id: 'hubspot_deal_47291',
    });
  });

  it('parseTimelineEntityId accepts the canonical closed-list shape unchanged', () => {
    expect(parseTimelineEntityId('mail:msg-abc')).toEqual({
      collection: 'mail',
      id: 'msg-abc',
    });
  });

  it('parseTimelineEntityId still preserves colon-bearing target_ids on the right side', () => {
    expect(
      parseTimelineEntityId(
        'connection.api.hubspot.deal:hubspot:deal:47291',
      ),
    ).toEqual({
      collection: 'connection.api.hubspot.deal',
      id: 'hubspot:deal:47291',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Loader — closed-list scope
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — enrichment loader (closed-list scope)', () => {
  it('surfaces a contact_timeline_rollup row for the target', async () => {
    const ts = 1_700_000_000_000;
    seedContactRollup('alice@acme.com', ts);
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:alice@acme.com',
    });
    const enrichmentEntries = result.entries.filter(
      (e) => e.source === 'enrichment',
    );
    expect(enrichmentEntries).toHaveLength(1);
    expect(enrichmentEntries[0]!.kind).toBe('contact_timeline_rollup');
    const payload = enrichmentEntries[0]!.payload as Record<string, unknown>;
    expect(payload.scope).toBe('contact');
    expect(payload.target_id).toBe('alice@acme.com');
    expect(payload.staleness_class).toBe('fresh');
  });

  it('rolls authored_by into recipe_slug for client display', async () => {
    seedContactRollup('alice@acme.com', 1_700_000_000_000);
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:alice@acme.com',
    });
    const entry = result.entries.find((e) => e.source === 'enrichment');
    expect(entry?.recipe_slug).toBe(
      'system.housekeeping.contact_timeline_rollup',
    );
  });

  it('returns no enrichment entries when no rows exist for the target', async () => {
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:bob@nowhere.example',
    });
    expect(result.entries.filter((e) => e.source === 'enrichment')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Loader — platform-reference scope
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — enrichment loader (platform-reference scope)', () => {
  it('surfaces a deal_health_score row for the platform-reference target', async () => {
    const ts = 1_700_000_000_000;
    seedDealHealthScore('hubspot_deal_47291', ts);
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
    });
    const entry = result.entries.find((e) => e.source === 'enrichment');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('deal_health_score');
    const payload = entry!.payload as Record<string, unknown>;
    expect(payload.scope).toBe('connection.api.hubspot.deal');
    expect(payload.target_id).toBe('hubspot_deal_47291');
  });

  it('payload carries the meta snapshot when present', async () => {
    const ts = 1_700_000_000_000;
    seedDealHealthScore('hubspot_deal_47291', ts);
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
    });
    const payload = result.entries.find((e) => e.source === 'enrichment')!
      .payload as Record<string, unknown>;
    expect(payload.meta).toMatchObject({
      name: 'Deal hubspot_deal_47291',
      status: 'negotiation',
      amount: 50_000,
    });
  });

  it('payload carries ingredient_slug + model_id for AI-surface producers', async () => {
    seedDealHealthScore('hubspot_deal_47291', 1_700_000_000_000);
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
    });
    const payload = result.entries.find((e) => e.source === 'enrichment')!
      .payload as Record<string, unknown>;
    expect(payload.ingredient_slug).toBe('ai-score');
    expect(payload.model_id).toBe('gpt-4o-mini');
  });

  it('stale rows still surface in the feed (renderer handles the badge)', async () => {
    seedDealHealthScore('hubspot_deal_47291', 1_700_000_000_000, {
      stale: true,
    });
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
    });
    const entry = result.entries.find((e) => e.source === 'enrichment');
    expect(entry).toBeDefined();
    expect((entry!.payload as Record<string, unknown>).staleness_class).toBe('stale');
  });

  it('different target_ids on the same scope stay isolated', async () => {
    seedDealHealthScore('hubspot_deal_111', 1_700_000_000_000);
    seedDealHealthScore('hubspot_deal_222', 1_700_000_001_000);
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_111',
    });
    const entries = result.entries.filter((e) => e.source === 'enrichment');
    expect(entries).toHaveLength(1);
    expect((entries[0]!.payload as Record<string, unknown>).target_id).toBe(
      'hubspot_deal_111',
    );
  });

  it('returns no rows when collection is not a registered EnrichmentScope', async () => {
    seedDealHealthScore('hubspot_deal_47291', 1_700_000_000_000);
    const result = await handleTimelineRequest(baseDeps(), {
      // 'invented' is not in ALL_ENRICHMENT_SCOPES
      entity_id: 'invented:hubspot_deal_47291',
    });
    expect(result.entries.filter((e) => e.source === 'enrichment')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-source merge
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — cross-source merge with enrichment rows', () => {
  it('interleaves enrichment + annotation + memory entries DESC by ts', async () => {
    const baseTs = 1_700_000_000_000;
    // ts ordering (oldest → newest): annotation, link, enrichment
    await seedAnnotation('contact', 'alice@acme.com', 'note', 'first');
    await seedAuditAndLink('run-1', 'contact', 'alice@acme.com', baseTs + 1000);
    seedContactRollup('alice@acme.com', baseTs + 2000);

    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:alice@acme.com',
    });
    const sources = result.entries.map((e) => e.source);
    // Annotation + enrichment surface; memory rides through the
    // links → audit_entries join. The ts ordering is what we pin.
    expect(sources).toContain('enrichment');
    expect(sources).toContain('annotation');

    // Strictly descending by effective ts:
    for (let i = 1; i < result.entries.length; i += 1) {
      expect(result.entries[i - 1]!.ts).toBeGreaterThanOrEqual(
        result.entries[i]!.ts,
      );
    }
  });

  it('limit applies across the merged set, not per source', async () => {
    seedContactRollup('alice@acme.com', 1_700_000_000_000);
    seedContactRollup('alice@acme.com', 1_700_000_001_000); // upsert overwrites first
    await seedAnnotation('contact', 'alice@acme.com', 'a1', 'v1');
    await seedAnnotation('contact', 'alice@acme.com', 'a2', 'v2');

    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:alice@acme.com',
      limit: 2,
    });
    expect(result.entries.length).toBeLessThanOrEqual(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Axis + window filters
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — axis + window filters', () => {
  it("axis: 'event' uses event_at for the effective ts when present", async () => {
    const writeTs = 1_700_000_500_000;
    const eventTs = 1_690_000_000_000; // historical
    seedDealHealthScore('hubspot_deal_47291', writeTs, { event_at: eventTs });

    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
      axis: 'event',
    });
    const entry = result.entries.find((e) => e.source === 'enrichment');
    expect(entry?.ts).toBe(eventTs);
  });

  it("axis: 'ingestion' falls back to ingested_at even when event_at is set", async () => {
    const writeTs = 1_700_000_500_000;
    const eventTs = 1_690_000_000_000;
    seedDealHealthScore('hubspot_deal_47291', writeTs, { event_at: eventTs });

    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
      axis: 'ingestion',
    });
    const entry = result.entries.find((e) => e.source === 'enrichment');
    expect(entry?.ts).toBe(writeTs);
  });

  it('since filters out rows older than the bound', async () => {
    // Two writes: old + new. The event_at on each row drives the
    // event-axis filter so we don't fight the upsert primary key (one
    // row per (topic, scope, target_id, authored_by)) — instead we
    // pin the effective ts via event_at.
    seedDealHealthScore('hubspot_deal_47291', 1_700_000_000_000, {
      event_at: 1_700_000_000_000,
    });
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
      since: 1_710_000_000_000, // strictly after the write
      axis: 'event',
    });
    expect(result.entries.filter((e) => e.source === 'enrichment')).toEqual([]);
  });

  it('until filters out rows newer than the bound', async () => {
    seedDealHealthScore('hubspot_deal_47291', 1_700_000_000_000, {
      event_at: 1_700_000_000_000,
    });
    const result = await handleTimelineRequest(baseDeps(), {
      entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
      until: 1_690_000_000_000, // strictly before the write
      axis: 'event',
    });
    expect(result.entries.filter((e) => e.source === 'enrichment')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Pagination
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — pagination', () => {
  it('cursor advances through enrichment-only entries without gaps', async () => {
    // Same target, multiple authors → multiple rows on one
    // (scope, target_id) pair, each with a distinct effective ts.
    const target = 'hubspot_deal_47291';
    const baseTs = 1_700_000_000_000;
    for (let i = 0; i < 5; i += 1) {
      timeCursor = baseTs + i * 1000;
      enrichmentStore.upsert({
        topic: 'deal_health_score',
        scope: 'connection.api.hubspot.deal',
        target_id: target,
        value: {
          score: 50 + i,
          signals: [],
          reasoning: '',
          confidence: 0.5,
        },
        authored_by: `pretend-author-${i}`,
        event_at: baseTs + i * 1000,
      });
    }

    const seen: TimelineEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await handleTimelineRequest(baseDeps(), {
        entity_id: 'connection.api.hubspot.deal:hubspot_deal_47291',
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
        axis: 'event',
      });
      seen.push(...result.entries);
      cursor = result.next_cursor;
      if (cursor === undefined) break;
    }
    const enrichmentSeen = seen.filter((e) => e.source === 'enrichment');
    expect(enrichmentSeen).toHaveLength(5);
    // Strictly descending by effective ts.
    for (let i = 1; i < enrichmentSeen.length; i += 1) {
      expect(enrichmentSeen[i - 1]!.ts).toBeGreaterThan(
        enrichmentSeen[i]!.ts,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Graceful degradation
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — graceful degradation', () => {
  it('absent enrichmentStore → enrichment entries skip; other sources still run', async () => {
    seedContactRollup('alice@acme.com', 1_700_000_000_000);
    await seedAnnotation('contact', 'alice@acme.com', 'note', 'still here');

    const deps: TimelineDeps = {
      db,
      auditLog,
      annotationStore,
      // enrichmentStore deliberately omitted
    };
    const result = await handleTimelineRequest(deps, {
      entity_id: 'contact:alice@acme.com',
    });
    expect(result.entries.filter((e) => e.source === 'enrichment')).toEqual([]);
    expect(result.entries.find((e) => e.source === 'annotation')).toBeDefined();
  });
});
