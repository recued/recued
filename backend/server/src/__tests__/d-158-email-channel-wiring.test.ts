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

describe('composeNotificationBlock email wiring', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c();
  });

  const harness = (opts: { withEmail: boolean; connectionRow: ConnectionRow | null }) => {
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

    const connectionStore = stubConnectionStore(opts.connectionRow);
    const emailChannel = opts.withEmail
      ? composeEmailChannel({ connectionStore, mailRpc: { send: okSend() } })
      : undefined;

    const { block } = composeNotificationBlock({
      db, auditLog, checkpointStore, annotationStore, eventBus,
      getExecuteDeps: (): ExecuteHandlerDeps | undefined => undefined,
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
