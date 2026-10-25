import type Database from 'better-sqlite3';
import { type ConnectionRow, type HouseholdHomeAssistantSelection, type HouseholdTelegramSelection } from '@recued/contracts';
import type { AskDeliveryDestination } from '@recued/notification';

const savedObject = (row: { value: string } | undefined): Record<string, unknown> | null => {
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
};

/** A Telegram connection the household's reminders can be posted in: one bound to a
 * group chat, whose Telegram id is negative. D-325 §15.7 (2026-10-24) — the group only
 * receives, so neither the owner's account nor the members' are needed. */
export const telegramHouseholdRoute = (row: ConnectionRow): { recipient: string } | null => {
  if (row.kind !== 'notification' || (row.subtype ?? row.name) !== 'telegram') return null;
  try {
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    if (typeof config.chat_id === 'number' && !Number.isSafeInteger(config.chat_id)) return null;
    const recipient = typeof config.chat_id === 'number' ? String(config.chat_id) : config.chat_id;
    return typeof recipient === 'string' && /^-[1-9]\d{0,19}$/u.test(recipient) ? { recipient } : null;
  } catch { return null; }
};

/** Private owner configuration, separate from the owner's default notification
 * channel. No credentials and no mutable copy of an occurrence lifecycle. */
export const createHouseholdDeliveryStore = (db: Database.Database) => {
  db.exec('CREATE TABLE IF NOT EXISTS household_delivery_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  // D-325 §15.7 (2026-10-24) — the household only receives. What builds before kept for
  // answering from the group goes once: the Join invite, the names of people who
  // pressed it, and the owner and member ids in a saved selection.
  const saved = db.prepare("SELECT value FROM household_delivery_settings WHERE key='telegram'").get() as { value: string } | undefined;
  const previous = savedObject(saved);
  const stale = previous !== null && ['members', 'expected_sender'].some(key => Object.hasOwn(previous, key));
  if (stale || db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='household_telegram_people'").get()
    || db.prepare("SELECT 1 FROM household_delivery_settings WHERE key='telegram_invite'").get()) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS household_telegram_people');
      db.prepare("DELETE FROM household_delivery_settings WHERE key='telegram_invite'").run();
      if (stale) {
        const { connection_name, connection_enrolled_at, recipient, selected_at } = previous!;
        db.prepare("UPDATE household_delivery_settings SET value=? WHERE key='telegram'")
          .run(JSON.stringify({ connection_name, connection_enrolled_at, recipient, selected_at }));
      }
    })();
  }
  const telegram = (): HouseholdTelegramSelection | null => {
    const row = db.prepare("SELECT value FROM household_delivery_settings WHERE key='telegram'").get() as { value: string } | undefined;
    const value = savedObject(row);
    // Corrupt or partial settings must not fail the startup migration or turn
    // a partial selection into a delivery destination. Keep the saved bytes so
    // an explicit owner selection can repair them.
    if (!value || typeof value.connection_name !== 'string' || !value.connection_name.trim()
      || typeof value.connection_enrolled_at !== 'number' || !Number.isSafeInteger(value.connection_enrolled_at)
      || typeof value.selected_at !== 'number' || !Number.isSafeInteger(value.selected_at)
      || typeof value.recipient !== 'string' || !/^-[1-9]\d{0,19}$/u.test(value.recipient)) return null;
    return { connection_name: value.connection_name, connection_enrolled_at: value.connection_enrolled_at,
      recipient: value.recipient, selected_at: value.selected_at };
  };
  const matches = (selection: HouseholdTelegramSelection, row: ConnectionRow): boolean =>
    row.name === selection.connection_name && row.enrolled_at === selection.connection_enrolled_at
      && telegramHouseholdRoute(row)?.recipient === selection.recipient;
  return {
    telegram,
    homeAssistant(): HouseholdHomeAssistantSelection | null {
      const row = db.prepare("SELECT value FROM household_delivery_settings WHERE key='home_assistant'").get() as { value: string } | undefined;
      return row ? JSON.parse(row.value) : null;
    },
    setHomeAssistant(value: HouseholdHomeAssistantSelection | null): void {
      if (!value) { db.prepare("DELETE FROM household_delivery_settings WHERE key='home_assistant'").run(); return; }
      db.prepare("INSERT INTO household_delivery_settings(key,value) VALUES('home_assistant',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
    },
    setTelegram(row: ConnectionRow | null, at = Date.now()): HouseholdTelegramSelection | null {
      if (row === null) { db.prepare("DELETE FROM household_delivery_settings WHERE key='telegram'").run(); return null; }
      const route = telegramHouseholdRoute(row);
      if (!route || !Number.isSafeInteger(at) || !Number.isSafeInteger(row.enrolled_at)) throw new Error('Choose a Telegram connection bound to a group');
      const value: HouseholdTelegramSelection = { connection_name: row.name, connection_enrolled_at: row.enrolled_at, recipient: route.recipient, selected_at: at };
      db.prepare("INSERT INTO household_delivery_settings(key,value) VALUES('telegram',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
      return value;
    },
    isHousehold(row: Pick<ConnectionRow, 'name' | 'enrolled_at'>): boolean {
      const value = telegram(); return value?.connection_name === row.name && value.connection_enrolled_at === row.enrolled_at;
    },
    /** The group as a destination that only receives: posted without buttons, and
     * nothing sent back from it answers (D-325 §15.7, 2026-10-24). */
    destinations(connections: readonly ConnectionRow[]): AskDeliveryDestination[] {
      const selected = telegram(); if (!selected || !connections.some(row => matches(selected, row))) return [];
      return [{ id: `household:telegram:${encodeURIComponent(selected.connection_name)}:${selected.connection_enrolled_at}`, channel: 'telegram',
        connection_name: selected.connection_name, connection_enrolled_at: selected.connection_enrolled_at, recipient: selected.recipient,
        audience: 'household' }];
    },
  };
};
export type HouseholdDeliveryStore = ReturnType<typeof createHouseholdDeliveryStore>;
