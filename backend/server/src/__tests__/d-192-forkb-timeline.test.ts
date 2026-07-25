/** D-192 Fork B (B2) — the `data.file` timeline drill-down loader.
 *
 *  `buildLoadFileCollectionRecord` is the FIRST implementation of the long-
 *  unwired `LoadCollectionRecord` (`data.timeline`'s raw-record source). It
 *  hydrates ONE unified file view — CAS collection OR remote meta-store — as a
 *  `file`-source `TimelineEntry`, so the webclient Data→Files drill-down (and,
 *  later, MCP `data.timeline`) shows a mirrored remote file's metadata. Scoped
 *  to the `file` collection (mail / calendar stay unwired, unchanged).
 *
 *  Two surfaces: the loader in isolation, and end-to-end through
 *  `handleTimelineRequest` with the doubled `file:file:remote:…` entity_id the
 *  mirror-search picker emits. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleTimelineRequest } from '../mcp/timeline.js';
import type { ReadGrantChecker } from '../read-grant-checker.js';
import type { Collection } from '../collections/types.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { DataFileRecord } from '../collections/file/inbound-file-collection.js';
import {
  buildFileMetaSnapshot,
  createFileMetaStore,
  ensureFileMetaSchema,
  type FileMetaStore,
} from '../storage/file-meta-store.js';
import {
  buildLoadFileCollectionRecord,
  createFileViewResolverFromRegistry,
  remoteFileRecordId,
} from '../file-view-resolver.js';

const NOW = 1_700_000_000_000;
const CAS_ID = 'file:0123456789abcdef0123456789abcdef';

const casRecord = (record_id: string, filename: string): DataFileRecord =>
  ({
    record_id,
    received_at: NOW,
    modified_at: NOW,
    hot_fields: {
      filename,
      mime_type: 'text/plain',
      size: 42,
      content_hash: 'h',
      origin: 'webclient_upload',
      scan_status: 'clean',
      media_class: 'document',
    },
    storage_ref: { kind: 'cas', blob_hash: 'blob-1' },
  }) as unknown as DataFileRecord;

const fakeRegistry = (records: DataFileRecord[]): CollectionRegistry =>
  ({
    list: () =>
      [
        {
          platform: 'file',
          slug: 'received',
          get: (id: string) => records.find((r) => r.record_id === id) ?? null,
          list: () => records,
        } as unknown as Collection,
      ],
  }) as unknown as CollectionRegistry;

describe('buildLoadFileCollectionRecord', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-forkb-tl-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    store.upsert({
      scope: 'dropbox.c.file',
      target_id: 'id:a',
      meta: buildFileMetaSnapshot(
        { filename: 'Deck.pdf', provider: 'dropbox', remote_id: 'id:a', path: '/Work/Deck.pdf', size: 2048, mtime: NOW - 500, revision: 'rev9' },
        NOW,
      ),
      now: NOW,
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const loader = () =>
    buildLoadFileCollectionRecord(createFileViewResolverFromRegistry(fakeRegistry([casRecord(CAS_ID, 'local.txt')]), store));

  it('hydrates a REMOTE file as a `file`-source entry (kind mirrored, storage_ref remote)', async () => {
    const remoteId = remoteFileRecordId('dropbox.c.file', 'id:a');
    const entry = await loader()('file', remoteId);
    expect(entry).toMatchObject({
      ts: NOW - 500, // vendor mtime
      source: 'file',
      kind: 'mirrored',
      payload: {
        record_id: remoteId,
        storage_ref: { kind: 'remote', provider: 'dropbox', remote_id: 'id:a' },
        hot_fields: { filename: 'Deck.pdf', path: '/Work/Deck.pdf', posture: 'remote', revision: 'rev9', provider: 'dropbox' },
        size_bytes: 2048,
      },
    });
  });

  it('hydrates a CAS file as a `file`-source entry (kind received, storage_ref cas)', async () => {
    const entry = await loader()('file', CAS_ID);
    expect(entry).toMatchObject({
      ts: NOW,
      source: 'file',
      kind: 'received',
      payload: {
        record_id: CAS_ID,
        storage_ref: { kind: 'cas', blob_hash: 'blob-1' },
        hot_fields: { filename: 'local.txt', posture: 'cas', content_hash: 'h', scan_status: 'clean' },
        size_bytes: 42,
      },
    });
  });

  it('returns null for a non-file collection (mail/calendar stay unwired) or a gone id', async () => {
    expect(await loader()('mail', CAS_ID)).toBeNull(); // scoped to `file`
    expect(await loader()('file', remoteFileRecordId('dropbox.c.file', 'id:gone'))).toBeNull();
    expect(await loader()('file', 'file:ffffffffffffffffffffffffffffffff')).toBeNull(); // cas miss
  });
});

describe('data.timeline drill-down (end to end) — the doubled file:file:remote id', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-forkb-tl2-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    store.upsert({
      scope: 's3.c.file',
      target_id: 'Reports/2026/q1.pdf',
      meta: buildFileMetaSnapshot(
        { filename: 'q1.pdf', provider: 's3', remote_id: 'Reports/2026/q1.pdf', path: 'Reports/2026/q1.pdf', mtime: NOW },
        NOW,
      ),
      now: NOW,
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('handleTimelineRequest surfaces the remote file record from its picker entity_id', async () => {
    const loadCollectionRecord = buildLoadFileCollectionRecord(
      createFileViewResolverFromRegistry(fakeRegistry([]), store),
    );
    // The mirror-search picker emits `file:${record_id}`; timeline splits on the
    // FIRST colon → collection 'file', id 'file:remote:<enc>:<enc>'.
    const recordId = remoteFileRecordId('s3.c.file', 'Reports/2026/q1.pdf');
    const res = await handleTimelineRequest({ loadCollectionRecord }, { entity_id: `file:${recordId}` });
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({
      source: 'file',
      kind: 'mirrored',
      payload: { record_id: recordId, hot_fields: { filename: 'q1.pdf' } },
    });
  });

  it('the MCP channel (B3) fences the file record behind the `file` collection read-grant', async () => {
    const loadCollectionRecord = buildLoadFileCollectionRecord(
      createFileViewResolverFromRegistry(fakeRegistry([]), store),
    );
    const recordId = remoteFileRecordId('s3.c.file', 'Reports/2026/q1.pdf');
    const checker = (fileGranted: boolean): ReadGrantChecker => ({
      isTopicReadGranted: () => false,
      isCollectionReadGranted: (c) => c === 'file' && fileGranted,
      isVerbOpGranted: () => true,
    });
    // GRANTED (`file` collection + the timeline verb-op) → the record surfaces.
    const granted = await handleTimelineRequest(
      { loadCollectionRecord, gateMcpPrivate: true, readGrantChecker: checker(true) },
      { entity_id: `file:${recordId}` },
    );
    expect(granted.entries).toHaveLength(1);
    // DENIED the `file` collection → the whole feed is empty BEFORE the loader
    // (the D-187 raw-collection fence), so an ungranted AI never sees the file.
    const denied = await handleTimelineRequest(
      { loadCollectionRecord, gateMcpPrivate: true, readGrantChecker: checker(false) },
      { entity_id: `file:${recordId}` },
    );
    expect(denied.entries).toEqual([]);
  });
});
