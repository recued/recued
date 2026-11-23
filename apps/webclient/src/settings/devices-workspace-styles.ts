/** Devices presentation keeps native roster cells, single-row editors and
 * the mount's confirmation, freshness and focus ownership. */
const panel = '[data-recued-settings-section="devices"]';

export const DEVICES_WORKSPACE_STYLES = `
${panel} {
  --wc-control-h: 40px;
  --devices-cell-inset: 24px;
  min-width: 0;
  max-width: 100%;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} #account-devices {
  margin: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
${panel} .rx-section-title { margin-bottom: 12px; font-size: 20px; line-height: 1.3; font-weight: 600; }
${panel} .rx-section-hint { margin-bottom: 16px; font-size: 13px; line-height: 1.5; }
${panel} .account-devices-refresh { gap: 12px; margin-bottom: 16px; }
${panel} .account-devices-last-checked { font-size: 12px; line-height: 1.5; }
${panel} .account-devices-table-scroll { container-type: inline-size; scroll-padding: 8px; }
${panel} .account-devices-table { margin-top: 0; font-size: 13px; line-height: 1.5; }
${panel} .account-devices-th { padding: 10px 12px; font-size: 12px; }
${panel} .account-devices-cell { padding: 12px; }
${panel} .account-devices-name { font-weight: 600; }
${panel} .account-devices-kind { margin-top: 4px; font-size: 12px; line-height: 1.5; }
${panel} .account-devices-current-badge { max-width: 100%; margin-top: 6px; padding: 4px 10px; font-size: 12px; line-height: 1.4; }
${panel} :is(button, input, .settings-devices-add-hint a) {
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  font-size: 13px;
}
${panel} :is(button, .settings-devices-add-hint a) {
  font-size: 12px;
  height: auto;
  padding: 6px 12px;
  border-radius: var(--wc-radius, 9px);
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} :is(button, input, .settings-devices-add-hint a):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} :is(.account-devices-actions, .account-devices-rename-actions, .account-devices-confirm-actions) { flex-wrap: wrap; gap: 10px; }
${panel} .account-devices-actions button { min-width: max-content; white-space: nowrap; overflow-wrap: normal; }
${panel} :is(.account-devices-rename-cell, .account-devices-confirm-cell) { padding: 0 12px 12px; }
${panel} :is(.account-devices-rename, .account-devices-confirm-panel) {
  max-width: min(100%, calc(100cqi - var(--devices-cell-inset)));
  gap: 12px;
  padding: 16px;
  border-radius: var(--wc-radius, 9px);
}
/* Editors and destructive review fit the visible pane even when the roster scrolls. */
${panel} .account-devices-rename {
  border: 1px solid var(--border);
  background: var(--surface-sunk);
}
${panel} .account-devices-rename-label { font-size: 12px; line-height: 1.4; font-weight: 600; color: var(--fg); }
${panel} .account-devices-rename-input {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: var(--wc-control-h, 40px);
  padding: 6px 10px;
  border-radius: var(--wc-radius, 9px);
  font-size: 13px;
  line-height: 1.4;
  scroll-margin: 8px;
}
${panel} .account-devices-confirm-heading { font-size: 16px; line-height: 1.4; font-weight: 600; }
${panel} .account-devices-confirm-list { padding-left: 20px; line-height: 1.5; }
${panel} .account-devices-confirm-list li + li { margin-top: 6px; }
${panel} .account-devices-confirm-recover { font-size: 12px; line-height: 1.5; }
${panel} .account-devices-confirm-actions { margin-top: 0; }
${panel} :is(.account-devices-list-error, .account-devices-rename-error, .account-devices-confirm-error) {
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: var(--wc-radius, 9px);
  background: var(--danger-weak);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
}
${panel} .account-devices-list-error { flex-wrap: wrap; gap: 12px; }
${panel} .account-devices-list-error-text { flex: 1 1 16rem; }
${panel} .account-devices-loading { margin-bottom: 16px; font-size: 13px; }
${panel} .account-devices-revoke-success { margin-bottom: 16px; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); font-size: 13px; }
${panel} .account-devices-empty { padding: 16px 12px; }
${panel} .settings-devices-add-hint { margin: 0; }
@media (max-width: 640px) {
  ${panel} { --wc-control-h: 44px; --devices-cell-inset: 16px; }
  ${panel} #account-devices { padding: 12px; }
  ${panel} :is(.account-devices-rename-actions, .account-devices-confirm-actions) button { width: 100%; }
  ${panel} .settings-devices-add-hint a { width: 100%; justify-content: center; }
  ${panel} :is(.account-devices-th, .account-devices-cell) { padding: 10px 8px; }
  ${panel} :is(.account-devices-rename-cell, .account-devices-confirm-cell) { padding: 0 8px 10px; }
  ${panel} :is(.account-devices-rename, .account-devices-confirm-panel) { padding: 12px; }
}
`;
