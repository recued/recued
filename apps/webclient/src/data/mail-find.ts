import { e } from '@recued/ui-shared';
import { findTextMatches, type TextFindMatch } from './text-find.js';

export const MAIL_FIND_ACTION = 'mail-message-find-';
const INPUT = 'data-mail-find-input';
const MATCH = 'data-mail-find-match';
export interface MailFindSnapshot { key: string; body: string | null; opened: boolean; query: string; active: number }

/** Finds only the displayed plain-text email. It neither reads other messages
 * nor mutates the snapshot later used for replies, forwarding or downloads. */
export const createMailFind = (deps: {
  document: Document; root?: HTMLElement; actionAttr: string; render(): void; onSearchEverywhere?(query: string): void;
}) => {
  let key: string | null = null, body: string | null = null, partial = false, opened = false, query = '', active = 0;
  let matches: TextFindMatch[] = [], limited = false, jump = false;
  let focus: 'input' | 'trigger' | null = null;
  let selection: { start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } | null = null;
  const host = () => (deps.root ?? deps.document).querySelector?.<HTMLElement>('.data-mail-conversation') ?? null;
  const input = () => host()?.querySelector<HTMLInputElement>(`[${INPUT}]`);
  const available = () => body !== null && body.length > 0;
  const reset = () => { key = null; body = null; partial = opened = limited = jump = false; query = ''; active = 0; matches = []; focus = null; selection = null; };
  const search = () => {
    const result = findTextMatches(body ?? '', query);
    matches = result.matches; limited = result.limited;
    active = Math.max(0, Math.min(active, matches.length - 1));
  };
  const status = () => body === null ? 'Email text is unavailable.' : !body.length ? partial ? 'No text in the displayed part of this email.' : 'This email is empty.'
    : !query ? 'Type to find text.' : !matches.length ? partial ? 'No matches in the displayed text.' : 'No matches.'
      : `${active + 1} of ${matches.length.toLocaleString()}${limited ? '+' : ''} matches${limited ? '. Narrow your search to see more.' : '.'}`;
  const renderBody = (): string => {
    if (!opened || !query || !matches.length) return e(body || '(Empty message)');
    let html = '', cursor = 0;
    for (const [index, match] of matches.entries()) {
      html += e(body!.slice(cursor, match.start)) + `<mark ${MATCH}="${index}"${index === active ? ' data-mail-find-current' : ''}>${e(body!.slice(match.start, match.end))}</mark>`;
      cursor = match.end;
    }
    return html + e(body!.slice(cursor));
  };
  const update = (replaceBody = false) => {
    const reader = host(); if (!reader) return;
    const text = reader.querySelector<HTMLElement>('[data-mail-message-body]');
    if (text && replaceBody) text.innerHTML = renderBody();
    const state = reader.querySelector<HTMLElement>('[data-mail-find-status]'); if (state) state.textContent = status();
    reader.querySelectorAll<HTMLButtonElement>('[data-mail-find-step]').forEach(button => { button.disabled = matches.length === 0; });
    const everywhere = reader.querySelector<HTMLButtonElement>('[data-mail-find-everywhere]');
    if (everywhere) { everywhere.disabled = !query.trim(); everywhere.setAttribute('aria-label', query.trim() ? `Search everywhere for ${query.trim()}` : 'Search everywhere'); }
    reader.querySelectorAll<HTMLElement>(`[${MATCH}]`).forEach(mark => {
      if (mark.getAttribute(MATCH) === String(active)) mark.setAttribute('data-mail-find-current', ''); else mark.removeAttribute('data-mail-find-current');
    });
    if (jump) {
      const bar = reader.querySelector<HTMLElement>('[data-mail-find-bar]');
      if (text && bar) text.style.setProperty('--mail-find-offset', `${bar.getBoundingClientRect().height + 24}px`);
      reader.querySelector<HTMLElement>('[data-mail-find-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      jump = false;
    }
  };
  const show = () => {
    if (!host() || !key || !available() && !opened) return false;
    if (opened) { input()?.focus({ preventScroll: true }); input()?.select(); return true; }
    opened = true; focus = 'input'; jump = Boolean(query); deps.render(); return true;
  };
  const close = () => { opened = false; focus = 'trigger'; deps.render(); };
  const step = (direction: number) => { if (matches.length) { active = (active + direction + matches.length) % matches.length; jump = true; update(); } };
  return {
    reset, renderBody,
    snapshot: (): MailFindSnapshot | null => key ? { key, body, opened, query, active } : null,
    restore(saved: MailFindSnapshot | null): boolean {
      if (!saved || !key || saved.key !== key) return false;
      opened = saved.opened; query = saved.query; active = saved.body === body ? saved.active : 0;
      focus = null; selection = null; jump = false; search(); return true;
    },
    setMessage(nextKey: string | null, nextBody: string | null, truncated = false) {
      if (nextKey === key && nextBody === body && truncated === partial) return;
      if (nextKey !== key) { reset(); key = nextKey; }
      body = nextBody; partial = truncated; search();
    },
    renderTrigger: () => `<button type="button" class="data-button" ${e(deps.actionAttr)}="${MAIL_FIND_ACTION}open" data-mail-focus="find-open" aria-expanded="${opened}"${available() ? '' : ' disabled'}>Find in email</button>`,
    renderBar: (): string => !opened || !key ? '' : `<div class="data-mail-find" data-mail-find-bar role="search" aria-label="Find in this email">
      <label for="mail-find-query">Find in this email</label>
      <div class="data-mail-find-controls"><input id="mail-find-query" type="search" ${INPUT} data-mail-focus="find-input" value="${e(query)}" maxlength="512" autocomplete="off" aria-describedby="mail-find-status${partial ? ' mail-find-scope' : ''}">
        <button type="button" class="data-button" ${e(deps.actionAttr)}="${MAIL_FIND_ACTION}previous" data-mail-find-step data-mail-focus="find-previous" aria-label="Previous match"${matches.length ? '' : ' disabled'}>↑</button>
        <button type="button" class="data-button" ${e(deps.actionAttr)}="${MAIL_FIND_ACTION}next" data-mail-find-step data-mail-focus="find-next" aria-label="Next match"${matches.length ? '' : ' disabled'}>↓</button>
        <button type="button" class="data-button" ${e(deps.actionAttr)}="${MAIL_FIND_ACTION}close" data-mail-focus="find-close" aria-label="Close find">×</button></div>
      <div class="data-mail-find-summary"><span id="mail-find-status" data-mail-find-status role="status" aria-live="polite">${e(status())}</span>
        ${deps.onSearchEverywhere ? `<button type="button" class="data-button" ${e(deps.actionAttr)}="${MAIL_FIND_ACTION}everywhere" data-mail-find-everywhere data-mail-focus="find-everywhere" aria-label="${e(query.trim() ? `Search everywhere for ${query.trim()}` : 'Search everywhere')}"${query.trim() ? '' : ' disabled'}>Search everywhere</button>` : ''}</div>
      ${partial ? '<p id="mail-find-scope" class="data-mail-message-note">Only the displayed part of this email is searched.</p>' : ''}
    </div>`,
    capture() {
      const field = input(); selection = field && field.ownerDocument.activeElement === field
        ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection } : null;
    },
    mount() {
      if (opened) update();
      const field = input();
      if (focus === 'input') { field?.focus({ preventScroll: true }); field?.select(); }
      else if (focus === 'trigger') host()?.querySelector<HTMLElement>('[data-mail-focus="find-open"]')?.focus({ preventScroll: true });
      else if (field && selection) { field.focus({ preventScroll: true }); if (selection.start !== null && selection.end !== null) field.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined); }
      focus = null; selection = null;
    },
    handleInput(target: HTMLElement): boolean {
      if (!opened || !target.hasAttribute(INPUT) || !host()?.contains(target)) return false;
      const next = (target as HTMLInputElement).value.slice(0, 512);
      if (next !== query) { query = next; active = 0; jump = true; search(); update(true); }
      return true;
    },
    handleAction(action: string, target?: HTMLElement): boolean {
      if (!action.startsWith(MAIL_FIND_ACTION) || !target || !host()?.contains(target)) return false;
      if (action === `${MAIL_FIND_ACTION}open`) show();
      if (action === `${MAIL_FIND_ACTION}close`) close();
      if (opened && (action === `${MAIL_FIND_ACTION}next` || action === `${MAIL_FIND_ACTION}previous`)) { target.focus({ preventScroll: true }); step(action.endsWith('next') ? 1 : -1); }
      if (opened && action === `${MAIL_FIND_ACTION}everywhere` && query.trim()) deps.onSearchEverywhere?.(query.trim());
      return true;
    },
    handleKeyDown(event: KeyboardEvent): boolean {
      const reader = host(), target = event.target as HTMLElement | null;
      if (!reader || !target || !reader.contains(target) || event.isComposing || event.defaultPrevented
        || target.closest('.data-mail-attachments')) return false;
      const owned = target.hasAttribute(INPUT);
      if (!owned && target.closest('input,textarea,select,[contenteditable]')) return false;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        if (!show()) return false;
        event.preventDefault(); event.stopPropagation(); return true;
      }
      if (opened && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
      if (opened && owned && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); step(event.shiftKey ? -1 : 1); return true; }
      return false;
    },
  };
};

export const MAIL_FIND_STYLES = `
.data-mail-find { position:sticky; top:8px; z-index:2; min-width:0; display:grid; gap:8px; padding:12px; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
.data-mail-find label { font-size:13px; font-weight:600; }
.data-mail-find-controls { display:flex; gap:6px; min-width:0; }
.data-mail-find-controls input { flex:1; min-width:0; width:100%; min-height:44px; padding:8px; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:6px; }
.data-mail-find-controls .data-button { flex:none; min-width:44px; min-height:44px; }
.data-mail-find-summary { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:6px; font-size:13px; }
.data-mail-find-summary .data-button { min-height:44px; }
[data-mail-message-body] mark { color:var(--fg); background:color-mix(in srgb,var(--accent) 20%,var(--surface)); scroll-margin-block-start:var(--mail-find-offset,12rem); scroll-margin-block-end:2rem; }
[data-mail-message-body] mark[data-mail-find-current] { outline:2px solid var(--accent); outline-offset:1px; }
`;
