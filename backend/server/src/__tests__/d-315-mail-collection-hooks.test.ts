/** D-315 slice 1 — the mail collection's hooks for mail facts (§5, §5.3).
 *
 *  A real `createMailCollection` over a stub provider: what the upsert hook is
 *  told (a first sighting, whether the first backfill had finished), and that
 *  every path removing a row — a provider delete, the collection's `delete`,
 *  retention — and a verified move each reach their hook. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createInstanceStore } from '../collections/instance-store.js';
import {
  createMailCollection,
  type MailCollection,
  type MailStoredContext,
  type MailUpsertContext,
} from '../collections/mail/mail-collection.js';
import type {
  CanonicalMessage,
  MailProvider,
  MailSyncOutcome,
  ProviderSyncCallback,
} from '../collections/mail/provider.js';
import type { MailFactWriter } from '../mail-facts/fact-writer.js';
import { createMailFactIngest, mailMayTrigger } from '../mail-facts/mail-ingest.js';
import { createBlobStore } from '../storage/blob-store.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const message = (source_id: string, over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id,
  from: 'pkginfo@ups.com',
  from_name: 'UPS',
  to: ['me@example.com'],
  cc: [],
  subject: 'UPS Update',
  thread_id: 'T-1',
  folder_or_label: 'INBOX',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: NOW - DAY,
  body_text: 'Tracking Number: 1Z01',
  ...over,
});

interface Harness {
  readonly collection: MailCollection;
  readonly upserts: { msg: CanonicalMessage; ctx: MailUpsertContext }[];
  readonly stored: { msg: CanonicalMessage; ctx: MailStoredContext }[];
  /** The hooks in the order they ran: `stored:<source_id>`, `upserted:<source_id>`. */
  readonly order: string[];
  readonly removed: { slug: string; ids: readonly string[] }[];
  readonly rekeyed: [string, string, string][];
  /** Push a live provider event through the sync callback. */
  push(event: Parameters<ProviderSyncCallback>[0]): Promise<void>;
}

let db: Database.Database;
let blobsDir: string;

beforeEach(async () => {
  db = new Database(':memory:');
  blobsDir = await mkdtemp(join(tmpdir(), 'd315-hooks-'));
});

afterEach(async () => {
  db.close();
  await rm(blobsDir, { recursive: true, force: true });
});

const start = async (
  scan: CanonicalMessage[],
  retentionDays = 365,
  extra: Partial<Parameters<typeof createMailCollection>[0]> = {},
): Promise<Harness> => {
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'mail', slug: 'work', adapter_type: 'imap',
    config: {}, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
  });
  let sync: ProviderSyncCallback | null = null;
  const provider: MailProvider = {
    kind: 'imap',
    slug: 'work',
    sendCapable: false,
    mutationCapable: false,
    accountEmail: 'me@example.com',
    async connect() {},
    async initialScan(opts) {
      for (const msg of scan) if (!(await opts.onMessage(msg))) break;
    },
    async startSync(cb) {
      sync = cb;
      return async () => { sync = null; };
    },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
  };
  const upserts: Harness['upserts'] = [];
  const stored: Harness['stored'] = [];
  const order: string[] = [];
  const removed: Harness['removed'] = [];
  const rekeyed: Harness['rekeyed'] = [];
  const collection = createMailCollection({
    db,
    blobs: createBlobStore(blobsDir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: 'work',
    provider,
    config: () => ({ backfill_days: 30, retention_days: retentionDays, quota_bytes: 1024 * 1024 }),
    instances,
    now: () => NOW,
    onMessageUpserted: (msg, ctx) => {
      upserts.push({ msg, ctx });
      order.push(`upserted:${msg.source_id}`);
    },
    onMessageStored: (msg, ctx) => {
      stored.push({ msg, ctx });
      order.push(`stored:${msg.source_id}`);
    },
    onRecordsRemoved: (slug, ids) => removed.push({ slug, ids }),
    onRecordRekeyed: (slug, from, to) => rekeyed.push([slug, from, to]),
    ...extra,
  });
  await collection.sync.start();
  return {
    collection,
    upserts,
    stored,
    order,
    removed,
    rekeyed,
    push: async (event) => {
      if (sync === null) throw new Error('sync not started');
      await sync(event);
    },
  };
};

describe('the upsert hook’s context', () => {
  it('marks the first backfill’s messages as first seen before the backfill completed', async () => {
    const h = await start([message('m1')]);
    try {
      expect(h.upserts).toHaveLength(1);
      expect(h.upserts[0]?.ctx).toMatchObject({
        slug: 'work',
        account_email: 'me@example.com',
        first_seen: true,
        backfill_complete: false,
        backfill_days: 30,
        attachments: [],
      });
      expect(h.upserts[0]?.ctx.record_id).toMatch(/^mail:/);
    } finally {
      await h.collection.sync.stop();
    }
  });

  it('tells a live arrival after the backfill apart from a re-list of a known message', async () => {
    const h = await start([message('m1')]);
    try {
      await h.push({ kind: 'created', source_id: 'm2', message: message('m2') });
      await h.push({ kind: 'updated', source_id: 'm1', message: message('m1', { is_read: true }) });
      expect(h.upserts.slice(1).map(({ ctx }) => [ctx.first_seen, ctx.backfill_complete])).toEqual([
        [true, true],
        [false, true],
      ]);
    } finally {
      await h.collection.sync.stop();
    }
  });
});

describe('a message deleted while its attachments were fetched', () => {
  it('reaches no upsert hook: nothing derived may outlive its row', async () => {
    let h: Harness | undefined;
    const withPart = message('m2', {
      has_attachments: true,
      attachments: [{
        source_part_id: 'p1', filename: 'label.pdf', mime_type: 'application/pdf', size_bytes: 4,
        fetchBytes: async () => {
          const id = h!.collection.list({ platform: 'mail', slug: 'work', limit: 10 }).find((r) => r.source_id === 'm2')!.record_id;
          h!.collection.delete(id);
          return Buffer.from('%PDF');
        },
      }],
    } as unknown as Partial<CanonicalMessage>);
    h = await start([message('m1')], 365, {
      inboundAttachmentDeps: () => ({
        fileIngestor: { ingest: async () => ({ record_id: 'file:1' }) } as never,
        attach: (async () => undefined) as never,
        attachDeps: {} as never,
      }),
    });
    try {
      await h.push({ kind: 'created', source_id: 'm2', message: withPart });
      expect(h.stored.map(({ msg }) => msg.source_id)).toEqual(['m1', 'm2']);
      expect(h.upserts.map(({ msg }) => msg.source_id)).toEqual(['m1']);
      expect(h.removed.map(({ ids }) => ids.length)).toEqual([1]);
    } finally {
      await h.collection.sync.stop();
    }
  });
});

describe('an email relabelled while its attachments download (§5)', () => {
  it('the upsert hook is told the labels and folder its row holds then, not those it came with', async () => {
    let h: Harness | undefined;
    const withPart = message('m2', {
      labels: ['INBOX', 'watch'],
      has_attachments: true,
      attachments: [{
        source_part_id: 'p1', filename: 'receipt.pdf', mime_type: 'application/pdf', size_bytes: 4,
        fetchBytes: async () => {
          // Moved to the archive, its label taken off, while its file downloads.
          const id = h!.collection.list({ platform: 'mail', slug: 'work', limit: 10 }).find((r) => r.source_id === 'm2')!.record_id;
          h!.collection.applyVerifiedMutation(id, {
            source_id: 'm2', is_read: false, is_flagged: false, folder_or_label: 'Archive', labels: ['Archive'],
          });
          return Buffer.from('%PDF');
        },
      }],
    } as unknown as Partial<CanonicalMessage>);
    h = await start([message('m1')], 365, {
      inboundAttachmentDeps: () => ({
        fileIngestor: { ingest: async () => ({ record_id: 'file:1' }) } as never,
        attach: (async () => undefined) as never,
        attachDeps: {} as never,
      }),
    });
    try {
      await h.push({ kind: 'created', source_id: 'm2', message: withPart });
      const told = h.upserts.find(({ msg }) => msg.source_id === 'm2')!.msg;
      expect([told.labels, told.folder_or_label]).toEqual([['Archive'], 'Archive']);
      // What it said besides is as it came.
      expect(told.subject).toBe(withPart.subject);
    } finally {
      await h.collection.sync.stop();
    }
  });

  it('every label taken off: the hook is told none, not the ones it came with', async () => {
    let h: Harness | undefined;
    const withPart = message('m2', {
      labels: ['INBOX', 'watch'],
      has_attachments: true,
      attachments: [{
        source_part_id: 'p1', filename: 'receipt.pdf', mime_type: 'application/pdf', size_bytes: 4,
        fetchBytes: async () => {
          const id = h!.collection.list({ platform: 'mail', slug: 'work', limit: 10 }).find((r) => r.source_id === 'm2')!.record_id;
          h!.collection.applyVerifiedMutation(id, { source_id: 'm2', is_read: false, is_flagged: false, folder_or_label: 'INBOX', labels: [] });
          return Buffer.from('%PDF');
        },
      }],
    } as unknown as Partial<CanonicalMessage>);
    h = await start([], 365, {
      inboundAttachmentDeps: () => ({
        fileIngestor: { ingest: async () => ({ record_id: 'file:1' }) } as never,
        attach: (async () => undefined) as never,
        attachDeps: {} as never,
      }),
    });
    try {
      await h.push({ kind: 'created', source_id: 'm2', message: withPart });
      const told = h.upserts.find(({ msg }) => msg.source_id === 'm2')!.msg;
      expect([told.labels, told.folder_or_label]).toEqual([[], 'INBOX']);
    } finally {
      await h.collection.sync.stop();
    }
  });
});

describe('the stored hook (§5)', () => {
  it('tells a first sighting the moment its row lands, before the upsert hook — and never a re-list', async () => {
    const h = await start([message('m1')]);
    try {
      await h.push({ kind: 'created', source_id: 'm2', message: message('m2') });
      await h.push({ kind: 'updated', source_id: 'm1', message: message('m1', { is_read: true }) });
      expect(h.order).toEqual(['stored:m1', 'upserted:m1', 'stored:m2', 'upserted:m2', 'upserted:m1']);
      expect(h.stored.map(({ ctx }) => [ctx.backfill_complete, ctx.backfill_days])).toEqual([[false, 30], [true, 30]]);
      expect(h.stored[1]?.ctx.record_id).toBe(h.upserts[1]?.ctx.record_id);
    } finally {
      await h.collection.sync.stop();
    }
  });

  it('is news to the fact writer only when it is news: past the first backfill, in the window, not a draft', () => {
    const markNews = vi.fn();
    const write = vi.fn((_input: { email_at: number }) => ({ facts: 0, events: 0 }));
    const ingest = createMailFactIngest({ writer: { markNews, write } as unknown as MailFactWriter, now: () => NOW });
    const ctx: MailStoredContext = { slug: 'work', record_id: 'mail:1', backfill_complete: true, backfill_days: 30 };
    ingest.onMessageStored(message('m1'), ctx);
    ingest.onMessageStored(message('m2'), { ...ctx, record_id: 'mail:2', backfill_complete: false });
    ingest.onMessageStored(message('m3', { received_at: NOW - 60 * DAY }), { ...ctx, record_id: 'mail:3' });
    ingest.onMessageStored(message('m4', { direction: 'draft' }), { ...ctx, record_id: 'mail:4' });
    expect(markNews.mock.calls).toEqual([[{ slug: 'work', record_id: 'mail:1' }]]);
  });

  it('dates a fact by its email, never later than now: a sender cannot date one next year', () => {
    const write = vi.fn((_input: { email_at: number }) => ({ facts: 0, events: 0 }));
    const ingest = createMailFactIngest({ writer: { write } as unknown as MailFactWriter, now: () => NOW });
    const ctx: MailUpsertContext = {
      slug: 'work', record_id: 'mail:1', account_email: 'me@example.com', first_seen: true,
      backfill_complete: true, backfill_days: 30, attachments: [],
    };
    ingest.onMessageUpserted(message('m1', { received_at: NOW + 365 * DAY }), ctx);
    ingest.onMessageUpserted(message('m2', { received_at: NOW - DAY }), { ...ctx, record_id: 'mail:2' });
    expect(write.mock.calls.map(([input]) => input.email_at)).toEqual([NOW, NOW - DAY]);
  });
});

describe('every path that removes a row reaches its hook (ruling 29)', () => {
  it('a provider-side delete', async () => {
    const h = await start([message('m1')]);
    try {
      const id = h.upserts[0]!.ctx.record_id;
      await h.push({ kind: 'deleted', source_id: 'm1' });
      expect(h.removed).toEqual([{ slug: 'work', ids: [id] }]);
      // A delete of a row that is not there reports nothing.
      await h.push({ kind: 'deleted', source_id: 'm1' });
      expect(h.removed).toHaveLength(1);
    } finally {
      await h.collection.sync.stop();
    }
  });

  it('the collection’s own delete', async () => {
    const h = await start([message('m1')]);
    try {
      const id = h.upserts[0]!.ctx.record_id;
      expect(h.collection.delete(id)).toBe(true);
      expect(h.collection.delete(id)).toBe(false);
      expect(h.removed).toEqual([{ slug: 'work', ids: [id] }]);
    } finally {
      await h.collection.sync.stop();
    }
  });

  it('retention', async () => {
    const h = await start(
      [message('old', { received_at: NOW - 40 * DAY }), message('new', { received_at: NOW - DAY })],
      30,
    );
    try {
      const oldId = h.upserts.find(({ msg }) => msg.source_id === 'old')!.ctx.record_id;
      const result = await h.collection.runRetention();
      expect(result.pruned_count).toBe(1);
      expect(h.removed).toEqual([{ slug: 'work', ids: [oldId] }]);
    } finally {
      await h.collection.sync.stop();
    }
  });
});

describe('a verified move', () => {
  it('re-keys when the provider minted a new id, and not when it kept the id', async () => {
    const h = await start([message('7@INBOX')]);
    try {
      const id = h.upserts[0]!.ctx.record_id;
      const kept = h.collection.applyVerifiedMutation(id, {
        source_id: '7@INBOX', is_read: true, is_flagged: false, folder_or_label: 'INBOX',
      });
      expect(kept?.record_id).toBe(id);
      expect(h.rekeyed).toEqual([]);

      const moved = h.collection.applyVerifiedMutation(id, {
        source_id: '3@Archive', is_read: true, is_flagged: false, folder_or_label: 'Archive',
      });
      expect(h.rekeyed).toEqual([['work', id, moved!.record_id]]);
      expect(moved!.record_id).not.toBe(id);
      expect(h.removed).toEqual([]); // a move is not a removal
    } finally {
      await h.collection.sync.stop();
    }
  });
});

describe('a first backfill that failed (D-124, §5)', () => {
  /** A mailbox whose first scans fail `failing` times, then succeed. With
   *  `refused`, the provider says the scan's (or a later sign-in's) failure was
   *  a refused credential. */
  const failingFirst = (failing: number, firstScanRetryMs: number, refused: 'scan' | 'connect' | null = null) => {
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'work', adapter_type: 'imap',
      config: {}, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
    });
    const box = { scans: 0, connects: 0, sync: null as ProviderSyncCallback | null, upserts: [] as MailUpsertContext[] };
    let outcome: ((outcome: MailSyncOutcome) => void) | null = null;
    const provider: MailProvider = {
      kind: 'imap',
      slug: 'work',
      sendCapable: false,
      mutationCapable: false,
      accountEmail: 'me@example.com',
      onSyncOutcome(listener) {
        outcome = listener;
        return () => { outcome = null; };
      },
      async connect() {
        box.connects += 1;
        if (refused === 'connect' && box.connects > 1) {
          outcome?.({ phase: 'reconnect', ok: false, failure: 'auth', at: NOW });
          throw new Error('AUTHENTICATIONFAILED');
        }
      },
      async initialScan(opts) {
        box.scans += 1;
        if (box.scans <= failing) {
          if (refused === 'scan') outcome?.({ phase: 'initial_scan', ok: false, failure: 'auth', at: NOW });
          throw new Error('the server hung up');
        }
        await opts.onMessage(message('m1'));
      },
      async startSync(cb) {
        box.sync = cb;
        return async () => { box.sync = null; };
      },
      async close() {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    };
    const collection = createMailCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'work',
      provider,
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
      instances,
      now: () => NOW,
      firstScanRetryMs,
      onMessageUpserted: (_msg, ctx) => { box.upserts.push(ctx); },
    });
    const complete = (): boolean => instances.get('mail', 'work')?.backfill_complete === true;
    return { collection, box, complete };
  };

  it('is tried again, so what the mailbox receives is news without a restart', async () => {
    const { collection, box, complete } = failingFirst(1, 5);
    try {
      await collection.sync.start();
      expect(complete()).toBe(false);
      await vi.waitFor(() => expect(complete()).toBe(true));
      expect(box.scans).toBe(2);
      await vi.waitFor(() => expect(box.sync).not.toBeNull());
      await box.sync!({ kind: 'created', source_id: 'm2', message: message('m2') });
      expect(box.upserts.at(-1)).toMatchObject({ first_seen: true, backfill_complete: true });
    } finally {
      await collection.close();
    }
  });

  it('waits twice as long each time', async () => {
    vi.useFakeTimers();
    const { collection, box } = failingFirst(10, 100);
    try {
      await collection.sync.start();
      expect(box.scans).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(box.scans).toBe(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(box.scans).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(box.scans).toBe(3);
    } finally {
      await collection.close();
      vi.useRealTimers();
    }
  });

  it('is not tried again once the mailbox stops: its next start scans anyway', async () => {
    const { collection, box } = failingFirst(10, 20);
    await collection.sync.start();
    await collection.sync.stop();
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    expect(box.scans).toBe(1);
    await collection.close();
  });

  it('is not tried again when the credential was refused: that needs signing in again', async () => {
    vi.useFakeTimers();
    const onScan = failingFirst(10, 100, 'scan');
    try {
      await onScan.collection.sync.start();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await onScan.collection.close();
      vi.useRealTimers();
    }
    // Refused on the retry's sign-in: no more after it.
    vi.useFakeTimers();
    const onConnect = failingFirst(10, 100, 'connect');
    try {
      await onConnect.collection.sync.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(onConnect.box.connects).toBe(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onConnect.box.connects).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await onConnect.collection.close();
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind when the mailbox stops', async () => {
    vi.useFakeTimers();
    const { collection } = failingFirst(10, 100);
    try {
      await collection.sync.start();
      expect(vi.getTimerCount()).toBe(1);
      await collection.sync.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await collection.close();
      vi.useRealTimers();
    }
  });
});

describe('news is mail inside the mailbox’s retention too (§5)', () => {
  const ctx = { first_seen: true, backfill_complete: true, backfill_days: 30 } as const;

  it('mail older than the mailbox keeps was pruned: found again, it is old mail', () => {
    const tenDaysOld = message('m1', { received_at: NOW - 10 * DAY });
    expect(mailMayTrigger(tenDaysOld, ctx, NOW)).toBe(true);
    expect(mailMayTrigger(tenDaysOld, { ...ctx, retention_days: 7 }, NOW)).toBe(false);
    expect(mailMayTrigger(tenDaysOld, { ...ctx, retention_days: 365 }, NOW)).toBe(true);
    expect(mailMayTrigger(message('m2', { received_at: NOW - DAY }), { ...ctx, retention_days: 7 }, NOW)).toBe(true);
  });

  it('the hooks are told how long the mailbox keeps mail', async () => {
    const h = await start([message('m1')], 90);
    try {
      expect(h.stored[0]?.ctx).toMatchObject({ backfill_days: 30, retention_days: 90 });
      expect(h.upserts[0]?.ctx).toMatchObject({ backfill_days: 30, retention_days: 90 });
    } finally {
      await h.collection.sync.stop();
    }
  });
});
