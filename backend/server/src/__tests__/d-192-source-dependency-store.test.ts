/** D-192 Slice 2 — `source_dependency_entity` store: cache refresh (upsert +
 *  preserve selection + prune vendor-deleted), selection (exactly one), and
 *  per-Source teardown. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSourceDependencyEntityStore,
  ensureSourceDependencyEntitySchema,
  type SourceDependencyEntityStore,
} from '../storage/source-dependency-entity-store.js';

const SRC = 'asana.acme.task';
const REF = 'workspace';
const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: SourceDependencyEntityStore;

beforeEach(() => {
  db = new Database(':memory:');
  ensureSourceDependencyEntitySchema(db);
  store = createSourceDependencyEntityStore(db);
});
afterEach(() => db.close());

describe('D-192 source_dependency_entity store', () => {
  it('caches a fetched entity set and lists it', () => {
    store.replaceEntities(SRC, REF, [
      { entity_pk: 'w1', label: 'Acme' },
      { entity_pk: 'w2', label: 'Beta' },
    ], { pack_slug: 'asana', now: NOW });
    const rows = store.list(SRC, REF);
    expect(rows.map((r) => r.entity_pk).sort()).toEqual(['w1', 'w2']);
    expect(rows.every((r) => !r.selected)).toBe(true);
    expect(rows[0].pack_slug).toBe('asana');
  });

  it('selects exactly one and lists it first; getSelected returns it', () => {
    store.replaceEntities(SRC, REF, [
      { entity_pk: 'w1', label: 'Acme' }, { entity_pk: 'w2', label: 'Beta' },
    ], { now: NOW });
    expect(store.select(SRC, REF, 'w2')).toBe(true);
    expect(store.getSelected(SRC, REF)?.entity_pk).toBe('w2');
    expect(store.list(SRC, REF)[0].entity_pk).toBe('w2'); // selected first
    // re-select clears the prior
    expect(store.select(SRC, REF, 'w1')).toBe(true);
    expect(store.getSelected(SRC, REF)?.entity_pk).toBe('w1');
    expect(store.list(SRC, REF).filter((r) => r.selected)).toHaveLength(1);
  });

  it('selecting an uncached pk is a no-op returning false', () => {
    store.replaceEntities(SRC, REF, [{ entity_pk: 'w1', label: 'Acme' }], { now: NOW });
    expect(store.select(SRC, REF, 'nope')).toBe(false);
    expect(store.getSelected(SRC, REF)).toBeNull();
  });

  it('refresh PRESERVES a selection whose entity survives + updates its label', () => {
    store.replaceEntities(SRC, REF, [{ entity_pk: 'w1', label: 'Acme' }, { entity_pk: 'w2', label: 'Beta' }], { now: NOW });
    store.select(SRC, REF, 'w1');
    // re-fetch: w1 still there (renamed), w2 gone, w3 new
    store.replaceEntities(SRC, REF, [{ entity_pk: 'w1', label: 'Acme Corp' }, { entity_pk: 'w3', label: 'Gamma' }], { now: NOW + 1 });
    expect(store.getSelected(SRC, REF)?.entity_pk).toBe('w1');
    expect(store.getSelected(SRC, REF)?.label).toBe('Acme Corp');
    expect(store.list(SRC, REF).map((r) => r.entity_pk).sort()).toEqual(['w1', 'w3']); // w2 pruned
  });

  it('refresh DROPS a selection whose entity vanished vendor-side', () => {
    store.replaceEntities(SRC, REF, [{ entity_pk: 'w1', label: 'Acme' }], { now: NOW });
    store.select(SRC, REF, 'w1');
    store.replaceEntities(SRC, REF, [{ entity_pk: 'w9', label: 'New' }], { now: NOW + 1 });
    expect(store.getSelected(SRC, REF)).toBeNull(); // w1 pruned → selection gone
  });

  it('an empty fetched set prunes the whole cache for the pair', () => {
    store.replaceEntities(SRC, REF, [{ entity_pk: 'w1', label: 'Acme' }], { now: NOW });
    store.replaceEntities(SRC, REF, [], { now: NOW + 1 });
    expect(store.list(SRC, REF)).toEqual([]);
  });

  it('scopes rows per (source_id, dependency_ref)', () => {
    store.replaceEntities(SRC, 'workspace', [{ entity_pk: 'w1', label: 'W' }], { now: NOW });
    store.replaceEntities(SRC, 'team', [{ entity_pk: 't1', label: 'T' }], { now: NOW });
    store.replaceEntities('other.acme.task', 'workspace', [{ entity_pk: 'x1', label: 'X' }], { now: NOW });
    expect(store.list(SRC, 'workspace')).toHaveLength(1);
    expect(store.list(SRC, 'team')).toHaveLength(1);
    expect(store.list('other.acme.task', 'workspace')).toHaveLength(1);
  });

  it('deleteForSource tears down every dependency ref for the Source', () => {
    store.replaceEntities(SRC, 'workspace', [{ entity_pk: 'w1', label: 'W' }, { entity_pk: 'w2', label: 'W2' }], { now: NOW });
    store.replaceEntities(SRC, 'team', [{ entity_pk: 't1', label: 'T' }], { now: NOW });
    store.replaceEntities('keep.acme.task', 'workspace', [{ entity_pk: 'k1', label: 'K' }], { now: NOW });
    expect(store.deleteForSource(SRC)).toBe(3);
    expect(store.list(SRC, 'workspace')).toEqual([]);
    expect(store.list(SRC, 'team')).toEqual([]);
    expect(store.list('keep.acme.task', 'workspace')).toHaveLength(1); // untouched
  });
});
