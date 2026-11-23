/** Quiet canvas scale for Sign-offs and its nested completion/receipt views. */
const workspace = '[data-recued-quote-signoffs]';

export const CUSTOMER_SIGNOFF_WORKSPACE_STYLES = `
${workspace} { max-width: 1100px; gap: 16px; font-size: 13px; line-height: 1.5; }
${workspace} h2 { font-size: 18px; }
${workspace} h3 { font-size: 16px; }
${workspace} h4 { font-size: 14px; }
${workspace} .signoff-intro { font-size: 13px; }
${workspace} label { min-width: 0; gap: 6px; font-size: 12px; }
${workspace} :is(input:not([type="checkbox"]), select, textarea) {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  padding: 8px 11px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4;
}
${workspace} :is(input:not([type="checkbox"]), select) { min-height: var(--wc-control-h, 40px); }
${workspace} select { overflow: hidden; text-overflow: ellipsis; }
${workspace} button, ${workspace} .signoff-primary, ${workspace} [data-signoff-create] > summary {
  box-sizing: border-box; max-width: 100%; min-height: var(--wc-control-h, 40px); padding: 8px 12px;
  border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.5;
}
${workspace} :is(form, [data-signoff-history], [data-signoff-completions], [data-completion-history], [data-signoff-receipt], [data-signoff-receipt-requests]) { gap: 16px; }
${workspace} :is(.signoff-actions, .request-actions) { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
${workspace} :is(.signoff-actions, .request-actions) h3 { margin-right: auto; }
${workspace} article { padding: 16px; gap: 12px; border-radius: var(--wc-radius, 9px); }
${workspace} .signoff-card-header h3 { font-size: 14px; }
${workspace} :is(.signoff-card-status, .signoff-request-details) { font-size: 12px; }
${workspace} [data-signoff-history] [data-signoff-state] { font-size: 11px; }
${workspace} .signoff-filters { grid-template-columns: minmax(0, 1fr) minmax(180px, .6fr) auto; gap: 12px; }
${workspace} .signoff-filter-actions { grid-column: auto; }
${workspace} [data-signoff-create] { max-width: 850px; }
${workspace} [data-signoff-create][open] > summary { margin-bottom: 12px; }
${workspace} [data-signoff-create] > form, ${workspace} form[aria-label="Request customer completion"] {
  max-width: 850px; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface);
}
${workspace} .signoff-billing-fields { min-width: 0; padding: 12px; gap: 12px; align-items: end; border-radius: var(--wc-radius, 9px); }
${workspace} .signoff-billing-fields legend { padding-inline: 4px; font-size: 12px; }
${workspace} :is(.signoff-expiry-help, .signoff-replacement-notice) { font-size: 12px; }
${workspace} pre { margin: 0; padding: 12px; border-radius: var(--wc-radius, 9px); font-size: 13px; }
${workspace} [data-signoff-preview]:not(:empty) { display: grid; gap: 16px; margin-top: 16px; }
${workspace} [data-completion-preview]:not(:empty) { display: grid; gap: 16px; }
${workspace} [data-customer-preview-freshness] { display: grid; gap: 8px; padding: 12px; border-left: 3px solid var(--accent); background: var(--surface-sunk); font-size: 12px; }
${workspace} label:has(input[type="checkbox"]) { display: flex; align-items: center; gap: 8px; min-height: var(--wc-control-h, 40px); cursor: pointer; }
${workspace} input[type="checkbox"] { flex: 0 0 18px; width: 18px; height: 18px; min-height: 18px; padding: 0; margin: 0; }
${workspace} .completion-filters { display: grid; grid-template-columns: minmax(180px, 320px) auto; justify-content: start; align-items: end; gap: 12px; }
${workspace} .completion-filter-field { display: grid; min-width: 0; gap: 6px; }
${workspace} .reminder-account-field { display: grid; min-width: 0; gap: 6px; }
${workspace} [data-signoff-reminder-editor] form { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; }
${workspace} [data-signoff-reminder-editor] form > :is(p, button) { grid-column: 1 / -1; }
${workspace} [data-customer-link-share] { gap: 12px; padding: 16px; border-radius: var(--wc-radius, 9px); }
@media (max-width: 640px) {
  ${workspace} .signoff-filters, ${workspace} .completion-filters, ${workspace} [data-signoff-reminder-editor] form { grid-template-columns: minmax(0, 1fr); }
  ${workspace} .signoff-filters .signoff-filter-actions { grid-column: 1; }
  ${workspace} article, ${workspace} [data-signoff-create] > form, ${workspace} form[aria-label="Request customer completion"], ${workspace} [data-customer-link-share] { padding: 12px; }
  ${workspace} .signoff-billing-fields { padding: 10px; }
}
`;
