/** D-145 PA6 — work-entity page CSS.
 *
 *  Scoped under `work-entity-*` so it doesn't collide with form-renderer
 *  (`form-renderer-*`), variable-widgets (`var-row`), connection-schemas,
 *  or any pre-PA6 page CSS.
 *
 *  Per project convention: rendering primitives ship a self-contained
 *  CSS string the host concatenates into the page stylesheet. The
 *  styling is intentionally minimal — visual polish is host
 *  responsibility; PA6 supplies enough structure for the
 *  composition to work without further config.
 */

import { WORK_ENTITY_DIALOG_DISCARD_GUARD_ATTR } from './dialog.js';
import { TASK_DUE_STYLES } from '../task-due.js';

export const WORK_ENTITY_PAGE_STYLES = `
${TASK_DUE_STYLES}
.work-entity-dialog.work-entity-task-reader { width:min(760px,100%); overflow:hidden; }
.work-entity-task-reader .work-entity-dialog-header { flex-shrink:0; }
.work-entity-task-reader .work-entity-dialog-title { min-width:0; overflow-wrap:anywhere; }
.work-entity-task-reader .work-entity-dialog-close { flex-shrink:0; min-width:44px; min-height:44px; }
.work-entity-task-reader-content { flex:1; min-height:0; overflow:auto; padding:20px; display:flex; flex-direction:column; gap:16px; }
.work-entity-task-reader-content h3, .work-entity-task-reader-content p { margin:0; }
.work-entity-task-reader-content section { display:grid; gap:10px; min-width:0; }
.work-entity-task-meta { display:flex; flex-wrap:wrap; gap:12px 24px; margin:0; }
.work-entity-task-meta div { min-width:0; }
.work-entity-task-meta dt { color:var(--rx-muted,var(--fg-muted)); font-size:12px; }
.work-entity-task-meta dd { margin:4px 0 0; overflow-wrap:anywhere; }
.work-entity-task-notes { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; }
.work-entity-task-reader .work-entity-dialog-actions { flex-shrink:0; flex-wrap:wrap; padding:12px 20px; }
.work-entity-task-reader .work-entity-dialog-actions button { min-height:44px; }
.work-entity-task-reader button[aria-disabled="true"] { opacity:.6; cursor:default; }
@media(max-width:540px) { .work-entity-task-reader-content { padding:16px; } .work-entity-task-reader .work-entity-dialog-actions { padding:12px 16px; } }
.work-entity-dialog[data-kind="note"] { width:min(760px,100%); overflow:hidden; }
.work-entity-dialog[data-kind="note"] .work-entity-dialog-header { flex-shrink:0; }
.work-entity-dialog[data-kind="note"] .work-entity-dialog-title { min-width:0; overflow-wrap:anywhere; }
.work-entity-dialog[data-kind="note"] .work-entity-dialog-close { flex-shrink:0; min-width:44px; min-height:44px; }
.work-entity-dialog[data-kind="note"] .work-entity-dialog-form { min-height:0; overflow:hidden; padding:0; gap:0; }
.work-entity-note-content { flex:1; min-height:0; overflow:auto; padding:20px; display:flex; flex-direction:column; gap:16px; }
.work-entity-dialog[data-kind="note"] .work-entity-dialog-actions { flex-shrink:0; flex-wrap:wrap; padding:12px 20px; }
.work-entity-dialog[data-kind="note"] .work-entity-dialog-actions button { min-height:44px; }
.work-entity-note-meta { display:flex; flex-wrap:wrap; gap:6px 14px; color:var(--rx-muted,var(--fg-muted)); font-size:12px; }
.work-entity-note-meta > span { min-width:0; overflow-wrap:anywhere; }
.work-entity-note-related { list-style:none; padding:0; display:grid; gap:12px; }
.work-entity-note-related li { display:grid; justify-items:start; gap:4px; }
.work-entity-note-related small { color:var(--rx-muted,var(--fg-muted)); }
.work-entity-note-related p { margin:0; font-size:13px; }
.work-entity-note-body { white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; font-size:15px; line-height:1.65; color:var(--rx-fg,var(--fg)); }
.work-entity-note-display { display:flex; flex-wrap:wrap; flex-shrink:0; gap:4px; align-self:flex-start; max-width:calc(100% - 40px); margin:12px 20px 0; padding:3px; border:1px solid var(--rx-divider,var(--border)); border-radius:8px; }
.work-entity-note-display button { min-height:40px; padding:6px 12px; border:0; border-radius:5px; background:transparent; color:var(--rx-muted,var(--fg-muted)); cursor:pointer; font:inherit; font-size:13px; }
.work-entity-note-display button[aria-pressed="true"] { background:var(--rx-accent-soft,var(--surface)); color:var(--rx-fg,var(--fg)); font-weight:600; }
.work-entity-note-display button:focus-visible, .work-entity-note-outline button:focus-visible, .work-entity-note-markdown :focus-visible { outline:2px solid var(--rx-accent,var(--accent)); outline-offset:2px; }
.work-entity-note-find { display:grid; flex-shrink:0; gap:6px; margin:12px 20px 0; min-width:0; }
.work-entity-note-find input { box-sizing:border-box; width:100%; min-width:0; min-height:44px; padding:8px 10px; font:inherit; border:1px solid var(--rx-divider,var(--border)); border-radius:6px; color:var(--rx-fg,var(--fg)); background:var(--rx-bg,var(--surface)); }
.work-entity-note-find-controls { display:flex; align-items:center; gap:6px; min-width:0; }
.work-entity-note-find button { flex:none; min-height:44px; min-width:44px; padding:6px 10px; font:inherit; font-size:13px; cursor:pointer; border:1px solid var(--rx-divider,var(--border)); border-radius:6px; color:var(--rx-fg,var(--fg)); background:var(--rx-bg,var(--surface)); }
.work-entity-note-find button:disabled { opacity:.5; cursor:default; }
.work-entity-note-find-everywhere { justify-self:start; }
.work-entity-note-find :focus-visible { outline:2px solid var(--rx-accent,var(--accent)); outline-offset:2px; }
.work-entity-note-find [role="status"] { flex:1; min-width:0; font-size:12px; color:var(--rx-muted,var(--fg-muted)); overflow-wrap:anywhere; }
.work-entity-note-body mark[data-note-find-match], .work-entity-task-reader mark[data-task-find-match] { padding:0; color:inherit; background:color-mix(in srgb,var(--rx-accent,var(--accent)) 25%,transparent); }
.work-entity-note-body mark[data-note-find-current], .work-entity-task-reader mark[data-task-find-current] { color:var(--on-accent); background:var(--rx-accent,var(--accent)); outline:1px solid var(--rx-accent,var(--accent)); }
.work-entity-note-outline { border:1px solid var(--rx-divider,var(--border)); border-radius:8px; font-size:13px; }
.work-entity-note-outline summary { cursor:pointer; min-height:44px; padding:12px; box-sizing:border-box; font-weight:600; }
.work-entity-note-outline summary span { margin-left:8px; font-weight:400; color:var(--rx-muted,var(--fg-muted)); }
.work-entity-note-outline nav { max-height:240px; overflow:auto; padding:0 8px 8px; }
.work-entity-note-outline ol { margin:0; padding:0; list-style:none; }
.work-entity-note-outline li[data-level="2"] { padding-left:12px; }
.work-entity-note-outline li[data-level="3"] { padding-left:24px; }
.work-entity-note-outline li[data-level="4"], .work-entity-note-outline li[data-level="5"], .work-entity-note-outline li[data-level="6"] { padding-left:36px; }
.work-entity-note-outline button { display:block; width:100%; min-height:44px; padding:8px; border:0; border-radius:4px; text-align:left; background:transparent; color:var(--rx-accent,var(--accent)); font:inherit; overflow-wrap:anywhere; cursor:pointer; }
.work-entity-note-markdown { white-space:normal; }
.work-entity-note-markdown > :first-child { margin-top:0; }
.work-entity-note-markdown > :last-child { margin-bottom:0; }
.work-entity-note-markdown h1, .work-entity-note-markdown h2, .work-entity-note-markdown h3, .work-entity-note-markdown h4, .work-entity-note-markdown h5, .work-entity-note-markdown h6 { margin:1.5em 0 .6em; line-height:1.3; overflow-wrap:anywhere; }
.work-entity-note-markdown h1 { font-size:1.6em; }
.work-entity-note-markdown h2 { font-size:1.35em; }
.work-entity-note-markdown h3 { font-size:1.15em; }
.work-entity-note-markdown h4, .work-entity-note-markdown h5, .work-entity-note-markdown h6 { font-size:1em; }
.work-entity-note-markdown p, .work-entity-note-markdown ul, .work-entity-note-markdown ol, .work-entity-note-markdown blockquote, .work-entity-note-markdown pre { margin:0 0 1em; }
.work-entity-note-markdown ul, .work-entity-note-markdown ol { padding-left:1.5em; }
.work-entity-note-markdown li > ul, .work-entity-note-markdown li > ol { margin-bottom:0; }
.work-entity-note-markdown a { color:var(--rx-accent,var(--accent)); text-decoration:underline; }
.work-entity-note-markdown pre { padding:12px; overflow:auto; border-radius:6px; background:var(--rx-bg,var(--surface)); white-space:pre; }
.work-entity-note-markdown code { font-family:var(--font-mono,monospace); font-size:.9em; }
.work-entity-note-markdown :not(pre) > code { padding:2px 4px; border-radius:4px; background:var(--rx-bg,var(--surface)); overflow-wrap:anywhere; }
.work-entity-note-markdown blockquote { margin-left:0; padding-left:14px; border-left:3px solid var(--rx-divider,var(--border)); color:var(--rx-muted,var(--fg-muted)); }
.work-entity-note-markdown table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; margin-bottom:1em; }
.work-entity-note-markdown th, .work-entity-note-markdown td { padding:8px 12px; border:1px solid var(--rx-divider,var(--border)); text-align:left; }
.work-entity-note-plain { white-space:pre-wrap; }
.work-entity-note-warning, .work-entity-note-notice { margin:0; padding:10px 12px; border:1px solid var(--rx-divider,var(--border)); border-radius:6px; font-size:13px; line-height:1.5; }
.work-entity-note-notice[role="alert"] { color:var(--danger,var(--fg)); }
.work-entity-note-reader .work-entity-note-notice, .work-entity-task-reader .work-entity-note-notice { flex-basis:100%; }
.work-entity-note-reader button[aria-disabled="true"] { opacity:.6; cursor:default; }
.work-entity-note-secondary { border-top:1px solid var(--rx-divider,var(--border)); padding-top:12px; font-size:13px; }
.work-entity-note-secondary summary { cursor:pointer; min-height:44px; padding:12px 0; box-sizing:border-box; }
.work-entity-note-form { display:flex; flex-direction:column; gap:16px; }
.work-entity-note-form > [data-form-row="title"] input { font-size:17px; font-weight:600; }
.work-entity-dialog[data-kind="note"] .work-entity-note-form > [data-form-row="body"] textarea { min-height:240px; resize:vertical; }
.work-entity-note-form > .work-entity-task-details-toggle { align-self:flex-start; }
.work-entity-note-form[data-note-details-open="false"] > [data-form-row]:not([data-form-row="title"]):not([data-form-row="body"]) { display:none; }
@media(max-width:540px) { .work-entity-note-content { padding:16px; } .work-entity-dialog[data-kind="note"] .work-entity-dialog-actions { padding:12px 16px; } }
.work-entity-dialog[data-kind="task"] { overflow:hidden; }
.work-entity-dialog[data-kind="task"] .work-entity-dialog-header { flex-shrink:0; }
.work-entity-dialog[data-kind="task"] .work-entity-dialog-form { min-height:0; overflow:hidden; padding:0; gap:0; }
.work-entity-task-content { min-height:0; overflow:auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
.work-entity-dialog[data-kind="task"] .work-entity-dialog-actions { flex-shrink:0; padding:12px 16px; }
.work-entity-task-form { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; }
.work-entity-task-form > * { grid-column:1 / -1; min-width:0; }
.work-entity-task-form > [data-form-row="priority"],
.work-entity-task-form > [data-form-row="due_at"] { grid-column:auto; }
.work-entity-task-form > [data-form-row="title"] input { font-size:17px; font-weight:600; }
.work-entity-task-form > [data-form-row="body"] textarea { min-height:112px; resize:vertical; }
.work-entity-task-form[data-task-details-open="false"] > [data-form-row]:not([data-form-row="title"]):not([data-form-row="body"]):not([data-form-row="priority"]):not([data-form-row="due_at"]) { display:none; }
.work-entity-task-date-hint { margin:8px 0 0; color:var(--rx-muted, var(--fg-muted)); font-size:12px; line-height:1.5; }
.work-entity-task-details-toggle { justify-self:start; padding:8px 0; min-height:44px; border:0; background:transparent; color:var(--rx-accent, var(--accent)); font:inherit; font-size:13px; cursor:pointer; }
.work-entity-task-completion { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border:1px solid var(--rx-divider, var(--border)); border-radius:8px; }
.work-entity-task-completion p { margin:0; font-size:13px; color:var(--rx-muted, var(--fg-muted)); }
@media(max-width:540px) { .work-entity-task-form { grid-template-columns:minmax(0,1fr); } }
.work-entity-page {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.work-entity-page-header {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.work-entity-page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.work-entity-page-source-row {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.work-entity-page-create {
  margin-left: auto;
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--rx-accent, var(--accent));
  border-radius: 6px;
  background: var(--rx-accent, var(--accent));
  color: var(--on-accent);
  cursor: pointer;
  font: inherit;
}
.work-entity-page-create:hover {
  filter: brightness(1.05);
}
.work-entity-page-create-disabled {
  margin: 0 0 0 auto;
  font-size: 13px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-page-body {
  min-width: 0;
}
.work-entity-page--external-header { padding:0; gap:12px; }
.work-entity-page--external-header > .work-entity-page-source-row { align-items:end; gap:8px; }
.work-entity-page--external-header > .work-entity-page-source-row .work-entity-source-dropdown { display:grid; flex:1 1 15rem; gap:4px; max-width:28rem; }
.work-entity-page--external-header > .work-entity-page-source-row .work-entity-source-dropdown-label { font-size:12px; }
.work-entity-page--external-header > .work-entity-page-source-row .work-entity-source-dropdown-select { width:100%; min-width:0; min-height:var(--wc-control-h,40px); }

.work-entity-page--compact-task { --task-controls-columns:minmax(0,1fr) var(--wc-task-filter-width,6.5rem) var(--wc-task-action-width,7.5rem); padding:0; gap:12px; }
.work-entity-task-tools { display:grid; gap:8px; }
.work-entity-task-search-row { display:grid; grid-template-columns:var(--task-controls-columns); align-items:center; gap:8px; }
.work-entity-task-search-row > .work-entity-list-search { min-width:0; }
.work-entity-task-filter-toggle { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-width:0; min-height:var(--wc-control-h,40px); padding:6px 8px; border:1px solid var(--border); border-radius:var(--wc-radius,9px); background:var(--surface); color:var(--fg); font:inherit; font-size:13px; white-space:nowrap; cursor:pointer; }
.work-entity-task-filter-toggle[aria-expanded="true"] { border-color:var(--accent); color:var(--accent); }
.work-entity-task-sort { position:relative; min-width:0; }
.work-entity-task-sort > span { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.work-entity-task-sort select { width:100%; min-width:0; height:var(--wc-control-h,40px); }
.work-entity-task-filter-panel { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr)); align-items:end; gap:12px; padding:12px 0; border-bottom:1px solid var(--border); }
.work-entity-task-filter-panel[hidden] { display:none; }
.work-entity-task-filter-panel > label { min-width:0; display:grid; gap:4px; font-size:12px; color:var(--fg-muted); }
.work-entity-task-filter-panel select { min-width:0; width:100%; height:var(--wc-control-h,40px); }
.work-entity-task-filter-panel > p { grid-column:1 / -1; margin:0; font-size:12px; color:var(--fg-muted); }
.work-entity-task-active-filters { margin:0; color:var(--fg-muted); font-size:12px; }
.work-entity-task-context { display:grid; grid-template-columns:var(--task-controls-columns); align-items:end; gap:8px; }
.work-entity-task-context .work-entity-source-dropdown { grid-column:1 / 3; display:grid; gap:4px; max-width:none; }
.work-entity-task-context .work-entity-source-dropdown-label { font-size:12px; }
.work-entity-task-context .work-entity-source-dropdown-select { width:100%; height:var(--wc-control-h,40px); }
.work-entity-task-context .work-entity-source-chips { grid-column:1 / 3; }
.work-entity-task-context .task-bulk--idle { grid-column:3; grid-row:1; margin:0; padding:0; border:0; background:transparent; }
.work-entity-task-context .task-bulk--idle .task-bulk-heading { display:block; }
.work-entity-task-context .task-bulk--idle .task-bulk-buttons { display:grid; }
.work-entity-task-context .task-bulk--idle button { width:100%; min-height:var(--wc-control-h,40px); }
.work-entity-task-context .task-bulk--idle .task-bulk-heading > strong { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.work-entity-task-context .task-bulk--idle > p:not([role="alert"]) { display:none; }
.work-entity-task-context .task-bulk:not(.task-bulk--idle) { grid-column:1 / -1; min-width:0; margin:4px 0 0; }
@media(min-width:901px) {
  .work-entity-page--compact-task { --task-controls-columns:minmax(0,28rem) minmax(0,1fr) var(--wc-task-filter-width,6.5rem) var(--wc-task-action-width,7.5rem); }
  .work-entity-task-filter-toggle { grid-column:3; }
  .work-entity-task-sort { grid-column:4; }
  .work-entity-task-context .work-entity-source-dropdown,
  .work-entity-task-context .work-entity-source-chips { grid-column:1; }
  .work-entity-task-context .task-bulk--idle { grid-column:4; }
}
@media(max-width:380px) {
  .work-entity-task-search-row > .work-entity-list-search { grid-column:1 / -1; }
  .work-entity-task-filter-toggle { grid-column:1 / 3; }
  .work-entity-task-sort { grid-column:3; }
  .work-entity-task-context .work-entity-source-dropdown { grid-column:1 / -1; }
  .work-entity-task-context .task-bulk--idle { grid-row:auto; }
}

.work-entity-source-dropdown {
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.work-entity-source-dropdown-label {
  font-size: 13px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-source-dropdown-select {
  min-width: 0;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 4px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  font: inherit;
}

.work-entity-source-chips {
  display: inline-flex;
  gap: 4px;
}
.work-entity-source-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 500;
  background: var(--rx-chip-bg, var(--surface-sunk));
  color: var(--rx-fg, var(--fg));
}
.work-entity-source-chip-write {
  background: var(--surface-sunk);
  color: var(--fg);
}
.work-entity-source-chip-readonly {
  background: var(--surface-sunk);
  color: var(--fg-muted);
}
.work-entity-source-chip-mcp {
  background: var(--accent-weak);
  color: var(--accent);
}

.work-entity-list-view {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.work-entity-list-search-input {
  min-width: 0;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 4px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  font: inherit;
}
.work-entity-list-search {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: end;
}
.work-entity-list-filter-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 150px;
  font-size: 12px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-list-filter {
  padding: 6px 8px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 4px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  font: inherit;
}
.work-entity-task-filters .work-entity-list-filter {
  min-height: 36px;
  max-width: 100%;
}

.work-entity-list {
  min-width: 0;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.work-entity-list-row {
  min-width: 0;
  margin: 0;
}
.work-entity-list-row-button {
  min-width: 0;
  width: 100%;
  text-align: left;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
  background: var(--rx-input-bg, var(--surface));
  padding: 10px 12px;
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.work-entity-list-row-button:hover {
  border-color: var(--rx-accent, var(--accent));
}
.work-entity-list-row-button[aria-busy="true"] {
  cursor: wait;
  border-color: var(--rx-accent, var(--accent));
}
.work-entity-list-row-primary {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 500;
  font-size: 14px;
}
.work-entity-list-row-secondary {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-list-row-footer {
  min-width: 0;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-list-row-opening {
  margin-left: auto;
  color: var(--rx-accent, var(--accent));
  font-weight: 600;
}
.work-entity-list-row-source {
  min-width: 0;
  overflow-wrap: anywhere;
  background: var(--surface-sunk);
  padding: 1px 6px;
  border-radius: 9px;
  font-weight: 500;
}
/* D-267 follow-on — boundary badges. Same chip shape as the Source label they
   sit beside; the warning tone is a stroke + weight, never a fill, per I-7's
   fill budget (state is glyph/label/weight, danger the one surviving hue). */
.work-entity-list-row-badge {
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 1px 6px;
  border-radius: 9px;
  background: var(--surface-sunk);
  color: var(--fg-muted);
  font-weight: 500;
}
.work-entity-list-row-badge[data-warning] {
  outline: 1px solid var(--border-strong);
  color: var(--fg);
  font-weight: 600;
}
.work-entity-list-row-meta {
  min-width: 0;
  overflow-wrap: anywhere;
}
.work-entity-list-empty {
  padding: 24px;
  text-align: center;
  color: var(--rx-muted, var(--fg-muted));
}

.work-entity-booking-detail {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 16px;
}
.work-entity-booking-detail-nav {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.work-entity-booking-detail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.work-entity-booking-back,
.work-entity-booking-manage,
.work-entity-booking-edit {
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
  padding: 7px 11px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  cursor: pointer;
  font: inherit;
}
.work-entity-booking-edit {
  border-color: var(--rx-accent, var(--accent));
  background: var(--rx-accent, var(--accent));
  color: var(--on-accent);
}
.work-entity-booking-manage:disabled {
  cursor: wait;
  opacity: .7;
}
.work-entity-booking-manage-notice {
  margin: -8px 0 0;
  overflow-wrap: anywhere;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-booking-manage-notice--error {
  color: var(--rx-danger, var(--danger));
}
.work-entity-booking-detail h1,
.work-entity-booking-detail h2,
.work-entity-booking-kicker { margin: 0; }
.work-entity-booking-kicker {
  color: var(--rx-muted, var(--fg-muted));
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .08em;
}
.work-entity-booking-state {
  display: inline-block;
  margin-top: 8px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--surface-sunk);
}
.work-entity-booking-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin: 0;
}
.work-entity-booking-facts div {
  padding: 10px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
}
.work-entity-booking-facts dt {
  color: var(--rx-muted, var(--fg-muted));
  font-size: 12px;
}
.work-entity-booking-facts dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.work-entity-booking-history-section { display: flex; flex-direction: column; gap: 10px; }
.work-entity-booking-history { list-style: none; margin: 0; padding: 0; }
.work-entity-booking-history li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--rx-divider, var(--border));
}
.work-entity-booking-history-action { grid-column:1 / -1; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.work-entity-booking-history-action > p { flex-basis:100%; margin:0; }
.work-entity-booking-history-empty { color: var(--rx-muted, var(--fg-muted)); }

.work-entity-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 100;
}
.work-entity-dialog {
  background: var(--rx-input-bg, var(--surface));
  border-radius: 8px;
  width: min(560px, 100%);
  max-height: 90vh;
  overflow: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
}
.work-entity-dialog-header {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--rx-divider, var(--border));
}
.work-entity-dialog-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.work-entity-dialog-close {
  background: transparent;
  border: 0;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-dialog-form {
  min-width: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.work-entity-dialog-source-picker,
.work-entity-dialog-source-static {
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.work-entity-dialog-source-select {
  min-width: 0;
  max-width: 100%;
}
.work-entity-dialog-source-value {
  min-width: 0;
  overflow-wrap: anywhere;
}
.work-entity-dialog-source-readonly {
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--rx-fg, var(--fg));
}
.work-entity-dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 8px;
  border-top: 1px solid var(--rx-divider, var(--border));
}
.work-entity-dialog-cancel,
.work-entity-dialog-submit {
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}
.work-entity-dialog-cancel {
  border: 1px solid var(--rx-divider, var(--border));
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
}
.work-entity-dialog-submit {
  border: 1px solid var(--rx-accent, var(--accent));
  background: var(--rx-accent, var(--accent));
  color: var(--on-accent);
}
.work-entity-dialog-submit[disabled] {
  opacity: 0.6;
  cursor: not-allowed;
}
.work-entity-dialog-submit-error {
  background: var(--danger-weak);
  border: 1px solid var(--danger);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--danger);
  font-size: 13px;
  overflow-wrap: anywhere;
}
[${WORK_ENTITY_DIALOG_DISCARD_GUARD_ATTR}] {
  display: grid;
  gap: 10px;
  margin: 16px;
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-weak);
}
[${WORK_ENTITY_DIALOG_DISCARD_GUARD_ATTR}] h3,
[${WORK_ENTITY_DIALOG_DISCARD_GUARD_ATTR}] p {
  margin: 0;
}
.work-entity-dialog-discard-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.work-entity-dialog-discard-actions button {
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.work-entity-commitment-reader { overflow: hidden; }
.work-reader-copy-fallback { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
.work-reader-copy-fallback label { font-weight: 600; }
.work-reader-copy-fallback textarea { box-sizing: border-box; width: 100%; min-height: 120px; resize: vertical; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--rx-input-bg, var(--surface)); color: var(--rx-fg, var(--fg)); font: inherit; }
.work-reader-copy-fallback button { justify-self: start; min-height: 44px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--rx-input-bg, var(--surface)); color: var(--rx-fg, var(--fg)); font: inherit; cursor: pointer; }
.work-entity-commitment-reader .work-entity-dialog-header { padding: 20px; flex-shrink: 0; }
.work-entity-commitment-reader button[aria-disabled="true"] { opacity: .6; cursor: default; }
.work-entity-commitment-content { padding: 20px; display: grid; gap: 16px; min-width: 0; min-height: 0; overflow: auto; }
.work-entity-commitment-content p { margin: 0; }
.work-entity-commitment-statement { font-size: 20px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.work-entity-commitment-status { font-weight: 600; color: var(--fg-muted); }
.work-entity-commitment-status.is-overdue { color: var(--danger,#b42318); }
.work-entity-commitment-meta { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; margin: 0; }
.work-entity-commitment-meta dt { font-size: 12px; color: var(--fg-muted); margin-bottom: 4px; }
.work-entity-commitment-meta dd { margin: 0; overflow-wrap: anywhere; }
.work-entity-commitment-evidence { min-width: 0; border-top: 1px solid var(--border); padding-top: 8px; }
.work-entity-commitment-evidence > summary { display: list-item; cursor: pointer; min-height: 44px; padding: 10px 0; box-sizing: border-box; font-weight: 600; }
.work-entity-commitment-evidence > summary span { font-weight: 400; color: var(--fg-muted); }
.commitment-evidence-list { display: grid; gap: 16px; margin: 12px 0 0; padding: 0; list-style: none; }
.commitment-evidence-entry { display: grid; gap: 10px; min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
.commitment-evidence-entry h3 { margin: 0; font-size: 15px; }
.commitment-evidence-kind, .commitment-evidence-unavailable { color: var(--fg-muted); font-size: 13px; }
.commitment-evidence-text, .commitment-evidence-values dd { white-space: pre-wrap; overflow-wrap: anywhere; }
.commitment-evidence-entry blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--border); }
.commitment-evidence-values, .commitment-evidence-meta { display: grid; gap: 10px; margin: 0; min-width: 0; }
.commitment-evidence-values dt, .commitment-evidence-meta dt { color: var(--fg-muted); font-size: 12px; }
.commitment-evidence-values dd, .commitment-evidence-meta dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.commitment-evidence-entry a { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px; min-height: 44px; justify-self: start; overflow-wrap: anywhere; }
.work-entity-commitment-reader .work-entity-dialog-actions { flex-wrap: wrap; flex-shrink: 0; padding: 16px 20px; }
.work-entity-commitment-related { min-width: 0; border-top: 1px solid var(--border); padding-top: 8px; }
.work-entity-commitment-related > summary { min-height: 44px; box-sizing: border-box; padding: 10px 0; cursor: pointer; font-weight: 600; }
.commitment-related-list { display: grid; gap: 12px; margin: 8px 0; padding: 0; list-style: none; }
.commitment-related-row { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; overflow-wrap: anywhere; }
.commitment-related-row h3, .commitment-related-preview h4 { margin: 0; font-size: 15px; }
.commitment-related-meta { color: var(--fg-muted); font-size: 13px; }
.commitment-related-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.commitment-related-row button { min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
.commitment-related-preview { display: grid; gap: 10px; min-width: 0; border-top: 1px solid var(--border); padding-top: 10px; }
.commitment-related-preview dl { display: grid; gap: 10px; margin: 0; }
.commitment-related-preview dt { color: var(--fg-muted); font-size: 12px; }
.commitment-related-preview dd { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
@media(max-width:600px) {
  .work-entity-commitment-meta { grid-template-columns: minmax(0,1fr); }
  .work-entity-commitment-reader .work-entity-dialog-actions button { min-height: 44px; }
  .work-entity-commitment-filters { flex-wrap: wrap; }
}
@media (max-width: 360px) {
  .work-entity-list-search {
    align-items: stretch;
    flex-direction: column;
  }
  .work-entity-list-filter-label {
    width: 100%;
    min-width: 0;
  }
}
`;
