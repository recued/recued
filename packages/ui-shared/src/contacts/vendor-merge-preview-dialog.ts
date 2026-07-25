/** D-138 P5 — `<VendorMergePreviewDialog>` shared component.
 *
 *  Renders the modal that fires after the user clicks "Also merge
 *  upstream" inside `<MergeReviewDialog>`. Two-step second-click
 *  confirm gate per spec § A.7:
 *
 *    Step 1 — preview only.   Confirm button is INERT (data-action
 *                             stamps `vendor-merge-arm`); single click
 *                             flips the dialog into "armed" state but
 *                             does NOT call the rpc.
 *    Step 2 — armed confirm.  The same Confirm button now stamps
 *                             `vendor-merge-fire`; clicking it calls
 *                             `upstream_merge.request`. Other clicks
 *                             (Cancel / Esc / outside-click) reset
 *                             the dialog to step 1.
 *
 *  The arm/fire split lives at the action-name level so the host
 *  router stays responsible for which click gets dispatched. The
 *  renderer reads `armed: boolean` from the dialog state + flips the
 *  button label + data-action accordingly.
 *
 *  Salesforce contact degraded path is rendered inline — the dialog
 *  surfaces "Merge locally only" semantics + a single Confirm button
 *  that stamps `vendor-merge-arm` and then `vendor-merge-fire-degraded`
 *  (the host calls `upstream_merge.request` regardless; the response's
 *  `degraded_path: 'vendor_not_dispatchable'` flag drives the receipt).
 *
 *  Pure render module — no IO, no rpc. */

import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { actionBar } from '../primitives/action-bar.js';
import { inlineError, inlineHint, inlineWarn } from '../primitives/message.js';
import { panel } from '../primitives/panel.js';

import type {
  UpstreamMergeFieldOutcome,
  UpstreamMergeObjectType,
  UpstreamMergeVendor,
} from '@recued/contracts';

/** State for the dialog. The host owns the lifecycle — the dialog is
 *  rendered iff `state.open` is true. `state.armed` flips on the first
 *  click of the Confirm button; the second click fires. `state.error`
 *  surfaces the rpc failure inline (caller resets it on Cancel). */
export interface VendorMergePreviewState {
  open: boolean;
  vendor: UpstreamMergeVendor;
  object_type: UpstreamMergeObjectType;
  /** Vendor-side semantics summary — wired from the describe rpc. */
  vendor_semantics_summary: string;
  /** Per-field outcome list — empty for non-dispatchable vendors. */
  field_outcomes: UpstreamMergeFieldOutcome[];
  /** True when the vendor + object type expose a callable merge API.
   *  Salesforce contact = false; the dialog renders the degraded-path
   *  explanation instead. */
  dispatchable: boolean;
  /** Vendor-side platform ids. Surfaced verbatim in the modal so the
   *  user can sanity-check which records will be touched. */
  survivor_platform_id: string;
  loser_platform_id: string;
  /** Last-modified stamps surfaced in the modal so the user can
   *  judge freshness. Optional — Salesforce describe doesn't fetch. */
  survivor_last_modified?: string;
  loser_last_modified?: string;
  /** Two-step gate — false on first render; true after the first
   *  Confirm click. Reset to false on Cancel / Esc. */
  armed: boolean;
  /** True while an upstream-merge rpc is in flight. Disables every
   *  action button. */
  saving: boolean;
  /** Inline error surfaced on rpc failure. */
  error?: string;
}

const HEADER_LABEL: Record<UpstreamMergeVendor, string> = {
  hubspot: 'Also merge in HubSpot',
  salesforce: 'Also merge in Salesforce',
};

const VENDOR_LOGO_TEXT: Record<UpstreamMergeVendor, string> = {
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
};

/** Format the per-field outcome row. Caller passes the vendor + the
 *  outcome; we render survivor + loser values + the winner label. */
const renderFieldRow = (outcome: UpstreamMergeFieldOutcome, vendor: UpstreamMergeVendor): string => {
  const winnerLabel =
    outcome.winner === 'survivor'
      ? `${VENDOR_LOGO_TEXT[vendor]} keeps survivor's value`
      : outcome.winner === 'loser'
        ? `${VENDOR_LOGO_TEXT[vendor]} keeps loser's value`
        : `${VENDOR_LOGO_TEXT[vendor]} decides at merge time`;
  const sValue = outcome.survivor_value === null || outcome.survivor_value === undefined
    ? '—'
    : String(outcome.survivor_value);
  const lValue = outcome.loser_value === null || outcome.loser_value === undefined
    ? '—'
    : String(outcome.loser_value);
  return `
    <tr class="rx-vmp-row">
      <td class="rx-vmp-field">${e(outcome.field)}</td>
      <td class="rx-vmp-survivor ${outcome.winner === 'survivor' ? 'rx-vmp-winner' : ''}">${e(sValue)}</td>
      <td class="rx-vmp-loser ${outcome.winner === 'loser' ? 'rx-vmp-winner' : ''}">${e(lValue)}</td>
      <td class="rx-vmp-rule">${e(winnerLabel)}</td>
    </tr>
  `;
};

const renderFieldTable = (
  outcomes: ReadonlyArray<UpstreamMergeFieldOutcome>,
  vendor: UpstreamMergeVendor,
): string => {
  if (outcomes.length === 0) {
    return inlineHint(
      `${VENDOR_LOGO_TEXT[vendor]} decides per-field merge outcomes at merge time. We'll show the result after the merge completes.`,
    );
  }
  return `
    <table class="rx-vmp-fields">
      <thead>
        <tr>
          <th>Field</th>
          <th>Survivor</th>
          <th>Loser</th>
          <th>Outcome</th>
        </tr>
      </thead>
      <tbody>
        ${outcomes.map((o) => renderFieldRow(o, vendor)).join('')}
      </tbody>
    </table>
  `;
};

/** Render the vendor-merge preview dialog. Returns the empty string
 *  when `state.open` is false (the host inserts this as a slot;
 *  rendering nothing keeps the layout clean). */
export const renderVendorMergePreviewDialog = (
  state: VendorMergePreviewState,
): string => {
  if (!state.open) return '';
  const vendor = state.vendor;
  const dispatchable = state.dispatchable;
  const armed = state.armed;
  const saving = state.saving;

  // First-click action arms the dialog; second-click fires the rpc.
  // The host catches the data-action and dispatches accordingly.
  const confirmAction = armed ? 'vendor-merge-fire' : 'vendor-merge-arm';
  const confirmLabel = armed
    ? dispatchable
      ? `Confirm merge in ${VENDOR_LOGO_TEXT[vendor]}`
      : 'Confirm local-only merge'
    : dispatchable
      ? `I want to also merge in ${VENDOR_LOGO_TEXT[vendor]}`
      : 'I understand — merge locally only';
  const confirmVariant = armed ? 'danger' : 'primary';

  const idsLine = dispatchable
    ? `Survivor: <code>${e(state.survivor_platform_id)}</code> · Loser: <code>${e(state.loser_platform_id)}</code>`
    : '';

  const lastModifiedLine =
    state.survivor_last_modified !== undefined || state.loser_last_modified !== undefined
      ? `<p class="rx-vmp-last-modified">Last modified — survivor: ${e(state.survivor_last_modified ?? '—')}, loser: ${e(state.loser_last_modified ?? '—')}</p>`
      : '';

  const error = state.error
    ? inlineError(state.error)
    : '';

  const armedHint = armed && !saving
    ? inlineWarn(`Click ${confirmLabel} again to fire the merge. Cancel to step back.`)
    : '';

  const semantics = panel({
    tone: dispatchable ? 'warn' : 'info',
    title: dispatchable ? 'Vendor merge semantics' : 'Local-only merge',
    body: `<p>${e(state.vendor_semantics_summary)}</p>${idsLine ? `<p class="rx-vmp-ids">${idsLine}</p>` : ''}${lastModifiedLine}`,
  });

  const fields = dispatchable
    ? renderFieldTable(state.field_outcomes, vendor)
    : '';

  const buttons = [
    button({
      label: 'Cancel',
      variant: 'secondary',
      size: 'sm',
      action: 'vendor-merge-cancel',
      disabled: saving,
    }),
    button({
      label: confirmLabel,
      variant: confirmVariant,
      size: 'sm',
      action: confirmAction,
      disabled: saving,
    }),
  ];

  return `
    <div class="rx-vmp-overlay" data-armed="${armed ? '1' : '0'}" data-dispatchable="${dispatchable ? '1' : '0'}">
      <div class="rx-vmp-dialog" role="dialog" aria-modal="true"
           aria-labelledby="rx-vmp-title">
        <div class="rx-vmp-header">
          <h2 id="rx-vmp-title">${e(HEADER_LABEL[vendor])}</h2>
        </div>
        <div class="rx-vmp-body">
          ${semantics}
          ${fields}
          ${armedHint}
          ${error}
        </div>
        ${actionBar({ children: buttons, align: 'end' })}
      </div>
    </div>
  `;
};

// Re-exported for the host so the data-action constants are typed.
export const VENDOR_MERGE_DIALOG_ACTIONS = {
  arm: 'vendor-merge-arm',
  fire: 'vendor-merge-fire',
  cancel: 'vendor-merge-cancel',
} as const;
export type VendorMergeDialogAction =
  (typeof VENDOR_MERGE_DIALOG_ACTIONS)[keyof typeof VENDOR_MERGE_DIALOG_ACTIONS];
