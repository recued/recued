/** Certificate inventory and upload presentation. Renewal and pin notices
 * share the treatment only inside the Certificates tab. */
const panel = '[data-recued-tls-certs-panel]';
const tab = '[data-recued-settings-subtab-panel="certificates"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;
const renewal = `${tab} [data-recued-tls-renew-panel]`;
const pin = `${tab} [data-recued-cert-pin-stale-panel]`;

export const CERTIFICATES_WORKSPACE_STYLES = `
${server} { gap: 16px; font-size: 13px; line-height: 1.5; }
${server} > h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }
${tab},
${panel} {
  --wc-control-h: 40px;
  min-width: 0;
  max-width: 100%;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${tab} :where(*, *::before, *::after),
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} .tls-certs-inventory { gap: 12px; }
${panel} :is(.tls-certs-title, .tls-certs-form-title) {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} .tls-certs-muted {
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}
${panel} .tls-certs-list { gap: 12px; }
${panel} :is(.tls-certs-row, .tls-certs-form, .tls-certs-result) {
  padding: 16px;
  gap: 12px;
  border-radius: var(--wc-radius-lg, 14px);
}
${panel} [data-recued-tls-certs-empty] {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
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
  font-size: 14px;
  line-height: 1.4;
  font-weight: 600;
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
${panel} .tls-certs-row-meta { gap: 12px 16px; }
${panel} .tls-certs-meta-label {
  margin-bottom: 4px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.4;
}
${panel} .tls-certs-field-label {
  margin-bottom: 6px;
  color: var(--fg);
  font-size: 12px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} .tls-certs-meta-value { font-size: 13px; line-height: 1.5; }
${panel} .tls-certs-field { gap: 6px; }
${panel} .tls-certs-form > .tls-certs-field:has(textarea) {
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
${panel} :is(button, input, textarea),
${tab} [data-recued-tls-renew-panel] button {
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  font-size: 13px;
}
${panel} button,
${tab} [data-recued-tls-renew-panel] button {
  border-radius: var(--wc-radius, 9px);
  font-size: 12px;
  height: auto;
  padding: 6px 12px;
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
  padding: 6px 10px;
  color: var(--fg);
  line-height: 1.5;
}
${panel} .tls-certs-input { height: var(--wc-control-h, 40px); }
${panel} .tls-certs-textarea {
  min-height: 132px;
  font-size: 13px;
}
/* Keep native pickers outside the shell's text-field padding. */
${tab} ${panel} .tls-certs-field input[type="file"].tls-certs-file {
  width: 100%;
  height: auto;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface);
  color: var(--fg);
  font-size: 13px;
}
${tab} ${panel} .tls-certs-field input[type="file"].tls-certs-file::file-selector-button {
  min-height: calc(var(--wc-control-h, 40px) - 2px);
  margin: 0 12px 0 0;
  padding: 6px 10px;
  border: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-sunk);
  color: inherit;
  font: inherit;
}
${panel} .tls-certs-actions { gap: 10px; }
${panel} .tls-certs-row > .tls-certs-actions { justify-content: flex-start; }
${panel} .tls-certs-confirm { gap: 12px; padding-top: 14px; }
${panel} :is(.tls-certs-error, .tls-certs-issue) { padding: 12px; border-radius: var(--wc-radius, 9px); }
${tab} :is([data-recued-tls-renew-panel], [data-recued-cert-pin-stale-panel]) {
  padding: 16px;
  gap: 12px;
  border-radius: var(--wc-radius-lg, 14px);
  font-size: 13px;
  line-height: 1.5;
}
${tab} [data-recued-tls-renew-panel] { background: var(--surface); }
${renewal} .tls-renew-title,
${pin} .cert-pin-stale-title { font-size: 16px; line-height: 1.4; }
${renewal} .tls-renew-help { line-height: 1.5; }
${renewal} .tls-renew-actions { gap: 10px; }
${renewal} .tls-renew-result {
  padding: 12px;
  gap: 10px 16px;
  grid-template-columns: minmax(0, 9rem) minmax(0, 1fr);
  border-radius: var(--wc-radius, 9px);
}
${renewal} .tls-renew-result-value { overflow-wrap: anywhere; }
${renewal} .tls-renew-error { padding: 12px; border-radius: var(--wc-radius, 9px); font-size: 13px; }
${pin} .cert-pin-stale-row { flex-wrap: wrap; font-size: 13px; }
${pin} .cert-pin-stale-value { overflow-wrap: anywhere; }
${panel} :is(.tls-certs-input, .tls-certs-textarea) { border-color: var(--border-strong); border-radius: var(--wc-radius, 9px); }
${panel} .tls-certs-row { container: certificate-card / inline-size; }
${panel} .tls-certs-row-meta > div { display: grid; grid-template-rows: subgrid; grid-row: span 2; row-gap: 4px; }
${panel} .tls-certs-row-meta .tls-certs-meta-label { margin: 0; }
${panel} .tls-certs-mono { font-size: 12px; }
${renewal}, ${pin} { container: certificate-notice / inline-size; }
${renewal} :is(.tls-renew-title, .tls-renew-help, .tls-renew-error),
${pin} :is(.cert-pin-stale-title, .cert-pin-stale-subtitle) { margin: 0; }
${renewal} .tls-renew-help { font-size: 13px; line-height: 1.5; }
${renewal} .tls-renew-result { background: var(--surface-sunk); }
${renewal} :is(.tls-renew-result-label, .tls-renew-result-value-mono) { font-size: 12px; }
${renewal} [data-recued-tls-renew-status]:focus-visible,
${panel} [data-recued-tls-certs-write-progress]:focus-visible,
${panel} [data-recued-tls-certs-read-heading]:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--wc-radius, 9px); }
${panel} .tls-certs-write-progress { margin: 0; font-size: 12px; line-height: 1.5; }
${pin} .cert-pin-stale-row { display: grid; grid-template-columns: minmax(0, 9rem) minmax(0, 1fr); align-items: start; gap: 4px 16px; }
${pin} .cert-pin-stale-label { color: var(--fg-muted); font-size: 12px; }
${pin} .cert-pin-stale-fp { font-size: 12px; }
@container certificate-card (max-width: 440px) {
  ${panel} .tls-certs-row-meta { grid-template-columns: minmax(0, 1fr); }
}
@container certificate-notice (max-width: 440px) {
  ${renewal} .tls-renew-result { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  ${renewal} .tls-renew-result-value:not(:last-child) { margin-bottom: 8px; }
  ${pin} .cert-pin-stale-row { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  ${tab}, ${panel} { --wc-control-h: 44px; }
  ${panel} :is(.tls-certs-row, .tls-certs-form, .tls-certs-result),
  ${panel} [data-recued-tls-certs-empty],
  ${tab} :is([data-recued-tls-renew-panel], [data-recued-cert-pin-stale-panel]) { padding: 12px; }
  ${panel} :is(.tls-certs-actions, .tls-certs-upload-actions) button,
  ${renewal} button { width: 100%; justify-content: center; }
}
`;
