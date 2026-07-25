/** D-145 PA9.7b — `action_items` producer × LLM result cache integration.
 *
 *  Sibling of `d-145-pa9-7b-summary-cache-integration.test.ts`; the
 *  action_items value shape is `{ action_items: ActionItem[] }`, fully
 *  target-agnostic given the body bytes.
 *
 *  Spec: docs/d-145-spec.md § A.7.10. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollectionRecord, IngredientManifest } from '@recued/contracts';

import { actionItemsProducer } from '../housekeeping/producers/action-items.js';
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

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let llmResultCache: LlmResultCacheStore;

const SHARED_BODY =
  'Hi team,\n\nFor the Q3 review, please complete the following before Friday: ' +
  'send the revised forecast to finance, reconcile the customer expansion notes, ' +
  'and confirm the regional split with sales. Thanks.';

const SAMPLE_OUTPUT = {
  action_items: [
    { description: 'send the revised forecast to finance', owner: 'me', due: 'Friday' },
    { description: 'reconcile the customer expansion notes', due: 'Friday' },
    { description: 'confirm the regional split with sales', due: 'Friday' },
  ],
};

const buildRecord = (record_id: string, body = SHARED_BODY): CollectionRecord => ({
  record_id,
  received_at: NOW,
  modified_at: NOW,
  hot_fields: {
    from: 'alice@example.com',
    to: ['team@example.com'],
    subject: 'Q3 review prep',
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
  output: unknown = SAMPLE_OUTPUT,
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
): Promise<NonNullable<Awaited<ReturnType<typeof actionItemsProducer.produce>>>> => {
  const out = await actionItemsProducer.produce(ctx, buildSourceRecord(record));
  if (out === null) throw new Error('produce returned null in fixture');
  enrichmentStore.upsert({
    topic: 'action_items',
    scope: 'mail',
    target_id: record.record_id,
    authored_by: 'system.housekeeping.action_items',
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
    'llm.fields': ['action_items'],
    'llm.model_hint': 'fast',
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-7b-action-items-'));
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

describe('actionItemsProducer × cache — miss', () => {
  it('first call hits the LLM + inserts a cache entry pointing to the row', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));

    expect(llm.calls()).toBe(1);
    const entry = llmResultCache.lookup(expectedInputHash());
    expect(entry).not.toBeNull();
    expect(entry?.result_path).toBe('data.enrichment.action_items.mail.mail-1');
  });
});

describe('actionItemsProducer × cache — hit', () => {
  it('second record with identical body reuses the cached extraction', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    const first = await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    const second = await actionItemsProducer.produce(
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
    await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord('mail-3')));

    expect(llm.calls()).toBe(1);
    const row = llmResultCache.getRow(expectedInputHash());
    expect(row?.hit_count).toBe(2);
  });
});

describe('actionItemsProducer × cache — opt-out', () => {
  it('ctx without llmResultCache → producer falls back to compute-every-time', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, undefined);
    await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord('mail-1')));
    await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM llm_result_cache').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});

describe('actionItemsProducer × cache — self-healing dangling pointer', () => {
  it('cached row deleted → lazy delete + LLM call + re-insert pointing to new row', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    const firstRow = enrichmentStore.list({
      topic: 'action_items',
      scope: 'mail',
      target_id: 'mail-1',
    })[0]!;
    enrichmentStore.deleteById(firstRow._id);

    await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);
    const entry = llmResultCache.lookup(expectedInputHash());
    expect(entry?.result_path).toBe('data.enrichment.action_items.mail.mail-2');
  });
});

describe('actionItemsProducer × cache — self-healing hash drift', () => {
  it('mutated value at cached path → lazy delete + LLM call', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1'));
    expect(llm.calls()).toBe(1);

    db.prepare(`UPDATE data_enrichment SET value = ? WHERE target_id = 'mail-1'`).run(
      JSON.stringify({ action_items: [{ description: 'drifted' }] }),
    );

    await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord('mail-2')));
    expect(llm.calls()).toBe(2);
  });
});

describe('actionItemsProducer × cache — disjoint inputs', () => {
  it('different bodies yield different input_hashes; no false cache hits', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildRecord('mail-1', SHARED_BODY));
    const otherBody =
      'Hi friend! Just wanted to share that I finally finished the marathon last weekend. ' +
      'It took me 4 hours and 23 minutes but I made it across the finish line.';
    await actionItemsProducer.produce(
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
