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
import { renderToday, TODAY_CREATE_ACTION, TODAY_VIEW_STYLES } from '../data/today-view.js';
import {
  createTodayController, type TodayCallers, type TodayController,
} from './today-controller.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

export const TODAY_ROUTE_HOST_ATTR = 'data-recued-today-route';
export const TODAY_ROUTE_STYLES_MARKER = 'data-recued-today-route-styles';
/** Today's own click-dispatch attribute. `renderToday` takes the attribute as
 *  an argument, so the markup carries whichever the host passes. */
export const TODAY_ROUTE_ACTION_ATTR = 'data-recued-today-action';

/** How often Today re-reads purely because the clock moved. One minute — the
 *  smallest unit any of its copy renders ("in 3 minutes", "overdue"). */
export const TODAY_CLOCK_INTERVAL_MS = 60_000;

export interface BootstrapTodayRouteOptions {
  container: HTMLElement;
  callers: TodayCallers;
  now?: () => number;
  /** The shell's broadcast subscriber. Today reads tasks, commitments and
   *  calendar, so it listens on the same kinds the Data tab did. Absent ⇒ the
   *  view refreshes only on demand. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface TodayRoute {
  dispose: () => void;
  hasInFlightWork: () => boolean;
  /** Start a fresh read. No-op while one is already running. */
  refresh: () => void;
  /** Is what is on screen a complete, current answer? Carried over from the
   *  Data route VERBATIM (`todayRefreshing || snapshot === null ||
   *  issues.length > 0`) — the recovery-intent machinery compares surfaces, so
   *  a surface that computed freshness its own way would report "current"
   *  where its predecessor reported "unavailable" and quietly change what a
   *  recovery return decides. */
  getRecoveryContextFreshness: () => 'current' | 'unavailable';
  /** Test seam — settles the in-flight read. */
  whenLoaded: () => Promise<void>;
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
      style.textContent = TODAY_VIEW_STYLES;
      doc?.head?.appendChild?.(style);
    }
  }
  const root = doc.createElement('div');
  root.setAttribute(TODAY_ROUTE_HOST_ATTR, '');
  opts.container.appendChild(root);

  let generation = 0;
  let pending: Promise<void> = Promise.resolve();
  let sourcesOpen: boolean | undefined;

  const render = (): void => {
    if (disposed) return;
    // Preserve the sources disclosure across a repaint — the snapshot changing
    // is not a reason to collapse something the owner opened.
    sourcesOpen = root.querySelector?.<HTMLDetailsElement>('.today-sources')?.open ?? sourcesOpen;
    // ⛔⛔ EVERY PAINT REPLACES THE DOM, SO EVERY PAINT MUST HAND FOCUS BACK.
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
    root.innerHTML = renderToday(
      controller.snapshot(),
      controller.refreshing(),
      TODAY_ROUTE_ACTION_ATTR,
      sourcesOpen,
      opts.callers.openCreateOverlay !== undefined,
      {
        canComplete: opts.callers.taskMarkDoneCaller !== undefined,
        canReschedule: opts.callers.workEntityUpsertCaller !== undefined,
        edit: controller.edit(),
        notice: controller.notice(),
      },
    );
    if (held === null) return;
    const find = (selector: string, match: (el: HTMLElement) => boolean): HTMLElement | null =>
      Array.from(root.querySelectorAll?.<HTMLElement>(selector) ?? []).find(match) ?? null;
    const refresh = (): HTMLElement | null =>
      root.querySelector?.<HTMLElement>('.today-refresh') ?? null;
    if (heldHref !== null && heldHref !== undefined) {
      (find('a', (el) => el.getAttribute('href') === heldHref) ?? refresh())
        ?.focus?.({ preventScroll: true });
    } else if (heldRefresh || heldSources) {
      root.querySelector?.<HTMLElement>(heldRefresh ? '.today-refresh' : '.today-sources summary')
        ?.focus?.({ preventScroll: true });
    } else if (heldAction?.startsWith('today-task-') === true) {
      // ⚠ The due-date INPUT lands here too. Its draft lives in the
      // controller's `edit`, so the re-rendered field already carries the typed
      // value — what the repaint would otherwise lose is only the caret.
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
    callers: opts.callers,
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

  const load = async (): Promise<void> => {
    const mine = ++generation;
    await controller.load(() => !disposed && mine === generation);
    if (disposed || mine !== generation) return;
    render();
    // Drain AFTER the paint, never during — a broadcast that arrived mid-read
    // is a reason to read again, not a reason to interleave two reads.
    if (controller.takeQueuedLiveRefresh()) pending = load();
  };

  const onClick = (ev: Event): void => {
    const target = (ev.target as HTMLElement | null)
      ?.closest?.(`[${TODAY_ROUTE_ACTION_ATTR}]`) as HTMLElement | null;
    const action = target?.getAttribute(TODAY_ROUTE_ACTION_ATTR);
    if (!action) return;
    if (action === 'refresh-today') {
      if (!controller.refreshing()) pending = load();
      return;
    }
    if (action === 'today-task-complete' || action === 'today-task-reschedule') {
      controller.openEditor(
        target?.getAttribute('data-today-task') ?? '',
        action === 'today-task-complete' ? 'complete' : 'reschedule',
      );
      return;
    }
    if (action === 'today-task-save') { void controller.submit(); return; }
    if (action === 'today-task-cancel') { controller.closeEditor(); return; }
    if (action === TODAY_CREATE_ACTION) opts.callers.openCreateOverlay?.();
  };

  const onInput = (ev: Event): void => {
    const target = ev.target as HTMLInputElement | null;
    if (target?.getAttribute(TODAY_ROUTE_ACTION_ATTR) === 'today-task-due') {
      controller.setEditValue(target.value);
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
    : [opts.subscribe('warehouse', onLive), opts.subscribe('memory', onLive)];

  render();
  pending = load();

  return {
    dispose: () => {
      disposed = true;
      for (const off of unsubscribers) off();
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
      root.removeEventListener('keydown', onKeyDown);
      if (clock !== undefined) doc.defaultView?.clearInterval?.(clock);
      doc.removeEventListener?.('visibilitychange', onVisible);
      root.remove();
    },
    // A task write in flight must retain its owner across a route change.
    hasInFlightWork: () => controller.busy(),
    // ⛔ ALWAYS STARTS A NEW READ — it does NOT skip while one is running.
    // Superseding is the point: `load()` takes a fresh generation, so the
    // in-flight read is retired and can no longer repaint rows the newer one
    // has already replaced. The click handler debounces the BUTTON; this seam
    // must not, or a caller asking for current data would silently get the
    // answer to a question it already knows is stale.
    refresh: () => { pending = load(); },
    getRecoveryContextFreshness: () => {
      const snap = controller.snapshot();
      return disposed || controller.refreshing() || snap === null || snap.issues.length > 0
        ? 'unavailable' : 'current';
    },
    whenLoaded: () => pending,
  };
};
