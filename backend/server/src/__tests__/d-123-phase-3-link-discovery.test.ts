/** D-123 Phase 3 — `link-discovery` task tests.
 *
 *  Verifies frequent-touch annotation emission against the actual
 *  schema (`links` provenance table writing colon-delimited
 *  `<collection>:<entity_id>` + `annotation` typed-relationship
 *  table). Covers threshold gating, idempotent upsert, the
 *  rolling 30-day window boundary, and the no-op fast path on
 *  fresh installs without the supporting tables. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LINK_KINDS } from '@recued/contracts';

import {
  linkDiscoveryTask,
  linkDiscoveryAnnotationId,
  LINK_DISCOVERY_ANNOTATION_KEY,
  LINK_DISCOVERY_AUTHORED_BY,
  LINK_DISCOVERY_THRESHOLD,
  LINK_DISCOVERY_WINDOW_MS,
} from '../housekeeping/tasks/link-discovery.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

let dir: string;
let db: Database.Database;
let now = 1_700_000_000_000;

const ensureLinksTable = () => {
  const kindList = LINK_KINDS.map((k) => `'${k}'`).join(', ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      memory_id          TEXT    NOT NULL,
      entity_id          TEXT    NOT NULL,
      recipe_insight_id  INTEGER NOT NULL,
      kind               TEXT    NOT NULL CHECK (kind IN (${kindList})),
      ts                 INTEGER NOT NULL,
      event_at           INTEGER,
      PRIMARY KEY (memory_id, entity_id, kind, ts)
    );
  `);
};

const ensureAnnotationTable = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS annotation (
      id                    TEXT PRIMARY KEY,
      target_collection     TEXT NOT NULL,
      target_id             TEXT NOT NULL,
      key                   TEXT NOT NULL,
      value_inline          TEXT,
      blob_hash             TEXT,
      size_bytes            INTEGER NOT NULL,
      authored_by_recipe_id TEXT NOT NULL,
      source_record_hash    TEXT NOT NULL,
      recipe_hash           TEXT NOT NULL,
      model_used            TEXT,
      authored_at           INTEGER NOT NULL,
      event_at              INTEGER
    );
  `);
};

const insertProvenanceLink = (
  memory_id: string,
  entity_id: string,
  kind: string,
  ts: number,
): void => {
  db.prepare(`
    INSERT OR IGNORE INTO links (memory_id, entity_id, recipe_insight_id, kind, ts, event_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(memory_id, entity_id, 1, kind, ts);
};

const seedNLinks = (
  entity_id: string,
  kind: string,
  count: number,
  start_ts: number = now - 24 * 60 * 60_000,
  spacing_ms = 60_000,
): void => {
  for (let i = 0; i < count; i++) {
    insertProvenanceLink(`mem-${entity_id}-${kind}-${i}`, entity_id, kind, start_ts + i * spacing_ms);
  }
};

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const listAnnotations = (): Array<{
  id: string;
  target_collection: string;
  target_id: string;
  key: string;
  value: unknown;
  authored_by_recipe_id: string;
}> =>
  (db
    .prepare(`SELECT id, target_collection, target_id, key, value_inline, authored_by_recipe_id FROM annotation`)
    .all() as Array<{
      id: string;
      target_collection: string;
      target_id: string;
      key: string;
      value_inline: string;
      authored_by_recipe_id: string;
    }>).map((r) => ({
      id: r.id,
      target_collection: r.target_collection,
      target_id: r.target_id,
      key: r.key,
      value: JSON.parse(r.value_inline),
      authored_by_recipe_id: r.authored_by_recipe_id,
    }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-link-discovery-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  now = 1_700_000_000_000;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('linkDiscoveryTask metadata', () => {
  it('declares core kind, interruptible, no deps, no invalidate hook', () => {
    expect(linkDiscoveryTask.meta.id).toBe('link-discovery');
    expect(linkDiscoveryTask.meta.kind).toBe('core');
    expect(linkDiscoveryTask.meta.interruptible).toBe(true);
    expect(linkDiscoveryTask.meta.depends_on).toBeUndefined();
    expect(linkDiscoveryTask.onInvalidate).toBeUndefined();
  });
});

describe('linkDiscoveryTask.step — schema fast paths', () => {
  it('returns complete when neither table exists (fresh install)', async () => {
    const result = await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('returns complete when links table is missing', async () => {
    ensureAnnotationTable();
    const result = await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
  });

  it('returns complete when annotation table is missing', async () => {
    ensureLinksTable();
    seedNLinks('mail:m1', 'execution.action', LINK_DISCOVERY_THRESHOLD);
    const result = await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
  });
});

describe('linkDiscoveryTask.step — threshold + emission', () => {
  beforeEach(() => {
    ensureLinksTable();
    ensureAnnotationTable();
  });

  it('emits one annotation when an entity hits the threshold', async () => {
    seedNLinks('mail:m1', 'execution.action', LINK_DISCOVERY_THRESHOLD);
    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const annotations = listAnnotations();
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      id: linkDiscoveryAnnotationId('mail:m1', 'execution.action'),
      target_collection: 'mail',
      target_id: 'm1',
      key: LINK_DISCOVERY_ANNOTATION_KEY,
      authored_by_recipe_id: LINK_DISCOVERY_AUTHORED_BY,
    });
    expect(annotations[0].value).toMatchObject({
      pattern: 'frequent_touch',
      kind: 'execution.action',
      count: LINK_DISCOVERY_THRESHOLD,
      window_days: 30,
    });
  });

  it('does not emit below the threshold', async () => {
    seedNLinks('mail:m1', 'execution.action', LINK_DISCOVERY_THRESHOLD - 1);
    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listAnnotations()).toHaveLength(0);
  });

  it('emits one annotation per (entity, kind) pair', async () => {
    seedNLinks('mail:m1', 'execution.action', LINK_DISCOVERY_THRESHOLD);
    seedNLinks('mail:m1', 'execution.write', LINK_DISCOVERY_THRESHOLD);
    seedNLinks('contact:c1', 'execution.action', LINK_DISCOVERY_THRESHOLD);
    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const annotations = listAnnotations();
    expect(annotations).toHaveLength(3);
    const ids = annotations.map((a) => a.id).sort();
    expect(ids).toEqual([
      linkDiscoveryAnnotationId('contact:c1', 'execution.action'),
      linkDiscoveryAnnotationId('mail:m1', 'execution.action'),
      linkDiscoveryAnnotationId('mail:m1', 'execution.write'),
    ]);
  });

  it('upserts an existing annotation when count changes (idempotent re-run)', async () => {
    seedNLinks('mail:m1', 'execution.action', LINK_DISCOVERY_THRESHOLD);
    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listAnnotations()[0].value).toMatchObject({ count: LINK_DISCOVERY_THRESHOLD });

    // Add 2 more links of the same kind on the same entity → re-aggregate yields count + 2.
    seedNLinks('mail:m1', 'execution.action', 2, now - 30_000, 5_000);

    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const annotations = listAnnotations();
    expect(annotations).toHaveLength(1); // still one row — upserted, not duplicated.
    expect(annotations[0].value).toMatchObject({
      count: LINK_DISCOVERY_THRESHOLD + 2,
    });
  });
});

describe('linkDiscoveryTask.step — rolling window boundary', () => {
  beforeEach(() => {
    ensureLinksTable();
    ensureAnnotationTable();
  });

  it('does not count rows older than the 30-day window', async () => {
    // Threshold-1 inside the window plus more outside → still under threshold.
    const inside_ts = now - 24 * 60 * 60_000;
    const outside_ts = now - LINK_DISCOVERY_WINDOW_MS - 24 * 60 * 60_000;
    for (let i = 0; i < LINK_DISCOVERY_THRESHOLD - 1; i++) {
      insertProvenanceLink(`mem-in-${i}`, 'mail:m1', 'execution.action', inside_ts + i * 1_000);
    }
    for (let i = 0; i < 10; i++) {
      insertProvenanceLink(`mem-out-${i}`, 'mail:m1', 'execution.action', outside_ts + i * 1_000);
    }

    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listAnnotations()).toHaveLength(0);
  });

  it('counts links exactly at the window boundary as inside', async () => {
    // ts >= window_start is inclusive — boundary row counts.
    const boundary_ts = now - LINK_DISCOVERY_WINDOW_MS;
    insertProvenanceLink('mem-edge', 'mail:m1', 'execution.action', boundary_ts);
    for (let i = 0; i < LINK_DISCOVERY_THRESHOLD - 1; i++) {
      insertProvenanceLink(`mem-in-${i}`, 'mail:m1', 'execution.action', now - 60_000 - i * 1_000);
    }

    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listAnnotations()).toHaveLength(1);
    expect(listAnnotations()[0].value).toMatchObject({ count: LINK_DISCOVERY_THRESHOLD });
  });
});

describe('linkDiscoveryTask.step — entity_id parsing', () => {
  beforeEach(() => {
    ensureLinksTable();
    ensureAnnotationTable();
  });

  it('skips entity_ids without a colon delimiter', async () => {
    seedNLinks('no-colon-here', 'execution.action', LINK_DISCOVERY_THRESHOLD);
    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(listAnnotations()).toHaveLength(0);
  });

  it('handles ids that themselves contain colons (split on first only)', async () => {
    // entity_id `mail:thread:abc` → collection=mail, id=thread:abc
    seedNLinks('mail:thread:abc', 'execution.action', LINK_DISCOVERY_THRESHOLD);
    await linkDiscoveryTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const annotations = listAnnotations();
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      target_collection: 'mail',
      target_id: 'thread:abc',
    });
  });
});
