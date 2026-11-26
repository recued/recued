import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { mailFollowUpHref, type MailFollowUp } from '@recued/contracts';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';
import type { MailFollowUpService } from './mail-follow-up-service.js';
import { PUSH_GRACE_MS, settleWithin, STOP_GRACE_MS } from './lifecycle/settle-within.js';

interface Notice {
  watch_id: string; schedule_version: number; draft_id: string; activity_id: string; created_at: number;
  history_revision: number; claimed_at: number | null; suppressed: number;
}
export const createMailFollowUpAlertStore = (db: Database.Database) => {
  const schema = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
    watch_id TEXT NOT NULL REFERENCES mail_follow_ups(id) ON DELETE CASCADE,
    schedule_version INTEGER NOT NULL DEFAULT 0, draft_id TEXT NOT NULL,
    activity_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
    history_revision INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, suppressed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(watch_id,schedule_version)
  )`;
  db.exec(schema('mail_follow_up_notices'));
  if (!(db.prepare('PRAGMA table_info(mail_follow_up_notices)').all() as { name: string }[]).some(column => column.name === 'schedule_version')) {
    // Keep every original claim and history identity when upgrading a server.
    db.transaction(() => {
      db.exec(schema('mail_follow_up_notice_cycles'));
      db.exec(`INSERT INTO mail_follow_up_notice_cycles
        (watch_id,schedule_version,draft_id,activity_id,created_at,history_revision,claimed_at,suppressed)
        SELECT watch_id,0,draft_id,activity_id,created_at,history_revision,claimed_at,suppressed FROM mail_follow_up_notices;
        DROP TABLE mail_follow_up_notices;
        ALTER TABLE mail_follow_up_notice_cycles RENAME TO mail_follow_up_notices`);
    }).immediate();
  }
  const get = (id: string, version = 0) => db.prepare('SELECT * FROM mail_follow_up_notices WHERE watch_id=? AND schedule_version=?')
    .get(id, version) as Notice | undefined;
  return {
    get,
    candidates(): { id: string; schedule_version: number }[] {
      return db.prepare(`SELECT w.id,w.schedule_version,w.check_at FROM mail_follow_ups w
        WHERE w.state='draft_ready' AND NOT EXISTS (SELECT 1 FROM mail_follow_up_notices n
          WHERE n.watch_id=w.id AND n.schedule_version=w.schedule_version)
        UNION ALL
        SELECT w.id,n.schedule_version,w.check_at FROM mail_follow_ups w JOIN mail_follow_up_notices n ON n.watch_id=w.id
        WHERE n.history_revision<>w.revision OR (n.schedule_version=w.schedule_version AND n.claimed_at IS NULL AND n.suppressed=0)
        ORDER BY check_at,id,schedule_version`).all() as { id: string; schedule_version: number }[];
    },
    ensure(watch: MailFollowUp, at: number): Notice | undefined {
      if (!watch.draft_id) return undefined;
      const version = watch.schedule_version ?? 0;
      const identity = version === 0 ? [watch.id, watch.draft_id] : [watch.id, watch.draft_id, version];
      const id = 'mail-follow-up:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      db.prepare(`INSERT OR IGNORE INTO mail_follow_up_notices (watch_id,schedule_version,draft_id,activity_id,created_at)
        SELECT id,schedule_version,?,?,? FROM mail_follow_ups WHERE id=? AND revision=? AND schedule_version=? AND state='draft_ready'`)
        .run(watch.draft_id, id, at, watch.id, watch.revision, version);
      return get(watch.id, version);
    },
    dirty(id: string, version: number) { db.prepare('UPDATE mail_follow_up_notices SET history_revision=0 WHERE watch_id=? AND schedule_version=?').run(id, version); },
    recorded(watch: MailFollowUp, version: number): boolean {
      return db.prepare(`UPDATE mail_follow_up_notices SET history_revision=?,suppressed=? WHERE watch_id=? AND schedule_version=?
        AND EXISTS (SELECT 1 FROM mail_follow_ups WHERE id=? AND revision=?)`)
        .run(watch.revision, version !== (watch.schedule_version ?? 0) || ['delivery_failed', 'replied', 'cancelled', 'superseded'].includes(watch.state) ? 1 : 0,
          watch.id, version, watch.id, watch.revision).changes === 1;
    },
    claim(watch: MailFollowUp, at: number): boolean {
      return db.prepare(`UPDATE mail_follow_up_notices SET claimed_at=? WHERE watch_id=? AND draft_id=? AND schedule_version=?
        AND claimed_at IS NULL AND suppressed=0 AND history_revision=?
        AND EXISTS (SELECT 1 FROM mail_follow_ups w WHERE w.id=? AND w.revision=? AND w.state='draft_ready'
          AND w.schedule_version=mail_follow_up_notices.schedule_version)
        AND EXISTS (SELECT 1 FROM mail_drafts d WHERE d.draft_id=mail_follow_up_notices.draft_id AND d.deleted_at IS NULL)`)
        .run(at, watch.id, watch.draft_id, watch.schedule_version ?? 0, watch.revision, watch.id, watch.revision).changes === 1;
    },
  };
};

export const mailFollowUpAlertMessage = (watch: MailFollowUp, publicBaseUrl?: string | null, postponed = false): NotificationMessage => {
  const resolved = watch.state === 'replied' || watch.state === 'cancelled' || watch.state === 'superseded';
  const failure = watch.state === 'delivery_failed';
  const deferred = postponed && !resolved && !failure;
  const hash = mailFollowUpHref(watch.id, deferred || failure ? undefined : watch.draft_id, deferred || failure ? 0 : watch.schedule_version ?? 0);
  return {
    title: failure ? 'Email delivery failed' : deferred ? 'Follow-up postponed' : watch.state === 'draft_ready' ? 'Follow-up draft ready' : resolved ? 'Follow-up no longer needed' : 'Follow-up needs review',
    // Notification destinations do not need the email's subject, recipients or body.
    text: failure ? 'A permanent delivery failure was reported. Follow-up preparation stopped; task status is unchanged. Open the watch to review the report.' : deferred ? 'You changed the check time. This earlier alert has been retired. Open the watch for its current status.'
      : watch.state === 'draft_ready' ? 'Your follow-up draft is ready. Open it to review before sending.'
      : watch.state === 'replied' ? 'A recipient replied. The saved follow-up draft has been kept for review.'
      : watch.state === 'superseded' ? 'A newer email was sent. Review the conversation before using the saved follow-up draft.'
      : watch.state === 'cancelled' ? 'This reply watch was cancelled. Its saved draft has been kept.'
      : 'Check the reply watch before using its saved draft. The conversation or mailbox needs review.',
    ...(publicBaseUrl ? { link_url: publicBaseUrl.replace(/\/+$/, '') + '/' + hash } : {}),
  };
};

/** History is durable before a push is claimed. Claims are never replayed,
 * including a failed push; missed in-app notices use ordinary history catch-up.
 * Quiet hours hold new alerts, while updates retire obsolete existing alerts. */
export const createMailFollowUpAlertRuntime = (deps: {
  store: ReturnType<typeof createMailFollowUpAlertStore>;
  service: Pick<MailFollowUpService, 'check'>;
  validateDraft(watch: MailFollowUp): Promise<() => void>;
  auditLog: Pick<AuditLogStore, 'logActivity'>;
  notifier: Pick<NotificationBlock, 'notify'>;
  update(message: NotificationMessage, activityId: string, hash: string): void;
  canRun?: () => boolean;
  isQuiet(at: number): boolean;
  getPublicBaseUrl?: () => string | null;
  now?: () => number; intervalMs?: number;
}) => {
  const now = deps.now ?? Date.now;
  let stopped = false, timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined, pushing: Promise<void> | undefined;
  const available = () => !stopped && deps.canRun?.() !== false;
  const record = async (watch: MailFollowUp, notice: Notice): Promise<boolean> => {
    const outdated = notice.schedule_version !== (watch.schedule_version ?? 0);
    const message = mailFollowUpAlertMessage(watch, deps.getPublicBaseUrl?.(), outdated);
    const hash = mailFollowUpHref(watch.id, outdated || watch.state === 'delivery_failed' ? undefined : notice.draft_id, outdated || watch.state === 'delivery_failed' ? 0 : watch.schedule_version ?? 0);
    await deps.auditLog.logActivity({ activity_id: notice.activity_id, timestamp: notice.created_at,
      action: 'notification_fired', target: watch.id, detail: JSON.stringify({ ...message, link_url: message.link_url ?? hash }) });
    if (!available() || !deps.store.recorded(watch, notice.schedule_version)) { deps.store.dirty(watch.id, notice.schedule_version); return false; }
    if (notice.history_revision !== watch.revision && (outdated || watch.state !== 'draft_ready' || notice.claimed_at !== null)) deps.update(message, notice.activity_id, hash);
    return true;
  };
  const tick = (): Promise<void> => {
    if (!available()) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      let pushes = 0;
      for (const candidate of deps.store.candidates()) {
        const { id, schedule_version: version } = candidate;
        if (!available() || pushes >= 10) return;
        try {
          let watch = await deps.service.check(id);
          if (!available()) return;
          let notice = deps.store.get(id, version);
          const outdated = version !== (watch.schedule_version ?? 0);
          let authorized: (() => void) | undefined;
          if (!notice && (watch.state !== 'draft_ready' || deps.isQuiet(now()))) continue;
          if (watch.state === 'draft_ready' && !outdated) {
            authorized = await deps.validateDraft(watch);
            if (!available() || deps.isQuiet(now())) continue;
            notice = notice ?? deps.store.ensure(watch, now());
          }
          if (!notice) continue;
          if (notice.history_revision !== watch.revision && !await record(watch, notice)) continue;
          if (outdated || watch.state !== 'draft_ready' || notice.claimed_at !== null || !available() || deps.isQuiet(now())) continue;
          // Audit persistence and draft authorization yield. Recheck the exact
          // conversation before claiming this alert, then fence the claim on its revision.
          watch = await deps.service.check(id);
          if (!available()) return;
          if (watch.state !== 'draft_ready' || (watch.schedule_version ?? 0) !== version) { await record(watch, notice); continue; }
          authorized?.();
          if (deps.isQuiet(now()) || !deps.store.claim(watch, now())) continue;
          const message = mailFollowUpAlertMessage(watch, deps.getPublicBaseUrl?.());
          const push = (async () => deps.notifier.notify(message, undefined, {
            persisted_activity_id: notice.activity_id, ui_link_url: mailFollowUpHref(watch.id, notice.draft_id, watch.schedule_version ?? 0),
          }))();
          pushes++; pushing = push;
          try { await push; } catch { /* History retains a failed best-effort push; never push it twice. */ }
          finally { pushing = undefined; }
        } catch { /* One unavailable watch or draft must not block other ready drafts. */ }
      }
    })().catch(() => { /* A locked/unavailable database is retried on the next tick. */ })
      .finally(() => { running = undefined; });
    return running;
  };
  return {
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void tick(), deps.intervalMs ?? 30_000); timer.unref?.(); void tick();
    },
    async stop() {
      stopped = true; if (timer) clearInterval(timer); timer = undefined;
      if (running) await settleWithin(running, pushing ? PUSH_GRACE_MS : STOP_GRACE_MS);
    },
  };
};
