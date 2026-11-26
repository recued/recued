import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { mailFollowUpHref, mailFollowUpReplyHref, type MailFollowUp } from '@recued/contracts';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';
import type { MailFollowUpService } from './mail-follow-up-service.js';
import { PUSH_GRACE_MS, settleWithin, STOP_GRACE_MS } from './lifecycle/settle-within.js';

type ReplyNoticeState = 'ready' | 'unavailable' | 'stopped';
interface Notice {
  watch_id: string; activity_id: string; created_at: number; history_revision: number;
  history_state: ReplyNoticeState | ''; claimed_at: number | null; suppressed: number;
}
export const createMailFollowUpReplyAlertStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_follow_up_reply_notices (
    watch_id TEXT PRIMARY KEY REFERENCES mail_follow_ups(id) ON DELETE CASCADE,
    activity_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
    history_revision INTEGER NOT NULL DEFAULT 0, history_state TEXT NOT NULL DEFAULT '',
    claimed_at INTEGER, suppressed INTEGER NOT NULL DEFAULT 0
  )`);
  const get = (id: string) => db.prepare('SELECT * FROM mail_follow_up_reply_notices WHERE watch_id=?').get(id) as Notice | undefined;
  return {
    get,
    candidates(): string[] {
      return (db.prepare(`SELECT w.id FROM mail_follow_ups w LEFT JOIN mail_follow_up_reply_notices n ON n.watch_id=w.id
        WHERE (w.state='replied' AND w.notify_on_reply=1 AND n.watch_id IS NULL)
          OR (n.watch_id IS NOT NULL AND (n.history_revision<>w.revision OR (n.claimed_at IS NULL AND n.suppressed=0)))
        ORDER BY w.updated_at,w.id`).all() as { id: string }[]).map(row => row.id);
    },
    ensure(watch: MailFollowUp, at: number): Notice | undefined {
      const id = 'mail-reply:' + createHash('sha256').update(JSON.stringify([watch.id, watch.reply_ref])).digest('hex');
      db.prepare(`INSERT OR IGNORE INTO mail_follow_up_reply_notices (watch_id,activity_id,created_at)
        SELECT id,?,? FROM mail_follow_ups WHERE id=? AND revision=? AND state='replied' AND notify_on_reply=1`)
        .run(id, at, watch.id, watch.revision);
      return get(watch.id);
    },
    dirty(id: string) { db.prepare('UPDATE mail_follow_up_reply_notices SET history_revision=0 WHERE watch_id=?').run(id); },
    recorded(watch: MailFollowUp, state: ReplyNoticeState): boolean {
      return db.prepare(`UPDATE mail_follow_up_reply_notices SET history_revision=?,history_state=?,suppressed=? WHERE watch_id=?
        AND EXISTS (SELECT 1 FROM mail_follow_ups WHERE id=? AND revision=?)`)
        .run(watch.revision, state, state === 'stopped' ? 1 : 0, watch.id, watch.id, watch.revision).changes === 1;
    },
    claim(watch: MailFollowUp, at: number): boolean {
      return db.prepare(`UPDATE mail_follow_up_reply_notices SET claimed_at=? WHERE watch_id=? AND history_revision=?
        AND history_state='ready' AND claimed_at IS NULL AND suppressed=0
        AND EXISTS (SELECT 1 FROM mail_follow_ups WHERE id=? AND revision=? AND state='replied' AND notify_on_reply=1)`)
        .run(at, watch.id, watch.revision, watch.id, watch.revision).changes === 1;
    },
  };
};

const message = (watch: MailFollowUp, state: ReplyNoticeState, base?: string | null): NotificationMessage => {
  const hash = state === 'ready' ? mailFollowUpReplyHref(watch.id) : mailFollowUpHref(watch.id);
  return {
    title: state === 'ready' ? 'Reply received' : state === 'stopped' ? 'Reply alert stopped' : 'Reply needs review',
    text: state === 'ready' ? 'A recipient replied to your watched email. Open the received message to read it and choose your next action.'
      : state === 'stopped' ? 'Reply alerts are off for this watch. You can still review its conversation in Mail.'
      : 'The received reply could not be confirmed. Open the watch to review the conversation.',
    ...(base ? { link_url: base.replace(/\/+$/, '') + '/' + hash } : {}),
  };
};

/** A reply may arrive before the follow-up deadline. Opt-in delivery is independent
 * of draft creation; a retained full reference is checked again before claiming. */
export const createMailFollowUpReplyAlertRuntime = (deps: {
  store: ReturnType<typeof createMailFollowUpReplyAlertStore>;
  service: Pick<MailFollowUpService, 'check' | 'replyGuard'>;
  validateOwner(watch: MailFollowUp): Promise<() => void>;
  auditLog: Pick<AuditLogStore, 'logActivity'>;
  notifier: Pick<NotificationBlock, 'notify'>;
  update(message: NotificationMessage, activityId: string, hash: string): void;
  canRun?: () => boolean; isQuiet(at: number): boolean;
  getPublicBaseUrl?: () => string | null; now?: () => number; intervalMs?: number;
}) => {
  const now = deps.now ?? Date.now;
  let stopped = false, timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined, pushing: Promise<void> | undefined;
  const available = () => !stopped && deps.canRun?.() !== false;
  const record = async (watch: MailFollowUp, notice: Notice, state: ReplyNoticeState): Promise<boolean> => {
    const body = message(watch, state, deps.getPublicBaseUrl?.());
    const hash = state === 'ready' ? mailFollowUpReplyHref(watch.id) : mailFollowUpHref(watch.id);
    await deps.auditLog.logActivity({ activity_id: notice.activity_id, timestamp: notice.created_at, action: 'notification_fired',
      target: watch.id, detail: JSON.stringify({ ...body, link_url: body.link_url ?? hash }) });
    if (!available() || !deps.store.recorded(watch, state)) { deps.store.dirty(watch.id); return false; }
    if (state !== 'ready' || notice.claimed_at !== null || notice.history_state !== '' && notice.history_state !== state)
      deps.update(body, notice.activity_id, hash);
    return true;
  };
  const tick = (): Promise<void> => {
    if (!available()) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      let pushes = 0;
      for (const id of deps.store.candidates()) {
        if (!available() || pushes >= 10) return;
        try {
          let watch = await deps.service.check(id); if (!available()) return;
          let notice = deps.store.get(id);
          if (!watch.notify_on_reply || watch.state !== 'replied') {
            if (notice && (notice.history_revision !== watch.revision || notice.history_state !== 'stopped')) await record(watch, notice, 'stopped');
            continue;
          }
          if (!notice && deps.isQuiet(now())) continue;
          const authorized = await deps.validateOwner(watch); if (!available()) return;
          let guard: Awaited<ReturnType<MailFollowUpService['replyGuard']>>;
          try { guard = await deps.service.replyGuard(id); watch = guard().watch; }
          catch {
            if (notice && (notice.history_revision !== watch.revision || notice.history_state !== 'unavailable')) await record(watch, notice, 'unavailable');
            continue;
          }
          if (!watch.notify_on_reply || !available() || deps.isQuiet(now())) continue;
          notice = notice ?? deps.store.ensure(watch, now()); if (!notice) continue;
          if ((notice.history_revision !== watch.revision || notice.history_state !== 'ready') && !await record(watch, notice, 'ready')) continue;
          if (notice.claimed_at !== null || !available() || deps.isQuiet(now())) continue;
          authorized();
          try { guard(); } catch { await record(watch, notice, 'unavailable'); continue; }
          if (!deps.store.claim(watch, now())) { deps.store.dirty(id); continue; }
          const push = (async () => deps.notifier.notify(message(watch, 'ready', deps.getPublicBaseUrl?.()), undefined,
            { persisted_activity_id: notice.activity_id, ui_link_url: mailFollowUpReplyHref(watch.id) }))();
          pushes++; pushing = push;
          try { await push; } catch { /* A claimed best-effort push is never replayed; history supports catch-up. */ }
          finally { pushing = undefined; }
        } catch { /* A locked store or one unavailable owner must not block other watches. */ }
      }
    })().catch(() => { /* Temporary storage failures retry on the next pass. */ }).finally(() => { running = undefined; });
    return running;
  };
  return {
    tick,
    start() { if (timer || stopped) return; timer = setInterval(() => void tick(), deps.intervalMs ?? 30_000); timer.unref?.(); void tick(); },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; if (running) await settleWithin(running, pushing ? PUSH_GRACE_MS : STOP_GRACE_MS); },
  };
};
