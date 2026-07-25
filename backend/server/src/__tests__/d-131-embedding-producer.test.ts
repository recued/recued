/** D-131 A.3 — `embedding` enrichment producer tests.
 *
 *  Mirrors the structural shape of the other AI-driven producer tests
 *  (`d-123-summary-producer`, `d-123-purpose-producer`,
 *  `d-123-action-items-producer`) with deltas:
 *
 *    1. Vector output instead of structured text — output validation
 *       checks `vector` finiteness, `dimensions` consistency, and
 *       non-empty `model`.
 *    2. Stub `ctx.embed` (not `ctx.llm`) since the producer's
 *       `ai_surface = 'embeddings'` routes through the embeddings
 *       executor.
 *    3. Sidecar serialisation — `vectorToBuffer` packs `number[]` into
 *       a Float32 buffer; tests assert the round-trip preserves the
 *       vector and that `byteLength === vector.length × 4`.
 *    4. Tighter input cap — embeddings can't take 32 KB; tests cover
 *       the 8 KB MAX_EMBED_INPUT_CHARS truncation path.
 *
 *  The producer is a pure transform — body fetch + embed call + output
 *  validation + Float32 serialisation — so the tests don't need a live
 *  SQLite stack. */

import { describe, expect, it, vi } from 'vitest';

import {
  embeddingProducer,
  MAX_EMBED_INPUT_CHARS,
  vectorToBuffer,
} from '../housekeeping/producers/embedding.js';
import type {
  HousekeepingContext,
  HousekeepingEmbedExecute,
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
    'the board pack? Also, please loop in Carol on the Acme expansion thread.\n\nThanks,\nAlice',
  ...overrides,
});

const buildSourceRecord = (data: CollectionRecord): SourceRecord => ({
  target_id: data.record_id,
  data,
  cursor_token: data.record_id,
});

interface StubEmbed {
  fn: ReturnType<typeof vi.fn>;
  capturedManifest: IngredientManifest | null;
  capturedInput: Record<string, unknown> | null;
}

const buildStubEmbed = (
  result:
    | { vector: number[]; dimensions: number; model: string }
    | (() => never)
    | (() => Promise<never>),
): StubEmbed => {
  const stub: StubEmbed = {
    capturedManifest: null,
    capturedInput: null,
    fn: vi.fn(),
  };
  stub.fn = vi.fn(
    async (manifest: IngredientManifest, input: Record<string, unknown>) => {
      stub.capturedManifest = manifest;
      stub.capturedInput = input;
      if (typeof result === 'function') return result();
      return result;
    },
  );
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
  embed: ReturnType<typeof vi.fn>,
  blobs: BlobStore,
): HousekeepingContext => ({
  db: {} as never,
  bus: {} as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => 1_700_000_000_000,
  emitAuditRow: () => undefined,
  embed: embed as unknown as HousekeepingEmbedExecute,
  blobs,
});

// 1536-dim sample — text-embedding-3-small default. Constants are
// arbitrary but finite so the validator passes.
const sampleVector = (dim = 1536): number[] =>
  Array.from({ length: dim }, (_, i) => Math.sin(i / 17) * 0.1);

// ────────────────────────────────────────────────────────────────
// Producer surface contract
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer surface contract', () => {
  it('declares ai_surface=embeddings so the Run-Now probe routes correctly', () => {
    expect(embeddingProducer.ai_surface).toBe('embeddings');
  });

  it('returns a positive token estimate so the harness flips idle_eligible to false', () => {
    const tokens = embeddingProducer.estimate_per_record_tokens();
    expect(tokens).toBeGreaterThan(0);
  });

  it('targets the mail scope', () => {
    expect(embeddingProducer.source_scope).toBe('mail');
  });

  it('targets the embedding registry topic', () => {
    expect(embeddingProducer.topic).toBe('embedding');
  });
});

// ────────────────────────────────────────────────────────────────
// vectorToBuffer helper
// ────────────────────────────────────────────────────────────────

describe('vectorToBuffer', () => {
  it('packs number[] into a Float32 buffer of length 4 × dimensions', () => {
    const v = [0.1, -0.2, 0.3, -0.4];
    const buf = vectorToBuffer(v);
    expect(buf.byteLength).toBe(v.length * 4);
  });

  it('round-trips the vector through Float32 quantisation', () => {
    const v = [0.5, -0.25, 0.125, -0.0625];
    const buf = vectorToBuffer(v);
    // Read back as Float32Array — Buffer.buffer is the underlying
    // ArrayBuffer; map at the same byte offset / length.
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    expect(Array.from(f32)).toEqual(v);
  });

  it('handles a 1536-dim production-shaped vector', () => {
    const v = sampleVector(1536);
    const buf = vectorToBuffer(v);
    expect(buf.byteLength).toBe(1536 * 4);
  });
});

// ────────────────────────────────────────────────────────────────
// Producer behavior
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer.produce', () => {
  it('returns value + sidecar_vector for a normal mail body', async () => {
    const vec = sampleVector(1536);
    const embed = buildStubEmbed({
      vector: vec,
      dimensions: 1536,
      model: 'text-embedding-3-small',
    });
    const ctx = buildCtx(embed.fn, buildBlobs());
    const out = await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(out).not.toBeNull();
    expect(out?.value).toEqual({
      dimensions: 1536,
      model: 'text-embedding-3-small',
    });
    expect(out?.sidecar_vector).toBeInstanceOf(Buffer);
    expect(out?.sidecar_vector?.byteLength).toBe(1536 * 4);
    expect(out?.sidecar_text).toBeUndefined();
  });

  it('reads body_inline when present and passes it as llm.data', async () => {
    const embed = buildStubEmbed({
      vector: sampleVector(768),
      dimensions: 768,
      model: 'models/text-embedding-004',
    });
    const blobs = buildBlobs();
    const ctx = buildCtx(embed.fn, blobs);
    const record = buildRecord();
    await embeddingProducer.produce(ctx, buildSourceRecord(record));

    expect(blobs.get).not.toHaveBeenCalled();
    expect(embed.capturedInput?.['llm.data']).toBe(record.body_inline);
  });

  it('reads from CAS via blob_hash when body_inline is absent', async () => {
    const embed = buildStubEmbed({
      vector: sampleVector(1536),
      dimensions: 1536,
      model: 'text-embedding-3-small',
    });
    const blobBytes = Buffer.from(
      'A long mail body fetched from CAS storage that exceeds the floor. '.repeat(3),
      'utf8',
    );
    const blobs = buildBlobs({
      get: vi.fn(async (hash: string) => {
        expect(hash).toBe('cas-hash-007');
        return blobBytes;
      }),
    });
    const ctx = buildCtx(embed.fn, blobs);
    const record = buildRecord({
      body_inline: undefined,
      blob_hash: 'cas-hash-007',
    });
    const out = await embeddingProducer.produce(ctx, buildSourceRecord(record));

    expect(out).not.toBeNull();
    expect(blobs.get).toHaveBeenCalledWith('cas-hash-007');
    expect(embed.capturedInput?.['llm.data']).toBe(blobBytes.toString('utf8').trim());
  });

  it('returns null when neither body_inline nor blob_hash is set', async () => {
    const embed = buildStubEmbed({ vector: [], dimensions: 0, model: 'unused' });
    const ctx = buildCtx(embed.fn, buildBlobs());
    const record = buildRecord({ body_inline: undefined, blob_hash: undefined });
    const out = await embeddingProducer.produce(ctx, buildSourceRecord(record));

    expect(out).toBeNull();
    expect(embed.fn).not.toHaveBeenCalled();
  });

  it('returns null when body is shorter than the 50-char floor', async () => {
    const embed = buildStubEmbed({ vector: [], dimensions: 0, model: 'unused' });
    const ctx = buildCtx(embed.fn, buildBlobs());
    const record = buildRecord({ body_inline: 'Got it. Thanks.' });
    const out = await embeddingProducer.produce(ctx, buildSourceRecord(record));

    expect(out).toBeNull();
    expect(embed.fn).not.toHaveBeenCalled();
  });

  it('truncates very long bodies before calling the embed adapter (8K cap)', async () => {
    const longBody = 'X'.repeat(80_000);
    const embed = buildStubEmbed({
      vector: sampleVector(1536),
      dimensions: 1536,
      model: 'text-embedding-3-small',
    });
    const ctx = buildCtx(embed.fn, buildBlobs());
    const record = buildRecord({ body_inline: longBody });
    await embeddingProducer.produce(ctx, buildSourceRecord(record));

    const passedData = embed.capturedInput?.['llm.data'] as string;
    expect(passedData.length).toBe(MAX_EMBED_INPUT_CHARS);
    expect(passedData.length).toBe(8_000);
    expect(passedData.startsWith('X')).toBe(true);
  });

  it('does NOT pass llm.dimensions or llm.model_hint — the adapter picks defaults', async () => {
    // The producer leaves Matryoshka truncation to the adapter / slot
    // configuration. Future widening to per-recipe `dimensions` is out
    // of A.3 scope.
    const embed = buildStubEmbed({
      vector: sampleVector(1536),
      dimensions: 1536,
      model: 'text-embedding-3-small',
    });
    const ctx = buildCtx(embed.fn, buildBlobs());
    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(embed.capturedInput).not.toHaveProperty('llm.dimensions');
    expect(embed.capturedInput).not.toHaveProperty('llm.model_hint');
  });

  it('calls the adapter with the ai-embed manifest', async () => {
    const embed = buildStubEmbed({
      vector: sampleVector(1536),
      dimensions: 1536,
      model: 'text-embedding-3-small',
    });
    const ctx = buildCtx(embed.fn, buildBlobs());
    await embeddingProducer.produce(ctx, buildSourceRecord(buildRecord()));

    expect(embed.capturedManifest?.slug).toBe('ai-embed');
    expect(embed.capturedManifest?.kind).toBe('ai');
    // Discriminator: `output.vector` non-empty string makes the
    // manifest an embeddings ingredient (`isEmbeddingsManifest`).
    expect(typeof embed.capturedManifest?.output?.vector).toBe('string');
  });

  it('throws embedding_producer_misconfigured when ctx.embed is absent', async () => {
    const ctx: HousekeepingContext = {
      db: {} as never,
      bus: {} as never,
      enrichmentStore: {} as never,
      recipeStore: {} as never,
      now: () => 1,
      emitAuditRow: () => undefined,
      blobs: buildBlobs(),
    };
    await expect(
      embeddingProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/embedding_producer_misconfigured.*ctx\.embed/);
  });

  it('throws embedding_producer_misconfigured when ctx.blobs is absent', async () => {
    const embed = buildStubEmbed({
      vector: sampleVector(1536),
      dimensions: 1536,
      model: 'text-embedding-3-small',
    });
    const ctx: HousekeepingContext = {
      db: {} as never,
      bus: {} as never,
      enrichmentStore: {} as never,
      recipeStore: {} as never,
      now: () => 1,
      emitAuditRow: () => undefined,
      embed: embed.fn as unknown as HousekeepingEmbedExecute,
    };
    await expect(
      embeddingProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/embedding_producer_misconfigured.*ctx\.blobs/);
  });

  it('propagates AI_LLM_UNAVAILABLE so the harness records it via the per-task error counter', async () => {
    const failing = buildStubEmbed(() => {
      throw new Error('AI_LLM_UNAVAILABLE: no embeddings path resolves');
    });
    const ctx = buildCtx(failing.fn, buildBlobs());

    await expect(
      embeddingProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/AI_LLM_UNAVAILABLE/);
  });

  it('rejects an empty vector with embedding_output_invalid', async () => {
    const empty = buildStubEmbed({
      vector: [],
      dimensions: 0,
      model: 'text-embedding-3-small',
    });
    const ctx = buildCtx(empty.fn, buildBlobs());

    await expect(
      embeddingProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/embedding_output_invalid.*empty.*vector/);
  });

  it('rejects a vector containing non-finite values', async () => {
    const nanVec = buildStubEmbed({
      vector: [0.1, NaN, 0.3],
      dimensions: 3,
      model: 'text-embedding-3-small',
    });
    const ctx = buildCtx(nanVec.fn, buildBlobs());

    await expect(
      embeddingProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/embedding_output_invalid.*non-finite/);
  });

  it('rejects a vector whose length disagrees with the dimensions field', async () => {
    const mismatch = buildStubEmbed({
      vector: [0.1, 0.2, 0.3],
      dimensions: 1536,
      model: 'text-embedding-3-small',
    });
    const ctx = buildCtx(mismatch.fn, buildBlobs());

    await expect(
      embeddingProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/embedding_output_invalid.*dimensions.*disagrees/);
  });

  it('rejects an empty model string', async () => {
    const noModel = buildStubEmbed({
      vector: sampleVector(1536),
      dimensions: 1536,
      model: '',
    });
    const ctx = buildCtx(noModel.fn, buildBlobs());

    await expect(
      embeddingProducer.produce(ctx, buildSourceRecord(buildRecord())),
    ).rejects.toThrow(/embedding_output_invalid.*missing model/);
  });
});

// ────────────────────────────────────────────────────────────────
// Harness integration — real enrichment store + vector_index sidecar
// ────────────────────────────────────────────────────────────────

describe('embeddingProducer through buildEnrichmentProducerTask + real store', () => {
  it('writes to data_enrichment AND data_enrichment_vector_index in the same upsert', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const Database = (await import('better-sqlite3')).default;
    const { createEnrichmentStore } = await import('../storage/enrichment-store.js');
    const { buildEnrichmentProducerTask } = await import(
      '../housekeeping/enrichment-producer.js'
    );
    const dir = mkdtempSync(join(tmpdir(), 'd-131-embedding-'));
    try {
      const db = new Database(join(dir, 'test.db'));
      db.pragma('journal_mode = WAL');
      const store = createEnrichmentStore(db);

      const vec = sampleVector(1536);
      const embed = buildStubEmbed({
        vector: vec,
        dimensions: 1536,
        model: 'text-embedding-3-small',
      });

      // Stub walker — yields one mail record, hashes by JSON of the
      // target id (the producer test doesn't care about hash content
      // beyond stability).
      const record = buildRecord();
      const sourceRecord = buildSourceRecord(record);
      const walker = {
        walkAfter: function* () {
          yield sourceRecord;
        },
        fetchOne: () => sourceRecord,
        hashOf: () => 'fixed-hash-v1',
      };

      const task = buildEnrichmentProducerTask({ producer: embeddingProducer, walker });

      const ctx: HousekeepingContext = {
        db,
        bus: {
          emit: () => undefined,
          subscribe: () => () => undefined,
          dispose: () => undefined,
        } as never,
        enrichmentStore: store,
        recipeStore: {} as never,
        now: () => 1_700_000_000_000,
        emitAuditRow: () => undefined,
        embed: embed.fn as unknown as HousekeepingEmbedExecute,
        blobs: buildBlobs(),
      };

      const result = await task.step(
        ctx,
        { kind: 'topic', topic: 'embedding', scope: 'mail', max_target_id_seen: '' },
        10_000,
      );

      expect(result.status).toBe('complete');

      // Verify the enrichment row was written with value metadata.
      const row = store.getByRecord(
        'embedding',
        'mail',
        record.record_id,
        'system.housekeeping.embedding',
      );
      expect(row).not.toBeNull();
      expect(row?.value).toEqual({
        dimensions: 1536,
        model: 'text-embedding-3-small',
      });

      // Verify the vector_index sidecar carries the float32 buffer.
      const sidecar = db
        .prepare('SELECT vector FROM data_enrichment_vector_index WHERE enrichment_id = ?')
        .get(row!._id) as { vector: Buffer } | undefined;
      expect(sidecar).toBeDefined();
      expect(sidecar?.vector.byteLength).toBe(1536 * 4);
      const f32 = new Float32Array(
        sidecar!.vector.buffer,
        sidecar!.vector.byteOffset,
        sidecar!.vector.byteLength / 4,
      );
      // Float32 quantisation is lossy at the 7th significant digit;
      // sample-test the first few entries against the original.
      expect(f32[0]).toBeCloseTo(vec[0]!, 5);
      expect(f32[100]).toBeCloseTo(vec[100]!, 5);

      // Sidecar drops on row delete (FK CASCADE).
      store.deleteById(row!._id);
      const sidecarAfterDelete = db
        .prepare('SELECT vector FROM data_enrichment_vector_index WHERE enrichment_id = ?')
        .get(row!._id);
      expect(sidecarAfterDelete).toBeUndefined();

      store.close();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
