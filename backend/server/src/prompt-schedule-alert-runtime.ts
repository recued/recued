import type { PromptSchedule } from '@recued/contracts';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';
import type Database from 'better-sqlite3';
import type { EventBus } from './events/bus.js';
import type { PromptSchedules } from './prompt-schedules.js';
import { PUSH_GRACE_MS, settleWithin, STOP_GRACE_MS } from './lifecycle/settle-within.js';
import { createPromptScheduleHealthStore, currentPromptQueueIssue, promptScheduleHealthStamp,
  promptScheduleNoticeId, type PromptScheduleFailureNotice, type PromptScheduleHealthSnapshot } from './prompt-schedule-health.js';

type FailureKind = PromptScheduleFailureNotice['episode_kind'];
const failed = (schedule: PromptSchedule): boolean => {
  const outcome = schedule.last_outcome;
  return outcome?.status === 'failed' || outcome?.status === 'interrupted'
    || outcome?.status === 'needs_attention' && outcome.reason === 'tool_failed';
};
export const promptScheduleFailureMessage = (
  notice: PromptScheduleFailureNotice, title?: string, publicBaseUrl?: string | null,
): { message: NotificationMessage; hash: string } => {
  const label = title?.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160);
  const subject = label ? `“${label}”` : 'A scheduled prompt';
  const hash = `#chat/session/${encodeURIComponent(notice.session_id)}`
    + (notice.episode_kind === 'run' && notice.plan_id ? `/plan/${encodeURIComponent(notice.plan_id)}`
      : notice.episode_kind === 'run' && notice.message_id ? `/answer/${encodeURIComponent(notice.message_id)}` : '');
  return { hash, message: { title: 'Scheduled prompt needs attention',
    text: notice.episode_kind === 'admission'
      ? `Recued could not confirm that ${label ? `“${label}”` : 'a scheduled prompt'} was queued. Open its conversation to review the schedule. Recued will check again while it is active.`
      : `${subject} reported a failure or an interrupted run. Open its conversation and check what completed before trying an action again.`,
    ...(publicBaseUrl ? { link_url: `${publicBaseUrl.replace(/\/+$/, '')}/${hash}` } : {}) } };
};

/** One passive worker, separate from clock admission. Persist history before
 * claiming one best-effort push per failure episode. Recovery is silent. */
export const createPromptScheduleAlertRuntime = (deps: {
  db: Database.Database;
  schedules: Pick<PromptSchedules, 'get' | 'isFailureCurrent'>;
  auditLog: Pick<AuditLogStore, 'logActivity'>;
  notifier: Pick<NotificationBlock, 'notify'>;
  events?: Pick<EventBus, 'subscribe' | 'unsubscribe'>;
  canRun?: () => boolean;
  isQuiet: (at: number) => boolean;
  getPublicBaseUrl?: () => string | null;
  now?: () => number;
  intervalMs?: number;
}) => {
  const state = createPromptScheduleHealthStore(deps.db), now = deps.now ?? Date.now;
  const seen = new Map<string, string>(), versions = new Map<string, number>(), checkedVersions = new Map<string, number>();
  let sessions = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined, pushing: Promise<void> | undefined;
  let stopped = false;
  const subscriber = {};
  const available = () => !stopped && deps.canRun?.() !== false;
  deps.events?.subscribe(subscriber, { kinds: ['chat.session_changed', 'chat.plan_proposed', 'chat.plan_resolved',
    'chat.tool_call_completed', 'chat.message_complete'] }, event => {
    if ('session_id' in event && sessions.has(event.session_id)) {
      versions.set(event.session_id, (versions.get(event.session_id) ?? 0) + 1);
    }
  });
  type Observation = { row: PromptScheduleHealthSnapshot; schedule?: PromptSchedule; kind?: FailureKind; recovered: boolean; failureKey?: string };
  const read = async (id: string): Promise<Observation | undefined> => {
    if (!available()) return;
    const row = state.get(id); if (!row) return;
    const queueIssue = currentPromptQueueIssue(row);
    const version = versions.get(row.session_id) ?? 0;
    let schedule: PromptSchedule | undefined;
    try {
      if (queueIssue || row.turn_id && ['completed', 'failed', 'interrupted'].includes(row.status ?? '')) {
        schedule = await deps.schedules.get(id);
      }
    }
    catch (error) {
      // A failed queue turn remains an observable failure even if its request
      // can no longer be decrypted. Never expose the error to a notification.
      if (!queueIssue && !state.unresolvedSignal(id, row.turn_id, false)
        && !['failed', 'interrupted'].includes(row.status ?? '')) throw error;
    }
    let olderFailure = state.unresolvedSignal(id, row.turn_id, schedule?.last_outcome?.status === 'finished');
    if (olderFailure && !await deps.schedules.isFailureCurrent(olderFailure)) olderFailure = undefined;
    if (!available()) return;
    const current = state.get(id);
    if (!current || promptScheduleHealthStamp(current) !== promptScheduleHealthStamp(row)
      || (versions.get(row.session_id) ?? 0) !== version) return;
    const runFailed = olderFailure || (schedule ? failed(schedule) : ['failed', 'interrupted'].includes(row.status ?? ''));
    return { row, ...(schedule ? { schedule } : {}),
      ...(queueIssue ? { kind: 'admission' as const } : runFailed ? { kind: 'run' as const } : {}),
      ...(olderFailure ? { failureKey: olderFailure.failure_key } : {}),
      recovered: !olderFailure && schedule?.last_outcome?.status === 'finished' };
  };
  const observe = (value: Observation): void => {
    if (!currentPromptQueueIssue(value.row)) state.resolve(value.row.schedule_id, 'admission');
    if (value.kind) state.open(value.row.schedule_id, value.kind, now());
    else if (value.recovered) state.resolve(value.row.schedule_id);
    if (value.failureKey) state.attachSignal(value.row.schedule_id, value.failureKey);
  };
  const tick = (): Promise<void> => {
    if (!available()) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      // One metadata read for the saved schedules (the service caps them at
      // 200). Decrypt outcomes only for changed rows or recorded Chat events.
      const rows = state.snapshot(), currentIds = new Set(rows.map(row => row.schedule_id));
      sessions = new Set(rows.map(row => row.session_id));
      for (const id of seen.keys()) if (!currentIds.has(id)) seen.delete(id);
      for (const id of versions.keys()) if (!sessions.has(id)) { versions.delete(id); checkedVersions.delete(id); }
      const observations = new Map<string, Observation>();
      for (const signal of state.unseen()) {
        if (!available()) return;
        let currentFailure = false;
        try {
          currentFailure = await deps.schedules.isFailureCurrent(signal);
          if (!available()) return;
          if (!currentFailure) { state.observeSignal(signal, now(), false, false); continue; }
          const value = await read(signal.schedule_id); if (!value || !available()) continue;
          observe(value);
          state.observeSignal(signal, now(), value.recovered, true);
        } catch {
          // A corrupt request must not trap later failure signals behind it.
          // Its already-recorded action failure can still get a generic notice.
          if (currentFailure && available()) try { state.observeSignal(signal, now(), false, true); } catch { /* Local storage remains unavailable. */ }
        }
      }
      for (const row of rows) {
        if (!available()) return;
        const stamp = promptScheduleHealthStamp(row), version = versions.get(row.session_id) ?? 0;
        if (seen.get(row.schedule_id) === stamp && checkedVersions.get(row.session_id) === version) continue;
        try {
          const value = await read(row.schedule_id); if (!value || !available()) continue;
          observe(value); observations.set(row.schedule_id, value);
          seen.set(row.schedule_id, stamp); checkedVersions.set(row.session_id, version);
        } catch { /* A corrupt request cannot prevent checking the next one. */ }
      }
      let delivered = 0;
      for (const notice of state.pending()) {
        if (!available()) return;
        if (notice.history_recorded && (deps.isQuiet(now()) || delivered >= 10)) continue;
        try {
          const value = observations.get(notice.schedule_id) ?? await read(notice.schedule_id);
          if (!value || !available()) continue;
          observe(value);
          if (!value.kind || value.kind !== notice.episode_kind) continue;
          const { message, hash } = promptScheduleFailureMessage(notice, value.schedule?.title, deps.getPublicBaseUrl?.());
          const activity_id = promptScheduleNoticeId(notice);
          if (!notice.history_recorded) {
            await deps.auditLog.logActivity({ activity_id, timestamp: notice.notice_at,
              action: 'notification_fired', target: notice.schedule_id, detail: JSON.stringify({ ...message, link_url: message.link_url ?? hash }) });
            if (!available() || !state.recordHistory(notice)) continue;
          }
          if (delivered >= 10 || deps.isQuiet(now()) || !available()) continue;
          // History may yield while the owner removes, pauses or fixes a run.
          // Read its current state again immediately before the atomic claim.
          const fresh = await read(notice.schedule_id); if (!fresh || !available()) continue;
          observe(fresh);
          if (!fresh.kind || fresh.kind !== notice.episode_kind || deps.isQuiet(now()) || !state.claim(notice, now())) continue;
          const currentMessage = promptScheduleFailureMessage(notice, fresh.schedule?.title, deps.getPublicBaseUrl?.());
          delivered += 1;
          const push = (async () => deps.notifier.notify(currentMessage.message, undefined,
            { persisted_activity_id: activity_id, ui_link_url: currentMessage.hash }))();
          pushing = push;
          try { await push; } catch { /* History is durable; a claimed push is not replayed. */ }
          finally { pushing = undefined; }
        } catch { /* Leave unclaimed history/delivery pending for another check. */ }
      }
    })().catch(() => { if (!stopped) console.warn('[scheduled prompt alerts] local state or history is unavailable; checking again later'); })
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
      deps.events?.unsubscribe(subscriber);
      if (running) await settleWithin(running, pushing ? PUSH_GRACE_MS : STOP_GRACE_MS);
    },
  };
};
