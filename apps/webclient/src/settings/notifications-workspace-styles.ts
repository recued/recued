/** Shared presentation for the five notification cards. Each panel keeps
 * ownership of its settings, pending work, feedback and focus. */
const section = '[data-recued-settings-section="notifications"]';
const cards = `${section} :is([data-recued-notifications-panel], [data-recued-kind-policy-panel], [data-situation-delivery], [data-recued-quiet-hours-panel], [data-household-delivery])`;

export const NOTIFICATIONS_WORKSPACE_STYLES = `
${section} {
  --wc-control-h: 44px;
  min-width: 0;
  max-width: 100%;
  gap: 20px;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${section} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${section} > h2 { margin: 0; font-size: 22px; line-height: 1.3; }
${cards} {
  gap: 16px;
  padding: 20px;
  border-radius: 12px;
  background: var(--surface);
  font-size: 14px;
  line-height: 1.55;
}
${cards} :is(h3, .notif-title) { margin: 0; font-size: 18px; line-height: 1.4; font-weight: 650; }
${cards} :is(h4, .notif-phrase-heading) { font-size: 16px; line-height: 1.4; font-weight: 650; }
${cards} :is(.notif-lede, .kp-lede, .sd-lede, .hd-lede) { margin: 0; font-size: 14px; line-height: 1.55; }
${cards} :is(.notif-row-status, .notif-email-steps, .notif-phrase-hint, .notif-bridge-empty, .kp-note, .qh-hint, .sd-hint, .hd-hint, .hd-note, [data-overview-results]) { font-size: 13px; line-height: 1.55; }
${cards} :is(.notif-row, .hd-block) { gap: 12px; padding: 16px; border-radius: 8px; background: var(--surface-sunk); }
${cards} .notif-list { gap: 12px; }
${cards} .notif-row-header { gap: 10px; }
${cards} .notif-row-name { font-size: 14px; font-weight: 650; }
${cards} .notif-row-capability { max-width: 100%; padding: 4px 8px; font-size: 12px; }
${cards} .notif-row-cells { gap: 20px; }
${cards} .notif-axis-label { font-size: 12px; }
${cards} .notif-axis-fixed { height: auto; min-height: 44px; font-size: 13px; }
${cards} .notif-bridge-group { margin-top: 0; padding-top: 12px; gap: 12px; }
${cards} .notif-bridge-row { gap: 12px; padding: 12px; border-radius: 8px; background: var(--surface); }
${cards} .notif-bridge-row-head { flex-wrap: wrap; gap: 10px; }
${cards} .notif-bridge-row-label { font-size: 13px; }
${cards} .notif-bridge-row-presence { padding: 4px 8px; font-size: 12px; }
${cards} .notif-phrase { gap: 12px; margin-top: 0; padding-top: 16px; }
${cards} :is(.notif-actions, .notif-phrase-controls, .notif-bridge-row-buttons, .sd-actions, .hd-actions) { flex-wrap: wrap; gap: 10px; }
${cards} .notif-phrase-input { flex: 1 1 16rem; min-width: 0; }
${cards} :is(input:not([type="checkbox"]), select) {
  min-width: 0;
  max-width: 100%;
  height: 44px;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
}
${cards} button {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  height: auto;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: normal;
}
/* The whole label is the target; the native checkbox stays compact. */
${cards} label:has(> input[type="checkbox"]) {
  display: flex;
  align-items: center;
  min-width: 44px;
  min-height: 44px;
  gap: 10px;
  padding: 8px 0;
  cursor: pointer;
}
${cards} input[type="checkbox"] { flex: 0 0 18px; width: 18px; height: 18px; min-width: 18px; min-height: 18px; margin: 0; accent-color: var(--accent); }
${cards} label:has(> input:disabled) { cursor: not-allowed; }
${cards} :is(button, input:not([type="checkbox"]), select, summary):focus-visible,
${cards} label:has(> input[type="checkbox"]:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 8px; }
${cards} label > input[type="checkbox"]:focus-visible { outline: none; }
${cards} [data-recued-kind-policy-row] { display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 12rem); gap: 12px; padding: 12px 0; }
${cards} .kp-kind { min-width: 0; font-weight: 600; }
${cards} [data-recued-kind-policy-row] select { width: 100%; }
${cards} [data-recued-kind-policy-row] > :is(p, [role]) { grid-column: 1 / -1; }
${cards} .qh-range { display: grid; grid-template-columns: auto minmax(120px, 1fr) auto minmax(120px, 1fr) auto; align-items: center; gap: 10px; }
${cards} .qh-range input { width: 100%; }
${cards} .qh-range .rx-btn { margin-left: 0; }
${cards} :is([data-recued-quiet-hours-declared], [data-recued-quiet-hours-row]) { font-size: 13px; line-height: 1.55; }
${cards} [data-recued-quiet-hours-row-role="authoritative"] { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-sunk); color: var(--fg); }
${cards} :is(.sd-fields, .hd-field, .sd-field) { width: 100%; max-width: 100%; gap: 8px; }
${cards} .sd-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
${cards} .sd-field { min-width: 0; }
${cards} :is(.sd-field, .hd-field) > span { font-size: 13px; line-height: 1.5; font-weight: 600; color: var(--fg); }
${cards} :is(form, .hd-detail) { gap: 16px; }
${cards} :is(.sd-field, .hd-field) > :is(input, select) { width: 100%; }
${cards} :is(.hd-more, [data-overview-results]) summary { min-width: 44px; min-height: 44px; padding: 10px 0; font-size: 13px; line-height: 1.55; }
${cards} :is(.sd-sent, .hd-note) { padding: 12px; border-radius: 8px; }
${cards} :is(.notif-error, .notif-row-error, [data-recued-kind-policy-error], [data-recued-quiet-hours-blocked], [data-recued-quiet-hours-error], [data-situation-delivery-message][role="alert"], [data-household-read-status][role="alert"], .hd-note-issue):not(:empty) {
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-weak);
  color: var(--fg);
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  ${cards} { padding: 16px; }
  ${cards} :is(.notif-row, .hd-block) { padding: 12px; }
  ${cards} .sd-fields { grid-template-columns: 1fr; }
  ${cards} .qh-range { grid-template-columns: auto minmax(0, 1fr); }
  ${cards} .qh-range > button { grid-column: 1 / -1; }
  ${cards} .notif-phrase-controls > :is(input, button) { flex: 1 1 100%; width: 100%; }
}
@media (max-width: 480px) {
  ${cards} [data-recued-kind-policy-row] { grid-template-columns: 1fr; gap: 8px; }
}
`;
