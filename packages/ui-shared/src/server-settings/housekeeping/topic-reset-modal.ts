/** D-136 §A.12 P7.G — topic-reset dry-run-then-confirm modal.
 *
 *  Substrate panic button surfaced from the Settings → Server →
 *  Housekeeping per-topic detail drawer's "Reset" button. The host
 *  fires `housekeeping.topic.reset` with NO `confirmation_token` to
 *  enter the dry-run path; the response carries `impact` (rows to
 *  tombstone, pinned protected, PSI baselines to drop, estimated
 *  recompute tokens) + a single-use `confirmation_token` (5 min TTL).
 *  Clicking Confirm fires the same rpc with the token; the response's
 *  `applied_summary` populates the post-confirm view.
 *
 *  data-actions emitted (per spec § A.12):
 *    - `housekeeping-reset-open`        — drawer button, opens modal in
 *      'previewing' phase (host fires the dry-run rpc immediately)
 *    - `housekeeping-reset-confirm`     — preview view, fires confirm
 *    - `housekeeping-reset-toggle-psi`  — preview view checkbox; flips
 *      `resetPsiBaselines` + clears the token (substrate binds tokens
 *      to the request shape so flipping requires a re-mint)
 *    - `housekeeping-reset-cancel`      — close modal at any phase
 *    - `housekeeping-reset-done`        — applied view, closes modal
 *    - `housekeeping-reset-retry`       — error view, re-fires the
 *      dry-run rpc
 *
 *  Spec: D-136 §A.12 + §A.13.5. */

import { e } from '../../template.js';
import { button } from '../../primitives/button.js';
import { inlineError } from '../../primitives/message.js';
import type { HousekeepingResetModalState } from './state.js';

export interface HousekeepingTopicResetModalProps {
  state: HousekeepingResetModalState;
  /** "now" for the token-expiry relative formatter. Tests pin a
   *  fixed timestamp so renders stay deterministic. */
  now: number;
  /** Optional USD per-token cost for the dollar estimate next to the
   *  recompute-token line. The host wires this from the active
   *  model's price card; absent → cost row hidden. */
  modelUnitCostUsd?: number;
}

const formatExpiresIn = (expires_at: number, now: number): string => {
  const ms = Math.max(0, expires_at - now);
  if (ms <= 0) return 'expired';
  const minutes = Math.ceil(ms / 60_000);
  return `expires in ${minutes} min`;
};

const formatTokens = (n: number): string => n.toLocaleString();

const renderImpactSummary = (
  impact: NonNullable<HousekeepingResetModalState['impact']>,
  modelUnitCostUsd: number | undefined,
): string => {
  const costLine = (() => {
    if (impact.estimated_recompute_tokens === 0) {
      return `<dd class="housekeeping-reset-impact-tokens">No additional cost — recompute is deterministic.</dd>`;
    }
    const tokens = formatTokens(impact.estimated_recompute_tokens);
    if (modelUnitCostUsd !== undefined) {
      const cost = (impact.estimated_recompute_tokens * modelUnitCostUsd).toFixed(2);
      return `<dd class="housekeeping-reset-impact-tokens">~${tokens} tokens ≈ $${cost} on next housekeeping cycle.</dd>`;
    }
    return `<dd class="housekeeping-reset-impact-tokens">~${tokens} tokens on next housekeeping cycle.</dd>`;
  })();
  return `
    <dl class="housekeeping-reset-impact">
      <dt>Rows to tombstone</dt>
      <dd>${impact.rows_to_tombstone.toLocaleString()}</dd>
      <dt>Pinned (preserved)</dt>
      <dd>${impact.pinned_protected.toLocaleString()}</dd>
      <dt>PSI baselines to drop</dt>
      <dd>${impact.psi_baselines_to_drop.toLocaleString()}</dd>
      <dt>Estimated recompute cost</dt>
      ${costLine}
    </dl>
  `;
};

const renderAppliedSummary = (
  applied: NonNullable<HousekeepingResetModalState['appliedSummary']>,
): string => `
  <dl class="housekeeping-reset-applied">
    <dt>Tombstoned</dt>
    <dd>${applied.rows_tombstoned.toLocaleString()}</dd>
    <dt>Recompute enqueued</dt>
    <dd>${applied.rows_recompute_enqueued.toLocaleString()}</dd>
    <dt>PSI baselines dropped</dt>
    <dd>${applied.psi_baselines_dropped.toLocaleString()}</dd>
    <dt>Pinned skipped</dt>
    <dd>${applied.pinned_skipped.toLocaleString()}</dd>
  </dl>
`;

const renderPreviewView = (
  topic: string,
  state: HousekeepingResetModalState,
  now: number,
  modelUnitCostUsd: number | undefined,
): string => {
  if (!state.impact) return '';
  // resetPsiBaselines is null = follow registry default (derived
  // server-side). Surface the explicit user choice when set, otherwise
  // default the checkbox to checked (PSI baselines drop is the safe
  // post-reset default for emits-confidence topics).
  const psiChecked = state.resetPsiBaselines ?? true;
  const expiresHint = state.expires_at
    ? `<span class="housekeeping-reset-token-expiry">${e(formatExpiresIn(state.expires_at, now))}</span>`
    : '';
  return `
    <p class="housekeeping-reset-warning">
      Reset will tombstone every non-pinned row for <code>${e(topic)}</code> + enqueue
      a recompute on the next housekeeping cycle. This cannot be undone.
    </p>
    ${renderImpactSummary(state.impact, modelUnitCostUsd)}
    <label class="housekeeping-reset-psi-toggle">
      <input
        type="checkbox"
        data-action="housekeeping-reset-toggle-psi"
        data-topic="${e(topic)}"
        ${psiChecked ? 'checked' : ''}
      />
      <span>Also drop confidence-drift baselines for this topic</span>
    </label>
    <div class="housekeeping-reset-actions">
      ${button({
        label: 'Confirm reset',
        variant: 'danger',
        size: 'sm',
        action: 'housekeeping-reset-confirm',
        data: { topic },
        disabled: state.confirmation_token === null,
      })}
      ${button({
        label: 'Cancel',
        size: 'sm',
        action: 'housekeeping-reset-cancel',
      })}
      ${expiresHint}
    </div>
  `;
};

const renderConfirmingView = (topic: string): string => `
  <p class="housekeeping-reset-warning">
    Applying reset for <code>${e(topic)}</code>…
  </p>
  <div class="housekeeping-reset-actions">
    ${button({
      label: 'Applying…',
      variant: 'danger',
      size: 'sm',
      action: 'housekeeping-reset-confirm',
      data: { topic },
      disabled: true,
    })}
    ${button({
      label: 'Cancel',
      size: 'sm',
      action: 'housekeeping-reset-cancel',
      disabled: true,
    })}
  </div>
`;

const renderAppliedView = (
  topic: string,
  state: HousekeepingResetModalState,
): string => {
  if (!state.appliedSummary) return '';
  return `
    <p class="housekeeping-reset-applied-headline">
      Reset complete for <code>${e(topic)}</code>.
    </p>
    ${renderAppliedSummary(state.appliedSummary)}
    <p class="housekeeping-reset-applied-followup">
      The next housekeeping cycle will recompute the affected rows.
    </p>
    <div class="housekeeping-reset-actions">
      ${button({
        label: 'Done',
        variant: 'primary',
        size: 'sm',
        action: 'housekeeping-reset-done',
      })}
    </div>
  `;
};

const renderErrorView = (
  topic: string,
  state: HousekeepingResetModalState,
): string => `
  ${state.error ? inlineError(state.error) : ''}
  <div class="housekeeping-reset-actions">
    ${button({
      label: 'Retry',
      variant: 'primary',
      size: 'sm',
      action: 'housekeeping-reset-retry',
      data: { topic },
    })}
    ${button({
      label: 'Cancel',
      size: 'sm',
      action: 'housekeeping-reset-cancel',
    })}
  </div>
`;

const renderPreviewingView = (topic: string): string => `
  <p class="housekeeping-reset-loading">Loading impact preview for <code>${e(topic)}</code>…</p>
  <div class="housekeeping-reset-actions">
    ${button({
      label: 'Cancel',
      size: 'sm',
      action: 'housekeeping-reset-cancel',
    })}
  </div>
`;

export const renderHousekeepingTopicResetModal = (
  props: HousekeepingTopicResetModalProps,
): string => {
  const { state, now } = props;
  if (state.topic === null || state.phase === 'idle') return '';
  const topic = state.topic;
  const body = (() => {
    switch (state.phase) {
      case 'previewing': return renderPreviewingView(topic);
      case 'preview':    return renderPreviewView(topic, state, now, props.modelUnitCostUsd);
      case 'confirming': return renderConfirmingView(topic);
      case 'applied':    return renderAppliedView(topic, state);
      case 'error':      return renderErrorView(topic, state);
      default:           return '';
    }
  })();
  return `
    <div
      class="housekeeping-reset-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Reset enrichment topic ${e(topic)}"
      data-topic="${e(topic)}"
      data-phase="${e(state.phase)}"
    >
      <div class="housekeeping-reset-modal-backdrop" data-action="housekeeping-reset-cancel"></div>
      <div class="housekeeping-reset-modal-card">
        <header class="housekeeping-reset-modal-header">
          <h3>Reset <code>${e(topic)}</code></h3>
        </header>
        <div class="housekeeping-reset-modal-body">${body}</div>
      </div>
    </div>
  `;
};
