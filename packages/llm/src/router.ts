import type { ModelHint } from '@recued/contracts';
import type { LLMConfig, LLMSlot } from './types.js';
import { LLMError } from './types.js';

/** Result of resolving a slot for a given model hint. */
export interface ResolvedSlot {
  slot: LLMSlot;
  /** Which slot was selected: 'slot_1' or 'slot_2'. Used for per-slot token tracking. */
  slot_key: 'slot_1' | 'slot_2';
  /** The hint we actually honored. May differ from requested when the user lacks slot_2. */
  resolved_hint: ModelHint;
  /** True when we fell back to slot_1 because slot_2 was missing. */
  used_fallback: boolean;
}

/** Select the appropriate slot for a model hint.
 *
 *  Resolution order (per decision made when building @recued/llm):
 *  - Default hint is `quality` — AI functions are Pro-gated, so primary usage
 *    weights quality over speed. Ingredient manifests can override via
 *    `input["llm.model_hint"] = "fast"` for genuinely high-volume ingredients.
 *  - `fast` → slot_1, fall back to slot_2
 *  - `quality` / `thinking` → slot_2, fall back to slot_1
 *  - `thinking` downgrades silently to `quality` when slot lacks `supports_thinking`
 *    (the engine logs this but does not fail).
 *
 *  Free/anonymous users who only have slot_1 get the same slot regardless of hint.
 *  This is intentional: hint is a Pro feature; free users have no choice to express.
 */
export const resolveSlot = (
  hint: ModelHint | undefined,
  config: LLMConfig,
): ResolvedSlot => {
  const resolved_hint: ModelHint = hint ?? 'quality';

  if (!config.slot_1 && !config.slot_2) {
    throw new LLMError(
      'AI_LLM_UNAVAILABLE',
      'No LLM slot configured. Configure at least one provider in Settings.',
    );
  }

  if (resolved_hint === 'fast') {
    const slot = config.slot_1 ?? config.slot_2;
    const slot_key = config.slot_1 ? 'slot_1' as const : 'slot_2' as const;
    return { slot: slot as LLMSlot, slot_key, resolved_hint, used_fallback: config.slot_1 == null };
  }

  // quality or thinking → prefer slot_2, fall back to slot_1
  const slot = config.slot_2 ?? config.slot_1;
  const slot_key = config.slot_2 ? 'slot_2' as const : 'slot_1' as const;
  return {
    slot: slot as LLMSlot,
    slot_key,
    resolved_hint,
    used_fallback: config.slot_2 == null,
  };
};

/** Clamp max_tokens to the slot's ceiling if declared, else use the requested value.
 *  `fast` requests get a smaller budget (4000) than `quality`/`thinking` (8000). */
export const computeMaxTokens = (hint: ModelHint, slot: LLMSlot): number => {
  const requested = hint === 'fast' ? 4000 : 8000;
  if (slot.max_output_tokens == null) return requested;
  return Math.min(requested, slot.max_output_tokens);
};

/** Whether extended reasoning should be enabled for this hint + slot combo. */
export const shouldEnableThinking = (hint: ModelHint, slot: LLMSlot): boolean =>
  hint === 'thinking' && slot.supports_thinking === true;
