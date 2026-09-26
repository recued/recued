/** D-316 — background AI gets the chat's privacy layer, proven through the REAL
 *  per-record enrichment harness (`buildEnrichmentProducerTask`), not only the
 *  wrapper in isolation:
 *    - a batched (D-162) `llm.data` reaches the model aliased;
 *    - when the input cannot be aliased (the tag source throws), no model call is
 *      made and the record carries the reason as a per-row producer failure,
 *      where until D-316 the raw input went out.
 *
 *  Spec: D-316 §3, §4. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CollectionRecord,
  EnrichmentScope,
  IngredientManifest,
  PiiFieldTag,
} from '@recued/contracts';

import {
  buildEnrichmentProducerTask,
  enrichmentProducerAuthoredBy,
  type HousekeepingEnrichmentProducer,
} from '../housekeeping/enrichment-producer.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceCollectionWalker, SourceRecord } from '../housekeeping/source-walkers.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
const now = 1_750_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-316-harness-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db, { now: () => now });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = { slug: 'ai-classify' } as IngredientManifest;

/** A mail record whose sender the tag source marks as an email. */
const mailRecord = (record_id: string, from: string): SourceRecord => {
  const data: CollectionRecord = {
    record_id,
    received_at: now,
    modified_at: now,
    hot_fields: { from },
    size_bytes: 100,
    source_id: record_id,
  };
  return { target_id: record_id, data, cursor_token: record_id };
};

const walkerOf = (records: SourceRecord[]): SourceCollectionWalker => ({
  *walkAfter(cursor_token, batch_size) {
    let yielded = 0;
    for (const record of records) {
      if (record.cursor_token <= cursor_token) continue;
      if (yielded >= batch_size) return;
      yield record;
      yielded += 1;
    }
  },
  hashOf(record) {
    return `v1:${record.target_id}`;
  },
  fetchOne(target_id) {
    return records.find((r) => r.target_id === target_id) ?? null;
  },
});

/** An AI producer, as the shipped `purpose` producer declares itself: it sends
 *  the record as a ONE-ELEMENT BATCH (D-162 shape), the input the old seam
 *  passed through raw. */
const batchingPurposeProducer = (): HousekeepingEnrichmentProducer => ({
  topic: 'purpose',
  source_scope: 'mail',
  ai_surface: 'chat',
  scope_read_declaration: [{ collection: 'data.mail', sample_field_paths: ['from'] }],
  estimate_per_record_tokens: () => 100,
  async produce(ctx, record) {
    const from = String((record.data as CollectionRecord).hot_fields?.from ?? '');
    await ctx.llm!(MANIFEST, {
      'llm.data': [{ id: record.target_id, body: `A question from ${from}` }],
      'llm.id_field': 'id',
      'llm.categories': ['request', 'other'],
    });
    return { value: { category: 'request', confidence: 0.9, reasoning: 'asked a question' } };
  },
});

const ctxWith = (
  llm: NonNullable<HousekeepingContext['llm']>,
  enrichmentPiiTagSource: (scope: EnrichmentScope) => readonly PiiFieldTag[],
): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
  llm,
  enrichmentPiiTagSource,
});

const tagsForMail = (scope: EnrichmentScope): readonly PiiFieldTag[] =>
  scope === 'mail' ? [{ path: 'from', kind: 'email' }] : [];

describe('D-316 — the real enrichment harness', () => {
  it('sends a batched llm.data aliased', async () => {
    const sent: unknown[] = [];
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      sent.push(input['llm.data']);
      return [{ id: 'm1', category: 'request', confidence: 0.9, reasoning: 'ok' }];
    });
    const task = buildEnrichmentProducerTask({
      producer: batchingPurposeProducer(),
      walker: walkerOf([mailRecord('m1', 'alice@acme.com')]),
    });

    const result = await task.step(ctxWith(llm, tagsForMail), { kind: 'complete' }, 60_000);

    expect(result.status).toBe('complete');
    expect(llm).toHaveBeenCalledTimes(1);
    const sentJson = JSON.stringify(sent[0]);
    expect(sentJson).not.toContain('alice@acme.com');
    expect(sentJson).toContain('.invalid');
    const row = store.getByRecord('purpose', 'mail', 'm1', enrichmentProducerAuthoredBy('purpose'));
    expect(row?.value).toEqual({ category: 'request', confidence: 0.9, reasoning: 'asked a question' });
  });

  it('makes no model call when the input cannot be aliased, and records why', async () => {
    const llm = vi.fn(async () => [{ id: 'm1', category: 'request' }]);
    const brokenTagSource = (): readonly PiiFieldTag[] => {
      throw new Error('privacy schema unreadable');
    };
    const task = buildEnrichmentProducerTask({
      producer: batchingPurposeProducer(),
      walker: walkerOf([mailRecord('m1', 'alice@acme.com')]),
    });

    const result = await task.step(ctxWith(llm, brokenTagSource), { kind: 'complete' }, 60_000);

    expect(result.status).toBe('complete');
    expect(llm).not.toHaveBeenCalled();
    const row = store.getByRecord('purpose', 'mail', 'm1', enrichmentProducerAuthoredBy('purpose'));
    expect(row?.value).toBeNull();
    expect(row?.failure_attempt_count).toBe(1);
    expect(row?.last_failure_reason).toContain('could not alias');
    expect(row?.last_failure_reason).toContain('privacy schema unreadable');
  });
});
