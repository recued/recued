/** D-172 Phase 2 — `attachFile` link-writer tests.
 *
 *  Exercises the real `handleLinkWrite` → `AnnotationStore.link()`
 *  path against a real `InboundFileCollection`, covering:
 *    - the written link's role / endpoints / DIRECTION (N.3:
 *      from = entity, to = file);
 *    - idempotent re-attach (no duplicate edge; the existing link is
 *      reused — the `link` table has no UNIQUE on (from, to, role));
 *    - file-not-found rejection (I-1, no dangling links);
 *    - the mutation-check: a wrong-direction edge does NOT satisfy the
 *      inline `…links.attachment` / `…inbound_links.attachment`
 *      surfacing the consumer relies on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { RpcError } from '@recued/contracts';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../../../storage/annotation-store.js';
import type { AnnotationRpcDeps } from '../../../annotation-handler.js';
import {
  createInboundFileCollection,
  inboundFileRecordId,
  type InboundFileCollection,
} from '../inbound-file-collection.js';
import { createCollectionRegistry, type CollectionRegistry } from '../../registry.js';
import {
  attachFile,
  ATTACH_FILE_AUTHOR_ID,
  ATTACHMENT_LINK_ROLE,
} from '../attach-file.js';

interface Harness {
  root: string;
  db: Database.Database;
  blobs: BlobStore;
  store: AnnotationStore;
  registry: CollectionRegistry;
  collection: InboundFileCollection;
  deps: { annotationDeps: AnnotationRpcDeps; registry: CollectionRegistry };
}

let h: Harness;

const makeHarness = (): Harness => {
  const root = mkdtempSync(join(tmpdir(), 'd172-attach-file-'));
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  const blobs = createBlobStore(join(root, 'blobs'));
  let counter = 0;
  const store = createAnnotationStore({
    db,
    blobs,
    now: () => 1_000_000 + ++counter,
    newId: () => `link-${counter}`,
  });
  const registry = createCollectionRegistry();
  const gate = createStorageGate({
    quota: 100 * 1024 * 1024,
    reservePct: 10,
    surface: 'collection:file:received',
  });
  const collection = createInboundFileCollection({
    db,
    blobs,
    gate,
    bus: createWarehouseEventBus(),
    slug: 'received',
    now: () => 1_000,
  });
  registry.register(collection);
  const deps = { annotationDeps: { store } as AnnotationRpcDeps, registry };
  return { root, db, blobs, store, registry, collection, deps };
};

/** Ingest a real file record so there is something to attach to. */
const ingestFile = async (source_id: string): Promise<string> => {
  const rec = await h.collection.ingest({
    bytes: Buffer.from(`body-${source_id}`),
    filename: `${source_id}.pdf`,
    mime_type: 'application/pdf',
    origin: 'reception_drop',
    source_id,
    scan_status: 'clean',
    now: 1_000,
  });
  return rec.record_id;
};

beforeEach(() => {
  h = makeHarness();
});

afterEach(async () => {
  await h.collection.close();
  h.db.close();
  rmSync(h.root, { recursive: true, force: true });
});

describe('attachFile', () => {
  it('writes a role:attachment link with the N.3 direction (from=entity, to=file)', async () => {
    const fileId = await ingestFile('drop-1');
    const { link, already_attached } = await attachFile(
      { file_id: fileId, to_collection: 'contact', to_id: 'jane@x.com' },
      h.deps,
    );

    expect(already_attached).toBe(false);
    expect(link.role).toBe(ATTACHMENT_LINK_ROLE);
    expect(ATTACHMENT_LINK_ROLE).toBe('attachment');
    // Direction: from = the entity, to = the file.
    expect(link.from_collection).toBe('contact');
    expect(link.from_id).toBe('jane@x.com');
    expect(link.to_collection).toBe('file');
    expect(link.to_id).toBe(fileId);
    expect(link.authored_by_recipe_id).toBe(ATTACH_FILE_AUTHOR_ID);

    // The edge is reachable inline BOTH directions via the store's
    // per-record reads (what the prefetch surfacing consumes):
    //   - entity outbound → the file
    const fromEntity = await h.store.outboundLinks('contact', 'jane@x.com');
    expect(fromEntity.filter((l) => l.role === 'attachment').map((l) => l.to_id))
      .toEqual([fileId]);
    //   - file inbound → the entity
    const toFile = await h.store.inboundLinks('file', fileId);
    expect(toFile.filter((l) => l.role === 'attachment').map((l) => l.from_id))
      .toEqual(['jane@x.com']);
  });

  it('honors an explicit authored_by override', async () => {
    const fileId = await ingestFile('drop-2');
    const { link } = await attachFile(
      {
        file_id: fileId,
        to_collection: 'project',
        to_id: 'proj-1',
        authored_by: 'recued-core/mail-inbound',
      },
      h.deps,
    );
    expect(link.authored_by_recipe_id).toBe('recued-core/mail-inbound');
  });

  it('is idempotent — re-attach of the same (entity, file) reuses the edge, no duplicate', async () => {
    const fileId = await ingestFile('drop-3');
    const first = await attachFile(
      { file_id: fileId, to_collection: 'contact', to_id: 'bob@x.com' },
      h.deps,
    );
    const second = await attachFile(
      { file_id: fileId, to_collection: 'contact', to_id: 'bob@x.com' },
      h.deps,
    );

    expect(first.already_attached).toBe(false);
    expect(second.already_attached).toBe(true);
    expect(second.link._id).toBe(first.link._id);

    // Exactly ONE physical attachment row to that file.
    const links = await h.store.outboundLinks('contact', 'bob@x.com');
    const atts = links.filter(
      (l) => l.role === 'attachment' && l.to_id === fileId,
    );
    expect(atts).toHaveLength(1);
  });

  it('distinct files on the same entity each get their own edge', async () => {
    const f1 = await ingestFile('drop-4a');
    const f2 = await ingestFile('drop-4b');
    await attachFile({ file_id: f1, to_collection: 'contact', to_id: 'c@x.com' }, h.deps);
    await attachFile({ file_id: f2, to_collection: 'contact', to_id: 'c@x.com' }, h.deps);

    const links = await h.store.outboundLinks('contact', 'c@x.com');
    const atts = links.filter((l) => l.role === 'attachment');
    expect(atts.map((l) => l.to_id).sort()).toEqual([f1, f2].sort());
  });

  it('rejects when the file record does not exist (no dangling link, I-1)', async () => {
    const ghost = inboundFileRecordId('reception_drop', 'never-ingested');
    await expect(
      attachFile({ file_id: ghost, to_collection: 'contact', to_id: 'x@x.com' }, h.deps),
    ).rejects.toMatchObject({ code: 'file_not_found' });

    // Nothing was written.
    const links = await h.store.outboundLinks('contact', 'x@x.com');
    expect(links).toHaveLength(0);
  });

  it('rejects malformed args', async () => {
    const fileId = await ingestFile('drop-5');
    await expect(
      attachFile({ file_id: '', to_collection: 'contact', to_id: 'x' }, h.deps),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      attachFile({ file_id: fileId, to_collection: '', to_id: 'x' }, h.deps),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      attachFile({ file_id: fileId, to_collection: 'contact', to_id: '' }, h.deps),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects when the file collection is not registered', async () => {
    const fileId = await ingestFile('drop-6');
    const emptyRegistry = createCollectionRegistry();
    await expect(
      attachFile(
        { file_id: fileId, to_collection: 'contact', to_id: 'x@x.com' },
        { annotationDeps: { store: h.store } as AnnotationRpcDeps, registry: emptyRegistry },
      ),
    ).rejects.toMatchObject({ code: 'collection_not_found' });
  });

  // MUTATION CHECK — the consumer surfaces an attachment via the
  // entity's OUTBOUND `links.attachment` (and the file's INBOUND).
  // A reversed edge (from=file, to=entity) would NOT satisfy that read.
  // This test asserts the direction is load-bearing: were `attachFile`
  // to flip from/to, `outboundLinks('contact', …)` would be empty and
  // this would fail.
  it('mutation: a reversed edge would not surface on the entity outbound read', async () => {
    const fileId = await ingestFile('drop-7');
    await attachFile({ file_id: fileId, to_collection: 'contact', to_id: 'm@x.com' }, h.deps);

    // What the inline `{{data.contact.<email>.links.attachment}}` surface
    // reads — the entity's OUTBOUND links. Must be non-empty + point at
    // the file. A wrong-direction writer (from=file) would leave this []
    // and instead populate outboundLinks('file', fileId).
    const entityOut = await h.store.outboundLinks('contact', 'm@x.com');
    expect(entityOut.filter((l) => l.role === 'attachment').map((l) => l.to_id))
      .toEqual([fileId]);

    // And the file's OUTBOUND must be empty (the file is the `to`, never
    // the `from`, for an attachment edge).
    const fileOut = await h.store.outboundLinks('file', fileId);
    expect(fileOut.filter((l) => l.role === 'attachment')).toHaveLength(0);

    // attachFile carries `to_id` as an opaque string column value (never
    // through the dot-delimited walkPath), so a dotted email entity id
    // round-trips intact on both index sides.
    expect(fileId).toBe(inboundFileRecordId('reception_drop', 'drop-7'));
  });
});
