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
[data-recued-contracts-detail].contracts-workspace .contracts-detail-toolbar { display: contents; }
[data-recued-contracts-detail].contracts-workspace .contracts-detail-action { display: none; }
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
[data-recued-contracts-connect] .contracts-connect-picker { display: none; }
[data-recued-contracts-detail].contracts-workspace [data-recued-permissions-create] { padding: 14px; border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); }
[data-recued-contracts-detail].contracts-workspace label:has(> [data-recued-permissions-create-denied]) { min-height: 44px; }
[data-recued-contracts-detail].contracts-workspace [data-recued-contract-grants-cell] { min-height: 44px; padding-top: 8px; padding-bottom: 8px; }
[data-recued-contracts-detail].contracts-workspace .cg-kind { margin-top: 18px; padding: 14px; border: 1px solid var(--border); border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); }
[data-recued-contracts-detail].contracts-workspace .cg-axis-note { max-width: 70ch; font-size: 12px; line-height: 1.5; }
[data-recued-contracts-detail].contracts-workspace .cg-filter-bar { gap: 10px; padding: 0 0 12px; }
[data-recued-contracts-detail].contracts-workspace .cg-summary { margin-top: 4px; }
[data-recued-contract-grants][data-grant-view="ops"] :is(.cg-ops-sidebar, .cg-ops-overview) { display: contents; }
[data-recued-contract-grants][data-grant-view="ops"] .cg-ops-navigation { display: none; }
[data-recued-contracts-detail].contracts-workspace > details > summary { min-height: 44px; padding: 10px 0; font-weight: 600; cursor: pointer; }
@media (min-width: 1280px) and (hover: hover) and (pointer: fine) {
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-head:has(.contracts-sphere-access, .contracts-door) {
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    align-items: start;
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid:has(.contracts-sphere-access, .contracts-door) {
    display: contents;
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid:has(.contracts-sphere-access, .contracts-door) > .contracts-detail-access {
    grid-column: 2;
    grid-row: 1;
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid:has(.contracts-revoke-wrap) > .contracts-detail-access {
    grid-row: 1 / span 2;
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid:has(.contracts-sphere-access, .contracts-door) > .contracts-detail-lifecycle {
    grid-column: 1;
    grid-row: 2;
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-lifecycle {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 16px;
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-lifecycle:has(.contracts-revoke-prompt) > .contracts-revoke-wrap { flex-basis: 100%; }
  [data-recued-contracts-detail].contracts-workspace [data-recued-contracts-head-error] { grid-column: 1 / -1; }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    align-items: center;
    gap: 8px;
    padding: 4px;
    border-bottom: 1px solid var(--border);
    border-radius: var(--wc-radius-lg, 10px) var(--wc-radius-lg, 10px) 0 0;
    background: var(--surface-subtle);
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-toolbar > .contracts-tabs {
    padding: 0;
    border: 0;
    background: transparent;
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-action {
    display: block;
    min-width: 148px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius, 6px);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-action:hover { border-color: var(--border-strong); }
  [data-recued-contracts-detail].contracts-workspace > .contracts-permission-tests:not([open]),
  [data-recued-contracts-detail].contracts-workspace > .contracts-permission-tests > summary,
  [data-recued-contracts-detail].contracts-workspace:not([data-recued-contracts-detail-panel="approvals"])
    > [data-recued-contracts-app-preapprovals],
  [data-recued-contracts-detail].contracts-workspace[data-recued-contracts-detail-panel]
    > .contracts-detail-content > [data-recued-contracts-tab-body] { display: none; }
  [data-recued-contracts-detail].contracts-workspace[data-recued-contracts-detail-panel] > .contracts-detail-content {
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
  }
  [data-recued-contracts-detail].contracts-workspace[data-recued-contracts-detail-panel] .contracts-detail-toolbar {
    border-bottom: 0;
    border-radius: var(--wc-radius-lg, 10px);
  }
  [data-recued-contracts-detail].contracts-workspace[data-recued-contracts-detail-panel]
    > :is(.contracts-permission-tests[open], [data-recued-contracts-app-preapprovals]) {
    /* Keep the panel in view after scrolling to it, even with a short list. */
    min-block-size: calc(100dvh - var(--wc-header-height, 64px) - 64px);
  }
  [data-recued-contracts-detail].contracts-workspace[data-recued-contracts-detail-panel="approvals"]
    > [data-recued-contracts-app-preapprovals] {
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius-lg, 10px);
    background: var(--surface);
  }
  [data-recued-contracts-detail].contracts-workspace .contracts-permission-tests,
  [data-recued-contracts-detail].contracts-workspace .contracts-permission-tests [data-permission-focus],
  [data-recued-contracts-detail].contracts-workspace [data-recued-contracts-app-preapprovals] {
    scroll-margin-block-start: 64px;
  }
  [data-recued-contracts-detail].contracts-workspace [data-recued-contracts-tab-body]:has(> [data-recued-contracts-connect]) {
    padding-block-start: 12px;
  }
  [data-recued-contracts-connect]:has(> .contracts-connect-key) {
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    gap: 8px 24px;
    align-items: start;
  }
  [data-recued-contracts-connect] > .contracts-section-copy { grid-column: 1 / -1; }
  [data-recued-contracts-connect] [data-recued-contract-key] {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
    margin-bottom: 0;
  }
  [data-recued-contracts-connect] [data-recued-contract-key] > * { grid-column: 1 / -1; }
  [data-recued-contracts-connect] [data-recued-contract-key] > h3 {
    grid-column: 1;
    grid-row: 1;
    align-self: center;
  }
  [data-recued-contracts-connect] [data-recued-contract-key]:not(:has(.contract-key-value-row))
    > .contract-key-actions:has(> :is([data-recued-contract-key-create], [data-recued-contract-key-turn-off])) {
    grid-column: 2;
    grid-row: 1;
  }
  [data-recued-contracts-connect] .contracts-connect-setup { display: grid; gap: 12px; }
  [data-recued-contracts-connect] .contracts-connect-picker {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    font-weight: 600;
  }
  [data-recued-contracts-connect] .contracts-connect-picker select {
    padding-inline: 10px;
    font: inherit;
    font-weight: 400;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--wc-radius, 6px);
    background: var(--surface);
    color: var(--fg);
  }
  [data-recued-contracts-detail].contracts-workspace [data-recued-contracts-connect] .contracts-snippet-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  [data-recued-contracts-connect] [data-recued-contracts-snippet]:not([data-selected="true"]) { display: none; }
  [data-recued-contract-grants][data-grant-view="ops"] {
    display: grid;
    grid-template-columns: minmax(0, 248px) minmax(0, 1fr);
    align-items: start;
    gap: 20px;
  }
  [data-recued-contract-grants][data-grant-view="ops"] .cg-ops-sidebar {
    display: grid;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius-lg, 10px);
    background: var(--surface-subtle);
  }
  [data-recued-contracts-detail].contracts-workspace .cg-ops-sidebar .cg-filter-bar {
    position: static;
    display: grid;
    gap: 4px;
    padding: 0;
    background: transparent;
  }
  [data-recued-contract-grants][data-grant-view="ops"] .cg-filter-status { margin-inline-start: 0; }
  [data-recued-contract-grants][data-grant-view="ops"] .cg-ops-navigation { display: grid; gap: 6px; }
  [data-recued-contract-grants][data-grant-view="ops"] .cg-ops-navigation button {
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius, 6px);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-weight: 600;
    text-align: start;
    cursor: pointer;
  }
  [data-recued-contract-grants][data-grant-view="ops"] .cg-ops-navigation button:hover {
    border-color: var(--border-strong);
    background: var(--surface-sunk);
  }
  [data-recued-contract-grants][data-grant-view="ops"] .cg-ops-overview { display: grid; gap: 8px; }
  [data-recued-contracts-detail].contracts-workspace .cg-ops-overview > :is(.cg-summary, .cg-axis-note) { margin: 0; }
  [data-recued-contracts-detail].contracts-workspace [data-grant-view="ops"] .cg-kind:first-child { margin-top: 0; }
  [data-recued-contract-grants][data-grant-view="ops"]
    :is(.cg-filter-results, .cg-kind-name[tabindex], .cg-op-ingredient-name[tabindex]) { scroll-margin-block-start: 12px; }
}
@media (min-width: 1280px) and (min-height: 560px) and (hover: hover) and (pointer: fine) {
  [data-recued-contract-grants][data-grant-view="ops"] .cg-ops-sidebar:not(:has(.cg-error)) {
    position: sticky;
    inset-block-start: 12px;
  }
}
@media (max-width: 760px), (hover: none), (pointer: coarse) {
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-control-grid { grid-template-columns: minmax(0, 1fr); }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-lifecycle { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; }
  [data-recued-contracts-detail].contracts-workspace .contracts-detail-lifecycle:not(:has(.contracts-revoke-wrap)) { display: none; }
}
`;
