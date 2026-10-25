/** D-325 §15.7 (2026-10-24) — the household only receives: its Telegram group is any
 *  connection bound to a group chat, and what builds before kept for answering from the
 *  group is dropped once. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import { createHouseholdDeliveryStore, telegramHouseholdRoute } from '../storage/household-delivery-store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const open = () => { const db = new Database(':memory:'); databases.push(db); return db; };
// As the app enrols a Telegram connection: a chat id and no principal (only Teams resolves one, D-238).
const row = (name: string, chat_id: string | number, extra: Record<string, unknown> = {}): ConnectionRow => ({ pk: `notification:${name}`,
  name, kind: 'notification', subtype: 'telegram', display_name: name, enrolled_at: 200, updated_at: 200,
  config_json: JSON.stringify({ ingress_mode: 'poll', chat_id, ...extra }), auth_ciphertext: 'never-read-here' });

describe('D-325 household delivery store — the group only receives', () => {
  it.each(['{', 'null', '[]', '"old selection"', 'false', '{"connection_name":"family"}'])('keeps invalid saved Telegram settings unavailable without failing startup: %s', value => {
    const db = open(); db.exec('CREATE TABLE household_delivery_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare("INSERT INTO household_delivery_settings VALUES('telegram',?)").run(value);
    const store = createHouseholdDeliveryStore(db);
    expect(store.telegram()).toBeNull(); expect(store.destinations([row('family', '-100123')])).toEqual([]);
    expect(store.isHousehold(row('family', '-100123'))).toBe(false);
    expect((db.prepare("SELECT value FROM household_delivery_settings WHERE key='telegram'").get() as { value: string }).value).toBe(value);
    // The owner can recover by explicitly selecting a valid group.
    expect(store.setTelegram(row('family', '-100123'), 10)?.recipient).toBe('-100123');
  });

  it('takes any Telegram connection bound to a group chat, with no principal, and nothing else', () => {
    expect(telegramHouseholdRoute(row('family', '-1001234567890'))).toEqual({ recipient: '-1001234567890' });
    expect(telegramHouseholdRoute(row('family', -100123))).toEqual({ recipient: '-100123' });
    // The owner's own chat is not a group, and another vendor is not Telegram.
    expect(telegramHouseholdRoute(row('own', '123456789'))).toBeNull();
    expect(telegramHouseholdRoute({ ...row('slack', '-100123'), subtype: 'slack' })).toBeNull();
    const store = createHouseholdDeliveryStore(open());
    expect(() => store.setTelegram(row('own', '123456789'), 1)).toThrow('Choose a Telegram connection bound to a group');
  });

  it('posts to the chosen group as a destination that names no one who may answer', () => {
    const store = createHouseholdDeliveryStore(open()); const family = row('family', '-100123');
    expect(store.setTelegram(family, 1)).toEqual({ connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', selected_at: 1 });
    expect(store.destinations([family])).toEqual([{ id: 'household:telegram:family:200', channel: 'telegram',
      connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', audience: 'household' }]);
    expect(store.isHousehold(family)).toBe(true);
    // A re-enrolled or re-pointed connection is not the group that was chosen.
    expect(store.destinations([{ ...family, enrolled_at: 201 }])).toEqual([]);
    expect(store.destinations([row('family', '-100456')])).toEqual([]);
    expect(store.setTelegram(null)).toBeNull(); expect(store.destinations([family])).toEqual([]);
  });

  it('drops, once, what builds before kept for answering from the group', () => {
    const db = open();
    db.exec('CREATE TABLE household_delivery_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.exec(`CREATE TABLE household_telegram_people (sender TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT,
      state TEXT NOT NULL, invite_id TEXT NOT NULL, at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO household_telegram_people VALUES ('2002','Ben Kim','ben_k','member','invite-1',5)").run();
    const put = db.prepare('INSERT INTO household_delivery_settings(key,value) VALUES(?,?)');
    put.run('telegram', JSON.stringify({ connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123',
      expected_sender: '1001', members: ['1001', '2002'], selected_at: 3 }));
    put.run('telegram_invite', JSON.stringify({ invite_id: 'invite-1', vendor_message_id: '9' }));
    const store = createHouseholdDeliveryStore(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='household_telegram_people'").get()).toBeUndefined();
    expect(db.prepare("SELECT key FROM household_delivery_settings ORDER BY key").all()).toEqual([{ key: 'telegram' }]);
    // The group stays chosen; the owner's and members' Telegram ids are gone from it.
    expect(JSON.parse((db.prepare("SELECT value FROM household_delivery_settings WHERE key='telegram'").get() as { value: string }).value))
      .toEqual({ connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', selected_at: 3 });
    expect(store.destinations([row('family', '-100123', { principal_id: '1001' })])).toHaveLength(1);
    // Nothing is left to drop, so opening the store again writes nothing.
    const before = db.prepare("SELECT value FROM household_delivery_settings WHERE key='telegram'").get();
    createHouseholdDeliveryStore(db);
    expect(db.prepare("SELECT value FROM household_delivery_settings WHERE key='telegram'").get()).toEqual(before);
  });
});
