/** Email chat presentation, shared by its panel and Settings route. */
const panel = '[data-recued-mail-chat-door-panel]';
const emailChat = '[data-recued-settings-section="email-chat"]';

export const EMAIL_CHAT_WORKSPACE_STYLES = `
${emailChat} {
  --wc-control-h: 40px;
  min-width: 0;
  max-width: 100%;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
}
${emailChat} > h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }
${emailChat} ${panel} {
  padding: 0;
  border: 0;
  background: transparent;
}
${emailChat} ${panel}:is([data-recued-mail-chat-door-state="loading"], [data-recued-mail-chat-door-state="error"]):not(:has(> .mcd-card)) {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
${panel} {
  --wc-control-h: 40px;
  min-width: 0;
  max-width: none;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} .mcd-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
${panel} h3 { font-size: 16px; line-height: 1.4; font-weight: 600; }
${panel} p { line-height: 1.5; }
${panel} .mcd-hint,
${panel} [data-recued-mail-chat-door-recent] {
  max-width: 72ch;
  font-size: 12px;
  line-height: 1.5;
}
${panel} .mcd-rules > p:first-of-type { font-weight: 600; }
${panel} :is(button, select, input:not([type="checkbox"])) {
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  border-radius: var(--wc-radius, 9px);
  font-size: 13px;
  line-height: 1.4;
}
${panel} button {
  height: auto;
  padding: 6px 12px;
  font-size: 12px;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} :is(button, select, input:not([type="checkbox"])):focus-visible,
${panel} label:has(> input[type="checkbox"]:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: var(--wc-radius, 9px);
}
${panel} label > input[type="checkbox"]:focus-visible { outline: none; }
${panel} :is(select, input:not([type="checkbox"])) {
  height: var(--wc-control-h, 40px);
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
}
${panel} select { width: 100%; }
${panel} label.mcd-field {
  display: grid;
  width: 100%;
  max-width: 32rem;
  align-items: start;
  gap: 6px;
}
${panel} :is(label.mcd-field > span, .mcd-stale-field > span:first-child) {
  font-size: 12px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} fieldset {
  gap: 4px;
  padding: 12px;
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-sunk);
}
${panel} legend { font-size: 12px; line-height: 1.4; }
${panel} label.rx-checkbox-row {
  min-height: 44px;
  padding: 8px 0;
  align-items: flex-start;
  flex-wrap: nowrap;
  gap: 10px;
  border-radius: var(--wc-radius, 9px);
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
${panel} label.rx-checkbox-row:has(> input:disabled) { cursor: not-allowed; }
${panel} label.rx-checkbox-row > span { flex: 1; }
${panel} input[type="checkbox"] {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  margin: 1px 0;
  accent-color: var(--accent);
}
${panel} label.mcd-prefix-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  padding: 0;
}
/* Different value lengths share the same field edge and maximum track. */
${panel} .mcd-prefix-row > input[type="text"] {
  grid-column: 1 / -1;
  width: 100%;
  max-width: 32rem;
}
${panel} label.mcd-stale-field { display: grid; align-items: start; gap: 6px; }
${panel} .mcd-duration { display: inline-flex; align-items: center; gap: 8px; }
${panel} input[type="number"] { width: 7rem; }
${panel} input[type="email"] { width: 100%; max-width: none; }
${panel} .mcd-row { gap: 10px; }
${panel} [data-recued-mail-chat-door-disclosure] {
  padding: 12px;
  border-radius: 0 var(--wc-radius, 9px) var(--wc-radius, 9px) 0;
  background: var(--surface-sunk);
}
${panel} [data-recued-mail-chat-door-enrol] { gap: 12px; }
${panel} [data-recued-mail-chat-door-enrol-sender] {
  gap: 10px;
  padding: 12px;
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-sunk);
}
${panel} ul,
${panel} ol { gap: 8px; }
${panel} .mcd-nowrap { white-space: normal; overflow-wrap: anywhere; }
${panel} [data-recued-mail-chat-door-paused] {
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: var(--wc-radius, 9px);
  background: var(--danger-weak);
  color: var(--fg);
}
${panel} [data-recued-mail-chat-door-error] {
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: var(--wc-radius, 9px);
  background: var(--danger-weak);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
}
@media (max-width: 640px) {
  ${emailChat}, ${panel} { --wc-control-h: 44px; }
  ${panel} .mcd-card,
  ${emailChat} ${panel}:is([data-recued-mail-chat-door-state="loading"], [data-recued-mail-chat-door-state="error"]):not(:has(> .mcd-card)) { padding: 12px; }
  ${panel} .mcd-row,
  ${panel} button { width: 100%; }
}
`;
