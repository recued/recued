import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SAVED_DATA_VIEW_LIMIT, type SavedDataViewCreateOnceRequest } from '@recued/contracts';
import { createSavedDataViewStore } from '../saved-data-view-store.js';

const databases: Database.Database[] = [];
const dirs: string[] = [];
const open = (filename = ':memory:') => { const db = new Database(filename); databases.push(db); return db; };
const request = (): SavedDataViewCreateOnceRequest => ({
  request_id: randomUUID(), name: 'Work contacts', definition: { tab: 'contact', query: 'Acme' },
});
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('saved-view creation receipts', () => {
  it('returns one identity across independent handles and a database reopen, while allowing intentional copies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saved-view-creation-')); dirs.push(dir);
    const filename = join(dir, 'realm.db');
    const db = open(filename), first = createSavedDataViewStore(db);
    const input = request(), saved = first.createOnce!(input);
    const second = createSavedDataViewStore(open(filename));
    expect(second.createOnce!({ ...input, name: ' Work contacts ' })).toEqual(saved);
    db.close();
    const reopened = createSavedDataViewStore(open(filename));
    expect(reopened.createOnce!(input)).toEqual(saved);
    expect(reopened.getCreation!(input)).toEqual(saved);
    expect(reopened.list()).toHaveLength(1);
    const copy = reopened.createOnce!({ ...input, request_id: randomUUID() });
    expect(copy.view_id).not.toBe(saved.view_id);
    expect(reopened.list()).toHaveLength(2);
    // Old callers can still intentionally create a view with identical settings.
    reopened.create(input);
    expect(reopened.list()).toHaveLength(3);
  });

  it('refuses to reuse an identity for different names or filters without altering its view', () => {
    const store = createSavedDataViewStore(open()), input = request();
    const saved = store.createOnce!(input);
    for (const changed of [{ ...input, name: 'Other' }, { ...input, definition: { tab: 'contact' as const, query: 'Other' } }]) {
      expect(() => store.createOnce!(changed)).toThrow(/different view settings/);
      expect(() => store.getCreation!(changed)).toThrow(/different view settings/);
    }
    expect(store.get(saved.view_id)).toEqual(saved.view);
    expect(store.list()).toHaveLength(1);
  });

  it('returns current settings and preserves deletion rather than resurrecting the view', () => {
    const db = open(), store = createSavedDataViewStore(db), input = request();
    const saved = store.createOnce!(input);
    const renamed = store.rename({ id: saved.view_id, expected_revision: 1, name: 'Renamed elsewhere' });
    const changed = store.update({ id: saved.view_id, expected_revision: renamed.revision,
      definition: { tab: 'contact', query: 'New filter' } });
    const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    expect(store.getCreation!(input)?.view).toEqual(changed);
    expect(store.getCreation!({ ...input, request_id: randomUUID() })).toBeNull();
    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(changes);
    expect(store.createOnce!(input).view).toEqual(changed);
    store.delete({ id: changed.id, expected_revision: changed.revision });
    expect(store.createOnce!(input)).toEqual({ request_id: input.request_id, view_id: changed.id, view: null });
    expect(store.getCreation!(input)?.view).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('rolls back the view when its receipt cannot be written, then safely retries', () => {
    const db = open(), store = createSavedDataViewStore(db), input = request();
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON saved_data_view_creations BEGIN SELECT RAISE(ABORT, 'disk write failed'); END");
    expect(() => store.createOnce!(input)).toThrow(/disk write failed/);
    expect(store.list()).toEqual([]);
    expect(store.getCreation!(input)).toBeNull();
    db.exec('DROP TRIGGER fail_receipt');
    const saved = store.createOnce!(input);
    expect(store.createOnce!(input)).toEqual(saved);
    expect(store.list()).toHaveLength(1);
  });

  it('confirms a prior save at the owner limit, without letting a new save bypass that limit', () => {
    const store = createSavedDataViewStore(open()), input = request();
    const saved = store.createOnce!(input);
    for (let i = 1; i < SAVED_DATA_VIEW_LIMIT; i++) store.create({ name: `View ${i}`, definition: { tab: 'today' } });
    expect(store.createOnce!(input)).toEqual(saved);
    expect(() => store.createOnce!({ ...input, request_id: randomUUID() })).toThrow(/up to/);
    expect(store.list()).toHaveLength(SAVED_DATA_VIEW_LIMIT);
  });

  it('rejects malformed requests and creates owner settings without copying alert or pack authority', () => {
    const db = open(), store = createSavedDataViewStore(db), input = request();
    for (const bad of [{ ...input, request_id: 'not-a-uuid' }, { ...input, name: '' },
      { ...input, definition: { tab: 'unknown' } }]) {
      expect(() => store.createOnce!(bad as SavedDataViewCreateOnceRequest)).toThrow();
    }
    expect(store.list()).toEqual([]);
    expect(db.prepare('SELECT * FROM saved_data_view_creations').all()).toEqual([]);
    const saved = store.createOnce!({ ...input, pack: { publisher: 'vendor', slug: 'pack' },
      alert: { enabled: true }, hidden: true, review: { at: 1, event_id: 'x' } } as SavedDataViewCreateOnceRequest);
    expect(saved.view).toMatchObject({ name: input.name, definition: input.definition, revision: 1 });
    expect(saved.view).not.toHaveProperty('pack');
    expect(saved.view).not.toHaveProperty('alert');
    expect(saved.view).not.toHaveProperty('hidden');
    expect(saved.view).not.toHaveProperty('review');
  });
});
