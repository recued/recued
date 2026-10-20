/** The approval card names the files a held action carries.
 *
 *  ⛔ Found on a live drive (2026-10-10): Chat emailed a file from a watched
 *  folder, and the held send's card read
 *  `Attachments ["file:local:Y2xpZW50cw:U2FuZGh1cnN0L2tpY2tvZmYtbm90ZXMubWQ"]` —
 *  the row the owner reads to check that the right file is leaving, with
 *  nothing in it they could check.
 *
 *  Over a real watched folder, a real saved file and a real connected-source
 *  row, through the describer the server composes. */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createAskCardDetailResolver } from '../ask-card-held-op-details.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { watchedFileRecordId } from '../collections/file/watched-folder-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import {
  createFileRefDescriber,
  createFileViewResolverFromRegistry,
  remoteFileRecordId,
} from '../file-view-resolver.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  buildFileMetaSnapshot, createFileMetaStore, ensureFileMetaSchema,
} from '../storage/file-meta-store.js';
import { startWatchedFolder } from './helpers/watched-folder.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const world = async () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'card-files-'));
  const bus = createWarehouseEventBus();
  const registry = createCollectionRegistry();
  const received = createInboundFileCollection({
    db, blobs: createBlobStore(join(dir, 'cas')), bus, slug: 'received',
    gate: createStorageGate({ quota: 10 * 1024 * 1024, reservePct: 10, surface: 'collection:file:received' }),
  });
  registry.register(received);
  const saved = await received.ingest({
    bytes: Buffer.from('a brief'), filename: 'brief.pdf', mime_type: 'application/pdf',
    origin: 'webclient_upload', source_id: 'upload-1',
  });
  const root = join(dir, 'Clients');
  mkdirSync(join(root, 'Sandhurst'), { recursive: true });
  writeFileSync(join(root, 'Sandhurst', 'kickoff-notes.md'), '# Kickoff\n');
  writeFileSync(join(root, 'agenda.md'), '# Agenda\n');
  const folder = await startWatchedFolder({ db, bus, registry, slug: 'clients', root });
  ensureFileMetaSchema(db);
  const meta = createFileMetaStore(db);
  const mirror = (scope: string, provider: string, filename: string, path: string) => {
    meta.upsert({
      scope, target_id: `id:${filename}`, now: 9_000,
      meta: buildFileMetaSnapshot({ filename, path, provider, remote_id: `id:${filename}`, mime_type: 'application/pdf', mtime: 9_000 }, 9_000),
    });
    return remoteFileRecordId(scope, `id:${filename}`);
  };
  const ids = {
    nested: watchedFileRecordId('clients', 'Sandhurst/kickoff-notes.md'),
    top: watchedFileRecordId('clients', 'agenda.md'),
    saved: saved.record_id,
    dropbox: mirror('src_dropbox_1', 'dropbox', 'invoice-10823.pdf', 'Sandhurst/invoice-10823.pdf'),
    unknownVendor: mirror('src_acme_1', 'acme-drive', 'plan.pdf', 'plan.pdf'),
    gone: watchedFileRecordId('clients', 'Sandhurst/deleted.md'),
  };
  cleanups.push(async () => { await folder.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  // What `compose-listeners.ts` hands the card resolver.
  const describe = createFileRefDescriber(createFileViewResolverFromRegistry(registry, meta));
  return { ids, describe };
};

describe('a file as the approval card names it', () => {
  it('its name, and the folder, saved files or source it lives in', async () => {
    const { ids, describe } = await world();
    expect(describe(ids.nested)).toBe('kickoff-notes.md (clients folder: Sandhurst/kickoff-notes.md)');
    // At the folder's top level the path is the name: said once.
    expect(describe(ids.top)).toBe('agenda.md (clients folder)');
    expect(describe(ids.saved)).toBe('brief.pdf (Saved files)');
    expect(describe(ids.dropbox)).toBe('invoice-10823.pdf (Dropbox: Sandhurst/invoice-10823.pdf)');
    expect(describe(ids.unknownVendor)).toBe('plan.pdf (acme-drive)');
    expect(describe(ids.gone)).toBeUndefined();
  });
});

describe('the card for a held send', () => {
  // The send the drive held, as Chat called it.
  const SEND = {
    sender_mail_instance: 'bench-mail',
    to: ['dana@sandhurst.test'],
    subject: 'Sandhurst kickoff notes',
    body: 'These are the notes from our kickoff.',
  };
  const card = (args: Record<string, unknown>, describeFileRef?: (id: string) => string | undefined) =>
    createAskCardDetailResolver({
      getCheckpoint: async () => ({
        checkpoint_id: 'cp1', run_id: 'run1', gated_step_id: 'send',
        step_state: { send: { input: args } },
        approved_target: { ingredient_slug: 'mail-send' },
      } as never),
      getAnchor: async () => ({ commit_status: 'awaiting_approval', recipe_id: 'send-composed-mail' } as never),
      // A Recued built-in declares no reviewable fields: the kernel rows.
      resolveArgEditSchema: () => ({ fields: [] }),
      timeZone: 'UTC',
      ...(describeFileRef !== undefined ? { describeFileRef } : {}),
    })({ ask_id: 'a1', handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'cp1' } } as never);
  const row = (rows: Awaited<ReturnType<typeof card>>, label: string) =>
    rows?.find((r) => r.label === label)?.value;

  it('names its attachment', async () => {
    const { ids, describe } = await world();
    const rows = await card({ ...SEND, attachments: [ids.nested] }, describe);
    expect(row(rows, 'attachments')).toBe('kickoff-notes.md (clients folder: Sandhurst/kickoff-notes.md)');
    // A list that is not of files reads as its values.
    expect(row(rows, 'to')).toBe('dana@sandhurst.test');
    expect(row(rows, 'subject')).toBe('Sandhurst kickoff notes');
  });

  it('the whole send the drive held: lists read as their values, blank fields share two rows', async () => {
    // Live drive 2026-10-10: twelve rows, six of them blank, and `To ["dana@sandhurst.test"]`.
    const { ids, describe } = await world();
    const rows = await card({
      subject: 'Sandhurst kickoff notes', sender_mail_instance: 'bench-mail',
      to: ['dana@sandhurst.test'], cc: [], bcc: [],
      body: 'Hi Dana,\n\nPlease find attached the notes from our kickoff.', body_format: 'text',
      in_reply_to: '', references: [], reply_to: '', reconciliation_id: null,
      attachments: [ids.nested],
    }, describe);
    expect(rows).toEqual([
      { label: 'subject', value: 'Sandhurst kickoff notes' },
      { label: 'from', value: 'bench-mail' },
      { label: 'to', value: 'dana@sandhurst.test' },
      { label: 'body', value: 'Hi Dana,\n\nPlease find attached the notes from our kickoff.' },
      { label: 'body_format', value: 'text' },
      { label: 'attachments', value: 'kickoff-notes.md (clients folder: Sandhurst/kickoff-notes.md)' },
      { label: 'Not set', value: 'Reconciliation ID' },
      { label: 'Empty', value: 'CC, BCC, In reply to, References, Reply to' },
    ]);
  });

  it('several: how many, then each; one it cannot find says so', async () => {
    const { ids, describe } = await world();
    const rows = await card({ ...SEND, attachments: [ids.nested, ids.saved, ids.gone] }, describe);
    expect(row(rows, 'attachments')).toBe(
      `3 files: kickoff-notes.md (clients folder: Sandhurst/kickoff-notes.md); brief.pdf (Saved files); ${ids.gone} (not found)`,
    );
  });

  it('text that only starts like a file id is left as written', async () => {
    const { describe } = await world();
    const rows = await card({ ...SEND, subject: 'file:local: notes' }, describe);
    expect(row(rows, 'subject')).toBe('file:local: notes');
  });

  it('a describer that throws costs the name, never the card', async () => {
    const { ids } = await world();
    const rows = await card({ ...SEND, attachments: [ids.nested] }, () => { throw new Error('store closed'); });
    expect(row(rows, 'attachments')).toBe(`${ids.nested} (not found)`);
    expect(row(rows, 'subject')).toBe('Sandhurst kickoff notes');
  });

  it('without a describer, the ids', async () => {
    const { ids } = await world();
    const rows = await card({ ...SEND, attachments: [ids.nested] });
    expect(row(rows, 'attachments')).toBe(ids.nested);
  });
});
