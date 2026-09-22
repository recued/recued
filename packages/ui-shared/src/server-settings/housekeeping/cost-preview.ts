/** D-123 Phase 5 — Token-cost preview for `kind: 'enrichment'`
 *  housekeeping tasks.
 *
 *  Multiplies the producer's per-record token estimate by the current
 *  source-collection size; both come from the
 *  `HousekeepingEnrichmentInfo` field that `housekeeping.status.read`
 *  surfaces for enrichment-kind tasks. Deterministic producers
 *  (`thread_signals`) report `token_estimate_per_record: 0` — the
 *  preview renders "no token cost" inline and the dialog skips the
 *  dollar-estimate row entirely.
 *
 *  Spec: D-123 §5.3. */

import type { HousekeepingEnrichmentInfo } from '@recued/contracts';

export interface HousekeepingCostPreview {
  /** Estimated total tokens for one full producer sweep — per-record
   *  estimate × current source-collection size. */
  estimated_tokens?: number;
  /** ⛔ ABSENT when the total cannot be computed: an AI producer whose
   *  `source_collection_count` is unknown (a standalone task declares no
   *  source scope). Optional ON PURPOSE — a boolean "count_known" flag can be
   *  forgotten at a render site, and forgetting it prints `0 tokens` for a run
   *  that spends them. Making the NUMBER absent turns every such site into a
   *  compile error instead. Always present on the deterministic path, where
   *  the total is a real zero rather than an unknown one. */
  /** True when the producer is deterministic (per-record estimate
   *  is 0) — the dialog renders the "no token cost — pure SQL
   *  aggregation" inline copy and omits the dollar estimate. */
  deterministic: boolean;
  /** True when the producer requires an AI path. Inverse of
   *  `deterministic`; restated explicitly so dialogs gating on
   *  AI-availability don't have to remember the negation. */
  ai_required: boolean;
  /** Pass-through from `HousekeepingEnrichmentInfo.ai_path_available`.
   *  When `ai_required && ai_path_available === false`, the dialog
   *  renders the "Configure AI in Settings → AI before running"
   *  warning and disables the Run Now button. Undefined for
   *  deterministic producers (probe is skipped) or during early
   *  boot (probe not yet populated). */
  ai_path_available?: boolean;
  /** Human-shaped tag for the warning copy. `no_byok_no_freepool`
   *  → user has no AI configured at all. `quota_exhausted` → at
   *  least one path exists but every candidate is in cooldown.
   *  `no_embeddings_model` → user has chat keys but none can do
   *  embeddings (D-131 A.3 — pure-Anthropic case + similar
   *  misconfigurations land here for vector-output producers). */
  ai_path_reason?: 'no_byok_no_freepool' | 'quota_exhausted' | 'no_embeddings_model';
  /** Estimated USD cost when a unit cost is supplied. Undefined for
   *  deterministic producers OR when the host doesn't have a unit
   *  cost wired (BYOK without a price tag). */
  estimated_cost_usd?: number;
}

export interface HousekeepingCostPreviewInput {
  enrichment: HousekeepingEnrichmentInfo;
  /** USD per token. Optional — sidebar / webapp wires this from the
   *  active model's price card; absent → cost row hidden. */
  model_unit_cost_usd?: number;
}

/** Compute the preview shown on the *Run now* dialog for an
 *  enrichment-kind task. Pure — re-renders deterministically from
 *  the same inputs. */
export const computeHousekeepingCostPreview = (
  input: HousekeepingCostPreviewInput,
): HousekeepingCostPreview => {
  const perRecord = input.enrichment.token_estimate_per_record;
  const count = input.enrichment.source_collection_count;
  // Prefer the stated fact; fall back to the old derivation when it is absent
  // so a payload without the field keeps the meaning it always had.
  const deterministic = input.enrichment.is_ai_surface !== undefined
    ? !input.enrichment.is_ai_surface
    : perRecord === 0;
  if (deterministic) {
    return {
      estimated_tokens: 0,
      deterministic: true,
      ai_required: false,
    };
  }
  // ⛔ No count ⇒ no total. The previous line multiplied by it unconditionally,
  // so an absent count read as 0 and the dialog offered "~0 tokens" for an AI
  // run. An unknown cost has to LOOK unknown.
  if (count === undefined || perRecord === undefined) {
    return {
      deterministic: false,
      ai_required: true,
      ...(input.enrichment.ai_path_available !== undefined
        ? { ai_path_available: input.enrichment.ai_path_available }
        : {}),
      ...(input.enrichment.ai_path_reason !== undefined
        ? { ai_path_reason: input.enrichment.ai_path_reason }
        : {}),
    };
  }
  const tokens = Math.max(0, Math.floor(perRecord * count));
  const aiPassthrough = {
    ai_required: true,
    ...(input.enrichment.ai_path_available !== undefined
      ? { ai_path_available: input.enrichment.ai_path_available }
      : {}),
    ...(input.enrichment.ai_path_reason !== undefined
      ? { ai_path_reason: input.enrichment.ai_path_reason }
      : {}),
  };
  if (typeof input.model_unit_cost_usd === 'number' && Number.isFinite(input.model_unit_cost_usd)) {
    return {
      estimated_tokens: tokens,
      deterministic: false,
      ...aiPassthrough,
      estimated_cost_usd: tokens * input.model_unit_cost_usd,
    };
  }
  return { estimated_tokens: tokens, deterministic: false, ...aiPassthrough };
};
