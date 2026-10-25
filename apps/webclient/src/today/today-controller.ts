/** Today's state, reads and task writes — extracted from the Data route so a
 *  standalone `#today` route and the Data tab can share ONE implementation.
 *
 *  ⛔ EXTRACTED, NOT COPIED. The invariants below — partial paints on the FIRST
 *  load only, a generation guard on both the partial callback and the final
 *  assignment, the live-refresh queue draining after the paint — are the kind
 *  that read as noise and get "tidied" by someone who has not paid for them.
 *  One copy.
 *
 *  ⚠ THE DATA ROUTE DOES NOT USE THIS YET. Today left `#data` (D-290) and the
 *  Data route kept ~13 unreachable `activeTab === 'today'` branches; they are
 *  dead, not a second implementation, and removing `'today'` from `DataTabId`
 *  makes the compiler list every one. Until that lands, this module has ONE
 *  consumer — `bootstrap-today-route`.
 *
 *  ⚠ THE DOM STAYS IN THE SHELL. `focusTask` / `ownsFocus` are seams rather
 *  than querySelector calls, because focus restoration belongs to whichever
 *  surface owns the document — the Data route restores focus across its whole
 *  tab strip, a standalone route has only this view to worry about.
 */
import type { SituationDismissal, WorkEntity, YoursCommand, YoursCommandResult } from '@recued/contracts';
import { timedDueMs } from '@recued/contracts';
import {
  loadToday, replaceTodayTask, situationRefHref, writableTodayTask,
  type TodaySnapshot, type TodayTaskEdit,
} from '../data/today-view.js';
import type { BootstrapDataRouteOptions } from '../data/bootstrap-data-route.js';

/** The eight seams Today actually needs — what it reads and writes, and
 *  nothing else.
 *
 *  ⛔ A `Pick` OF THE REAL OPTIONS, NOT A HAND-WRITTEN TWIN. `loadToday`
 *  already takes a `Pick` of four of these, and re-declaring the signatures
 *  here would type-check happily while drifting from the callers the shell
 *  actually passes — the mismatch would surface as a runtime shape error at
 *  the one moment a task write lands. */
export type TodayCallers = Pick<BootstrapDataRouteOptions,
  | 'spheres' | 'proactiveTodayCaller' | 'workEntityListCaller' | 'collectionListCaller' | 'collectionListInstancesCaller'
  | 'workEntitySourceListCaller' | 'workEntityGetCaller' | 'taskMarkDoneCaller'
  | 'workEntityUpsertCaller' | 'commitmentCloseCaller'>
  & {
    /** D-267 — the shell's shared Create opener, the same modal the chat
     *  composer chip and the drawer seat open. Wired → Today's zero-state
     *  offers a capture button; absent → it renders nothing at all rather than
     *  a dead control.
     *
     *  ⚠ DECLARED HERE, not picked. It lived on `BootstrapDataRouteOptions`
     *  while Today was a Data tab; once Today left, the Data route stopped
     *  reading it and the field became a seam the shell could wire to no
     *  effect. Nothing to drift: a nullary void opener has no signature to
     *  keep in step. */
    openCreateOverlay?: () => void;
    /** §15.4 — `yours.change` for the coded answers on a cluster item and their
     *  Undo. Absent (an older server) → no answer buttons. */
    situationChangeCaller?: (input: Extract<YoursCommand, { action: 'situation.dismiss' | 'situation.restore' }>) => Promise<YoursCommandResult>;
    /** D-325 §15.7 (2026-10-24) — `yours.change` for Done on a renewal, which only acknowledges
     *  it. Absent (an older shell) → Done closes as for any task, and the server refuses it. */
    occurrenceAcknowledgeCaller?: (input: Extract<YoursCommand, { action: 'occurrence.acknowledge' }>) => Promise<YoursCommandResult>;
    /** D-325 §8 — the owner opened an item Today showed. Fire and forget: the link
     *  navigates at once, so this must never hold the route-switch guard. */
    situationOpenedCaller?: (input: Extract<YoursCommand, { action: 'navigation.open' }>) => void;
  };

/** unix-ms → the `YYYY-MM-DDTHH:mm` a datetime-local input shows, in the
 *  viewer's local time (the frame the owner picks a new wall-clock time in).
 *  The reverse (`new Date(value).getTime()`) reads the picked string back as
 *  local time, so the round-trip is tz-consistent for the owner. (D-210 R-4.)
 *
 *  ⛔ NOT A HOST SEAM, DELIBERATELY. `submit` validates
 *  `toDatetimeLocal(due) === edit.value` — a round-trip equality check — so two
 *  shells supplying two copies of this would not merely drift, they would make
 *  that validation reject a perfectly good date on one surface and accept it on
 *  the other. One formatter, or the check means nothing. */
export const toDatetimeLocal = (unixMs: number): string => {
  if (!Number.isFinite(unixMs)) return '';
  const d = new Date(unixMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface TodayControllerHost {
  /** Passed through to `loadToday`, which reads the four list callers off it. */
  callers: TodayCallers;
  now: () => number;
  render: () => void;
  isDisposed: () => boolean;
  /** Is Today the surface on screen? The Data route answers
   *  `activeTab === 'today' && activeLens === 'data'`; a standalone route
   *  answers `true`. Guards every async landing. */
  isActive: () => boolean;
  /** Ask the shell for a fresh read, retiring any older one in flight. The
   *  shell owns the promise because it owns the generation counter. */
  refreshActive: () => void;
  focusTask: (selector: string) => void;
  ownsFocus: () => boolean;
  /** The shell's click-dispatch attribute, used to build focus selectors. */
  actionAttr: string;
  errMessage: (error: unknown) => string;
}

export interface TodayController {
  snapshot: () => TodaySnapshot | null;
  refreshing: () => boolean;
  edit: () => TodayTaskEdit | null;
  notice: () => string | null;
  error: () => string | null;
  /** The key the notice's Undo restores, after a dismissal. */
  undoDismissal: () => string | null;
  /** Answers a cluster item; resolves to its record's address for "That's wrong". */
  dismissSituation: (clusterId: string, index: number, code: SituationDismissal) => Promise<string | null>;
  restoreSituation: (key: string) => Promise<void>;
  recordOpen: (clusterId: string, index: number) => void;
  closeCommitment: (key: string, outcome: 'fulfill' | 'cancel') => Promise<void>;
  /** True while an editor is mid-write — the shell blocks navigation on it. */
  busy: () => boolean;
  /** One read. `stillCurrent` is the shell's generation guard. */
  load: (stillCurrent: () => boolean) => Promise<void>;
  /** A live broadcast arrived while a read was running. */
  queueLiveRefresh: () => void;
  /** Drain the queue after the paint; true when one was pending. */
  takeQueuedLiveRefresh: () => boolean;
  openEditor: (taskKey: string, action: 'complete' | 'reschedule') => void;
  setEditValue: (value: string) => void;
  closeEditor: () => void;
  submit: () => Promise<void>;
  /** Tab switch / teardown — drops an editor and retires its sequence. */
  reset: () => void;
}

export const createTodayController = (host: TodayControllerHost): TodayController => {
  let snapshot: TodaySnapshot | null = null;
  let refreshing = false;
  let liveRefreshQueued = false;
  let edit: TodayTaskEdit | null = null;
  let notice: string | null = null;
  let error: string | null = null;
  let closingCommitment = false;
  let undoDismissal: string | null = null;
  let sequence = 0;

  const dueSelector = `[${host.actionAttr}="today-task-due"]`;

  const load = async (stillCurrent: () => boolean): Promise<void> => {
    refreshing = true;
    liveRefreshQueued = false;
    // ⛔⛔ PARTIAL PAINTS ON THE FIRST LOAD ONLY — never on a refresh, and the
    // reason is focus. Each paint replaces the view's DOM, and the shell
    // recaptures the focused control from `doc.activeElement` at the START of
    // every render: the first partial that does not yet contain the focused
    // row drops focus to <body>, and every later paint then reads "nothing was
    // focused" and has nothing to restore. Caught by the e2e that focuses a row
    // and advances the clock, not by any unit test.
    //
    // ⚖ And it costs nothing: a refresh already has the previous snapshot on
    // screen under "Loading again. These are the old results." Painting
    // partials over results that are already there buys no earlier information
    // — the problem partials exist to solve is the FIRST paint withholding
    // everything while three of four reads have answered.
    const paintPartials = snapshot === null;
    const next = await loadToday(
      host.callers,
      host.now(),
      stillCurrent,
      // ⛔ Guarded by the SAME check as the final assignment: a partial from a
      // retired load must not overwrite a newer one, and unlike the final
      // assignment this callback can fire many times while a newer refresh is
      // already running. ⚠ The snapshot carries `complete: false`, so no
      // partial paint claims a finished read.
      paintPartials
        ? (partial) => {
            if (!stillCurrent()) return;
            snapshot = partial;
            host.render();
          }
        : undefined,
    );
    if (!stillCurrent()) return;
    snapshot = next;
    refreshing = false;
  };

  const closeEditor = (): void => {
    if (!edit || edit.busy) return;
    const { key, action: editing } = edit;
    edit = null; sequence += 1; host.render();
    host.focusTask(`[data-today-task="${key}"][${host.actionAttr}="today-task-${editing}"]`);
  };

  const submit = async (): Promise<void> => {
    const current = edit;
    const get = host.callers.workEntityGetCaller;
    const listSources = host.callers.workEntitySourceListCaller;
    if (!current || current.busy || !get || !listSources
      || host.isDisposed() || !host.isActive()) return;
    if (current.action === 'complete'
      ? !host.callers.taskMarkDoneCaller : !host.callers.workEntityUpsertCaller) return;
    const picked = new Date(current.value).getTime();
    if (current.action === 'reschedule' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(current.value)
      || !Number.isFinite(picked) || toDatetimeLocal(picked) !== current.value)) {
      edit = { ...current, error: 'Pick a valid due date and time in your local time zone.' };
      host.render(); host.focusTask(dueSelector); return;
    }
    // A task due on a whole DAY, moved to another day at midnight, stays a whole
    // day (`due-day.ts`) — its UTC-midnight encoding, not this zone's midnight,
    // which would make it overdue from the day's first minute. Any other pick is
    // a time; `timedDueMs` keeps one that lands on 00:00 UTC from reading as a day.
    const [year, month, day] = current.value.slice(0, 10).split('-').map(Number) as [number, number, number];
    const due = current.allDay === true && current.value.endsWith('T00:00')
      ? Date.UTC(year, month - 1, day)
      : timedDueMs(picked);
    const mine = ++sequence;
    edit = { ...current, busy: true, error: null };
    host.render();
    try {
      // A task can disappear or lose its source while its row is on screen.
      // Send only the selected change; never replay fields from that old row.
      const [{ entity }, { sources }] = await Promise.all([
        get({ kind: 'task', id: current.id }), listSources(),
      ]);
      if (host.isDisposed() || mine !== sequence) return;
      const source = entity
        ? sources.find((entry) => entry.id === (entity as { source_id?: string }).source_id)
        : undefined;
      if (!entity || entity._kind !== 'task' || entity.deleted_at != null
        || entity.sync_state !== 'live' || source?.top_tier_kind !== 'task'
        || !source.write_capable || source.sync_posture === 'read_through') {
        throw new Error('This task cannot be changed here now. Refresh Today and check its source.');
      }
      const result = current.action === 'complete'
        ? await host.callers.taskMarkDoneCaller!({ id: current.id, done: true })
        : await host.callers.workEntityUpsertCaller!({ kind: 'task', id: current.id, due_at: due });
      if (host.isDisposed() || mine !== sequence) return;
      if ((result.entity as { pending_write?: unknown }).pending_write) {
        throw new Error('Your change is saved in Recued, but the source has not confirmed it yet. Refresh Today to check before trying again.');
      }
      const done = result.entity as Extract<WorkEntity, { _kind: 'task' }>;
      if (done._kind !== 'task' || done.id !== current.id || done.sync_state !== 'live'
        || done.deleted_at != null
        || (current.action === 'complete' ? !done.done : done.due_at !== due)) {
        throw new Error('The server did not confirm the change. Refresh Today to check the task.');
      }
      const carryFocus = host.ownsFocus();
      if (snapshot) snapshot = replaceTodayTask(snapshot, done);
      edit = null;
      notice = `${current.action === 'complete' ? 'Completed' : 'Rescheduled'} “${current.title}”.`; undoDismissal = null;
      // Retire any older read before it can restore the pre-write row. Do not
      // hold a successful task change hostage to an unrelated calendar read.
      host.refreshActive();
      host.render();
      if (carryFocus) host.focusTask('[data-today-task-notice]');
    } catch (error) {
      if (host.isDisposed() || mine !== sequence) return;
      const carryFocus = host.ownsFocus();
      edit = { ...current, busy: false, error: host.errMessage(error) };
      host.render();
      if (carryFocus) host.focusTask('[data-today-task-error]');
    }
  };

  return {
    snapshot: () => snapshot,
    refreshing: () => refreshing,
    edit: () => edit,
    notice: () => notice,
    error: () => error,
    undoDismissal: () => undoDismissal,
    dismissSituation: async (clusterId, index, code) => {
      const change = host.callers.situationChangeCaller;
      const item = snapshot?.items.find(row => row.cluster?.id === clusterId)?.cluster?.items[index];
      if (!change || !item || item.basis === 'declared' || closingCommitment || edit?.busy || host.isDisposed() || !host.isActive()) return null;
      const mine = ++sequence;
      closingCommitment = true; error = null; notice = null; undoDismissal = null; host.render();
      try {
        const result = await change({ action: 'situation.dismiss', ref: item.ref, kind: item.kind, code, label: item.what.value ?? 'This item' });
        if (host.isDisposed() || mine !== sequence) return null;
        notice = result.message; undoDismissal = result.id ?? null;
        host.refreshActive();
        return code === 'wrong' ? situationRefHref(item.ref) : null;
      } catch (cause) {
        if (!host.isDisposed() && mine === sequence) error = host.errMessage(cause);
        return null;
      } finally {
        closingCommitment = false;
        if (!host.isDisposed() && mine === sequence) {
          const carryFocus = host.ownsFocus(); host.render();
          if (carryFocus) host.focusTask(error ? '[data-today-task-error]' : '[data-today-task-notice]');
        }
      }
    },
    /** Opening a bill or a delivery Today showed counts, for the learner, as acting on its
     *  kind; "Not this one" and "Never this kind" count as setting it aside (Option A). */
    recordOpen: (clusterId: string, index: number) => {
      const item = snapshot?.items.find(row => row.cluster?.id === clusterId)?.cluster?.items[index];
      if (item?.ref.collection === 'mail_fact' && !host.isDisposed()) host.callers.situationOpenedCaller?.({ action: 'navigation.open', ref: item.ref, from: 'today' });
    },
    restoreSituation: async (key) => {
      const change = host.callers.situationChangeCaller;
      if (!change || closingCommitment || host.isDisposed() || !host.isActive()) return;
      const mine = ++sequence;
      closingCommitment = true; error = null; host.render();
      try {
        const result = await change({ action: 'situation.restore', key });
        if (host.isDisposed() || mine !== sequence) return;
        notice = result.message; undoDismissal = null;
        host.refreshActive();
      } catch (cause) {
        if (!host.isDisposed() && mine === sequence) error = host.errMessage(cause);
      } finally {
        closingCommitment = false;
        if (!host.isDisposed() && mine === sequence) host.render();
      }
    },
    closeCommitment: async (key, outcome) => {
      const item = snapshot?.items.find(row => row.key === key);
      const close = host.callers.commitmentCloseCaller;
      if (!item?.commitmentId || item.unreachable || !snapshot?.sources.some(source => source.key === item.sourceKey && source.writeCapable) || !close || closingCommitment || edit?.busy
        || host.isDisposed() || !host.isActive()) return;
      // D-325 §15.7 (2026-10-24) — Done on a renewal acknowledges its reminder: its new date
      // closes it (Yours → Due), so it stays open, and Today shows it again at its next reminder.
      const acknowledge = outcome === 'fulfill' && item.renewalOccurrenceId ? host.callers.occurrenceAcknowledgeCaller : undefined;
      const mine = ++sequence;
      closingCommitment = true; error = null; notice = null; undoDismissal = null; host.render();
      try {
        if (acknowledge) {
          const result = await acknowledge({ action: 'occurrence.acknowledge', id: item.renewalOccurrenceId! });
          if (host.isDisposed() || mine !== sequence) return;
          if (snapshot) snapshot = { ...snapshot, items: snapshot.items.filter(row => row.key !== key) };
          notice = result.message; host.refreshActive(); return;
        }
        const { entity } = await close({ id: item.commitmentId, outcome });
        if (host.isDisposed() || mine !== sequence) return;
        if (entity._kind !== 'commitment' || entity.id !== item.commitmentId
          || entity.lifecycle_state !== (outcome === 'fulfill' ? 'fulfilled' : 'cancelled')) {
          throw new Error('The server did not confirm the close. Refresh Today to check it.');
        }
        if (snapshot) snapshot = { ...snapshot, items: snapshot.items.filter(row => row.key !== key) };
        notice = `${outcome === 'fulfill' ? 'Done' : 'Cancelled'} “${item.title}”.`;
        host.refreshActive();
      } catch (cause) {
        if (!host.isDisposed() && mine === sequence) error = host.errMessage(cause);
      } finally {
        closingCommitment = false;
        if (!host.isDisposed() && mine === sequence) {
          const carryFocus = host.ownsFocus(); host.render();
          if (carryFocus) host.focusTask(error ? '[data-today-task-error]' : '[data-today-task-notice]');
        }
      }
    },
    busy: () => edit?.busy === true || closingCommitment,
    load,
    queueLiveRefresh: () => { liveRefreshQueued = true; },
    takeQueuedLiveRefresh: () => {
      if (!liveRefreshQueued) return false;
      liveRefreshQueued = false;
      return true;
    },
    openEditor: (taskKey, action) => {
      if (edit?.busy || closingCommitment || !host.isActive()) return;
      if (edit) { host.focusTask(`${dueSelector}, [data-today-task-error]`); return; }
      const item = writableTodayTask(snapshot, taskKey);
      if (!item?.taskId || !host.callers.workEntityGetCaller
        || !host.callers.workEntitySourceListCaller) return;
      if (action === 'complete'
        ? !host.callers.taskMarkDoneCaller : !host.callers.workEntityUpsertCaller) return;
      sequence += 1;
      notice = null; undoDismissal = null;
      edit = { key: item.key, id: item.taskId, title: item.title, action,
        value: toDatetimeLocal(item.when),
        ...(item.allDay === true ? { allDay: true } : {}),
        busy: false, error: null };
      if (action === 'complete') void submit();
      else { host.render(); host.focusTask(dueSelector); }
    },
    setEditValue: (value) => { if (edit && !edit.busy) edit = { ...edit, value }; },
    closeEditor,
    submit,
    reset: () => { edit = null; notice = null; error = null; undoDismissal = null; sequence += 1; },
  };
};
