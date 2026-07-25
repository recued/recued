/** D-149 P4 § A.5.1 — Reception static-asset bundle.
 *
 *  Reception serves a small closed-list of substrate-bundled assets at
 *  `/reception/_static/<asset>`:
 *
 *    - `style.css` — minimal stylesheet for the rendered reception_page
 *      surface. Substrate-controlled (Mary cannot override at v1) so
 *      the visitor surface is uniform across servers — no css-injection
 *      attack surface.
 *    - `favicon.ico` — generic 1×1 transparent ICO. Returned as a
 *      placeholder so visitor browsers don't trigger 404 spam.
 *    - `avatar/<sha256>` — RESERVED future path for user-uploaded
 *      avatars (per spec § A.5.1: "Avatar upload (handled via existing
 *      user profile substrate; just renders here)"). P4 declines to
 *      ship the upload path — the static-asset dispatcher returns 404
 *      for the avatar subtree until the user-profile substrate wires
 *      a backing store.
 *
 *  All other paths under `/reception/_static/` return 404 to avoid
 *  fingerprinting the substrate's asset inventory.
 *
 *  Path-traversal defense: the dispatcher rejects any path containing
 *  `..` segments OR with a `/` outside the asset-name leaf. The
 *  closed-list mapping is the source of truth — even if path traversal
 *  somehow constructed `style.css` via `../../../etc/passwd`, the
 *  dispatcher would still only serve the bundled bytes.
 *
 *  Spec: docs/d-149-spec.md § A.5.1 line 595 + § A.11 TR-8 + § Must
 *  Hold I-7. */

import { createHash } from 'node:crypto';

import { RECEPTION_PAGE_STATIC_PATH_PREFIX } from '@recued/contracts';

import { RECEPTION_DROP_UPLOADER_JS } from './drop-uploader-bundle.generated.js';

// ────────────────────────────────────────────────────────────────
// Bundled assets
// ────────────────────────────────────────────────────────────────

/** Small, audited visitor-surface stylesheet. No `@import`, remote fonts,
 *  scripts, or user-controlled CSS — every rendered surface uses this
 *  substrate-owned class list only. */
const RECEPTION_PAGE_STYLE_CSS = `:root {
  color-scheme: light;
  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-sunk: #f1f3f5;
  --fg: #18181b;
  --muted: #686872;
  --accent: #0e7490;
  --accent-strong: #155e75;
  --accent-weak: rgba(14, 116, 144, 0.10);
  --on-accent: #ffffff;
  --danger: #b42318;
  --danger-weak: rgba(180, 35, 24, 0.09);
  --border: #dedfe3;
  --border-strong: #c7c9cf;
  --focus: rgba(14, 116, 144, 0.22);
  --shadow: 0 24px 70px rgba(24, 24, 27, 0.10), 0 2px 8px rgba(24, 24, 27, 0.05);
}
* { box-sizing: border-box; }
html { min-width: 320px; }
body {
  margin: 0;
  min-height: 100vh;
  min-height: 100svh;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--fg);
  background:
    radial-gradient(circle at 12% 0%, var(--accent-weak), transparent 34rem),
    var(--bg);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.rcp-shell {
  width: min(100%, 760px);
  margin: 0 auto;
  padding: clamp(24px, 6vw, 64px) 24px;
}
.rcp-card {
  position: relative;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: clamp(24px, 5vw, 36px);
  box-shadow: var(--shadow);
}
.rcp-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: linear-gradient(90deg, var(--accent), transparent 72%);
}
.rcp-header {
  display: flex;
  gap: 18px;
  align-items: center;
  margin-bottom: 24px;
}
.rcp-avatar {
  width: 68px;
  height: 68px;
  border-radius: 18px;
  background: linear-gradient(145deg, var(--accent-weak), var(--surface-sunk));
  border: 1px solid var(--border);
  flex-shrink: 0;
  object-fit: cover;
}
.rcp-name {
  margin: 0;
  font-size: clamp(23px, 4vw, 30px);
  font-weight: 700;
  line-height: 1.18;
  letter-spacing: -0.025em;
}
.rcp-tagline {
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 15px;
  max-width: 58ch;
}
.rcp-section {
  margin-top: 24px;
  padding-top: 22px;
  border-top: 1px solid var(--border);
}
.rcp-section-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--muted);
  margin: 0 0 12px;
}
.rcp-methods {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.rcp-method-chip {
  display: inline-block;
  padding: 6px 11px;
  border-radius: 9999px;
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}
.rcp-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  margin: 6px 8px 0 0;
  padding: 10px 17px;
  background: var(--accent);
  color: var(--on-accent);
  text-decoration: none;
  border-radius: 11px;
  font-size: 14px;
  font-weight: 650;
  box-shadow: 0 6px 18px rgba(14, 116, 144, 0.18);
  transition: background-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
}
.rcp-cta:hover {
  background: var(--accent-strong);
  transform: translateY(-1px);
  box-shadow: 0 9px 24px rgba(14, 116, 144, 0.22);
}
.rcp-cta:focus-visible,
.rcp-link:focus-visible,
.rcp-button:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}
.rcp-link {
  display: flex;
  align-items: center;
  min-height: 42px;
  margin-top: 6px;
  padding: 9px 12px;
  color: var(--accent);
  text-decoration: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
  font-size: 14px;
  font-weight: 600;
}
.rcp-link:hover { border-color: var(--accent); }

/* D-207 slice 2 — the shared @recued/renderer block classes.
 *
 * NO BACKTICKS IN THIS FILE: the stylesheet is a TS template literal, and a
 * backtick anywhere in it — even inside a CSS comment — TERMINATES the literal
 * and the parse errors land far from the cause.
 *
 * These classes are emitted by @recued/renderer, not by this port's own
 * renderers, so they carry the renderer's vocabulary (.block, .link-button-*)
 * rather than rcp-*. That is the cost of ONE block renderer across the owner's
 * panel and the visitor's page, and it is the right cost: the alternative is a
 * second renderer per surface, which is how the link button's absolute-HTTPS
 * href fence ends up enforced in one place and forgotten in the other.
 *
 * Styled to match .rcp-link so the page looks unchanged. */
.link-button-link {
  display: flex;
  align-items: center;
  min-height: 42px;
  margin-top: 6px;
  padding: 9px 12px;
  color: var(--accent);
  text-decoration: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
  font-size: 14px;
  font-weight: 600;
}
.link-button-link:hover { border-color: var(--accent); }
.link-button-link:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}
.link-button-description {
  margin: 4px 2px 0;
  color: var(--muted);
  font-size: 12px;
}

/* D-207 slice 2 render mode — the remaining shared block kinds a paired
 * recipe's output.render can put on this page. Same vocabulary, same renderer
 * as the owner's Recipes panel; only the stylesheet differs. */
.block { margin-top: 10px; font-size: 14px; }
.block:first-child { margin-top: 0; }
.block-empty, .block-error { color: var(--muted); font-size: 13px; }
.text-block p { margin: 0; }
.summary-list, .copyable-content { margin: 0; }
.summary-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}
.summary-row dt { color: var(--muted); }
.summary-row dd { margin: 0; font-weight: 600; }
.value-critical { color: var(--danger); }
.value-warn { color: var(--accent-strong); }
.table-block table { width: 100%; border-collapse: collapse; }
.table-block th, .table-block td {
  padding: 7px 8px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.table-block th { color: var(--muted); font-weight: 600; }
.checklist-block ul { margin: 0; padding-left: 18px; }
.checklist-block li { padding: 3px 0; }
.ai-block, .copyable-block, .file-artifact-card {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.copyable-content pre {
  margin: 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.file-artifact-card h4 { margin: 0 0 6px; font-size: 14px; }
.file-artifact-card dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 10px;
  margin: 0;
  font-size: 13px;
}
.file-artifact-card dt { color: var(--muted); }
.file-artifact-card dd { margin: 0; word-break: break-all; }
.rcp-form {
  display: grid;
  gap: 18px;
  margin-top: 24px;
}
.rcp-field {
  display: grid;
  gap: 7px;
}
.rcp-field > label,
.rcp-duration-form > label,
.rcp-legend {
  color: var(--fg);
  font-size: 13px;
  font-weight: 650;
}
.rcp-field input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),
.rcp-field select,
.rcp-field textarea,
.rcp-duration-form select {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-sunk);
  color: var(--fg);
  font: inherit;
  font-size: 15px;
  line-height: 1.4;
  transition: border-color 150ms ease, box-shadow 150ms ease, background-color 150ms ease;
}
.rcp-field textarea {
  min-height: 108px;
  resize: vertical;
}
.rcp-field input::placeholder,
.rcp-field textarea::placeholder { color: var(--muted); opacity: 0.78; }
.rcp-field input:not([type="checkbox"]):not([type="radio"]):focus,
.rcp-field select:focus,
.rcp-field textarea:focus,
.rcp-duration-form select:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: 0 0 0 3px var(--focus);
}
.rcp-field input[readonly] { color: var(--muted); cursor: not-allowed; }
.rcp-field input[type="file"] { padding: 7px; }
.rcp-field input[type="file"]::file-selector-button {
  margin-right: 10px;
  padding: 7px 10px;
  border: 0;
  border-radius: 7px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.rcp-field-check {
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.rcp-field-check input,
.rcp-option input {
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.rcp-field-disabled {
  padding: 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.rcp-meta,
.rcp-context,
.rcp-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.rcp-context {
  margin-bottom: 18px;
  padding: 12px 14px;
  border-left: 3px solid var(--accent);
  border-radius: 0 9px 9px 0;
  background: var(--accent-weak);
  color: var(--fg);
}
.rcp-required { color: var(--danger); }
.rcp-fieldset {
  min-width: 0;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-sunk);
}
.rcp-legend { padding: 0 5px; }
.rcp-option {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 2px 10px;
  align-items: start;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  cursor: pointer;
}
.rcp-option + .rcp-option { margin-top: 4px; }
.rcp-option:hover { border-color: var(--border); background: var(--surface); }
.rcp-option-label { font-size: 14px; font-weight: 650; }
.rcp-option-desc {
  grid-column: 2;
  color: var(--muted);
  font-size: 12px;
}
.rcp-duration-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 7px 10px;
  align-items: end;
  margin: 18px 0 4px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-sunk);
}
.rcp-duration-form > label { grid-column: 1 / -1; }
.rcp-button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 14px;
  font-weight: 650;
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease, transform 150ms ease;
}
.rcp-button:hover { border-color: var(--accent); transform: translateY(-1px); }
.rcp-button-primary {
  width: 100%;
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  box-shadow: 0 6px 18px rgba(14, 116, 144, 0.16);
}
.rcp-button-primary:hover { background: var(--accent-strong); }
.rcp-honeypot {
  position: absolute !important;
  left: -10000px !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
}
.rcp-footer {
  margin-top: 28px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}
.rcp-trust-footer {
  margin: 0 0 8px 0;
  color: var(--fg);
  font-size: 13px;
}
.rcp-placeholder {
  margin: 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
  color: var(--muted);
  font-size: 14px;
}
.rcp-receipt {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-sunk);
}
.rcp-receipt-ref {
  margin: 0 0 4px 0;
  font-size: 14px;
}
.rcp-receipt-ref code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 7px;
  font-size: 13px;
}
.rcp-receipt-meta {
  margin: 0 0 10px 0;
  color: var(--muted);
  font-size: 13px;
}
.rcp-receipt-fields {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  font-size: 14px;
}
.rcp-receipt-fields dt {
  color: var(--muted);
  font-weight: 600;
}
.rcp-receipt-fields dd {
  margin: 0;
  word-break: break-word;
}
.rcp-status-body {
  display: grid;
  gap: 10px;
  margin-top: 20px;
}
.rcp-status-title {
  margin: 0 0 2px;
  font-size: 17px;
  line-height: 1.35;
}
.rcp-status-row {
  display: grid;
  grid-template-columns: minmax(110px, 0.35fr) minmax(0, 1fr);
  gap: 14px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.rcp-status-label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rcp-status-value { min-width: 0; word-break: break-word; }
.rcp-status-list { margin: 0; padding-left: 18px; }
.rcp-status-item + .rcp-status-item { margin-top: 5px; }
.rcp-status-leg,
.rcp-status-leg-meta { display: block; }
.rcp-status-leg-meta { color: var(--muted); font-size: 12px; }
.rcp-status-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.rcp-tag {
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 12px;
  font-weight: 650;
}
.rcp-upload-progress {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.rcp-upload-bar {
  height: 7px;
  border-radius: 9999px;
  background: var(--border);
  overflow: hidden;
}
.rcp-upload-bar-fill {
  height: 100%;
  width: 0;
  background: var(--accent);
  transition: width 0.2s ease;
}
.rcp-upload-progress[data-state="error"] .rcp-upload-bar { display: none; }
.rcp-upload-status {
  margin: 8px 0 0 0;
  color: var(--muted);
  font-size: 14px;
}
.rcp-upload-progress[data-state="error"] .rcp-upload-status { color: var(--danger); }
.rcp-form[data-uploading] { opacity: 0.6; }
@media (max-width: 600px) {
  .rcp-shell { padding: 16px 12px 24px; }
  .rcp-card { padding: 22px 18px; border-radius: 16px; }
  .rcp-header { align-items: flex-start; gap: 13px; margin-bottom: 20px; }
  .rcp-avatar { width: 54px; height: 54px; border-radius: 15px; }
  .rcp-name { font-size: 23px; }
  .rcp-tagline { font-size: 14px; }
  .rcp-cta { width: 100%; margin-right: 0; }
  .rcp-duration-form { grid-template-columns: 1fr; }
  .rcp-duration-form > label { grid-column: auto; }
  .rcp-duration-form .rcp-button { width: 100%; }
  .rcp-status-row { grid-template-columns: 1fr; gap: 4px; }
  .rcp-receipt-fields { grid-template-columns: 1fr; gap: 2px; }
  .rcp-receipt-fields dd + dt { margin-top: 6px; }
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #09090b;
    --surface: #18181b;
    --surface-sunk: #222226;
    --fg: #f4f4f5;
    --muted: #a1a1aa;
    --accent: #22b8cf;
    --accent-strong: #3bc6da;
    --accent-weak: rgba(34, 184, 207, 0.13);
    --on-accent: #071417;
    --danger: #fb7185;
    --danger-weak: rgba(251, 113, 133, 0.12);
    --border: #303036;
    --border-strong: #45454d;
    --focus: rgba(34, 184, 207, 0.26);
    --shadow: 0 24px 70px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.28);
  }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
`;

/** Generic 1×1 transparent ICO. Pre-encoded so the static-asset
 *  dispatcher doesn't have to runtime-encode. Reduces 404 noise from
 *  visitor browsers that auto-fetch `/favicon.ico` on page load — the
 *  reception_page renders `<link rel="icon" href="/reception/_static/favicon.ico">`
 *  to direct the lookup. */
const RECEPTION_PAGE_FAVICON_BASE64 =
  'AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAQAQAAAAAAAAAAAAAAAAAAAAAAAAA' +
  // 16x16 transparent ICO. The exact bytes here aren't important — every
  // pixel is fully transparent — but the substrate ships a single
  // canonical favicon so visitor browsers see the same icon on every
  // server.
  'AAAAAAAA';

const RECEPTION_PAGE_FAVICON_BYTES = Buffer.from(RECEPTION_PAGE_FAVICON_BASE64, 'base64');

// ────────────────────────────────────────────────────────────────
// Closed-list asset map
// ────────────────────────────────────────────────────────────────

interface ReceptionStaticAsset {
  readonly content_type: string;
  readonly bytes: Buffer;
  readonly cache_control: string;
}

/** D-172 step 5b/5c — the reception drop-link resumable uploader bundle (one
 *  self-contained IIFE, built by `scripts/build-reception-uploader.mjs`). Served
 *  under the drop page's per-render nonce'd CSP + SRI. The SRI + cache-bust token
 *  are computed HERE, over the exact bytes served, so the page's
 *  `integrity=sha384-…` can never drift from the served file (no build-time hash
 *  to inject). The `?v=` cache-bust makes the URL content-addressed, so a server
 *  upgrade that changes the bundle never serves a stale cached copy against the
 *  new page's SRI. */
const RECEPTION_DROP_UPLOADER_BYTES = Buffer.from(RECEPTION_DROP_UPLOADER_JS, 'utf8');

/** `sha384-<base64>` over the served bytes — the page's `<script integrity=…>`. */
export const RECEPTION_DROP_UPLOADER_SRI = `sha384-${createHash('sha384')
  .update(RECEPTION_DROP_UPLOADER_BYTES)
  .digest('base64')}`;

/** Content-addressed `src` for the uploader `<script>` (the `?v=` busts caches on
 *  a bundle change; the static dispatcher matches on the path, ignoring the
 *  query, so the asset key stays `drop-uploader.js`). */
export const RECEPTION_DROP_UPLOADER_SRC = `${RECEPTION_PAGE_STATIC_PATH_PREFIX}drop-uploader.js?v=${createHash(
  'sha256',
)
  .update(RECEPTION_DROP_UPLOADER_BYTES)
  .digest('hex')
  .slice(0, 12)}`;

const RECEPTION_STATIC_ASSETS: Readonly<Record<string, ReceptionStaticAsset>> = {
  'style.css': {
    content_type: 'text/css; charset=utf-8',
    bytes: Buffer.from(RECEPTION_PAGE_STYLE_CSS, 'utf8'),
    // Substrate-bundled — version-pinned with the server binary. 24h
    // cache is conservative; visitors who upgrade their server pick
    // up the new CSS on the next day.
    cache_control: 'public, max-age=86400, immutable',
  },
  'favicon.ico': {
    content_type: 'image/x-icon',
    bytes: RECEPTION_PAGE_FAVICON_BYTES,
    cache_control: 'public, max-age=86400, immutable',
  },
  // D-172 — the resumable uploader. `immutable` is safe because the page
  // references it by the content-addressed `?v=` src (a changed bundle → a new
  // URL → a fresh fetch that matches the new SRI).
  'drop-uploader.js': {
    content_type: 'text/javascript; charset=utf-8',
    bytes: RECEPTION_DROP_UPLOADER_BYTES,
    cache_control: 'public, max-age=86400, immutable',
  },
};

const RECEPTION_STATIC_ASSET_KEYS: ReadonlySet<string> = new Set(
  Object.keys(RECEPTION_STATIC_ASSETS),
);

// ────────────────────────────────────────────────────────────────
// Path-traversal-safe dispatcher
// ────────────────────────────────────────────────────────────────

/** Returns the asset (if any) at the given pathname. `null` ⇒ the
 *  caller should 404. Path-traversal defense:
 *
 *    - Pathname MUST start with `RECEPTION_PAGE_STATIC_PATH_PREFIX`
 *      (`/reception/_static/`).
 *    - Suffix after the prefix MUST be a single segment (no nested
 *      paths; no `/` separators).
 *    - Suffix MUST NOT contain `..` (defense in depth — `URL` already
 *      normalizes, but the substrate doesn't trust the upstream
 *      dispatcher to have run it).
 *    - Suffix MUST be a member of `RECEPTION_STATIC_ASSET_KEYS`.
 *
 *  The closed-list membership check is the load-bearing gate — even
 *  if every other defense fails, the dispatcher only serves bytes
 *  whose key the substrate explicitly bundled. */
export const lookupReceptionStaticAsset = (
  pathname: string,
): ReceptionStaticAsset | null => {
  if (!pathname.startsWith(RECEPTION_PAGE_STATIC_PATH_PREFIX)) return null;
  const tail = pathname.slice(RECEPTION_PAGE_STATIC_PATH_PREFIX.length);
  if (tail.length === 0) return null;
  if (tail.includes('/')) return null;
  if (tail.includes('..')) return null;
  if (!RECEPTION_STATIC_ASSET_KEYS.has(tail)) return null;
  return RECEPTION_STATIC_ASSETS[tail] ?? null;
};

/** Exposed for ratchet tests — asserts the closed-list of asset keys
 *  stays scoped to the substrate's intended surface (every key must
 *  match `^[a-z0-9._-]+$`; no nested paths). */
export const RECEPTION_STATIC_ASSET_KEY_LIST: ReadonlyArray<string> = Object.freeze([
  ...RECEPTION_STATIC_ASSET_KEYS,
]);
