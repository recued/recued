import type { CollectionRecord } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { mailInboxHasFilters, type createMailInbox } from './mail-inbox.js';

export const MAIL_READER_ACTION = 'mail-reader-';
export const MAIL_READER_FOCUS = 'data-mail-reader-focus';
type Inbox = Pick<ReturnType<typeof createMailInbox>, 'snapshot' | 'more'>;

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
  let visit: { view: View; filters: string; scope: string; ids: string[]; index: number } | null = null;
  let generation = 0, moving = false, error = '';
  const current = (): View | null => {
    const view = deps.inbox.snapshot();
    return visit && view === visit.view && JSON.stringify(view.filters) === visit.filters
      && (deps.scope?.() ?? '') === visit.scope ? view : null;
  };
  const records = (view: View) => deps.records?.() ?? view.records;
  const more = (view: View) => view.hasMore && (deps.canPage?.() ?? true);
  const reset = () => { generation++; visit = null; moving = false; error = ''; };
  const move = async (direction: -1 | 1): Promise<void> => {
    const view = current(), owner = visit;
    if (!owner || !view || moving || deps.isReading() || !deps.beforeLeave()) return;
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
    handle(action: string): boolean {
      if (!action.startsWith(MAIL_READER_ACTION)) return false;
      if (action === 'mail-reader-previous') void move(-1);
      if (action === 'mail-reader-next') void move(1);
      return true;
    },
    render(actionAttr: string): string {
      const view = current();
      if (!view || !visit) return '';
      const pending = moving || deps.isReading();
      const button = (direction: 'previous' | 'next', unavailable: boolean) => `<button type="button" class="data-button" ${actionAttr}="mail-reader-${direction}" ${MAIL_READER_FOCUS}="${direction}"${unavailable ? ' disabled' : pending ? ' aria-disabled="true" aria-busy="true"' : ''}>${direction === 'previous' ? '<span aria-hidden="true">←</span> Previous email' : 'Next email <span aria-hidden="true">→</span>'}</button>`;
      return `<nav class="mail-reader-navigation" aria-label="Browse inbox emails">
        <div class="mail-reader-navigation-controls">${button('previous', visit.index === 0)}${button('next', visit.index === visit.ids.length - 1 && !more(view))}<span class="mail-reader-navigation-position">${mailInboxHasFilters(view.filters) || visit.scope && visit.scope !== 'all' ? 'Filtered inbox' : 'Inbox'} · ${visit.index + 1} of ${visit.ids.length}${more(view) ? '+' : ''} loaded</span></div>
        ${moving ? '<p role="status">Opening email…</p>' : ''}${error ? `<p role="alert">${e(error)}</p>` : ''}
      </nav>`;
    },
    captureFocus: (active: HTMLElement | null | undefined) => active?.getAttribute?.(MAIL_READER_FOCUS) ?? null,
    restoreFocus(root: HTMLElement, key: string | null): void {
      if (!key || !current()) return;
      (root.querySelector<HTMLElement>(`[${MAIL_READER_FOCUS}="${key}"]:not([disabled])`)
        ?? root.querySelector<HTMLElement>(`[${MAIL_READER_FOCUS}]:not([disabled])`))?.focus({ preventScroll: true });
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
`;
