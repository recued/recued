/** D-172 A.7 — inbound mail attachments materialize as data.file records
 *  and `role:"attachment"` links on the mail record. */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { resolveValue, type Link, type NamespaceStores, type RecipeStep } from '@recued/contracts';
import { prefetchSharedRefs } from '@recued/engine';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import type { AnnotationRpcDeps } from '../annotation-handler.js';
import { attachFile } from '../collections/file/attach-file.js';
import {
  createInboundFileCollection,
  inboundFileRecordId,
  type InboundFileCollection,
} from '../collections/file/inbound-file-collection.js';
import {
  createMailCollection,
  type MailCollection,
  type MailCollectionConfig,
} from '../collections/mail/mail-collection.js';
import type {
  CanonicalMessage,
  InboundMailAttachmentPart,
  MailProvider,
  ProviderHealth,
  ProviderSyncCallback,
  ProviderSyncEvent,
} from '../collections/mail/provider.js';
import { createCollectionRegistry, type CollectionRegistry } from '../collections/registry.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';

const BIG_QUOTA = 100 * 1024 * 1024;
const NOW = 1_800_000_000_000;

const attachmentPart = (input: {
  filename: string;
  mime_type: string;
  source_part_id: string;
  bytes: Buffer;
}): InboundMailAttachmentPart => ({
  filename: input.filename,
  mime_type: input.mime_type,
  size: input.bytes.length,
  source_part_id: input.source_part_id,
  async fetchBytes() {
    return Buffer.from(input.bytes);
  },
});

const failingAttachmentPart = (input: {
  filename: string;
  mime_type: string;
  source_part_id: string;
  size: number;
}): InboundMailAttachmentPart => ({
  filename: input.filename,
  mime_type: input.mime_type,
  size: input.size,
  source_part_id: input.source_part_id,
  async fetchBytes() {
    throw new Error('provider attachment fetch failed');
  },
});

const mkMessage = (
  overrides: Partial<CanonicalMessage> = {},
): CanonicalMessage => ({
  source_id: 'provider-msg-1',
  from: 'alice@example.com',
  to: ['bob@example.com'],
  cc: [],
  subject: 'with attachments',
  thread_id: 'thread-1',
  folder_or_label: 'INBOX',
  is_read: false,
  has_attachments: false,
  received_at: NOW - 1_000,
  body_text: 'body text',
  ...overrides,
});

interface StubHandle {
  provider: MailProvider;
  push(event: ProviderSyncEvent): Promise<void>;
}

const makeStubProvider = (scanMessages: CanonicalMessage[]): StubHandle => {
  let syncCb: ProviderSyncCallback | null = null;
  const provider: MailProvider = {
    kind: 'imap',
    slug: 'work',
    sendCapable: false,
    accountEmail: 'alice@example.com',
    async connect() { /* no-op */ },
    async initialScan(opts) {
      for (const msg of scanMessages) {
        const cont = await opts.onMessage(msg);
        if (!cont) break;
      }
    },
    async startSync(cb) {
      syncCb = cb;
      return async () => { syncCb = null; };
    },
    async close() { /* no-op */ },
    health(): ProviderHealth {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
  };
  return {
    provider,
    async push(event) {
      if (!syncCb) throw new Error('push called before startSync');
      await syncCb(event);
    },
  };
};

interface Harness {
  dir: string;
  db: Database.Database;
  blobs: BlobStore;
  store: AnnotationStore;
  registry: CollectionRegistry;
  fileColl: InboundFileCollection;
  collection: MailCollection;
  stub: StubHandle;
  close(): Promise<void>;
}

const newHarness = (scanMessages: CanonicalMessage[]): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'd172-a7-mail-inbound-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const blobs = createBlobStore(join(dataDir, 'blobs'));
  const bus = createWarehouseEventBus();
  const registry = createCollectionRegistry();
  let id = 0;
  const store = createAnnotationStore({
    db,
    blobs,
    now: () => NOW + id,
    newId: () => `d172-a7-link-${++id}`,
  });
  const fileColl = createInboundFileCollection({
    db,
    blobs,
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:file:received' }),
    bus,
    slug: 'received',
    now: () => NOW,
  });
  registry.register(fileColl);
  const stub = makeStubProvider(scanMessages);
  const config: MailCollectionConfig = {
    backfill_days: 30,
    retention_days: 365,
    quota_bytes: BIG_QUOTA,
  };
  const attachDeps = { annotationDeps: { store } as AnnotationRpcDeps, registry };
  const collection = createMailCollection({
    db,
    blobs,
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:mail:work' }),
    bus,
    slug: 'work',
    provider: stub.provider,
    config: () => config,
    now: () => NOW,
    inboundAttachmentDeps: () => ({
      fileIngestor: fileColl,
      attach: attachFile,
      attachDeps,
    }),
  });
  registry.register(collection);
  return {
    dir,
    db,
    blobs,
    store,
    registry,
    fileColl,
    collection,
    stub,
    async close() {
      await collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const harnesses: Harness[] = [];
const withHarness = (scanMessages: CanonicalMessage[]): Harness => {
  const h = newHarness(scanMessages);
  harnesses.push(h);
  return h;
};

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close();
  }
});

const listFiles = (h: Harness) =>
  h.fileColl.list({ platform: 'file', slug: 'received' });

const mailRecord = (h: Harness) =>
  h.collection.list({ platform: 'mail', slug: 'work' })[0];

const linkPrefetchStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

describe('D-172 A.7 mail inbound attachment capstone', () => {
  it('ingests provider parts into CAS, attaches them to the mail record, and is idempotent on re-sync', async () => {
    const pdf = Buffer.from('%PDF-1.4 signed contract');
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    const msg = mkMessage({
      source_id: 'provider-msg-attachments',
      has_attachments: true,
      attachments: [
        attachmentPart({
          filename: '../contract.pdf',
          mime_type: 'application/octet-stream',
          source_part_id: 'att-a',
          bytes: pdf,
        }),
        attachmentPart({
          filename: 'image.png',
          mime_type: 'application/octet-stream',
          source_part_id: 'att-b',
          bytes: png,
        }),
      ],
    });
    const h = withHarness([msg]);

    await h.collection.sync.start();

    const mail = mailRecord(h);
    expect(mail.hot_fields.has_attachments).toBe(true);
    const fileAId = inboundFileRecordId('mail_attachment', `${mail.record_id}:att-a`);
    const fileBId = inboundFileRecordId('mail_attachment', `${mail.record_id}:att-b`);
    const fileA = h.fileColl.get(fileAId)!;
    const fileB = h.fileColl.get(fileBId)!;
    expect(fileA.hot_fields).toMatchObject({
      filename: 'contract.pdf',
      mime_type: 'application/pdf',
      origin: 'mail_attachment',
      size: pdf.length,
    });
    expect(fileB.hot_fields).toMatchObject({
      filename: 'image.png',
      mime_type: 'image/png',
      origin: 'mail_attachment',
      size: png.length,
    });
    await expect(h.blobs.get(fileA.blob_hash!)).resolves.toEqual(pdf);
    await expect(h.blobs.get(fileB.blob_hash!)).resolves.toEqual(png);

    const links = await h.store.outboundLinks('mail', mail.record_id);
    expect(links.map((l) => l.to_id).sort()).toEqual([fileAId, fileBId].sort());
    expect(links.every((l) => l.role === 'attachment' && l.to_collection === 'file')).toBe(true);

    const stores = linkPrefetchStores();
    const ref = `{{data.mail.${mail.record_id}.links.attachment}}`;
    await prefetchSharedRefs(
      { id: 'assert-links', ingredient: 'noop', input: { attachments: ref } } as RecipeStep,
      stores,
      {
        linksForRecord: async (collection, id, direction) => {
          expect(collection).toBe('mail');
          expect(id).toBe(mail.record_id);
          expect(direction).toBe('outbound');
          return h.store.outboundLinks(collection, id);
        },
      },
    );
    const resolved = resolveValue(ref, stores) as Link[];
    expect(resolved.map((l) => l.to_id).sort()).toEqual([fileAId, fileBId].sort());

    await h.stub.push({ kind: 'updated', source_id: msg.source_id, message: msg });
    expect(listFiles(h).map((f) => f.record_id).sort()).toEqual([fileAId, fileBId].sort());
    const afterLinks = await h.store.outboundLinks('mail', mail.record_id);
    expect(afterLinks.filter((l) => l.role === 'attachment')).toHaveLength(2);
  });

  it('records a failed attachment fetch without dropping sibling parts or the mail record', async () => {
    const good = Buffer.from('%PDF-1.4 sibling attachment');
    const msg = mkMessage({
      source_id: 'provider-msg-partial-failure',
      has_attachments: true,
      attachments: [
        attachmentPart({
          filename: 'good.pdf',
          mime_type: 'application/pdf',
          source_part_id: 'good',
          bytes: good,
        }),
        failingAttachmentPart({
          filename: 'bad.pdf',
          mime_type: 'application/pdf',
          source_part_id: 'bad',
          size: 123,
        }),
      ],
    });
    const h = withHarness([msg]);

    await h.collection.sync.start();

    const mail = mailRecord(h);
    const goodId = inboundFileRecordId('mail_attachment', `${mail.record_id}:good`);
    expect(h.collection.get(mail.record_id)).not.toBeNull();
    expect(listFiles(h).map((f) => f.record_id)).toEqual([goodId]);
    expect(await h.store.outboundLinks('mail', mail.record_id)).toHaveLength(1);
    expect(h.collection.health().error_count_24h).toBeGreaterThan(0);
  });
});
