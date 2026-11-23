/** Timezone presentation preserves the renderer's native editor, clock
 * authority, save confirmation and recovery ownership. */
const panel = '[data-recued-server-timezone-panel]';
const tab = '[data-recued-settings-subtab-panel="timezone"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;
const clock = '[data-recued-server-timezone-clock]';

export const TIMEZONE_WORKSPACE_STYLES = `
${server} { gap: 16px; font-size: 13px; line-height: 1.5; }
${server} > h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }
${tab},
${panel} { min-width: 0; max-width: 100%; }
${panel} {
  --wc-control-h: 40px;
  gap: 16px;
  padding: 16px;
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} h3 { font-size: 16px; line-height: 1.4; font-weight: 600; }
${panel} > h3 + p:not([role]) { font-size: 14px; line-height: 1.4; font-weight: 600; }
${panel} > label:has([data-recued-server-timezone-mode]) {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  min-width: 44px;
  min-height: 44px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  cursor: pointer;
}
${panel} > label:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: inset 2px 0 0 var(--accent);
}
${panel} > label:has(input:disabled) { cursor: not-allowed; }
${panel} [data-recued-server-timezone-mode] { width: 18px; height: 18px; margin: 2px 0 0; }
${panel} .server-timezone-mode-copy { display: flex; flex-direction: column; gap: 4px; }
${panel} .server-timezone-mode-name { font-weight: 600; }
${panel} .server-timezone-mode-hint { color: var(--fg-muted); font-size: 12px; line-height: 1.5; }
${panel} > label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} [data-recued-server-timezone-mode]:focus-visible { outline: none; }
${panel} .server-timezone-editor { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: end; gap: 8px; }
${panel} .server-timezone-field { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
${panel} .server-timezone-field > span { font-size: 12px; line-height: 1.4; font-weight: 600; }
${panel} input[type="text"] {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: var(--wc-control-h, 40px);
  min-height: var(--wc-control-h, 40px);
  padding: 6px 10px;
  border-radius: var(--wc-radius, 9px);
  background: var(--surface);
  font-size: 13px;
  line-height: 1.4;
}
${panel} button {
  flex: 0 0 auto;
  justify-self: start;
  align-self: flex-start;
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  height: auto;
  padding: 6px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: pointer;
}
${panel} .server-timezone-editor > button { align-self: end; }
${panel} [data-recued-server-timezone-save] {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
${panel} button:disabled { cursor: not-allowed; }
${panel} :is(button, input[type="text"]):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} .server-timezone-help { color: var(--fg-muted); font-size: 12px; }
${panel} .server-timezone-feedback { gap: 12px; }
${panel} .server-timezone-feedback > p:last-child:not([role]):not(${clock}) { color: var(--fg-muted); font-size: 12px; }
${panel} .server-timezone-feedback > div:has(> ${clock}) { display: flex; flex-direction: column; gap: 8px; }
${panel} ${clock} {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-sunk);
  font-size: 12px;
  line-height: 1.5;
}
/* The server clock is the saved value; the browser clock is a comparison. */
${panel} [data-recued-server-timezone-clock-role="authoritative"] {
  padding: 12px;
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--fg);
  font-size: 13px;
}
${panel} [data-recued-server-timezone-error] {
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: var(--wc-radius, 9px);
  background: var(--danger-weak);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
}
@media (max-width: 640px) {
  ${panel} { --wc-control-h: 44px; padding: 12px; gap: 12px; }
  ${panel} .server-timezone-editor { grid-template-columns: minmax(0, 1fr); }
  ${panel} button { width: 100%; }
}
`;
