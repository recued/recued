/**
 * D-325 P31/P43 — the brief, day-of notes and plain reminders go through the
 * connection the owner named in Settings, never a household one.
 *
 * ⛔ WHAT WAS WRONG. Reminder asks resolved the owner's named connection, but
 * everything sent through `notification.send` (the brief, D-324 reminders) took the
 * first Telegram row of the store, which lists newest first. Enrolling a household
 * group after the owner's private chat sent the weekly brief to the family.
 *
 * Real throughout the composed half: the collection context's own dispatchers, the
 * encrypted connection store, notification settings and the household designation.
 * Only the network is a twin.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createRuntimeConfigStore } from '@recued/config';
import type { ConnectionRow } from '@recued/contracts';
import { createNotificationSettingsStore, DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@recued/notification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { encodeAuthForStorage } from '../connection-auth-storage.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { selectOwnerNotificationConnection } from '../situations/reminder-destinations.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createHouseholdDeliveryStore } from '../storage/household-delivery-store.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const row = (name: string, enrolled_at: number, chat_id: string): ConnectionRow => ({
  pk: `notification:${name}`, kind: 'notification', subtype: 'telegram', name, display_name: name, enrolled_at, updated_at: enrolled_at,
  config_json: JSON.stringify({ chat_id, principal_id: '1000' }), auth_ciphertext: 'never-read-here',
});
const named = (connection?: { name: string; enrolled_at: number } | null): NotificationSettings => ({
  ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS),
  telegram: { notification: true, approval: false, messenger: false, ...(connection !== undefined ? { connection } : {}) },
});

describe('D-325 — the owner notification connection', () => {
  const privateChat = row('private', 10, 'private-chat');
  const family = row('family', 20, '-100123');
  const isFamily = (candidate: ConnectionRow) => candidate.name === 'family';
  const select = (settings: NotificationSettings, rows: ConnectionRow[], channel = 'telegram') =>
    selectOwnerNotificationConnection({ settings, channel, rows, isHousehold: isFamily });

  it('takes the named connection, not the newest, and never a household one', () => {
    expect(select(named({ name: 'private', enrolled_at: 10 }), [family, privateChat])).toBe(privateChat);
    expect(select(named({ name: 'family', enrolled_at: 20 }), [family, privateChat])).toEqual({ reason: 'NOTIFICATION_CONNECTION_IS_HOUSEHOLD' });
    expect(select(named({ name: 'private', enrolled_at: 9 }), [family, privateChat])).toEqual({ reason: 'NOTIFICATION_CONNECTION_MISSING' });
  });

  it('uses the only connection, asks for a choice among several, and honours "none"', () => {
    expect(select(named(), [privateChat])).toBe(privateChat);
    expect(select(named(), [family, privateChat])).toEqual({ reason: 'NOTIFICATION_CONNECTION_CHOICE_REQUIRED' });
    expect(select(named(null), [privateChat])).toEqual({ reason: 'NOTIFICATION_CONNECTION_OFF' });
  });

  it('leaves channels without connection credentials on their enrolled row', () => {
    const inApp = { ...privateChat, subtype: 'in-app' } as ConnectionRow;
    expect(select(named(), [inApp, privateChat], 'in_app')).toBe(inApp);
  });
});

describe('D-325 — the composed dispatchers send where the owner chose', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('sends the brief’s Telegram copy to the named private chat, and refuses the household group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-owner-notification-')); dirs.push(dir);
    // The notification handler binds `globalThis.fetch` when it is composed.
    const sent: Array<{ url: string; chat_id: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), chat_id: (JSON.parse(String(init?.body ?? '{}')) as { chat_id?: unknown }).chat_id });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const dbPath = join(dir, 'server.db');
    const runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath, runtimeConfig,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    try {
      const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig, gateRegistry: storage.gateRegistry,
        auditLog: storage.auditLog, eventBus: storage.eventBus, serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
        pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: createExecutionLateBoundRefs() });
      await unlockServerVault(app.keys!);
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig, manifests: storage.manifests,
        baseVault: storage.baseVault, auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
        contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
        accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
      const connections = app.connectionStoreRef!;
      for (const candidate of [row('private', 10, 'private-chat'), row('family', 20, '-100123')]) {
        connections.upsert({ ...candidate, auth_ciphertext: await encodeAuthForStorage({ type: 'bearer', token: `${candidate.name}-bot` },
          { kind: 'notification', name: candidate.name }, app.keys!.keyProvider('connection')) });
      }
      createHouseholdDeliveryStore(storage.db).setTelegram(connections.get('notification', 'family'), ['1000', '1001']);
      const settings = createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(storage.db, 'notification_settings'));
      await settings.setChannelMode('telegram', { notification: true, connection: { name: 'private', enrolled_at: 10 } });
      const telegram = collection.channelDispatchers!.telegram;
      expect(await telegram({ channel: 'telegram', text: 'Coming up' })).toMatchObject({ ok: true });
      expect(sent).toEqual([{ url: expect.stringContaining('/botprivate-bot/sendMessage'), chat_id: 'private-chat' }]);
      await settings.setChannelMode('telegram', { connection: { name: 'family', enrolled_at: 20 } });
      expect(await telegram({ channel: 'telegram', text: 'Coming up' })).toEqual({ ok: false, reason: 'NOTIFICATION_CONNECTION_IS_HOUSEHOLD' });
      expect(sent).toHaveLength(1);
    } finally { storage.db.close(); }
  });
});
