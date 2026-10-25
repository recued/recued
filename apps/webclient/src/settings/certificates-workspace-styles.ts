/** Certificate inventory and upload presentation. Renewal and pin notices
 * share the treatment only inside the Certificates tab. */
const panel = '[data-recued-tls-certs-panel]';
const tab = '[data-recued-settings-subtab-panel="certificates"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;
const renewal = `${tab} [data-recued-tls-renew-panel]`;
const pin = `${tab} [data-recued-cert-pin-stale-panel]`;

export const CERTIFICATES_WORKSPACE_STYLES = `
${server} { gap: 20px; }
${server} > h2 { margin: 0; font-size: 22px; line-height: 1.3; }
${tab},
${panel} {
  --wc-control-h: 44px;
  min-width: 0;
  max-width: 100%;
  gap: 20px;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${tab} :where(*, *::before, *::after),
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} .tls-certs-inventory { gap: 14px; }
${panel} :is(.tls-certs-title, .tls-certs-form-title) {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 650;
}
${panel} .tls-certs-muted {
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.6;
}
${panel} .tls-certs-list { gap: 16px; }
${panel} :is(.tls-certs-row, .tls-certs-form, .tls-certs-result) {
  padding: 20px;
  gap: 16px;
  border-radius: 12px;
}
${panel} [data-recued-tls-certs-empty] {
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
${panel} .tls-certs-row-main {
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 12px;
}
${panel} .tls-certs-row-name {
  flex: 1 1 18rem;
  max-width: 100%;
  font-size: 15px;
  line-height: 1.4;
  font-weight: 650;
}
${panel} .tls-certs-chip {
  flex: 0 0 auto;
  max-width: 100%;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} .tls-certs-row-meta { gap: 14px 24px; }
${panel} .tls-certs-meta-label {
  margin-bottom: 4px;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.4;
}
${panel} .tls-certs-field-label {
  margin-bottom: 8px;
  color: var(--fg);
  font-size: 13px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} .tls-certs-meta-value { font-size: 14px; line-height: 1.55; }
${panel} .tls-certs-field { gap: 8px; }
${panel} .tls-certs-form > .tls-certs-field:has(textarea) {
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
${panel} :is(button, input, textarea),
${tab} [data-recued-tls-renew-panel] button {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  font-size: 14px;
}
${panel} button,
${tab} [data-recued-tls-renew-panel] button {
  height: auto;
  padding: 10px 14px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} :is(button, input, textarea):focus-visible,
${tab} [data-recued-tls-renew-panel] button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
${panel} :is(.tls-certs-input, .tls-certs-textarea) {
  padding: 10px 12px;
  color: var(--fg);
  line-height: 1.55;
}
${panel} .tls-certs-input { height: 44px; }
${panel} .tls-certs-textarea {
  min-height: 132px;
  font-size: 13px;
}
${panel} .tls-certs-file {
  width: 100%;
  height: auto;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  font-size: 13px;
}
${panel} .tls-certs-file::file-selector-button {
  min-height: 44px;
  margin: 0 12px 0 0;
  padding: 10px 12px;
  border: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-sunk);
  color: inherit;
  font: inherit;
}
${panel} .tls-certs-actions { gap: 10px; }
${panel} .tls-certs-row > .tls-certs-actions { justify-content: flex-start; }
${panel} .tls-certs-confirm { gap: 12px; padding-top: 14px; }
${panel} :is(.tls-certs-error, .tls-certs-issue) { padding: 12px; border-radius: 8px; }
${tab} :is([data-recued-tls-renew-panel], [data-recued-cert-pin-stale-panel]) {
  padding: 20px;
  gap: 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.55;
}
${tab} [data-recued-tls-renew-panel] { background: var(--surface); }
${renewal} .tls-renew-title,
${pin} .cert-pin-stale-title { font-size: 16px; line-height: 1.4; }
${renewal} .tls-renew-help { line-height: 1.55; }
${renewal} .tls-renew-actions { gap: 10px; }
${renewal} .tls-renew-result {
  padding: 14px;
  gap: 10px 16px;
  grid-template-columns: minmax(0, 12rem) minmax(0, 1fr);
  border-radius: 8px;
}
${renewal} .tls-renew-result-value { overflow-wrap: anywhere; }
${renewal} .tls-renew-error { padding: 12px; border-radius: 8px; font-size: 13px; }
${pin} .cert-pin-stale-row { flex-wrap: wrap; font-size: 13px; }
${pin} .cert-pin-stale-value { overflow-wrap: anywhere; }
@media (max-width: 600px) {
  ${panel} :is(.tls-certs-row, .tls-certs-form, .tls-certs-result),
  ${panel} [data-recued-tls-certs-empty],
  ${tab} :is([data-recued-tls-renew-panel], [data-recued-cert-pin-stale-panel]) { padding: 16px; }
  ${renewal} .tls-renew-result { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  ${renewal} .tls-renew-result-value:not(:last-child) { margin-bottom: 6px; }
  ${pin} .cert-pin-stale-row { flex-direction: column; gap: 4px; }
  ${pin} .cert-pin-stale-label { flex-basis: auto; }
}
`;
