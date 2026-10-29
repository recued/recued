/**
 * D-324 — Data → Owned → Reminders.
 *
 * The owner's reminders still to ring, soonest first, each with its time on the
 * clock it was set on: edit its words and time, or cancel it. The ones rung or
 * cancelled in the last 30 days sit below, folded. A reminder is set in chat
 * ("remind me tomorrow at 3pm to call the dentist") or with the "Remind me"
 * recipe; this list is where the owner sees and changes them (D-324 P2).
 *
 * Like the Mail facts tab, it keeps its own state and renders HTML strings. The
 * Data route forwards:
 *   - `render()` inside its tab panel, and `refresh()` from its loader;
 *   - clicks whose action starts with `reminders-`, and `input` / `change`
 *     events from the wording and time fields (`REMINDERS_FIELD_ATTR`);
 *   - focus: `captureFocus()` before a repaint, `restoreFocus()` after, by a
 *     stable key each control carries (`REMINDERS_FOCUS_ATTR`).
 *
 * ⚠ A NEW TIME IS READ ON THE REMINDER'S OWN CLOCK, not the browser's. The list
 * words each time in the zone it was set in (`time_zone`), so the field edits
 * that same wall clock; read on a travelling browser's clock it would move the
 * reminder by the difference.
 */

import {
  REMINDER_TEXT_MAX,
  zonedWallClockToEpochMs,
  type ReminderCancelResult,
  type ReminderListResult,
  type ReminderUpdateResult,
  type ReminderView,
  type ReminderListRequest, type ReminderListPageInput, type ReminderListCursor, type ReminderCreateResult,
} from '@recued/contracts';
import { e, stampZone } from '@recued/ui-shared';

import { reminderWallClockValue } from '../reminders/reminder-time.js';
import { mountReminderCreateForm } from '../reminders/reminder-create-form.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const REMINDERS_HOST_ATTR = 'data-recued-reminders';
export const REMINDERS_FOCUS_ATTR = 'data-recued-reminders-focus';
/** The wording and time fields. */
export const REMINDERS_FIELD_ATTR = 'data-recued-reminders-field';
/** Every action this tab handles starts with this. */
export const REMINDERS_ACTION_PREFIX = 'reminders-';

/** Every reminder rpc the tab calls; an absent one hides what needs it. */
export interface ReminderCallers {
  readonly list?: (args: ReminderListRequest) => Promise<ReminderListResult>;
  readonly create?: (args: { text: string; at: number; creation_id: string }) => Promise<ReminderCreateResult>;
  readonly update?: (args: { reminder_id: string; at?: number; text?: string }) => Promise<ReminderUpdateResult>;
  readonly cancel?: (args: { reminder_id: string }) => Promise<ReminderCancelResult>;
}

export interface RemindersSurfaceDeps {
  readonly callers: ReminderCallers;
  /** The Data route's action attribute: clicks are dispatched by it. */
  readonly actionAttr: string;
  /** Repaint the route. */
  readonly render: () => void;
  /** The browser's own zone, to say when a reminder's clock is another one. */
  readonly browserZone?: () => string;
  readonly timeZone?: () => string | undefined;
  readonly now?: () => number;
}

export interface RemindersSurface {
  render(): string;
  /** Load the list. `silent` keeps what is shown until the new one lands. */
  refresh(silent?: boolean): Promise<void>;
  /** A click on an action starting with `reminders-`; true when handled. */
  handleAction(action: string, target: HTMLElement): boolean;
  /** An `input` from either edit field; true when handled. */
  handleInput(target: HTMLElement): boolean;
  /** A `change` from either edit field; true when handled. */
  handleChange(target: HTMLElement): boolean;
  /** A load, edit or cancellation is active: a broadcast must not replace it. */
  isBusy(): boolean;
  /** Wording or a new time is typed and not saved. */
  hasUnsavedChanges(): boolean;
  /** A save or a cancellation is under way. */
  hasInFlightWork(): boolean;
  beforeLeave(): boolean;
  whenLoaded(): Promise<void>;
  captureFocus(active: Element | null | undefined): string | null;
  restoreFocus(root: ParentNode, key: string | null): void;
  dispose(): void;
}

export { reminderWallClockValue } from '../reminders/reminder-time.js';

const zoneOf = (reminder: ReminderView): string => reminder.time_zone ?? 'UTC';

interface State {
  reminders: ReminderView[];
  delivered: ReminderView[];
  count: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The original values keep a wording edit from re-rounding its instant. */
  editing: { id: string; value: string; text: string; initialValue: string; initialText: string; zone: string;
    error: string | null; errorField?: 'at' | 'text' } | null;
  /** The reminder whose cancel waits for "Cancel it". */
  confirming: string | null;
  /** The reminder a save or a cancellation is under way for. */
  working: string | null;
  /** What the last save or cancellation did, in the server's words. */
  notice: { text: string; tone: 'ok' | 'bad' } | null;
  historyOpen: boolean;
  matchedCount: number;
  nextCursor: ReminderListCursor | null;
  paging: boolean | null;
  moreLoading: boolean;
  moreError: string | null;
  filterError: string | null;
  draft: ReminderFilters;
  applied: ReminderFilters;
  creating: boolean;
}

interface ReminderFilters { query: string; range: 'all' | 'today' | 'week' | 'custom'; from: string; through: string }
const PAGE_SIZE = 50;

export const createRemindersSurface = (deps: RemindersSurfaceDeps): RemindersSurface => {
  const { callers } = deps;
  // ⚠ `stampZone()` with no server zone IS the browser's zone: D-269 keeps that
  // one reading in `two-clock.ts` (`d-269-stamp-zone.test.ts` names where it may
  // live). Here it only says whether a reminder's clock is another one.
  const browserZone = deps.browserZone ?? ((): string => stampZone());
  const now = deps.now ?? Date.now;
  const filterZone = () => stampZone(deps.timeZone?.());
  const day = (at: number, zone: string) => reminderWallClockValue(at, zone).slice(0, 10);
  const nextDay = (value: string, amount: number) => {
    const at = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new Error('Choose a valid calendar date.');
    const next = new Date(at + amount * 86_400_000).toISOString().slice(0, 10);
    if (next.length !== 10) throw new Error('Choose a date within the supported calendar range.');
    return next;
  };
  const initialFilters = (): ReminderFilters => {
    const today = day(now(), filterZone());
    return { query: '', range: 'all', from: today, through: nextDay(today, 6) };
  };
  let state: State = {
    reminders: [], delivered: [], count: 0, loaded: false, loading: false, error: null,
    editing: null, confirming: null, working: null, notice: null, historyOpen: false,
    matchedCount: 0, nextCursor: null, paging: null, moreLoading: false, moreError: null, filterError: null,
    draft: initialFilters(), applied: initialFilters(), creating: false,
  };
  let pending: Promise<void> = Promise.resolve();
  let pageQuery: ReminderListPageInput = {};
  let createHost: HTMLElement | null = null;
  let createForm: ReturnType<typeof mountReminderCreateForm> | undefined;
  let createFocus: HTMLElement | null = null;
  let seq = 0;
  let disposed = false;
  let pendingFocus: {
    key: string;
    /** An asynchronous reply may redirect only the focus its action owns. */
    from?: readonly string[];
    fallback?: string;
  } | null = null;

  const filterQuery = (): ReminderListPageInput => {
    const filters = state.applied, zone = filterZone();
    const query = filters.query.trim();
    if (query.length > 200) throw new Error('Search for at most 200 characters.');
    let from: number | undefined, before: number | undefined;
    if (filters.range !== 'all') {
      const first = filters.range === 'custom' ? filters.from : day(now(), zone);
      const last = filters.range === 'custom' ? filters.through : nextDay(first, filters.range === 'week' ? 6 : 0);
      from = zonedWallClockToEpochMs(first, zone) ?? undefined;
      before = zonedWallClockToEpochMs(nextDay(last, 1), zone) ?? undefined;
      if (from === undefined || before === undefined || from >= before) throw new Error('Choose valid dates with the last day on or after the first.');
    }
    return { ...(query ? { query } : {}), ...(from !== undefined ? { from } : {}), ...(before !== undefined ? { before } : {}) };
  };
  const matches = (row: ReminderView): boolean => {
    const q = pageQuery;
    return (!q.query || row.text.normalize('NFKC').toLowerCase().includes(q.query.normalize('NFKC').toLowerCase()))
      && (q.from === undefined || row.at >= q.from) && (q.before === undefined || row.at < q.before);
  };
  const read = async (silent: boolean, append = false): Promise<void> => {
    if (!callers.list || disposed || append && (state.loading || state.moreLoading || !state.nextCursor)) return;
    let query: ReminderListPageInput;
    try { query = filterQuery(); }
    catch (error) { state = { ...state, filterError: humanizeRpcError(error) }; deps.render(); return; }
    if (append && JSON.stringify(query) !== JSON.stringify(pageQuery)) append = false;
    const mine = ++seq;
    const existing = state.reminders;
    const rows = new Map((append ? existing : []).map(row => [row.reminder_id, row]));
    const goal = append ? existing.length + PAGE_SIZE : Math.max(PAGE_SIZE, existing.length);
    let cursor = append ? state.nextCursor : undefined;
    let latest: ReminderListResult | undefined, delivered = state.delivered;
    state = { ...state, loading: !append, moreLoading: append, moreError: null, filterError: null,
      ...(silent ? {} : { error: null }) };
    if (!silent || append) deps.render();
    try {
      for (let pages = 0; pages < 100; pages++) {
        const includeHistory = !append && pages === 0;
        const out = await callers.list({ include_delivered: includeHistory, limit: Math.min(PAGE_SIZE, goal - rows.size),
          page: { ...query, ...(cursor ? { cursor } : {}) } });
        if (disposed || mine !== seq) return;
        if (!Array.isArray(out.reminders) || !Number.isSafeInteger(out.count) || out.count < 0) throw new Error('The reminder list could not be confirmed. Try again.');
        if (!out.page && (query.query || query.from !== undefined || query.before !== undefined || cursor))
          throw new Error('This server cannot search or page reminders yet. Update the server, then retry.');
        for (const row of out.reminders) rows.set(row.reminder_id, row);
        if (includeHistory) delivered = out.delivered ?? [];
        latest = out;
        const next = out.page?.next_cursor;
        if (next) {
          const last = out.reminders.at(-1);
          if (!last || next.at !== last.at || next.reminder_id !== last.reminder_id
            || cursor && (next.at < cursor.at || next.at === cursor.at && next.reminder_id <= cursor.reminder_id))
            throw new Error('The reminder page did not advance. Refresh the list and try again.');
        }
        cursor = next;
        if (!next || rows.size >= goal) break;
        if (pages === 99) throw new Error('The reminder list changed while loading. Refresh it and try again.');
      }
      if (!latest) throw new Error('The reminder list could not be confirmed.');
      const reminders = [...rows.values()].sort((a, b) => a.at - b.at || (a.reminder_id < b.reminder_id ? -1 : a.reminder_id > b.reminder_id ? 1 : 0));
      const editing = state.editing;
      const canEdit = editing !== null && reminders.some(row => row.reminder_id === editing.id && row.state === 'pending' && row.managed_by !== 'clock');
      const retired = editing !== null && !canEdit;
      const finished = retired ? delivered.find(row => row.reminder_id === editing.id) : undefined;
      pageQuery = query;
      state = { ...state, reminders, delivered, count: latest.count, matchedCount: latest.page?.matched_count ?? latest.count,
        nextCursor: latest.page?.next_cursor ?? null, paging: latest.page !== undefined,
        loaded: true, loading: false, moreLoading: false, error: null,
        editing: canEdit ? editing : null,
        confirming: state.confirming && reminders.some(row => row.reminder_id === state.confirming) ? state.confirming : null,
        ...(retired ? { notice: { tone: 'bad', text: finished?.state === 'delivered'
          ? 'This reminder has already rung. Your changes were not saved.'
          : finished?.state === 'cancelled' ? 'This reminder was cancelled. Your changes were not saved.'
          : reminders.some(row => row.reminder_id === editing.id && row.managed_by === 'clock')
            ? 'This reminder is managed in Yours. Your changes were not saved.'
            : 'This reminder is no longer in the waiting list. Your changes were not saved.' } as const } : {}),
      };
      if (append) {
        const previousIds = new Set(existing.map(row => row.reminder_id));
        const firstNew = reminders.find(row => !previousIds.has(row.reminder_id));
        pendingFocus = { key: firstNew ? `row:${firstNew.reminder_id}` : 'query', from: ['more'], fallback: 'query' };
      }
    } catch (error) {
      if (disposed || mine !== seq) return;
      state = { ...state, loading: false, moreLoading: false,
        ...(append ? { moreError: humanizeRpcError(error) } : { error: humanizeRpcError(error) }) };
    }
    deps.render();
  };
  const load = (silent: boolean, append = false): Promise<void> => {
    if (append && (state.loading || state.moreLoading || !state.nextCursor)) return pending;
    pending = read(silent, append); return pending;
  };

  const find = (id: string): ReminderView | undefined => state.reminders.find((r) => r.reminder_id === id);
  const confirmedState = (id: string, reminder: ReminderView | undefined, retired: boolean): Pick<State, 'reminders' | 'delivered' | 'count' | 'matchedCount'> => ({
    reminders: [...(retired || reminder && !matches(reminder) ? state.reminders.filter(row => row.reminder_id !== id)
      : reminder ? state.reminders.map(row => row.reminder_id === id ? reminder : row) : state.reminders)]
      .sort((a, b) => a.at - b.at || a.reminder_id.localeCompare(b.reminder_id)),
    delivered: reminder && reminder.state !== 'pending'
      ? [reminder, ...state.delivered.filter(row => row.reminder_id !== id)] : state.delivered,
    count: Math.max(0, state.count - (retired && state.reminders.some(row => row.reminder_id === id) ? 1 : 0)),
    matchedCount: Math.max(0, state.matchedCount - ((retired || reminder && !matches(reminder)) && state.reminders.some(row => row.reminder_id === id) ? 1 : 0)),
  });

  const dirtyEdit = (): boolean => state.editing !== null
    && (state.editing.value !== state.editing.initialValue || state.editing.text !== state.editing.initialText);
  const beforeLeave = (): boolean => {
    if (state.working !== null || createForm?.pending() || createForm?.hasDraft() || dirtyEdit()) {
      state = { ...state, notice: { tone: 'bad', text: state.working !== null || createForm?.pending()
        ? 'Your reminder is still being saved. Wait for the result before leaving or changing the list.'
        : 'Save or discard your reminder changes before leaving or changing the list.' } };
      if (!createForm?.hasDraft() || createForm.pending()) pendingFocus = { key: state.editing && state.working === null ? `text:${state.editing.id}` : 'notice' };
      deps.render();
      if (createForm?.hasDraft() && !createForm.pending()) createForm.open();
      return false;
    }
    return true;
  };
  const applyFilters = (clear = false): void => {
    if (!beforeLeave()) return;
    const previous = state.applied;
    const draft = clear ? initialFilters() : { ...state.draft, query: state.draft.query.trim() };
    state = { ...state, applied: draft };
    try { filterQuery(); }
    catch (error) { state = { ...state, applied: previous, filterError: humanizeRpcError(error) }; deps.render(); return; }
    state = { ...state, draft, reminders: [], loaded: false, nextCursor: null, matchedCount: 0,
      editing: null, confirming: null, notice: null, filterError: null };
    pendingFocus = { key: 'query' };
    void load(false);
  };
  const openCreate = (target: HTMLElement): void => {
    if (!callers.create) return;
    if (state.creating) { createForm?.open(); return; }
    if (!beforeLeave()) return;
    const doc = target.ownerDocument;
    if (!createHost) {
      createHost = doc.createElement('div');
      createForm = mountReminderCreateForm({ host: createHost, create: callers.create, now,
        ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
        onClose: result => {
          if (disposed) return;
          const active = createHost?.ownerDocument.activeElement;
          const ownsFocus = active == null || active === createHost?.ownerDocument.body || createHost?.contains(active);
          state = { ...state, creating: false };
          if (result) {
            const row = result.reminder;
            const known = state.reminders.some(item => item.reminder_id === row.reminder_id);
            const terminal = row.state !== 'pending';
            const visible = row.state === 'pending' && matches(row)
              && (!state.nextCursor || row.at <= (state.reminders.at(-1)?.at ?? Infinity));
            state = { ...state,
              reminders: terminal ? state.reminders.filter(item => item.reminder_id !== row.reminder_id)
                : visible ? [...state.reminders.filter(item => item.reminder_id !== row.reminder_id), row].sort((a, b) => a.at - b.at || a.reminder_id.localeCompare(b.reminder_id)) : state.reminders,
              delivered: terminal ? [row, ...state.delivered.filter(item => item.reminder_id !== row.reminder_id)] : state.delivered,
              count: Math.max(0, state.count + (!known && !terminal ? 1 : known && terminal ? -1 : 0)),
              matchedCount: Math.max(0, state.matchedCount + (!known && !terminal && matches(row) ? 1 : known && terminal ? -1 : 0)),
              notice: { tone: 'ok', text: `${terminal ? 'Reminder history' : 'Reminder set'}: ${row.text}. ${result.confirmation}` } };
          }
          pendingFocus = ownsFocus ? { key: result ? 'notice' : 'create' } : null;
          deps.render();
          if (result) void load(true);
        },
      });
    }
    state = { ...state, creating: true, editing: null, confirming: null, notice: null };
    deps.render();
    createForm?.open();
  };

  const save = async (id: string): Promise<void> => {
    const reminder = find(id);
    const editing = state.editing;
    if (state.working !== null || reminder === undefined || editing === null || editing.id !== id
      || reminder.managed_by === 'clock' || reminder.state !== 'pending' || callers.update === undefined) return;
    const fail = (field: 'text' | 'at', error: string): void => {
      state = { ...state, editing: { ...editing, error, errorField: field } };
      pendingFocus = { key: `${field}:${id}` };
      deps.render();
    };
    const patch: { reminder_id: string; text?: string; at?: number } = { reminder_id: id };
    if (editing.text !== editing.initialText) {
      const text = editing.text.replace(/\s+/gu, ' ').trim();
      if (!text) { fail('text', 'Enter what this reminder should say.'); return; }
      if (text.length > REMINDER_TEXT_MAX) { fail('text', `Keep the reminder within ${REMINDER_TEXT_MAX} characters.`); return; }
      if (text !== editing.initialText) patch.text = text;
    }
    if (editing.value !== editing.initialValue) {
      const at = zonedWallClockToEpochMs(editing.value, editing.zone);
      if (at === null || reminderWallClockValue(at, editing.zone) !== editing.value) {
        fail('at', 'Pick a valid day and time on this reminder’s clock.'); return;
      }
      patch.at = at;
    }
    if (patch.text === undefined && patch.at === undefined) {
      state = { ...state, editing: null, notice: { text: 'No changes to save.', tone: 'ok' } };
      pendingFocus = { key: `edit:${id}` }; deps.render();
      return;
    }
    state = { ...state, working: id, notice: { text: 'Saving reminder…', tone: 'ok' } };
    pendingFocus = { key: 'notice', from: [`save:${id}`, `text:${id}`, `at:${id}`, `keep-time:${id}`] };
    deps.render();
    try {
      const out = await callers.update(patch);
      if (disposed) return;
      const retired = !out.updated && (out.reason === 'not_found' || out.reason === 'not_pending');
      state = {
        ...state, ...confirmedState(id, out.reminder, retired), working: null,
        editing: out.updated || retired ? null : state.editing,
        notice: { text: out.message, tone: out.updated ? 'ok' : 'bad' },
      };
      pendingFocus = { key: out.updated ? `edit:${id}` : retired ? 'notice' : `${patch.text !== undefined ? 'text' : 'at'}:${id}`,
        from: ['notice'], fallback: 'notice' };
      const settledFocus = pendingFocus.key;
      deps.render();
      // The refresh may retire the control just restored. Redirect only if it
      // still owns focus; another row or tab must keep the focus moved there.
      pendingFocus = { key: settledFocus, from: [settledFocus], fallback: 'notice' };
      await load(true);
    } catch (error) {
      if (disposed) return;
      const current = find(id);
      const canKeep = current?.state === 'pending' && current.managed_by !== 'clock';
      state = { ...state, working: null,
        notice: canKeep ? null : { text: humanizeRpcError(error), tone: 'bad' },
        editing: canKeep ? { ...editing, error: humanizeRpcError(error) } : null };
      pendingFocus = { key: canKeep ? `${patch.text !== undefined ? 'text' : 'at'}:${id}` : 'notice', from: ['notice'], fallback: 'notice' };
      deps.render();
    }
  };

  const cancel = async (id: string): Promise<void> => {
    if (callers.cancel === undefined || find(id) === undefined) return;
    state = { ...state, working: id, notice: { text: 'Cancelling reminder…', tone: 'ok' } };
    pendingFocus = { key: 'notice', from: [`cancel-confirm:${id}`, `cancel-keep:${id}`] };
    deps.render();
    try {
      const out = await callers.cancel({ reminder_id: id });
      if (disposed) return;
      state = {
        ...state, ...confirmedState(id, out.reminder, out.cancelled || out.reason === 'not_found' || out.reason === 'not_pending'),
        working: null, confirming: null,
        notice: { text: out.message, tone: out.cancelled ? 'ok' : 'bad' },
      };
      pendingFocus = { key: 'notice', from: ['notice'] };
      deps.render();
      await load(true);
    } catch (error) {
      if (disposed) return;
      state = { ...state, working: null, confirming: null, notice: { text: humanizeRpcError(error), tone: 'bad' } };
      pendingFocus = { key: 'notice', from: ['notice'] };
      deps.render();
    }
  };

  const focus = (key: string): string => `${REMINDERS_FOCUS_ATTR}="${e(key)}"`;
  const act = (action: string, id?: string): string =>
    `${deps.actionAttr}="${action}"${id !== undefined ? ` data-reminder-id="${e(id)}"` : ''}`;

  const renderActions = (reminder: ReminderView): string => {
    const id = reminder.reminder_id;
    const busy = state.working === id;
    if (reminder.managed_by === 'clock') return `<div class="reminders-managed"><span>Managed in Yours</span>
      <a class="data-button" href="#yours" ${focus(`manage:${id}`)}>Manage in Yours</a></div>`;
    if (reminder.state !== 'pending') return '';
    if (state.editing !== null && state.editing.id === id) {
      const zone = state.editing.zone;
      const otherClock = zone !== browserZone();
      return `
        <div class="reminders-edit">
          <label class="reminders-field reminders-message">
            <span>Reminder</span>
            <textarea rows="3" maxlength="${REMINDER_TEXT_MAX}" ${REMINDERS_FIELD_ATTR}="text" data-reminder-id="${e(id)}"
              ${focus(`text:${id}`)}${state.editing.errorField === 'text' ? ' aria-invalid="true"' : ''}${busy ? ' disabled' : ''}>${e(state.editing.text)}</textarea>
          </label>
          <label class="reminders-field">
            <span>When${otherClock ? ` <span class="reminders-subtle">(${e(zone)} time)</span>` : ''}</span>
            <input type="datetime-local" ${REMINDERS_FIELD_ATTR}="at" data-reminder-id="${e(id)}"
              value="${e(state.editing.value)}" ${focus(`at:${id}`)}${state.editing.errorField === 'at' ? ' aria-invalid="true"' : ''} ${busy ? 'disabled' : ''}>
          </label>
          <p class="reminders-subtle">${e(zone)} time. The saved time stays exact unless you change it.</p>
          ${state.editing.error !== null ? `<p class="reminders-error" role="alert">${e(state.editing.error)}</p>` : ''}
          <div class="reminders-buttons">
            <button type="button" class="data-button" ${act('reminders-save', id)} ${focus(`save:${id}`)} ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button>
            <button type="button" class="data-button" ${act('reminders-edit-close', id)} ${focus(`keep-time:${id}`)} ${busy ? 'disabled' : ''}>Discard changes</button>
          </div>
        </div>`;
    }
    if (state.confirming === id) {
      return `
        <div class="reminders-confirm">
          <span>Cancel this reminder? It will not ring.</span>
          <div class="reminders-buttons">
            <button type="button" class="data-button reminders-danger" ${act('reminders-cancel-confirm', id)} ${focus(`cancel-confirm:${id}`)} ${busy ? 'disabled' : ''}>${busy ? 'Cancelling…' : 'Cancel it'}</button>
            <button type="button" class="data-button" ${act('reminders-cancel-keep', id)} ${focus(`cancel-keep:${id}`)} ${busy ? 'disabled' : ''}>Keep it</button>
          </div>
        </div>`;
    }
    return `
      <div class="reminders-buttons">
        ${callers.update !== undefined ? `<button type="button" class="data-button" ${act('reminders-edit', id)} ${focus(`edit:${id}`)}>Edit reminder</button>` : ''}
        ${callers.cancel !== undefined ? `<button type="button" class="data-button" ${act('reminders-cancel', id)} ${focus(`cancel:${id}`)}>Cancel</button>` : ''}
      </div>`;
  };

  const renderUpcoming = (): string => {
    if (callers.list === undefined) {
      return '<p class="reminders-empty">This server cannot list reminders yet. Update it to see them here.</p>';
    }
    if (state.error !== null && !state.loaded) {
      return `<p class="reminders-error" role="alert">${e(state.error)}
        <button type="button" class="data-button" ${act('reminders-retry')} ${focus('retry')}>Try again</button></p>`;
    }
    if (!state.loaded) return '<p class="reminders-empty">Loading reminders…</p>';
    if (state.reminders.length === 0) {
      return state.applied.query || state.applied.range !== 'all'
        ? '<p class="reminders-empty">No waiting reminders match these filters.</p>'
        : callers.create ? '<p class="reminders-empty">No reminders waiting. Set one with New reminder.</p>'
        : '<p class="reminders-empty">No reminders waiting. Ask chat to set one: “remind me tomorrow at 3pm to call the dentist”.</p>';
    }
    return `
      <ol class="reminders-list" aria-label="Reminders still to ring">
        ${state.reminders.map((reminder) => `
          <li class="reminders-row" data-reminder-id="${e(reminder.reminder_id)}" tabindex="-1" ${focus(`row:${reminder.reminder_id}`)}>
            <div class="reminders-when">${e(reminder.when)}</div>
            <div class="reminders-text">${e(reminder.text)}</div>
            ${renderActions(reminder)}
          </li>`).join('')}
      </ol>
      <p class="reminders-subtle">${state.paging ? `Showing ${state.reminders.length} of ${state.matchedCount} matching reminders · ${state.count} waiting in all.`
        : state.count > state.reminders.length ? `Showing the first ${state.reminders.length} of ${state.count}.` : `${state.count} waiting.`}</p>
      ${state.moreError ? `<p role="alert" class="reminders-error">${e(state.moreError)}</p>` : ''}
      ${state.nextCursor ? `<button type="button" class="data-button" ${act('reminders-more')} ${focus('more')}
        ${state.moreLoading ? 'aria-disabled="true" aria-busy="true"' : ''}>${state.moreLoading ? 'Loading…' : state.moreError ? 'Retry loading more' : 'Load more'}</button>` : ''}`;
  };

  const renderFilters = (): string => `
    <form class="reminders-filters" data-reminders-search aria-label="Find waiting reminders">
      <label>Search reminders <input class="data-input" type="search" maxlength="200" ${REMINDERS_FIELD_ATTR}="query" ${focus('query')} value="${e(state.draft.query)}" ${state.paging === false ? 'disabled' : ''}></label>
      <label>Dates <select class="data-select" ${REMINDERS_FIELD_ATTR}="range" ${focus('range')} ${state.paging === false ? 'disabled' : ''}>
        ${([['all', 'All dates'], ['today', 'Today'], ['week', 'Next 7 days'], ['custom', 'Choose dates']] as const)
          .map(([value, label]) => `<option value="${value}"${state.draft.range === value ? ' selected' : ''}>${label}</option>`).join('')}
      </select></label>
      ${state.draft.range === 'custom' ? `<label>From <input class="data-input" type="date" ${REMINDERS_FIELD_ATTR}="from" ${focus('from')} value="${e(state.draft.from)}"></label>
        <label>Through <input class="data-input" type="date" ${REMINDERS_FIELD_ATTR}="through" ${focus('through')} value="${e(state.draft.through)}"></label>` : ''}
      <div class="reminders-buttons"><button type="submit" class="data-button" ${focus('apply')} ${state.paging === false ? 'disabled' : ''}>Apply filters</button>
        <button type="button" class="data-button" ${act('reminders-clear')} ${focus('clear')}>Clear filters</button></div>
      <p class="reminders-subtle">Dates use ${e(filterZone())}. Search applies to waiting reminders.</p>
      ${state.paging === false ? '<p class="reminders-subtle">Update the server to search and load all waiting reminders.</p>' : ''}
      ${state.filterError ? `<p role="alert" class="reminders-error">${e(state.filterError)}</p>` : ''}
    </form>`;

  const renderHistory = (): string => {
    if (state.delivered.length === 0) return '';
    return `
      <details class="reminders-history" ${state.historyOpen ? 'open' : ''}>
        <summary ${act('reminders-history-toggle')} ${focus('history')}>Rung or cancelled in the last 30 days (${state.delivered.length})</summary>
        <ol class="reminders-list reminders-past">
          ${state.delivered.map((reminder) => `
            <li class="reminders-row" data-reminder-id="${e(reminder.reminder_id)}" data-state="${e(reminder.state)}">
              <div class="reminders-when">${e(reminder.when)}</div>
              <div class="reminders-text">${e(reminder.text)}</div>
              <div class="reminders-state">${reminder.state === 'cancelled' ? 'Cancelled' : 'Rang'}</div>
            </li>`).join('')}
        </ol>
      </details>`;
  };

  return {
    render: () => `
      <section class="reminders" ${REMINDERS_HOST_ATTR}>
        <div class="data-contact-toolbar">
          <h2 class="data-section-title">Reminders</h2>
          ${callers.create ? `<button type="button" class="data-button" ${act('reminders-create')} ${focus('create')}>New reminder</button>` : ''}
          <button type="button" class="data-button" ${act('reminders-retry')} ${focus('refresh')}
            ${state.loading || state.moreLoading ? 'aria-disabled="true" aria-busy="true"' : ''}>${state.loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
        <p class="reminders-intro">Each reminder rings once, at its time, on every channel you set up.</p>
        <div data-reminders-create-slot></div>
        <p class="reminders-notice" data-tone="${state.notice?.tone ?? 'ok'}" role="status" aria-live="polite" tabindex="-1" ${focus('notice')}>${e(state.notice?.text ?? '')}</p>
        ${state.error !== null && state.loaded ? `<p class="reminders-error" role="alert">${e(state.error)}</p>` : ''}
        ${renderFilters()}
        ${renderUpcoming()}
        ${renderHistory()}
      </section>`,

    refresh: (silent = false) => load(silent),

    handleAction: (action, target) => {
      if (!action.startsWith(REMINDERS_ACTION_PREFIX)) return false;
      const id = target.getAttribute('data-reminder-id') ?? '';
      if (action === 'reminders-create') { openCreate(target); return true; }
      if (action === 'reminders-apply' || action === 'reminders-clear') { applyFilters(action === 'reminders-clear'); return true; }
      if (action === 'reminders-more') { if (beforeLeave()) void load(true, true); return true; }
      if (action === 'reminders-retry') {
        if (!state.loading && !state.moreLoading && beforeLeave()) void load(false);
        return true;
      }
      if (action === 'reminders-history-toggle') {
        // The browser opens or shuts it; the state keeps it so across repaints.
        state = { ...state, historyOpen: !state.historyOpen };
        return true;
      }
      if (state.working !== null) return true;
      const editing = state.editing;
      if (editing && id !== editing.id && (action === 'reminders-edit' || action === 'reminders-cancel')
        && (editing.value !== editing.initialValue || editing.text !== editing.initialText)) {
        state = { ...state, notice: { text: 'Save or discard your reminder changes before opening another one.', tone: 'bad' } };
        pendingFocus = { key: `text:${editing.id}` }; deps.render(); return true;
      }
      const reminder = find(id);
      if (action === 'reminders-edit' && reminder !== undefined && reminder.managed_by !== 'clock' && reminder.state === 'pending') {
        const initialValue = reminderWallClockValue(reminder.at, zoneOf(reminder));
        state = {
          ...state, confirming: null, notice: null,
          editing: { id, value: initialValue, initialValue, text: reminder.text, initialText: reminder.text,
            zone: zoneOf(reminder), error: null },
        };
        pendingFocus = { key: `text:${id}` };
      } else if (action === 'reminders-edit-close') {
        state = { ...state, editing: null };
        pendingFocus = { key: `edit:${id}` };
      } else if (action === 'reminders-save') {
        void save(id);
        return true;
      } else if (action === 'reminders-cancel' && reminder !== undefined && reminder.managed_by !== 'clock') {
        state = { ...state, editing: null, confirming: id, notice: null };
        pendingFocus = { key: `cancel-keep:${id}` };
      } else if (action === 'reminders-cancel-keep') {
        state = { ...state, confirming: null };
        pendingFocus = { key: `cancel:${id}` };
      } else if (action === 'reminders-cancel-confirm') {
        void cancel(id);
        return true;
      } else {
        return true;
      }
      deps.render();
      return true;
    },

    handleInput: (target) => {
      const field = target.getAttribute(REMINDERS_FIELD_ATTR);
      if (field === 'query' || field === 'from' || field === 'through') {
        state = { ...state, draft: { ...state.draft, [field]: (target as HTMLInputElement).value } }; return true;
      }
      if (field !== 'at' && field !== 'text') return false;
      if (state.working !== null) return true;
      const id = target.getAttribute('data-reminder-id') ?? '';
      if (state.editing !== null && state.editing.id === id) {
        // No repaint while typing: the field holds what is typed.
        state = { ...state, editing: { ...state.editing,
          [field === 'text' ? 'text' : 'value']: (target as HTMLInputElement | HTMLTextAreaElement).value, error: null, errorField: undefined } };
      }
      return true;
    },

    handleChange: (target) => {
      const field = target.getAttribute(REMINDERS_FIELD_ATTR);
      if (field === 'query' || field === 'from' || field === 'through') {
        state = { ...state, draft: { ...state.draft, [field]: (target as HTMLInputElement).value } }; return true;
      }
      if (field === 'range') {
        const range = (target as HTMLSelectElement).value;
        if (range === 'all' || range === 'today' || range === 'week' || range === 'custom') state = { ...state, draft: { ...state.draft, range } };
        deps.render(); return true;
      }
      if (field !== 'at' && field !== 'text') return false;
      if (state.working !== null) return true;
      const id = target.getAttribute('data-reminder-id') ?? '';
      if (state.editing !== null && state.editing.id === id) {
        state = { ...state, editing: { ...state.editing,
          [field === 'text' ? 'text' : 'value']: (target as HTMLInputElement | HTMLTextAreaElement).value, error: null, errorField: undefined } };
      }
      return true;
    },

    isBusy: () => state.loading || state.moreLoading || state.working !== null || state.editing !== null || state.confirming !== null
      || createForm?.hasDraft() === true || JSON.stringify(state.draft) !== JSON.stringify(state.applied),
    beforeLeave,
    whenLoaded: () => pending,

    hasUnsavedChanges: () => {
      const editing = state.editing;
      if (createForm?.hasDraft()) return true;
      if (editing === null) return false;
      const reminder = find(editing.id);
      return reminder !== undefined && (editing.value !== editing.initialValue || editing.text !== editing.initialText);
    },

    hasInFlightWork: () => state.working !== null || createForm?.pending() === true,

    captureFocus: (active) => {
      createFocus = createHost?.contains(active as Node) ? active as HTMLElement : null;
      const key = (active as HTMLElement | null | undefined)?.getAttribute?.(REMINDERS_FOCUS_ATTR);
      return typeof key === 'string' && key.length > 0 ? key : null;
    },

    restoreFocus: (root, key) => {
      if (disposed) return;
      const searchForm = root.querySelector?.<HTMLFormElement>('[data-reminders-search]');
      if (searchForm) searchForm.onsubmit = event => { event.preventDefault(); applyFilters(); };
      if (state.creating && createHost) root.querySelector?.('[data-reminders-create-slot]')?.appendChild(createHost);
      if (createFocus?.isConnected) { createFocus.focus({ preventScroll: true }); createFocus = null; return; }
      const request = pendingFocus;
      // Consume even a rejected request: a reply received in another tab must
      // not take focus when the owner later returns to Reminders.
      pendingFocus = null;
      const owned = request !== null && (request.from === undefined || (key !== null && request.from.includes(key)));
      const wanted = owned ? request.key : key;
      if (wanted === null) return;
      const control = (value: string): HTMLElement | null | undefined => root.querySelector?.(
        `[${REMINDERS_FOCUS_ATTR}="${value.replace(/["\\]/g, '\\$&')}"]`,
      ) as HTMLElement | null | undefined;
      const found = control(wanted) ?? (owned && request.fallback !== undefined ? control(request.fallback) : null);
      found?.focus?.({ preventScroll: !owned || wanted === key });
    },

    dispose: () => {
      disposed = true;
      seq += 1;
      createForm?.dispose();
      pendingFocus = null;
    },
  };
};

/** The tab's styles, scoped to its host; injected with the Data route's. */
export const REMINDERS_STYLES = `
.reminders-filters { display:flex; flex-wrap:wrap; align-items:end; gap:.75rem; margin:1rem 0; }
.reminders-filters label { display:flex; flex-direction:column; gap:.35rem; min-width:0; }
.reminders-filters label:first-child { flex:1 1 15rem; }
.reminders-filters p { flex-basis:100%; margin:0; }
@media(max-width:600px) { .reminders-filters label { flex:1 1 100%; } }
[${REMINDERS_HOST_ATTR}] { min-width: 0; }
[${REMINDERS_HOST_ATTR}] .reminders-intro { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
[${REMINDERS_HOST_ATTR}] .reminders-notice { margin: 0 0 8px; font-size: 13px; min-height: 0; }
[${REMINDERS_HOST_ATTR}] .reminders-notice:empty { display: none; }
[${REMINDERS_HOST_ATTR}] .reminders-notice[data-tone="bad"] { color: var(--danger); }
[${REMINDERS_HOST_ATTR}] .reminders-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
[${REMINDERS_HOST_ATTR}] .reminders-row {
  display: grid; grid-template-columns: minmax(0, 14em) minmax(0, 1fr) auto; align-items: center; gap: 8px 16px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 10px; min-width: 0;
}
[${REMINDERS_HOST_ATTR}] .reminders-when { font-weight: 600; overflow-wrap: anywhere; }
[${REMINDERS_HOST_ATTR}] .reminders-text { overflow-wrap: anywhere; min-width: 0; }
[${REMINDERS_HOST_ATTR}] .reminders-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
[${REMINDERS_HOST_ATTR}] .reminders-edit,
[${REMINDERS_HOST_ATTR}] .reminders-confirm { display: grid; gap: 6px; grid-column: 1 / -1; font-size: 13px; }
[${REMINDERS_HOST_ATTR}] .reminders-edit { gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
[${REMINDERS_HOST_ATTR}] .reminders-field { display: grid; gap: 2px; font-size: 12px; color: var(--muted); max-width: 20em; }
[${REMINDERS_HOST_ATTR}] .reminders-field input,
[${REMINDERS_HOST_ATTR}] .reminders-field textarea { box-sizing: border-box; width: 100%; font: inherit; font-size: 14px; color: var(--fg); max-width: 100%; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); padding: 8px; }
[${REMINDERS_HOST_ATTR}] .reminders-message { max-width: 42em; width: 100%; }
[${REMINDERS_HOST_ATTR}] .reminders-message textarea { min-height: 84px; resize: vertical; }
[${REMINDERS_HOST_ATTR}] .reminders-managed { display: grid; justify-items: start; gap: 6px; font-size: 12px; color: var(--muted); }
[${REMINDERS_HOST_ATTR}] .reminders-danger { border-color: var(--danger); color: var(--danger); }
[${REMINDERS_HOST_ATTR}] .reminders-subtle { margin: 0; font-size: 12px; color: var(--muted); }
[${REMINDERS_HOST_ATTR}] .reminders-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; color: var(--danger); font-size: 13px; }
[${REMINDERS_HOST_ATTR}] .reminders-empty { color: var(--muted); max-width: 60ch; }
[${REMINDERS_HOST_ATTR}] .reminders-history { margin-top: 16px; }
[${REMINDERS_HOST_ATTR}] .reminders-history summary { cursor: pointer; font-size: 13px; margin-bottom: 8px; }
[${REMINDERS_HOST_ATTR}] .reminders-past .reminders-row { color: var(--muted); }
[${REMINDERS_HOST_ATTR}] .reminders-state { font-size: 12px; font-weight: 600; }
@media (max-width: 720px) {
  [${REMINDERS_HOST_ATTR}] .reminders-row { grid-template-columns: minmax(0, 1fr); }
}
`;
