/** Connect a device presentation preserves the two address cards, shared
 * checks and pairing guidance, and the renderer's control ownership. */
const panel = '[data-recued-connect-device-panel]';
const tab = '[data-recued-settings-subtab-panel="connect-device"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;

export const CONNECT_DEVICE_WORKSPACE_STYLES = `
${server} { gap: 20px; }
${server} > h2 { margin: 0; font-size: 22px; line-height: 1.3; }
${tab},
${panel} { min-width: 0; max-width: 100%; }
${panel} {
  --wc-control-h: 44px;
  gap: 20px;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} .connect-device-card {
  gap: 16px;
  padding: 20px;
  border-radius: 12px;
  background: var(--surface);
}
${panel} .connect-device-card-title {
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 650;
}
${panel} .connect-device-chip {
  max-width: 100%;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
}
${panel} .connect-device-steps { margin: 0; gap: 12px; }
${panel} .connect-device-steps li { grid-template-columns: 20px minmax(0, 1fr); gap: 8px 12px; line-height: 1.55; }
${panel} .connect-device-step-mark { width: 20px; height: 20px; font-size: 12px; }
${panel} .connect-device-step-action { gap: 10px 12px; font-size: 13px; line-height: 1.55; }
${panel} :is(button, .connect-device-url) {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  height: auto;
}
${panel} button {
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} .connect-device-url {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  white-space: normal;
  word-break: normal;
  overflow-wrap: anywhere;
}
${panel} :is(button, .connect-device-url):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
${panel} :is(.connect-device-note, .connect-device-port-note, .connect-device-hosted-note) { font-size: 13px; line-height: 1.55; }
${panel} .connect-device-routes-heading { margin: 0; font-weight: 650; }
${panel} .connect-device-routes { margin: 0; gap: 16px; }
${panel} .connect-device-routes li { line-height: 1.55; }
${panel} .connect-device-routes p { margin-bottom: 8px; }
${panel} .connect-device-route-badge {
  display: inline-block;
  max-width: 100%;
  padding: 4px 8px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
}
${panel} .connect-device-command {
  max-width: 100%;
  margin-top: 8px;
  padding: 12px;
  border-radius: 8px;
  overscroll-behavior-x: contain;
}
${panel} .connect-device-command code { font-size: 13px; line-height: 1.5; overflow-wrap: normal; word-break: normal; }
${panel} .connect-device-check-block { gap: 12px; }
${panel} .connect-device-check-status { margin: 0; font-size: 14px; line-height: 1.55; }
${panel} :is(.connect-device-check-error, .connect-device-step-action-error) {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-weak);
  color: var(--fg);
  font-size: 14px;
  line-height: 1.55;
}
${panel} .connect-device-probe-detail { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.55; }
${panel} .connect-device-probe-detail li + li { margin-top: 6px; }
${panel} .connect-device-pairing { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; padding-top: 20px; }
${panel} .connect-device-pairing h4 { margin: 0; font-size: 16px; line-height: 1.4; font-weight: 650; }
${panel} .connect-device-pairing-steps { margin: 0; padding-left: 24px; font-size: 14px; line-height: 1.55; }
${panel} .connect-device-pairing-steps li + li { margin-top: 8px; }
${panel} .connect-device-pairing > p { margin: 0; }
@media (max-width: 640px) {
  ${panel} .connect-device-card { padding: 16px; }
}
`;
