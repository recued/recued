const detail = '[data-recued-packs-panel].packs-panel:has(> [data-recued-packs-detail-section="identity"])';

export const PACK_DETAIL_STYLES = `
${detail} {
  --wc-control-h: 44px;
  gap: 16px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
${detail} :where(*) { box-sizing: border-box; min-width: 0; max-width: 100%; }
${detail} [hidden] { display: none !important; }
${detail} > .packs-detail-back { align-self: flex-start; width: auto; margin: 0; }
${detail} :is([data-recued-packs-detail-section="identity"], .packs-detail-content) {
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 10px);
  background: var(--surface);
}
${detail} [data-recued-packs-detail-section="identity"] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 16px;
  padding: clamp(14px, 2vw, 20px);
}
${detail} .packs-detail-overview { display: grid; align-content: start; gap: 8px; }
${detail} .packs-detail-name { font-size: 22px; line-height: 1.3; }
${detail} .packs-detail-facts { font-size: 13px; font-variant-numeric: tabular-nums; }
${detail} .packs-detail-overview > a { justify-self: start; }
${detail} .packs-detail-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
${detail} .packs-detail-actions:empty { display: none; }
${detail} .packs-detail-actions:has([data-recued-packs-row-delete-confirm]) { grid-column: 1 / -1; }
${detail} .packs-detail-actions > :not(button) { flex: 1 1 100%; }
${detail} .packs-detail-actions > .packs-row-footer { flex: 0 1 auto; }
${detail} .packs-detail-actions:has([data-recued-packs-row-delete-confirm]) > .packs-row-footer { flex-basis: 100%; }
${detail} .packs-detail-actions > button { flex: 0 1 auto; width: auto; }
${detail} .packs-detail-content { overflow: visible; }
${detail} [data-recued-packs-detail-tabs] { gap: 4px; margin: 0; padding: 4px; background: var(--surface-subtle); }
${detail} [data-recued-packs-detail-tabs]:first-child { border-radius: var(--wc-radius-lg, 10px) var(--wc-radius-lg, 10px) 0 0; }
${detail} [data-recued-packs-detail-tabs].packs-detail-tabs-nested { padding: 6px clamp(14px, 2vw, 20px); background: var(--surface); }
${detail} [data-recued-packs-detail-tab] { min-height: 44px; border: 1px solid transparent; border-radius: var(--wc-radius, 6px); font-size: 13px; }
${detail} [data-recued-packs-detail-tab][aria-selected="true"] { border-color: var(--border); background: var(--surface); color: var(--fg); }
${detail} .packs-detail-tabs-nested [data-recued-packs-detail-tab][aria-selected="true"] { border-color: transparent; background: var(--surface-subtle); }
${detail} .packs-detail-pin { min-height: 44px; border-radius: var(--wc-radius, 6px); }
${detail} [data-recued-packs-detail-tab-panel] { gap: 16px; padding: clamp(14px, 2vw, 20px); }
${detail} [data-recued-packs-detail-tab-panel] > .packs-detail-section { gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); }
${detail} .packs-detail-heading { font-size: 15px; line-height: 1.4; color: var(--fg); text-transform: none; letter-spacing: normal; }
${detail} :is(.packs-detail-counts, .packs-detail-desc, .packs-detail-tags, .packs-detail-note) { font-size: 13px; line-height: 1.5; }
${detail} :is(button, a, summary) { min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
${detail} :is(button[class], a[class]) { white-space: normal; overflow-wrap: anywhere; }
${detail} :is(button, a, select, input, textarea, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
${detail} :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]), select, textarea) { min-height: 44px; }
${detail} select { height: 44px; overflow: hidden; text-overflow: ellipsis; }
${detail} label:has(input:is([type="checkbox"], [type="radio"])) { min-height: 44px; }
${detail} [data-recued-owner-operation-row] { gap: 10px; padding: 14px; border-radius: var(--wc-radius, 6px); background: var(--surface); }
${detail} .pa-contract { border-radius: var(--wc-radius, 6px); background: var(--surface); }
${detail} .pa-cell { padding-top: 8px; padding-bottom: 8px; }
${detail} :is(.pa-scope, .pa-contract-body) { gap: 10px; }
@media (max-width: 760px) {
  ${detail} [data-recued-packs-detail-section="identity"] { grid-template-columns: minmax(0, 1fr); }
  ${detail} .packs-detail-actions { justify-content: flex-start; }
  ${detail} .packs-row-footer { justify-content: flex-start; }
}
`;
