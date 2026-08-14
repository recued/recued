/** D-192 source-data-removal slice 3c — the "[N] records" removal-preview.
 *
 *  Two levels:
 *    - `previewConnectionPurgeCount` (the connection-level COUNT orchestrator):
 *      the read-only twin of `purgeConnectionData`. Sums the per-Source primary
 *      count over every registry Source the connection owns PLUS its D-190 CRM
 *      mirror rows (per-connection `target_id` prefix). The load-bearing
 *      invariant: the count MUST equal exactly the primary records the delete
 *      purge removes (`records_deleted + crm_records_deleted`) — a wrong count
 *      mislabels the confirm dialog.
 *    - `handleConnectionPreviewPurge` gate: resolves the vendor, kind-gates to
 *      `api` (only api connections own purgeable mirror data), and degrades to
 *      `{ count: 0 }` for a non-api / missing / unwired connection so the dialog
 *      open never throws.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composeConnectionTargetIdPrefix,
  composePlatformRecordTargetId,
  type EnrichmentMeta,
  type SourceRegistration,
} from '@recued/contracts';

import { handleConnectionPreviewPurge } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import {
  previewConnectionPurgeCount,
  purgeConnectionData,
  type PurgeConnectionDataDeps,
} from '../source-mirror/connection-purge.js';
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
import { createAnnotationStore, type AnnotationStore } from '../storage/annotation-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';
import type { BlobStore } from '../storage/blob-store.js';

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

const DEAL_SCOPE = 'connection.api.hubspot.deal' as const;
const now = 1_700_000_000_000;

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
  });
};

// ── previewConnectionPurgeCount — orchestrator (real stores) ─────

describe('previewConnectionPurgeCount — connection-level COUNT fan-out', () => {
  let dir: string;
  let db: Database.Database;
  let workEntityStore: WorkEntityStore;
  let fileMetaStore: FileMetaStore;
  let annotationStore: AnnotationStore;
  let mirror: CrmRecordMirrorStore;

  const seedMirror = (conn: string, native: string): void => {
    const meta: EnrichmentMeta = { snapshot_at: now, snapshot_hash: `h:${conn}${native}`, name: conn };
    mirror.upsert({
      scope: DEAL_SCOPE,
      target_id: composePlatformRecordTargetId('hubspot', 'deal', conn, native),
      meta,
      now,
    });
  };

  // The COUNT-only preview deps (the smaller quorum the rpc wires: no db /
  // annotation / enrichment / edge stores — it never deletes).
  const previewDeps = () => ({
    workEntityStore,
    fileMetaStore,
    crmRecordMirror: mirror,
  });

  // The full delete deps — used ONLY to prove count/delete parity. Enrichment +
  // edges are stubbed to 0 (they are not primary records; the preview counts
  // neither, and neither feeds `records_deleted` / `crm_records_deleted`).
  const purgeDeps = (): PurgeConnectionDataDeps => ({
    db,
    workEntityStore,
    fileMetaStore,
    annotationStore,
    enrichmentStore: { deleteForSource: () => 0, deleteForScopeAndTargetPrefix: () => 0 },
    edges: { deleteForSource: () => 0 },
    crmRecordMirror: mirror,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-conn-preview-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    ensureFileMetaSchema(db);
    ensureCrmRecordMirrorSchema(db);
    workEntityStore = createWorkEntityStore(db);
    fileMetaStore = createFileMetaStore(db);
    annotationStore = createAnnotationStore({ db, blobs: noopBlobs });
    mirror = createCrmRecordMirrorStore(db);

    // connection `acme`: a file Source (2 rows) + task Source (2) + note Source
    // (1) + a contact Source (skipped). A DIFFERENT connection `other` (1 task)
    // must not be counted.
    registerSource(workEntityStore, 'hubspot.acme.file', 'file');
    registerSource(workEntityStore, 'hubspot.acme.task', 'task');
    registerSource(workEntityStore, 'hubspot.acme.note', 'note');
    registerSource(workEntityStore, 'provider.acme.contact', 'contact');
    registerSource(workEntityStore, 'hubspot.other.task', 'task');

    for (const remote_id of ['f1', 'f2']) {
      fileMetaStore.upsert({
        scope: 'hubspot.acme.file',
        target_id: remote_id,
        meta: buildFileMetaSnapshot({ filename: `${remote_id}.txt`, provider: 's3', remote_id }, now),
        now,
      });
    }
    workEntityStore.writeTask({ source_id: 'hubspot.acme.task', source_record_id: 'r1', title: 't1' });
    workEntityStore.writeTask({ source_id: 'hubspot.acme.task', source_record_id: 'r2', title: 't2' });
    workEntityStore.writeNote({ source_id: 'hubspot.acme.note', source_record_id: 'n1', body: 'b1' });
    workEntityStore.writeTask({ source_id: 'hubspot.other.task', source_record_id: 'o1', title: 'other' });

    seedMirror('acme', '1');
    seedMirror('acme', '2');
    seedMirror('acme2', '9'); // sibling same-vendor connection — must not be counted
  });

  afterEach(() => {
    annotationStore.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts every Source of one connection (file + work-entity), skips contact, ignores other connections', () => {
    // acme: 2 file + 2 task + 1 note = 5 primary Source records; contact = 0.
    // Plus 2 CRM deal rows (acme, not acme2). Total = 7.
    const count = previewConnectionPurgeCount({ connection_name: 'acme', vendor: 'hubspot' }, previewDeps());
    expect(count).toBe(7);
  });

  it('PARITY — the preview count equals exactly the primary records the purge removes', () => {
    // Snapshot the preview BEFORE the (mutating) purge, then run the real purge
    // and assert the count matched what it actually deleted. This is the whole
    // point of the slice: the "[N] records" label must not lie.
    const previewed = previewConnectionPurgeCount({ connection_name: 'acme', vendor: 'hubspot' }, previewDeps());
    const purged = purgeConnectionData({ connection_name: 'acme', vendor: 'hubspot' }, purgeDeps());
    expect(previewed).toBe(purged.records_deleted + purged.crm_records_deleted);
    // …and once purged, the preview reads 0 (nothing left to remove).
    expect(previewConnectionPurgeCount({ connection_name: 'acme', vendor: 'hubspot' }, previewDeps())).toBe(0);
  });

  it('CRM leg is per-connection — acme != acme2', () => {
    // Drop the work-entity + file Sources' contribution by pointing at a
    // connection that owns none; only the CRM leg (vendor hubspot) runs.
    // acme owns 2 deal rows; acme2 (sibling) owns 1 and must not leak in.
    expect(
      previewConnectionPurgeCount({ connection_name: 'acme2', vendor: 'hubspot' }, previewDeps()),
    ).toBe(1);
  });

  it('skips the CRM leg for a connection with no vendor (Sources only)', () => {
    // No vendor → no CRM count; only the 5 primary Source records of acme.
    expect(previewConnectionPurgeCount({ connection_name: 'acme' }, previewDeps())).toBe(5);
  });

  it('fans across every CRM entity of the vendor (deal + contact + company), still per-connection', () => {
    const CONTACT_SCOPE = 'connection.api.hubspot.contact' as const;
    const COMPANY_SCOPE = 'connection.api.hubspot.company' as const;
    for (const [scope, entity] of [
      [CONTACT_SCOPE, 'contact'],
      [COMPANY_SCOPE, 'company'],
    ] as const) {
      mirror.upsert({
        scope,
        target_id: composePlatformRecordTargetId('hubspot', entity, 'acme', 'x'),
        meta: { snapshot_at: now, snapshot_hash: `h:${entity}` },
        now,
      });
    }
    // a sibling contact for acme2 that must NOT be counted
    mirror.upsert({
      scope: CONTACT_SCOPE,
      target_id: composePlatformRecordTargetId('hubspot', 'contact', 'acme2', 'y'),
      meta: { snapshot_at: now, snapshot_hash: 'h:sibling' },
      now,
    });
    // acme: 5 Source records + 2 deal + 1 contact + 1 company = 9.
    expect(
      previewConnectionPurgeCount({ connection_name: 'acme', vendor: 'hubspot' }, previewDeps()),
    ).toBe(9);
  });

  it('returns 0 for a connection that owns nothing', () => {
    expect(
      previewConnectionPurgeCount({ connection_name: 'nonexistent', vendor: 'hubspot' }, previewDeps()),
    ).toBe(0);
  });
});

// ── handleConnectionPreviewPurge — gate ─────────────────────────

describe('handleConnectionPreviewPurge — kind gate + degrade-to-zero', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createConnectionStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-preview-gate-'));
    db = new Database(join(dir, 'conn.db'));
    store = createConnectionStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const enroll = (kind: 'api' | 'notification', name: string, subtype: string): void => {
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

  it('returns the closure count for an api connection, resolving the vendor', async () => {
    enroll('api', 'my_hubspot', 'hubspot');
    const previewFn = vi.fn(() => 42);
    const out = await handleConnectionPreviewPurge(
      { store, previewConnectionPurgeCount: previewFn },
      { kind: 'api', name: 'my_hubspot' },
    );
    expect(out).toEqual({ count: 42 });
    expect(previewFn).toHaveBeenCalledWith({ connection_name: 'my_hubspot', vendor: 'hubspot' });
  });

  it('a non-purgeable notification sharing a name with an api one never touches the closure', async () => {
    // The (kind, name) PK lets notification/shared coexist with api/shared; an
    // `email` notification owns no purgeable footprint (not api, not messenger —
    // D-192 slice 4 makes only messenger subtypes purgeable), so it previews 0
    // without ever calling the closure.
    enroll('api', 'shared', 'hubspot');
    enroll('notification', 'shared', 'email');
    const previewFn = vi.fn(() => 99);
    const out = await handleConnectionPreviewPurge(
      { store, previewConnectionPurgeCount: previewFn },
      { kind: 'notification', name: 'shared' },
    );
    expect(out).toEqual({ count: 0 });
    expect(previewFn).not.toHaveBeenCalled();
  });

  it('returns 0 when the preview closure is unwired (dbless / partial harness)', async () => {
    enroll('api', 'my_hubspot', 'hubspot');
    const out = await handleConnectionPreviewPurge({ store }, { kind: 'api', name: 'my_hubspot' });
    expect(out).toEqual({ count: 0 });
  });

  it('returns 0 for a missing connection without calling the closure', async () => {
    const previewFn = vi.fn(() => 5);
    const out = await handleConnectionPreviewPurge(
      { store, previewConnectionPurgeCount: previewFn },
      { kind: 'api', name: 'never_existed' },
    );
    expect(out).toEqual({ count: 0 });
    expect(previewFn).not.toHaveBeenCalled();
  });
});
