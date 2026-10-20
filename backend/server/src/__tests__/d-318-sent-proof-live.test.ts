/** D-318 steps 2 and 3 — proof (a), and the turn a proven request becomes,
 *  through the server's real composition.
 *
 *  ⛔ WHY THE REAL CONTEXTS. The proof rides four seams that each typecheck with
 *  a field dropped: the collection context builds it over the server's database
 *  and the door, `composeMailBoot` forwards its hook to `composeMailStack`,
 *  which forwards it to each `createMailCollection` as `onMessageStored`; and
 *  the lookup runs in the real Gmail provider. So this composes the server's
 *  storage, app and collection contexts over one SQLite file, and only the
 *  network is scripted: `globalThis.fetch`, behind the production fetcher,
 *  answers as Gmail for two accounts — the chat mailbox and the owner's.
 *
 *      the owner's Gmail (scripted: a Sent copy) ─┐
 *      the chat mailbox's Gmail (scripted: what arrived) → real provider → real
 *        mail collection → the stored hook → the proof → the owner mailbox's
 *        real `lookupSentByMessageId` → proven, or waiting
 *
 *  The ten-minute give-up and its notice are pinned in `d-318-sent-proof.test.ts`
 *  over an injected clock; here the forged request is shown waiting, never
 *  proven, and the owner's mailbox is never asked for a stranger's mail.
 *
 *  Step 3 adds the server's own chat: the app context's queued chat
 *  orchestrator over the late-bound execution context, a model scripted at the
 *  same network edge (an OpenAI-compatible endpoint in the free pool, there at
 *  boot), and the turns bound to the proof as compose-listeners binds them.
 *  ⚠ Found building it: chat asks the free pool for a speed tier other than
 *  `quality` here, so the scripted model is offered at every tier. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { GMAIL_SEND_SCOPE } from '../collections/mail/gmail-provider.js';
import type { MailCollection } from '../collections/mail/mail-collection.js';
import { createLLMConfigManager } from '../llm-config.js';
import { materializeMailBody } from '../mail-body-read-handler.js';
import { composeMailChatAnswers, type MailChatAnswers } from '../mail-chat-door/answers.js';
import { composeMailChatTurns } from '../mail-chat-door/turns.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import {
  composeExecutionContext,
  createExecutionLateBoundRefs,
} from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const CHAT_ADDRESS = 'recued@chat.example';
const OWNER_ADDRESS = 'me@owner.example';

let tmp: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

interface ScriptedMessage {
  readonly id: string;
  readonly at: number;
  readonly labels: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly messageId: string;
  /** The `References` header, when it is a reply. */
  readonly references?: string;
  /** The `In-Reply-To` header. */
  readonly inReplyTo?: string;
  readonly body?: string;
  /** A whole MIME body (with its own Content-Type), in place of the plain one. */
  readonly mime?: { readonly contentType: string; readonly body: string };
  /** Its attachment parts, as Gmail's `format=full` payload lists them — what
   *  a Gmail sync stores. */
  readonly parts?: ReadonlyArray<{
    filename: string; mimeType: string; headers: Array<{ name: string; value: string }>; data: Buffer;
  }>;
  /** Step 5 — the whole message as Gmail keeps it, for one Recued sent. */
  readonly source?: string;
  /** Its Gmail thread, when not its own. */
  readonly threadId?: string;
}

/** Gmail's own stamp on mail delivered from `address`, in the shape measured on
 *  a real Gmail inbox (2026-10-15): on top of every message Gmail delivers. */
const gmailStamp = (address: string): string => {
  const domain = address.slice(address.indexOf('@') + 1);
  return `mx.google.com;       dkim=pass header.i=@${domain} header.s=selector1 header.b=hJxoxgU2;       `
    + `arc=pass (i=1);       spf=pass (google.com: domain of ${address} designates 2001:db8::2 as permitted `
    + `sender) smtp.mailfrom=${address};       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=${domain}`;
};

/** A header of a whole message, unfolded. */
const headerOf = (source: string, name: string): string | undefined => {
  const head = source.split(/\r\n\r\n/)[0]!.replace(/\r\n[ \t]+/g, ' ');
  const line = head.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
};

const raw = (m: ScriptedMessage): string => m.source ?? [
  `From: ${m.from}`,
  `To: ${m.to}`,
  `Subject: ${m.subject}`,
  `Message-ID: <${m.messageId}>`,
  ...(m.references !== undefined ? [`References: ${m.references}`] : []),
  ...(m.inReplyTo !== undefined ? [`In-Reply-To: ${m.inReplyTo}`] : []),
  `Date: ${new Date(m.at).toUTCString()}`,
  ...(m.mime !== undefined
    ? ['MIME-Version: 1.0', `Content-Type: ${m.mime.contentType}`, '', m.mime.body]
    : ['Content-Type: text/plain; charset=utf-8', '', m.body ?? 'what is on today?']),
  '',
].join('\r\n');

/** A model the server can call, as an OpenAI-compatible endpoint answers. */
const LLM_BASE_URL = 'https://llm.example.test/v1';

/** Two Gmail accounts, told apart by the access token each request carries;
 *  and, when given, a model answering at `LLM_BASE_URL` with the text `model`
 *  returns for the request body it was sent. */
const scriptGmail = (
  accounts: Record<string, { address: string; mailbox: ScriptedMessage[] }>,
  model?: (requestBody: string) => string,
) => {
  const sentLookups: Array<{ token: string; q: string }> = [];
  /** Step 5 — what each account sent through Gmail, as Gmail took it. */
  const sent: Array<{ token: string; source: string; threadId?: string }> = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (model !== undefined && url.href === `${LLM_BASE_URL}/chat/completions`) {
      const content = model(typeof init?.body === 'string' ? init.body : '');
      return json({
        id: 'cmpl-1',
        object: 'chat.completion',
        model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    const headers = new Headers(init?.headers);
    const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const account = accounts[token];
    if (account === undefined) return json({ error: `unscripted token for ${url.href}` }, 401);
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    // Step 5 — a send: Gmail gives the message its own Message-ID and From,
    // keeps it in the sender's Sent, and delivers it to any scripted account
    // it is addressed to.
    if (path === '/messages/send' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { raw: string; threadId?: string };
      const given = Buffer.from(body.raw, 'base64url').toString('utf8');
      const n = sent.push({ token, source: given, ...(body.threadId ? { threadId: body.threadId } : {}) });
      const messageId = `CAgmail-${n}@mail.gmail.com`;
      const source = `From: ${account.address}\r\nMessage-ID: <${messageId}>\r\n${given}`;
      const copy = {
        at: Date.now(), from: account.address, to: headerOf(given, 'To') ?? '', subject: headerOf(given, 'Subject') ?? '',
        messageId, source,
      };
      const threadId = body.threadId ?? `sent-${n}`;
      // §8.18 — mail to oneself: Gmail keeps ONE message, in Sent and the inbox.
      const toItself = copy.to.toLowerCase().includes(account.address.toLowerCase());
      account.mailbox.push({ ...copy, id: `sent-${n}`, labels: toItself ? ['SENT', 'INBOX'] : ['SENT'], threadId });
      for (const other of Object.values(accounts)) {
        if (other !== account && copy.to.includes(other.address)) {
          // Delivered as Gmail delivers: its stamp on top.
          other.mailbox.push({
            ...copy, id: `delivered-${n}`, labels: ['INBOX'],
            source: `Authentication-Results: ${gmailStamp(account.address)}\r\n${copy.source}`,
          });
        }
      }
      return json({ id: `sent-${n}`, threadId });
    }
    if (path === '/profile') return json({ emailAddress: account.address, historyId: '100' });
    if (path === '/history') return json({ historyId: '100' });
    if (path === '/messages') {
      const q = url.searchParams.get('q') ?? '';
      if (q.startsWith('rfc822msgid:')) {
        sentLookups.push({ token, q });
        const wanted = q.slice('rfc822msgid:'.length);
        const labels = url.searchParams.getAll('labelIds');
        const hits = account.mailbox.filter((m) =>
          m.messageId === wanted && labels.every((label) => m.labels.includes(label)));
        return json({ messages: hits.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })), resultSizeEstimate: hits.length });
      }
      // A list by label (the Sent record's), or the whole mailbox (a sync).
      const labels = url.searchParams.getAll('labelIds');
      const listed = account.mailbox.filter((m) => labels.every((label) => m.labels.includes(label)));
      return json({ messages: listed.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })), resultSizeEstimate: listed.length });
    }
    // A thread, read as headers: the chat mailbox asking whether it already
    // answered a request (the answer is sent into the request's thread).
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread !== null && url.searchParams.get('format') === 'metadata') {
      const id = decodeURIComponent(thread[1]!);
      const names = url.searchParams.getAll('metadataHeaders');
      return json({
        id,
        messages: account.mailbox.filter((m) => (m.threadId ?? m.id) === id).map((m) => ({
          id: m.id,
          threadId: id,
          labelIds: m.labels,
          internalDate: String(m.at),
          payload: {
            headers: names.flatMap((name) => {
              const value = headerOf(raw(m), name);
              return value === undefined ? [] : [{ name, value }];
            }),
          },
        })),
      });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    const message = one ? account.mailbox.find((m) => m.id === decodeURIComponent(one[1]!)) : undefined;
    if (message !== undefined && url.searchParams.get('format') === 'raw') {
      return json({
        id: message.id,
        threadId: message.threadId ?? message.id,
        labelIds: message.labels,
        raw: Buffer.from(raw(message)).toString('base64url'),
        internalDate: String(message.at),
      });
    }
    if (message !== undefined && url.searchParams.get('format') === 'full') {
      return json({
        id: message.id,
        threadId: message.threadId ?? message.id,
        labelIds: message.labels,
        internalDate: String(message.at),
        payload: {
          mimeType: 'multipart/mixed',
          parts: (message.parts ?? []).map((part, i) => ({
            partId: String(i + 1),
            mimeType: part.mimeType,
            filename: part.filename,
            headers: part.headers,
            body: { size: part.data.length, data: part.data.toString('base64url') },
          })),
        },
      });
    }
    if (message !== undefined && url.searchParams.get('format') === 'metadata') {
      const source = message.source;
      return json({
        id: message.id,
        threadId: message.threadId ?? message.id,
        labelIds: message.labels,
        internalDate: String(message.at),
        ...(source !== undefined ? { sizeEstimate: Buffer.byteLength(source) } : {}),
        payload: {
          headers: source !== undefined
            // The headers asked for, as a message Recued sent carries them.
            ? url.searchParams.getAll('metadataHeaders').flatMap((name) => {
                const value = headerOf(source, name);
                return value === undefined ? [] : [{ name, value }];
              })
            : [
                { name: 'Message-ID', value: `<${message.messageId}>` },
                { name: 'To', value: message.to },
                { name: 'Subject', value: message.subject },
              ],
        },
      });
    }
    return json({ error: `unscripted ${url.href}` }, 404);
  });
  return { sentLookups, sent };
};

const bootLive = async (opts: { model?: boolean; oneMailbox?: boolean; bothSend?: boolean } = {}) => {
  tmp = mkdtempSync(join(tmpdir(), 'd-318-proof-live-'));
  const dbPath = join(tmp, 'server.db');
  const runtimeConfig = createRuntimeConfigStore({});
  const storage = await composeStorageContext({
    dbPath,
    bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
    runtimeConfig,
    vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 },
  });
  // The owner's model, there before the server starts, as a server's is.
  if (opts.model) {
    for (const speed of ['fast', 'quality', 'thinking'] as const) {
      createLLMConfigManager(storage.db!).upsertPoolEntry({
        id: `free-${speed}`, type: 'api', provider: 'openai-compatible', model: 'test-model', api_key: 'k',
        base_url: LLM_BASE_URL, speed, supports_json: true, enabled: true,
      });
    }
  }
  const lateBound = createExecutionLateBoundRefs();
  const app = composeAppContext({
    db: storage.db,
    dbPath,
    envLlmConfig: storage.envLlmConfig,
    gateRegistry: storage.gateRegistry,
    auditLog: storage.auditLog,
    eventBus: storage.eventBus,
    serverInstanceId: storage.serverInstanceId,
    recipeStore: storage.recipeStore,
    pairedInstances: storage.pairedInstances,
    workEntityStore: storage.workEntityStoreRef,
    // The chat reads its tools through these, bound once the execution
    // context is composed below — as the server binds them.
    chatLateBound: lateBound,
  });
  await unlockServerVault(app.keys!);
  const collection = composeCollectionContext({
    db: storage.db,
    dbPath,
    runtimeConfig,
    manifests: storage.manifests,
    baseVault: storage.baseVault,
    auditLog: storage.auditLog,
    cacheBlobs: app.cacheBlobs,
    warehouseBus: app.warehouseBus,
    contactStore: app.contactStoreRef,
    mailFactStore: storage.mailFactStoreRef,
    gateRegistry: storage.gateRegistry,
    accountStore: storage.accountStore,
    eventBus: storage.eventBus,
    keys: app.keys,
    connectionStore: app.connectionStoreRef,
    workEntityStore: storage.workEntityStoreRef,
    enrichmentCascade: app.enrichmentCascadeRef,
    // As the server passes it: what links a received file to its email, so the
    // mail sync stores attachments.
    ...(app.annotationDeps ? { annotationDeps: app.annotationDeps } : {}),
  });
  await composeExecutionContext({ storage, app, collection, baseVault: storage.baseVault, lateBound, env: {} });

  createOAuthAppConfigStore(storage.db!, { getEncryptionKey: app.keys!.keyProvider('server-data') })
    .setIssuer('google', 'client-id', 'client-secret');
  // §8.18 — one mailbox: the owner's own Gmail alone, which is the chat mailbox too.
  const accounts = opts.oneMailbox
    ? [['me', OWNER_ADDRESS, 'at-me']] as const
    : [['recued-chat', CHAT_ADDRESS, 'at-chat'], ['me', OWNER_ADDRESS, 'at-me']] as const;
  const chatSlug = opts.oneMailbox ? 'me' : 'recued-chat';
  for (const [slug, address, token] of accounts) {
    await storage.accountStore!.set(`gmail.${slug}.access_token`, token);
    await storage.accountStore!.set(`gmail.${slug}.refresh_token`, `rt-${slug}`);
    await storage.accountStore!.set(`gmail.${slug}.expires_at`, String(Date.now() + 3_600_000));
    // The chat mailbox can send, as the door requires (D-127).
    if (slug === chatSlug || opts.bothSend) await storage.accountStore!.set(`gmail.${slug}.granted_scopes`, GMAIL_SEND_SCOPE);
    collection.mailStack!.instances.upsert({
      platform: 'mail',
      slug,
      adapter_type: 'gmail',
      config: { account_email: address },
      caps: {},
      auth_state: 'healthy',
      last_synced_at: null,
    } as never);
  }
  collection.mailChatDoor!.setChatMailbox(chatSlug, opts.oneMailbox ? OWNER_ADDRESS : CHAT_ADDRESS);
  // The owner names their own mailbox: its Sent record alone proves a request.
  collection.mailChatDoor!.setOwnerMailboxes(['me']);

  const close = async (): Promise<void> => {
    await collection.mailChatProof?.dispose();
    app.chatOrchestratorRef?.turnQueue?.close();
    await collection.mailStack!.disposeAll();
    storage.db?.close();
  };
  return { storage, app, collection, proof: collection.mailChatProof!, mailStack: collection.mailStack!, close };
};

describe('D-318 step 2, live — a request proven by the owner’s own Sent record', () => {
  it('proves the owner’s request by their Gmail Sent copy; a forged one and a stranger’s are not proven', async () => {
    const chatMailbox: ScriptedMessage[] = [];
    const ownerMailbox: ScriptedMessage[] = [];
    const { sentLookups } = scriptGmail({
      'at-chat': { address: CHAT_ADDRESS, mailbox: chatMailbox },
      'at-me': { address: OWNER_ADDRESS, mailbox: ownerMailbox },
    });
    const live = await bootLive();
    try {
      // The first syncs are backfills; nothing they find is a request.
      await live.mailStack.startAll();
      const notify = vi.fn(async () => undefined);
      // As compose-listeners does, once every mailbox is registered.
      live.proof.bindNotify(notify);
      live.proof.start();

      await live.mailStack.pauseSync();
      const now = Date.now();
      const request = {
        at: now - 20_000, from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'ask: what is on today?', messageId: 'req-1@owner.example',
      };
      // The owner wrote from their own Gmail: the copy that arrived in the chat
      // mailbox, and the Sent copy in theirs, under one Message-ID.
      chatMailbox.push({ ...request, id: 'c1', labels: ['INBOX'] });
      ownerMailbox.push({ ...request, id: 'o1', labels: ['SENT'] });
      // Anyone can write the owner's address in From; no Sent copy exists.
      chatMailbox.push({ ...request, id: 'c2', labels: ['INBOX'], messageId: 'forged-1@owner.example' });
      // A stranger writes to the chat mailbox.
      chatMailbox.push({ ...request, id: 'c3', labels: ['INBOX'], from: 'stranger@else.example', messageId: 'spam-1@else.example' });
      await live.mailStack.resumeSync();

      await vi.waitFor(() => {
        expect(live.proof.get('recued-chat', 'req-1@owner.example')).toMatchObject({ state: 'proven', proven_by: 'me' });
        expect(live.proof.get('recued-chat', 'forged-1@owner.example')).toMatchObject({ state: 'pending', attempts: 1 });
        expect(live.proof.get('recued-chat', 'spam-1@else.example')).toMatchObject({ state: 'ignored', reason: 'not_owner' });
      }, { timeout: 10_000 });

      // Only the owner's account was asked, and only for what claimed to be theirs.
      expect(sentLookups.map((l) => l.token)).toEqual(['at-me', 'at-me']);
      expect(sentLookups.map((l) => l.q).sort()).toEqual([
        'rfc822msgid:forged-1@owner.example',
        'rfc822msgid:req-1@owner.example',
      ]);
      // The Sent copy synced into the owner's own mailbox is not a request.
      expect(live.proof.get('me', 'req-1@owner.example')).toBeNull();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await live.close();
    }
  }, 60_000);

  it('the server composition starts the proof with the owner’s notice, and stops it at shutdown', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const listeners = readFileSync(resolve(here, '..', 'serve/compose-listeners.ts'), 'utf-8');
    expect(listeners).toContain('mailChatProof.bindNotify((message, extras) => notifier.notify(message, undefined, extras));');
    expect(listeners).toContain('mailChatProof.start();');
    expect(listeners).toContain('...(mailChatProof !== undefined ? [begin(() => mailChatProof.dispose())] : []),');
    // Started after the mailboxes are registered: the listeners are composed
    // after `startBootRecoveryAndAdapters`.
    const recovery = readFileSync(resolve(here, '..', 'serve/start-lifecycle-recovery-pre-listener-runtime.ts'), 'utf-8');
    expect(recovery.indexOf('await startBootRecoveryAndAdapters(')).toBeGreaterThan(-1);
    expect(recovery.indexOf('await startBootRecoveryAndAdapters('))
      .toBeLessThan(recovery.indexOf('const listenerRuntime = await startPreListenerRuntime('));
  });
});

describe('D-318 step 3, live — a proven request runs as a chat turn', () => {
  it('runs through the server’s own chat orchestrator and queue, in its own conversation, and a reply continues it', async () => {
    const chatMailbox: ScriptedMessage[] = [];
    const ownerMailbox: ScriptedMessage[] = [];
    const modelBodies: string[] = [];
    scriptGmail({
      'at-chat': { address: CHAT_ADDRESS, mailbox: chatMailbox },
      'at-me': { address: OWNER_ADDRESS, mailbox: ownerMailbox },
    }, (body) => {
      modelBodies.push(body);
      // Chat's main turn asks for JSON: its answer in `response`.
      return JSON.stringify({ response: `answer ${modelBodies.length}`, tool_calls: [] });
    });
    const live = await bootLive({ model: true });
    try {
      // Chat set to use the free pool.
      live.app.chatDeps!.store.setDefaultModelSourceId('free_pool');
      await live.mailStack.startAll();
      // As compose-listeners does: the turns over the server's own chat
      // orchestrator, handed to the proof before it starts.
      const conversations = live.collection.mailChatConversations!;
      const turns = composeMailChatTurns({
        orchestrator: live.app.chatOrchestratorRef!,
        door: live.collection.mailChatDoor!,
        mailboxes: () => live.collection.collectionRegistry.list()
          .filter((entry): entry is MailCollection => entry.platform === 'mail'),
        readBody: (record) => materializeMailBody(record, live.app.cacheBlobs!),
        conversations,
      })!;
      live.proof.bindAdmit(turns.admit);
      live.proof.start();

      await live.mailStack.pauseSync();
      const at = Date.now() - 20_000;
      const request = {
        at, from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'ask: what is on today?', messageId: 'req-1@owner.example',
      };
      chatMailbox.push({ ...request, id: 'c1', labels: ['INBOX'] });
      ownerMailbox.push({ ...request, id: 'o1', labels: ['SENT'] });
      await live.mailStack.resumeSync();

      await vi.waitFor(() => expect(live.proof.get('recued-chat', 'req-1@owner.example'))
        .toMatchObject({ state: 'proven', admit_state: 'admitted' }), { timeout: 10_000 });
      const conversation = conversations.conversationOf('recued-chat', 'req-1@owner.example');
      const session = `mail:recued-chat:${conversation}`;
      const store = live.app.chatDeps!.store;
      await vi.waitFor(async () => expect((await store.listMessages(session)).map((m) => [m.role, m.content])).toEqual([
        ['user', 'what is on today?'],
        ['assistant', 'answer 1'],
      ]), { timeout: 10_000 });
      expect(store.getSession(session)?.title).toBe('what is on today?');
      expect(modelBodies[0]).toContain('what is on today?');
      const recall = live.storage.db!.prepare(
        'SELECT recall_eligibility AS r FROM chat_messages WHERE session_id = ? ORDER BY ts',
      ).all(session) as Array<{ r: string }>;
      expect(recall.map((row) => row.r)).toEqual(['messenger:not_owner_authenticated', 'messenger:not_owner_authenticated']);

      // The owner replies to their own request: the same conversation.
      await live.mailStack.pauseSync();
      const reply = {
        at: Date.now() - 5_000, from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'Re: ask: what is on today?',
        messageId: 'req-2@owner.example', references: '<req-1@owner.example>',
        // Step 4 — through Gmail's own parsing: the signature and the quoted
        // history stay out of the conversation.
        body: [
          'and tomorrow?', '', '-- ', 'Ann', '+1 555 0100', '',
          'On Tue, Oct 14, 2026 at 9:00 AM Recued <recued@chat.example> wrote:', '> answer 1',
        ].join('\r\n'),
      };
      chatMailbox.push({ ...reply, id: 'c2', labels: ['INBOX'] });
      ownerMailbox.push({ ...reply, id: 'o2', labels: ['SENT'] });
      await live.mailStack.resumeSync();
      await vi.waitFor(async () => expect(await store.listMessages(session)).toHaveLength(4), { timeout: 10_000 });
      expect((await store.listMessages(session))[2]?.content).toBe('and tomorrow?');
      expect(modelBodies[1]).not.toContain('555 0100');
      expect(conversations.conversationOf('recued-chat', 'req-2@owner.example')).toBe(conversation);
      expect(store.listSessions().map((s) => s.id)).toEqual([session]);

      // Step 4 — a new request with a PDF attached and a logo in its HTML
      // signature, as Gmail sends one: the PDF is the turn's file, the logo is not.
      await live.mailStack.pauseSync();
      const withFiles = {
        at: Date.now() - 2_000, from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'ask: is this quote fair?',
        messageId: 'req-3@owner.example',
        mime: {
          contentType: 'multipart/mixed; boundary="mixed"',
          body: [
            '--mixed',
            'Content-Type: multipart/related; boundary="related"',
            '',
            '--related',
            'Content-Type: multipart/alternative; boundary="alt"',
            '',
            '--alt',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Is this quote fair?',
            '',
            '-- ',
            'Ann',
            '--alt',
            'Content-Type: text/html; charset=utf-8',
            '',
            '<div>Is this quote fair?</div><div class="gmail_signature">Ann<img src="cid:logo@owner.example"></div>',
            '--alt--',
            '--related',
            'Content-Type: image/png; name="logo.png"',
            'Content-Disposition: inline; filename="logo.png"',
            'Content-ID: <logo@owner.example>',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64'),
            '--related--',
            '--mixed',
            'Content-Type: application/pdf; name="quote.pdf"',
            'Content-Disposition: attachment; filename="quote.pdf"',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from('%PDF-1.7\nquote\n%%EOF').toString('base64'),
            '--mixed--',
          ].join('\r\n'),
        },
        parts: [
          { filename: 'logo.png', mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
            headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
              { name: 'Content-ID', value: '<logo@owner.example>' }] },
          { filename: 'quote.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7\nquote\n%%EOF'),
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="quote.pdf"' }] },
        ],
      };
      chatMailbox.push({ ...withFiles, id: 'c3', labels: ['INBOX'] });
      ownerMailbox.push({ ...withFiles, id: 'o3', labels: ['SENT'] });
      await live.mailStack.resumeSync();
      await vi.waitFor(() => expect(live.proof.get('recued-chat', 'req-3@owner.example'))
        .toMatchObject({ admit_state: 'admitted' }), { timeout: 10_000 });
      const third = `mail:recued-chat:${conversations.conversationOf('recued-chat', 'req-3@owner.example')}`;
      await vi.waitFor(async () => expect(await store.listMessages(third)).toHaveLength(2), { timeout: 10_000 });
      const [asked] = await store.listMessages(third);
      expect(asked?.content).toBe('Is this quote fair?');
      expect(asked?.attachments?.map((file) => file.filename)).toEqual(['quote.pdf']);
      expect(modelBodies[2]).toContain('quote.pdf');
      expect(modelBodies[2]).not.toContain('logo.png');
    } finally {
      await live.close();
    }
  }, 60_000);

  it('the server composition registers the turns and binds them before the proof starts', () => {
    const listeners = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-listeners.ts'), 'utf-8');
    expect(listeners).toContain('const mailChatTurns = app.chatOrchestratorRef && collection.mailChatDoor && collection.mailChatConversations');
    expect(listeners).toContain('conversations: collection.mailChatConversations,');
    const bind = listeners.indexOf('mailChatProof.bindAdmit(mailChatTurns.admit);');
    expect(bind).toBeGreaterThan(-1);
    expect(bind).toBeLessThan(listeners.indexOf('mailChatProof.start();'));
  });
});

describe('D-318 step 5, live — the answer goes back by email', () => {
  it('is sent from the chat mailbox into the request’s thread, joins the conversation, and stays out of the owner’s mail', async () => {
    const chatMailbox: ScriptedMessage[] = [];
    const ownerMailbox: ScriptedMessage[] = [];
    let turn = 0;
    const { sent } = scriptGmail({
      'at-chat': { address: CHAT_ADDRESS, mailbox: chatMailbox },
      'at-me': { address: OWNER_ADDRESS, mailbox: ownerMailbox },
    }, () => JSON.stringify({ response: turn++ === 0 ? 'Nothing today.' : 'Tomorrow is clear too.', tool_calls: [] }));
    const live = await bootLive({ model: true });
    let answers: MailChatAnswers | undefined;
    try {
      live.app.chatDeps!.store.setDefaultModelSourceId('free_pool');
      await live.mailStack.startAll();
      // As compose-listeners composes them.
      const conversations = live.collection.mailChatConversations!;
      const mailboxes = () => live.collection.collectionRegistry.list()
        .filter((entry): entry is MailCollection => entry.platform === 'mail');
      const turns = composeMailChatTurns({
        orchestrator: live.app.chatOrchestratorRef!,
        door: live.collection.mailChatDoor!,
        mailboxes,
        readBody: (record) => materializeMailBody(record, live.app.cacheBlobs!),
        conversations,
        afterTurn: () => answers?.kick(),
      })!;
      answers = composeMailChatAnswers({
        db: live.storage.db!,
        chatStore: live.app.chatStoreRef!,
        door: live.collection.mailChatDoor!,
        mailboxes,
        requests: live.proof,
        conversations,
        claims: createMailSendClaimStore(live.storage.db!),
        publicBaseUrl: () => null,
        isUnlocked: live.app.isVaultUnlocked,
      })!;
      answers.start();
      const composed = answers;
      const stopSettled = live.app.onChatRunSettled!((settled) => composed.onRunSettled(settled));
      live.proof.bindAdmit(turns.admit);
      live.proof.start();

      await live.mailStack.pauseSync();
      const request = {
        at: Date.now() - 20_000, from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'ask: what is on today?',
        messageId: 'req-1@owner.example',
      };
      chatMailbox.push({ ...request, id: 'c1', labels: ['INBOX'] });
      ownerMailbox.push({ ...request, id: 'o1', labels: ['SENT'] });
      await live.mailStack.resumeSync();

      // Sent by the real Gmail provider, from the chat mailbox's account.
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 15_000 });
      const first = sent[0]!;
      expect(first.token).toBe('at-chat');
      // Into the request's thread in the chat mailbox.
      expect(first.threadId).toBe('c1');
      expect(headerOf(first.source, 'To')).toBe(OWNER_ADDRESS);
      expect(headerOf(first.source, 'Cc')).toBeUndefined();
      expect(headerOf(first.source, 'Reply-To')).toBeUndefined();
      expect(headerOf(first.source, 'Subject')).toBe('Re: ask: what is on today?');
      expect(headerOf(first.source, 'In-Reply-To')).toBe('<req-1@owner.example>');
      expect(headerOf(first.source, 'References')).toBe('<req-1@owner.example>');
      expect(headerOf(first.source, 'Auto-Submitted')).toBe('auto-replied');
      expect(headerOf(first.source, 'X-Auto-Response-Suppress')).toBe('OOF, AutoReply');
      const reconciliation = headerOf(first.source, 'x-recued-reconciliation-id');
      expect(reconciliation).toMatch(/^mail-chat-answer:[0-9a-f]{32}$/);
      expect(first.source.split('\r\n\r\n')[1]).toBe('Nothing today.');

      // The Message-ID Gmail gave it, read from the chat mailbox's Sent record,
      // joins the conversation.
      const conversation = conversations.conversationOf('recued-chat', 'req-1@owner.example');
      await vi.waitFor(() => expect(conversations.conversationOf('recued-chat', 'CAgmail-1@mail.gmail.com'))
        .toBe(conversation), { timeout: 10_000 });

      // It lands in the owner's inbox: Recued's own, and not the owner's mail.
      await live.mailStack.pauseSync();
      await live.mailStack.resumeSync();
      const owner = live.collection.collectionRegistry.get('mail', 'me') as MailCollection;
      await vi.waitFor(() => expect(owner.list({ platform: 'mail', slug: 'me', limit: 50 })
        .some((record) => record.hot_fields.reconciliation_id === reconciliation)).toBe(true), { timeout: 10_000 });
      // The audit — marked so as it was stored, as is the owner's Sent copy of
      // the request: every reader of the stored mail leaves both out.
      const ownerRows = owner.list({ platform: 'mail', slug: 'me', limit: 50 });
      expect(ownerRows.find((record) => record.hot_fields.reconciliation_id === reconciliation)?.hot_fields.mail_chat).toBe(true);
      expect(ownerRows.find((record) => record.hot_fields.rfc_message_id === 'req-1@owner.example')?.hot_fields.mail_chat)
        .toBe(true);
      // Neither the answer nor the requests' Sent copies made the chat mailbox a contact.
      expect(live.app.contactStoreRef!.get(CHAT_ADDRESS)).toBeNull();
      // The chat mailbox's own Sent copy of it is not a request.
      expect(live.proof.get('recued-chat', 'CAgmail-1@mail.gmail.com')).toBeNull();

      // The owner replies to the answer from a mail app that writes In-Reply-To
      // alone, under a subject without ask: — the recorded answer continues it.
      await live.mailStack.pauseSync();
      const reply = {
        at: Date.now() - 2_000, from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'Re: what is on today?',
        messageId: 'req-2@owner.example', inReplyTo: '<CAgmail-1@mail.gmail.com>', body: 'and tomorrow?',
      };
      // Gmail files it in the answer's thread.
      chatMailbox.push({ ...reply, id: 'c2', labels: ['INBOX'], threadId: 'c1' });
      ownerMailbox.push({ ...reply, id: 'o2', labels: ['SENT'] });
      await live.mailStack.resumeSync();
      await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 15_000 });
      expect(conversations.conversationOf('recued-chat', 'req-2@owner.example')).toBe(conversation);
      const second = sent[1]!;
      expect(second.threadId).toBe('c1');
      expect(headerOf(second.source, 'Subject')).toBe('Re: what is on today?');
      expect(headerOf(second.source, 'In-Reply-To')).toBe('<req-2@owner.example>');
      expect(headerOf(second.source, 'References')).toBe('<CAgmail-1@mail.gmail.com> <req-2@owner.example>');
      expect(second.source.split('\r\n\r\n')[1]).toBe('Tomorrow is clear too.');
      const session = `mail:recued-chat:${conversation}`;
      expect((await live.app.chatDeps!.store.listMessages(session)).map((m) => m.content)).toEqual([
        'what is on today?', 'Nothing today.', 'and tomorrow?', 'Tomorrow is clear too.',
      ]);

      // ⛔ What a server that remembers neither request finds — restored from a
      // backup, or a second copy: each one's own answer, in the chat mailbox's
      // Sent record, read by the provider that sent it. The second request's
      // thread holds the first one's answer too, which answers only the first.
      const chat = live.collection.collectionRegistry.get('mail', 'recued-chat') as MailCollection;
      await expect(chat.lookupSentReplies({ rfc_message_id: 'req-1@owner.example' })).resolves.toEqual({
        status: 'found', matches: [{ reconciliation_id: reconciliation, sent_at: expect.any(Number) }],
      });
      const secondReconciliation = headerOf(second.source, 'x-recued-reconciliation-id');
      expect(secondReconciliation).toMatch(/^mail-chat-answer:[0-9a-f]{32}$/);
      expect(secondReconciliation).not.toBe(reconciliation);
      await expect(chat.lookupSentReplies({ rfc_message_id: 'req-2@owner.example' })).resolves.toEqual({
        status: 'found', matches: [{ reconciliation_id: secondReconciliation, sent_at: expect.any(Number) }],
      });

      // Part 3 — ⛔ an answer ANOTHER copy of this server sent: one restored from
      // a backup holds no claim for the answers sent since it was taken (live,
      // 2026-10-15: such a copy stored them as the owner's mail, and made the
      // chat mailbox a contact). Gmail delivers it stamped, like this server's
      // own: it stays out of the owner's mail by the stamp of the mailbox it
      // landed in.
      const otherCopy = (id: string, messageId: string, stamped: boolean): ScriptedMessage => {
        const given = first.source.replace(reconciliation!, id);
        const source = `From: ${CHAT_ADDRESS}\r\nMessage-ID: <${messageId}>\r\n${given}`;
        return {
          id: messageId, at: Date.now(), labels: ['INBOX'], from: CHAT_ADDRESS, to: OWNER_ADDRESS,
          subject: headerOf(given, 'Subject') ?? '', messageId,
          source: stamped ? `Authentication-Results: ${gmailStamp(CHAT_ADDRESS)}\r\n${source}` : source,
        };
      };
      const stampedId = 'mail-chat-answer:0123456789abcdef0123456789abcdef';
      const stamplessId = 'mail-chat-answer:fedcba9876543210fedcba9876543210';
      const rowOf = (id: string) => owner.list({ platform: 'mail', slug: 'me', limit: 50 })
        .find((record) => record.hot_fields.reconciliation_id === id);
      await live.mailStack.pauseSync();
      ownerMailbox.push(otherCopy(stampedId, 'CAgmail-other-1@mail.gmail.com', true));
      await live.mailStack.resumeSync();
      await vi.waitFor(() => expect(rowOf(stampedId)).toBeDefined(), { timeout: 10_000 });
      expect(rowOf(stampedId)?.hot_fields.mail_chat).toBe(true);
      expect(live.app.contactStoreRef!.get(CHAT_ADDRESS)).toBeNull();
      // The control: the same answer without Gmail's stamp is the owner's mail,
      // and makes the chat mailbox a contact.
      await live.mailStack.pauseSync();
      ownerMailbox.push(otherCopy(stamplessId, 'CAgmail-other-2@mail.gmail.com', false));
      await live.mailStack.resumeSync();
      await vi.waitFor(() => expect(rowOf(stamplessId)).toBeDefined(), { timeout: 10_000 });
      expect(rowOf(stamplessId)?.hot_fields.mail_chat).toBeUndefined();
      await vi.waitFor(() => expect(live.app.contactStoreRef!.get(CHAT_ADDRESS)).not.toBeNull(), { timeout: 10_000 });

      // Part 2 — the server's own settled-run sink reaches the door: a run an
      // email turn started is kept for its follow-up; another door's is not.
      const source = { channel: 'messenger', actor: 'user_self', from: OWNER_ADDRESS } as const;
      await live.app.chatRunSettledSink!({ execution_source: { ...source, vendor: 'email' }, run_id: 'run-live-1',
        tool_name: 'recipe.run', result: { success: true }, ts: Date.now() });
      await live.app.chatRunSettledSink!({ execution_source: { ...source, vendor: 'slack' }, run_id: 'run-live-2',
        tool_name: 'recipe.run', result: { success: true }, ts: Date.now() });
      expect(live.storage.db!.prepare('SELECT run_id, outcome FROM mail_chat_settled_runs').all())
        .toEqual([{ run_id: 'run-live-1', outcome: 'succeeded' }]);
      stopSettled();
    } finally {
      await answers?.dispose();
      await live.close();
    }
  }, 60_000);

  it('the server composition sends the answers once the turns exist, and stops them at shutdown', () => {
    const listeners = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-listeners.ts'), 'utf-8');
    expect(listeners).toContain('afterTurn: () => mailChatAnswers?.kick(),');
    expect(listeners).toContain('mailChatAnswers = mailChatTurns !== undefined && answersDb !== undefined && app.chatStoreRef');
    expect(listeners).toContain('requests: mailChatProof,');
    expect(listeners).toContain('mailChatAnswers.bindNotify((message, extras) => notifier.notify(message, undefined, extras));');
    expect(listeners).toContain('mailChatAnswers.start();');
    expect(listeners).toContain('...(mailChatAnswers !== undefined ? [begin(() => mailChatAnswers!.dispose())] : []),');
    // The answers' own claims and the owner's question about one gone unknown.
    expect(listeners).toContain('claims: createMailSendClaimStore(answersDb),');
    expect(listeners).toContain('await raiseMailSendOutcomeAsk({');
    // Part 2 — and hear of each run that settles after its turn.
    expect(listeners).toContain('stopMailChatSettled = app.onChatRunSettled?.((settled) => answers.onRunSettled(settled));');
    // The audit — a run that settles during boot, before the loop, is kept by
    // a listener the runtime adds as soon as chat's settled-run sink exists.
    const runtime = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..',
      'serve/start-post-storage-app-collection-execution-runtime.ts'), 'utf-8');
    expect(runtime.indexOf('recordMailChatSettledRun(settledRunsDb, settled, Date.now());'))
      .toBeGreaterThan(runtime.indexOf('lateBound.publishRunSettledSink(app.chatRunSettledSink);'));
    // An answer given up closes the owner's question; the answers pause while
    // the vault is locked; a reply to a deleted conversation starts a new one.
    expect(listeners).toContain('closeMailSendOutcomeAsk({ notifier: execution.notificationBlock, reconciliation_id }),');
    expect(listeners).toContain('isUnlocked: app.isVaultUnlocked,');
    expect(listeners).toContain('{ sessionExists: (session_id: string) => app.chatStoreRef!.getSession(session_id) !== null }');
    // And no mail fact is made from the conversation, in any mailbox — nor is
    // mail Recued's own unless its send claims say so.
    expect(listeners).toContain('? { isConversationMail: collection.mailChatConversationMail.isConversationMail }');
    expect(listeners).toContain('...(collection.isOwnSend ? { isOwnSend: collection.isOwnSend } : {}),');
    // The proof pauses while the vault is locked, as the answers do.
    const context = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-collection-context.ts'), 'utf-8');
    expect(context).toContain('isUnlocked: isVaultUnlocked,');
    // §8.10 — the mail stack judges each message as it syncs (the provider's
    // record in hand), the readers of stored mail read without the marked rows,
    // and the fact ingest asks Recued's own record what Recued sent.
    expect(context).toContain('isChatConversationMail: mailChatConversationMail.isConversationMessage');
    expect(context).toContain('rows: { mail: MAIL_CHAT_OWNER_ROWS_SQL },');
    expect(context).toContain('...(isOwnSend ? { isOwnSend } : {}),');
    // And the conversation's mail in the owner's other mailboxes starts no recipe.
    expect(listeners).toContain('isChatConversationRecord: (slug: string, record_id: string) =>\n'
      + '            collection.mailChatConversationMail!.isConversationRecord(slug, record_id),');
    // ...and no housekeeping producer reads it: the server's scheduler passes
    // the check, and the substrate hands it to both mail walkers.
    const here = dirname(fileURLToPath(import.meta.url));
    const schedulers = readFileSync(resolve(here, '..', 'serve/start-schedulers.ts'), 'utf-8');
    expect(schedulers).toContain('isChatConversationRecord: (record: { hot_fields: Record<string, unknown> }) =>\n'
      + '            collection.mailChatConversationMail!.isConversationMail(record.hot_fields),');
    const substrate = readFileSync(resolve(here, '..', 'composition/bin/wire-housekeeping-substrate.ts'), 'utf-8');
    expect(substrate.split('...(deps.isChatConversationRecord ? { isChatConversationRecord: deps.isChatConversationRecord } : {}),'))
      .toHaveLength(3);
  });
});

describe('§8.18 one mailbox, live — the owner writes to their own Gmail, and Recued answers there', () => {
  it('answers in the thread from the same mailbox, keeps the conversation out of the owner’s mail, and the rest in', async () => {
    const mine: ScriptedMessage[] = [];
    let turn = 0;
    const { sent, sentLookups } = scriptGmail({
      'at-me': { address: OWNER_ADDRESS, mailbox: mine },
    }, () => JSON.stringify({ response: turn++ === 0 ? 'Nothing today.' : 'Tomorrow is clear too.', tool_calls: [] }));
    const live = await bootLive({ model: true, oneMailbox: true });
    let answers: MailChatAnswers | undefined;
    try {
      expect(live.collection.mailChatDoor!.get()).toMatchObject({
        chat_mailbox: 'me', owner_mailboxes: ['me'], ask_prefix: 'ask:',
      });
      live.app.chatDeps!.store.setDefaultModelSourceId('free_pool');
      await live.mailStack.startAll();
      const conversations = live.collection.mailChatConversations!;
      const mailboxes = () => live.collection.collectionRegistry.list()
        .filter((entry): entry is MailCollection => entry.platform === 'mail');
      const turns = composeMailChatTurns({
        orchestrator: live.app.chatOrchestratorRef!,
        door: live.collection.mailChatDoor!,
        mailboxes,
        readBody: (record) => materializeMailBody(record, live.app.cacheBlobs!),
        conversations,
        afterTurn: () => answers?.kick(),
      })!;
      answers = composeMailChatAnswers({
        db: live.storage.db!,
        chatStore: live.app.chatStoreRef!,
        door: live.collection.mailChatDoor!,
        mailboxes,
        requests: live.proof,
        conversations,
        claims: createMailSendClaimStore(live.storage.db!),
        publicBaseUrl: () => null,
        isUnlocked: live.app.isVaultUnlocked,
      })!;
      answers.start();
      live.proof.bindAdmit(turns.admit);
      live.proof.start();

      await live.mailStack.pauseSync();
      const at = Date.now() - 20_000;
      // ⛔ As Gmail keeps an email to oneself: ONE message, labelled SENT and INBOX.
      const self = { at, from: OWNER_ADDRESS, to: OWNER_ADDRESS, labels: ['SENT', 'INBOX'] } as const;
      mine.push({ ...self, id: 'm1', subject: 'ask: what is on today?', messageId: 'req-1@owner.example' });
      // The rest of the owner's mail, in the same mailbox.
      mine.push({ ...self, id: 'm2', subject: 'Buy milk', messageId: 'note-1@owner.example', body: 'and eggs' });
      mine.push({
        id: 'm3', at, labels: ['INBOX'], from: 'bob@friend.example', to: OWNER_ADDRESS, subject: 'lunch?',
        messageId: 'lunch-1@friend.example', body: 'Thursday?',
        source: `Authentication-Results: ${gmailStamp('bob@friend.example')}\r\n` + [
          'From: bob@friend.example', `To: ${OWNER_ADDRESS}`, 'Subject: lunch?', 'Message-ID: <lunch-1@friend.example>',
          `Date: ${new Date(at).toUTCString()}`, 'Content-Type: text/plain; charset=utf-8', '', 'Thursday?', '',
        ].join('\r\n'),
      });
      await live.mailStack.resumeSync();

      // Proven by its own Sent record, run, and answered — by the real Gmail
      // provider, past D-127's self-loop guard, to the owner, in the thread.
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 15_000 });
      expect(live.proof.get('me', 'req-1@owner.example')).toMatchObject({ state: 'proven', proven_by: 'me' });
      expect(sentLookups.map((lookup) => lookup.q)).toContain('rfc822msgid:req-1@owner.example');
      const first = sent[0]!;
      expect(first.token).toBe('at-me');
      expect(first.threadId).toBe('m1');
      expect(headerOf(first.source, 'To')).toBe(OWNER_ADDRESS);
      expect(headerOf(first.source, 'Cc')).toBeUndefined();
      expect(headerOf(first.source, 'In-Reply-To')).toBe('<req-1@owner.example>');
      const reconciliation = headerOf(first.source, 'x-recued-reconciliation-id');
      expect(reconciliation).toMatch(/^mail-chat-answer:[0-9a-f]{32}$/);
      expect(first.source.split('\r\n\r\n')[1]).toBe('Nothing today.');

      // The answer lands in the same mailbox; synced, it is Recued's own.
      const conversation = conversations.conversationOf('me', 'req-1@owner.example');
      await vi.waitFor(() => expect(conversations.conversationOf('me', 'CAgmail-1@mail.gmail.com'))
        .toBe(conversation), { timeout: 10_000 });
      await live.mailStack.pauseSync();
      await live.mailStack.resumeSync();
      const box = live.collection.collectionRegistry.get('mail', 'me') as MailCollection;
      const rowOf = (key: string, value: string) => box.list({ platform: 'mail', slug: 'me', limit: 50 })
        .find((record) => record.hot_fields[key] === value);
      await vi.waitFor(() => expect(rowOf('reconciliation_id', reconciliation!)).toBeDefined(), { timeout: 10_000 });
      // ⛔ The conversation is out of the owner's mail: the request, and the answer.
      expect(rowOf('rfc_message_id', 'req-1@owner.example')?.hot_fields.mail_chat).toBe(true);
      expect(rowOf('reconciliation_id', reconciliation!)?.hot_fields.mail_chat).toBe(true);
      // ⛔ ...and the rest of the mailbox is theirs, as before: a note to self, a
      // friend's email, which still makes the friend a contact.
      expect(rowOf('rfc_message_id', 'note-1@owner.example')?.hot_fields.mail_chat).toBeUndefined();
      expect(rowOf('rfc_message_id', 'lunch-1@friend.example')?.hot_fields.mail_chat).toBeUndefined();
      await vi.waitFor(() => expect(live.app.contactStoreRef!.get('bob@friend.example')).not.toBeNull(), { timeout: 10_000 });
      // The answer, delivered back, is no request; nor is anything but the request.
      expect(live.proof.get('me', 'CAgmail-1@mail.gmail.com')).toBeNull();
      expect(live.proof.recent('me', 10).map((request) => request.rfc_message_id)).toEqual(['req-1@owner.example']);

      // The owner replies to the answer, from the same mailbox, without ask:.
      await live.mailStack.pauseSync();
      mine.push({
        ...self, at: Date.now() - 2_000, id: 'm4', threadId: 'm1', subject: 'Re: what is on today?',
        messageId: 'req-2@owner.example', inReplyTo: '<CAgmail-1@mail.gmail.com>', body: 'and tomorrow?',
      });
      await live.mailStack.resumeSync();
      await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 15_000 });
      expect(conversations.conversationOf('me', 'req-2@owner.example')).toBe(conversation);
      expect(headerOf(sent[1]!.source, 'To')).toBe(OWNER_ADDRESS);
      expect(sent[1]!.source.split('\r\n\r\n')[1]).toBe('Tomorrow is clear too.');
      await vi.waitFor(() => expect(rowOf('rfc_message_id', 'req-2@owner.example')?.hot_fields.mail_chat).toBe(true),
        { timeout: 10_000 });
      expect((await live.app.chatDeps!.store.listMessages(`mail:me:${conversation}`)).map((m) => m.content)).toEqual([
        'what is on today?', 'Nothing today.', 'and tomorrow?', 'Tomorrow is clear too.',
      ]);
    } finally {
      await answers?.dispose();
      await live.close();
    }
  }, 60_000);
});

describe('§8.18, live — switching between two mailboxes and one, and back', () => {
  it('answers in each setup, turns the prefix back on for one mailbox, and leaves the old threads unanswered', async () => {
    const chatBox: ScriptedMessage[] = [];
    const mine: ScriptedMessage[] = [];
    let turn = 0;
    const { sent } = scriptGmail({
      'at-chat': { address: CHAT_ADDRESS, mailbox: chatBox },
      'at-me': { address: OWNER_ADDRESS, mailbox: mine },
    }, () => JSON.stringify({ response: `answer ${++turn}`, tool_calls: [] }));
    const live = await bootLive({ model: true, bothSend: true });
    let answers: MailChatAnswers | undefined;
    try {
      live.app.chatDeps!.store.setDefaultModelSourceId('free_pool');
      await live.mailStack.startAll();
      const door = live.collection.mailChatDoor!;
      const conversations = live.collection.mailChatConversations!;
      const mailboxes = () => live.collection.collectionRegistry.list()
        .filter((entry): entry is MailCollection => entry.platform === 'mail');
      const turns = composeMailChatTurns({
        orchestrator: live.app.chatOrchestratorRef!, door, mailboxes,
        readBody: (record) => materializeMailBody(record, live.app.cacheBlobs!), conversations,
        afterTurn: () => answers?.kick(),
      })!;
      answers = composeMailChatAnswers({
        db: live.storage.db!, chatStore: live.app.chatStoreRef!, door, mailboxes, requests: live.proof, conversations,
        claims: createMailSendClaimStore(live.storage.db!), publicBaseUrl: () => null, isUnlocked: live.app.isVaultUnlocked,
      })!;
      answers.start();
      live.proof.bindAdmit(turns.admit);
      live.proof.start();
      /** As Settings → Email chat switches: off, then on with the mailboxes picked
       *  (`collection.mail.chat_door.set` names the owner's mailboxes first). */
      const switchTo = (chat: 'recued-chat' | 'me') => {
        door.setChatMailbox(null);
        door.setOwnerMailboxes(['me']);
        return door.setChatMailbox(chat, chat === 'me' ? OWNER_ADDRESS : CHAT_ADDRESS);
      };
      const deliver = async (...pushes: Array<[ScriptedMessage[], ScriptedMessage]>) => {
        await live.mailStack.pauseSync();
        for (const [box, msg] of pushes) box.push(msg);
        await live.mailStack.resumeSync();
      };
      const at = () => Date.now() - 2_000;

      // 1. Two mailboxes, the prefix switched off by the owner.
      door.setAskPrefix(null);
      const one = { at: at(), from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'first question', messageId: 'q1@owner.example' };
      await deliver([chatBox, { ...one, id: 'c1', labels: ['INBOX'] }], [mine, { ...one, id: 'o1', labels: ['SENT'] }]);
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 15_000 });
      expect(sent[0]!.token).toBe('at-chat');
      expect(headerOf(sent[0]!.source, 'To')).toBe(OWNER_ADDRESS);
      await vi.waitFor(() => expect(conversations.conversationOf('recued-chat', 'CAgmail-1@mail.gmail.com')).not.toBeNull(),
        { timeout: 10_000 });

      // 2. Switched to one mailbox: the filter is on again, whatever the owner chose before.
      expect(switchTo('me')).toMatchObject({ chat_mailbox: 'me', owner_mailboxes: ['me'], ask_prefix: 'ask:' });
      // ⛔ A reply to the old thread goes to the old chat mailbox: nobody answers it now.
      const oldReply = {
        at: at(), from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'Re: first question', messageId: 'q1-reply@owner.example',
        inReplyTo: '<CAgmail-1@mail.gmail.com>',
      };
      // A note to themselves, without the prefix: their own mail.
      const note = { at: at(), from: OWNER_ADDRESS, to: OWNER_ADDRESS, subject: 'Buy milk', messageId: 'note@owner.example' };
      const two = { at: at(), from: OWNER_ADDRESS, to: OWNER_ADDRESS, subject: 'ask: second question', messageId: 'q2@owner.example' };
      await deliver(
        [chatBox, { ...oldReply, id: 'c2', labels: ['INBOX'] }], [mine, { ...oldReply, id: 'o2', labels: ['SENT'] }],
        [mine, { ...note, id: 'o3', labels: ['SENT', 'INBOX'] }],
        [mine, { ...two, id: 'o4', labels: ['SENT', 'INBOX'] }],
      );
      await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 15_000 });
      expect(sent[1]!.token).toBe('at-me');
      expect(headerOf(sent[1]!.source, 'To')).toBe(OWNER_ADDRESS);
      expect(headerOf(sent[1]!.source, 'In-Reply-To')).toBe('<q2@owner.example>');
      expect(live.proof.get('me', 'q2@owner.example')).toMatchObject({ state: 'proven', proven_by: 'me' });
      expect(live.proof.get('me', 'note@owner.example')).toBeNull();
      expect(live.proof.get('me', 'q1-reply@owner.example')).toBeNull();
      expect(live.proof.get('recued-chat', 'q1-reply@owner.example')).toBeNull();

      // 3. Back to two mailboxes. ⛔ A reply in the one-mailbox thread is the owner's mail again.
      expect(switchTo('recued-chat')).toMatchObject({ chat_mailbox: 'recued-chat', owner_mailboxes: ['me'], ask_prefix: 'ask:' });
      const twoReply = {
        at: at(), from: OWNER_ADDRESS, to: OWNER_ADDRESS, subject: 'Re: ask: second question',
        messageId: 'q2-reply@owner.example', inReplyTo: '<q2@owner.example>',
      };
      const three = { at: at(), from: OWNER_ADDRESS, to: CHAT_ADDRESS, subject: 'ask: third question', messageId: 'q3@owner.example' };
      await deliver(
        [mine, { ...twoReply, id: 'o5', labels: ['SENT', 'INBOX'] }],
        [chatBox, { ...three, id: 'c3', labels: ['INBOX'] }], [mine, { ...three, id: 'o6', labels: ['SENT'] }],
      );
      await vi.waitFor(() => expect(sent).toHaveLength(3), { timeout: 15_000 });
      expect(sent[2]!.token).toBe('at-chat');
      expect(headerOf(sent[2]!.source, 'In-Reply-To')).toBe('<q3@owner.example>');
      expect(live.proof.get('me', 'q2-reply@owner.example')).toBeNull();
      // Nothing else was sent: three questions, three answers.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(sent).toHaveLength(3);
      // Each setup kept its own conversations.
      expect(conversations.conversationOf('recued-chat', 'q1@owner.example')).not.toBeNull();
      expect(conversations.conversationOf('me', 'q2@owner.example')).not.toBeNull();
      expect(conversations.conversationOf('recued-chat', 'q3@owner.example')).not.toBeNull();
    } finally {
      await answers?.dispose();
      await live.close();
    }
  }, 90_000);
});

describe('D-325 §5.3, live — where the owner forwards proof', () => {
  it('names the +done address of the owner’s mailbox and never the chat mailbox’s, whose mail is not read for facts', async () => {
    scriptGmail({ 'at-chat': { address: CHAT_ADDRESS, mailbox: [] }, 'at-me': { address: OWNER_ADDRESS, mailbox: [] } });
    const live = await bootLive();
    try {
      await live.mailStack.startAll();
      expect((await live.collection.yours!.snapshot()).proof_addresses).toEqual(['me+done@owner.example']);
    } finally {
      await live.close();
    }
  });

  it('names it with one mailbox, which is the owner’s own as well as the chat’s (§8.18)', async () => {
    scriptGmail({ 'at-me': { address: OWNER_ADDRESS, mailbox: [] } });
    const live = await bootLive({ oneMailbox: true });
    try {
      await live.mailStack.startAll();
      expect((await live.collection.yours!.snapshot()).proof_addresses).toEqual(['me+done@owner.example']);
    } finally {
      await live.close();
    }
  });
});
