import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createMiddlewareRegistry } from '@recued/middleware';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import { MCP_RESERVED_RPC_PREFIXES } from '@recued/contracts';
import type { OutboundMessage, TransportSendResult } from '@recued/transport';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import { createChatMessengerBridge, splitMessengerText } from '../chat-messenger-bridge.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleSend, handleChatDelivery, makeChatHandlers } from '../chat-handler.js';
import { composeMessengerTurnIngest } from '../composition/bin/wire-messenger-turn.js';
import { createMessengerAccountResolver } from '../composition/bin/messenger-account-identity.js';
import { buildConnectionRow, encodePlaintextAuth, stubConnectionStore } from './d-163-remote-channel-test-helpers.js';

/** ⛔ `vi.waitFor` GIVES UP AFTER ONE SECOND unless told otherwise, and this
 *  file waits on real work: a delivery pump, SQLite commits (one case on a file
 *  that fsyncs), eleven queued chat turns. Idle, every wait here settles in one
 *  50 ms poll. With four writers syncing to disk beside it, the file-backed case
 *  took 260 ms, five times as long — and the full sweep builds a Docker image
 *  while it runs. The file went red once (2026-10-07, `e4968eeb3`) and passed
 *  every rerun, alone and starved. Each wait still fails a delivery that never
 *  happens — at 8 s, inside the 30 s test limit — but no longer on a slow disk.
 *  Same bound as the sibling `d-265-messenger-roundtrip.test.ts`. */
const eventually = (assert: () => unknown | Promise<unknown>) => vi.waitFor(assert, { timeout: 8_000, interval: 10 });

const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0).reverse()) cleanup(); });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'delivery-test' };
const key = () => new Uint8Array(32).fill(39);
const fixture = (path = ':memory:', workerAlive?: (pid: number, started: number) => boolean,
  destination = { vendor: 'slack', recipient: 'C123', account: 'slack:T1:B1' }) => {
  const db = new Database(path); ensureChatSchema(db); const store = createChatStore(db, key);
  const bridge = createChatMessengerBridge({ db, store, getKey: key, pollMs: 5, minSendIntervalMs: 0, retryDelayMs: 5,
    ...(workerAlive ? { workerAlive } : {}),
  });
  close.push(() => { bridge.close(); if (db.open) db.close(); });
  const bound = bridge.bind(destination.vendor, destination.recipient, destination.account);
  const add = (id: string, text: string) => store.appendMessage({ id, session_id: bound.session_id, role: 'assistant', content: text,
    target_server: 'self', picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' } });
  let currentAccount = destination.account;
  const sent: OutboundMessage[] = [];
  const register = (send?: (message: OutboundMessage) => Promise<TransportSendResult>) => bridge.register(destination.vendor, {
    resolve: async () => ({ token: 'fixture-token', recipient: destination.recipient, account: currentAccount }),
    send: async message => { sent.push(message); return send ? send(message) : { ok: true, vendor_message_id: `posted-${sent.length}` }; },
  });
  return { db, store, bridge, bound, add, sent, register, account: (account: string) => { currentAccount = account; } };
};
const state = async (f: ReturnType<typeof fixture>, id: string) => (await f.bridge.snapshot(f.bound.session_id)).deliveries.find(d => d.message_id === id);

describe('D-265 verified bot identity', () => {
  it.each([
    ['slack', { ok: true, team_id: 'T1', bot_id: 'B1' }, 'slack:T1:B1'],
    ['telegram', { ok: true, result: { id: 123, is_bot: true } }, 'telegram:123'],
    ['discord', { id: '123', bot: true }, 'discord:123'],
  ] as const)('verifies %s and joins concurrent identity reads for one credential', async (vendor, body, account) => {
    let calls = 0;
    const resolve = createMessengerAccountResolver(async (_url, init) => {
      calls++; expect(init?.redirect).toBe('error'); return Response.json(body);
    });
    expect(await Promise.all([resolve(vendor, 'token'), resolve(vendor, 'token')])).toEqual([account, account]);
    expect(calls).toBe(1);
    expect(await resolve(vendor, 'rotated')).toBe(account); expect(calls).toBe(2);
  });

  it('does not cache a failed identity read and bounds the response without exposing credentials', async () => {
    let calls = 0;
    const resolve = createMessengerAccountResolver(async () => {
      calls++;
      return calls === 1 ? Response.json({ padding: 'x'.repeat(70 * 1024) })
        : Response.json({ ok: true, result: { id: 123, is_bot: true } });
    });
    await expect(resolve('telegram', 'private-token')).rejects.toThrow('Could not verify the connected Messenger bot account.');
    expect(await resolve('telegram', 'private-token')).toBe('telegram:123');
  });

  it('continues on verified token rotation but fences a replacement bot before sending old context', async () => {
    const f = fixture(); let token = 'original';
    const resolve = createMessengerAccountResolver(async (_url, init) => Response.json({ ok: true, team_id: 'T1',
      bot_id: new Headers(init?.headers).get('authorization') === 'Bearer replacement' ? 'B2' : 'B1' }));
    f.bridge.register('slack', { resolve: async () => ({ token, recipient: 'C123', account: await resolve('slack', token) }),
      send: async message => { f.sent.push(message); return { ok: true, vendor_message_id: String(f.sent.length) }; },
    });
    await f.add('one', 'original context');
    await eventually(async () => expect(await state(f, 'one')).toMatchObject({ state: 'sent' }));
    token = 'rotated'; await f.add('two', 'same account');
    await eventually(async () => expect(await state(f, 'two')).toMatchObject({ state: 'sent' }));
    expect(f.sent.map(message => message.token)).toEqual(['original', 'rotated']);
    token = 'replacement'; await f.add('three', 'must stay private');
    await eventually(async () => expect(await state(f, 'three')).toMatchObject({ state: 'failed', error: 'binding_changed' }));
    expect(f.sent).toHaveLength(2);
  });
});

describe('D-265 durable delivery journal and fault recovery', () => {
  it('creates an obligation atomically and rolls back the message if its delivery cannot be recorded', async () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON chat_deliveries BEGIN SELECT RAISE(ABORT, 'delivery unavailable'); END;");
    await expect(f.add('m', 'retain atomically')).rejects.toThrow('delivery unavailable');
    expect(await f.store.listMessages(f.bound.session_id)).toEqual([]);
    f.db.exec('DROP TRIGGER reject_delivery'); await f.add('m', 'retain atomically');
    expect(await state(f, 'm')).toMatchObject({ state: 'pending' });
    f.register(); await eventually(async () => expect(await state(f, 'm')).toMatchObject({ state: 'sent' }));
    expect(f.sent.map(m => m.text)).toEqual(['retain atomically']);
  });

  it('preserves all Unicode text, retains encrypted chunk plans, and retries only unconfirmed chunks without regenerating', async () => {
    const f = fixture(); const text = ('😀<&>\n' + 'x'.repeat(1791)).repeat(3);
    expect(splitMessengerText(text).join('')).toBe(text);
    expect(splitMessengerText(text).every(s => s.length <= 1800)).toBe(true);
    let fail = true;
    f.register(async () => f.sent.length === 2 && fail
      ? { ok: false, error: { kind: 'network', detail: 'receipt lost' } }
      : { ok: true, vendor_message_id: `id-${f.sent.length}` });
    await f.add('long', text); await f.add('later', 'must wait');
    await eventually(async () => expect(await state(f, 'long')).toMatchObject({ state: 'unknown', sent_chunks: 1 }));
    const job = (await state(f, 'long'))!;
    expect(f.sent).toHaveLength(2); expect(await state(f, 'later')).toMatchObject({ state: 'pending' });
    expect(() => f.bridge.act(f.bound.session_id, job.delivery_id, 'retry', 'retry')).toThrow('Acknowledge');
    expect(JSON.stringify(f.db.prepare('SELECT payload FROM chat_delivery_chunks').all())).not.toContain('xxxx');
    fail = false; f.bridge.act(f.bound.session_id, job.delivery_id, 'retry', 'retry', true); f.bridge.kick();
    await eventually(async () => expect(await state(f, 'later')).toMatchObject({ state: 'sent' }));
    expect(f.sent[0]!.text + f.sent.slice(2, -1).map(m => m.text).join('')).toBe(text);
    expect(f.sent[1]!.delivery_id).toBe(f.sent[2]!.delivery_id);
    const count = f.sent.length;
    f.bridge.act(f.bound.session_id, job.delivery_id, 'retry', 'retry', true); f.bridge.kick();
    expect(f.sent).toHaveLength(count);
    expect(await f.bridge.nativeReply(f.bound.session_id, 'slack', 'id-3')).toMatchObject({ message_id: 'long', text });
  });

  it('paces safe rate-limit retries, but a missing receipt is unknown', async () => {
    const f = fixture();
    f.register(async () => f.sent.length === 1 ? { ok: false, error: { kind: 'rate_limited', detail: 'wait' } } : { ok: true });
    await f.add('rate', 'one message');
    await eventually(async () => expect(await state(f, 'rate')).toMatchObject({ state: 'unknown', error: 'missing_receipt' }));
    expect(f.sent).toHaveLength(2);
  });

  it('persists the vendor retry deadline and bounds repeated rate-limit attempts', async () => {
    const f = fixture(); const started = Date.now();
    f.register(async () => ({ ok: false, error: { kind: 'rate_limited', detail: 'wait', retry_after_ms: 180000 } }));
    await f.add('rate', 'one message');
    await eventually(async () => expect(await state(f, 'rate')).toMatchObject({ state: 'pending', error: 'rate_limited' }));
    expect((f.db.prepare('SELECT next_attempt_at FROM chat_deliveries').get() as { next_attempt_at: number }).next_attempt_at)
      .toBeGreaterThanOrEqual(started + 180000);
    for (let attempt = 2; attempt <= 5; attempt++) {
      f.db.exec('UPDATE chat_deliveries SET next_attempt_at = 0'); f.bridge.kick();
      await eventually(() => expect(f.sent).toHaveLength(attempt));
    }
    await eventually(async () => expect(await state(f, 'rate')).toMatchObject({ state: 'failed', error: 'rate_limited' }));
  });

  it('reports a complete backlog count and remembers skips beyond the bounded detail window', async () => {
    const f = fixture();
    for (let i = 0; i < 205; i++) await f.add(`m${i}`, `text ${i}`);
    const before = await f.bridge.snapshot(f.bound.session_id);
    expect(before).toMatchObject({ pending_count: 205, skipped_count: 0 }); expect(before.deliveries).toHaveLength(200);
    f.bridge.act(f.bound.session_id, before.deliveries[0]!.delivery_id, 'skip-old', 'skip');
    f.db.exec("UPDATE chat_deliveries SET state = 'sent' WHERE state = 'pending'");
    const after = await f.bridge.snapshot(f.bound.session_id);
    expect(after).toMatchObject({ pending_count: 0, skipped_count: 1 });
    expect(after.deliveries.every(d => d.state === 'sent')).toBe(true);
  });

  it('refuses new linked input before acknowledgement when delivery capacity cannot be reserved', async () => {
    const f = fixture();
    for (let i = 0; i < 2047; i++) await f.add(`m${i}`, `pending ${i}`);
    const queue = createChatTurnQueueStore(f.db, key);
    const command = { family: 'chat', session_id: f.bound.session_id, message: 'needs two delivery slots', input: {} };
    await expect(queue.admit(command, 'not-accepted')).rejects.toThrow('delivery storage is full');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_turn_submissions').get()).toEqual({ n: 0 });
    f.db.exec("UPDATE chat_deliveries SET state = 'sent'");
    expect(await queue.admit(command, 'not-accepted')).toMatchObject({ disposition: 'accepted' });
  });

  it('fences changed accounts and deleted sessions without retargeting pending text', async () => {
    const f = fixture(); await f.add('old', 'private old account'); f.account('slack:T2:B2'); f.register();
    await eventually(async () => expect(await state(f, 'old')).toMatchObject({ state: 'failed', error: 'binding_changed' }));
    expect(f.sent).toEqual([]);
    const replacement = f.bridge.bind('slack', 'C123', 'slack:T2:B2');
    expect(replacement.session_id).not.toBe(f.bound.session_id);
    expect(await f.store.listMessages(replacement.session_id)).toEqual([]);
    f.store.deleteSession(f.bound.session_id); f.bridge.kick();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_deliveries').get()).toEqual({ n: 0 });
  });

  it('recovers queued delivery across SQLite reopen while a possibly-written chunk stays unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd265-delivery-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'data.sqlite'); const first = fixture(path);
    await first.add('queued', 'survives restart'); first.bridge.close(); first.db.close();
    const second = fixture(path); second.register();
    await eventually(async () => expect(await state(second, 'queued')).toMatchObject({ state: 'sent' }));
    const job = (await state(second, 'queued'))!;
    second.db.prepare("UPDATE chat_delivery_chunks SET state = 'sending', vendor_message_id = NULL WHERE delivery_id = ?").run(job.delivery_id);
    second.db.prepare("UPDATE chat_deliveries SET state = 'sending', worker_pid = -1, worker_id = 'dead' WHERE delivery_id = ?").run(job.delivery_id);
    second.bridge.close(); second.db.close();
    const third = fixture(path, () => false); third.register();
    await eventually(async () => expect(await state(third, 'queued')).toMatchObject({ state: 'unknown', error: 'restart_after_send' }));
    expect(third.sent).toEqual([]);
    const details = await third.bridge.snapshot(third.bound.session_id, { session_id: third.bound.session_id, details: true });
    expect(details.deliveries[0]!.details).toMatchObject({ message: { snippet: 'survives restart' },
      text: { sent_parts: 0, total_parts: 1 }, uncertain_parts: 1 });
  });

  it('maps an explicit owner reply to its target and the subsequent answer to that new owner message', async () => {
    const f = fixture(); f.register(); await f.add('original', 'earlier answer');
    await eventually(async () => expect(await state(f, 'original')).toMatchObject({ state: 'sent' }));
    const queue = createChatTurnQueueStore(f.db, key);
    const accepted = await queue.admit({ family: 'chat', session_id: f.bound.session_id, message: 'follow-up',
      input: { reply_to_message_id: 'original' } }, 'follow-up');
    await f.store.appendMessage({ id: 'question', session_id: f.bound.session_id, role: 'user', content: 'follow-up', turn_id: accepted.turn_id,
      target_server: 'self', picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' } });
    await f.store.appendMessage({ id: 'answer', session_id: f.bound.session_id, role: 'assistant', content: 'new answer', turn_id: accepted.turn_id,
      target_server: 'self', picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' } });
    await eventually(async () => expect(await state(f, 'answer')).toMatchObject({ state: 'sent' }));
    expect(f.sent[1]).toMatchObject({ reply_to_message_id: 'posted-1', thread_id: 'posted-1' });
    expect(f.sent[1]!.text).toBe('Owner (via webclient)\nfollow-up');
    expect(f.sent[2]).toMatchObject({ reply_to_message_id: 'posted-2', thread_id: 'posted-1' });
    await expect(queue.admit({ family: 'chat', session_id: f.bound.session_id, message: 'missing target',
      input: { reply_to_message_id: 'not-retained' } }, 'missing-target')).rejects.toThrow('no longer available');
    expect(f.sent).toHaveLength(3);
  });

  it('recovers an unwritable receipt as unknown without crashing or posting it twice', async () => {
    const f = fixture();
    f.register(async () => {
      f.db.exec("CREATE TRIGGER no_delivery_update BEFORE UPDATE ON chat_deliveries BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
      return { ok: true, vendor_message_id: 'receipt-not-committed' };
    });
    await f.add('m', 'sent once');
    await eventually(() => expect(f.sent).toHaveLength(1));
    // The vendor write succeeded but no receipt/terminal write was possible.
    f.db.exec('DROP TRIGGER no_delivery_update'); f.bridge.kick();
    await eventually(async () => expect(await state(f, 'm')).toMatchObject({ state: 'unknown' }));
    expect(f.sent).toHaveLength(1);
  });

  it('requires paired owner authority and preserves an existing legacy conversation until explicitly linked', async () => {
    const f = fixture(); f.register();
    f.store.createSession({ id: 'messenger:slack:legacy' });
    const legacy = await f.bridge.snapshot('messenger:slack:legacy');
    expect(legacy.binding).toBeNull(); expect(legacy.available?.linked_session_id).toBe(f.bound.session_id);
    const raw = createChatOrchestrator({ chatStore: f.store, selfSignature: signature, registry: {
      list: () => [], listByTier: () => [], getByName: () => null, dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {},
    } });
    const deps = { store: f.store, orchestrator: { ...raw, messengerBridge: f.bridge }, selfSignature: signature };
    const handlers = makeChatHandlers(deps)!.handlers;
    for (const method of ['chat.deliveries.list', 'chat.delivery.retry', 'chat.delivery.skip', 'chat.messenger.connect'] as const) {
      expect(MCP_RESERVED_RPC_PREFIXES.some(prefix => method.startsWith(prefix))).toBe(true);
      await expect(handlers[method]!({ session_id: f.bound.session_id } as never, { instance_id: null } as never)).rejects.toThrow('paired');
    }
    await expect(handleChatDelivery(deps, 'connect', { session_id: 'messenger:slack:legacy', vendor: 'slack' })).rejects.toThrow('current linked');
  });

  it('cannot link a recreated session using a request made for its deleted predecessor', async () => {
    const f = fixture(); f.store.createSession({ id: 'legacy' });
    let resolve!: (credential: { token: string; recipient: string; account: string }) => void;
    const credential = new Promise<{ token: string; recipient: string; account: string }>(done => { resolve = done; });
    f.bridge.register('telegram', { resolve: () => credential, send: async () => ({ ok: true, vendor_message_id: 'never' }) });
    const pending = f.bridge.connect('legacy', 'telegram');
    f.store.deleteSession('legacy'); f.store.createSession({ id: 'legacy' });
    resolve({ token: 'fixture', recipient: '123', account: 'telegram:1' });
    await expect(pending).rejects.toThrow('conversation changed');
    expect(f.bridge.binding('legacy')).toBeUndefined();
  });
});

it.each([
  { vendor: 'slack', recipient: 'C123', account: 'slack:T1:B1', identity: { ok: true, team_id: 'T1', bot_id: 'B1' },
    config: { channel_id: 'C123' },
    inbound: { type: 'event_callback', event: { type: 'message', channel: 'C123', user: 'U1', ts: 'native-1', thread_ts: 'root-1', text: 'native start' } },
    echo: { type: 'event_callback', event: { type: 'message', channel: 'C123', bot_id: 'B1', ts: 'echo', text: 'answer 11' } },
  },
  { vendor: 'telegram', recipient: '-123', account: 'telegram:123', identity: { ok: true, result: { id: 123, is_bot: true } },
    config: { chat_id: '-123' },
    inbound: { message: { message_id: 1, message_thread_id: 77, chat: { id: -123 }, from: { id: 456, is_bot: false }, text: 'native start' } },
    echo: { message: { message_id: 2, chat: { id: -123 }, from: { id: 123, is_bot: true }, text: 'answer 11' } },
  },
  { vendor: 'discord', recipient: '1234', account: 'discord:123', identity: { id: '123', bot: true },
    config: { channel_id: '1234', ingress_mode: 'socket' },
    inbound: { id: '1', channel_id: '1234', author: { id: '456', bot: false }, content: 'native start' },
    echo: { id: '2', channel_id: '1234', author: { id: '123', bot: true }, content: 'answer 11' },
  },
])('continues ten webclient exchanges in a native $vendor session while delivery is stalled, then mirrors all in order', async scenario => {
  const f = fixture(':memory:', undefined, scenario);
  const auth = { type: 'bearer' as const, token: 'xoxb-fixture' };
  const row = buildConnectionRow({ name: scenario.vendor, auth, config: scenario.config });
  const middlewareRegistry = createMiddlewareRegistry(); registerFirstPartyMiddlewares(middlewareRegistry);
  let aiCalls = 0;
  const raw = createChatOrchestrator({ chatStore: f.store, selfSignature: signature, middlewareRegistry,
    registry: { list: () => [], listByTier: () => [], getByName: () => null, dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} },
    executeAiCall: async () => ({ body: { response: `answer ${++aiCalls}`, events: [], tool_calls: [] } }),
  });
  const orchestrator = withQueuedChatTurns(raw, { db: f.db, store: f.store, getKey: key, messengerBridge: f.bridge, pollMs: 5 });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  close.push(() => { release(); orchestrator.turnQueue!.close(); });
  const posts: Array<Record<string, unknown>> = [];
  const ingest = composeMessengerTurnIngest({ orchestrator, connectionStore: stubConnectionStore(row), fetchImpl: async (url, init) => {
    if (/\/(auth.test|getMe|users\/@me)$/.test(String(url))) return Response.json(scenario.identity);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; posts.push(body);
    if (posts.length === 1) await held;
    return Response.json({ ok: true, ts: `posted-${posts.length}`, id: String(posts.length + 100), result: { message_id: posts.length + 100 } });
  } })!;
  await ingest(scenario.vendor, scenario.vendor, scenario.inbound);
  await eventually(() => expect(posts).toHaveLength(1));
  for (let i = 1; i <= 10; i++) await handleSend({ store: f.store, orchestrator, selfSignature: signature }, {
    session_id: f.bound.session_id, message: `web exchange ${i}`, submission_id: `web-${i}`, picker_state: { current: 'self' },
  });
  await eventually(async () => expect((await f.store.listMessages(f.bound.session_id)).filter(m => m.role === 'assistant')).toHaveLength(11));
  expect(aiCalls).toBe(11);
  expect(posts).toHaveLength(1);
  release();
  await eventually(async () => expect((await f.bridge.snapshot(f.bound.session_id)).deliveries.every(d => d.state === 'sent')).toBe(true));
  expect(await f.bridge.nativeReply(f.bound.session_id, scenario.vendor, scenario.vendor === 'slack' ? 'posted-21' : '121'))
    .toMatchObject({ role: 'assistant', text: 'answer 11' });
  expect(posts.map(p => p.text ?? p.content)).toEqual(['answer 1', ...Array.from({ length: 10 }, (_, i) => [`Owner (via webclient)\nweb exchange ${i + 1}`, `answer ${i + 2}`]).flat()]);
  if (scenario.vendor === 'slack') expect(posts.every(p => p.mrkdwn === false && p.thread_ts === 'root-1')).toBe(true);
  if (scenario.vendor === 'telegram') expect(posts.every(p => p.message_thread_id === 77)).toBe(true);
  if (scenario.vendor === 'discord') expect(posts.every(p => p.enforce_nonce === true)).toBe(true);
  await ingest(scenario.vendor, scenario.vendor, scenario.echo);
  expect(aiCalls).toBe(11);
  // Deleting old retained history starts the 30-day redelivery fence at
  // deletion, even when the original admission is much older.
  f.db.prepare('UPDATE chat_native_admissions SET created_at = ?').run(Date.now() - 90 * 86400000);
  f.store.deleteSession(f.bound.session_id);
  await expect(ingest(scenario.vendor, scenario.vendor, scenario.inbound)).resolves.toBe(false);
  expect(f.store.getSession(f.bound.session_id)).toBeNull();
  const tombstone = f.db.prepare('SELECT * FROM chat_native_admissions').get();
  expect(tombstone).toMatchObject({ source_key: expect.stringMatching(/^[a-f0-9]{64}$/), session_id: null, deleted_at: expect.any(Number) });
  expect(JSON.stringify(tombstone)).not.toContain('native start');
});
