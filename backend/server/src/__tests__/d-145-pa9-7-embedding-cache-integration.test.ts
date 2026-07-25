/** D-145 PA9.7 — `embedding` producer × LLM result cache integration.
 *
 *  The embedding producer is the canary for the content-addressed
 *  cache: deterministic vector output, highest expected hit rate
 *  (signatures + forwarded chains + template emails repeat across
 *  records). This file locks the hit / miss / self-healing paths in
 *  the producer's own integration; the substrate-level coverage
 *  lives in `d-145-pa9-6-llm-result-cache-store.test.ts`.
 *
 *  Coverage:
 *    1. Cache miss → `ctx.embed` called; entry inserted with vector
 *       sidecar reusable by future calls.
 *    2. Cache hit on a second record with identical body bytes →
 *       `ctx.embed` NOT called; vector + value + model_id reused.
 *    3. ctx without llmResultCache → producer falls back to compute-
 *       every-time (legacy behavior).
 *    4. Dangling cache pointer (row deleted) → lazy delete + LLM
 *       call.
 *    5. Hash drift on the cached row's value → lazy delete + LLM call.
 *    6. Missing sidecar at the cached row (FK row but no vector) →
 *       lazy delete + LLM call.
 *
 *  Spec: docs/d-145-spec.md § A.7.10 + § A.7.10 acceptance criterion
 *  6 (wire embedding producer first; ≥10% hit rate gate). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollectionRecord, IngredientManifest } from '@recued/contracts';

import { embeddingProducer } from '../housekeeping/producers/embedding.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import {
  createLlmResultCacheStore,
  hashLlmInput,
  type LlmResultCacheStore,
} from '../housekeeping/llm-result-cache-store.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type {
  HousekeepingContext,
  HousekeepingEmbedExecute,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { BlobStore } from '../storage/blob-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let llmResultCache: LlmResultCacheStore;

const SHARED_BODY =
  'Hi Bob,\n\nCould you send the revised forecast by Friday so finance can update ' +
  'the board pack? Also, please loop in Carol on the Acme expansion thread.\n\nThanks,\nAlice';

const buildRecord = (record_id: string, body = SHARED_BODY): CollectionRecord => ({
  record_id,
  received_at: NOW,
  modified_at: NOW,
  hot_fields: {
    from: 'alice@example.com',
    to: ['bob@example.com'],
    subject: 'Q3 plan review',
    thread_id: `thread_${record_id}`,
  },
  size_bytes: body.length,
  source_id: `msg-${record_id}`,
  body_inline: body,
});

const buildSourceRecord = (record: CollectionRecord): SourceRecord => ({
  target_id: record.record_id,
  data: record,
  cursor_token: record.record_id,
});

const buildBlobs = (): BlobStore => ({
  put: vi.fn(async () => 'unused'),
  get: vi.fn(async () => null),
  has: vi.fn(async () => false),
  delete: vi.fn(async () => undefined),
  sizeOf: vi.fn(async () => null),
  sweepOrphans: vi.fn(async () => 0),
  totalBytes: vi.fn(async () => 0),
  root: '/tmp/test',
});

const sampleVector = (dim = 16, seed = 1): number[] =>
  Array.from({ length: dim }, (_, i) => Math.sin((i + seed) / 17) * 0.1);

const stubEmbed = (
  vector = sampleVector(),
  model = 'openai:text-embedding-3-small',
): { fn: ReturnType<typeof vi.fn>; calls: () => number } => {
  const fn = vi.fn(
    async (_m: IngredientManifest, _i: Record<string, unknown>) => ({
      vector,
      dimensions: vector.length,
      model,
    }),
  );
  return { fn, calls: () => fn.mock.calls.length };
};

const buildCtx = (
  embed: ReturnType<typeof vi.fn>,
  cache: LlmResultCacheStore | undefined,
): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
  embed: embed as unknown as HousekeepingEmbedExecute,
  blobs: buildBlobs(),
  ...(cache ? { llmResultCache: cache } : {}),
});

/** Run produce + the harness-equivalent upsert by hand so the cache
 *  pointer resolves on subsequent calls (the harness normally writes
 *  the row right after produce() returns; here we do it manually). */
const produceAndPersist = async (
  ctx: HousekeepingContext,
  record: CollectionRecord,
): Promise<{
  value: { dimensions: number; model: string };
  sidecar_vector: Buffer;
  model_id: string;
  producer_version_hash: string;
}> => {
  const out = await embeddingProducer.produce(ctx, buildSourceRecord(record));
  if (out === null) throw new Error('produce returned null in fixture');
  // The harness threads these fields onto the upsert. Match the
  // per-record harness's upsert call shape so the cache's pointer
  // resolves correctly on the next call.
  enrichmentStore.upsert({
    topic: 'embedding',
    scope: 'mail',
    target_id: record.record_id,
    authored_by: 'system.housekeeping.embedding',
    value: out.value,
    sidecar_vector: out.sidecar_vector,
    source_record_hash: `src_${record.record_id}`,
    ...(out.model_id !== undefined ? { model_id: out.model_id } : {}),
    ...(out.event_at !== undefined ? { event_at: out.event_at } : {}),
    ...(out.ingredient_slug !== undefined ? { ingredient_slug: out.ingredient_slug } : {}),
    ...(out.producer_version_hash !== undefined
      ? { producer_version_hash: out.producer_version_hash }
      : {}),
  });
  return out as ReturnType<typeof produceAndPersist> extends Promise<infer R> ? R : never;
};

// ────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-7-embed-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureHousekeepingSchema(db);
  enrichmentStore = createEnrichmentStore(db, { now: () => NOW });
  llmResultCache = createLlmResultCacheStore(db);
});

afterEach(() => {
  enrichmentStore.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// 1. Cache miss → embed call + cache entry insertion
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer × cache — miss', () => {
  it('first call hits the embedding adapter + inserts a cache entry pointing to the row', async () => {
    const embed = stubEmbed();
    const ctx = buildCtx(embed.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));

    expect(embed.calls()).toBe(1);
    const inputHash = hashLlmInput({ 'llm.data': SHARED_BODY });
    const entry = llmResultCache.lookup(inputHash);
    expect(entry).not.toBeNull();
    expect(entry?.result_path).toBe('data.enrichment.embedding.mail.mail-1');
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Cache hit on a second record with identical body
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer × cache — hit', () => {
  it('second record with identical body reuses the cached vector', async () => {
    const embed = stubEmbed(sampleVector(16), 'openai:text-embedding-3-small');
    const ctx = buildCtx(embed.fn, llmResultCache);
    const first = await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(embed.calls()).toBe(1);

    // Second record carries the same body text → cache hits; no
    // additional embed call.
    const second = await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(embed.calls()).toBe(1);
    expect(second).not.toBeNull();
    if (!second) throw new Error();

    // Vector + value carry through.
    expect(second.value).toEqual(first.value);
    expect(second.sidecar_vector!.equals(first.sidecar_vector)).toBe(true);
    expect(second.model_id).toBe(first.model_id);
    expect(second.producer_version_hash).toBe(first.producer_version_hash);
    // event_at flows from the SECOND record's source clock.
    expect(second.event_at).toBe(NOW);

    // hit_count incremented.
    const inputHash = hashLlmInput({ 'llm.data': SHARED_BODY });
    const row = llmResultCache.getRow(inputHash);
    expect(row?.hit_count).toBe(1);
  });

  it('three records with identical body cause exactly one embed call + two hit_count bumps', async () => {
    const embed = stubEmbed();
    const ctx = buildCtx(embed.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-3')));

    expect(embed.calls()).toBe(1);
    const row = llmResultCache.getRow(hashLlmInput({ 'llm.data': SHARED_BODY }));
    expect(row?.hit_count).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Opt-out path
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer × cache — opt-out', () => {
  it('ctx without llmResultCache → producer falls back to compute-every-time', async () => {
    const embed = stubEmbed();
    const ctx = buildCtx(embed.fn, undefined); // cache disabled
    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-1')));
    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(embed.calls()).toBe(2);
    // No cache row written either — the no-cache ctx skips the
    // insertOrIgnore at the bottom of produce().
    const rows = db.prepare('SELECT COUNT(*) AS n FROM llm_result_cache').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Self-healing — dangling cache pointer (row deleted)
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer × cache — self-healing dangling pointer', () => {
  it('cached row was deleted → lazy delete + LLM call', async () => {
    const embed = stubEmbed();
    const ctx = buildCtx(embed.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(embed.calls()).toBe(1);

    // Simulate § A.7.9 cleanup firing on the first writer's row.
    const firstRow = enrichmentStore.list({
      topic: 'embedding',
      scope: 'mail',
      target_id: 'mail-1',
    })[0]!;
    enrichmentStore.deleteById(firstRow._id);

    // Second record with same body — cache entry exists, but the
    // pointed-to row is gone. Producer lazy-deletes + falls through.
    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(embed.calls()).toBe(2);

    // Cache entry was lazy-deleted on the dangling read AND re-inserted
    // on the post-LLM write, now pointing at mail-2's path.
    const entry = llmResultCache.lookup(hashLlmInput({ 'llm.data': SHARED_BODY }));
    // produce() doesn't upsert the second row in this assertion path,
    // so the cache insert pointed at mail-2's not-yet-written row.
    expect(entry?.result_path).toBe('data.enrichment.embedding.mail.mail-2');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Self-healing — hash drift on the cached value
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer × cache — self-healing hash drift', () => {
  it('mutated value at cached path → lazy delete + LLM call', async () => {
    const embed = stubEmbed();
    const ctx = buildCtx(embed.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(embed.calls()).toBe(1);

    // External mutation of the row's value — the cache's result_hash
    // no longer matches.
    db.prepare(`UPDATE data_enrichment SET value = ? WHERE target_id = 'mail-1'`).run(
      JSON.stringify({ dimensions: 99, model: 'drifted' }),
    );

    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(embed.calls()).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. Self-healing — missing sidecar vector
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer × cache — self-healing missing sidecar', () => {
  it('vector sidecar gone (FK row present, vector_index row missing) → lazy delete + LLM call', async () => {
    const embed = stubEmbed();
    const ctx = buildCtx(embed.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(embed.calls()).toBe(1);

    // Drop the sidecar without touching the value row. The cache's
    // hash check passes (value unchanged) but the sidecar read
    // returns null → lazy delete + fall through.
    db.prepare(
      `DELETE FROM data_enrichment_vector_index
         WHERE enrichment_id IN (
           SELECT _id FROM data_enrichment WHERE target_id = 'mail-1'
         )`,
    ).run();

    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(embed.calls()).toBe(2);
    // Cache entry replaced with mail-2's pointer.
    const entry = llmResultCache.lookup(hashLlmInput({ 'llm.data': SHARED_BODY }));
    expect(entry?.result_path).toBe('data.enrichment.embedding.mail.mail-2');
  });
});

// ────────────────────────────────────────────────────────────────
// 7. Different bodies don't collide
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer × cache — disjoint inputs', () => {
  it('different bodies yield different input_hashes; no false cache hits', async () => {
    const embed = stubEmbed();
    const ctx = buildCtx(embed.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1', SHARED_BODY));
    const otherBody =
      'Completely different content that has nothing in common with the first record. ' +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.';
    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2', otherBody)));

    expect(embed.calls()).toBe(2);
    // Two distinct cache entries.
    const allRows = db.prepare('SELECT COUNT(*) AS n FROM llm_result_cache').get() as { n: number };
    expect(allRows.n).toBe(2);
  });
});
