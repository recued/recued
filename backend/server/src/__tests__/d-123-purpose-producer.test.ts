/** D-123 follow-on — `purpose` enrichment producer tests.
 *
 *  Mirrors the structural shape of `d-123-summary-producer.test.ts`
 *  with three deltas:
 *
 *    1. The contracted ingredient is `ai-classify`, so the LLM stub
 *       returns `{ category, confidence, reasoning }`.
 *    2. `MIN_BODY_CHARS` floor is 50 (vs summary's 100).
 *    3. The producer enforces a closed-set guarantee on `category`;
 *       a category outside `PURPOSE_CATEGORIES` throws
 *       `purpose_output_invalid` even when the shape is otherwise
 *       valid. The summary producer has no analogous gate.
 *
 *  The producer is pure transform — body fetch + LLM call + output
 *  validation — so the tests don't need a live SQLite stack (the
 *  harness handles cursor / hash bookkeeping; covered by the
 *  thread_signals + summary tests). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PURPOSE_CATEGORIES,
  purposeProducer,
} from '../housekeeping/producers/purpose.js';
import type {
  HousekeepingContext,
  HousekeepingLlmExecute,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { BlobStore } from '../storage/blob-store.js';
import type {
  CollectionRecord,
  IngredientManifest,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const buildRecord = (overrides: Partial<CollectionRecord> = {}): CollectionRecord => ({
  record_id: 'mail_001',
  received_at: 1_700_000_000_000,
  modified_at: 1_700_000_000_000,
  hot_fields: {
    from: 'alice@example.com',
    to: ['bob@example.com'],
    subject: 'Q3 plan review',
    thread_id: 'thread_abc',
  },
  size_bytes: 500,
  source_id: 'msg-id-001',
  body_inline:
    'Hi Bob,\n\nCould you send the revised forecast by Friday so finance can update ' +
    'the board pack? Let me know if Tuesday morning works for you.\n\nThanks,\nAlice',
  ...overrides,
});

const buildSourceRecord = (data: CollectionRecord): SourceRecord => ({
  target_id: data.record_id,
  data,
  cursor_token: data.record_id,
});

interface StubLlm {
  fn: ReturnType<typeof vi.fn>;
  capturedManifest: IngredientManifest | null;
  capturedInput: Record<string, unknown> | null;
}

const buildStubLlm = (
  result:
    | { category: string; confidence: number; reasoning: string }
    | (() => never)
    | (() => Promise<never>),
): StubLlm => {
  const stub: StubLlm = {
    capturedManifest: null,
    capturedInput: null,
    fn: vi.fn(),
  };
  stub.fn = vi.fn(async (manifest: IngredientManifest, input: Record<string, unknown>) => {
    stub.capturedManifest = manifest;
    stub.capturedInput = input;
    if (typeof result === 'function') return result();
    return result;
  });
  return stub;
};

const buildBlobs = (overrides: Partial<BlobStore> = {}): BlobStore => ({
  put: vi.fn(async () => 'unused'),
  get: vi.fn(async () => null),
  has: vi.fn(async () => false),
  delete: vi.fn(async () => undefined),
  sizeOf: vi.fn(async () => null),
  sweepOrphans: vi.fn(async () => 0),
  totalBytes: vi.fn(async () => 0),
  root: '/tmp/test',
  ...overrides,
});

const buildCtx = (
  llm: ReturnType<typeof vi.fn>,
  blobs: BlobStore,
): HousekeepingContext => ({
  db: {} as never,
  bus: {} as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => 1_700_000_000_000,
  emitAuditRow: () => undefined,
  llm: llm as unknown as HousekeepingLlmExecute,
  // D-136 P3 — purposeProducer reads `ctx.llmWithMeta` (audit §20.2 fix
  // — model_id capture). Wrap the same `llm` mock so tests don't need
  // to maintain two separate response queues.
  llmWithMeta: (async (manifest: unknown, input: unknown) => ({
    result: await (llm as unknown as (m: unknown, i: unknown) => Promise<unknown>)(
      manifest,
      input,
    ),
    model_id: 'openai:gpt-4o-mini',
  })) as unknown as HousekeepingContext['llmWithMeta'],
  blobs,
});

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('purposeProducer.estimate_per_record_tokens', () => {
  it('returns a positive token estimate so the harness flips idle_eligible to false', () => {
    const tokens = purposeProducer.estimate_per_record_tokens();
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('purposeProducer.produce', () => {
  let llm: StubLlm;
  let blobs: BlobStore;

  beforeEach(() => {
    llm = buildStubLlm({
      category: 'request',
      confidence: 0.86,
      reasoning: 'Asks for a revised forecast by Friday and proposes a meeting time.',
    });
    blobs = buildBlobs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { category, confidence, reasoning } shape from the LLM stub', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord();
    const out = await purposeProducer.produce(ctx, buildSourceRecord(record));

    expect(out).not.toBeNull();
    expect(out?.value).toEqual({
      category: 'request',
      confidence: 0.86,
      reasoning: 'Asks for a revised forecast by Friday and proposes a meeting time.',
    });
    // Confidence is preserved verbatim on the value so recipes can
    // gate via `{{data.enrichment.mail.<id>.purpose.confidence}}
    // greater 0.7`. No sidecar emitted (registry: sidecar='none').
    expect(out?.sidecar_text).toBeUndefined();
    expect(out?.sidecar_vector).toBeUndefined();
  });

  it('passes the closed PURPOSE_CATEGORIES set to ai-classify', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord()));

    const categories = llm.capturedInput?.['llm.categories'] as readonly string[];
    expect(categories).toEqual([...PURPOSE_CATEGORIES]);
    // Spot-check a generic + business-context entry are both present.
    expect(categories).toContain('request');
    expect(categories).toContain('sales_inquiry');
    expect(categories).toContain('other');
  });

  it('passes a priority-rule context so the LLM picks the most specific business-context label', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord()));

    const ctxStr = llm.capturedInput?.['llm.context'] as string;
    expect(typeof ctxStr).toBe('string');
    expect(ctxStr).toMatch(/most specific business-context/i);
    expect(ctxStr).toMatch(/other.*last resort/i);
  });

  it('reads body_inline when present and passes it as llm.data', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord();
    await purposeProducer.produce(ctx, buildSourceRecord(record));

    expect(blobs.get).not.toHaveBeenCalled();
    expect(llm.capturedInput?.['llm.data']).toBe(record.body_inline);
  });

  it('reads from CAS via blob_hash when body_inline is absent', async () => {
    const blobBytes = Buffer.from(
      'Could you confirm the contract terms by Friday? '.repeat(4),
      'utf8',
    );
    const blobsWithBody = buildBlobs({
      get: vi.fn(async (hash: string) => {
        expect(hash).toBe('cas-hash-002');
        return blobBytes;
      }),
    });
    const ctx = buildCtx(llm.fn, blobsWithBody);
    const record = buildRecord({ body_inline: undefined, blob_hash: 'cas-hash-002' });
    const out = await purposeProducer.produce(ctx, buildSourceRecord(record));

    expect(out).not.toBeNull();
    expect(blobsWithBody.get).toHaveBeenCalledWith('cas-hash-002');
    expect(llm.capturedInput?.['llm.data']).toBe(blobBytes.toString('utf8').trim());
  });

  it('returns null when neither body_inline nor blob_hash is set', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: undefined, blob_hash: undefined });
    const out = await purposeProducer.produce(ctx, buildSourceRecord(record));

    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('returns null when body is shorter than the 50-char floor', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: 'Got it.' });
    const out = await purposeProducer.produce(ctx, buildSourceRecord(record));

    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('classifies short-but-above-floor bodies (50-char threshold is below summary 100)', async () => {
    // 60 chars — above the purpose floor (50) but below summary's (100).
    const shortBody = 'Hi team — please approve the Q3 budget by Friday EOD.';
    expect(shortBody.length).toBeGreaterThanOrEqual(50);
    expect(shortBody.length).toBeLessThan(100);

    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: shortBody });
    const out = await purposeProducer.produce(ctx, buildSourceRecord(record));

    expect(out).not.toBeNull();
    expect(llm.fn).toHaveBeenCalledOnce();
    expect(llm.capturedInput?.['llm.data']).toBe(shortBody);
  });

  it('truncates very long bodies before calling the LLM', async () => {
    const longBody = 'X'.repeat(80_000);
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: longBody });
    await purposeProducer.produce(ctx, buildSourceRecord(record));

    const passedData = llm.capturedInput?.['llm.data'] as string;
    expect(passedData.length).toBeLessThanOrEqual(32_000);
    expect(passedData.startsWith('X')).toBe(true);
  });

  it('passes model_hint=fast so classification biases toward slot_1 / cheap free-pool', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    await purposeProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(llm.capturedInput?.['llm.model_hint']).toBe('fast');
  });

  it('propagates LLM errors so the harness records them via the per-task error counter', async () => {
    const failing = buildStubLlm(() => {
      throw new Error('AI_LLM_UNAVAILABLE: no slot or pool resolves');
    });
    const ctx = buildCtx(failing.fn, blobs);

    await expect(
      purposeProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/AI_LLM_UNAVAILABLE/);
  });

  it('rejects malformed LLM output (missing reasoning field)', async () => {
    const malformed = buildStubLlm({
      category: 'request',
      confidence: 0.9,
      // @ts-expect-error -- intentional malformed shape
      reasoning: 42,
    });
    const ctx = buildCtx(malformed.fn, blobs);

    await expect(
      purposeProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/purpose_output_invalid/);
  });

  it('rejects out-of-set categories (closed-set guarantee)', async () => {
    const offSet = buildStubLlm({
      category: 'urgent_followup', // not in PURPOSE_CATEGORIES
      confidence: 0.95,
      reasoning: 'Made-up category to test the closed-set gate.',
    });
    const ctx = buildCtx(offSet.fn, blobs);

    await expect(
      purposeProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/purpose_output_invalid/);
  });
});
