/** Hostname inventory and editor presentation. The renderer keeps its
 * field/control ownership, verification gates and caller contract. */
const panel = '[data-recued-hostnames-panel]';
const tab = '[data-recued-settings-subtab-panel="hostnames"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;
const domains = `${tab} [data-recued-custom-domains]`;

export const HOSTNAMES_WORKSPACE_STYLES = `
${server} { gap: 16px; font-size: 13px; line-height: 1.5; }
${server} > h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }
${tab},
${panel} { min-width: 0; max-width: 100%; }
${panel} {
  --wc-control-h: 40px;
  gap: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after),
${domains} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} .hostnames-panel-header { flex-wrap: wrap; gap: 12px; }
${panel} .hostnames-panel-title { font-size: 16px; line-height: 1.4; font-weight: 600; }
${panel} .hostnames-panel-list { gap: 12px; }
${panel} :is(.hostnames-row, .hostnames-form, .hostnames-verify-form, .hostnames-detail-panel) {
  padding: 16px;
  gap: 12px;
  border-radius: var(--wc-radius-lg, 14px);
}
${panel} :is(.hostnames-form-title, .hostnames-detail-title, .hostnames-local-urls-title) {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} .hostnames-row-main { flex-direction: row; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px; }
${panel} .hostnames-row-name {
  flex: 1 1 18rem;
  max-width: 100%;
  font-size: 14px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} :is(.hostnames-pill, .hostnames-cert-chip, .hostnames-delegation-chip) {
  flex: 0 0 auto;
  align-self: flex-start;
  max-width: 100%;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} :is(.hostnames-row-meta, .hostnames-form-grid) { gap: 12px 16px; }
${panel} .hostnames-meta-label { margin-bottom: 4px; font-size: 12px; line-height: 1.4; }
${panel} .hostnames-meta-value { font-size: 13px; line-height: 1.5; }
${panel} .hostnames-field-label {
  margin-bottom: 6px;
  color: var(--fg);
  font-size: 12px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} :is(button, input:not([type="checkbox"]), select),
${domains} :is(button, input) {
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  font-size: 13px;
}
${panel} button,
${domains} button {
  height: auto;
  padding: 6px 12px;
  border-radius: var(--wc-radius, 9px);
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} :is(button, input, select):focus-visible,
${domains} :is(button, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} :is(.hostnames-input, .hostnames-select) { height: var(--wc-control-h, 40px); padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 9px); background: var(--surface); color: var(--fg); line-height: 1.4; }
${panel} label.hostnames-checkbox-label {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  gap: 10px;
  padding: 8px 0;
  font-size: 13px;
  line-height: 1.5;
}
${panel} .hostnames-checkbox-label input[type="checkbox"] {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  margin: 0;
}
${panel} .hostnames-ports { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
${panel} .hostnames-ports .hostnames-checkbox-label {
  justify-content: center;
  gap: 8px;
  padding: 8px 6px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface);
}
${panel} .hostnames-ports-hint { margin-top: 6px; font-size: 12px; line-height: 1.5; }
${panel} .hostnames-actions { gap: 10px; }
${panel} .hostnames-row > .hostnames-actions { justify-content: flex-start; }
${panel} .hostnames-error { padding: 12px; border-radius: var(--wc-radius, 9px); }
${panel} [data-recued-hostnames-remove-confirm-panel] { padding: 12px; border-radius: var(--wc-radius, 9px); background: var(--surface-sunk); }
${panel} .hostnames-mono { font-size: 12px; overflow-wrap: anywhere; }
${panel} :is(.hostnames-local-urls, .hostnames-ddns, .hostnames-addresses) {
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
${panel} .hostnames-ddns > p { margin: 0; }
/* WebKit counts native menu text beyond fitted address selects. Card padding
   contains that overflow and keeps the controls' focus rings visible. */
${panel} .hostnames-addresses { overflow: clip; }
${panel} .hostnames-local-url-row { flex-wrap: wrap; gap: 10px; padding: 12px; }
${panel} .hostnames-local-url-value { flex: 1 1 15rem; max-width: 100%; }
${panel} .hostnames-address-row { grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 12px 0; border-top: 1px solid var(--border); }
${panel} .hostnames-address-row > p { grid-column: 1 / -1; }
${panel} .hostnames-address-row > .hostnames-field-label { margin: 0; }
${panel} .hostnames-address-row > p { font-size: 12px; line-height: 1.5; }
${domains} {
  --wc-control-h: 40px;
  min-width: 0;
  max-width: 100%;
  padding: 16px;
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${domains} .custom-domains-field-label { font-size: 12px; line-height: 1.4; font-weight: 600; color: var(--fg); }
${domains} .custom-domains-input { height: var(--wc-control-h, 40px); padding: 6px 10px; border-color: var(--border-strong); border-radius: var(--wc-radius, 9px); background: var(--surface); color: var(--fg); font-size: 13px; line-height: 1.4; }
/* Shared intrinsic caption rows keep paired fields aligned when labels wrap. */
${panel} :is(.hostnames-form, .hostnames-verify-form) { container: hostname-editor / inline-size; }
${panel} :is(.hostnames-row, .hostnames-detail-panel) { container: hostname-card / inline-size; }
${panel} .hostnames-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
${panel} .hostnames-form-grid > label:has(> .hostnames-field-label) {
  display: grid;
  grid-template-rows: subgrid;
  grid-row: span 2;
  row-gap: 6px;
}
${panel} .hostnames-form-grid > label > .hostnames-field-label { margin: 0; }
${panel} .hostnames-form-grid > .hostnames-checkbox-label { grid-row: span 2; align-self: end; }
${panel} .hostnames-verify-form:has(.hostnames-checkbox-label) .hostnames-form-grid { grid-template-columns: minmax(0, 1fr); }
${panel} .hostnames-row-meta > div { display: grid; grid-template-rows: subgrid; grid-row: span 2; row-gap: 4px; }
${panel} .hostnames-row-meta .hostnames-meta-label { margin: 0; }
${panel} .hostnames-status-progress { margin: 0; font-size: 12px; line-height: 1.5; }
${panel} :is(.hostnames-status-progress, .hostnames-field-label, .hostnames-panel-title, .hostnames-local-urls-title):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--wc-radius, 9px); }
${domains} :is(.custom-domains-intro, .custom-domains-status, .custom-domains-record-hint, .custom-domains-check-detail) { color: var(--fg-muted); }
${domains} .custom-domains-record { gap: 8px; padding: 12px; border-radius: var(--wc-radius, 9px); background: var(--surface-sunk); }
${domains} .custom-domains-record-label { font-size: 12px; text-transform: none; letter-spacing: 0; }
${domains} .custom-domains-record-row { display: grid; grid-template-columns: 3.5rem minmax(0, 1fr); align-items: start; gap: 8px; }
${domains} .custom-domains-record-hint { font-size: 12px; line-height: 1.5; }
${domains} .custom-domains-delegation { margin-left: 0; padding-left: 12px; gap: 8px; }
${domains} .custom-domains-apex { padding: 12px; border-radius: var(--wc-radius, 9px); color: var(--fg); }
${domains} .custom-domains-error { padding: 12px; border: 1px solid var(--danger); border-radius: var(--wc-radius, 9px); background: var(--danger-weak); color: var(--fg); font-size: 13px; line-height: 1.5; }
@container hostname-editor (max-width: 440px) {
  ${panel} .hostnames-form-grid { grid-template-columns: minmax(0, 1fr); }
  ${panel} .hostnames-ports { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container hostname-card (max-width: 440px) {
  ${panel} .hostnames-row-meta { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  ${panel}, ${domains} { --wc-control-h: 44px; }
  ${panel} :is(.hostnames-row, .hostnames-form, .hostnames-verify-form, .hostnames-detail-panel,
    .hostnames-local-urls, .hostnames-ddns, .hostnames-addresses),
  ${domains} { padding: 12px; }
  ${panel} :is(.hostnames-actions, .hostnames-panel-header) button,
  ${panel} :is(.hostnames-ddns, .hostnames-local-url-row) > button,
  ${domains} button { width: 100%; justify-content: center; }
}
`;
