import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createMiddlewareRegistry } from '@recued/middleware';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createInboundFileCollection, type InboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createMessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleSend } from '../chat-handler.js';
import { composeMessengerTurnIngest } from '../composition/bin/wire-messenger-turn.js';
import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import { buildMessengerRemoteChannels } from '../composition/bin/messenger-transport-leaves.js';
import { createDiscordGatewayRunner, createSlackSocketRunner, createTelegramPollRunner,
  type MessengerIngressRunnerState } from '../messenger-ingress/local-runners.js';
import { buildConnectionRow } from './d-163-remote-channel-test-helpers.js';
import { createMockMessengerService, type MockMessengerEvent, type MockMessengerVendor } from './helpers/mock-messenger-service.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  // Fixtures reuse vendor conversation IDs but own separate databases. Do not
  // carry a prior fixture's in-process prompt backlog into its replacement.
  __clearSessionBriefs(); __clearUnfoldedUserMessages();
});
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'roundtrip-test' };
const key = () => new Uint8Array(32).fill(61);
const eventually = (assert: () => unknown | Promise<unknown>) => vi.waitFor(assert, { timeout: 8_000, interval: 10 });

const fixture = async (vendor: MockMessengerVendor, sharedFiles?: InboundFileCollection) => {
  const service = await createMockMessengerService(vendor);
  cleanup.push(() => service.close());
  const dir = mkdtempSync(join(tmpdir(), 'messenger-roundtrip-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'chat.sqlite');
  const db = new Database(path);
  ensureChatSchema(db);
  const store = createChatStore(db, key);
  const files = sharedFiles ?? createInboundFileCollection({ db, blobs: createEncryptedBlobStore(join(dir, 'cas'), key), slug: 'received',
    bus: createWarehouseEventBus(), gate: createStorageGate({ quota: 100_000_000, reservePct: 10, surface: 'collection:file:received' }),
  });
  cleanup.push(() => { if (db.open) db.close(); });
  const stateStore = createMessengerIngressStateStore(db);
  const connectionStore = createConnectionStore(db);
  connectionStore.upsert(buildConnectionRow({ name: vendor,
    auth: { type: 'bearer', token: service.botToken },
    config: vendor === 'telegram' ? { chat_id: service.recipient, ingress_mode: 'poll' }
      : { channel_id: service.recipient, ingress_mode: 'socket' },
  }));
  const bridge = createChatMessengerBridge({ db, store, getKey: key, pollMs: 5,
    minSendIntervalMs: 0, retryDelayMs: 5 });
  const middlewareRegistry = createMiddlewareRegistry();
  registerFirstPartyMiddlewares(middlewareRegistry);
  const prompts: string[] = [];
  let active = 0;
  let maxActive = 0;
  let releaseAi!: () => void;
  const heldAi = new Promise<void>(resolve => { releaseAi = resolve; });
  const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature, middlewareRegistry,
    registry: { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} },
    executeAiCall: async (_tool, args) => {
      const number = prompts.push(JSON.stringify(args));
      maxActive = Math.max(maxActive, ++active);
      try {
        if (number === 1) await heldAi;
        return { body: { response: `answer ${number}`, events: [], tool_calls: [] } };
      } finally { active--; }
    },
  });
  const orchestrator = withQueuedChatTurns(raw, { db, store, getKey: key, messengerBridge: bridge, pollMs: 5 });
  cleanup.push(async () => {
    releaseAi(); service.releasePosts();
    orchestrator.turnQueue!.close();
    await eventually(() => expect(active).toBe(0));
  });
  const messengerTurnIngest = composeMessengerTurnIngest({ orchestrator, connectionStore, fileCollection: files,
    downloadDir: join(dir, 'media'), fetchImpl: service.fetchImpl });
  const { messengerDispatchers } = composeInboundAnswerDispatcher({ messengerTurnIngest,
    messengerChannels: buildMessengerRemoteChannels({ connectionStore, transportOptions: { fetchImpl: service.fetchImpl } }),
  });
  const states: Array<{ state: MessengerIngressRunnerState; detail?: string }> = [];
  const options = { connectionName: vendor, credentialFingerprint: 'fixture-credential', stateStore,
    dispatch: messengerDispatchers[vendor]!, fetchImpl: service.fetchImpl, webSocketFactory: service.webSocketFactory,
    onState: (state: MessengerIngressRunnerState, detail?: string) => { states.push({ state, ...(detail ? { detail } : {}) }); },
    random: () => 0.1,
  };
  const runner = vendor === 'telegram' ? createTelegramPollRunner({ ...options, botToken: service.botToken })
    : vendor === 'slack' ? createSlackSocketRunner({ ...options, appToken: service.appToken })
      : createDiscordGatewayRunner({ ...options, botToken: service.botToken, boundChannelId: service.recipient });
  cleanup.push(() => runner.stop());
  runner.start();
  await eventually(() => expect(states.some(s => s.state === 'active')).toBe(true));

  const session = (): string => {
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    return sessions[0]!.id;
  };
  const acknowledged = (event: MockMessengerEvent): boolean => vendor === 'slack'
    ? service.acknowledgements.has(event.envelopeId)
    : Number(stateStore.get(vendor, vendor)?.state[vendor === 'telegram' ? 'offset' : 'sequence'] ?? 0)
      >= event.cursor + (vendor === 'telegram' ? 1 : 0);
  const caughtUp = async (count: number): Promise<void> => {
    await eventually(async () => {
      expect(service.posts).toHaveLength(count);
      const snapshot = await bridge.snapshot(session());
      // The public snapshot keeps only the latest 20 completed obligations;
      // native questions also have receipts, without another outbound post.
      const deliveries = db.prepare('SELECT state FROM chat_deliveries ORDER BY sequence').all();
      expect(deliveries).toEqual((await store.listMessages(session())).map(() => ({ state: 'sent' })));
      expect(snapshot.pending_count).toBe(0);
      expect(snapshot.deliveries.every(d => d.state === 'sent')).toBe(true);
      expect(acknowledged(service.posts[count - 1]!.echo)).toBe(true);
    });
    expect(service.errors).toEqual([]);
  };
  return { vendor, service, db, path, stateStore, store, files, bridge, orchestrator, states, messengerTurnIngest,
    prompts, releaseAi, session, acknowledged, caughtUp, get maxActive() { return maxActive; } };
};

it('does not acknowledge Slack file intake when the bot author identity cannot be verified', async () => {
  const f = await fixture('slack'); f.service.omitSenderIdentity();
  await expect(f.messengerTurnIngest!('slack', 'slack', { type: 'event_callback', event: { type: 'message', user: 'U1',
    channel: f.service.recipient, text: '', ts: '123.000001', files: [{ id: 'F1', mimetype: 'application/pdf', size: 10 }],
  } })).rejects.toThrow('author identity unavailable');
  expect(f.prompts).toEqual([]); expect(f.store.listSessions()).toEqual([]);
  expect(f.service.requests.some(r => r.path.endsWith('/files.info'))).toBe(false);
});

it('keeps identical native message IDs on different Messenger bindings from replacing retained files', async () => {
  const telegram = await fixture('telegram'); const discord = await fixture('discord', telegram.files);
  const nativeFile = { filename: 'same-name.pdf', mime_type: 'application/pdf', bytes: Buffer.from('%PDF-telegram-original') };
  telegram.service.receive('first file', '1', { file: nativeFile });
  await eventually(() => expect(telegram.prompts).toHaveLength(1));
  const firstId = (await telegram.store.listMessages(telegram.session()))[0]!.attachments![0]!.file_id;
  discord.service.receive('second file', '1', { file: { ...nativeFile, bytes: Buffer.from('%PDF-discord-original') } });
  await eventually(() => expect(discord.prompts).toHaveLength(1));
  const secondId = (await discord.store.listMessages(discord.session()))[0]!.attachments![0]!.file_id;
  expect(secondId).not.toBe(firstId);
  expect((await telegram.files.readBytes(firstId)).bytes).toEqual(nativeFile.bytes);
  expect((await telegram.files.readBytes(secondId)).bytes).toEqual(Buffer.from('%PDF-discord-original'));
  telegram.releaseAi(); discord.releaseAi();
  await Promise.all([telegram.caughtUp(1), discord.caughtUp(1)]);
});

describe.each(['telegram', 'slack', 'discord'] as const)('D-265 %s receive/send join', vendor => {
  it('roundtrips quoted replies through the native APIs and retained Chats history', async () => {
    const f = await fixture(vendor);
    const rootId = vendor === 'slack' ? f.service.thread : '1';
    const initial = f.service.receive('original native question', rootId);
    await eventually(() => { expect(f.acknowledged(initial)).toBe(true); expect(f.prompts).toHaveLength(1); });
    f.releaseAi(); await f.caughtUp(1);
    const session_id = f.session();
    const [root, answer] = await f.store.listMessages(session_id);
    expect(root!.reply_to).toBeUndefined();
    await handleSend({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature }, {
      session_id, message: 'web quoted reply', reply_to_message_id: answer!.id,
      submission_id: 'quoted-web', picker_state: { current: 'self' },
    });
    await f.caughtUp(3);
    const web = (await f.store.listMessages(session_id)).find(message => message.content === 'web quoted reply')!;
    expect(web.reply_to).toEqual({ message_id: answer!.id, preview: { role: 'assistant', text: 'answer 1' } });
    const sent = f.service.posts[1]!;
    if (vendor === 'telegram') expect(sent.body.reply_parameters).toEqual({ message_id: Number(f.service.posts[0]!.id) });
    else if (vendor === 'discord') expect(sent.body.message_reference).toMatchObject({ message_id: f.service.posts[0]!.id });
    else {
      expect(sent.body.thread_ts).toBe(rootId);
      expect(sent.text).toBe('Replying to Recued: answer 1\n\nOwner (via webclient)\nweb quoted reply');
      expect(sent.body.mrkdwn).toBe(false);
    }

    // Slack quotes the thread parent; Telegram and Discord carry the exact
    // native post selected by the owner, including a mirrored web user row.
    const followup = f.service.receive('native quoted followup', '2', { replyTo: sent.id });
    await eventually(() => expect(f.acknowledged(followup)).toBe(true));
    await f.caughtUp(4);
    const expected = vendor === 'slack' ? root! : web;
    const reopened = createChatStore(f.db, key);
    const native = (await reopened.listMessages(session_id)).find(message => message.content === 'native quoted followup')!;
    expect(native.reply_to).toEqual({ message_id: expected.id, vendor,
      native_message_id: vendor === 'slack' ? rootId : sent.id,
      preview: { role: expected.role, text: expected.content },
    });
    expect(f.prompts[2]).toContain(expected.content);
    expect(f.prompts).toHaveLength(3); expect(f.maxActive).toBe(1);
  });

  it('retains native files and mirrors web attachments once through real multipart/upload endpoints', async () => {
    const f = await fixture(vendor);
    const nativeFile = { filename: 'Native résumé 📄.pdf', mime_type: 'application/pdf', bytes: Buffer.from('%PDF-native-original\0') };
    const native = f.service.receive('native attachment', '1', { file: nativeFile });
    await eventually(() => { expect(f.acknowledged(native)).toBe(true); expect(f.prompts).toHaveLength(1); });
    const session_id = f.session();
    const first = (await f.store.listMessages(session_id))[0]!;
    expect(first.attachments).toHaveLength(1);
    const retained = await f.files.readBytes(first.attachments![0]!.file_id);
    expect(retained.bytes).toEqual(nativeFile.bytes); expect(retained.filename).toBe(nativeFile.filename);
    expect(f.service.posts).toEqual([]);
    const webBytes = Buffer.from('OggS-web-original-audio\0');
    const web = await f.files.ingest({ bytes: webBytes, filename: 'Web voice 🐈.ogg', mime_type: 'audio/ogg',
      origin: 'webclient_upload', source_id: 'web-upload',
    });
    // Different clients submit the same final file reference. Admission dedup
    // must prevent both an extra AI call and a second attachment publication.
    await Promise.all(['A', 'B'].map(client => handleSend({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature }, {
      session_id, message: 'web attachment', submission_id: `client-${client}`, picker_state: { current: 'self' },
      attachments: [{ file_id: web.record_id, media_class: 'voice' }],
    })));
    f.releaseAi(); await f.caughtUp(4);
    const posts = f.service.posts;
    expect(posts.map(p => p.text)).toEqual(['answer 1', 'Owner (via webclient)\nweb attachment', '', 'answer 2']);
    expect(posts[2]!.file).toMatchObject({ filename: 'Web voice 🐈.ogg', bytes: webBytes });
    expect(f.prompts).toHaveLength(2); expect(f.maxActive).toBe(1);
    const messages = await f.store.listMessages(session_id);
    expect(messages).toHaveLength(4); expect(messages[2]!.attachments).toMatchObject([{ source_file_id: web.record_id, media_class: 'voice', availability: 'available' }]);
    if (vendor === 'slack') {
      expect(posts[2]!.body).toMatchObject({ channel_id: f.service.recipient, thread_ts: f.service.thread });
      expect(f.db.prepare("SELECT vendor_file_id, vendor_message_id FROM chat_delivery_chunks WHERE kind = 'attachment'").get())
        .toEqual({ vendor_file_id: 'F1', vendor_message_id: null });
    } else {
      expect(await f.bridge.nativeReply(session_id, vendor, posts[2]!.id)).toMatchObject({ message_id: messages[2]!.id });
      if (vendor === 'telegram') expect(posts[2]!.body).toMatchObject({ chat_id: f.service.recipient,
        message_thread_id: 77, reply_parameters: { message_id: Number(posts[1]!.id) } });
      else expect(posts[2]!.body).toMatchObject({ message_reference: { message_id: posts[1]!.id },
        allowed_mentions: { parse: [], replied_user: false }, enforce_nonce: true });
    }
  });

  it('mirrors ten exchanges from two webclients, then continues natively in the same retained conversation', async () => {
    const f = await fixture(vendor);
    f.service.holdPosts();
    const native = f.service.receive('native start', '1');
    await eventually(() => {
      expect(f.acknowledged(native)).toBe(true);
      expect(f.prompts).toHaveLength(1);
    });
    const session_id = f.session();
    expect(f.bridge.binding(session_id)).toMatchObject({ vendor, recipient: f.service.recipient });
    // Vendor acknowledgement means SQLite owns the input, even while the AI
    // call is held. A separate database handle observes the durable receipt.
    const persisted = new Database(f.path, { readonly: true });
    try {
      expect(persisted.prepare('SELECT status FROM chat_turn_queue').all()).toEqual([{ status: 'running' }]);
      expect(persisted.prepare('SELECT message_id FROM chat_native_receipts').all()).toEqual([{ message_id: '1' }]);
    } finally { persisted.close(); }

    const send = (client: string, number: number) => handleSend({ store: f.store,
      orchestrator: f.orchestrator, selfSignature: signature }, {
      session_id, message: `web exchange ${number}`, submission_id: `${client}-${number}`,
      picker_state: { current: 'self' },
    });
    for (let number = 1; number <= 10; number++) {
      // Two independent callers race with the same text. Only one is executed,
      // even though both get their own durable submission acknowledgement.
      await Promise.all([send('webclient-A', number), send('webclient-B', number)]);
    }
    expect(f.db.prepare('SELECT status, duplicate_count FROM chat_turn_queue ORDER BY position').all())
      .toEqual([{ status: 'running', duplicate_count: 0 },
        ...Array.from({ length: 10 }, () => ({ status: 'queued', duplicate_count: 1 }))]);
    expect(f.prompts).toHaveLength(1);
    f.releaseAi();
    await eventually(async () => expect((await f.store.listMessages(session_id)).filter(m => m.role === 'assistant')).toHaveLength(11));
    expect(f.service.posts).toHaveLength(1);
    f.service.releasePosts();
    await f.caughtUp(21);
    const expected = ['native start', 'answer 1',
      ...Array.from({ length: 10 }, (_, i) => [`web exchange ${i + 1}`, `answer ${i + 2}`]).flat()];
    expect((await f.store.listMessages(session_id)).map(m => m.content)).toEqual(expected);
    expect(f.service.posts.map(p => p.text)).toEqual(['answer 1',
      ...Array.from({ length: 10 }, (_, i) => [`Owner (via webclient)\nweb exchange ${i + 1}`, `answer ${i + 2}`]).flat()]);

    const lastReply = f.service.posts[20]!;
    const followup = f.service.receive('continue after web exchange 10', '2', { replyTo: lastReply.id });
    await eventually(() => expect(f.acknowledged(followup)).toBe(true));
    await f.caughtUp(22);
    // The next native turn sees the current webclient context under the
    // existing bounded prompt policy. The complete transcript is checked
    // separately below; prompt compaction need not copy every older answer.
    // Every bot echo has already crossed the real receive runner.
    expect(f.prompts).toHaveLength(12);
    for (const text of ['native start', 'answer 10', 'answer 11',
      ...Array.from({ length: 10 }, (_, i) => `web exchange ${i + 1}`)]) expect(f.prompts[11]).toContain(text);
    expect(f.maxActive).toBe(1);
    expect((await f.store.listMessages(session_id)).map(m => m.content))
      .toEqual([...expected, 'continue after web exchange 10', 'answer 12']);
    const messages = await f.store.listMessages(session_id);
    for (let index = 0; index < f.service.posts.length; index++) {
      const post = f.service.posts[index]!;
      const message = messages[index < 21 ? index + 1 : 23]!;
      expect(await f.bridge.nativeReply(session_id, vendor, post.id))
        .toMatchObject({ message_id: message.id, text: message.content, role: message.role });
    }
    if (vendor === 'telegram') {
      expect(f.service.posts.every(p => p.body.chat_id === f.service.recipient && p.body.message_thread_id === 77)).toBe(true);
      expect(f.service.posts[21]!.body.reply_parameters).toEqual({ message_id: 2 });
    } else if (vendor === 'slack') {
      expect(f.service.posts.every(p => p.body.channel === f.service.recipient && p.body.thread_ts === f.service.thread && p.body.mrkdwn === false)).toBe(true);
    } else {
      expect(f.service.posts.every(p => p.body.enforce_nonce === true)).toBe(true);
      expect(new Set(f.service.posts.map(p => p.body.nonce)).size).toBe(22);
      expect(f.service.posts[21]!.body.message_reference).toMatchObject({ message_id: '2' });
    }
    expect(f.states.filter(s => s.state === 'retrying' || s.state === 'error')).toEqual([]);
  }, 20_000);

  it('does not acknowledge failed admission, then replays the native message once after storage recovers', async () => {
    const f = await fixture(vendor);
    f.db.exec(`CREATE TRIGGER reject_native BEFORE INSERT ON chat_native_receipts
      WHEN NEW.message_id = '1' BEGIN SELECT RAISE(ABORT, 'mock admission disk failure'); END`);
    const native = f.service.receive('must survive failed admission', '1');
    // A later harmless event in the SAME socket burst must not advance a
    // cumulative cursor past the failed user input (Discord in particular).
    f.service.receive('unrelated bot echo', '900', { bot: true });
    // Keep the fault through one reconnect, including Discord's RESUMED after
    // its replay burst. That control event must obey the same durable fence.
    await eventually(() => expect(f.states.filter(s => s.state === 'retrying'
      && s.detail?.includes('mock admission disk failure')).length).toBeGreaterThanOrEqual(2));
    expect(f.acknowledged(native)).toBe(false);
    expect(f.db.prepare('SELECT * FROM chat_turn_queue').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM chat_native_admissions').all()).toEqual([]);
    expect(f.prompts).toEqual([]);
    expect(f.service.posts).toEqual([]);
    f.db.exec('DROP TRIGGER reject_native');
    await eventually(() => {
      expect(f.acknowledged(native)).toBe(true);
      expect(f.prompts).toHaveLength(1);
    });
    if (vendor === 'discord') expect(f.service.frames.find(frame => frame.body.op === 6)?.body.d)
      .toMatchObject({ session_id: 'fixture-session', seq: 10 });
    f.releaseAi();
    await f.caughtUp(1);
    expect((await f.store.listMessages(f.session())).map(m => m.content))
      .toEqual(['must survive failed admission', 'answer 1']);
    expect(f.db.prepare('SELECT message_id FROM chat_native_receipts').all()).toEqual([{ message_id: '1' }]);
    expect(f.prompts).toHaveLength(1);
  }, 15_000);

  it('replays a lost receive acknowledgement without executing or delivering the accepted input twice', async () => {
    const f = await fixture(vendor);
    if (vendor === 'slack') f.service.loseAcknowledgement();
    else f.db.exec(`CREATE TRIGGER reject_cursor BEFORE ${vendor === 'telegram' ? 'INSERT' : 'UPDATE'} ON messenger_ingress_state
      BEGIN SELECT RAISE(ABORT, 'mock cursor disk failure'); END`);
    const native = f.service.receive('accepted before acknowledgement loss', '1');
    await eventually(() => expect(vendor === 'slack'
      ? f.service.lostAcknowledgements.includes(native.envelopeId)
      : f.states.some(s => s.state === 'retrying')).toBe(true));
    expect(f.db.prepare('SELECT message_id FROM chat_native_receipts').all()).toEqual([{ message_id: '1' }]);
    expect(f.acknowledged(native)).toBe(false);
    if (vendor !== 'slack') f.db.exec('DROP TRIGGER reject_cursor');
    await eventually(() => expect(f.acknowledged(native)).toBe(true));
    // Also redeliver the same vendor message with a NEW envelope/sequence;
    // dedup must use its native message identity, not the receive cursor.
    const redelivery = f.service.receive('accepted before acknowledgement loss', '1');
    await eventually(() => expect({ acknowledged: f.acknowledged(redelivery),
      failures: f.states.filter(s => s.state === 'retrying').map(s => s.detail) })
      .toMatchObject({ acknowledged: true }));
    f.releaseAi();
    await f.caughtUp(1);
    expect(f.prompts).toHaveLength(1);
    expect((await f.store.listMessages(f.session())).map(m => m.content))
      .toEqual(['accepted before acknowledgement loss', 'answer 1']);
    expect(f.db.prepare('SELECT message_id FROM chat_native_receipts').all()).toEqual([{ message_id: '1' }]);
    const completedReplay = f.service.receive('accepted before acknowledgement loss', '1');
    await eventually(() => expect(f.acknowledged(completedReplay)).toBe(true));
    expect(f.prompts).toHaveLength(1);
    expect(f.service.posts).toHaveLength(1);
  }, 15_000);
});
