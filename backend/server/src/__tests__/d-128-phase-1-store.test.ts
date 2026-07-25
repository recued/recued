/** D-128 Phase 1 — Platform-reference enrichment substrate (storage surface).
 *
 *  Schema migration: `data_enrichment` gains nullable `meta` +
 *  `mirror_blob_hash` columns. Pre-D-128 rows (no meta) keep working.
 *  Round-trip: producers writing `meta` get it back through the store
 *  + resolver. Size-cap rejection: `MetaSnapshotTooLargeError` fires
 *  on serialised meta > 8 KB. Mirror-blob slot stays NULL until a
 *  future post-launch D activates the local-mirror path. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MetaSnapshotTooLargeError,
  PLATFORM_REFERENCE_META_MAX_BYTES,
  type EnrichmentMeta,
} from '@recued/contracts';

import {
  createEnrichmentStore,
  ensureEnrichmentSchema,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createEnrichmentResolver } from '../storage/enrichment-resolver.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-128-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const validRollup = {
  interaction_count: 4,
  last_interaction: 1_700_000_000_000,
  recent_subjects: ['hello'],
  cursor_at: 1_700_000_000_000,
  window_ms: 30 * 24 * 60 * 60 * 1000,
};

const sampleMeta = (): EnrichmentMeta => ({
  snapshot_at: 1730294400000,
  snapshot_hash: 'fnv1a:8a3f0123',
  name: 'Acme Q3 Expansion',
  status: 'negotiation',
  amount: 50000,
  owner: 'alice@acme.com',
  key_dates: { close_date: 1735689600000 },
});

// ────────────────────────────────────────────────────────────────
// Schema migration
// ────────────────────────────────────────────────────────────────

describe('D-128 P1 — schema additive migration', () => {
  it('fresh CREATE TABLE includes the meta + mirror_blob_hash columns', () => {
    const cols = db
      .prepare('PRAGMA table_info(data_enrichment)')
      .all() as { name: string; type: string }[];
    const colMap = new Map(cols.map((c) => [c.name, c.type]));
    expect(colMap.get('meta')).toBe('TEXT');
    expect(colMap.get('mirror_blob_hash')).toBe('TEXT');
  });

  it('ensureEnrichmentSchema is idempotent + safely re-runs ALTER on a pre-D-128 schema', () => {
    // Simulate a pre-D-128 DB by dropping the columns and verifying
    // the second ensure call adds them back without throwing.
    db.exec('DROP TABLE data_enrichment');
    db.exec(`
      CREATE TABLE data_enrichment (
        _id                TEXT PRIMARY KEY,
        topic              TEXT NOT NULL,
        scope              TEXT,
        target_id          TEXT,
        value              TEXT NOT NULL,
        authored_by        TEXT NOT NULL,
        source_record_hash TEXT,
        recipe_hash        TEXT,
        model_used         TEXT,
        event_at           INTEGER,
        ingested_at        INTEGER NOT NULL,
        authored_at        INTEGER NOT NULL,
        stale              INTEGER NOT NULL DEFAULT 0
      );
    `);
    expect(() => ensureEnrichmentSchema(db)).not.toThrow();
    const cols = db
      .prepare('PRAGMA table_info(data_enrichment)')
      .all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('meta')).toBe(true);
    expect(colNames.has('mirror_blob_hash')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Round-trip — meta persists through upsert + read paths
// ────────────────────────────────────────────────────────────────

describe('D-128 P1 — meta round-trip on upsert', () => {
  it('writes + reads back meta on a per-record (Shape A) row', () => {
    const meta = sampleMeta();
    const out = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.refresh-contact-timeline-rollup',
      meta,
    });
    expect(out.meta).toEqual(meta);
    const re = store.getByRecord(
      'contact_timeline_rollup',
      'contact',
      'bob@x.com',
      'recipe.refresh-contact-timeline-rollup',
    );
    expect(re?.meta).toEqual(meta);
  });

  it('omitting meta on upsert leaves the column NULL', () => {
    const out = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
    });
    expect(out.meta).toBeNull();
    const row = db
      .prepare('SELECT meta FROM data_enrichment WHERE _id = ?')
      .get(out._id) as { meta: string | null };
    expect(row.meta).toBeNull();
  });

  it('PRESERVES existing meta when the next upsert omits it (reconciler snapshot survives a producer re-upsert)', () => {
    // The D-128 reconciler snapshots the source record onto a target's
    // enrichment rows (`refreshMetaForTarget`) so subscribers reading meta
    // on `updated` events see the values. A producer re-derives `value` and
    // upserts WITHOUT meta — it must NOT clobber that snapshot to NULL
    // (the meta-sourced alert race: `surface-stalling-deals-crm` read
    // `meta.amount`, got 0, and silently skipped). `meta = COALESCE(?, meta)`.
    const inserted = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
      meta: sampleMeta(),
    });
    expect(inserted.meta).not.toBeNull();
    const updated = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: { ...validRollup, interaction_count: 5 },
      authored_by: 'recipe.r',
    });
    expect(updated._id).toBe(inserted._id);
    expect(updated.meta).toEqual(sampleMeta());
    // The value still updated (the re-derive landed; only meta is preserved).
    expect((updated.value as { interaction_count: number }).interaction_count).toBe(5);
  });

  it('a PROVIDED meta on a later upsert still overwrites the prior snapshot', () => {
    // Preserve is for OMITTED meta only — a writer that supplies meta
    // (the reconciler's first-write path) replaces it. COALESCE's `?` is
    // non-null when meta is provided.
    store.upsert({
      topic: 'contact_timeline_rollup', scope: 'contact', target_id: 'bob@x.com',
      value: validRollup, authored_by: 'recipe.r', meta: sampleMeta(),
    });
    const fresh: EnrichmentMeta = { snapshot_at: 2, snapshot_hash: 'fnv1a:def', name: 'Updated' };
    const updated = store.upsert({
      topic: 'contact_timeline_rollup', scope: 'contact', target_id: 'bob@x.com',
      value: validRollup, authored_by: 'recipe.r', meta: fresh,
    });
    expect(updated.meta).toEqual(fresh);
  });

  it('upsert rejects a too-large meta with MetaSnapshotTooLargeError', () => {
    const big: EnrichmentMeta = {
      snapshot_at: 1,
      snapshot_hash: 'fnv1a:abc',
      bloat: 'x'.repeat(PLATFORM_REFERENCE_META_MAX_BYTES + 100),
    };
    expect(() =>
      store.upsert({
        topic: 'contact_timeline_rollup',
        scope: 'contact',
        target_id: 'bob@x.com',
        value: validRollup,
        authored_by: 'recipe.r',
        meta: big,
      }),
    ).toThrow(MetaSnapshotTooLargeError);
    // No row was committed.
    expect(
      store.getByRecord('contact_timeline_rollup', 'contact', 'bob@x.com', 'recipe.r'),
    ).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// mirror_blob_hash forward-compat slot
// ────────────────────────────────────────────────────────────────

describe('D-128 P1 — mirror_blob_hash always-NULL invariant', () => {
  it('mirror_blob_hash is NULL on every row produced by the upsert path at D-128', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
      meta: sampleMeta(),
    });
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'alice@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
    });
    const rows = db
      .prepare('SELECT mirror_blob_hash FROM data_enrichment')
      .all() as { mirror_blob_hash: string | null }[];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.mirror_blob_hash).toBeNull();
    }
  });

  it('exposes mirror_blob_hash as null on the EnrichmentRecord shape', () => {
    const out = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
    });
    expect(out.mirror_blob_hash).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Resolver — meta drill is a sibling of value
// ────────────────────────────────────────────────────────────────

describe('D-128 P1 — resolver meta.<field> drill', () => {
  it('resolves <topic>.meta.<field> from the row meta column', () => {
    const meta = sampleMeta();
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
      meta,
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve([
      'contact',
      'bob@x.com',
      'contact_timeline_rollup',
      'meta',
      'name',
    ]);
    expect(out).toEqual({ kind: 'value', value: 'Acme Q3 Expansion' });

    const status = resolver.resolve([
      'contact',
      'bob@x.com',
      'contact_timeline_rollup',
      'meta',
      'status',
    ]);
    expect(status).toEqual({ kind: 'value', value: 'negotiation' });

    const closeDate = resolver.resolve([
      'contact',
      'bob@x.com',
      'contact_timeline_rollup',
      'meta',
      'key_dates',
      'close_date',
    ]);
    expect(closeDate).toEqual({ kind: 'value', value: 1735689600000 });
  });

  it('still resolves <topic>.<value-field> through the value JSON', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
      meta: sampleMeta(),
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve([
      'contact',
      'bob@x.com',
      'contact_timeline_rollup',
      'interaction_count',
    ]);
    expect(out).toEqual({ kind: 'value', value: 4 });
  });

  it('returns undefined when meta is NULL on the row', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve([
      'contact',
      'bob@x.com',
      'contact_timeline_rollup',
      'meta',
      'name',
    ]);
    expect(out).toEqual({ kind: 'value', value: undefined });
  });

  it('returns undefined for a missing meta sub-field', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
      meta: sampleMeta(),
    });
    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve([
      'contact',
      'bob@x.com',
      'contact_timeline_rollup',
      'meta',
      'no_such_field',
    ]);
    expect(out).toEqual({ kind: 'value', value: undefined });
  });
});
