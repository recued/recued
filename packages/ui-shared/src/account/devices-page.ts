/** D-156 P2 — Settings → Devices page renderer.
 *
 *  Restored from `649ac948^` (D-121 Phase 7) minus every tier-aware
 *  widget retired by D-148 P12: no `mode` column, no mode-toggle, no
 *  Demote button, no executor-limit copy, no Pro/Free tier badge, no
 *  `overageBanner`, no `graceMessage`, no Replace-device flow. The
 *  Pro tier is friction-reducer-only post-D-148 § A.5 — there is no
 *  capability gate on this page.
 *
 *  Shape:
 *    • Pure render — host wires the `data-action` handlers to their
 *      `pair.list` / `pair.revoke` rpcs (D-156 P5 owns the mount).
 *    • The mount filters revoked devices OUT of the roster (R30 — a
 *      revoked device drops off the active list; the revoke event stays
 *      in the audit log; re-pairing brings it back as a fresh row). So
 *      this renderer only ever sees active devices.
 *    • Columns: Device (name · kind · "This device") · Status (Online
 *      now / Offline) · Paired (pairing date, from `added_at`) · Actions.
 *      Accurate last-seen-while-offline is not yet in the contract
 *      (D-156 P10), so Status is an honest online/offline flag rather
 *      than a mislabeled pairing timestamp.
 *    • Roster sort: current device pinned to the top, then connected
 *      actives, then offline actives (most-recently paired first).
 *    • Self-revoke blocked. The row representing the currently-
 *      rendering client gets no Revoke button — same pattern as
 *      Apple/Google "remove from account". Revoke from another paired
 *      device. (The mount ALSO hard-guards the revoke handler, so the
 *      block does not depend on the render alone — R30 defect #1.)
 *    • Inline two-stage revoke confirm. Clicking Revoke surfaces the
 *      `confirmingInstanceId` state slice; the renderer emits a second
 *      `<tr>` below the row carrying a danger-tone confirm panel +
 *      Cancel / "Yes, revoke" buttons. One row at a time can be in the
 *      confirm state — caller collapses the previous row on a second
 *      Revoke click (mirrors the TLS renew + Clear-this-browser panels
 *      from D-148 slices 110/111).
 *    • `revokingInstanceId` is a slice the renderer reads to disable
 *      the confirm button + render a "Revoking…" status. On rpc
 *      failure the host writes `revokeError` and keeps
 *      `confirmingInstanceId` set; the renderer surfaces the error
 *      inline. On rpc success the host clears both slices + refreshes
 *      the roster.
 *
 *  Spec: docs/d-156-pair-substrate-retirement-pending-design.md
 *  § Settings → Devices page shape. */

import { e } from '../template.js';
import { section } from '../primitives/section.js';

export type PairListEntryKind = 'webclient' | 'bridge' | 'cli';

export interface DevicesPageRow {
  /** Stable id — `instance_id` in server land + the value the row's
   *  Revoke button stamps onto `data-instance-id` for the rpc. */
  instance_id: string;
  /** Display label — auto-derived UA string ("Chrome on macOS", …),
   *  frozen at pair-time. Rendered escape-safe; combined with the kind
   *  label. No rename (owner — labels are UA strings; no pair.rename). */
  display_name: string;
  /** Client surface — drives the parenthesized kind label after the
   *  display name (e.g. "Phone (Webclient)"). Closed list. */
  kind: PairListEntryKind;
  /** Currently-connected WS client (live heartbeat). Drives the
   *  "Online now" vs "Offline" Status cell + the row class. */
  connected: boolean;
  /** Pairing date — epoch ms (first successful register, `added_at`).
   *  Rendered in the "Paired" column. */
  paired_at: number;
  /** True for the row representing the currently-rendering client.
   *  Pinned to the top of the table; gets no Revoke button (self-
   *  revoke blocked). */
  isCurrent: boolean;
}

export interface DevicesPageState {
  rows: DevicesPageRow[];
  /** When set, the row with the matching `instance_id` renders the
   *  inline two-stage confirm panel below it. The host transitions
   *  this slice on Revoke / Cancel clicks. Only one row at a time. */
  confirmingInstanceId?: string;
  /** When set (always implies `confirmingInstanceId` matches), the
   *  row's confirm panel renders with the "Yes, revoke" button
   *  disabled + a "Revoking…" status. The host sets this on rpc
   *  dispatch + clears it on response. */
  revokingInstanceId?: string;
  /** Inline error to render under the confirm panel on rpc failure.
   *  The host writes this when `pair.revoke` rejects + keeps
   *  `confirmingInstanceId` set so the user can retry or cancel. */
  revokeError?: string;
  /** Reference time for the "Paired Nd ago" relative formatter.
   *  Defaults to `Date.now()` when omitted. */
  nowMs?: number;
}

const KIND_LABEL: Record<PairListEntryKind, string> = {
  webclient: 'Webclient',
  bridge: 'Bridge',
  cli: 'CLI',
};

const COLUMN_COUNT = 4;

const formatRelative = (epochMs: number, nowMs: number): string => {
  if (!epochMs) return 'Unknown';
  const diffMs = Math.max(0, nowMs - epochMs);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const renderStatusCell = (row: DevicesPageRow): string =>
  row.connected ? 'Online now' : 'Offline';

const renderPairedCell = (row: DevicesPageRow, nowMs: number): string =>
  e(formatRelative(row.paired_at, nowMs));

const renderActionsCell = (row: DevicesPageRow): string => {
  // Self-revoke blocked — render no action button on the current row
  // (Apple/Google "remove from account" pattern). See spec § Behaviour
  // rules. The mount hard-guards the handler too (R30 defect #1).
  if (row.isCurrent) return '<span class="account-devices-action-placeholder" aria-hidden="true">—</span>';
  return `
    <button type="button"
      class="account-devices-action account-devices-action--revoke"
      data-action="revoke-device"
      data-instance-id="${e(row.instance_id)}">
      Revoke
    </button>
  `;
};

const renderConfirmPanel = (
  row: DevicesPageRow,
  state: DevicesPageState,
): string => {
  if (state.confirmingInstanceId !== row.instance_id) return '';
  const revoking = state.revokingInstanceId === row.instance_id;
  const status = revoking
    ? `<p class="account-devices-confirm-status" role="status">Revoking…</p>`
    : '';
  const error =
    state.revokeError && !revoking
      ? `<p class="account-devices-confirm-error" role="alert">${e(state.revokeError)}</p>`
      : '';
  const disabledAttr = revoking ? ' disabled' : '';
  return `
    <tr class="account-devices-confirm-row" data-instance-id="${e(row.instance_id)}">
      <td colspan="${COLUMN_COUNT}" class="account-devices-confirm-cell">
        <div class="account-devices-confirm-panel" role="alertdialog" aria-label="Confirm revoke ${e(row.display_name)}">
          <p class="account-devices-confirm-heading">⚠ Revoking this device will:</p>
          <ul class="account-devices-confirm-list">
            <li>Immediately disconnect it from your server</li>
            <li>Erase its stored access token</li>
          </ul>
          <p class="account-devices-confirm-recover">
            To pair this device again, you'll need to enter your 24-word recovery key on it.
          </p>
          ${status}
          ${error}
          <div class="account-devices-confirm-actions">
            <button type="button"
              class="account-devices-action account-devices-action--cancel"
              data-action="cancel-revoke"
              data-instance-id="${e(row.instance_id)}"${disabledAttr}>
              Cancel
            </button>
            <button type="button"
              class="account-devices-action account-devices-action--confirm-revoke"
              data-action="confirm-revoke"
              data-instance-id="${e(row.instance_id)}"${disabledAttr}>
              Yes, revoke &ldquo;${e(row.display_name)}&rdquo;
            </button>
          </div>
        </div>
      </td>
    </tr>
  `;
};

const renderRow = (
  row: DevicesPageRow,
  state: DevicesPageState,
  nowMs: number,
): string => {
  const klasses = [
    'account-devices-row',
    row.isCurrent ? 'account-devices-row--current' : '',
    row.connected ? 'account-devices-row--connected' : 'account-devices-row--offline',
    state.confirmingInstanceId === row.instance_id
      ? 'account-devices-row--confirming'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const currentBadge = row.isCurrent
    ? `<span class="account-devices-current-badge">This device</span>`
    : '';
  return `
    <tr class="${klasses}" data-instance-id="${e(row.instance_id)}">
      <td class="account-devices-cell account-devices-cell--name">
        <span class="account-devices-name">${e(row.display_name)}</span>
        <span class="account-devices-kind">(${e(KIND_LABEL[row.kind])})</span>
        ${currentBadge}
      </td>
      <td class="account-devices-cell account-devices-cell--status">
        ${renderStatusCell(row)}
      </td>
      <td class="account-devices-cell account-devices-cell--paired">
        ${renderPairedCell(row, nowMs)}
      </td>
      <td class="account-devices-cell account-devices-cell--actions">
        ${renderActionsCell(row)}
      </td>
    </tr>
    ${renderConfirmPanel(row, state)}
  `;
};

export const renderDevicesPage = (state: DevicesPageState): string => {
  const nowMs = state.nowMs ?? Date.now();
  // Sort: current first, then connected actives, then offline actives
  // (most-recently paired first). Revoked rows never reach the renderer
  // (the mount filters them out — R30).
  const sorted = [...state.rows].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return b.paired_at - a.paired_at;
  });
  const rows = sorted.map((r) => renderRow(r, state, nowMs)).join('');
  const body = `
    <table class="account-devices-table" role="table" aria-label="Paired devices">
      <thead>
        <tr>
          <th class="account-devices-th">Device</th>
          <th class="account-devices-th">Status</th>
          <th class="account-devices-th">Paired</th>
          <th class="account-devices-th">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="${COLUMN_COUNT}" class="account-devices-empty">No paired devices yet.</td></tr>`}
      </tbody>
    </table>
  `;

  return section({
    title: 'Devices',
    hint: 'Connected devices paired to this server. Revoke from another device — self-revoke is blocked.',
    body,
    id: 'account-devices',
  });
};
