/** D-338 — the Agenda in the owner's Telegram chat is a notice they can quote.
 *
 *  Slice 1 gave the notice hook to the remote channels (approvals, alerts, a scheduled prompt's
 *  done notice). The Agenda, "Due today", the Overview and a recipe's notification go out through
 *  `notification.send` and the dispatchers `composeConnectionNotification` boots, which never asked
 *  it: driven live (2026-11-07), the Agenda reached Telegram as a plain message, nothing was kept in
 *  the chat, and a reply that quoted it reached the model as an id with no text.
 *
 *  Real throughout except Telegram (a stubbed `fetch`) and the bot's identity: the chat store, the
 *  messenger bridge and its binding, the notice hook, the connection store, the composer's
 *  dispatchers and `handleNotificationSend`, called as the Agenda calls it. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';
import type { CollectionRegistry } from '../collections/registry.js';
import { composeConnectionNotification } from '../composition/bin/wire-connection-notification.js';
import { createEventBus } from '../events/bus.js';
import { handleNotificationSend } from '../notification-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { encodeAuthForStorage } from '../connection-auth-storage.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { createChatNotices } from '../chat-notices.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllGlobals(); });

const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'd-338-send' };
/** What the Agenda sends (`scheduled-situations.ts`): a title, the day, and the app's own link. */
const AGENDA = { title: 'Agenda · Sat 7 Nov', text: '09:00  Run 5 km\n18:00  Spanish lesson', ui_link_url: '#today' };

const server = async (chatId: number) => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const getKey = () => new Uint8Array(32).fill(7);
  const store = createChatStore(db, getKey);
  store.createSession({ id: 's' });
  const bridge = createChatMessengerBridge({ db, store, getKey, pollMs: 5, minSendIntervalMs: 0 });
  cleanups.push(() => db.close(), () => bridge.close());
  // The owner's chat with Recued, bound to the bot the connection sends with.
  bridge.bind('telegram', '3001', 'telegram:999', 's');
  const accountFor = vi.fn(async () => 'telegram:999');
  const notices = createChatNotices({ db, chatStore: store, accountFor, keyReady: () => true, signature });

  // Telegram, stubbed before the composer runs: the handler takes the global fetch when it is made.
  const telegram: Array<{ chat_id: unknown; text: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (!String(url).endsWith('/sendMessage')) throw new Error(`unexpected call ${String(url)}`);
    telegram.push(JSON.parse(String(init.body)) as { chat_id: unknown; text: string });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 101 + telegram.length } }), { status: 200 });
  }));
  const connectionStore = createConnectionStore(db);
  connectionStore.upsert({ kind: 'notification', name: 'telegram', subtype: 'telegram', display_name: 'Telegram',
    config_json: JSON.stringify({ chat_id: chatId }),
    auth_ciphertext: await encodeAuthForStorage({ type: 'bearer', token: 'BOT-TOKEN' }, { kind: 'notification', name: 'telegram' }),
    enrolled_at: 1, updated_at: 1 });
  const { channelDispatchers } = composeConnectionNotification({
    connectionStore, keys: undefined, eventBus: createEventBus(), collectionRegistry: {} as CollectionRegistry, notices,
  });

  return { db, store, bridge, telegram, accountFor, send: () => handleNotificationSend({ dispatchers: channelDispatchers! }, AGENDA) };
};

describe('D-338 the Agenda in the owner\'s chat with Recued is a notice', () => {
  it('goes out as a notice, is kept in the chat, and a reply that quotes it gets its text', async () => {
    const s = await server(3001);

    expect((await s.send()).delivered_to).toContain('telegram');

    expect(s.telegram).toEqual([{ chat_id: 3001, text: 'Notice · Agenda · Sat 7 Nov\n\n09:00  Run 5 km\n18:00  Spanish lesson\n\n'
      + 'Not part of your chat with Recued. To ask about it, use Reply on this message.' }]);
    const notice = (await s.store.listMessages('s')).filter((m) => m.role === 'notice');
    expect(notice).toEqual([expect.objectContaining({ content: AGENDA.text, notice: expect.objectContaining({ vendor: 'telegram', title: AGENDA.title }) })]);
    // The owner replies to message 102 on Telegram: it resolves to the notice, with what they saw.
    expect(await s.bridge.nativeReply('s', 'telegram', '102'))
      .toEqual({ message_id: notice[0]!.id, role: 'notice', text: `${AGENDA.title}\n${AGENDA.text}` });
  });

  it('to a chat the owner does not chat with Recued in, it goes as before and nothing is kept', async () => {
    const s = await server(4000);

    await s.send();

    expect(s.telegram).toEqual([{ chat_id: 4000, text: `${AGENDA.title}\n\n${AGENDA.text}` }]);
    expect((await s.store.listMessages('s')).filter((m) => m.role === 'notice')).toEqual([]);
    // No chat is bound to that recipient, so the bot's identity is not asked for.
    expect(s.accountFor).not.toHaveBeenCalled();
  });
});

describe('D-338 the collection context hands the chat\'s hook to what it sends', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('its own Telegram dispatcher sends the notice the hook answers, and records it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-d338-send-')); dirs.push(dir);
    const telegram: string[] = [];
    // Stubbed before the composer runs: the handler takes the global fetch when it is made.
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      telegram.push(String((JSON.parse(String(init?.body ?? '{}')) as { text?: unknown }).text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }), { status: 200, headers: { 'content-type': 'application/json' } });
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
      const recorded: Array<string | undefined> = [];
      const prepare = vi.fn(async (input: { message: { title?: string; text: string } }) => ({
        title: `Notice · ${input.message.title ?? ''}`, text: input.message.text, sent: async (id: string | undefined) => { recorded.push(id); } }));
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig, manifests: storage.manifests,
        baseVault: storage.baseVault, auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
        contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
        accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef, chatNotices: { prepare } });
      app.connectionStoreRef!.upsert({ kind: 'notification', name: 'telegram', subtype: 'telegram', display_name: 'Telegram',
        config_json: JSON.stringify({ chat_id: '3001' }), enrolled_at: 1, updated_at: 1,
        auth_ciphertext: await encodeAuthForStorage({ type: 'bearer', token: 'BOT-TOKEN' }, { kind: 'notification', name: 'telegram' },
          app.keys!.keyProvider('connection')) });

      expect(await collection.channelDispatchers!.telegram({ channel: 'telegram', title: AGENDA.title, text: AGENDA.text })).toMatchObject({ ok: true });

      expect(prepare).toHaveBeenCalledWith({ vendor: 'telegram', recipient: '3001', token: 'BOT-TOKEN', message: { title: AGENDA.title, text: AGENDA.text } });
      expect(telegram).toEqual([`Notice · ${AGENDA.title}\n\n${AGENDA.text}`]);
      expect(recorded).toEqual(['102']);
    } finally { storage.db.close(); }
  });
});
