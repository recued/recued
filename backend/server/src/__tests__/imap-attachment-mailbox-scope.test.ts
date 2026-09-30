/** Two IMAP mailboxes, one email id: whose attachment is it?
 *
 *  An IMAP record id hashes `uid@folder`, which two accounts share — both have
 *  a UID 7 in INBOX. Each mailbox keeps its rows in its own table, but received
 *  attachments live in ONE `data.file.received` table, and were named by the
 *  bare record id: each account's re-ingest overwrote the other's file, and a
 *  reader of either got whichever wrote last. Proven here over the real mail,
 *  file and link stores; only the IMAP server is scripted. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { afterEach, describe, expect, it } from 'vitest';

import type { AnnotationRpcDeps } from '../annotation-handler.js';
import { attachFile } from '../collections/file/attach-file.js';
import { createInboundFileCollection, inboundFileRecordId } from '../collections/file/inbound-file-collection.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { legacyAttachmentsAmbiguousIn } from '../collections/mail/mail-attachment-source-id.js';
import { createMailCollection, type MailCollection } from '../collections/mail/mail-collection.js';
import type {
  CanonicalMessage,
  InboundMailAttachmentPart,
  MailProvider,
  ProviderSyncCallback,
  ProviderSyncEvent,
} from '../collections/mail/provider.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createMailAttachmentReader } from '../mail-attachment-evidence.js';
import { storedAttachmentsOf } from '../mail-facts/stored-email.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createBackfillStateLookup } from '../triggers/backfill-state.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { createEventTriggersStore } from '../triggers/store.js';

const NOW = 1_800_000_000_000;
const QUOTA = 1 << 30;
const UID = '7@INBOX';

const part = (bytes: string, fails = false): InboundMailAttachmentPart => ({
  filename: 'invoice.pdf', mime_type: 'application/pdf', size: bytes.length, source_part_id: 'part-0',
  async fetchBytes() {
    if (fails) throw new Error('the IMAP server dropped the connection');
    return Buffer.from(bytes);
  },
});

const email = (attachments: InboundMailAttachmentPart[], over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: UID, from: 'billing@vendor.example', to: ['me@example.com'], cc: [], subject: 'Invoice', thread_id: 't-7',
  folder_or_label: 'INBOX', is_read: false, is_flagged: false, has_attachments: attachments.length > 0,
  received_at: NOW - 60_000, body_text: 'Attached.', attachments, ...over,
});

/** The file an attachment's source id names — the on-disk forms, pinned. */
const legacyFile = (record_id: string): string => inboundFileRecordId('mail_attachment', `${record_id}:part-0`);
const scopedFile = (slug: string, record_id: string): string =>
  inboundFileRecordId('mail_attachment', `${slug}/${record_id}:part-0`);

const worlds: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()!();
});

/** One server's stores, with IMAP mailboxes added by `mailbox`. `failUnlink`:
 *  the link store refuses to delete a link. */
const world = (options: { readonly failUnlink?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'imap-attachment-scope-'));
  const db = new Database(join(dir, 'server.db'));
  const blobs = createBlobStore(join(dir, 'blobs'));
  const bus = createWarehouseEventBus();
  const registry = createCollectionRegistry();
  const instances = createInstanceStore({ db });
  let ids = 0;
  const annotations = createAnnotationStore({ db, blobs, now: () => NOW + ids, newId: () => `link-${(ids += 1)}` });
  const files = createInboundFileCollection({
    db, blobs, bus, slug: 'received', now: () => NOW,
    gate: createStorageGate({ quota: QUOTA, reservePct: 10, surface: 'collection:file:received' }),
  });
  registry.register(files);
  const linkStore = options.failUnlink
    ? { ...annotations, deleteLink: async (): Promise<boolean> => { throw new Error('database is locked'); } }
    : annotations;
  const attachDeps = { annotationDeps: { store: linkStore } as AnnotationRpcDeps, registry };
  const collections: MailCollection[] = [];
  worlds.push(async () => {
    for (const collection of collections) await collection.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const mailbox = (slug: string, scan: CanonicalMessage[] = []) => {
    /** The attachments each upsert handed its hook (D-315). */
    const upserted: string[][] = [];
    instances.upsert({
      platform: 'mail', slug, adapter_type: 'imap', config: {}, caps: {}, auth_state: 'healthy', last_synced_at: null,
    } as never);
    let sync: ProviderSyncCallback | null = null;
    const provider: MailProvider = {
      kind: 'imap', slug, sendCapable: false, mutationCapable: false, accountEmail: `${slug}@example.com`,
      async connect() {},
      async close() {},
      async initialScan(opts) { for (const message of scan) if (!(await opts.onMessage(message))) break; },
      async startSync(cb) {
        sync = cb;
        return async () => { sync = null; };
      },
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    };
    const collection = createMailCollection({
      db, blobs, bus, slug, provider, instances, now: () => NOW,
      gate: createStorageGate({ quota: QUOTA, reservePct: 10, surface: `collection:mail:${slug}` }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: QUOTA }),
      inboundAttachmentDeps: () => ({ fileIngestor: files, attach: attachFile, attachDeps }),
      onMessageUpserted: (_message, ctx) => { upserted.push(ctx.attachments.map((attachment) => attachment.file_id)); },
    });
    registry.register(collection);
    collections.push(collection);
    return {
      collection,
      upserted,
      /** A restart's re-scan or a flag change: the email listed again. */
      push: (event: ProviderSyncEvent) => sync!(event),
      row: () => collection.list({ platform: 'mail', slug, limit: 10 }).find((row) => row.source_id === UID)!,
    };
  };

  /** What an ingest before this fix left: the attachment named by the bare id, linked. */
  const legacyAttachment = async (record_id: string, bytes: string): Promise<string> => {
    const file = await files.ingest({
      bytes: Buffer.from(bytes), filename: 'invoice.pdf', mime_type: 'application/pdf',
      origin: 'mail_attachment', source_id: `${record_id}:part-0`, now: NOW,
    });
    await attachFile({ file_id: file.record_id, to_collection: 'mail', to_id: record_id }, attachDeps);
    return file.record_id;
  };

  const bytesOf = async (file_id: string): Promise<string> => (await files.readBytes(file_id)).bytes.toString();
  const linked = async (record_id: string): Promise<string[]> =>
    (await annotations.outboundLinks('mail', record_id)).filter((link) => link.role === 'attachment').map((link) => link.to_id).sort();
  const stored = (): string[] => files.list({ platform: 'file', slug: 'received', limit: 50 }).map((file) => file.record_id).sort();
  const reader = createMailAttachmentReader(registry, annotations, legacyAttachmentsAmbiguousIn(registry));

  return { db, bus, instances, registry, files, annotations, attachDeps, mailbox, legacyAttachment, bytesOf, linked, stored, reader };
};

describe('two IMAP mailboxes holding an email under one id', () => {
  it('keep one attachment file each, which neither re-ingest overwrites, and keep each verdict', async () => {
    const w = world();
    const work = w.mailbox('work', [email([part('%PDF-1.4 work invoice')])]);
    const home = w.mailbox('home', [email([part('%PDF-1.4 home letter')])]);
    await work.collection.sync.start();
    await home.collection.sync.start();
    const id = work.row().record_id;
    expect(home.row().record_id).toBe(id);

    expect(w.stored()).toEqual([scopedFile('home', id), scopedFile('work', id)].sort());
    expect(await w.bytesOf(scopedFile('work', id))).toBe('%PDF-1.4 work invoice');
    expect(await w.bytesOf(scopedFile('home', id))).toBe('%PDF-1.4 home letter');
    w.files.setScanStatus(scopedFile('work', id), 'clean');
    w.files.setScanStatus(scopedFile('home', id), 'flagged');

    // Every restart re-scans, and every flag change re-fetches: in turn.
    for (const [box, bytes] of [[home, 'home letter'], [work, 'work invoice'], [home, 'home letter']] as const) {
      await box.push({ kind: 'updated', source_id: UID, message: email([part(`%PDF-1.4 ${bytes}`)], { is_read: true }) });
    }

    expect(w.stored()).toEqual([scopedFile('home', id), scopedFile('work', id)].sort());
    expect(await w.bytesOf(scopedFile('work', id))).toBe('%PDF-1.4 work invoice');
    expect(await w.bytesOf(scopedFile('home', id))).toBe('%PDF-1.4 home letter');
    expect(w.files.get(scopedFile('work', id))?.hot_fields.scan_status).toBe('clean');
    expect(w.files.get(scopedFile('home', id))?.hot_fields.scan_status).toBe('flagged');
  });

  it('names a new email’s attachment with its mailbox', async () => {
    const w = world();
    const work = w.mailbox('work', [email([part('%PDF-1.4 new')])]);
    await work.collection.sync.start();
    const id = work.row().record_id;
    expect(w.stored()).toEqual([scopedFile('work', id)]);
    expect(await w.linked(id)).toEqual([scopedFile('work', id)]);
  });

  it('keeps the legacy name of a single mailbox’s attachment: an upgrade renames nothing', async () => {
    const w = world();
    const work = w.mailbox('work', [email([], { has_attachments: true })]);
    await work.collection.sync.start();
    const id = work.row().record_id;
    const legacy = await w.legacyAttachment(id, '%PDF-1.4 work invoice');

    await work.push({ kind: 'updated', source_id: UID, message: email([part('%PDF-1.4 work invoice')], { is_read: true }) });

    expect(legacy).toBe(legacyFile(id));
    expect(w.stored()).toEqual([legacy]);
    expect(await w.linked(id)).toEqual([legacy]);
  });

  it('files an email under its mailbox once another mailbox holds its id: the legacy link goes, the file stays', async () => {
    const w = world();
    const work = w.mailbox('work', [email([], { has_attachments: true })]);
    // The other account's copy of the id, its attachment not re-read yet.
    const home = w.mailbox('home', [email([], { has_attachments: true })]);
    await work.collection.sync.start();
    const id = work.row().record_id;
    const legacy = await w.legacyAttachment(id, '%PDF-1.4 work invoice');
    await home.collection.sync.start();

    await work.push({ kind: 'updated', source_id: UID, message: email([part('%PDF-1.4 work invoice')], { is_read: true }) });

    expect(await w.linked(id)).toEqual([scopedFile('work', id)]);
    expect(await w.bytesOf(scopedFile('work', id))).toBe('%PDF-1.4 work invoice');
    // Not deleted: a chat attachment or a mail fact may name it.
    expect(w.files.get(legacy)).not.toBeNull();
  });

  it('still hands the upsert hook the attachment when the legacy link cannot be removed', async () => {
    const w = world({ failUnlink: true });
    const work = w.mailbox('work', [email([], { has_attachments: true })]);
    const home = w.mailbox('home', [email([], { has_attachments: true })]);
    await work.collection.sync.start();
    const id = work.row().record_id;
    const legacy = await w.legacyAttachment(id, '%PDF-1.4 work invoice');
    await home.collection.sync.start();
    const errors = work.collection.health().error_count_24h;

    await work.push({ kind: 'updated', source_id: UID, message: email([part('%PDF-1.4 work invoice')], { is_read: true }) });

    expect(work.upserted.at(-1)).toEqual([scopedFile('work', id)]);
    expect(await w.linked(id)).toEqual([legacy, scopedFile('work', id)].sort());
    expect(work.collection.health().error_count_24h).toBe(errors + 1);
  });
});

describe('reading an email’s attachments', () => {
  it('gives a shared id only this mailbox’s own files — never the legacy file, which may be the other account’s', async () => {
    const w = world();
    const work = w.mailbox('work', [email([], { has_attachments: true })]);
    const home = w.mailbox('home', [email([], { has_attachments: true })]);
    await work.collection.sync.start();
    await home.collection.sync.start();
    const id = work.row().record_id;
    // As the two accounts left it before this fix, and each since re-filed.
    const legacy = await w.legacyAttachment(id, '%PDF-1.4 whichever wrote last');
    for (const slug of ['work', 'home']) {
      const file = await w.files.ingest({
        bytes: Buffer.from(`%PDF-1.4 ${slug}`), filename: 'invoice.pdf', mime_type: 'application/pdf',
        origin: 'mail_attachment', source_id: `${slug}/${id}:part-0`, now: NOW,
      });
      await attachFile({ file_id: file.record_id, to_collection: 'mail', to_id: id }, w.attachDeps);
    }
    expect(await w.linked(id)).toEqual([legacy, scopedFile('home', id), scopedFile('work', id)].sort());

    expect(w.reader(work.row(), 'work').attachments.map((a) => a.file_ref)).toEqual([scopedFile('work', id)]);
    expect(w.reader(home.row(), 'home').attachments.map((a) => a.file_ref)).toEqual([scopedFile('home', id)]);
  });

  it('still gives a single mailbox’s email its legacy file', async () => {
    const w = world();
    const work = w.mailbox('work', [email([], { has_attachments: true })]);
    await work.collection.sync.start();
    const legacy = await w.legacyAttachment(work.row().record_id, '%PDF-1.4 work invoice');

    const read = w.reader(work.row(), 'work');
    expect(read.attachments).toEqual([expect.objectContaining({ file_ref: legacy, available: true })]);
    expect(read.warnings).toEqual([]);
  });
});

describe('a mail fact reading an email again', () => {
  it('finds the file named with the mailbox first, and one named by the bare id only where no other mailbox holds it', () => {
    const id = 'mail:0123456789abcdef0123456789abcdef';
    const message = email([part('%PDF-1.4 x')]);
    const offered = (files: string[], ambiguous?: boolean) => storedAttachmentsOf(message, 'work', id, {
      fileStored: (file_id) => files.includes(file_id),
      ...(ambiguous === undefined ? {} : { legacyAttachmentsAmbiguous: () => ambiguous }),
    }).map((attachment) => attachment.file_id);

    expect(offered([legacyFile(id), scopedFile('work', id)], false)).toEqual([scopedFile('work', id)]);
    expect(offered([legacyFile(id)], false)).toEqual([legacyFile(id)]);
    expect(offered([legacyFile(id)], true)).toEqual([]);
    // Unasked, a bare-id file could be another account's: not offered.
    expect(offered([legacyFile(id)])).toEqual([]);
    // Never another mailbox's.
    expect(offered([scopedFile('home', id)], false)).toEqual([]);
  });

  it('asks the mailbox, which reads every mail table', async () => {
    const w = world();
    const work = w.mailbox('work', [email([], { has_attachments: true })]);
    await work.collection.sync.start();
    const id = work.row().record_id;
    const ambiguous = legacyAttachmentsAmbiguousIn(w.registry);
    expect(ambiguous('work', id)).toBe(false);
    const home = w.mailbox('home', [email([], { has_attachments: true })]);
    await home.collection.sync.start();
    expect(ambiguous('work', id)).toBe(true);
    expect(ambiguous('gone', id)).toBe(true);
  });
});

describe('a received-file trigger, when an email’s attachment is filed again', () => {
  const triggered = (w: ReturnType<typeof world>) => {
    const store = createEventTriggersStore(w.db);
    store.create({
      trigger_id: 't-received', recipe_id: 'r-received', publisher_id: 'local', pattern: 'data.file.received.**',
      enabled: true, origin: 'user', created_at: 1, last_fired_at: null, last_error: null,
    } as never);
    const runs: string[] = [];
    const dispatcher = createEventTriggerDispatcher({
      bus: w.bus, store, backfillState: createBackfillStateLookup({ instances: w.instances }),
      runtime: {
        runRecipe: async (input) => {
          runs.push((input.context as { event: { payload: { record_id: string } } }).event.payload.record_id);
          return { run_id: `run-${runs.length}` };
        },
      },
    });
    dispatcher.rebuild();
    worlds.push(async () => { dispatcher.dispose(); });
    return { runs, drained: () => dispatcher.drained() };
  };

  it('is not told of an old email renamed with its mailbox; a new email’s attachment still tells it', async () => {
    const w = world();
    const work = w.mailbox('work', [email([], { has_attachments: true })]);
    const home = w.mailbox('home');
    await work.collection.sync.start();
    await home.collection.sync.start();
    const id = work.row().record_id;
    await w.legacyAttachment(id, '%PDF-1.4 work invoice');
    const trigger = triggered(w);

    // New mail for `home` under the same id: news.
    await home.push({ kind: 'created', source_id: UID, message: email([part('%PDF-1.4 home letter')]) });
    // `work`'s own email read again: its attachment filed anew, under `work`.
    await work.push({ kind: 'updated', source_id: UID, message: email([part('%PDF-1.4 work invoice')], { is_read: true }) });
    await trigger.drained();

    expect(w.files.get(scopedFile('work', id))).not.toBeNull();
    expect(trigger.runs).toEqual([scopedFile('home', id)]);
  });

  it('is told of an attachment first stored late for an email already here: no trigger has seen it', async () => {
    const w = world();
    // The first fetch failed: the email landed, its attachment did not.
    const work = w.mailbox('work', [email([part('%PDF-1.4 work invoice', true)])]);
    await work.collection.sync.start();
    const id = work.row().record_id;
    expect(w.stored()).toEqual([]);
    const trigger = triggered(w);

    await work.push({ kind: 'updated', source_id: UID, message: email([part('%PDF-1.4 work invoice')], { is_read: true }) });
    await trigger.drained();

    expect(w.stored()).toEqual([scopedFile('work', id)]);
    expect(trigger.runs).toEqual([scopedFile('work', id)]);
  });
});
