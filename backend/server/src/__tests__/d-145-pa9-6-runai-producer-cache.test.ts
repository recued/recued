/** D-145 PA9.6 — `runAIProducer` × LLM result cache integration.
 *
 *  Locks the new lookup-before-LLM + insert-after-LLM contract per
 *  spec § A.7.10 invariants:
 *
 *    1. Cache miss with compose_input → LLM call runs; cache entry
 *       inserted with input_hash + result_hash + result_path of the
 *       just-written row.
 *    2. Cache hit (different target, same input) → LLM call skipped;
 *       outcome.cached === true; outcome.cached_from_path is set;
 *       tokens_consumed === 0.
 *    3. Cache hit's row in the current target is upserted with model_id
 *       sourced from the cached path's row (so the row stamps the
 *       model that actually produced the value).
 *    4. Hash mismatch on the cached path → lazy delete + fall through
 *       to LLM call.
 *    5. Dangling cache entry (no row at the path) → lazy delete + fall
 *       through to LLM call.
 *    6. Producer without compose_input → no cache interaction (legacy
 *       AI producers stay byte-stable).
 *    7. ctx without llmResultCache → no cache interaction.
 *    8. Dedup hit on (input_fingerprint_hash, producer_version_hash)
 *       wins BEFORE the cache lookup (invariant 7 — producer-version
 *       hash skip-rule preserved).
 *    9. Trust gate fires BEFORE the cache lookup (cache doesn't bypass
 *       AI gating).
 *   10. Cache hit increments hit_count on the entry.
 *   11. First-writer-wins on insert: second producer with same input
 *       does NOT overwrite the cache entry.
 *
 *  Spec: docs/d-145-spec.md § A.7.10. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeProducerVersionHash,
  type EnrichmentTopic,
  type IngredientManifest,
} from '@recued/contracts';

import { runAIProducer } from '../housekeeping/ai-producer-wrapper.js';
import { createEnrichmentStore } from '../storage/enrichment-store.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import {
  createLlmResultCacheStore,
  hashEnrichmentResult,
  hashLlmInput,
  type LlmResultCacheStore,
} from '../housekeeping/llm-result-cache-store.js';
import { createTrustStore } from '../housekeeping/trust-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure (mirrors d-136-phase-3 wrapper test)
// ────────────────────────────────────────────────────────────────

const SOURCE_EVENT_AT = 1_700_000_000_000;
const NOW = 1_700_500_000_000;
const TOPIC: EnrichmentTopic = 'purpose'; // permissive ai-classify topic
const SCOPE = 'mail' as const;
const AUTHORED_BY = 'system.housekeeping.purpose';
const INGREDIENT_SLUG = 'ai-classify';

const baseManifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'AI Classifier',
  description: 'test',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: [],
  input: {},
  output: {},
};

const aiResponse = { category: 'request', confidence: 0.92, reasoning: 'asks for action' };

const buildInput = (
  ctx: HousekeepingContext,
  overrides: {
    target_id?: string;
    source_record_hash?: string;
    composeInput?: (() => unknown) | undefined;
    llmInput?: Record<string, unknown>;
  } = {},
) => {
  const target_id = overrides.target_id ?? 'mail_record_001';
  const source_record_hash = overrides.source_record_hash ?? `src_${target_id}`;
  return {
    ctx,
    topic: TOPIC,
    scope: SCOPE,
    target_id,
    authored_by: AUTHORED_BY,
    source_record_hash,
    inputFingerprint: {
      kind: 'per_record_source_hash' as const,
      source_record_hash,
    },
    producer_version_hash: computeProducerVersionHash({
      producer_code_hash: 'pc1',
      model_id: 'openai:gpt-4o-mini',
      prompt_template_hash: 'pt1',
      adapter_version: '@recued/llm@1.0.0',
      consumed_ingredients_versions: [],
    }),
    ingredient_slug: INGREDIENT_SLUG,
    eventClock: { event_at: SOURCE_EVENT_AT },
    manifest: baseManifest,
    llmInput: overrides.llmInput ?? { 'llm.data': 'shared body' },
    validate: (raw: unknown) => raw as typeof aiResponse,
    buildValue: (r: typeof aiResponse) => ({
      category: r.category,
      confidence: r.confidence,
      reasoning: r.reasoning,
    }),
    token_estimate: 250,
    ...(overrides.composeInput !== undefined ? { compose_input: overrides.composeInput } : {}),
  };
};

let dir: string;
let db: Database.Database;

const mkCtx = (
  overrides: {
    llmWithMetaImpl?: HousekeepingContext['llmWithMeta'];
    enableCache?: boolean;
  } = { enableCache: true },
) => {
  ensureHousekeepingSchema(db);
  const enrichmentStore = createEnrichmentStore(db, { now: () => NOW });
  const trustStore = createTrustStore(db);
  const llmResultCache = overrides.enableCache !== false ? createLlmResultCacheStore(db) : undefined;
  const llmWithMeta = vi.fn(
    overrides.llmWithMetaImpl ??
      (async (_m: IngredientManifest, _i: Record<string, unknown>) => ({
        result: aiResponse,
        model_id: 'openai:gpt-4o-mini',
      })),
  );
  const ctx: HousekeepingContext = {
    db,
    bus: { emit: vi.fn() } as unknown as HousekeepingContext['bus'],
    enrichmentStore,
    recipeStore: {} as HousekeepingContext['recipeStore'],
    now: () => NOW,
    emitAuditRow: vi.fn(),
    llmWithMeta,
    trustStore,
    ...(llmResultCache ? { llmResultCache } : {}),
  };
  return { ctx, enrichmentStore, trustStore, llmWithMeta, llmResultCache };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-6-wrapper-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// 1. Cache miss path
// ────────────────────────────────────────────────────────────────

describe('runAIProducer × cache — miss path', () => {
  it('compose_input + miss → LLM runs; entry inserted; outcome.cached === false', async () => {
    const { ctx, llmWithMeta, llmResultCache } = mkCtx();
    const composeInput = () => ({ system: 'classify', user: 'shared body' });
    const out = await runAIProducer(buildInput(ctx, { composeInput }));
    expect(out.status).toBe('computed');
    expect(llmWithMeta).toHaveBeenCalledOnce();
    if (out.status === 'computed') {
      expect(out.cached).toBe(false);
      expect(out.cached_from_path).toBeUndefined();
      expect(out.tokens_consumed).toBe(250);
    }
    const inputHash = hashLlmInput(composeInput());
    const entry = llmResultCache!.lookup(inputHash);
    expect(entry).not.toBeNull();
    expect(entry?.result_path).toBe('data.enrichment.purpose.mail.mail_record_001');
  });

  it('result_hash matches the persisted value', async () => {
    const { ctx, enrichmentStore, llmResultCache } = mkCtx();
    const composeInput = () => ({ system: 'classify', user: 'X' });
    await runAIProducer(buildInput(ctx, { composeInput, target_id: 'msg-1' }));
    const rows = enrichmentStore.list({ topic: TOPIC, scope: SCOPE, target_id: 'msg-1' });
    const persistedValueHash = hashEnrichmentResult(rows[0]!.value);
    const entry = llmResultCache!.lookup(hashLlmInput(composeInput()));
    expect(entry?.result_hash).toBe(persistedValueHash);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Cache hit path
// ────────────────────────────────────────────────────────────────

describe('runAIProducer × cache — hit path', () => {
  it('second target with identical compose_input skips LLM + reuses cached value', async () => {
    const { ctx, enrichmentStore, llmWithMeta, llmResultCache } = mkCtx();
    const composeInput = () => ({ system: 'classify', user: 'shared body' });
    await runAIProducer(buildInput(ctx, { composeInput, target_id: 'msg-1' }));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    // Second target — different source_record_hash so the dedup
    // probe misses; same compose_input so the cache hits.
    const out = await runAIProducer(
      buildInput(ctx, { composeInput, target_id: 'msg-2', source_record_hash: 'src_different' }),
    );
    expect(llmWithMeta).toHaveBeenCalledTimes(1); // still 1 — LLM skipped
    expect(out.status).toBe('computed');
    if (out.status === 'computed') {
      expect(out.cached).toBe(true);
      expect(out.cached_from_path).toBe('data.enrichment.purpose.mail.msg-1');
      expect(out.tokens_consumed).toBe(0);
      expect(out.model_id).toBe('openai:gpt-4o-mini'); // sourced from cached row
    }

    // Second target's row exists with the cached value.
    const rows2 = enrichmentStore.list({ topic: TOPIC, scope: SCOPE, target_id: 'msg-2' });
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.value).toEqual({ category: 'request', confidence: 0.92, reasoning: 'asks for action' });

    // hit_count incremented on the cache entry.
    const entry = llmResultCache!.getRow(hashLlmInput(composeInput()));
    expect(entry?.hit_count).toBe(1);
  });

  it('multiple hits accumulate hit_count', async () => {
    const { ctx, llmWithMeta, llmResultCache } = mkCtx();
    const composeInput = () => ({ system: 'classify', user: 'shared body' });
    await runAIProducer(buildInput(ctx, { composeInput, target_id: 'msg-1' }));
    await runAIProducer(
      buildInput(ctx, { composeInput, target_id: 'msg-2', source_record_hash: 'src_2' }),
    );
    await runAIProducer(
      buildInput(ctx, { composeInput, target_id: 'msg-3', source_record_hash: 'src_3' }),
    );
    expect(llmWithMeta).toHaveBeenCalledTimes(1); // one real LLM call

    const entry = llmResultCache!.getRow(hashLlmInput(composeInput()));
    expect(entry?.hit_count).toBe(2); // two hits (msg-2 + msg-3)
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Self-healing paths
// ────────────────────────────────────────────────────────────────

describe('runAIProducer × cache — self-healing', () => {
  it('dangling cache entry (target row deleted) → lazy delete + LLM call', async () => {
    const { ctx, enrichmentStore, llmWithMeta, llmResultCache } = mkCtx();
    const composeInput = () => ({ system: 'classify', user: 'X' });
    await runAIProducer(buildInput(ctx, { composeInput, target_id: 'msg-1' }));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    // Drop the first row — simulates § A.7.9 cleanup firing on
    // source-delete or null-return.
    const firstRow = enrichmentStore.list({ topic: TOPIC, scope: SCOPE, target_id: 'msg-1' })[0]!;
    enrichmentStore.deleteById(firstRow._id);

    // Second target with same input — cache entry exists but the
    // pointed-to row is gone. Wrapper lazy-deletes + falls through.
    const out = await runAIProducer(
      buildInput(ctx, { composeInput, target_id: 'msg-2', source_record_hash: 'src_2' }),
    );
    expect(llmWithMeta).toHaveBeenCalledTimes(2);
    if (out.status === 'computed') expect(out.cached).toBe(false);

    // Cache entry was lazy-deleted on the missing-path read, then
    // re-inserted on the post-LLM write — pointing at msg-2 now.
    const entry = llmResultCache!.lookup(hashLlmInput(composeInput()));
    expect(entry?.result_path).toBe('data.enrichment.purpose.mail.msg-2');
  });

  it('hash drift at cached path → lazy delete + LLM call', async () => {
    const { ctx, llmWithMeta, llmResultCache } = mkCtx();
    const composeInput = () => ({ system: 'classify', user: 'X' });
    await runAIProducer(buildInput(ctx, { composeInput, target_id: 'msg-1' }));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    // Mutate the first row's value directly so its hash no longer
    // matches the cached result_hash. (External mutation /
    // corruption simulation.)
    db.prepare(
      `UPDATE data_enrichment SET value = ? WHERE target_id = ?`,
    ).run(JSON.stringify({ category: 'mutated', confidence: 0, reasoning: '' }), 'msg-1');

    const out = await runAIProducer(
      buildInput(ctx, { composeInput, target_id: 'msg-2', source_record_hash: 'src_2' }),
    );
    expect(llmWithMeta).toHaveBeenCalledTimes(2);
    if (out.status === 'computed') expect(out.cached).toBe(false);
    // Cache entry was replaced with the new (msg-2) result.
    const entry = llmResultCache!.lookup(hashLlmInput(composeInput()));
    expect(entry?.result_path).toBe('data.enrichment.purpose.mail.msg-2');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Opt-out + degradation paths
// ────────────────────────────────────────────────────────────────

describe('runAIProducer × cache — opt-out / degradation', () => {
  it('producer without compose_input → no cache interaction; cached === false', async () => {
    const { ctx, llmWithMeta, llmResultCache } = mkCtx();
    await runAIProducer(buildInput(ctx)); // no composeInput
    expect(llmWithMeta).toHaveBeenCalledOnce();
    // Iterate any rows that might exist.
    const anyRows = db.prepare(`SELECT COUNT(*) AS n FROM llm_result_cache`).get() as { n: number };
    expect(anyRows.n).toBe(0);
    // gcDanglingRefs reports no rows touched.
    expect(llmResultCache!.gcDanglingRefs({ resolvePathExists: () => true }).rows_deleted).toBe(0);
  });

  it('ctx without llmResultCache → no cache interaction', async () => {
    const { ctx, llmWithMeta } = mkCtx({ enableCache: false });
    const composeInput = () => ({ system: 'classify', user: 'X' });
    const out = await runAIProducer(buildInput(ctx, { composeInput }));
    expect(out.status).toBe('computed');
    if (out.status === 'computed') expect(out.cached).toBe(false);
    expect(llmWithMeta).toHaveBeenCalledOnce();
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Ordering — dedup + trust gate before cache (invariant 7)
// ────────────────────────────────────────────────────────────────

describe('runAIProducer × cache — ordering invariants', () => {
  it('dedup hit short-circuits BEFORE cache lookup (invariant 7)', async () => {
    const { ctx, llmWithMeta, llmResultCache } = mkCtx();
    const composeInput = () => ({ system: 'classify', user: 'X' });
    await runAIProducer(buildInput(ctx, { composeInput, target_id: 'msg-1' }));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    // Same target + identical input fingerprint = dedup hit. No LLM
    // call AND no cache lookup (the cache's hit_count stays 0).
    const out = await runAIProducer(buildInput(ctx, { composeInput, target_id: 'msg-1' }));
    expect(out.status).toBe('dedup_hit');
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
    const entry = llmResultCache!.getRow(hashLlmInput(composeInput()));
    expect(entry?.hit_count).toBe(0); // cache not consulted
  });

  it('trust_state=off short-circuits BEFORE cache lookup', async () => {
    const { ctx, trustStore, llmWithMeta, llmResultCache } = mkCtx();
    const composeInput = () => ({ system: 'classify', user: 'X' });
    // First call seeds the cache + persists row.
    await runAIProducer(buildInput(ctx, { composeInput, target_id: 'msg-1' }));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    // Now flip trust off; second call with same compose_input
    // returns skipped_trust without touching the cache.
    trustStore.write(TOPIC, { trust_state: 'off' }, NOW);
    const out = await runAIProducer(
      buildInput(ctx, { composeInput, target_id: 'msg-2', source_record_hash: 'src_2' }),
    );
    expect(out.status).toBe('skipped_trust');
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
    // hit_count stays 0 — cache was not consulted.
    const entry = llmResultCache!.getRow(hashLlmInput(composeInput()));
    expect(entry?.hit_count).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. First-writer-wins
// ────────────────────────────────────────────────────────────────

describe('runAIProducer × cache — first-writer-wins', () => {
  it('a second producer hitting the same input after a miss does NOT overwrite the entry', async () => {
    // Bootstrap an existing cache entry directly so the test doesn't
    // depend on cross-producer race ordering.
    const { ctx, enrichmentStore, llmWithMeta } = mkCtx();
    const cache = ctx.llmResultCache as LlmResultCacheStore;
    const composeInput = () => ({ system: 'classify', user: 'shared' });
    const inputHash = hashLlmInput(composeInput());
    // Pre-seed the cache pointing at a row that exists.
    enrichmentStore.upsert({
      topic: TOPIC,
      scope: SCOPE,
      target_id: 'first-writer',
      value: { category: 'request', confidence: 0.92, reasoning: 'asks for action' },
      authored_by: AUTHORED_BY,
      source_record_hash: 'src_first',
    });
    cache.insertOrIgnore({
      input_hash: inputHash,
      result_hash: hashEnrichmentResult({
        category: 'request',
        confidence: 0.92,
        reasoning: 'asks for action',
      }),
      result_path: 'data.enrichment.purpose.mail.first-writer',
      computed_at: NOW - 1000,
    });

    // Second producer call would normally insert after a fresh miss,
    // but the cache hits → no insert fires. Even if it did fire on a
    // weird race, insert-or-ignore preserves the original entry.
    const out = await runAIProducer(buildInput(ctx, { composeInput, target_id: 'second' }));
    expect(out.status).toBe('computed');
    if (out.status === 'computed') expect(out.cached).toBe(true);
    expect(llmWithMeta).toHaveBeenCalledTimes(0); // hit on cache

    const entry = cache.lookup(inputHash);
    expect(entry?.result_path).toBe('data.enrichment.purpose.mail.first-writer');
    expect(entry?.computed_at).toBe(NOW - 1000); // unchanged
  });
});
