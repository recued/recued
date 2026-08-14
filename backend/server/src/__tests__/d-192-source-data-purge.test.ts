/** D-192 source-data-removal slice 2 — the per-Source teardown purge.
 *
 *  Covers the new `work-entity-store` purge primitives
 *  (`listRecordIdentitiesForSource` / `deleteRecordsForSource` /
 *  `countRecordsForSource` — all sync_states incl. orphaned; scope isolation;
 *  idempotency) and the `purgeSourceData` orchestrator's family dispatch +
 *  live-derived cascade (annotations / links via the REAL annotation store,
 *  enrichments + edges via spies asserting the exact `(kind, id)` / `source_id`
 *  fan-out) + `previewSourcePurgeCount`.
 *
 *  Real work-entity + annotation stores prove the actual keying (annotations
 *  key `(collection = kind, target_id = row id)`); enrichment/edge are
 *  pre-existing single-method deletes, spied so the args (the correctness
 *  claim) are asserted directly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileMetaProjection, SourceRegistration } from '@recued/contracts';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  buildFileMetaSnapshot,
  createFileMetaStore,
  ensureFileMetaSchema,
  type FileMetaStore,
} from '../storage/file-meta-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import type { BlobStore } from '../storage/blob-store.js';
import {
  PurgeSourceUnsupportedError,
  previewSourcePurgeCount,
  purgeSourceData,
  resolvePurgeSourceFamily,
  type PurgeSourceDataDeps,
} from '../source-mirror/purge.js';

// ── harness ─────────────────────────────────────────────────────

/** A no-op BlobStore — the annotations we seed are small inline values
 *  (< 64 KB), so `blobs.delete` is never reached. */
const noopBlobs: BlobStore = {
  sizeOf: async () => null,
  get: async () => null,
  getStream: async () => null,
  put: async () => '',
  has: async () => false,
  delete: async () => {},
  sweepOrphans: async () => 0,
  totalBytes: async () => 0,
  root: '/tmp/none',
};

const fileProj = (over: Partial<FileMetaProjection> = {}): FileMetaProjection => ({
  filename: 'report.pdf',
  provider: 'dropbox',
  remote_id: 'id:abc',
  ...over,
});

const registerSource = (
  store: WorkEntityStore,
  id: string,
  top_tier_kind: SourceRegistration['top_tier_kind'],
): void => {
  store.registerSource({
    id,
    top_tier_kind,
    source_kind: 'connection',
    source_label: `${top_tier_kind} source ${id}`,
    write_capable: false,
  });
};

const src = (
  id: string,
  top_tier_kind: SourceRegistration['top_tier_kind'],
): Pick<SourceRegistration, 'id' | 'top_tier_kind'> => ({ id, top_tier_kind });

let dir: string;
let db: Database.Database;
let workEntityStore: WorkEntityStore;
let fileMetaStore: FileMetaStore;
let annotationStore: AnnotationStore;

// enrichment + edge spies (backing state so idempotency reads realistically)
let enrichCalls: Array<{ scope: string; target_id: string }>;
let edgeCalls: string[];
let edgeSourcesWithRows: Set<string>;
let deps: PurgeSourceDataDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-purge-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Production parity — the app db runs `foreign_keys = ON`
  // (compose-storage-context), so the purge must satisfy the
  // note_access_ledger → data_note FK. Enforce it here or the FK path
  // silently passes (the bug slice-2 rev-2 fixed).
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  ensureFileMetaSchema(db);
  workEntityStore = createWorkEntityStore(db);
  fileMetaStore = createFileMetaStore(db);
  annotationStore = createAnnotationStore({ db, blobs: noopBlobs });

  enrichCalls = [];
  edgeCalls = [];
  edgeSourcesWithRows = new Set();
  deps = {
    db,
    fileMetaStore,
    workEntityStore,
    annotationStore,
    enrichmentStore: {
      deleteForSource: (scope, target_id) => {
        enrichCalls.push({ scope, target_id });
        return 2; // pretend each record had 2 enrichment rows
      },
    },
    edges: {
      deleteForSource: (source_id) => {
        edgeCalls.push(source_id);
        if (edgeSourcesWithRows.has(source_id)) {
          edgeSourcesWithRows.delete(source_id);
          return 5; // pretend the source had 5 edges (once)
        }
        return 0;
      },
    },
  };
});

afterEach(() => {
  annotationStore.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// seed a task and return its warehouse id
const writeTask = (source_id: string, source_record_id: string): string =>
  workEntityStore.writeTask({ source_id, source_record_id, title: `task ${source_record_id}` }).id;

const writeNote = (source_id: string, source_record_id: string): string =>
  workEntityStore.writeNote({ source_id, source_record_id, body: `note ${source_record_id}` }).id;

// annotate + link a record so the cascade has something to reap
const seedDerived = async (collection: string, id: string): Promise<void> => {
  await annotationStore.annotate({
    target_collection: collection,
    target_id: id,
    key: 'summary',
    value: `about ${id}`,
    authored_by_recipe_id: 'test',
    source_record_hash: 'h',
    recipe_hash: 'r',
  });
  await annotationStore.link({
    from_collection: collection,
    from_id: id,
    to_collection: 'contact',
    to_id: `c-${id}`,
    role: 'mentions',
    authored_by_recipe_id: 'test',
  });
};

// ── resolvePurgeSourceFamily ────────────────────────────────────

describe('resolvePurgeSourceFamily', () => {
  it('maps top_tier_kind to the purge family', () => {
    expect(resolvePurgeSourceFamily({ top_tier_kind: 'file' })).toBe('file');
    for (const k of ['task', 'note', 'commitment', 'project'] as const) {
      expect(resolvePurgeSourceFamily({ top_tier_kind: k })).toBe('work_entity');
    }
    expect(resolvePurgeSourceFamily({ top_tier_kind: 'contact' })).toBe('contact');
    expect(resolvePurgeSourceFamily({ top_tier_kind: 'mail_message' })).toBe('unsupported');
    expect(resolvePurgeSourceFamily({ top_tier_kind: 'calendar.event' })).toBe('unsupported');
  });
});

// ── work-entity-store purge primitives ──────────────────────────

describe('work-entity-store purge primitives', () => {
  let ledgerNoteId: string;
  beforeEach(() => {
    registerSource(workEntityStore, 'hs.a.task', 'task');
    registerSource(workEntityStore, 'hs.b.note', 'note');
    writeTask('hs.a.task', 'r1');
    writeTask('hs.a.task', 'r2');
    writeTask('hs.a.task', 'r3');
    ledgerNoteId = writeNote('hs.b.note', 'n1');
    writeNote('hs.b.note', 'n2');
    // A note with a note_access_ledger child — the FK the bulk delete
    // must satisfy under foreign_keys = ON.
    workEntityStore.recordNoteAccess({
      note_id: ledgerNoteId,
      accessed_at: 1,
      access_kind: 'user_open',
    });
  });

  it('deleteRecordsForSource clears the note_access_ledger FK child (no FK violation under foreign_keys=ON)', () => {
    expect(workEntityStore.listNoteAccess(ledgerNoteId)).toHaveLength(1);
    expect(workEntityStore.deleteRecordsForSource('hs.b.note')).toBe(2);
    expect(workEntityStore.countRecordsForSource('hs.b.note')).toBe(0);
    expect(workEntityStore.listNoteAccess(ledgerNoteId)).toEqual([]);
  });

  it('countRecordsForSource counts a source across all sync_states; unknown source = 0', () => {
    expect(workEntityStore.countRecordsForSource('hs.a.task')).toBe(3);
    expect(workEntityStore.countRecordsForSource('hs.b.note')).toBe(2);
    expect(workEntityStore.countRecordsForSource('nope')).toBe(0);
  });

  it('listRecordIdentitiesForSource returns (kind,id) for a source only (scope-isolated)', () => {
    const a = workEntityStore.listRecordIdentitiesForSource('hs.a.task');
    expect(a).toHaveLength(3);
    expect(a.every((r) => r.kind === 'task')).toBe(true);
    expect(new Set(a.map((r) => r.id)).size).toBe(3);
    expect(workEntityStore.listRecordIdentitiesForSource('hs.b.note').every((r) => r.kind === 'note')).toBe(
      true,
    );
  });

  it('sees ORPHANED rows (a prior unregisterSource orphan-flip does not hide them)', () => {
    workEntityStore.unregisterSource('hs.a.task'); // flips rows to orphaned + drops the registry row
    expect(workEntityStore.countRecordsForSource('hs.a.task')).toBe(3);
    expect(workEntityStore.listRecordIdentitiesForSource('hs.a.task')).toHaveLength(3);
  });

  it('deleteRecordsForSource hard-deletes all of a source (incl. orphaned), is scope-isolated + idempotent', () => {
    workEntityStore.unregisterSource('hs.a.task'); // orphan-flip first — deleteRecordsForSource must still reap
    expect(workEntityStore.deleteRecordsForSource('hs.a.task')).toBe(3);
    expect(workEntityStore.countRecordsForSource('hs.a.task')).toBe(0);
    expect(workEntityStore.listRecordIdentitiesForSource('hs.a.task')).toEqual([]);
    // other source untouched
    expect(workEntityStore.countRecordsForSource('hs.b.note')).toBe(2);
    // idempotent
    expect(workEntityStore.deleteRecordsForSource('hs.a.task')).toBe(0);
  });
});

// ── purgeSourceData — file family ───────────────────────────────

describe('purgeSourceData — file family', () => {
  const seedFile = (scope: string, target_id: string): void => {
    fileMetaStore.upsert({ scope, target_id, meta: buildFileMetaSnapshot(fileProj({ remote_id: target_id }), 100), now: 100 });
  };

  it('deletes only the mirror rows (meta-only — no derived cascade), scope-isolated + idempotent', () => {
    seedFile('dropbox.a.file', 'f1');
    seedFile('dropbox.a.file', 'f2');
    seedFile('dropbox.b.file', 'g1');

    const res = purgeSourceData(src('dropbox.a.file', 'file'), deps);
    expect(res).toMatchObject({
      source_id: 'dropbox.a.file',
      family: 'file',
      records_deleted: 2,
      annotations_deleted: 0,
      links_deleted: 0,
      enrichments_deleted: 0,
      edges_deleted: 0,
    });
    // no cascade fan-out for the meta-only file mirror
    expect(enrichCalls).toEqual([]);
    expect(edgeCalls).toEqual([]);
    // other file source survives
    expect(fileMetaStore.countForScope('dropbox.b.file')).toBe(1);
    // idempotent
    expect(purgeSourceData(src('dropbox.a.file', 'file'), deps).records_deleted).toBe(0);
  });
});

// ── purgeSourceData — work-entity family ────────────────────────

describe('purgeSourceData — work-entity family', () => {
  let taskIds: string[];
  let noteId: string;

  beforeEach(async () => {
    registerSource(workEntityStore, 'hs.a.task', 'task');
    registerSource(workEntityStore, 'hs.b.note', 'note');
    taskIds = [writeTask('hs.a.task', 'r1'), writeTask('hs.a.task', 'r2')];
    noteId = writeNote('hs.b.note', 'n1');
    for (const id of taskIds) await seedDerived('task', id);
    await seedDerived('note', noteId);
    // the note carries an access-ledger child — the orchestrator's bulk
    // delete must clear it before the note row (FK, foreign_keys = ON).
    workEntityStore.recordNoteAccess({ note_id: noteId, accessed_at: 1, access_kind: 'user_open' });
    edgeSourcesWithRows.add('hs.a.task');
  });

  it('cascades annotations/links/enrichments + deletes records + edges; returns aggregated counts', async () => {
    const res = purgeSourceData(src('hs.a.task', 'task'), deps);

    expect(res.family).toBe('work_entity');
    expect(res.records_deleted).toBe(2);
    expect(res.annotations_deleted).toBe(2); // one per task
    expect(res.links_deleted).toBe(2);
    expect(res.enrichments_deleted).toBe(4); // 2 tasks × spy's 2
    expect(res.edges_deleted).toBe(5);

    // enrichment fan-out: one call per record, keyed (scope='task', target_id=row id)
    expect(enrichCalls).toHaveLength(2);
    expect(enrichCalls.every((c) => c.scope === 'task')).toBe(true);
    expect(new Set(enrichCalls.map((c) => c.target_id))).toEqual(new Set(taskIds));
    // edge fan-out: once, by source_id
    expect(edgeCalls).toEqual(['hs.a.task']);

    // the source's records + their annotations/links are gone
    expect(workEntityStore.countRecordsForSource('hs.a.task')).toBe(0);
    for (const id of taskIds) {
      expect(await annotationStore.annotationsForRecord('task', id)).toEqual([]);
      expect(await annotationStore.outboundLinks('task', id)).toEqual([]);
    }

    // scope isolation — the note source's record + derived data survive
    expect(workEntityStore.countRecordsForSource('hs.b.note')).toBe(1);
    expect(await annotationStore.annotationsForRecord('note', noteId)).toHaveLength(1);
    expect(await annotationStore.outboundLinks('note', noteId)).toHaveLength(1);
  });

  it('purges a note source with an access-ledger child under foreign_keys=ON (FK regression)', async () => {
    edgeSourcesWithRows.add('hs.b.note');
    const res = purgeSourceData(src('hs.b.note', 'note'), deps);
    expect(res.family).toBe('work_entity');
    expect(res.records_deleted).toBe(1);
    expect(res.annotations_deleted).toBe(1);
    expect(workEntityStore.countRecordsForSource('hs.b.note')).toBe(0);
    expect(workEntityStore.listNoteAccess(noteId)).toEqual([]);
    // the task source is untouched
    expect(workEntityStore.countRecordsForSource('hs.a.task')).toBe(2);
  });

  it('is idempotent — a re-run over a purged source returns zeroed counts + no cascade calls', async () => {
    purgeSourceData(src('hs.a.task', 'task'), deps);
    enrichCalls = [];
    edgeCalls = [];

    const again = purgeSourceData(src('hs.a.task', 'task'), deps);
    expect(again.records_deleted).toBe(0);
    expect(again.annotations_deleted).toBe(0);
    expect(again.links_deleted).toBe(0);
    expect(again.enrichments_deleted).toBe(0);
    expect(again.edges_deleted).toBe(0);
    expect(enrichCalls).toEqual([]); // no identities left → no enrichment fan-out
    expect(edgeCalls).toEqual(['hs.a.task']); // edges still swept (returns 0 now)
  });
});

// ── unsupported families ────────────────────────────────────────

describe('purgeSourceData — unsupported families throw', () => {
  it('throws PurgeSourceUnsupportedError for contact + mail/calendar sources', () => {
    expect(() => purgeSourceData(src('x.a.contact', 'contact'), deps)).toThrow(PurgeSourceUnsupportedError);
    expect(() => purgeSourceData(src('x.a.mail', 'mail_message'), deps)).toThrow(PurgeSourceUnsupportedError);
    try {
      purgeSourceData(src('x.a.contact', 'contact'), deps);
    } catch (e) {
      expect(e).toBeInstanceOf(PurgeSourceUnsupportedError);
      expect((e as PurgeSourceUnsupportedError).family).toBe('contact');
    }
  });
});

// ── previewSourcePurgeCount ─────────────────────────────────────

describe('previewSourcePurgeCount', () => {
  it('counts per family; contact/unsupported preview 0', () => {
    registerSource(workEntityStore, 'hs.a.task', 'task');
    writeTask('hs.a.task', 'r1');
    writeTask('hs.a.task', 'r2');
    fileMetaStore.upsert({ scope: 'dropbox.a.file', target_id: 'f1', meta: buildFileMetaSnapshot(fileProj(), 100), now: 100 });

    const previewDeps = { fileMetaStore, workEntityStore };
    expect(previewSourcePurgeCount(src('hs.a.task', 'task'), previewDeps)).toBe(2);
    expect(previewSourcePurgeCount(src('dropbox.a.file', 'file'), previewDeps)).toBe(1);
    expect(previewSourcePurgeCount(src('x.a.contact', 'contact'), previewDeps)).toBe(0);
    expect(previewSourcePurgeCount(src('x.a.mail', 'mail_message'), previewDeps)).toBe(0);
  });
});
