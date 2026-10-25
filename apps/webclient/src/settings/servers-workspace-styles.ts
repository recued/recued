/** Servers presentation keeps address verification, Save and focus ownership
 * in the panel while matching the surrounding Settings workspaces. */
const section = '[data-recued-settings-section="servers"]';
const panel = `${section} [data-server-address-panel]`;
const row = `${panel} [data-server-address-row]`;
const status = '[data-server-address-status]';

export const SERVERS_WORKSPACE_STYLES = `
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
${section} > p { margin: 0; max-width: 68ch; color: var(--fg-muted); }
${panel} { display: flex; flex-direction: column; gap: 20px; }
${row} {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
${row} .server-address-name { margin: 0; font-size: 18px; line-height: 1.4; font-weight: 650; }
${row} .server-address-current { display: flex; flex-direction: column; gap: 4px; margin: 0; }
${row} .server-address-caption { font-size: 13px; color: var(--fg-muted); }
${row} .server-address-url { font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
${row} .server-address-field { display: flex; flex-direction: column; gap: 8px; }
${row} .server-address-field > span { font-size: 13px; font-weight: 600; }
${row} [data-server-address-input] {
  width: 100%;
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
  scroll-margin: 8px;
}
${row} .server-address-actions { display: flex; flex-wrap: wrap; gap: 10px; }
${row} button {
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
${row} :is(button, input, ${status}):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${row} ${status} {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
  color: var(--fg);
  font-size: 14px;
  line-height: 1.55;
}
${row} ${status}:empty { display: none; }
${row}[data-server-address-row-state="refused"] ${status} { border-color: var(--danger); background: var(--danger-weak); }
${row}:is([data-server-address-row-state="verified"], [data-server-address-row-state="saved"]) ${status} { border-color: var(--accent); background: var(--accent-weak); }
@media (max-width: 640px) {
  ${row} { padding: 16px; }
  ${row} .server-address-actions > button { flex: 1 1 8rem; }
}
`;
