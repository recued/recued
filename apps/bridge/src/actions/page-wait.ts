/** D-335 slice H — waiting in one document until part of the page shows, or
 *  goes: `core.dom.wait`, for an AI that clicked or typed and must know the page
 *  has answered before it reads again.
 *
 *  ⛔ THE WAIT LOOP IS THE SERVICE WORKER'S, NOT THE PAGE'S. The pages the AI
 *  works in are usually background tabs, where Chrome slows a page's timers to
 *  once a second, and once a minute for a tab hidden five minutes. A wait run
 *  inside the page would then miss its deadline or check too rarely. So the
 *  executor injects {@link checkPageElement}, one check, every
 *  {@link PAGE_WAIT_POLL_MS}, and keeps the clock itself. */

import { isBrowserConditionMatchCounts, type BrowserConditionMatchCounts, type BridgeErrorCode } from '@recued/contracts';

import type { ActionExecutorOutcome } from '../queue/dispatcher.js';

/** How often the executor checks the page again. */
export const PAGE_WAIT_POLL_MS = 200;

/** What one check looks for. `until: 'shown'`: an element matching `selector`
 *  is shown (and holds `text`, when given). `until: 'gone'`: none is. */
export interface PageWaitCheck {
  selector: string;
  until: 'shown' | 'gone';
  text?: string;
}

/** A server-selected readiness predicate, never silently partially interpreted. */
export const readReadyCheck = (value: unknown): PageWaitCheck | undefined | null => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['selector', 'until', 'text'].includes(key))
    || typeof raw.selector !== 'string' || !raw.selector.trim()
    || (raw.until !== 'shown' && raw.until !== 'gone')
    || raw.text !== undefined && typeof raw.text !== 'string') return null;
  return { selector: raw.selector, until: raw.until as 'shown' | 'gone', ...(typeof raw.text === 'string' ? { text: raw.text } : {}) };
};

export type PageWaitCheckAnswer =
  | { outputs: { url: string; title: string; met: boolean; match_counts?: BrowserConditionMatchCounts } }
  | { invalid: true }
  | { blocked: true };

/** One check of the document it runs in. Injected, so self-contained. A shown
 *  element is one a person could see: the same test `inspectPage` uses. `text`
 *  matches case-insensitively, with runs of white space read as one space. */
export const checkPageElement = (check: PageWaitCheck, expectedUrl?: string): PageWaitCheckAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  let matches: Element[];
  try {
    matches = [...document.querySelectorAll(check.selector)];
  } catch {
    return { invalid: true };
  }
  const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = check.text == null ? '' : normal(check.text);
  const above = (at: Element): Element | null =>
    at.assignedSlot ?? at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null;
  // 2026-11-22 — as `inspectPage` reads it: a dialog the page marks hidden, on it or around it, while a person
  // sees it on top (where a click at the screen's centre, or at the centre of one of its quarters, lands) is
  // shown; what the page marks hidden inside it is not. ⛔ The same rule, word for word, as `inspectPage`'s.
  const onTop = new Set<Element>();
  try {
    const shadowOf = (element: Element): ShadowRoot | null => {
      try {
        const dom = (globalThis as typeof globalThis & {
          chrome?: { dom?: { openOrClosedShadowRoot?: (host: Element) => ShadowRoot | null | undefined } } }).chrome?.dom;
        return dom?.openOrClosedShadowRoot?.(element) ?? element.shadowRoot;
      } catch {
        return element.shadowRoot;
      }
    };
    const DIALOG = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
    const marked = (element: Element) => {
      for (let at: Element | null = element; at; at = above(at)) if (at.getAttribute('aria-hidden') === 'true') return true;
      return false;
    };
    // And what covers the page at the screen's centre though the page marks it hidden, unless a modal dialog
    // it does not hide is open (2026-11-22, `inspectPage`'s `covers`).
    const openModal = [...document.querySelectorAll(DIALOG)].some((element) => !marked(element)
      && (element.matches(':modal') || element.getAttribute('aria-modal') === 'true')
      && element.checkVisibility({ checkVisibilityCSS: true }));
    for (const [x, y] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
      const px = innerWidth * x;
      const py = innerHeight * y;
      let hit = document.elementFromPoint(px, py);
      for (let depth = 0; hit !== null && depth < 32; depth += 1) {
        const inner = shadowOf(hit)?.elementFromPoint(px, py) ?? null;
        if (inner === null || inner === hit) break;
        hit = inner;
      }
      let dialog: Element | null = null;
      for (let at: Element | null = hit; at; at = above(at)) if (at.matches(DIALOG) && marked(at)) dialog = at;
      if (dialog !== null) onTop.add(dialog);
      if (x !== 0.5 || y !== 0.5 || openModal) continue;
      let cover: Element | null = null;
      for (let at: Element | null = hit; at; at = above(at)) {
        if (marked(at) && getComputedStyle(at).position === 'fixed') cover = at;
      }
      if (cover !== null) onTop.add(cover);
    }
  } catch {
    onTop.clear();
  }
  const shown = (element: Element) => {
    for (let at: Element | null = element; at; at = above(at)) {
      if (onTop.has(at)) break;
      if (at.getAttribute('aria-hidden') === 'true') return false;
    }
    return element.checkVisibility({ checkVisibilityCSS: true })
      || getComputedStyle(element).display === 'contents';
  };
  let visible = 0, textMatched = 0;
  for (const element of matches) if (shown(element)) {
    visible += 1;
    if (wanted === '' || normal((element as HTMLElement).innerText ?? element.textContent ?? '').includes(wanted)) textMatched += 1;
  }
  const present = textMatched > 0;
  const title = document.title.length > 200 ? `${document.title.slice(0, 200)}…` : document.title;
  return { outputs: { url: location.href, title, met: check.until === 'gone' ? !present : present,
    match_counts: { matched: matches.length, visible, text_matched: textMatched } } };
};

/** A wait command's arguments, or why it cannot run. The server bounds
 *  `timeout_ms`; the Bridge bounds it again. */
export const readWaitRequest = (args: Record<string, unknown>, maxMs: number, defaultMs: number):
  | { check: PageWaitCheck; timeout_ms: number }
  | { error: string } => {
  const { selector, until, text, timeout_ms } = args;
  if (typeof selector !== 'string' || selector.trim() === '') return { error: 'Name what to wait for: a CSS selector.' };
  if (until !== undefined && until !== 'shown' && until !== 'gone') return { error: 'Wait until it is shown or gone.' };
  if (text !== undefined && typeof text !== 'string') return { error: 'The text to wait for must be text.' };
  if (timeout_ms !== undefined && (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms < 0)) {
    return { error: 'The time to wait must be a number of milliseconds.' };
  }
  return {
    check: { selector, until: until ?? 'shown', ...(text !== undefined && text !== '' ? { text } : {}) },
    timeout_ms: Math.min(maxMs, timeout_ms ?? defaultMs),
  };
};

/** D-335 slice K — what means the step failed, on the page (`args.fail`, the step's `fail_when`):
 *  undefined when the command names none, null when it names one wrongly. It is waited for as a
 *  shown element is. */
export const readFailCheck = (raw: unknown): PageWaitCheck | undefined | null => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { selector, text, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof selector !== 'string' || selector.trim() === '') return null;
  if (text !== undefined && (typeof text !== 'string' || text === '')) return null;
  return { selector, until: 'shown', ...(typeof text === 'string' ? { text } : {}) };
};

/** One check's answer, or the error it means. Anything but exactly one known
 *  key proves nothing. */
export const waitCheckOutcome = (answer: unknown):
  | { url: string; title: string; met: boolean; match_counts?: BrowserConditionMatchCounts }
  | { error: ActionExecutorOutcome } => {
  const error = (code: BridgeErrorCode, message: string) => ({ error: { status: 'error' as const, error: { code, message } } });
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1) {
    return error('unknown', 'bridge: no readable answer from the page');
  }
  const reply = answer as Record<string, unknown>;
  if (reply.blocked === true) return error('tab_navigation_blocked', 'The owner client cannot be automated.');
  if (reply.invalid === true) return error('selector_not_found', 'The selector is not valid CSS.');
  const outputs = reply.outputs as Record<string, unknown> | undefined;
  if (!outputs || typeof outputs.url !== 'string' || typeof outputs.title !== 'string' || typeof outputs.met !== 'boolean'
    || Object.keys(outputs).some(key => !['url', 'title', 'met', 'match_counts'].includes(key))
    || outputs.match_counts !== undefined && !isBrowserConditionMatchCounts(outputs.match_counts)) {
    return error('unknown', 'bridge: no readable answer from the page');
  }
  return { url: outputs.url, title: outputs.title, met: outputs.met,
    ...(isBrowserConditionMatchCounts(outputs.match_counts) ? { match_counts: outputs.match_counts } : {}) };
};
