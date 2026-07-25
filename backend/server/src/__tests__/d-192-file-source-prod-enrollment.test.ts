/** D-192 file SOURCE family — PROD ENROLLMENT composition parity.
 *
 *  The two halves are each proven in isolation elsewhere:
 *  `d-192-file-source-boot.test.ts` (the `SourceRegistration` visibility rows)
 *  and `d-192-slice4-file-source-sync.test.ts` (the reconcile runner + the wired
 *  task step → `file_meta_ref`). What NO single test proved is the COMPOSED path
 *  `compose-app-context.ts` actually wires in prod: ONE connection enrollment
 *  driving BOTH wires at once — `wireFileSourceSync` (through the REAL
 *  `buildFileSourceAdapterResolver` + real vendor leaf, not an inline
 *  `() => async () => okList([])` stub) and `wireFileSourceBoot` — such that the
 *  same `CONNECTION_SOURCE_ID(vendor, name, 'file')` is AT ONCE a live
 *  housekeeping sync task AND a visible read-only Source, and running that task
 *  writes `file_meta_ref` rows the Source anchors.
 *
 *  This is the regression guard for "does a real file connection actually mirror
 *  in prod?" — the exact question the D-192 lane doc flagged. It fails closed if
 *  the two wires ever drift on the source id, if the boot wire's
 *  `workEntityStore` gate is dropped (Sources go invisible), or if the adapter
 *  resolver stops mapping a declared vendor to its leaf (the sync task vanishes).
 *
 *  It mirrors the compose composition (`compose-app-context.ts` §"file SOURCE
 *  family"): the same four stores, the same `buildFileSourceAdapterResolver`,
 *  the same two wires in the same order. The only seams are the two the adapter
 *  factory exposes for test — the injected `resolveConnection` (canned creds, no
 *  vault) + `fetchImpl` (canned vendor HTTP, no network). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONNECTION_SOURCE_ID } from '@recued/contracts';

import { createConnectionStore, type ConnectionStoreSqlite } from '../storage/connection-store.js';
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
  createFileSourceSyncStateStore,
  ensureFileSourceSyncStateSchema,
  type FileSourceSyncStateStore,
} from '../storage/file-source-sync-state.js';
import { fileSourceSyncTaskId, wireFileSourceSync } from '../file-source-sync.js';
import { wireFileSourceBoot } from '../file-source-boot.js';
import {
  buildFileSourceAdapterResolver,
  type FileConnectionCredential,
  type FileConnectionResolver,
  type FileFetch,
} from '../file-source-adapters/index.js';
import {
  clearDefaultHousekeepingRegistry,
  getHousekeepingTask,
  type HousekeepingAuditRow,
  type HousekeepingContext,
} from '../housekeeping/registry.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let fileMeta: FileMetaStore;
let syncState: FileSourceSyncStateStore;
let workEntityStore: WorkEntityStore;
let connectionStore: ConnectionStoreSqlite;

// ── The two seams the adapter factory exposes for test ──────────────────────

/** Canned bearer creds — stands in for the compose `resolveFileSourceConnection`
 *  (which AEAD-decrypts the vault). Every file leaf reads `{ auth, config }`. */
const bearerCreds: FileConnectionCredential = {
  auth: { type: 'bearer', token: 'dbx-token' },
  config: { vendor: 'dropbox' },
};
const resolveConnection: FileConnectionResolver = async () => bearerCreds;

/** A single-shot `FileFetch` — returns the scripted response for call `i`, then
 *  a hard 500 (so a leaf that pages more than scripted fails, never false-passes). */
const scriptFetch = (
  responses: Array<{ ok?: boolean; status?: number; json?: unknown }>,
): { fetchImpl: FileFetch; callCount: () => number } => {
  let calls = 0;
  const fetchImpl: FileFetch = async () => {
    const r = responses[calls++] ?? { ok: false, status: 500, json: null };
    const ok = r.ok ?? true;
    const body = r.json !== undefined ? JSON.stringify(r.json) : '';
    return {
      ok,
      status: r.status ?? (ok ? 200 : 500),
      headers: new Headers(),
      text: async () => body,
      json: async () => (r.json !== undefined ? r.json : null),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
  return { fetchImpl, callCount: () => calls };
};

/** One Dropbox `list_folder` page (has_more:false ⇒ a clean, complete full walk). */
const dropboxPage = (
  files: ReadonlyArray<{ id: string; name: string }>,
): { json: unknown } => ({
  json: {
    entries: files.map((f) => ({
      '.tag': 'file',
      name: f.name,
      path_display: `/${f.name}`,
      id: f.id,
      size: 1024,
      server_modified: '2026-07-01T00:00:00.000Z',
      rev: 'a1b2',
    })),
    cursor: 'CUR1',
    has_more: false,
  },
});

const enroll = (name: string, vendor: string): void => {
  connectionStore.upsert({
    kind: 'api',
    name,
    display_name: `${vendor} ${name}`,
    config_json: JSON.stringify({ vendor }),
    auth_ciphertext: 'CIPHER',
    enrolled_at: NOW,
    updated_at: NOW,
  });
};

/** The exact compose composition: both wires, same order, sharing the four
 *  stores + one connection store. Returns the fetch call counter so a test can
 *  assert the real leaf did a single-page walk. */
const wireCompose = (
  responses: Array<{ ok?: boolean; status?: number; json?: unknown }> = [],
): { callCount: () => number } => {
  const { fetchImpl, callCount } = scriptFetch(responses);
  wireFileSourceSync({
    connectionStore,
    store: fileMeta,
    syncState,
    resolveAdapter: buildFileSourceAdapterResolver({ resolveConnection, fetchImpl }),
  });
  wireFileSourceBoot({ connectionStore, store: workEntityStore });
  return { callCount };
};

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: (_row: HousekeepingAuditRow) => undefined,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-file-prod-enroll-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureFileMetaSchema(db);
  fileMeta = createFileMetaStore(db);
  ensureFileSourceSyncStateSchema(db);
  syncState = createFileSourceSyncStateStore(db);
  ensureWorkEntitySchema(db);
  workEntityStore = createWorkEntityStore(db);
  connectionStore = createConnectionStore(db);
  clearDefaultHousekeepingRegistry();
});

afterEach(() => {
  clearDefaultHousekeepingRegistry();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-192 file SOURCE — prod enrollment composition parity', () => {
  it('one Dropbox enrollment lights up BOTH the sync task and the visible Source under the same id', () => {
    wireCompose();
    enroll('personal', 'dropbox');

    const sid = CONNECTION_SOURCE_ID('dropbox', 'personal', 'file');
    // The sync half — a live housekeeping task keyed on the shared source id.
    expect(getHousekeepingTask(fileSourceSyncTaskId(sid))?.meta).toMatchObject({
      kind: 'core',
      idle_eligible: true,
    });
    // The visibility half — a read-only meta-mirror Source under the SAME id.
    const reg = workEntityStore.getSource(sid);
    expect(reg).not.toBeNull();
    expect(reg!).toMatchObject({
      top_tier_kind: 'file',
      source_kind: 'connection',
      sync_posture: 'file_meta_ref',
      write_capable: false,
      mcp_exposed: false,
    });
  });

  it('running the enrolled Source task writes file_meta_ref through the REAL Dropbox leaf + records fresh health', async () => {
    const { callCount } = wireCompose([
      dropboxPage([
        { id: 'id:1', name: 'a.pdf' },
        { id: 'id:2', name: 'b.pdf' },
      ]),
    ]);
    enroll('personal', 'dropbox');

    const sid = CONNECTION_SOURCE_ID('dropbox', 'personal', 'file');
    const task = getHousekeepingTask(fileSourceSyncTaskId(sid));
    expect(task).toBeDefined();

    const result = await task!.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result).toMatchObject({ status: 'complete' });

    // file_meta_ref rows written — by the real leaf → real projector → real store.
    expect(fileMeta.list(sid).map((r) => r.target_id).sort()).toEqual(['id:1', 'id:2']);
    expect(fileMeta.list(sid).find((r) => r.target_id === 'id:1')?.meta.path).toBe('/a.pdf');
    // A single-page walk — one list_folder call, no phantom paging.
    expect(callCount()).toBe(1);
    // Freshness lands on the sync-state row (the freshness reader's input).
    expect(syncState.get(sid)).toMatchObject({
      last_success_at: NOW,
      degraded: false,
      last_error_code: null,
    });
    // The Source stays visible through a sync cycle (registration ≠ sync state).
    expect(workEntityStore.getSource(sid)).not.toBeNull();
  });

  it('the REAL adapter resolver also lights up an S3 (object-store fork) enrollment', () => {
    // No fetch/creds needed — registration only asks the resolver for the leaf,
    // proving the compose-wired resolver covers a second, structurally different
    // vendor (basic-auth object store, no native delta) — not just Dropbox.
    wireCompose();
    enroll('bucket', 's3');

    const sid = CONNECTION_SOURCE_ID('s3', 'bucket', 'file');
    expect(getHousekeepingTask(fileSourceSyncTaskId(sid))).toBeDefined();
    expect(workEntityStore.getSource(sid)).not.toBeNull();
  });

  it('deleting the connection retires BOTH the task and the Source (teardown parity)', () => {
    wireCompose();
    enroll('personal', 'dropbox');
    const sid = CONNECTION_SOURCE_ID('dropbox', 'personal', 'file');
    expect(getHousekeepingTask(fileSourceSyncTaskId(sid))).toBeDefined();
    expect(workEntityStore.getSource(sid)).not.toBeNull();

    connectionStore.delete('api', 'personal');

    expect(getHousekeepingTask(fileSourceSyncTaskId(sid))).toBeUndefined();
    expect(workEntityStore.getSource(sid)).toBeNull();
  });

  it('a non-file vendor (hubspot) enrollment lights up NEITHER file surface', () => {
    wireCompose();
    enroll('acme', 'hubspot');

    const sid = CONNECTION_SOURCE_ID('hubspot', 'acme', 'file');
    expect(getHousekeepingTask(fileSourceSyncTaskId(sid))).toBeUndefined();
    expect(workEntityStore.getSource(sid)).toBeNull();
    // And no stray 'file' Source leaked into the shared registry.
    expect(workEntityStore.listSources('file').filter((s) => s.source_kind === 'connection')).toHaveLength(0);
  });
});
