import { savedWorkAddress, savedWorkLinks, savedWorkLinkMatches,
  type SavedWorkAddress, type WorkEntityGetRpcResponse, type LinkedCalendarEvent, type LinkedCalendarPage,
  type WorkEntityLinkedFromItem, type WorkEntityLinkedFromRpcRequest, type WorkEntityLinkedFromRpcResponse } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { recordLink } from '../shell/record-link.js';
import { serializeShellRoute } from '../shell/route.js';
import { allDayEventDays } from '@recued/contracts';
import { calendarTimeLabel, calendarDayLabel } from './calendar-event-actions.js';

type Kind = 'task' | 'note' | 'contact' | 'mail' | 'calendar';
type Owner = { kind: Kind; id: string; identity: string; visit: string; url?: string; source_identity?: WorkEntityLinkedFromRpcRequest['source_identity']; contact_identity?: WorkEntityLinkedFromRpcRequest['contact_identity'] };
export type LinkedFromCaller = (args: WorkEntityLinkedFromRpcRequest) => Promise<WorkEntityLinkedFromRpcResponse>;
const ACTION = 'data-linked-from-action', KEY = 'data-linked-from-key';
const identity = (owner: Owner) => owner.identity;
const focusAttribute = (kind: Kind) => kind === 'contact' ? 'data-contact-quick-focus' : kind === 'mail' || kind === 'calendar' ? 'data-source-linked-focus' : `data-${kind}-focus`;
const ownerUrl = (owner: Owner, href: string) => owner.url ?? recordLink(href, serializeShellRoute('data', owner.kind, owner.id));
const rowKey = (row: WorkEntityLinkedFromItem) => JSON.stringify([row.kind, row.id, row.source_id, row.source_record_id, row.created_at]);
const calendarKey = (row: LinkedCalendarEvent) => 'calendar:' + JSON.stringify([row.slug, row.record_id, row.source_id, row.received_at, row.incarnation]);

/** An index result is a discovery hint. A fresh source read must still identify
 * that saved record and contain the exact link before its reader is opened. */
export const verifyLinkedFromSource = (row: WorkEntityLinkedFromItem, target: SavedWorkAddress, response: WorkEntityGetRpcResponse, referenceIds: readonly string[] = [target.id]): void => {
  const entity = response.entity;
  if (!entity || entity._kind !== row.kind || entity.id !== row.id || entity.source_id !== row.source_id
    || entity.source_record_id !== row.source_record_id || entity.created_at !== row.created_at
    || entity.deleted_at != null || entity.sync_state === 'tombstoned' || entity.sync_state === 'orphaned') {
    throw new Error('This linked record is no longer available. Refresh Linked from.');
  }
  if (!savedWorkLinks(entity.body ?? '').some(link => referenceIds.some(id => savedWorkLinkMatches(link, { ...target, id })))) {
    throw new Error('This record no longer links here. Refresh Linked from.');
  }
};

interface State {
  open: boolean; loaded: boolean; loading: boolean; dirty?: boolean; items: WorkEntityLinkedFromItem[];
  more: boolean; offset: number; providerOnly: string[]; error?: string; openError?: string; opening?: string;
  calendar?: LinkedCalendarPage;
}
/** Paint only the secondary section. Settling a read never rebuilds saved text,
 * Find highlights or the reader's scroll/focus. No metadata goes to storage. */
export const createWorkLinkedFrom = (deps: {
  root: HTMLElement; owner: () => Owner | null; href: () => string; call?: LinkedFromCaller;
  blocked: () => boolean;
  open: (kind: Kind, trigger: HTMLElement, row: WorkEntityLinkedFromItem, target: SavedWorkAddress) => Promise<void>;
  openCalendar?: (trigger: HTMLElement, row: LinkedCalendarEvent, target: SavedWorkAddress) => Promise<void>;
}) => {
  const states = new Map<string, State>();
  let key = '', visit = '', generation = 0, section: HTMLDetailsElement | null = null, state: State | undefined;
  let disposed = false;
  let contactFocus: { binding: string; value: string } | undefined;
  const binding = () => { const owner = deps.owner(); return owner ? identity(owner) + ':' + owner.visit : ''; };
  const current = (captured: string) => !disposed && binding() === captured;
  const paint = () => {
    if (!section?.isConnected || !state) return;
    const owner = deps.owner(); if (!owner || identity(owner) !== key) return;
    const active = deps.root.ownerDocument.activeElement, focusKey = section.contains(active) ? active?.getAttribute(focusAttribute(owner.kind)) : null;
    const summaryFocused = active === section.querySelector('summary');
    const content = section.parentElement, top = content?.scrollTop;
    const kind = owner.kind;
    const button = (action: string, text: string, focus: string, extra = '') => `<button type="button" class="${kind === 'task' || kind === 'note' ? 'work-entity-dialog-cancel' : 'data-button'}" ${ACTION}="${action}" ${focusAttribute(kind)}="linked-from:${e(kind === 'contact' ? encodeURIComponent(focus) : focus)}"${extra}>${e(text)}</button>`;
    section.open = state.open;
    section.innerHTML = `<summary ${focusAttribute(kind)}="linked-from:summary">Linked from</summary><p>Links in saved Notes and task notes.</p>`
      + (state.openError || state.error ? `<p role="alert">${e(state.openError ?? state.error!)}</p>` : '')
      + (state.loading ? '<p role="status">Loading linked records…</p>' : '')
      + (state.loaded && !state.items.length && !state.error && !state.loading ? '<p>No saved Notes or task notes link here.</p>' : '')
      + (state.items.length ? '<ul class="work-entity-note-related">' + state.items.map(row => {
        const rowId = rowKey(row), opening = state!.opening === rowId;
        const hints = [row.kind === 'note' ? 'Note' : 'Task notes', row.source_label,
          ...(row.stale ? ['May be out of date'] : []), ...(row.source_incomplete ? ['Source sync incomplete'] : []), ...(row.pending_write ? ['Change awaiting confirmation'] : [])];
        return '<li>' + button('open', opening ? 'Opening…' : row.title, rowId, ` ${KEY}="${e(rowId)}" aria-label="Open ${e(row.kind)} ${e(row.title)}"${state!.opening ? ' aria-disabled="true"' : ''}`)
          + '<small>' + e(hints.join(' · ')) + '</small><p class="work-linked-from-excerpt">' + e(row.excerpt) + '</p></li>';
      }).join('') + '</ul>' : '')
      + (state.providerOnly.length ? '<p>Saved links are unavailable for: ' + e(state.providerOnly.join(', ')) + '.</p>' : '')
      + (state.more ? button('more', 'More linked records', 'more', state.loading ? ' aria-disabled="true" aria-busy="true"' : '') : '')
      + (owner.kind === 'mail' && state.calendar && deps.openCalendar ? '<section aria-label="Linked calendar events"><h4>Calendar events</h4>'
        + '<p>Events with an explicit link to this email.</p>'
        + (!state.calendar.items.length ? '<p>' + (state.calendar.unavailable_sources.length ? 'No linked events found in the calendars checked.' : 'No saved calendar events link here.') + '</p>' : '<ul class="work-entity-note-related">'
          + state.calendar.items.map(row => {
            const key = calendarKey(row), days = row.is_all_day ? allDayEventDays(row) : null;
            const time = days ? 'All day · ' + calendarDayLabel(days.first) + (days.last === days.first ? '' : ' – ' + calendarDayLabel(days.last))
              : calendarTimeLabel(row.start_at, row.timezone);
            return '<li data-linked-calendar>' + button('calendar-open', state!.opening === key ? 'Opening…' : row.title, key,
              ` ${KEY}="${e(key)}" aria-label="Open event ${e(row.title)}"${state!.opening ? ' aria-disabled="true"' : ''}`)
              + '<small>' + e([row.calendar_name, row.slug, row.status === 'cancelled' ? 'Cancelled' : row.status === 'tentative' ? 'Tentative' : '',
                row.stale ? 'May be out of date' : ''].filter(Boolean).join(' · ')) + '</small><p>' + e(time) + '</p></li>';
          }).join('') + '</ul>')
        + (state.calendar.unavailable_sources.length ? '<p>Calendar links could not be checked for: ' + e(state.calendar.unavailable_sources.join(', ')) + '.</p>' : '')
        + (state.calendar.more ? button('calendar-more', 'More linked events', 'calendar-more', state.loading ? ' aria-disabled="true" aria-busy="true"' : '') : '') + '</section>' : '')
      + button('refresh', state.loaded || state.error ? 'Refresh linked records' : 'Load linked records', 'refresh', state.loading || state.opening ? ' aria-disabled="true" aria-busy="true"' : '');
    if (content && top !== undefined) content.scrollTop = top;
    if (summaryFocused) section.querySelector('summary')?.focus({ preventScroll: true });
    if (focusKey) ([...section.querySelectorAll<HTMLElement>(`[${focusAttribute(kind)}]`)]
      .find(element => element.getAttribute(focusAttribute(kind)) === focusKey) ?? section.querySelector('summary'))?.focus({ preventScroll: true });
  };
  const load = async (mode: 'refresh' | 'work-more' | 'calendar-more' = 'refresh') => {
    const owner = deps.owner(), captured = binding(), selected = state;
    if (!owner || !selected || !deps.call || selected.loading || selected.opening) return;
    const url = ownerUrl(owner, deps.href());
    if (!url) return;
    const sequence = ++generation, offset = mode === 'work-more' ? selected.offset + 10 : mode === 'refresh' ? 0 : selected.offset;
    const calendarOffset = mode === 'calendar-more' ? (selected.calendar?.offset ?? 0) + 10 : mode === 'refresh' ? 0 : selected.calendar?.offset ?? 0;
    selected.loading = true; selected.dirty = false; selected.error = undefined; paint();
    try {
      const response = await deps.call({ url, limit: 10, offset, ...(owner.kind === 'mail' ? { calendar_offset: calendarOffset } : {}), ...(owner.contact_identity ? { contact_identity: owner.contact_identity } : {}), ...(owner.source_identity ? { source_identity: owner.source_identity } : {}) });
      if (!current(captured) || sequence !== generation || state !== selected) return;
      if (response.offset !== offset) throw new Error('Unexpected page');
      if (mode !== 'calendar-more') selected.items = mode === 'work-more' ? [...selected.items, ...response.items.filter(row => !selected.items.some(old => rowKey(old) === rowKey(row)))] : response.items;
      if (response.calendar && response.calendar.offset !== calendarOffset) throw new Error('Unexpected calendar page');
      if (mode !== 'work-more') selected.calendar = response.calendar ? { ...response.calendar,
        items: mode === 'calendar-more' ? [...selected.calendar?.items ?? [], ...response.calendar.items.filter(row =>
          !selected.calendar?.items.some(old => calendarKey(old) === calendarKey(row)))] : response.calendar.items } : undefined;
      selected.more = response.more; selected.offset = offset; selected.providerOnly = response.provider_only_sources ?? []; selected.loaded = true;
    } catch {
      if (!current(captured) || sequence !== generation || state !== selected) return;
      selected.error = 'Could not load linked records. Try again.';
    } finally {
      if (sequence === generation && state === selected) { selected.loading = false; paint(); if (selected.dirty && current(captured)) void load(); }
    }
  };
  const toggle = () => {
    if (!section || !state) return;
    state.open = section.open;
    if (state.open && !state.loaded) void load();
  };
  return {
    captureFocus() {
      if (!section?.isConnected || !section.hasAttribute('data-contact-section') && !section.hasAttribute('data-source-linked-from')) return;
      const active = deps.root.ownerDocument.activeElement;
      if (section.contains(active)) {
        const value = active?.getAttribute(section.hasAttribute('data-contact-section') ? 'data-contact-quick-focus' : 'data-source-linked-focus');
        if (value) contactFocus = { binding: visit, value };
      } else if (active && active !== deps.root.ownerDocument.body && !section?.contains(active)) contactFocus = undefined;
    },
    restoreFocus() {
      if (!contactFocus || !deps.owner()) return;
      const pending = contactFocus; contactFocus = undefined;
      const active = deps.root.ownerDocument.activeElement;
      if (pending.binding !== binding() || !section || active !== deps.root.ownerDocument.body && !section.contains(active)) return;
      ([...section.querySelectorAll<HTMLElement>(`[${focusAttribute(deps.owner()!.kind)}]`)]
        .find(control => control.getAttribute(focusAttribute(deps.owner()!.kind)) === pending.value) ?? section.querySelector('summary'))?.focus({ preventScroll: true });
    },
    mount() {
      const owner = deps.owner(), nextKey = owner ? identity(owner) : '', nextVisit = binding();
      if (nextVisit !== visit) {
        generation++; if (state) { state.loading = false; state.opening = undefined; }
        visit = nextVisit; key = nextKey; state = nextKey ? states.get(nextKey) : undefined;
        if (owner && !state) {
          state = { open: false, loaded: false, loading: false, items: [], more: false, offset: 0, providerOnly: [] };
          states.set(nextKey, state);
          while (states.size > 24) states.delete(states.keys().next().value!);
        } else if (state) state.loaded = false;
      }
      const content = owner && deps.call ? deps.root.querySelector<HTMLElement>(owner.kind === 'contact' ? '[data-recued-data-contact-detail]' : owner.kind === 'mail' || owner.kind === 'calendar' ? '.col-explorer-detail' : `.work-entity-${owner.kind}-reader .work-entity-${owner.kind}-content`) : null;
      if (!content || !state) { section = null; return; }
      if (section?.isConnected && section.parentElement === content) return;
      section = content.ownerDocument.createElement('details'); section.className = 'work-entity-note-secondary work-linked-from';
      section.setAttribute(`data-${owner!.kind}-section`, 'linked-from');
      if (owner!.kind === 'mail' || owner!.kind === 'calendar') section.setAttribute('data-source-linked-from', '');
      section.addEventListener('toggle', toggle);
      content.append(section); paint(); if (state.open && !state.loaded) void load();
    },
    handleClick(event: Event): boolean {
      const target = (event.target as Element | null)?.closest?.<HTMLElement>('[' + ACTION + ']');
      if (!target || !section?.contains(target)) return false;
      event.preventDefault(); event.stopPropagation();
      if (deps.blocked() || !state) return true;
      const action = target.getAttribute(ACTION);
      if (action === 'more' || action === 'calendar-more' || action === 'refresh') { state.openError = undefined; void load(action === 'more' ? 'work-more' : action === 'calendar-more' ? 'calendar-more' : 'refresh'); return true; }
      if (action === 'calendar-open' && !state.opening && deps.openCalendar) {
        const owner = deps.owner(), url = owner && ownerUrl(owner, deps.href()), address = url && savedWorkAddress(url);
        const row = state.calendar?.items.find(row => calendarKey(row) === target.getAttribute(KEY));
        if (owner?.kind !== 'mail' || !address || !row) return true;
        const selected = state, captured = binding();
        selected.opening = calendarKey(row); selected.openError = undefined;
        target.focus({ preventScroll: true }); target.setAttribute('aria-busy', 'true'); target.setAttribute('aria-disabled', 'true');
        void deps.openCalendar(target, row, address).catch(cause => {
          if (current(captured)) selected.openError = cause instanceof Error ? cause.message : 'Could not open this event. Try again.';
        }).finally(() => { selected.opening = undefined; if (state === selected) paint(); });
        return true;
      }
      if (action !== 'open' || state.opening) return true;
      const row = state.items.find(row => rowKey(row) === target.getAttribute(KEY)), owner = deps.owner();
      const url = owner && ownerUrl(owner, deps.href());
      const address = url && savedWorkAddress(url); if (!row || !owner || !address) return true;
      const selected = state; selected.opening = rowKey(row); selected.error = undefined; selected.openError = undefined;
      target.focus({ preventScroll: true });
      target.setAttribute('aria-busy', 'true'); target.setAttribute('aria-disabled', 'true'); target.textContent = 'Opening…';
      // Keep the actual trigger connected until navigation captures its focus.
      const captured = binding();
      void deps.open(owner.kind, target, row, address).catch(() => {
        if (current(captured)) selected.openError = 'Could not open this linked record. Try again.';
      }).finally(() => {
        selected.opening = undefined; if (state === selected) paint();
      });
      return true;
    },
    refresh() { if (state?.loading) state.dirty = true; else if (state?.open && !state.opening) void load(); else if (state) state.loaded = false; },
    failure(message: string) { if (state) { state.openError = message; paint(); } },
    dispose() { disposed = true; generation++; states.clear(); section?.remove(); section = null; },
  };
};

export const WORK_LINKED_FROM_STYLES = `
.work-linked-from { min-width:0; overflow-wrap:anywhere; }
.work-linked-from li, .work-linked-from button { min-width:0; max-width:100%; }
.work-linked-from button { min-height:44px; white-space:normal; text-align:start; }
`;
