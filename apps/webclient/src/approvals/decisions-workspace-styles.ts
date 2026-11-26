/** Quiet canvas rules for the pending inbox. Shared card and navigation consumers keep their own layout. */
export const APPROVALS_ROUTE_CHROME_STYLES = `
[data-recued-approvals-route] {
  /* Inherit the shell's light/dark tokens instead of hard-pinning light
     values, which left inner --bg/--surface-sunk elements dark-on-dark
     in dark mode (visual-UX review). */
  --wc-control-h: 40px;
  container: approval-decisions / inline-size;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
}
[data-recued-approvals-route] .approvals-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
[data-recued-approvals-route] .approvals-title {
  margin: 0;
  flex-shrink: 0;
  font-size: 20px;
  font-weight: 600;
}
[data-recued-approvals-route] .approvals-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  margin-left: auto;
  flex-shrink: 0;
  white-space: nowrap;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface);
  color: var(--fg);
  min-height: var(--wc-control-h);
  padding: 0 11px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
[data-recued-approvals-route] .approvals-refresh[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: .65;
}
[data-recued-approvals-route] .approvals-summary {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
[data-recued-approvals-route] .approvals-filters { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 12px 16px; margin: 0 0 16px; }
[data-recued-approvals-route] .approvals-search-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; min-width: 0; }
[data-recued-approvals-route] .approvals-type-filters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: 1fr; gap: 8px; min-width: 0; }
[data-recued-approvals-route] .approvals-search-label { display: grid; flex: 1 1 15rem; min-width: 0; gap: 6px; font-size: 12px; font-weight: 600; color: var(--fg-muted, var(--muted)); }
[data-recued-approvals-route] .approvals-search-input { box-sizing: border-box; width: 100%; min-width: 0; min-height: var(--wc-control-h); padding: 8px 12px;
  border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 9px); font: inherit; font-size: 13px; font-weight: 400; color: var(--fg); background: var(--surface); }
[data-recued-approvals-route] .approvals-filter-button { display: inline-flex; align-items: center; justify-content: center; min-width: 0; max-width: 100%; min-height: var(--wc-control-h); padding: 6px 12px; font: inherit; font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere;
  border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 9px); color: var(--fg); background: var(--surface); cursor: pointer; }
[data-recued-approvals-route] .approvals-filter-button[aria-pressed=true] { border-color:var(--accent); background:var(--surface-sunk); font-weight:600; }
[data-recued-approvals-route] .approvals-review-navigation { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:0 0 16px; }
[data-recued-approvals-route] .approvals-review-count { flex:1 1 100%; margin:0; color:var(--muted); }
[data-recued-approvals-route] .approvals-review-navigation .approvals-filter-button { flex:1 1 12rem; }
[data-recued-approvals-route] .approvals-review-navigation [aria-disabled=true] { cursor:not-allowed; opacity:.65; }
[data-recued-approvals-route] :is(.approvals-filter-button,.approvals-search-input):focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
[data-recued-approvals-route] .approvals-filter-empty { margin:0; padding:16px; color:var(--muted); border:1px dashed var(--border); border-radius:8px; }
[data-recued-approvals-route] [data-recued-approvals-focus][hidden],
[data-recued-approvals-route] .approvals-filter-button[hidden],
[data-recued-approvals-route] .approvals-filter-empty[hidden] { display:none !important; }
[data-recued-approvals-route] .approvals-list-heading {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
[data-recued-approvals-route] .approvals-plan-resolution {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  margin: 0 0 16px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-subtle);
}
[data-recued-approvals-route] .approvals-plan-resolution[hidden] {
  display: none;
}
[data-recued-approvals-route] .approvals-plan-resolution-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
[data-recued-approvals-route] .approvals-plan-resolution-title {
  color: var(--fg);
  font-size: 12px;
  line-height: 1.4;
  font-weight: 600;
}
[data-recued-approvals-route] .approvals-plan-resolution-detail {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
[data-recued-approvals-route] .approvals-plan-resolution-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}
[data-recued-approvals-route] .approvals-plan-resolution-link,
[data-recued-approvals-route] .approvals-plan-resolution-dismiss {
  box-sizing: border-box;
  display: inline-flex;
  min-height: var(--wc-control-h);
  align-items: center;
  justify-content: center;
  border-radius: var(--wc-radius, 9px);
  padding: 0 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
[data-recued-approvals-route] .approvals-plan-resolution-link {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[data-recued-approvals-route] .approvals-plan-resolution-dismiss {
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  gap: 6px;
}
[data-recued-approvals-route] :is(.approvals-refresh, .approvals-plan-resolution-dismiss) > svg {
  flex-shrink: 0;
}
[data-recued-approvals-route] .approvals-plan-resolution-announcer {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
/* R20 — ONE unified list; gate + ask cards interleaved oldest-first. */
[data-recued-approvals-route] .approvals-list {
  display: grid;
  gap: 16px;
}
[data-recued-approvals-route] :is(.approvals-workspace, .approvals-review-pane) { display: contents; }
[data-recued-approvals-route] .approvals-queue[hidden] { display: none; }
[data-recued-approvals-route] [data-approvals-queue-layout] {
  display: grid;
  grid-template-columns: minmax(240px, 288px) minmax(0, 1fr);
  align-items: start;
  gap: 24px;
}
[data-recued-approvals-route] [data-approvals-queue-layout] .approvals-review-pane {
  display: block;
  min-width: 0;
}
[data-recued-approvals-route] [data-approvals-queue-layout] .approvals-list > [data-recued-approvals-focus]:not([data-approvals-queue-selected]) {
  display: none;
}
[data-recued-approvals-route] .approvals-queue {
  position: sticky;
  top: 16px;
  display: grid;
  gap: 4px;
  min-width: 0;
  max-height: calc(100dvh - 104px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg, 12px);
  background: var(--surface);
}
[data-recued-approvals-route] .approvals-queue > button {
  display: grid;
  min-width: 0;
  min-height: 60px;
  align-content: center;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--wc-radius, 9px);
  background: transparent;
  color: var(--fg);
  font: inherit;
  text-align: start;
  cursor: pointer;
}
[data-recued-approvals-route] .approvals-queue > button:hover { background: var(--surface-sunk); }
[data-recued-approvals-route] .approvals-queue > button[aria-selected="true"] {
  border-color: var(--accent);
  background: var(--accent-weak);
}
[data-recued-approvals-route] .approvals-queue > button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -3px;
}
[data-recued-approvals-route] .approvals-queue-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: 13px;
  font-weight: 600;
}
[data-recued-approvals-route] .approvals-queue-meta {
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 12px;
}
/* The full inbox gives each shared card the same context / evidence / action
   hierarchy. Scope these rules to this route so compact consumers keep their
   presentation and all card handlers retain their existing ownership. */
[data-recued-approvals-route] :is(.rx-approval-card, .rx-ask-card) {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 16px;
  border-radius: var(--wc-radius-lg, 14px);
}
[data-recued-approvals-route] :is(.rx-approval-card, .rx-ask-card) > * {
  min-width: 0;
  max-width: 100%;
  margin: 0;
}
[data-recued-approvals-route] :is(.rx-approval-card-title, .rx-ask-card-title) {
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
}
[data-recued-approvals-route] :is(.rx-approval-card-meta, .rx-ask-card-age) {
  color: var(--muted);
  opacity: 1;
  font-size: 12px;
  line-height: 1.5;
}
[data-recued-approvals-route] :is(.rx-approval-card-input, .rx-ask-card-resource-review) {
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-subtle);
  color: var(--fg);
  font: 12px/1.6 var(--mono, ui-monospace, monospace);
}
[data-recued-approvals-route] .rx-ask-card-summary {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-subtle);
}
[data-recued-approvals-route] .rx-ask-card-summary dt {
  color: var(--muted);
}
[data-recued-approvals-route] :is(.rx-approval-card-actions, .rx-ask-card-actions) {
  gap: 8px;
  padding-top: 12px;
  align-items: stretch;
  border-top: 1px solid var(--border);
}
[data-recued-approvals-route] :is(.rx-approval-card-btn, .rx-ask-card-btn) {
  min-height: var(--wc-control-h);
  min-width: min(96px, 100%);
  padding: 6px 12px;
  border-radius: var(--wc-radius, 9px);
  font-size: 12px;
  line-height: 1.4;
  font-weight: 600;
}
[data-recued-approvals-route] :is(.rx-approval-card-links a, .rx-ask-card-link) {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-height: var(--wc-control-h);
  max-width: 100%;
  padding: 6px 8px;
  border-radius: var(--wc-radius, 9px);
  overflow-wrap: anywhere;
}
[data-recued-approvals-route] :is(.rx-ask-card-details, .rx-ask-card-body) > summary {
  box-sizing: border-box;
  min-height: var(--wc-control-h);
  padding: 10px 2px;
  line-height: 1.5;
}
[data-recued-approvals-route] :is(.rx-approval-card-btn, .rx-ask-card-btn, .rx-ask-card-link):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* R17 — the run-scoped deep-link target: a calm accent ring on the one card the
   user came here to resolve. */
[data-recued-approvals-route] [data-recued-approvals-list] [data-focused="true"] {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--wc-radius-lg, 14px);
}
[data-recued-approvals-route] .approvals-summary[hidden],
[data-recued-approvals-route] .approvals-empty[hidden] {
  display: none;
}
[data-recued-approvals-route] .approvals-loading,
[data-recued-approvals-route] .approvals-error,
[data-recued-approvals-route] .approvals-empty {
  font-size: 13px;
  color: var(--muted);
}
[data-recued-approvals-route] .approvals-loading {
  border: 1px solid var(--border-subtle);
  border-radius: var(--wc-radius, 9px);
  padding: 12px 16px;
  background: var(--surface-subtle);
}
[data-recued-approvals-route] .approvals-error {
  color: var(--danger);
  margin-bottom: 8px;
}
[data-recued-approvals-route] .approvals-empty {
  margin: 0;
  display: block;
  padding: 16px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-sunk);
  text-align: center;
  line-height: 1.5;
}
@media (max-width: 620px) {
  [data-recued-approvals-route] .approvals-plan-resolution {
    grid-template-columns: 1fr;
  }
  [data-recued-approvals-route] .approvals-plan-resolution-actions {
    justify-content: flex-start;
  }
}

[data-recued-approvals-route] :where(*, *::before, *::after) { box-sizing: border-box; }
[data-recued-approvals-route] [hidden] { display: none !important; }
[data-recued-approvals-route] .approval-view-nav { margin-bottom: 16px; border-radius: var(--wc-radius-lg, 14px); }
[data-recued-approvals-route] .approval-view-nav a { min-height: var(--wc-control-h); border-radius: var(--wc-radius, 9px); font-size: 12px; }
[data-recued-approvals-route] .approvals-refresh { font-weight: 600; }
[data-recued-approvals-route] .rx-ask-card-note { gap: 6px; }
[data-recued-approvals-route] .rx-ask-card-note-label { font-size: 12px; font-weight: 600; }
[data-recued-approvals-route] .rx-ask-card-note-input { min-height: 96px; padding: 10px 12px; border-color: var(--border-strong); border-radius: var(--wc-radius, 9px); font: inherit; font-size: 13px; line-height: 1.5; }
[data-recued-approvals-route] .rx-ask-card-secret-input { min-height: var(--wc-control-h); padding: 8px 12px; border-color: var(--border-strong); border-radius: var(--wc-radius, 9px); }
[data-recued-approvals-route] .rx-ask-card-secret-remember { display: flex; align-items: center; gap: 8px; min-height: 44px; line-height: 1.5; }
[data-recued-approvals-route] .rx-ask-card > h3 { margin: 0; font-size: 16px; line-height: 1.4; font-weight: 600; }
[data-recued-approvals-route] [data-recued-preapproval-ask] a { display: inline-flex; align-items: center; min-height: var(--wc-control-h); padding: 6px 8px; font-size: 12px; color: var(--accent); border-radius: var(--wc-radius, 9px); }
[data-recued-approvals-route] :is(.rx-ask-card-body, .rx-ask-card-details) { border-radius: var(--wc-radius, 9px); }
[data-recued-approvals-route] :is(.rx-ask-card-text, .rx-ask-card-summary) { font-size: 13px; line-height: 1.5; }
[data-recued-approvals-route] :is(button, a, input, textarea, [tabindex="-1"], [tabindex="0"]):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
[data-recued-approvals-route] :is([tabindex="-1"], [tabindex="0"]) { scroll-margin-block: 8px; }
@container approval-decisions (width < 800px) {
  [data-recued-approvals-route] .approvals-filters { grid-template-columns: minmax(0, 1fr); }
}
@container approval-decisions (width < 480px) {
  [data-recued-approvals-route] .approvals-type-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  [data-recued-approvals-route] .approvals-search-row > button { flex: 1 1 10rem; }
}
@media (max-width: 640px) {
  [data-recued-approvals-route] { --wc-control-h: 44px; padding: 12px; }
  [data-recued-approvals-route] :is(.rx-approval-card, .rx-ask-card) { padding: 12px; }
  [data-recued-approvals-route] :is(.rx-approval-card-actions, .rx-ask-card-actions) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  [data-recued-approvals-route] :is(.rx-approval-card-actions, .rx-ask-card-actions) > button { width: 100%; min-width: 0; }
  [data-recued-approvals-route] :is(.rx-approval-card-actions, .rx-ask-card-actions) > button:only-child { grid-column: 1 / -1; }
  [data-recued-approvals-route] .rx-ask-card-secret > button { width: 100%; }
  [data-recued-approvals-route] .approvals-plan-resolution-actions > * { flex: 1 1 10rem; }
}
`;
