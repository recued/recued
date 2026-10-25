/** Hostname inventory and editor presentation. The renderer keeps its
 * field/control ownership, verification gates and caller contract. */
const panel = '[data-recued-hostnames-panel]';
const tab = '[data-recued-settings-subtab-panel="hostnames"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;
const domains = `${tab} [data-recued-custom-domains]`;

export const HOSTNAMES_WORKSPACE_STYLES = `
${server} { gap: 20px; }
${server} > h2 { margin: 0; font-size: 22px; line-height: 1.3; }
${tab},
${panel} { min-width: 0; max-width: 100%; }
${panel} {
  --wc-control-h: 44px;
  gap: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after),
${domains} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} .hostnames-panel-header { flex-wrap: wrap; gap: 12px; }
${panel} .hostnames-panel-title { font-size: 18px; line-height: 1.4; font-weight: 650; }
${panel} .hostnames-panel-list { gap: 16px; }
${panel} :is(.hostnames-row, .hostnames-form, .hostnames-verify-form, .hostnames-detail-panel) {
  padding: 20px;
  gap: 16px;
  border-radius: 12px;
}
${panel} :is(.hostnames-form-title, .hostnames-detail-title, .hostnames-local-urls-title) {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 650;
}
${panel} .hostnames-row-main { flex-direction: row; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px; }
${panel} .hostnames-row-name {
  flex: 1 1 18rem;
  max-width: 100%;
  font-size: 15px;
  line-height: 1.4;
  font-weight: 650;
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
${panel} :is(.hostnames-row-meta, .hostnames-form-grid) { gap: 16px 20px; }
${panel} .hostnames-meta-label { margin-bottom: 4px; font-size: 13px; line-height: 1.4; }
${panel} .hostnames-meta-value { font-size: 14px; line-height: 1.55; }
${panel} .hostnames-field-label {
  margin-bottom: 8px;
  color: var(--fg);
  font-size: 13px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} :is(button, input:not([type="checkbox"]), select),
${domains} :is(button, input) {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  font-size: 14px;
}
${panel} button,
${domains} button {
  height: auto;
  padding: 10px 14px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} :is(button, input, select):focus-visible,
${domains} :is(button, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} :is(.hostnames-input, .hostnames-select) { height: 44px; padding: 8px 10px; color: var(--fg); }
${panel} label.hostnames-checkbox-label {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  gap: 10px;
  padding: 8px 0;
  font-size: 14px;
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
  border-radius: 8px;
  background: var(--surface);
}
${panel} .hostnames-ports-hint { margin-top: 8px; font-size: 13px; line-height: 1.55; }
${panel} .hostnames-actions { gap: 10px; }
${panel} .hostnames-row > .hostnames-actions { justify-content: flex-start; }
${panel} .hostnames-error { padding: 12px; border-radius: 8px; }
${panel} [data-recued-hostnames-remove-confirm-panel] { padding: 14px; border-radius: 8px; background: var(--surface-sunk); }
${panel} .hostnames-mono { font-size: 13px; overflow-wrap: anywhere; }
${panel} :is(.hostnames-local-urls, .hostnames-ddns, .hostnames-addresses) {
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
/* WebKit counts native menu text beyond fitted address selects. Card padding
   contains that overflow and keeps the controls' focus rings visible. */
${panel} .hostnames-addresses { overflow: clip; }
${panel} .hostnames-local-url-row { flex-wrap: wrap; gap: 10px; padding: 12px; }
${panel} .hostnames-local-url-value { flex: 1 1 15rem; max-width: 100%; }
${panel} .hostnames-address-row { gap: 8px 16px; }
${panel} .hostnames-address-row > p { font-size: 13px; line-height: 1.55; }
${domains} {
  --wc-control-h: 44px;
  min-width: 0;
  max-width: 100%;
  padding: 20px;
  border-radius: 12px;
  background: var(--surface);
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${domains} .custom-domains-field-label { font-size: 13px; }
${domains} .custom-domains-input { height: 44px; }
@media (max-width: 1000px) {
  ${panel} .hostnames-ports { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  ${panel} :is(.hostnames-row, .hostnames-form, .hostnames-verify-form, .hostnames-detail-panel,
    .hostnames-local-urls, .hostnames-ddns, .hostnames-addresses),
  ${domains} { padding: 16px; }
}
`;
