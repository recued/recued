/** D-324 — reminders ring on the minute, built in: nothing to switch on.
 *
 *  ⛔ NOT A RECIPE. D-193's `reminder-due-notifier` was a hidden auto-run recipe,
 *  and since D-319 ("installing starts nothing") a recipe that runs on its own
 *  needs a dish switched on, which no screen offered for a hidden one: a reminder
 *  was saved and never rang (D-324 §2.1). This is a server service, the shape of
 *  Reception's customer reminders: every minute, and once at start, each pending
 *  reminder whose time has come is sent.
 *
 *  ⚠ AT LEAST ONCE, NOT AT MOST ONCE. The try is counted before the send and the
 *  reminder is marked delivered after it, once a channel took it. Two ticks never
 *  both send (one runs at a time, and a cancel in between stops the send), but a
 *  crash between the send and the mark sends it once more on restart. That is
 *  the right way round for a reminder: once more beats never.
 *
 *  ⚠ EVERY CHANNEL FAILING LEAVES IT PENDING, and the next minute tries again,
 *  least recently tried first (D-193's rule, kept): the store orders the due list
 *  so one reminder that cannot be delivered does not hold up the rest.
 *
 *  ⛔ A STOP DOES NOT WAIT FOR THE SENDS (`stop`). A check sends up to 50
 *  reminders one after another, each through every channel — 30 s a messenger,
 *  30 to 120 s an email — and a drain step has 5 s, while the process exits
 *  right after the drain anyway. The same at-least-once rule makes it safe: a
 *  reminder is marked delivered only after a channel took it, so the one being
 *  sent and every one after it stay pending, and the first check after the
 *  restart (`fireImmediate`) sends them. */

import {
  REMINDER_HISTORY_MS,
  REMINDER_LIST_LINK,
  reminderDeliveryText,
} from '@recued/contracts';

import { releasedAtStop, settleWithin, STOP_GRACE_MS } from '../lifecycle/settle-within.js';
import type { ReminderStore } from '../storage/reminder-store.js';

/** How often the service checks. A reminder rings at most this late. */
export const REMINDER_DELIVERY_INTERVAL_MS = 60_000;

/** The most reminders one check sends. The rest wait a minute. */
export const REMINDER_DELIVERY_BATCH = 50;

export interface ReminderMessage {
  title: string;
  text: string;
  link_url?: string;
  ui_link_url: string;
}

export interface ReminderDeliveryDeps {
  store: ReminderStore;
  /** Sends one reminder on every channel the owner set up, and says which took it. */
  send: (message: ReminderMessage) => Promise<{ delivered_to: readonly string[] }>;
  /** D-269 — is the owner's quiet window active at `at`? Held reminders wait for
   *  the window to end and then ring, saying which time they were for. */
  isQuiet: (at: number) => boolean;
  /** R21.1 — false while the vault is sealed: the channels that need the
   *  owner's credentials cannot send, so the check waits as the executors do,
   *  and rings once it is unlocked. Absent ⇒ always ready. */
  isVaultUnlocked?: () => boolean;
  publicBaseUrl?: () => string | null;
  now?: () => number;
}

export interface ReminderDeliveryResult {
  /** Reminders whose time had come. */
  due: number;
  delivered: number;
  /** Tried, and no channel took it: still pending. */
  failed: number;
  /** Held by quiet hours or a sealed vault: still pending. */
  held: number;
  /** Old history dropped. */
  pruned: number;
}

export interface ReminderDelivery {
  /** One check. Settles when it is done, or within `STOP_GRACE_MS` of `stop`
   *  — whichever is first — so the timer that runs it does not hold a drain
   *  that also calls `stop`. */
  tick(): Promise<ReminderDeliveryResult>;
  /** Start no further check and no further send, and wait for the send in
   *  progress at most `STOP_GRACE_MS`. Idempotent. */
  stop(): Promise<void>;
}

export const createReminderDelivery = (deps: ReminderDeliveryDeps): ReminderDelivery => {
  const now = deps.now ?? Date.now;
  let running: Promise<ReminderDeliveryResult> | undefined;
  const stopping = new AbortController();

  const check = async (result: ReminderDeliveryResult): Promise<ReminderDeliveryResult> => {
    const current = now();
    result.pruned = deps.store.prune(current - REMINDER_HISTORY_MS);
    const due = deps.store.listDue(current, REMINDER_DELIVERY_BATCH);
    result.due = due.length;
    if (due.length === 0) return result;
    if (deps.isQuiet(current) || deps.isVaultUnlocked?.() === false) {
      result.held = due.length;
      return result;
    }
    for (const reminder of due) {
      // A stop sends nothing more: the rest stay pending (the module header).
      if (stopping.signal.aborted) break;
      // False when it was cancelled since the list was read: not sent.
      if (!deps.store.recordAttempt(reminder.reminder_id, current)) continue;
      let delivered_to: readonly string[] = [];
      try {
        const baseUrl = deps.publicBaseUrl?.();
        ({ delivered_to } = await deps.send({
          title: 'Reminder',
          text: reminderDeliveryText(reminder, current),
          ...(baseUrl ? { link_url: `${baseUrl.replace(/\/$/, '')}/${REMINDER_LIST_LINK}` } : {}),
          ui_link_url: REMINDER_LIST_LINK,
        }));
      } catch {
        delivered_to = [];
      }
      // A send that ends after a stop is still marked here when the store is
      // open; when it is not, the reminder stays pending and rings once more
      // after the restart — the at-least-once rule.
      if (delivered_to.length > 0 && deps.store.markDelivered(reminder.reminder_id, now(), delivered_to)) {
        result.delivered += 1;
      } else {
        result.failed += 1;
      }
    }
    return result;
  };

  return {
    tick() {
      const result: ReminderDeliveryResult = { due: 0, delivered: 0, failed: 0, held: 0, pruned: 0 };
      // One check at a time: an interval can fire while a slow channel is still
      // sending, and two checks would read the same due reminders.
      if (running !== undefined || stopping.signal.aborted) return Promise.resolve(result);
      const work: Promise<ReminderDeliveryResult> = check(result).finally(() => {
        if (running === work) running = undefined;
      });
      running = work;
      // Released at a stop: the interval that runs this waits for what it
      // returns, inside the same drain step as `stop`. The check itself goes
      // on, and what it finds after the release is still counted in `result`.
      return releasedAtStop(work, stopping.signal, result);
    },
    async stop() {
      stopping.abort();
      if (running !== undefined) await settleWithin(running, STOP_GRACE_MS);
    },
  };
};
