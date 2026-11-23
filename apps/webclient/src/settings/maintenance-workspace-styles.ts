/** Maintenance owns these rules; the shared Housekeeping renderers retain
 * their defaults everywhere else. Table roles and headers survive the narrow
 * layout, while visual cell labels stay out of the accessibility tree. */
const host = '[data-recued-maintenance-panel-host]';
const tab = '[data-recued-settings-subtab-panel="maintenance"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;

export const MAINTENANCE_WORKSPACE_STYLES = `
${server} { gap: 16px; font-size: 13px; line-height: 1.5; }
${server} > h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }
${host} {
  --wc-control-h: 40px;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
${host} :where(*, *::before, *::after) { box-sizing: border-box; }
${host} .housekeeping-panel {
  min-width: 0;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
}
${host} .housekeeping-header { display: grid; gap: 8px; }
${host} .housekeeping-header h2 {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
}
${host} .housekeeping-summary {
  max-width: 76ch;
  font-size: 13px;
  line-height: 1.5;
}
${host} .housekeeping-maintenance {
  container: maintenance-section / inline-size;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
${host} .housekeeping-maintenance > h3 {
  margin: 0 0 12px;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
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
  padding: 12px 8px;
  vertical-align: top;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
${host} .housekeeping-task-table thead th:first-child { width: 29%; }
${host} [data-recued-maintenance-storage] .housekeeping-task-table thead th:first-child { width: 20%; }
${host} .housekeeping-task-table thead th:last-child { width: 144px; }
${host} .housekeeping-task-table tbody tr:last-child > * { border-bottom: 0; }
${host} .housekeeping-task-id { color: var(--fg); font-size: 14px; font-weight: 600; }
${host} .housekeeping-task-desc {
  margin-top: 4px;
  font-size: 12px;
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
${host} .maintenance-storage-receipt { font-size: 12px; line-height: 1.5; }
${host} .housekeeping-cell-label { display: none; }
${host} .housekeeping-task-empty { margin: 0; color: var(--fg-muted); font-size: 12px; }
${host} .maintenance-reclaim-progress { display: block; margin-top: 6px; scroll-margin-block: 8px; font-size: 12px; line-height: 1.5; }
${host} .maintenance-reclaim-progress:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--wc-radius, 9px); }
${host} > .housekeeping-loading,
${host} > .housekeeping-panel:has(> .housekeeping-error) { margin: 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface); font-size: 13px; line-height: 1.5; }
${host} :is(button, a) {
  height: auto;
  border-radius: var(--wc-radius, 9px);
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  padding: 6px 12px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${host} .housekeeping-runnow-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
}
${host} .housekeeping-runnow-btn > svg { flex-shrink: 0; }
${host} .housekeeping-runnow-btn[hidden] { display: none; }
${host} .housekeeping-runnow-btn:hover:not(:disabled) { background: var(--surface-sunk); }
${host} .housekeeping-runnow-btn:disabled { opacity: 0.55; cursor: default; }
${host} :is(button, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${host} .housekeeping-runnow-dialog { padding: 16px; }
${host} .housekeeping-runnow-dialog-card {
  gap: 12px;
  width: min(480px, 100%);
  max-width: 100%;
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  padding: 20px;
  border-radius: var(--wc-radius-lg, 14px);
  font-size: 13px;
}
${host} .housekeeping-runnow-dialog-title { flex-shrink: 0; font-size: 16px; line-height: 1.4; font-weight: 600; }
${host} .housekeeping-runnow-dialog-body { min-height: 0; overflow-y: auto; }
${host} .housekeeping-runnow-dialog-actions { flex-shrink: 0; flex-wrap: wrap; align-items: stretch; gap: 8px; }
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
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius, 9px);
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
  ${host} :is(.housekeeping-task-action, .maintenance-storage-action) > button { width: 100%; }
}
@media (max-width: 640px) {
  ${host} { --wc-control-h: 44px; }
  ${host} .housekeeping-runnow-dialog-card { padding: 16px; }
  ${host} .housekeeping-runnow-dialog-actions > button { flex: 1 1 10rem; }
  ${host} > .housekeeping-panel:has(> .housekeeping-error) > div > button { width: 100%; }
  ${host} .housekeeping-maintenance { padding: 12px; }
}
`;
