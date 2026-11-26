import { formatReminderWhen, reminderDetailLink, type ReminderListCursor, type ReminderView } from '@recued/contracts';
import { e, stampZone } from '@recued/ui-shared';
import type { ReminderCallers } from '../data/reminders-surface.js';
import { todayWindow } from '../data/today-view.js';
import { REMINDER_TIME_PRESETS, reminderTimePreset, type ReminderTimePreset } from '../reminders/reminder-time.js';
import { validateReminderSearchPage } from '../reminders/reminder-search.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export const TODAY_REMINDER_FOCUS = 'data-today-reminder-focus';
export const createTodayReminders = (deps: {
  callers?: ReminderCallers; now(): number;
  changed(): void; blocked(): boolean;
}) => {
  const callers = deps.callers ?? {};
  let rows: ReminderView[] = [], loaded = false, loading = false, disposed = false, sequence = 0;
  let span = todayWindow(deps.now()), error: string | undefined, unsupported = false;
  let notice: string | undefined, working: string | undefined, confirming: string | undefined;
  let pending = Promise.resolve(), nextFocus: string | undefined;
  let retry: { id: string; preset: ReminderTimePreset; at: number; previousAt: number } | undefined;
  const zone = (row: ReminderView) => stampZone(row.time_zone ?? 'UTC');
  const visible = (row: ReminderView) => row.state === 'pending' && !row.managed_by && row.at < span.before;
  const keep = (row: ReminderView) => {
    rows = rows.filter(value => value.reminder_id !== row.reminder_id);
    if (visible(row)) rows.push(row);
    rows.sort((a, b) => a.at - b.at || a.reminder_id.localeCompare(b.reminder_id));
  };
  const load = (): Promise<void> => {
    if (!callers.list || disposed || working) return pending;
    const mine = ++sequence, window = todayWindow(deps.now());
    loading = true; error = undefined; unsupported = false; deps.changed();
    pending = (async () => {
      try {
        const found = new Map<string, ReminderView>();
        let cursor: ReminderListCursor | undefined;
        for (let page = 0; page < 100; page++) {
          const input = { state: 'pending' as const, before: window.before, ...(cursor ? { cursor } : {}) };
          const out = await callers.list!({ limit: 100, page: input });
          if (disposed || mine !== sequence) return;
          validateReminderSearchPage(out, input);
          for (const row of out.reminders) found.set(row.reminder_id, row);
          const next = out.page!.next_cursor;
          if (found.size > out.page!.matched_count || !next && found.size !== out.page!.matched_count)
            throw new Error('The reminders changed while loading. Refresh to try again.');
          if (!next) {
            span = window; rows = [...found.values()].filter(visible); loaded = true;
            if (retry && found.get(retry.id)?.at === retry.at) retry = undefined;
            if (!rows.some(row => row.reminder_id === confirming)) confirming = undefined;
            return;
          }
          cursor = next;
        }
        throw new Error('There are more reminders than Today can check. Open Reminders to see them all.');
      } catch (failure) {
        if (disposed || mine !== sequence) return;
        const code = classifyRpcError(failure).code;
        unsupported = code === 'unknown_method' || code === 'not_configured';
        error = unsupported ? 'Update your server to show one-off reminders in Today.' : humanizeRpcError(failure);
      } finally {
        if (!disposed && mine === sequence) { loading = false; deps.changed(); }
      }
    })();
    return pending;
  };
  const change = async (id: string, preset?: ReminderTimePreset): Promise<void> => {
    const shown = rows.find(row => row.reminder_id === id);
    if (!shown || working || disposed || !callers.get || preset && !callers.update || !preset && !callers.cancel) return;
    if (deps.blocked()) { error = 'Finish or cancel the current change before changing a reminder.'; deps.changed(); return; }
    const atClick = deps.now(), mine = ++sequence;
    working = id; loading = false; error = undefined; notice = undefined; deps.changed();
    const current = () => !disposed && mine === sequence;
    try {
      const { reminder: fresh } = await callers.get({ reminder_id: id });
      if (!current()) return;
      if (!fresh || fresh.reminder_id !== id) throw new Error('This reminder is no longer available. Refresh Today.');
      keep(fresh);
      if (fresh.managed_by) throw new Error('This reminder is managed in Yours. Open it there to change it.');
      if (fresh.state !== 'pending') {
        if (!preset && fresh.state === 'cancelled') notice = 'This reminder was already cancelled.';
        else throw new Error(fresh.state === 'delivered' ? 'This reminder has already rung. Open its history to remind again.' : 'This reminder was cancelled.');
        return;
      }
      if (deps.blocked()) throw new Error('Finish or cancel the current change before changing a reminder.');
      if (preset) {
        const old = retry?.id === id && retry.preset === preset ? retry : undefined;
        if (old && fresh.at === old.at) {
          retry = undefined; notice = `Reminder moved: ${fresh.when}`; return;
        }
        if (fresh.at !== (old?.previousAt ?? shown.at) || fresh.time_zone !== shown.time_zone || fresh.text !== shown.text)
          throw new Error('This reminder changed since it was shown. Review its updated details and try again.');
        const at = old?.at ?? reminderTimePreset(preset, atClick, zone(fresh)).at;
        if (at <= deps.now()) throw new Error('That reminder time has passed. Choose another time.');
        retry = { id, preset, at, previousAt: fresh.at };
        const out = await callers.update!({ reminder_id: id, at });
        if (!current()) return;
        if (out.reminder?.reminder_id === id) keep(out.reminder);
        if (!out.updated || !out.reminder || out.reminder.reminder_id !== id || out.reminder.at !== at || out.reminder.state !== 'pending')
          throw new Error(out.message || 'The reminder change could not be confirmed. Refresh Today.');
        retry = undefined; notice = out.message;
      } else {
        if (fresh.at !== shown.at || fresh.text !== shown.text) {
          confirming = undefined;
          throw new Error('This reminder changed since it was shown. Review its updated details before cancelling it.');
        }
        const out = await callers.cancel!({ reminder_id: id });
        if (!current()) return;
        if (out.reminder?.reminder_id === id) keep(out.reminder);
        if (!out.cancelled || out.reminder?.reminder_id !== id || out.reminder.state !== 'cancelled')
          throw new Error(out.message || 'Cancellation could not be confirmed. Refresh Today.');
        confirming = undefined; notice = out.message;
      }
    } catch (failure) {
      if (current()) error = humanizeRpcError(failure) + ' Refresh Today to check the saved result.';
    } finally {
      if (current()) { working = undefined; deps.changed(); }
    }
  };
  return {
    load, whenLoaded: () => pending, busy: () => working !== undefined,
    current: () => !callers.list || loaded && !loading && !error && !working,
    canClaimEmpty: () => !callers.list || loaded && !loading && !error && rows.length === 0,
    beforeOpen(): boolean {
      if (!working && !deps.blocked()) return true;
      error = 'Finish or cancel the current change before opening a reminder.'; deps.changed(); return false;
    },
    async change(id: string, preset?: ReminderTimePreset) { await change(id, preset); },
    handle(action: string, id: string, preset?: string): boolean {
      if (!action.startsWith('today-reminder-')) return false;
      if (working || disposed) return true;
      if (action === 'today-reminder-refresh') { void load(); return true; }
      if (action === 'today-reminder-cancel') {
        if (deps.blocked()) { error = 'Finish or cancel the current change before changing a reminder.'; deps.changed(); return true; }
        error = undefined; notice = undefined; confirming = id; nextFocus = `confirm:${id}`; deps.changed();
      } else if (action === 'today-reminder-keep') {
        confirming = undefined; nextFocus = `cancel:${id}`; deps.changed();
      } else if (action === 'today-reminder-confirm' && confirming === id) void change(id);
      else if (action === 'today-reminder-move') {
        const choice = REMINDER_TIME_PRESETS.find(row => row.key === preset);
        if (choice) { confirming = undefined; void change(id, choice.key); }
      }
      return true;
    },
    restoreFocus(root: ParentNode, held?: string | null): boolean {
      const key = nextFocus ?? held; nextFocus = undefined;
      if (!key) return false;
      const controls = Array.from(root.querySelectorAll<HTMLElement>(`[${TODAY_REMINDER_FOCUS}]`));
      (controls.find(node => node.getAttribute(TODAY_REMINDER_FOCUS) === key)
        ?? (error ? controls.find(node => node.getAttribute(TODAY_REMINDER_FOCUS) === 'error') : undefined)
        ?? (notice ? controls.find(node => node.getAttribute(TODAY_REMINDER_FOCUS) === 'notice') : undefined)
        ?? controls.find(node => node.getAttribute(TODAY_REMINDER_FOCUS) === 'heading'))?.focus({ preventScroll: true });
      return true;
    },
    render(actionAttr: string): string {
      if (!callers.list) return '';
      const act = (action: string, id = '') => `${actionAttr}="today-reminder-${action}" data-today-reminder-id="${e(id)}"`;
      const focus = (key: string) => `${TODAY_REMINDER_FOCUS}="${e(key)}"`;
      const blocked = working ? ' aria-disabled="true"' : '';
      const groups = [{ key: 'now', label: 'Due now', matches: (row: ReminderView) => row.at <= span.now },
        { key: 'today', label: 'Today', matches: (row: ReminderView) => row.at > span.now && row.at < span.tomorrow },
        { key: 'next', label: 'Next seven days', matches: (row: ReminderView) => row.at >= span.tomorrow }];
      return `<section class="today-view today-reminders" data-today-reminders aria-label="One-off reminders" aria-busy="${loading}">
        <header class="today-header today-reminder-summary"><div><h2 tabindex="-1" ${focus('heading')}>Reminders</h2>
          <p>${loaded ? `${rows.length} waiting` : 'One-off reminders'} · Your local day</p></div>
          <button type="button" class="today-refresh" ${act('refresh')} ${focus('refresh')}${blocked}>Refresh reminders</button></header>
        ${notice ? `<p role="status" tabindex="-1" ${focus('notice')}>${e(notice)}</p>` : ''}
        ${loading ? `<p role="status">${loaded ? 'Updating reminders. These are the last confirmed results.' : 'Loading reminders…'}</p>` : ''}
        ${error ? `<p role="${unsupported ? 'status' : 'alert'}" tabindex="-1" ${focus('error')}>${e(error)} <a href="#data/reminder">Open Reminders</a></p>` : ''}
        ${loaded && !rows.length && !error && !loading ? '<p>No one-off reminders waiting in this window.</p>' : ''}
        ${groups.map(group => {
          const items = rows.filter(group.matches);
          return !items.length ? '' : `<section class="today-group" data-today-reminder-group="${group.key}"><h3>${group.label}<span class="today-count">${items.length}</span></h3>
            <ul class="today-list">${items.map(row => `<li class="today-row" data-today-reminder-row="${e(row.reminder_id)}">
              <time datetime="${e(new Date(row.at).toISOString())}">${e(formatReminderWhen(row.at, zone(row), span.now))}<br>${e(zone(row))}</time><div>
                <a href="${e(reminderDetailLink(row.reminder_id))}" ${act('open', row.reminder_id)} ${focus(`open:${row.reminder_id}`)}>${e(row.text)}</a>
                ${row.record_ref ? `<div class="today-meta">Linked ${e(row.record_ref.kind)}</div>` : ''}
                <div class="today-task-actions">${callers.get && callers.update ? REMINDER_TIME_PRESETS.map(preset => `<button type="button" ${act('move', row.reminder_id)} data-today-reminder-preset="${preset.key}" ${focus(`move:${preset.key}:${row.reminder_id}`)}${blocked}>${preset.label}</button>`).join('') : ''}
                  ${callers.get && callers.cancel ? `<button type="button" ${act('cancel', row.reminder_id)} ${focus(`cancel:${row.reminder_id}`)}${blocked}>Cancel</button>` : ''}</div>
                ${confirming === row.reminder_id ? `<div role="group" aria-label="Cancel this reminder?"><p>Cancel this reminder?</p>
                  <button type="button" class="today-refresh" ${act('confirm', row.reminder_id)} ${focus(`confirm:${row.reminder_id}`)}${blocked}>Cancel reminder</button>
                  <button type="button" class="today-refresh" ${act('keep', row.reminder_id)} ${focus(`keep:${row.reminder_id}`)}${blocked}>Keep reminder</button></div>` : ''}
              </div></li>`).join('')}</ul></section>`;
        }).join('')}
      </section>`;
    },
    dispose() { disposed = true; sequence++; },
  };
};
