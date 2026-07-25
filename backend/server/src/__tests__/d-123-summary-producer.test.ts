/** D-123 follow-on — `summary` enrichment producer tests.
 *
 *  Drives `summaryProducer.produce()` against a stub
 *  `HousekeepingContext` that captures the LLM input + body resolution
 *  paths. The producer is pure transform — body fetch + LLM call +
 *  output validation — so the tests don't need a live SQLite stack
 *  (the harness handles cursor / hash bookkeeping; covered by the
 *  thread_signals tests). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { summaryProducer } from '../housekeeping/producers/summary.js';
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
    'Hi Bob,\n\nQ3 review meets next Tuesday at 10:00. Please bring the revised forecast and ' +
    'the customer expansion notes. We need to lock the regional split before Friday so finance ' +
    'can update the board pack. Let me know if Tuesday morning works for you, otherwise we can ' +
    'push to Wednesday afternoon.\n\nThanks,\nAlice',
  ...overrides,
});

const buildSourceRecord = (data: CollectionRecord): SourceRecord => ({
  target_id: data.record_id,
  data,
  cursor_token: data.record_id,
});

interface StubLlm {
  /** Mock returned by `vi.fn` so tests can use `toHaveBeenCalled` /
   *  `mock.calls[i]` directly. The producer's parameter type
   *  (`HousekeepingLlmExecute`) accepts this via TS's
   *  variance-on-promise rules — Mock<...> is a callable assignable
   *  to the interface signature. */
  fn: ReturnType<typeof vi.fn>;
  capturedManifest: IngredientManifest | null;
  capturedInput: Record<string, unknown> | null;
}

const buildStubLlm = (
  result:
    | { summary: string; key_points: string[] }
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
  // D-136 P3 — summaryProducer reads `ctx.llmWithMeta`. Wrap the same
  // `llm` mock so existing fixtures' response queues work unchanged.
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

describe('summaryProducer.estimate_per_record_tokens', () => {
  it('returns a positive token estimate so the harness flips idle_eligible to false', () => {
    const tokens = summaryProducer.estimate_per_record_tokens();
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('summaryProducer.produce', () => {
  let llm: StubLlm;
  let blobs: BlobStore;

  beforeEach(() => {
    llm = buildStubLlm({
      summary: 'Q3 review on Tuesday — bring revised forecast and customer notes.',
      key_points: [
        'Meeting Tuesday 10:00',
        'Bring revised forecast',
        'Lock regional split before Friday',
      ],
    });
    blobs = buildBlobs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { summary, key_points } shape with sidecar_text matching the summary', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord();
    const out = await summaryProducer.produce(ctx, buildSourceRecord(record));

    expect(out).not.toBeNull();
    expect(out?.value).toEqual({
      summary: 'Q3 review on Tuesday — bring revised forecast and customer notes.',
      key_points: [
        'Meeting Tuesday 10:00',
        'Bring revised forecast',
        'Lock regional split before Friday',
      ],
    });
    expect(out?.sidecar_text).toBe('Q3 review on Tuesday — bring revised forecast and customer notes.');
  });

  it('reads body_inline when present and passes it as llm.data', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord();
    await summaryProducer.produce(ctx, buildSourceRecord(record));

    expect(blobs.get).not.toHaveBeenCalled();
    expect(llm.capturedInput).not.toBeNull();
    expect(llm.capturedInput?.['llm.data']).toBe(record.body_inline);
  });

  it('reads from CAS via blob_hash when body_inline is absent', async () => {
    const blobBytes = Buffer.from('Long body fetched from CAS storage. '.repeat(20), 'utf8');
    const blobsWithBody = buildBlobs({
      get: vi.fn(async (hash: string) => {
        expect(hash).toBe('cas-hash-001');
        return blobBytes;
      }),
    });
    const ctx = buildCtx(llm.fn, blobsWithBody);
    const record = buildRecord({ body_inline: undefined, blob_hash: 'cas-hash-001' });
    const out = await summaryProducer.produce(ctx, buildSourceRecord(record));

    expect(out).not.toBeNull();
    expect(blobsWithBody.get).toHaveBeenCalledWith('cas-hash-001');
    // Producer trims trailing whitespace before passing to the LLM.
    expect(llm.capturedInput?.['llm.data']).toBe(blobBytes.toString('utf8').trim());
  });

  it('returns null when neither body_inline nor blob_hash is set', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: undefined, blob_hash: undefined });
    const out = await summaryProducer.produce(ctx, buildSourceRecord(record));

    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('returns null when body is shorter than the 100-char floor', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: 'Got it. Thanks!' });
    const out = await summaryProducer.produce(ctx, buildSourceRecord(record));

    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('truncates very long bodies before calling the LLM', async () => {
    const longBody = 'X'.repeat(80_000);
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: longBody });
    await summaryProducer.produce(ctx, buildSourceRecord(record));

    const passedData = llm.capturedInput?.['llm.data'] as string;
    expect(passedData.length).toBeLessThanOrEqual(32_000);
    // Truncation should preserve the leading bytes — first chars must
    // come from the original body, not be replaced by an ellipsis.
    expect(passedData.startsWith('X')).toBe(true);
  });

  it('passes model_hint=fast so summarisation biases toward slot_1 / cheap free-pool', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    await summaryProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(llm.capturedInput?.['llm.model_hint']).toBe('fast');
  });

  it('propagates LLM errors so the harness records them via the per-task error counter', async () => {
    const failing = buildStubLlm(() => {
      throw new Error('AI_LLM_UNAVAILABLE: no slot or pool resolves');
    });
    const ctx = buildCtx(failing.fn, blobs);

    await expect(
      summaryProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/AI_LLM_UNAVAILABLE/);
  });

  it('rejects malformed LLM output (missing key_points array)', async () => {
    const malformed = buildStubLlm({
      summary: 'a summary',
      // @ts-expect-error -- intentional malformed shape
      key_points: 'not an array',
    });
    const ctx = buildCtx(malformed.fn, blobs);

    await expect(
      summaryProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/summary_output_invalid/);
  });
});
