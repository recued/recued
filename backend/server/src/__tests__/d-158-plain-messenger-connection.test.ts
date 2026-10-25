/** D-158 amendment 2026-10-20 — a plain notify or ask on a chat channel goes
 *  through the connection the owner chose for that channel, else the only one,
 *  else the one named after the channel, as email's has since 10-19. An answer
 *  to a plain ask is taken only from that connection. A messenger turn and live
 *  control keep the connection named after the channel: they answer in the
 *  conversation the message came in on. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigStore } from '@recued/config';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import {
  createNotificationSettingsStore,
  type NotificationBlock,
  type NotificationSettings,
  type RemoteChannel,
} from '@recued/notification';

import { createBootTrace } from '../cli/boot-trace.js';
import { encodeAuthForStorage } from '../connection-auth-storage.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeExecutionContext, createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';
import { createOwnerNotificationConnection } from '../composition/bin/owner-email-connection.js';
import { buildMessengerCredentialResolvers, buildMessengerRemoteChannels } from '../composition/bin/messenger-transport-leaves.js';
import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import { createRemoteCredentialResolver } from '../composition/bin/wire-remote-channel.js';
import { resolveTelegramRecipient } from '../composition/bin/wire-telegram-channel.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createHouseholdDeliveryStore } from '../storage/household-delivery-store.js';

const blob = (auth: ConnectionAuth) => Buffer.from(JSON.stringify(auth)).toString('base64');
const telegram = (name: string, enrolled_at: number, chat = `${name}-chat`): Omit<ConnectionRow, 'pk'> => ({ kind: 'notification', subtype: 'telegram',
  name, display_name: name, enrolled_at, updated_at: enrolled_at, config_json: JSON.stringify({ chat_id: chat, principal_id: '1001' }),
  auth_ciphertext: blob({ type: 'bearer', token: `token-${name}` }) });

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const world = (...rows: Array<Omit<ConnectionRow, 'pk'>>) => {
  const db = new Database(':memory:'); dbs.push(db);
  const store = createConnectionStore(db); for (const row of rows) store.upsert(row);
  const settings = createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings'));
  const choose = (connection: { name: string; enrolled_at: number } | null) => settings.setChannelMode('telegram', { connection });
  return { db, store, choose, owner: createOwnerNotificationConnection(db, store, 'telegram') };
};
const named = (row: ConnectionRow | { reason: string }) => ('reason' in row ? row.reason : row.name);

describe('the connection a plain notify or ask on a chat channel goes through', () => {
  it('is the owner’s choice, else the only one, else the one named after the channel', async () => {
    const one = world(telegram('private', 2));
    expect(named(await one.owner())).toBe('private');
    const two = world(telegram('telegram', 1), telegram('private', 2));
    expect(named(await two.owner())).toBe('telegram');
    await two.choose({ name: 'private', enrolled_at: 2 });
    expect(named(await two.owner())).toBe('private');
    const unnamed = world(telegram('work', 1), telegram('private', 2));
    expect(named(await unnamed.owner())).toBe('NOTIFICATION_CONNECTION_CHOICE_REQUIRED');
  });

  it('is none when the owner turned the channel off, chose a connection that went, or chose the household', async () => {
    const w = world(telegram('telegram', 1), telegram('family', 2, '-100123'));
    await w.choose(null);
    expect(named(await w.owner())).toBe('NOTIFICATION_CONNECTION_OFF');
    await w.choose({ name: 'private', enrolled_at: 9 });
    expect(named(await w.owner())).toBe('NOTIFICATION_CONNECTION_MISSING');
    createHouseholdDeliveryStore(w.db).setTelegram(w.store.get('notification', 'family')!, 3);
    await w.choose({ name: 'family', enrolled_at: 2 });
    expect(named(await w.owner())).toBe('NOTIFICATION_CONNECTION_IS_HOUSEHOLD');
  });

  it('is what the credential resolver reads when no destination is named; a destination keeps its own row', async () => {
    const w = world(telegram('telegram', 1), telegram('private', 2));
    await w.choose({ name: 'private', enrolled_at: 2 });
    const plain = createRemoteCredentialResolver({ connectionStore: w.store, vendor: 'telegram', resolveRecipient: resolveTelegramRecipient, plainConnection: w.owner });
    expect(await plain()).toMatchObject({ token: 'token-private', recipient: 'private-chat' });
    expect(await plain({ id: 'owner', channel: 'telegram', connection_name: 'telegram', connection_enrolled_at: 1, recipient: 'telegram-chat' }))
      .toMatchObject({ token: 'token-telegram', connection_name: 'telegram' });
    await w.choose(null);
    expect(await plain()).toBeNull();
    // Without the owner's choice the resolver reads the row named after the vendor.
    await w.choose({ name: 'private', enrolled_at: 2 });
    const turn = createRemoteCredentialResolver({ connectionStore: w.store, vendor: 'telegram', resolveRecipient: resolveTelegramRecipient });
    expect(await turn()).toMatchObject({ token: 'token-telegram', recipient: 'telegram-chat' });
  });

  it('reaches the notification channels and not the turn or live-control resolvers', async () => {
    const w = world(telegram('telegram', 1), telegram('private', 2));
    await w.choose({ name: 'private', enrolled_at: 2 });
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => { urls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }); });
    const plainConnection = (vendor: string) => createOwnerNotificationConnection(w.db, w.store, vendor);
    const channels = buildMessengerRemoteChannels({ connectionStore: w.store, transportOptions: { fetchImpl: fetchImpl as typeof fetch }, plainConnection });
    await channels.telegram!.deliverNotify({ title: 'Passport', text: 'Renew it before June.' });
    expect(urls).toEqual(['https://api.telegram.org/bottoken-private/sendMessage']);
    // The builder the turn and live control use takes no owner's choice.
    expect(await buildMessengerCredentialResolvers({ connectionStore: w.store }).telegram!()).toMatchObject({ token: 'token-telegram' });
  });
});

describe('the server’s own composition', () => {
  it('sends a plain Telegram notification through the connection the owner chose, and Settings names it', async () => {
    // ⛔ The units above hand the channel the owner's choice; this is the
    // composition that must, over the server's own store and settings.
    // `telegram` is the row named after the channel, the only one read before.
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => { sent.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }); }));
    const dir = mkdtempSync(join(tmpdir(), 'plain-messenger-'));
    const dbPath = join(dir, 'server.db'); const runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath, runtimeConfig,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    try {
      const lateBound = createExecutionLateBoundRefs();
      const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig, gateRegistry: storage.gateRegistry,
        auditLog: storage.auditLog, eventBus: storage.eventBus, serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
        pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: lateBound });
      await unlockServerVault(app.keys!);
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig, manifests: storage.manifests,
        baseVault: storage.baseVault, auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
        contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
        accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
      const context = await composeExecutionContext({ storage, app, collection, baseVault: storage.baseVault, lateBound, env: {} });
      for (const [name, enrolled_at] of [['telegram', 1], ['private', 2]] as const) {
        app.connectionStoreRef!.upsert({ kind: 'notification', name, subtype: 'telegram', display_name: name,
          config_json: JSON.stringify({ chat_id: `${name}-chat` }), enrolled_at, updated_at: enrolled_at,
          auth_ciphertext: await encodeAuthForStorage({ type: 'bearer', token: `token-${name}` }, { kind: 'notification', name }, app.keys!.keyProvider('connection')) });
      }
      const block = context.notificationBlock!;
      const row = async () => (await block.describeNotificationChannels()).find(item => item.channel === 'telegram');
      // Two connections and no choice: the one named after the channel, as before.
      expect(await row()).toMatchObject({ plain_connection: { name: 'telegram' } });
      expect(await block.setNotificationChannelMode('telegram', { connection: { name: 'private', enrolled_at: 2 }, notification: true }))
        .toMatchObject({ ok: true });
      expect(await row()).toMatchObject({ plain_connection: { name: 'private', display_name: 'private' } });
      await block.notify({ title: 'Passport', text: 'Renew it before June.' });
      await vi.waitFor(() => expect(sent.filter(url => url.startsWith('https://api.telegram.org/')))
        .toEqual(['https://api.telegram.org/bottoken-private/sendMessage']));
    } finally { storage.db.close(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('an answer to a plain ask on a chat channel', () => {
  const press = async (opts: { from: string; reminder?: boolean; plain?: { name: string; enrolled_at: number } | null; checked?: boolean }) => {
    const submitAnswer = vi.fn(async () => ({ outcome: 'accepted' }));
    const ack = vi.fn(async () => {});
    const block = { restoreAskDeliveries: async () => {}, submitAnswer,
      getAsk: async (ask_id: string) => ({ ask_id, status: 'open', ...(opts.reminder ? { delivery_group_id: 'group-1' } : {}) }) } as unknown as NotificationBlock;
    const channel = { name: 'telegram', capability: 'inline', parseInboundMessage: () => null,
      parseInboundReply: () => ({ ask_id: 'ask-deploy', option: 'approve', via: 'telegram' }) } as unknown as RemoteChannel;
    const { messengerDispatchers } = composeInboundAnswerDispatcher({ block, messengerChannels: { telegram: channel },
      connectionEnrollment: name => ({ telegram: 1, private: 2 } as Record<string, number>)[name], telegramAck: ack,
      ...(opts.checked === false ? {} : { plainAskConnection: async () => opts.plain === undefined ? { name: 'private', enrolled_at: 2 } : opts.plain }) });
    await messengerDispatchers.telegram!({ connection_name: opts.from, update_id: '1',
      payload: { update_id: 1, callback_query: { id: 'cb', from: { id: 1001 }, data: 'x', message: { message_id: 1, chat: { id: 1 } } } } } as never);
    return { submitAnswer, ack };
  };

  it('is taken from the connection the ask went out through', async () => {
    expect((await press({ from: 'private' })).submitAnswer).toHaveBeenCalledTimes(1);
  });
  it('is not taken from another connection, and the press is still acknowledged', async () => {
    const { submitAnswer, ack } = await press({ from: 'telegram' });
    expect(submitAnswer).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
  });
  it('is not taken when no connection can carry a plain ask', async () => {
    expect((await press({ from: 'private', plain: null })).submitAnswer).not.toHaveBeenCalled();
  });
  it('leaves a reminder’s answer to its own destinations', async () => {
    expect((await press({ from: 'telegram', reminder: true })).submitAnswer).toHaveBeenCalledTimes(1);
  });
  it('was taken from any connection before: a press with the ask’s id settled it', async () => {
    expect((await press({ from: 'telegram', checked: false })).submitAnswer).toHaveBeenCalledTimes(1);
  });
});
