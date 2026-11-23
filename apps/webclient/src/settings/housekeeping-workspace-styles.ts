const host = '[data-recued-housekeeping-panel-host]';

export const HOUSEKEEPING_WORKSPACE_STYLES = `
${host} {
  --wc-control-h: 40px;
  container: housekeeping / inline-size;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
${host} :where(*) { box-sizing: border-box; min-width: 0; max-width: 100%; }
${host} [hidden] { display: none !important; }
${host} .housekeeping-panel { gap: 16px; font-size: 13px; line-height: 1.5; }
${host} .housekeeping-header { display: grid; gap: 8px; }
${host} .housekeeping-header h2 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }
${host} .housekeeping-summary { max-width: 70ch; font-size: 13px; line-height: 1.5; }
${host} :is(.housekeeping-schedule, .housekeeping-producers) { gap: 16px; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface); }
${host} :is(.housekeeping-schedule, .housekeeping-producers) h3 { font-size: 16px; line-height: 1.4; }
${host} .housekeeping-preset-picker { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
${host} .housekeeping-preset-picker legend { margin-bottom: 12px; font-size: 12px; }
${host} .housekeeping-preset-choice { align-items: start; gap: 4px 10px; padding: 12px; border-radius: var(--wc-radius, 9px); background: var(--surface-subtle); }
${host} .housekeeping-preset-choice:has(input:checked) { border-color: var(--accent); }
${host} .housekeeping-preset-choice input { margin-top: 4px; }
${host} :is(.housekeeping-preset-desc, .housekeeping-custom-hint, .housekeeping-current-summary) { font-size: 12px; line-height: 1.5; }
${host} .housekeeping-custom-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; padding: 12px; border-radius: var(--wc-radius, 9px); }
${host} .housekeeping-custom-row { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; align-items: start; gap: 6px; }
${host} .housekeeping-custom-row label,
${host} .housekeeping-custom-window-label { min-width: 0; color: var(--fg-muted); font-size: 12px; font-weight: 600; }
${host} .housekeeping-custom-row input,
${host} .housekeeping-custom-row select { width: 100%; padding: 6px 10px; border-radius: var(--wc-radius, 9px); font-weight: 400; }
${host} .housekeeping-custom-window { grid-column: 1 / -1; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 6px 12px; }
${host} .housekeeping-custom-window > :is(.housekeeping-custom-window-label, .housekeeping-custom-hint) { grid-column: 1 / -1; }
${host} .housekeeping-actions { gap: 8px; }
${host} :is(button, a, summary) { min-width: 40px; min-height: var(--wc-control-h, 40px); white-space: normal; overflow-wrap: anywhere; }
${host} button[class] { padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; min-width: 40px; min-height: var(--wc-control-h, 40px); white-space: normal; overflow-wrap: anywhere; }
${host} :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]), select, textarea) { min-height: var(--wc-control-h, 40px); max-width: 100%; font: inherit; font-size: 13px; }
${host} select { height: var(--wc-control-h, 40px); overflow: hidden; text-overflow: ellipsis; }
${host} label:has(input:is([type="checkbox"], [type="radio"])) { min-width: 40px; min-height: var(--wc-control-h, 40px); }
${host} .housekeeping-producer-filter-bar { gap: 8px; }
${host} .housekeeping-producer-search { min-width: 0; padding: 6px 10px; border-radius: var(--wc-radius, 9px); font-size: 13px; }
${host} .housekeeping-producer-cost-toggle { flex: 0 1 auto; border-radius: var(--wc-radius, 9px); }
${host} button.housekeeping-producer-cost-segment { border-radius: 0; min-width: 40px; min-height: var(--wc-control-h, 40px); padding: 8px; font-size: 12px; }
${host} .housekeeping-producer-table { font-size: 13px; }
${host} .housekeeping-producer-table th { padding: 8px; font-size: 12px; }
${host} .housekeeping-producer-row td { padding: 12px 8px; }
${host} .housekeeping-producer-topic-head { gap: 8px; }
${host} .housekeeping-producer-oneliner { margin-top: 4px; font-size: 12px; line-height: 1.5; }
${host} .housekeeping-producer-action { white-space: nowrap; }
${host} .housekeeping-producer-runpolicy { min-width: 0; }
${host} .housekeeping-producer-runpolicy-seg { min-width: 40px; min-height: var(--wc-control-h, 40px); }
${host} .housekeeping-producer-runpolicy-seg span { min-width: 40px; min-height: var(--wc-control-h, 40px); padding: 8px; font-size: 12px; }
${host} .housekeeping-producer-cost-line { padding: 10px 14px; font-size: 13px; line-height: 1.5; }
${host} .housekeeping-drawer { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 12px; padding: 12px; }
${host} .housekeeping-drawer-section { padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
${host} .housekeeping-drawer-section h4 { margin: 0 0 12px; font-size: 14px; line-height: 1.4; }
${host} .housekeeping-drawer-section p { line-height: 1.5; }
${host} :is(.housekeeping-drawer-reset-section, .housekeeping-drawer-recent-runs, .housekeeping-drawer-error-history) { grid-column: 1 / -1; }
${host} .housekeeping-drawer-radios { gap: 10px; }
${host} .housekeeping-drawer-radio { gap: 4px 8px; align-items: start; padding: 6px 0; }
${host} .housekeeping-drawer-radio input { margin-top: 4px; }
${host} :is(.housekeeping-drawer-radio-desc, .housekeeping-drawer-coverage-reasoning, .housekeeping-drawer-coverage-stats, .housekeeping-drawer-confidence-meta, .housekeeping-drawer-wipe-note, .housekeeping-drawer-read-access-note) { font-size: 12px; line-height: 1.5; }
${host} :is(.housekeeping-drawer-runs, .housekeeping-drawer-recent-runs, .housekeeping-drawer-error-time) { font-size: 12px; }
${host} .housekeeping-drawer-runs td { padding: 8px 6px; }
${host} .housekeeping-drawer-read-access-link { min-height: var(--wc-control-h, 40px); font-size: 13px; }
${host} .housekeeping-drawer-coverage-bias summary { min-height: var(--wc-control-h, 40px); padding: 10px 0; font-size: 12px; }
${host} :is(.housekeeping-reset-modal-card, .housekeeping-runnow-dialog-card) { width: min(480px, calc(100% - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 16px; border-radius: var(--wc-radius-lg, 14px); }
${host} .housekeeping-reset-modal-header h3,
${host} .housekeeping-runnow-dialog-title { font-size: 16px; line-height: 1.4; }
${host} .housekeeping-runnow-dialog-actions { flex-wrap: wrap; gap: 8px; }
${host} :is(.housekeeping-promotion-banner, .housekeeping-drift-banner) { gap: 12px; padding: 16px; border-radius: var(--wc-radius-lg, 14px); }
${host} .housekeeping-reset-psi-toggle { min-height: var(--wc-control-h, 40px); }
@media (max-width: 640px) {
  ${host} { --wc-control-h: 44px; }
  ${host} :is(button, a, summary, .housekeeping-producer-runpolicy-seg, .housekeeping-producer-runpolicy-seg span) { min-width: 44px; }
  ${host} .housekeeping-custom-fields { grid-template-columns: minmax(0, 1fr); }
  ${host} :is(.housekeeping-schedule, .housekeeping-producers, .housekeeping-reset-modal-card, .housekeeping-runnow-dialog-card, .housekeeping-promotion-banner, .housekeeping-drift-banner) { padding: 12px; }
  ${host} :is(.housekeeping-runnow-dialog-actions, .housekeeping-reset-actions, .housekeeping-promotion-banner-actions, .housekeeping-drift-banner-actions) > button { width: 100%; }
}
@media (min-width: 721px) {
  ${host} .housekeeping-producer-action { width: 148px; min-width: 148px; }
}
@media (max-width: 720px) {
  ${host} .housekeeping-producer-table .housekeeping-producer-row { gap: 10px; padding: 12px; }
  ${host} .housekeeping-producer-row td { padding: 0; }
  ${host} .housekeeping-producer-action { gap: 8px; white-space: normal; }
}
/* Settings can leave a narrow pane beside its rail on a wider viewport. */
@container housekeeping (max-width: 600px) {
  ${host} .housekeeping-producer-table,
  ${host} .housekeeping-producer-table tbody,
  ${host} .housekeeping-producer-table tr,
  ${host} .housekeeping-producer-table td { display: block; width: 100%; }
  ${host} .housekeeping-producer-table thead { display: none; }
  ${host} .housekeeping-producer-row-group { margin-bottom: 8px; }
  ${host} .housekeeping-producer-table .housekeeping-producer-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius, 9px);
    background: var(--surface);
  }
  ${host} .housekeeping-producer-row td { min-width: 0; padding: 0; border-bottom: 0; }
  ${host} .housekeeping-producer-topic { grid-column: 1 / -1; }
  ${host} .housekeeping-producer-runpolicy-cell { grid-column: 1; }
  ${host} .housekeeping-producer-last-run { grid-column: 2; align-self: center; color: var(--fg-muted); }
  ${host} .housekeeping-producer-action {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    width: auto;
    min-width: 0;
    gap: 8px;
    white-space: normal;
  }
  ${host} .housekeeping-producer-row-group[data-expanded="true"] .housekeeping-producer-row {
    border-bottom: 0;
    border-radius: var(--wc-radius, 9px) var(--wc-radius, 9px) 0 0;
  }
  ${host} .housekeeping-producer-drawer-cell {
    padding: 10px 0 0;
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 var(--wc-radius, 9px) var(--wc-radius, 9px);
    overflow: hidden;
  }
  ${host} .housekeeping-producer-cost-line { padding: 0 12px 10px; }
}
`;
