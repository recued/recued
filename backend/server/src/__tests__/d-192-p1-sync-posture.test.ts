/** D-192 P-1 — Source sync-posture seam (the file SOURCE family prerequisite).
 *
 *  `sync_posture` is a first-class, persisted field on `source_registry`,
 *  mirroring the `enabled` optional / store-default / preserve-on-reregister
 *  idiom. Covered here:
 *    - contract: SOURCE_SYNC_POSTURES + isSourceSyncPosture (closed set)
 *    - schema: the column lands at boot; ensureWorkEntitySchema is idempotent
 *    - default `records` when a caller omits it (pre-P-1 callers keep working)
 *    - an explicit posture round-trips register → get → list
 *    - UPSERT preserves the creation posture (structural, never toggled)
 *    - a legacy / invalid persisted cell coerces to `records`
 *
 *  NOTE: posture is orthogonal to `top_tier_kind` — `file` is not yet a
 *  SOURCE_TOP_TIER_KIND (that lands in the next slice), so these tests carry
 *  the `file_meta_ref` posture on an existing kind to exercise the field.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SOURCE_SYNC_POSTURES,
  SOURCE_SYNC_POSTURE_SET,
  isSourceSyncPosture,
} from '@recued/contracts';

import {
  SOURCE_REGISTRY_TABLE,
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;

const NOW = 1_700_000_000_000;

const baseReg = (id: string) => ({
  id,
  top_tier_kind: 'note' as const,
  source_kind: 'connection' as const,
  source_label: 'Dropbox',
  write_capable: false,
  mcp_exposed: false,
  registered_at: NOW,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-p1-posture-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-192 P-1 contract — SOURCE_SYNC_POSTURES', () => {
  it('enumerates records | file_meta_ref | contact_import', () => {
    expect([...SOURCE_SYNC_POSTURES]).toEqual(['records', 'file_meta_ref', 'contact_import']);
  });

  it('isSourceSyncPosture guards the closed set', () => {
    expect(isSourceSyncPosture('records')).toBe(true);
    expect(isSourceSyncPosture('file_meta_ref')).toBe(true);
    expect(isSourceSyncPosture('contact_import')).toBe(true);
    expect(isSourceSyncPosture('bogus')).toBe(false);
    expect(isSourceSyncPosture('')).toBe(false);
    expect(isSourceSyncPosture(undefined)).toBe(false);
    expect(isSourceSyncPosture(null)).toBe(false);
    expect(isSourceSyncPosture(3)).toBe(false);
    expect(SOURCE_SYNC_POSTURE_SET.has('file_meta_ref')).toBe(true);
  });
});

describe('D-192 P-1 schema', () => {
  it('sync_posture column lands at boot', () => {
    const cols = db
      .prepare(`PRAGMA table_info(${SOURCE_REGISTRY_TABLE})`)
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'sync_posture')).toBe(true);
  });

  it('ensureWorkEntitySchema is idempotent (re-run swallows the duplicate column)', () => {
    expect(() => ensureWorkEntitySchema(db)).not.toThrow();
    expect(() => ensureWorkEntitySchema(db)).not.toThrow();
  });
});

describe('D-192 P-1 store — sync_posture persistence', () => {
  it('defaults to records when a caller omits it (pre-P-1 callers keep working)', () => {
    const out = store.registerSource(baseReg('recued.note'));
    expect(out.sync_posture).toBe('records');
    expect(store.getSource('recued.note')?.sync_posture).toBe('records');
    expect(store.listSources('note')[0]?.sync_posture).toBe('records');
  });

  it('round-trips an explicit file_meta_ref posture through register → get → list', () => {
    const out = store.registerSource({ ...baseReg('dropbox.conn1'), sync_posture: 'file_meta_ref' });
    expect(out.sync_posture).toBe('file_meta_ref');
    expect(store.getSource('dropbox.conn1')?.sync_posture).toBe('file_meta_ref');
    expect(store.listSources('note').find((s) => s.id === 'dropbox.conn1')?.sync_posture)
      .toBe('file_meta_ref');
  });

  it('preserves the creation posture across a boot-wire re-register (structural, like enabled)', () => {
    store.registerSource({ ...baseReg('s1'), sync_posture: 'file_meta_ref' });
    // Re-register the SAME id WITHOUT posture — a boot-wire re-register that
    // would default to `records`. The persisted file_meta_ref must survive
    // (ON CONFLICT omits sync_posture), exactly like the `enabled` toggle.
    const out = store.registerSource({ ...baseReg('s1'), source_label: 'Dropbox (relabel)', registered_at: NOW + 1000 });
    expect(out.sync_posture).toBe('file_meta_ref');
    expect(store.getSource('s1')?.sync_posture).toBe('file_meta_ref');
  });

  it('coerces a legacy / invalid persisted posture cell to records', () => {
    store.registerSource(baseReg('s2'));
    db.prepare(`UPDATE ${SOURCE_REGISTRY_TABLE} SET sync_posture = 'bogus' WHERE id = ?`).run('s2');
    expect(store.getSource('s2')?.sync_posture).toBe('records');
    expect(store.listSources('note').find((s) => s.id === 's2')?.sync_posture).toBe('records');
  });
});
