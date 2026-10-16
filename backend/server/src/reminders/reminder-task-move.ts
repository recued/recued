/** D-324 §6 — D-193's reminder tasks become reminders, once, at server start.
 *
 *  Until D-324 a reminder was a `data.task` row (`source_extension_blob.kind =
 *  recued_reminder`). Each one still open is handled once, and the handling is
 *  recorded so a later start does not repeat it:
 *
 *    - waiting (`reminder_pending`) on Recued's own tasks ⇒ copied to the
 *      reminders store, rung by the minute service (a time already passed rings
 *      at once, saying which time it was for), and the task closed;
 *    - rung already (`reminder_fired`) ⇒ the task closed;
 *    - kept in a vendor's tasks (Asana, Linear) ⇒ left alone: Recued does not
 *      close the owner's tasks there. Each is named once in the activity feed.
 *
 *  ⛔ CLOSED, NOT DELETED. Marking a task done can be undone; a delete cannot
 *  (D-324 §6). A moved task's state becomes `reminder_moved`, so D-193's watcher,
 *  which reads `reminder_pending` alone, never fires the old notifier for it.
 *
 *  ⚠ ONE SCAN PER START, A PAGE AT A TIME. Reminder tasks cannot be told apart
 *  by any list filter, so the scan reads every live task; nothing writes new
 *  ones once "Remind me" version 2 is installed.
 *
 *  ⛔ THE ORGANIZER PACK DOES NOT UPGRADE ITSELF AT BOOT. Personal Organizer
 *  Foundation is `bundled`, not `pre_install` (owner ruling 2026-09-07): the
 *  owner installs and updates it in Packs. Until they update it, "Remind me"
 *  stays at version 1 and writes reminder tasks, and one written after this
 *  start becomes a reminder only at the next start, so it rings late. */

import { RECUED_BUILTIN_SOURCE_ID, type Task } from '@recued/contracts';

import type { ReminderStore } from '../storage/reminder-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';

export interface ReminderTaskMoveDeps {
  workEntityStore: Pick<WorkEntityStore, 'listTasks' | 'writeTask'>;
  store: ReminderStore;
  /** The owner's zone, for the moved reminder's wording. */
  timeZone: () => string;
  /** Writes the one activity line naming what moved. */
  logActivity?: (entry: { activity_id: string; timestamp: number; action: 'reminders_moved'; target: string; detail: string }) => Promise<void>;
  now?: () => number;
}

export interface ReminderTaskMoveResult {
  moved: number;
  closed: number;
  /** Titles of the ones left in a vendor's tasks, newly found this start. */
  left_in_vendor: string[];
}

const PAGE = 500;
/** The titles the activity line names; the count says how many in all. */
const NAMED_MAX = 5;

const isReminderTask = (task: Task): boolean =>
  (task.source_extension_blob as { kind?: unknown } | undefined)?.kind === 'recued_reminder';

/** The reminder's own words: the body "Remind me" wrote, else the title without
 *  its "Reminder: " prefix. */
const reminderText = (task: Task): string => {
  const body = typeof task.body === 'string' ? task.body.trim() : '';
  if (body.length > 0) return body;
  const title = task.title.replace(/^Reminder:\s*/u, '').trim();
  return title.length > 0 ? title : task.title;
};

export const moveReminderTasks = async (deps: ReminderTaskMoveDeps): Promise<ReminderTaskMoveResult> => {
  const now = deps.now ?? Date.now;
  const result: ReminderTaskMoveResult = { moved: 0, closed: 0, left_in_vendor: [] };
  const found: Task[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = deps.workEntityStore.listTasks({ sync_states: ['live'], limit: PAGE, offset });
    for (const task of page) if (isReminderTask(task) && task.done !== true) found.push(task);
    if (page.length < PAGE) break;
  }

  const close = (task: Task, state: string | undefined, at: number): void => {
    deps.workEntityStore.writeTask({
      ...(task as unknown as Parameters<WorkEntityStore['writeTask']>[0]),
      done: true,
      completed_at: at,
      ...(state !== undefined ? { state } : {}),
    }, at);
  };

  for (const task of found) {
    const at = now();
    if (task.source_id !== RECUED_BUILTIN_SOURCE_ID('task')) {
      if (deps.store.recordTaskMove(task.id, 'left_in_vendor', at)) result.left_in_vendor.push(task.title);
      continue;
    }
    if (task.state === 'reminder_pending') {
      // A start that stopped between the copy and the close finishes the close.
      if (!deps.store.hasFromTask(task.id)) {
        if (typeof task.due_at !== 'number' || !Number.isFinite(task.due_at)) continue;
        deps.store.create({
          text: reminderText(task),
          at: task.due_at,
          time_zone: deps.timeZone(),
          origin: { recipe_id: 'remind-me-of' },
          from_task_id: task.id,
        }, at, { uncapped: true });
      }
      close(task, 'reminder_moved', at);
      deps.store.recordTaskMove(task.id, 'moved', at);
      result.moved += 1;
    } else if (task.state === 'reminder_fired') {
      close(task, undefined, at);
      deps.store.recordTaskMove(task.id, 'closed', at);
      result.closed += 1;
    }
  }

  if (deps.logActivity && (result.moved + result.closed + result.left_in_vendor.length) > 0) {
    const named = result.left_in_vendor.slice(0, NAMED_MAX).map((title) => `"${title}"`).join(', ');
    const more = result.left_in_vendor.length > NAMED_MAX ? ` and ${result.left_in_vendor.length - NAMED_MAX} more` : '';
    await deps.logActivity({
      activity_id: '',
      timestamp: now(),
      action: 'reminders_moved',
      target: 'reminders',
      detail: `moved=${result.moved} closed=${result.closed} left_in_vendor=${result.left_in_vendor.length}`
        + (named.length > 0 ? `: ${named}${more}` : ''),
    });
  }
  return result;
};
