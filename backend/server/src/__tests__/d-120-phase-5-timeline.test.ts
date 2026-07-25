/** D-120 Phase 5 — `data.timeline()` MCP primitive — server-side
 *  merge tests.
 *
 *  Covers:
 *    - bad request: malformed entity_id → RpcError(bad_request)
 *    - empty store: empty entries, no cursor
 *    - per-source isolation: memory/annotation/link/raw record alone
 *    - cross-source merge: ts DESC ordering, stable tie-break
 *    - since/until window applied to every source
 *    - limit clamping (default 100, max 1000) + per-call clamp
 *    - cursor round-trip — second page resumes correctly
 *    - cursor stability — paging through hundreds of entries returns
 *      every row exactly once
 *    - graceful degradation when stores are absent (no DB / no
 *      annotation store / no loader)
 *    - cross-collection ID collision — `deal:42` vs `contact:42`
 *      stay distinct because the persisted entity_id is qualified
 *    - audit-pruned memory entries still surface (link is the proof)
 *    - large-entity pagination — 250 memory entries paginate without
 *      gaps when limit=50
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decodeTimelineCursor,
  RpcError,
  TIMELINE_DEFAULT_LIMIT,
  type EmittedLink,
  type TimelineEntry,
} from '@recued/contracts';

import {
  createAuditLogStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

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
import {
  handleTimelineRequest,
  type LoadCollectionRecord,
  type TimelineDeps,
} from '../mcp/timeline.js';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let auditLog: AuditLogStore;
let annotationStore: AnnotationStore;
let insightId: number;

const setupHarness = (): void => {
  dir = mkdtempSync(join(tmpdir(), 'd120-p5-timeline-'));
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
  let counter = 0;
  let clock = 1_000_000;
  annotationStore = createAnnotationStore({
    db,
    blobs,
    now: () => clock++,
    newId: () => `ann-${++counter}`,
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

const seedAudit = async (
  run_id: string,
  ts: number,
  recipe_id = 'phase-5-recipe',
  overrides: Partial<AuditEntry> = {},
): Promise<void> => {
  const entry: AuditEntry = {
    run_id,
    recipe_id,
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
    ...overrides,
  };
  await auditLog.append(entry);
};

const seedLink = (
  run_id: string,
  collection: string,
  entity_id: string,
  kind: EmittedLink['kind'],
  ts: number,
): void => {
  const link: EmittedLink = {
    step_id: 'step',
    collection,
    entity_id,
    kind,
    access: 'read',
    ts,
  };
  insertLinks(db, { memory_id: run_id, recipe_insight_id: insightId }, [link]);
};

const seedAnnotation = async (
  collection: string,
  id: string,
  key: string,
  value: unknown,
  recipe_id = 'phase-5-recipe',
): Promise<string> => {
  const ann = await annotationStore.annotate({
    target_collection: collection,
    target_id: id,
    key,
    value,
    authored_by_recipe_id: recipe_id,
    source_record_hash: 'src-hash',
    recipe_hash: 'rec-hash',
  });
  return ann._id;
};

const seedLinkD119 = async (
  fromCol: string,
  fromId: string,
  toCol: string,
  toId: string,
  role: string,
  recipe_id = 'phase-5-recipe',
): Promise<string> => {
  const link = await annotationStore.link({
    from_collection: fromCol,
    from_id: fromId,
    to_collection: toCol,
    to_id: toId,
    role,
    authored_by_recipe_id: recipe_id,
  });
  return link._id;
};

const baseDeps = (): TimelineDeps => ({
  db,
  auditLog,
  annotationStore,
});

// ────────────────────────────────────────────────────────────────
// Request validation
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — request validation', () => {
  it('throws RpcError(bad_request) for missing colon in entity_id', async () => {
    await expect(
      handleTimelineRequest(baseDeps(), { entity_id: 'msg-abc-123' }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('throws RpcError(bad_request) for empty collection or empty id', async () => {
    await expect(
      handleTimelineRequest(baseDeps(), { entity_id: ':msg-1' }),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      handleTimelineRequest(baseDeps(), { entity_id: 'mail:' }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('returns empty response for an entity with no events', async () => {
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-empty',
    });
    expect(response.entries).toEqual([]);
    expect(response.next_cursor).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Per-source isolation
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — per-source merge', () => {
  it('returns memory entries from D-120 links + audit join', async () => {
    await seedAudit('run-1', 1000);
    seedLink('run-1', 'mail', 'msg-1', 'execution.action', 1000);

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
    });
    expect(response.entries).toHaveLength(1);
    const entry = response.entries[0];
    expect(entry.source).toBe('memory');
    expect(entry.kind).toBe('execution.action');
    expect(entry.ts).toBe(1000);
    expect(entry.recipe_insight_id).toBe(insightId);
    expect(entry.recipe_slug).toBe('phase-5-recipe');
    expect(entry.payload).toMatchObject({
      run_id: 'run-1',
      recipe_id: 'phase-5-recipe',
      commit_status: 'succeeded',
    });
  });

  it('returns annotation entries from the annotation store', async () => {
    const annId = await seedAnnotation('mail', 'msg-1', 'summary', 'Hello');
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
    });
    expect(response.entries).toHaveLength(1);
    const entry = response.entries[0];
    expect(entry.source).toBe('annotation');
    expect(entry.kind).toBe('summary');
    expect(entry.recipe_slug).toBe('phase-5-recipe');
    expect((entry.payload as { annotation_id: string }).annotation_id).toBe(annId);
    expect((entry.payload as { value: unknown }).value).toBe('Hello');
  });

  it('returns inbound + outbound D-119 typed links separately', async () => {
    const inboundId = await seedLinkD119('mail', 'msg-x', 'mail', 'msg-1', 'reply-to');
    const outboundId = await seedLinkD119('mail', 'msg-1', 'calendar', 'evt-1', 'scheduled-from');

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
    });
    expect(response.entries).toHaveLength(2);
    const kinds = response.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(['inbound:reply-to', 'outbound:scheduled-from']);

    const inbound = response.entries.find((e) => e.kind === 'inbound:reply-to')!;
    expect((inbound.payload as { link_id: string }).link_id).toBe(inboundId);
    expect((inbound.payload as { direction: string }).direction).toBe('inbound');
    expect((inbound.payload as { other_collection: string }).other_collection).toBe('mail');

    const outbound = response.entries.find((e) => e.kind === 'outbound:scheduled-from')!;
    expect((outbound.payload as { link_id: string }).link_id).toBe(outboundId);
    expect((outbound.payload as { other_id: string }).other_id).toBe('evt-1');
  });

  it('includes raw record entry when loadCollectionRecord is wired', async () => {
    const loader: LoadCollectionRecord = async (collection, id) => ({
      ts: 5000,
      source: collection as TimelineEntry['source'],
      kind: 'updated',
      payload: { record_id: id, hot_fields: { from: 'a@b.com' }, size_bytes: 1024 },
    });
    const response = await handleTimelineRequest(
      { ...baseDeps(), loadCollectionRecord: loader },
      { entity_id: 'mail:msg-1' },
    );
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].source).toBe('mail');
    expect(response.entries[0].kind).toBe('updated');
    expect(response.entries[0].ts).toBe(5000);
  });

  it('skips raw record source when loader returns null', async () => {
    const loader: LoadCollectionRecord = async () => null;
    await seedAudit('run-1', 1000);
    seedLink('run-1', 'mail', 'msg-1', 'execution.action', 1000);
    const response = await handleTimelineRequest(
      { ...baseDeps(), loadCollectionRecord: loader },
      { entity_id: 'mail:msg-1' },
    );
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].source).toBe('memory');
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-source merge ordering
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — global merge ordering', () => {
  it('sorts entries by ts DESC across sources', async () => {
    await seedAudit('run-1', 100);
    seedLink('run-1', 'mail', 'msg-1', 'execution.action', 100);
    await seedAudit('run-2', 300);
    seedLink('run-2', 'mail', 'msg-1', 'execution.write', 300);
    await seedAnnotation('mail', 'msg-1', 'summary', 'A'); // ts via annotation clock
    await seedLinkD119('mail', 'msg-x', 'mail', 'msg-1', 'reply-to');

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
    });
    // Sorted DESC; verify monotonic.
    for (let i = 1; i < response.entries.length; i++) {
      expect(response.entries[i - 1].ts).toBeGreaterThanOrEqual(
        response.entries[i].ts,
      );
    }
  });

  it('breaks ties with mergeKey DESC for same-ts entries', async () => {
    await seedAudit('run-A', 1000);
    await seedAudit('run-B', 1000);
    seedLink('run-A', 'mail', 'msg-1', 'execution.action', 1000);
    seedLink('run-B', 'mail', 'msg-1', 'execution.write', 1000);

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
    });
    expect(response.entries).toHaveLength(2);
    // Both at ts=1000; same source ('memory'); kinds differ:
    // execution.write > execution.action lex-wise → write first in DESC.
    expect(response.entries[0].kind).toBe('execution.write');
    expect(response.entries[1].kind).toBe('execution.action');
  });
});

// ────────────────────────────────────────────────────────────────
// Window filters
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — since/until window', () => {
  it('applies since (inclusive) to every source', async () => {
    await seedAudit('run-old', 100);
    seedLink('run-old', 'mail', 'msg-1', 'execution.action', 100);
    await seedAudit('run-new', 500);
    seedLink('run-new', 'mail', 'msg-1', 'execution.action', 500);

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      since: 200,
    });
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].ts).toBe(500);
  });

  it('applies until (exclusive) to every source', async () => {
    await seedAudit('run-old', 100);
    seedLink('run-old', 'mail', 'msg-1', 'execution.action', 100);
    await seedAudit('run-new', 500);
    seedLink('run-new', 'mail', 'msg-1', 'execution.action', 500);

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      until: 500, // exclusive — drops the ts=500 entry
    });
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].ts).toBe(100);
  });

  it('combines since + until into a half-open range', async () => {
    for (let ts = 100; ts <= 500; ts += 100) {
      const id = `run-${ts}`;
      await seedAudit(id, ts);
      seedLink(id, 'mail', 'msg-1', 'execution.action', ts);
    }
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      since: 200,
      until: 500,
    });
    const tsValues = response.entries.map((e) => e.ts).sort();
    expect(tsValues).toEqual([200, 300, 400]);
  });
});

// ────────────────────────────────────────────────────────────────
// Limit + cursor pagination
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — limit + cursor', () => {
  it('clamps default limit when not specified', async () => {
    // Seed 150 memory entries; default limit = 100.
    for (let i = 1; i <= 150; i++) {
      const id = `run-${i.toString().padStart(3, '0')}`;
      await seedAudit(id, i);
      seedLink(id, 'mail', 'msg-1', 'execution.action', i);
    }
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
    });
    expect(response.entries.length).toBe(TIMELINE_DEFAULT_LIMIT);
    expect(response.next_cursor).toBeDefined();
  });

  it('respects a caller-supplied limit smaller than the default', async () => {
    for (let i = 1; i <= 10; i++) {
      const id = `run-${i.toString().padStart(3, '0')}`;
      await seedAudit(id, i);
      seedLink(id, 'mail', 'msg-1', 'execution.action', i);
    }
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      limit: 3,
    });
    expect(response.entries).toHaveLength(3);
    expect(response.next_cursor).toBeDefined();
  });

  it('omits next_cursor when the merged set fits in the page', async () => {
    for (let i = 1; i <= 5; i++) {
      const id = `run-${i.toString().padStart(2, '0')}`;
      await seedAudit(id, i);
      seedLink(id, 'mail', 'msg-1', 'execution.action', i);
    }
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      limit: 10,
    });
    expect(response.entries).toHaveLength(5);
    expect(response.next_cursor).toBeUndefined();
  });

  it('cursor round-trips — second page resumes correctly', async () => {
    for (let i = 1; i <= 6; i++) {
      const id = `run-${i.toString().padStart(2, '0')}`;
      await seedAudit(id, i);
      seedLink(id, 'mail', 'msg-1', 'execution.action', i);
    }
    const page1 = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      limit: 3,
    });
    expect(page1.entries.map((e) => e.ts)).toEqual([6, 5, 4]);
    expect(page1.next_cursor).toBeDefined();

    const page2 = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      limit: 3,
      cursor: page1.next_cursor,
    });
    expect(page2.entries.map((e) => e.ts)).toEqual([3, 2, 1]);
    expect(page2.next_cursor).toBeUndefined();
  });

  it('handles a malformed cursor by falling back to the head', async () => {
    for (let i = 1; i <= 3; i++) {
      const id = `run-${i.toString().padStart(2, '0')}`;
      await seedAudit(id, i);
      seedLink(id, 'mail', 'msg-1', 'execution.action', i);
    }
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      cursor: '!!!not-base64!!!',
    });
    expect(response.entries).toHaveLength(3);
  });

  it('paginates 250 memory entries through 5 pages without gaps or duplicates', async () => {
    const total = 250;
    for (let i = 1; i <= total; i++) {
      const id = `run-${i.toString().padStart(3, '0')}`;
      await seedAudit(id, i);
      seedLink(id, 'mail', 'msg-paged', 'execution.action', i);
    }

    const seen = new Set<string>();
    const limit = 50;
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const response = await handleTimelineRequest(baseDeps(), {
        entity_id: 'mail:msg-paged',
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      pages++;
      for (const e of response.entries) {
        const payload = e.payload as { run_id: string };
        expect(seen.has(payload.run_id)).toBe(false);
        seen.add(payload.run_id);
      }
      if (response.next_cursor === undefined) break;
      cursor = response.next_cursor;
      if (pages > 10) throw new Error('runaway pagination');
    }
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThanOrEqual(5);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-collection isolation + audit pruning
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — qualified entity_id isolation', () => {
  it('keeps deal:42 and contact:42 distinct via the qualified entity_id', async () => {
    await seedAudit('run-deal', 100);
    await seedAudit('run-contact', 200);
    seedLink('run-deal', 'deal', '42', 'execution.write', 100);
    seedLink('run-contact', 'contact', '42', 'execution.write', 200);

    const dealResponse = await handleTimelineRequest(baseDeps(), {
      entity_id: 'deal:42',
    });
    expect(dealResponse.entries).toHaveLength(1);
    expect((dealResponse.entries[0].payload as { run_id: string }).run_id).toBe(
      'run-deal',
    );

    const contactResponse = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:42',
    });
    expect(contactResponse.entries).toHaveLength(1);
    expect(
      (contactResponse.entries[0].payload as { run_id: string }).run_id,
    ).toBe('run-contact');
  });

  it('still surfaces a memory entry whose audit row was pruned', async () => {
    // Seed link without seeding audit — simulates retention pruning the
    // body but leaving the link as the "proof the touch happened".
    seedLink('run-pruned', 'mail', 'msg-1', 'execution.action', 1000);

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
    });
    expect(response.entries).toHaveLength(1);
    const entry = response.entries[0];
    expect(entry.source).toBe('memory');
    expect((entry.payload as { audit_pruned: boolean }).audit_pruned).toBe(true);
    expect(entry.recipe_slug).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Graceful degradation
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — graceful degradation', () => {
  it('skips memory source when db is absent', async () => {
    seedLink('run-1', 'mail', 'msg-1', 'execution.action', 100);
    await seedAudit('run-1', 100);
    await seedAnnotation('mail', 'msg-1', 'summary', 'A');

    const response = await handleTimelineRequest(
      { auditLog, annotationStore },
      { entity_id: 'mail:msg-1' },
    );
    // No memory entries because db is missing; annotation still surfaces.
    expect(response.entries.every((e) => e.source !== 'memory')).toBe(true);
    expect(response.entries.some((e) => e.source === 'annotation')).toBe(true);
  });

  it('skips memory source when auditLog is absent', async () => {
    seedLink('run-1', 'mail', 'msg-1', 'execution.action', 100);
    await seedAudit('run-1', 100);

    const response = await handleTimelineRequest(
      { db, annotationStore },
      { entity_id: 'mail:msg-1' },
    );
    expect(response.entries.every((e) => e.source !== 'memory')).toBe(true);
  });

  it('skips annotation + link sources when annotationStore is absent', async () => {
    await seedAudit('run-1', 100);
    seedLink('run-1', 'mail', 'msg-1', 'execution.action', 100);
    await seedAnnotation('mail', 'msg-1', 'summary', 'A');

    const response = await handleTimelineRequest(
      { db, auditLog },
      { entity_id: 'mail:msg-1' },
    );
    expect(response.entries.every((e) => e.source !== 'annotation')).toBe(true);
    expect(response.entries.every((e) => e.source !== 'link')).toBe(true);
    // Memory still works because db + auditLog are wired.
    expect(response.entries.some((e) => e.source === 'memory')).toBe(true);
  });

  it('returns empty when no stores are wired at all', async () => {
    const response = await handleTimelineRequest({}, {
      entity_id: 'mail:msg-1',
    });
    expect(response.entries).toEqual([]);
    expect(response.next_cursor).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Cursor decoding sanity
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — cursor encoding hints', () => {
  it('encodes the last entry\'s ts + key into next_cursor', async () => {
    for (let i = 1; i <= 3; i++) {
      const id = `run-${i.toString().padStart(2, '0')}`;
      await seedAudit(id, i);
      seedLink(id, 'mail', 'msg-1', 'execution.action', i);
    }
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
      limit: 2,
    });
    expect(response.next_cursor).toBeDefined();
    const decoded = decodeTimelineCursor(response.next_cursor!);
    expect(decoded).not.toBeNull();
    // Last entry returned was at ts=2 (sorted DESC: [3, 2]).
    expect(decoded!.last_ts).toBe(2);
    expect(decoded!.last_key.startsWith('memory:execution.action:')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// D-120 Phase 7.5 — bistemporal axis ordering
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — bistemporal axis (Phase 7.5)', () => {
  /** Seed a memory link with an explicit `event_at` distinct from `ts`.
   *  Mimics a backfill recipe stamping the source record's date_header. */
  const seedLinkWithEventAt = (
    run_id: string,
    collection: string,
    entity_id: string,
    kind: EmittedLink['kind'],
    ts: number,
    event_at: number,
  ): void => {
    const link: EmittedLink = {
      step_id: 'step',
      collection,
      entity_id,
      kind,
      access: 'read',
      ts,
      event_at,
    };
    insertLinks(db, { memory_id: run_id, recipe_insight_id: insightId }, [link]);
  };

  it('event-axis (default) sorts by COALESCE(event_at, ts) DESC', async () => {
    // Two runs: one ingested today (ts=1000) but for an event LAST YEAR
    // (event_at=100), and one for a recent event (event_at=900) with
    // a slightly earlier ingestion ts=950.
    await seedAudit('run-old-event', 1000);
    await seedAudit('run-recent-event', 950);
    seedLinkWithEventAt('run-old-event', 'mail', 'msg-1', 'execution.action', 1000, 100);
    seedLinkWithEventAt('run-recent-event', 'mail', 'msg-1', 'execution.action', 950, 900);

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-1',
    });
    // Event-axis ordering puts the RECENT-event entry first even though
    // it was ingested earlier. The OLD-event entry surfaces at its
    // historical date (ts=100) regardless of when ingestion happened.
    const memoryEntries = response.entries.filter((e) => e.source === 'memory');
    expect(memoryEntries[0]!.ts).toBe(900);
    expect(memoryEntries[1]!.ts).toBe(100);
  });

  it('ingestion-axis flips the order back to ingestion time (raw ts)', async () => {
    await seedAudit('run-old-event', 1000);
    await seedAudit('run-recent-event', 950);
    seedLinkWithEventAt('run-old-event', 'mail', 'msg-2', 'execution.action', 1000, 100);
    seedLinkWithEventAt('run-recent-event', 'mail', 'msg-2', 'execution.action', 950, 900);

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-2',
      axis: 'ingestion',
    });
    const memoryEntries = response.entries.filter((e) => e.source === 'memory');
    // Ingestion-axis: most-recently-ingested first (1000 > 950) and
    // entry.ts reflects raw ingestion time, not the event_at.
    expect(memoryEntries[0]!.ts).toBe(1000);
    expect(memoryEntries[1]!.ts).toBe(950);
  });

  it('mixed null/non-null event_at ordering (event-axis falls back to ts)', async () => {
    await seedAudit('run-with-event', 500);
    await seedAudit('run-no-event', 1000);
    // First link: event_at=200 (predates ts).
    seedLinkWithEventAt('run-with-event', 'mail', 'msg-3', 'execution.action', 500, 200);
    // Second link: no event_at; SQL COALESCE falls back to ts=1000.
    seedLink('run-no-event', 'mail', 'msg-3', 'execution.action', 1000);

    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-3',
    });
    const memoryEntries = response.entries.filter((e) => e.source === 'memory');
    // Sorted DESC by COALESCE: 1000, 200.
    expect(memoryEntries[0]!.ts).toBe(1000);
    expect(memoryEntries[1]!.ts).toBe(200);
  });

  it('axis defaults to event when omitted', async () => {
    await seedAudit('run-default', 1000);
    seedLinkWithEventAt('run-default', 'mail', 'msg-4', 'execution.action', 1000, 50);
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-4',
    });
    const memoryEntries = response.entries.filter((e) => e.source === 'memory');
    // event_at=50 wins over ts=1000 because event-axis is the default.
    expect(memoryEntries[0]!.ts).toBe(50);
  });

  it('an unrecognised axis value falls back to event (defensive)', async () => {
    await seedAudit('run-bad-axis', 1000);
    seedLinkWithEventAt('run-bad-axis', 'mail', 'msg-5', 'execution.action', 1000, 75);
    const response = await handleTimelineRequest(baseDeps(), {
      entity_id: 'mail:msg-5',
      axis: 'historical' as unknown as 'event',
    });
    const memoryEntries = response.entries.filter((e) => e.source === 'memory');
    expect(memoryEntries[0]!.ts).toBe(75); // event-axis behavior
  });
});
