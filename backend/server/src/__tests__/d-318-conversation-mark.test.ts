/** D-318 audit — the email chat door's conversation is marked as it is stored,
 *  in the owner's own mailboxes, and every reader of the stored mail leaves it
 *  out.
 *
 *  Through a real mail collection over a real table, its provider scripted:
 *  the decision is made as each message syncs, with the provider's own record
 *  in hand (the real `isConversationMessage` and the real send-claim store), and
 *  kept on the row. ⛔ What a sender can write — a From line, a header, the
 *  owner Bcc'd on mail "to" the chat mailbox — marks nothing. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import type { CollectionRecord } from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInstanceStore } from '../collections/instance-store.js';
import {
  createMailCollection,
  MAIL_CHAT_CONVERSATION_FIELD,
  mailChangedFields,
  type MailCollection,
} from '../collections/mail/mail-collection.js';
import type { CanonicalMessage, MailProvider, ProviderSyncCallback } from '../collections/mail/provider.js';
import { listCollectionDataTables, setCollectionReaderExclusion } from '../collections/table.js';
import {
  createMailChatConversationMail,
  MAIL_CHAT_OWNER_ROWS_SQL,
  mailChatAnswerReconciliationId,
} from '../mail-chat-door/conversation-mail.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createMailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';

const NOW = 1_800_000_000_000;
const CHAT = 'recued@chat.example';
const OWNER = 'me@owner.example';
const ANSWER = mailChatAnswerReconciliationId('answer-1');

let db: Database.Database;
let dir: string;
let events: WarehouseEvent[];
const open: MailCollection[] = [];

beforeEach(async () => {
  db = new Database(':memory:');
  dir = await mkdtemp(join(tmpdir(), 'd318-mark-'));
  events = [];
});
afterEach(async () => {
  for (const collection of open.splice(0)) await collection.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const message = (source_id: string, over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id,
  rfc_message_id: `<${source_id}@x.example>`,
  from: 'bob@x.example',
  to: [OWNER],
  cc: [],
  subject: 'lunch?',
  thread_id: `t-${source_id}`,
  folder_or_label: 'INBOX',
  direction: 'inbound',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: NOW - 60_000,
  body_text: 'hello',
  ...over,
});

/** The owner's mailbox, with the door's check as the server composes it —
 *  or, `marks: false`, as a server before the mark stored it. A Gmail mailbox
 *  unless `kind` says otherwise. */
const ownerMailbox = async (
  scan: CanonicalMessage[],
  options: { marks?: boolean; kind?: MailProvider['kind'] } = {},
) => {
  const door = createMailChatDoorStore(db);
  door.setChatMailbox('recued-chat', CHAT);
  door.setOwnerMailboxes(['work']);
  const claims = createMailSendClaimStore(db);
  // Recued sent the answer: its claim was recorded before it went.
  claims.claim({ reconciliation_id: ANSWER, sender_slug: 'recued-chat', recipient: OWNER, subject: 'Re: ask: lunch?', proof_kind: 'envelope', now: NOW - 120_000 });
  const conversation = createMailChatConversationMail({
    door, mailbox: () => undefined, isOwnAnswer: (id) => claims.get(id) !== null,
  });
  const instances = createInstanceStore({ db });
  if (instances.get('mail', 'work') === null) {
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'gmail', config: {}, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
  }
  let sync: ProviderSyncCallback | null = null;
  const provider: MailProvider = {
    kind: options.kind ?? 'gmail', slug: 'work', sendCapable: false, mutationCapable: false, accountEmail: OWNER,
    async connect() {},
    async initialScan(opts) { for (const msg of scan) if (!(await opts.onMessage(msg))) break; },
    async startSync(cb) {
      sync = cb;
      return async () => { sync = null; };
    },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
  };
  const bus = createWarehouseEventBus();
  bus.subscribe('**', (event) => { events.push(event); });
  const collection = createMailCollection({
    db, blobs: createBlobStore(join(dir, 'blobs')), bus, slug: 'work', provider, instances, now: () => NOW,
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
    ...(options.marks === false ? {} : { isChatConversation: conversation.isConversationMessage }),
  });
  open.push(collection);
  await collection.sync.start();
  const row = (source_id: string): CollectionRecord =>
    collection.list({ platform: 'mail', slug: 'work', limit: 50 }).find((r) => r.source_id === source_id)!;
  return { collection, conversation, row, push: (event: Parameters<ProviderSyncCallback>[0]) => sync!(event) };
};

describe('D-318 audit — the conversation is marked as it is stored', () => {
  it('marks Recued’s answer and the owner’s Sent copy — never what a sender can write', async () => {
    const box = await ownerMailbox([
      // Recued's answer, in the owner's inbox: its id is Recued's.
      message('answer', { from: CHAT, reconciliation_id: ANSWER, subject: 'Re: ask: lunch?' }),
      // The owner's request, as Gmail's SENT label holds it.
      message('sent-copy', { from: OWNER, to: [CHAT], direction: 'outbound', labels: ['SENT'], subject: 'ask: lunch?' }),
      // ⛔ A stranger: the owner's From, the chat mailbox as the only To, the
      // owner Bcc'd — in the inbox. Stored, it reads `outbound` all the same.
      message('bcc-forgery', { from: OWNER, to: [CHAT], subject: 'ask: wire 5,000' }),
      // A header any sender can write, and the chat mailbox in a From line.
      message('forged-answer', { from: CHAT, reconciliation_id: mailChatAnswerReconciliationId('never-sent') }),
      // The owner's own mail.
      message('mine'),
    ]);
    const marked = (source_id: string) => box.row(source_id).hot_fields[MAIL_CHAT_CONVERSATION_FIELD] === true;
    expect(marked('answer')).toBe(true);
    expect(marked('sent-copy')).toBe(true);
    expect(box.row('bcc-forgery').hot_fields.direction).toBe('outbound');
    expect(marked('bcc-forgery')).toBe(false);
    expect(marked('forged-answer')).toBe(false);
    expect(marked('mine')).toBe(false);
    // A stored row is read by its mark.
    expect(box.conversation.isConversationMail(box.row('bcc-forgery').hot_fields)).toBe(false);
    expect(box.conversation.isConversationMail(box.row('sent-copy').hot_fields)).toBe(true);
  });

  it('⛔ marks an answer another copy of the server sent, by the stamp of the mailbox it landed in', async () => {
    // A copy restored from a backup holds no claim for the answers sent since:
    // this answer's id is none of this server's.
    const other = mailChatAnswerReconciliationId('answered-by-the-other-copy');
    // Gmail's own stamp, as measured on the owner's Gmail (2026-10-15).
    const stamp = 'mx.google.com;       dkim=pass header.i=@chat.example header.s=selector1 header.b=hJxoxgU2;'
      + '       arc=pass (i=1);       spf=pass (google.com: domain of recued@chat.example designates 2001:db8::2 as '
      + 'permitted sender) smtp.mailfrom=recued@chat.example;       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) '
      + 'header.from=chat.example';
    const stamped = (source_id: string, authentication_results?: string) => message(source_id, {
      from: `Recued <${CHAT}>`, reconciliation_id: other, subject: 'Re: ask: lunch?',
      ...(authentication_results !== undefined ? { headers: { 'authentication-results': authentication_results } } : {}),
    });
    const box = await ownerMailbox([
      stamped('other-copy-answer', stamp),
      // ⛔ A pass a sender wrote, named for another checker.
      stamped('planted-pass', stamp.replace('mx.google.com', 'mx.evil.example')),
      // ⛔ No stamp at all.
      stamped('stampless'),
    ]);
    const marked = (source_id: string) => box.row(source_id).hot_fields[MAIL_CHAT_CONVERSATION_FIELD] === true;
    expect(marked('other-copy-answer')).toBe(true);
    expect(marked('planted-pass')).toBe(false);
    expect(marked('stampless')).toBe(false);
  });

  it('⛔ an IMAP mailbox’s stamp marks nothing: its server may stamp nothing, leaving a sender’s first', async () => {
    const other = mailChatAnswerReconciliationId('answered-by-the-other-copy');
    const stamp = 'mx.owner.example; dmarc=pass header.from=chat.example';
    const box = await ownerMailbox([
      message('other-copy-answer', {
        from: CHAT, reconciliation_id: other, headers: { 'authentication-results': stamp },
      }),
    ], { kind: 'imap' });
    expect(box.row('other-copy-answer').hot_fields[MAIL_CHAT_CONVERSATION_FIELD]).toBeUndefined();
  });

  it('every reader that lists the mail tables reads them without the marked rows', async () => {
    await ownerMailbox([
      message('answer', { from: CHAT, reconciliation_id: ANSWER }),
      message('sent-copy', { from: OWNER, to: [CHAT], direction: 'outbound', labels: ['SENT'] }),
      message('bcc-forgery', { from: OWNER, to: [CHAT] }),
      message('mine'),
    ]);
    setCollectionReaderExclusion(db, { rows: { mail: MAIL_CHAT_OWNER_ROWS_SQL } });
    const [name] = listCollectionDataTables(db, 'mail');
    const read = (db.prepare(`SELECT source_id FROM "${name!}" ORDER BY source_id`).all() as Array<{ source_id: string }>)
      .map((row) => row.source_id);
    expect(read).toEqual(['bcc-forgery', 'mine']);
  });

  it('a mark appearing on a message stored before it is no update: no trigger wakes on the upgrade', async () => {
    const copy = message('sent-copy', { from: OWNER, to: [CHAT], direction: 'outbound', labels: ['SENT'] });
    // Stored by a server before the mark.
    const before = await ownerMailbox([copy], { marks: false });
    expect(before.row('sent-copy').hot_fields[MAIL_CHAT_CONVERSATION_FIELD]).toBeUndefined();
    await before.collection.close();
    open.splice(open.indexOf(before.collection), 1);

    // The upgraded server lists it again, as a restart's scan lists every message.
    const after = await ownerMailbox([]);
    events.length = 0;
    await after.push({ kind: 'updated', source_id: 'sent-copy', message: copy });
    expect(after.row('sent-copy').hot_fields[MAIL_CHAT_CONVERSATION_FIELD]).toBe(true);
    expect(events.filter((event) => event.event_kind === 'updated')).toEqual([]);
    // A real change still is one.
    await after.push({ kind: 'updated', source_id: 'sent-copy', message: { ...copy, is_read: true } });
    expect(events.filter((event) => event.event_kind === 'updated')).toHaveLength(1);
    const { [MAIL_CHAT_CONVERSATION_FIELD]: _mark, ...unmarked } = after.row('sent-copy').hot_fields;
    expect(mailChangedFields({ ...after.row('sent-copy'), hot_fields: unmarked }, after.row('sent-copy'))).toEqual([]);
  });

  it('a check that throws marks nothing, and the message is stored all the same', async () => {
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'gmail', config: {}, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
    const collection = createMailCollection({
      db, blobs: createBlobStore(join(dir, 'blobs-2')), bus: createWarehouseEventBus(), slug: 'work', instances, now: () => NOW,
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
      provider: {
        kind: 'gmail', slug: 'work', sendCapable: false, mutationCapable: false, accountEmail: OWNER,
        async connect() {},
        async initialScan(opts) { await opts.onMessage(message('m1')); },
        async startSync() { return async () => {}; },
        async close() {},
        health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      },
      isChatConversation: () => { throw new Error('claims unreadable'); },
    });
    open.push(collection);
    await collection.sync.start();
    const rows = collection.list({ platform: 'mail', slug: 'work', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hot_fields[MAIL_CHAT_CONVERSATION_FIELD]).toBeUndefined();
  });
});
