/** D-158 P3 — which asks the email channel sent outlives a restart.
 *
 *  Through the server's own pieces over one real SQLite database: the email channel as the
 *  server composes it (`composeEmailChannel`, its `email_prompt_records` table), the real
 *  notification block (`composeNotificationBlock`), and the block's boot re-delivery sweep
 *  (`recoverPendingAsks`). Before, the channel kept which asks it had emailed in the process: a
 *  restarted server's sweep emailed each open approval again (found 2026-11-02, after the same
 *  fix for Telegram and Slack). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ConnectionRow } from '@recued/contracts';
import type { AskOption, Channel, NotificationMessage } from '@recued/notification';
import type { MailRpcDep } from '@recued/ingredients';
import {
  createAuditLogStore,
  createCheckpointStore,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import { composeEmailChannel } from '../composition/bin/wire-email-channel.js';
import { composeNotificationBlock } from '../composition/bin/wire-notification-block.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { EventBus } from '../events/bus.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const emailRow = {
  pk: 'notification:email', kind: 'notification', name: 'email', display_name: 'Email', subtype: 'email',
  config_json: JSON.stringify({ sender_mail_instance: 'mail-1', default_recipient: 'inbox@example.test' }),
  auth_ciphertext: '', enrolled_at: 1, updated_at: 1,
} as unknown as ConnectionRow;
const connectionStore = {
  list: ({ kind }: { kind?: string } = {}) => [emailRow].filter(row => kind === undefined || row.kind === kind),
  get: (kind: string, name: string) => (kind === emailRow.kind && name === emailRow.name ? emailRow : null),
} as unknown as ConnectionStoreSqlite;

const approval: NotificationMessage = { title: 'Approve: Remove a calendar event', text: '"Dentist" is waiting for your approval.' };
const options: readonly AskOption[] = [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }];
const HANDLER = 'test.p3-email';

const okSend = () => vi.fn<MailRpcDep['send']>(async () => ({ source_id: 's1', message_id: 'm1', sent_at: 1 }));

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** One server's database, kept across the restart. */
const serverDb = () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const dir = mkdtempSync(join(tmpdir(), 'p3-email-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  createInstanceStore({ db }).upsert({ platform: 'mail', slug: 'mail-1', adapter_type: 'imap',
    config: { username: 'mail-1@example.test', smtp: { host: 'smtp.example.test' } },
    caps: {} as never, auth_state: 'healthy', last_synced_at: null });
  return { db, dir };
};

/** What one process builds over that database: a new block and a new email channel. */
const boot = (db: Database.Database, dir: string, emailChannel: Channel) => {
  const checkpointStore = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
  ensureCheckpointSchema(db);
  ensureSourceDependencyEntitySchema(db);
  const eventBus = {
    cursor: vi.fn(() => 0), subscribe: vi.fn(), unsubscribe: vi.fn(),
    emit: vi.fn((event) => ({ cursor: 1, ...event })), replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  } as unknown as EventBus;
  const { block } = composeNotificationBlock({
    db,
    auditLog: createAuditLogStore(
      createSQLiteCollection<AuditEntry>(db, 'audit_log'),
      createSQLiteCollection<ActivityEntry>(db, 'activity_log'),
    ),
    checkpointStore,
    annotationStore: createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')), now: () => 0, newId: () => 'annotation-1' }),
    eventBus,
    getExecuteDeps: (): ExecuteHandlerDeps | undefined => undefined,
    connectionStore,
    emailChannel,
  });
  block.registerAskHandler(HANDLER, async () => undefined);
  return block;
};

describe('D-158 P3 — an approval emailed before a restart, through the block and its boot sweep', () => {
  it('is not emailed again when the restarted server re-delivers open asks, and its record goes when it is answered', async () => {
    const { db, dir } = serverDb();
    const first = okSend();
    const before = boot(db, dir, composeEmailChannel({ connectionStore, mailRpc: { send: first }, db }));
    expect(await before.setNotificationChannelMode('email', { approval: true })).toMatchObject({ ok: true });
    const { ask_id } = await before.ask(approval, options, { kind: HANDLER, payload: {} });
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]![0].subject).toContain(`[#${ask_id}]`);

    // The restart: the same database, a new block and a new email channel. Boot re-delivers every open ask.
    const second = okSend();
    const after = boot(db, dir, composeEmailChannel({ connectionStore, mailRpc: { send: second }, db }));
    await after.recoverPendingAsks();
    expect(second).not.toHaveBeenCalled();

    // Answered: the ask closes on every channel it went to, and email's record goes with it.
    expect(await after.submitAnswer({ ask_id, option: 'approve', via: 'ui' })).toBe('answered');
    expect(db.prepare('SELECT COUNT(*) AS n FROM email_prompt_records').get()).toEqual({ n: 0 });
    expect(second).not.toHaveBeenCalled();
  });

  it('⛔ CONTROL: with no database the channel keeps nothing, so the restarted server emails it again', async () => {
    const { db, dir } = serverDb();
    const before = boot(db, dir, composeEmailChannel({ connectionStore, mailRpc: { send: okSend() } }));
    expect(await before.setNotificationChannelMode('email', { approval: true })).toMatchObject({ ok: true });
    await before.ask(approval, options, { kind: HANDLER, payload: {} });

    const second = okSend();
    const after = boot(db, dir, composeEmailChannel({ connectionStore, mailRpc: { send: second } }));
    await after.recoverPendingAsks();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
