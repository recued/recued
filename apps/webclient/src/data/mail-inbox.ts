import type { CollectionListQuery, CollectionRecord } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const MAIL_INBOX_PAGE_SIZE = 30;
export interface MailInboxFilters {
  status: 'all' | 'unread' | 'starred';
  direction: 'all' | 'received' | 'sent';
  attachments: boolean;
}
export const defaultMailInboxFilters = (): MailInboxFilters => ({ status: 'all', direction: 'all', attachments: false });
export const mailInboxHasFilters = (filters: MailInboxFilters): boolean =>
  filters.status !== 'all' || filters.direction !== 'all' || filters.attachments;
export const mailInboxQueryFilters = (filters: MailInboxFilters): Record<string, unknown> => ({
  ...(filters.status === 'unread' ? { is_read: false } : filters.status === 'starred' ? { is_flagged: true } : {}),
  ...(filters.direction !== 'all' ? { direction: filters.direction === 'sent' ? 'outbound' : 'inbound' } : {}),
  ...(filters.attachments ? { has_attachments: true } : {}),
});
export const mailInboxMatches = (row: CollectionRecord, filters: MailInboxFilters): boolean =>
  Object.entries(mailInboxQueryFilters(filters)).every(([key, value]) => typeof value === 'boolean'
    ? row.hot_fields[key] === value || row.hot_fields[key] === Number(value) : row.hot_fields[key] === value);

export interface MailInboxPosition {
  recordId: string;
  nearby: string[];
  scrollTop: number;
  hash: string;
}
interface Resume { filters: MailInboxFilters; pages: number; position?: MailInboxPosition }
interface InboxMemory { selectedSlug?: string; views: Map<string, Resume> }
const memories = new WeakMap<object, InboxMemory>();
/** The bootstrap's owner belongs to one paired server. Keep navigation hints
 * in memory across route mounts, without caching message content or using URLs. */
export const mailInboxMemory = (owner: object): InboxMemory => {
  let memory = memories.get(owner);
  if (!memory) { memory = { views: new Map() }; memories.set(owner, memory); }
  return memory;
};
type Cursor = NonNullable<CollectionListQuery['before']>;
type List = (query: CollectionListQuery) => Promise<{ records: CollectionRecord[] }>;
interface Mailbox {
  slug: string;
  filters: MailInboxFilters;
  records: CollectionRecord[];
  pages: number;
  cursor?: Cursor;
  hasMore: boolean;
  loading: boolean;
  error?: string;
  failed?: { more: boolean; pages: number };
}
const compareId = (left: string, right: string): number => {
  // SQLite's BINARY collation compares UTF-8 bytes, unlike JS string ordering.
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
};
const olderThan = (row: Cursor, before: Cursor): boolean => row.received_at < before.received_at
  || row.received_at === before.received_at && compareId(row.record_id, before.record_id) < 0;
const validatePage = (records: CollectionRecord[], filters: MailInboxFilters, before?: Cursor): void => {
  if (!Array.isArray(records) || records.length > MAIL_INBOX_PAGE_SIZE + 1) throw new Error('The mail page could not be confirmed. Refresh messages.');
  const ids = new Set<string>();
  let previous = before;
  for (const row of records) {
    if (!row || typeof row.record_id !== 'string' || !row.record_id || !Number.isSafeInteger(row.received_at)
      || !row.hot_fields || ids.has(row.record_id) || previous && !olderThan(row, previous)) {
      throw new Error('The mail page did not advance correctly. Refresh messages or update your server.');
    }
    if (!mailInboxMatches(row, filters)) throw new Error('Your server could not confirm these mail filters. Refresh messages or update your server.');
    ids.add(row.record_id); previous = row;
  }
};

export const createMailInbox = (list: List | undefined, changed: () => void, memory: InboxMemory = { views: new Map() }) => {
  const views = new Map<string, Mailbox>();
  let slug: string | null = null, generation = 0, disposed = false;
  const remember = (view: Mailbox): void => {
    memory.views.set(view.slug, { ...memory.views.get(view.slug), filters: { ...view.filters }, pages: Math.max(1, view.pages) });
  };
  const viewFor = (id: string): Mailbox => {
    let view = views.get(id);
    if (!view) {
      view = { slug: id, filters: { ...(memory.views.get(id)?.filters ?? defaultMailInboxFilters()) }, records: [],
        pages: 0, hasMore: false, loading: false };
      views.set(id, view);
    }
    return view;
  };
  const current = (): Mailbox | null => slug === null ? null : viewFor(slug);
  const load = async (view: Mailbox, more: boolean, pages: number): Promise<void> => {
    if (!list || disposed || more && (view.loading || !view.cursor || !view.hasMore)) return;
    const at = ++generation, filters = { ...view.filters };
    view.loading = true; view.error = undefined; view.failed = undefined; changed();
    let cursor = more ? view.cursor : undefined;
    const records = more ? [...view.records] : [];
    const ids = new Set(records.map(row => row.record_id));
    let loaded = more ? view.pages : 0, hasMore = false;
    try {
      for (let page = 0; page < (more ? 1 : pages); page++) {
        const response = await list({ platform: 'mail', slug: view.slug, filters: mailInboxQueryFilters(filters),
          limit: MAIL_INBOX_PAGE_SIZE + 1, ...(cursor ? { before: cursor } : {}) });
        if (disposed || at !== generation) return;
        validatePage(response.records, filters, cursor);
        const rows = response.records.slice(0, MAIL_INBOX_PAGE_SIZE);
        for (const row of rows) {
          if (ids.has(row.record_id)) throw new Error('The mail page repeated a message. Refresh messages.');
          ids.add(row.record_id); records.push(row);
        }
        loaded++; hasMore = response.records.length > MAIL_INBOX_PAGE_SIZE;
        const last = rows.at(-1);
        cursor = hasMore && last ? { received_at: last.received_at, record_id: last.record_id } : undefined;
        if (!cursor) break;
      }
      view.records = records; view.pages = loaded; view.cursor = cursor; view.hasMore = hasMore;
      remember(view);
    } catch (cause) {
      if (disposed || at !== generation) return;
      view.error = humanizeRpcError(cause); view.failed = { more, pages };
    } finally {
      if (!disposed && at === generation) { view.loading = false; changed(); }
    }
  };
  return {
    snapshot: current,
    selectedSlug: () => memory.selectedSlug,
    async select(id: string) {
      generation++; for (const view of views.values()) view.loading = false;
      slug = id; memory.selectedSlug = id;
      const view = viewFor(id);
      await load(view, false, Math.max(1, view.pages || memory.views.get(id)?.pages || 1));
    },
    async filter(filters: MailInboxFilters) {
      const view = current(); if (!view || disposed) return;
      view.filters = { ...filters }; view.records = []; view.pages = 0; view.cursor = undefined; view.hasMore = false;
      remember(view);
      memory.views.get(view.slug)!.position = undefined;
      await load(view, false, 1);
    },
    refresh: () => { const view = current(); return view && !view.loading ? load(view, false, Math.max(1, view.pages)) : Promise.resolve(); },
    more: () => { const view = current(); return view ? load(view, true, 1) : Promise.resolve(); },
    retry: () => { const view = current(); return view?.failed && !view.loading ? load(view, view.failed.more, view.failed.pages) : Promise.resolve(); },
    reconcile(record: CollectionRecord) {
      const view = current(); if (!view || !view.records.some(row => row.record_id === record.record_id)) return;
      if (view.loading) { generation++; view.loading = false; }
      view.records = view.records.map(row => row.record_id === record.record_id ? record : row)
        .filter(row => mailInboxMatches(row, view.filters));
      changed();
    },
    position: () => slug ? memory.views.get(slug)?.position : undefined,
    rememberPosition(position: MailInboxPosition) {
      const view = current(); if (!view) return;
      remember(view); memory.views.get(view.slug)!.position = position;
    },
    cancel() { generation++; for (const view of views.values()) view.loading = false; },
    dispose() { disposed = true; generation++; },
  };
};

type InboxState = NonNullable<ReturnType<ReturnType<typeof createMailInbox>['snapshot']>>;
export const renderMailInboxControls = (state: InboxState, action: string, disabled = false): string => {
  const option = (value: string, label: string, selected: string) => `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`;
  return `<section data-mail-inbox>
    <fieldset class="mail-inbox-filters"${disabled ? ' disabled' : ''}><legend>Filter saved mail</legend>
      <div class="mail-inbox-fields">
      <label>Message status <select class="data-input" data-mail-inbox-field="status" aria-label="Message status">
        ${option('all', 'All messages', state.filters.status)}${option('unread', 'Unread', state.filters.status)}${option('starred', 'Starred', state.filters.status)}</select></label>
      <label>Mail direction <select class="data-input" data-mail-inbox-field="direction" aria-label="Mail direction">
        ${option('all', 'Received and sent', state.filters.direction)}${option('received', 'Received', state.filters.direction)}${option('sent', 'Sent', state.filters.direction)}</select></label>
      </div>
      <label class="mail-inbox-attachments"><input type="checkbox" data-mail-inbox-field="attachments"${state.filters.attachments ? ' checked' : ''}> Has attachments</label>
      <div class="mail-inbox-filter-actions">
      <button type="button" class="data-button" ${action}="mail-inbox-reset"${mailInboxHasFilters(state.filters) ? '' : ' disabled'}>Reset filters</button>
      <button type="button" class="data-button" ${action}="mail-inbox-refresh"${disabled ? ' disabled' : state.loading ? ' aria-disabled="true"' : ''}>Refresh messages</button>
      </div>
    </fieldset>
    <p role="status" tabindex="-1" data-mail-inbox-status>${state.pages ? `${state.records.length} saved message${state.records.length === 1 ? '' : 's'} shown${mailInboxHasFilters(state.filters) ? ' matching these filters' : ''}.` : state.loading ? 'Loading saved messages…' : 'Saved messages have not been loaded.'}${state.loading && state.pages ? ' Checking messages…' : ''}</p>
  </section>`;
};
export const renderMailInboxFooter = (state: InboxState, action: string, disabled = false): string => state.error && state.pages > 0
  ? `<p role="alert">Saved messages could not be checked. ${e(state.error)}${state.pages ? ' The previous results are still shown.' : ''}
      <button type="button" class="data-button" ${action}="mail-inbox-retry"${disabled ? ' disabled' : state.loading ? ' aria-disabled="true"' : ''}>Retry messages</button></p>`
  : state.hasMore ? `<button type="button" class="data-button" ${action}="mail-inbox-more"${disabled ? ' disabled' : state.loading ? ' aria-disabled="true"' : ''}>${state.loading ? 'Loading messages…' : 'Load more messages'}</button>` : '';

export const MAIL_INBOX_STYLES = `
[data-mail-inbox] { margin-block: 12px; min-width: 0; }
.mail-inbox-filters { display:flex; flex-wrap:wrap; align-items:end; gap:12px; margin:0; padding:12px; border:1px solid var(--border); border-radius:var(--wc-radius,9px); min-width:0; }
.mail-inbox-filters legend { max-width:100%; padding:0 4px; color:var(--fg-muted); font-size:12px; font-weight:600; overflow-wrap:anywhere; }
.mail-inbox-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); flex:1 1 24rem; gap:12px; min-width:0; }
.mail-inbox-fields label { display:grid; gap:4px; min-width:0; color:var(--fg-muted); font-size:12px; }
.mail-inbox-fields select { box-sizing:border-box; width:100%; min-width:0; min-height:var(--wc-control-h,44px); max-width:100%; }
.mail-inbox-attachments { display:flex; align-items:center; gap:8px; min-height:var(--wc-control-h,44px); font-size:13px; white-space:nowrap; }
.mail-inbox-attachments input { flex:none; margin:0; }
.mail-inbox-filter-actions { display:flex; flex-wrap:wrap; gap:8px; margin-inline-start:auto; max-width:100%; }
.mail-inbox-filter-actions button { min-height:var(--wc-control-h,44px); }
[data-mail-inbox-status] { margin:8px 0 0; color:var(--fg-muted); font-size:12px; line-height:1.45; }
@media(max-width:600px) {
  .mail-inbox-filters { display:grid; grid-template-columns:minmax(0,1fr); gap:8px; }
  .mail-inbox-fields { gap:8px; }
  .mail-inbox-filter-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); margin-inline-start:0; }
  .mail-inbox-filter-actions button { width:100%; }
}
@media(max-width:380px) {
  .mail-inbox-fields,.mail-inbox-filter-actions { grid-template-columns:minmax(0,1fr); }
}
`;
