import type Database from 'better-sqlite3';
import { MESSENGER_PRINCIPAL_CONFIG_KEY, type ConnectionRow, type HouseholdTelegramSelection, type HouseholdHomeAssistantSelection } from '@recued/contracts';
import type { AskDeliveryDestination } from '@recued/notification';

export const telegramHouseholdRoute = (row: ConnectionRow): { recipient: string; expected_sender: string } | null => {
  if (row.kind !== 'notification' || (row.subtype ?? row.name) !== 'telegram') return null;
  try {
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    if (typeof config.chat_id === 'number' && !Number.isSafeInteger(config.chat_id)) return null;
    const recipient = typeof config.chat_id === 'number' ? String(config.chat_id) : config.chat_id;
    const principal = config[MESSENGER_PRINCIPAL_CONFIG_KEY];
    if (typeof recipient !== 'string' || !/^-[1-9]\d{0,19}$/u.test(recipient) || typeof principal !== 'string' || !/^[1-9]\d{0,19}$/u.test(principal)) return null;
    return { recipient, expected_sender: principal };
  } catch { return null; }
};

/** Private owner configuration, separate from the owner's default notification
 * channel. No credentials and no mutable copy of an occurrence lifecycle. */
export const createHouseholdDeliveryStore = (db: Database.Database) => {
  db.exec('CREATE TABLE IF NOT EXISTS household_delivery_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const telegram = (): HouseholdTelegramSelection | null => {
    const row = db.prepare("SELECT value FROM household_delivery_settings WHERE key='telegram'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  };
  const matches = (selection: HouseholdTelegramSelection, row: ConnectionRow): boolean => {
    const route = telegramHouseholdRoute(row);
    return row.name === selection.connection_name && row.enrolled_at === selection.connection_enrolled_at
      && route?.recipient === selection.recipient && route.expected_sender === selection.expected_sender;
  };
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
    setTelegram(row: ConnectionRow | null, members: readonly string[] = [], at = Date.now()): HouseholdTelegramSelection | null {
      if (row === null) { db.prepare("DELETE FROM household_delivery_settings WHERE key='telegram'").run(); return null; }
      const route = telegramHouseholdRoute(row); const normalized = [...new Set(members)].sort();
      if (!route || !Number.isSafeInteger(at) || !Number.isSafeInteger(row.enrolled_at) || normalized.length < 1 || normalized.length > 32 || normalized.some(id => typeof id !== 'string' || !/^[1-9]\d{0,19}$/u.test(id))
        || !normalized.includes(route.expected_sender)) throw new Error('Choose an enrolled Telegram group and up to 32 member ids, including its enrolled owner');
      const value: HouseholdTelegramSelection = { connection_name: row.name, connection_enrolled_at: row.enrolled_at, ...route, members: normalized, selected_at: at };
      db.prepare("INSERT INTO household_delivery_settings(key,value) VALUES('telegram',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
      return value;
    },
    isHousehold(row: Pick<ConnectionRow, 'name' | 'enrolled_at'>): boolean {
      const value = telegram(); return value?.connection_name === row.name && value.connection_enrolled_at === row.enrolled_at;
    },
    destinations(connections: readonly ConnectionRow[]): AskDeliveryDestination[] {
      const selected = telegram(); if (!selected || !connections.some(row => matches(selected, row))) return [];
      return [{ id: `household:telegram:${encodeURIComponent(selected.connection_name)}:${selected.connection_enrolled_at}`, channel: 'telegram',
        connection_name: selected.connection_name, connection_enrolled_at: selected.connection_enrolled_at, recipient: selected.recipient,
        expected_sender: selected.expected_sender, audience: 'household', allowed_senders: selected.members }];
    },
    permitsMember(destination: AskDeliveryDestination, sender: string, connections: readonly ConnectionRow[]): boolean {
      const selected = telegram(); return destination.audience === 'household' && destination.channel === 'telegram' && !!selected
        && selected.connection_name === destination.connection_name && selected.connection_enrolled_at === destination.connection_enrolled_at
        && selected.recipient === destination.recipient && selected.expected_sender === destination.expected_sender
        && selected.members.includes(sender) && destination.allowed_senders?.includes(sender) === true && connections.some(row => matches(selected, row));
    },
  };
};
export type HouseholdDeliveryStore = ReturnType<typeof createHouseholdDeliveryStore>;
