/** Quiet canvas spacing for the jobs board and its mounted job workspace. */
const jobs = '[data-customer-jobs]';

export const CUSTOMER_JOB_WORKSPACE_STYLES = `
${jobs} { gap: 16px; min-width: 0; font-size: 13px; line-height: 1.5; }
${jobs} h2 { font-size: 18px; }
${jobs} h3 { font-size: 16px; }
${jobs} h4 { font-size: 14px; }
${jobs} article { padding: 16px; gap: 16px; border-radius: var(--wc-radius, 9px); }
${jobs} :is(input:not([type="checkbox"]), select, textarea) {
  box-sizing: border-box; min-width: 0; min-height: var(--wc-control-h, 40px); padding: 8px 11px;
  border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4;
}
${jobs} button, ${jobs} .job-primary-action, ${jobs} [data-job-more-filters] > summary {
  box-sizing: border-box; min-height: var(--wc-control-h, 40px); max-width: 100%; padding: 8px 12px;
  border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.5;
}
${jobs} .job-primary-action { align-items: center; }
${jobs} :is(form, [data-job-list]) { gap: 16px; }
${jobs} label, ${jobs} .job-filter-field, ${jobs} .job-timeline-field { display: grid; gap: 6px; min-width: 0; font-size: 12px; }
${jobs} .job-actions, ${jobs} [data-timeline-actions], ${jobs} .statement-actions { gap: 8px; }
${jobs} .job-statuses { gap: 12px; }
${jobs} .job-statuses > div { gap: 6px; border-radius: var(--wc-radius, 9px); }
${jobs} .job-summary { gap: 12px 16px; }
${jobs} .job-summary h3 { font-size: 14px; }
${jobs} .job-summary p { font-size: 12px; }
${jobs} form[aria-label="Find customer jobs"] { grid-template-columns: minmax(0, 1fr) auto auto; gap: 12px; }
${jobs} [data-job-more-filters][open] { display: grid; grid-column: 1 / -1; grid-row: auto; grid-template-columns: minmax(0, 1fr); gap: 12px; }
${jobs} .job-filter-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
${jobs} [data-job-more-filters][open] > summary { grid-column: 1 / -1; justify-self: start; }
${jobs} .job-invoice { padding: 12px; gap: 12px; border-radius: var(--wc-radius, 9px); }
${jobs} :is([data-job-timeline], [data-job-closeout]) { padding: 16px; gap: 16px; border-radius: var(--wc-radius, 9px); }
${jobs} form[aria-label="Find job activity"] { grid-template-columns: minmax(0, 1fr) minmax(180px, .6fr) auto; align-items: end; gap: 12px; }
${jobs} [data-job-timeline-summary] { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; }
${jobs} [data-job-timeline-summary] > :is(details, [data-timeline-issue]) { grid-column: 1 / -1; }
${jobs} [data-job-timeline] ol { padding: 0; list-style: none; gap: 12px; }
${jobs} [data-job-timeline] li { padding: 12px; background: var(--surface-sunk); border-radius: 0 var(--wc-radius, 9px) var(--wc-radius, 9px) 0; }
${jobs} [data-job-closeout] label { display: flex; align-items: center; gap: 8px; min-height: var(--wc-control-h, 40px); cursor: pointer; }
${jobs} [data-job-closeout] input[type="checkbox"] { flex: 0 0 18px; width: 18px; height: 18px; padding: 0; margin: 0; }
${jobs} [data-customer-job-payment-statement] { gap: 16px; }
[data-customer-work] [data-customer-job-header] { gap: 8px; padding-top: 12px; }
[data-customer-work] [data-customer-job-header] h2 { font-size: 18px; line-height: 1.4; }
[data-customer-work] [data-customer-job-header] p { font-size: 12px; line-height: 1.5; }
@media (max-width: 640px) {
  ${jobs} article, ${jobs} :is([data-job-timeline], [data-job-closeout]) { padding: 12px; gap: 12px; }
  ${jobs} form[aria-label="Find customer jobs"] { grid-template-columns: minmax(0, 1fr) auto; }
  ${jobs} form[aria-label="Find customer jobs"] > .job-search-field { grid-column: 1 / -1; }
  ${jobs} [data-job-more-filters] { grid-column: 2; grid-row: 2; }
  ${jobs} [data-job-more-filters][open] { grid-column: 1 / -1; grid-row: 3; grid-template-columns: minmax(0, 1fr); }
  ${jobs} .job-filter-fields { grid-template-columns: minmax(0, 1fr); }
  ${jobs} form[aria-label="Find customer jobs"] > .job-actions { flex-wrap: wrap; }
  ${jobs} form[aria-label="Find job activity"], ${jobs} [data-job-timeline-summary] { grid-template-columns: minmax(0, 1fr); }
  ${jobs} .job-invoice { padding: 10px; }
}
`;
