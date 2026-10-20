/** D-158 P2b — email notification `Channel` server-wiring (OUTBOUND slice).
 *
 *  Two halves:
 *    - `composeEmailChannel` unit: the `EmailSender` resolves the
 *      `connection.notification.email` record at send time and maps the
 *      composed `OutboundEmail` onto `mailRpc.send`, with fail-closed
 *      guards for a missing record / sender / recipient.
 *    - wiring: `composeNotificationBlock` includes the email channel in
 *      its fan-out set, so the readiness probe flips the email Settings
 *      row live once a `connection.notification.email` record is enrolled.
 *
 *  Real sqlite for the block harness (mirrors
 *  `d-157-server-wiring-notification-composition.test.ts`); the connection
 *  store + mail rpc are injected stubs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ConnectionRow } from '@recued/contracts';
import type {
  AskOption,
  NotificationMessage,
  RemoteChannel,
} from '@recued/notification';
import type { MailRpcDep } from '@recued/ingredients';
import {
  createAuditLogStore,
  createCheckpointStore,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import { composeEmailChannel } from '../composition/bin/wire-email-channel.js';
import { composeNotificationBlock } from '../composition/bin/wire-notification-block.js';
import { createOwnerEmailConnection, ownerEmailConnectionProblem } from '../composition/bin/owner-email-connection.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { EventBus } from '../events/bus.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

// ────────────────────────────────────────────────────────────────
// Stubs
// ────────────────────────────────────────────────────────────────

const okSend = () =>
  vi.fn<MailRpcDep['send']>(async () => ({ source_id: 's1', message_id: 'm1', sent_at: 1 }));

/** A connection store whose only behaviour is `get('notification','email')`
 *  returning the supplied row (or null). Cast to the full type — the email
 *  channel + readiness probe touch nothing else. */
const stubConnectionStore = (
  row: ConnectionRow | null,
): ConnectionStoreSqlite =>
  ({
    get: (kind: string, name: string) =>
      kind === 'notification' && name === 'email' ? row : null,
  }) as unknown as ConnectionStoreSqlite;

const emailRow = (config: Record<string, unknown>): ConnectionRow =>
  ({
    pk: 'notification:email',
    kind: 'notification',
    name: 'email',
    display_name: 'Email',
    config_json: JSON.stringify(config),
    auth_ciphertext: '',
    enrolled_at: 0,
    updated_at: 0,
  }) as unknown as ConnectionRow;

const VALID_CONFIG = {
  sender_mail_instance: 'mail-1',
  default_recipient: 'inbox@example.test',
};

const notify: NotificationMessage = { title: 'Build ready', text: 'Deploy finished' };
const ask: NotificationMessage = { title: 'Decision', text: 'Approve the plan?' };
const askOptions: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

// ────────────────────────────────────────────────────────────────
// composeEmailChannel — the EmailSender seam
// ────────────────────────────────────────────────────────────────

describe('composeEmailChannel', () => {
  it('is an email landing-page channel', () => {
    const channel = composeEmailChannel({
      connectionStore: stubConnectionStore(emailRow(VALID_CONFIG)),
      mailRpc: { send: okSend() },
    });
    expect(channel.name).toBe('email');
    expect(channel.capability).toBe('landing-page');
  });

  it('deliverNotify sends through mailRpc with resolved sender + recipient', async () => {
    const send = okSend();
    const channel = composeEmailChannel({
      connectionStore: stubConnectionStore(emailRow(VALID_CONFIG)),
      mailRpc: { send },
    });
    await channel.deliverNotify(notify);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      instance: 'mail-1',
      to: ['inbox@example.test'],
      subject: 'Build ready',
      body_text: 'Deploy finished',
    });
  });

  it('deliverAsk carries the [#ask_id] subject tag + lists the options', async () => {
    const send = okSend();
    const channel = composeEmailChannel({
      connectionStore: stubConnectionStore(emailRow(VALID_CONFIG)),
      mailRpc: { send },
    });
    await channel.deliverAsk('ask-xyz', ask, askOptions);
    const sent = send.mock.calls[0][0];
    expect(sent.subject).toContain('[#ask-xyz]');
    expect(sent.body_text).toContain('Approve');
    expect(sent.body_text).toContain('Reject');
  });

  it('coerces an array default_recipient to a multi-recipient send', async () => {
    const send = okSend();
    const channel = composeEmailChannel({
      connectionStore: stubConnectionStore(
        emailRow({ sender_mail_instance: 'mail-1', default_recipient: ['a@x.test', 'b@x.test'] }),
      ),
      mailRpc: { send },
    });
    await channel.deliverNotify(notify);
    expect(send.mock.calls[0][0].to).toEqual(['a@x.test', 'b@x.test']);
  });

  it('resolves the record on EACH send (re-enrollment is picked up)', async () => {
    const send = okSend();
    let current: ConnectionRow | null = emailRow({
      sender_mail_instance: 'mail-old',
      default_recipient: 'old@x.test',
    });
    const connectionStore = {
      get: (kind: string, name: string) =>
        kind === 'notification' && name === 'email' ? current : null,
    } as unknown as ConnectionStoreSqlite;
    const channel = composeEmailChannel({ connectionStore, mailRpc: { send } });

    await channel.deliverNotify(notify);
    expect(send.mock.calls[0][0].instance).toBe('mail-old');
    // Re-enroll between sends.
    current = emailRow({ sender_mail_instance: 'mail-new', default_recipient: 'new@x.test' });
    await channel.deliverNotify(notify);
    expect(send.mock.calls[1][0].instance).toBe('mail-new');
  });

  it('throws (retryable) when no email connection is enrolled', async () => {
    const send = okSend();
    const channel = composeEmailChannel({
      connectionStore: stubConnectionStore(null),
      mailRpc: { send },
    });
    await expect(channel.deliverNotify(notify)).rejects.toThrow(/not enrolled/);
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when the record is missing sender_mail_instance', async () => {
    const channel = composeEmailChannel({
      connectionStore: stubConnectionStore(emailRow({ default_recipient: 'a@x.test' })),
      mailRpc: { send: okSend() },
    });
    await expect(channel.deliverNotify(notify)).rejects.toThrow(/sender_mail_instance/);
  });

  it('throws when the record is missing default_recipient', async () => {
    const channel = composeEmailChannel({
      connectionStore: stubConnectionStore(emailRow({ sender_mail_instance: 'mail-1' })),
      mailRpc: { send: okSend() },
    });
    await expect(channel.deliverNotify(notify)).rejects.toThrow(/default_recipient/);
  });

  it('throws on malformed config_json', async () => {
    const badRow = {
      pk: 'notification:email', kind: 'notification', name: 'email',
      display_name: 'Email', config_json: '{not json', auth_ciphertext: '',
      enrolled_at: 0, updated_at: 0,
    } as unknown as ConnectionRow;
    const channel = composeEmailChannel({
      connectionStore: stubConnectionStore(badRow),
      mailRpc: { send: okSend() },
    });
    await expect(channel.deliverNotify(notify)).rejects.toThrow(/malformed/);
  });
});

// ────────────────────────────────────────────────────────────────
// Wiring — composeNotificationBlock registers the email channel
// ────────────────────────────────────────────────────────────────

/** What a real notification block composes over, closed by `cleanups`. */
const blockStores = (cleanups: Array<() => void>) => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const dir = mkdtempSync(join(tmpdir(), 'email-wiring-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_log'),
    createSQLiteCollection<ActivityEntry>(db, 'activity_log'),
  );
  const checkpointStore = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  ensureSourceDependencyEntitySchema(db);
  const annotationStore = createAnnotationStore({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    now: () => 0,
    newId: () => 'annotation-1',
  });
  const eventBus = {
    cursor: vi.fn(() => 0), subscribe: vi.fn(), unsubscribe: vi.fn(),
    emit: vi.fn((e) => ({ cursor: 1, ...e })), replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  } as unknown as EventBus;
  return {
    db, auditLog, checkpointStore, annotationStore, eventBus,
    getExecuteDeps: (): ExecuteHandlerDeps | undefined => undefined,
  };
};

describe('composeNotificationBlock email wiring', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c();
  });

  const harness = (opts: { withEmail: boolean; connectionRow: ConnectionRow | null }) => {
    const connectionStore = stubConnectionStore(opts.connectionRow);
    const emailChannel = opts.withEmail
      ? composeEmailChannel({ connectionStore, mailRpc: { send: okSend() } })
      : undefined;

    const { block } = composeNotificationBlock({
      ...blockStores(cleanups),
      connectionStore,
      ...(emailChannel ? { emailChannel } : {}),
    });
    return block;
  };

  it('flips the email Settings row READY when the channel + connection are present', async () => {
    const block = harness({ withEmail: true, connectionRow: emailRow(VALID_CONFIG) });
    const rows = await block.describeNotificationChannels();
    const email = rows.find((r) => r.channel === 'email');
    expect(email).toBeDefined();
    expect(email!.capability).toBe('landing-page');
    expect(email!.ready).toBe(true);
  });

  it('keeps the email row NOT-ready when the adapter is absent (structural gate)', async () => {
    // Connection enrolled, but the channel adapter is NOT wired into the
    // fan-out set → the probe's hasAdapter('email') gate keeps it not-ready.
    const block = harness({ withEmail: false, connectionRow: emailRow(VALID_CONFIG) });
    const rows = await block.describeNotificationChannels();
    const email = rows.find((r) => r.channel === 'email');
    expect(email!.ready).toBe(false);
  });

  it('keeps the email row NOT-ready when the channel is wired but no connection is enrolled', async () => {
    const block = harness({ withEmail: true, connectionRow: null });
    const rows = await block.describeNotificationChannels();
    const email = rows.find((r) => r.channel === 'email');
    expect(email!.ready).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// D-158 amendment 2026-10-18 — one address: notifications to the sending mailbox
// ────────────────────────────────────────────────────────────────

describe('composeEmailChannel — a connection naming no recipient notifies its own mailbox', () => {
  const ownerSeam = () => {
    const send = okSend();
    const sendToOwner = vi.fn<NonNullable<MailRpcDep['sendToOwner']>>(async () => ({ source_id: 's2', message_id: 'm2', sent_at: 2 }));
    return { send, sendToOwner, mailRpc: { send, sendToOwner } };
  };
  const pinnedRow = (config: Record<string, unknown>): ConnectionRow =>
    ({ ...emailRow(config), pk: 'notification:owner-mail', name: 'owner-mail', subtype: 'email', enrolled_at: 7 }) as ConnectionRow;
  const envelope = (recipient: string) => ({ group_id: 'g', attempt_id: 'attempt-7', repeat: false,
    destination: { id: 'owner:email', channel: 'email' as const, connection_name: 'owner-mail', connection_enrolled_at: 7,
      recipient, expected_sender: recipient, sender_source: 'mail-1' },
    asks: [{ ask_id: 'ask-1', message: { title: 'Passport', text: 'Renew it.' }, options: [{ id: 'done', label: 'Done' }] }] as never });

  it('sends notify and ask through the owner seam: to the mailbox when no recipient, else to it', async () => {
    const { send, sendToOwner, mailRpc } = ownerSeam();
    await composeEmailChannel({ connectionStore: stubConnectionStore(emailRow({ sender_mail_instance: 'mail-1' })), mailRpc })
      .deliverNotify(notify);
    await composeEmailChannel({ connectionStore: stubConnectionStore(emailRow(VALID_CONFIG)), mailRpc })
      .deliverAsk('ask-9', ask, askOptions);
    expect(sendToOwner.mock.calls.map(([args]) => [args.instance, args.to])).toEqual([['mail-1', undefined], ['mail-1', ['inbox@example.test']]]);
    expect(send).not.toHaveBeenCalled();
  });

  it('delivers a pinned reminder to the mailbox’s own address, stamped with its attempt', async () => {
    const { sendToOwner, mailRpc } = ownerSeam();
    const row = pinnedRow({ sender_mail_instance: 'mail-1' });
    const connectionStore = { get: (kind: string, name: string) => kind === 'notification' && name === row.name ? row : null } as unknown as ConnectionStoreSqlite;
    const channel = composeEmailChannel({ connectionStore, mailRpc, mailboxAddress: slug => slug === 'mail-1' ? 'Owner@Example.test' : undefined });
    expect(await channel.deliverAskDelivery!(envelope('owner@example.test'))).toMatchObject({ outcome: 'delivered' });
    expect(sendToOwner.mock.calls[0]?.[0]).toMatchObject({ instance: 'mail-1', to: ['owner@example.test'], reconciliation_id: 'attempt-7' });
    // The pinned recipient no longer the mailbox's (or no address to compare) ⇒ nothing is sent.
    expect(await channel.deliverAskDelivery!(envelope('someone@example.test'))).toMatchObject({ outcome: 'not_delivered' });
    expect(await composeEmailChannel({ connectionStore, mailRpc }).deliverAskDelivery!(envelope('owner@example.test')))
      .toMatchObject({ outcome: 'not_delivered' });
    expect(sendToOwner).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────
// D-158 amendment 2026-10-19 — a plain notify or ask goes through the
// connection Settings names for it
// ────────────────────────────────────────────────────────────────

describe('a plain notify or ask goes through the connection Settings names for it', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c();
  });

  /** An email notification connection sending from `mailbox`. */
  const mailRow = (name: string, enrolled_at: number, mailbox: string): ConnectionRow =>
    ({ ...emailRow({ sender_mail_instance: mailbox, default_recipient: 'inbox@example.test' }),
      pk: `notification:${name}`, name, display_name: `${name} mailbox`, subtype: 'email', enrolled_at }) as ConnectionRow;
  const telegramRow = (name: string, enrolled_at: number): ConnectionRow =>
    ({ pk: `notification:${name}`, kind: 'notification', name, display_name: `${name} bot`, subtype: 'telegram',
      config_json: '{}', auth_ciphertext: '', enrolled_at, updated_at: 0 }) as unknown as ConnectionRow;

  const harness = (rows: ConnectionRow[]) => {
    const stores = blockStores(cleanups);
    // The production store's two reads, over rows a test enrolls and removes.
    const connectionStore = {
      list: ({ kind }: { kind?: string } = {}) => rows.filter(row => kind === undefined || row.kind === kind),
      get: (kind: string, name: string) => rows.find(row => row.kind === kind && row.name === name) ?? null,
    } as unknown as ConnectionStoreSqlite;
    const send = okSend();
    const emailChannel = composeEmailChannel({
      connectionStore, mailRpc: { send },
      ownerConnection: createOwnerEmailConnection(stores.db, connectionStore),
      ownerConnectionProblem: ownerEmailConnectionProblem,
    });
    const telegram: RemoteChannel = {
      name: 'telegram', capability: 'inline', owns_llm_egress: false,
      deliverNotify: vi.fn(async () => undefined), deliverAsk: vi.fn(async () => undefined),
      closeAsk: vi.fn(async () => undefined),
      parseInboundMessage: vi.fn(() => null), parseInboundReply: vi.fn(() => null),
    };
    const { block } = composeNotificationBlock({
      ...stores, connectionStore, emailChannel, messengerChannels: { telegram },
    });
    const view = async (channel: string) =>
      (await block.describeNotificationChannels()).find(row => row.channel === channel)!;
    const choose = async (channel: 'email' | 'telegram', connection: { name: string; enrolled_at: number } | null) =>
      expect(await block.setNotificationChannelMode(channel, { connection })).toMatchObject({ ok: true });
    // A new ask id each time: the channel sends one ask id once.
    let asks = 0;
    /** The mailboxes a plain notify, then a plain ask, went out from. */
    const sentFrom = async () => {
      send.mockClear();
      await emailChannel.deliverNotify(notify);
      await emailChannel.deliverAsk(`ask-${++asks}`, ask, askOptions);
      return send.mock.calls.map(([args]) => args.instance);
    };
    const refusal = async () => {
      await expect(emailChannel.deliverAsk(`ask-${++asks}`, ask, askOptions)).rejects.toThrow();
      return emailChannel.deliverNotify(notify).then(() => 'sent', (error: Error) => error.message);
    };
    return { block, send, view, choose, sentFrom, refusal };
  };

  it('sends through the only email connection, whatever its name, as the ready row says', async () => {
    const { block, send, view, sentFrom } = harness([mailRow('owner-mail', 1, 'mail-a')]);
    expect(await view('email')).toMatchObject({ ready: true, plain_connection: { name: 'owner-mail', display_name: 'owner-mail mailbox' } });
    expect(await sentFrom()).toEqual(['mail-a', 'mail-a']);
    // Through the block's own fan-out once the owner turns it on.
    expect(await block.setNotificationChannelMode('email', { notification: true })).toMatchObject({ ok: true });
    send.mockClear();
    await block.notify(notify);
    expect(send.mock.calls.map(([args]) => args.instance)).toEqual(['mail-a']);
  });

  it('sends through the connection the owner chose among several, and a new choice applies at the next send', async () => {
    const { view, choose, sentFrom } = harness([mailRow('email', 2, 'mail-b'), mailRow('owner-mail', 1, 'mail-a')]);
    await choose('email', { name: 'owner-mail', enrolled_at: 1 });
    expect(await view('email')).toMatchObject({ ready: true, plain_connection: { name: 'owner-mail' } });
    expect(await sentFrom()).toEqual(['mail-a', 'mail-a']);
    await choose('email', { name: 'email', enrolled_at: 2 });
    expect(await view('email')).toMatchObject({ plain_connection: { name: 'email' } });
    expect(await sentFrom()).toEqual(['mail-b', 'mail-b']);
  });

  it('keeps sending through the one named email while several wait for a choice, and Settings says so', async () => {
    const { view, sentFrom } = harness([mailRow('owner-mail', 1, 'mail-a'), mailRow('email', 2, 'mail-b')]);
    const row = await view('email');
    expect(row).toMatchObject({ ready: false, plain_connection: { name: 'email' } });
    expect(row.connection).toBeUndefined();
    expect(await sentFrom()).toEqual(['mail-b', 'mail-b']);
  });

  it('sends nothing when no connection can carry it, and says what to do in Settings', async () => {
    const rows = [mailRow('owner-mail', 1, 'mail-a'), mailRow('work-mail', 3, 'mail-c')];
    const { send, view, choose, refusal } = harness(rows);
    expect(await view('email')).toMatchObject({ plain_connection: null });
    expect(await refusal()).toMatch(/^Several email connections are enrolled\. Choose the one notifications use in Settings/);
    await choose('email', { name: 'work-mail', enrolled_at: 3 });
    rows.splice(1, 1);
    expect(await view('email')).toMatchObject({ plain_connection: null });
    expect(await refusal()).toMatch(/is no longer enrolled\. Choose another/);
    await choose('email', null);
    expect(await view('email')).toMatchObject({ plain_connection: null });
    expect(await refusal()).toMatch(/^Email notifications have no connection chosen/);
    rows.length = 0;
    expect(await refusal()).toMatch(/^No email connection can carry notifications\. Add one in Settings → Connections/);
    expect(send).not.toHaveBeenCalled();
  });

  // D-158 amendment 2026-10-20 — Telegram follows the owner's choice too.
  it('names the Telegram connection the owner chose, else the only one, else the one called “telegram”', async () => {
    const rows = [telegramRow('family-bot', 5)];
    const { view, choose } = harness(rows);
    expect(await view('telegram')).toMatchObject({ plain_connection: { name: 'family-bot' } });
    // A Telegram connection never carries email.
    expect(await view('email')).toMatchObject({ plain_connection: null });
    rows.push(telegramRow('telegram', 6));
    expect(await view('telegram')).toMatchObject({ plain_connection: { name: 'telegram', display_name: 'telegram bot' } });
    await choose('telegram', { name: 'family-bot', enrolled_at: 5 });
    expect(await view('telegram')).toMatchObject({
      connection: { name: 'family-bot', enrolled_at: 5 },
      plain_connection: { name: 'family-bot', display_name: 'family-bot bot' },
    });
  });
});
