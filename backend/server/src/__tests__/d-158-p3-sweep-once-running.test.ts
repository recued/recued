/** D-158 P3 — what a restarted server does with the asks it finds, through its own startup code.
 *
 *  `startBootRecoveryAndAdapters` (the boot's recovery step, then the adapters) and
 *  `recoverPendingAsksOnceRunning` (the sweep once the server runs, as `composeListeners` wires
 *  it), over one real SQLite database kept across the restart: the real notification block,
 *  Telegram through the real transport against a stand-in Bot API, and email through the real
 *  send path (`handleCollectionMailSend`), which finds its mailbox in the collection registry
 *  only once `startCollectionAdapters` has registered it. Before, the sweep ran inside the
 *  recovery step, ahead of the adapters: its email was refused (`COLLECTION_NOT_FOUND`), and an
 *  approval answered while the server stopped resumed its run without its mailboxes and
 *  calendars (found 2026-11-02). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ConnectionAuth, ConnectionRow } from '@recued/contracts';
import {
  createAskStore,
  type AskOption,
  type NotificationBlock,
  type NotificationMessage,
  type PendingAsk,
} from '@recued/notification';
import {
  createAuditLogStore,
  createCheckpointStore,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import { handleCollectionMailSend } from '../collections/collection-handler.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { composeEmailChannel } from '../composition/bin/wire-email-channel.js';
import { buildMessengerRemoteChannels } from '../composition/bin/messenger-transport-leaves.js';
import {
  composeNotificationBlock,
  recoverPendingAsksOnceRunning,
} from '../composition/bin/wire-notification-block.js';
import type { EventBus } from '../events/bus.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { Lifecycle } from '../lifecycle/index.js';
import { createLifecycleStateMachine, type LifecycleStateMachine } from '../lifecycle/lifecycle-state.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { startBootRecoveryAndAdapters } from '../serve/start-boot-recovery-and-adapters.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';

const blob = (auth: ConnectionAuth) => Buffer.from(JSON.stringify(auth)).toString('base64');
const CONNECTIONS: ReadonlyArray<Omit<ConnectionRow, 'pk'>> = [
  { kind: 'notification', subtype: 'telegram', name: 'telegram', display_name: 'Telegram', enrolled_at: 1, updated_at: 1,
    config_json: JSON.stringify({ chat_id: 'owner-chat', principal_id: '1001' }),
    auth_ciphertext: blob({ type: 'bearer', token: 'token-telegram' }) },
  { kind: 'notification', subtype: 'email', name: 'email', display_name: 'Email', enrolled_at: 1, updated_at: 1,
    config_json: JSON.stringify({ sender_mail_instance: 'mail-1', default_recipient: 'inbox@example.test' }),
    auth_ciphertext: blob({ type: 'bearer', token: 'unused' }) },
];
const approval: NotificationMessage = { title: 'Approve: Remove a calendar event', text: '"Dentist" is waiting for your approval.' };
const options: readonly AskOption[] = [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }];
const HANDLER = 'test.p3-sweep';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** One server's database, kept across the restart. */
const serverDb = () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const dir = mkdtempSync(join(tmpdir(), 'p3-sweep-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const connections = createConnectionStore(db);
  for (const row of CONNECTIONS) connections.upsert(row);
  createInstanceStore({ db }).upsert({ platform: 'mail', slug: 'mail-1', adapter_type: 'imap',
    config: { username: 'mail-1@example.test', smtp: { host: 'smtp.example.test' } },
    caps: {} as never, auth_state: 'healthy', last_synced_at: null });
  return { db, dir };
};

/** The Bot API, numbering its messages; `failing` answers every call with a 500. */
const botApi = (failing = false) => {
  const calls: string[] = [];
  let id = 100;
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url).split('/').pop() ?? '');
    if (failing) {
      return new Response(JSON.stringify({ ok: false, error_code: 500, description: 'stand-in down' }),
        { status: 500, headers: { 'content-type': 'application/json' } });
    }
    id += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: id } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

/** One process over the database: its own channels, block and collection registry, empty until
 *  its adapters start, as a server's is. */
const process_ = (db: Database.Database, dir: string, bot: ReturnType<typeof botApi>) => {
  const connectionStore = createConnectionStore(db);
  const registry = createCollectionRegistry();
  const mailbox = {
    platform: 'mail', slug: 'mail-1',
    send: vi.fn(async (_args: { subject: string }) => ({ source_id: 's', message_id: 'm', sent_at: 1, _id: null, _collection: 'data.mail' })),
  };
  const emailChannel = composeEmailChannel({
    connectionStore, db,
    mailRpc: { send: (args) => handleCollectionMailSend({ registry }, args) as never },
  });
  const { telegram } = buildMessengerRemoteChannels({ connectionStore, transportOptions: { fetchImpl: bot.fetchImpl }, db });
  const checkpointStore = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
  ensureCheckpointSchema(db);
  ensureSourceDependencyEntitySchema(db);
  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_log'),
    createSQLiteCollection<ActivityEntry>(db, 'activity_log'),
  );
  const eventBus = {
    cursor: vi.fn(() => 0), subscribe: vi.fn(), unsubscribe: vi.fn(),
    emit: vi.fn((event) => ({ cursor: 1, ...event })), replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  } as unknown as EventBus;
  const { block } = composeNotificationBlock({
    db, auditLog, checkpointStore, eventBus, connectionStore, emailChannel, messengerChannels: { telegram: telegram! },
    annotationStore: createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')), now: () => 0, newId: () => 'annotation-1' }),
    getExecuteDeps: (): ExecuteHandlerDeps | undefined => undefined,
  });
  /** For each run of the handler: whether the mailbox was registered when it ran, as an
   *  approved run needs its mailboxes and calendars. */
  const handled: boolean[] = [];
  block.registerAskHandler(HANDLER, async () => { handled.push(registry.get('mail', 'mail-1') !== undefined); });
  return { block, checkpointStore, auditLog, registry, mailbox, handled, bot };
};
type Process = ReturnType<typeof process_>;

const raise = async (p: Process): Promise<string> => {
  for (const channel of ['telegram', 'email'] as const) {
    expect(await p.block.setNotificationChannelMode(channel, { approval: true })).toMatchObject({ ok: true });
  }
  return (await p.block.ask(approval, options, { kind: HANDLER, payload: {} })).ask_id;
};

/** The restarted server, as it starts: the boot's recovery step and adapters, then the sweep
 *  held for `running` (wired after them, as `composeListeners` runs after them). Returns the
 *  machine and the sweep's own promise once it has started. */
const restart = async (p: Process) => {
  const machine: LifecycleStateMachine = createLifecycleStateMachine('booting');
  const swept = vi.spyOn(p.block, 'recoverPendingAsks');
  await startBootRecoveryAndAdapters({
    lifecycle: { machine } as unknown as Lifecycle,
    bootSigningIdentity: async () => undefined,
    notificationBlock: p.block as NotificationBlock,
    checkpointStore: p.checkpointStore,
    auditLog: p.auditLog,
    commitStore: undefined,
    fileStack: undefined,
    collection: { startCollectionAdapters: async () => { p.registry.register(p.mailbox as never); } },
    warn: () => undefined,
  });
  recoverPendingAsksOnceRunning({ block: p.block, lifecycle: { machine } });
  return {
    machine,
    swept,
    run: async () => {
      machine.transition('running');
      expect(swept).toHaveBeenCalledTimes(1);
      await swept.mock.results[0]!.value;
    },
  };
};

const askRow = (db: Database.Database, ask_id: string) =>
  createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')).get(ask_id);

describe('D-158 P3 — a restarted server sweeps its asks once it runs, through its own startup code', () => {
  it('an approval that reached Telegram but not email is emailed once the server runs, and Telegram is not sent it again', async () => {
    const { db, dir } = serverDb();
    // Before the restart its email could not go (no mailbox registered yet), its Telegram message did.
    const before = process_(db, dir, botApi());
    const ask_id = await raise(before);
    expect(before.bot.calls).toEqual(['sendMessage']);
    expect(before.mailbox.send).not.toHaveBeenCalled();

    const after = process_(db, dir, botApi());
    const server = await restart(after);
    // The boot step sends nothing, though its adapters have registered the mailbox by its end.
    expect(after.registry.get('mail', 'mail-1')).toBeDefined();
    expect(server.swept).not.toHaveBeenCalled();
    expect(after.mailbox.send).not.toHaveBeenCalled();

    await server.run();
    expect(after.mailbox.send).toHaveBeenCalledTimes(1);
    expect(after.mailbox.send.mock.calls[0]![0].subject).toContain(`[#${ask_id}]`);
    expect(after.bot.calls).toEqual([]);
    expect(await askRow(db, ask_id)).toMatchObject({ status: 'open' });
  });

  it('an approval that reached no channel before the restart reaches each once the server runs', async () => {
    const { db, dir } = serverDb();
    const before = process_(db, dir, botApi(true));
    const ask_id = await raise(before);
    expect(before.mailbox.send).not.toHaveBeenCalled();

    const after = process_(db, dir, botApi());
    await (await restart(after)).run();
    expect(after.bot.calls).toEqual(['sendMessage']);
    expect(after.mailbox.send).toHaveBeenCalledTimes(1);
    expect(after.mailbox.send.mock.calls[0]![0].subject).toContain(`[#${ask_id}]`);
  });

  it('⛔ CONTROL: swept where the boot step swept it, the email is refused, its mailbox not registered yet', async () => {
    const { db, dir } = serverDb();
    await raise(process_(db, dir, botApi()));
    const after = process_(db, dir, botApi());
    // What the recovery step did before: the sweep, ahead of `startCollectionAdapters`.
    await after.block.recoverPendingAsks();
    expect(after.registry.get('mail', 'mail-1')).toBeUndefined();
    expect(after.mailbox.send).not.toHaveBeenCalled();
  });

  it('an approval answered while the server stopped is carried out once the next start runs, its mailboxes registered', async () => {
    const { db, dir } = serverDb();
    const before = process_(db, dir, botApi());
    const ask_id = await raise(before);
    // The server is stopping: the answer is recorded, its handler left to the next start.
    before.block.beginStopping();
    await before.block.submitAnswer({ ask_id, option: 'approve', via: 'ui' });
    expect(before.handled).toEqual([]);
    expect(await askRow(db, ask_id)).toMatchObject({ status: 'answered' });

    const after = process_(db, dir, botApi());
    const server = await restart(after);
    expect(after.handled).toEqual([]);

    await server.run();
    // Once, with its mailbox there; and the Telegram message sent before the restart loses its
    // buttons (D-158 P3's records), on the message the earlier process sent.
    expect(after.handled).toEqual([true]);
    expect(await askRow(db, ask_id)).toMatchObject({ status: 'handled' });
    expect(after.bot.calls).toEqual(['editMessageText']);
  });

  it('a handled approval is left alone', async () => {
    const { db, dir } = serverDb();
    const before = process_(db, dir, botApi());
    const ask_id = await raise(before);
    await before.block.submitAnswer({ ask_id, option: 'approve', via: 'ui' });
    expect(await askRow(db, ask_id)).toMatchObject({ status: 'handled' });

    const after = process_(db, dir, botApi());
    await (await restart(after)).run();
    expect(after.handled).toEqual([]);
    expect(after.bot.calls).toEqual([]);
    expect(after.mailbox.send).not.toHaveBeenCalled();
  });

  it('a boot that never runs sweeps nothing: the asks wait, durable, for the next one', async () => {
    const { db, dir } = serverDb();
    const before = process_(db, dir, botApi(true));
    const ask_id = await raise(before);

    const after = process_(db, dir, botApi());
    const server = await restart(after);
    server.machine.transition('crashed');
    expect(server.swept).not.toHaveBeenCalled();
    expect(after.bot.calls).toEqual([]);
    expect(after.mailbox.send).not.toHaveBeenCalled();
    expect(await askRow(db, ask_id)).toMatchObject({ status: 'open' });
  });
});
