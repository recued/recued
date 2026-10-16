/** D-324 — the reminder wiring: the `core.reminder.*` dispatchers the kernel
 *  adapter calls, and the minute service that rings them.
 *
 *  Both read the owner's zone and quiet hours per call, not once: the owner can
 *  change either while the server runs, and a reminder set after the change must
 *  be worded and held by the new one. */

import type Database from 'better-sqlite3';
import { resolveServerTimeZone, shouldSuppressForQuietHours } from '@recued/contracts';

import { handleNotificationSend, type NotificationDeps } from '../../notification-handler.js';
import {
  REMINDER_DELIVERY_INTERVAL_MS,
  createReminderDelivery,
  type ReminderDelivery,
} from '../../reminders/reminder-delivery.js';
import { createReminderDispatchers, type ReminderDispatchers } from '../../reminders/reminder-service.js';
import { moveReminderTasks, type ReminderTaskMoveDeps } from '../../reminders/reminder-task-move.js';
import { createQuietHoursStore, type QuietHoursStore } from '../../storage/quiet-hours-store.js';
import { createReminderStore } from '../../storage/reminder-store.js';
import { createServerTimeZoneStore, type ServerTimeZoneStore } from '../../storage/server-timezone-store.js';
import type { BackgroundServiceRegistry } from './wire-background-services.js';

export interface ReminderWiringDeps {
  db: Database.Database;
  /** Absent ⇒ read from `db`, as Reception's reminders read them. */
  serverTimeZoneStore?: Pick<ServerTimeZoneStore, 'read'>;
  quietHoursStore?: Pick<QuietHoursStore, 'read'>;
  now?: () => number;
}

const ownerZone = (store: Pick<ServerTimeZoneStore, 'read'>): string =>
  resolveServerTimeZone(store.read(), Intl.DateTimeFormat().resolvedOptions().timeZone);

const settingsOf = (deps: ReminderWiringDeps): {
  zone: Pick<ServerTimeZoneStore, 'read'>;
  quiet: Pick<QuietHoursStore, 'read'>;
} => ({
  zone: deps.serverTimeZoneStore ?? createServerTimeZoneStore(deps.db),
  quiet: deps.quietHoursStore ?? createQuietHoursStore(deps.db),
});

/** The `core.reminder.*` dispatchers. */
export const wireReminderDispatchers = (deps: ReminderWiringDeps): ReminderDispatchers => {
  const { zone, quiet } = settingsOf(deps);
  return createReminderDispatchers({
    store: createReminderStore(deps.db),
    timeZone: () => ownerZone(zone),
    quietHours: () => quiet.read(),
    ...(deps.now ? { now: deps.now } : {}),
  });
};

/** The minute service. It sends the way `core.notification.send` does, through
 *  the same channel dispatchers, so a reminder reaches the owner where the
 *  notifier's reminders did: every channel they set up, in-app always.
 *
 *  D-324 §6 — given the task store, it first moves D-193's reminder tasks into
 *  the reminders store, so the first tick rings them. ⚠ A move that fails is
 *  logged and the service starts anyway: a reminder set from now on must not
 *  wait on an old one. */
export const wireReminderDelivery = async (
  deps: ReminderWiringDeps & {
    registry: Pick<BackgroundServiceRegistry, 'registerInterval'>;
    notification: NotificationDeps;
    isVaultUnlocked?: () => boolean;
    workEntityStore?: ReminderTaskMoveDeps['workEntityStore'];
    logActivity?: ReminderTaskMoveDeps['logActivity'];
  },
): Promise<ReminderDelivery> => {
  const { zone, quiet } = settingsOf(deps);
  if (deps.workEntityStore) {
    try {
      await moveReminderTasks({
        workEntityStore: deps.workEntityStore,
        store: createReminderStore(deps.db),
        timeZone: () => ownerZone(zone),
        ...(deps.logActivity ? { logActivity: deps.logActivity } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
    } catch (err) {
      console.warn('[reminders] moving the reminder tasks failed; they stay tasks until the next start', err);
    }
  }
  const delivery = createReminderDelivery({
    store: createReminderStore(deps.db),
    send: (message) => handleNotificationSend(deps.notification, message),
    isQuiet: (at) => shouldSuppressForQuietHours({
      policy: quiet.read(),
      instant: at,
      timeZone: ownerZone(zone),
    }),
    ...(deps.isVaultUnlocked ? { isVaultUnlocked: deps.isVaultUnlocked } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  deps.registry.registerInterval({
    name: 'reminders',
    intervalMs: REMINDER_DELIVERY_INTERVAL_MS,
    // A restart rings what came due while the server was off at once, not a
    // minute later.
    fireImmediate: true,
    tick: async () => {
      await delivery.tick();
    },
  });
  return delivery;
};
