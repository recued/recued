/** D-318 step 1 — the email chat door's chat mailbox.
 *
 *  The owner names one connected mailbox that can send; its mail is the
 *  conversation with Recued, not the owner's mail. This file pins the setting:
 *  the store (one row, kept across restarts, read from memory), the
 *  `collection.mail.chat_door.*` rpc through the real collection slice (a
 *  mailbox that does not exist or cannot send is refused; `null` clears; each
 *  change is audited), the chat mailbox's flag in `collection.mail.list`, and
 *  that no outside agent can reach either rpc. What the mark DOES — no facts,
 *  no contacts, no recipes — is pinned where it happens: `wire-mail-stack.test.ts`
 *  and the trigger dispatcher's tests. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  isReservedLocalRpc,
  MAIL_CHAT_RECENT_REQUESTS_MAX,
  type MailChatDoorCheckResult,
  type MailChatDoorSettings,
  type MailSentByMessageIdResult,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import { makeCollectionHandlers } from '../collections/collection-handler.js';
import { createInstanceStore, type CollectionInstanceStore } from '../collections/instance-store.js';
import type { MailEnrollDeps } from '../collections/mail/enroll.js';
import type { OAuthAccountStore } from '../collections/mail/oauth.js';
import type { CollectionRegistry } from '../collections/registry.js';
import { createMailChatDoorStore } from '../storage/mail-chat-door-store.js';

const accountStore: OAuthAccountStore = {
  async get() { return null; },
  async set() { /* unused */ },
  async delete() { /* unused */ },
  async getAll() { return {}; },
};

/** Two IMAP mailboxes: `recued-chat` can send (it has an SMTP block),
 *  `archive` cannot. */
const seedMailboxes = (instances: CollectionInstanceStore): void => {
  for (const [slug, config] of [
    ['recued-chat', { username: 'recued@owner.example', smtp: { host: 'smtp.owner.example', port: 465 } }],
    ['archive', { username: 'archive@owner.example' }],
  ] as const) {
    instances.upsert({
      platform: 'mail',
      slug,
      adapter_type: 'imap',
      config: { ...config },
      caps: {} as never,
      auth_state: 'healthy',
      last_synced_at: null,
    });
  }
};

const harness = () => {
  const db = new Database(':memory:');
  const instances = createInstanceStore({ db });
  seedMailboxes(instances);
  const mailEnroll: MailEnrollDeps = { instances, accountStore };
  const mailChatDoor = createMailChatDoorStore(db, () => 1_000);
  const logActivity = vi.fn(async () => undefined);
  const auditLog = { logActivity } as unknown as AuditLogStore;
  const slice = makeCollectionHandlers({
    registry: { list: () => [], get: () => undefined } as unknown as CollectionRegistry,
    mailEnroll,
    mailChatDoor,
    auditLog,
  })!;
  const call = (method: string, args?: unknown): Promise<unknown> =>
    (slice.handlers as unknown as Record<string, (args: unknown, client: unknown) => Promise<unknown>>)[method]!(
      args,
      undefined,
    );
  return { db, mailChatDoor, logActivity, call, slice };
};

/** The door's settings, as the store and the rpc answer them. */
const settings = (over: Partial<MailChatDoorSettings> = {}): MailChatDoorSettings => ({
  chat_mailbox: null, ask_prefix: 'ask:', owner_mailboxes: [], chat_address: null, stale_after_minutes: 60,
  paused_at: null, enrolled_senders: [], ...over,
});

describe('the chat mailbox store', () => {
  it('names none until set, keeps what is set across a restart, and clears with null', () => {
    const db = new Database(':memory:');
    const store = createMailChatDoorStore(db);
    expect(store.get()).toEqual(settings());
    expect(store.isChatMailbox('recued-chat')).toBe(false);

    store.setChatMailbox('recued-chat');
    expect(store.isChatMailbox('recued-chat')).toBe(true);
    expect(store.isChatMailbox('archive')).toBe(false);
    expect(createMailChatDoorStore(db).get()).toEqual(settings({ chat_mailbox: 'recued-chat' }));

    store.setChatMailbox(null);
    expect(store.isChatMailbox('recued-chat')).toBe(false);
    expect(createMailChatDoorStore(db).get()).toEqual(settings());
  });

  it('D-318 step 4 — keeps the ask: prefix the owner chose, or none, across a restart', () => {
    const db = new Database(':memory:');
    const store = createMailChatDoorStore(db);
    expect(store.get().ask_prefix).toBe('ask:');
    store.setChatMailbox('recued-chat');
    store.setAskPrefix('chat:');
    expect(createMailChatDoorStore(db).get()).toEqual(settings({ chat_mailbox: 'recued-chat', ask_prefix: 'chat:' }));
    store.setAskPrefix(null);
    expect(createMailChatDoorStore(db).get()).toEqual(settings({ chat_mailbox: 'recued-chat', ask_prefix: null }));
    // A row from before the setting has the filter on.
    db.prepare(`UPDATE mail_chat_door SET settings_json = '{"chat_mailbox":"recued-chat"}'`).run();
    expect(createMailChatDoorStore(db).get()).toEqual(settings({ chat_mailbox: 'recued-chat' }));
  });

  it('D-318 step 6 — keeps how late a request may run, an hour by default, across a restart', () => {
    const db = new Database(':memory:');
    const store = createMailChatDoorStore(db);
    expect(store.get().stale_after_minutes).toBe(60);
    store.setStaleAfterMinutes(15);
    expect(createMailChatDoorStore(db).get()).toEqual(settings({ stale_after_minutes: 15 }));
    // A row from before the setting, or with a value it would refuse, has the default.
    for (const json of ['{"chat_mailbox":"recued-chat"}', '{"stale_after_minutes":2}', '{"stale_after_minutes":"15"}']) {
      db.prepare('UPDATE mail_chat_door SET settings_json = ?').run(json);
      expect(createMailChatDoorStore(db).get().stale_after_minutes, json).toBe(60);
    }
  });

  it('D-318 step 6 — the burst guard pauses once, and the pause holds across a restart until resumed', () => {
    const db = new Database(':memory:');
    const store = createMailChatDoorStore(db);
    expect(store.pause(5_000)).toBe(true);
    // Paused already: the first pause is the one the owner was told of.
    expect(store.pause(9_000)).toBe(false);
    expect(createMailChatDoorStore(db).get().paused_at).toBe(5_000);
    expect(store.resume()).toEqual(settings());
    expect(createMailChatDoorStore(db).get().paused_at).toBeNull();
    // Resumed, the next burst pauses it again.
    expect(store.pause(12_000)).toBe(true);
  });

  it('reads a row it cannot parse as naming no chat mailbox', () => {
    const db = new Database(':memory:');
    createMailChatDoorStore(db);
    db.prepare("INSERT INTO mail_chat_door (id, settings_json, updated_at) VALUES (1, '{not json', 0)").run();
    expect(createMailChatDoorStore(db).get()).toEqual(settings());
  });
});

describe('the D-318 audit — the owner’s mailboxes, and a mailbox deleted', () => {
  it('names the owner’s own mailboxes: no repeats, never the chat mailbox, ten at most, kept across a restart', () => {
    const db = new Database(':memory:');
    const store = createMailChatDoorStore(db);
    store.setChatMailbox('recued-chat', ' Recued@Owner.example ');
    store.setOwnerMailboxes(['me', 'work', 'me', 'recued-chat']);
    expect(createMailChatDoorStore(db).get()).toEqual(settings({
      chat_mailbox: 'recued-chat', chat_address: 'recued@owner.example', owner_mailboxes: ['me', 'work'],
    }));
    store.setOwnerMailboxes(Array.from({ length: 12 }, (_, i) => `m${i}`));
    expect(store.get().owner_mailboxes).toHaveLength(10);
  });

  it('naming one of the owner’s mailboxes the chat mailbox takes it off their list', () => {
    const store = createMailChatDoorStore(new Database(':memory:'));
    store.setOwnerMailboxes(['me', 'work']);
    store.setChatMailbox('work');
    expect(store.get()).toEqual(settings({ chat_mailbox: 'work', owner_mailboxes: ['me'] }));
  });

  it('a row from before the audit names no owner’s mailbox and no address: nothing is proven until they are named', () => {
    const db = new Database(':memory:');
    createMailChatDoorStore(db).setChatMailbox('recued-chat');
    db.prepare(`UPDATE mail_chat_door SET settings_json = '{"chat_mailbox":"recued-chat","ask_prefix":"ask:"}'`).run();
    expect(createMailChatDoorStore(db).get()).toEqual(settings({ chat_mailbox: 'recued-chat' }));
  });

  it('forgets a deleted mailbox — as the chat mailbox with its address, and as the owner’s', () => {
    const db = new Database(':memory:');
    const store = createMailChatDoorStore(db);
    store.setChatMailbox('recued-chat', 'recued@owner.example');
    store.setOwnerMailboxes(['me', 'work']);
    store.forgetMailbox('work');
    expect(store.get()).toEqual(settings({
      chat_mailbox: 'recued-chat', chat_address: 'recued@owner.example', owner_mailboxes: ['me'],
    }));
    store.forgetMailbox('recued-chat');
    expect(createMailChatDoorStore(db).get()).toEqual(settings({ owner_mailboxes: ['me'] }));
    // Another mailbox going changes nothing.
    const before = store.get();
    expect(store.forgetMailbox('archive')).toBe(before);
  });
});

describe('collection.mail.chat_door.* — naming the chat mailbox', () => {
  it('names a connected mailbox that can send, audits it, and flags it in the mailbox list', async () => {
    const h = harness();
    // Its address is kept with it: the door needs it while the mailbox is not running.
    const named = settings({ chat_mailbox: 'recued-chat', chat_address: 'recued@owner.example' });
    await expect(h.call('collection.mail.chat_door.set', { chat_mailbox: 'recued-chat' })).resolves.toEqual(named);
    await expect(h.call('collection.mail.chat_door.get')).resolves.toEqual(named);
    expect(h.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mail_chat_door_set',
      detail: JSON.stringify({ chat_mailbox: 'recued-chat' }),
    }));

    const listed = await h.call('collection.mail.list') as {
      instances: Array<{ slug: string; chat_mailbox?: true }>;
    };
    expect(listed.instances.find((row) => row.slug === 'recued-chat')?.chat_mailbox).toBe(true);
    expect(Object.hasOwn(listed.instances.find((row) => row.slug === 'archive')!, 'chat_mailbox')).toBe(false);
  });

  it('refuses a mailbox that cannot send, and one that is not connected, and changes nothing', async () => {
    const h = harness();
    await expect(h.call('collection.mail.chat_door.set', { chat_mailbox: 'archive' }))
      .rejects.toMatchObject({ code: 'failed_precondition', status: 409 });
    await expect(h.call('collection.mail.chat_door.set', { chat_mailbox: 'nowhere' }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(h.mailChatDoor.get()).toEqual(settings());
    expect(h.logActivity).not.toHaveBeenCalled();
  });

  it('refuses anything but a slug or null', async () => {
    const h = harness();
    for (const args of [undefined, 'recued-chat', { chat_mailbox: 7 }, { chat_mailbox: true }, ['recued-chat']]) {
      await expect(h.call('collection.mail.chat_door.set', args))
        .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    }
  });

  it('D-318 step 4 — sets the ask: prefix, or switches the filter off, alone or with the mailbox, and audits what changed', async () => {
    const h = harness();
    await expect(h.call('collection.mail.chat_door.set', { ask_prefix: 'Recued:' }))
      .resolves.toEqual(settings({ ask_prefix: 'Recued:' }));
    expect(h.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'mail_chat_door_set', detail: JSON.stringify({ ask_prefix: 'Recued:' }),
    }));
    await expect(h.call('collection.mail.chat_door.set', { chat_mailbox: 'recued-chat', ask_prefix: null }))
      .resolves.toEqual(settings({ chat_mailbox: 'recued-chat', chat_address: 'recued@owner.example', ask_prefix: null }));
    expect(h.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      detail: JSON.stringify({ chat_mailbox: 'recued-chat', ask_prefix: null }),
    }));
  });

  it('D-318 step 4 — refuses a prefix that is empty, too long, padded or on two lines, and an empty call', async () => {
    const h = harness();
    for (const args of [{}, { ask_prefix: '' }, { ask_prefix: 'x'.repeat(33) }, { ask_prefix: ' ask:' },
      { ask_prefix: 'ask:\n' }, { ask_prefix: 7 }]) {
      await expect(h.call('collection.mail.chat_door.set', args))
        .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    }
    expect(h.mailChatDoor.get()).toEqual(settings());
    expect(h.logActivity).not.toHaveBeenCalled();
  });

  it('D-318 step 6 — sets how late a request may run, from 5 minutes to a day, and audits it', async () => {
    const h = harness();
    for (const minutes of [5, 90, 1440]) {
      await expect(h.call('collection.mail.chat_door.set', { stale_after_minutes: minutes }))
        .resolves.toEqual(settings({ stale_after_minutes: minutes }));
    }
    expect(h.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'mail_chat_door_set', detail: JSON.stringify({ stale_after_minutes: 1440 }),
    }));
    for (const minutes of [4, 1441, 60.5, '60', null, 0]) {
      await expect(h.call('collection.mail.chat_door.set', { stale_after_minutes: minutes }), String(minutes))
        .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    }
    expect(h.mailChatDoor.get().stale_after_minutes).toBe(1440);
  });

  it('D-318 step 6 — resume: true takes requests again after the burst guard paused the door, and is audited', async () => {
    const h = harness();
    h.mailChatDoor.pause(5_000);
    await expect(h.call('collection.mail.chat_door.set', { resume: false }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(h.mailChatDoor.get().paused_at).toBe(5_000);
    await expect(h.call('collection.mail.chat_door.set', { resume: true })).resolves.toEqual(settings());
    expect(h.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'mail_chat_door_set', detail: JSON.stringify({ resumed: true }),
    }));
    // Not paused: nothing to resume, nothing changes.
    await expect(h.call('collection.mail.chat_door.set', { resume: true })).resolves.toEqual(settings());
  });

  it('clears with null, and the list flags no mailbox', async () => {
    const h = harness();
    await h.call('collection.mail.chat_door.set', { chat_mailbox: 'recued-chat' });
    await expect(h.call('collection.mail.chat_door.set', { chat_mailbox: null }))
      .resolves.toEqual(settings());
    const listed = await h.call('collection.mail.list') as { instances: Array<Record<string, unknown>> };
    expect(listed.instances.every((row) => !Object.hasOwn(row, 'chat_mailbox'))).toBe(true);
  });

  it('the D-318 audit — names the owner’s mailboxes, each connected, and audits them', async () => {
    const h = harness();
    await expect(h.call('collection.mail.chat_door.set', { owner_mailboxes: ['archive'] }))
      .resolves.toEqual(settings({ owner_mailboxes: ['archive'] }));
    expect(h.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'mail_chat_door_set', detail: JSON.stringify({ owner_mailboxes: ['archive'] }),
    }));
    await expect(h.call('collection.mail.chat_door.set', { owner_mailboxes: ['nowhere'] }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(h.call('collection.mail.chat_door.set', { owner_mailboxes: [] }))
      .resolves.toEqual(settings());
  });

  it('the D-318 audit — a mailbox is the chat mailbox or one of the owner’s, never both', async () => {
    const h = harness();
    await h.call('collection.mail.chat_door.set', { chat_mailbox: 'recued-chat' });
    await expect(h.call('collection.mail.chat_door.set', { owner_mailboxes: ['archive', 'recued-chat'] }))
      .rejects.toMatchObject({ code: 'failed_precondition', status: 409 });
    await expect(h.call('collection.mail.chat_door.set', { chat_mailbox: null, owner_mailboxes: ['recued-chat'] }))
      .resolves.toEqual(settings({ owner_mailboxes: ['recued-chat'] }));
    await expect(h.call('collection.mail.chat_door.set', { chat_mailbox: 'recued-chat' }))
      .rejects.toMatchObject({ code: 'failed_precondition', status: 409 });
    expect(h.mailChatDoor.get()).toEqual(settings({ owner_mailboxes: ['recued-chat'] }));
  });

  it('the D-318 audit — refuses an owner’s list that is not slugs, or names more than ten', async () => {
    const h = harness();
    for (const owner_mailboxes of ['me', [7], [''], Array.from({ length: 11 }, (_, i) => `m${i}`), null]) {
      await expect(h.call('collection.mail.chat_door.set', { owner_mailboxes }))
        .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    }
    expect(h.mailChatDoor.get()).toEqual(settings());
  });

  it('is in the collection slice, and reserved from every outside agent', () => {
    const h = harness();
    const methods = ['get', 'set', 'check', 'recent'].map((name) => `collection.mail.chat_door.${name}`);
    expect(h.slice.methods).toEqual(expect.arrayContaining(methods));
    for (const method of methods) expect(isReservedLocalRpc(method), method).toBe(true);
  });

  it('answers not_configured without the store', async () => {
    const slice = makeCollectionHandlers({
      registry: { list: () => [], get: () => undefined } as unknown as CollectionRegistry,
    })!;
    const handlers = slice.handlers as unknown as Record<string, (args: unknown, client: unknown) => Promise<unknown>>;
    await expect(handlers['collection.mail.chat_door.get']!(undefined, undefined))
      .rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('D-318 step 8 — collection.mail.chat_door.set enrols an address Recued does not read', () => {
  const on = async (h: ReturnType<typeof harness>) => {
    await h.call('collection.mail.chat_door.set', { chat_mailbox: 'recued-chat' });
  };

  it('enrols with a code the owner sees, audited without it; a second call is a new code', async () => {
    const h = harness();
    await on(h);
    const first = await h.call('collection.mail.chat_door.set', { enroll: '  Me@Personal.Example ' }) as MailChatDoorSettings;
    expect(first.enrolled_senders).toEqual([expect.objectContaining({
      address: 'me@personal.example', state: 'pending', chat_mailbox: 'recued-chat', code: expect.stringMatching(/^\d{6}$/),
    })]);
    expect(h.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'mail_chat_door_set', detail: JSON.stringify({ enrolled: 'me@personal.example' }),
    }));
    expect(JSON.stringify(h.logActivity.mock.calls)).not.toContain(first.enrolled_senders[0]!.code!);
    const again = await h.call('collection.mail.chat_door.set', { enroll: 'me@personal.example' }) as MailChatDoorSettings;
    expect(again.enrolled_senders).toHaveLength(1);
    await expect(h.call('collection.mail.chat_door.set', { unenroll: 'ME@personal.example' }))
      .resolves.toMatchObject({ enrolled_senders: [] });
    expect(h.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'mail_chat_door_set', detail: JSON.stringify({ unenrolled: 'me@personal.example' }),
    }));
  });

  it('refuses while the door is off, an address that is not one, and one alongside a mailbox change', async () => {
    const h = harness();
    await expect(h.call('collection.mail.chat_door.set', { enroll: 'me@personal.example' }))
      .rejects.toMatchObject({ code: 'failed_precondition', status: 409 });
    await on(h);
    for (const enroll of ['me', 'me@', '@personal.example', 'me@personal', 'me @personal.example', '"me"@personal.example', 7, null]) {
      await expect(h.call('collection.mail.chat_door.set', { enroll }), String(enroll))
        .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    }
    await expect(h.call('collection.mail.chat_door.set', { enroll: 'me@personal.example', chat_mailbox: 'recued-chat' }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(h.call('collection.mail.chat_door.set', { unenroll: 7 }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(h.mailChatDoor.get().enrolled_senders).toEqual([]);
  });

  it('refuses the chat mailbox itself, a mailbox Recued reads, and a sixth address', async () => {
    const h = harness();
    await on(h);
    await expect(h.call('collection.mail.chat_door.set', { enroll: 'recued@owner.example' }))
      .rejects.toMatchObject({ code: 'failed_precondition', message: expect.stringMatching(/chat mailbox itself/) });
    // `archive` is connected: its Sent folder is the proof.
    await expect(h.call('collection.mail.chat_door.set', { enroll: 'Archive@owner.example' }))
      .rejects.toMatchObject({ code: 'failed_precondition', message: expect.stringMatching(/Recued reads/) });
    for (let i = 0; i < 5; i += 1) await h.call('collection.mail.chat_door.set', { enroll: `me${i}@personal.example` });
    await expect(h.call('collection.mail.chat_door.set', { enroll: 'me5@personal.example' }))
      .rejects.toMatchObject({ code: 'failed_precondition', message: expect.stringMatching(/At most 5/) });
    // One already listed may get a new code.
    await expect(h.call('collection.mail.chat_door.set', { enroll: 'me0@personal.example' })).resolves.toBeDefined();
  });
});

describe('D-318 step 7 — collection.mail.chat_door.check, before the door is switched on', () => {
  type Lookup = (query: { rfc_message_id: string }) => Promise<MailSentByMessageIdResult>;
  /** The slice over the two seeded mailboxes, `running` as Recued has them now. */
  const checking = (options: {
    running?: string[]; lookup?: Lookup; firstSyncDone?: string[]; auth?: Record<string, 'expired'>;
  } = {}) => {
    const db = new Database(':memory:');
    const instances = createInstanceStore({ db });
    seedMailboxes(instances);
    // The owner's own, and — under another name — the chat mailbox's account again.
    for (const [slug, username] of [['work', 'me@owner.example'], ['twin', 'Recued@Owner.example']] as const) {
      instances.upsert({
        platform: 'mail', slug, adapter_type: 'imap', config: { username },
        caps: {} as never, auth_state: options.auth?.[slug] ?? 'healthy', last_synced_at: null,
      });
    }
    for (const slug of options.firstSyncDone ?? ['recued-chat']) instances.markBackfillComplete('mail', slug);
    const lookup = vi.fn<Lookup>(options.lookup ?? (async () => ({ status: 'not_found' })));
    const live = (options.running ?? ['recued-chat', 'archive', 'work', 'twin']).map((slug) => ({
      platform: 'mail', slug, accountEmail: `${slug}@x`, lookupSentByMessageId: lookup,
    }));
    const mailChatDoor = createMailChatDoorStore(db);
    const slice = makeCollectionHandlers({
      registry: { list: () => live, get: () => undefined } as unknown as CollectionRegistry,
      mailEnroll: { instances, accountStore },
      mailChatDoor,
    })!;
    const check = (args?: unknown) =>
      (slice.handlers as unknown as Record<string, (args: unknown, client: unknown) => Promise<MailChatDoorCheckResult>>)[
        'collection.mail.chat_door.check'
      ]!(args, undefined);
    return { check, lookup, mailChatDoor };
  };

  it('passes a chat mailbox that sends and has synced, and an owner’s mailbox whose Sent record can be asked', async () => {
    const h = checking();
    await expect(h.check({ chat_mailbox: 'recued-chat', owner_mailboxes: ['work'] })).resolves.toEqual({
      ready: true,
      checks: [
        { kind: 'chat_mailbox', slug: 'recued-chat', status: 'pass', text: 'It can send, and its first sync is done.' },
        {
          kind: 'owner_mailbox', slug: 'work', status: 'pass',
          text: 'Recued can look in its Sent folder, which is how it knows an email to the chat mailbox is yours.',
        },
      ],
    });
    // One lookup, for a Message-ID no message has.
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.lookup.mock.calls[0]![0].rfc_message_id).toMatch(/^recued-door-check-[0-9a-f-]{36}@invalid$/);
  });

  it('checks the mailboxes named when none are given', async () => {
    const h = checking();
    h.mailChatDoor.setChatMailbox('recued-chat');
    h.mailChatDoor.setOwnerMailboxes(['work']);
    await expect(h.check()).resolves.toMatchObject({ ready: true });
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });

  it('fails a chat mailbox that cannot send, and one not connected; waits on one still syncing or not running', async () => {
    const h = checking({ running: ['recued-chat', 'work'], firstSyncDone: [] });
    const chat = async (chat_mailbox: string) =>
      (await h.check({ chat_mailbox, owner_mailboxes: ['work'] })).checks[0];
    await expect(chat('archive')).resolves.toMatchObject({ status: 'unknown', text: expect.stringMatching(/not connected to it right now/) });
    await expect(chat('recued-chat')).resolves.toMatchObject({ status: 'unknown', text: expect.stringMatching(/first sync is still running/) });
    await expect(chat('gone')).resolves.toMatchObject({ status: 'fail', text: 'No connected mailbox is named "gone".' });
    const sending = checking({ firstSyncDone: ['archive'] });
    await expect((await sending.check({ chat_mailbox: 'archive', owner_mailboxes: ['work'] })).checks[0])
      .toMatchObject({ status: 'fail', text: expect.stringMatching(/cannot send mail/) });
  });

  it('tells a Sent folder Recued cannot read from one it could not reach just now', async () => {
    for (const [result, status] of [
      [{ status: 'unavailable', reason: 'unsupported' }, 'fail'],
      [{ status: 'unavailable', reason: 'provider_error' }, 'unknown'],
    ] as const) {
      const h = checking({ lookup: async () => result });
      const checked = await h.check({ chat_mailbox: 'recued-chat', owner_mailboxes: ['work'] });
      expect(checked).toMatchObject({ ready: false, checks: [{ status: 'pass' }, { kind: 'owner_mailbox', status }] });
    }
    const throwing = checking({ lookup: async () => { throw new Error('socket hang up'); } });
    await expect(throwing.check({ chat_mailbox: 'recued-chat', owner_mailboxes: ['work'] }))
      .resolves.toMatchObject({ ready: false, checks: [{}, { status: 'unknown' }] });
  });

  it('asks the owner to sign in again, and refuses the chat mailbox as their own or one with its address', async () => {
    const expired = checking({ auth: { work: 'expired' } });
    await expect(expired.check({ chat_mailbox: 'recued-chat', owner_mailboxes: ['work'] }))
      .resolves.toMatchObject({ ready: false, checks: [{}, { status: 'unknown', text: expect.stringMatching(/sign in to it again/) }] });
    expect(expired.lookup).not.toHaveBeenCalled();
    const h = checking();
    await expect(h.check({ chat_mailbox: 'recued-chat', owner_mailboxes: ['recued-chat'] }))
      .resolves.toMatchObject({ checks: [{}, { status: 'fail', text: expect.stringMatching(/It is the chat mailbox/) }] });
    await expect(h.check({ chat_mailbox: 'recued-chat', owner_mailboxes: ['twin'] }))
      .resolves.toMatchObject({ checks: [{}, { status: 'fail', text: expect.stringMatching(/connected twice/) }] });
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('with none named, says what to pick; refuses what is not a slug', async () => {
    const h = checking();
    // Step 8 — none of the owner's mailboxes is not a failure: the door can be
    // for addresses Recued does not read, added once it is on.
    await expect(h.check()).resolves.toEqual({
      ready: false,
      checks: [
        { kind: 'chat_mailbox', slug: '', status: 'fail', text: 'Pick the mailbox Recued answers from.' },
      ],
    });
    for (const args of [{ chat_mailbox: 7 }, { chat_mailbox: '' }, { owner_mailboxes: 'work' }, { owner_mailboxes: [''] }, []]) {
      await expect(h.check(args)).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    }
  });
});

describe('D-318 step 7 — collection.mail.chat_door.recent, for the test round trip', () => {
  it('lists the latest requests and how far each got — never a subject or a body', async () => {
    const db = new Database(':memory:');
    const mailChatDoor = createMailChatDoorStore(db);
    const recent = vi.fn(() => [{
      rfc_message_id: 'ping@owner.example', from_address: 'me@owner.example', arrived_at: 5_000, state: 'proven',
      proof: 'enrolled', reason: null, admit_state: 'admitted', admit_reason: null, sender_auth: 'pass',
    }] as never);
    const ofRequest = vi.fn(() => ({ state: 'sent' as const, sent_at: 9_000 }));
    const slice = makeCollectionHandlers({
      registry: { list: () => [], get: () => undefined } as unknown as CollectionRegistry,
      mailChatDoor, mailChatRequests: { recent }, mailChatAnswers: { ofRequest },
    })!;
    const call = () => (slice.handlers as unknown as Record<string, (args: unknown, client: unknown) => Promise<unknown>>)[
      'collection.mail.chat_door.recent'
    ]!(undefined, undefined);
    // No chat mailbox, no requests.
    await expect(call()).resolves.toEqual({ requests: [] });
    mailChatDoor.setChatMailbox('recued-chat');
    await expect(call()).resolves.toEqual({
      requests: [{
        arrived_at: 5_000, from: 'me@owner.example', state: 'proven', proof: 'enrolled', reason: null, chat: 'admitted',
        chat_reason: null, sender_auth: 'pass', answer: 'sent', answered_at: 9_000,
      }],
    });
    expect(recent).toHaveBeenCalledWith('recued-chat', MAIL_CHAT_RECENT_REQUESTS_MAX);
    expect(ofRequest).toHaveBeenCalledWith('recued-chat', 'ping@owner.example');
  });
});

describe('the chat mailbox is checked wherever mail is read', () => {
  // ⚠ Source checks, because each site is a composition root whose real
  // collaborators (a live mail stack, the trigger substrate, the housekeeping
  // scheduler) a unit test cannot stand up; the behaviour itself is pinned at
  // each reader (wire-mail-stack, the dispatcher, the source walkers). A wiring
  // line dropped here is what these catch.
  const read = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8');

  it('the collection context makes the one store and hands it to the mail stack', () => {
    const source = read('../serve/compose-collection-context.ts');
    expect(source).toContain('createMailChatDoorStore(db)');
    expect(source).toContain('isChatMailbox: (slug: string) => mailChatDoor.isChatMailbox(slug)');
  });

  it('the listeners hand it to the trigger dispatcher and the mailbox rpcs', () => {
    const source = read('../serve/compose-listeners.ts');
    expect(source).toContain('isChatMailbox: (slug: string) => collection.mailChatDoor!.isChatMailbox(slug)');
    expect(source).toContain('mailChatDoor: collection.mailChatDoor');
    expect(read('../composition/bin/wire-event-triggers.ts')).toContain('...(isChatMailbox ? { isChatMailbox } : {})');
  });

  it('the housekeeping scheduler hands it to the mail walkers', () => {
    expect(read('../serve/start-schedulers.ts'))
      .toContain('isChatMailbox: (slug: string) => collection.mailChatDoor!.isChatMailbox(slug)');
    const substrate = read('../composition/bin/wire-housekeeping-substrate.ts');
    expect(substrate.match(/\.\.\.\(deps\.isChatMailbox \? \{ isChatMailbox: deps\.isChatMailbox \} : \{\}\)/g))
      .toHaveLength(2);
  });
});
