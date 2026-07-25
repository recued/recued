/** D-145 PA9.7b — `purpose` producer × LLM result cache integration.
 *
 *  Sibling of `d-145-pa9-7b-summary-cache-integration.test.ts`; same
 *  hit / miss / self-heal surface but with purpose's classification
 *  output shape `{ category, confidence, reasoning }`.
 *
 *  Spec: D-145 § A.7.10. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollectionRecord, IngredientManifest } from '@recued/contracts';

import {
  purposeProducer,
  PURPOSE_CATEGORIES,
} from '../housekeeping/producers/purpose.js';
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

const PURPOSE_CONTEXT =
  'Pick the most specific business-context category when one applies; ' +
  'fall back to a generic intent category otherwise; use "other" only as a last resort.';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let llmResultCache: LlmResultCacheStore;

const SHARED_BODY =
  'Hi team — we are closing the Q3 contract with Acme Corp on Friday. ' +
  'Please confirm the final pricing line items by EOD Thursday so legal can ' +
  'finalize the redlines. Thanks, Alice.';

const SAMPLE_OUTPUT = {
  category: 'contract' as const,
  confidence: 0.88,
  reasoning: 'Mentions contract closure, legal redlines, and pricing line items.',
};

const buildRecord = (record_id: string, body = SHARED_BODY): CollectionRecord => ({
  record_id,
  received_at: NOW,
  modified_at: NOW,
  hot_fields: {
    from: 'alice@example.com',
    to: ['bob@example.com'],
    subject: 'Acme contract',
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

const produceAndPersist = async (
  ctx: HousekeepingContext,
  record: CollectionRecord,
): Promise<NonNullable<Awaited<ReturnType<typeof purposeProducer.produce>>>> => {
  const out = await purposeProducer.produce(ctx, buildSourceRecord(record));
  if (out === null) throw new Error('produce returned null in fixture');
  enrichmentStore.upsert({
    topic: 'purpose',
    scope: 'mail',
    target_id: record.record_id,
    authored_by: 'system.housekeeping.purpose',
    value: out.value,
    source_record_hash: `src_${record.record_id}`,
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
    'llm.categories': [...PURPOSE_CATEGORIES],
    'llm.context': PURPOSE_CONTEXT,
    'llm.model_hint': 'fast',
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-7b-purpose-'));
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

describe('purposeProducer × cache — miss', () => {
  it('first call hits the LLM + inserts a cache entry pointing to the row', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));

    expect(llm.calls()).toBe(1);
    const entry = llmResultCache.lookup(expectedInputHash());
    expect(entry).not.toBeNull();
    expect(entry?.result_path).toBe('data.enrichment.purpose.mail.mail-1');
  });
});

describe('purposeProducer × cache — hit', () => {
  it('second record with identical body reuses the cached classification', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    const first = await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    const second = await purposeProducer.produce(
      ctx,
      buildSourceRecord(buildRecord('mail-2')),
    );
    expect(llm.calls()).toBe(1);
    expect(second).not.toBeNull();
    if (!second) throw new Error();
    expect(second.value).toEqual(first.value);
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
    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord('mail-3')));

    expect(llm.calls()).toBe(1);
    const row = llmResultCache.getRow(expectedInputHash());
    expect(row?.hit_count).toBe(2);
  });
});

describe('purposeProducer × cache — opt-out', () => {
  it('ctx without llmResultCache → producer falls back to compute-every-time', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, undefined);
    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord('mail-1')));
    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM llm_result_cache').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});

describe('purposeProducer × cache — self-healing dangling pointer', () => {
  it('cached row deleted → lazy delete + LLM call + re-insert pointing to new row', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    const firstRow = enrichmentStore.list({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail-1',
    })[0]!;
    enrichmentStore.deleteById(firstRow._id);

    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);
    const entry = llmResultCache.lookup(expectedInputHash());
    expect(entry?.result_path).toBe('data.enrichment.purpose.mail.mail-2');
  });
});

describe('purposeProducer × cache — self-healing hash drift', () => {
  it('mutated value at cached path → lazy delete + LLM call', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    db.prepare(`UPDATE data_enrichment SET value = ? WHERE target_id = 'mail-1'`).run(
      JSON.stringify({ category: 'other', confidence: 0.1, reasoning: 'drifted' }),
    );

    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);
  });
});

describe('purposeProducer × cache — disjoint inputs', () => {
  it('different bodies yield different input_hashes; no false cache hits', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1', SHARED_BODY));
    const otherBody =
      'Hi! Could you grab lunch on Tuesday? My team is in town and would love to ' +
      'catch up over the new coffee shop on 3rd Ave.';
    await purposeProducer.produce(
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
