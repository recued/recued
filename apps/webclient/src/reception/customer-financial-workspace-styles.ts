/** Shared Quiet canvas scale for the account and invoice workspaces. */
const panel = ':is([data-customer-accounts], [data-customer-account-payments], [data-customer-payment-history], [data-receivables-aging], [data-customer-job-payment-statement], [data-customer-account-statement], [data-customer-account-payment-statement])[data-customer-financial-workspace]';

const styles = `
${panel} { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; max-width: 1100px; font-size: 13px; line-height: 1.5; }
${panel}[hidden], ${panel} [hidden] { display: none !important; }
${panel} :is(h3, h4, h5, p) { margin: 0; }
${panel} h3 { font-size: 16px; }
${panel} > h3:first-of-type { font-size: 18px; }
${panel} h4 { font-size: 14px; }
${panel} h5 { font-size: 13px; }
${panel} :is(p, label, legend) { overflow-wrap: anywhere; }
${panel} :is(form, fieldset) { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
${panel} :is(label, .financial-field) { display: grid; gap: 6px; min-width: 0; font-size: 12px; }
${panel} :is(input:not([type="checkbox"]):not([type="radio"]), select, textarea) {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; padding: 8px 11px; border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px); background: var(--surface); color: var(--fg); font: inherit; font-size: 13px; line-height: 1.4;
}
${panel} :is(input:not([type="checkbox"]):not([type="radio"]), select, button) { min-height: var(--wc-control-h, 40px); }
${panel} select { overflow: hidden; text-overflow: ellipsis; }
${panel} button { box-sizing: border-box; max-width: 100%; width: fit-content; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); color: var(--fg); font: inherit; font-size: 12px; line-height: 1.5; }
${panel} button:disabled { opacity: .6; cursor: default; }
${panel} :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
${panel} :is(.financial-actions, .request-actions, [data-account-actions], [data-aging-actions], [data-contact-default-actions], .payment-history-actions, .statement-actions) { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
${panel} :is(.financial-stack, [data-customer-account-list], [data-account-payment-history], [data-account-payment-invoices], [data-account-correction-history], [data-payment-history-entries], [data-invoice-credit-history], [data-payment-correction-history], [data-credit-correction-history], [data-refund-history], [data-refund-correction-history]) { display: grid; gap: 12px; min-width: 0; }
${panel} :is([data-customer-refunds], [data-invoice-credits], [data-payment-corrections], [data-credit-corrections], [data-refund-corrections], [data-account-payment-corrections], [data-invoice-section], [data-payment-receipt], [data-customer-account-statement], [data-customer-account-payment-statement], [data-account-payment-reminders], [data-account-payment-reminder-editor], [data-invoice-credit-copy], [data-refund-copy]) { display: grid; gap: 16px; min-width: 0; }
${panel} article { display: grid; min-width: 0; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); }
${panel} fieldset { margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); }
${panel} legend { padding-inline: 4px; font-size: 12px; }
${panel} pre { margin: 0; padding: 12px; background: var(--surface-sunk); border-radius: var(--wc-radius, 9px); white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
${panel} :is([data-account-contact-defaults], [data-receivables-aging]) { border-radius: var(--wc-radius, 9px); }
${panel}[data-receivables-aging] { padding: 16px; border-radius: var(--wc-radius, 9px); }
${panel} [data-account-job-choices] { display: grid; gap: 8px; }
${panel} :is([data-account-job-choices] > label, .account-confirmation) { display: flex; align-items: center; gap: 8px; min-height: var(--wc-control-h, 40px); cursor: pointer; }
${panel} input[type="checkbox"] { flex: 0 0 18px; width: 18px; height: 18px; min-height: 18px; padding: 0; margin: 0; }
${panel} :is(.financial-fields, form[aria-label="Record customer account payment"], form[aria-label="Edit account contact defaults"], form[data-invoice-credit-editor], form[data-refund-editor]) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; align-items: end; }
${panel} :is(form[aria-label="Record customer account payment"], form[aria-label="Edit account contact defaults"], form[data-invoice-credit-editor], form[data-refund-editor]) > :is(p, .financial-actions, .financial-fields, [data-contact-default-actions], [data-account-payment-invoices], [data-invoice-credit-preview], [data-refund-preview], a),
${panel} :is(form, .financial-fields) > label:has(textarea) { grid-column: 1 / -1; }
${panel} :is([data-invoice-credit-editor], [data-refund-editor], [data-payment-correction-editor], [data-credit-correction-editor], [data-refund-correction-editor], [aria-label="Correct customer account payment"]) textarea { min-height: 100px; }
${panel} form[aria-label="Find receivables"] { grid-template-columns: minmax(0, 1fr) minmax(180px, .6fr) minmax(140px, .4fr) auto; align-items: end; gap: 12px; }
${panel} [data-aging-totals] { gap: 12px; }
${panel} [data-aging-totals] dl { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; font-size: 12px; }
${panel} [data-aging-totals] dd { font-variant-numeric: tabular-nums; }
${panel} [data-customer-financial-document] { gap: 16px; }
${panel} [data-customer-financial-document] .financial-balance { padding: 12px; border-radius: var(--wc-radius, 9px); }
${panel} [data-customer-financial-document] table { font-size: 12px; }
@media (max-width: 900px) {
  ${panel} form[aria-label="Find receivables"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  ${panel} :is(.financial-fields, form[aria-label="Record customer account payment"], form[aria-label="Edit account contact defaults"], form[data-invoice-credit-editor], form[data-refund-editor], form[aria-label="Find receivables"]) { grid-template-columns: minmax(0, 1fr); }
  ${panel} article, ${panel}[data-receivables-aging] { padding: 12px; }
  ${panel} [data-account-contact-defaults] { padding: 12px; }
  ${panel} fieldset { padding: 10px; }
}
`;

export const mountCustomerFinancialWorkspaceStyles = (doc: Document, root: HTMLElement): void => {
  root.setAttribute('data-customer-financial-workspace', '');
  const style = doc.createElement('style');
  style.textContent = styles;
  root.appendChild(style);
};
