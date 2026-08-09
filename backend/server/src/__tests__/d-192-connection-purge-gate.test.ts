/** D-192 source-data-removal slice 3 — connection-delete purge gate.
 *
 *  Two levels:
 *    - `purgeConnectionData` (the connection-level orchestrator): fans
 *      `purgeSourceData` over every registry Source a connection owns, sums the
 *      counts, skips `contact` (unsupported), is connection-scoped + idempotent.
 *    - `handleConnectionDelete` gate: `remove_mirror_data: true` runs the purge
 *      + writes the `source_data_purged` audit + returns `purged`; unchecked /
 *      absent leaves the mirror data (the existing cascade still runs); the
 *      purge is best-effort (a throw never fails the delete rpc).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SourceRegistration } from '@recued/contracts';
import type { ActivityEntry } from '@recued/storage';

import { handleConnectionDelete } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { wireWorkEntitySourceBoot } from '../work-entity-source-boot.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createFileMetaStore,
  ensureFileMetaSchema,
  type FileMetaStore,
} from '../storage/file-meta-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import type { BlobStore } from '../storage/blob-store.js';
import { purgeConnectionData } from '../source-mirror/connection-purge.js';
import type { PurgeConnectionDataDeps } from '../source-mirror/connection-purge.js';

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

const registerSource = (
  store: WorkEntityStore,
  id: string,
  top_tier_kind: SourceRegistration['top_tier_kind'],
): void => {
  store.registerSource({
    id,
    top_tier_kind,
    source_kind: 'connection',
    source_label: id,
    write_capable: false,
    mcp_exposed: false,
  });
};

// ── purgeConnectionData orchestrator ────────────────────────────

describe('purgeConnectionData — connection-level fan-out', () => {
  let dir: string;
  let db: Database.Database;
  let workEntityStore: WorkEntityStore;
  let fileMetaStore: FileMetaStore;
  let annotationStore: AnnotationStore;
  let enrichCalls: Array<{ scope: string; target_id: string }>;
  let edgeCalls: string[];
  let deps: PurgeConnectionDataDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-conn-purge-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    ensureFileMetaSchema(db);
    workEntityStore = createWorkEntityStore(db);
    fileMetaStore = createFileMetaStore(db);
    annotationStore = createAnnotationStore({ db, blobs: noopBlobs });
    enrichCalls = [];
    edgeCalls = [];
    deps = {
      db,
      fileMetaStore,
      workEntityStore,
      annotationStore,
      enrichmentStore: {
        deleteForSource: (scope, target_id) => {
          enrichCalls.push({ scope, target_id });
          return 0;
        },
        deleteForScopeAndTargetPrefix: () => 0,
      },
      edges: {
        deleteForSource: (source_id) => {
          edgeCalls.push(source_id);
          return 0;
        },
      },
    };

    // connection `acme` owns a task Source + a note Source + a contact Source.
    registerSource(workEntityStore, 'hubspot.acme.task', 'task');
    registerSource(workEntityStore, 'hubspot.acme.note', 'note');
    registerSource(workEntityStore, 'provider.acme.contact', 'contact');
    // a DIFFERENT connection's Source — must survive.
    registerSource(workEntityStore, 'hubspot.other.task', 'task');
    workEntityStore.writeTask({ source_id: 'hubspot.acme.task', source_record_id: 'r1', title: 't1' });
    workEntityStore.writeTask({ source_id: 'hubspot.acme.task', source_record_id: 'r2', title: 't2' });
    workEntityStore.writeNote({ source_id: 'hubspot.acme.note', source_record_id: 'n1', body: 'b1' });
    workEntityStore.writeTask({ source_id: 'hubspot.other.task', source_record_id: 'o1', title: 'other' });
  });

  afterEach(() => {
    annotationStore.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('purges every registry Source of one connection, skips contact, leaves other connections', () => {
    const summary = purgeConnectionData({ connection_name: 'acme' }, deps);

    expect(summary.sources_purged).toBe(2); // task + note
    expect(summary.sources_skipped).toBe(1); // contact (unsupported → retract policy)
    expect(summary.records_deleted).toBe(3); // 2 tasks + 1 note

    // connection-scoped: the OTHER connection's task is untouched
    expect(workEntityStore.countRecordsForSource('hubspot.acme.task')).toBe(0);
    expect(workEntityStore.countRecordsForSource('hubspot.acme.note')).toBe(0);
    expect(workEntityStore.countRecordsForSource('hubspot.other.task')).toBe(1);

    // edge fan-out ran once per purged (non-contact) source
    expect(edgeCalls.sort()).toEqual(['hubspot.acme.note', 'hubspot.acme.task']);
    // enrichment fan-out ran per record (2 tasks + 1 note)
    expect(enrichCalls).toHaveLength(3);
  });

  it('is idempotent — a re-run sums zeros and leaves the skip count', () => {
    purgeConnectionData({ connection_name: 'acme' }, deps);
    const again = purgeConnectionData({ connection_name: 'acme' }, deps);
    expect(again.records_deleted).toBe(0);
    expect(again.sources_purged).toBe(2); // sources still registered (unregister is a separate teardown tier)
    expect(again.sources_skipped).toBe(1);
  });

  it('returns an all-zero summary for a connection with no Sources', () => {
    const summary = purgeConnectionData({ connection_name: 'nonexistent' }, deps);
    expect(summary).toMatchObject({ sources_purged: 0, sources_skipped: 0, records_deleted: 0 });
  });
});

// ── handleConnectionDelete gate ─────────────────────────────────

describe('handleConnectionDelete — remove_mirror_data gate', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createConnectionStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-conn-gate-'));
    db = new Database(join(dir, 'conn.db'));
    store = createConnectionStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const enroll = (kind: 'api', name: string, subtype: string): void => {
    store.upsert({
      kind,
      name,
      subtype,
      display_name: name,
      config_json: '{}',
      auth_ciphertext: 'x',
      enrolled_at: 1,
      updated_at: 1,
    });
  };

  const summary = {
    sources_purged: 2,
    sources_skipped: 1,
    records_deleted: 5,
    annotations_deleted: 3,
    links_deleted: 1,
    enrichments_deleted: 4,
    edges_deleted: 2,
    crm_records_deleted: 0,
    crm_enrichments_deleted: 0,
    contact_links_retracted: 0,
  };

  it('runs the purge + writes the source_data_purged audit + returns purged when opted in', async () => {
    enroll('api', 'my_hubspot', 'hubspot');
    const purgeFn = vi.fn(() => summary);
    const logActivity = vi.fn(async (_entry: ActivityEntry) => {});

    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purgeFn, auditLog: { logActivity, listInboundContractIds: async () => [] }, now: () => 42 },
      { kind: 'api', name: 'my_hubspot', remove_mirror_data: true },
    );

    expect(out).toEqual({ deleted: true, purged: summary });
    expect(purgeFn).toHaveBeenCalledWith({ connection_name: 'my_hubspot', vendor: 'hubspot' });
    expect(logActivity).toHaveBeenCalledTimes(1);
    const entry = logActivity.mock.calls[0]![0];
    expect(entry.action).toBe('source_data_purged');
    expect(entry.target).toBe('my_hubspot');
    expect(entry.timestamp).toBe(42);
    expect(JSON.parse(entry.detail ?? '{}')).toMatchObject({ kind: 'api', vendor: 'hubspot', records_deleted: 5 });
  });

  it('does NOT purge or audit when remove_mirror_data is absent/false', async () => {
    enroll('api', 'my_hubspot', 'hubspot');
    const purgeFn = vi.fn(() => summary);
    const logActivity = vi.fn(async () => {});

    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purgeFn, auditLog: { logActivity, listInboundContractIds: async () => [] } },
      { kind: 'api', name: 'my_hubspot' },
    );

    expect(out).toEqual({ deleted: true });
    expect(purgeFn).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('still fires the enrichment tombstone cascade regardless of the opt-in', async () => {
    enroll('api', 'my_hubspot', 'hubspot');
    const cascade = vi.fn();
    await handleConnectionDelete(
      { store, cascadeForConnectionDelete: cascade },
      { kind: 'api', name: 'my_hubspot', remove_mirror_data: true },
    );
    expect(cascade).toHaveBeenCalledWith('api', 'my_hubspot', 'hubspot');
  });

  it('is best-effort — a purge throw never fails the delete rpc', async () => {
    enroll('api', 'my_hubspot', 'hubspot');
    const purgeFn = vi.fn(() => {
      throw new Error('purge boom');
    });
    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purgeFn },
      { kind: 'api', name: 'my_hubspot', remove_mirror_data: true },
    );
    expect(out).toEqual({ deleted: true }); // no purged, but rpc succeeds
    expect(store.get('api', 'my_hubspot')).toBeNull();
  });

  it('does not purge when no row was deleted (opt-in on a missing connection)', async () => {
    const purgeFn = vi.fn(() => summary);
    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purgeFn },
      { kind: 'api', name: 'never_existed', remove_mirror_data: true },
    );
    expect(out).toEqual({ deleted: false });
    expect(purgeFn).not.toHaveBeenCalled();
  });

  it('does NOT purge for a non-purgeable notification sharing a name with an api one (kind gate)', async () => {
    // The (kind, name) PK lets `notification/shared` coexist with `api/shared`;
    // an `email` notification owns NO purgeable footprint (not an api connection,
    // not a messenger — D-192 slice 4 makes only messenger subtypes purgeable), so
    // its delete must never reach the api connection's mirror data.
    store.upsert({
      kind: 'notification',
      name: 'shared',
      subtype: 'email',
      display_name: 'shared',
      config_json: '{}',
      auth_ciphertext: 'x',
      enrolled_at: 1,
      updated_at: 1,
    });
    const purgeFn = vi.fn(() => summary);
    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purgeFn },
      { kind: 'notification', name: 'shared', remove_mirror_data: true },
    );
    expect(out).toEqual({ deleted: true });
    expect(purgeFn).not.toHaveBeenCalled();
  });
});

// ── real delete-hook flow (integration) ─────────────────────────
// Proves the purge runs BEFORE `store.delete` unregisters the connection's
// Sources (the source-boot delete hooks fire synchronously inside
// `store.delete`), and that a cross-kind same-name delete leaves the api
// connection's data intact. The unit tests above stub the purge, so ONLY these
// exercise the real order-of-operations.

describe('handleConnectionDelete — real source-boot delete flow', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ReturnType<typeof createConnectionStore>;
  let workEntityStore: WorkEntityStore;
  let fileMetaStore: FileMetaStore;
  let annotationStore: AnnotationStore;
  let boundPurge: (input: { connection_name: string }) => ReturnType<typeof purgeConnectionData>;

  const enrollApi = (name: string): void => {
    connectionStore.upsert({
      kind: 'api',
      name,
      subtype: 'hubspot',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: 'x',
      enrolled_at: 1,
      updated_at: 1,
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-conn-real-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    ensureFileMetaSchema(db);
    connectionStore = createConnectionStore(db);
    workEntityStore = createWorkEntityStore(db);
    fileMetaStore = createFileMetaStore(db);
    annotationStore = createAnnotationStore({ db, blobs: noopBlobs });
    // The REAL boot wire — registers the addOnDelete hook that unregisters a
    // deleted connection's Sources (the exact synchronous side effect of
    // `store.delete` that the purge must beat).
    wireWorkEntitySourceBoot({ connectionStore, store: workEntityStore });
    boundPurge = (input) =>
      purgeConnectionData(input, {
        db,
        workEntityStore,
        fileMetaStore,
        annotationStore,
        enrichmentStore: { deleteForSource: () => 0, deleteForScopeAndTargetPrefix: () => 0 },
        edges: { deleteForSource: () => 0 },
      });
  });

  afterEach(() => {
    annotationStore.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('purges the records BEFORE store.delete unregisters the Source (opt-in)', async () => {
    enrollApi('acme');
    // Register the Source + records AFTER the boot wire (registerSource fires
    // no reconcile, so the Source survives until the connection delete).
    registerSource(workEntityStore, 'hubspot.acme.task', 'task');
    workEntityStore.writeTask({ source_id: 'hubspot.acme.task', source_record_id: 'r1', title: 't1' });
    workEntityStore.writeTask({ source_id: 'hubspot.acme.task', source_record_id: 'r2', title: 't2' });
    expect(workEntityStore.countRecordsForSource('hubspot.acme.task')).toBe(2);

    const out = await handleConnectionDelete(
      { store: connectionStore, purgeConnectionData: boundPurge },
      { kind: 'api', name: 'acme', remove_mirror_data: true },
    );

    expect(out.deleted).toBe(true);
    expect(out.purged?.records_deleted).toBe(2);
    // records actually gone (would be 2 orphaned rows if the purge ran too late)
    expect(workEntityStore.countRecordsForSource('hubspot.acme.task')).toBe(0);
    // the delete hook still unregistered the Source
    expect(workEntityStore.getSource('hubspot.acme.task')).toBeNull();
  });

  it('a non-purgeable notification delete leaves the same-named api connection\'s data intact', async () => {
    enrollApi('shared');
    // `email` (non-messenger) → no purgeable footprint, so the notification
    // delete never touches the api connection's registry Sources.
    connectionStore.upsert({
      kind: 'notification',
      name: 'shared',
      subtype: 'email',
      display_name: 'shared',
      config_json: '{}',
      auth_ciphertext: 'x',
      enrolled_at: 1,
      updated_at: 1,
    });
    registerSource(workEntityStore, 'hubspot.shared.task', 'task');
    workEntityStore.writeTask({ source_id: 'hubspot.shared.task', source_record_id: 'r1', title: 't1' });

    const out = await handleConnectionDelete(
      { store: connectionStore, purgeConnectionData: boundPurge },
      { kind: 'notification', name: 'shared', remove_mirror_data: true },
    );

    expect(out).toEqual({ deleted: true });
    // api connection's Source + records untouched
    expect(workEntityStore.getSource('hubspot.shared.task')).not.toBeNull();
    expect(workEntityStore.countRecordsForSource('hubspot.shared.task')).toBe(1);
    // the api connection itself is still enrolled
    expect(connectionStore.get('api', 'shared')).not.toBeNull();
  });
});
