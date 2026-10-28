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
import type { SituationDismissal } from '@recued/contracts';
import { renderToday, TODAY_CREATE_ACTION, TODAY_VIEW_STYLES } from '../data/today-view.js';
import type { TodaySphereFilter } from '../data/today-view.js';
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
  /** Is what is on screen a complete, current answer? Pending reads, source
   * issues, and a view waiting for its reschedule editor to close are unavailable
   * to recovery continuity; a fresh snapshot alone cannot qualify an old paint. */
  getRecoveryContextFreshness: () => 'current' | 'unavailable';
  /** Test seam — settles the in-flight read. */
  whenLoaded: () => Promise<void>;
}

const errMessage = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : 'Something went wrong.';

/** Replace the siblings along the due field's path without disconnecting any
 * ancestor. Native date controls keep partial segments outside `value`; even
 * reinserting the same input resets which segment receives the next keystroke.
 * A different path shape is handled by keeping the editor in its current place. */
const renderAroundDueField = (
  current: Element, next: Element, due: HTMLInputElement, nextDue: HTMLInputElement,
): boolean => {
  const path = (leaf: Element, host: Element): Element[] => {
    const nodes: Element[] = [];
    for (let node: Element | null = leaf; node !== host; node = node.parentElement) {
      if (node === null) return [];
      nodes.unshift(node);
    }
    return nodes;
  };
  const before = path(due, current); const after = path(nextDue, next);
  if (before.length === 0 || before.length !== after.length
    || before.some((node, index) => node.tagName !== after[index]!.tagName)) return false;
  const attributes = (target: Element, source: Element): void => {
    for (const attr of Array.from(target.attributes)) {
      if (target === due && attr.name === 'value') continue;
      if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    }
    for (const attr of Array.from(source.attributes)) {
      if (target === due && attr.name === 'value') continue;
      if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
    }
  };
  for (let index = 0; index < before.length; index++) {
    const parent = index === 0 ? current : before[index - 1]!;
    const nextParent = index === 0 ? next : after[index - 1]!;
    const branch = before[index]!; const nextBranch = after[index]!;
    attributes(parent, nextParent);
    for (const node of Array.from(parent.childNodes)) if (node !== branch) parent.removeChild(node);
    let following = false;
    for (const node of Array.from(nextParent.childNodes)) {
      if (node === nextBranch) { following = true; continue; }
      parent.insertBefore(node, following ? null : branch);
    }
  }
  attributes(due, nextDue);
  return true;
};

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
        [${TODAY_ROUTE_HOST_ATTR}] { max-width: var(--wc-content-max, 1080px); margin: 0 auto; padding: 16px; }
        [${TODAY_ROUTE_HOST_ATTR}] .today-view { max-width: none; margin-top: 0; }
      `;
      doc?.head?.appendChild?.(style);
    }
  }
  const root = doc.createElement('div');
  root.setAttribute(TODAY_ROUTE_HOST_ATTR, '');
  opts.container.appendChild(root);

  let generation = 0;
  let pending: Promise<void> = Promise.resolve();
  let sourcesOpen: boolean | undefined;
  let sphereFilter: TodaySphereFilter = 'all';
  let deferredViewPaint = false;

  const render = (): void => {
    if (disposed) return;
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
    const html = renderToday(
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
        error: controller.error(),
        canCloseCommitment: opts.callers.commitmentCloseCaller !== undefined,
        commitmentBusy: controller.busy(),
        canDismissSituation: opts.callers.situationChangeCaller !== undefined,
        undoDismissal: controller.undoDismissal(),
      },
      sphereFilter,
    );
    const due = root.querySelector<HTMLInputElement>(`[${TODAY_ROUTE_ACTION_ATTR}="today-task-due"]`);
    deferredViewPaint = false;
    if (due !== null) {
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
    if (held === null) return;
    if (held === due && doc.activeElement === due) return;
    const find = (selector: string, match: (el: HTMLElement) => boolean): HTMLElement | null =>
      Array.from(root.querySelectorAll?.<HTMLElement>(selector) ?? []).find(match) ?? null;
    const refresh = (): HTMLElement | null =>
      root.querySelector?.<HTMLElement>('.today-refresh') ?? null;
    if (held.hasAttribute('data-today-sphere')) {
      root.querySelector<HTMLSelectElement>('[data-today-sphere]')?.focus();
    } else if (heldHref !== null && heldHref !== undefined) {
      (find('a', (el) => el.getAttribute('href') === heldHref) ?? refresh())
        ?.focus?.({ preventScroll: true });
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
    // Carry the owner's activated control through the repaint in WebKit too.
    // A programmatic refresh must retain the field the owner is editing.
    if (ev.isTrusted && target?.tagName === 'BUTTON') {
      target.focus?.({ preventScroll: true });
    }
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
      return disposed || deferredViewPaint || controller.refreshing() || snap === null || snap.issues.length > 0
        ? 'unavailable' : 'current';
    },
    whenLoaded: () => pending,
  };
};
