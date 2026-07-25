/** D-145 PA9.7b — `summary` producer × LLM result cache integration.
 *
 *  The body-only triad (`summary` / `purpose` / `action_items`) all
 *  emit target-agnostic values given the body bytes — identical bodies
 *  across distinct mail records (forwarded chains, template emails,
 *  signature blocks above MIN_BODY_CHARS) reuse the cached LLM call.
 *
 *  Coverage mirrors the embedding canary at
 *  `d-145-pa9-7-embedding-cache-integration.test.ts`:
 *    1. Cache miss → ctx.llmWithMeta called + cache entry inserted.
 *    2. Cache hit on identical body → ctx.llmWithMeta NOT called +
 *       value reused.
 *    3. Multi-record hit_count bumps.
 *    4. Opt-out (no llmResultCache) → compute every time.
 *    5. Dangling pointer (row deleted) → lazy delete + LLM call.
 *    6. Hash drift on cached value → lazy delete + LLM call.
 *    7. Different bodies don't collide (no false hits).
 *
 *  Spec: docs/d-145-spec.md § A.7.10 + § A.7.10 acceptance criterion 6
 *  (body-only follow-on once embedding telemetry validates the pattern). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollectionRecord, IngredientManifest } from '@recued/contracts';

import { summaryProducer } from '../housekeeping/producers/summary.js';
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
  HousekeepingLlmExecuteWithMeta,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { BlobStore } from '../storage/blob-store.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let llmResultCache: LlmResultCacheStore;

const SHARED_BODY =
  'Hi Bob,\n\nCould you send the revised forecast by Friday so finance can update ' +
  'the board pack? Also, please loop in Carol on the Acme expansion thread.\n\nThanks,\nAlice';

const SAMPLE_OUTPUT = {
  summary: 'Alice asks Bob to send the revised forecast by Friday and loop in Carol on Acme expansion.',
  key_points: [
    'revised forecast due Friday',
    'finance updating board pack',
    'loop in Carol on Acme expansion',
  ],
};

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

const stubLlmWithMeta = (
  output = SAMPLE_OUTPUT,
  model_id = 'openai:gpt-4o-mini',
): { fn: ReturnType<typeof vi.fn>; calls: () => number } => {
  const fn = vi.fn(
    async (_m: IngredientManifest, _i: Record<string, unknown>) => ({
      result: output,
      model_id,
    }),
  );
  return { fn, calls: () => fn.mock.calls.length };
};

const buildCtx = (
  llmWithMeta: ReturnType<typeof vi.fn>,
  cache: LlmResultCacheStore | undefined,
): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
  llmWithMeta: llmWithMeta as unknown as HousekeepingLlmExecuteWithMeta,
  blobs: buildBlobs(),
  ...(cache ? { llmResultCache: cache } : {}),
});

/** Run produce + the harness-equivalent upsert by hand so the cache
 *  pointer resolves on subsequent calls. */
const produceAndPersist = async (
  ctx: HousekeepingContext,
  record: CollectionRecord,
): Promise<NonNullable<Awaited<ReturnType<typeof summaryProducer.produce>>>> => {
  const out = await summaryProducer.produce(ctx, buildSourceRecord(record));
  if (out === null) throw new Error('produce returned null in fixture');
  enrichmentStore.upsert({
    topic: 'summary',
    scope: 'mail',
    target_id: record.record_id,
    authored_by: 'system.housekeeping.summary',
    value: out.value,
    source_record_hash: `src_${record.record_id}`,
    ...(out.sidecar_text !== undefined ? { sidecar_text: out.sidecar_text } : {}),
    ...(out.model_id !== undefined ? { model_id: out.model_id } : {}),
    ...(out.event_at !== undefined ? { event_at: out.event_at } : {}),
    ...(out.ingredient_slug !== undefined ? { ingredient_slug: out.ingredient_slug } : {}),
    ...(out.producer_version_hash !== undefined
      ? { producer_version_hash: out.producer_version_hash }
      : {}),
  });
  return out;
};

const expectedInputHash = (body = SHARED_BODY): string =>
  hashLlmInput({
    'llm.data': body,
    'llm.max_length': 200,
    'llm.focus': 'key actions, decisions, and asks',
    'llm.model_hint': 'fast',
  });

// ────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-7b-summary-'));
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
// 1. Cache miss → LLM call + cache insert
// ────────────────────────────────────────────────────────────────

describe('summaryProducer × cache — miss', () => {
  it('first call hits the LLM + inserts a cache entry pointing to the row', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));

    expect(llm.calls()).toBe(1);
    const entry = llmResultCache.lookup(expectedInputHash());
    expect(entry).not.toBeNull();
    expect(entry?.result_path).toBe('data.enrichment.summary.mail.mail-1');
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Cache hit on second record with identical body
// ────────────────────────────────────────────────────────────────

describe('summaryProducer × cache — hit', () => {
  it('second record with identical body reuses the cached summary', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    const first = await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    const second = await summaryProducer.produce(
      ctx,
      buildSourceRecord(buildRecord('mail-2')),
    );
    expect(llm.calls()).toBe(1);
    expect(second).not.toBeNull();
    if (!second) throw new Error();
    expect(second.value).toEqual(first.value);
    expect(second.sidecar_text).toBe(first.sidecar_text);
    expect(second.model_id).toBe(first.model_id);
    expect(second.producer_version_hash).toBe(first.producer_version_hash);
    expect(second.event_at).toBe(NOW);

    const row = llmResultCache.getRow(expectedInputHash());
    expect(row?.hit_count).toBe(1);
  });

  it('three records with identical body produce one LLM call + two hit_count bumps', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    await summaryProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    await summaryProducer.produce(ctx, buildSourceRecord(buildRecord('mail-3')));

    expect(llm.calls()).toBe(1);
    const row = llmResultCache.getRow(expectedInputHash());
    expect(row?.hit_count).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Opt-out path
// ────────────────────────────────────────────────────────────────

describe('summaryProducer × cache — opt-out', () => {
  it('ctx without llmResultCache → producer falls back to compute-every-time', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, undefined);
    await summaryProducer.produce(ctx, buildSourceRecord(buildRecord('mail-1')));
    await summaryProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM llm_result_cache').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Self-healing — dangling pointer
// ────────────────────────────────────────────────────────────────

describe('summaryProducer × cache — self-healing dangling pointer', () => {
  it('cached row deleted → lazy delete + LLM call + re-insert pointing to new row', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    const firstRow = enrichmentStore.list({
      topic: 'summary',
      scope: 'mail',
      target_id: 'mail-1',
    })[0]!;
    enrichmentStore.deleteById(firstRow._id);

    await summaryProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);

    const entry = llmResultCache.lookup(expectedInputHash());
    expect(entry?.result_path).toBe('data.enrichment.summary.mail.mail-2');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Self-healing — hash drift
// ────────────────────────────────────────────────────────────────

describe('summaryProducer × cache — self-healing hash drift', () => {
  it('mutated value at cached path → lazy delete + LLM call', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    db.prepare(`UPDATE data_enrichment SET value = ? WHERE target_id = 'mail-1'`).run(
      JSON.stringify({ summary: 'drifted', key_points: ['drifted'] }),
    );

    await summaryProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. Disjoint inputs don't collide
// ────────────────────────────────────────────────────────────────

describe('summaryProducer × cache — disjoint inputs', () => {
  it('different bodies yield different input_hashes; no false cache hits', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1', SHARED_BODY));
    const otherBody =
      'Completely different content that has nothing in common with the first record. ' +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.';
    await summaryProducer.produce(
      ctx,
      buildSourceRecord(buildRecord('mail-2', otherBody)),
    );

    expect(llm.calls()).toBe(2);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM llm_result_cache').get() as {
      n: number;
    };
    expect(rows.n).toBe(2);
  });
});
