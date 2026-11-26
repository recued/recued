import { reconcileNativeField as renderAroundDueField } from '../shell/reconcile-native-field.js';
/** The `#today` route — Today as its own surface rather than a Data tab.
 *
 *  Today aggregates tasks, commitments and calendar across sources; it is not
 *  a view of one warehouse collection, which is what every other `#data` tab
 *  is. It kept a Data tab for historical reasons and a drawer seat pointing at
 *  `#data/today`, so the menu already treated it as a first-class destination
 *  while the address said otherwise. This route makes the two agree.
 *
 *  ⛔ THE STATE LIVES IN `today-controller.ts`, NOT HERE. While the Data tab
 *  still exists, both mount the same controller — a second copy of the
 *  partial-paint rule or the write-confirmation checks would be one "tidy" away
 *  from diverging on one surface only.
 *
 *  ⛔ THIS ROUTE OWNS ITS ELEMENT. The shell's contract is `dispose()` then
 *  mount the next route, and it NEVER clears `contentRoot` — a route that
 *  paints into the shared container leaves itself behind and the next route
 *  renders underneath it (the defect `bootstrap-stats-route` records). */
import type { SituationDismissal, SourceRegistration } from '@recued/contracts';
import { TASK_BLOCKERS_STYLES } from '@recued/ui-shared';
import { createTaskBlockers } from '../data/task-blockers.js';
import type { TaskBlockerNavigation } from '../data/task-blocker-navigation.js';
import { renderToday, TODAY_CLOSE_DAY_ACTION, TODAY_CREATE_ACTION, TODAY_OCCASION_NEXT_NONE, TODAY_OCCASION_NEXT_SAVE, TODAY_STREAM_ACTION, TODAY_VIEW_STYLES } from '../data/today-view.js';
import { openStreamDialog, STREAM_PANEL_STYLES } from './stream-panel.js';
import type { TodaySphereFilter } from '../data/today-view.js';
import {
  createTodayController, type TodayCallers, type TodayController,
} from './today-controller.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { createTodayReminders, TODAY_REMINDER_FOCUS } from './reminders.js';
import type { TodayReminderNavigation } from './reminder-navigation.js';
import { createTodayFollowUps } from './follow-ups.js';
import { createTodayCustomerDecisionReviews } from './customer-decision-reviews.js';
import { CUSTOMER_WATCH_STYLES, type CustomerDecisionWatchCallers } from '../data/customer-decision-watch.js';
import { createTaskReplyWatchSlots } from '../mail/task-reply-watch.js';

export const TODAY_ROUTE_HOST_ATTR = 'data-recued-today-route';
export const TODAY_ROUTE_STYLES_MARKER = 'data-recued-today-route-styles';
/** Today's own click-dispatch attribute. `renderToday` takes the attribute as
 *  an argument, so the markup carries whichever the host passes. */
export const TODAY_ROUTE_ACTION_ATTR = 'data-recued-today-action';

/** How often Today re-reads purely because the clock moved. One minute — the
 *  smallest unit any of its copy renders ("in 3 minutes", "overdue"). */
export const TODAY_CLOCK_INTERVAL_MS = 60_000;
/** D-407 slice 2 — the boxes of "When is the next one?", each naming its occasion. */
const OCCASION_NEXT_FIELDS = ['data-today-occasion-next-on', 'data-today-occasion-next-time'] as const;

export interface BootstrapTodayRouteOptions {
  reminderNavigation?: TodayReminderNavigation;
  customerDecisionWatches?: Pick<CustomerDecisionWatchCallers, 'reviews' | 'change'>;
  taskBlockerNavigation?: TaskBlockerNavigation;
  container: HTMLElement;
  callers: TodayCallers;
  now?: () => number;
  /** The shell's broadcast subscriber. Today reads tasks, commitments and
   *  calendar, so it listens on the same kinds the Data tab did. Absent ⇒ the
   *  view refreshes only on demand. */
  subscribe?: BroadcastSubscriber['on'];
  /** D-340 slice 2 — `#today/stream`: open the streams' settings once Today is up (the link the
   *  notifications page leaves where the Agenda's card was). */
  openStream?: boolean;
  searchReturnHash?: string;
}

export interface TodayRoute {
  dispose: () => void;
  hasInFlightWork: () => boolean;
  /** Start a fresh read. No-op while one is already running. */
  refresh: () => void;
  /** Is what is on screen a complete, current answer? Pending reads, source
   * issues, and a view waiting for its reschedule editor to close are unavailable
   * to recovery continuity; a fresh snapshot alone cannot qualify an old paint. */
  getRecoveryContextFreshness: () => 'current' | 'unavailable';
  /** Test seam — settles the in-flight read. */
  whenLoaded: () => Promise<void>;
  /** D-340 slice 2 — open the streams' settings over Today (`#today/stream` while Today is up). */
  openStream: () => void;
}

const errMessage = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : 'Something went wrong.';

export const bootstrapTodayRoute = (opts: BootstrapTodayRouteOptions): TodayRoute => {
  const doc = opts.container.ownerDocument ?? globalThis.document;
  let disposed = false;

  // ⚠ Injected once, keyed by a marker — a second mount must not stack a
  // second copy of the sheet.
  if (doc?.head?.querySelector?.(`style[${TODAY_ROUTE_STYLES_MARKER}]`) == null) {
    const style = doc?.createElement?.('style');
    if (style) {
      style.setAttribute(TODAY_ROUTE_STYLES_MARKER, '');
      style.textContent = `${TODAY_VIEW_STYLES}
        ${TASK_BLOCKERS_STYLES}
        ${STREAM_PANEL_STYLES}
        ${CUSTOMER_WATCH_STYLES}
        [${TODAY_ROUTE_HOST_ATTR}] { max-width: var(--wc-content-max, 1080px); margin: 0 auto; padding: var(--wc-page-pad, 24px); }
        [${TODAY_ROUTE_HOST_ATTR}] .today-view { max-width: none; margin-top: 0; }
      `;
      doc?.head?.appendChild?.(style);
    }
  }
  const searchBack = opts.searchReturnHash ? doc.createElement('a') : null;
  if (searchBack) {
    searchBack.href = opts.searchReturnHash!; searchBack.textContent = 'Back to search';
    searchBack.className = 'rx-btn rx-btn-outline'; searchBack.setAttribute('data-search-saved-view-return', '');
    opts.container.appendChild(searchBack);
  }
  const root = doc.createElement('div');
  /** D-407 slice 2 — what the owner typed in "When is the next one?", by occasion id. */
  const occasionDrafts = new Map<string, { on: string; time: string }>();
  root.setAttribute(TODAY_ROUTE_HOST_ATTR, '');
  opts.container.appendChild(root);
  const taskReplyWatches = createTaskReplyWatchSlots(opts.callers.taskReplyWatchListCaller, opts.now ?? Date.now);

  let generation = 0;
  let pending: Promise<void> = Promise.resolve();
  const returnOrigin = opts.taskBlockerNavigation?.restoreToday();
  const reminderOrigin = opts.reminderNavigation?.restoreToday();
  let reminderRestorePending = reminderOrigin !== undefined;
  let interaction = 0;
  let restorePending = returnOrigin !== undefined;
  let sourcesOpen: boolean | undefined = reminderOrigin?.sourcesOpen ?? returnOrigin?.sourcesOpen;
  let sphereFilter: TodaySphereFilter = reminderOrigin?.sphere ?? returnOrigin?.sphere ?? 'all';
  let dependencySources: readonly SourceRegistration[] = [];
  let deferredViewPaint = false;
  const taskBlockers = createTaskBlockers({ get: opts.callers.workEntityGetCaller, sources: () => dependencySources,
    initialExpanded: reminderOrigin?.expanded ?? returnOrigin?.expanded,
    open: async target => {
      if (controller.edit() || controller.busy()) throw new Error('Finish or cancel the current change before opening a dependency.');
      if (opts.taskBlockerNavigation) opts.taskBlockerNavigation.open({ ...target, expanded: taskBlockers.expanded(), sphere: sphereFilter,
        sourcesOpen, scrollTop: opts.container.scrollTop });
      else if (doc.defaultView) doc.defaultView.location.hash = `#data/task/${encodeURIComponent(target.dependency)}`;
    } });

  const render = (): void => {
    if (disposed) return;
    const blockerFocus = taskBlockers.captureFocus();
    const replyWatchFocus = taskReplyWatches.captureFocus();
    // Preserve the sources disclosure across a repaint — the snapshot changing
    // is not a reason to collapse something the owner opened.
    sourcesOpen = root.querySelector?.<HTMLDetailsElement>('.today-sources')?.open ?? sourcesOpen;
    // Most paints replace the DOM, so restore the focused control by identity.
    // An open date field and its ancestry stay connected instead: native
    // partial values and the active segment cannot be reconstructed from text.
    // A repaint here is usually something the owner did NOT ask for — a live
    // broadcast, the minute clock, the read that follows a task write — and
    // `innerHTML =` destroys the focused node, dropping focus to <body>.
    // Keyboard and screen-reader users then lose their place mid-task, and the
    // notice announcing "Completed X" is never reached at all.
    //
    // ⚠ Carried over from the Data tab; the D-290 extraction left it behind and
    // this route repainted without it. Seven of the Today e2e specs caught it
    // and no unit test could: this suite runs without a DOM, so there is no
    // `document.activeElement` here to lose.
    //
    // Matched by IDENTITY, not by index: a refresh reorders and drops rows, so
    // "the nth control" is a different task afterwards. Each branch falls back
    // to a stable landmark rather than nothing.
    const active = doc.activeElement as HTMLElement | null | undefined;
    const held = active?.closest?.(`[${TODAY_ROUTE_HOST_ATTR}]`) != null ? active : null;
    const heldHref = held?.getAttribute('href');
    const heldAction = held?.getAttribute(TODAY_ROUTE_ACTION_ATTR);
    const heldTaskKey = held?.getAttribute('data-today-task');
    const heldRefresh = heldAction === 'refresh-today';
    const heldSources = held?.tagName === 'SUMMARY';
    const heldNotice = held?.hasAttribute('data-today-task-notice') === true;
    const heldError = held?.hasAttribute('data-today-task-error') === true;
    const heldReminderKey = held?.getAttribute(TODAY_REMINDER_FOCUS);
    const heldReview = held?.closest('[data-today-customer-review]')?.getAttribute('data-today-customer-review');
    const expandedReviews = new Set(Array.from(root.querySelectorAll?.('[data-today-customer-review][open]') ?? [])
      .map(row => row.getAttribute('data-today-customer-review') ?? ''));
    const showCustomerReviews = sphereFilter === 'all' || sphereFilter === 'professional';
    const html = renderToday(
      controller.snapshot(),
      controller.refreshing(),
      TODAY_ROUTE_ACTION_ATTR,
      sourcesOpen,
      opts.callers.openCreateOverlay !== undefined && reminders.canClaimEmpty() && followUps.canClaimEmpty()
        && (!showCustomerReviews || customerReviews.canClaimEmpty()),
      {
        canComplete: opts.callers.taskMarkDoneCaller !== undefined,
        canReschedule: opts.callers.workEntityUpsertCaller !== undefined,
        edit: controller.edit(),
        notice: controller.notice(),
        error: controller.error(),
        canCloseCommitment: opts.callers.commitmentCloseCaller !== undefined,
        commitmentBusy: controller.busy(),
        canDismissSituation: opts.callers.situationChangeCaller !== undefined,
        canCloseDay: opts.callers.closeDayCaller !== undefined,
        canOpenStream: opts.callers.stream !== undefined,
        closingDay: controller.closingDay(),
        undoDismissal: controller.undoDismissal(),
        occasionDrafts,
        canAnswerOccasionNext: opts.callers.occasionNextCaller !== undefined,
      },
      sphereFilter,
      (showCustomerReviews ? customerReviews.render(TODAY_ROUTE_ACTION_ATTR, expandedReviews) : '')
        + followUps.render(TODAY_ROUTE_ACTION_ATTR) + reminders.render(TODAY_ROUTE_ACTION_ATTR),
    );
    const due = root.querySelector<HTMLInputElement>(`[${TODAY_ROUTE_ACTION_ATTR}="today-task-due"]`);
    deferredViewPaint = false;
    // D-407 slice 2 — a "When is the next one?" box being typed in stays in place, as the task editor's date does:
    // a native date keeps its half-typed segments outside `value`.
    const occasionField = due === null ? OCCASION_NEXT_FIELDS.find(name => held?.hasAttribute(name)) : undefined;
    if (occasionField !== undefined && held) {
      const next = doc.createElement('div');
      for (const attr of Array.from(root.attributes)) next.setAttribute(attr.name, attr.value);
      next.innerHTML = html;
      const counterpart = Array.from(next.querySelectorAll(`[${occasionField}]`)).find(node => node.getAttribute(occasionField) === held.getAttribute(occasionField));
      if (!counterpart || !renderAroundDueField(root, next, held, counterpart)) root.innerHTML = html;
    } else if (due !== null) {
      const next = doc.createElement('div');
      for (const attr of Array.from(root.attributes)) next.setAttribute(attr.name, attr.value);
      next.innerHTML = html;
      const nextDue = next.querySelector<HTMLInputElement>(`[${TODAY_ROUTE_ACTION_ATTR}="today-task-due"]`);
      if (nextDue === null) root.innerHTML = html;
      else if (!renderAroundDueField(root, next, due, nextDue)) {
        // A task can leave the list (or its sphere) during an edit. Keep its
        // native control in place, update errors/busy state, and make the
        // pending view explicit until Save or Cancel can retire the editor.
        const editor = due.closest('[data-today-task-editor]');
        const nextEditor = nextDue.closest('[data-today-task-editor]');
        if (editor && nextEditor) renderAroundDueField(editor, nextEditor, due, nextDue);
        deferredViewPaint = true;
        const updated = root.querySelector('.today-updated');
        if (updated) updated.textContent = 'Finish or cancel rescheduling to show the latest results.';
      }
    } else root.innerHTML = html;
    taskBlockers.mount(root);
    taskReplyWatches.mount(root);
    if (taskReplyWatches.focus(replyWatchFocus)) return;
    if (blockerFocus) { taskBlockers.focus(blockerFocus); return; }
    if (reminders.restoreFocus(root, heldReminderKey)) return;
    if (reminderRestorePending && reminderOrigin && controller.snapshot()?.complete && reminders.current()) {
      reminderRestorePending = false;
      if (!held && interaction === 0) {
        reminders.restoreFocus(root, reminderOrigin.focus);
        if (doc.activeElement?.getAttribute(TODAY_REMINDER_FOCUS) === reminderOrigin.focus) opts.container.scrollTop = reminderOrigin.scrollTop;
        else (doc.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
      }
    }
    if (restorePending && returnOrigin && controller.snapshot()?.complete) {
      restorePending = false;
      if (!held) { taskBlockers.focus(returnOrigin); opts.container.scrollTop = returnOrigin.scrollTop; }
    }
    if (held === null) return;
    if (held === due && doc.activeElement === due) return;
    const find = (selector: string, match: (el: HTMLElement) => boolean): HTMLElement | null =>
      Array.from(root.querySelectorAll?.<HTMLElement>(selector) ?? []).find(match) ?? null;
    const refresh = (): HTMLElement | null =>
      root.querySelector?.<HTMLElement>('.today-refresh') ?? null;
    if (heldReview) {
      const review = find('[data-today-customer-review]', row => row.getAttribute('data-today-customer-review') === heldReview);
      const target = heldAction === 'today-customer-review-done'
        ? review?.querySelector<HTMLElement>('button:not(:disabled)') : heldHref ? review?.querySelector<HTMLElement>('a') : null;
      (target ?? review?.querySelector<HTMLElement>('summary')
        ?? root.querySelector<HTMLElement>('[data-today-customer-heading]') ?? refresh())?.focus({ preventScroll: true });
    } else if (held.hasAttribute('data-today-sphere')) {
      root.querySelector<HTMLSelectElement>('[data-today-sphere]')?.focus();
    } else if (heldHref !== null && heldHref !== undefined) {
      (find('a', (el) => el.getAttribute('href') === heldHref) ?? refresh())
        ?.focus?.({ preventScroll: true });
    } else if (heldAction === 'today-follow-ups-refresh') {
      root.querySelector<HTMLElement>(`[${TODAY_ROUTE_ACTION_ATTR}="today-follow-ups-refresh"]`)?.focus({ preventScroll: true });
    } else if (heldRefresh || heldSources) {
      root.querySelector?.<HTMLElement>(heldRefresh ? '.today-refresh' : '.today-sources summary')
        ?.focus?.({ preventScroll: true });
    } else if (heldAction?.startsWith('today-task-') === true || heldAction?.startsWith('today-commitment-') === true) {
      (find(`[${TODAY_ROUTE_ACTION_ATTR}]`, (el) =>
        el.getAttribute(TODAY_ROUTE_ACTION_ATTR) === heldAction
        && el.getAttribute('data-today-task') === heldTaskKey)
        ?? root.querySelector?.<HTMLElement>('[data-today-task-notice]') ?? refresh())
        ?.focus?.({ preventScroll: true });
    } else if (heldNotice || heldError) {
      root.querySelector?.<HTMLElement>(
        heldError ? '[data-today-task-error]' : '[data-today-task-notice]',
      )?.focus?.({ preventScroll: true });
    }
  };

  const controller: TodayController = createTodayController({
    callers: { ...opts.callers, workEntitySourceListCaller: opts.callers.workEntitySourceListCaller ? async () => {
      const response = await opts.callers.workEntitySourceListCaller!(); dependencySources = response.sources; return response;
    } : undefined },
    now: opts.now ?? (() => Date.now()),
    render: () => { render(); },
    isDisposed: () => disposed,
    // A standalone route is only ever mounted when Today is the surface.
    isActive: () => !disposed,
    refreshActive: () => { pending = load(); },
    focusTask: (selector) => { root.querySelector?.<HTMLElement>(selector)?.focus?.(); },
    ownsFocus: () => doc.activeElement == null || doc.activeElement === doc.body
      || (doc.activeElement as HTMLElement).closest?.(`[${TODAY_ROUTE_HOST_ATTR}]`) != null,
    actionAttr: TODAY_ROUTE_ACTION_ATTR,
    errMessage,
  });
  const reminders = createTodayReminders({ callers: opts.callers.reminderCallers,
    now: opts.now ?? Date.now,
    changed: render, blocked: () => controller.edit() !== null || controller.busy(),
  });
  const followUps = createTodayFollowUps({ list: opts.callers.followUpListCaller, now: opts.now ?? Date.now, changed: render });
  const customerReviews = createTodayCustomerDecisionReviews({ callers: opts.customerDecisionWatches, changed: render });

  const load = async (): Promise<void> => {
    const mine = ++generation;
    taskBlockers.refresh();
    await Promise.all([controller.load(() => !disposed && mine === generation).then(() => {
      if (!disposed && mine === generation) render();
    }), reminders.load(), followUps.load(), customerReviews.load()]);
    if (disposed || mine !== generation) return;
    render();
    // Drain AFTER the paint, never during — a broadcast that arrived mid-read
    // is a reason to read again, not a reason to interleave two reads.
    if (controller.takeQueuedLiveRefresh()) pending = load();
  };

  // D-340 slice 2 (§3.7) — the streams' settings, over Today in a dialog of their own, so Today's
  // repaints never touch them. Closing it gives focus back to the button that opened it.
  let streamDialog: ReturnType<typeof openStreamDialog> | null = null;
  const openStream = (): void => {
    const stream = opts.callers.stream;
    if (disposed || !stream || streamDialog) return;
    streamDialog = openStreamDialog(doc, stream, () => {
      streamDialog = null;
      if (!disposed) root.querySelector<HTMLElement>('[data-today-stream-open]')?.focus({ preventScroll: true });
    });
  };
  const onClick = (ev: Event): void => {
    const target = (ev.target as HTMLElement | null)
      ?.closest?.(`[${TODAY_ROUTE_ACTION_ATTR}]`) as HTMLElement | null;
    const action = target?.getAttribute(TODAY_ROUTE_ACTION_ATTR);
    if (!action) return;
    if (action === 'today-reminder-open') {
      const click = ev as MouseEvent;
      if (click.ctrlKey || click.metaKey || click.shiftKey || click.altKey || click.button && click.button !== 0) return;
      ev.preventDefault();
      const id = target?.getAttribute('data-today-reminder-id'), href = target?.getAttribute('href');
      if (!id || !href || !reminders.beforeOpen()) return;
      if (opts.reminderNavigation) opts.reminderNavigation.open({ id, focus: `open:${id}`, scrollTop: opts.container.scrollTop,
        sphere: sphereFilter, sourcesOpen, expanded: taskBlockers.expanded() });
      else if (doc.defaultView) doc.defaultView.location.hash = href;
      return;
    }
    // Carry the owner's activated control through the repaint in WebKit too.
    // A programmatic refresh must retain the field the owner is editing.
    if (ev.isTrusted && target?.tagName === 'BUTTON') {
      target.focus?.({ preventScroll: true });
    }
    if (reminders.handle(action, target?.getAttribute('data-today-reminder-id') ?? '', target?.getAttribute('data-today-reminder-preset') ?? undefined)) return;
    if (reminders.busy()) return;
    if (action === 'today-follow-ups-refresh') { if (!followUps.loading()) void followUps.load(); return; }
    if (action === 'today-customer-reviews-refresh') { void customerReviews.load(); return; }
    if (action === 'today-customer-review-done') {
      const id = target?.getAttribute('data-review-id');
      if (id) void customerReviews.reviewed(id);
      return;
    }
    if (action === 'refresh-today') {
      if (!controller.refreshing()) pending = load();
      return;
    }
    if (action === TODAY_CLOSE_DAY_ACTION) { void controller.closeDay(); return; }
    if (action === TODAY_STREAM_ACTION) { openStream(); return; }
    if (action === 'today-task-complete' || action === 'today-task-reschedule') {
      controller.openEditor(
        target?.getAttribute('data-today-task') ?? '',
        action === 'today-task-complete' ? 'complete' : 'reschedule',
      );
      return;
    }
    if (action === 'today-task-save') { void controller.submit(); return; }
    if (action === 'today-task-due-today' || action === 'today-task-due-tomorrow' || action === 'today-task-due-clear') {
      const shortcut = action === 'today-task-due-today' ? 'today' : action === 'today-task-due-tomorrow' ? 'tomorrow' : 'clear';
      void controller.applyDueShortcut(target?.getAttribute('data-today-task') ?? '', shortcut);
      return;
    }
    if (action === 'today-commitment-fulfill' || action === 'today-commitment-cancel') {
      void controller.closeCommitment(target?.getAttribute('data-today-task') ?? '', action === 'today-commitment-fulfill' ? 'fulfill' : 'cancel');
      return;
    }
    if (action === 'today-situation-dismiss') {
      const code = target?.getAttribute('data-today-dismiss') as SituationDismissal | null;
      if (!code) return;
      void controller.dismissSituation(target?.getAttribute('data-today-dismiss-cluster') ?? '', Number(target?.getAttribute('data-today-dismiss-item')), code)
        // "That's wrong" corrects the record itself: open it once the answer is kept.
        .then(href => { if (href && !disposed && doc.defaultView) doc.defaultView.location.hash = href; });
      return;
    }
    // D-407 slice 2 — "When is the next one?": the date typed beside it, or "No next one".
    if (action === TODAY_OCCASION_NEXT_SAVE || action === TODAY_OCCASION_NEXT_NONE) {
      const id = target?.getAttribute('data-today-occasion-id') ?? '';
      const read = (name: string) => [...root.querySelectorAll<HTMLInputElement>(`[${name}]`)].find(node => node.getAttribute(name) === id)?.value ?? '';
      void controller.answerOccasionNext(id, action === TODAY_OCCASION_NEXT_NONE ? null : read(OCCASION_NEXT_FIELDS[0]), read(OCCASION_NEXT_FIELDS[1]));
      return;
    }
    if (action === 'today-situation-restore') { void controller.restoreSituation(target?.getAttribute('data-today-dismissal') ?? ''); return; }
    // The link still navigates; this only tells the learner it was opened.
    if (action === 'today-situation-open') {
      controller.recordOpen(target?.getAttribute('data-today-open-cluster') ?? '', Number(target?.getAttribute('data-today-open-item')));
      return;
    }
    if (action === 'today-task-cancel') { controller.closeEditor(); return; }
    if (action === TODAY_CREATE_ACTION) opts.callers.openCreateOverlay?.();
  };

  const onInput = (ev: Event): void => {
    const target = ev.target as HTMLInputElement | null;
    if (target?.getAttribute(TODAY_ROUTE_ACTION_ATTR) === 'today-task-due') {
      controller.setEditValue(target.value);
    }
    // D-407 slice 2 — kept for the next repaint.
    const [onField, timeField] = OCCASION_NEXT_FIELDS;
    const id = target?.getAttribute(onField) ?? target?.getAttribute(timeField);
    if (target && id) {
      const draft = occasionDrafts.get(id) ?? { on: '', time: '' };
      occasionDrafts.set(id, target.hasAttribute(onField) ? { ...draft, on: target.value } : { ...draft, time: target.value });
    }
  };

  /** ⛔ THE EDITOR IS A KEYBOARD SURFACE, SO IT OWES KEYBOARD EXITS. Escape
   *  closes a reschedule without committing it and Enter commits from the date
   *  field, because a field you can only leave by finding a button with the
   *  mouse is not usable by the people most likely to be living in this view.
   *
   *  ⚠ The Data tab had this; the D-290 extraction dropped the whole keydown
   *  handler and left the editor openable but not closable by key. Found by the
   *  e2e, not by a unit test — this suite has no DOM to dispatch a key into.
   *
   *  `stopPropagation` on Escape so it closes the EDITOR rather than whatever
   *  the shell would otherwise treat Escape as dismissing. */
  const onKeyDown = (ev: KeyboardEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (ev.key === 'Escape' && !ev.isComposing && controller.edit() !== null
      && target?.closest?.('[data-today-task-editor]') != null) {
      ev.preventDefault();
      ev.stopPropagation();
      controller.closeEditor();
      return;
    }
    if (ev.key === 'Enter' && !ev.isComposing
      && target?.closest?.(`[${TODAY_ROUTE_ACTION_ATTR}]`)
        ?.getAttribute(TODAY_ROUTE_ACTION_ATTR) === 'today-task-due') {
      ev.preventDefault();
      void controller.submit();
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeyDown);
  const interacted = () => { interaction++; };
  root.addEventListener('pointerdown', interacted);
  root.addEventListener('keydown', interacted);
  root.addEventListener('focusin', interacted);
  root.addEventListener('change', event => { const target = event.target as HTMLSelectElement | null;
    if (target?.hasAttribute('data-today-sphere') && ['all', 'personal', 'professional', 'unsorted'].includes(target.value)) {
      sphereFilter = target.value as TodaySphereFilter; render(); root.querySelector<HTMLSelectElement>('[data-today-sphere]')?.focus();
    }
  });

  // ⛔ TIME IS AN INPUT TO THIS SURFACE, AND NOTHING BROADCASTS IT. Today
  // classifies by deadline — overdue, due today, the local-day boundary — so
  // the same rows mean something different a minute later with no warehouse
  // write to announce it. Without this a Today page left open keeps yesterday's
  // answer indefinitely, and it LOOKS current: nothing is stale on screen, the
  // rows are simply sorted against a clock that stopped.
  //
  // ⚠ Carried over from the Data tab, where it was `todayClock` +
  // `onTodayVisible`. The D-290 extraction left both behind and this route ran
  // without them; found by deleting the Data route's dead copy and asking
  // whether the live one had it. A broadcast subscription is NOT a substitute.
  const onTick = (): void => {
    if (disposed || controller.refreshing() || doc.visibilityState === 'hidden') return;
    pending = load();
  };
  const clock = doc.defaultView?.setInterval?.(onTick, TODAY_CLOCK_INTERVAL_MS);
  // Intervals do not fire reliably in a backgrounded tab, so returning to one
  // reads once rather than waiting out the rest of the minute.
  const onVisible = (): void => {
    if (disposed || doc.visibilityState !== 'visible' || controller.refreshing()) return;
    pending = load();
  };
  doc.addEventListener?.('visibilitychange', onVisible);
  const onLive = (): void => {
    if (disposed) return;
    // A read already running owns the next paint; queue rather than race it.
    if (controller.refreshing()) controller.queueLiveRefresh();
    else pending = load();
  };
  const unsubscribers = opts.subscribe === undefined ? []
    : [opts.subscribe('warehouse', onLive), opts.subscribe('memory', onLive), opts.subscribe('notification.notify', onLive)];

  render();
  pending = load();
  if (opts.openStream) openStream();

  return {
    dispose: () => {
      streamDialog?.close(true);
      disposed = true;
      taskBlockers.dispose();
      taskReplyWatches.dispose();
      reminders.dispose();
      followUps.dispose();
      customerReviews.dispose();
      for (const off of unsubscribers) off();
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
      root.removeEventListener('keydown', onKeyDown);
      if (clock !== undefined) doc.defaultView?.clearInterval?.(clock);
      doc.removeEventListener?.('visibilitychange', onVisible);
      searchBack?.remove();
      root.remove();
    },
    // A task write in flight must retain its owner across a route change.
    hasInFlightWork: () => controller.busy() || reminders.busy() || customerReviews.busy() || streamDialog?.panel.hasInFlightWork() === true,
    // ⛔ ALWAYS STARTS A NEW READ — it does NOT skip while one is running.
    // Superseding is the point: `load()` takes a fresh generation, so the
    // in-flight read is retired and can no longer repaint rows the newer one
    // has already replaced. The click handler debounces the BUTTON; this seam
    // must not, or a caller asking for current data would silently get the
    // answer to a question it already knows is stale.
    refresh: () => { pending = load(); },
    getRecoveryContextFreshness: () => {
      const snap = controller.snapshot();
      return disposed || deferredViewPaint || controller.refreshing() || snap === null || snap.issues.length > 0 || !taskBlockers.current() || !reminders.current() || !followUps.current()
        ? 'unavailable' : 'current';
    },
    whenLoaded: () => pending,
    openStream,
  };
};
