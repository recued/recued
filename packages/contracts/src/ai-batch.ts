/** D-162 — Batch mode for the contracted `ai-*` ingredient family.
 *
 *  The contracted `ai-*` family (D-070 / D-079) is single-item: one
 *  `llm.data` value in, one contracted result object out. D-162 adds an
 *  additive **batch mode** — `llm.data` as an array of objects + a
 *  non-empty `llm.id_field` → one model call over the collection → a
 *  per-element output array, each entry the source record carried through
 *  and merged with the operation's contracted result fields.
 *
 *  This module is the **contract surface** for batch mode:
 *    - which slugs support it (N.5 — `BATCH_CAPABLE_AI_SLUGS`),
 *    - each operation's contracted result-field names (N.4 —
 *      `AI_RESULT_FIELDS`: the `llm.id_field` collision set + the
 *      carry-through merge target),
 *    - the mode-switch predicate (N.1 — `isAIBatchMode`).
 *
 *  The mechanism — batch prompt builders, the array parser, the executor
 *  carry-through merge — lives in `@recued/llm`; it cannot live here
 *  because contracts must not depend on the LLM layer. Single mode is
 *  byte-unchanged (N.7); batch mode is purely opt-in, keyed on
 *  `llm.id_field`.
 *
 *  Spec: D-162. */

import { stripCorePrefix } from './core-pack.js';

/** N.5 — the eight contracted `ai-*` slugs that support batch mode.
 *
 *  Every contracted slug that takes a single `llm.data` qualifies.
 *  `ai-compare` is the lone exclusion: it is pairwise (`llm.data_a` /
 *  `llm.data_b`), has no single `llm.data` to batch over, and "batch
 *  comparison" is a different operation out of D-162 scope (I-6).
 *
 *  Mirrors `CONTRACTED_SLUGS` in `@recued/llm` minus `ai-compare` — the
 *  list is restated here because contracts cannot import from the LLM
 *  layer. (`ai-prompt` is the uncontracted escape hatch; it was never in
 *  the contracted set.) */
export const BATCH_CAPABLE_AI_SLUGS = [
  'ai-classify',
  'ai-score',
  'ai-extract',
  'ai-summarize',
  'ai-sentiment',
  'ai-generate',
  'ai-translate',
  'ai-rewrite',
] as const;

/** A contracted `ai-*` slug that supports batch mode (N.5). */
export type BatchCapableAISlug = (typeof BATCH_CAPABLE_AI_SLUGS)[number];

/** Membership set for `BATCH_CAPABLE_AI_SLUGS` — O(1) lookup. */
export const BATCH_CAPABLE_AI_SLUG_SET: ReadonlySet<string> = new Set(
  BATCH_CAPABLE_AI_SLUGS,
);

/** True iff `slug` is a contracted `ai-*` slug that supports batch mode.
 *  §5 — a `core-<bare>` kernel alias is batch-capable iff `<bare>` is, so the
 *  prefix is stripped before the membership test. Returns a plain `boolean` (not a
 *  `slug is BatchCapableAISlug` guard) because the prefixed alias is not itself a
 *  literal `BatchCapableAISlug`; every call site uses the result as a boolean. */
export const isBatchCapableAISlug = (slug: string): boolean =>
  BATCH_CAPABLE_AI_SLUG_SET.has(stripCorePrefix(slug));

/** N.4 — the contracted result-field names each operation merges onto
 *  every batch entry. This is the single-mode return shape, by slug — the
 *  same fields the per-slug validators check.
 *
 *  Two uses:
 *    1. The N.2 collision set — `llm.id_field` MUST NOT name a result
 *       field, because one JSON key cannot be both the join id and an
 *       operation output.
 *    2. Documentation of the carry-through merge target (N.4): each batch
 *       entry is `{ …input element…, …these fields… }`.
 *
 *  `ai-extract` is intentionally absent: its result fields are
 *  recipe-defined by the call's `llm.fields`, not a fixed set (N.4 note).
 *  An `ai-extract` batch call runs its N.2 collision check against
 *  `llm.fields` instead. */
export const AI_RESULT_FIELDS = {
  'ai-classify': ['category', 'confidence', 'reasoning'],
  'ai-score': ['score', 'breakdown', 'reasoning'],
  'ai-summarize': ['summary', 'key_points'],
  'ai-sentiment': ['sentiment', 'score', 'signals'],
  'ai-generate': ['content'],
  'ai-translate': ['translated', 'source_language', 'confidence'],
  'ai-rewrite': ['rewritten'],
} as const satisfies Record<
  Exclude<BatchCapableAISlug, 'ai-extract'>,
  readonly string[]
>;

/** A batch-mode output entry (N.4): one input element shallow-merged with
 *  the operation's contracted result fields, emitted in `llm.data` input
 *  order. The concrete keys are call-defined — the input record's own
 *  fields plus the slug's `AI_RESULT_FIELDS` — so the static shape is an
 *  open record; the executor builds these deterministically. */
export type AIBatchEntry = Record<string, unknown>;

/** N.1 — the batch-mode switch. A contracted `ai-*` call runs in batch
 *  mode iff `llm.id_field` is a non-empty string **and** `llm.data` is an
 *  array. `llm.id_field` is the *only* switch: an array `llm.data` without
 *  `llm.id_field` stays single mode (the array is the single datum — e.g.
 *  `ai-summarize` over a collection → one summary, unchanged).
 *
 *  This predicate tests the input shape only. Whether the *slug* admits
 *  batch mode (`ai-compare` does not — I-6) is a separate gate, enforced
 *  by the manifest validator and the prompt builder. */
export const isAIBatchMode = (input: Record<string, unknown>): boolean => {
  const idField = input['llm.id_field'];
  return (
    typeof idField === 'string' &&
    idField !== '' &&
    Array.isArray(input['llm.data'])
  );
};
