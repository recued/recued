/** Maintenance owns these rules; the shared Housekeeping renderers retain
 * their defaults everywhere else. Table roles and headers survive the narrow
 * layout, while visual cell labels stay out of the accessibility tree. */
const host = '[data-recued-maintenance-panel-host]';

export const MAINTENANCE_WORKSPACE_STYLES = `
${host} {
  --wc-control-h: 44px;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
${host} :where(*, *::before, *::after) { box-sizing: border-box; }
${host} .housekeeping-panel {
  min-width: 0;
  gap: 20px;
  font-size: 14px;
  line-height: 1.5;
}
${host} .housekeeping-header { display: grid; gap: 10px; }
${host} .housekeeping-header h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.3;
}
${host} .housekeeping-summary {
  max-width: 76ch;
  font-size: 14px;
  line-height: 1.6;
}
${host} .housekeeping-maintenance {
  container: maintenance-section / inline-size;
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
${host} .housekeeping-maintenance > h3 {
  margin: 0 0 14px;
  font-size: 16px;
  line-height: 1.4;
}
${host} .housekeeping-maintenance > .housekeeping-summary { margin-bottom: 16px; }
${host} .housekeeping-task-table {
  width: 100%;
  table-layout: fixed;
  font-size: 13px;
}
${host} .housekeeping-task-table thead th {
  padding: 10px 8px;
  font-size: 12px;
}
${host} .housekeeping-task-table :is(td, th[scope="row"]) {
  padding: 14px 8px;
  vertical-align: top;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
${host} .housekeeping-task-table thead th:first-child { width: 29%; }
${host} [data-recued-maintenance-storage] .housekeeping-task-table thead th:first-child { width: 20%; }
${host} .housekeeping-task-table thead th:last-child { width: 128px; }
${host} .housekeeping-task-table tbody tr:last-child > * { border-bottom: 0; }
${host} .housekeeping-task-id { color: var(--fg); font-size: 14px; }
${host} .housekeeping-task-desc {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 400;
}
${host} .housekeeping-task-error {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.5;
}
${host} .housekeeping-task-row[data-task-status="error"] .housekeeping-task-status {
  color: var(--danger);
}
${host} .maintenance-storage-size { white-space: normal; }
${host} .maintenance-storage-receipt { font-size: 13px; line-height: 1.5; }
${host} .housekeeping-cell-label { display: none; }
${host} :is(button, a) {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${host} .housekeeping-runnow-btn {
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 6px);
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
}
${host} .housekeeping-runnow-btn:hover:not(:disabled) { background: var(--surface-sunk); }
${host} .housekeeping-runnow-btn:disabled { opacity: 0.55; cursor: default; }
${host} :is(button, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${host} .housekeeping-runnow-dialog { padding: 16px; }
${host} .housekeeping-runnow-dialog-card {
  width: min(480px, 100%);
  max-width: 100%;
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  padding: 20px;
  border-radius: 12px;
  font-size: 14px;
}
${host} .housekeeping-runnow-dialog-title { flex-shrink: 0; font-size: 16px; line-height: 1.4; }
${host} .housekeeping-runnow-dialog-body { min-height: 0; overflow-y: auto; }
${host} .housekeeping-runnow-dialog-actions { flex-shrink: 0; flex-wrap: wrap; gap: 10px; }
@container maintenance-section (max-width: 560px) {
  ${host} .housekeeping-task-table { display: block; table-layout: auto; }
  ${host} .housekeeping-task-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  ${host} .housekeeping-task-table tbody { display: grid; gap: 12px; }
  ${host} .housekeeping-task-table tbody tr {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 16px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }
  ${host} .housekeeping-task-table tbody :is(td, th[scope="row"]) {
    display: block;
    min-width: 0;
    padding: 0;
    border: 0;
  }
  ${host} .housekeeping-task-name,
  ${host} .housekeeping-task-status,
  ${host} .housekeeping-task-action,
  ${host} .maintenance-storage-row th[scope="row"],
  ${host} .maintenance-storage-receipt,
  ${host} .maintenance-storage-action { grid-column: 1 / -1; }
  ${host} .housekeeping-task-id,
  ${host} .maintenance-storage-row th[scope="row"] { font-size: 14px; color: var(--fg); }
  ${host} .maintenance-storage-row--attention th[scope="row"] { color: var(--danger); }
  ${host} .housekeeping-task-table .housekeeping-cell-label {
    display: block;
    margin-bottom: 4px;
    color: var(--fg-muted);
    font-size: 12px;
    font-weight: 600;
  }
  ${host} .maintenance-storage-action:empty { display: none; }
}
@media (max-width: 600px) {
  ${host} .housekeeping-maintenance { padding: 14px; }
}
`;
