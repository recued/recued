/** D-131 A.3 — `embedding` enrichment producer. First vector-output
 *  housekeeping topic on the harness shipped by D-123 P4.
 *
 *  Computes a semantic vector for a mail body via the `ai-embed`
 *  kernel ingredient (D-131 A.2). Output `value: { dimensions, model }`
 *  records the cohort metadata recipes need to filter compatible
 *  vectors; the float32 vector itself goes to the
 *  `data_enrichment_vector_index` sidecar via `sidecar_vector` so the
 *  enrichment-store FK CASCADE handles staleness + delete propagation
 *  the same way it does for FTS sidecars.
 *
 *  This is the substrate the A.17 `semantic_cluster` producer reads
 *  out of — reading rows where `topic = 'embedding'` and `model =
 *  '<picked>'` from the enrichment store gives the input set, the
 *  vector_index sidecar gives the float buffer to compute similarity.
 *
 *  Mirrors the AI-producer contract established by `summary` /
 *  `purpose` / `action_items`:
 *
 *    - Positive `estimate_per_record_tokens()` flips the harness's
 *      `meta.idle_eligible` to false → manual-only by construction.
 *      User clicks Run Now, the dialog shows the embeddings cost
 *      preview (input tokens × per-record floor; embeddings have no
 *      decode tokens), then the cycle dispatches.
 *    - `ai_surface: 'embeddings'` routes the Run-Now availability
 *      probe to `probeEmbeddingsPathAvailability` (vs the chat probe
 *      the other AI producers use). The pure-Anthropic case surfaces
 *      `no_embeddings_model` instead of "available" — without this
 *      discriminator the dialog would offer the call and the
 *      embedding adapter would throw at use-time.
 *    - Body-aware mail walker (`hashMailRecordWithBody` shared with
 *      `summary` / `purpose` / `action_items` via `bin.ts`) marks rows
 *      stale on body change. Same body → same hash → skip on next walk.
 *    - Cascade-engine staling on source delete is the D-122 P4.5 hook.
 *
 *  Failure modes:
 *    - No body / body too short → `produce` returns `null`; harness
 *      doesn't write a row.
 *    - `ctx.embed` not wired → throws `embedding_producer_misconfigured`
 *      (engineering error; bin.ts always wires it when llmConfig is set).
 *    - `executeEmbedding` throws (no path, quota exhausted, timeout) →
 *      propagates; harness's per-task error counter catches.
 *    - Provider returned an empty / non-finite vector → producer throws
 *      `embedding_output_invalid`. The vendor adapters (P2) already
 *      defend against malformed responses; this is a belt-and-suspenders
 *      check at the producer side. */

import {
  computeProducerVersionHash,
  type IngredientManifest,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import {
  composeEnrichmentPath,
  hashEnrichmentResult,
  hashLlmInput,
  parseEnrichmentPath,
} from '../llm-result-cache-store.js';

import { fetchMailBody } from './_mail-body.js';

/** D-136 P3 — producer-version hash. The embedding producer's
 *  `model_id` flips on the FIRST call once `ctx.embed` returns the
 *  resolved adapter's model — embeddings are deterministic given
 *  model so the model identity IS the producer identity (audit §27.5
 *  per-ingredient table — `ai-embed` regen on `model_change`). */
const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'embedding:1',
  model_id: '',
  prompt_template_hash: '',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-embed', version: '1' }],
});

/** Minimum body length for which embedding is worth running. 50
 *  matches `purpose`'s floor: vectors of very short strings are
 *  noisier than the cost is worth, but anything past a sentence
 *  carries usable signal for similarity search. */
const MIN_BODY_CHARS = 50;

/** Embeddings-specific input cap. Tighter than the chat producers'
 *  32_000 because Gemini's `text-embedding-004` accepts only ~2048
 *  tokens (~8K chars); OpenAI's `text-embedding-3-*` family accepts
 *  8192 tokens (~32K chars) but cost scales with input. 8K is the
 *  cross-vendor safe ceiling and keeps cost bounded; the ai-embed
 *  surface is a single forward pass, not a token-by-token decode,
 *  so a slightly truncated body still yields a usable vector. */
const MAX_EMBED_INPUT_CHARS = 8_000;

/** Per-record token estimate for the Run-Now cost preview. ~250
 *  input tokens for a typical mail body; 0 output tokens (embeddings
 *  return a vector, not text). Conservative — long bodies clip at
 *  MAX_EMBED_INPUT_CHARS so the upper bound is bounded. Pricing on
 *  text-embedding-3-small is ~$0.00002 / 1K tokens; this estimate
 *  errs slightly high so the preview is mildly pessimistic. */
const TOKEN_ESTIMATE_PER_RECORD = 250;

/** Inline `IngredientManifest` matching `community/ingredients/ai-embed.json`.
 *  Local-to-producer for the same reason `summary` / `purpose` /
 *  `action_items` keep their manifests inline: housekeeping path
 *  doesn't depend on the marketplace ingredient store. The
 *  isEmbeddingsManifest discriminator (`kind:'ai'` + `output.vector`)
 *  routes this manifest through `executeEmbedding` rather than
 *  `executeLLM`. */
const aiEmbedManifest: IngredientManifest = {
  slug: 'ai-embed',
  name: 'AI Embed',
  description:
    'Compute an embedding vector for input text. Routes to the configured embeddings provider.',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['kernel', 'ai', 'embeddings', 'vector'],
  input: {
    'llm.data': null,
    'llm.dimensions': null,
  },
  output: {
    vector: 'vector',
    dimensions: 'dimensions',
    model: 'model',
  },
};

/** Truncate body for embeddings input. Soft cut at MAX_EMBED_INPUT_CHARS.
 *  Producer-local (not in `_mail-body.ts`) because the cap is
 *  embeddings-specific — chat producers can take 32K, embeddings can't. */
const truncateForEmbed = (s: string): string =>
  s.length <= MAX_EMBED_INPUT_CHARS ? s : s.slice(0, MAX_EMBED_INPUT_CHARS);

/** Convert a `number[]` from the embeddings adapter into a Float32
 *  Buffer the vector_index sidecar consumes. Float32 (not Float64)
 *  matches the ~1e-7 precision typical of cosine similarity — Float64
 *  would double storage with no measurable signal gain. Uses
 *  `Float32Array.from` so non-finite values would surface as NaN
 *  (the adapter already filters those, but the producer-side check
 *  below is a belt-and-suspenders guard). */
const vectorToBuffer = (vector: number[]): Buffer => {
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

/** Validate the executor's output: vector must be a non-empty array
 *  of finite numbers, dimensions must match `vector.length`, model
 *  must be a non-empty string. Anything else throws
 *  `embedding_output_invalid`. */
const validateEmbedOutput = (
  raw: { vector: number[]; dimensions: number; model: string },
  target_id: string,
): void => {
  if (!Array.isArray(raw.vector) || raw.vector.length === 0) {
    throw new Error(
      `embedding_output_invalid: empty or non-array vector for mail '${target_id}'`,
    );
  }
  if (raw.vector.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(
      `embedding_output_invalid: vector contains non-finite values for mail '${target_id}'`,
    );
  }
  if (raw.dimensions !== raw.vector.length) {
    throw new Error(
      `embedding_output_invalid: dimensions field (${raw.dimensions}) disagrees with vector length (${raw.vector.length}) for mail '${target_id}'`,
    );
  }
  if (typeof raw.model !== 'string' || raw.model.length === 0) {
    throw new Error(
      `embedding_output_invalid: missing model identifier for mail '${target_id}'`,
    );
  }
};

export const embeddingProducer: HousekeepingEnrichmentProducer = {
  // D-136 P3 — harness skip-rule version-hash invalidation. Note: the
  // wrapped per-call hash is RE-COMPOSED with the resolved model id at
  // upsert time (see produce()'s output.producer_version_hash); the
  // static `baseProducerVersionHash` here is the lower-bound fingerprint
  // — when the static fingerprint flips (code/adapter change), all rows
  // re-derive even before the per-call resolution swaps model id.
  producer_version_hash: baseProducerVersionHash,
  topic: 'embedding',
  source_scope: 'mail',
  ai_surface: 'embeddings',
  scope_read_declaration: [
    {
      collection: 'data.mail',
      sample_field_paths: ['subject', 'body_text'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,

  async produce(ctx: HousekeepingContext, source_record: SourceRecord) {
    if (!ctx.embed) {
      throw new Error(
        'embedding_producer_misconfigured: ctx.embed is required for vector-output producers',
      );
    }
    if (!ctx.blobs) {
      throw new Error(
        'embedding_producer_misconfigured: ctx.blobs is required for body resolution',
      );
    }
    const body = await fetchMailBody(source_record.data, ctx.blobs);
    if (body === null) return null;
    const trimmed = body.trim();
    if (trimmed.length < MIN_BODY_CHARS) return null;

    const input = {
      'llm.data': truncateForEmbed(trimmed),
    };

    // D-145 § A.7.10 (PA9.7) — content-addressed cache. Embedding is
    // deterministic given (input, model); identical bodies across
    // distinct mail records (forwarded chains, signature blocks,
    // template emails) reuse the previously-computed vector. Opt-in
    // via `ctx.llmResultCache` being wired — production fills it from
    // `bin.ts`; tests + cache-disabled cycles leave it undefined and
    // the producer degrades to the legacy compute-every-time path.
    const inputHash = ctx.llmResultCache ? hashLlmInput(input) : undefined;
    if (ctx.llmResultCache && inputHash !== undefined) {
      const cached = readCachedEmbedding(ctx, inputHash);
      if (cached !== null) {
        ctx.llmResultCache.incrementHitCount(inputHash);
        return {
          value: cached.value,
          sidecar_vector: cached.sidecar_vector,
          event_at: source_record.data.received_at,
          model_id: cached.model_id,
          ingredient_slug: 'ai-embed',
          producer_version_hash: cached.producer_version_hash,
        };
      }
    }

    const result = await ctx.embed(aiEmbedManifest, input);
    validateEmbedOutput(result, source_record.target_id);

    const value = {
      dimensions: result.dimensions,
      model: result.model,
    };

    // Cache-insert is keyed on the row this producer is about to
    // write — the harness upserts immediately after produce() returns,
    // so the pointer resolves on subsequent reads. Concurrent races
    // are tolerated by the lazy-delete-on-missing-path branch in
    // `readCachedEmbedding`.
    if (ctx.llmResultCache && inputHash !== undefined) {
      ctx.llmResultCache.insertOrIgnore({
        input_hash: inputHash,
        result_hash: hashEnrichmentResult(value),
        result_path: composeEnrichmentPath({
          topic: 'embedding',
          scope: 'mail',
          target_id: source_record.target_id,
        }),
        computed_at: ctx.now(),
      });
    }

    return {
      value,
      sidecar_vector: vectorToBuffer(result.vector),
      // D-136 P3 — `ctx.embed` already returns `model` (the resolved
      // provider model id); thread to row's `model_id` column. Compose
      // a per-call producer_version_hash that folds in the resolved
      // model so cross-model row partitioning works (audit §20.2).
      event_at: source_record.data.received_at,
      model_id: result.model,
      ingredient_slug: 'ai-embed',
      producer_version_hash: result.model
        ? computeProducerVersionHash({
            producer_code_hash: 'embedding:1',
            model_id: result.model,
            prompt_template_hash: '',
            adapter_version: '@recued/llm@1.0.0',
            consumed_ingredients_versions: [{ slug: 'ai-embed', version: '1' }],
          })
        : baseProducerVersionHash,
    };
  },
};

/** D-145 § A.7.10 (PA9.7) — resolve a cached embedding by input hash.
 *  Reads the cache pointer + the pointed-to row's value + sidecar +
 *  metadata; verifies the value hash matches; falls back to lazy
 *  delete on dangling / drift. Returns null on miss OR on any
 *  self-healing trigger (caller falls through to a fresh ctx.embed
 *  call). */
const readCachedEmbedding = (
  ctx: HousekeepingContext,
  inputHash: string,
): {
  value: { dimensions: number; model: string };
  sidecar_vector: Buffer;
  model_id: string;
  producer_version_hash: string;
} | null => {
  if (!ctx.llmResultCache) return null;
  const entry = ctx.llmResultCache.lookup(inputHash);
  if (!entry) return null;
  const parsed = parseEnrichmentPath(entry.result_path);
  if (!parsed || parsed.kind !== 'shape_a') {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  // Pull the first row at (topic, scope, target_id) — only one writer
  // per (topic, scope, target_id, authored_by) by construction; the
  // cache wraps over the authored_by axis so the first match wins.
  const rows = ctx.enrichmentStore.list({
    topic: parsed.topic,
    scope: parsed.scope,
    target_id: parsed.target_id,
    fresh_only: true,
    limit: 1,
  });
  const row = rows[0];
  if (!row || row.value === null || row.value === undefined) {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  if (hashEnrichmentResult(row.value) !== entry.result_hash) {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  const sidecar = ctx.enrichmentStore.getSidecarVector(row._id);
  if (!sidecar) {
    // Vector sidecar missing — row exists but the FK-linked blob is
    // gone. Treat as drift, lazy-delete + fall through.
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  // Defensive: the cached value must carry the embedding shape
  // (`{ dimensions, model }`) we expect; reject anything else as
  // schema drift.
  const value = row.value as { dimensions?: unknown; model?: unknown };
  if (typeof value.dimensions !== 'number' || typeof value.model !== 'string') {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  return {
    value: { dimensions: value.dimensions, model: value.model },
    sidecar_vector: sidecar,
    model_id: row.model_id ?? value.model,
    producer_version_hash:
      row.producer_version_hash ?? baseProducerVersionHash,
  };
};

export { MAX_EMBED_INPUT_CHARS, vectorToBuffer };
