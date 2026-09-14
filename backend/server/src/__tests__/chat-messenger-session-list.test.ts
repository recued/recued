import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessengerReceiveState, ConnectionRow } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleMessagesSearch, handleSessionsList, type ChatRpcDeps } from '../chat-handler.js';
import { composeMessengerTurnIngest } from '../composition/bin/wire-messenger-turn.js';
import { buildConnectionRow, encodePlaintextAuth, stubConnectionStore } from './d-163-remote-channel-test-helpers.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'messenger-list-test' };
const fixture = () => {
  const db = new Database(':memory:'); ensureChatSchema(db); const store = createChatStore(db);
  const bridge = createChatMessengerBridge({ db, store, pollMs: 60_000, minSendIntervalMs: 0 });
  const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature,
    registry: { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} } });
  let receive: ChatMessengerReceiveState = 'active';
  const deps: ChatRpcDeps = { store, orchestrator: { ...raw, messengerBridge: bridge }, selfSignature: signature,
    messengerReceiveStatus: () => receive };
  cleanup.push(() => { bridge.close(); db.close(); });
  const status = (id: string) => handleSessionsList(deps).sessions.find(session => session.id === id)?.messenger;
  const add = (session: string, id: string) => store.appendMessage({ id, session_id: session, role: 'assistant', content: 'retained private text',
    target_server: 'self', picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' } });
  return { db, store, bridge, deps, status, add, receive: (state: ChatMessengerReceiveState) => { receive = state; } };
};

describe('Messenger identity and health in chat.sessions.list', () => {
  it('uses the production binding and receive projection for filtered message search', async () => {
    const f = fixture();
    f.store.createSession({ id: 'bound-uuid', title: 'Renamed by owner' });
    f.store.createSession({ id: 'web', title: 'telegram is only a title' });
    await f.add('bound-uuid', 'bound-message'); await f.add('web', 'web-message');
    f.bridge.bind('telegram', '42', 'bot', 'bound-uuid');
    f.bridge.register('telegram', { resolve: async () => ({ token: 'fixture', recipient: '42', account: 'bot' }), send: vi.fn() });
    await vi.waitFor(() => expect(f.status('bound-uuid')?.receive).toBe('active'));
    const search = (filters: unknown) => handleMessagesSearch(f.deps, { query: 'retained', filters });
    expect(handleSessionsList(f.deps).history_filters_available).toBe(true);
    expect((await search({ vendor: 'telegram' })).matches.map(m => m.message_id)).toEqual(['bound-message']);
    expect((await search({ source: 'webclient' })).matches.map(m => m.message_id)).toEqual(['web-message']);
    expect((await search({ needs_attention: true })).matches).toEqual([]);
    f.receive('retrying');
    expect(f.status('bound-uuid')?.delivery?.pending_count).toBe(0);
    expect((await search({ needs_attention: true })).matches.map(m => m.message_id)).toEqual(['bound-message']);
  });
  it.each(['slack', 'telegram', 'discord'])('keeps %s identity after renaming and reports receive loss with a caught-up journal', async vendor => {
    const f = fixture();
    f.store.createSession({ id: 'normal-uuid', title: 'A title the owner chose' });
    f.store.createSession({ id: 'web-only', title: 'slack · C1 is just a title' });
    f.bridge.bind(vendor, 'destination-1', 'bot-1', 'normal-uuid');
    const resolve = vi.fn(async () => ({ token: 'secret-token', recipient: 'destination-1', account: 'bot-1' }));
    f.bridge.register(vendor, { resolve, send: vi.fn() });
    const first = handleSessionsList(f.deps);
    expect(first.messenger_status_available).toBe(true);
    expect(first.sessions.find(row => row.id === 'normal-uuid')).toMatchObject({ title: 'A title the owner chose',
      messenger: { vendor, recipient: 'destination-1', linked: true, receive: 'checking' } });
    expect(first.sessions.find(row => row.id === 'web-only')?.messenger).toBeUndefined();
    await vi.waitFor(() => expect(f.status('normal-uuid')?.receive).toBe('active'));
    f.receive('retrying');
    expect(f.status('normal-uuid')).toMatchObject({ receive: 'retrying', delivery: { pending_count: 0 } });
    f.receive('webhook'); expect(f.status('normal-uuid')?.receive).toBe('webhook');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(handleSessionsList(f.deps))).not.toContain('secret-token');
  });

  it('counts the whole journal without decrypting messages or mistaking skips for successful delivery', async () => {
    const f = fixture(); const { session_id } = f.bridge.bind('slack', 'C1', 'bot-1');
    for (let i = 0; i < 230; i++) await f.add(session_id, `m${i}`);
    f.db.exec("UPDATE chat_deliveries SET state = 'sent'; UPDATE chat_deliveries SET state = 'skipped' WHERE message_id = 'm0';");
    f.db.exec("UPDATE chat_deliveries SET state = 'failed' WHERE message_id = 'm1'; UPDATE chat_deliveries SET state = 'unknown' WHERE message_id = 'm2';");
    f.db.exec("UPDATE chat_deliveries SET state = 'sending' WHERE message_id = 'm3'; UPDATE chat_deliveries SET state = 'pending' WHERE message_id = 'm4';");
    expect(f.status(session_id)?.delivery).toEqual({ pending_count: 4, sending_count: 1, failed_count: 1, unknown_count: 1, skipped_count: 1 });
    expect(JSON.stringify(handleSessionsList(f.deps))).not.toContain('retained private text');
  });

  it('does not block the synchronous list on identity HTTP, shares reads, and discards rotated in-flight credentials', async () => {
    const f = fixture(); const ids = ['bot-1', 'bot-2'].map(account => f.bridge.bind('slack', 'C1', account).session_id);
    let revision = 'one'; let finish!: (credential: { token: string; recipient: string; account: string }) => void;
    const held = new Promise<{ token: string; recipient: string; account: string }>(resolve => { finish = resolve; });
    const resolve = vi.fn().mockImplementationOnce(() => held).mockResolvedValue({ token: 'two', recipient: 'C1', account: 'bot-2' });
    f.bridge.register('slack', { revision: () => revision, resolve, send: vi.fn() });
    expect(handleSessionsList(f.deps).sessions.every(session => session.messenger?.receive === 'checking')).toBe(true);
    await Promise.resolve(); expect(resolve).toHaveBeenCalledTimes(1);
    revision = 'two'; expect(f.status(ids[1]!)?.receive).toBe('checking');
    await vi.waitFor(() => expect(f.status(ids[1]!)?.receive).toBe('active'));
    finish({ token: 'old', recipient: 'C1', account: 'bot-1' }); await held; await Promise.resolve();
    expect(f.status(ids[0]!)?.receive).toBe('connection_changed');
    expect(f.status(ids[1]!)?.receive).toBe('active'); expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps vault and pause status visible after credential resolution, and retries failed observations', async () => {
    vi.useFakeTimers(); const f = fixture(); const { session_id } = f.bridge.bind('telegram', '42', 'bot-1');
    const resolve = vi.fn().mockRejectedValueOnce(new Error('private provider error')).mockResolvedValue(null);
    f.bridge.register('telegram', { resolve, send: vi.fn() });
    f.status(session_id); await vi.advanceTimersByTimeAsync(0);
    expect(f.status(session_id)?.receive).toBe('unavailable'); expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); f.status(session_id); await vi.advanceTimersByTimeAsync(0);
    expect(f.status(session_id)?.receive).toBe('not_connected');
    f.receive('locked'); expect(f.status(session_id)?.receive).toBe('locked');
    f.receive('paused'); expect(f.status(session_id)?.receive).toBe('paused');
    expect(JSON.stringify(handleSessionsList(f.deps))).not.toContain('private provider error');
  });

  it('retains older unlinked histories, advertises unavailable status, and preserves the old-server shape', () => {
    const f = fixture(); f.store.createSession({ id: 'messenger:discord:123', title: 'An old chat' });
    expect(f.status('messenger:discord:123')).toEqual({ vendor: 'discord', recipient: '123', linked: false, receive: 'unlinked', delivery: null });
    vi.spyOn(f.bridge, 'sessionStatuses').mockImplementation(() => { throw new Error('storage read failed'); });
    expect(handleSessionsList(f.deps)).toMatchObject({ messenger_status_available: false, sessions: [{ title: 'An old chat' }] });
    const { messengerBridge: _bridge, ...legacy } = f.deps.orchestrator;
    const old = handleSessionsList({ ...f.deps, orchestrator: legacy });
    expect(old).not.toHaveProperty('messenger_status_available'); expect(old.sessions[0]).not.toHaveProperty('messenger');
  });

  it('uses the production credential/config revision to detect removal, destination changes and same-account rotation', async () => {
    const f = fixture(); const { session_id } = f.bridge.bind('slack', 'C1', 'slack:T1:B1');
    f.deps.orchestrator = withQueuedChatTurns(f.deps.orchestrator, { db: f.db, store: f.store, messengerBridge: f.bridge });
    cleanup.push(() => f.deps.orchestrator.turnQueue!.close());
    const row = (token: string, destination = 'C1') => {
      const auth = { type: 'bearer' as const, token };
      return { ...buildConnectionRow({ name: 'slack', auth, config: { channel_id: destination, roles: ['messenger'] } }), auth_ciphertext: encodePlaintextAuth(auth) };
    };
    let current: ConnectionRow | null = row('original'); const connectionStore = stubConnectionStore(current);
    connectionStore.get = (kind, name) => kind === 'notification' && name === 'slack' ? current : null;
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, team_id: 'T1', bot_id: 'B1' }));
    composeMessengerTurnIngest({ orchestrator: f.deps.orchestrator, connectionStore, fetchImpl });
    await vi.waitFor(() => expect(f.status(session_id)?.receive).toBe('active'));
    current = row('rotated'); expect(f.status(session_id)?.receive).toBe('checking');
    await vi.waitFor(() => expect(f.status(session_id)?.receive).toBe('active'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    current = row('rotated', 'C2');
    await vi.waitFor(() => expect(f.status(session_id)?.receive).toBe('connection_changed'));
    current = null;
    await vi.waitFor(() => expect(f.status(session_id)?.receive).toBe('not_connected'));
  });
});
