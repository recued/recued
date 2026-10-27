import type { AuditLogStore } from '@recued/storage';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import { PUSH_GRACE_MS, settleWithin, STOP_GRACE_MS } from './lifecycle/settle-within.js';
import type { SavedDataViewAlertNotice, SavedDataViewAlertStore } from './saved-data-view-alert-store.js';

export const savedViewAlertMessage = (notice: SavedDataViewAlertNotice, publicBaseUrl?: string): NotificationMessage => {
  const noun = notice.kind === 'records' ? 'record' : 'task';
  return {
    title: `New ${noun}${notice.count === 1 ? '' : 's'} in “${notice.view_name}”`,
    text: `${notice.count === 1 ? `A ${noun} now matches` : `${notice.count} ${noun}s now match`} your saved view “${notice.view_name}”.`
      + (notice.titles ?? []).map(title => `\n• ${title}`).join('')
      + `\nOpen the view to review the matching ${noun}s.`,
    // D-291 — the canonical saved-view address is `#views/<id>`. ⚠ Notifications
    // ALREADY DELIVERED carry the old `#data/view/<id>`, in inboxes and OS
    // notification centres this server cannot reach; they keep working because
    // the shell's parser still re-points that address. Emitting the new one is
    // for links sent from here on, not a migration.
    ...(publicBaseUrl ? { link_url: `${publicBaseUrl}/#views/${encodeURIComponent(notice.view_id)}` } : {}),
  };
};

/** One worker per server, with durable notification history before an atomic
 * push claim. Existing owner channels remain best-effort; a restart never
 * repeats a claimed push. Unclaimed notices retry with the SAME activity id. */
export const createSavedDataViewAlertRuntime = (deps: {
  store: SavedDataViewAlertStore;
  auditLog: Pick<AuditLogStore, 'logActivity'>;
  notifier: Pick<NotificationBlock, 'notify'>;
  /** Read per notice: the server's public address can appear or change while
   *  it runs. */
  getPublicBaseUrl?: () => string | null;
  intervalMs?: number;
}) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  /** The claimed push in flight, if any (`stop`). */
  let pushing: Promise<void> | undefined;
  let stopped = false;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      deps.store.evaluate();
      for (const notice of deps.store.pending()) {
        if (stopped) break;
        const message = savedViewAlertMessage(notice, deps.getPublicBaseUrl?.() ?? undefined);
        const ui_link_url = `#views/${encodeURIComponent(notice.view_id)}`;
        await deps.auditLog.logActivity({ activity_id: notice.id, timestamp: notice.created_at,
          action: 'notification_fired', target: notice.view_id,
          detail: JSON.stringify({ ...message, link_url: message.link_url ?? ui_link_url }) });
        if (stopped || !deps.store.claim(notice.id)) continue;
        const push = (async () => deps.notifier.notify(message, undefined, { persisted_activity_id: notice.id, ui_link_url }))();
        pushing = push;
        try { await push; } finally { pushing = undefined; }
      }
    })().catch(error => { console.warn('[saved-view-alert] evaluation or notification persistence failed', error); })
      .finally(() => { running = undefined; });
    return running;
  };
  return {
    tick,
    start(): void {
      if (timer || stopped) return;
      timer = setInterval(() => { void tick(); }, deps.intervalMs ?? 60_000);
      timer.unref();
      void tick();
    },
    /** Claim no further notice, and wait for the check in progress at most
     *  `STOP_GRACE_MS` — `PUSH_GRACE_MS` while a claimed push is in flight.
     *
     *  A notice not yet claimed is safe to leave: it stays in the store and the
     *  first tick after the restart sends it under the same activity id. A
     *  claimed one is not: the claim deletes the notice ("attempted at most
     *  once, even across restarts", the store) and `notify()` keeps no outbox.
     *  So its push gets the longer grace, and one still going after it (15 s a
     *  messenger call; an email longer) is cut by the exit after the drain,
     *  leaving only its history row: waiting on would run out the drain step,
     *  which makes an update refuse to swap. */
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (running) await settleWithin(running, pushing !== undefined ? PUSH_GRACE_MS : STOP_GRACE_MS);
    },
  };
};
