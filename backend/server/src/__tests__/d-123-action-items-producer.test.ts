/** D-123 follow-on — `action_items` enrichment producer tests.
 *
 *  Mirrors the structural shape of `d-123-purpose-producer.test.ts`
 *  with deltas:
 *
 *    1. The contracted ingredient is `ai-extract`, so the LLM stub
 *       returns `{ action_items: [...] }`.
 *    2. The producer accepts both string-form items (`['Send forecast', ...]`)
 *       and object-form items (`[{description, owner?, due?}, ...]`)
 *       so the LLM has freedom to pick a shape — coverage for both.
 *    3. Empty extraction is preserved as `{ action_items: [] }`,
 *       NOT null. Validates the row-creation invariant for downstream
 *       length-filtering recipes.
 *    4. The producer caps at 10 items even when the LLM returns more.
 *
 *  The producer is pure transform — body fetch + LLM call + output
 *  validation — so the tests don't need a live SQLite stack. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ITEMS_PER_BODY,
  actionItemsProducer,
} from '../housekeeping/producers/action-items.js';
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
    'the board pack? Also, please loop in Carol on the Acme expansion thread, and ' +
    "let's lock the regional split before Monday's pipeline review.\n\nThanks,\nAlice",
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
    | Record<string, unknown>
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
  // D-136 P3 — actionItemsProducer reads `ctx.llmWithMeta`. Wrap.
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

describe('actionItemsProducer.estimate_per_record_tokens', () => {
  it('returns a positive token estimate so the harness flips idle_eligible to false', () => {
    const tokens = actionItemsProducer.estimate_per_record_tokens();
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('actionItemsProducer.produce', () => {
  let llm: StubLlm;
  let blobs: BlobStore;

  beforeEach(() => {
    llm = buildStubLlm({
      action_items: [
        { description: 'Send the revised forecast by Friday', owner: 'me', due: 'Friday' },
        { description: 'Loop in Carol on the Acme expansion thread', owner: 'me' },
        { description: "Lock the regional split before Monday's review", due: 'Monday' },
      ],
    });
    blobs = buildBlobs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { action_items: [...] } structured object form', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(out).not.toBeNull();
    const items = (out?.value as { action_items: Array<Record<string, unknown>> }).action_items;
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      description: 'Send the revised forecast by Friday',
      owner: 'me',
      due: 'Friday',
    });
    expect(items[1]).toEqual({
      description: 'Loop in Carol on the Acme expansion thread',
      owner: 'me',
    });
    expect(items[2]).toEqual({
      description: "Lock the regional split before Monday's review",
      due: 'Monday',
    });
    expect(out?.sidecar_text).toBeUndefined();
    expect(out?.sidecar_vector).toBeUndefined();
  });

  it('accepts string-form items (LLM returned a flat list of descriptions)', async () => {
    const stringForm = buildStubLlm({
      action_items: [
        'Send the revised forecast by Friday',
        'Loop in Carol on the Acme expansion thread',
      ],
    });
    const ctx = buildCtx(stringForm.fn, blobs);
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord()));

    const items = (out?.value as { action_items: Array<Record<string, unknown>> }).action_items;
    expect(items).toEqual([
      { description: 'Send the revised forecast by Friday' },
      { description: 'Loop in Carol on the Acme expansion thread' },
    ]);
  });

  it('passes ["action_items"] as llm.fields to ai-extract', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(llm.capturedInput?.['llm.fields']).toEqual(['action_items']);
  });

  it('reads body_inline when present and passes it as llm.data', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord();
    await actionItemsProducer.produce(ctx, buildSourceRecord(record));

    expect(blobs.get).not.toHaveBeenCalled();
    expect(llm.capturedInput?.['llm.data']).toBe(record.body_inline);
  });

  it('reads from CAS via blob_hash when body_inline is absent', async () => {
    const blobBytes = Buffer.from(
      'Could you send the contract by Friday and confirm the start date? '.repeat(3),
      'utf8',
    );
    const blobsWithBody = buildBlobs({
      get: vi.fn(async (hash: string) => {
        expect(hash).toBe('cas-hash-003');
        return blobBytes;
      }),
    });
    const ctx = buildCtx(llm.fn, blobsWithBody);
    const record = buildRecord({ body_inline: undefined, blob_hash: 'cas-hash-003' });
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(record));

    expect(out).not.toBeNull();
    expect(blobsWithBody.get).toHaveBeenCalledWith('cas-hash-003');
    expect(llm.capturedInput?.['llm.data']).toBe(blobBytes.toString('utf8').trim());
  });

  it('returns null when neither body_inline nor blob_hash is set', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: undefined, blob_hash: undefined });
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(record));

    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('returns null when body is shorter than the 100-char floor', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: 'Got the contract. Thanks!' });
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(record));

    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('preserves empty array (NOT null) when LLM finds no action items', async () => {
    const empty = buildStubLlm({ action_items: [] });
    const ctx = buildCtx(empty.fn, blobs);
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(out).not.toBeNull();
    expect((out?.value as { action_items: unknown[] }).action_items).toEqual([]);
  });

  it('preserves empty array when LLM returns null for the field (no signal)', async () => {
    // ai-extract's contract: per-field null when the LLM finds no signal.
    // Producer treats this as zero items rather than throwing.
    const noSignal = buildStubLlm({ action_items: null });
    const ctx = buildCtx(noSignal.fn, blobs);
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(out).not.toBeNull();
    expect((out?.value as { action_items: unknown[] }).action_items).toEqual([]);
  });

  it('caps at 10 items even when LLM returns more (mis-extraction guard)', async () => {
    const flood = buildStubLlm({
      action_items: Array.from({ length: 25 }, (_, i) => `Item ${i + 1}`),
    });
    const ctx = buildCtx(flood.fn, blobs);
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord()));

    const items = (out?.value as { action_items: unknown[] }).action_items;
    expect(items).toHaveLength(MAX_ITEMS_PER_BODY);
    expect(MAX_ITEMS_PER_BODY).toBe(10);
  });

  it('drops malformed items but keeps well-formed siblings', async () => {
    const mixed = buildStubLlm({
      action_items: [
        'Send the forecast',
        { description: 'Schedule meeting', owner: 'me' },
        { not_a_description: 'oops' },           // missing description → dropped
        '',                                       // empty string → dropped
        null,                                     // null item → dropped
        { description: 'Lock the split', due: 'Monday' },
      ],
    });
    const ctx = buildCtx(mixed.fn, blobs);
    const out = await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord()));

    const items = (out?.value as { action_items: Array<Record<string, unknown>> }).action_items;
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.description)).toEqual([
      'Send the forecast',
      'Schedule meeting',
      'Lock the split',
    ]);
  });

  it('truncates very long bodies before calling the LLM', async () => {
    const longBody = 'X'.repeat(80_000);
    const ctx = buildCtx(llm.fn, blobs);
    const record = buildRecord({ body_inline: longBody });
    await actionItemsProducer.produce(ctx, buildSourceRecord(record));

    const passedData = llm.capturedInput?.['llm.data'] as string;
    expect(passedData.length).toBeLessThanOrEqual(32_000);
    expect(passedData.startsWith('X')).toBe(true);
  });

  it('passes model_hint=fast (cheap free-pool / slot_1)', async () => {
    const ctx = buildCtx(llm.fn, blobs);
    await actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(llm.capturedInput?.['llm.model_hint']).toBe('fast');
  });

  it('propagates LLM errors so the harness records them via the per-task error counter', async () => {
    const failing = buildStubLlm(() => {
      throw new Error('AI_LLM_UNAVAILABLE: no slot or pool resolves');
    });
    const ctx = buildCtx(failing.fn, blobs);

    await expect(
      actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/AI_LLM_UNAVAILABLE/);
  });

  it('rejects malformed top-level shape (action_items not an array)', async () => {
    const malformed = buildStubLlm({
      action_items: 'not an array',
    });
    const ctx = buildCtx(malformed.fn, blobs);

    await expect(
      actionItemsProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/action_items_output_invalid/);
  });
});
