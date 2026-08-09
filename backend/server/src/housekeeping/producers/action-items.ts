/** D-123 follow-on — `action_items` enrichment producer. Third
 *  AI-driven housekeeping topic on the pattern shipped by `summary`
 *  (commit `5b9ad55`) + `purpose` (commit `6257327`).
 *
 *  Extracts to-dos / commitments / asks from a mail body via
 *  `ai-extract`. Output `value: { action_items: [{description,
 *  owner?, due?}, ...] }`. Recipes filter empty inboxes via
 *  `{{...action_items.action_items.length}} greater 0`, sort by
 *  due date, route by owner — same compositional surface as
 *  `purpose` and `summary`.
 *
 *  Mirrors the AI-producer contract:
 *
 *    - `ai_surface: 'chat'` + a positive `estimate_per_record_tokens()`
 *      are BOTH required to make this an AI surface — that pair is what
 *      resolves the topic to trust_state 'manual', honours the Pause-AI
 *      window, and applies the owner's pool policy. This header used to
 *      claim the token estimate alone did it; it did not, and the field
 *      was missing here for exactly that reason.
 *    - Body-aware mail walker (`hashMailRecordWithBody` shared with
 *      `summary` / `purpose` via `bin.ts`) marks rows stale when
 *      `body_inline` / `blob_hash` change.
 *    - Cascade-engine staling on source delete is the D-122 P4.5 hook.
 *    - LLM resolution failure throws; harness counts via per-task
 *      error counter. Pre-confirm probe in `getEnrichmentInfo` is the
 *      primary UX gate.
 *
 *  Shape A, no sidecar. The producer's load-bearing job is shape
 *  validation: ai-extract returns a permissive `Record<string, unknown>`
 *  so the producer enforces array structure + per-item `description`
 *  presence + 10-item cap. Out-of-shape rows throw
 *  `action_items_output_invalid` rather than silently coercing —
 *  same closed-set discipline as `purpose`.
 *
 *  Empty result is preserved as `{ action_items: [] }` (NOT null) so
 *  recipes can filter on `length === 0` without coalesce gymnastics
 *  and so the enrichment-row hash skip-rule can short-circuit on the
 *  next walk.
 *
 *  Owner / due fields are intentionally free-form strings — the LLM
 *  picks "me" / "Alice" / "Friday" / "next week" rather than
 *  normalised IDs / ISO dates. Recipes that need normalisation can
 *  downstream-classify with another producer or transform; the
 *  ai-extract contract already returns free-form text and forcing
 *  normalisation here would either require a second LLM call per
 *  item (cost) or fail brittly on edge cases (correctness). */

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

/** D-136 P3 — producer-version hash. */
const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'action_items:1',
  model_id: '',
  prompt_template_hash: 'action_items_extract_v1',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-extract', version: '1' }],
});

/** Minimum body length for which extraction is worth running.
 *  100 chars (same as `summary`) — action items need surrounding
 *  context to be meaningful; "Got it." has zero extractable signal.
 *  Below the floor → producer returns null, harness skips. */
const MIN_BODY_CHARS = 100;

/** Per-record token estimate for the Run-Now cost preview. ~400
 *  (~300 input — typical mail body — + ~100 structured output: array
 *  of items, each ~20-30 tokens for description + optional owner /
 *  due). Slightly higher than `purpose` (250) because the structured
 *  output is bigger. */
const TOKEN_ESTIMATE_PER_RECORD = 400;

/** Hard cap on returned items. Bodies that yield more than 10 are
 *  almost always mis-extracted (e.g. the LLM treating each sentence
 *  as a to-do); truncating beats throwing because partial signal is
 *  still useful. The cap is a producer-side guard, not enforced by
 *  ai-extract. */
const MAX_ITEMS_PER_BODY = 10;

/** Inline `IngredientManifest` matching `community/ingredients/ai-extract.json`.
 *  Local-to-producer, same reason as summary's `aiSummarizeManifest`
 *  + purpose's `aiClassifyManifest`: housekeeping path doesn't depend
 *  on the marketplace ingredient store. When producer count crosses
 *  some threshold we'll extract a shared kernel-manifest table. */
const aiExtractManifest: IngredientManifest = {
  slug: 'ai-extract',
  name: 'AI Field Extractor',
  description:
    'Extracts a caller-specified set of fields from unstructured input into a flat object.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'extraction'],
  input: {
    'llm.data': null,
    'llm.fields': null,
    'llm.model_hint': null,
  },
  output: {
    extracted: 'dynamic_fields_per_llm_fields_input',
  },
};

export interface ActionItem {
  /** The to-do / commitment / ask. ≤ 200 chars after trim. */
  description: string;
  /** Free-form owner string. The LLM picks "me" / "alice" / "the team"
   *  / unspecified — recipes can downstream-classify if they need
   *  normalised IDs. Undefined when the LLM can't infer an owner. */
  owner?: string;
  /** Free-form due string. The LLM picks "Friday" / "2026-04-30" /
   *  "next sprint" / unspecified. Recipes parse with a date transform
   *  if they need an absolute timestamp. Undefined when not present. */
  due?: string;
}

export interface ActionItemsValue {
  action_items: ReadonlyArray<ActionItem>;
}

/** Coerce one LLM-returned item into the strict `ActionItem` shape.
 *  Two valid input shapes:
 *
 *    - `string`            → `{ description: <string> }` (LLM
 *                            returned a flat list of descriptions)
 *    - `{ description, owner?, due? }` → validated object form
 *
 *  Anything else returns null and the caller drops it from the array.
 *  Keeping the producer tolerant of either shape rather than forcing
 *  the LLM into a strict object form trades model-prompt control for
 *  resilience — the `ai-extract` system prompt is fixed in
 *  `packages/llm/src/prompts.ts` and we don't want to fork it for
 *  one producer. */
const coerceActionItem = (raw: unknown): ActionItem | null => {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    return { description: trimmed.slice(0, 200) };
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.description !== 'string') return null;
    const description = obj.description.trim();
    if (description.length === 0) return null;
    const item: ActionItem = { description: description.slice(0, 200) };
    if (typeof obj.owner === 'string' && obj.owner.trim().length > 0) {
      item.owner = obj.owner.trim().slice(0, 100);
    }
    if (typeof obj.due === 'string' && obj.due.trim().length > 0) {
      item.due = obj.due.trim().slice(0, 100);
    }
    return item;
  }
  return null;
};

/** Validate top-level LLM output. ai-extract's contract says the
 *  result is `Record<string, unknown>` keyed by `llm.fields`; we
 *  asked for exactly `['action_items']` so the result must have an
 *  `action_items` key whose value is an array. Anything else throws
 *  `action_items_output_invalid` — same discipline as purpose's
 *  closed-set guarantee. */
const parseActionItemsOutput = (
  raw: unknown,
): ActionItem[] | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  // ai-extract returns `null` per-field when the LLM finds no signal.
  // Treat that as an empty list (preserve the row, don't throw).
  if (obj.action_items === null || obj.action_items === undefined) return [];
  if (!Array.isArray(obj.action_items)) return null;
  const items: ActionItem[] = [];
  for (const raw_item of obj.action_items) {
    const coerced = coerceActionItem(raw_item);
    if (coerced !== null) items.push(coerced);
    if (items.length >= MAX_ITEMS_PER_BODY) break;
  }
  return items;
};

export const actionItemsProducer: HousekeepingEnrichmentProducer = {
  // D-136 P3 — harness skip-rule version-hash invalidation.
  producer_version_hash: baseProducerVersionHash,
  topic: 'action_items',
  source_scope: 'mail',
  scope_read_declaration: [
    {
      collection: 'data.mail',
      sample_field_paths: ['subject', 'body_text', 'from', 'to'],
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
        'action_items_producer_misconfigured: ctx.llmWithMeta is required for AI-driven producers',
      );
    }
    if (!ctx.blobs) {
      throw new Error(
        'action_items_producer_misconfigured: ctx.blobs is required for body resolution',
      );
    }
    const body = await fetchMailBody(source_record.data, ctx.blobs);
    if (body === null) return null;
    const trimmed = body.trim();
    if (trimmed.length < MIN_BODY_CHARS) return null;

    const input = {
      'llm.data': truncateForLlm(trimmed),
      'llm.fields': ['action_items'],
      'llm.model_hint': 'fast',
    };

    // D-145 § A.7.10 (PA9.7b) — content-addressed cache. Action items'
    // value shape `{ action_items }` is fully target-agnostic given
    // the body bytes — identical bodies (template emails, forwarded
    // chains above MIN_BODY_CHARS) share the cached extraction.
    const inputHash = ctx.llmResultCache ? hashLlmInput(input) : undefined;
    if (ctx.llmResultCache && inputHash !== undefined) {
      const cached = readCachedActionItems(ctx, inputHash);
      if (cached !== null) {
        ctx.llmResultCache.incrementHitCount(inputHash);
        return {
          value: cached.value,
          event_at: source_record.data.received_at,
          model_id: cached.model_id,
          ingredient_slug: 'ai-extract',
          producer_version_hash: cached.producer_version_hash,
        };
      }
    }

    const { result, model_id } = await ctx.llmWithMeta(aiExtractManifest, input);
    const items = parseActionItemsOutput(result);
    if (items === null) {
      throw new Error(
        `action_items_output_invalid: ai-extract returned non-conformant shape for mail '${source_record.target_id}'`,
      );
    }

    const value = {
      action_items: items,
    };

    if (ctx.llmResultCache && inputHash !== undefined) {
      ctx.llmResultCache.insertOrIgnore({
        input_hash: inputHash,
        result_hash: hashEnrichmentResult(value),
        result_path: composeEnrichmentPath({
          topic: 'action_items',
          scope: 'mail',
          target_id: source_record.target_id,
        }),
        computed_at: ctx.now(),
      });
    }

    return {
      value,
      // D-136 P3 — bistemporal + dedup hashes (audit §20.2 fix).
      event_at: source_record.data.received_at,
      model_id,
      ingredient_slug: 'ai-extract',
      producer_version_hash: baseProducerVersionHash,
    };
  },
};

/** D-145 § A.7.10 (PA9.7b) — resolve a cached action_items extraction
 *  by input hash. Same self-healing as the sibling body-only
 *  producers — lazy-delete on dangling / hash drift / schema drift. */
const readCachedActionItems = (
  ctx: HousekeepingContext,
  inputHash: string,
): {
  value: ActionItemsValue;
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
  // Re-validate the cached value's shape — cache writer + this reader
  // share the same `ActionItem` invariants. Coerce per-item via the
  // same path the LLM-call branch uses so any drift triggers
  // lazy-delete + recompute.
  const raw = row.value as Record<string, unknown>;
  if (!Array.isArray(raw.action_items)) {
    ctx.llmResultCache.delete(inputHash);
    return null;
  }
  const items: ActionItem[] = [];
  for (const item_raw of raw.action_items) {
    const coerced = coerceActionItem(item_raw);
    if (coerced !== null) items.push(coerced);
    if (items.length >= MAX_ITEMS_PER_BODY) break;
  }
  return {
    value: { action_items: items },
    model_id: row.model_id ?? '',
    producer_version_hash: row.producer_version_hash ?? baseProducerVersionHash,
  };
};

export { MAX_ITEMS_PER_BODY };
