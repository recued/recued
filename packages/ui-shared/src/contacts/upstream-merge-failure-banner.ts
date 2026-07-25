/** D-138 P5 — upstream-merge failure banner.
 *
 *  Renders one banner row per outbox row in `vendor_merge_failed`
 *  state. Hosts subscribe to the `kind: 'upstream_merge_failed'`
 *  broadcast bus event + hydrate the list via
 *  `upstream_merge.list({ state: 'vendor_merge_failed' })`. Each row
 *  surfaces:
 *
 *    "Verify in HubSpot/Salesforce, then [Retry] or [Discard]."
 *
 *  - [Retry]    — calls `upstream_merge.retry`; substrate creates a
 *                 fresh outbox row so a new approval surfaces. The
 *                 substrate never silently re-runs a failed call.
 *  - [Discard]  — calls `upstream_merge.discard`; row is hard-deleted.
 *
 *  Pure render module. No rpc, no IO; the host wires data-action
 *  clicks to the rpc layer.
 *
 *  Spec: D-138 § A.7 + § Phase 5 (failure surfacing). */

import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { panel } from '../primitives/panel.js';

import type {
  UpstreamMergeOutboxRow,
  UpstreamMergeVendor,
} from '@recued/contracts';

const VENDOR_LABEL: Record<UpstreamMergeVendor, string> = {
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
};

export interface UpstreamMergeFailureBannerState {
  rows: UpstreamMergeOutboxRow[];
  /** Host disables the action buttons while a retry/discard rpc is
   *  in flight per row. Map keyed by `outbox_id`. */
  rowsBusy?: Record<string, boolean>;
}

const renderRow = (
  row: UpstreamMergeOutboxRow,
  busy: boolean,
): string => {
  const errCode = row.last_error?.code ?? 'unknown_error';
  const errMessage = row.last_error?.message ?? 'No error message captured';
  const summary =
    `${VENDOR_LABEL[row.vendor]} merge failed for ${row.survivor_email} ` +
    `(${row.loser_emails.length} loser${row.loser_emails.length === 1 ? '' : 's'}). ` +
    `Verify in ${VENDOR_LABEL[row.vendor]} before retrying.`;

  return panel({
    tone: 'danger',
    title: `Upstream merge failed: ${VENDOR_LABEL[row.vendor]} ${e(row.object_type)}`,
    body: `
      <p class="rx-umfb-summary">${e(summary)}</p>
      <p class="rx-umfb-error"><code>${e(errCode)}</code>: ${e(errMessage)}</p>
      <div class="rx-umfb-actions">
        ${button({
          label: 'Retry',
          variant: 'primary',
          size: 'sm',
          action: 'upstream-merge-retry',
          data: { 'outbox-id': row.id },
          disabled: busy,
        })}
        ${button({
          label: 'Discard',
          variant: 'danger-text',
          size: 'sm',
          action: 'upstream-merge-discard',
          data: { 'outbox-id': row.id },
          disabled: busy,
        })}
      </div>
    `,
  });
};

export const renderUpstreamMergeFailureBanner = (
  state: UpstreamMergeFailureBannerState,
): string => {
  if (state.rows.length === 0) return '';
  const rowsBusy = state.rowsBusy ?? {};
  return `
    <div class="rx-umfb">
      ${state.rows.map((r) => renderRow(r, rowsBusy[r.id] === true)).join('')}
    </div>
  `;
};
