/** D-123 follow-on — `purpose` enrichment producer. Second AI-driven
 *  housekeeping topic on top of the pattern shipped by `summary`
 *  (commit `5b9ad55`).
 *
 *  Classifies each mail body into one of a closed 18-category set
 *  (generic intent + business-context buckets, with `other` as the
 *  fallback). Output is `{ category, confidence, reasoning }` —
 *  `confidence` persists in the enrichment row so recipes can gate on
 *  it directly, e.g.
 *
 *    "{{data.enrichment.mail.{{item.id}}.purpose.confidence}} greater 0.7"
 *
 *  Mirrors the AI-producer contract established by `summary`:
 *
 *    - Positive `estimate_per_record_tokens()` flips the harness's
 *      `meta.idle_eligible` to false → manual-only by construction.
 *    - The body-aware mail walker (`hashMailRecordWithBody` shared with
 *      `summary` via `bin.ts`) marks rows stale when `body_inline` /
 *      `blob_hash` change, so re-syncs trigger re-classification.
 *    - Cascade-engine staling on source delete is the D-122 P4.5 hook.
 *    - LLM resolution failure throws; harness counts via per-task
 *      error counter. Pre-confirm probe in `getEnrichmentInfo` is the
 *      primary UX gate.
 *
 *  Shape A, no sidecar. The closed-set guarantee is enforced at the
 *  producer (output `category` must be in `PURPOSE_CATEGORIES`); the
 *  registry's `value_schema` accepts any object. */

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

/** D-136 P3 — producer-version hash. Bumps whenever this file's
 *  `PRODUCER_CODE_HASH` literal moves or the prompt template / category
 *  list changes. The actual `model_id` is captured at LLM-call time
 *  via `ctx.llmWithMeta` and stamped on the row separately so cross-pool
 *  invalidation (Groq free pool ↔ Anthropic BYOK) works. */
const PRODUCER_CODE_HASH = 'purpose:1';
const PROMPT_TEMPLATE_HASH = 'purpose_classify_v1';
const ADAPTER_VERSION = '@recued/llm@1.0.0';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: PRODUCER_CODE_HASH,
  model_id: '',
  prompt_template_hash: PROMPT_TEMPLATE_HASH,
  adapter_version: ADAPTER_VERSION,
  consumed_ingredients_versions: [{ slug: 'ai-classify', version: '1' }],
});

/** Minimum body length for which classification is worth running.
 *  50 chars (vs `summary`'s 100) — short messages can carry strong
 *  signal ("Got the contract — sending today.", "Are you free at 3?").
 *  The floor is just a cost guard against single-word bodies that the
 *  LLM can't classify above the floor confidence anyway. */
const MIN_BODY_CHARS = 50;

/** Per-record token estimate for the Run-Now cost preview. ~250
 *  (~200 input — bodies are usually shorter than the summary cohort —
 *  + ~50 structured output: short category string, number, sentence).
 *  Conservative bias toward over-reporting. */
const TOKEN_ESTIMATE_PER_RECORD = 250;

/** 18 closed categories. Order matters only for the prompt list — the
 *  resolver compares membership, not position. Generic-intent buckets
 *  first, business-context second, `other` as the explicit fallback.
 *
 *  When a message could fit both a generic bucket and a business
 *  context (e.g. a `request` that's also `support_request`), the
 *  classifier prefers the more specific business-context label —
 *  encoded in `llm.context` so the LLM picks rather than the producer.
 *
 *  This list is the contract: changing it is a producer revision —
 *  recipes pinning categories must keep up with the registry update. */
const PURPOSE_CATEGORIES = [
  // ── Generic intent ─────────────────────────────────────
  'request',          // explicitly asking the recipient for action
  'update',           // informational; no ask
  'follow_up',        // checking in on prior thread
  'decision',         // closing a question / committing to a plan
  'scheduling',       // calendar coordination
  'introduction',     // first-contact / intro forwarded
  'thanks',           // acknowledgment, no action expected
  'ooo',              // auto-reply / out-of-office

  // ── Business context ───────────────────────────────────
  'sales_inquiry',    // prospect / lead — inbound or outbound sales
  'support_request',  // customer support / help / troubleshooting
  'internal_update',  // company-internal announcement / standup
  'bug_report',       // issue / defect report
  'feature_request',  // feature suggestion / product feedback
  'billing',          // invoice / payment / subscription
  'contract',         // legal / agreement / NDA / terms
  'recruiting',       // hiring / candidate / interview / referral
  'newsletter',       // promotional / subscribed marketing / digest

  // ── Fallback ───────────────────────────────────────────
  'other',
] as const;

export type PurposeCategory = typeof PURPOSE_CATEGORIES[number];

const PURPOSE_CATEGORY_SET = new Set<string>(PURPOSE_CATEGORIES);

/** Priority rule passed via `llm.context`. Keeps the picking-policy
 *  out of the prompt template (which lives in `packages/llm/`) so the
 *  producer owns the selection guidance for its own categories. */
const PURPOSE_CONTEXT =
  'Pick the most specific business-context category when one applies; ' +
  'fall back to a generic intent category otherwise; use "other" only as a last resort.';

/** Inline `IngredientManifest` matching `community/ingredients/ai-classify.json`.
 *  Local to the producer, same reason as `summary`'s `aiSummarizeManifest`:
 *  the housekeeping path doesn't depend on the marketplace ingredient
 *  store. When producer count grows we'll extract a shared kernel-
 *  manifest table. */
const aiClassifyManifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'AI Classifier',
  description:
    'Picks one category from a provided list that best fits the input data.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'classification'],
  input: {
    'llm.data': null,
    'llm.categories': null,
    'llm.context': null,
    'llm.model_hint': null,
  },
  output: {
    category: 'category',
    confidence: 'confidence',
    reasoning: 'reasoning',
  },
};

interface AiClassifyOutput {
  category: PurposeCategory;
  confidence: number;
  reasoning: string;
}

const isPurposeOutput = (value: unknown): value is AiClassifyOutput => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.category !== 'string' || !PURPOSE_CATEGORY_SET.has(v.category)) return false;
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence)) return false;
  if (typeof v.reasoning !== 'string') return false;
  return true;
};

export const purposeProducer: HousekeepingEnrichmentProducer = {
  topic: 'purpose',
  source_scope: 'mail',
  // D-136 P3 — declared so the harness skip rule invalidates fresh
  // existing rows when the producer's code+model+prompt fingerprint
  // bumps even if source content is unchanged.
  producer_version_hash: baseProducerVersionHash,
  scope_read_declaration: [
    {
      collection: 'data.mail',
      sample_field_paths: ['subject', 'body_preview', 'from'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,

  async produce(ctx: HousekeepingContext, source_record: SourceRecord) {
    // D-136 P3 — switch to `ctx.llmWithMeta` so the resolved provider
    // model id flows through to the row's `model_id` column (audit §20.2).
    if (!ctx.llmWithMeta) {
      throw new Error(
        'purpose_producer_misconfigured: ctx.llmWithMeta is required for AI-driven producers',
      );
    }
    if (!ctx.blobs) {
      throw new Error(
        'purpose_producer_misconfigured: ctx.blobs is required for body resolution',
      );
    }
    const body = await fetchMailBody(source_record.data, ctx.blobs);
    if (body === null) return null;
    const trimmed = body.trim();
    if (trimmed.length < MIN_BODY_CHARS) return null;

    const input = {
      'llm.data': truncateForLlm(trimmed),
      'llm.categories': [...PURPOSE_CATEGORIES],
      'llm.context': PURPOSE_CONTEXT,
      'llm.model_hint': 'fast',
    };

    // D-145 § A.7.10 (PA9.7b) — content-addressed cache. Purpose's
    // value shape `{ category, confidence, reasoning }` is fully
    // target-agnostic given the body bytes, so two mail records carrying
    // identical bodies can share the cached LLM classification.
    const inputHash = ctx.llmResultCache ? hashLlmInput(input) : undefined;
    if (ctx.llmResultCache && inputHash !== undefined) {
      const cached = readCachedPurpose(ctx, inputHash);
      if (cached !== null) {
        ctx.llmResultCache.incrementHitCount(inputHash);
        return {
          value: cached.value,
          event_at: source_record.data.received_at,
          model_id: cached.model_id,
          ingredient_slug: 'ai-classify',
          producer_version_hash: cached.producer_version_hash,
        };
      }
    }

    const { result, model_id } = await ctx.llmWithMeta(aiClassifyManifest, input);
    if (!isPurposeOutput(result)) {
      throw new Error(
        `purpose_output_invalid: ai-classify returned non-conformant shape or out-of-set category for mail '${source_record.target_id}'`,
      );
    }

    const value = {
      category: result.category,
      confidence: result.confidence,
      reasoning: result.reasoning,
    };

    if (ctx.llmResultCache && inputHash !== undefined) {
      ctx.llmResultCache.insertOrIgnore({
        input_hash: inputHash,
        result_hash: hashEnrichmentResult(value),
        result_path: composeEnrichmentPath({
          topic: 'purpose',
          scope: 'mail',
          target_id: source_record.target_id,
        }),
        computed_at: ctx.now(),
      });
    }

    return {
      value,
      // D-136 P3 — bistemporal + dedup hashes threaded to the harness.
      // event_at is the mail's Date: header (parsed by providers from
      // `parsed.date.getTime()`); the harness was previously stamping
      // null + falling back to `ctx.now()` per audit §20.2.
      event_at: source_record.data.received_at,
      model_id,
      ingredient_slug: 'ai-classify',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};

/** D-145 § A.7.10 (PA9.7b) — resolve a cached purpose classification by
 *  input hash. Same self-healing pattern as `readCachedSummary` —
 *  dangling pointer, hash drift, schema drift all lazy-delete + fall
 *  through to a fresh LLM call. */
const readCachedPurpose = (
  ctx: HousekeepingContext,
  inputHash: string,
): {
  value: AiClassifyOutput;
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
  if (!isPurposeOutput(row.value)) {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  return {
    value: {
      category: row.value.category,
      confidence: row.value.confidence,
      reasoning: row.value.reasoning,
    },
    model_id: row.model_id ?? '',
    producer_version_hash: row.producer_version_hash ?? baseProducerVersionHash,
  };
};

export { PURPOSE_CATEGORIES };
