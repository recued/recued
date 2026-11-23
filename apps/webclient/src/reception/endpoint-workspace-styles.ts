/** Quiet canvas spacing for the owner inventory and endpoint detail. */
export const RECEPTION_ENDPOINT_WORKSPACE_STYLES = `
.reception-page[data-view] :is(.reception-sections, .reception-section, .reception-section-rows, .reception-row, .reception-detail, .reception-detail-section) { min-width: 0; }
.reception-page[data-view] .reception-sections { gap: 16px; }
.reception-page[data-view] .reception-section { gap: 12px; padding: 20px; border-radius: var(--wc-radius, 9px); }
.reception-page[data-view] .reception-section-head { flex-wrap: wrap; gap: 12px; align-items: center; }
.reception-page[data-view] .reception-section-title { font-size: 16px; line-height: 1.4; }
.reception-page[data-view] .reception-section-rows { gap: 12px; }
.reception-page[data-view] .reception-row { gap: 12px; padding: 16px; border-radius: var(--wc-radius, 9px); }
.reception-page[data-view] .reception-row-head { gap: 8px 12px; }
.reception-page[data-view] .reception-row-name { flex-basis: 100%; min-width: 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.reception-page[data-view] :is(.reception-row-meta, .reception-row-revocation, .reception-detail-title) { overflow-wrap: anywhere; }
.reception-page[data-view] :is(.reception-row, .reception-detail) .rx-action-bar { gap: 8px; align-items: center; }
.reception-page[data-view] .reception-row > .rx-action-bar { padding-top: 12px; }
.reception-page[data-view] .rx-btn { min-height: var(--wc-control-h, 40px); border-radius: var(--wc-radius, 9px); font-size: 12px; font-weight: 600; }
.reception-page[data-view] .reception-detail { gap: 16px; }
.reception-page[data-view] .reception-detail-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; }
.reception-page[data-view] .reception-detail-title { margin: 0; font-size: 18px; font-weight: 650; line-height: 1.4; }
.reception-page[data-view] .reception-detail-section { gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
.reception-page[data-view] .reception-detail-section > :is(p, h4) { margin: 0; }
.reception-page[data-view] .reception-detail-section > h4 { font-size: 14px; font-weight: 650; line-height: 1.5; }
.reception-page[data-view] .reception-detail-section > p { line-height: 1.6; }
.reception-page[data-view] .reception-detail-section .rx-panel { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; box-shadow: none; background: var(--surface-sunk); }
.reception-page[data-view] .reception-detail-section .rx-panel > .rx-btn { justify-self: start; }
.reception-page[data-view] :is(.reception-share-cards, .reception-share-card) { gap: 12px; min-width: 0; }
.reception-page[data-view] .reception-share-snippet { padding: 12px; font-size: 12px; line-height: 1.6; }
.reception-page[data-view] .reception-access-log-scroll { min-width: 0; max-width: 100%; overflow: auto; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); }
.reception-page[data-view] .reception-access-log { min-width: 620px; }
.reception-page[data-view] .reception-access-log :is(th, td) { padding: 10px 12px; white-space: nowrap; overflow-wrap: normal; word-break: normal; line-height: 1.5; }
.reception-page[data-view] .reception-access-log th { background: var(--surface-sunk); font-size: 11px; }
.reception-page[data-view] :is(.reception-access-log-scroll, .reception-detail-title):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 640px) {
  .reception-page[data-view] .reception-section { padding: 14px; }
  .reception-page[data-view] .reception-row, .reception-page[data-view] .reception-detail-section { padding: 12px; }
  .reception-page[data-view] .reception-section-head > .rx-btn { flex: 1 1 100%; }
  .reception-page[data-view] .reception-row > .rx-action-bar { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .reception-page[data-view] .reception-row > .rx-action-bar .rx-btn { width: 100%; white-space: normal; }
  .reception-page[data-view] .reception-detail-head { grid-template-columns: minmax(0, 1fr) auto; }
  .reception-page[data-view] .reception-detail-head > .rx-btn { grid-column: 1 / -1; justify-self: start; }
  .reception-page[data-view] .reception-detail-title { font-size: 16px; }
}
`;
