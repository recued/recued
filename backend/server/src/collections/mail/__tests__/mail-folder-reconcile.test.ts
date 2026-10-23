/** What a mail collection does with an IMAP folder's flags read after a
 *  restart (`MailFolderSnapshot`): a stored message the folder no longer holds
 *  was deleted meanwhile and is removed; one whose flags differ takes the
 *  server's. A row written since the read is newer than it and stays, and so
 *  does every row of another folder.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FileCollectionCaps } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import { createBlobStore } from '../../../storage/blob-store.js';
import { createInstanceStore } from '../../instance-store.js';
import { createMailCollection, type MailCollection } from '../mail-collection.js';
import type {
  CanonicalMessage,
  MailFolderSnapshot,
  MailProvider,
  ProviderSyncCallback,
} from '../provider.js';

const SLUG = 'reconcile';
const BIG_QUOTA = 100 * 1024 * 1024;
const T0 = 1_700_000_000_000;

const MAIL_CAPS: FileCollectionCaps = {
  read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri',
};

const message = (uid: number, opts: { folder?: string; is_read?: boolean; is_flagged?: boolean; at?: number } = {}): CanonicalMessage => {
  const folder = opts.folder ?? 'INBOX';
  return {
    source_id: `${uid}@${folder}`,
    rfc_message_id: `<${uid}.${folder}@example.com>`,
    from: 'alice@example.com',
    to: ['me@example.com'],
    cc: [],
    subject: `Message ${uid} in ${folder}`,
    thread_id: `thread-${uid}`,
    folder_or_label: folder,
    is_read: opts.is_read ?? false,
    is_flagged: opts.is_flagged ?? false,
    has_attachments: false,
    received_at: opts.at ?? T0 - uid * 60_000,
    body_text: 'hello',
  };
};

interface Harness {
  collection: MailCollection;
  events: WarehouseEvent[];
  removed: string[];
  advance(ms: number): void;
  now(): number;
  /** The sync callback the collection handed the provider. */
  cb(): ProviderSyncCallback;
  row(source_id: string): Record<string, unknown> | undefined;
  close(): Promise<void>;
}

const newHarness = async (stored: CanonicalMessage[]): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-folder-reconcile-'));
  const db = new Database(':memory:');
  let now = T0;
  const instances = createInstanceStore({ db, now: () => now });
  instances.upsert({
    platform: 'mail', slug: SLUG, adapter_type: 'imap', config: {}, caps: MAIL_CAPS, auth_state: 'healthy', last_synced_at: null,
  });
  let syncCb: ProviderSyncCallback | undefined;
  const provider: MailProvider = {
    kind: 'imap',
    slug: SLUG,
    sendCapable: false,
    mutationCapable: false,
    accountEmail: 'me@example.com',
    async connect() {},
    async initialScan(opts) {
      opts.onAccessVerified?.();
      for (const msg of stored) await opts.onMessage(msg);
    },
    async startSync(cb) { syncCb = cb; return async () => {}; },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
  };
  const bus = createWarehouseEventBus();
  const events: WarehouseEvent[] = [];
  bus.subscribe('**', (event) => { events.push(event); });
  const removed: string[] = [];
  const collection = createMailCollection({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: `collection:mail:${SLUG}` }),
    bus,
    slug: SLUG,
    provider,
    config: () => ({ backfill_days: 400, retention_days: 3650, quota_bytes: BIG_QUOTA }),
    now: () => now,
    instances,
    onRecordsRemoved: (_slug, ids) => { removed.push(...ids); },
  });
  await collection.sync.start();
  const byId = (source_id: string) => {
    for (let before: { received_at: number; record_id: string } | undefined; ;) {
      const page = collection.list({ platform: 'mail', slug: SLUG, limit: 500, ...(before ? { before } : {}) });
      const found = page.find((record) => record.source_id === source_id);
      if (found) return found;
      const last = page.at(-1);
      if (page.length < 500 || !last) return undefined;
      before = { received_at: last.received_at, record_id: last.record_id };
    }
  };
  return {
    collection,
    events,
    removed,
    advance(ms) { now += ms; },
    now: () => now,
    cb() {
      if (!syncCb) throw new Error('sync did not start');
      return syncCb;
    },
    row: (source_id) => byId(source_id)?.hot_fields,
    async close() {
      await collection.close();
      bus.dispose();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const snapshot = (read_at: number, held: Array<[string, boolean, boolean]>, folder = 'INBOX'): MailFolderSnapshot => ({
  folder,
  read_at,
  messages: new Map(held.map(([source_id, is_read, is_flagged]) => [source_id, { is_read, is_flagged }])),
});

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('a mail collection reconciles an IMAP folder read after a restart', () => {
  it('removes the rows the folder no longer holds and takes the server\'s flags, leaving other folders alone', async () => {
    h = await newHarness([
      message(1),
      message(2, { is_read: true }),
      message(3),
      message(4, { folder: 'Archive' }),
    ]);
    h.advance(60_000);
    h.events.length = 0;
    await h.cb()({
      kind: 'folder',
      source_id: 'INBOX',
      folder: snapshot(h.now(), [['1@INBOX', true, false], ['2@INBOX', true, false]]),
    });
    expect(h.row('3@INBOX')).toBeUndefined();
    expect(h.row('1@INBOX')).toMatchObject({ is_read: true, is_flagged: false });
    expect(h.row('2@INBOX')).toMatchObject({ is_read: true });
    expect(h.row('4@Archive')).toBeDefined();
    expect(h.events.map((event) => [event.event_kind, event.changed_fields ?? null])).toEqual([
      ['deleted', null],
      ['updated', ['is_read']],
    ]);
    expect(h.removed).toHaveLength(1);
  });

  it('leaves a row written since the folder was read', async () => {
    h = await newHarness([message(1), message(2)]);
    const readAt = h.now() + 30_000;
    h.advance(60_000);
    // After the read: the IDLE path saw message 1 read, and message 9 arrive.
    await h.cb()({ kind: 'updated', source_id: '1@INBOX', message: message(1, { is_read: true }) });
    await h.cb()({ kind: 'created', source_id: '9@INBOX', message: message(9, { at: h.now() }) });
    h.events.length = 0;
    await h.cb()({
      kind: 'folder',
      source_id: 'INBOX',
      folder: snapshot(readAt, [['1@INBOX', false, false], ['2@INBOX', false, true]]),
    });
    expect(h.row('1@INBOX')).toMatchObject({ is_read: true });
    expect(h.row('9@INBOX')).toBeDefined();
    expect(h.row('2@INBOX')).toMatchObject({ is_flagged: true });
    expect(h.events.map((event) => event.event_kind)).toEqual(['updated']);
  });

  it('reads every page of the folder before it changes a row', async () => {
    const stored = Array.from({ length: 1_203 }, (_, i) => message(i + 1));
    h = await newHarness(stored);
    h.advance(60_000);
    // The oldest messages sit on the last page (newest first): 1203 is gone,
    // 1202 was read elsewhere, every other row is unchanged.
    const held = stored
      .filter((msg) => msg.source_id !== '1203@INBOX')
      .map((msg): [string, boolean, boolean] => [msg.source_id, msg.source_id === '1202@INBOX', false]);
    h.events.length = 0;
    await h.cb()({ kind: 'folder', source_id: 'INBOX', folder: snapshot(h.now(), held) });
    expect(h.row('1203@INBOX')).toBeUndefined();
    expect(h.row('1202@INBOX')).toMatchObject({ is_read: true });
    expect(h.events.map((event) => event.event_kind).sort()).toEqual(['deleted', 'updated']);
  });
});
