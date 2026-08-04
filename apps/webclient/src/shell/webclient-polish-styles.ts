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
 *  The `--wc-*` custom properties below are defined on SHELL so they
 *  cascade to every surface inside the app but never leak to the Bridge /
 *  dashboard / marketplace (which link the same `tokens.css` but have no
 *  shell host). Editing one knob retunes every control at once. */

export const WEBCLIENT_POLISH_STYLES_MARKER = 'data-recued-webclient-polish';

export const WEBCLIENT_POLISH_STYLES = `
/* ── Webclient-local design knobs + transparent-panel source fix ──── */
[data-recued-webclient-shell] {
  --wc-radius: 9px;
  --wc-radius-lg: 14px;
  --wc-radius-pill: 999px;
  --wc-control-h: 38px;
  --wc-pad-x: 14px;
  --wc-gap: 14px;
  /* One content column width every workspace/list route shares so the
     column stops jumping (960/980/1040/1120) as you navigate. Each route
     reads it via max-width: var(--wc-content-max, 1080px). The dedicated
     Settings form page stays deliberately narrower (forms read poorly at
     full width); Kitchen is owned by another workstream. */
  --wc-content-max: 1160px;
  --wc-ring: 0 0 0 3px var(--accent-weak);
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
:where([data-recued-webclient-content]) input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]),
:where([data-recued-webclient-content]) select,
:where([data-recued-webclient-content]) textarea {
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
:where([data-recued-webclient-content]) textarea { resize: vertical; }
:where([data-recued-webclient-content]) input::placeholder,
:where([data-recued-webclient-content]) textarea::placeholder {
  color: var(--fg-subtle);
}

/* ════════════════════════════════════════════════════════════════
   2 · Unified named buttons (data / runs / recipes / automation)
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-button, .runs-button, .recipes-button, .automation-button
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
  transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-button, .runs-button, .recipes-button, .automation-button
):hover:not(:disabled) {
  background: var(--surface-sunk);
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .data-button, .runs-button, .recipes-button, .automation-button
):disabled {
  opacity: 0.55;
  cursor: not-allowed;
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
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
[data-recued-webclient-shell] [data-recued-webclient-content] .rx-btn:hover:not(:disabled):not([aria-disabled="true"]) {
  transform: translateY(-1px);
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
  color: var(--fg-subtle);
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
  min-height: 30px;
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
   7 · Card / row cohesion — consistent radius + hover lift
   ════════════════════════════════════════════════════════════════ */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .recipe-card, .data-row-button, .data-timeline-row,
  .work-entity-list-row-button,
  [data-recued-runs-row], [data-recued-automation-row]
) {
  border-radius: 12px;
  transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .recipe-card, .data-row-button, .work-entity-list-row-button,
  [data-recued-runs-row], [data-recued-automation-row]
):hover {
  border-color: var(--border-strong);
  background: var(--surface-sunk);
  box-shadow: 0 6px 18px rgba(24, 24, 27, 0.055);
  transform: translateY(-1px);
}
/* Keep an actionable row's accent affordance on hover. */
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  .recipe-card, .work-entity-list-row-button
):hover {
  border-color: var(--accent);
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
  .connections-route-title, .contracts-title, .packs-route-title, .logs-title
) {
  font-size: clamp(24px, 3vw, 29px);
  font-weight: 720;
  line-height: 1.15;
  letter-spacing: -0.025em;
}
[data-recued-webclient-shell] [data-recued-webclient-content] [data-recued-settings-route] > h1 {
  font-size: clamp(24px, 3vw, 29px);
  font-weight: 720;
  line-height: 1.15;
  letter-spacing: -0.025em;
}
[data-recued-webclient-shell] [data-recued-webclient-content] :is(
  [data-recued-chat-route-session-list],
  [data-recued-chat-route-thread],
  [data-recued-packs-panel]
) {
  border-radius: var(--wc-radius-lg);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.035);
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

@media (max-width: 640px) {
  [data-recued-webclient-shell] {
    --wc-control-h: 40px;
    --wc-pad-x: 12px;
  }
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
