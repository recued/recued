/** Webclient demo / shell polish layer.
 *
 *  ── Why this file exists ────────────────────────────────────────────
 *  Every route (`data`, `runs`, `recipes`, `automation`, `home`,
 *  Settings, …) ships its own self-scoped `*_ROUTE_STYLES` block and the
 *  shared `@recued/ui-shared` primitives ship `.rx-*`. Those grew
 *  independently and drifted: button heights, input radii, focus
 *  treatments, danger/primary handling, and floating-panel backgrounds
 *  are inconsistent surface-to-surface, and a couple of nested panels
 *  (the form-renderer object/union sections, the install-grant picker)
 *  render on a transparent background and visually lose their content.
 *
 *  This module is ONE normalization layer injected once at shell mount.
 *  It does not touch any route's own CSS — it layers on top, using the
 *  shell's two structural anchors so the cascade is predictable:
 *
 *    SHELL  = `[data-recued-webclient-shell]`   (wraps the whole app)
 *    CONTENT= `[data-recued-webclient-content]` (the <main> routes mount in)
 *
 *  ── Specificity contract (READ before editing) ──────────────────────
 *  Route control rules are written as `[ROUTE_HOST] .data-button`
 *  (specificity 0,2,0). To win deterministically — regardless of which
 *  `<style>` lands in `<head>` first — every override here that must beat
 *  a route rule is scoped `SHELL CONTENT :is(.a, .b, …)` (0,3,0). The
 *  `:is()` list keeps it one rule per concern while contributing only its
 *  most-specific argument (a single class → 0,1,0).
 *
 *  Baseline rules for *un-classed* native controls are wrapped in
 *  `:where(CONTENT)` so they contribute (0,0,1) — a pure floor that any
 *  explicit class (route or primitive) overrides. That gives a sane
 *  default to the many bare `<input>`/`<button>` call sites in Settings
 *  without ever fighting a styled control.
 *
 *  ── Webclient-local design knobs ────────────────────────────────────
 *  The `--wc-*` custom properties below are defined on SHELL and explicit
 *  webclient portals so they cascade inside the app but never leak to the Bridge /
 *  dashboard / marketplace (which link the same `tokens.css` but have no
 *  shell host). Editing one knob retunes every control at once. */

export const WEBCLIENT_POLISH_STYLES_MARKER = 'data-recued-webclient-polish';

export const WEBCLIENT_POLISH_STYLES = `
/* ── Webclient-local design knobs + transparent-panel source fix ──── */
[data-recued-webclient-shell], [data-recued-webclient-overlay] {
  --wc-radius: 9px;
  --wc-radius-lg: 14px;
  --wc-radius-pill: 999px;
  --wc-control-h: 40px;
  --wc-task-action-width: 7.5rem;
  --wc-task-filter-width: 6.5rem;
  --wc-pad-x: 14px;
  --wc-gap: 14px;
  --wc-space-sm: 8px;
  --wc-space-md: 16px;
  --wc-space-lg: 24px;
  --wc-page-pad: 24px;
  --wc-font-body: 14px;
  --wc-font-small: 12px;
  --wc-font-title: clamp(24px, 3vw, 28px);
  /* One content column width every workspace/list route shares so the
     column stops jumping (960/980/1040/1120) as you navigate. Each route
     reads it via max-width: var(--wc-content-max, 1080px). Settings keeps
     a narrower form column inside the wide desktop frame. */
  --wc-content-max: 1160px;
  /* Keyboard focus: a gap in the surface colour, then 2px of accent. ⛔ It was
     the accent at 10% (1.14:1 on white), which a keyboard user lost track of.
     The gap keeps the ring visible around an accent-filled button. */
  --wc-ring: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent);
  /* A field's edge: 3:1 against the surface, the page and a sunk panel in
     both themes (3.40:1 at worst light, 4.66:1 dark). ⛔ --border-strong
     measured 1.48:1, so fields read as text. */
  --wc-field-edge: color-mix(in srgb, var(--fg-muted) 85%, var(--surface));
  --wc-shadow-panel: 0 24px 64px rgba(15, 23, 42, 0.20), 0 2px 8px rgba(15, 23, 42, 0.06);
  /* The form-renderer reads object/union backgrounds from these props
     with a 'transparent' fallback (PALETTE_FALLBACKS pins them to
     transparent on :root). Re-point them on the shell so nested form
     sections sit on a clear sunk panel instead of bleeding into the
     parent — the documented fix for the "nested sections lose content"
     bug. */
  --color-object-bg: var(--surface-sunk);
  --color-union-variant-bg: var(--surface-sunk);
}
:where([data-recued-webclient-content]) {
  font-size: var(--wc-font-body);
  line-height: 1.5;
}

/* ════════════════════════════════════════════════════════════════
   1 · Baseline for un-classed native controls (pure floor)
   ════════════════════════════════════════════════════════════════ */
:where([data-recued-webclient-content]) button,
:where([data-recued-webclient-content]) [role="button"] {
  font-family: inherit;
  cursor: pointer;
  /* Inherit the themed text colour instead of the UA system ButtonText
     (black), which doesn't track our dark theme — a bare/un-classed button
     was unreadable in dark mode. Classed buttons (data-button, rx-btn,
     accent fills) override this 0,0,1 floor. */
  color: inherit;
}
/* A link that sets no colour of its own takes the accent. ⛔ Such links drew
   the browser's own blue, lavender in dark, which no theme uses. */
:where([data-recued-webclient-content]) a:where([href]) {
  color: var(--accent);
}
:where([data-recued-webclient-content]) input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]),
:where([data-recued-webclient-content]) select,
:where([data-recued-webclient-content]) textarea {
  box-sizing: border-box;
  font-family: inherit;
  font-size: 13px;
  color: var(--fg);
  background: var(--surface);
  border-radius: var(--wc-radius);
  min-height: 40px;
  padding: 8px 11px;
}
:where([data-recued-webclient-content]) textarea { resize: vertical; }

/* Inventory fields share tracks rather than sizing themselves from the
   currently selected provider or status. Labels sit above the same baseline. */
/* Keep the filter axes stable when Clear filters appears. The container is
   limited to the filter row so enrollment dialogs retain their viewport. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) {
  container: connections-filters / inline-size;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: end;
  gap: 8px 12px;
  min-width: 0;
  margin: 0;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label {
  display: grid; gap: 6px; min-width: 0;
  font-size: 12px; font-weight: 600; line-height: 1.4; color: var(--muted);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label:nth-of-type(1) { grid-column: 1 / span 2; grid-row: 1; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label:nth-of-type(2) { grid-column: 3; grid-row: 1; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label:nth-of-type(3) { grid-column: 4; grid-row: 1; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) :is(input, select) {
  box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0;
  height: var(--wc-control-h, 44px); min-height: var(--wc-control-h, 44px); padding: 0 10px;
  border-radius: var(--wc-radius, 9px);
  background: var(--surface); color: var(--fg); font: inherit; font-size: 13px; font-weight: 400;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > [role="status"] {
  grid-column: 1 / span 3; grid-row: 2;
  display: flex; align-items: center; min-width: 0; min-height: var(--wc-control-h, 44px);
  color: var(--muted); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > button {
  grid-column: 4; grid-row: 2; justify-self: end; max-width: 100%; min-width: 0;
  min-height: var(--wc-control-h, 44px); padding: 0 12px; border-radius: var(--wc-radius, 9px);
  font-size: 13px; font-weight: 600; white-space: normal; overflow-wrap: anywhere;
}
@container connections-filters (max-width: 52rem) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label:nth-of-type(1) { grid-column: 1 / -1; }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label:nth-of-type(2) { grid-column: 1 / span 2; grid-row: 2; }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label:nth-of-type(3) { grid-column: 3 / span 2; grid-row: 2; }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > [role="status"] { grid-column: 1 / span 2; grid-row: 3; }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > button { grid-column: 3 / span 2; grid-row: 3; }
}
@container connections-filters (max-width: 22rem) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label:nth-of-type(2) { grid-column: 1 / -1; }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > label:nth-of-type(3) { grid-column: 1 / -1; grid-row: 3; }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > [role="status"],
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-inventory-filters, .accounts-inventory-filters) > button { grid-row: 4; }
}
/* Inventory cards keep one inset and text scale across account and API lanes.
   Let actions move below the details before they squeeze the identity column. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-group-rows, .accounts-rows) { gap: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row, .accounts-row) {
  border-radius: var(--wc-radius-lg, 14px); background: var(--surface);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row, .accounts-row-main) { padding: 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-row-main { gap: 6px; border-radius: inherit; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row, .accounts-cloud-source) {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 24px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-row-info { gap: 6px; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row-name, .accounts-row-name) {
  font-size: 14px; font-weight: 600; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row-meta, .accounts-row-sub) { font-size: 12px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-cloud-source > :is(.accounts-row-name, .accounts-row-meta) { grid-column: 1; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-cloud-source > .accounts-form-actions { grid-column: 2; grid-row: 1 / span 2; margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row-actions, .accounts-cloud-source > .accounts-form-actions) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row-actions, .accounts-cloud-source > .accounts-form-actions) > .rx-btn {
  flex: 1 1 auto; box-sizing: border-box; min-height: var(--wc-control-h, 44px); max-width: 100%;
  padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4;
  white-space: normal; overflow-wrap: anywhere;
}
@media (max-width: 900px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row, .accounts-cloud-source) { grid-template-columns: minmax(0, 1fr); row-gap: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .accounts-cloud-source > .accounts-form-actions { grid-column: 1; grid-row: auto; }
}
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-row .connections-row-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-row-actions > :is([data-action="connections-manage-row-authentication"], [data-action="connections-engagement-toggle"]) { grid-column: 1 / -1; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .accounts-cloud-source > .accounts-form-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row-actions, .accounts-cloud-source > .accounts-form-actions) { align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row-actions, .accounts-cloud-source > .accounts-form-actions) > .rx-btn { padding: 4px 8px; }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-row-actions, .accounts-cloud-source > .accounts-form-actions) { grid-template-columns: minmax(0, 1fr); }
}
/* Setup choices share a responsive grid and start their captions at the same
   inset. Authentication cards retain the component's selected-state colours. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-picker-title, .accounts-picker-title) {
  margin: 0 0 16px; font-size: 20px; font-weight: 600; line-height: 1.3;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-picker-grid, .accounts-picker-grid, .connections-auth-method-cards) {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  gap: 12px; min-width: 0; margin: 0;
}
/* Subtypes carry setup instructions and service limits; give that copy a
   full-width reading row. The kind grid sits inside its own section. */
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-picker > .connections-picker-grid { grid-template-columns: minmax(0, 1fr); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-picker-section { gap: 12px; margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-picker-card, .accounts-picker-card, .connections-auth-method-card) {
  display: grid; align-content: start; gap: 8px; box-sizing: border-box; min-width: 0; max-width: 100%;
  padding: 16px; border-radius: var(--wc-radius-lg, 14px); text-align: left; white-space: normal; overflow-wrap: anywhere;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-picker-card, .accounts-picker-card, .connections-auth-method-card) > strong {
  font-size: 14px; font-weight: 600; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-picker-card-desc, .accounts-picker-card-desc, .connections-auth-method-card > span) {
  font-size: 13px; line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-picker-card, .accounts-picker-card) { background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-picker-card, .accounts-picker-card):hover { background: var(--surface-sunk); }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-picker > .connections-dialog-actions, .accounts-picker > .accounts-form-actions) {
  justify-content: flex-start; gap: 8px; margin-top: 16px;
}
/* Account facts use stable label tracks on larger screens and a full reading
   width on phones. Keep the native definition list and action order intact. */
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail { max-width: 780px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail-title {
  margin: 0 0 16px; font-size: 20px; font-weight: 600; line-height: 1.3;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail-grid {
  box-sizing: border-box; grid-template-columns: minmax(8rem, 10rem) minmax(0, 1fr); gap: 12px 24px;
  padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail-grid dt { font-size: 12px; font-weight: 600; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail-grid dd { font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail > .accounts-form-actions { gap: 8px; margin-top: 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail > .accounts-form-actions > .rx-btn {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 44px);
  padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4;
  white-space: normal; overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail-grid { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail-grid dd:not(:last-child) { margin-bottom: 8px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail > .accounts-form-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .accounts-detail > .accounts-form-actions > .rx-btn { padding: 4px 8px; }
}
/* Connection setup uses the same control scale as its inventory. Keep state
   colours in the components so rejected credentials and locked fields read
   correctly after sizing the native controls. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-form-title, .accounts-form-title) {
  font-size: 20px; font-weight: 600; line-height: 1.3;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-form-description, .accounts-form-desc) {
  font-size: 13px; line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-form-fields, .accounts-form-fields) { gap: 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-form .rx-form-row:not(.rx-form-row-inline) {
  grid-template-columns: minmax(0, 1fr); align-items: start; min-width: 0; margin-bottom: 0;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-field-row, .accounts-form-fields .rx-form-row, .accounts-password-repair label) {
  min-width: 0; gap: 6px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-form, .accounts-form, .accounts-password-repair) label:not(:has(input[type="checkbox"], input[type="radio"])) {
  font-size: 12px; font-weight: 600; line-height: 1.4;
}
:where([data-recued-webclient-content] :is(.connections-form, .accounts-form, .accounts-password-repair) label:not(:has(input[type="checkbox"], input[type="radio"]))) { color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-form, .accounts-form, .accounts-password-repair) label:has(> select) {
  display: grid; gap: 6px; min-width: 0;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-form, .accounts-form, .accounts-password-repair) :is(
  input:not([type]), input[type="text"], input[type="password"], input[type="number"],
  input[type="url"], input[type="email"], input[type="search"],
  select:not([multiple]):not([size]), select[size="1"]:not([multiple])
) {
  box-sizing: border-box; max-width: 100%; min-width: 0;
  height: var(--wc-control-h, 44px); min-height: var(--wc-control-h, 44px); padding: 0 10px;
  border-radius: var(--wc-radius, 9px); font-size: 13px; font-weight: 400; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-form, .accounts-form) textarea {
  max-width: 100%; min-width: 0; font-size: 13px; line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-form :is(select:not([multiple]):not([size]), select[size="1"]:not([multiple])) { overflow: hidden; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.connections-form, .accounts-form) .rx-field-hint {
  font-size: 12px; line-height: 1.5; overflow-wrap: anywhere;
}
/* Saved app credentials follow the setup form scale. Leave field colours and
   borders to their existing focus, disabled and validation treatments. */
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] {
  display: grid; gap: 16px; min-width: 0; max-width: 780px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] > h3 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] > label { min-width: 0; gap: 6px; margin: 0; font-size: 12px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] :is(input, select) {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%;
  height: var(--wc-control-h, 44px); min-height: var(--wc-control-h, 44px); padding: 0 10px;
  border-radius: var(--wc-radius, 9px); font-size: 13px; font-weight: 400; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] > p { margin: 0; font-size: 13px; line-height: 1.5; }
:where([data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] > :is(label, p:not([role="alert"]))) { color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] > button { justify-self: start; margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] .oauth-apps-form-actions { gap: 8px; margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] button {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 44px);
  padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] .oauth-apps-form-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps [data-oauth-app-editor] button { padding: 4px 8px; }
}
/* Saved-app maintenance reviews use the same field and choice rhythm as setup. */
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) {
  min-width: 0; padding-top: 16px; font-size: 13px; line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) h3 { margin: 0 0 12px; font-size: 20px; font-weight: 600; line-height: 1.3; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) :is(h4, h5) { margin: 16px 0 8px; font-size: 13px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) p { margin: 8px 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) button {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 44px);
  padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) .rx-btn-primary { color: var(--on-accent); }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-permissions) label:not(:has(input[type="checkbox"])) { display: grid; gap: 6px; min-width: 0; margin: 16px 0 8px; font-size: 12px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-permissions) input:is([type="password"], [type="date"], [type="url"]) {
  box-sizing: border-box; width: 100%; max-width: 780px; min-width: 0;
  height: var(--wc-control-h, 44px); min-height: var(--wc-control-h, 44px); padding: 0 10px;
  border-radius: var(--wc-radius, 9px); font-size: 13px; font-weight: 400; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-maintenance-choices, .oauth-app-renewal > ul, .oauth-permission-scopes) { display: grid; gap: 8px; padding: 0; margin: 12px 0; list-style: none; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-maintenance-choices, .oauth-app-renewal > ul, .oauth-permission-scopes) > li { min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) label:has(input[type="checkbox"]) {
  display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 8px; margin: 0;
  min-width: 0; min-height: var(--wc-control-h, 44px); padding: 8px 0; box-sizing: border-box; font-size: 13px; line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) input[type="checkbox"] { box-sizing: border-box; width: 18px; min-width: 18px; height: 18px; min-height: 18px; margin: 1px 0 0; padding: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps .oauth-maintenance-choices label > span { display: grid; gap: 4px; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage [role="group"], [data-permission-group], [data-permission-cleanup-preview], [data-permission-cleanup-task]) { min-width: 0; margin: 16px 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is([data-permission-cleanup-preview], [data-permission-cleanup-task]) > :first-child { margin-top: 0; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage, .oauth-app-renewal, .oauth-permissions) button { width: 100%; margin: 4px 0; padding: 6px 8px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .oauth-apps :is(.oauth-app-usage [role="group"], [data-permission-group], [data-permission-cleanup-preview], [data-permission-cleanup-task]) { padding: 12px; }
}
/* Identity settings share caption tracks and the setup control scale. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is([data-recued-settings-section="account"], [data-recued-settings-section="servers"]) { --wc-control-h: 40px; gap: 16px; font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is([data-recued-settings-section="account"], [data-recued-settings-section="servers"]) > h2 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] { gap: 16px; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .account-bind-card { min-width: 0; padding: 16px; gap: 12px; border-radius: var(--wc-radius-lg, 14px); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] h3 { font-size: 16px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] :is(.account-bind-kv, .account-bind-pro-item) { display: grid; grid-template-columns: 160px minmax(0, 1fr); align-items: start; gap: 4px 12px; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] :is(.account-bind-k, .account-bind-pro-label) { min-width: 0; font-size: 12px; line-height: 1.5; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] :is(.account-bind-v, .account-bind-pro-value) { min-width: 0; overflow-wrap: anywhere; word-break: normal; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] :is(.account-bind-pro-value, .account-bind-pro-state, .account-bind-pro-detail, .account-bind-dashboard-inline) { grid-column: 2; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .account-bind-pro-items { gap: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .account-bind-conflict { padding: 12px; gap: 12px; border-radius: var(--wc-radius, 9px); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .account-bind-actions { gap: 8px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] :is(button, .account-bind-dashboard-link) { box-sizing: border-box; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 40px); padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .account-bind-card > .account-bind-dashboard-link { align-self: flex-start; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .rx-btn-primary { color: var(--on-accent); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] [data-server-address-panel] { gap: 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] [data-server-address-row] { padding: 16px; border-radius: var(--wc-radius-lg, 14px); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] .server-address-name { font-size: 16px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] :is(.server-address-caption, .server-address-field > span) { font-size: 12px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] .server-address-field { gap: 6px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] [data-server-address-input] { height: var(--wc-control-h, 40px); min-height: var(--wc-control-h, 40px); padding: 0 10px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] .server-address-actions { gap: 8px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] [data-server-address-row] button { min-height: var(--wc-control-h, 40px); padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] [data-server-address-status] { border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.5; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is([data-recued-settings-section="account"], [data-recued-settings-section="servers"]) { --wc-control-h: 44px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .account-bind-card,
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-section="servers"] [data-server-address-row] { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] :is(.account-bind-kv, .account-bind-pro-item) { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] :is(.account-bind-pro-value, .account-bind-pro-state, .account-bind-pro-detail, .account-bind-dashboard-inline) { grid-column: auto; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .account-bind-actions { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-account-binding-panel] .account-bind-card > .account-bind-dashboard-link { align-self: stretch; }
}
/* Backup forms keep the same label track even when a time or count control is
   shorter than a storage selector. Native disclosures and file controls stay native. */
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] { --wc-control-h: 40px; gap: 16px; font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] > h2 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] h3 { margin: 0 0 12px; font-size: 16px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] :is([data-backup-card], [data-unattended-backups], [data-backup-history-card]) { padding: 16px; margin-block: 16px; border-radius: var(--wc-radius-lg, 14px); min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-backup-card] { margin-block: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-unattended-backups] { margin-top: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-backup-disclosure] { margin-block: 16px; border-radius: var(--wc-radius, 9px); min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-backup-disclosure] > summary { padding: 10px 12px; font-size: 13px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-backup-disclosure-body] { padding: 0 12px 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-backup-disclosure="tools"] [data-backup-disclosure-body] > div + div { padding-top: 16px; margin-top: 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-remote-backups] label:has(> :is(select, input:not([type="checkbox"]))) { display: grid; grid-template-columns: 220px minmax(0, 1fr); align-items: center; gap: 6px 12px; margin-block: 12px; min-width: 0; font-size: 12px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-remote-backups] :is(select, input:not([type="checkbox"])) { width: 100%; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 40px); padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4; background: var(--surface); color: var(--fg); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-remote-backups] :is(input[type="number"], input[type="time"]) { max-width: 12rem; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] label:has(> input[type="checkbox"]) { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 8px; min-height: var(--wc-control-h, 40px); margin-block: 8px; font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] input[type="checkbox"] { grid-column: 1; grid-row: 1; width: 18px; min-width: 18px; height: 18px; min-height: 18px; padding: 0; margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] button { box-sizing: border-box; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 40px); padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] .rx-btn-primary { color: var(--on-accent); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] :is([data-archive-import-check], [data-archive-import-dismiss]) { margin: 4px 8px 4px 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] .archive-backup-block { gap: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] .archive-backup-field { gap: 6px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] :is(.archive-backup-manifest, textarea, .archive-backup-field input[type="text"]) { border-radius: var(--wc-radius, 9px); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] .archive-backup-actions { flex-wrap: wrap; gap: 8px; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] { --wc-control-h: 44px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] :is([data-backup-card], [data-unattended-backups], [data-backup-history-card]) { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-remote-backups] label:has(> :is(select, input:not([type="checkbox"]))) { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] [data-remote-backups] :is(input[type="number"], input[type="time"]) { max-width: 100%; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] button { width: 100%; margin: 4px 0; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] :is([data-archive-import-check], [data-archive-import-dismiss]) { margin: 4px 0; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-backup-workspace] .archive-backup-actions > button { margin: 0; }
}
/* Authentication choices share tracks rather than taking their widths from
   their labels. Component variants still own selected and busy states. */
[data-recued-webclient-shell] [data-recued-webclient-content] .auth-management {
  box-sizing: border-box; max-width: 100%; gap: 12px; margin: 16px 0; padding: 16px; border-radius: var(--wc-radius-lg, 14px);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-panel .auth-management { max-width: 780px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .auth-management-head { gap: 8px 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .auth-management-head h3 { font-size: 16px; font-weight: 600; line-height: 1.35; }
[data-recued-webclient-shell] [data-recued-webclient-content] .auth-management-choices {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: 8px; align-items: stretch;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .auth-management-choices > .rx-btn {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 44px);
  padding: 6px 10px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.auth-management-status, .auth-management-note) { font-size: 13px; line-height: 1.5; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .auth-management-choices { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] .auth-management-choices > .rx-btn { padding: 4px 8px; }
}
/* Broker fields start at the same baseline even when only one has a hint.
   The key toggle follows its input row, including validation messages. */
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-editor { border-radius: var(--wc-radius-lg, 14px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-field { align-content: start; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-field > :is(label, span) { font-size: 12px; font-weight: 600; line-height: 1.4; }
:where([data-recued-webclient-content] .connections-managed-oauth .managed-oauth-field > :is(label, span)) { color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-field :is(input[type="text"], input[type="password"], input[type="url"], select) {
  height: var(--wc-control-h, 44px); min-height: var(--wc-control-h, 44px); border-radius: var(--wc-radius, 9px);
  font-size: 13px; font-weight: 400; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-field input:is([type="text"], [type="password"], [type="url"]) { padding: 0 10px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-field select { padding: 0 32px 0 10px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-editor button {
  box-sizing: border-box; min-height: var(--wc-control-h, 44px); max-width: 100%; padding: 6px 12px;
  border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere;
}
@media (min-width: 641px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-key { row-gap: 6px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-key > .managed-oauth-field { grid-column: 1; grid-row: 1 / span 3; grid-template-rows: subgrid; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-key > .managed-oauth-field:has(.managed-oauth-field-error) { grid-row-end: span 4; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-key > button { grid-column: 2; grid-row: 2; align-self: stretch; justify-self: stretch; margin: 0; }
}
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-editor > .managed-oauth-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-editor button { padding: 4px 8px; }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-editor > .managed-oauth-actions { grid-template-columns: minmax(0, 1fr); }
}
/* Account usage keeps names, API status and activity in separate reading rows.
   Connection actions share a stable phone grid within each saved account. */
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-usage { gap: 12px; padding: 16px; border-radius: var(--wc-radius-lg, 14px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-usage > h5 { font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection {
  gap: 12px; margin: 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection > h5 { display: grid; gap: 4px; font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection > h5 > code { font-size: 11px; font-weight: 400; line-height: 1.5; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection dl { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection dl > div { display: grid; align-content: start; gap: 4px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection dt { font-size: 12px; font-weight: 500; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection dd { font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection > ul { margin: 0; padding-left: 18px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection > ul > li + li { margin-top: 4px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-usage button { min-height: var(--wc-control-h, 44px); padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection dl { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection > .managed-oauth-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection > .managed-oauth-actions > button { justify-self: stretch; padding: 4px 8px; }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-account-connection > .managed-oauth-actions { grid-template-columns: minmax(0, 1fr); }
}
/* Permission groups share reading tracks instead of wrapping as uneven chips.
   The decision, explanations and warnings keep the full review width. */
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 16px; border-radius: var(--wc-radius-lg, 14px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview > * { grid-column: 1 / -1; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview > .managed-oauth-scopes { grid-column: auto; align-content: start; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview > .managed-oauth-scopes > h5 { font-size: 12px; font-weight: 600; line-height: 1.4; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; align-items: center; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview-head > button { min-height: var(--wc-control-h, 44px); padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview .managed-oauth-scope-list { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview .managed-oauth-scope-list > li { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview .managed-oauth-scope-list code { display: block; padding: 6px 8px; border-radius: var(--wc-radius, 9px); }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview,
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview-head { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-managed-oauth .managed-oauth-preview-head > button { justify-self: stretch; }
}
/* Account comparisons and affected connections use the same review rhythm.
   A single account fills the comparison, and phone comparisons read in order. */
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface-sunk); font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > :is(h4, h5, p) { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > h4 { font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > h5,
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact [data-file-source-authentication] > h5 { font-size: 12px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-card { display: grid; align-content: start; gap: 8px; padding: 16px; border-radius: var(--wc-radius, 9px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-card:only-child { grid-column: 1 / -1; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-card > :is(h5, p) { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-card > h5 { font-size: 12px; font-weight: 600; line-height: 1.4; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-card > p:has(> strong) { display: grid; gap: 4px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-card code { font-size: 11px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact [data-managed-vendor-email] { font-weight: 600; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > ul { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > ul > li { display: grid; gap: 8px; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > ul > li > :is(h5, p) { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > ul > li > h5 { display: grid; gap: 4px; font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > ul > li > h5 > code { font-size: 11px; font-weight: 400; line-height: 1.5; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > ul > li > ul,
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact [data-file-source-authentication] > ul { margin: 0; padding-left: 18px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact > ul > li > ul > li + li { margin-top: 4px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact [data-file-source-authentication] { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact [data-file-source-authentication] > :is(h5, p) { margin: 0; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-cards { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] .managed-oauth-impact .managed-oauth-account-card { padding: 12px; }
}
/* Bulk setup uses stacked captions and shared field widths. Checkbox choices
   keep their control beside a stable name, identifier and sign-in summary. */
[data-recued-webclient-shell] [data-recued-webclient-content] section.connections-bulk-migration { display: grid; gap: 16px; max-width: 780px; font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > :is(h2, h3, p) { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > h2 { font-size: 20px; font-weight: 600; line-height: 1.3; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > h3 { font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > label:not(.bulk-account-choice) { display: grid; gap: 6px; margin: 0; font-size: 12px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > label:has(> input[type="url"]) { padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > label > p { margin: 0; font-size: 13px; font-weight: 400; line-height: 1.5; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > label > code { font-size: 11px; font-weight: 400; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > label > :is(select, input[type="url"]) { width: 100%; height: var(--wc-control-h, 44px); min-height: var(--wc-control-h, 44px); padding: 0 10px; border-radius: var(--wc-radius, 9px); font-size: 13px; font-weight: 400; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > label > select { overflow: hidden; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-account-choice { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 10px; align-items: start; margin: 0; padding: 16px; border-radius: var(--wc-radius-lg, 14px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-account-choice > input { width: 16px; height: 16px; margin: 2px 0 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-account-summary { display: grid; gap: 4px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-account-summary > strong { font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-account-summary > :is(code, span) { font-size: 12px; font-weight: 400; line-height: 1.5; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-account-summary > code { font-size: 11px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-account-choice:has(> input:checked) { border-color: var(--accent); background: var(--accent-weak); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > p[role="alert"] { padding: 12px; border-left: 3px solid var(--danger); border-radius: var(--wc-radius, 9px); background: var(--danger-weak); color: var(--danger); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration button { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > div:last-child { display: flex; flex-wrap: wrap; gap: 8px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > div:last-child > button,
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > button[data-bulk-resume] { min-height: var(--wc-control-h, 44px); padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > label:has(> input[type="url"]),
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-account-choice { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > div:last-child { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > div:last-child > button { justify-self: stretch; padding: 4px 8px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > div:last-child:has(> button:last-child:nth-child(odd)) > [data-bulk-action="close"] { grid-column: 1 / -1; }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration > div:last-child { grid-template-columns: minmax(0, 1fr); }
}
/* Results separate the connection, outcome and read-check reference. Keep the
   recorded outcome text so colour never substitutes for what was verified. */
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-progress { padding: 12px; border-radius: var(--wc-radius, 9px); background: var(--surface-sunk); font-weight: 600; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-results { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result { display: grid; gap: 12px; margin: 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result > :is(h4, p) { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result > h4 { display: grid; gap: 4px; font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result > h4 > code { font-size: 11px; font-weight: 400; line-height: 1.5; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result > p[role="status"] { padding: 8px 10px; border-radius: var(--wc-radius, 9px); background: var(--surface-sunk); color: var(--fg); font-weight: 500; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result:is([data-bulk-row-state="verified"], [data-bulk-row-state="applying"]) > p[role="status"] { background: var(--accent-weak); color: var(--accent); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result[data-bulk-row-state="migrated"] > p[role="status"] { font-weight: 600; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result[data-bulk-row-state="failed"] > p[role="status"] { background: var(--danger-weak); color: var(--danger); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result > p:not([role]) { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result > p:not([role]) > code { font-size: 11px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result > details > summary { min-height: var(--wc-control-h, 44px); padding: 8px 0; font-size: 12px; font-weight: 600; line-height: 1.4; cursor: pointer; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result > details[open] > summary { margin-bottom: 12px; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connections-bulk-migration .bulk-migration-result { padding: 12px; }
}
/* Guided sign-in help shares the form scale. Keep ordered steps, native
   checkbox labels and the local-review qualification easy to read. */
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help { margin: 16px 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help:has(> div) { box-sizing: border-box; max-width: 780px; padding: 16px; border-radius: var(--wc-radius-lg, 14px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help > div { display: grid; gap: 12px; margin-top: 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help > div > :is(h3, p) { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help h3 { font-size: 16px; font-weight: 600; line-height: 1.35; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-field { display: grid; gap: 6px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-field > label { font-size: 12px; font-weight: 600; line-height: 1.4; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-field > select { height: var(--wc-control-h, 44px); min-height: var(--wc-control-h, 44px); padding: 0 10px; border-radius: var(--wc-radius, 9px); font-size: 13px; font-weight: 400; line-height: 1.4; overflow: hidden; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help ol { display: grid; gap: 12px; margin: 0; padding-left: 24px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help li { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help li::marker { font-size: 12px; font-weight: 600; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help li label { display: inline-grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 10px; width: 100%; vertical-align: top; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help input[type="checkbox"] { min-height: 18px; padding: 0; margin: 2px 0 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-callback { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface-sunk); font-size: 11px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help button { min-height: var(--wc-control-h, 44px); padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-actions { display: flex; flex-wrap: wrap; gap: 8px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-actions + p { font-size: 12px; color: var(--muted); }
[data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help > div > p[role="status"] { padding: 10px 12px; border-radius: var(--wc-radius, 9px); background: var(--surface-sunk); }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-actions > button { justify-self: stretch; padding: 4px 8px; }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .oauth-help-actions { grid-template-columns: minmax(0, 1fr); }
}
/* Replacement steps share the connection form scale. Account comparisons use
   bounded tracks so their identities remain inside narrow review panels. */
[data-recued-webclient-shell] [data-recued-webclient-content] section.connection-replacement { max-width: 780px; gap: 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-step { gap: 12px; padding: 16px; border-radius: var(--wc-radius-lg, 14px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-step-title { font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-pair { gap: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-field { gap: 6px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-field-label { line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement select { height: var(--wc-control-h, 44px); min-height: var(--wc-control-h, 44px); padding: 0 10px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4; overflow: hidden; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-arrow { display: grid; align-items: center; height: var(--wc-control-h, 44px); padding: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-choices { gap: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-choices > li { gap: 8px; padding: 12px; border-radius: var(--wc-radius, 9px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-choices .replacement-muted { padding-left: 28px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-check { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-check input { min-height: 18px; padding: 0; margin: 2px 0 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-identities { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-identity { gap: 6px; padding: 12px; border-radius: var(--wc-radius, 9px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-identity-role { font-size: 12px; font-weight: 600; line-height: 1.4; letter-spacing: 0; text-transform: none; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-identity-detail { gap: 4px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-identity-detail > strong { font-size: 14px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-identity-id { font-size: 11px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .rx-btn { min-height: var(--wc-control-h, 44px); padding: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-result { gap: 12px; padding: 16px; border-radius: var(--wc-radius-lg, 14px); background: var(--surface); }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-history-list { gap: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-history-list > li { padding: 12px; border-radius: var(--wc-radius, 9px); }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-step { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement :is(.replacement-pair, .replacement-identities) { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-arrow { display: none; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-actions > .rx-btn { justify-self: stretch; padding: 4px 8px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-actions > :only-child { grid-column: 1 / -1; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-history-list > li { display: grid; }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .connection-replacement .replacement-actions { grid-template-columns: minmax(0, 1fr); }
}
/* Access reviews also mount inside the repair worklist. Give their own cards
   explicit padding and flow so the worklist's article grid cannot flatten
   nested resource fields against the card border. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access, .authentication-incidents) {
  font-size: var(--wc-font-body, 14px); line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-incidents > h2 {
  margin: 0 0 12px; font-size: var(--wc-font-title, 26px); line-height: 1.2; font-weight: 680; letter-spacing: -.025em;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access, .authentication-incidents) h3 {
  margin: 0 0 12px; font-size: 15px; line-height: 1.4; font-weight: 650;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access, .authentication-incidents) :is(h4, h5) {
  margin: 16px 0 8px; font-size: 14px; line-height: 1.4; font-weight: 650;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access, .authentication-incidents) p { margin: 0 0 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-incidents > p { max-width: 84ch; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access, .authentication-history-filters, .authentication-history-file, .authentication-history-preview) {
  padding: 16px; border-radius: var(--wc-radius, 9px);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-access > article {
  display: block; margin: 0; padding: 16px 0; border: 0; border-top: 1px solid var(--border); border-radius: 0; background: transparent;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .bulk-authentication-access > article {
  margin: 12px 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-incidents > article {
  padding: 16px; border-radius: var(--wc-radius, 9px);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access, .authentication-incidents) article > :first-child { margin-top: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access, .authentication-incidents) :is(button, select, input:not([type="checkbox"]):not([type="radio"]):not([type="file"])) {
  box-sizing: border-box; min-height: var(--wc-control-h, 40px); border-radius: var(--wc-radius, 9px); padding: 8px 11px; font-size: 13px; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-access label:has(> input[type="checkbox"]) {
  display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 8px; margin: 8px 0 12px; cursor: pointer;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-access label > input[type="checkbox"] { margin: 4px 0 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access label:not(:has(input)), .authentication-history-filter-fields label, .authentication-history-file label) {
  margin: 0 0 6px; color: var(--fg-muted); font-size: 12px; font-weight: 600; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-filter-fields {
  grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-filter-fields > div { min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-filters > p { margin-top: 12px; color: var(--fg-muted); font-size: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-export-privacy { gap: 8px 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-export-privacy select { height: var(--wc-control-h, 40px); }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-file input[type="file"] {
  min-height: var(--wc-control-h, 40px); padding: 0; border: 0; border-radius: 0; background: transparent;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-file input::file-selector-button {
  min-height: var(--wc-control-h, 40px); margin-right: 8px; padding: 8px 11px; border-radius: var(--wc-radius, 9px); font-size: 13px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview button { margin-right: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview select { height: var(--wc-control-h, 40px); }
/* Bundle and support sections contain more than their copy controls. Keep
   the compact copy tool, while allowing the surrounding history to use the
   record's reading width. Saved fields follow the other record fact grids. */
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview :is(
  [data-history-preview-related="bundle"], [data-history-preview-support="timeline"]
) { max-width: none; }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview :is(
  [data-history-preview-related="bundle"], [data-history-preview-support="timeline"]
) > summary { margin-bottom: 8px; font-weight: 600; }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview :is(
  [data-history-preview-related="bundle"], [data-history-preview-support="timeline"]
) > p { max-width: 84ch; }
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview :is([data-history-preview-record], [data-history-preview-related-record], [data-history-preview-linked-record]) > dl {
  display: grid; grid-template-columns: minmax(0, 180px) minmax(0, 1fr); align-items: start; gap: 8px 16px; margin: 16px 0;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview :is([data-history-preview-record], [data-history-preview-related-record], [data-history-preview-linked-record]) > dl > dt {
  margin: 0; color: var(--fg-muted); font-size: 12px; line-height: 1.5; font-weight: 600;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview :is([data-history-preview-record], [data-history-preview-related-record], [data-history-preview-linked-record]) > dl > dd { margin: 0; min-width: 0; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview :is([data-history-preview-record], [data-history-preview-related-record], [data-history-preview-linked-record]) > dl { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-preview :is([data-history-preview-record], [data-history-preview-related-record], [data-history-preview-linked-record]) > dl > dd { margin-bottom: 8px; }
}
[data-recued-webclient-shell] [data-recued-webclient-content] .access-comparison-controls {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .access-comparison-controls > :is(button, a) { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .access-comparison-controls > :is(div, p) { flex-basis: 100%; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .access-comparison {
  padding: 16px; border-radius: var(--wc-radius, 9px); background: var(--surface-subtle, var(--surface-sunk));
}
[data-recued-webclient-shell] [data-recued-webclient-content] .access-comparison-clocks { gap: 16px; }
/* Native account repair and saved-app switches share the same field rhythm
   as API setup. Their action wrappers keep wrapping independent of labels. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-repair, .accounts-oauth-app-switch, .accounts-bulk-app-switch) {
  padding: 16px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-repair, .accounts-oauth-app-switch, .accounts-bulk-app-switch) :is(h2, h3) {
  margin: 0 0 12px; font-size: 15px; font-weight: 650; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-repair, .accounts-oauth-app-switch, .accounts-bulk-app-switch) > p { margin: 0 0 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-repair, .accounts-oauth-app-switch, .accounts-bulk-app-switch) label:where(:not(:has(input[type="checkbox"])):not(:has(input[type="radio"]))) {
  display: flex; flex-direction: column; min-width: 0; gap: 6px; margin: 12px 0; color: var(--fg-muted); font-size: var(--wc-font-small, 12px); line-height: 1.4; font-weight: 600;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-repair, .accounts-oauth-app-switch, .accounts-bulk-app-switch) :is(select, input:not([type="checkbox"]):not([type="radio"])) {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 40px); padding: 8px 11px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-oauth-app-switch, .accounts-bulk-app-switch) select:not([multiple]):not([size]) { overflow: hidden; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-password-repair form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-password-repair form > label { margin: 0; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-password-repair form > :is(p, .accounts-password-actions, label:only-of-type) { grid-column: 1 / -1; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-password-repair form > p { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-actions, .accounts-oauth-app-actions, [data-bulk-app-footer]) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-actions, .accounts-oauth-app-actions, [data-bulk-app-footer]) > button { width: auto; min-width: 0; max-width: 100%; margin: 0; min-height: var(--wc-control-h, 40px); border-radius: var(--wc-radius, 9px); white-space: normal; overflow-wrap: anywhere; }
[data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-oauth-app-actions, [data-bulk-app-footer]) > p { flex-basis: 100%; margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-bulk-app-accounts {
  padding: 0; margin: 12px 0; list-style: none; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-bulk-app-accounts > li { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-bulk-app-accounts > li + li { border-top: 1px solid var(--border); }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-bulk-app-accounts label { display: flex; align-items: start; gap: 8px; min-height: var(--wc-control-h, 40px); margin: 0; padding: 10px 12px; cursor: pointer; }
[data-recued-webclient-shell] [data-recued-webclient-content] .accounts-bulk-app-accounts input[type="checkbox"] { flex: 0 0 auto; margin: 3px 0 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-credential-rotation { padding: 12px; gap: 6px; border-radius: var(--wc-radius, 9px); }
/* Recovery actions follow their explanation so long handoff labels do not
   squeeze the provider's correction into a narrow desktop column. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is([data-connection-credential-recovery], .connections-credential-correction, .connections-external-change) {
  display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; min-width: 0;
  padding: 12px; gap: 6px 12px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is([data-connection-credential-recovery], .connections-credential-correction, .connections-external-change) :is(.connections-credential-recovery-action, .connections-credential-correction-action, .connections-external-change-action) {
  grid-column: 1 / -1; grid-row: auto; display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 8px; min-width: 0; margin-top: 4px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is([data-connection-credential-recovery], .connections-credential-correction, .connections-external-change) .rx-btn {
  width: auto; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 40px); margin: 0;
  border-radius: var(--wc-radius, 9px); white-space: normal; overflow-wrap: anywhere;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-credential-closure-status { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-credential-admin-handoff { margin-top: 4px; padding-top: 8px; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-credential-admin-handoff > summary { min-height: var(--wc-control-h, 40px); line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-credential-admin-handoff-body { gap: 12px; padding: 4px 0 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .connections-credential-admin-handoff pre { padding: 12px; border-radius: var(--wc-radius, 9px); font-size: var(--wc-font-small, 12px); line-height: 1.5; }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is([data-connection-credential-recovery], .connections-credential-correction, .connections-external-change) :is(.connections-credential-recovery-action, .connections-credential-correction-action, .connections-external-change-action) {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch;
  }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is([data-connection-credential-recovery], .connections-credential-correction, .connections-external-change) :is(.connections-credential-recovery-action, .connections-credential-correction-action, .connections-external-change-action) { grid-template-columns: minmax(0, 1fr); }
}
[data-recued-webclient-shell] [data-recued-webclient-content] .source-sphere-choice span { box-sizing: border-box; min-height: calc(var(--wc-control-h, 40px) - 6px); }
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-repair, .accounts-oauth-app-switch, .accounts-bulk-app-switch) { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .accounts-password-repair form { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-actions, .accounts-oauth-app-actions, [data-bulk-app-footer]) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-oauth-app-actions, [data-bulk-app-footer]) > p { grid-column: 1 / -1; }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.accounts-password-actions, .accounts-oauth-app-actions, [data-bulk-app-footer]) { grid-template-columns: minmax(0, 1fr); }
}
/* Webhook setup and delivery readers use the same field and fact scale as
   the other Connections lanes. Keep their status colours and write gates. */
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] { min-width: 0; gap: 16px; font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-filters { display: grid; grid-template-columns: minmax(0, 2fr) minmax(180px, 1fr); gap: 16px; align-items: end; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] label { min-width: 0; gap: 6px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] :is(input:not([type="checkbox"]):not([type="radio"]), select, textarea) {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 40px);
  padding: 8px 11px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4;
}
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] select:not([multiple]):not([size]) { overflow: hidden; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] button {
  min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 40px); padding: 8px 12px; border-radius: var(--wc-radius, 9px); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere;
}
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] button.wh-primary { color: var(--on-accent); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] :is([data-recued-webhooks-form], [data-recued-webhooks-card]) { min-width: 0; padding: 16px; gap: 12px; border-radius: var(--wc-radius, 9px); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] [data-recued-webhooks-form] { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-form] > :not(label) { grid-column: 1 / -1; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-event-types { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; padding: 12px; border-radius: var(--wc-radius, 9px); min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-event-types > :not(label) { grid-column: 1 / -1; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-event-types label { min-height: var(--wc-control-h, 40px); padding: 6px 8px; font-size: 13px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-event-types label:has(input:checked) { background: color-mix(in srgb, var(--accent) 8%, var(--surface)); border-radius: var(--wc-radius, 9px); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-event-types input[type="checkbox"] { flex: 0 0 auto; margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-event-types .wh-event-custom label { padding: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] dl { grid-template-columns: 168px minmax(0, 1fr); gap: 8px 16px; font-size: 13px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] dt { font-size: var(--wc-font-small, 12px); font-weight: 600; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-card-head { min-width: 0; gap: 12px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-card-head h3 { min-width: 0; overflow-wrap: anywhere; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-strays] { display: grid; gap: 12px; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-strays] .wh-stray-group { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface-sunk); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-strays] :is(h4, p, .wh-actions) { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-strays] p { max-width: 90ch; overflow-wrap: anywhere; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-recipes] { display: grid; gap: 8px; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-recipes] h4 { margin: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-recipes] ul { display: grid; gap: 16px; margin: 0; padding-inline-start: 18px; }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-recipes] li > p { margin: 4px 0 8px; }
@media (max-width: 900px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-event-types { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] :is(.wh-filters, .wh-grid, [data-recued-webhooks-form]) { grid-template-columns: minmax(0, 1fr); }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] :is([data-recued-webhooks-form], [data-recued-webhooks-card]) { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] dl { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] dd:not(:last-child) { margin-bottom: 8px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-card-head { flex-direction: column; align-items: flex-start; gap: 8px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-actions > .wh-note { grid-column: 1 / -1; }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-actions > :is([data-recued-webhooks-action="deliveries"], [data-recued-webhooks-action="rejections"], [data-recued-webhooks-action="dead-letters"]) { grid-column: 1 / -1; }
}
@media (max-width: 480px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-event-types { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 360px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-webhooks-panel] .wh-actions { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 900px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-filter-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(.authentication-access, .authentication-history-filters, .authentication-history-file, .authentication-history-preview, .access-comparison) { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .bulk-authentication-access > article { padding: 12px; }
  [data-recued-webclient-shell] [data-recued-webclient-content] .authentication-history-filter-fields { grid-template-columns: minmax(0, 1fr); gap: 12px; }
}
/* A field's border, and on a field the border names mean the field edge.
   Components draw their fields with var(--border) or var(--border-strong),
   which everywhere else are meant to be quiet (1.2-1.5:1 on white);
   re-pointing the names on the field itself reaches every one of them.
   ⛔ The border sits here, at no specificity, not in the rule above: that
   rule's :not([type]) parts give it (0,4,1), which outranks a component's
   class rule — so an input's focus border and its error border (a rejected
   credential's red edge in Connections) never showed. */
:where([data-recued-webclient-content]) :where(
  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]),
  select, textarea
) {
  border: 1px solid var(--wc-field-edge);
  --border: var(--wc-field-edge);
  --border-strong: var(--wc-field-edge);
  --border-subtle: var(--wc-field-edge);
  --color-border: var(--wc-field-edge);
  --rx-divider: var(--wc-field-edge);
}
/* A field with no focus style of its own draws the app's ring instead of the
   browser's default one. */
:where([data-recued-webclient-content]) :where(input, select, textarea):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* WebKit's native popup selects discard min-height and padding. Give single
   choices the shared control height; leave listboxes and multiple selects
   free to show their rows. Route-specific heights still override this floor. */
:where([data-recued-webclient-content]) :where(
  select:not([multiple]):not([size]), select[size="1"]:not([multiple])
) {
  height: var(--wc-control-h);
}
:where([data-recued-webclient-content]) input::placeholder,
:where([data-recued-webclient-content]) textarea::placeholder {
  color: var(--fg-muted);
}

/* ════════════════════════════════════════════════════════════════
   2 · Unified named buttons (data / runs / recipes / automation)
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .wc-button, .data-button, .runs-button, .recipes-button, .automation-button
) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  min-height: var(--wc-control-h);
  padding: 0 var(--wc-pad-x);
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius);
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .wc-button, .data-button, .runs-button, .recipes-button, .automation-button
):hover:not(:disabled) {
  background: var(--surface-sunk);
  border-color: var(--border-strong);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .wc-button, .data-button, .runs-button, .recipes-button, .automation-button
):disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
/* User-authored labels can wrap inside a button; short action labels keep
   their natural width and wrap as whole controls. */
[data-recued-webclient-shell] [data-recued-webclient-content] .wc-button--wrap {
  white-space: normal;
  text-align: left;
}
/* Primary — solid accent, only the genuinely-primary action carries it. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-button--primary, .runs-button--primary, .recipes-button--primary, .automation-button--primary
) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-button--primary, .runs-button--primary, .recipes-button--primary, .automation-button--primary
):hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  filter: brightness(1.07);
}
/* Danger — ink + border by default (not a solid red field). */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-button--danger, .runs-button--danger, .recipes-button--danger, .automation-button--danger
) {
  background: var(--surface);
  border-color: var(--danger);
  color: var(--danger);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-button--danger, .runs-button--danger, .recipes-button--danger, .automation-button--danger
):hover:not(:disabled) {
  background: var(--danger-weak);
}

/* Align the shared primitive + the recipes bulk-pack buttons to the same
   metrics within the webclient (without touching the cross-surface
   primitive defaults the Bridge/dashboard rely on). */
[data-recued-webclient-shell] [data-recued-webclient-content] .rx-btn {
  border-radius: var(--wc-radius);
  min-height: var(--wc-control-h);
  font-weight: 600;
  transition: background-color 120ms ease, border-color 120ms ease;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .rx-btn-link {
  min-height: 0;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .bulk-pack-btn {
  min-height: var(--wc-control-h);
  border-radius: var(--wc-radius);
  font-size: 13px;
}

/* ════════════════════════════════════════════════════════════════
   3 · Unified text inputs / selects / textareas
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-input,
  .runs-input, .runs-select,
  .recipes-automation-input, .recipes-automation-select,
  .form-renderer-input, .form-renderer-select, .form-renderer-textarea,
  .work-entity-list-search-input, .work-entity-source-dropdown-select,
  .rx-input, .rx-select
) {
  box-sizing: border-box;
  font-family: inherit;
  font-size: 13px;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius);
  min-height: 40px;
  padding: 8px 11px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .form-renderer-textarea {
  min-height: 80px;
  resize: vertical;
}
/* Preserve the deliberately-monospace pattern/URL field. */
[data-recued-webclient-shell] [data-recued-webclient-content] .recipes-automation-input {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-input,
  .runs-input, .runs-select,
  .recipes-automation-input, .recipes-automation-select,
  .form-renderer-input, .form-renderer-select, .form-renderer-textarea,
  .work-entity-list-search-input, .work-entity-source-dropdown-select,
  .rx-input, .rx-select
)::placeholder {
  color: var(--fg-muted);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-input,
  .runs-input, .runs-select,
  .recipes-automation-input, .recipes-automation-select,
  .form-renderer-input, .form-renderer-select, .form-renderer-textarea,
  .work-entity-list-search-input, .work-entity-source-dropdown-select,
  .rx-input, .rx-select
):disabled {
  opacity: 0.6;
  cursor: not-allowed;
  background: var(--surface-sunk);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-input,
  .runs-input, .runs-select,
  .recipes-automation-input, .recipes-automation-select,
  .form-renderer-input, .form-renderer-select, .form-renderer-textarea,
  .work-entity-list-search-input, .work-entity-source-dropdown-select,
  .rx-input, .rx-select
):focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--wc-ring);
}
/* Checkbox / radio accent. */
[data-recued-webclient-shell] [data-recued-webclient-content] input:is([type="checkbox"], [type="radio"]) {
  accent-color: var(--accent);
}

/* ════════════════════════════════════════════════════════════════
   4 · One focus-visible ring for every interactive element
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  button, [role="button"], summary,
  .data-button, .runs-button, .recipes-button, .automation-button,
  .rx-btn, .bulk-pack-btn,
  .data-tab, .data-row-button, .data-timeline-row,
  .work-entity-list-row-button,
  .work-entity-page-create, .work-entity-dialog-submit, .work-entity-dialog-cancel
):focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--wc-ring);
}
/* Plain links + anchor-as-action surfaces get a crisp outline ring. */
[data-recued-webclient-shell] [data-recued-webclient-content] a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* ════════════════════════════════════════════════════════════════
   5 · Tabs — outlined active state (stop over-using accent fills)
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] .data-tab {
  min-height: 36px;
  border-radius: var(--wc-radius);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .data-tab[data-active="true"] {
  background: var(--surface);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

/* ════════════════════════════════════════════════════════════════
   6 · Floating panels — guarantee solid surface + border + shadow
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-dialog-panel, .work-entity-dialog, .recipes-modal-panel
) {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--wc-radius-lg);
  box-shadow: var(--wc-shadow-panel);
}
/* Nested form object/union + the install-grant picker were transparent —
   give them a clearly-bordered sunk panel (belt-and-suspenders with the
   --color-*-bg custom-property fix above). */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .form-renderer-object, .form-renderer-union-variant
) {
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  border-radius: var(--wc-radius);
}
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-install-grant-picker] {
  background: var(--surface-sunk);
  border-radius: var(--wc-radius);
}
/* Topbar approval popover lives outside CONTENT — anchor it to SHELL. */
[data-recued-webclient-shell] .webclient-attention-popover-frame {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius-lg);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
}

/* ════════════════════════════════════════════════════════════════
   7 · Card / row cohesion — quiet, stable interaction surfaces
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .recipe-card, .data-row-button, .data-timeline-row,
  .work-entity-list-row-button,
  [data-recued-runs-row], [data-recued-automation-row]
) {
  border-radius: var(--wc-radius);
  transition: border-color 120ms ease, background 120ms ease;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .recipe-card, .data-row-button, .work-entity-list-row-button,
  [data-recued-runs-row], [data-recued-automation-row]
):hover {
  border-color: var(--border-strong);
  background: var(--surface-sunk);
}
/* Keep an actionable row's accent affordance on hover. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .recipe-card, .work-entity-list-row-button
):hover {
  border-color: var(--accent);
}

/* Work records read as one list. Selection belongs to the entire row; Source
   names are quiet text while exceptional origin/sync badges keep their chips. */
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list {
  gap: 0;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius);
  background: var(--surface);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row {
  position: relative;
  border-bottom: 1px solid var(--border);
  transition: background-color 120ms ease;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row:first-child {
  border-top-left-radius: var(--wc-radius);
  border-top-right-radius: var(--wc-radius);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row:last-child {
  border-bottom: 0;
  border-bottom-left-radius: var(--wc-radius);
  border-bottom-right-radius: var(--wc-radius);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list .work-entity-list-row-button {
  border: 1px solid transparent;
  border-radius: 0;
  padding: 12px 16px;
  background: transparent;
  gap: 4px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row:has(.work-entity-list-row-button:hover) {
  background: var(--surface-sunk);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list .work-entity-list-row-button:hover {
  border-color: transparent;
  background: transparent;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row:has(.work-entity-task-select input:checked) {
  background: var(--accent-weak);
  box-shadow: inset 3px 0 var(--accent);
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row:has(.work-entity-task-select) {
  align-items: start;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row .work-entity-task-select {
  align-self: start;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row-button:focus-visible {
  position: relative;
  z-index: 1;
  border-radius: 6px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row-primary {
  font-weight: 600;
  line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row-secondary {
  line-height: 1.45;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row-source {
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: var(--fg-muted);
  font-weight: 400;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-source-dropdown-label {
  flex-shrink: 0;
  white-space: nowrap;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .work-entity-list-row-footer {
  column-gap: 12px;
  row-gap: 4px;
  line-height: 1.5;
}

/* ════════════════════════════════════════════════════════════════
   8 · Empty states — a quiet, intentional sunk panel (not bare text)
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  [data-recued-runs-empty], [data-recued-automation-empty], .work-entity-list-empty
) {
  display: block;
  padding: 22px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--wc-radius-lg);
  background: var(--surface-sunk);
  text-align: center;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.5;
}

/* ════════════════════════════════════════════════════════════════
   9 · Route headings + primary workspace panels
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .chat-route-title, .data-title, .recipes-title, .automation-title,
  .connections-route-title, .contracts-title, .packs-route-title, .logs-title,
  .mail-route-title, [data-recued-today-route] .today-header h2
) {
  font-size: var(--wc-font-title);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.025em;
}
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-route] > h1 {
  color: var(--fg);
  font-size: var(--wc-font-title);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.025em;
}
/* Keep Settings' narrower form column while sharing workspace insets and the
   setup-field scale. The rail keeps its intentional phone scroll strip. */
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-route] { padding: var(--wc-page-pad, 24px); gap: var(--wc-space-lg, 24px); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-route] .settings-shell { gap: var(--wc-space-lg, 24px); }
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-nav-item] { min-height: var(--wc-control-h, 40px); padding: 8px 10px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .settings-finder { gap: 8px; margin: 0; min-width: 0; }
[data-recued-webclient-shell] [data-recued-webclient-content] .settings-finder label { font-size: 12px; font-weight: 600; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .settings-finder input { box-sizing: border-box; min-width: 0; height: var(--wc-control-h, 40px); min-height: var(--wc-control-h, 40px); padding: 0 10px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.4; }
[data-recued-webclient-shell] [data-recued-webclient-content] .settings-finder p { font-size: 12px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .settings-finder button { min-width: 0; min-height: var(--wc-control-h, 40px); padding: 12px; border-radius: var(--wc-radius, 9px); font-size: 13px; line-height: 1.5; }
[data-recued-webclient-shell] [data-recued-webclient-content] .settings-finder button span { font-size: 12px; line-height: 1.5; }
@media (max-width: 720px) {
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-route] .settings-shell { gap: var(--wc-space-md, 16px); }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-nav-item] { min-height: 44px; }
}

/* The wide desktop frame aligns the workspace pages below.
   Settings keeps its existing 912px inner measure for the finder, rail and form. */
@media (min-width: 1280px) and (hover: hover) and (pointer: fine) {
  [data-recued-webclient-shell] [data-recued-webclient-content] :is(
    [data-recued-discovery-surface]:has(> [id="recued-recipes-library-installed-panel"]),
    [data-recued-settings-route],
    [data-recued-logs-route],
    [data-recued-packs-route],
    [data-recued-automation-route]
  ) {
    box-sizing: border-box;
    width: 100%;
    max-width: var(--wc-content-max, 1160px);
    margin-inline: auto;
    padding: var(--wc-page-pad, 24px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-discovery-surface]:has(> [id="recued-recipes-library-installed-panel"]) > :is(.discovery-tabbar, .discovery-back-to-chat) {
    margin: 0 0 var(--wc-space-md, 16px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-discovery-surface]:has(> [id="recued-recipes-library-installed-panel"]) :is([data-recued-recipes-route], [data-recued-discovery-discover]) {
    padding: 0;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-route] {
    display: grid;
    grid-template-columns: minmax(0, 912px);
  }
  /* WebKit can focus a native time field's segments without matching :focus-visible. */
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-route] input[type="time"]:focus:not(:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* The library's title and actions share a row. List content and read notices
     use the whole frame. Recipe detail keeps its own internal layout. */
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-recipes-route]:has(> .recipes-header + .recipes-actions) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    column-gap: var(--wc-space-lg, 24px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-recipes-route] > :not(.recipes-header, .recipes-actions) {
    grid-column: 1 / -1;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-recipes-route] > .recipes-header {
    grid-area: 1 / 1;
    margin: 0;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-recipes-route] > .recipes-actions {
    grid-area: 1 / 2;
    justify-content: flex-end;
    margin: 0 0 var(--wc-space-md, 16px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-recipes-route] > .recipes-actions > :is(button, a) {
    min-height: var(--wc-control-h, 40px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-recipes-route] > .recipes-actions > [data-recued-recipes-kitchen-link] {
    padding: 4px 12px;
    border-radius: var(--wc-radius, 9px);
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }

  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-logs-route] > .logs-page-header {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    align-items: center;
    gap: var(--wc-space-sm, 8px) var(--wc-space-md, 16px);
    margin-bottom: var(--wc-space-md, 16px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .logs-page-header > :is(.logs-header, .logs-intro, .logs-view-nav) {
    margin: 0;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .logs-page-header > .logs-view-nav {
    grid-area: 1 / 2;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .logs-page-header > .logs-intro {
    grid-area: 2 / 1 / 3 / -1;
  }

  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-packs-route] .packs-surface-add {
    margin-bottom: var(--wc-space-md, 16px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-packs-route] .packs-surface-add-submit {
    min-height: var(--wc-control-h, 40px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-packs-route] .packs-catalogue-toolbar {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    align-items: center;
    gap: var(--wc-space-sm, 8px);
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .packs-catalogue-toolbar > .packs-surface-installed-toggle {
    margin: 0;
    min-height: var(--wc-control-h, 40px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .packs-catalogue-toolbar > .discover-controls {
    grid-area: 1 / 2;
    padding: 0;
    border: 0;
    background: transparent;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .packs-catalogue-toolbar > [data-recued-packs-surface-installed-only-error] {
    grid-area: 2 / 1 / 3 / -1;
    margin: 0;
  }

  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-automation-route] > .automation-page-header {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--wc-space-sm, 8px) var(--wc-space-md, 16px);
    margin-bottom: var(--wc-space-md, 16px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-page-header :is(.automation-header, .automation-header > div) {
    display: contents;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-page-header .automation-title {
    grid-area: 1 / 1;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-page-header > .automation-subnav {
    grid-area: 1 / 2;
    justify-self: start;
    margin: 0;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-page-header .automation-subnav-tab {
    min-height: var(--wc-control-h, 40px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-page-header .automation-header > a {
    grid-area: 1 / 3;
    display: inline-flex;
    align-items: center;
    justify-self: end;
    min-height: var(--wc-control-h, 40px);
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius, 9px);
    background: var(--surface);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-page-header .automation-subtitle {
    grid-area: 2 / 1 / 3 / -1;
    margin: 0;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-page-header > .automation-lock-banner {
    grid-area: 3 / 1 / 4 / -1;
    margin: 0;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-automation-route] .automation-filter {
    gap: var(--wc-space-sm, 8px) var(--wc-space-md, 16px);
    margin: 0 0 var(--wc-space-md, 16px);
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius-lg, 12px);
    background: var(--surface);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-automation-route] .automation-filter > .ref-picker {
    min-width: 0;
    max-width: 520px;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-filter :is(.ref-picker-input, .automation-filter-select) {
    min-height: var(--wc-control-h, 40px);
  }
  [data-recued-webclient-shell] [data-recued-webclient-content] .automation-filter .automation-filter-select {
    inline-size: 160px;
    padding: 6px 10px;
  }
}

[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  [data-recued-chat-route-session-list],
  [data-recued-chat-route-thread],
  [data-recued-packs-panel]
) {
  border-radius: var(--wc-radius-lg);
}

/* ════════════════════════════════════════════════════════════════
   10 · One-shot recovery-intent orientation
   ════════════════════════════════════════════════════════════════ */
@keyframes recued-recovery-intent-arrive {
  from {
    outline-offset: 10px;
  }
  to {
    outline-offset: 4px;
  }
}
/* :focus is intentional: recovery focus is programmatic, and the extra
   pseudo-class also outranks the shell's generic :focus-visible reset. */
[data-recued-webclient-shell] [data-recued-webclient-content]
  [data-recued-recovery-intent-cue]:focus {
  --wc-recovery-intent-color: var(--accent);
  outline: 3px solid var(--wc-recovery-intent-color);
  outline-offset: 4px;
  animation: recued-recovery-intent-arrive 520ms ease-out 1;
}
[data-recued-recovery-intent-announcer] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
@media (forced-colors: active) {
  [data-recued-webclient-shell] [data-recued-webclient-content]
    [data-recued-recovery-intent-cue]:focus {
    --wc-recovery-intent-color: Highlight;
  }
}

/* ════════════════════════════════════════════════════════════════
   11 · Containment floor — nothing overflows its column
   ════════════════════════════════════════════════════════════════
   Every rule here is a PURE FLOOR at specificity 0,0,0 (:where()
   contributes nothing, * contributes nothing), so any route rule —
   however loosely written — still wins. These are defaults the app
   should always have had, not overrides.

   Written as one layer because the failure is one failure: a long
   unbreakable token (a contract id, a pack slug, an error payload, a
   220-char request id) forces a flex/grid child's min-content width
   past the viewport and the whole page scrolls sideways on a phone.
   Fixing that per-selector needs three declarations on every element
   in the chain from the token to the route root; fixing it here needs
   none, because the chain no longer has a weak link. */

/* Flex and grid children default to min-width: auto, which refuses to
   shrink below content — the single most common cause of a route pushing
   the page wider than the viewport. Block elements already compute 0, so
   this only changes flex/grid children: exactly the intended target. A
   site that genuinely needs intrinsic width declares min-width and wins. */
:where([data-recued-webclient-content]) * {
  min-width: 0;
}

/* Padding and border must never add to a declared width. */
:where([data-recued-webclient-content]) *,
:where([data-recued-webclient-content]) *::before,
:where([data-recued-webclient-content]) *::after {
  box-sizing: border-box;
}

/* anywhere rather than break-word: only anywhere also shrinks the
   element's intrinsic min-content width, which is what actually stops a
   flex parent from being pushed wide. Inherited, so one declaration on
   the content root reaches every descendant. */
:where([data-recued-webclient-content]) {
  overflow-wrap: anywhere;
}

/* Replaced content never exceeds its column. */
:where([data-recued-webclient-content]) :is(img, svg, video, canvas, iframe) {
  max-width: 100%;
}

/* ── The one exception: containers that are SUPPOSED to overflow ──────
   A horizontal scroll rail (a tab strip that scrolls the active section
   into view, a wide data table) needs its children to KEEP intrinsic
   width — that overflow is the feature, and scrollLeft is how the
   surface reveals the active item. The min-width floor above would
   shrink them to fit and silently delete the scroll.

   Every intentional rail owns the shared data-recued-scroll-rail marker.
   The marker is the review boundary: adding one means the local overflow
   is deliberate and keyboard/pointer users have a way to reveal it.

   Restoring min-width alone is NOT enough, and this is the subtle part:
   the overflow-wrap: anywhere floor drops an element's min-content width
   to roughly one character, so min-width: auto still resolves to almost
   nothing and the rail keeps collapsing. A scroll rail has to opt out of
   BOTH floors — rigid width and unbroken text — to overflow at all.

   The scope differs by rail shape: a tab strip needs its direct children
   rigid, while a scrolling table needs its cells rigid, because shrinking
   those lets a width: 100% table consume the overflow internally. */
:where([data-recued-webclient-content] [data-recued-scroll-rail]) {
  overflow-wrap: normal;
}
:where(
  [data-recued-webclient-content] [data-recued-scroll-rail] > *,
  [data-recued-webclient-content] [data-recued-scroll-rail] :is(table, th, td)
) {
  min-width: auto;
  overflow-wrap: normal;
}

/* Block-level preformatted text keeps its formatting and scrolls inside its
   own box rather than widening the page.

   INLINE code/kbd/samp deliberately do NOT get this treatment: they carry
   exactly the long unbreakable tokens this layer exists to contain (ref
   paths, ids, slugs) and they sit inside flowing prose, so they must break
   like any other text. Exempting them was measurably wrong — it was the
   sole cause of three Automation containment failures, where a
   data.connection.api.* ref in an inline code span forced a 245px row to
   1457px. Only pre gets the scroll-box treatment. */
:where([data-recued-webclient-content]) pre {
  max-width: 100%;
  overflow-wrap: normal;
  overflow-x: auto;
}

@media (max-width: 640px) {
  [data-recued-webclient-shell], [data-recued-webclient-overlay] {
    --wc-control-h: 44px;
    --wc-pad-x: 12px;
    --wc-page-pad: 16px;
  }
  /* Every text field and select is a finger's height on a phone. ⛔ The floor
     above held them at 40px, and its :not() chain outranks the 44px a route
     asks for (Yours does, on touch). */
  :where([data-recued-webclient-content]) input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]),
  :where([data-recued-webclient-content]) select,
  :where([data-recued-webclient-content]) textarea {
    min-height: var(--wc-control-h);
  }
  :where([data-recued-webclient-content]) select {
    min-width: var(--wc-control-h);
  }

  /* ── The phone floor, in pages and in what they open ──────────────────
     Every button, tab, select and text field is 44px tall, in a page or in
     a dialog the page opens. Dialogs attach to <body>, outside the content
     area, so the scope is the owner surface itself; the top bar is sized on
     its own and the drawer's rows keep 40px on purpose.
     Measured 2026-10-24 in the 330 states the e2e fixtures load and the 967
     their buttons open: 165 controls under 44px, mostly a route's own
     24-38px. This outranks a rule of up to three classes; a control that
     must stay smaller says so with a stronger one.
     ⛔ Height only. A min-width replaces a flex item's auto minimum, its
     label's width, which is what lets a scroll rail scroll: a width floor
     here shrank every tab in Settings' rail to 44px under its own label.
     Width is raised only where the control is an icon or a word as short
     as "All". */
  html[data-recued-owner-surface] :is(button, [role="button"], [role="tab"], select, input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="hidden"], [type="file"])):not([data-recued-webclient-topbar] *, [data-recued-webclient-drawer] *) {
    min-height: var(--wc-control-h, 44px);
  }
  html[data-recued-owner-surface] :is([data-recued-live-control-close], [data-recued-live-control-run-control], .work-entity-dialog-close, .logs-row-open, .ref-picker-clear, .memory-filter-chip, .recipes-chip, .connections-row-actions > .rx-btn) {
    min-width: 44px;
  }

  /* Links that act as buttons — never a link inside a sentence, which keeps
     the sentence's line (WCAG 2.5.5 exempts it). */
  html[data-recued-owner-surface] [data-recued-automation-route] :is(a:not(p a), .automation-row-title a),
  html[data-recued-owner-surface] [data-recued-recipes-route] .recipes-inline-link:not(p > .recipes-inline-link) {
    min-width: 44px;
    min-height: 44px;
  }
  html[data-recued-owner-surface] [data-recued-logs-route] :is(.logs-inline-link, .logs-row-links a, .logs-detail-meta a),
  html[data-recued-owner-surface] [data-recued-seller-page] :is([data-recued-seller-back], [data-recued-seller-collection-item-link]),
  html[data-recued-owner-surface] [data-recued-account-binding-panel] .account-bind-dashboard-inline,
  html[data-recued-owner-surface] .memory-row-run-link,
  html[data-recued-owner-surface] [data-recued-tool-call-link] {
    min-height: 44px;
  }
  html[data-recued-owner-surface] [data-recued-chat-route-mail-notice] a,
  html[data-recued-owner-surface] a.auth-management-history {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
  /* Yours' plain links sit as blocks in its pages, sections and cards. */
  html[data-recued-owner-surface] [data-recued-yours] :is(.yours-pages, .yours-content, .yours-section, .yours-card, .yours-change-preview) > a:not([class]) {
    display: flex;
    align-items: center;
    min-height: 44px;
  }
  html[data-recued-owner-surface] [data-recued-yours] :is(.yours-pages, .yours-actions) > a {
    min-width: 44px;
    justify-content: center;
  }
  html[data-recued-owner-surface] [data-recued-connections-route] .connections-tool-body .connections-broker-manager > .rx-btn {
    min-height: 44px;
  }

  /* Disclosure rows. A summary that keeps the browser's triangle stays a
     list item, so it grows by padding rather than by becoming a flex row. */
  html[data-recued-owner-surface] [data-recued-data-route] .data-sources-summary,
  html[data-recued-owner-surface] .records-explorer summary {
    min-height: 44px;
  }
  html[data-recued-owner-surface] [data-recued-webhooks-panel] details > summary,
  html[data-recued-owner-surface] [data-oauth-advanced-permissions] > summary {
    box-sizing: border-box;
    min-height: 44px;
    padding-block: 12px;
  }
  html[data-recued-owner-surface] [data-recued-chat-route-composer-more] > summary {
    width: 44px;
    height: 44px;
  }
  html[data-recued-owner-surface] [data-recued-chat-route-session-actions] > summary {
    width: 44px;
  }

  /* A checkbox's label is its target. */
  html[data-recued-owner-surface] [data-recued-exposure-panel] .exposure-cell-target {
    min-width: 44px;
    min-height: 44px;
  }
  html[data-recued-owner-surface] .hostnames-checkbox-label,
  html[data-recued-owner-surface] .oauth-help li label {
    min-height: 44px;
  }
  html[data-recued-owner-surface] label:has(> input[data-contact-privacy-mark]),
  html[data-recued-owner-surface] .run-modal-actions > label:has(> input[type="checkbox"]),
  html[data-recued-owner-surface] .form-renderer-row[data-form-row-inline="true"] > .form-renderer-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    margin-inline-end: 16px;
  }
}
/* ════════════════════════════════════════════════════════════════
   D-266 · The missed-run card — one panel above the Schedules list.
   Raised rather than sunk: it is the one thing on the page WAITING
   on the owner, and an empty-state's quiet dashed panel would read
   as "nothing here" for the opposite reason.
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] .missed-runs-card {
  display: block;
  margin: 0 0 18px;
  padding: 18px 20px;
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--accent);
  border-radius: var(--wc-radius-lg);
  background: var(--surface-raised, var(--surface-sunk));
}
[data-recued-webclient-shell] [data-recued-webclient-content] .missed-runs-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 680;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .missed-runs-window, .missed-runs-note
) {
  margin: 0 0 10px;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .missed-runs-entries {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .missed-runs-entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  line-height: 1.45;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .missed-runs-entry-actions, .missed-runs-actions
) {
  display: flex;
  gap: 8px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .missed-runs-entry-action {
  padding: 3px 10px;
  font-size: 12px;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .missed-runs-error {
  margin: 0 0 10px;
  color: var(--danger, #b42318);
  font-size: 12.5px;
}

@media (prefers-reduced-motion: reduce) {
  [data-recued-webclient-shell] *,
  [data-recued-webclient-shell] *::before,
  [data-recued-webclient-shell] *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
  [data-recued-webclient-shell] [data-recued-webclient-content]
    [data-recued-recovery-intent-cue]:focus {
    animation: none !important;
  }
}
`;

/** Inject the polish layer into `<head>` once. Idempotent — the marker
 *  attribute guards against a second insertion across route remounts. */
export const injectWebclientPolishStyles = (doc: Document): void => {
  if (doc.head.querySelector(`style[${WEBCLIENT_POLISH_STYLES_MARKER}]`) !== null) {
    return;
  }
  const style = doc.createElement('style');
  style.setAttribute(WEBCLIENT_POLISH_STYLES_MARKER, '');
  style.textContent = WEBCLIENT_POLISH_STYLES;
  doc.head.appendChild(style);
};
