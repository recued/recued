import type { PreparedAuthenticationHistoryDownload } from './authentication-history-export.js';
import { previewTitle as title, previewFieldTitle, previewFieldText, previewMatches, PREVIEW_MATCH_PAGE_SIZE, type PreviewPath, type PreviewMatch } from './authentication-history-preview-fields.js';
import { previewMatchedText, type PreviewHighlight } from './authentication-history-preview-excerpt.js';
import { createAuthenticationHistoryCopy } from './authentication-history-preview-copy.js';

export type RevealPreviewField = (path: PreviewPath) => HTMLElement | undefined;
type Entry = PreparedAuthenticationHistoryDownload['report']['entries'][number];
const PAGE_SIZE = 20;
let fieldsCounter = 0;

/** Lazy saved-field trees and match navigation. Each owner gets its own
 * highlight, return path and copy lifetime, using only prepared public fields. */
export const createAuthenticationHistoryPreviewFields = (deps: {
  document: Document; active(control: HTMLElement): boolean; interactive?(control: HTMLElement): boolean; notice: HTMLElement;
}) => {
  const doc = deps.document; const active = deps.active; const interactive = deps.interactive ?? active; const notice = deps.notice;
  const id = 'history-preview-fields-' + ++fieldsCounter;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const empty = (element: HTMLElement): void => { while (element.firstChild) element.removeChild(element.firstChild); };
  const matchedText = (parent: HTMLElement, text: string, ranges: readonly PreviewHighlight[], fullValue?: 'display' | 'saved'): HTMLElement[] => {
    let offset = 0; const hits: HTMLElement[] = [];
    for (const range of ranges) {
      if (range.start > offset) parent.appendChild(node('span', text.slice(offset, range.start)));
      const mark = node('mark', text.slice(range.start, range.end)); mark.setAttribute('data-history-preview-highlight', 'match');
      if (fullValue) mark.setAttribute('data-history-preview-value-highlight', fullValue);
      parent.appendChild(mark); hits.push(mark); offset = range.end;
    }
    if (offset < text.length) parent.appendChild(node('span', text.slice(offset)));
    return hits;
  };
  type FullValue = { element: HTMLElement; text: string; raw: string };
  const fullValues = new WeakMap<HTMLElement, FullValue>();
  let fullSelection: { value: FullValue; host: HTMLElement; extra: HTMLElement | undefined; navigation?: HTMLElement } | undefined;
  const clearValueHighlight = (): void => {
    if (!fullSelection) return;
    const { value, host, extra, navigation } = fullSelection; empty(value.element); value.element.textContent = value.text;
    if (navigation && host.contains(navigation)) host.removeChild(navigation);
    if (extra && host.contains(extra)) host.removeChild(extra); fullSelection = undefined;
  };
  const returnHosts = new WeakMap<HTMLElement, HTMLElement>();
  let returnPlacement: { control: HTMLButtonElement; host: HTMLElement; dedicated: boolean; target: HTMLElement; label: string | null; copy?: HTMLElement } | undefined;
  const clearReturn = (): void => {
    clearValueHighlight();
    if (!returnPlacement) return;
    const { control, host, dedicated, target, label, copy } = returnPlacement;
    if (host.contains(control)) host.removeChild(control); if (dedicated) host.hidden = true;
    if (copy && host.contains(copy)) host.removeChild(copy);
    target.setAttribute('data-history-preview-match-target', 'false');
    if (label === null) target.removeAttribute('aria-label'); else target.setAttribute('aria-label', label);
    returnPlacement = undefined;
  };
  const button = (text: string, key: string, run: (event: MouseEvent) => void): HTMLButtonElement => {
    const control = node('button', text); control.type = 'button'; control.setAttribute('data-history-preview-control', key);
    control.addEventListener('click', event => { if (interactive(control) && !control.disabled) run(event); }); return control;
  };
  const pagingButton = (text: string, key: string, run: (pointerFocus?: Element | null) => void): HTMLButtonElement => {
    let pointerFocus: Element | null | undefined;
    const control = button(text, key, event => {
      const before = event.detail > 0 ? pointerFocus : undefined; pointerFocus = undefined; run(before);
    });
    // WebKit can blur the old field on pointerdown, before click runs.
    control.addEventListener('pointerdown', () => { pointerFocus = interactive(control) ? doc.activeElement : undefined; });
    control.addEventListener('pointercancel', () => { pointerFocus = undefined; });
    return control;
  };
  const pagingFocus = (previous: HTMLButtonElement, next: HTMLButtonElement, summary: HTMLElement, pointerFocus?: Element | null, items?: HTMLElement) => {
    const current = doc.activeElement;
    const before = current === doc.body || current === summary ? pointerFocus ?? current : current;
    return { focused: before === previous ? previous : before === next ? next : undefined, removed: items?.contains(before) ? before : undefined, summary };
  };
  const restorePagingFocus = ({ focused, removed, summary }: ReturnType<typeof pagingFocus>, range: HTMLElement): void => {
    if (!interactive(range)) return;
    const current = doc.activeElement; const fallback = current === doc.body || current === summary;
    // Disabling a button or removing a selected field can synchronously blur
    // it. Preserve any newer focus chosen by that handler, including its scroll.
    if (focused?.disabled && (current === focused || fallback) || removed && (current === removed || fallback)) {
      range.focus({ preventScroll: true });
      if (interactive(range) && doc.activeElement === range) range.scrollIntoView?.({ block: 'nearest' });
    } else if (focused && interactive(focused) && current !== focused && fallback) focused.focus({ preventScroll: true });
  };
  const scalar = (parent: HTMLElement, key: string, data: unknown, path: PreviewPath): void => {
    let value: HTMLElement | undefined;
    if (typeof data === 'number' && (key === 'at' || key.endsWith('_at'))) {
      const iso = new Date(data).toISOString(); value = node('time', iso); value.setAttribute('datetime', iso);
    } else if (typeof data === 'boolean') value = node('span', data ? 'Yes' : 'No');
    else if (typeof data === 'string' || typeof data === 'number') {
      const identifier = key === 'id' || key.endsWith('_id') || ['name', 'slug', 'revision', 'authentication_revision', 'app_reference'].includes(key);
      value = node(identifier ? 'code' : 'span', previewFieldText(path, data));
    }
    if (value) { parent.appendChild(value); fullValues.set(parent, { element: value, text: value.textContent ?? '', raw: String(data) }); }
  };
  const fields = (parent: HTMLElement, data: object, path: PreviewPath): RevealPreviewField => {
    const list = node('dl'); parent.appendChild(list);
    const children = new Map<string, RevealPreviewField>();
    for (const [key, child] of Object.entries(data)) {
      const childPath = [...path, key]; list.appendChild(node('dt', previewFieldTitle(childPath))); const content = node('dd'); list.appendChild(content);
      children.set(key, detail(content, key, child, childPath));
    }
    return remaining => typeof remaining[0] === 'string' ? children.get(remaining[0])?.(remaining.slice(1)) : undefined;
  };
  const detail = (parent: HTMLElement, key: string, data: unknown, path: PreviewPath = [key]): RevealPreviewField => {
    if (!data || typeof data !== 'object') {
      scalar(parent, key, data, path); parent.setAttribute('data-history-preview-path', JSON.stringify(path));
      return remaining => !remaining.length && active(parent) ? parent : undefined;
    }
    const disclosure = node('details'); disclosure.setAttribute('data-history-preview-field', key);
    const summary = node('summary', title(key) + (Array.isArray(data) ? ` (${data.length})` : '')); summary.setAttribute('tabindex', '0');
    summary.setAttribute('data-history-preview-path', JSON.stringify(path)); disclosure.appendChild(summary); parent.appendChild(disclosure);
    const actions = node('div'); actions.hidden = true; disclosure.appendChild(actions); returnHosts.set(summary, actions);
    let populated = false; let revealChildren: RevealPreviewField | undefined;
    const populate = (wanted: PreviewPath = []): void => {
      if (!active(disclosure) || populated) return; populated = true;
      if (!Array.isArray(data)) { revealChildren = fields(disclosure, data, path); return; }
      const initial = wanted[0]; let offset = typeof initial === 'number' && Number.isInteger(initial) && initial >= 0 && initial < data.length ? Math.floor(initial / PAGE_SIZE) * PAGE_SIZE : 0;
      const children = new Map<number, RevealPreviewField>(); const list = node('ol'); const range = node('p'); range.setAttribute('role', 'status'); range.setAttribute('tabindex', '-1');
      const previous = pagingButton('Previous items', 'array-previous', before => { offset -= PAGE_SIZE; renderItems(before); });
      const next = pagingButton('Next items', 'array-next', before => { offset += PAGE_SIZE; renderItems(before); });
      const renderItems = (pointerFocus?: Element | null): void => {
        const focus = pagingFocus(previous, next, summary, pointerFocus, list);
        if (returnPlacement && list.contains(returnPlacement.control)) clearReturn();
        empty(list); children.clear(); const end = Math.min(offset + PAGE_SIZE, data.length); list.setAttribute('start', String(offset + 1));
        for (let index = offset; index < end; index++) {
          const child = data[index]; const item = node('li'); list.appendChild(item); const childPath = [...path, index];
          children.set(index, child && typeof child === 'object' && !Array.isArray(child) ? fields(item, child, childPath) : detail(item, key, child, childPath));
        }
        range.textContent = data.length ? `Items ${offset + 1}–${end} of ${data.length}` : 'No items recorded.';
        previous.disabled = offset === 0; next.disabled = end >= data.length;
        restorePagingFocus(focus, range);
      };
      disclosure.appendChild(list); disclosure.appendChild(range);
      if (data.length > PAGE_SIZE) { disclosure.appendChild(previous); disclosure.appendChild(next); }
      renderItems();
      revealChildren = remaining => {
        const index = remaining[0]; if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= data.length) return undefined;
        const desired = Math.floor(index / PAGE_SIZE) * PAGE_SIZE; if (desired !== offset) { offset = desired; renderItems(); }
        return children.get(index)?.(remaining.slice(1));
      };
    };
    disclosure.addEventListener('toggle', () => { if (disclosure.open) populate(); });
    return remaining => {
      if (!active(disclosure)) return undefined; disclosure.open = true; populate(remaining);
      return remaining.length ? revealChildren?.(remaining) : summary;
    };
  };
  const matches = (options: {
    parent: HTMLElement; summary: HTMLElement; entry: Entry; query: string; firstMatches: ReturnType<typeof previewMatches>;
    open(): void; reveal: RevealPreviewField; context?: string;
  }): HTMLElement => {
    const { entry, query: recordQuery, firstMatches } = options; const context = options.context ? ' in ' + options.context : '';
    const openMatch = (match: PreviewMatch, restoreMatch: () => HTMLButtonElement | undefined): void => {
      options.open();
      const target = options.reveal(match.path);
      if (!target) { notice.textContent = 'This matching field could not be opened. Apply this search again.'; notice.hidden = false; return; }
      clearReturn();
      const originalLabel = target.getAttribute('aria-label');
      let hits: HTMLElement[] = []; let savedValue = false;
      const value = fullValues.get(target);
      if (value && match.source !== 'Field name') {
        const display = previewMatchedText(value.text, recordQuery);
        let extra: HTMLElement | undefined;
        if (display.highlights.length) {
          empty(value.element); value.element.textContent = '';
          hits = matchedText(value.element, display.text, display.highlights, 'display');
        } else {
          const raw = previewMatchedText(value.raw, recordQuery);
          if (raw.highlights.length) {
            extra = node('div'); extra.setAttribute('data-history-preview-saved-value', 'literal'); extra.appendChild(node('span', 'Saved value: '));
            const code = node('code'); hits = matchedText(code, raw.text, raw.highlights, 'saved'); extra.appendChild(code); target.appendChild(extra); savedValue = true;
          }
        }
        if (hits.length) fullSelection = { value, host: target, extra };
      }
      target.setAttribute('data-history-preview-match-target', 'true');
      if (target.getAttribute('tabindex') === null) target.setAttribute('tabindex', '-1');
      const accessibleValue = value ? value.text + (savedValue ? '. Saved value: ' + value.raw : '') : target.textContent;
      target.setAttribute('aria-label', 'Matched field: ' + match.label + (accessibleValue ? ': ' + accessibleValue : ''));
      const back = button('Return to matching fields', 'return-matches', () => {
        options.open(); const origin = restoreMatch();
        if (!origin || !interactive(origin)) { notice.textContent = 'The original match is no longer available. Apply this search again.'; notice.hidden = false; return; }
        origin.focus({ preventScroll: true });
        if (interactive(origin) && doc.activeElement === origin) origin.scrollIntoView?.({ block: 'nearest' });
        notice.textContent = 'Returned to matching fields: ' + match.label + '.'; notice.hidden = false;
      });
      back.className = 'authentication-history-preview-return'; back.setAttribute('aria-label', 'Return to matching fields: ' + match.label + context);
      back.setAttribute('data-history-preview-return-path', JSON.stringify(match.path));
      const dedicated = returnHosts.get(target); const host = dedicated ?? target; if (dedicated) host.hidden = false;
      let hitIndex = 0;
      const scrollToHit = (): void => { (hits[hitIndex] ?? target).scrollIntoView?.({ block: hits.length ? 'center' : 'nearest' }); };
      if (hits.length) {
        const navigation = node('div'); navigation.className = 'authentication-history-preview-hits'; navigation.setAttribute('role', 'group');
        navigation.setAttribute('aria-label', 'Find hits in ' + match.label); navigation.setAttribute('data-history-preview-hits', 'navigation');
        const hitRange = node('p'); hitRange.setAttribute('role', 'status'); hitRange.setAttribute('tabindex', '-1');
        hitRange.setAttribute('data-history-preview-hit-range', 'value'); hitRange.id = id + '-hit-range';
        const previousHit = pagingButton('Previous hit', 'hit-previous', before => selectHit(hitIndex - 1, true, before));
        const nextHit = pagingButton('Next hit', 'hit-next', before => selectHit(hitIndex + 1, true, before));
        const selectHit = (index: number, scroll = true, pointerFocus?: Element | null): void => {
          if (index < 0 || index >= hits.length) return;
          // WebKit can focus the enclosing value when a button is clicked.
          // Use captured pointer focus only within this navigation context.
          const focus = pagingFocus(previousHit, nextHit, target, pointerFocus);
          hits[hitIndex]!.setAttribute('aria-current', 'false'); hitIndex = index; hits[hitIndex]!.setAttribute('aria-current', 'true');
          hitRange.textContent = `Hit ${hitIndex + 1} of ${hits.length}`; previousHit.disabled = hitIndex === 0; nextHit.disabled = hitIndex === hits.length - 1;
          restorePagingFocus(focus, hitRange);
          if (scroll && interactive(navigation) && [target, previousHit, nextHit, hitRange].some(control => doc.activeElement === control)) scrollToHit();
        };
        previousHit.setAttribute('aria-describedby', hitRange.id); nextHit.setAttribute('aria-describedby', hitRange.id);
        navigation.appendChild(hitRange); navigation.appendChild(previousHit); navigation.appendChild(nextHit); host.appendChild(navigation);
        fullSelection!.navigation = navigation; selectHit(0, false);
      }
      host.appendChild(back); returnPlacement = { control: back, host, dedicated: !!dedicated, target, label: originalLabel };
      if (value) {
        const copy = createAuthenticationHistoryCopy({ kind: 'value', document: doc, raw: value.raw, readable: value.text, label: match.label, origin: target, active, interactive });
        host.appendChild(copy); returnPlacement.copy = copy;
      }
      target.focus({ preventScroll: true });
      if (interactive(back) && doc.activeElement === target) scrollToHit();
      // Settle scroll anchoring after the saved-value row changes layout.
      // A newer selection or focused control must keep its own position.
      doc.defaultView?.requestAnimationFrame?.(() => { if (interactive(back) && doc.activeElement === target) scrollToHit(); });
      notice.textContent = 'Opened matching field: ' + match.label + '.' + (savedValue ? ' Matching text is highlighted in the saved value.'
        : hits.length ? ' Matching text is highlighted in the full value.' : ' The field name matches this search.'); notice.hidden = false;
    };
    const section = node('section'); section.className = 'authentication-history-preview-matches'; section.setAttribute('data-history-preview-matches', 'fields');
    section.setAttribute('aria-label', 'Matching saved fields' + context); section.appendChild(node('h4', 'Matching fields'));
    section.appendChild(node('p', 'Highlights show matching names or values. Long values show nearby text. An ellipsis marks omitted text. View field opens the full saved value.'));
    const items = node('ol'); const matchRange = node('p'); matchRange.setAttribute('role', 'status'); matchRange.setAttribute('tabindex', '-1');
    matchRange.setAttribute('data-history-preview-match-range', 'fields'); let matchOffset = 0;
    const views = new Map<string, HTMLButtonElement>();
    const previousMatch = pagingButton('Previous matches', 'matches-previous', before => { matchOffset -= PREVIEW_MATCH_PAGE_SIZE; renderMatches(before); });
    const nextMatch = pagingButton('Next matches', 'matches-next', before => { matchOffset += PREVIEW_MATCH_PAGE_SIZE; renderMatches(before); });
    const renderMatches = (pointerFocus?: Element | null): void => {
      const focus = pagingFocus(previousMatch, nextMatch, options.summary, pointerFocus, items);
      const current = matchOffset === 0 ? firstMatches : previewMatches(entry, recordQuery, matchOffset); empty(items); views.clear(); items.setAttribute('start', String(matchOffset + 1));
      for (const match of current.matches) {
        const item = node('li'); const label = node('p'); matchedText(label, match.label, match.labelHighlights); label.appendChild(node('span', ' · ' + match.source)); item.appendChild(label);
        const value = node('code'); matchedText(value, match.value, match.valueHighlights); item.appendChild(value);
        const originOffset = matchOffset; const pathKey = JSON.stringify(match.path);
        const view = button('View field', 'match-field', () => openMatch(match, () => {
          if (matchOffset !== originOffset) { matchOffset = originOffset; renderMatches(); }
          return views.get(pathKey);
        })); view.setAttribute('aria-label', 'View matching field: ' + match.label + context);
        view.setAttribute('data-history-preview-match-path', pathKey); views.set(pathKey, view); item.appendChild(view); items.appendChild(item);
      }
      const end = Math.min(matchOffset + PREVIEW_MATCH_PAGE_SIZE, current.total); matchRange.textContent = `Matching fields ${matchOffset + 1}–${end} of ${current.total}`;
      previousMatch.disabled = matchOffset === 0; nextMatch.disabled = end >= current.total;
      restorePagingFocus(focus, matchRange);
    };
    section.appendChild(matchRange); section.appendChild(previousMatch); section.appendChild(nextMatch); section.appendChild(items); options.parent.appendChild(section); renderMatches();
    return section;
  };
  return { fields, detail, matches, clear: clearReturn };
};
