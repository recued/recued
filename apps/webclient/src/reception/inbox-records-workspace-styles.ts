/** Quiet canvas scale for the Inbox and the two Records lenses. Scoped to
 * Reception so embedded inbox panels keep their host's existing layout. */
const route = '[data-recued-reception-route]';
const records = `${route} [data-recued-reception-records]`;
const responses = `${route} [data-recued-reception-responses]`;

export const RECEPTION_INBOX_RECORDS_WORKSPACE_STYLES = `
${route} .reception-route-title { font-size: var(--wc-font-title, 26px); }
${route} .reception-inbox-shell { border-radius: var(--wc-radius, 9px); box-shadow: none; font-size: 13px; line-height: 1.5; }
${route} .reception-inbox-head { padding: 16px; gap: 12px; background: var(--surface); }
${route} .reception-inbox-title { font-size: 18px; }
${route} .reception-inbox-detail-title { font-size: 16px; }
${route} .reception-inbox-btn { min-height: var(--wc-control-h, 40px); padding: 8px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; }
${route} .reception-inbox-form { gap: 16px; }
${route} .reception-inbox-field { gap: 6px; }
${route} .reception-inbox-check-field { display: flex; align-items: center; gap: 8px; min-height: var(--wc-control-h, 40px); cursor: pointer; }
${route} .reception-inbox-check-field input[type="checkbox"] { order: -1; flex: 0 0 18px; width: 18px; height: 18px; min-height: 18px; margin: 0; padding: 0; }
${route} .reception-inbox-field :is(input:not([type="checkbox"]), select, textarea),
${route} .reception-inbox-reason { min-height: var(--wc-control-h, 40px); padding: 8px 11px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4; }
${route} .reception-inbox-reason { margin-top: 16px; min-height: 80px; }
${route} .reception-inbox-detail-actions { gap: 8px; margin-top: 16px; padding-top: 12px; }
${route} .reception-inbox-help { font-size: var(--wc-font-small, 12px); line-height: 1.5; }
${route} .reception-inbox-chip { font-size: 11px; font-weight: 500; }
${route} .reception-inbox-row { border-radius: var(--wc-radius, 9px); box-shadow: none; }
${route} .reception-inbox-row[aria-selected="true"] { box-shadow: inset 3px 0 0 var(--accent); }
${route} .reception-inbox-row-title { font-size: 13px; }
${route} .reception-inbox-row-subtitle { font-size: 12px; line-height: 1.5; }

${route} [data-recued-reception-records-section], ${records} .reception-records-shell { min-width: 0; gap: 16px; font-size: 13px; line-height: 1.5; }
${route} .reception-records-lenses { max-width: 100%; }
${route} .reception-records-lens, ${records} :is(.reception-records-chip, .reception-records-details-button, .reception-records-action),
${responses} [data-recued-reception-response-action]:not([data-recued-reception-response-action="open"]),
${responses} .reception-responses-automation-actions a {
  min-height: var(--wc-control-h, 40px); padding: 8px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4;
}
${records} .reception-records-filters { gap: 12px; align-items: start; }
${records} .reception-records-chipset { min-width: 0; max-width: 100%; flex-wrap: wrap; }
${records} .reception-records-chip { flex: 1 0 auto; padding-inline: 8px; white-space: nowrap; overflow-wrap: normal; }
${records} .reception-records-row { min-width: 0; padding: 16px; gap: 12px; border-radius: var(--wc-radius, 9px); }
${records} .reception-records-row-head { gap: 8px 12px; }
${records} .reception-records-row-foot { min-width: 0; gap: 8px 16px; align-items: center; overflow-wrap: anywhere; }
${records} .reception-records-details { gap: 12px; padding-top: 12px; }
${records} .reception-records-answer { grid-template-columns: 168px minmax(0, 1fr); gap: 8px 16px; }
${records} :is(.reception-records-error, .reception-records-details-error) { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
${records} .reception-records-action { border: 1px solid var(--border); background: var(--surface); color: var(--fg); }

${responses} { font-size: 13px; line-height: 1.5; gap: 16px; }
${responses} [data-recued-reception-response-detail] { display: grid; min-width: 0; gap: 16px; }
${responses} [data-recued-reception-response-action="close"] { justify-self: start; }
${responses} .reception-responses-header { gap: 12px; }
${responses} .reception-responses-header h2 { font-size: 16px; }
${responses} .reception-responses-list { margin: 0; gap: 8px; }
${responses} .reception-responses-list li { border-radius: var(--wc-radius, 9px); }
${responses} .reception-responses-list button { padding: 16px; gap: 8px 16px; }
${responses} .reception-responses-meta, ${responses} .reception-responses-fields {
  min-width: 0; margin: 0; padding: 16px; gap: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface);
}
${responses} .reception-responses-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
${responses} .reception-responses-fields > div { display: grid; min-width: 0; grid-template-columns: 168px minmax(0, 1fr); gap: 8px 16px; }
${responses} :is(.reception-responses-meta, .reception-responses-fields) dt { font-size: 12px; font-weight: 600; text-transform: none; letter-spacing: normal; }
${responses} :is(.reception-responses-meta, .reception-responses-fields) dd { margin: 4px 0 0; overflow-wrap: anywhere; }
${responses} .reception-responses-fields dd { margin: 0; }
${responses} h3 { margin: 0; font-size: 14px; }
${responses} .reception-responses-automation { gap: 16px; padding: 16px; border-radius: var(--wc-radius, 9px); align-items: center; }
@media (max-width: 640px) {
  ${route} .reception-inbox-head, ${route} .reception-inbox-list, ${route} .reception-inbox-detail,
  ${records} .reception-records-row, ${responses} .reception-responses-list button,
  ${responses} .reception-responses-meta, ${responses} .reception-responses-fields, ${responses} .reception-responses-automation { padding: 12px; }
  ${records} .reception-records-answer, ${responses} .reception-responses-fields > div { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  ${responses} .reception-responses-meta { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  ${route} .reception-inbox-detail-actions { display: grid; grid-template-columns: minmax(0, 1fr); }
}
`;
