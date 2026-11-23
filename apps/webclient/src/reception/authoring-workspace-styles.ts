/** Aligned field groups shared by the routed editor and embedded authoring forms. */
export const RECEPTION_AUTHORING_WORKSPACE_STYLES = `
.reception-authoring-section-head, .reception-authoring-section-form { width: 100%; min-width: 0; }
.reception-form { max-width: 1100px; min-width: 0; margin: 0; gap: 20px; padding: 20px; border-radius: var(--wc-radius, 9px); box-shadow: 0 1px 2px rgba(24, 24, 27, .04); }
.reception-form :is(.reception-form-body, .reception-form-section, .reception-form-field, .reception-form-cell) { min-width: 0; }
.reception-form .reception-form-section { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; padding: 16px; border-radius: var(--wc-radius, 9px); align-items: start; }
.reception-form .reception-form-section-title { grid-column: 1 / -1; margin: 0; padding: 0; border: 0; font-size: 14px; font-weight: 650; text-transform: none; letter-spacing: 0; line-height: 1.5; color: var(--fg); }
.reception-form .reception-form-section > :is(p, .reception-form-repeater), .reception-form .reception-form-field:has(textarea), .reception-form .reception-form-field:has(.reception-form-checkgroup) { grid-column: 1 / -1; }
.reception-form :is(.reception-form-label, .reception-form-cell-label, .reception-form-help) { overflow-wrap: anywhere; }
.reception-form .reception-form-label { font-size: 12px; font-weight: 600; }
.reception-form :is(.reception-form-input, .reception-form-select, .reception-form-textarea) { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; padding: 8px 11px; min-height: var(--wc-control-h, 40px); border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.5; }
.reception-form .reception-form-textarea { min-height: 100px; }
.reception-form select { overflow: hidden; text-overflow: ellipsis; }
.reception-form .reception-form-checkgroup { gap: 8px 16px; }
.reception-form .reception-form-repeater { padding: 0; border: 0; background: transparent; }
.reception-form .reception-form-repeater-rows { gap: 12px; margin: 0; }
.reception-form .reception-form-repeater-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 12px; padding: 12px; border-radius: var(--wc-radius, 9px); background: var(--surface); }
.reception-form .reception-form-repeater-cells { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; min-width: 0; }
.reception-form .reception-form-repeater[data-repeater-key="available_window_definition.explicit_windows"] .reception-form-repeater-cells { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.reception-form .reception-form-cell { gap: 6px; min-width: 0; }
.reception-form .reception-form-cell:has([data-row-field="values"]) { grid-column: 1 / -1; }
.reception-form .reception-form-cell-label { font-size: 12px; }
.reception-form .reception-form-repeater > .rx-btn { justify-self: start; width: fit-content; }
.reception-form input[type="checkbox"] { width: 18px; height: 18px; min-height: 18px; flex: 0 0 18px; margin: 0; }
.reception-authoring-section .reception-form .rx-btn { min-height: var(--wc-control-h, 40px); border-radius: var(--wc-radius, 9px); font-size: 12px; font-weight: 600; }
.reception-form > .rx-action-bar { gap: 8px; padding-top: 16px; }
.reception-form > .rx-panel { display: grid; gap: 12px; min-width: 0; border-radius: var(--wc-radius, 9px); }
.reception-form > .rx-panel p { margin: 0; overflow-wrap: anywhere; }
.reception-form-preview-region { min-width: 0; padding-top: 16px; border-top: 1px solid var(--border); }
.reception-form-preview-region .reception-vav-head { flex-wrap: wrap; gap: 12px; }
.reception-form-preview-region .reception-vav-frame { box-sizing: border-box; max-width: 100%; }
.reception-form-preview-region .reception-vav-fieldsplit { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.reception-form-preview-region .reception-vav-fieldsplit > div { min-width: 0; }
.reception-form-preview-region :is(p, li) { overflow-wrap: anywhere; }
.reception-form :is([role="alert"], .reception-form-preview-region):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.reception-form-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
.reception-authoring-back { min-height: var(--wc-control-h, 40px); border-radius: var(--wc-radius, 9px); }
@supports (grid-template-rows: subgrid) {
  .reception-form .reception-form-section > .reception-form-field:not(.reception-form-repeater) { display: grid; grid-template-rows: subgrid; grid-row: span 3; gap: 6px; }
  .reception-form .reception-form-field--toggle > :not(p) { grid-row: 2; }
  .reception-form .reception-form-field--toggle > p { grid-row: 3; }
}
@media (max-width: 640px) {
  .reception-form { padding: 14px; }
  .reception-form .reception-form-section { grid-template-columns: minmax(0, 1fr); padding: 12px; }
  .reception-form .reception-form-repeater-row, .reception-form .reception-form-repeater-cells, .reception-form .reception-form-repeater[data-repeater-key="available_window_definition.explicit_windows"] .reception-form-repeater-cells, .reception-form-preview-region .reception-vav-fieldsplit { grid-template-columns: minmax(0, 1fr); }
  .reception-form .reception-form-repeater-row { padding: 10px; }
  .reception-form .reception-form-repeater-row > .rx-btn { justify-self: start; }
  .reception-form > .rx-action-bar { display: grid; grid-template-columns: minmax(0, 1fr); }
  .reception-form > .rx-action-bar .rx-btn { width: 100%; white-space: normal; }
}
`;
