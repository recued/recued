/** Exposure presentation keeps the native permission table, fieldsets and
 * confirmation controls owned by the existing renderer. */
const panel = '[data-recued-exposure-panel]';
const tab = '[data-recued-settings-subtab-panel="exposure"]';
const server = `[data-recued-settings-section="server"]:has(${tab}[data-active="true"])`;

export const EXPOSURE_WORKSPACE_STYLES = `
${server} { gap: 16px; font-size: 13px; line-height: 1.5; }
${server} > h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }
${tab},
${panel} { min-width: 0; max-width: 100%; }
${panel} {
  --wc-control-h: 40px;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${panel} :where(*, *::before, *::after) { box-sizing: border-box; min-width: 0; }
${panel} .exposure-title { font-size: 16px; line-height: 1.4; font-weight: 600; }
${panel} :is(.exposure-help, .exposure-public-note) { line-height: 1.5; }
${panel} :is(.exposure-presets, .exposure-grid, .exposure-public-mcp-card,
  .exposure-apex, .exposure-lan-posture) {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 14px);
  background: var(--surface);
}
/* Keep legends inside their cards while retaining native fieldset semantics. */
${panel} :is(.exposure-presets, .exposure-apex) > legend { float: left; width: 100%; padding: 0; }
${panel} .exposure-legend,
${panel} .exposure-lan-posture h4 {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
}
${panel} .exposure-legend { flex-wrap: wrap; }
${panel} .exposure-custom-badge { padding: 4px 10px; font-size: 12px; line-height: 1.4; }
${panel} :is(.exposure-preset-row, .exposure-apex-row) {
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 12px;
  min-height: 44px;
  padding: 12px;
  border-radius: var(--wc-radius, 9px);
}
${panel} :is(.exposure-preset-row, .exposure-apex-row)[data-current="true"] { background: var(--accent-weak); }
${panel} :is(.exposure-preset-row, .exposure-apex-row)[data-disabled="true"] {
  opacity: 1;
  border-style: dashed;
  background: var(--surface-sunk);
  color: var(--fg-muted);
}
${panel} :is(.exposure-preset-body, .exposure-apex-body) { gap: 6px; }
${panel} :is(.exposure-preset-name, .exposure-apex-name) { font-weight: 600; }
${panel} :is(.exposure-preset-subtitle, .exposure-preset-desc, .exposure-apex-subtitle, .exposure-hint) {
  font-size: 12px;
  line-height: 1.5;
}
${panel} :is(.exposure-preset-radio, .exposure-apex-radio) { width: 18px; height: 18px; margin: 2px 0 0; }
${panel} .exposure-grid-table { table-layout: fixed; }
${panel} .exposure-grid-table th { padding: 8px 4px; font-size: 12px; line-height: 1.4; }
${panel} .exposure-grid-table th:not(:first-child) { width: 52px; }
${panel} .exposure-grid-cell { padding: 8px 4px; }
${panel} .exposure-grid-path { padding: 8px 8px 8px 4px; }
${panel} .exposure-grid-path-name { font-weight: 600; }
${panel} .exposure-grid-path-subtitle { margin-top: 4px; font-size: 12px; line-height: 1.45; }
${panel} .exposure-cell-target { min-width: 44px; min-height: 44px; border-radius: var(--wc-radius, 9px); }
${panel} .exposure-cell-checkbox { width: 18px; height: 18px; margin: 0; }
${panel} :is(.exposure-cell-target, .exposure-preset-row, .exposure-apex-row):has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
${panel} :is(.exposure-cell-checkbox, .exposure-preset-radio, .exposure-apex-radio):focus-visible { outline: none; }
${panel} .exposure-cell-target:not(.exposure-cell-target-disabled):hover { background: var(--accent-weak); }
${panel} :is(button, input[type="text"]) {
  min-width: 44px;
  min-height: var(--wc-control-h, 40px);
  max-width: 100%;
  font-size: 13px;
}
${panel} button { height: auto; padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; }
${panel} :is(button, input[type="text"], .exposure-connect-snippet):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
${panel} .exposure-lan-posture { align-items: flex-start; }
${panel} .exposure-lan-note { margin: 0; }
${panel} .exposure-lan-posture button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  cursor: pointer;
}
${panel} .exposure-lan-posture button > svg { flex-shrink: 0; }
${panel} .exposure-lan-posture button[hidden] { display: none; }
${panel} .exposure-lan-posture button:disabled { opacity: 0.6; cursor: not-allowed; }
${panel} :is(.exposure-public-note, .exposure-action-error, .exposure-apex-warning) { padding: 12px; border-radius: var(--wc-radius, 9px); }
${panel} .exposure-load-error { gap: 12px; padding: 16px; border-radius: var(--wc-radius-lg, 14px); }
${panel} .exposure-modal-overlay { padding: 20px; }
${panel} .exposure-modal-card {
  max-width: 560px;
  max-height: calc(100dvh - 40px);
  gap: 12px;
  padding: 20px;
  border-radius: var(--wc-radius-lg, 14px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-padding: 8px;
}
${panel} .exposure-modal-card > * { flex-shrink: 0; }
${panel} .exposure-modal-title { font-size: 16px; line-height: 1.4; font-weight: 600; }
${panel} :is(.exposure-modal-subtitle, .exposure-modal-bullets) { line-height: 1.5; }
${panel} .exposure-modal-bullets { gap: 8px; }
${panel} .exposure-modal-body { gap: 12px; }
${panel} .exposure-modal-phrase-label { gap: 6px; font-size: 12px; line-height: 1.4; font-weight: 600; }
${panel} .exposure-modal-phrase-input { height: var(--wc-control-h, 40px); width: 100%; padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 9px); background: var(--surface); color: var(--fg); font-family: inherit; line-height: 1.4; }
${panel} .exposure-modal-actions { flex-wrap: wrap; gap: 10px; }
${panel} .exposure-connect-snippet-label { margin: 0; font-size: 14px; line-height: 1.4; }
${panel} .exposure-connect-snippet {
  margin: 0;
  max-width: 100%;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-sunk);
  font-size: 12px;
  line-height: 1.5;
  scroll-margin-block: 8px;
}
${panel} .exposure-connect-snippet-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--muted); overflow-wrap: anywhere; }
${panel} .exposure-connect-snippet-note code { white-space: pre-wrap; overflow-wrap: anywhere; }
${panel} .exposure-write-status { display: block; margin: 8px 0 0; color: var(--fg-muted); font-size: 12px; line-height: 1.5; }
${panel} :is(.exposure-write-status, .exposure-grid-path, .exposure-preset-row, .exposure-apex-row):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--wc-radius, 9px); }
@media (max-width: 640px) {
  ${panel} { --wc-control-h: 44px; }
  ${panel} :is(.exposure-presets, .exposure-grid, .exposure-public-mcp-card,
    .exposure-apex, .exposure-lan-posture, .exposure-load-error) { padding: 12px; }
  ${panel} .exposure-modal-overlay { padding: 12px; }
  ${panel} .exposure-modal-card { max-height: calc(100dvh - 24px); padding: 12px; }
  ${panel} .exposure-modal-actions > button { width: 100%; }
  ${panel} :is(.exposure-public-mcp-card, .exposure-lan-posture, .exposure-load-error) > button { width: 100%; justify-content: center; }
}
`;
