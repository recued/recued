const host = '[data-recued-housekeeping-panel-host]';

export const HOUSEKEEPING_WORKSPACE_STYLES = `
${host} {
  --wc-control-h: 44px;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
${host} :where(*) { box-sizing: border-box; min-width: 0; max-width: 100%; }
${host} [hidden] { display: none !important; }
${host} .housekeeping-panel { gap: 16px; font-size: 14px; line-height: 1.5; }
${host} .housekeeping-header { display: grid; gap: 8px; }
${host} .housekeeping-header h2 { margin: 0; font-size: 22px; line-height: 1.3; }
${host} .housekeeping-summary { max-width: 70ch; font-size: 13px; line-height: 1.5; }
${host} :is(.housekeeping-schedule, .housekeeping-producers) { gap: 16px; padding: clamp(14px, 2vw, 20px); border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 10px); background: var(--surface); }
${host} :is(.housekeeping-schedule, .housekeeping-producers) h3 { font-size: 16px; line-height: 1.4; }
${host} .housekeeping-preset-picker { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
${host} .housekeeping-preset-picker legend { margin-bottom: 10px; font-size: 13px; }
${host} .housekeeping-preset-choice { align-items: start; gap: 4px 10px; padding: 12px; border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); }
${host} .housekeeping-preset-choice:has(input:checked) { border-color: var(--accent); }
${host} .housekeeping-preset-choice input { margin-top: 4px; }
${host} :is(.housekeeping-preset-desc, .housekeeping-custom-hint, .housekeeping-current-summary) { font-size: 12px; line-height: 1.5; }
${host} .housekeeping-custom-fields { gap: 14px; padding: 14px; border-radius: var(--wc-radius, 6px); }
${host} .housekeeping-custom-row { gap: 8px 12px; }
${host} .housekeeping-custom-row label { min-width: 0; }
${host} .housekeeping-actions { gap: 10px; }
${host} :is(button, a, summary) { min-width: 44px; min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
${host} button[class] { min-width: 44px; min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
${host} :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]), select, textarea) { min-height: 44px; max-width: 100%; font: inherit; font-size: 13px; }
${host} select { height: 44px; overflow: hidden; text-overflow: ellipsis; }
${host} label:has(input:is([type="checkbox"], [type="radio"])) { min-width: 44px; min-height: 44px; }
${host} .housekeeping-producer-filter-bar { gap: 10px; }
${host} .housekeeping-producer-search { min-width: 0; padding: 10px 12px; border-radius: var(--wc-radius, 6px); font-size: 13px; }
${host} .housekeeping-producer-cost-toggle { flex: 0 1 auto; }
${host} .housekeeping-producer-cost-segment { min-width: 44px; min-height: 44px; padding: 8px; font-size: 12px; }
${host} .housekeeping-producer-table { font-size: 13px; }
${host} .housekeeping-producer-table th { padding: 8px; font-size: 12px; }
${host} .housekeeping-producer-row td { padding: 12px 8px; }
${host} .housekeeping-producer-topic-head { gap: 8px; }
${host} .housekeeping-producer-oneliner { margin-top: 4px; font-size: 12px; line-height: 1.5; }
${host} .housekeeping-producer-action { white-space: nowrap; }
${host} .housekeeping-producer-runpolicy { min-width: 0; }
${host} .housekeeping-producer-runpolicy-seg { min-width: 44px; min-height: 44px; }
${host} .housekeeping-producer-runpolicy-seg span { min-width: 44px; min-height: 44px; padding: 8px; font-size: 12px; }
${host} .housekeeping-producer-cost-line { padding: 10px 14px; font-size: 13px; line-height: 1.5; }
${host} .housekeeping-drawer { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 14px; padding: 14px; }
${host} .housekeeping-drawer-section { padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 6px); background: var(--surface); }
${host} .housekeeping-drawer-section h4 { margin: 0 0 10px; font-size: 14px; line-height: 1.4; }
${host} .housekeeping-drawer-section p { line-height: 1.5; }
${host} :is(.housekeeping-drawer-reset-section, .housekeeping-drawer-recent-runs, .housekeeping-drawer-error-history) { grid-column: 1 / -1; }
${host} .housekeeping-drawer-radios { gap: 10px; }
${host} .housekeeping-drawer-radio { gap: 4px 8px; align-items: start; padding: 6px 0; }
${host} .housekeeping-drawer-radio input { margin-top: 4px; }
${host} :is(.housekeeping-drawer-radio-desc, .housekeeping-drawer-coverage-reasoning, .housekeeping-drawer-coverage-stats, .housekeeping-drawer-confidence-meta, .housekeeping-drawer-wipe-note, .housekeeping-drawer-read-access-note) { font-size: 12px; line-height: 1.5; }
${host} :is(.housekeeping-drawer-runs, .housekeeping-drawer-recent-runs, .housekeeping-drawer-error-time) { font-size: 12px; }
${host} .housekeeping-drawer-runs td { padding: 8px 6px; }
${host} .housekeeping-drawer-read-access-link { min-height: 44px; font-size: 13px; }
${host} .housekeeping-drawer-coverage-bias summary { min-height: 44px; padding: 10px 0; font-size: 12px; }
${host} :is(.housekeeping-reset-modal-card, .housekeeping-runnow-dialog-card) { width: min(480px, calc(100% - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 20px; border-radius: var(--wc-radius-lg, 10px); }
${host} .housekeeping-reset-modal-header h3,
${host} .housekeeping-runnow-dialog-title { font-size: 16px; line-height: 1.4; }
${host} .housekeeping-runnow-dialog-actions { flex-wrap: wrap; }
${host} .housekeeping-reset-psi-toggle { min-height: 44px; }
@media (min-width: 721px) {
  ${host} .housekeeping-producer-action { width: 148px; min-width: 148px; }
}
@media (max-width: 720px) {
  ${host} .housekeeping-producer-table .housekeeping-producer-row { gap: 10px; padding: 12px; }
  ${host} .housekeeping-producer-row td { padding: 0; }
  ${host} .housekeeping-producer-action { gap: 8px; white-space: normal; }
}
`;
