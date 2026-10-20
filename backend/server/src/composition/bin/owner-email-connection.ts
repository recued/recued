import type Database from 'better-sqlite3';
import type { ConnectionRow } from '@recued/contracts';
import { createNotificationSettingsStore, type NotificationSettings } from '@recued/notification';
import { createSQLiteCollection } from '../../sqlite-collection.js';
import { selectOwnerNotificationConnection } from '../../situations/reminder-destinations.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import { createHouseholdDeliveryStore } from '../../storage/household-delivery-store.js';

/** The connection a plain notify or ask on `channel` (email, Slack, Telegram or
 * another chat channel) goes through, and an answer to one is checked against:
 * the one the owner chose for the channel, else the only one enrolled, else the
 * one named after the channel, which plain asks always used (D-158 amendments
 * 2026-10-19 for email, 2026-10-20 for the chat channels). Read per call, so a new
 * choice or enrollment applies at once. */
export const createOwnerNotificationConnection = (db: Database.Database, connections: Pick<ConnectionStoreSqlite, 'list' | 'get'>, channel: string) =>
  async (): Promise<ConnectionRow | { reason: string }> => {
    const listed = typeof connections.list === 'function' ? connections.list({ kind: 'notification' })
      : [connections.get('notification', channel)].filter((row): row is ConnectionRow => row !== null);
    const rows = listed.filter(row => row.subtype === channel || (!row.subtype && row.name === channel));
    if (!rows.length) return { reason: 'NO_CONNECTION_BOUND' };
    return selectOwnerNotificationConnection({
      settings: await createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')).get(),
      channel, rows, isHousehold: row => createHouseholdDeliveryStore(db).isHousehold(row), fallbackName: channel,
    });
  };

/** The email connection a plain notify or ask goes through. */
export const createOwnerEmailConnection = (db: Database.Database, connections: Pick<ConnectionStoreSqlite, 'list' | 'get'>) =>
  createOwnerNotificationConnection(db, connections, 'email');

/** What the owner sees when no email connection can carry a plain notification. */
export const ownerEmailConnectionProblem = (reason: string): string => ({
  NOTIFICATION_CONNECTION_CHOICE_REQUIRED: 'Several email connections are enrolled. Choose the one notifications use in Settings → Approval & notifications.',
  NOTIFICATION_CONNECTION_MISSING: 'The email connection chosen for notifications is no longer enrolled. Choose another in Settings → Approval & notifications.',
  NOTIFICATION_CONNECTION_OFF: 'Email notifications have no connection chosen. Choose one in Settings → Approval & notifications.',
  NOTIFICATION_CONNECTION_IS_HOUSEHOLD: 'The email connection chosen for notifications is a household one. Choose your own in Settings → Approval & notifications.',
} as Record<string, string>)[reason] ?? 'No email connection can carry notifications. Add one in Settings → Connections.';
