/** D-133 — Confidence drift banner.
 *
 *  Non-blocking inline banner that fires when an AI-surface
 *  enrichment producer's confidence distribution crosses the
 *  PSI severity threshold. Reuses the D-132 P6 promotion-banner
 *  shell + interaction model. Two buttons:
 *
 *    - Review     → opens the source topic's detail drawer
 *                   (auto-scroll to the Drift section).
 *    - Dismiss    → marks the banner read for this
 *                   `(source_topic, severity-transition)` pair.
 *                   Re-arms only on the next severity transition;
 *                   re-firing within the same severity bucket is
 *                   already gated server-side.
 *
 *  Realtime entry point: the host subscribes to the
 *  `enrichment_drift_detected` broadcast event (in
 *  `DEFAULT_SUBSCRIPTIONS` per D-133 P2) and writes the
 *  payload into `state.driftSignals[source_topic]` on delivery.
 *  Banner visibility derives from the persisted `dismissed_at` field
 *  on the signal row — when set + severity unchanged, banner stays
 *  collapsed.
 *
 *  Spec: D-133 §A.7. */

import { e } from '../../template.js';
import { button } from '../../primitives/button.js';
import { inlineError } from '../../primitives/message.js';
import type {
  ConfidenceDriftSignal,
  DriftSeverity,
} from '@recued/contracts';

export interface HousekeepingDriftBannerProps {
  /** Active drift signals keyed by source topic. The banner renders
   *  one entry per signal whose severity is non-`'none'` AND whose
   *  `dismissed_at` is unset. Topics absent / dismissed render
   *  nothing. */
  signals: Record<string, ConfidenceDriftSignal>;
  /** Per-source-topic in-flight flag — disables Review + Dismiss
   *  while a dismissal rpc is pending. */
  writing: Record<string, boolean>;
  /** Per-source-topic last write error. */
  writeError: Record<string, string>;
}

const SEVERITY_COPY: Record<Exclude<DriftSeverity, 'none'>, string> = {
  moderate: 'has drifted moderately',
  significant: 'has drifted significantly',
};

const isBannerEligible = (signal: ConfidenceDriftSignal): boolean => {
  if (signal.severity === 'none') return false;
  if (signal.dismissed_at !== undefined) return false;
  return true;
};

const renderOne = (
  signal: ConfidenceDriftSignal,
  writing: boolean,
  writeError: string | undefined,
): string => {
  const sev = signal.severity as Exclude<DriftSeverity, 'none'>;
  const errorBlock = writeError ? inlineError(writeError) : '';
  return `
    <div class="housekeeping-drift-banner"
         role="status"
         aria-live="polite"
         data-source-topic="${e(signal.source_topic)}"
         data-severity="${e(sev)}">
      <div class="housekeeping-drift-banner-body">
        <p class="housekeeping-drift-banner-headline">
          Confidence on <code>${e(signal.source_topic)}</code> ${e(SEVERITY_COPY[sev])} (PSI=${e(signal.psi.toFixed(2))}).
        </p>
        <p class="housekeeping-drift-banner-meta">
          This often signals a model swap or input-distribution shift.
        </p>
      </div>
      ${errorBlock}
      <div class="housekeeping-drift-banner-actions">
        ${button({
          label: 'Dismiss',
          variant: 'secondary',
          size: 'sm',
          action: 'housekeeping-drift-dismiss',
          data: { 'source-topic': signal.source_topic },
          disabled: writing,
        })}
        ${button({
          label: 'Review',
          variant: 'primary',
          size: 'sm',
          action: 'housekeeping-drift-review',
          data: { 'source-topic': signal.source_topic },
          disabled: writing,
        })}
      </div>
    </div>
  `;
};

export const renderHousekeepingDriftBanner = (
  props: HousekeepingDriftBannerProps,
): string => {
  const eligible = Object.values(props.signals).filter(isBannerEligible);
  if (eligible.length === 0) return '';
  return `
    <section class="housekeeping-drift-banners" aria-label="Drift alerts">
      ${eligible
        .map((signal) =>
          renderOne(
            signal,
            props.writing[signal.source_topic] ?? false,
            props.writeError[signal.source_topic],
          ),
        )
        .join('')}
    </section>
  `;
};
