export const CONTRACTS_DETAIL_STYLES = `
[data-recued-contracts-detail].contracts-workspace {
  --wc-control-h: 44px;
  display: grid;
  gap: 16px;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-recued-contracts-detail].contracts-workspace :where(*) { box-sizing: border-box; min-width: 0; max-width: 100%; }
[data-recued-contracts-detail].contracts-workspace [hidden] { display: none !important; }
[data-recued-contracts-detail].contracts-workspace > [data-recued-contracts-back] { justify-self: start; margin: 0; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-head { display: grid; gap: 16px; padding: 0; border: 0; }
[data-recued-contracts-detail].contracts-workspace :is(.contracts-detail-summary, .contracts-detail-access, .contracts-detail-lifecycle, .contracts-detail-content),
[data-recued-contracts-detail].contracts-workspace > details {
  padding: clamp(14px, 2vw, 20px);
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 10px);
  background: var(--surface);
}
[data-recued-contracts-detail].contracts-workspace :is(.contracts-detail-summary, .contracts-detail-access) { display: grid; align-content: start; gap: 14px; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-identity { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-name { flex: 1 1 240px; margin: 0; font-size: 22px; line-height: 1.3; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
[data-recued-contracts-detail].contracts-workspace [data-recued-contracts-pill][data-state="active"] { color: var(--ok, var(--accent)); background: color-mix(in srgb, var(--ok, var(--accent)) 12%, transparent); }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-facts { flex: 1 1 240px; margin: 0; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-facts dt { margin-bottom: 4px; color: var(--muted); font-size: 12px; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-limits { margin: 0; color: var(--fg); font-size: 13px; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(190px, .3fr); gap: 16px; align-items: start; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid:not(:has(.contracts-sphere-access, .contracts-door, .contracts-revoke-wrap)) { display: none; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid:not(:has(.contracts-revoke-wrap)),
[data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid:not(:has(.contracts-sphere-access, .contracts-door)) { grid-template-columns: minmax(0, 1fr); }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-access:not(:has(.contracts-sphere-access, .contracts-door)),
[data-recued-contracts-detail].contracts-workspace .contracts-detail-lifecycle:not(:has(.contracts-revoke-wrap)) { display: none; }
[data-recued-contracts-detail].contracts-workspace :is(.contracts-detail-access, .contracts-detail-lifecycle) > h3 { margin: 0; font-size: 15px; line-height: 1.4; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-access-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr)); gap: 16px; align-items: start; }
[data-recued-contracts-detail].contracts-workspace .contracts-scope-group { display: grid; gap: 10px; }
[data-recued-contracts-detail].contracts-workspace .contracts-scope-group:empty { display: none; }
[data-recued-contracts-detail].contracts-workspace .contracts-sphere-access { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
[data-recued-contracts-detail].contracts-workspace .contracts-sphere-access select { width: 100%; height: 44px; }
[data-recued-contracts-detail].contracts-workspace .contracts-sphere-hint { max-width: 70ch; color: var(--muted); font-size: 12px; line-height: 1.5; }
[data-recued-contracts-detail].contracts-workspace .contracts-door { display: flex; gap: 6px; }
[data-recued-contracts-detail].contracts-workspace .contracts-door-label { flex-basis: 100%; }
[data-recued-contracts-detail].contracts-workspace [data-recued-contracts-door-toggle] { min-height: 44px; gap: 8px; padding: 6px; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-lifecycle { display: grid; gap: 12px; border-top: 3px solid var(--border-strong, var(--border)); }
[data-recued-contracts-detail].contracts-workspace .contracts-revoke-wrap { display: flex; gap: 8px; }
[data-recued-contracts-detail].contracts-workspace .contracts-revoke-prompt { flex-basis: 100%; font-size: 13px; }
[data-recued-contracts-detail].contracts-workspace [data-recued-contracts-head-error] { margin: 0; padding: 10px 12px; border-left: 3px solid var(--danger); background: var(--surface-subtle); }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-content { padding: 0; overflow: visible; }
[data-recued-contracts-detail].contracts-workspace .contracts-tabs { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 4px; margin: 0; padding: 4px; border-bottom: 1px solid var(--border); border-radius: var(--wc-radius-lg, 10px) var(--wc-radius-lg, 10px) 0 0; background: var(--surface-subtle); }
[data-recued-contracts-detail].contracts-workspace [data-recued-contracts-tab] { min-height: 44px; padding: 8px 10px; border: 1px solid transparent; border-radius: var(--wc-radius, 6px); white-space: normal; }
[data-recued-contracts-detail].contracts-workspace [data-recued-contracts-tab][aria-selected="true"] { border-color: var(--border); background: var(--surface); color: var(--fg); }
[data-recued-contracts-detail].contracts-workspace [data-recued-contracts-tab-body] { padding: clamp(14px, 2vw, 20px); color: var(--fg); }
[data-recued-contracts-detail].contracts-workspace :is(button, a) { min-height: 44px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
[data-recued-contracts-detail].contracts-workspace :is(button[class], a[class]) { white-space: normal; overflow-wrap: anywhere; }
[data-recued-contracts-detail].contracts-workspace :is(button, a, select, input, textarea, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[data-recued-contracts-detail].contracts-workspace :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]), select, textarea) { min-height: 44px; }
[data-recued-contracts-detail].contracts-workspace select { height: 44px; overflow: hidden; text-overflow: ellipsis; }
[data-recued-contracts-detail].contracts-workspace .contracts-snippet-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 14px; }
[data-recued-contracts-detail].contracts-workspace [data-recued-contracts-snippet] { padding: 14px; border-radius: var(--wc-radius, 6px); }
[data-recued-contracts-detail].contracts-workspace [data-recued-contracts-snippet] pre { font-size: 12px; line-height: 1.6; }
[data-recued-contracts-detail].contracts-workspace [data-recued-permissions-create] { padding: 14px; border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); }
[data-recued-contracts-detail].contracts-workspace label:has(> [data-recued-permissions-create-denied]) { min-height: 44px; }
[data-recued-contracts-detail].contracts-workspace [data-recued-contract-grants-cell] { min-height: 44px; padding-top: 8px; padding-bottom: 8px; }
[data-recued-contracts-detail].contracts-workspace .cg-kind { margin-top: 18px; padding: 14px; border: 1px solid var(--border); border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); }
[data-recued-contracts-detail].contracts-workspace .cg-axis-note { max-width: 70ch; font-size: 12px; line-height: 1.5; }
[data-recued-contracts-detail].contracts-workspace .cg-filter-bar { gap: 10px; padding: 0 0 12px; }
[data-recued-contracts-detail].contracts-workspace .cg-summary { margin-top: 4px; }
[data-recued-contracts-detail].contracts-workspace > details > summary { min-height: 44px; padding: 10px 0; font-weight: 600; cursor: pointer; }
@media (max-width: 760px) {
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid { grid-template-columns: minmax(0, 1fr); }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-lifecycle { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-lifecycle:not(:has(.contracts-revoke-wrap)) { display: none; }
}
`;
