import { findTextMatches as findNoteMatches } from './text-find.js';
import type { ReaderFindState } from './reader-state.js';
export { findTextMatches as findNoteMatches } from './text-find.js';
export const NOTE_FIND_ACTION = 'note-find-';
export const NOTE_FIND_INPUT = 'data-note-find-input';
export const TASK_FIND_ACTION = 'task-find-';
const blocks = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'TD', 'TH', 'TR', 'HR']);
export const readerTextIndex = (roots: readonly HTMLElement[]) => {
  const pieces: string[] = [], runs: { node: Text; start: number; end: number }[] = [];
  let length = 0, last = '';
  const append = (text: string) => { if (text) { pieces.push(text); length += text.length; last = text.at(-1)!; } };
  const boundary = () => { if (length && last !== '\n') append('\n'); };
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node as Text;
      if (text.data) { const start = length; append(text.data); runs.push({ node: text, start, end: length }); }
    } else if (node.nodeType === 1) {
      const element = node as Element;
      if (element.tagName === 'BUTTON' || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true' || element.getAttribute('role') === 'status') return;
      if (element.tagName === 'BR' || blocks.has(element.tagName)) boundary();
      for (const child of element.childNodes) visit(child);
      if (blocks.has(element.tagName)) boundary();
    }
  };
  for (const root of roots) { boundary(); visit(root); }
  return { text: pieces.join(''), runs };
};

/** Highlights touch only selected reader text, never the saved record,
 * rendered link attributes, the outline, or the editing form. */
export const createNoteFind = (deps: { root: HTMLElement; render: () => void; onSearchEverywhere?: (query: string) => void; onReveal?: () => void; kind?: 'note' | 'task' }) => {
  const kind = deps.kind ?? 'note', actionPrefix = `${kind}-find-`, inputAttribute = `data-${kind}-find-input`, matchAttribute = `data-${kind}-find-match`;
  let id: string | null = null, opened = false, query = '', active = 0, limited = false;
  let bodies: HTMLElement[] = [], lastQuery = '', lastFormat = '';
  let groups: HTMLElement[][] = [];
  let requestFocus: 'input' | 'trigger' | null = null;
  let selection: { start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } | null = null;
  let jump = false;
  const reader = () => {
    if (id === null) return null;
    const element = deps.root.querySelector?.<HTMLElement>(`.work-entity-${kind}-reader`);
    return element?.getAttribute(`data-${kind}-id`) === id ? element : null;
  };
  const input = () => reader()?.querySelector<HTMLInputElement>(`[${inputAttribute}]`);
  const reset = () => {
    id = null; opened = false; query = ''; active = 0; groups = []; limited = false;
    bodies = []; lastQuery = lastFormat = ''; requestFocus = null; selection = null; jump = false;
  };
  const update = () => {
    const host = reader(); if (!host) return;
    const status = host.querySelector<HTMLElement>(`[data-${kind}-find-status]`);
    if (status) status.textContent = !query ? 'Type to find text.' : !groups.length ? 'No matches.'
      : `${active + 1} of ${groups.length.toLocaleString()}${limited ? '+' : ''} matches${limited ? '. Narrow your search to see more.' : '.'}`;
    host.querySelectorAll<HTMLButtonElement>(`[data-${kind}-find-step]`).forEach(button => { button.disabled = groups.length === 0; });
    const everywhere = host.querySelector<HTMLButtonElement>(`[data-${kind}-find-everywhere]`);
    if (everywhere) {
      everywhere.disabled = !query.trim() || everywhere.getAttribute('aria-disabled') === 'true';
      everywhere.setAttribute('aria-label', query.trim() ? `Search everywhere for ${query.trim()}` : 'Search everywhere');
    }
    for (let index = 0; index < groups.length; index++) for (const mark of groups[index]!) {
      if (index === active) mark.setAttribute(`data-${kind}-find-current`, ''); else mark.removeAttribute(`data-${kind}-find-current`);
    }
    if (jump) {
      const mark = groups[active]?.[0], content = host.querySelector<HTMLElement>(`.work-entity-${kind}-content`);
      if (mark && content && content.contains(mark)) {
        if (host.classList?.contains('work-entity-reader--inline') && content.scrollHeight <= content.clientHeight) {
          mark.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
          const at = mark.getBoundingClientRect(), bounds = content.getBoundingClientRect();
          if (at.top < bounds.top + 12 || at.bottom > bounds.bottom - 12) content.scrollTop += at.top - bounds.top - 16;
          const code = mark.closest('pre');
          if (code) { const box = code.getBoundingClientRect(); if (at.left < box.left || at.right > box.right) code.scrollLeft += at.left - box.left - 12; }
        }
        deps.onReveal?.();
      }
      jump = false;
    }
  };
  const search = () => {
    const host = reader();
    if (!host || !opened) { bodies = []; groups = []; return; }
    const roots = Array.from(host.querySelectorAll<HTMLElement>(kind === 'task' ? '[data-task-find-title], [data-task-find-body]' : '[data-note-body]'));
    if (!roots.length) { bodies = []; groups = []; return; }
    const format = host.getAttribute(`data-${kind}-format`) ?? '';
    if (bodies.length === roots.length && bodies.every((body, index) => body === roots[index]) && lastQuery === query) { update(); return; }
    if (lastFormat && lastFormat !== format) jump = true;
    bodies = roots; lastFormat = format; lastQuery = query;
    for (const body of bodies) {
      body.querySelectorAll<HTMLElement>(`mark[${matchAttribute}]`).forEach(mark => mark.replaceWith(body.ownerDocument.createTextNode(mark.textContent ?? '')));
      body.normalize();
    }
    const document = host.ownerDocument;
    const model = readerTextIndex(bodies), result = findNoteMatches(model.text, query);
    groups = result.matches.map(() => []); limited = result.limited;
    active = Math.max(0, Math.min(active, groups.length - 1));
    let first = 0;
    for (const run of model.runs) {
      while (first < result.matches.length && result.matches[first]!.end <= run.start) first++;
      if (!result.matches[first] || result.matches[first]!.start >= run.end) continue;
      const fragment = document.createDocumentFragment(); let offset = 0;
      for (let index = first; index < result.matches.length && result.matches[index]!.start < run.end; index++) {
        const match = result.matches[index]!, start = Math.max(0, match.start - run.start), end = Math.min(run.node.length, match.end - run.start);
        fragment.append(document.createTextNode(run.node.data.slice(offset, start)));
        const mark = document.createElement('mark'); mark.setAttribute(matchAttribute, String(index));
        mark.textContent = run.node.data.slice(start, end); fragment.append(mark); groups[index]!.push(mark); offset = end;
      }
      fragment.append(document.createTextNode(run.node.data.slice(offset))); run.node.replaceWith(fragment);
    }
    update();
  };
  const show = () => {
    if (!reader()) return;
    if (opened) { input()?.focus({ preventScroll: true }); input()?.select(); return; }
    opened = true; requestFocus = 'input'; jump = Boolean(query); deps.render();
  };
  const close = () => { opened = false; requestFocus = 'trigger'; deps.render(); };
  const step = (direction: number) => {
    if (!groups.length) return;
    active = (active + direction + groups.length) % groups.length; jump = true; update();
  };
  return {
    reset,
    open(noteId: string) { if (noteId !== id) { reset(); id = noteId; } },
    find(value: string) {
      if (!reader() || !value.trim()) return;
      query = value; active = 0; jump = true; opened = true; requestFocus = 'input'; deps.render();
    },
    state: () => ({ open: opened, query, can_search_everywhere: Boolean(deps.onSearchEverywhere) }),
    snapshot: (): ReaderFindState => ({ open: opened, query, active }),
    resume(state: ReaderFindState) { opened = state.open; query = state.query; active = state.active; bodies = []; groups = []; lastQuery = lastFormat = ''; jump = false; requestFocus = null; selection = null; },
    capture() {
      const field = input();
      selection = field && field.ownerDocument.activeElement === field
        ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection } : null;
    },
    mount() {
      search();
      const field = input();
      if (requestFocus === 'input') { field?.focus({ preventScroll: true }); field?.select(); }
      else if (requestFocus === 'trigger') reader()?.querySelector<HTMLElement>(`[data-${kind}-focus="find-open"]`)?.focus({ preventScroll: true });
      else if (field && selection) { field.focus({ preventScroll: true }); if (selection.start !== null && selection.end !== null) field.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined); }
      requestFocus = null; selection = null;
    },
    handleInput(target: HTMLElement): boolean {
      if (!target.hasAttribute(inputAttribute) || !reader()?.contains(target) || !opened) return false;
      const value = (target as HTMLInputElement).value.slice(0, 512);
      if (value !== query) { query = value; active = 0; jump = true; search(); }
      return true;
    },
    handleAction(action: string, target: HTMLElement): boolean {
      if (!action.startsWith(actionPrefix) || !reader()?.contains(target)) return false;
      if (action === `${actionPrefix}open`) show();
      if (action === `${actionPrefix}close`) close();
      if (opened && action === `${actionPrefix}everywhere` && query.trim()) deps.onSearchEverywhere?.(query.trim());
      if (opened && (action === `${actionPrefix}next` || action === `${actionPrefix}previous`)) { target.focus({ preventScroll: true }); step(action === `${actionPrefix}next` ? 1 : -1); }
      return true;
    },
    handleKeyDown(event: KeyboardEvent): boolean {
      const host = reader();
      if (!host || !host.contains(event.target as Node) || event.isComposing) return false;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation(); show(); return true;
      }
      if (opened && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
      if (opened && event.key === 'Enter' && (event.target as HTMLElement).hasAttribute(inputAttribute)) {
        event.preventDefault(); event.stopPropagation(); step(event.shiftKey ? -1 : 1); return true;
      }
      return false;
    },
  };
};
