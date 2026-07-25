import { IngredientError, type ResolvedCall } from './types.js';

/** Optional context — required when running outside a browser (e.g., tests).
 *  In production content-script execution, defaults to globalThis.document and globalThis.location.
 */
export interface DOMContext {
  document: Document;
  url: string;
}

/** Result shape for a DOM write call. */
export interface DOMWriteResult {
  /** Number of fields successfully written. */
  written: number;
  /** Field names that were written. */
  fields: string[];
  /** Field names that could not be written (missing selector, non-writable element, etc.). */
  failed: string[];
}

/** Output-value prefix that marks a DOM write target. The part after the
 *  prefix is the input field name whose value is written to the selector. */
const DOM_WRITE_PREFIX = 'dom.';
const DOM_CLICK = 'click';
const DOM_ENTER = 'enter';
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Execute a DOM ingredient call. Read, write, or mixed — determined by
 *  each individual output entry's value shape (NOT by manifest.category).
 *
 *  Each entry in `manifest.output` is classified by its VALUE:
 *  - `"trigger"` → the KEY is a URL pattern (not a selector). The current
 *    URL must match at least one trigger pattern, else DOM_PAGE_NOT_MATCHING
 *    is thrown. If no trigger entries exist, the ingredient runs on any URL.
 *  - Starts with `"dom."` → WRITE entry. The part after the prefix is the
 *    input field name. The executor reads `input[field]` and writes it into
 *    the element matched by the KEY (CSS selector). Element-type aware:
 *    input/textarea/select use `.value` + input+change events; contenteditable
 *    uses `textContent` + input event; anything else fails for that field.
 *  - Anything else → READ entry. The KEY is a CSS selector; the matched
 *    element's trimmed textContent is stored under the value as a field name.
 *    Field is null when no element matches.
 *
 *  Selector fallback chains (comma-separated):
 *  - Both read and write support comma-separated selectors for robustness
 *    across page-design rollouts.
 *  - Each sub-selector is tried in DECLARATION ORDER (not document order).
 *    The first sub-selector that returns any element wins; subsequent
 *    sub-selectors are not tried even if they would have matched.
 *  - This is NOT equivalent to `document.querySelector("a,b,c")` which
 *    returns the first match in document order across the union.
 *  - Commas inside brackets or parens don't split (e.g.
 *    `[data-foo="a,b"]` and `:nth-child(2n+1,4)` stay intact).
 *
 *  DESIGN STRATEGY — newest selector always goes first:
 *  - When a page ships a new design, PREPEND the new selector to the chain.
 *    Leave old ones behind as a safety net for users still on the old UI,
 *    A/B-rollout cohorts, or cached pages.
 *  - Declaration order should match expected match frequency: the happy
 *    path (current design) is tried first, legacy fallbacks come after.
 *  - On current pages this means ONE querySelector call, not N−1 misses.
 *  - Over time, old selectors can be dropped from the tail once telemetry
 *    confirms no users are on that design anymore.
 *
 *  Example (written for a HubSpot UI migration):
 *    "[data-id='subject'],[data-olddesign-id='subject'],#Subject"
 *    // ^^^^^^^^^^^^^^^^  current design — happy path
 *    //                   ^^^^^^^^^^^^^^^^^^^^^^^^ previous design — still supported
 *    //                                            ^^^^^^^^ legacy — rare safety net
 *
 *  (Plain read field names cannot contain dots — dots break
 *  `{{step.X.Y}}` resolution downstream — so the `dom.` prefix is an
 *  unambiguous discriminator.)
 *
 *  Read-only ingredients produce `Record<string, string | null>`.
 *  Write-only ingredients produce `DOMWriteResult`.
 *  Mixed ingredients produce `{ reads: Record<string,string|null>, writes: DOMWriteResult }`.
 *
 *  Missing write values (input[field] is null/undefined) are skipped without
 *  error so callers can supply partial updates. If the caller supplied at
 *  least one write value but every write target failed (page structure
 *  changed, selectors all miss), the executor throws DOM_WRITE_FAILED. */
export const executeDOM = async (
  resolved: ResolvedCall,
  ctx?: DOMContext,
): Promise<unknown> => {
  const { input, output, slug } = resolved;
  const domCtx = ctx ?? defaultContext(slug);

  const triggers: string[] = [];
  const reads: Array<{ selector: string; field: string }> = [];
  const writes: Array<{ selector: string; field: string }> = [];
  const clicks: Array<{ selector: string; action: 'click' | 'enter' }> = [];

  for (const [key, value] of Object.entries(output)) {
    if (value === 'trigger') {
      triggers.push(key);
    } else if (value === DOM_CLICK || value === DOM_ENTER) {
      clicks.push({ selector: key, action: value as 'click' | 'enter' });
    } else if (value.startsWith(DOM_WRITE_PREFIX)) {
      const field = value.slice(DOM_WRITE_PREFIX.length);
      if (field) writes.push({ selector: key, field });
    } else {
      if (PROTOTYPE_SENSITIVE_KEYS.has(value)) continue;
      reads.push({ selector: key, field: value });
    }
  }

  if (triggers.length > 0 && !triggers.some(p => matchUrl(domCtx.url, p))) {
    throw new IngredientError(
      'DOM_PAGE_NOT_MATCHING',
      `${slug} cannot run on ${domCtx.url} — no trigger pattern matches`,
    );
  }

  // Phase 1: reads — capture current state before any mutations
  const readResult: Record<string, string | null> = {};
  for (const { selector, field } of reads) {
    readResult[field] = readElement(domCtx.document, selector);
  }

  // Phase 2: writes — set form/contenteditable values
  let writeResult: DOMWriteResult | null = null;
  if (writes.length > 0) {
    writeResult = writeElements(slug, domCtx.document, writes, input);
  }

  // Phase 3: clicks — dispatch click events (after writes so values are set before send)
  let clickCount = 0;
  if (clicks.length > 0) {
    clickCount = clickElements(slug, domCtx.document, clicks);
  }

  // Return shape based on what was requested
  if (writes.length === 0 && clicks.length === 0) return readResult;
  if (reads.length === 0 && clicks.length === 0) return writeResult;
  if (reads.length === 0 && writes.length === 0) return { clicked: clickCount };

  return {
    ...(reads.length > 0 ? { reads: readResult } : {}),
    ...(writeResult ? { writes: writeResult } : {}),
    ...(clickCount > 0 ? { clicked: clickCount } : {}),
  };
};

/** Split a CSS selector string into individual selectors for declaration-order
 *  fallback evaluation. Only top-level commas (outside brackets and parens)
 *  are split points, so `[data-x="a,b"]` and `:nth-child(2n+1, 4)` stay intact.
 *
 *  Note on WHY this exists: `document.querySelector("[a],[b]")` groups both
 *  selectors and returns the first element in DOCUMENT ORDER that matches
 *  EITHER — not the first selector in declaration order. For a fallback chain
 *  ("old-design id first, then new-design id, then legacy id") we want
 *  declaration order: try each selector individually, use the first that
 *  returns any element. That's what this helper enables. */
const splitSelectors = (combined: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < combined.length; i++) {
    const c = combined[i];
    if (c === '[' || c === '(') {
      depth++;
      current += c;
      continue;
    }
    if (c === ']' || c === ')') {
      depth--;
      current += c;
      continue;
    }
    if (c === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      continue;
    }
    current += c;
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
};

/** Try each sub-selector in declaration order. Returns the first matching
 *  element (from the first sub-selector that returns one), or null if none
 *  match. Invalid sub-selectors are silently skipped so they don't poison
 *  the whole chain. */
const querySelectorFallback = (doc: Document, combined: string): Element | null => {
  for (const sel of splitSelectors(combined)) {
    let el: Element | null;
    try {
      el = doc.querySelector(sel);
    } catch {
      continue; // invalid sub-selector — try the next one in the chain
    }
    if (el) return el;
  }
  return null;
};

/** Read text content of the first matching element. Returns null if no
 *  selector in the (possibly comma-separated) fallback chain matches. */
const readElement = (doc: Document, selector: string): string | null => {
  const el = querySelectorFallback(doc, selector);
  if (!el) return null;
  const text = el.textContent;
  return text == null ? null : text.trim();
};

/** Write supplied input values into the matched elements. */
const writeElements = (
  slug: string,
  doc: Document,
  selectors: Array<{ selector: string; field: string }>,
  input: Record<string, unknown>,
): DOMWriteResult => {
  const written: string[] = [];
  const failed: string[] = [];
  let suppliedCount = 0;

  for (const { selector, field } of selectors) {
    const raw = input[field];
    // Null/undefined → caller is not supplying this field, skip cleanly
    if (raw == null) continue;
    suppliedCount++;
    const value = String(raw);

    // Walk the comma-separated fallback chain in declaration order.
    // First matching element wins, regardless of whether it turns out
    // to be writable — the fallback chain is for "which page version",
    // not "which writable control".
    const el = querySelectorFallback(doc, selector);
    if (!el) {
      failed.push(field);
      continue;
    }

    if (setElementValue(el, value)) {
      written.push(field);
    } else {
      failed.push(field);
    }
  }

  // If the caller supplied values but NONE landed, treat as a hard failure
  // so the recipe halts and the approval layer can tell the user.
  // (suppliedCount === 0 means the caller passed nothing — that's a no-op,
  // not a failure — we return an empty result.)
  if (suppliedCount > 0 && written.length === 0) {
    throw new IngredientError(
      'DOM_WRITE_FAILED',
      `${slug} could not write any of ${failed.length} target field(s): ${failed.join(', ')}`,
      { failed },
    );
  }

  return { written: written.length, fields: written, failed };
};

/** Set an element's value based on its type. Returns true on success.
 *  Dispatches `input` and `change` events so React / Vue / etc. re-render. */
const setElementValue = (el: Element, value: string): boolean => {
  // Form elements: input, textarea, select
  if (isFormControl(el)) {
    try {
      (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = value;
    } catch {
      return false;
    }
    dispatchWriteEvents(el);
    return true;
  }

  // contenteditable region — use execCommand('insertText') first so
  // rich text frameworks (Quill, ProseMirror, Slate, Lexical) intercept
  // correctly. Falls back to textContent for simpler implementations.
  if ((el as HTMLElement).isContentEditable) {
    try {
      const doc = el.ownerDocument;
      el.textContent = '';
      const selection = doc.getSelection();
      if (selection) {
        const range = doc.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (!doc.execCommand('insertText', false, value)) {
        el.textContent = value; // fallback
      }
    } catch {
      try { el.textContent = value; } catch { return false; }
    }
    dispatchWriteEvents(el);
    return true;
  }

  // Anything else: refuse. Setting textContent on a display <div> is almost
  // certainly the wrong thing for an action recipe.
  return false;
};

const isFormControl = (el: Element): boolean => {
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  // Block read-only and disabled inputs — those are display-only
  const ctrl = el as HTMLInputElement;
  if (ctrl.disabled || ctrl.readOnly) return false;
  return true;
};

/** Dispatch input + change events so framework listeners see the update. */
const dispatchWriteEvents = (el: Element): void => {
  try {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch {
    // Event dispatch failing is not fatal — the DOM value is already set.
  }
};

/** Dispatch a full pointer+mouse event sequence on an element.
 *  The complete sequence (pointerdown → mousedown → pointerup → mouseup → click)
 *  is needed because React, Angular, and Lit attach listeners at different
 *  points in the chain. A plain `.click()` is often ignored by frameworks
 *  that detect synthetic events. */
const dispatchClick = (el: Element): void => {
  const opts = { bubbles: true, cancelable: true };
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  } catch {
    // Fallback: plain click
    try { (el as HTMLElement).click?.(); } catch { /* noop */ }
  }
};

/** Dispatch Enter key event on an element (keydown + keyup).
 *  Used for inputs that submit on Enter (chat inputs, search boxes).
 *  The full key event sequence matches real keyboard behavior. */
const dispatchEnter = (el: Element): void => {
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  try {
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  } catch {
    // Fallback: try just keydown (some frameworks only listen for keydown)
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
    } catch { /* noop */ }
  }
};

/** Execute click or enter actions on matching elements. Returns count of successful actions. */
const clickElements = (
  slug: string,
  doc: Document,
  targets: Array<{ selector: string; action: 'click' | 'enter' }>,
): number => {
  let acted = 0;
  for (const { selector, action } of targets) {
    const el = querySelectorFallback(doc, selector);
    if (!el) continue;
    if (action === 'enter') {
      dispatchEnter(el);
    } else {
      dispatchClick(el);
    }
    acted++;
  }
  return acted;
};

/** Match a URL against a glob-style pattern. `*` matches any characters including `/`.
 *  Matches Chrome extension URL match-pattern semantics for predictability.
 */
const matchUrl = (url: string, pattern: string): boolean => {
  // Strip protocol if pattern doesn't include one (so "app.hubspot.com/*" matches "https://app.hubspot.com/...")
  const stripped = pattern.includes('://') ? url : url.replace(/^https?:\/\//, '');

  // Escape regex special chars, then turn * into .*
  const regex = new RegExp('^' + pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*') + '$');

  return regex.test(stripped);
};

/** Default context: use globalThis when available (browser content-script). Otherwise throw. */
const defaultContext = (slug: string): DOMContext => {
  const g = globalThis as unknown as { document?: Document; location?: { href?: string } };
  if (g.document && g.location?.href) {
    return { document: g.document, url: g.location.href };
  }
  throw new IngredientError(
    'DOM_SELECTOR_NOT_FOUND',
    `${slug} requires a DOMContext (no document available in this environment)`,
  );
};
