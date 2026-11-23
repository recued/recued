/** Quiet canvas layout for the global queues; nested job editors keep their own host styles. */
const followups = '[data-customer-followups-workspace]';
const editor = `${followups} :is([data-signoff-reminder-editor], [data-completion-reminder-editor], [data-payment-reminder-editor], [data-account-payment-reminder-editor])`;
const form = `${followups} form[aria-label$="follow-up"]`;
export const CUSTOMER_FOLLOWUP_WORKSPACE_STYLES = `
${followups} { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; max-width: 1100px; font-size: 13px; line-height: 1.5; }
${followups} [hidden] { display: none !important; }
${followups} :is(h2, h3, h4, p) { margin: 0; overflow-wrap: anywhere; }
${followups} h2 { font-size: 18px; }
${followups} h3 { font-size: 16px; }
${followups} h4 { font-size: 14px; }
${followups} [data-customer-followup-group] { min-width: 0; padding: 16px; border-radius: var(--wc-radius, 9px); }
${followups} [data-customer-followup-group] > summary { display: list-item; min-height: var(--wc-control-h, 40px); align-content: center; font-size: 14px; overflow-wrap: anywhere; }
${followups} [data-customer-followup-group][open] > summary { margin-bottom: 16px; }
${followups} :is([data-signoff-reminders], [data-completion-reminders], [data-payment-reminders], [data-account-payment-reminders]), ${editor} { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
${followups} :is([data-signoff-reminder-queue], [data-completion-reminder-queue], [data-payment-reminder-queue], [data-account-payment-reminder-queue]) { display: grid; gap: 12px; min-width: 0; }
${followups} article { display: grid; gap: 12px; min-width: 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
${followups} .request-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
${followups} .request-actions > button { box-sizing: border-box; min-height: var(--wc-control-h, 40px); max-width: 100%; width: fit-content; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); color: var(--fg); font: inherit; font-size: 12px; line-height: 1.5; }
${followups} .request-actions > button:disabled { opacity: .6; cursor: default; }
${form} { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; align-items: end; min-width: 0; }
${form} :is(label, .reminder-account-field) { display: grid; gap: 6px; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
${form} :is(input, select) { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 40px); padding: 8px 11px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); color: var(--fg); font: inherit; font-size: 13px; line-height: 1.4; }
${form} select { overflow: hidden; text-overflow: ellipsis; }
${form} > :is(p, .request-actions) { grid-column: 1 / -1; }
${form} [data-account-contact-default-status]:empty { display: none; }
${followups} :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 640px) {
  ${form} { grid-template-columns: minmax(0, 1fr); }
  ${followups} article, ${followups} [data-customer-followup-group] { padding: 12px; }
}
`;

const abuse = '[data-recued-reception-abuse-section]';
export const RECEPTION_ABUSE_WORKSPACE_STYLES = `
${abuse} { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; max-width: 1100px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
${abuse} .rx-panel-title { font-size: 16px; line-height: 1.4; }
${abuse} .reception-abuse-head { flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
${abuse} .reception-abuse-threshold { margin-bottom: 16px; font-size: 12px; }
${abuse} .reception-abuse-rows { gap: 12px; }
${abuse} .reception-abuse-row { gap: 8px; padding: 16px; border-radius: var(--wc-radius, 9px); background: var(--surface); }
${abuse} .reception-abuse-signal { font-size: 14px; }
${abuse} :is(.reception-abuse-desc, .reception-abuse-detail, .reception-abuse-suggest) { font-size: 13px; }
${abuse} button { min-height: var(--wc-control-h, 40px); max-width: 100%; padding: 8px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.5; }
${abuse} button:disabled { opacity: .6; cursor: default; }
${abuse} .reception-abuse-blocked { margin-top: 16px; }
${abuse} .reception-abuse-blocked-row { flex-wrap: wrap; gap: 12px; padding-block: 12px; }
${abuse} .reception-abuse-blocked-row > span { min-width: 0; flex: 1 1 240px; }
${abuse} .reception-abuse-blocked-row > button { flex: 0 0 auto; }
${abuse} :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 640px) { ${abuse} .reception-abuse-row { padding: 12px; } }
`;
