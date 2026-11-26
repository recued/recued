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
 *   - an exact reminder address, preserving list filters and pages beneath it;
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
  formatReminderWhen,
  type ReminderGetResult,
  zonedWallClockToEpochMs,
  type ReminderCancelResult,
  type ReminderListResult,
  type ReminderUpdateResult,
  type ReminderView,
  type ReminderListRequest, type ReminderListPageInput, type ReminderListCursor, type ReminderCreateResult,
  type ReminderSearchStatus, isReminderState, type ReminderCreateRequest, type ReminderRecordReference, type WorkEntityGetRpcResponse,
  type ReminderMailReference, type MailMessageSnapshot, sameReminderMailReference,
  readReminderRecordReference, sameReminderRecordReference,
} from '@recued/contracts';
import { e, stampZone } from '@recued/ui-shared';

import { reminderWallClockValue, reminderTimePreset, formatReminderTimePreview, REMINDER_TIME_PRESETS, type ReminderTimePreset } from '../reminders/reminder-time.js';
import { mountReminderCreateForm } from '../reminders/reminder-create-form.js';
import { renderReminderRecoveries } from '../reminders/reminder-recovery-view.js';
import type { ReminderDraftEntry, ReminderRecoveryStore } from '../reminders/reminder-draft-recovery.js';
import { createReminderTriage, type ReminderTriageCallers } from '../reminders/reminder-triage.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { REMINDER_STATUS_LABELS, validateReminderSearchPage } from '../reminders/reminder-search.js';
import { matchesReminderRecord } from './work-reminder.js';

export const REMINDERS_HOST_ATTR = 'data-recued-reminders';
export const REMINDERS_FOCUS_ATTR = 'data-recued-reminders-focus';
export const REMINDER_READER_SCROLL_ATTR = 'data-reminder-reader-scroll';
/** The wording and time fields. */
export const REMINDERS_FIELD_ATTR = 'data-recued-reminders-field';
/** Every action this tab handles starts with this. */
export const REMINDERS_ACTION_PREFIX = 'reminders-';

/** Every reminder rpc the tab calls; an absent one hides what needs it. */
export interface ReminderCallers extends ReminderTriageCallers {
  readonly get?: (args: { reminder_id: string }) => Promise<ReminderGetResult>;
  readonly list?: (args: ReminderListRequest) => Promise<ReminderListResult>;
  readonly create?: (args: ReminderCreateRequest) => Promise<ReminderCreateResult>;
  readonly update?: (args: { reminder_id: string; at?: number; text?: string }) => Promise<ReminderUpdateResult>;
  readonly cancel?: (args: { reminder_id: string }) => Promise<ReminderCancelResult>;
}

export interface RemindersSurfaceDeps {
  readonly callers: ReminderCallers;
  readonly recovery?: ReminderRecoveryStore;
  readonly recoveryList?: boolean;
  readonly initialId?: string;
  readonly onAddressChange?: () => void;
  readonly onBack?: () => boolean;
  readonly backLabel?: () => string;
  readonly desktopWorkspace?: () => boolean;
  /** The Data route's action attribute: clicks are dispatched by it. */
  readonly actionAttr: string;
  /** Repaint the route. */
  readonly render: () => void;
  /** The browser's own zone, to say when a reminder's clock is another one. */
  readonly browserZone?: () => string;
  readonly timeZone?: () => string | undefined;
  readonly now?: () => number;
  readonly readRecord?: (ref: ReminderRecordReference) => Promise<WorkEntityGetRpcResponse>;
  readonly openRecord?: (response: WorkEntityGetRpcResponse) => void;
  readonly readMail?: (ref: ReminderMailReference) => Promise<MailMessageSnapshot>;
  readonly openMail?: (message: MailMessageSnapshot, ref: ReminderMailReference, current: () => boolean) => void | Promise<void>;
  readonly isActive?: () => boolean;
}

export interface RemindersSurface {
  render(): string;
  resumeDraft(id: string, target: HTMLElement, expected?: ReminderDraftEntry): boolean;
  showRecoveryNotice(message: string): void;
  /** Keep the list state beneath the addressed reminder. False when a draft or write blocks navigation. */
  open(id: string | null, syncAddress?: boolean): boolean;
  detailId(): string | undefined;
  hasListReader(): boolean;
  closeReaderFromKeyboard(): boolean;
  /** Reload the list or addressed reminder. `silent` keeps the confirmed view while reading. */
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
  /** True when the action moved focus and its target should be revealed after scroll restoration. */
  restoreFocus(root: ParentNode, key: string | null): boolean | void;
  dispose(): void;
}

export { reminderWallClockValue } from '../reminders/reminder-time.js';

const zoneOf = (reminder: ReminderView): string => reminder.time_zone ?? 'UTC';

interface ReminderDetail { id: string; reminder: ReminderView | null; loaded: boolean; loading: boolean; error: string | null }

interface State {
  detail: ReminderDetail | null;
  reminders: ReminderView[];
  delivered: ReminderView[];
  count: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The original values keep a wording edit from re-rounding its instant. */
  editing: { id: string; value: string; text: string; initialValue: string; initialAt: number; initialText: string; zone: string;
    choice?: { preset: ReminderTimePreset; at: number };
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

interface ReminderFilters { query: string; status: ReminderSearchStatus; range: 'all' | 'today' | 'week' | 'custom'; from: string; through: string }
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
    return { query: '', status: 'pending', range: 'all', from: today, through: nextDay(today, 6) };
  };
  let state: State = {
    detail: deps.initialId ? { id: deps.initialId, reminder: null, loaded: false, loading: false, error: null } : null,
    reminders: [], delivered: [], count: 0, loaded: false, loading: false, error: null,
    editing: null, confirming: null, working: null, notice: null, historyOpen: false,
    matchedCount: 0, nextCursor: null, paging: null, moreLoading: false, moreError: null, filterError: null,
    draft: initialFilters(), applied: initialFilters(), creating: false,
  };
  let pending: Promise<void> = Promise.resolve();
  let detailPending: Promise<void> = Promise.resolve();
  let detailSeq = 0;
  let linkedRecordRead = 0;
  let linkedRecordBusy = false;
  let linkedRecordError: string | undefined;
  let listReader = false;
  const showWorkspace = () => listReader && deps.desktopWorkspace?.() === true;
  let listNeedsRefresh = false;
  let loadedGoal = PAGE_SIZE;
  let pageQuery: ReminderListPageInput = {};
  let createHost: HTMLElement | null = null;
  let createForm: ReturnType<typeof mountReminderCreateForm> | undefined;
  let recoveryDiscard: string | undefined, recoveryError = '';
  let createFocus: HTMLElement | null = null;
  let createReturnFocus = 'create';
  let again: { id: string; detail: string | null; notice: NonNullable<State['notice']> } | null = null;
  let againPending = Promise.resolve();
  let seq = 0;
  let disposed = false;
  let pendingFocus: {
    key: string;
    /** An asynchronous reply may redirect only the focus its action owns. */
    from?: readonly string[];
    fallback?: string | readonly string[];
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
    return { ...(query ? { query } : {}), ...(filters.status !== 'pending' ? { state: filters.status } : {}),
      ...(from !== undefined ? { from } : {}), ...(before !== undefined ? { before } : {}) };
  };
  const matches = (row: ReminderView): boolean => {
    const q = pageQuery;
    return ((q.state ?? 'pending') === 'all' || row.state === (q.state ?? 'pending'))
      && (!q.query || row.text.normalize('NFKC').toLowerCase().includes(q.query.normalize('NFKC').toLowerCase()))
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
    const goal = append ? Math.max(loadedGoal, existing.length) + PAGE_SIZE : Math.max(loadedGoal, existing.length);
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
        if (query.state) validateReminderSearchPage(out, { ...query, state: query.state, ...(cursor ? { cursor } : {}) });
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
      const editable = (id: string): boolean => {
        const row = listReader && state.detail?.id === id
          ? state.detail.reminder : reminders.find(row => row.reminder_id === id);
        return row?.state === 'pending' && row.managed_by !== 'clock';
      };
      const canEdit = editing !== null && editable(editing.id);
      const retired = editing !== null && !canEdit;
      const finished = retired ? delivered.find(row => row.reminder_id === editing.id) : undefined;
      pageQuery = query; loadedGoal = goal;
      listNeedsRefresh = false;
      state = { ...state, reminders, delivered, count: latest.count, matchedCount: latest.page?.matched_count ?? latest.count,
        nextCursor: latest.page?.next_cursor ?? null, paging: latest.page !== undefined,
        loaded: true, loading: false, moreLoading: false, error: null,
        editing: canEdit ? editing : null,
        confirming: state.confirming && (listReader && state.detail?.id === state.confirming
          ? editable(state.confirming) : reminders.some(row => row.reminder_id === state.confirming)) ? state.confirming : null,
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

  const readDetail = async (silent: boolean): Promise<void> => {
    const detail = state.detail;
    if (!detail || disposed) return;
    const mine = ++detailSeq;
    state = { ...state, detail: { ...detail, loading: true, error: null } };
    if (!silent) deps.render();
    try {
      if (!callers.get) throw new Error('Update the server to open individual reminders. You can still use the reminder list.');
      const out = await callers.get({ reminder_id: detail.id });
      if (disposed || mine !== detailSeq || state.detail?.id !== detail.id) return;
      if (!out || out.reminder !== null && out.reminder?.reminder_id !== detail.id) throw new Error('This reminder could not be confirmed. Try again.');
      const row = out.reminder;
      const listed = state.reminders.find(item => item.reminder_id === detail.id);
      // A notification can reveal a row that rang while this list was retained.
      // Keep the pages beneath it, then reconcile them on return.
      if (listed && (!row || row.state !== listed.state || row.text !== listed.text || row.at !== listed.at
        || row.managed_by !== listed.managed_by)) listNeedsRefresh = true;
      const retired = state.editing !== null && (row === null || row.state !== 'pending' || row.managed_by === 'clock');
      state = { ...state, detail: { id: detail.id, reminder: row, loaded: true, loading: false, error: null },
        editing: retired ? null : state.editing,
        confirming: row?.state === 'pending' && row.managed_by !== 'clock' ? state.confirming : null,
        ...(retired ? { notice: { tone: 'bad', text: row?.state === 'delivered' ? 'This reminder has already rung. Your changes were not saved.'
          : row?.state === 'cancelled' ? 'This reminder was cancelled. Your changes were not saved.'
          : row?.managed_by === 'clock' ? 'This reminder is managed in Yours. Your changes were not saved.'
          : 'This reminder is no longer available. Your changes were not saved.' } as const } : {}),
      };
    } catch (error) {
      if (disposed || mine !== detailSeq || state.detail?.id !== detail.id) return;
      state = { ...state, detail: { ...state.detail, loading: false, error: humanizeRpcError(error) } };
    }
    deps.render();
  };
  const refreshCurrent = async (silent: boolean): Promise<void> => {
    if (!state.detail) return load(silent);
    detailPending = readDetail(silent);
    await Promise.all([detailPending, listReader ? load(silent) : undefined]);
  };
  const find = (id: string): ReminderView | undefined => state.detail?.id === id
    ? state.detail.reminder ?? undefined : state.reminders.find((r) => r.reminder_id === id);
  const confirmedState = (id: string, reminder: ReminderView | undefined, retired: boolean): Pick<State, 'detail' | 'reminders' | 'delivered' | 'count' | 'matchedCount'> => ({
    detail: state.detail?.id === id ? { ...state.detail, reminder: reminder ?? (retired ? null : state.detail.reminder),
      loaded: true, loading: false, error: null } : state.detail,
    reminders: [...(retired && !reminder || reminder && !matches(reminder) ? state.reminders.filter(row => row.reminder_id !== id)
      : reminder ? state.reminders.map(row => row.reminder_id === id ? reminder : row) : state.reminders)]
      .sort((a, b) => a.at - b.at || a.reminder_id.localeCompare(b.reminder_id)),
    delivered: reminder && reminder.state !== 'pending'
      ? [reminder, ...state.delivered.filter(row => row.reminder_id !== id)] : state.delivered,
    count: Math.max(0, state.count - (retired && state.reminders.some(row => row.reminder_id === id) ? 1 : 0)),
    matchedCount: Math.max(0, state.matchedCount - ((retired && !reminder || reminder && !matches(reminder)) && state.reminders.some(row => row.reminder_id === id) ? 1 : 0)),
  });

  const dirtyEdit = (): boolean => state.editing !== null
    && (state.editing.value !== state.editing.initialValue || state.editing.text !== state.editing.initialText
      || state.editing.choice !== undefined && state.editing.choice.at !== state.editing.initialAt);
  const retireAgain = (): void => {
    if (again && state.notice === again.notice) state = { ...state, notice: null };
    again = null;
  };
  const leaveAllowed = (): boolean => {
    if (state.working !== null || triage.writing() || createForm?.pending() || createForm?.hasDraft() || dirtyEdit()) {
      state = { ...state, notice: { tone: 'bad', text: state.working !== null || triage.writing() || createForm?.pending()
        ? 'Your reminder is still being saved. Wait for the result before leaving or changing the list.'
        : 'Save or discard your reminder changes before leaving or changing the list.' } };
      if (!createForm?.hasDraft() || createForm.pending()) pendingFocus = { key: state.editing && state.working === null ? `text:${state.editing.id}` : 'notice' };
      deps.render();
      if (createForm?.hasDraft() && !createForm.pending()) createForm.open();
      return false;
    }
    return true;
  };
  const beforeLeave = (): boolean => {
    if (!leaveAllowed()) return false;
    retireAgain();
    linkedRecordRead++; linkedRecordBusy = false; linkedRecordError = undefined;
    return true;
  };
  const open = (id: string | null, syncAddress = true, fromList = false): boolean => {
    if (disposed) return false;
    if ((state.detail?.id ?? null) === id) {
      if (fromList && !state.editing && !state.confirming && !state.creating && state.working === null) {
        pendingFocus = { key: 'detail' };
        deps.render();
      }
      return true;
    }
    if (!beforeLeave()) return false;
    triage.reset();
    const oldId = state.detail?.id;
    const returningToList = id === null && listReader;
    const keepList = returningToList || fromList;
    if (!keepList) seq++;
    detailSeq++;
    listReader = id !== null && fromList;
    state = { ...state, detail: id === null ? null : { id, reminder: null, loaded: false, loading: false, error: null },
      ...(keepList ? {} : { loading: false, moreLoading: false }), editing: null, confirming: null, notice: null };
    const listed = oldId && state.reminders.some(row => row.reminder_id === oldId);
    const returnFocus = returningToList && oldId ? `open:${oldId}` : !listNeedsRefresh && listed ? `row:${oldId}` : 'query';
    pendingFocus = { key: id === null ? returnFocus : 'detail',
      ...(id === null ? { fallback: listed ? [`row:${oldId}`, 'query'] : 'query' } : {}) };
    if (syncAddress) deps.onAddressChange?.();
    deps.render();
    if (id !== null) detailPending = readDetail(false);
    else if (!state.loading && !state.moreLoading && (!state.loaded || listNeedsRefresh)) { listNeedsRefresh = false; void load(state.loaded); }
    return true;
  };
  const retireReadsForWrite = (): void => {
    seq++; detailSeq++;
    listNeedsRefresh = true;
    state = { ...state, loading: false, moreLoading: false,
      detail: state.detail ? { ...state.detail, loading: false } : null };
  };
  const nearbyFocus = (id: string): string[] => {
    const order = state.reminders.map(row => row.reminder_id), index = order.indexOf(id);
    return [...order.slice(index + 1), ...order.slice(0, Math.max(index, 0)).reverse()].map(other => `row:${other}`).concat('query');
  };
  const closeFilteredReader = (id: string, listed: boolean): boolean => {
    if (!listReader || state.detail?.id !== id || !listed || state.reminders.some(row => row.reminder_id === id)) return false;
    listReader = false;
    detailSeq++;
    state = { ...state, detail: null };
    deps.onAddressChange?.();
    return true;
  };
  const applyFilters = (clear = false): void => {
    if (!beforeLeave()) return;
    const previous = state.applied;
    const draft = clear ? initialFilters() : { ...state.draft, query: state.draft.query.trim() };
    state = { ...state, applied: draft };
    try { filterQuery(); }
    catch (error) { state = { ...state, applied: previous, filterError: humanizeRpcError(error) }; deps.render(); return; }
    triage.reset();
    loadedGoal = PAGE_SIZE;
    state = { ...state, draft, reminders: [], loaded: false, nextCursor: null, matchedCount: 0,
      editing: null, confirming: null, notice: null, filterError: null };
    pendingFocus = { key: 'query' };
    void load(false);
  };
  const openCreate = (target: HTMLElement, initial?: { text: string; focus: boolean; returnFocus: string; record_ref?: ReminderRecordReference; mail_ref?: ReminderMailReference }, restored?: ReminderDraftEntry): boolean => {
    if (!callers.create) return false;
    if (state.creating) { createForm?.open(); return false; }
    if (!beforeLeave()) return false;
    triage.reset();
    const doc = target.ownerDocument;
    if (!createHost) {
      createHost = doc.createElement('div');
      createForm = mountReminderCreateForm({ host: createHost, create: callers.create, now,
        ...(deps.recovery ? { recovery: deps.recovery } : {}),
        ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
        onClose: (result, keptId) => {
          if (disposed) return;
          const active = createHost?.ownerDocument.activeElement;
          // Cancel is a direct action; a creation reply may arrive after focus
          // has moved elsewhere and must respect that newer owner.
          const ownsFocus = !result || active == null || active === createHost?.ownerDocument.body || createHost?.contains(active);
          state = { ...state, creating: false };
          if (keptId) { recoveryError = ''; createReturnFocus = `recovery-resume:${keptId}`; }
          if (result) {
            const row = result.reminder;
            const known = state.reminders.some(item => item.reminder_id === row.reminder_id);
            const terminal = row.state !== 'pending';
            const visible = matches(row)
              && (!state.nextCursor || row.at <= (state.reminders.at(-1)?.at ?? Infinity));
            state = { ...state,
              reminders: visible ? [...state.reminders.filter(item => item.reminder_id !== row.reminder_id), row].sort((a, b) => a.at - b.at || a.reminder_id.localeCompare(b.reminder_id))
                : state.reminders.filter(item => item.reminder_id !== row.reminder_id),
              delivered: terminal ? [row, ...state.delivered.filter(item => item.reminder_id !== row.reminder_id)] : state.delivered,
              count: Math.max(0, state.count + (!known && !terminal ? 1 : known && terminal ? -1 : 0)),
              matchedCount: Math.max(0, state.matchedCount + (!known && matches(row) ? 1 : known && !matches(row) ? -1 : 0)),
              notice: { tone: 'ok', text: `${terminal ? 'Reminder history' : 'Reminder set'}: ${row.text}. ${result.confirmation}` } };
          }
          const returnFocus = createReturnFocus.startsWith('again:') && !state.detail && !state.historyOpen && state.applied.status === 'pending' ? 'history' : createReturnFocus;
          pendingFocus = ownsFocus ? { key: result ? 'notice' : returnFocus, fallback: ['create', 'detail', 'history', 'query'] } : null;
          deps.render();
          if (result) void load(true);
        },
      });
    }
    createReturnFocus = initial?.returnFocus ?? 'create';
    state = { ...state, creating: true, editing: null, confirming: null, notice: null };
    deps.render();
    if (restored) {
      if (!createForm?.resume(restored.id, restored)) {
        state = { ...state, creating: false }; recoveryError = 'This recovery copy changed or is no longer available. Review the current drafts.';
        deps.render(); return false;
      }
    } else createForm?.open(initial ? { ...initial, fromHistory: true } : undefined);
    return true;
  };
  const resumeDraft = (id: string, target: HTMLElement, expected?: ReminderDraftEntry): boolean => {
    const entry = deps.recovery?.get(id);
    if (!entry || expected && JSON.stringify(entry) !== JSON.stringify(expected)) {
      recoveryError = 'This recovery copy changed or is no longer available. Review the current drafts.'; deps.render(); return false;
    }
    recoveryError = ''; recoveryDiscard = undefined;
    return openCreate(target, undefined, entry);
  };
  const recoveries = () => deps.recoveryList === false || state.creating ? '' : renderReminderRecoveries({ store: deps.recovery, actionAttr: deps.actionAttr,
    currentId: createForm?.id?.(), confirming: recoveryDiscard, error: recoveryError, disabled: state.working !== null || Boolean(createForm?.hasDraft()) || dirtyEdit() });
  const reusable = (row: ReminderView | null | undefined): row is ReminderView => !!row
    && (row.state === 'delivered' || row.state === 'cancelled') && row.managed_by !== 'clock';
  const remindAgain = (id: string, target: HTMLElement): void => {
    if (again || !callers.create || !callers.get) return;
    const shown = find(id) ?? state.delivered.find(row => row.reminder_id === id);
    if (!reusable(shown) || !beforeLeave()) return;
    const op = { id, detail: state.detail?.id ?? null, notice: { tone: 'ok' as const, text: 'Checking reminder…' } };
    again = op; state = { ...state, notice: op.notice };
    // This direct action owns focus even when a pointer click does not focus
    // the button (WebKit). Subsequent replies still respect a newer focus owner.
    pendingFocus = { key: 'notice' }; deps.render();
    const current = () => !disposed && again === op && (state.detail?.id ?? null) === op.detail;
    againPending = (async () => {
      try {
        const { reminder } = await callers.get!({ reminder_id: id });
        if (!current()) return;
        if (!reminder || reminder.reminder_id !== id) throw new Error('This reminder could not be confirmed. Refresh it and try again.');
        if (!reusable(reminder)) throw new Error('This reminder is no longer available to reuse. Refresh it and try again.');
        const active = target.ownerDocument.activeElement;
        const key = active?.getAttribute?.(REMINDERS_FOCUS_ATTR);
        const ownsFocus = active == null || active === target.ownerDocument.body || key === `again:${id}` || key === 'notice';
        again = null; pendingFocus = null;
        openCreate(target, { text: reminder.text, focus: ownsFocus, returnFocus: `again:${id}`,
          ...(reminder.record_ref ? { record_ref: reminder.record_ref } : {}), ...(reminder.mail_ref ? { mail_ref: reminder.mail_ref } : {}) });
      } catch (error) {
        if (current()) {
          state = { ...state, notice: { tone: 'bad', text: humanizeRpcError(error) } };
          pendingFocus = { key: 'notice', from: [`again:${id}`, 'notice'] };
        }
      } finally { if (again === op) { again = null; if (!disposed) deps.render(); } }
    })();
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
    const listed = state.reminders.some(row => row.reminder_id === id);
    const fallback = nearbyFocus(id);
    const patch: { reminder_id: string; text?: string; at?: number } = { reminder_id: id };
    if (editing.text !== editing.initialText) {
      const text = editing.text.replace(/\s+/gu, ' ').trim();
      if (!text) { fail('text', 'Enter what this reminder should say.'); return; }
      if (text.length > REMINDER_TEXT_MAX) { fail('text', `Keep the reminder within ${REMINDER_TEXT_MAX} characters.`); return; }
      if (text !== editing.initialText) patch.text = text;
    }
    if (editing.choice !== undefined || editing.value !== editing.initialValue) {
      const at = editing.choice?.at ?? zonedWallClockToEpochMs(editing.value, editing.zone);
      if (at === null || reminderWallClockValue(at, editing.zone) !== editing.value) {
        fail('at', 'Pick a valid day and time on this reminder’s clock.'); return;
      }
      if (at !== editing.initialAt) patch.at = at;
    }
    if (patch.text === undefined && patch.at === undefined) {
      state = { ...state, editing: null, notice: { text: 'No changes to save.', tone: 'ok' } };
      pendingFocus = { key: `edit:${id}` }; deps.render();
      return;
    }
    retireReadsForWrite();
    state = { ...state, working: id, notice: { text: 'Saving reminder…', tone: 'ok' } };
    pendingFocus = { key: 'notice', from: [`save:${id}`, `text:${id}`, `at:${id}`, `keep-time:${id}`,
      ...REMINDER_TIME_PRESETS.map(preset => `preset:${preset.key}:${id}`)] };
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
      const closed = closeFilteredReader(id, listed);
      pendingFocus = { key: closed ? fallback[0]! : out.updated ? `edit:${id}` : retired ? 'notice' : `${patch.text !== undefined ? 'text' : 'at'}:${id}`,
        from: ['notice'], fallback: out.updated ? fallback : 'notice' };
      const settledFocus = pendingFocus.key;
      deps.render();
      // The refresh may retire the control just restored. Redirect only if it
      // still owns focus; another row or tab must keep the focus moved there.
      pendingFocus = { key: settledFocus, from: [settledFocus], fallback: out.updated ? fallback : 'notice' };
      await refreshCurrent(true);
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
    const reminder = find(id);
    if (state.working !== null || callers.cancel === undefined || reminder?.state !== 'pending' || reminder.managed_by === 'clock') return;
    const listed = state.reminders.some(row => row.reminder_id === id);
    const fallback = nearbyFocus(id);
    retireReadsForWrite();
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
      const closed = closeFilteredReader(id, listed);
      pendingFocus = closed ? { key: fallback[0]!, from: ['notice'], fallback } : { key: 'notice', from: ['notice'] };
      deps.render();
      await refreshCurrent(true);
    } catch (error) {
      if (disposed) return;
      state = { ...state, working: null, confirming: null, notice: { text: humanizeRpcError(error), tone: 'bad' } };
      pendingFocus = { key: 'notice', from: ['notice'] };
      deps.render();
    }
  };

  const triage = createReminderTriage({ callers, rows: () => state.reminders, zone: filterZone, now,
    actionAttr: deps.actionAttr, fieldAttr: REMINDERS_FIELD_ATTR, focusAttr: REMINDERS_FOCUS_ATTR,
    render: deps.render, focus: (key, from) => { pendingFocus = { key, ...(from ? { from } : {}) }; },
    beforeStart: () => {
      if (!beforeLeave()) return false;
      state = { ...state, editing: null, confirming: null, notice: null };
      return true;
    },
    beforeWrite: retireReadsForWrite,
    onResult: item => {
      if (item.reminder || item.status === 'applied') state = { ...state,
        ...confirmedState(item.reminder_id, item.reminder, !item.reminder || item.reminder.state !== 'pending') };
    },
    refresh: () => load(true),
  });

  const focus = (key: string): string => `${REMINDERS_FOCUS_ATTR}="${e(key)}"`;
  const act = (action: string, id?: string): string =>
    `${deps.actionAttr}="${action}"${id !== undefined ? ` data-reminder-id="${e(id)}"` : ''}`;

  const editAt = (editing: NonNullable<State['editing']>): number | null => {
    if (editing.choice) return editing.choice.at;
    if (editing.value === editing.initialValue) return editing.initialAt;
    const at = zonedWallClockToEpochMs(editing.value, editing.zone);
    return at !== null && reminderWallClockValue(at, editing.zone) === editing.value ? at : null;
  };
  const previewText = (editing: NonNullable<State['editing']>): string => {
    const at = editAt(editing);
    return at === null ? `Choose a valid time on this reminder’s clock (${editing.zone}).`
      : `Selected time: ${formatReminderTimePreview(at, editing.zone)} (${editing.zone}).`;
  };
  const updateTimePreview = (target: HTMLElement): void => {
    const editor = target.closest?.('.reminders-edit');
    const preview = editor?.querySelector<HTMLElement>('[data-reminder-time-preview]');
    if (preview && state.editing) preview.textContent = previewText(state.editing);
    for (const button of editor?.querySelectorAll<HTMLElement>('[data-reminder-time-preset]') ?? []) button.setAttribute('aria-pressed', 'false');
  };

  const renderActions = (reminder: ReminderView): string => {
    const id = reminder.reminder_id;
    const busy = state.working === id;
    if (reminder.managed_by === 'clock') return `<div class="reminders-managed"><span>Managed in Yours</span>
      <a class="data-button" href="#yours" ${focus(`manage:${id}`)}>Manage in Yours</a></div>`;
    if (reminder.state !== 'pending') return renderAgain(reminder);
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
          <div class="reminders-buttons" role="group" aria-label="Choose a reminder time">
            ${REMINDER_TIME_PRESETS.map(preset => `<button type="button" class="data-button" ${act('reminders-time-preset', id)}
              data-reminder-time-preset="${preset.key}" ${focus(`preset:${preset.key}:${id}`)} aria-pressed="${state.editing?.choice?.preset === preset.key}" ${busy ? 'disabled' : ''}>${preset.label}</button>`).join('')}
          </div>
          <p class="reminders-subtle" data-reminder-time-preview role="status">${e(previewText(state.editing))}</p>
          <p class="reminders-subtle">${e(zone)} time. Presets use the time you choose them. Save to apply the selected time.</p>
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
  const renderAgain = (reminder: ReminderView): string => !callers.create || !callers.get || !reusable(reminder) ? ''
    : `<div class="reminders-buttons"><button type="button" class="data-button" ${act('reminders-again', reminder.reminder_id)}
      ${focus(`again:${reminder.reminder_id}`)}${again || state.working !== null || createForm?.pending() ? ' disabled' : ''}${again?.id === reminder.reminder_id ? ' aria-busy="true"' : ''}>${again?.id === reminder.reminder_id ? 'Checking reminder…' : 'Remind again'}</button></div>`;

  const renderOpenRow = (reminder: ReminderView, showState: boolean): string => `
    <button type="button" class="reminders-open-row" ${act('reminders-open', reminder.reminder_id)} ${focus(`open:${reminder.reminder_id}`)}
      aria-label="Open reminder: ${e(reminder.text)}"${state.detail?.id === reminder.reminder_id ? ' aria-current="true"' : ''}>
      <span class="reminders-row-time">
        <span class="reminders-when">${e(reminder.when)}</span>
        ${showState ? `<span class="reminders-state">${REMINDER_STATUS_LABELS[reminder.state]}</span>` : ''}
      </span>
      <span class="reminders-text">${e(reminder.text)}</span>
    </button>`;

  const renderUpcoming = (desktop: boolean, inline: boolean): string => {
    if (callers.list === undefined) {
      return '<p class="reminders-empty">This server cannot list reminders yet. Update it to see them here.</p>';
    }
    if (state.error !== null && !state.loaded) {
      return `<p class="reminders-error" role="alert">${e(state.error)}
        <button type="button" class="data-button" ${act('reminders-retry')} ${focus('retry')}>Try again</button></p>`;
    }
    if (!state.loaded) return '<p class="reminders-empty">Loading reminders…</p>';
    if (state.reminders.length === 0) {
      return state.applied.status !== 'pending' ? '<p class="reminders-empty">No reminders match these filters. Finished reminders are kept for 30 days.</p>'
        : state.applied.query || state.applied.range !== 'all' ? '<p class="reminders-empty">No waiting reminders match these filters.</p>'
        : callers.create ? '<p class="reminders-empty">No reminders waiting. Set one with New reminder.</p>'
        : '<p class="reminders-empty">No reminders waiting. Ask chat to set one: “remind me tomorrow at 3pm to call the dentist”.</p>';
    }
    const showState = state.applied.status !== 'pending';
    const showOpen = showState || state.applied.query || state.applied.range !== 'all';
    return `
      <ol class="reminders-list" aria-label="${state.applied.status === 'pending' ? 'Reminders still to ring' : 'Matching reminders'}">
        ${state.reminders.map((reminder) => `
          <li class="reminders-row" data-reminder-id="${e(reminder.reminder_id)}" tabindex="-1" ${focus(`row:${reminder.reminder_id}`)}>
            ${triage.renderSelection(reminder, inline)}
            ${desktop ? renderOpenRow(reminder, showState) : `<div class="reminders-when">${e(reminder.when)}${showState ? `<span class="reminders-subtle">${e(zoneOf(reminder))}</span>` : ''}</div>
              <div class="reminders-text">${e(reminder.text)}</div>
              ${showState ? `<div class="reminders-state">${REMINDER_STATUS_LABELS[reminder.state]}</div>` : ''}
              ${showOpen ? `<button type="button" class="data-button" ${act('reminders-open', reminder.reminder_id)} ${focus(`open:${reminder.reminder_id}`)}>Open reminder</button>` : ''}`}
            ${inline ? '' : renderActions(reminder)}
          </li>`).join('')}
      </ol>
      <p class="reminders-subtle">${state.paging ? `Showing ${state.reminders.length} of ${state.matchedCount} matching reminders · ${state.count} waiting in all.`
        : state.count > state.reminders.length ? `Showing the first ${state.reminders.length} of ${state.count}.` : `${state.count} waiting.`}</p>
      ${state.moreError ? `<p role="alert" class="reminders-error">${e(state.moreError)}</p>` : ''}
      ${state.nextCursor ? `<button type="button" class="data-button" ${act('reminders-more')} ${focus('more')}
        ${state.moreLoading ? 'aria-disabled="true" aria-busy="true"' : ''}>${state.moreLoading ? 'Loading…' : state.moreError ? 'Retry loading more' : 'Load more'}</button>` : ''}`;
  };

  const renderFilters = (compact: boolean): string => `
    <form class="reminders-filters" data-reminders-search aria-label="Find reminders">
      <div class="reminders-filter-fields">
      <label>Search reminders <input class="data-input" type="search" maxlength="200" ${REMINDERS_FIELD_ATTR}="query" ${focus('query')} value="${e(state.draft.query)}" ${state.paging === false ? 'disabled' : ''}></label>
      <label>Status <select class="data-select" ${REMINDERS_FIELD_ATTR}="status" ${focus('status')}>
        ${Object.entries(REMINDER_STATUS_LABELS).map(([value, label]) => `<option value="${value}"${state.draft.status === value ? ' selected' : ''}>${label}</option>`).join('')}
      </select></label>
      <label>Dates <select class="data-select" ${REMINDERS_FIELD_ATTR}="range" ${focus('range')} ${state.paging === false ? 'disabled' : ''}>
        ${([['all', 'All dates'], ['today', 'Today'], ['week', 'Next 7 days'], ['custom', 'Choose dates']] as const)
          .map(([value, label]) => `<option value="${value}"${state.draft.range === value ? ' selected' : ''}>${label}</option>`).join('')}
      </select></label>
      </div>
      ${state.draft.range === 'custom' ? `<div class="reminders-date-range"><label>From <input class="data-input" type="date" ${REMINDERS_FIELD_ATTR}="from" ${focus('from')} value="${e(state.draft.from)}"></label>
        <label>Through <input class="data-input" type="date" ${REMINDERS_FIELD_ATTR}="through" ${focus('through')} value="${e(state.draft.through)}"></label></div>` : ''}
      <div class="reminders-filter-actions"><button type="submit" class="data-button" ${focus('apply')} ${state.paging === false ? 'disabled' : ''}>Apply filters</button>
        <button type="button" class="data-button" ${act('reminders-clear')} ${focus('clear')}>Clear filters</button></div>
      <p class="reminders-subtle">Dates use ${e(filterZone())} and match the scheduled time. History includes the last 30 days.${compact ? '' : ' Apply filters to search the selected status.'}</p>
      ${state.paging === false ? '<p class="reminders-subtle">Update the server to search and load all waiting reminders.</p>' : ''}
      ${state.filterError ? `<p role="alert" class="reminders-error">${e(state.filterError)}</p>` : ''}
    </form>`;

  const renderHistory = (desktop: boolean, inline: boolean): string => {
    if (state.delivered.length === 0 || state.applied.status !== 'pending') return '';
    return `
      <details class="reminders-history" ${state.historyOpen ? 'open' : ''}>
        <summary ${act('reminders-history-toggle')} ${focus('history')}>Rung or cancelled in the last 30 days (${state.delivered.length})</summary>
        <ol class="reminders-list reminders-past">
          ${state.delivered.map((reminder) => `
            <li class="reminders-row" data-reminder-id="${e(reminder.reminder_id)}" data-state="${e(reminder.state)}">
              ${desktop ? renderOpenRow(reminder, true) : `<div class="reminders-when">${e(reminder.when)}</div>
                <div class="reminders-text">${e(reminder.text)}</div>
                <div class="reminders-state">${reminder.state === 'cancelled' ? 'Cancelled' : 'Rang'}</div>`}
              ${inline ? '' : renderAgain(reminder)}
            </li>`).join('')}
        </ol>
      </details>`;
  };

  const renderNotice = (): string => `<p class="reminders-notice" data-tone="${state.notice?.tone ?? 'ok'}" role="status" aria-live="polite" tabindex="-1" ${focus('notice')}>${e(state.notice?.text ?? '')}</p>`;
  const renderDetail = (detail: ReminderDetail, inline = false): string => {
    const reminder = detail.reminder;
    const toolbar = `<div class="${inline ? 'reminders-reader-toolbar' : 'data-contact-toolbar'}">
        <button type="button" class="data-button" ${act('reminders-back')} ${focus('back')}>${e(inline ? 'Close reminder' : deps.backLabel?.() ?? 'Back to reminders')}</button>
        <button type="button" class="data-button" ${act('reminders-retry')} ${focus(inline ? 'reader-refresh' : 'refresh')} ${detail.loading ? 'aria-disabled="true" aria-busy="true"' : ''}>${detail.loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>`;
    const heading = inline
      ? `<h3 id="reminders-reader-title" class="reminders-detail-text" tabindex="-1" ${focus('detail')}>${e(reminder?.text ?? 'Reminder')}</h3>`
      : `<h2 class="data-section-title" tabindex="-1" ${focus('detail')}>Reminder</h2>`;
    const actions = reminder ? renderActions(reminder) : '';
    const body = `${detail.error ? `<p class="reminders-error" role="alert">${e(detail.error)} <button type="button" class="data-button" ${act('reminders-retry')} ${focus('retry')}>Try again</button></p>` : ''}
      ${reminder ? `<article class="reminders-detail" data-reminder-id="${e(detail.id)}" data-state="${e(reminder.state)}">
        ${inline ? '' : `<p class="reminders-detail-text">${e(reminder.text)}</p>`}
        <dl class="reminders-detail-meta"><div><dt>Scheduled for</dt><dd>${e(reminder.when)}<span class="reminders-subtle">${e(zoneOf(reminder))}</span></dd></div>
          <div><dt>Status</dt><dd>${reminder.state === 'pending' ? 'Waiting to ring' : reminder.state === 'delivered' ? 'Rang' : 'Cancelled'}${reminder.delivered_at !== null ? `<span class="reminders-subtle">${e(formatReminderWhen(reminder.delivered_at, zoneOf(reminder), now()))}</span>` : ''}</dd></div></dl>
        ${inline ? actions : ''}
        ${reminder.record_ref && deps.readRecord && deps.openRecord ? `<section aria-label="Linked record">
          <button type="button" class="data-button" ${act('reminders-open-record')} ${focus('linked-record')}${linkedRecordBusy ? ' aria-disabled="true" aria-busy="true"' : ''}>${linkedRecordBusy ? 'Checking record…' : `Open ${e(reminder.record_ref.kind)}`}</button>
          ${linkedRecordError ? `<p role="alert">${e(linkedRecordError)}</p>` : ''}
        </section>` : ''}
        ${reminder.mail_ref && deps.readMail && deps.openMail ? `<section aria-label="Linked email">
          <button type="button" class="data-button" ${act('reminders-open-mail')} ${focus('linked-mail')}${linkedRecordBusy ? ' aria-disabled="true" aria-busy="true"' : ''}>${linkedRecordBusy ? 'Checking email…' : 'Open email'}</button>
          ${linkedRecordError ? `<p role="alert">${e(linkedRecordError)}</p>` : ''}
        </section>` : ''}
        ${inline ? '' : actions}
      </article>` : detail.loaded ? '<p class="reminders-empty">This reminder is no longer available. It may have been removed, or its 30-day history has expired.</p>'
        : detail.loading ? '<p class="reminders-empty" role="status">Loading reminder…</p>' : ''}`;
    if (inline) return `<section class="reminders-reader" aria-labelledby="reminders-reader-title">
      ${toolbar}<div class="reminders-reader-content" ${REMINDER_READER_SCROLL_ATTR}="${e(detail.id)}">${heading}${renderNotice()}${body}</div>
    </section>`;
    return `<section class="reminders" ${REMINDERS_HOST_ATTR}>
      ${toolbar}${heading}${renderNotice()}<div data-reminders-create-slot></div>${recoveries()}${body}
    </section>`;
  };
  const render = (): string => {
    const detail = state.detail;
    if (detail && !showWorkspace()) return renderDetail(detail);
    const desktop = deps.desktopWorkspace?.() === true && callers.get !== undefined;
    const inline = detail !== null;
    const list = `${state.error !== null && state.loaded ? `<p class="reminders-error" role="alert">${e(state.error)}</p>` : ''}
        ${renderFilters(inline)}${triage.render(inline)}${renderUpcoming(desktop, inline)}${renderHistory(desktop, inline)}`;
    return `<section class="reminders" ${REMINDERS_HOST_ATTR}>
        <header class="reminders-header">
          <h2 class="data-section-title">Reminders</h2>
          <div class="reminders-header-actions">
          ${detail ? '' : `<button type="button" class="data-button" ${act('reminders-retry')} ${focus('refresh')}
            ${state.loading || state.moreLoading ? 'aria-disabled="true" aria-busy="true"' : ''}>${state.loading ? 'Refreshing…' : 'Refresh'}</button>`}
          ${callers.create ? `<button type="button" class="data-button data-button--primary" ${act('reminders-create')} ${focus('create')}>New reminder</button>` : ''}
          </div>
        </header>
        ${detail ? '' : '<p class="reminders-intro">Each reminder rings once, at its time, on every channel you set up.</p>'}
        <div data-reminders-create-slot></div>
        ${recoveries()}
        ${detail ? `<div class="reminders-workspace"><div class="reminders-workspace-list">${list}</div>${renderDetail(detail, true)}</div>`
          : renderNotice() + list}
      </section>`;
  };
  return {
    open,
    resumeDraft,
    showRecoveryNotice: message => { recoveryError = message; deps.render(); },
    detailId: () => state.detail?.id,
    hasListReader: () => listReader,
    closeReaderFromKeyboard: () => showWorkspace() && !state.editing && !state.confirming && !state.creating && open(null),
    render,

    refresh: (silent = false) => { retireAgain(); return refreshCurrent(silent); },

    handleAction: (action, target) => {
      if (action.startsWith('reminders-recovery-')) {
        if (state.working !== null || createForm?.hasDraft() || dirtyEdit() || !deps.recovery) return true;
        const id = target.getAttribute('data-reminder-draft-id') ?? '', name = action.slice('reminders-recovery-'.length);
        if (name === 'resume') { resumeDraft(id, target); return true; }
        if (name === 'discard') { recoveryDiscard = id; pendingFocus = { key: `recovery-keep:${id}` }; }
        else if (name === 'keep') { recoveryDiscard = undefined; pendingFocus = { key: `recovery-discard:${id}` }; }
        else if (name === 'remove' && recoveryDiscard === id) {
          if (!deps.recovery.remove(id)) { recoveryError = 'This recovery copy could not be discarded. Try again.'; pendingFocus = { key: `recovery-remove:${id}` }; }
          else { recoveryError = ''; recoveryDiscard = undefined; pendingFocus = { key: 'create' }; }
        }
        deps.render(); return true;
      }
      if (!action.startsWith(REMINDERS_ACTION_PREFIX)) return false;
      if (disposed) return true;
      if (action !== 'reminders-open-record' && action !== 'reminders-open-mail') { linkedRecordRead++; linkedRecordBusy = false; linkedRecordError = undefined; }
      if (action === 'reminders-open-mail') {
        const detail = state.detail, ref = detail?.reminder?.mail_ref;
        if (!detail || !ref || !deps.readMail || !deps.openMail || linkedRecordBusy || !beforeLeave()) return true;
        const mine = ++linkedRecordRead;
        linkedRecordBusy = true; linkedRecordError = undefined; deps.render();
        const current = () => !disposed && mine === linkedRecordRead && state.detail === detail && deps.isActive?.() !== false;
        void (async () => {
          try {
            const message = await deps.readMail!(ref);
            if (!current()) return;
            if (!message.reminder_ref || !sameReminderMailReference(ref, message.reminder_ref))
              throw new Error('This email or mailbox was removed or replaced. Reopen it from Mail.');
            if (leaveAllowed()) await deps.openMail!(message, ref, current);
          } catch (cause) { if (current()) linkedRecordError = humanizeRpcError(cause); }
          finally { if (current()) { linkedRecordBusy = false; deps.render(); } }
        })();
        return true;
      }
      if (action === 'reminders-open-record') {
        const detail = state.detail, ref = readReminderRecordReference(detail?.reminder?.record_ref);
        if (!detail || !ref || !deps.readRecord || !deps.openRecord || linkedRecordBusy || !beforeLeave()) return true;
        const mine = ++linkedRecordRead;
        linkedRecordBusy = true; linkedRecordError = undefined; deps.render();
        const current = () => !disposed && mine === linkedRecordRead && state.detail === detail && deps.isActive?.() !== false;
        void (async () => {
          try {
            const response = await deps.readRecord!(ref);
            if (!current()) return;
            if (!matchesReminderRecord(ref, response.entity)) throw new Error('The linked record was removed or replaced. It cannot be opened from this reminder.');
            linkedRecordBusy = false;
            if (!beforeLeave()) return;
            deps.openRecord!(response);
          } catch (error) { if (current()) linkedRecordError = humanizeRpcError(error); }
          finally { if (current()) { linkedRecordBusy = false; deps.render(); } }
        })();
        return true;
      }
      if (triage.handleAction(action)) return true;
      if (triage.writing()) { beforeLeave(); return true; }
      const id = target.getAttribute('data-reminder-id') ?? '';
      if (action === 'reminders-back') { if (!deps.onBack?.()) open(null); return true; }
      if (action === 'reminders-open') {
        if (find(id) || state.delivered.some(row => row.reminder_id === id)) {
          open(id, true, deps.desktopWorkspace?.() === true && target.classList?.contains('reminders-open-row'));
        }
        return true;
      }
      if (action === 'reminders-create') { openCreate(target); return true; }
      if (action === 'reminders-again') { remindAgain(id, target); return true; }
      if (action === 'reminders-apply' || action === 'reminders-clear') { applyFilters(action === 'reminders-clear'); return true; }
      if (action === 'reminders-more') { if (beforeLeave()) void load(true, true); return true; }
      if (action === 'reminders-retry') {
        if (!state.loading && !state.moreLoading && !state.detail?.loading && beforeLeave()) { triage.reset(); void refreshCurrent(false); }
        return true;
      }
      if (action === 'reminders-history-toggle') {
        // The browser opens or shuts it; the state keeps it so across repaints.
        state = { ...state, historyOpen: !state.historyOpen };
        return true;
      }
      retireAgain();
      if (state.working !== null) return true;
      const editing = state.editing;
      if (editing && id !== editing.id && (action === 'reminders-edit' || action === 'reminders-cancel')
        && dirtyEdit()) {
        state = { ...state, notice: { text: 'Save or discard your reminder changes before opening another one.', tone: 'bad' } };
        pendingFocus = { key: `text:${editing.id}` }; deps.render(); return true;
      }
      const reminder = find(id);
      if (action === 'reminders-time-preset') {
        const preset = REMINDER_TIME_PRESETS.find(value => value.key === target.getAttribute('data-reminder-time-preset'));
        if (!preset || !editing || editing.id !== id || reminder?.state !== 'pending' || reminder.managed_by === 'clock') return true;
        try {
          const choice = reminderTimePreset(preset.key, now(), editing.zone);
          state = { ...state, editing: { ...editing, value: choice.value, choice: { preset: preset.key, at: choice.at }, error: null, errorField: undefined } };
        } catch (error) {
          state = { ...state, editing: { ...editing, error: humanizeRpcError(error), errorField: 'at' } };
        }
        pendingFocus = { key: `preset:${preset.key}:${id}` }; deps.render(); return true;
      }
      if (action === 'reminders-edit' || action === 'reminders-cancel') triage.reset();
      if (action === 'reminders-edit' && reminder !== undefined && reminder.managed_by !== 'clock' && reminder.state === 'pending') {
        const initialValue = reminderWallClockValue(reminder.at, zoneOf(reminder));
        state = {
          ...state, confirming: null, notice: null,
          editing: { id, value: initialValue, initialValue, initialAt: reminder.at, text: reminder.text, initialText: reminder.text,
            zone: zoneOf(reminder), error: null },
        };
        pendingFocus = { key: `text:${id}` };
      } else if (action === 'reminders-edit-close') {
        state = { ...state, editing: null };
        pendingFocus = { key: `edit:${id}` };
      } else if (action === 'reminders-save') {
        void save(id);
        return true;
      } else if (action === 'reminders-cancel' && reminder?.state === 'pending' && reminder.managed_by !== 'clock') {
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
      if (target.getAttribute(REMINDERS_FIELD_ATTR) === 'triage-at') return triage.handleChange(target);
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
          [field === 'text' ? 'text' : 'value']: (target as HTMLInputElement | HTMLTextAreaElement).value,
          ...(field === 'at' ? { choice: undefined } : {}), error: null, errorField: undefined } };
        if (field === 'at') updateTimePreview(target);
      }
      return true;
    },

    handleChange: (target) => {
      if (triage.handleChange(target)) return true;
      const field = target.getAttribute(REMINDERS_FIELD_ATTR);
      if (field === 'status') {
        const status = (target as HTMLSelectElement).value;
        if (status === 'all' || isReminderState(status)) state = { ...state, draft: { ...state.draft, status } };
        return true;
      }
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
          [field === 'text' ? 'text' : 'value']: (target as HTMLInputElement | HTMLTextAreaElement).value,
          ...(field === 'at' ? { choice: undefined } : {}), error: null, errorField: undefined } };
        if (field === 'at') updateTimePreview(target);
      }
      return true;
    },

    isBusy: () => triage.isBusy() || again !== null || linkedRecordBusy || state.detail?.loading === true || state.loading || state.moreLoading || state.working !== null || state.editing !== null || state.confirming !== null
      || createForm?.hasDraft() === true || JSON.stringify(state.draft) !== JSON.stringify(state.applied),
    beforeLeave,
    whenLoaded: () => Promise.all([again !== null ? againPending : state.detail ? detailPending : pending,
      ...(listReader ? [pending] : []), triage.whenSettled()]).then(() => undefined),

    hasUnsavedChanges: () => {
      const editing = state.editing;
      if (createForm?.hasDraft()) return true;
      if (editing === null) return false;
      const reminder = find(editing.id);
      return reminder !== undefined && dirtyEdit();
    },

    hasInFlightWork: () => triage.writing() || state.working !== null || createForm?.pending() === true,

    captureFocus: (active) => {
      createFocus = createHost?.contains(active as Node) ? active as HTMLElement : null;
      const key = (active as HTMLElement | null | undefined)?.getAttribute?.(REMINDERS_FOCUS_ATTR);
      return typeof key === 'string' && key.length > 0 ? key : null;
    },

    restoreFocus: (root, key) => {
      if (disposed) return;
      const searchForm = root.querySelector?.<HTMLFormElement>('[data-reminders-search]');
      if (searchForm) searchForm.onsubmit = event => { event.preventDefault(); applyFilters(); };
      const createSlot = root.querySelector?.('[data-reminders-create-slot]');
      if (state.creating && createHost && createSlot && createHost.parentNode !== createSlot) createSlot.appendChild(createHost);
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
      const fallbacks = owned && request.fallback !== undefined ? typeof request.fallback === 'string' ? [request.fallback] : request.fallback : [];
      const found = control(wanted) ?? fallbacks.map(control).find(Boolean);
      const foundKey = found?.getAttribute?.(REMINDERS_FOCUS_ATTR) ?? wanted;
      found?.focus?.({ preventScroll: !owned || foundKey === key });
      return !!found && owned && foundKey !== key;
    },

    dispose: () => {
      disposed = true;
      triage.dispose();
      linkedRecordRead++;
      seq += 1;
      detailSeq += 1;
      retireAgain();
      createForm?.dispose();
      pendingFocus = null;
    },
  };
};

/** The tab's styles, scoped to its host; injected with the Data route's. */
export const REMINDERS_STYLES = `
[${REMINDERS_HOST_ATTR}] .reminders-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; min-width:0; margin:0 0 8px; }
[${REMINDERS_HOST_ATTR}] .reminders-header > .data-section-title { margin:0; font-size:20px; font-weight:600; line-height:1.2; }
[${REMINDERS_HOST_ATTR}] .reminders-header-actions { display:flex; flex-wrap:wrap; gap:8px; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-header-actions > .data-button--primary { min-width:var(--wc-task-action-width,7.5rem); }
[${REMINDERS_HOST_ATTR}] .reminders-filters { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:12px; min-width:0; margin:16px 0; }
[${REMINDERS_HOST_ATTR}] .reminders-filter-fields { display:grid; grid-template-columns:minmax(0,1fr) repeat(2,minmax(0,10rem)); gap:12px; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-filters label { display:flex; flex-direction:column; gap:6px; min-width:0; font-size:12px; font-weight:600; line-height:1.4; color:var(--muted); }
[${REMINDERS_HOST_ATTR}] .reminders-filters :is(input,select) { box-sizing:border-box; width:100%; min-width:0; max-width:100%; min-height:var(--wc-control-h,44px); padding:0 10px; border-radius:var(--wc-radius,9px); font-weight:400; }
[${REMINDERS_HOST_ATTR}] .reminders-date-range { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); grid-column:1 / -1; gap:12px; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-filter-actions { display:flex; gap:8px; grid-column:2; grid-row:1; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-header-actions > .data-button,
[${REMINDERS_HOST_ATTR}] .reminders-filter-actions > .data-button { min-height:var(--wc-control-h,44px); padding:0 12px; border-radius:var(--wc-radius,9px); font-weight:600; }
[${REMINDERS_HOST_ATTR}] .reminders-filters > p { grid-column:1 / -1; margin:0; }
@media(max-width:1100px) {
  [${REMINDERS_HOST_ATTR}] .reminders-filters { grid-template-columns:minmax(0,1fr); }
  [${REMINDERS_HOST_ATTR}] .reminders-filter-actions { grid-column:1; grid-row:auto; justify-content:flex-end; }
}
@media(max-width:600px) {
  [${REMINDERS_HOST_ATTR}] .reminders-filter-fields { grid-template-columns:repeat(2,minmax(0,1fr)); }
  [${REMINDERS_HOST_ATTR}] .reminders-filter-fields > label:first-child { grid-column:1 / -1; }
  [${REMINDERS_HOST_ATTR}] .reminders-filter-actions > .data-button { flex:1; }
}
@media(max-width:380px) {
  [${REMINDERS_HOST_ATTR}] .reminders-header-actions { width:100%; }
  [${REMINDERS_HOST_ATTR}] .reminders-header-actions > .data-button { flex:1; }
  [${REMINDERS_HOST_ATTR}] .reminders-filter-fields,
  [${REMINDERS_HOST_ATTR}] .reminders-date-range { grid-template-columns:minmax(0,1fr); }
}
[${REMINDERS_HOST_ATTR}] { min-width: 0; }
[${REMINDERS_HOST_ATTR}] .reminders-detail { display:grid; gap:20px; max-width:48rem; padding:24px; border:1px solid var(--border); border-radius:12px; background:var(--surface); min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-detail-text { margin:0; font-size:20px; line-height:1.5; overflow-wrap:anywhere; }
[${REMINDERS_HOST_ATTR}] .reminders-detail-meta { display:flex; flex-wrap:wrap; gap:16px 40px; margin:0; }
[${REMINDERS_HOST_ATTR}] .reminders-detail-meta div { display:grid; gap:4px; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-detail-meta dt { color:var(--muted); font-size:12px; }
[${REMINDERS_HOST_ATTR}] .reminders-detail-meta dd { display:grid; gap:4px; margin:0; font-size:14px; overflow-wrap:anywhere; }
[${REMINDERS_HOST_ATTR}] .reminders-intro { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
[${REMINDERS_HOST_ATTR}] .reminders-notice { margin: 0 0 8px; font-size: 13px; min-height: 0; }
[${REMINDERS_HOST_ATTR}] .reminders-notice:empty { display: none; }
[${REMINDERS_HOST_ATTR}] .reminders-notice[data-tone="bad"] { color: var(--danger); }
[${REMINDERS_HOST_ATTR}] .reminders-triage { display:grid; gap:12px; margin:16px 0; padding:16px; border:1px solid var(--border); border-radius:10px; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-triage :is(p,h3) { margin:0; overflow-wrap:anywhere; }
[${REMINDERS_HOST_ATTR}] .reminders-triage :is(button,input) { min-height:44px; }
[${REMINDERS_HOST_ATTR}] .reminders-triage :is(.reminders-triage-review,.reminders-triage-time) { display:grid; gap:12px; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-triage ul { display:grid; gap:12px; padding-left:20px; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-triage li { overflow-wrap:anywhere; }
[${REMINDERS_HOST_ATTR}] .reminders-triage li[data-outcome="needs_review"],
[${REMINDERS_HOST_ATTR}] .reminders-triage li[data-outcome="failed"] { color:var(--danger); }
[${REMINDERS_HOST_ATTR}] .reminders-triage-select { display:flex; gap:8px; align-items:center; min-height:44px; grid-column:1 / -1; cursor:pointer; }
[${REMINDERS_HOST_ATTR}] .reminders-triage-select input { width:20px; height:20px; margin:0; }
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
[${REMINDERS_HOST_ATTR}] .reminders-open-row {
  display:grid; grid-column:1 / span 2; grid-template-columns:minmax(0,14em) minmax(0,1fr); align-items:center;
  gap:6px 16px; width:100%; min-width:0; min-height:44px; padding:8px 10px; border:0; border-radius:6px;
  background:transparent; color:inherit; font:inherit; text-align:start; cursor:pointer;
}
[${REMINDERS_HOST_ATTR}] .reminders-row-time { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 10px; min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-open-row:hover { background:var(--surface-subtle); }
[${REMINDERS_HOST_ATTR}] .reminders-open-row[aria-current="true"] { background:var(--accent-weak); box-shadow:inset 3px 0 var(--accent); }
[${REMINDERS_HOST_ATTR}] .reminders-workspace {
  display:grid; grid-template-columns:minmax(17rem,38%) minmax(0,1fr); align-items:start; gap:var(--wc-space-lg,24px); min-width:0;
}
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list { min-width:0; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-filters { grid-template-columns:minmax(0,1fr); margin-block-start:0; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-filter-fields { grid-template-columns:repeat(2,minmax(0,1fr)); }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-filter-fields > label:first-child { grid-column:1 / -1; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-filter-actions { grid-column:1; grid-row:auto; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-filter-actions > .data-button { flex:1; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-triage--compact { padding:0; border:0; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-row { grid-template-columns:auto minmax(0,1fr); gap:4px; padding:4px; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-open-row { grid-column:1 / -1; grid-template-columns:minmax(0,1fr); }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-triage-select { grid-column:1; justify-content:center; align-self:stretch; min-width:44px; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-triage-select + .reminders-open-row { grid-column:2; }
[${REMINDERS_HOST_ATTR}] .reminders-workspace-list .reminders-when { font-size:12px; color:var(--muted); }
[${REMINDERS_HOST_ATTR}] .reminders-reader {
  display:flex; flex-direction:column; min-width:0; overflow:hidden;
  border:1px solid var(--border); border-radius:var(--wc-radius,9px); background:var(--surface);
}
[${REMINDERS_HOST_ATTR}] .reminders-reader-toolbar {
  display:flex; justify-content:space-between; align-items:start; flex-wrap:wrap; flex-shrink:0; gap:8px; padding:12px 16px;
  border-bottom:1px solid var(--border);
}
[${REMINDERS_HOST_ATTR}] .reminders-reader-content {
  display:grid; grid-auto-rows:max-content; align-content:start; gap:12px; min-width:0; min-height:0; overflow:auto; padding:16px;
}
[${REMINDERS_HOST_ATTR}] .reminders-reader .reminders-detail { gap:16px; max-width:none; padding:0; border:0; border-radius:0; background:none; }
[${REMINDERS_HOST_ATTR}] .reminders-reader .reminders-detail-meta > div { align-content:start; }
[${REMINDERS_HOST_ATTR}] .reminders-reader :is(.reminders-notice,.reminders-empty) { margin:0; }
@media (min-height:600px) {
  [${REMINDERS_HOST_ATTR}] .reminders-reader {
    position:sticky; top:var(--wc-space-md,16px);
    max-height:calc(100dvh - var(--wc-header-height,56px) - var(--wc-connection-banner-h,0px) - 128px);
  }
}
@media (max-width: 720px) {
  [${REMINDERS_HOST_ATTR}] .reminders-row { grid-template-columns: minmax(0, 1fr); }
}
`;
