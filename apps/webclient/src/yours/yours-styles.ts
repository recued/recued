/** Yours uses the shell's theme and control tokens; no separate palette. */
export const YOURS_STYLES = `
[data-recued-yours] {box-sizing:border-box;width:100%;max-width:var(--wc-content-max,1160px);margin:0 auto;padding:28px 24px 48px;color:var(--fg);overflow-wrap:anywhere;font-size:14px;line-height:1.55}
[data-recued-yours] *,[data-recued-yours] *::before,[data-recued-yours] *::after {box-sizing:border-box}
[data-recued-yours] [hidden] {display:none!important}
[data-recued-yours] :is(h1,h2,h3,h4,p) {margin:0}
[data-recued-yours] h1 {font-size:28px;letter-spacing:-.04em;line-height:1.2;font-weight:700}
[data-recued-yours] h2 {font-size:23px;letter-spacing:-.025em;line-height:1.3}
[data-recued-yours] :is(h3,h4) {font-size:15px;font-weight:650;line-height:1.4}
[data-recued-yours] a {color:var(--accent);text-underline-offset:3px}
[data-recued-yours] a:hover {text-decoration:underline}
[data-recued-yours] :is(button,input,select,textarea,summary,a):focus-visible {outline:2px solid var(--accent);outline-offset:3px}
[data-recued-yours] .yours-masthead {display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}
[data-recued-yours] .yours-masthead>button {flex:none;white-space:nowrap;min-width:84px}
[data-recued-yours] .yours-masthead p {color:var(--fg-muted);margin-top:6px}
[data-recued-yours] .yours-nav {display:flex;gap:24px;overflow-x:auto;overflow-y:hidden;box-shadow:inset 0 -1px var(--border);scrollbar-width:thin;margin-bottom:18px}
[data-recued-yours] .yours-nav a {flex:none;color:var(--fg-muted);text-decoration:none;white-space:nowrap;padding:12px 2px;min-height:44px;border-bottom:2px solid transparent}
[data-recued-yours] .yours-nav a[aria-current] {color:var(--accent);border-bottom-color:var(--accent);font-weight:650}
[data-recued-yours] .yours-content {display:flex;flex-direction:column;gap:20px;min-width:0}
[data-recued-yours] .yours-content>.yours-nav {margin-bottom:0}
[data-recued-yours] .yours-content>.yours-section:first-child {border-top:0;padding-top:0}
[data-recued-yours] .yours-page-header {display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
[data-recued-yours] .yours-page-header p {color:var(--fg-muted);margin-top:5px;max-width:66ch}
[data-recued-yours] .yours-actions {display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
[data-recued-yours] :is(button,.yours-button) {min-height:var(--wc-control-h,38px);padding:8px var(--wc-pad-x,14px);border:1px solid var(--border-strong);border-radius:var(--wc-radius,9px);background:var(--surface);color:var(--fg);font:inherit;font-weight:550;line-height:1.3;cursor:pointer;text-decoration:none;max-width:100%;overflow-wrap:anywhere}
[data-recued-yours] button:hover {background:var(--surface-sunk)}
[data-recued-yours] button.yours-primary {background:var(--accent);border-color:var(--accent);color:var(--on-accent,#fff)}
[data-recued-yours] button.yours-primary:hover {filter:brightness(.95)}
[data-recued-yours] button.yours-quiet {background:transparent;border-color:transparent;color:var(--fg-muted)}
[data-recued-yours] button.yours-danger {color:var(--danger)}
[data-recued-yours] button:disabled {opacity:.55;cursor:default;filter:none}
[data-recued-yours] .yours-toolbar {display:flex;align-items:end;flex-wrap:wrap;gap:12px;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--wc-radius-lg,14px)}
[data-recued-yours] .yours-toolbar>label {flex:1 1 160px;max-width:240px}
[data-recued-yours] .yours-toolbar>label:first-child {flex:2 1 240px;max-width:none}
[data-recued-yours] .yours-toolbar button {flex:none}
[data-recued-yours] .yours-asset-toolbar {display:block;padding:12px}
[data-recued-yours] .yours-search-row {display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:end;gap:8px}
[data-recued-yours] .yours-search-row .yours-asset-filters {border:0;padding:0}
[data-recued-yours] .yours-asset-filters>summary {padding:10px 12px;min-height:40px;border:1px solid var(--border-strong);border-radius:var(--wc-radius,9px);background:var(--surface)}
[data-recued-yours] .yours-search-row:has(.yours-asset-filters[open]) {grid-template-columns:minmax(0,1fr) auto}
[data-recued-yours] .yours-asset-filters[open] {grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:12px}
[data-recued-yours] .yours-asset-filters[open]>summary {grid-column:1/-1;width:fit-content}
[data-recued-yours] .yours-asset-filters[open]>*+* {margin:0}
[data-recued-yours] .yours-list-meta {display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:var(--fg-muted);font-size:13px}
[data-recued-yours] .yours-filter-chip {padding:3px 8px;border-radius:var(--wc-radius-pill,999px);background:var(--surface-sunk)}
[data-recued-yours] .yours-compact-filter {padding:0;border:0;background:transparent}
[data-recued-yours] .yours-compact-filter>label,[data-recued-yours] .yours-compact-filter>label:first-child {display:flex;align-items:center;gap:12px;flex:none;max-width:none}
[data-recued-yours] .yours-compact-filter select {width:auto}
[data-recued-yours] label {display:grid;gap:6px;min-width:0;font-size:13px;font-weight:550}
[data-recued-yours] :is(input,select,textarea) {box-sizing:border-box;min-height:40px;width:100%;font:inherit;font-weight:400;color:var(--fg);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--wc-radius,9px);padding:9px 11px;min-width:0}
[data-recued-yours] textarea {resize:vertical;min-height:112px}
[data-recued-yours] .yours-editor :is(input,select,textarea) {scroll-margin-block:100px}
[data-recued-yours] input[type=checkbox] {width:20px;min-height:20px;margin:0;accent-color:var(--accent)}
[data-recued-yours] label:has(>input[type=checkbox]) {display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:40px}
[data-recued-yours] :is(section,article,fieldset,details) {min-width:0}
[data-recued-yours] .yours-section {display:flex;flex-direction:column;gap:14px;border-top:1px solid var(--border);padding-top:24px}
[data-recued-yours] .yours-section-heading {display:flex;align-items:center;justify-content:space-between;gap:16px}
[data-recued-yours] .yours-card {position:relative;display:flex;flex-direction:column;gap:12px;padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--wc-radius-lg,14px);margin:0}
[data-recued-yours] .yours-card .yours-card {padding:16px;background:var(--surface-sunk);border-color:transparent}
[data-recued-yours] .yours-card>h3 {font-size:17px;letter-spacing:-.015em}
[data-recued-yours] .yours-card>h3 a {color:var(--fg);text-decoration:none}
[data-recued-yours] .yours-card>h3 a:hover {color:var(--accent);text-decoration:underline}
[data-recued-yours] .yours-list {display:grid;gap:12px;min-width:0}
[data-recued-yours] .yours-list>[data-yours-asset] {display:grid;grid-template-columns:minmax(140px,1fr) minmax(200px,2fr) auto;gap:8px 24px;padding:16px 20px;align-items:start}
[data-recued-yours] .yours-list>[data-yours-asset]>h3 {grid-column:1;grid-row:1}
[data-recued-yours] .yours-list>[data-yours-asset]>.yours-asset-meta {grid-column:1;grid-row:2;color:var(--fg-muted);font-size:13px}
[data-recued-yours] .yours-list>[data-yours-asset]>[data-yours-sphere] {grid-column:1;grid-row:3}
[data-recued-yours] .yours-list>[data-yours-asset]>[data-yours-asset-summary] {grid-column:2;grid-row:1 / span 3}
[data-recued-yours] .yours-list>[data-yours-asset]>[data-yours-open-asset] {position:static;grid-column:3;grid-row:1;min-height:24px;display:flex;align-items:center}
[data-recued-yours] [data-yours-open-asset] {position:absolute;right:20px;top:20px;font-size:13px;font-weight:550}
[data-recued-yours] [data-yours-sphere] {font-size:12px;color:var(--fg-muted);align-self:flex-start;max-width:100%}
[data-recued-yours] [data-yours-sphere]>summary {cursor:pointer;min-height:28px;padding:3px 9px;background:var(--surface-sunk);border-radius:var(--wc-radius-pill,999px);width:fit-content}
[data-recued-yours] [data-yours-sphere][open] {align-self:stretch;padding:12px;border:1px solid var(--border);border-radius:var(--wc-radius,9px)}
[data-recued-yours] [data-yours-sphere][open]>*+* {margin-top:10px}
[data-recued-yours] .yours-menu {position:relative;display:inline-block;align-self:flex-start;margin:0}
[data-recued-yours] .yours-menu>summary {min-height:var(--wc-control-h,38px);display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--wc-radius,9px);cursor:pointer;list-style:none;background:var(--surface);font-size:13px;font-weight:550}
[data-recued-yours] .yours-menu>summary::-webkit-details-marker {display:none}
[data-recued-yours] .yours-menu>summary::after {content:'⋯';font-size:18px;line-height:1}
[data-recued-yours] .yours-menu-body {position:absolute;z-index:5;top:calc(100% + 6px);left:0;display:grid;gap:3px;padding:6px;width:260px;max-width:calc(100vw - 48px);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--wc-radius-lg,14px);box-shadow:var(--wc-shadow-panel,0 12px 32px #0002)}
[data-recued-yours] .yours-menu[data-align=end]>.yours-menu-body {left:auto;right:0}
[data-recued-yours] .yours-menu-body button {text-align:left;border-color:transparent;background:transparent;font-size:13px;white-space:normal;min-height:40px}
[data-recued-yours] .yours-menu-body button:hover {background:var(--surface-sunk)}
[data-recued-yours] .yours-facts {display:grid;gap:0;margin:0}
[data-recued-yours] .yours-fact {display:grid;grid-template-columns:minmax(140px,1fr) minmax(0,2fr) auto;gap:16px;padding:16px 0;border-bottom:1px solid var(--border);align-items:start}
[data-recued-yours] .yours-fact dt {font-size:13px;color:var(--fg-muted);padding-top:3px}
[data-recued-yours] .yours-fact dd {margin:0;min-width:0;white-space:pre-wrap}
[data-recued-yours] .yours-fact small {display:block;white-space:normal;color:var(--fg-muted);font-size:12px;line-height:1.5;margin-top:5px}
[data-recued-yours] .yours-fact .yours-menu>summary {min-height:32px;border-color:transparent;padding:4px 8px}
[data-recued-yours] :is(.yours-section,.yours-card)>button {align-self:flex-start}
[data-recued-yours] :is(dl:not(.yours-facts)) {display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,3fr);gap:8px;margin:0}
[data-recued-yours] dd {margin:0;white-space:pre-wrap}
[data-recued-yours] .yours-editor {width:100%;max-width:720px;margin:4px auto 24px;display:grid;gap:20px;padding:28px;background:var(--surface);border:1px solid var(--border);border-radius:var(--wc-radius-lg,14px)}
[data-recued-yours] .yours-editor>h2 {padding-bottom:4px}
[data-recued-yours] .yours-source-note {margin:0;padding:16px;border-left:3px solid var(--accent);background:var(--surface-sunk);border-radius:0 var(--wc-radius,9px) var(--wc-radius,9px) 0;white-space:pre-wrap;overflow-wrap:anywhere}
[data-recued-yours] .yours-rule-preview {padding:16px;background:var(--surface-sunk);border-left:3px solid var(--accent);border-radius:0 var(--wc-radius,9px) var(--wc-radius,9px) 0;font-size:14px;line-height:1.6}
[data-recued-yours] .yours-change-preview {display:grid;gap:6px;padding:14px 16px;border-left:3px solid var(--accent);background:var(--surface-sunk);border-radius:0 var(--wc-radius,9px) var(--wc-radius,9px) 0}
[data-recued-yours] .yours-change-preview>a {font-weight:650}
[data-recued-yours] [data-yours-evidence] {margin:0;padding-inline-start:20px;font-size:13px}
[data-recued-yours] [data-yours-evidence] li+li {margin-top:8px}
[data-recued-yours] [data-yours-evidence] li :is(a,button) {margin-inline-start:8px}
[data-recued-yours] .yours-class-field-list {display:grid;gap:12px}
[data-recued-yours] .yours-class-field-list:empty {display:none}
[data-recued-yours] .yours-class-fields>button {justify-self:start}
[data-recued-yours] .yours-editor fieldset {border:0;border-top:1px solid var(--border);padding:20px 0 0;margin:0;display:grid;gap:14px}
[data-recued-yours] .yours-editor legend {padding:0 10px 0 0;font-size:14px;font-weight:650}
[data-recued-yours] .yours-editor article {padding:16px;background:var(--surface-sunk);border:1px solid var(--border);border-radius:var(--wc-radius,9px);display:grid;gap:12px}
[data-recued-yours] .yours-editor details {border-top:1px solid var(--border);padding-top:16px}
[data-recued-yours] .yours-editor details>summary {cursor:pointer;font-weight:550;min-height:44px}
[data-recued-yours] .yours-editor details[open]>*+* {margin-top:14px}
[data-recued-yours] .yours-editor .yours-actions {padding-top:16px;border-top:1px solid var(--border)}
[data-recued-yours] .yours-editor [data-yours-editor-actions] {position:sticky;bottom:0;z-index:6;background:var(--surface);padding:12px 0;box-shadow:0 -8px 12px var(--surface)}
[data-recued-yours] .yours-editor [data-yours-form-error] {flex-basis:100%;font-size:13px;padding:0;margin:0}
[data-recued-yours] [data-yours-form-error]:empty {display:none}
[data-recued-yours] .yours-field-error {color:var(--danger);font-weight:400}
[data-recued-yours] [aria-invalid=true] {border-color:var(--danger)}
[data-recued-yours] .yours-muted,[data-recued-yours] small {color:var(--fg-muted)}
[data-recued-yours] [data-yours-status]:empty,[data-recued-yours] [data-yours-error]:empty {display:none}
[data-recued-yours] [data-yours-status],[data-recued-yours] [data-yours-error] {padding:12px 16px;border-radius:var(--wc-radius,9px);background:var(--surface);margin-bottom:16px}
[data-recued-yours] [role=alert] {color:var(--danger)}
[data-recued-yours] .yours-notice {font-size:12px;color:var(--fg-muted);padding:0 0 16px}
[data-recued-yours] .yours-disclosure {border-top:1px solid var(--border);padding-top:16px}
[data-recued-yours] .yours-disclosure>summary {cursor:pointer;font-weight:550;min-height:44px;padding:10px 0}
[data-recued-yours] .yours-disclosure[open]>*+* {margin-top:14px}
[data-recued-yours] .yours-empty {padding:32px 24px;background:var(--surface);border:1px dashed var(--border-strong);border-radius:var(--wc-radius-lg,14px);color:var(--fg-muted)}
[data-recued-yours] [data-yours-missing-facts] {list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}
[data-recued-yours] [data-yours-missing-facts] li {min-width:0;max-width:100%}
[data-recued-yours] [data-yours-missing-facts] button {max-width:100%;text-align:left;font-size:12px;background:var(--surface-sunk);border-color:transparent}
[data-recued-yours] :is([data-yours-more-facts],[data-yours-asset-more],[data-yours-rule-more])>summary {min-height:44px;padding:10px 0;cursor:pointer;font-size:13px;color:var(--fg-muted)}
[data-recued-yours] .yours-pages {display:flex;gap:16px;align-items:center;min-height:40px}
[data-recued-yours] .yours-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:12px}
@media(pointer:coarse) {
 [data-recued-yours] :is(button,input,select,summary) {min-height:44px}
 [data-recued-yours] .yours-fact .yours-menu>summary,[data-recued-yours] [data-yours-sphere]>summary {min-height:44px;display:flex;align-items:center}
 [data-recued-yours] .yours-menu-body button,[data-recued-yours] label:has(>input[type=checkbox]) {min-height:44px}
 [data-recued-yours] .yours-list>[data-yours-asset]>[data-yours-open-asset] {min-height:44px}
 [data-recued-yours] [data-yours-sphere]>summary::after {content:'';width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);margin-inline-start:8px;flex:none}
 [data-recued-yours] .yours-asset-filters>summary {min-height:44px}
 [data-recued-yours] .yours-actions>a {min-height:44px;display:inline-flex;align-items:center}
 [data-recued-yours] .yours-nav a {min-width:44px;text-align:center}
}
@media(max-width:640px) {
 [data-recued-yours] {padding:16px 16px 32px;font-size:14px}
 [data-recued-yours] h1 {font-size:26px}
 [data-recued-yours] h2 {font-size:21px}
 [data-recued-yours] .yours-masthead {margin-bottom:16px}
 [data-recued-yours] .yours-masthead p {display:none}
 [data-recued-yours] .yours-nav {gap:20px;margin-bottom:20px}
 [data-recued-yours] .yours-page-header {flex-wrap:wrap;gap:12px}
 [data-recued-yours] .yours-content {gap:16px}
 [data-recued-yours] .yours-toolbar {padding:12px;gap:12px}
 [data-recued-yours] .yours-toolbar>label,[data-recued-yours] .yours-toolbar>label:first-child {flex:1 1 100%;max-width:none}
 [data-recued-yours] .yours-compact-filter {padding:0}
 [data-recued-yours] .yours-card {padding:16px}
 [data-recued-yours] .yours-list>[data-yours-asset] {display:flex;gap:8px;padding:16px}
 [data-recued-yours] [data-yours-open-asset] {position:static;align-self:flex-start}
 [data-recued-yours] .yours-editor {padding:20px 16px;margin:0 auto 16px}
 [data-recued-yours] .yours-editor .yours-actions {padding-bottom:env(safe-area-inset-bottom,0px)}
 [data-recued-yours] .yours-fact {grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;padding:16px 0}
 [data-recued-yours] .yours-fact dt {grid-column:1}
 [data-recued-yours] .yours-fact dd {grid-column:1;grid-row:2}
 [data-recued-yours] .yours-fact dd.yours-fact-actions {grid-column:2;grid-row:1 / span 2}
 [data-recued-yours] .yours-fact .yours-menu {grid-column:2;grid-row:1 / span 2}
 [data-recued-yours] dl:not(.yours-facts) {grid-template-columns:1fr}
}
`;
