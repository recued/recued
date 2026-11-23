const host = '[data-recued-storage-space-host]';
const server = '[data-recued-settings-section="server"]:has([data-recued-settings-subtab-panel="storage"][data-active="true"])';

export const STORAGE_SPACE_PANEL_STYLES = `
${server} { gap: 16px; font-size: 13px; line-height: 1.5; }
${server} > h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }
${host} { --wc-control-h: 40px; min-width: 0; max-width: 100%; overflow-wrap: anywhere; font-size: 13px; line-height: 1.5; container: storage-space / inline-size; }
${host} :where(*, *::before, *::after) { box-sizing: border-box; }
${host} [hidden] { display: none !important; }
${host} .storage-space-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
${host} .storage-space { display: grid; gap: 16px; min-width: 0; }
${host} .storage-space h2 { margin: 0; font-size: 16px; line-height: 1.4; font-weight: 600; }
${host} :is(.storage-space-summary, .storage-space-database, .storage-space-note) { margin: 0; max-width: 76ch; }
${host} .storage-space-summary, ${host} .storage-space-note { color: var(--fg-muted); }
${host} .storage-space-database { padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
${host} .storage-space-read-feedback { display: grid; justify-items: start; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface); }
${host} .storage-space-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
${host} .storage-space-table thead th { padding: 10px 8px; text-align: left; font-size: 12px; font-weight: 600; color: var(--fg-muted); }
${host} .storage-space-table thead th:first-child { width: 24%; }
${host} .storage-space-table thead th:nth-child(2) { width: 16%; }
${host} .storage-space-table thead th:nth-child(3) { width: 11%; }
${host} .storage-space-table thead th:nth-child(4) { width: 14%; }
${host} .storage-space-table thead th:nth-child(5) { width: 10%; }
${host} .storage-space-table thead th:last-child { width: 25%; }
${host} .storage-space-table :is(td, th[scope="row"]) { min-width: 0; padding: 12px 8px; vertical-align: top; text-align: left; border-bottom: 1px solid var(--border); }
${host} .storage-space-table th[scope="row"] { color: var(--fg); font-size: 14px; font-weight: 600; }
${host} .storage-space-table tbody tr:last-child > * { border-bottom: 0; }
${host} .storage-space-cell-label { display: none; }
${host} .storage-space-action { color: var(--fg-muted); font-size: 12px; }
${host} .storage-space-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-width: 44px; min-height: var(--wc-control-h); max-width: 100%; padding: 6px 12px;
  border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 9px);
  background: var(--surface); color: var(--fg); font: inherit; font-size: 12px; line-height: 1.4; font-weight: 600;
  cursor: pointer; white-space: normal; overflow-wrap: anywhere;
}
${host} .storage-space-btn:hover:not(:disabled) { background: var(--surface-sunk); }
${host} .storage-space-btn:disabled { opacity: 0.55; cursor: default; }
${host} .storage-space-btn--danger { border-color: var(--danger); color: var(--danger); }
${host} :is(button, input, [tabindex="-1"]):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${host} [tabindex="-1"] { scroll-margin-block: 8px; border-radius: var(--wc-radius, 9px); }
${host} .storage-space-purge { display: grid; gap: 16px; min-width: 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface); }
${host} .storage-space-purge h3 { margin: 0; font-size: 16px; line-height: 1.4; font-weight: 600; }
${host} .storage-space-choices { display: grid; gap: 12px; min-width: 0; width: 100%; margin: 0; padding: 0; border: 0; }
${host} .storage-space-choices legend { margin-bottom: 12px; padding: 0; font-size: 12px; font-weight: 600; color: var(--fg-muted); }
${host} .storage-space-choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
${host} .storage-space-choice { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 44px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); font-size: 13px; cursor: pointer; }
${host} .storage-space-choice:has(input:checked) { border-color: var(--accent); background: var(--surface-sunk); }
${host} .storage-space-choice input { flex: 0 0 auto; width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
${host} .storage-space-choices:disabled .storage-space-choice { cursor: default; }
${host} .storage-space-date { display: grid; gap: 6px; min-width: 0; font-size: 12px; font-weight: 600; color: var(--fg-muted); }
${host} .storage-space-date input { display: block; width: 100%; min-width: 0; max-width: 100%; min-height: var(--wc-control-h); padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 9px); background: var(--bg); color: var(--fg); font: inherit; font-size: 13px; font-weight: 400; color-scheme: light dark; }
${host} .storage-space-date input:disabled { opacity: 0.55; }
${host} .storage-space-date input[aria-invalid="true"] { border-color: var(--danger); }
${host} .storage-space-actions { display: flex; flex-wrap: wrap; gap: 8px; }
${host} :is(.storage-space-progress, .storage-space-preview, .storage-space-receipt, .storage-space-error) { margin: 0; font-size: 13px; line-height: 1.5; }
${host} .storage-space-progress, ${host} .storage-space-preview, ${host} .storage-space-receipt { padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--bg); }
${host} .storage-space-error { color: var(--danger); }
@container storage-space (width < 660px) {
  ${host} .storage-space-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  ${host} .storage-space-table, ${host} .storage-space-table tbody { display: block; width: 100%; }
  ${host} .storage-space-table tbody { display: grid; gap: 12px; }
  ${host} .storage-space-table tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
  ${host} .storage-space-table tbody :is(td, th[scope="row"]) { display: block; padding: 0; border: 0; }
  ${host} .storage-space-table th[scope="row"], ${host} .storage-space-action, ${host} .storage-space-purge-row > td { grid-column: 1 / -1; }
  ${host} .storage-space-cell-label { display: block; margin-bottom: 4px; color: var(--fg-muted); font-size: 12px; font-weight: 600; }
  ${host} .storage-space-action > button { width: 100%; }
  ${host} .storage-space-table tr.storage-space-purge-row { padding: 0; border: 0; background: transparent; }
}
@media (max-width: 640px) {
  ${host} { --wc-control-h: 44px; }
  ${host} .storage-space-purge { padding: 12px; }
  ${host} .storage-space-choice { gap: 6px; padding: 8px; font-size: 12px; }
  ${host} .storage-space-actions > button { flex: 1 1 10rem; }
  ${host} .storage-space-read-feedback { justify-items: stretch; padding: 12px; }
  ${host} .storage-space-database { padding: 12px; }
}
`;
