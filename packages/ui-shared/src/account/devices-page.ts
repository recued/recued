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
 *    • `revokingInstanceId` is a slice the renderer reads to mark both
 *      actions inert while keeping them focusable, expose the initiating
 *      confirm button as busy, + render a "Revoking…" status. On rpc
 *      failure the host writes `revokeError` and keeps
 *      `confirmingInstanceId` set; the renderer surfaces the error
 *      inline. On rpc success the host clears both slices + refreshes
 *      the roster.
 *
 *  Spec: D-156
 *  § Settings → Devices page shape. */

import { e } from '../template.js';
import { section } from '../primitives/section.js';
import { formatClientDateTime } from '../date-time.js';

export type PairListEntryKind = 'webclient' | 'bridge' | 'cli';

export interface DevicesPageRow {
  /** Stable id — `instance_id` in server land + the value the row's
   *  Revoke button stamps onto `data-instance-id` for the rpc. */
  instance_id: string;
  /** Display label — the owner's name for the device, or the browser and
   *  system it paired with ("Chrome on macOS", …) until renamed. Rendered
   *  escape-safe; combined with the kind label. */
  display_name: string;
  /** Client surface — drives the parenthesized kind label after the
   *  display name (e.g. "Phone (Browser)"). Closed list. */
  kind: PairListEntryKind;
  /** Currently-connected WS client (live heartbeat). Drives the
   *  "Online now" vs "Offline" Status cell + the row class. */
  connected: boolean;
  /** Pairing date — epoch ms (first successful register, `added_at`).
   *  Rendered in the "Paired" column. */
  paired_at: number;
  /** When the device last connected or left — epoch ms. Absent until the
   *  server has seen it since it began keeping this. ⛔ Without it a dead
   *  entry (a browser that cleared its storage never comes back) looked
   *  like any quiet one. */
  last_seen_at?: number;
  /** True for the row representing the currently-rendering client.
   *  Pinned to the top of the table; gets no Revoke button (self-
   *  revoke blocked). */
  isCurrent: boolean;
}

export interface DevicesPageState {
  rows: DevicesPageRow[];
  /** Opt in only when the host wires `refresh-devices`. A check time is
   *  published after a successful roster read, and retained on failure. */
  refresh?: {
    pending: boolean;
    lastSuccessfulAt?: number;
  };
  /** The list has never loaded — its first read failed. Render no table: an
   *  empty one says "No paired devices yet.", which is not what is known. */
  listUnavailable?: boolean;
  /** When set, the row with the matching `instance_id` renders the
   *  inline two-stage confirm panel below it. The host transitions
   *  this slice on Revoke / Cancel clicks. Only one row at a time. */
  confirmingInstanceId?: string;
  /** When set (always implies `confirmingInstanceId` matches), the
   *  row's confirm panel renders both actions aria-disabled while the
   *  initiating button stays focusable + aria-busy with a "Revoking…"
   *  label/status. The host sets this on rpc dispatch + clears it on
   *  response. */
  revokingInstanceId?: string;
  /** Inline error to render under the confirm panel on rpc failure.
   *  The host writes this when `pair.revoke` rejects + keeps
   *  `confirmingInstanceId` set so the user can retry or cancel. */
  revokeError?: string;
  /** Reference time for the "Paired Nd ago" relative formatter.
   *  Defaults to `Date.now()` when omitted. */
  nowMs?: number;
  /** The host can rename devices (`pair.rename`): each row offers Rename. */
  renameAvailable?: boolean;
  /** The row whose name is being edited, its draft, whether the save is in
   *  flight, and the refusal to show. One row at a time. */
  renamingInstanceId?: string;
  renameDraft?: string;
  renameSaving?: boolean;
  renameError?: string;
  /** Where this device takes its own access away, on a host that offers it.
   *  The roster never offers Revoke on the current device's own row. */
  selfRemovalHint?: string;
}

/** Longest device name the server keeps (`pair.rename`). */
export const DEVICE_NAME_MAX_CHARS = 64;

const KIND_LABEL: Record<PairListEntryKind, string> = {
  webclient: 'Browser',
  bridge: 'Browser Bridge',
  cli: 'Command line',
};

const COLUMN_COUNT = 4;

const renderRefresh = (refresh: DevicesPageState['refresh']): string => {
  if (refresh === undefined) return '';
  const checked = refresh.lastSuccessfulAt === undefined
    ? undefined
    : new Date(refresh.lastSuccessfulAt);
  const checkedLabel = checked !== undefined && Number.isFinite(checked.getTime())
    ? `Last successful check: <time datetime="${e(checked.toISOString())}">${e(formatClientDateTime(checked))}</time>`
    : 'Not checked yet';
  return `
    <div class="account-devices-refresh">
      <button type="button" class="account-devices-action"
        data-action="refresh-devices" aria-label="Refresh devices"${refresh.pending ? ' aria-disabled="true" aria-busy="true"' : ''}>
        ${refresh.pending ? 'Refreshing…' : 'Refresh'}
      </button>
      <p class="account-devices-last-checked" data-devices-last-checked role="status">${checkedLabel}</p>
    </div>
  `;
};

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

const renderStatusCell = (row: DevicesPageRow, nowMs: number): string => {
  if (row.connected) return 'Online now';
  if (row.last_seen_at === undefined) return 'Offline';
  const ago = formatRelative(row.last_seen_at, nowMs);
  return e(`Last used ${ago.charAt(0).toLowerCase()}${ago.slice(1)}`);
};

const renderPairedCell = (row: DevicesPageRow, nowMs: number): string =>
  e(formatRelative(row.paired_at, nowMs));

const renderActionsCell = (row: DevicesPageRow, state: DevicesPageState): string => {
  const deviceLabel = `${row.display_name} (${row.instance_id})`;
  const rename = state.renameAvailable === true && state.renamingInstanceId !== row.instance_id
    ? `
    <button type="button"
      class="account-devices-action"
      data-action="rename-device"
      data-instance-id="${e(row.instance_id)}"
      aria-label="Rename ${e(deviceLabel)}">
      Rename
    </button>`
    : '';
  // Self-revoke blocked — render no Revoke button on the current row
  // (Apple/Google "remove from account" pattern). See spec § Behaviour
  // rules. The mount hard-guards the handler too (R30 defect #1).
  if (row.isCurrent) {
    return rename.length > 0
      ? `<div class="account-devices-actions">${rename}</div>`
      : '<span class="account-devices-action-placeholder" aria-hidden="true">—</span>';
  }
  return `
    <div class="account-devices-actions">${rename}
    <button type="button"
      class="account-devices-action account-devices-action--revoke"
      data-action="revoke-device"
      data-instance-id="${e(row.instance_id)}"
      aria-label="Revoke ${e(deviceLabel)}">
      Revoke
    </button>
    </div>
  `;
};

/** The editor below the device row. Enter saves; Escape and Cancel keep the
 *  old name. Its control attributes remain owned by the mount. */
const renderRenameForm = (row: DevicesPageRow, state: DevicesPageState): string => {
  const saving = state.renameSaving === true;
  const inputId = `account-devices-rename-${row.instance_id}`;
  const errorId = `${inputId}-error`;
  const error = state.renameError !== undefined && !saving
    ? `<p class="account-devices-rename-error" id="${e(errorId)}" role="alert">${e(state.renameError)}</p>`
    : '';
  const busy = saving ? ' aria-disabled="true" aria-busy="true"' : '';
  return `
    <form class="account-devices-rename" data-rename-form data-instance-id="${e(row.instance_id)}">
      <label class="account-devices-rename-label" for="${e(inputId)}">New name for this device</label>
      <input id="${e(inputId)}" class="account-devices-rename-input" type="text"
        data-rename-input data-instance-id="${e(row.instance_id)}"
        maxlength="${DEVICE_NAME_MAX_CHARS}" autocomplete="off"
        value="${e(state.renameDraft ?? row.display_name)}"${error.length > 0 ? ` aria-describedby="${e(errorId)}" aria-invalid="true"` : ''}${saving ? ' readonly' : ''}>
      ${error}
      <div class="account-devices-rename-actions">
        <button type="submit" class="account-devices-action"
          data-action="save-rename" data-instance-id="${e(row.instance_id)}"${busy}>
          ${saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" class="account-devices-action"
          data-action="cancel-rename" data-instance-id="${e(row.instance_id)}"${saving ? ' aria-disabled="true"' : ''}>
          Cancel
        </button>
      </div>
    </form>
  `;
};

const renderConfirmPanel = (
  row: DevicesPageRow,
  state: DevicesPageState,
): string => {
  if (state.confirmingInstanceId !== row.instance_id) return '';
  const revoking = state.revokingInstanceId === row.instance_id;
  const deviceLabel = `${row.display_name} (${row.instance_id})`;
  const status = revoking
    ? `<p class="account-devices-confirm-status" role="status">Revoking…</p>`
    : '';
  const error =
    state.revokeError && !revoking
      ? `<p class="account-devices-confirm-error" role="alert">${e(state.revokeError)}</p>`
      : '';
  const inertAttr = revoking ? ' aria-disabled="true"' : '';
  const confirmBusyAttr = revoking
    ? `${inertAttr} aria-busy="true"`
    : '';
  const confirmLabel = revoking
    ? 'Revoking…'
    : `Yes, revoke &ldquo;${e(row.display_name)}&rdquo;`;
  const confirmAccessibleLabel = revoking
    ? `Revoking ${deviceLabel}`
    : `Confirm revoke ${deviceLabel}`;
  return `
    <tr class="account-devices-confirm-row" data-instance-id="${e(row.instance_id)}">
      <td colspan="${COLUMN_COUNT}" class="account-devices-confirm-cell">
        <div class="account-devices-confirm-panel" role="alertdialog" aria-label="Confirm revoke ${e(deviceLabel)}">
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
              data-instance-id="${e(row.instance_id)}"
              aria-label="Cancel revoke ${e(deviceLabel)}"${inertAttr}>
              Cancel
            </button>
            <button type="button"
              class="account-devices-action account-devices-action--confirm-revoke"
              data-action="confirm-revoke"
              data-instance-id="${e(row.instance_id)}"
              aria-label="${e(confirmAccessibleLabel)}"${confirmBusyAttr}>
              ${confirmLabel}
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
  const name = `<span class="account-devices-name">${e(row.display_name)}</span>`;
  const rename = state.renamingInstanceId === row.instance_id
    ? `<tr class="account-devices-rename-row" data-instance-id="${e(row.instance_id)}">
        <td class="account-devices-rename-cell" colspan="${COLUMN_COUNT}">
          ${renderRenameForm(row, state)}
        </td>
      </tr>`
    : '';
  return `
    <tr class="${klasses}" data-instance-id="${e(row.instance_id)}">
      <td class="account-devices-cell account-devices-cell--name">
        ${name}
        <span class="account-devices-kind">(${e(KIND_LABEL[row.kind])})</span>
        ${currentBadge}
      </td>
      <td class="account-devices-cell account-devices-cell--status">
        ${renderStatusCell(row, nowMs)}
      </td>
      <td class="account-devices-cell account-devices-cell--paired">
        ${renderPairedCell(row, nowMs)}
      </td>
      <td class="account-devices-cell account-devices-cell--actions">
        ${renderActionsCell(row, state)}
      </td>
    </tr>
    ${rename}
    ${renderConfirmPanel(row, state)}
  `;
};

export const renderDevicesPage = (state: DevicesPageState): string => {
  const nowMs = state.nowMs ?? Date.now();
  // Sort: current first, then connected actives, then offline actives
  // (most recently used first, else most recently paired). Revoked rows
  // never reach the renderer (the mount filters them out — R30).
  const sorted = [...state.rows].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return (b.last_seen_at ?? b.paired_at) - (a.last_seen_at ?? a.paired_at);
  });
  const rows = sorted.map((r) => renderRow(r, state, nowMs)).join('');
  const table = state.listUnavailable === true ? '' : `
    <div class="account-devices-table-scroll" data-recued-scroll-rail>
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
    </div>
  `;
  const body = `
    ${renderRefresh(state.refresh)}${table}
  `;

  // ⛔ This said "A device cannot remove itself" while Account & servers
  // revoked this browser's own access. Only the host knows where its device can.
  return section({
    title: 'Devices',
    hint: `Devices paired to this server. Use a different device to revoke one.${
      state.selfRemovalHint !== undefined ? ` ${state.selfRemovalHint}` : ''}`,
    body,
    id: 'account-devices',
  });
};
