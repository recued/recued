/** Email chat presentation, shared by its panel and Settings route. */
const panel = '[data-recued-mail-chat-door-panel]';
const emailChat = '[data-recued-settings-section="email-chat"]';

export const EMAIL_CHAT_WORKSPACE_STYLES = `
${emailChat} {
  --wc-control-h: 44px;
  min-width: 0;
  gap: 20px;
}
${emailChat} > h2 { margin: 0; font-size: 22px; line-height: 1.3; }
${emailChat} ${panel} {
  padding: 0;
  border: 0;
  background: transparent;
}
${emailChat} ${panel}:is([data-recued-mail-chat-door-state="loading"], [data-recued-mail-chat-door-state="error"]) {
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
${panel} {
  min-width: 0;
  max-width: none;
  gap: 16px;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${panel} :where(*) { box-sizing: border-box; min-width: 0; }
${panel} .mcd-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
${panel} h3 {
  font-size: 16px;
  line-height: 1.4;
  font-weight: 650;
}
${panel} p { line-height: 1.55; }
${panel} .mcd-hint,
${panel} [data-recued-mail-chat-door-recent] {
  max-width: 72ch;
  font-size: 13px;
  line-height: 1.55;
}
${panel} .mcd-rules > p:first-of-type { font-weight: 600; }
${panel} :is(button, select, input:not([type="checkbox"])) {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  font-size: 14px;
}
${panel} button {
  height: auto;
  padding: 10px 14px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} :is(button, select, input):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
${panel} select {
  width: 100%;
  max-width: 32rem;
  height: 44px;
  padding: 8px 10px;
}
${panel} input:not([type="checkbox"]) { height: 44px; padding: 8px 10px; }
${panel} label.mcd-field {
  display: grid;
  align-items: start;
  gap: 8px;
}
${panel} label.mcd-field > span { font-weight: 600; }
${panel} fieldset { gap: 4px; padding: 10px; border-radius: 8px; }
${panel} legend { font-size: 14px; }
${panel} label.rx-checkbox-row {
  min-height: 44px;
  padding: 10px 8px;
  align-items: flex-start;
  flex-wrap: nowrap;
  gap: 10px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.5;
}
${panel} label.rx-checkbox-row > span { flex: 1; }
${panel} input[type="checkbox"] {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  margin: 2px 0;
}
${panel} label.mcd-prefix-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  padding: 0;
}
${panel} .mcd-prefix-row > input[type="text"] {
  grid-column: 2;
  width: 100%;
  max-width: 12rem;
}
${panel} label.mcd-stale-field { gap: 8px; }
${panel} .mcd-duration { display: inline-flex; align-items: center; gap: 8px; }
${panel} input[type="number"] { width: 7rem; }
${panel} input[type="email"] { max-width: 30rem; }
${panel} .mcd-row { gap: 10px; }
${panel} [data-recued-mail-chat-door-disclosure] {
  padding: 12px 14px;
  border-radius: 0 8px 8px 0;
}
${panel} [data-recued-mail-chat-door-enrol] { gap: 12px; }
${panel} [data-recued-mail-chat-door-enrol-sender] {
  gap: 10px;
  padding: 14px;
  border-radius: 8px;
  background: var(--bg);
}
${panel} ul,
${panel} ol { gap: 8px; }
${panel} .mcd-nowrap { white-space: normal; overflow-wrap: anywhere; }
${panel} [data-recued-mail-chat-door-paused] {
  gap: 12px;
  padding: 14px;
  border-radius: 8px;
}
${panel} [data-recued-mail-chat-door-error] { color: var(--danger); }
@media (max-width: 600px) {
  ${panel} .mcd-card { padding: 16px; }
}
`;
