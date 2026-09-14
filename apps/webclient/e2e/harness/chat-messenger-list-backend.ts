import Database from 'better-sqlite3';
import { DEFAULT_INSTANCE_PREFS, applyPrefsPatch, type ChatMessengerReceiveState, type InstancePrefs } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../../../../backend/server/src/storage/chat-store.js';
import { createChatOrchestrator, type ChatBroadcastEmitter } from '../../../../backend/server/src/chat-orchestrator.js';
import { createChatMessengerBridge } from '../../../../backend/server/src/chat-messenger-bridge.js';
import { withQueuedChatTurns } from '../../../../backend/server/src/chat-turn-queue.js';
import { handleChatDelivery, handleChatQueue, handleMessagesSearch, handleSessionGet, handleSessionsList } from '../../../../backend/server/src/chat-handler.js';

/** Real list, storage, queue and delivery handlers; only vendor I/O is local. */
export const createMessengerListFixture = (broadcast: ChatBroadcastEmitter) => {
  const db = new Database(':memory:'); ensureChatSchema(db); const store = createChatStore(db);
  store.createSession({ id: 's', title: 'Web conversation' });
  store.createSession({ id: 'messenger:slack:old-channel', title: 'Older retained chat' });
  const selfSignature = { server_kind: 'recued' as const, version: '1', instance_id: 'list-browser-test' };
  const raw = createChatOrchestrator({ chatStore: store, selfSignature, broadcast,
    registry: { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} } });
  const bridge = createChatMessengerBridge({ db, store, broadcast, pollMs: 10, minSendIntervalMs: 0 });
  const receive = new Map<string, ChatMessengerReceiveState>();
  const account = new Map<string, string>(); const uncertain = new Set<string>(); let sends = 0;
  for (const vendor of ['slack', 'telegram', 'discord']) {
    store.createSession({ id: `${vendor}-chat`, title: `My ${vendor} project` });
    bridge.bind(vendor, `${vendor}-destination`, `${vendor}-bot`, `${vendor}-chat`);
    receive.set(vendor, 'active'); account.set(vendor, `${vendor}-bot`);
    bridge.register(vendor, { revision: () => account.get(vendor)!,
      resolve: async () => ({ token: 'local-fixture', recipient: `${vendor}-destination`, account: account.get(vendor)! }),
      send: async () => {
        sends++;
        return uncertain.delete(vendor) ? { ok: false, error: { kind: 'network', detail: 'fixture receipt lost' } }
          : { ok: true, vendor_message_id: `sent-${sends}` };
      } });
  }
  const orchestrator = withQueuedChatTurns(raw, { db, store, broadcast, messengerBridge: bridge });
  const deps = { store, orchestrator, selfSignature, messengerReceiveStatus: (vendor: string) => receive.get(vendor) ?? 'unknown' as const };
  const preferences = new Map<string, InstancePrefs>();
  return {
    addMessage: (session_id: string, id: string, content: string, ts = Date.now()) => store.appendMessage({
      id, session_id, content, ts, role: 'user', target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: selfSignature }, model_used: { provider: 'fixture', model_id: 'fixture' },
    }),
    receive: (vendor: string, state: ChatMessengerReceiveState) => { receive.set(vendor, state); },
    account: (vendor: string, identity: string) => { account.set(vendor, identity); },
    rename: (session: string, title: string) => { store.setTitle(session, title); broadcast.emit({ kind: 'chat.session_changed', session_id: session, field: 'title', value: title }); },
    sends: () => sends,
    async loseReceipt(vendor: string) {
      uncertain.add(vendor);
      await store.appendMessage({ id: `${vendor}-message`, session_id: `${vendor}-chat`, role: 'assistant', content: 'The retained answer',
        target_server: 'self', picker_at_send: { display_name: 'Self', signature: selfSignature }, model_used: { provider: 'fixture', model_id: 'fixture' } });
    },
    close: () => { orchestrator.turnQueue!.close(); bridge.close(); db.close(); },
    async rpc(method: string, args: unknown, client = 'paired'): Promise<unknown> {
      if (method === 'chat.sessions.list') return handleSessionsList(deps);
      if (method === 'chat.session.get') return handleSessionGet(deps, args as Parameters<typeof handleSessionGet>[1]);
      if (method === 'chat.deliveries.list') return handleChatDelivery(deps, 'list', args);
      if (method === 'chat.delivery.retry') return handleChatDelivery(deps, 'retry', args);
      if (method === 'chat.delivery.skip') return handleChatDelivery(deps, 'skip', args);
      if (method === 'chat.turns.list') return handleChatQueue(deps, 'list', args);
      if (method === 'server.getLLMConfig') return { config: { slot_1: { provider: 'openai', model: 'fixture', has_key: true, speed: 'fast' } } };
      if (method === 'chat.default_model_pref.get') return { source_id: null };
      if (method === 'chat.picker.list') return { entries: [] };
      if (method === 'collection.connection.list') return { connections: [] };
      if (method === 'recipe.list') return { recipes: [] };
      if (method === 'chat.messages.search') return handleMessagesSearch(deps, args);
      if (method === 'prefs.get') return { prefs: preferences.get(client) ?? DEFAULT_INSTANCE_PREFS };
      if (method === 'prefs.set') {
        const prefs = applyPrefsPatch(preferences.get(client) ?? DEFAULT_INSTANCE_PREFS, (args as { patch: Record<string, unknown> }).patch);
        preferences.set(client, prefs); return { prefs };
      }
      return {};
    },
  };
};
