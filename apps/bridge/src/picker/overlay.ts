/** "Watch this element" picker — in-page overlay (brick 2).
 *
 *  Injected into the active tab's isolated world (brick 3 does the
 *  `chrome.scripting.executeScript` call). The overlay lets the user:
 *    1. hover the page — the element under the cursor is outlined;
 *    2. click — that element is selected and a stable CSS selector is
 *       derived (selector-engine.ts);
 *    3. review/edit the selector in a small panel with a LIVE preview
 *       (match count + a text sample, mirroring the `read_dom` action);
 *    4. Confirm → the result is handed to `onResult`; Cancel/Escape →
 *       a `cancelled` result.
 *
 *  Selector stability is the engine's job; the overlay keeps the field
 *  fully editable so the user can relax / tighten the selector and watch
 *  the match count react. This module is the live-DOM binder (it touches
 *  `document` directly); the testable logic lives in selector-engine.ts +
 *  preview.ts. */

import { THEME_TOKENS_CSS } from '@recued/ui-shared/theme';
import {
  deriveSelector,
  elementViewFromDom,
  type MatchCountProbe,
} from './selector-engine.js';
import { previewSelector, type PreviewProbes, type SelectorPreview } from './preview.js';
import { isUsablePickedSelector, type PickerResult } from './picker-protocol.js';
import { readPageField } from '../actions/page-fields.js';

/** Stable DOM id of the overlay root — also the double-injection guard. */
export const PICKER_OVERLAY_ROOT_ID = '__recued-element-picker';

const Z_TOP = '2147483647';

/**
 * The picker runs inside arbitrary pages, so linking the extension token
 * stylesheet would let the host page's cascade interfere with it. Keep the
 * canonical webclient tokens in a closed shadow root instead: one accent,
 * one danger, 9/14px geometry, and the same control/focus treatment as the
 * extension-owned popup and side panel. The three selector substitutions
 * adapt the generated `:root` token sheet to a shadow host without copying
 * its light/dark values into this surface.
 */
const PICKER_SHADOW_TOKENS = THEME_TOKENS_CSS
  .replaceAll(':root[data-theme="dark"]', ':host([data-theme="dark"])')
  .replaceAll(':root:not([data-theme])', ':host(:not([data-theme]))')
  .replaceAll(':root {', ':host {');

const PICKER_STYLES = `${PICKER_SHADOW_TOKENS}
  :host {
    --picker-surface: var(--surface);
    --picker-surface-sunk: var(--surface-sunk);
    --picker-border: var(--border);
    --picker-border-strong: var(--border-strong);
    --picker-fg-muted: var(--fg-muted);
    --picker-fg: var(--fg);
    --picker-fg-strong: var(--fg-strong);
    --picker-accent: var(--accent);
    --picker-accent-weak: var(--accent-weak);
    --picker-danger: var(--danger);
    --picker-on-accent: var(--on-accent);
    all: initial !important;
    position: fixed !important;
    z-index: ${Z_TOP} !important;
    top: 0 !important;
    left: 0 !important;
    width: 0 !important;
    height: 0 !important;
    display: block !important;
    pointer-events: none !important;
    color-scheme: light !important;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  .highlight {
    position: fixed;
    display: none;
    border: 2px solid var(--picker-accent);
    border-radius: 4px;
    background: var(--picker-accent-weak);
    pointer-events: none;
    transition: left 40ms ease-out, top 40ms ease-out, width 40ms ease-out,
      height 40ms ease-out;
  }

  .panel {
    position: fixed;
    right: 16px;
    bottom: 16px;
    width: 380px;
    max-width: calc(100vw - 32px);
    padding: 16px;
    border: 1px solid var(--picker-border);
    border-radius: 14px;
    background: var(--picker-surface);
    box-shadow: 0 18px 50px rgba(24, 24, 27, 0.22),
      0 2px 8px rgba(24, 24, 27, 0.08);
    color: var(--picker-fg);
    font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system,
      BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    pointer-events: auto;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 5px;
    color: var(--picker-fg-strong);
    font-size: 16px;
    font-weight: 750;
    letter-spacing: -0.025em;
    line-height: 1.2;
  }

  .title::before {
    width: 10px;
    height: 10px;
    flex: none;
    border-radius: 4px;
    background: var(--picker-accent);
    box-shadow: 0 0 0 5px var(--picker-accent-weak);
    content: "";
  }

  .hint {
    margin: 0 0 14px 20px;
    color: var(--picker-fg-muted);
    font-size: 12px;
  }

  .label {
    display: block;
    margin: 0 0 6px;
    color: var(--picker-fg);
    font-size: 12px;
    font-weight: 650;
  }

  .selector {
    display: block;
    width: 100%;
    min-height: 66px;
    padding: 10px 11px;
    resize: vertical;
    border: 1px solid var(--picker-border-strong);
    border-radius: 9px;
    outline: 0;
    background: var(--picker-surface-sunk);
    color: var(--picker-fg-strong);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      monospace;
  }

  .selector::placeholder {
    color: var(--picker-fg-muted);
  }

  .selector:hover {
    border-color: var(--picker-fg-muted);
  }

  .selector:focus-visible {
    border-color: var(--picker-accent);
    box-shadow: 0 0 0 3px var(--picker-accent-weak);
  }

  .preview {
    min-height: 44px;
    margin: 10px 0 14px;
    padding: 9px 10px;
    border: 1px solid var(--picker-border);
    border-radius: 9px;
    background: var(--picker-surface-sunk);
    color: var(--picker-fg-muted);
    font-size: 12px;
  }

  .preview-summary {
    color: var(--picker-fg);
    font-weight: 650;
  }

  .preview-summary[data-tone="accent"] {
    color: var(--picker-accent);
  }

  .preview-summary[data-tone="danger"] {
    color: var(--picker-danger);
  }

  .preview-guidance,
  .preview-sample {
    color: var(--picker-fg-muted);
  }

  .preview-sample {
    margin-top: 4px;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .button {
    min-width: 82px;
    min-height: 38px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: 9px;
    outline: 0;
    font: 650 13px/1 Inter, ui-sans-serif, system-ui, -apple-system,
      BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
  }

  .button:focus-visible {
    box-shadow: 0 0 0 3px var(--picker-accent-weak);
  }

  .button-secondary {
    border-color: var(--picker-border-strong);
    background: var(--picker-surface);
    color: var(--picker-fg);
  }

  .button-secondary:hover {
    border-color: var(--picker-fg-muted);
    background: var(--picker-surface-sunk);
  }

  .button-primary {
    background: var(--picker-accent);
    color: var(--picker-on-accent);
  }

  .button-primary:hover:not(:disabled) {
    filter: brightness(0.94);
  }

  .button:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  @media (max-width: 440px) {
    .panel {
      right: 10px;
      bottom: 10px;
      left: 10px;
      width: auto;
      max-width: none;
    }

    .button {
      flex: 1;
    }
  }

  @media (prefers-color-scheme: dark) {
    :host(:not([data-theme])) {
      color-scheme: dark !important;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .highlight {
      transition: none;
    }
  }
`;

export interface PickerOverlayHandle {
  /** Tear down the overlay (remove DOM, detach listeners). Idempotent. */
  destroy(): void;
}

export interface StartPickerOverlayOptions {
  /** The document to operate on. Defaults to the ambient `document`. */
  doc?: Document;
  /** Called exactly once, with the user's outcome. The overlay tears
   *  itself down immediately before/around invoking this. */
  onResult: (result: PickerResult) => void;
}

type Mode = 'hovering' | 'selected';

/** Build the live `document`-backed probes the engine + preview use. A
 *  syntactically-invalid selector (the user is mid-edit) yields `-1`
 *  rather than throwing. */
const domProbes = (doc: Document): PreviewProbes & { matchCount: MatchCountProbe } => {
  const count = (selector: string): number => {
    try {
      return doc.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  };
  // The same read the watch's `read_dom` runs, so a picked form field previews
  // its value, and a protected field previews nothing, as the watch will see.
  const readText = (selector: string): string | null => {
    try {
      const answer = readPageField(selector, undefined, doc);
      return 'outputs' in answer && typeof answer.outputs.text === 'string' ? answer.outputs.text : null;
    } catch {
      return null;
    }
  };
  return { count, readText, matchCount: count };
};

/** Start the element picker overlay. Returns a handle whose `destroy()`
 *  removes it; `onResult` also tears it down, so a typical caller never
 *  needs `destroy()` unless it wants to abort externally. */
export const startPickerOverlay = (options: StartPickerOverlayOptions): PickerOverlayHandle => {
  const doc = options.doc ?? document;
  const probes = domProbes(doc);

  // Double-injection guard: if a prior overlay is still mounted, remove it
  // so we never stack two pickers.
  doc.getElementById(PICKER_OVERLAY_ROOT_ID)?.remove();

  let mode: Mode = 'hovering';
  let settled = false;

  // ── DOM scaffold ─────────────────────────────────────────────────────
  const root = doc.createElement('div');
  root.id = PICKER_OVERLAY_ROOT_ID;
  const shadow = root.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = PICKER_STYLES;
  shadow.appendChild(style);

  const highlight = doc.createElement('div');
  highlight.className = 'highlight';
  shadow.appendChild(highlight);

  const panel = doc.createElement('section');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', '__recued-picker-title');
  panel.setAttribute('aria-describedby', '__recued-picker-hint');
  shadow.appendChild(panel);

  const title = doc.createElement('h2');
  title.id = '__recued-picker-title';
  title.className = 'title';
  title.textContent = 'Watch this element';
  panel.appendChild(title);

  const hint = doc.createElement('p');
  hint.id = '__recued-picker-hint';
  hint.className = 'hint';
  hint.textContent = 'Hover the page and click the element to watch.';
  panel.appendChild(hint);

  const label = doc.createElement('label');
  label.className = 'label';
  label.htmlFor = '__recued-picker-selector';
  label.textContent = 'CSS selector';
  panel.appendChild(label);

  const input = doc.createElement('textarea');
  input.id = '__recued-picker-selector';
  input.className = 'selector';
  input.rows = 2;
  input.spellcheck = false;
  input.autocapitalize = 'none';
  input.autocomplete = 'off';
  input.placeholder = 'Click an element…';
  input.setAttribute('aria-describedby', '__recued-picker-preview');
  panel.appendChild(input);

  const preview = doc.createElement('div');
  preview.id = '__recued-picker-preview';
  preview.className = 'preview';
  preview.setAttribute('role', 'status');
  preview.setAttribute('aria-live', 'polite');
  preview.textContent = 'Choose an element to preview its selector.';
  panel.appendChild(preview);

  const buttons = doc.createElement('div');
  buttons.className = 'actions';
  panel.appendChild(buttons);

  const mkButton = (text: string, className: string): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.className = `button ${className}`;
    return b;
  };
  const cancelBtn = mkButton('Cancel', 'button-secondary');
  const confirmBtn = mkButton('Watch', 'button-primary');
  confirmBtn.disabled = true;
  buttons.appendChild(cancelBtn);
  buttons.appendChild(confirmBtn);

  // ── rendering ────────────────────────────────────────────────────────
  const positionHighlight = (el: Element | null): void => {
    if (el === null) {
      highlight.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = `${r.left}px`;
    highlight.style.top = `${r.top}px`;
    highlight.style.width = `${r.width}px`;
    highlight.style.height = `${r.height}px`;
  };

  const renderPreview = (p: SelectorPreview): void => {
    const summary = doc.createElement('span');
    summary.className = 'preview-summary';
    summary.dataset.tone = p.count < 0 ? 'danger' : p.ok ? 'accent' : 'neutral';
    summary.textContent = p.summary;

    const children: Node[] = [summary];
    if (p.count > 1) {
      const guidance = doc.createElement('span');
      guidance.className = 'preview-guidance';
      guidance.textContent = ' — tighten the selector to one element';
      children.push(guidance);
    }
    if (p.sample !== null) {
      const sample = doc.createElement('div');
      sample.className = 'preview-sample';
      sample.textContent = `“${p.sample}”`;
      children.push(sample);
    }
    preview.replaceChildren(...children);
  };

  // Re-preview from the field's current value; move the highlight to the
  // first match so editing the selector is visually anchored.
  const refreshFromField = (): void => {
    const selector = input.value;
    const p = previewSelector(probes, selector);
    renderPreview(p);
    confirmBtn.disabled = !isUsablePickedSelector(selector) || p.count <= 0;
    if (p.count > 0) {
      try {
        positionHighlight(doc.querySelector(selector.trim()));
      } catch {
        positionHighlight(null);
      }
    } else {
      positionHighlight(null);
    }
  };

  const selectElement = (el: Element): void => {
    mode = 'selected';
    const derived = deriveSelector(elementViewFromDom(el), probes.matchCount);
    input.value = derived.selector;
    hint.textContent = 'Edit the selector if needed, then Watch. Click the page to pick again.';
    refreshFromField();
    input.focus({ preventScroll: true });
  };

  // ── teardown + outcome ───────────────────────────────────────────────
  const detach = (): void => {
    doc.removeEventListener('mousemove', onMouseMove, true);
    doc.removeEventListener('click', onClickCapture, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    root.remove();
  };
  const destroy = (): void => {
    if (settled) return;
    settled = true;
    detach();
  };
  const settle = (result: PickerResult): void => {
    if (settled) return;
    settled = true;
    detach();
    options.onResult(result);
  };

  // A torn-down-but-not-detached instance (its root was removed by a newer
  // injection while its document listeners still linger) self-heals on its
  // next event: it detaches itself and returns BEFORE suppressing the event,
  // so it can't keep eating page clicks or `stopImmediatePropagation` the
  // fresh picker's listener (codex LOW fold).
  const isStale = (): boolean => {
    if (root.isConnected) return false;
    detach();
    return true;
  };

  // ── listeners (capture phase, so the page never sees the pick click) ──
  function onMouseMove(e: MouseEvent): void {
    if (isStale() || mode !== 'hovering') return;
    const target = e.target as Node | null;
    if (target === null || root.contains(target)) return;
    positionHighlight(target as Element);
  }

  function onClickCapture(e: MouseEvent): void {
    if (isStale()) return;
    // Ignore synthetic (page-dispatched) clicks — only a real user gesture
    // drives the picker (codex HIGH fold: a page can forge events on our
    // in-DOM overlay, so never act on an untrusted one).
    if (!e.isTrusted) return;
    const target = e.target as Node | null;
    // Clicks inside our panel (typing, buttons) pass through untouched.
    if (target !== null && root.contains(target)) return;
    // Any other click is a pick — suppress the page's own handling.
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    if (target !== null) selectElement(target as Element);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isStale()) return;
    if (e.isTrusted && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      settle({ status: 'cancelled' });
    }
  }

  cancelBtn.addEventListener('click', (e) => {
    if (e.isTrusted) settle({ status: 'cancelled' });
  });
  confirmBtn.addEventListener('click', (e) => {
    // Trusted-gesture + selector-validity gate: a page-forged click must not
    // confirm a watch, and the user-editable field must not carry an empty
    // or `{{`-bearing selector into brick 3 (codex HIGH + MEDIUM folds).
    if (!e.isTrusted) return;
    const selector = input.value.trim();
    if (!isUsablePickedSelector(selector)) return;
    settle({
      status: 'picked',
      selector,
      page_url: doc.location.href,
      sample_text: probes.readText(selector),
    });
  });
  input.addEventListener('input', () => {
    // Manual edits move out of hover-pick mode so the cursor stops
    // re-highlighting under the mouse while the user types.
    mode = 'selected';
    refreshFromField();
  });

  doc.addEventListener('mousemove', onMouseMove, true);
  doc.addEventListener('click', onClickCapture, true);
  doc.addEventListener('keydown', onKeyDown, true);

  (doc.body ?? doc.documentElement).appendChild(root);

  return { destroy };
};
