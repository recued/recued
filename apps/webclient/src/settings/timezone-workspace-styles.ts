/** Timezone presentation preserves the renderer's native editor, clock
 * authority, save confirmation and recovery ownership. */
const panel = '[data-recued-server-timezone-panel]';
const tab = '[data-recued-settings-subtab-panel="timezone"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;
const zone = '[data-recued-server-timezone-zone]';
const clock = '[data-recued-server-timezone-clock]';

export const TIMEZONE_WORKSPACE_STYLES = `
${server} { gap: 20px; }
${server} > h2 { margin: 0; font-size: 22px; line-height: 1.3; }
${tab},
${panel} { min-width: 0; max-width: 100%; }
${panel} {
  --wc-control-h: 44px;
  gap: 20px;
  padding: 20px;
  border-radius: 12px;
  background: var(--surface);
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} h3 { font-size: 18px; line-height: 1.4; font-weight: 650; }
${panel} > h3 + p:not([role]) { font-size: 16px; line-height: 1.4; font-weight: 600; }
${panel} > label:has([data-recued-server-timezone-mode]) {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  min-width: 44px;
  min-height: 44px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
${panel} > label:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: inset 2px 0 0 var(--accent);
}
${panel} > label:has(input:disabled) { cursor: not-allowed; }
${panel} [data-recued-server-timezone-mode] { width: 18px; height: 18px; margin: 2px 0 0; }
${panel} > label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} [data-recued-server-timezone-mode]:focus-visible { outline: none; }
${panel} > p:has(> ${zone}) { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px; }
${panel} input[type="text"] {
  flex: 1 1 18rem;
  min-width: 0;
  max-width: 100%;
  height: 44px;
  min-height: 44px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface);
  font-size: 14px;
  line-height: 1.4;
}
${panel} button {
  flex: 0 0 auto;
  align-self: flex-start;
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  height: auto;
  padding: 10px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: pointer;
}
${panel} [data-recued-server-timezone-save] {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
${panel} button:disabled { cursor: not-allowed; }
${panel} :is(button, input[type="text"]):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} > p:has(> ${zone}) + p { color: var(--fg-muted); font-size: 13px; }
${panel} .server-timezone-feedback { gap: 16px; }
${panel} .server-timezone-feedback > div:has(> ${clock}) { display: flex; flex-direction: column; gap: 12px; }
${panel} ${clock} {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
  font-size: 13px;
  line-height: 1.55;
}
/* The server clock is the saved value; the browser clock is a comparison. */
${panel} [data-recued-server-timezone-clock-role="authoritative"] {
  padding: 16px;
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--fg);
  font-size: 14px;
}
${panel} [data-recued-server-timezone-error] {
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-weak);
  color: var(--fg);
  font-size: 14px;
  line-height: 1.55;
}
@media (max-width: 640px) {
  ${panel} { padding: 16px; }
  ${panel} > p:has(> ${zone}) { flex-direction: column; align-items: stretch; }
  ${panel} > p:has(> ${zone}) > :is(input, button) { flex: 0 0 auto; width: 100%; }
}
`;
