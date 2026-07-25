/** D-132 Phase 6 — Promotion-suggestion banner.
 *
 *  Non-blocking inline banner offered after `MANUAL_RUN_THRESHOLD`
 *  successful manual runs of an AI-surface enrichment producer held
 *  in `trust_state: 'manual'`. The system never auto-flips trust
 *  state — this banner is the user-visible promotion path. Two
 *  buttons:
 *
 *    - Promote               → fires `housekeeping.trust.write` with
 *                              `trust_state: 'auto'`. Host removes
 *                              the suggestion + reloads trust rows.
 *    - Don't ask again       → fires
 *                              `housekeeping.trust.dismiss_promotion`.
 *                              Host removes the suggestion; banner
 *                              re-arming requires user-side flip back
 *                              to manual through the detail-drawer
 *                              radios.
 *
 *  Realtime entry point: the host subscribes to the
 *  `enrichment_promotion_suggested` broadcast event (already in
 *  `DEFAULT_SUBSCRIPTIONS` per D-121 Phase 6) and inserts
 *  the payload into `state.promotionSuggestions[topic]` on each
 *  delivery. The component renders one banner per active suggestion
 *  in insertion order.
 *
 *  Spec: D-132 §A.8. */

import { e } from '../../template.js';
import { button } from '../../primitives/button.js';
import { inlineError } from '../../primitives/message.js';
import type { HousekeepingPromotionSuggestion } from './state.js';

export interface HousekeepingPromotionBannerProps {
  /** Active suggestions keyed by topic — one banner per entry,
   *  rendered in object insertion order. Empty object → no output. */
  suggestions: Record<string, HousekeepingPromotionSuggestion>;
  /** Per-topic in-flight flag; disables both buttons for that topic
   *  while a `housekeeping.trust.{write,dismiss_promotion}` rpc is
   *  pending. */
  writing: Record<string, boolean>;
  /** Per-topic last write error. Cleared on next successful write. */
  writeError: Record<string, string>;
}

const formatTokens = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return 'no estimate available';
  return `~${n.toLocaleString()} tokens`;
};

const renderOne = (
  suggestion: HousekeepingPromotionSuggestion,
  writing: boolean,
  writeError: string | undefined,
): string => {
  const { topic, manual_run_count, estimated_idle_cycle_cost_tokens } = suggestion;
  const errorBlock = writeError ? inlineError(writeError) : '';
  return `
    <div class="housekeeping-promotion-banner"
         role="status"
         aria-live="polite"
         data-topic="${e(topic)}">
      <div class="housekeeping-promotion-banner-body">
        <p class="housekeeping-promotion-banner-headline">
          You've run <code>${e(topic)}</code> ${manual_run_count} times manually. Auto-run when idle?
        </p>
        <p class="housekeeping-promotion-banner-meta">
          Auto cycle cost estimate: ${e(formatTokens(estimated_idle_cycle_cost_tokens))}.
        </p>
      </div>
      ${errorBlock}
      <div class="housekeeping-promotion-banner-actions">
        ${button({
          label: 'Don\'t ask again',
          variant: 'secondary',
          size: 'sm',
          action: 'housekeeping-promotion-dismiss',
          data: { topic },
          disabled: writing,
        })}
        ${button({
          label: writing ? 'Promoting…' : 'Promote',
          variant: 'primary',
          size: 'sm',
          action: 'housekeeping-promotion-promote',
          data: { topic },
          disabled: writing,
        })}
      </div>
    </div>
  `;
};

export const renderHousekeepingPromotionBanner = (
  props: HousekeepingPromotionBannerProps,
): string => {
  const topics = Object.keys(props.suggestions);
  if (topics.length === 0) return '';
  return `
    <section class="housekeeping-promotion-banners" aria-label="Auto-run suggestions">
      ${topics
        .map((topic) =>
          renderOne(
            props.suggestions[topic]!,
            props.writing[topic] ?? false,
            props.writeError[topic],
          ),
        )
        .join('')}
    </section>
  `;
};
