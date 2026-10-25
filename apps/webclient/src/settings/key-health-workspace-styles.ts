/** Key Health presentation. The panel retains its protection/read contract,
 * rotation gates, control references and focus ownership. */
const panel = '[data-recued-key-health-panel]';
const tab = '[data-recued-settings-subtab-panel="key-health"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;

export const KEY_HEALTH_WORKSPACE_STYLES = `
${server} { gap: 20px; }
${server} > h2 { margin: 0; font-size: 22px; line-height: 1.3; }
${tab},
${panel} { min-width: 0; max-width: 100%; }
${panel} {
  --wc-control-h: 44px;
  gap: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel}:not([data-recued-key-health-panel-state="idle"]) {
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
${panel} .key-health-title {
  font-size: 18px;
  line-height: 1.4;
  font-weight: 650;
}
${panel} .key-health-help { max-width: 76ch; line-height: 1.6; }
${panel} .key-health-list { gap: 16px; }
${panel} .key-health-card { gap: 12px; padding: 20px; border-radius: 12px; }
${panel} .key-health-card-title {
  font-size: 16px;
  line-height: 1.4;
  font-weight: 650;
}
${panel} .key-health-card-desc { font-size: 14px; line-height: 1.55; }
${panel} .key-health-card-meta { gap: 8px 12px; }
${panel} .key-health-card-rotated { font-size: 13px; line-height: 1.5; }
${panel} .key-health-card-note {
  font-size: 13px;
  line-height: 1.55;
  font-style: normal;
}
/* Availability remains explicit in the text and action set. A dashed card
   distinguishes inventory-only keys while keeping their explanations readable. */
${panel} .key-health-card-unavailable {
  opacity: 1;
  border-style: dashed;
  background: var(--surface-sunk);
}
${panel} :is(.key-health-chip, .keyfile-posture-chip) {
  align-self: flex-start;
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
${panel} .key-health-chip-healthy { background: var(--surface-sunk); }
${panel} .key-health-chip-warning { background: var(--surface-sunk); }
${panel} .keyfile-posture-card { margin-bottom: 8px; }
${panel} :is(.keyfile-posture-detail, .keyfile-posture-remediation) { line-height: 1.6; }
${panel} :is(.keyfile-posture-consequence, .key-health-compromise-banner) {
  padding: 12px 14px;
  border-radius: 8px;
  line-height: 1.6;
}
${panel} .key-health-depair-warning {
  padding: 12px 14px;
  border-left: 3px solid var(--danger);
  border-radius: 0 8px 8px 0;
  background: var(--danger-bg);
}
${panel} :is(.key-health-card-actions, .key-health-actions) { gap: 10px; }
${panel} button.key-health-btn {
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  height: auto;
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
${panel} button.key-health-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
${panel} .key-health-result {
  grid-template-columns: minmax(0, 13rem) minmax(0, 1fr);
  gap: 10px 16px;
  padding: 14px;
  border-radius: 8px;
  background: var(--surface-sunk);
  font-size: 13px;
  line-height: 1.55;
}
${panel} .key-health-result-value { overflow-wrap: anywhere; }
${panel} .key-health-error { padding: 12px; border-radius: 8px; font-size: 13px; }
@media (max-width: 600px) {
  ${panel}:not([data-recued-key-health-panel-state="idle"]),
  ${panel} .key-health-card { padding: 16px; }
  ${panel} .key-health-result { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  ${panel} .key-health-result-value:not(:last-child) { margin-bottom: 6px; }
}
`;
