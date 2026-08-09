/** D-123 follow-on — `summary` enrichment producer. First AI-driven
 *  housekeeping producer; canary for the AI-producer pattern.
 *
 *  Mirrors the canary `thread_signals` shape but swaps deterministic
 *  SQL aggregation for an `ai-summarize` LLM call. The producer is
 *  manual-only by construction — which needs BOTH `ai_surface: 'chat'`
 *  and a positive `estimate_per_record_tokens()`. This header used to
 *  credit the token estimate alone (via `meta.idle_eligible`); that is
 *  not what `buildEnrichmentProducerTask` does, and `ai_surface` was
 *  missing here for exactly that reason — leaving the topic on
 *  trust_state 'auto', outside the Pause-AI window and the pool policy
 *  so the idle scheduler never fires it — the user clicks Run Now,
 *  the dialog shows the cost preview + AI-availability probe, and
 *  only then does the cycle invoke this producer.
 *
 *  The harness's hash-skip rule paired with the body-aware mail
 *  walker (`hashMailRecordWithBody` in `source-walkers.ts`) gives
 *  re-derive-on-body-change semantics: the canonical hash includes
 *  `body_inline` + `blob_hash` so a re-sync that updates the body
 *  flips the row to stale. Cascade-engine staling on source delete
 *  is handled by D-122 P4.5's eager hook.
 *
 *  Output:
 *    - `value.summary`     — concise summary string (≤ ~200 words)
 *    - `value.key_points`  — 3-5 extracted bullets
 *    - `sidecar_text`      — same as `summary` so the FTS sidecar
 *                            (`data_enrichment_fts`) indexes summaries
 *                            for searchable browse.
 *
 *  Failure modes:
 *    - No body / body too short  → `produce` returns `null`; harness
 *      doesn't write a row.
 *    - LLM resolution failure    → `LLMError('AI_LLM_UNAVAILABLE')`
 *      propagates to the harness's per-task error counter. The
 *      pre-confirm probe in `getEnrichmentInfo` keeps the Run-Now
 *      dialog from offering the call when no path resolves; this
 *      is the race-window safety net for "AI key removed between
 *      probe and confirm."
 *    - LLM output malformed      → re-thrown as the parser's error;
 *      harness records it. Same per-task error semantics. */

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

import { fetchMailBody, truncateForLlm } from './_mail-body.js';

/** D-136 P3 — producer-version hash. Bumps on producer-code or
 *  prompt-template revisions; `model_id` is captured per-call via
 *  `ctx.llmWithMeta` and stamped on the row. */
const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'summary:1',
  model_id: '',
  prompt_template_hash: 'summary_focus_v1',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-summarize', version: '1' }],
});

/** Minimum characters in a trimmed body for which a summary is
 *  worth running. Sub-100-char messages summarise to themselves —
 *  pure cost without signal. The threshold is a soft convention,
 *  not a contract; sibling producers pick their own floor. */
const MIN_BODY_CHARS = 100;

/** Per-record token estimate exposed to the Run-Now cost preview.
 *  ~500 input + ~100 output for the typical mail body. Chosen
 *  conservatively: the preview should over-report mildly so the
 *  user is not surprised by a higher actual bill. */
const TOKEN_ESTIMATE_PER_RECORD = 600;

/** Inline `IngredientManifest` matching `community/ingredients/ai-summarize.json`.
 *  Kept local to the producer rather than loading the JSON at runtime
 *  so the housekeeping path doesn't depend on the marketplace
 *  ingredient store. Future AI producers (`purpose`, `action_items`,
 *  ...) follow the same pattern; if the count grows we'll extract a
 *  shared kernel-manifest table. */
const aiSummarizeManifest: IngredientManifest = {
  slug: 'ai-summarize',
  name: 'AI Summarizer',
  description:
    'Produces a short summary and extracted key points from long-form text.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'summarization'],
  input: {
    'llm.data': null,
    'llm.max_length': null,
    'llm.focus': null,
    'llm.model_hint': null,
  },
  output: {
    summary: 'summary',
    key_points: 'key_points',
  },
};

interface AiSummarizeOutput {
  summary: string;
  key_points: ReadonlyArray<string>;
}

const isSummaryOutput = (value: unknown): value is AiSummarizeOutput =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AiSummarizeOutput).summary === 'string' &&
  Array.isArray((value as AiSummarizeOutput).key_points) &&
  (value as AiSummarizeOutput).key_points.every((p) => typeof p === 'string');

export const summaryProducer: HousekeepingEnrichmentProducer = {
  // D-136 P3 — see purpose.ts for the rationale on harness skip-rule integration.
  producer_version_hash: baseProducerVersionHash,
  topic: 'summary',
  source_scope: 'mail',
  scope_read_declaration: [
    {
      collection: 'data.mail',
      sample_field_paths: ['subject', 'body_preview', 'from', 'thread_id'],
    },
  ],
  // ⛔ WITHOUT THIS THE PRODUCER IS NOT AN AI SURFACE, and it calls an
  //    LLM. `enrichment-producer.ts` derives
  //    `isAiSurface = ai_surface !== undefined && estimate_per_record_tokens() > 0`
  //    — BOTH terms, so a positive token estimate alone is not enough. The
  //    header above used to claim the estimate flipped it "manual-only by
  //    construction"; it did not. With `isAiSurface` false the topic
  //    resolved to trust_state 'auto' (idle-eligible, running AI with no
  //    owner action), the `isAiSurface && isAiPaused()` check was skipped so
  //    Pause-AI did not stop it, and `wrapCtxWithForceLayer` was not applied
  //    so the owner's pool_policy was not enforced either.
  //    The field's own doc names this producer as the 'chat' case.
  ai_surface: 'chat',
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,

  async produce(ctx: HousekeepingContext, source_record: SourceRecord) {
    if (!ctx.llmWithMeta) {
      throw new Error(
        'summary_producer_misconfigured: ctx.llmWithMeta is required for AI-driven producers',
      );
    }
    if (!ctx.blobs) {
      throw new Error(
        'summary_producer_misconfigured: ctx.blobs is required for body resolution',
      );
    }
    const body = await fetchMailBody(source_record.data, ctx.blobs);
    if (body === null) return null;
    const trimmed = body.trim();
    if (trimmed.length < MIN_BODY_CHARS) return null;

    const input = {
      'llm.data': truncateForLlm(trimmed),
      'llm.max_length': 200,
      'llm.focus': 'key actions, decisions, and asks',
      'llm.model_hint': 'fast',
    };

    // D-145 § A.7.10 (PA9.7b) — content-addressed cache. Summary's
    // value shape `{ summary, key_points }` is fully target-agnostic
    // given the body bytes (no per-call metadata in `value`), so two
    // mail records carrying identical bodies (forwarded chains,
    // template emails, signature-only replies above MIN_BODY_CHARS)
    // can share the cached LLM result. Opt-in via `ctx.llmResultCache`
    // being wired — production fills it from `bin.ts`; tests +
    // cache-disabled cycles leave it undefined and the producer
    // degrades to the legacy compute-every-time path.
    const inputHash = ctx.llmResultCache ? hashLlmInput(input) : undefined;
    if (ctx.llmResultCache && inputHash !== undefined) {
      const cached = readCachedSummary(ctx, inputHash);
      if (cached !== null) {
        ctx.llmResultCache.incrementHitCount(inputHash);
        return {
          value: cached.value,
          sidecar_text: cached.value.summary,
          event_at: source_record.data.received_at,
          model_id: cached.model_id,
          ingredient_slug: 'ai-summarize',
          producer_version_hash: cached.producer_version_hash,
        };
      }
    }

    const { result, model_id } = await ctx.llmWithMeta(aiSummarizeManifest, input);
    if (!isSummaryOutput(result)) {
      throw new Error(
        `summary_output_invalid: ai-summarize returned non-conformant shape for mail '${source_record.target_id}'`,
      );
    }

    const value = {
      summary: result.summary,
      key_points: result.key_points,
    };

    // Cache-insert is keyed on the row this producer is about to
    // write — the harness upserts immediately after produce() returns
    // so the pointer resolves on subsequent reads. Concurrent races
    // are tolerated by the lazy-delete-on-missing-path branch in
    // `readCachedSummary`.
    if (ctx.llmResultCache && inputHash !== undefined) {
      ctx.llmResultCache.insertOrIgnore({
        input_hash: inputHash,
        result_hash: hashEnrichmentResult(value),
        result_path: composeEnrichmentPath({
          topic: 'summary',
          scope: 'mail',
          target_id: source_record.target_id,
        }),
        computed_at: ctx.now(),
      });
    }

    return {
      value,
      sidecar_text: result.summary,
      // D-136 P3 — bistemporal + dedup hashes (audit §20.2 fix).
      event_at: source_record.data.received_at,
      model_id,
      ingredient_slug: 'ai-summarize',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};

/** D-145 § A.7.10 (PA9.7b) — resolve a cached summary by input hash.
 *  Reads the cache pointer + the pointed-to row's value + metadata;
 *  verifies the value hash matches; falls back to lazy delete on
 *  dangling / drift. Returns null on miss OR on any self-healing
 *  trigger (caller falls through to a fresh ctx.llmWithMeta call). */
const readCachedSummary = (
  ctx: HousekeepingContext,
  inputHash: string,
): {
  value: AiSummarizeOutput;
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
  if (!isSummaryOutput(row.value)) {
    // Defensive — schema drift on the cached row.
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  return {
    value: { summary: row.value.summary, key_points: row.value.key_points },
    model_id: row.model_id ?? '',
    producer_version_hash: row.producer_version_hash ?? baseProducerVersionHash,
  };
};
