/** D-324 — what the `core.reminder.*` ops do: set, list, change and cancel the
 *  owner's reminders.
 *
 *  Each answer carries the time worded on the owner's clock (`when`), because the
 *  caller is usually a model that will repeat it to the owner, and a time it has
 *  to convert is a time it can get wrong (D-324 P8: never UTC). A time inside
 *  quiet hours comes with the note saying when it will really ring (P1): the
 *  window holds a reminder like any notification, and the owner hears that at
 *  the moment they set it, not the next morning. */

import {
  REMINDER_PAST_GRACE_MS,
  REMINDER_TEXT_MAX,
  formatReminderWhen,
  resolveQuietHoursOccurrence,
  type QuietHoursPolicy,
  type Reminder,
  type ReminderCancelResult,
  type ReminderListResult,
  type ReminderOrigin,
  type ReminderUpdateResult,
  type ReminderView,
} from '@recued/contracts';

import type { ReminderStore } from '../storage/reminder-store.js';

/** A refusal the caller can act on: an empty text, a time that has passed. */
export class ReminderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderInputError';
  }
}

export interface ReminderServiceDeps {
  store: ReminderStore;
  /** The owner's zone, read per call: it can change while the server runs. */
  timeZone: () => string;
  /** The quiet-hours window, read per call. */
  quietHours: () => QuietHoursPolicy;
  now?: () => number;
}

export interface ReminderDispatchers {
  reminderCreate: (input: { text: string; at: number; origin?: ReminderOrigin }) => Promise<{
    reminder: ReminderView;
    when: string;
    /** Set when the time falls in quiet hours: when it will really ring. */
    quiet_hours_note?: string;
    /** `when`, and the quiet-hours note after it when there is one: the line a
     *  caller shows the owner. */
    confirmation: string;
  }>;
  reminderList: (input: { include_delivered?: boolean; limit?: number }) => Promise<ReminderListResult>;
  reminderUpdate: (input: { reminder_id: string; text?: string; at?: number }) => Promise<ReminderUpdateResult>;
  reminderCancel: (input: { reminder_id: string }) => Promise<ReminderCancelResult>;
}

const NOT_FOUND = 'No reminder has that id. My reminders lists the ones still to ring.';
const notPending = (reminder: Reminder, verb: string): string =>
  reminder.state === 'delivered'
    ? `Not ${verb}: that reminder has already rung.`
    : `Not ${verb}: that reminder was cancelled.`;

const LIST_DEFAULT = 50;
const LIST_MAX = 200;

export const createReminderDispatchers = (deps: ReminderServiceDeps): ReminderDispatchers => {
  const now = deps.now ?? Date.now;

  const view = (reminder: Reminder, at: number): ReminderView => ({
    reminder_id: reminder.reminder_id,
    text: reminder.text,
    at: reminder.at,
    when: formatReminderWhen(reminder.at, reminder.time_zone ?? deps.timeZone(), at),
    state: reminder.state,
    delivered_at: reminder.delivered_at,
    time_zone: reminder.time_zone,
  });

  const cleanText = (raw: string): string => {
    const text = raw.replace(/\s+/gu, ' ').trim();
    if (text.length === 0) throw new ReminderInputError('A reminder needs words to say.');
    if (text.length > REMINDER_TEXT_MAX) {
      throw new ReminderInputError(
        `A reminder is at most ${REMINDER_TEXT_MAX} characters; this one is ${text.length}.`,
      );
    }
    return text;
  };

  const checkTime = (at: number, current: number, zone: string): void => {
    if (!Number.isFinite(at)) throw new ReminderInputError('A reminder needs a time.');
    if (at < current - REMINDER_PAST_GRACE_MS) {
      throw new ReminderInputError(
        `That time has passed: ${formatReminderWhen(at, zone, current)}. Pick a time still to come.`,
      );
    }
  };

  /** ⛔ The window holds a reminder (D-269 REV 15: one master silencer, no kind
   *  exempt), so the owner is told at once when it will come instead. */
  const quietNote = (at: number, zone: string, current: number): string | undefined => {
    const policy = deps.quietHours();
    if (!policy.enabled || !policy.applies_to.includes('notification')) return undefined;
    const occurrence = resolveQuietHoursOccurrence(policy, zone, at);
    if (occurrence === null || !occurrence.active) return undefined;
    return `That's in your quiet hours, so it will come ${formatReminderWhen(occurrence.end, zone, current)}.`;
  };

  return {
    reminderCreate: async (input) => {
      const current = now();
      const zone = deps.timeZone();
      const text = cleanText(input.text);
      checkTime(input.at, current, zone);
      const reminder = deps.store.create(
        { text, at: input.at, time_zone: zone, origin: input.origin ?? {} },
        current,
      );
      const shown = view(reminder, current);
      const note = quietNote(reminder.at, zone, current);
      return {
        reminder: shown,
        when: shown.when,
        ...(note !== undefined ? { quiet_hours_note: note } : {}),
        confirmation: note !== undefined ? `${shown.when}. ${note}` : shown.when,
      };
    },

    reminderList: async (input) => {
      const current = now();
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? LIST_DEFAULT), 1), LIST_MAX);
      const reminders = deps.store.listPending(limit).map((r) => view(r, current));
      return {
        reminders,
        count: deps.store.countPending(),
        ...(input.include_delivered === true
          ? { delivered: deps.store.listHistory(limit).map((r) => view(r, current)) }
          : {}),
      };
    },

    reminderUpdate: async (input) => {
      const current = now();
      const existing = deps.store.get(input.reminder_id);
      if (existing === null) return { updated: false, reason: 'not_found', message: NOT_FOUND };
      if (existing.state !== 'pending') {
        return {
          updated: false, reason: 'not_pending', reminder: view(existing, current),
          message: notPending(existing, 'changed'),
        };
      }
      const zone = existing.time_zone ?? deps.timeZone();
      const patch: { text?: string; at?: number } = {};
      if (input.text !== undefined) patch.text = cleanText(input.text);
      if (input.at !== undefined) {
        checkTime(input.at, current, zone);
        patch.at = input.at;
      }
      const updated = deps.store.update(input.reminder_id, patch, current);
      if (updated === null) {
        // Rung or cancelled between the read and the write.
        const now_ = deps.store.get(input.reminder_id);
        return {
          updated: false, reason: 'not_pending',
          message: now_ !== null ? notPending(now_, 'changed') : NOT_FOUND,
        };
      }
      const shown = view(updated, current);
      const note = quietNote(updated.at, zone, current);
      return {
        updated: true, reminder: shown, when: shown.when,
        ...(note !== undefined ? { quiet_hours_note: note } : {}),
        message: `Changed: ${shown.when}${note !== undefined ? `. ${note}` : '.'}`,
      };
    },

    reminderCancel: async (input) => {
      const current = now();
      const existing = deps.store.get(input.reminder_id);
      if (existing === null) return { cancelled: false, reason: 'not_found', message: NOT_FOUND };
      const cancelled = deps.store.cancel(input.reminder_id, current);
      if (cancelled === null) {
        const now_ = deps.store.get(input.reminder_id) ?? existing;
        return {
          cancelled: false, reason: 'not_pending', reminder: view(now_, current),
          message: now_.state === 'cancelled' ? 'That reminder was already cancelled.' : notPending(now_, 'cancelled'),
        };
      }
      return { cancelled: true, reminder: view(cancelled, current), message: 'Cancelled: it will not ring.' };
    },
  };
};
