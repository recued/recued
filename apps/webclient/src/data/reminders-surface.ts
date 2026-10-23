/**
 * D-324 — Data → Owned → Reminders.
 *
 * The owner's reminders still to ring, soonest first, each with its time on the
 * clock it was set on: move one to another time, or cancel it. The ones rung or
 * cancelled in the last 30 days sit below, folded. A reminder is set in chat
 * ("remind me tomorrow at 3pm to call the dentist") or with the "Remind me"
 * recipe; this list is where the owner sees and changes them (D-324 P2).
 *
 * Like the Mail facts tab, it keeps its own state and renders HTML strings. The
 * Data route forwards:
 *   - `render()` inside its tab panel, and `refresh()` from its loader;
 *   - clicks whose action starts with `reminders-`, and `input` / `change`
 *     events from the new-time field (`REMINDERS_FIELD_ATTR`);
 *   - focus: `captureFocus()` before a repaint, `restoreFocus()` after, by a
 *     stable key each control carries (`REMINDERS_FOCUS_ATTR`).
 *
 * ⚠ A NEW TIME IS READ ON THE REMINDER'S OWN CLOCK, not the browser's. The list
 * words each time in the zone it was set in (`time_zone`), so the field edits
 * that same wall clock; read on a travelling browser's clock it would move the
 * reminder by the difference.
 */

import {
  zonedWallClockToEpochMs,
  type ReminderCancelResult,
  type ReminderListResult,
  type ReminderUpdateResult,
  type ReminderView,
} from '@recued/contracts';
import { e, stampZone } from '@recued/ui-shared';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const REMINDERS_HOST_ATTR = 'data-recued-reminders';
export const REMINDERS_FOCUS_ATTR = 'data-recued-reminders-focus';
/** The new-time field. */
export const REMINDERS_FIELD_ATTR = 'data-recued-reminders-field';
/** Every action this tab handles starts with this. */
export const REMINDERS_ACTION_PREFIX = 'reminders-';

/** Every reminder rpc the tab calls; an absent one hides what needs it. */
export interface ReminderCallers {
  readonly list?: (args: { include_delivered?: boolean }) => Promise<ReminderListResult>;
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
}

export interface RemindersSurface {
  render(): string;
  /** Load the list. `silent` keeps what is shown until the new one lands. */
  refresh(silent?: boolean): Promise<void>;
  /** A click on an action starting with `reminders-`; true when handled. */
  handleAction(action: string, target: HTMLElement): boolean;
  /** An `input` from the new-time field; true when handled. */
  handleInput(target: HTMLElement): boolean;
  /** A `change` from the new-time field; true when handled. */
  handleChange(target: HTMLElement): boolean;
  /** A load, a move or a cancel is under way: a broadcast must not replace it. */
  isBusy(): boolean;
  /** A new time is typed and not saved. */
  hasUnsavedChanges(): boolean;
  /** A move or a cancel is under way. */
  hasInFlightWork(): boolean;
  captureFocus(active: Element | null | undefined): string | null;
  restoreFocus(root: ParentNode, key: string | null): void;
  dispose(): void;
}

/** `YYYY-MM-DDTHH:mm` on `zone`'s wall clock, for a `datetime-local` field. */
export const reminderWallClockValue = (at: number, zone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
};

const zoneOf = (reminder: ReminderView): string => reminder.time_zone ?? 'UTC';

interface State {
  reminders: ReminderView[];
  delivered: ReminderView[];
  count: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The reminder whose time is being changed, and what is typed. */
  editing: { id: string; value: string; error: string | null } | null;
  /** The reminder whose cancel waits for "Cancel it". */
  confirming: string | null;
  /** The reminder a move or a cancel is under way for. */
  working: string | null;
  /** What the last move or cancel did, in the server's words. */
  notice: { text: string; tone: 'ok' | 'bad' } | null;
  historyOpen: boolean;
}

export const createRemindersSurface = (deps: RemindersSurfaceDeps): RemindersSurface => {
  const { callers } = deps;
  // ⚠ `stampZone()` with no server zone IS the browser's zone: D-269 keeps that
  // one reading in `two-clock.ts` (`d-269-stamp-zone.test.ts` names where it may
  // live). Here it only says whether a reminder's clock is another one.
  const browserZone = deps.browserZone ?? ((): string => stampZone());
  let state: State = {
    reminders: [], delivered: [], count: 0, loaded: false, loading: false, error: null,
    editing: null, confirming: null, working: null, notice: null, historyOpen: false,
  };
  let seq = 0;
  let disposed = false;
  let pendingFocus: {
    key: string;
    /** An asynchronous reply may redirect only the focus its action owns. */
    from?: readonly string[];
    fallback?: string;
  } | null = null;

  const load = async (silent: boolean): Promise<void> => {
    if (callers.list === undefined) return;
    const mine = ++seq;
    state = { ...state, loading: true, ...(silent ? {} : { error: null }) };
    if (!silent) deps.render();
    try {
      const out = await callers.list({ include_delivered: true });
      if (disposed || mine !== seq) return;
      const stillThere = (id: string | null): boolean => id !== null && out.reminders.some((r) => r.reminder_id === id);
      state = {
        ...state,
        reminders: out.reminders,
        delivered: out.delivered ?? [],
        count: out.count,
        loaded: true,
        loading: false,
        error: null,
        // A reminder that rang or was cancelled elsewhere closes its open row.
        editing: state.editing !== null && stillThere(state.editing.id) ? state.editing : null,
        confirming: stillThere(state.confirming) ? state.confirming : null,
      };
    } catch (error) {
      if (disposed || mine !== seq) return;
      state = { ...state, loading: false, error: humanizeRpcError(error) };
    }
    deps.render();
  };

  const find = (id: string): ReminderView | undefined => state.reminders.find((r) => r.reminder_id === id);

  const save = async (id: string): Promise<void> => {
    const reminder = find(id);
    const editing = state.editing;
    if (reminder === undefined || editing === null || editing.id !== id || callers.update === undefined) return;
    const at = zonedWallClockToEpochMs(editing.value, zoneOf(reminder));
    if (at === null) {
      state = { ...state, editing: { ...editing, error: 'Pick a day and a time.' } };
      pendingFocus = { key: `at:${id}` };
      deps.render();
      return;
    }
    state = { ...state, working: id, notice: { text: 'Saving reminder…', tone: 'ok' } };
    pendingFocus = { key: 'notice', from: [`save:${id}`, `at:${id}`, `keep-time:${id}`] };
    deps.render();
    try {
      const out = await callers.update({ reminder_id: id, at });
      if (disposed) return;
      state = {
        ...state, working: null, editing: out.updated ? null : state.editing,
        notice: { text: out.message, tone: out.updated ? 'ok' : 'bad' },
      };
      pendingFocus = { key: out.updated ? `edit:${id}` : `at:${id}`, from: ['notice'], fallback: 'notice' };
      await load(true);
    } catch (error) {
      if (disposed) return;
      state = { ...state, working: null, notice: null, editing: { ...editing, error: humanizeRpcError(error) } };
      pendingFocus = { key: `at:${id}`, from: ['notice'] };
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
        ...state, working: null, confirming: null,
        notice: { text: out.message, tone: out.cancelled ? 'ok' : 'bad' },
      };
      pendingFocus = { key: 'notice', from: ['notice'] };
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
    if (state.editing !== null && state.editing.id === id) {
      const zone = zoneOf(reminder);
      const otherClock = zone !== browserZone();
      return `
        <div class="reminders-edit">
          <label class="reminders-field">
            <span>New time${otherClock ? ` <span class="reminders-subtle">(${e(zone)} time)</span>` : ''}</span>
            <input type="datetime-local" ${REMINDERS_FIELD_ATTR}="at" data-reminder-id="${e(id)}"
              value="${e(state.editing.value)}" ${focus(`at:${id}`)} ${busy ? 'disabled' : ''}>
          </label>
          ${state.editing.error !== null ? `<p class="reminders-error" role="alert">${e(state.editing.error)}</p>` : ''}
          <div class="reminders-buttons">
            <button type="button" class="data-button" ${act('reminders-save', id)} ${focus(`save:${id}`)} ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button>
            <button type="button" class="data-button" ${act('reminders-edit-close', id)} ${focus(`keep-time:${id}`)} ${busy ? 'disabled' : ''}>Keep the time</button>
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
        ${callers.update !== undefined ? `<button type="button" class="data-button" ${act('reminders-edit', id)} ${focus(`edit:${id}`)}>Change time</button>` : ''}
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
      return '<p class="reminders-empty">No reminders waiting. Ask chat to set one: “remind me tomorrow at 3pm to call the dentist”.</p>';
    }
    return `
      <ol class="reminders-list" aria-label="Reminders still to ring">
        ${state.reminders.map((reminder) => `
          <li class="reminders-row" data-reminder-id="${e(reminder.reminder_id)}">
            <div class="reminders-when">${e(reminder.when)}</div>
            <div class="reminders-text">${e(reminder.text)}</div>
            ${renderActions(reminder)}
          </li>`).join('')}
      </ol>
      ${state.count > state.reminders.length
        ? `<p class="reminders-subtle">Showing the first ${state.reminders.length} of ${state.count}.</p>`
        : ''}`;
  };

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
        </div>
        <p class="reminders-intro">Each reminder rings once, at its time, on every channel you set up.</p>
        <p class="reminders-notice" data-tone="${state.notice?.tone ?? 'ok'}" role="status" aria-live="polite" tabindex="-1" ${focus('notice')}>${e(state.notice?.text ?? '')}</p>
        ${state.error !== null && state.loaded ? `<p class="reminders-error" role="alert">${e(state.error)}</p>` : ''}
        ${renderUpcoming()}
        ${renderHistory()}
      </section>`,

    refresh: (silent = false) => load(silent),

    handleAction: (action, target) => {
      if (!action.startsWith(REMINDERS_ACTION_PREFIX)) return false;
      const id = target.getAttribute('data-reminder-id') ?? '';
      if (action === 'reminders-retry') {
        void load(false);
        return true;
      }
      if (action === 'reminders-history-toggle') {
        // The browser opens or shuts it; the state keeps it so across repaints.
        state = { ...state, historyOpen: !state.historyOpen };
        return true;
      }
      if (state.working !== null) return true;
      const reminder = find(id);
      if (action === 'reminders-edit' && reminder !== undefined) {
        state = {
          ...state, confirming: null, notice: null,
          editing: { id, value: reminderWallClockValue(reminder.at, zoneOf(reminder)), error: null },
        };
        pendingFocus = { key: `at:${id}` };
      } else if (action === 'reminders-edit-close') {
        state = { ...state, editing: null };
        pendingFocus = { key: `edit:${id}` };
      } else if (action === 'reminders-save') {
        void save(id);
        return true;
      } else if (action === 'reminders-cancel' && reminder !== undefined) {
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
      if (target.getAttribute(REMINDERS_FIELD_ATTR) !== 'at') return false;
      const id = target.getAttribute('data-reminder-id') ?? '';
      if (state.editing !== null && state.editing.id === id) {
        // No repaint while typing: the field holds what is typed.
        state = { ...state, editing: { ...state.editing, value: (target as HTMLInputElement).value, error: null } };
      }
      return true;
    },

    handleChange: (target) => {
      if (target.getAttribute(REMINDERS_FIELD_ATTR) !== 'at') return false;
      const id = target.getAttribute('data-reminder-id') ?? '';
      if (state.editing !== null && state.editing.id === id) {
        state = { ...state, editing: { ...state.editing, value: (target as HTMLInputElement).value, error: null } };
      }
      return true;
    },

    isBusy: () => state.loading || state.working !== null || state.editing !== null || state.confirming !== null,

    hasUnsavedChanges: () => {
      const editing = state.editing;
      if (editing === null) return false;
      const reminder = find(editing.id);
      return reminder !== undefined && editing.value !== reminderWallClockValue(reminder.at, zoneOf(reminder));
    },

    hasInFlightWork: () => state.working !== null,

    captureFocus: (active) => {
      const key = (active as HTMLElement | null | undefined)?.getAttribute?.(REMINDERS_FOCUS_ATTR);
      return typeof key === 'string' && key.length > 0 ? key : null;
    },

    restoreFocus: (root, key) => {
      if (disposed) return;
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
      pendingFocus = null;
    },
  };
};

/** The tab's styles, scoped to its host; injected with the Data route's. */
export const REMINDERS_STYLES = `
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
[${REMINDERS_HOST_ATTR}] .reminders-field { display: grid; gap: 2px; font-size: 12px; color: var(--muted); max-width: 20em; }
[${REMINDERS_HOST_ATTR}] .reminders-field input { font: inherit; font-size: 13px; color: var(--fg); max-width: 100%; }
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
