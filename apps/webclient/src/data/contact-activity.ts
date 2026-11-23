import { decodeTimelineCursor, originActorPassesTimelineFilter, type Actor, type TimelineEntry, type TimelineRequest, type TimelineResponse } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const CONTACT_ACTIVITY_PAGE_SIZE = 50;
export const CONTACT_ACTIVITY_FOCUS = 'data-contact-activity-focus';
type Filters = { range: 'all' | 'week' | 'month' | 'custom'; actor: 'all' | Actor; from: string; through: string };
type Position = { scrollTop: number; offset?: number; focus?: string };
type Resume = { filters: Filters; draft: Filters; pages: number; position?: Position };
type Memory = Map<string, Resume>;
const memories = new WeakMap<object, Memory>();
/** Only navigation hints survive a route mount; event payloads and cursors do not. */
export const contactActivityMemory = (owner: object): Memory => {
  let memory = memories.get(owner); if (!memory) { memory = new Map(); memories.set(owner, memory); } return memory;
};
type Caller = (request: TimelineRequest) => Promise<TimelineResponse>;
const dayText = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const day = (text: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Choose valid From and Through dates.');
  const [year, month, date] = text.split('-').map(Number);
  const result = new Date(0); result.setFullYear(year!, month! - 1, date!); result.setHours(0, 0, 0, 0);
  if (dayText(result) !== text) throw new Error('Choose valid From and Through dates.');
  return result;
};
const defaults = (now: number): Filters => ({ range: 'all', actor: 'all', from: dayText(new Date(now)), through: dayText(new Date(now)) });
const queryFor = (filters: Filters, now: number): Omit<TimelineRequest, 'entity_id' | 'limit' | 'cursor'> => {
  let since: number | undefined, until: number | undefined;
  if (filters.range !== 'all') {
    const start = filters.range === 'custom' ? day(filters.from) : day(dayText(new Date(now)));
    const end = filters.range === 'custom' ? day(filters.through) : day(dayText(new Date(now)));
    if (filters.range !== 'custom') start.setDate(start.getDate() - (filters.range === 'week' ? 6 : 29));
    if (start.getTime() > end.getTime()) throw new Error('From must be on or before Through.');
    end.setDate(end.getDate() + 1); since = start.getTime(); until = end.getTime();
  }
  return { ...(since !== undefined ? { since, until } : {}), ...(filters.actor !== 'all' ? { origin_actors: [filters.actor] } : {}) };
};
const filtered = (filters: Filters): boolean => filters.range !== 'all' || filters.actor !== 'all';
const validatePage = (response: TimelineResponse, request: TimelineRequest): void => {
  if (!response || !Array.isArray(response.entries) || response.entries.length > CONTACT_ACTIVITY_PAGE_SIZE) throw new Error('The activity page could not be confirmed. Refresh activity.');
  const before = request.cursor ? decodeTimelineCursor(request.cursor) : null;
  let previous = before?.last_ts ?? Infinity;
  for (const entry of response.entries) {
    if (!entry || !Number.isFinite(entry.ts) || entry.ts > previous || request.since !== undefined && entry.ts < request.since
      || request.until !== undefined && entry.ts >= request.until || !originActorPassesTimelineFilter(entry.origin_actor, request.origin_actors)) {
      throw new Error('Your server did not confirm this activity filter or page. Refresh activity or update the server.');
    }
    previous = entry.ts;
  }
  if (response.next_cursor !== undefined) {
    const next = decodeTimelineCursor(response.next_cursor);
    if (!next || before && !(next.last_ts < before.last_ts || next.last_ts === before.last_ts && next.last_key < before.last_key)
      || response.entries.length > 0 && next.last_ts !== response.entries.at(-1)!.ts) throw new Error('The activity page did not advance. Refresh activity.');
  }
};

export const createContactActivity = (deps: {
  call?: Caller;
  changed: () => void;
  now: () => number;
  memory: Memory;
  renderEntries: (entries: readonly TimelineEntry[], heading: 4 | 5) => string;
  firstPage?: (email: string, response: TimelineResponse) => void;
}) => {
  type View = { email: string; filters: Filters; draft: Filters; query: ReturnType<typeof queryFor>; key: string;
    entries: TimelineEntry[]; pages: number; cursor?: string; loading: boolean; error?: string; validation?: string;
    failed?: { append: boolean; target: number }; restore?: Position };
  let view: View | null = null, generation = 0, disposed = false;
  let pending = Promise.resolve(), focusRequest: { from: string; to: string } | undefined;
  const paint = (): void => { if (!disposed) deps.changed(); };
  const remember = (): void => {
    if (!view) return;
    const old = deps.memory.get(view.email);
    deps.memory.delete(view.email);
    deps.memory.set(view.email, { filters: { ...view.filters }, draft: { ...view.draft }, pages: Math.max(1, view.pages), position: old?.position });
    if (deps.memory.size > 50) deps.memory.delete(deps.memory.keys().next().value!);
  };
  const load = async (append: boolean, target: number, seed?: TimelineResponse, origin?: 'older' | 'retry'): Promise<void> => {
    if (disposed || !view || !deps.call || append && (view.loading || !view.cursor)) return;
    const owner = view, at = ++generation, publish = view.pages === 0, current = () => !disposed && view === owner && generation === at;
    const entries = append ? [...owner.entries] : [], start = owner.entries.length;
    let pages = append ? owner.pages : 0, cursor = append ? owner.cursor : undefined;
    owner.loading = true; if (origin !== 'retry') { owner.error = undefined; owner.failed = undefined; } paint();
    try {
      do {
        const request: TimelineRequest = { entity_id: `contact:${owner.email}`, limit: CONTACT_ACTIVITY_PAGE_SIZE, ...owner.query, ...(cursor ? { cursor } : {}) };
        const response = seed ?? await deps.call(request); seed = undefined;
        if (!current()) return;
        validatePage(response, request);
        if (pages === 0 && !filtered(owner.filters)) deps.firstPage?.(owner.email, response);
        entries.push(...response.entries); pages++; cursor = response.next_cursor;
        if (publish) { owner.entries = [...entries]; owner.pages = pages; owner.cursor = cursor; paint(); }
      } while (cursor && pages < target);
      owner.entries = entries; owner.pages = pages; owner.cursor = cursor; owner.error = undefined; owner.failed = undefined; remember();
      if (origin) focusRequest = { from: origin, to: append && entries.length > start ? `entry:${start}` : 'status' };
    } catch (failure) {
      if (!current()) return;
      owner.error = humanizeRpcError(failure); owner.failed = { append, target };
      if (origin) focusRequest = { from: origin, to: 'retry' };
    } finally { if (current()) { owner.loading = false; paint(); } }
  };
  const open = (email: string, seed: TimelineResponse | null, error?: string): Promise<void> => {
    generation++; const saved = deps.memory.get(email), filters = saved?.filters ?? defaults(deps.now());
    const query = queryFor(filters, deps.now());
    view = { email, filters: { ...filters }, draft: { ...(saved?.draft ?? filters) }, query, key: JSON.stringify([email, query]),
      entries: [], pages: 0, loading: false, restore: saved?.position };
    focusRequest = undefined;
    if (error && !filtered(filters)) {
      view.error = error; view.failed = { append: false, target: saved?.pages ?? 1 }; paint(); return pending = Promise.resolve();
    }
    pending = load(false, saved?.pages ?? 1, filtered(filters) ? undefined : seed ?? undefined); return pending;
  };
  const apply = (reset = false): Promise<void> => {
    if (!view || disposed) return pending;
    const next = reset ? defaults(deps.now()) : { ...view.draft };
    let query: ReturnType<typeof queryFor>;
    try { query = queryFor(next, deps.now()); }
    catch (failure) { view.validation = humanizeRpcError(failure); focusRequest = { from: 'apply', to: 'from' }; paint(); return pending; }
    view.filters = next; view.draft = { ...next }; view.query = query; view.key = JSON.stringify([view.email, query]);
    view.entries = []; view.pages = 0; view.cursor = undefined; view.restore = undefined; view.validation = undefined;
    deps.memory.delete(view.email); remember(); focusRequest = { from: reset ? 'reset' : 'apply', to: 'status' };
    pending = load(false, 1); return pending;
  };
  const focusAttr = (key: string) => `${CONTACT_ACTIVITY_FOCUS}="${e(key)}"`;
  const button = (action: string, label: string, blocked = false) => `<button type="button" class="data-button" data-action="contact-activity-${action}" ${focusAttr(action)}${blocked ? ' aria-disabled="true"' : ''}>${e(label)}</button>`;
  const render = (heading: 4 | 5 = 5): string => {
    if (!view || !deps.call) return '';
    const state = view, f = state.draft;
    const options = (values: readonly (readonly [string, string])[], selected: string) => values.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${e(label)}</option>`).join('');
    return `<div class="contact-activity" data-contact-activity-scope="${e(state.key)}">
      <fieldset class="contact-activity-filters"><legend>Filter activity</legend>
        <label>Date range <select class="data-input" data-contact-activity-field="range" ${focusAttr('range')}>${options([['all', 'All time'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['custom', 'Custom dates']], f.range)}</select></label>
        <label>Who acted <select class="data-input" data-contact-activity-field="actor" ${focusAttr('actor')}>${options([['all', 'Everyone'], ['user_self', 'You'], ['system', 'Recued'], ['contracted_user', 'Contracted agents'], ['anonymous', 'Visitors']], f.actor)}</select></label>
        ${f.range === 'custom' ? `<label>From <input type="date" class="data-input" data-contact-activity-field="from" ${focusAttr('from')} value="${e(f.from)}"></label><label>Through <input type="date" class="data-input" data-contact-activity-field="through" ${focusAttr('through')} value="${e(f.through)}"></label>` : ''}
        <div class="contact-activity-buttons">${button('apply', 'Apply filters')}${button('reset', 'Reset filters')}${button('refresh', 'Refresh activity', state.loading)}</div>
      </fieldset><p class="contact-activity-hint">Dates use your local time and include the whole Through day. Last 7 and 30 days include today.</p>
      ${state.validation ? `<p role="alert">${e(state.validation)}</p>` : ''}
      <p role="status" tabindex="-1" ${focusAttr('status')}>${state.loading ? `${state.pages ? `${state.entries.length} events shown. ` : ''}Loading activity…` : state.pages ? `${state.entries.length} event${state.entries.length === 1 ? '' : 's'} shown.${state.cursor ? ' Older activity is available.' : ''}` : 'Activity has not been loaded.'}${JSON.stringify(f) !== JSON.stringify(state.filters) ? ' Filters have unapplied changes.' : ''}</p>
      ${state.error ? `<p role="alert">Activity could not be ${state.failed?.append ? 'extended' : 'refreshed'}. ${e(state.error)}${state.pages ? ' Previously loaded activity remains below.' : ''}</p>${button('retry', state.loading ? 'Retrying activity…' : 'Retry activity', state.loading)}` : ''}
      ${state.entries.length ? deps.renderEntries(state.entries, heading) : state.pages && !state.loading && !state.error ? `<h${heading} class="memory-entity-detail-section-title">Timeline</h${heading}><p>${state.cursor ? 'No matching activity in the pages checked so far. Load older activity to continue.' : filtered(state.filters) ? 'No activity matches these filters.' : 'No timeline events yet.'}</p>` : ''}
      ${state.cursor && !state.error ? button('older', state.loading ? 'Loading older activity…' : 'Load older activity', state.loading) : ''}
    </div>`;
  };
  const capture = (root: ParentNode, host: Element | null, active?: Element | null): Position | undefined => {
    const area = root.querySelector<HTMLElement>('[data-contact-activity-scope]');
    if (!view || !host || !area) return undefined;
    const owned = area.getAttribute('data-contact-activity-scope') === view.key;
    if (!owned) {
      try { if (JSON.parse(area.getAttribute('data-contact-activity-scope') ?? '[]')[0] !== view.email) return undefined; } catch { return undefined; }
    }
    const rect = area.getBoundingClientRect?.(), bounds = host.getBoundingClientRect?.();
    const isDocument = host === host.ownerDocument.scrollingElement;
    const top = isDocument ? 0 : bounds?.top ?? 0, bottom = isDocument ? host.ownerDocument.defaultView?.innerHeight ?? 0 : bounds?.bottom ?? 0;
    const focus = area.contains(active ?? null) ? active?.closest(`[${CONTACT_ACTIVITY_FOCUS}]`)?.getAttribute(CONTACT_ACTIVITY_FOCUS)
      ?? (active?.closest('[data-contact-activity-entry]')?.getAttribute('data-contact-activity-entry') != null ? `entry:${active!.closest('[data-contact-activity-entry]')!.getAttribute('data-contact-activity-entry')}` : undefined) : undefined;
    const position: Position = { scrollTop: host.scrollTop, ...(rect && rect.top < bottom && rect.bottom > top ? { offset: rect.top - top } : {}), ...(focus ? { focus } : {}) };
    const saved = deps.memory.get(view.email);
    if (owned && view.pages > 0 && !view.restore && saved) saved.position = position;
    return owned && !view.restore ? position : { scrollTop: host.scrollTop, ...(focus ? { focus } : {}) };
  };
  const restore = (root: ParentNode, host: Element | null, previous?: Position): void => {
    const area = root.querySelector<HTMLElement>('[data-contact-activity-scope]');
    if (!view || !host || area?.getAttribute('data-contact-activity-scope') !== view.key) return;
    const rows = [...area.querySelectorAll<HTMLElement>('.memory-timeline-entry')];
    rows.forEach((row, index) => { row.setAttribute('data-contact-activity-entry', String(index)); row.tabIndex = -1; });
    const saved = view.pages > 0 && !view.loading && !view.error ? view.restore : undefined;
    const position = saved ?? previous;
    const request = focusRequest; focusRequest = undefined;
    const key = request && previous?.focus === request.from ? request.to : position?.focus;
    if (key) {
      const control = key.startsWith('entry:') ? rows[Number(key.slice(6))]
        : [...area.querySelectorAll<HTMLElement>(`[${CONTACT_ACTIVITY_FOCUS}]`)].find(node => node.getAttribute(CONTACT_ACTIVITY_FOCUS) === key);
      control?.focus({ preventScroll: true });
    }
    if (position) {
      if (position.offset !== undefined && area.getBoundingClientRect && host.getBoundingClientRect) {
        const top = host === host.ownerDocument.scrollingElement ? 0 : host.getBoundingClientRect().top;
        host.scrollTop += area.getBoundingClientRect().top - top - position.offset;
      } else host.scrollTop = position.scrollTop;
    }
    if (saved) { view.restore = undefined; const resume = deps.memory.get(view.email); if (resume) resume.position = saved; }
  };
  return {
    enabled: () => !!deps.call,
    email: () => view?.email,
    open, apply, render, capture, restore,
    snapshot: () => view,
    whenLoaded: () => pending,
    holdsList: () => !!view && (view.loading || view.pages > 1 || filtered(view.filters) || !!view.error || JSON.stringify(view.draft) !== JSON.stringify(view.filters)),
    close() { generation++; view = null; focusRequest = undefined; },
    cancelRestore() { if (view) view.restore = undefined; },
    setField(field: string, value: string): boolean {
      if (!view) return false;
      if (field === 'range' && ['all', 'week', 'month', 'custom'].includes(value)) view.draft.range = value as Filters['range'];
      else if (field === 'actor' && ['all', 'user_self', 'system', 'contracted_user', 'anonymous'].includes(value)) view.draft.actor = value as Filters['actor'];
      else if (field === 'from' || field === 'through') view.draft[field] = value;
      else return false;
      view.validation = undefined; view.restore = undefined; remember(); return true;
    },
    handleAction(action: string): boolean {
      if (!action.startsWith('contact-activity-') || !view) return false;
      const command = action.slice('contact-activity-'.length);
      if (command === 'apply' || command === 'reset') void apply(command === 'reset');
      else if (command === 'older' && !view.loading && view.cursor) pending = load(true, view.pages + 1, undefined, 'older');
      else if (command === 'retry' && !view.loading && view.failed) pending = load(view.failed.append, view.failed.target, undefined, 'retry');
      else if (command === 'refresh' && !view.loading) { view.query = queryFor(view.filters, deps.now()); view.key = JSON.stringify([view.email, view.query]); pending = load(false, Math.max(1, view.pages)); }
      return true;
    },
    dispose() { disposed = true; generation++; view = null; },
  };
};

export const CONTACT_ACTIVITY_STYLES = `
.contact-activity { min-width:0; display:grid; gap:.75rem; }
.contact-activity-filters { min-width:0; display:flex; align-items:end; flex-wrap:wrap; gap:.75rem; padding:.75rem; border:1px solid var(--border); border-radius:.5rem; }
.contact-activity-filters label { display:grid; gap:.35rem; min-width:0; font-size:.85rem; }
.contact-activity-filters select,.contact-activity-filters input { min-height:44px; max-width:100%; box-sizing:border-box; }
.contact-activity-buttons { display:flex; flex-wrap:wrap; gap:.5rem; }
.contact-activity p { margin:0; }
.contact-activity-hint { color:var(--fg-muted); font-size:.85rem; }
.contact-activity [role=alert] { color:var(--danger); }
.contact-activity [aria-disabled=true] { opacity:.65; cursor:progress; }
@media(max-width:600px) { .contact-activity-filters { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); } .contact-activity-buttons { grid-column:1 / -1; } }
`;
