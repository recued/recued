/** Devices presentation keeps native roster cells, single-row editors and
 * the mount's confirmation, freshness and focus ownership. */
const panel = '[data-recued-settings-section="devices"]';

export const DEVICES_WORKSPACE_STYLES = `
${panel} {
  --wc-control-h: 44px;
  min-width: 0;
  max-width: 100%;
  gap: 20px;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} #account-devices {
  margin: 0;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
${panel} .rx-section-title { margin-bottom: 12px; font-size: 22px; line-height: 1.3; font-weight: 650; }
${panel} .rx-section-hint { margin-bottom: 20px; font-size: 14px; line-height: 1.55; }
${panel} .account-devices-refresh { gap: 12px; margin-bottom: 16px; }
${panel} .account-devices-last-checked { font-size: 13px; line-height: 1.5; }
${panel} .account-devices-table-scroll { container-type: inline-size; scroll-padding: 8px; }
${panel} .account-devices-table { margin-top: 0; font-size: 14px; line-height: 1.5; }
${panel} .account-devices-th { padding: 12px; font-size: 13px; }
${panel} .account-devices-cell { padding: 12px; }
${panel} .account-devices-name { font-weight: 650; }
${panel} .account-devices-kind { margin-top: 4px; font-size: 13px; line-height: 1.5; }
${panel} .account-devices-current-badge { max-width: 100%; margin-top: 6px; padding: 4px 10px; font-size: 12px; line-height: 1.4; }
${panel} :is(button, input, .settings-devices-add-hint a) {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  font-size: 14px;
}
${panel} :is(button, .settings-devices-add-hint a) {
  height: auto;
  padding: 10px 14px;
  border-radius: 8px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} :is(button, input, .settings-devices-add-hint a):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} :is(.account-devices-actions, .account-devices-rename-actions, .account-devices-confirm-actions) { flex-wrap: wrap; gap: 10px; }
${panel} .account-devices-actions button { min-width: max-content; white-space: nowrap; overflow-wrap: normal; }
${panel} :is(.account-devices-rename-cell, .account-devices-confirm-cell) { padding: 0 12px 12px; }
${panel} :is(.account-devices-rename, .account-devices-confirm-panel) {
  gap: 12px;
  padding: 16px;
  border-radius: 8px;
}
${panel} .account-devices-rename {
  /* The editor stays within the visible rail even if the roster scrolls. */
  max-width: min(100%, calc(100cqi - 24px));
  border: 1px solid var(--border);
  background: var(--surface-sunk);
}
${panel} .account-devices-rename-label { font-size: 13px; line-height: 1.4; font-weight: 600; color: var(--fg); }
${panel} .account-devices-rename-input {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: 44px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.4;
  scroll-margin: 8px;
}
${panel} .account-devices-confirm-heading { font-size: 16px; line-height: 1.4; font-weight: 650; }
${panel} .account-devices-confirm-list { padding-left: 20px; line-height: 1.55; }
${panel} .account-devices-confirm-list li + li { margin-top: 6px; }
${panel} .account-devices-confirm-recover { font-size: 13px; line-height: 1.55; }
${panel} .account-devices-confirm-actions { margin-top: 0; }
${panel} :is(.account-devices-list-error, .account-devices-rename-error, .account-devices-confirm-error) {
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-weak);
  color: var(--fg);
  font-size: 14px;
  line-height: 1.55;
}
${panel} .account-devices-list-error { flex-wrap: wrap; gap: 12px; }
${panel} .account-devices-list-error-text { flex: 1 1 16rem; }
${panel} .account-devices-loading { margin-bottom: 16px; font-size: 14px; }
${panel} .account-devices-revoke-success { margin-bottom: 16px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); font-size: 14px; }
${panel} .account-devices-empty { padding: 20px 12px; }
${panel} .settings-devices-add-hint { margin: 0; }
@media (max-width: 640px) {
  ${panel} #account-devices { padding: 16px; }
  ${panel} :is(.account-devices-th, .account-devices-cell) { padding: 10px 8px; }
  ${panel} :is(.account-devices-rename-cell, .account-devices-confirm-cell) { padding: 0 8px 10px; }
  ${panel} :is(.account-devices-rename, .account-devices-confirm-panel) { padding: 12px; }
}
`;
