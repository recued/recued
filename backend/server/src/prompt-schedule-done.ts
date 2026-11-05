/** D-338 slice 2 — a scheduled prompt that notifies when it is done.
 *
 *  A scheduled prompt's answer used to stay in its conversation; only a failure was pushed, and the
 *  failure notice carries no result (`prompt-schedule-health.ts`). With "Notify me when it's done"
 *  on, a run that finished sends its answer to the owner's notification channels: the schedule's
 *  title, the answer (cut at {@link DONE_TEXT_MAX_CHARS}) and a link to it in its conversation. On a
 *  messenger the owner chats with Recued on, that is a notice they can quote (D-338 slice 1).
 *
 *  - Once per run, claimed before the push, never replayed: a push that fails is not sent again.
 *  - Only runs due since notifying was turned on (`chat_prompt_done_watch.since`), and never a Run
 *    now, which the owner started in the app and is watching.
 *  - Quiet hours hold it; a sealed vault or a paused server checks nothing.
 *  - The audit trail records that it went, and where it links; the answer stays in the encrypted
 *    conversation, as a failure notice's request and results do.
 *  - A schedule's owner may hold or drop a run's notice (`gate`): the Agenda's suggestions say
 *    nothing on a day the Agenda itself sent nothing.
 *
 *  Spec: D-338 § 4. */
import type Database from 'better-sqlite3';
import type { ChatMessage, PromptSchedule } from '@recued/contracts';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';
import type { PromptSchedules } from './prompt-schedules.js';
import { PUSH_GRACE_MS, settleWithin, STOP_GRACE_MS } from './lifecycle/settle-within.js';

/** Which schedules notify, from when; and which runs have had their notice. */
export const ensurePromptScheduleDoneTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_prompt_done_watch (
      schedule_id TEXT PRIMARY KEY REFERENCES chat_prompt_schedules(schedule_id) ON DELETE CASCADE,
      since INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_prompt_done_notices (
      schedule_id TEXT NOT NULL REFERENCES chat_prompt_schedules(schedule_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (schedule_id, turn_id)
    );
  `);
};

/** How much of an answer a notice carries; the rest is a tap away. */
export const DONE_TEXT_MAX_CHARS = 1_500;

export const promptScheduleDoneMessage = (
  schedule: Pick<PromptSchedule, 'title' | 'session_id'>,
  answer: Pick<ChatMessage, 'id' | 'content'>,
  publicBaseUrl?: string | null,
): { message: NotificationMessage; hash: string } => {
  const title = schedule.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || 'Scheduled prompt';
  const chars = Array.from(answer.content.trim());
  const text = chars.length > DONE_TEXT_MAX_CHARS
    ? `${chars.slice(0, DONE_TEXT_MAX_CHARS).join('')}…\n\nOpen the conversation for the rest.`
    : chars.join('');
  const hash = `#chat/session/${encodeURIComponent(schedule.session_id)}/answer/${encodeURIComponent(answer.id)}`;
  return { hash, message: { title, text,
    ...(publicBaseUrl ? { link_url: `${publicBaseUrl.replace(/\/+$/, '')}/${hash}` } : {}) } };
};

/** What a schedule's owner says of one finished run: send it, wait, or let it go unsent. */
export type PromptScheduleDoneGate = (schedule: PromptSchedule, run: { due_at: number }) => 'notify' | 'wait' | 'skip';

export const createPromptScheduleDoneRuntime = (deps: {
  db: Database.Database;
  schedules: Pick<PromptSchedules, 'get'>;
  /** The run's answer, from its conversation. */
  readAnswer: (session_id: string, message_id: string) => Promise<ChatMessage | undefined>;
  auditLog: Pick<AuditLogStore, 'logActivity'>;
  notifier: Pick<NotificationBlock, 'notify'>;
  canRun?: () => boolean;
  isQuiet: (at: number) => boolean;
  getPublicBaseUrl?: () => string | null;
  gate?: PromptScheduleDoneGate;
  now?: () => number;
  intervalMs?: number;
}) => {
  ensurePromptScheduleDoneTables(deps.db);
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined, pushing: Promise<void> | undefined;
  let stopped = false;
  const available = () => !stopped && deps.canRun?.() !== false;
  const watched = deps.db.prepare('SELECT schedule_id, since FROM chat_prompt_done_watch ORDER BY schedule_id');
  const runOf = deps.db.prepare('SELECT occurrence_id, due_at FROM chat_prompt_occurrences WHERE schedule_id=? AND turn_id=?');
  const noticed = deps.db.prepare('SELECT 1 FROM chat_prompt_done_notices WHERE schedule_id=? AND turn_id=?');
  const claim = deps.db.prepare('INSERT OR IGNORE INTO chat_prompt_done_notices (schedule_id, turn_id, outcome, at) VALUES (?, ?, ?, ?)');

  const tick = (): Promise<void> => {
    if (!available()) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      let delivered = 0;
      for (const { schedule_id, since } of watched.all() as Array<{ schedule_id: string; since: number }>) {
        if (!available() || delivered >= 10) return;
        try {
          const schedule = await deps.schedules.get(schedule_id);
          const outcome = schedule.last_outcome, turn = schedule.last_turn_id;
          if (schedule.notify_on_done !== true || outcome?.status !== 'finished' || !turn || !outcome.message_id) continue;
          if (noticed.get(schedule_id, turn)) continue;
          const run = runOf.get(schedule_id, turn) as { occurrence_id: string; due_at: number } | undefined;
          // A run due at or before the moment notifying was turned on was not asked to notify.
          if (!run || run.due_at <= since || run.occurrence_id.startsWith(`${schedule_id}:manual:`)) continue;
          const verdict = deps.gate?.(schedule, run) ?? 'notify';
          if (verdict === 'wait') continue;
          if (verdict === 'skip') { claim.run(schedule_id, turn, 'skipped', now()); continue; }
          if (deps.isQuiet(now())) continue;
          const answer = await deps.readAnswer(schedule.session_id, outcome.message_id);
          if (!answer || answer.role !== 'assistant' || !answer.content.trim() || !available()) continue;
          // Claimed before the push: a run's notice goes at most once, a failed push included.
          if (claim.run(schedule_id, turn, 'sent', now()).changes !== 1) continue;
          const { message, hash } = promptScheduleDoneMessage(schedule, answer, deps.getPublicBaseUrl?.());
          const activity_id = `prompt-done:${schedule_id}:${turn}`;
          try {
            await deps.auditLog.logActivity({ activity_id, timestamp: now(), action: 'notification_fired', target: schedule_id,
              detail: JSON.stringify({ title: message.title, link_url: message.link_url ?? hash }) });
          } catch { /* The notice still goes; only its history entry is missing. */ }
          delivered += 1;
          const push = (async () => deps.notifier.notify(message, undefined, { persisted_activity_id: activity_id, ui_link_url: hash }))();
          pushing = push;
          try { await push; } catch { /* Claimed: a failed push is not sent again. */ }
          finally { pushing = undefined; }
        } catch { /* One schedule that cannot be read must not hold up the next. */ }
      }
    })().catch(() => { if (!stopped) console.warn('[scheduled prompt done notices] local state is unavailable; checking again later'); })
      .finally(() => { running = undefined; });
    return running;
  };
  return {
    tick,
    start(): void {
      if (timer || stopped) return;
      timer = setInterval(() => { void tick(); }, deps.intervalMs ?? 60_000); timer.unref(); void tick();
    },
    async stop(): Promise<void> {
      stopped = true; if (timer) clearInterval(timer); timer = undefined;
      if (running) await settleWithin(running, pushing ? PUSH_GRACE_MS : STOP_GRACE_MS);
    },
  };
};
