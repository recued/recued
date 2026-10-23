/** A restart lists only the days a mailbox may have missed.
 *
 *  Every start used to list the whole backfill window (400 days by default),
 *  fetching each message and attachment again, however short the downtime. A
 *  provider that resumes from its persisted cursor (Gmail's history, Graph's
 *  delta) is caught up by its first poll, so after the first scan a restart
 *  lists the days since the mailbox last synced plus slack. An IMAP mailbox
 *  does so once each folder has a stored UID cursor (`imap-restart-catch-up`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FileCollectionCaps } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createBlobStore } from '../../../storage/blob-store.js';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../../instance-store.js';
import {
  createMailCollection,
  MAIL_RESTART_SCAN_SLACK_DAYS,
  type MailCollection,
} from '../mail-collection.js';
import type { CanonicalMessage, MailProvider, MailProviderKind } from '../provider.js';

const SLUG = 'restart-window';
const BIG_QUOTA = 100 * 1024 * 1024;
const START_TIME = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = 400;

const MAIL_CAPS: FileCollectionCaps = {
  read: 'yes',
  write: 'no',
  delete: 'no',
  watch: 'realtime',
  mirror: 'required',
  auth: 'oauth',
  path_style: 'uri',
};

const message = (source_id: string): CanonicalMessage => ({
  source_id,
  rfc_message_id: `<${source_id}@example.com>`,
  from: 'alice@example.com',
  to: ['me@example.com'],
  cc: [],
  subject: `Message ${source_id}`,
  thread_id: `thread-${source_id}`,
  folder_or_label: 'INBOX',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: START_TIME - 1_000,
  body_text: 'hello',
});

interface Harness {
  instances: CollectionInstanceStore;
  collection: MailCollection;
  /** The `backfill_days` of every scan, in order. */
  scans: number[];
  /** The sync clock as a restart would find it. */
  lastSynced(at: number | null): void;
  advance(ms: number): void;
  restart(): Promise<void>;
  close(): Promise<void>;
}

const newHarness = (kind: MailProviderKind, resumesFromCursor: boolean | undefined): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-restart-window-'));
  const db = new Database(':memory:');
  let now = START_TIME;
  const instances = createInstanceStore({ db, now: () => now });
  instances.upsert({
    platform: 'mail',
    slug: SLUG,
    adapter_type: kind,
    config: {},
    caps: MAIL_CAPS,
    auth_state: 'healthy',
    last_synced_at: null,
  });
  const scans: number[] = [];
  const provider: MailProvider = {
    kind,
    slug: SLUG,
    ...(resumesFromCursor === undefined ? {} : { resumesFromCursor }),
    sendCapable: false,
    mutationCapable: false,
    accountEmail: 'me@example.com',
    async connect() {},
    async initialScan(opts) {
      scans.push(opts.backfill_days);
      opts.onAccessVerified?.();
      await opts.onMessage(message(`m-${scans.length}`));
    },
    async startSync() { return async () => {}; },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
  };
  const collection = createMailCollection({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: `collection:mail:${SLUG}` }),
    bus: createWarehouseEventBus(),
    slug: SLUG,
    provider,
    config: () => ({ backfill_days: WINDOW, retention_days: 365, quota_bytes: BIG_QUOTA }),
    now: () => now,
    instances,
  });
  return {
    instances,
    collection,
    scans,
    lastSynced(at) {
      db.prepare('UPDATE collection_instances SET last_synced_at = ? WHERE platform = ? AND slug = ?')
        .run(at, 'mail', SLUG);
    },
    advance(ms) { now += ms; },
    async restart() {
      await collection.sync.stop();
      await collection.sync.start();
    },
    async close() {
      await collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let harnesses: Harness[] = [];
const withHarness = (kind: MailProviderKind, resumesFromCursor: boolean | undefined): Harness => {
  const harness = newHarness(kind, resumesFromCursor);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  for (const harness of harnesses) await harness.close();
  harnesses = [];
});

describe('a restart lists only the days a mailbox may have missed', () => {
  it.each(['gmail', 'graph'] as const)('%s: the first scan lists the whole window, a restart the days since the last sync', async (kind) => {
    const h = withHarness(kind, true);
    await h.collection.sync.start();
    expect(h.scans).toEqual([WINDOW]);
    expect(h.instances.get('mail', SLUG)?.backfill_complete).toBe(true);

    // Down for three hours: one day, plus the slack.
    h.lastSynced(START_TIME);
    h.advance(3 * HOUR);
    await h.restart();
    expect(h.scans).toEqual([WINDOW, 1 + MAIL_RESTART_SCAN_SLACK_DAYS]);

    // Down for ten days and a bit: eleven days, plus the slack.
    h.lastSynced(START_TIME + 3 * HOUR);
    h.advance(10 * DAY + HOUR);
    await h.restart();
    expect(h.scans.at(-1)).toBe(11 + MAIL_RESTART_SCAN_SLACK_DAYS);
  });

  it('never lists more than the window, however long the server was down', async () => {
    const h = withHarness('gmail', true);
    await h.collection.sync.start();
    h.lastSynced(START_TIME);
    h.advance(900 * DAY);
    await h.restart();
    expect(h.scans).toEqual([WINDOW, WINDOW]);
  });

  it('lists the whole window when no sync time was recorded', async () => {
    const h = withHarness('gmail', true);
    await h.collection.sync.start();
    h.lastSynced(null);
    await h.restart();
    expect(h.scans).toEqual([WINDOW, WINDOW]);
  });

  it('lists the whole window until a first scan has completed', async () => {
    const h = withHarness('gmail', true);
    h.lastSynced(START_TIME);
    h.advance(HOUR);
    await h.collection.sync.start();
    expect(h.scans).toEqual([WINDOW]);
  });

  it('lists the slack alone when the sync clock reads later than now', async () => {
    const h = withHarness('graph', true);
    await h.collection.sync.start();
    h.lastSynced(START_TIME + DAY);
    await h.restart();
    expect(h.scans).toEqual([WINDOW, MAIL_RESTART_SCAN_SLACK_DAYS]);
  });

  it.each([
    ['an IMAP mailbox before its folders have a cursor', 'imap', undefined],
    ['a provider that does not say it resumes', 'gmail', undefined],
    ['a provider that says it does not', 'graph', false],
  ] as const)('%s lists the whole window on every restart', async (_label, kind, resumes) => {
    const h = withHarness(kind, resumes);
    await h.collection.sync.start();
    h.lastSynced(START_TIME);
    h.advance(3 * HOUR);
    await h.restart();
    expect(h.scans).toEqual([WINDOW, WINDOW]);
  });
});
