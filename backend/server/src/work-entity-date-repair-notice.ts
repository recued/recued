/** Telling the owner about the text-dates repair
 *  (`WORK_ENTITY_TEXT_DATES_REPAIR_ID`, `storage/work-entity-store.ts`).
 *
 *  The repair itself runs where the store opens, before anything can write — an
 *  update of a record still holding a text date would be refused. This is the
 *  half that needs the notifier: once, at boot, in D-308's order — the history
 *  row under a fixed id, then the ledger's `noticed_at`, then the live push,
 *  best-effort. A crash before `noticed_at` re-delivers at the next boot. */

import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';

import type { DataRepairLedger } from './storage/data-repair-ledger.js';
import {
  WORK_ENTITY_TEXT_DATES_REPAIR_ID,
  type WorkEntityTextDateFix,
  type WorkEntityTextDatesSummary,
} from './storage/work-entity-store.js';

/** What the owner calls each date. */
const DATE_NAME: Readonly<Record<string, string>> = {
  due_at: 'task due date',
  completed_at: 'task completion date',
  promised_for_at: 'promise date',
  promised_at: 'date a promise was made',
  target_completion_at: 'project target date',
  slot_start_at: 'booking start',
  slot_end_at: 'booking end',
};

const LISTED = 25;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "2 promise dates, 1 project target date" — what the repair touched, by name. */
const counted = (fixes: readonly WorkEntityTextDateFix[]): string => {
  const byName = new Map<string, number>();
  for (const fix of fixes) {
    const name = DATE_NAME[fix.field] ?? fix.field;
    byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  return [...byName].map(([name, n]) => plural(n, name)).join(', ');
};

/** The owner's notice, or null when the repair found nothing. */
export const workEntityTextDatesNotice = (
  summary: WorkEntityTextDatesSummary,
): NotificationMessage | null => {
  const { fixed, cleared } = summary;
  if (fixed.length === 0 && cleared.length === 0) return null;
  const parts: string[] = [];
  if (fixed.length > 0) {
    parts.push(
      `Some dates were saved as text, so Recued could not tell when they fell: ${counted(fixed)}. `
        + 'A promise saved that way never showed as due or overdue and never sent a reminder. '
        + 'Each now holds the date it named.',
    );
    if (fixed.some((fix) => fix.field === 'promised_for_at')) {
      parts.push('A promise whose date has already passed may now show as overdue.');
    }
  }
  if (cleared.length > 0) {
    parts.push(
      `${plural(cleared.length, 'date')} held text that names no date, so ${cleared.length === 1 ? 'it was' : 'they were'} `
        + 'removed. What each held:'
        + cleared.slice(0, LISTED)
          .map((fix) => `\n• ${DATE_NAME[fix.field] ?? fix.field} on ${fix.kind} ${fix.id}: “${fix.was}”`)
          .join('')
        + (cleared.length > LISTED ? `\n• …and ${cleared.length - LISTED} more` : ''),
    );
  }
  const total = fixed.length + cleared.length;
  return {
    title: cleared.length === 0
      ? `${plural(total, 'date')} saved as text ${total === 1 ? 'was' : 'were'} fixed`
      : `${plural(total, 'date')} saved as text ${total === 1 ? 'was' : 'were'} repaired`,
    text: parts.join('\n\n'),
  };
};

export interface WorkEntityTextDatesNoticeDeps {
  readonly ledger: Pick<DataRepairLedger, 'get' | 'markNoticed'>;
  readonly auditLog: Pick<AuditLogStore, 'logActivity'>;
  readonly notifier: Pick<NotificationBlock, 'notify'>;
  readonly now: () => number;
}

export interface WorkEntityTextDatesNoticeResult {
  readonly noticed: boolean;
  readonly fixed: number;
  readonly cleared: number;
}

/** Deliver the repair's notice once. Nothing to say, or already said: no-op. */
export const noticeWorkEntityTextDatesRepairAtBoot = async (
  deps: WorkEntityTextDatesNoticeDeps,
): Promise<WorkEntityTextDatesNoticeResult> => {
  const record = deps.ledger.get(WORK_ENTITY_TEXT_DATES_REPAIR_ID);
  if (record === null || record.noticed_at !== null) return { noticed: false, fixed: 0, cleared: 0 };
  const summary = record.summary as WorkEntityTextDatesSummary;
  const counts = { fixed: summary.fixed.length, cleared: summary.cleared.length };
  const message = workEntityTextDatesNotice(summary);
  if (message === null) {
    deps.ledger.markNoticed(WORK_ENTITY_TEXT_DATES_REPAIR_ID, deps.now());
    return { noticed: false, ...counts };
  }
  const persisted_activity_id = `data-repair:${WORK_ENTITY_TEXT_DATES_REPAIR_ID}`;
  await deps.auditLog.logActivity({
    activity_id: persisted_activity_id,
    timestamp: record.applied_at,
    action: 'notification_fired',
    target: WORK_ENTITY_TEXT_DATES_REPAIR_ID,
    detail: JSON.stringify(message),
  });
  deps.ledger.markNoticed(WORK_ENTITY_TEXT_DATES_REPAIR_ID, deps.now());
  await deps.notifier.notify(message, undefined, { persisted_activity_id }).catch(() => undefined);
  return { noticed: true, ...counts };
};
