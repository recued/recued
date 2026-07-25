/** D-192 P3a — the work-entity Source mirror substrate.
 *
 *  Coverage: `WorkEntitySourceMirrorStore` (Source-identity upsert
 *  resolves the SAME local row — never a raw local-id duplicate;
 *  hash-map excludes tombstones + foreign sources; tombstone routes
 *  through the store; note = P6 guard) +
 *  `WorkEntitySourceSyncStateStore` (roundtrip, cycle marks, delete). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createWorkEntitySourceMirrorStore,
  createWorkEntitySourceSyncStateStore,
  ensureWorkEntitySourceSyncStateSchema,
  type WorkEntitySourceMirrorStore,
  type WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';

const NOW = 1_700_000_000_000;
const SOURCE = 'hubspot.acme.task';
const OTHER_SOURCE = 'salesforce.acme.task';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let mirror: WorkEntitySourceMirrorStore;
let syncState: WorkEntitySourceSyncStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-p3a-'));
  db = new Database(join(dir, 'test.db'));
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  store = createWorkEntityStore(db);
  for (const id of [SOURCE, OTHER_SOURCE]) {
    store.registerSource({
      id, top_tier_kind: 'task', source_kind: 'connection',
      source_label: id, write_capable: false, mcp_exposed: false, registered_at: NOW,
    });
  }
  store.registerSource({
    id: 'hubspot.acme.project', top_tier_kind: 'project', source_kind: 'connection',
    source_label: 'p', write_capable: false, mcp_exposed: false, registered_at: NOW,
  });
  mirror = createWorkEntitySourceMirrorStore(db, store);
  syncState = createWorkEntitySourceSyncStateStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const taskWrite = (rid: string, title: string, hash?: string) => ({
  kind: 'task' as const,
  write: {
    title,
    source_id: SOURCE,
    source_record_id: rid,
    ...(hash !== undefined ? { source_record_hash: hash } : {}),
    last_seen_at: NOW,
  },
});

describe('WorkEntitySourceMirrorStore', () => {
  it('upsert by Source identity updates the SAME local row — never a duplicate', () => {
    const first = mirror.upsertBySourceIdentity(taskWrite('r1', 'Call Alice', 'fnv1a:aa'), NOW);
    const second = mirror.upsertBySourceIdentity(taskWrite('r1', 'Call Alice again', 'fnv1a:bb'), NOW + 1);
    expect(second.id).toBe(first.id);
    expect(store.countTasks()).toBe(1);
    expect(store.readTask(first.id)?.title).toBe('Call Alice again');
  });

  it('a vendor re-fold PRESERVES local-only task lanes (parent_project_id, assigned_contact_id, body, blocks)', () => {
    // D-192 H1 regression: the projector writes only the canonical vendor fields,
    // so a re-fold onto an existing row must NOT null the local relationship FKs /
    // body a user (or AI, via `work_entity.task.update`) set. Before the fix,
    // `writeTask`'s ON CONFLICT bound every unsupplied lane to `?? null`, so a
    // routine vendor-side title change silently destroyed the task→project link.
    const created = mirror.upsertBySourceIdentity(taskWrite('r1', 'Original', 'fnv1a:aa'), NOW);
    // Local edit — set the local-only lanes while keeping the Source identity +
    // hash (exactly what `task.update` does; it never pushes these to the vendor).
    store.writeTask({
      id: created.id,
      title: 'Original',
      body: 'my private notes',
      parent_project_id: 'proj-x',
      assigned_contact_id: 'contact-y',
      blocks_task_ids: ['dep-1'],
      source_id: SOURCE,
      source_record_id: 'r1',
      source_record_hash: 'fnv1a:aa',
      last_seen_at: NOW,
    }, NOW);
    // Vendor changes the title upstream → new hash → a real fold (not hash-skipped).
    mirror.upsertBySourceIdentity(taskWrite('r1', 'Renamed upstream', 'fnv1a:bb'), NOW + 1);

    const row = store.readTask(created.id);
    expect(row?.title).toBe('Renamed upstream');          // vendor change applied
    expect(row?.body).toBe('my private notes');            // local body preserved
    expect(row?.parent_project_id).toBe('proj-x');         // link preserved
    expect(row?.assigned_contact_id).toBe('contact-y');    // assignment preserved
    expect(row?.blocks_task_ids).toEqual(['dep-1']);       // dependency list preserved
  });

  it('a vendor re-fold PRESERVES local-only project lanes (description, related_contact_ids, last_activity_at)', () => {
    const created = mirror.upsertBySourceIdentity({
      kind: 'project',
      write: { title: 'Q3 rollout', state: 'active', source_id: 'hubspot.acme.project', source_record_id: 'p1', source_record_hash: 'fnv1a:aa', last_seen_at: NOW },
    }, NOW);
    store.writeProject({
      id: created.id,
      title: 'Q3 rollout',
      state: 'active',
      description: 'local brief',
      related_contact_ids: ['contact-z'],
      last_activity_at: 5_000,
      source_id: 'hubspot.acme.project',
      source_record_id: 'p1',
      source_record_hash: 'fnv1a:aa',
      last_seen_at: NOW,
    }, NOW);
    mirror.upsertBySourceIdentity({
      kind: 'project',
      write: { title: 'Q3 rollout (renamed)', state: 'active', source_id: 'hubspot.acme.project', source_record_id: 'p1', source_record_hash: 'fnv1a:bb', last_seen_at: NOW + 1 },
    }, NOW + 1);

    const row = store.readProject(created.id);
    expect(row?.title).toBe('Q3 rollout (renamed)');       // vendor change applied
    expect(row?.description).toBe('local brief');           // local description preserved
    expect(row?.related_contact_ids).toEqual(['contact-z']); // preserved
    expect(row?.last_activity_at).toBe(5_000);             // NOT bumped to the sync clock
  });

  it('getBySourceIdentity roundtrips and misses unknown records', () => {
    const row = mirror.upsertBySourceIdentity(taskWrite('r2', 'Send quote'), NOW);
    expect(mirror.getBySourceIdentity('task', SOURCE, 'r2')?.id).toBe(row.id);
    expect(mirror.getBySourceIdentity('task', SOURCE, 'nope')).toBeNull();
    expect(mirror.getBySourceIdentity('task', OTHER_SOURCE, 'r2')).toBeNull();
  });

  it('listSnapshotHashes scopes to the source, sentinels hash-less rows, excludes tombstones', () => {
    mirror.upsertBySourceIdentity(taskWrite('h1', 'A', 'fnv1a:01'), NOW);
    // No hash → included with the '' sentinel (codex P3b fold): still
    // VISIBLE to the delete diff (a vendor-deleted record must
    // tombstone) while never hash-matching (re-syncs as changed).
    mirror.upsertBySourceIdentity(taskWrite('h2', 'B'), NOW);
    mirror.upsertBySourceIdentity(taskWrite('h3', 'C', 'fnv1a:03'), NOW);
    mirror.upsertBySourceIdentity({
      kind: 'task',
      write: { title: 'D', source_id: OTHER_SOURCE, source_record_id: 'h1', source_record_hash: 'fnv1a:xx', last_seen_at: NOW },
    }, NOW);
    expect(mirror.tombstoneBySourceIdentity('task', SOURCE, 'h3', NOW + 1)).toBe(true);
    const hashes = mirror.listSnapshotHashes('task', SOURCE);
    expect([...hashes.entries()].sort()).toEqual([['h1', 'fnv1a:01'], ['h2', '']]);
  });

  it('tombstoneBySourceIdentity tombstones via the store and misses unknowns', () => {
    const row = mirror.upsertBySourceIdentity(taskWrite('t1', 'Del me'), NOW);
    expect(mirror.tombstoneBySourceIdentity('task', SOURCE, 't1', NOW + 1)).toBe(true);
    expect(store.listTasks().some((t) => t.id === row.id)).toBe(false);
    expect(mirror.tombstoneBySourceIdentity('task', SOURCE, 'ghost')).toBe(false);
  });

  it('project kind roundtrips through writeProject', () => {
    const p = mirror.upsertBySourceIdentity({
      kind: 'project',
      write: { title: 'Q3 rollout', source_id: 'hubspot.acme.project', source_record_id: 'p1', last_seen_at: NOW },
    }, NOW);
    expect(mirror.getBySourceIdentity('project', 'hubspot.acme.project', 'p1')?.id).toBe(p.id);
  });

  it('note kind roundtrips through writeNote with an empty mirror body (P6)', () => {
    store.registerSource({
      id: 'hubspot.acme.note', top_tier_kind: 'note', source_kind: 'connection',
      source_label: 'n', write_capable: false, mcp_exposed: false, registered_at: NOW,
    });
    const n = mirror.upsertBySourceIdentity({
      kind: 'note',
      write: {
        body: '', title: 'Kickoff notes', source_id: 'hubspot.acme.note',
        source_record_id: 'n1', source_record_hash: 'fnv1a:n1', last_seen_at: NOW,
      },
    }, NOW);
    expect(mirror.getBySourceIdentity('note', 'hubspot.acme.note', 'n1')?.id).toBe(n.id);
    expect(store.readNote(n.id)?.body).toBe('');
    expect(mirror.listSnapshotHashes('note', 'hubspot.acme.note').get('n1')).toBe('fnv1a:n1');
    expect(mirror.tombstoneBySourceIdentity('note', 'hubspot.acme.note', 'n1', NOW + 1)).toBe(true);
    expect(store.readNote(n.id)?.sync_state).toBe('tombstoned');
    expect(store.listNotes().some((row) => row.id === n.id)).toBe(false);
  });

  it('note re-upsert preserves last_user_action_at — a sync fold is not a user action', () => {
    store.registerSource({
      id: 'hubspot.acme.note', top_tier_kind: 'note', source_kind: 'connection',
      source_label: 'n', write_capable: false, mcp_exposed: false, registered_at: NOW,
    });
    const noteWrite = (hash: string) => ({
      kind: 'note' as const,
      write: {
        body: '', source_id: 'hubspot.acme.note', source_record_id: 'n2',
        source_record_hash: hash, last_seen_at: NOW,
      },
    });
    const first = mirror.upsertBySourceIdentity(noteWrite('fnv1a:aa'), NOW);
    const refolded = mirror.upsertBySourceIdentity(noteWrite('fnv1a:bb'), NOW + 5_000);
    expect(refolded.id).toBe(first.id);
    expect(store.countNotes()).toBe(1);
    const row = store.readNote(first.id);
    // The re-fold advanced updated_at but NOT last_user_action_at.
    expect(row?.updated_at).toBe(NOW + 5_000);
    expect(row?.last_user_action_at).toBe(NOW);
  });

  it('note re-upsert never clears local-only lanes — body + related_* survive a fold (codex P6 fold)', () => {
    store.registerSource({
      id: 'hubspot.acme.note', top_tier_kind: 'note', source_kind: 'connection',
      source_label: 'n', write_capable: false, mcp_exposed: false, registered_at: NOW,
    });
    // Seed the mirrored row, then a LOCAL edit writes a complete body +
    // a related contact (what noteUpdate does on a mirrored row).
    const seeded = mirror.upsertBySourceIdentity({
      kind: 'note',
      write: {
        body: '', source_id: 'hubspot.acme.note', source_record_id: 'n3',
        source_record_hash: 'fnv1a:aa', last_seen_at: NOW,
      },
    }, NOW);
    store.writeNote({
      id: seeded.id, body: 'my local annotation', source_id: 'hubspot.acme.note',
      source_record_id: 'n3', source_record_hash: 'fnv1a:aa',
      related_contact_ids: ['c-1'], last_seen_at: NOW,
    }, NOW + 1);
    // A vendor-side change re-folds the row (projector body sentinel '').
    mirror.upsertBySourceIdentity({
      kind: 'note',
      write: {
        body: '', title: 'Vendor retitled', source_id: 'hubspot.acme.note',
        source_record_id: 'n3', source_record_hash: 'fnv1a:bb', last_seen_at: NOW + 2,
      },
    }, NOW + 2);
    const row = store.readNote(seeded.id);
    expect(row?.title).toBe('Vendor retitled');
    // The fold must NOT have cleared what sync never populates.
    expect(row?.body).toBe('my local annotation');
    expect(row?.body).not.toBe('');
    expect(row?.related_contact_ids).toEqual(['c-1']);
  });
});

describe('WorkEntitySourceSyncStateStore', () => {
  const seed = () => syncState.upsert({
    source_id: SOURCE, contract_hash: 'fnv1a:cc', sync_depth: 'meta', sync_mode: 'read_write',
    cursor_blob: null, last_sync_started_at: null, last_sync_completed_at: null,
    last_success_at: null, last_error_code: null, last_error_message: null,
    degraded: false, field_health_blob: null, list_complete: true,
    stale_after_ms: 3_600_000,
  });

  it('upsert + get roundtrip', () => {
    seed();
    const s = syncState.get(SOURCE);
    expect(s?.contract_hash).toBe('fnv1a:cc');
    expect(s?.degraded).toBe(false);
    expect(s?.cursor_blob).toBeNull();
    expect(syncState.get('missing')).toBeNull();
  });

  it('markStarted + markCompleted(ok) set the cycle fields and clear errors', () => {
    seed();
    syncState.markStarted(SOURCE, NOW);
    syncState.markCompleted(SOURCE, { ok: false, error_code: 'poll_failed', error_message: 'boom', now: NOW + 1 });
    let s = syncState.get(SOURCE)!;
    expect(s.last_error_code).toBe('poll_failed');
    expect(s.degraded).toBe(true);
    syncState.markCompleted(SOURCE, { ok: true, cursor_blob: '2026-07-01T00:00:00Z', now: NOW + 2 });
    s = syncState.get(SOURCE)!;
    expect(s.last_success_at).toBe(NOW + 2);
    expect(s.cursor_blob).toBe('2026-07-01T00:00:00Z');
    expect(s.last_error_code).toBeNull();
    expect(s.degraded).toBe(false);
    expect(s.last_sync_started_at).toBe(NOW);
    // CORE #8f — an omitted `complete` keeps the completed cycle complete.
    expect(s.list_complete).toBe(true);
  });

  it('markCompleted(ok) persists list_complete completeness distinctly from degraded (CORE #8f)', () => {
    seed();
    // A clean-but-PARTIAL cycle — no failed rows (degraded stays false) yet the
    // list walk was incomplete.
    syncState.markCompleted(SOURCE, { ok: true, cursor_blob: null, complete: false, now: NOW + 1 });
    let s = syncState.get(SOURCE)!;
    expect(s.degraded).toBe(false);
    expect(s.list_complete).toBe(false);
    // A subsequent COMPLETE cycle clears the partial flag.
    syncState.markCompleted(SOURCE, { ok: true, cursor_blob: null, complete: true, now: NOW + 2 });
    s = syncState.get(SOURCE)!;
    expect(s.degraded).toBe(false);
    expect(s.list_complete).toBe(true);
  });

  it('markCompleted(error) honors the degraded:false override; deleteForSource drops the row', () => {
    seed();
    syncState.markCompleted(SOURCE, {
      ok: false, error_code: 'transient', error_message: 'retry', degraded: false, now: NOW + 1,
    });
    expect(syncState.get(SOURCE)!.degraded).toBe(false);
    expect(syncState.deleteForSource(SOURCE)).toBe(true);
    expect(syncState.deleteForSource(SOURCE)).toBe(false);
    expect(syncState.get(SOURCE)).toBeNull();
  });
});
