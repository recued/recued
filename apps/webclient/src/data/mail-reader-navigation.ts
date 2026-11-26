import type { CollectionRecord } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { COLLECTION_RECORD_ID_ATTR, renderMailRow } from './collection-explorer.js';
import { mailInboxHasFilters, type createMailInbox } from './mail-inbox.js';

export const MAIL_READER_ACTION = 'mail-reader-';
export const MAIL_READER_OPEN_ACTION = 'mail-reader-open';
export const MAIL_READER_FOCUS = 'data-mail-reader-focus';
export const MAIL_READING_PANE_MEDIA = '(min-width: 1280px) and (hover: hover) and (pointer: fine)';
const INBOX_SCROLL = '[data-mail-reader-inbox-scroll]';
const INBOX_FOCUS_PREFIX = 'inbox:';
type Inbox = Pick<ReturnType<typeof createMailInbox>, 'snapshot' | 'more'>;

const revealInboxRow = (list: HTMLElement, selected: HTMLElement): void => {
  const bounds = list.getBoundingClientRect(), row = selected.getBoundingClientRect();
  if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
  else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
};

/** The inbox order belongs to this reader visit. Keep the anchor even when a
 * status update removes its row from an Unread or Starred list. */
export const createMailReaderNavigation = (deps: {
  inbox: Inbox;
  records?: () => readonly CollectionRecord[];
  scope?: () => string;
  canPage?: () => boolean;
  beforeLeave: () => boolean;
  isReading: () => boolean;
  open: (recordId: string) => Promise<void>;
  changed: () => void;
}) => {
  type View = NonNullable<ReturnType<Inbox['snapshot']>>;
  let visit: { view: View; filters: string; scope: string; ids: string[]; index: number;
    scrollTop?: number; selectedInPane?: string; focusedRow?: string } | null = null;
  let generation = 0, moving = false, error = '';
  const current = (): View | null => {
    const view = deps.inbox.snapshot();
    return visit && view === visit.view && JSON.stringify(view.filters) === visit.filters
      && (deps.scope?.() ?? '') === visit.scope ? view : null;
  };
  const records = (view: View) => deps.records?.() ?? view.records;
  const more = (view: View) => view.hasMore && (deps.canPage?.() ?? true);
  const isBusy = () => moving || deps.isReading();
  const reset = () => { generation++; visit = null; moving = false; error = ''; };
  const move = async (direction: -1 | 1): Promise<void> => {
    const view = current(), owner = visit;
    if (!owner || !view || isBusy() || !deps.beforeLeave()) return;
    if (direction === -1 && owner.index === 0 || direction === 1 && owner.index === owner.ids.length - 1 && !more(view)) return;
    const sequence = ++generation;
    const valid = () => sequence === generation && visit === owner && current() === view;
    moving = true; error = ''; deps.changed();
    try {
      if (direction === 1 && owner.index === owner.ids.length - 1 && more(view)) {
        const pages = view.pages;
        await deps.inbox.more();
        if (!valid()) return;
        if (view.error) throw new Error(view.error);
        if (view.pages === pages && more(view)) throw new Error('The inbox changed while loading. Try Next email again.');
        const known = new Set(owner.ids);
        owner.ids.push(...records(view).map(row => row.record_id).filter(id => !known.has(id)));
      }
      const target = owner.ids[owner.index + direction];
      if (!target || !valid() || !deps.beforeLeave()) return;
      owner.index += direction;
      await deps.open(target);
    } catch (cause) { if (valid()) error = humanizeRpcError(cause); }
    finally { if (valid()) { moving = false; deps.changed(); } }
  };
  return {
    reset,
    busy: () => moving,
    owns: (slug: string, id: string) => current()?.slug === slug && visit!.ids.includes(id),
    select(id: string) { if (visit && current()) { const index = visit.ids.indexOf(id); if (index >= 0) visit.index = index; } },
    start(slug: string, id: string): void {
      reset();
      const view = deps.inbox.snapshot();
      if (!view || view.slug !== slug || !view.pages || view.loading) return;
      const ids = records(view).map(row => row.record_id), index = ids.indexOf(id);
      if (index < 0) return;
      visit = { view, filters: JSON.stringify(view.filters), scope: deps.scope?.() ?? '', ids, index };
    },
    handle(action: string, recordId?: string | null, currentRecordId?: string): boolean {
      if (!action.startsWith(MAIL_READER_ACTION)) return false;
      if (action === 'mail-reader-previous') void move(-1);
      if (action === 'mail-reader-next') void move(1);
      if (action === MAIL_READER_OPEN_ACTION && recordId && recordId !== currentRecordId) {
        const view = current();
        if (view && visit?.ids.includes(recordId) && !isBusy()
          && records(view).some(row => row.record_id === recordId) && deps.beforeLeave()) {
          error = '';
          void deps.open(recordId);
        }
      }
      return true;
    },
    render(actionAttr: string): string {
      const view = current();
      if (!view || !visit) return '';
      const pending = isBusy();
      const button = (direction: 'previous' | 'next', unavailable: boolean) => `<button type="button" class="data-button" ${actionAttr}="mail-reader-${direction}" ${MAIL_READER_FOCUS}="${direction}"${unavailable ? ' disabled' : pending ? ' aria-disabled="true" aria-busy="true"' : ''}>${direction === 'previous' ? '<span aria-hidden="true">←</span> Previous email' : 'Next email <span aria-hidden="true">→</span>'}</button>`;
      return `<nav class="mail-reader-navigation" aria-label="Browse inbox emails">
        <div class="mail-reader-navigation-controls">${button('previous', visit.index === 0)}${button('next', visit.index === visit.ids.length - 1 && !more(view))}<span class="mail-reader-navigation-position">${mailInboxHasFilters(view.filters) || visit.scope && visit.scope !== 'all' ? 'Filtered inbox' : 'Inbox'} · ${visit.index + 1} of ${visit.ids.length}${more(view) ? '+' : ''} loaded</span></div>
        ${moving ? '<p role="status">Opening email…</p>' : ''}${error ? `<p role="alert">${e(error)}</p>` : ''}
      </nav>`;
    },
    renderPane(actionAttr: string, recordId: string, reader: string): string {
      const view = current();
      if (!view || !visit) return reader;
      const rows = records(view);
      const ids = rows.map(row => row.record_id);
      const tabStop = [visit.focusedRow, recordId].find(id => id !== undefined && ids.includes(id)) ?? ids[0];
      const filters = [
        view.filters.status === 'unread' ? 'Unread' : view.filters.status === 'starred' ? 'Starred' : '',
        view.filters.direction === 'received' ? 'Received' : view.filters.direction === 'sent' ? 'Sent' : '',
        view.filters.attachments ? 'Has attachments' : '',
        visit.scope === 'professional' ? 'Work' : visit.scope === 'personal' ? 'Personal' : visit.scope === 'unsorted' ? 'Unsorted' : '',
      ].filter(Boolean).join(' · ') || 'All messages';
      const pending = isBusy();
      return `<div class="mail-reading-pane" data-mail-reading-pane>
        <aside class="mail-reading-pane-inbox" aria-label="Inbox messages">
          <header class="mail-reading-pane-header">
            <h2 tabindex="-1" ${MAIL_READER_FOCUS}="inbox">Inbox <span>${e(view.slug)}</span></h2>
            <p>${e(filters)}</p>
            ${ids.includes(recordId) ? '' : '<p role="status">The open message is outside this inbox view.</p>'}
          </header>
          <div class="mail-reading-pane-scroll" data-mail-reader-inbox-scroll>
            <ul class="col-explorer-list" role="list">${rows.map(row => renderMailRow(row, actionAttr, '', false, {
              action: MAIL_READER_OPEN_ACTION, focusAttr: MAIL_READER_FOCUS, current: row.record_id === recordId,
              tabStop: row.record_id === tabStop, busy: pending,
            })).join('')}</ul>
          </div>
        </aside>
        ${reader}
      </div>`;
    },
    capturePaneScroll(root: HTMLElement): void {
      const list = root.querySelector<HTMLElement>(INBOX_SCROLL);
      if (visit && list) visit.scrollTop = list.scrollTop;
    },
    restorePaneScroll(root: HTMLElement): void {
      const list = root.querySelector<HTMLElement>(INBOX_SCROLL);
      if (!visit || !list) return;
      list.scrollTop = visit.scrollTop ?? 0;
      const selected = list.querySelector<HTMLElement>('[aria-current="true"]');
      const id = selected?.getAttribute(COLLECTION_RECORD_ID_ATTR) ?? undefined;
      if (selected && id !== visit.selectedInPane) revealInboxRow(list, selected);
      visit.selectedInPane = id;
    },
    handlePaneKeyDown(event: KeyboardEvent): boolean {
      if (!visit || event.isComposing || event.altKey || event.ctrlKey || event.metaKey
        || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
      const target = event.target as HTMLElement | null;
      const list = target?.closest<HTMLElement>(INBOX_SCROLL);
      if (!target || !list) return false;
      const rows = Array.from(list.querySelectorAll<HTMLElement>(`[${COLLECTION_RECORD_ID_ATTR}]`));
      const index = rows.indexOf(target);
      if (index < 0) return false;
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? rows[index + 1]
        : event.key === 'ArrowUp' ? rows[index - 1]
        : event.key === 'Home' ? rows[0] : rows.at(-1);
      if (next && next !== target) {
        visit.focusedRow = next.getAttribute(COLLECTION_RECORD_ID_ATTR) ?? undefined;
        const previous = list.querySelector<HTMLElement>(`[${COLLECTION_RECORD_ID_ATTR}][tabindex="0"]`);
        if (previous) previous.tabIndex = -1;
        next.tabIndex = 0;
        next.focus({ preventScroll: true });
        revealInboxRow(list, next);
      }
      return true;
    },
    captureFocus(active: HTMLElement | null | undefined): string | null {
      const key = active?.getAttribute?.(MAIL_READER_FOCUS) ?? null;
      if (visit && key?.startsWith(INBOX_FOCUS_PREFIX)) visit.focusedRow = active?.getAttribute(COLLECTION_RECORD_ID_ATTR) ?? undefined;
      return key;
    },
    restoreFocus(root: HTMLElement, key: string | null): void {
      if (!key || !current()) return;
      const targets = Array.from(root.querySelectorAll<HTMLElement>(`[${MAIL_READER_FOCUS}]:not([disabled])`));
      const byKey = (value: string) => targets.find(target => target.getAttribute(MAIL_READER_FOCUS) === value);
      (byKey(key) ?? (key.startsWith(INBOX_FOCUS_PREFIX) ? byKey('inbox') : null)
        ?? byKey('next') ?? byKey('previous'))?.focus({ preventScroll: true });
    },
  };
};

export const MAIL_READER_NAVIGATION_STYLES = `
.mail-reader-navigation { display:grid; gap:.5rem; min-width:0; margin:0; }
.mail-reader-navigation-controls { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; }
.mail-reader-navigation .data-button { min-height:44px; display:inline-flex; align-items:center; gap:.5rem; padding:.5rem .75rem; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:.5rem; cursor:pointer; }
.mail-reader-navigation .data-button:hover:not(:disabled) { background:var(--surface-sunk); border-color:var(--border-strong); }
.mail-reader-navigation .data-button:disabled { opacity:.5; cursor:default; }
.mail-reader-navigation-position { font-size:.8125rem; color:var(--fg-muted); overflow-wrap:anywhere; }
.mail-reader-navigation p { margin:0; font-size:.8125rem; }
.mail-reader-navigation [role="alert"] { color:var(--danger,var(--fg)); }
.mail-reading-pane {
  display:grid; grid-template-columns:clamp(212px, 28%, 272px) minmax(0, 1fr); gap:20px; align-items:start; min-width:0;
}
.mail-reading-pane-inbox {
  position:sticky; top:16px; min-width:0; max-height:clamp(180px, 64dvh, 660px); display:flex; flex-direction:column;
  border:1px solid var(--border); border-radius:var(--wc-radius-lg, 12px); background:var(--surface);
}
.mail-reading-pane-header { padding:12px; border-bottom:1px solid var(--border); }
.mail-reading-pane-header h2 { margin:0; font-size:14px; overflow-wrap:anywhere; }
.mail-reading-pane-header h2 span { margin-inline-start:6px; color:var(--fg-muted); font-weight:500; }
.mail-reading-pane-header p { margin:4px 0 0; color:var(--fg-muted); font-size:12px; line-height:1.4; overflow-wrap:anywhere; }
.mail-reading-pane-scroll { min-height:0; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; padding:6px; }
.mail-reading-pane-inbox .col-explorer-list { gap:3px; }
.mail-reading-pane-inbox .col-explorer-mail-row {
  box-sizing:border-box; gap:4px 8px; padding:8px 10px; border-color:transparent; line-height:1.35;
}
.mail-reading-pane-inbox .col-explorer-mail-row.is-unread { box-shadow:none; }
.mail-reading-pane-inbox .col-explorer-mail-row[aria-current="true"] {
  border-color:var(--border); background:var(--accent-weak, var(--surface-sunk)); box-shadow:inset 3px 0 var(--accent);
}
.mail-reading-pane-inbox .col-explorer-mail-row:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.mail-reading-pane-inbox .col-explorer-mail-subject { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mail-reading-pane-inbox .col-explorer-mail-date,
.mail-reading-pane-inbox .col-explorer-mail-status { font-size:11px; }
.mail-reading-pane .data-mail-conversation-layout { grid-template-columns:minmax(0, 1fr); gap:12px; }
.mail-reading-pane .data-mail-conversation-index {
  z-index:1; grid-template-columns:repeat(auto-fit, minmax(min(100%, 176px), 1fr)); max-height:140px;
  padding:4px; background:var(--surface); border:1px solid var(--border); border-radius:var(--wc-radius, 9px);
}
.mail-reading-pane .data-mail-conversation-index:has(> button:only-child) { display:none; }
`;
