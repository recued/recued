/** D-137 Trio #E — translate the LLM executor's internal
 *  `TokenUsage` shape (`@recued/llm`) into the public-facing
 *  `TokenUsageReport` (`@recued/contracts`) the chat decoder
 *  + orchestrator consume.
 *
 *  The two shapes share field names where the data already lines
 *  up; this translator exists so the engine doesn't cross-import
 *  from `packages/llm` and so the cross-package boundary stays
 *  one-directional (engine ← contracts → llm-internal).
 *
 *  Behaviour:
 *   - Required fields (input/output/total) pass through verbatim.
 *   - Optional cache/reasoning fields pass through only when
 *     populated (preserves the "absent vs zero" distinction —
 *     a provider that never echoed `cache_read_input_tokens`
 *     surfaces `undefined`, not `0`, so report-time code can
 *     tell "we don't know" from "we measured zero").
 *   - `model_id` passes through verbatim.
 *   - `attribution` translates the closed-list discriminator.
 *   - `slot_key` (the deprecated back-compat field on
 *     `TokenUsage`) is intentionally NOT mirrored to the report
 *     — `attribution` is the canonical source of truth for
 *     downstream consumers. */

import type { TokenUsageReport, TokenUsageAttribution } from '@recued/contracts';
import type { TokenUsage } from '@recued/llm';

export const tokenUsageToReport = (usage: TokenUsage): TokenUsageReport => {
  const report: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
    cache_write_input_tokens?: number;
    reasoning_tokens?: number;
    model_id?: string;
    attribution?: TokenUsageAttribution;
  } = {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  };
  if (usage.cache_read_input_tokens !== undefined) {
    report.cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_write_input_tokens !== undefined) {
    report.cache_write_input_tokens = usage.cache_write_input_tokens;
  }
  if (usage.reasoning_tokens !== undefined) {
    report.reasoning_tokens = usage.reasoning_tokens;
  }
  if (usage.model_id !== undefined) {
    report.model_id = usage.model_id;
  }
  if (usage.attribution !== undefined) {
    report.attribution = translateAttribution(usage.attribution);
  }
  return report;
};

const translateAttribution = (
  attr: NonNullable<TokenUsage['attribution']>,
): TokenUsageAttribution => {
  if (attr.kind === 'slot') return { kind: 'slot', slot_key: attr.slot_key };
  return { kind: 'pool', entry_id: attr.entry_id };
};
