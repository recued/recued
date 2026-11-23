import { formatReminderWhen, readReminderRecordReference, sameReminderRecordReference,
  readReminderMailReference, sameReminderMailReference,
  type ReminderListCursor, type ReminderRecordReference, type ReminderMailReference, type ReminderView } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { createRemindersSurface, type ReminderCallers, type RemindersSurface } from './reminders-surface.js';
import { validateReminderSearchPage } from '../reminders/reminder-search.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { reconcileNativeField } from '../shell/reconcile-native-field.js';
import type { ReminderRecoveryStore } from '../reminders/reminder-draft-recovery.js';

export const RECORD_REMINDER_FOCUS = 'data-record-reminder-focus';
export const RECORD_REMINDER_HOST = 'data-record-reminder-host';
interface Page {
  rows: ReminderView[]; total: number; next: ReminderListCursor | null; pages: number;
  loaded: boolean; loading: boolean; error?: string;
}
const empty = (): Page => ({ rows: [], total: 0, next: null, pages: 0, loaded: false, loading: false });

/** One saved record lifetime. Reads and the existing reminder editor share
 * this scope; the source record is never written by a reminder action. */
export const createRecordReminders = (deps: {
  root: HTMLElement; callers: ReminderCallers;
  recovery?: ReminderRecoveryStore;
  actionAttr: string; current(): boolean; changed(): void; now?: () => number; timeZone?: () => string | undefined;
} & ({ reference: ReminderRecordReference; mailReference?: never } | { reference?: never; mailReference: ReminderMailReference })) => {
  const ref = deps.reference ? { ...deps.reference } : undefined;
  const mail = deps.mailReference ? { ...deps.mailReference } : undefined;
  const scope = { ...(ref ? { record_ref: ref } : {}), ...(mail ? { mail_ref: mail } : {}) };
  const now = deps.now ?? Date.now;
  let pending = empty(), history = empty(), historyOpen = false, started = false, disposed = false;
  let readSeq = 0, historySeq = 0, detailSeq = 0;
  let pendingRead = Promise.resolve(), historyRead = Promise.resolve();
  let detail: RemindersSurface | undefined, host: HTMLElement | undefined, paintDetail = false;
  let held: string | null = null, heldDetail: string | null = null, focusNext: string | undefined;
  let returnKey = 'refresh', notice: string | undefined;
  const current = () => !disposed && deps.current();
  const matches = (row: ReminderView) => {
    const got = readReminderRecordReference(row.record_ref);
    const email = readReminderMailReference(row.mail_ref);
    return ref ? got !== undefined && !email && sameReminderRecordReference(ref, got)
      : mail !== undefined && email !== undefined && !got && sameReminderMailReference(mail, email);
  };
  const confirm = (row: ReminderView | null | undefined) => {
    if (row && !matches(row)) throw new Error('This reminder no longer belongs to this saved record. Refresh its reminders.');
  };
  const changed = () => { if (current()) deps.changed(); };
  const read = (past: boolean, append = false): Promise<void> => {
    if (!deps.callers.list || !current()) return Promise.resolve();
    const old = past ? history : pending;
    if (append && (old.loading || !old.next)) return past ? historyRead : pendingRead;
    const mine = past ? ++historySeq : ++readSeq, goal = append ? 1 : Math.max(1, old.pages);
    const rows = new Map((append ? old.rows : []).map(row => [row.reminder_id, row]));
    let cursor = append ? old.next : null, pages = append ? old.pages : 0;
    const next: Page = { ...old, loading: true, error: undefined };
    if (past) history = next; else pending = next;
    changed();
    const active = () => current() && mine === (past ? historySeq : readSeq);
    const work = (async () => {
      try {
        let total = 0;
        for (let page = 0; page < goal; page++) {
          const input = { ...scope, state: past ? 'all' as const : 'pending' as const,
            ...(past ? { history_only: true as const } : {}), ...(cursor ? { cursor } : {}) };
          const out = await deps.callers.list!({ limit: 20, page: input });
          if (!active()) return;
          validateReminderSearchPage(out, input);
          for (const row of out.reminders) rows.set(row.reminder_id, row);
          total = out.page!.matched_count; cursor = out.page!.next_cursor; pages++;
          if (rows.size > total || !cursor && rows.size !== total) throw new Error('These reminders changed while loading. Refresh to try again.');
          if (!cursor) break;
        }
        const result: Page = { rows: [...rows.values()], total, next: cursor, pages, loaded: true, loading: false };
        if (past) history = result; else pending = result;
      } catch (error) {
        if (active()) {
          const result = { ...old, loading: false, error: humanizeRpcError(error) };
          if (past) history = result; else pending = result;
        }
      } finally { if (active()) changed(); }
    })();
    if (past) historyRead = work; else pendingRead = work;
    return work;
  };
  const refresh = () => Promise.all([read(false), ...(historyOpen ? [read(true)] : [])]).then(() => {});
  const bound: ReminderCallers = {
    ...deps.callers,
    get: deps.callers.get ? async input => {
      if (!current()) throw new Error('This reader is no longer open.');
      const out = await deps.callers.get!(input);
      if (!current()) throw new Error('This reader is no longer open.');
      confirm(out.reminder); return out;
    } : undefined,
    list: deps.callers.list ? async args => {
      const input = { ...args.page, ...scope, state: args.page?.state ?? 'pending' as const };
      const out = await deps.callers.list!({ ...args, page: input });
      validateReminderSearchPage(out, input);
      for (const row of out.delivered ?? []) confirm(row);
      return out;
    } : undefined,
    update: deps.callers.update && deps.callers.get ? async input => {
      const checked = await bound.get!({ reminder_id: input.reminder_id });
      if (!checked.reminder || !current()) throw new Error('This reminder is no longer available.');
      const out = await deps.callers.update!(input); confirm(out.reminder);
      if (out.updated) notice = out.message;
      return out;
    } : undefined,
    cancel: deps.callers.cancel && deps.callers.get ? async input => {
      const checked = await bound.get!({ reminder_id: input.reminder_id });
      if (!checked.reminder || !current()) throw new Error('This reminder is no longer available.');
      const out = await deps.callers.cancel!(input); confirm(out.reminder);
      if (out.cancelled) notice = out.message;
      return out;
    } : undefined,
    create: deps.callers.create ? async input => {
      if (!current()) throw new Error('This reader is no longer open.');
      if (input.record_ref && (!ref || !sameReminderRecordReference(ref, input.record_ref))
        || input.mail_ref && (!mail || !sameReminderMailReference(mail, input.mail_ref)))
        throw new Error('Reopen this record before setting a reminder.');
      const out = await deps.callers.create!({ ...input, ...scope }); confirm(out.reminder);
      if (!out.reminder.record_ref && !out.reminder.mail_ref) throw new Error('The linked reminder could not be confirmed. Review existing reminders before retrying.');
      notice = `Reminder ${out.reminder.state === 'pending' ? 'set' : 'history'}: ${out.confirmation}`;
      return out;
    } : undefined,
  };
  const paint = () => {
    if (!detail || !host || !paintDetail) return;
    paintDetail = false;
    const next = host.ownerDocument.createElement('div'); next.innerHTML = detail.render();
    const field = host.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    const nextField = next.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    if (!(field?.validity.badInput && nextField && nextField.value === field.value && reconcileNativeField(host, next, field, nextField))) {
      host.replaceChildren(...Array.from(next.childNodes));
    }
  };
  const closeDetail = (): boolean => {
    if (!detail?.beforeLeave()) return true;
    detailSeq++; detail.dispose(); detail = undefined; host?.remove(); host = undefined;
    focusNext = returnKey; changed(); void refresh(); return true;
  };
  const open = async (id: string, mode: 'open' | 'edit' | 'cancel' | 'again', target: HTMLElement) => {
    if (!current() || detail && !detail.beforeLeave()) return;
    const mine = ++detailSeq; detail?.dispose();
    host = target.ownerDocument.createElement('div'); host.setAttribute(RECORD_REMINDER_HOST, '');
    returnKey = `${mode}:${id}`; heldDetail = null;
    const surface = createRemindersSurface({ callers: bound, actionAttr: deps.actionAttr, now,
      recovery: deps.recovery, recoveryList: false,
      ...(deps.timeZone ? { timeZone: deps.timeZone } : {}), isActive: current,
      backLabel: () => 'Back to linked reminders', onBack: closeDetail,
      render: () => { paintDetail = true; changed(); },
    });
    detail = surface; paintDetail = true;
    surface.open(id, false);
    await surface.whenLoaded();
    if (!current() || detail !== surface || mine !== detailSeq) return;
    if (mode !== 'open') surface.handleAction(mode === 'edit' ? 'reminders-edit' : mode === 'again' ? 'reminders-again' : 'reminders-cancel', target);
  };
  const renderRow = (row: ReminderView) => {
    const id = row.reminder_id, key = (mode: string) => `${RECORD_REMINDER_FOCUS}="${mode}:${e(id)}"`;
    const act = (mode: string) => `${deps.actionAttr}="record-reminders-${mode}" data-reminder-id="${e(id)}" ${key(mode)}`;
    return `<li class="reminders-row" data-record-reminder-row="${e(id)}" data-state="${row.state}">
      <div class="reminders-when">${e(formatReminderWhen(row.at, row.time_zone ?? 'UTC', now()))}<br>${e(row.time_zone ?? 'UTC')}</div>
      <div class="reminders-text">${e(row.text)}</div>
      ${row.state === 'pending' ? '' : `<div class="reminders-state">${row.state === 'delivered' ? 'Rang' : 'Cancelled'}</div>`}
      <div class="reminders-buttons"><button type="button" class="data-button" ${act('open')}>Open reminder</button>
        ${row.state === 'pending' && !row.managed_by && bound.update ? `<button type="button" class="data-button" ${act('edit')}>Reschedule</button>` : ''}
        ${row.state === 'pending' && !row.managed_by && bound.cancel ? `<button type="button" class="data-button" ${act('cancel')}>Cancel</button>` : ''}
        ${row.state !== 'pending' && !row.managed_by && deps.callers.create ? `<button type="button" class="data-button" ${act('again')}>Remind again</button>` : ''}</div></li>`;
  };
  const renderPage = (page: Page, past: boolean) => `
    ${page.loading ? '<p role="status">Loading linked reminders…</p>' : ''}
    ${page.error ? `<p role="alert">${e(page.error)} <button type="button" class="data-button" ${RECORD_REMINDER_FOCUS}="${past ? 'history-retry' : 'retry'}" ${deps.actionAttr}="record-reminders-${past ? 'history-refresh' : 'refresh'}">Try again</button></p>` : ''}
    ${page.loaded && !page.rows.length && !page.error && !page.loading ? `<p>${past ? 'No linked reminders in recent history.' : 'No linked reminders waiting.'}</p>` : ''}
    ${page.rows.length ? `<p>${page.rows.length} of ${page.total} ${past ? 'in recent history' : 'waiting'}</p><ol class="reminders-list">${page.rows.map(renderRow).join('')}</ol>` : ''}
    ${page.next ? `<button type="button" class="data-button" ${RECORD_REMINDER_FOCUS}="${past ? 'history-more' : 'more'}" ${deps.actionAttr}="record-reminders-${past ? 'history-more' : 'more'}"${page.loading ? ' disabled' : ''}>Load more${past ? ' history' : ' reminders'}</button>` : ''}`;
  return {
    current, refresh,
    initialReadPending: () => !!deps.callers.list && !pending.loaded && !pending.error,
    start() { if (!started && current()) { started = true; void read(false); } },
    preservedHost: () => host,
    busy: () => detail?.hasInFlightWork() === true,
    hasDraft: () => detail?.hasUnsavedChanges() === true,
    beforeLeave: () => detail?.beforeLeave() ?? true,
    prepareCreate() {
      if (detail && !detail.beforeLeave()) return false;
      if (detail) closeDetail();
      return true;
    },
    whenLoaded: async () => { await Promise.all([pendingRead, historyRead]); await detail?.whenLoaded(); },
    capture(active: Element | null) {
      held = active?.getAttribute(RECORD_REMINDER_FOCUS) ?? null;
      heldDetail = host?.contains(active) ? detail?.captureFocus(active) ?? null : null;
    },
    restore() {
      if (!current()) return;
      const slot = deps.root.querySelector(`[${RECORD_REMINDER_HOST}]`);
      if (host && slot !== host && slot) slot.replaceWith(host);
      paint();
      if (detail && host) detail.restoreFocus(host, heldDetail);
      const key = focusNext ?? held; focusNext = undefined; held = null; heldDetail = null;
      if (!key || detail) return;
      const controls = Array.from(deps.root.querySelectorAll<HTMLElement>(`[${RECORD_REMINDER_FOCUS}]`));
      (controls.find(node => node.getAttribute(RECORD_REMINDER_FOCUS) === key)
        ?? controls.find(node => node.getAttribute(RECORD_REMINDER_FOCUS) === (notice ? 'notice' : 'heading')))?.focus({ preventScroll: true });
    },
    render() {
      return `<section data-work-linked-reminders aria-label="Linked reminders"><h3 tabindex="-1" ${RECORD_REMINDER_FOCUS}="heading">Linked reminders</h3>
        ${detail ? `<div ${RECORD_REMINDER_HOST}></div>` : `<button type="button" class="data-button" ${deps.actionAttr}="record-reminders-refresh" ${RECORD_REMINDER_FOCUS}="refresh">Refresh linked reminders</button>
          ${notice ? `<p role="status" tabindex="-1" ${RECORD_REMINDER_FOCUS}="notice">${e(notice)}</p>` : ''}
          ${renderPage(pending, false)}
          <details data-record-reminder-history${historyOpen ? ' open' : ''}><summary ${deps.actionAttr}="record-reminders-history" ${RECORD_REMINDER_FOCUS}="history">Recent history · last 30 days</summary>
            ${historyOpen ? renderPage(history, true) : ''}</details>`}
      </section>`;
    },
    handle(action: string, target: HTMLElement): boolean {
      if (action.startsWith('reminders-') && target.closest('[data-work-linked-reminders]')) return detail?.handleAction(action, target) ?? true;
      if (!action.startsWith('record-reminders-')) return false;
      if (!current() || detail?.hasInFlightWork()) return true;
      const id = target.getAttribute('data-reminder-id') ?? '';
      if (action === 'record-reminders-refresh') void refresh();
      else if (action === 'record-reminders-more') void read(false, true);
      else if (action === 'record-reminders-history-refresh') void read(true);
      else if (action === 'record-reminders-history-more') void read(true, true);
      else if (action === 'record-reminders-history') { historyOpen = !historyOpen; changed(); if (historyOpen) void read(true); }
      else if ([...pending.rows, ...history.rows].some(row => row.reminder_id === id)) {
        const mode = action === 'record-reminders-edit' ? 'edit' : action === 'record-reminders-cancel' ? 'cancel'
          : action === 'record-reminders-again' ? 'again' : 'open';
        void open(id, mode, target);
      }
      return true;
    },
    input: (target: HTMLElement) => !!target.closest('[data-work-linked-reminders]') && (detail?.handleInput(target) ?? false),
    change: (target: HTMLElement) => !!target.closest('[data-work-linked-reminders]') && (detail?.handleChange(target) ?? false),
    dispose() { disposed = true; readSeq++; historySeq++; detailSeq++; detail?.dispose(); host?.remove(); },
  };
};
