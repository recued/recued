/** D-120 Phase 2 — recipe-insights store (IDB-side wrapper).
 *
 *  The wrapper is collection-agnostic (works over any
 *  `Collection<RecipeInsightRecord>` — IDB in production, in-memory
 *  in tests). Covers content-addressed get-or-create idempotency,
 *  null-on-miss semantics, prune behavior, and size accuracy.
 */

import { describe, expect, it } from 'vitest';
import { createInMemoryCollection } from '../in-memory.js';
import {
  createRecipeInsightsStore,
  type RecipeInsightRecord,
} from '../recipe-insights.js';

const sampleRecord = (overrides: Partial<RecipeInsightRecord> = {}): RecipeInsightRecord => ({
  hash: 'hash-stable',
  slug: 'detect-deal-risk-hubspot',
  version: 3,
  flattened: '{"steps":[]}',
  created_at: 1000,
  ...overrides,
});

describe('createRecipeInsightsStore', () => {
  it('getOrCreate returns the same row across repeat calls (idempotent)', async () => {
    const store = createRecipeInsightsStore(createInMemoryCollection());
    const first = await store.getOrCreate(sampleRecord());
    const second = await store.getOrCreate(sampleRecord());
    expect(second).toEqual(first);
    expect(await store.size()).toBe(1);
  });

  it('getOrCreate preserves the original row even when re-called with mismatched fields', async () => {
    const store = createRecipeInsightsStore(createInMemoryCollection());
    await store.getOrCreate(sampleRecord());
    const after = await store.getOrCreate(
      sampleRecord({ slug: 'something-else', flattened: '{"steps":[{}]}' }),
    );
    // First-write-wins semantics — content-addressing means the row
    // already exists, so the second insert is a no-op.
    expect(after.slug).toBe('detect-deal-risk-hubspot');
    expect(after.flattened).toBe('{"steps":[]}');
  });

  it('get returns the stored row by hash', async () => {
    const store = createRecipeInsightsStore(createInMemoryCollection());
    await store.getOrCreate(sampleRecord({ hash: 'h-find' }));
    const found = await store.get('h-find');
    expect(found?.slug).toBe('detect-deal-risk-hubspot');
  });

  it('get returns null for unknown hashes', async () => {
    const store = createRecipeInsightsStore(createInMemoryCollection());
    const found = await store.get('never-stored');
    expect(found).toBeNull();
  });

  it('prune removes hashes not in the keep set + reports accurate count', async () => {
    const store = createRecipeInsightsStore(createInMemoryCollection());
    await store.getOrCreate(sampleRecord({ hash: 'keep-1' }));
    await store.getOrCreate(sampleRecord({ hash: 'keep-2' }));
    await store.getOrCreate(sampleRecord({ hash: 'drop-1' }));
    await store.getOrCreate(sampleRecord({ hash: 'drop-2' }));
    const removed = await store.prune(new Set(['keep-1', 'keep-2']));
    expect(removed).toBe(2);
    expect(await store.size()).toBe(2);
    expect(await store.get('drop-1')).toBeNull();
    expect(await store.get('keep-1')).not.toBeNull();
  });
});
