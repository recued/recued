/** The attachment links two IMAP mailboxes shared, removed once
 *  (`mail-attachment-link-repair.ts`). Over the real stores and tables. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { afterEach, describe, expect, it } from 'vitest';

import type { AnnotationRpcDeps } from '../annotation-handler.js';
import { attachFile } from '../collections/file/attach-file.js';
import { createInboundFileCollection, type FileOrigin } from '../collections/file/inbound-file-collection.js';
import { createInstanceStore } from '../collections/instance-store.js';
import {
  MAIL_ATTACHMENT_SHARED_ID_REPAIR_ID,
  repairSharedMailAttachmentLinks,
} from '../collections/mail/mail-attachment-link-repair.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createCollectionTable } from '../collections/table.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createDataRepairLedger } from '../storage/data-repair-ledger.js';

const NOW = 1_800_000_000_000;
const SHARED = 'mail:11111111111111111111111111111111';
const ALONE = 'mail:22222222222222222222222222222222';
const TWICE_ENROLLED = 'mail:33333333333333333333333333333333';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Mail tables holding ids, as the mailboxes named left them; `adapter` null
 *  for a mailbox deleted since, whose table is left behind. */
const server = (mailboxes: Record<string, { adapter: 'imap' | 'gmail' | null; ids: string[] }>) => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-attachment-link-repair-'));
  const db = new Database(join(dir, 'server.db'));
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const blobs = createBlobStore(join(dir, 'blobs'));
  const instances = createInstanceStore({ db });
  for (const [slug, { adapter, ids }] of Object.entries(mailboxes)) {
    if (adapter !== null) {
      instances.upsert({
        platform: 'mail', slug, adapter_type: adapter, config: {}, caps: {}, auth_state: 'healthy', last_synced_at: null,
      } as never);
    }
    const table = createCollectionTable({ db, platform: 'mail', slug });
    for (const record_id of ids) {
      table.upsert({ record_id, received_at: NOW, modified_at: NOW, hot_fields: {}, size_bytes: 0, source_id: '7@INBOX' });
    }
  }
  let ids = 0;
  const annotations = createAnnotationStore({ db, blobs, now: () => NOW + ids, newId: () => `link-${(ids += 1)}` });
  const registry = createCollectionRegistry();
  const files = createInboundFileCollection({
    db, blobs, bus: createWarehouseEventBus(), slug: 'received', now: () => NOW,
    gate: createStorageGate({ quota: 1 << 30, reservePct: 10, surface: 'collection:file:received' }),
  });
  registry.register(files);
  const attachDeps = { annotationDeps: { store: annotations } as AnnotationRpcDeps, registry };
  /** A stored file, linked from the email as its attachment. */
  const attached = async (record_id: string, source_id: string, origin: FileOrigin = 'mail_attachment'): Promise<string> => {
    const file = await files.ingest({
      bytes: Buffer.from(source_id), filename: 'invoice.pdf', mime_type: 'application/pdf', origin, source_id, now: NOW,
    });
    await attachFile({ file_id: file.record_id, to_collection: 'mail', to_id: record_id }, attachDeps);
    return file.record_id;
  };
  const linked = async (record_id: string): Promise<string[]> =>
    (await annotations.outboundLinks('mail', record_id)).map((link) => `${link.role}:${link.to_id}`).sort();
  return { db, files, annotations, attached, linked };
};

describe('the shared attachment link repair', () => {
  it('unlinks only the legacy attachment files of ids two mailboxes hold, keeps every file, and runs once', async () => {
    const s = server({
      work: { adapter: 'imap', ids: [SHARED, ALONE] },
      home: { adapter: 'imap', ids: [SHARED] },
    });
    const legacy = await s.attached(SHARED, `${SHARED}:part-0`);
    const scoped = await s.attached(SHARED, `work/${SHARED}:part-0`);
    const upload = await s.attached(SHARED, 'upload-1', 'webclient_upload');
    await s.annotations.link({
      from_collection: 'mail', from_id: SHARED, to_collection: 'file', to_id: legacy, role: 'mentions', authored_by_recipe_id: 'r',
    });
    const alone = await s.attached(ALONE, `${ALONE}:part-0`);

    expect(repairSharedMailAttachmentLinks(s.db, NOW)).toEqual({ applied: true, unlinked: 1 });

    expect(await s.linked(SHARED)).toEqual([`attachment:${scoped}`, `attachment:${upload}`, `mentions:${legacy}`].sort());
    expect(await s.linked(ALONE)).toEqual([`attachment:${alone}`]);
    for (const file of [legacy, scoped, upload, alone]) expect(s.files.get(file)).not.toBeNull();
    const record = createDataRepairLedger(s.db).get(MAIL_ATTACHMENT_SHARED_ID_REPAIR_ID);
    expect(record).toMatchObject({ applied_at: NOW, summary: { unlinked: [{ record_id: SHARED, file_id: legacy }] } });

    // Once: a link written since is not the defect's, and stays.
    await s.attached(SHARED, `${SHARED}:part-0`);
    expect(repairSharedMailAttachmentLinks(s.db, NOW + 1)).toEqual({ applied: false, unlinked: 0 });
    expect(await s.linked(SHARED)).toContain(`attachment:${legacy}`);
    expect(createDataRepairLedger(s.db).get(MAIL_ATTACHMENT_SHARED_ID_REPAIR_ID)?.applied_at).toBe(NOW);
  });

  it('leaves an id only Gmail or Graph mailboxes hold — one account enrolled twice — and repairs one a deleted mailbox’s table shares', async () => {
    const s = server({
      personal: { adapter: 'gmail', ids: [TWICE_ENROLLED] },
      'personal-again': { adapter: 'gmail', ids: [TWICE_ENROLLED] },
      work: { adapter: 'imap', ids: [SHARED] },
      'work-old': { adapter: null, ids: [SHARED] },
    });
    const gmail = await s.attached(TWICE_ENROLLED, `${TWICE_ENROLLED}:part-0`);
    const legacy = await s.attached(SHARED, `${SHARED}:part-0`);

    expect(repairSharedMailAttachmentLinks(s.db, NOW)).toEqual({ applied: true, unlinked: 1 });
    expect(await s.linked(TWICE_ENROLLED)).toEqual([`attachment:${gmail}`]);
    expect(await s.linked(SHARED)).toEqual([]);
    expect(s.files.get(legacy)).not.toBeNull();
  });

  it('records a server with nothing to repair as repaired', () => {
    const s = server({ work: { adapter: 'imap', ids: [ALONE] } });
    expect(repairSharedMailAttachmentLinks(s.db, NOW)).toEqual({ applied: true, unlinked: 0 });
    expect(repairSharedMailAttachmentLinks(s.db, NOW)).toEqual({ applied: false, unlinked: 0 });
  });
});
