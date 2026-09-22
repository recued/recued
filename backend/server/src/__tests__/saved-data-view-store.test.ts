import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  SAVED_DATA_VIEW_LIMIT, parseSavedDataViewDefinition,
  type SavedDataViewDefinition,
} from '@recued/contracts';
import { createSavedDataViewStore } from '../saved-data-view-store.js';

const definitions: SavedDataViewDefinition[] = [
  { tab: 'search', query: 'Acme' },
  { tab: 'contact', query: 'Ada' },
  { tab: 'booking', query: 'paid', source_id: 'recued.booking', booking_lifecycle: 'confirmed' },
  { tab: 'task', query: 'call', source_id: null, booking_lifecycle: 'all' },
  { tab: 'task', query: 'invoice', source_id: 'recued.task', booking_lifecycle: 'all',
    task_filters: { completion: 'open', due: 'overdue', sort: 'due_asc' } },
  { tab: 'mail', collection_slug: 'work-mail' },
  { tab: 'records', owner: { publisher: 'vendor', pack_slug: 'shop' }, entity: 'order' },
  { tab: 'records', owner: { publisher: 'vendor', pack_slug: 'shop' }, entity: 'order',
    filters: { amount: { op: 'gte', value: '10.2500' }, paid: { op: 'eq', value: false }, status: { op: 'in', value: ['open', 'held'] } }, sort: '-amount' },
  { tab: 'memory', origin: 'user_self' },
  { tab: 'annotation' },
  { tab: 'today' },
];
const databases: Database.Database[] = [];
const dirs: string[] = [];
const open = (path = ':memory:') => { const db = new Database(path); databases.push(db); return db; };
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('saved Data view persistence', () => {
  it('updates every supported definition without changing the bookmark, name or creation time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saved-data-view-update-')); dirs.push(dir);
    const path = join(dir, 'realm.db');
    const db = open(path);
    const store = createSavedDataViewStore(db);
    const original = store.create({ name: 'My view', definition: definitions[0]! });
    let revision = original.revision;
    for (const definition of definitions) {
      const updated = store.update({ id: original.id, expected_revision: revision, definition });
      revision += 1;
      expect(updated).toMatchObject({ id: original.id, name: original.name, created_at: original.created_at,
        definition, revision });
      expect(updated.updated_at).toBeGreaterThanOrEqual(original.updated_at);
    }
    db.close();
    const reopened = createSavedDataViewStore(open(path));
    expect(reopened.list()).toEqual([expect.objectContaining({ id: original.id, revision, definition: definitions.at(-1) })]);
  });

  it('shares revision checks across settings, names and deletion on independent database handles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saved-data-view-conflict-')); dirs.push(dir);
    const path = join(dir, 'realm.db');
    const first = createSavedDataViewStore(open(path));
    const second = createSavedDataViewStore(open(path));
    const saved = first.create({ name: 'Original', definition: definitions[0]! });
    const updated = second.update({ id: saved.id, expected_revision: 1, definition: definitions[4]! });
    expect(() => first.update({ id: saved.id, expected_revision: 1, definition: definitions[1]! })).toThrow(/another browser/);
    expect(() => first.rename({ id: saved.id, expected_revision: 1, name: 'Stale' })).toThrow(/another browser/);
    expect(() => first.delete({ id: saved.id, expected_revision: 1 })).toThrow(/another browser/);
    expect(first.get(saved.id)).toEqual(updated);
    const renamed = first.rename({ id: saved.id, expected_revision: 2, name: 'Renamed' });
    expect(() => second.update({ id: saved.id, expected_revision: 2, definition: definitions[0]! })).toThrow(/another browser/);
    expect(second.get(saved.id)).toEqual(renamed);
    second.delete({ id: saved.id, expected_revision: 3 });
    expect(() => first.update({ id: saved.id, expected_revision: 3, definition: definitions[0]! })).toThrow(/deleted/);
    expect(first.list()).toEqual([]);
  });

  it('rejects invalid updates without modifying the saved revision or definition', () => {
    const store = createSavedDataViewStore(open());
    const original = store.create({ name: 'Original', definition: definitions[0]! });
    expect(() => store.update({ id: original.id, expected_revision: 1,
      // @ts-expect-error Runtime callers can send unsupported filters.
      definition: { tab: 'task', query: '', source_id: null, booking_lifecycle: 'all', task_filters: { due: 'unknown' } },
    })).toThrow(/Invalid saved view settings/);
    for (const revision of [0, -1, 1.5, NaN]) {
      expect(() => store.update({ id: original.id, expected_revision: revision, definition: definitions[1]! })).toThrow(/another browser/);
    }
    expect(store.get(original.id)).toEqual(original);
  });

  it('reopens every view from a fresh database handle and keeps its stable link after rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saved-data-views-')); dirs.push(dir);
    const path = join(dir, 'realm.db');
    const first = open(path);
    const store = createSavedDataViewStore(first);
    const saved = definitions.map((definition, index) => store.create({ name: `View ${index}`, definition }));
    first.close();
    const reopened = createSavedDataViewStore(open(path));
    expect(reopened.list()).toHaveLength(definitions.length);
    for (const view of saved) expect(reopened.get(view.id)).toEqual(view);
    const before = saved[0]!;
    const renamed = reopened.rename({ id: before.id, name: ' Customers ', expected_revision: 1 });
    expect(renamed).toMatchObject({ id: before.id, name: 'Customers', revision: 2, definition: before.definition });
    reopened.delete({ id: before.id, expected_revision: 2 });
    expect(reopened.get(before.id)).toBeNull();
    expect(reopened.list()).toHaveLength(saved.length - 1);
  });

  it('does not let a stale browser overwrite or delete a renamed view, or resurrect a deleted one', () => {
    const db = open();
    const first = createSavedDataViewStore(db);
    const second = createSavedDataViewStore(db);
    const saved = first.create({ name: 'Acme', definition: definitions[0]! });
    second.rename({ id: saved.id, name: 'Acme current', expected_revision: 1 });
    expect(() => first.rename({ id: saved.id, name: 'Old tab', expected_revision: 1 })).toThrow(/another browser/);
    expect(() => first.delete({ id: saved.id, expected_revision: 1 })).toThrow(/another browser/);
    second.delete({ id: saved.id, expected_revision: 2 });
    expect(() => first.rename({ id: saved.id, name: 'Resurrect', expected_revision: 2 })).toThrow(/deleted/);
    expect(first.list()).toEqual([]);
  });

  it('bounds storage and rejects invalid names without creating rows', () => {
    const store = createSavedDataViewStore(open());
    for (const name of ['', '  ', 'x'.repeat(101), 'one\ntwo']) {
      expect(() => store.create({ name, definition: definitions[0]! })).toThrow(/name/);
    }
    for (let i = 0; i < SAVED_DATA_VIEW_LIMIT; i++) store.create({ name: 'View', definition: definitions[0]! });
    expect(() => store.create({ name: 'Too many', definition: definitions[0]! })).toThrow(/up to/);
    const existing = store.list()[0]!;
    expect(store.update({ id: existing.id, expected_revision: existing.revision, definition: definitions[1]! }).definition)
      .toEqual(definitions[1]);
    expect(store.list()).toHaveLength(SAVED_DATA_VIEW_LIMIT);
  });

  it.each([
    null, [], { tab: 'search', query: 'x', sql: 'DROP TABLE contacts' },
    { tab: 'search', query: 'x'.repeat(2001) }, { tab: 'unknown' },
    { tab: 'booking', query: '', source_id: null, booking_lifecycle: 'future-state' },
    { tab: 'task', query: '', source_id: 42, booking_lifecycle: 'all' },
    { tab: 'mail', collection_slug: '' }, { tab: 'records', owner: null, entity: 'order' },
    { tab: 'memory', origin: 'somebody' }, { tab: 'shared', rows: [{ secret: true }] },
  ])('rejects unsupported settings instead of dropping their filters: %j', (value) => {
    expect(parseSavedDataViewDefinition(value)).toBeNull();
  });
});

describe('P2/F2 review mark', () => {
  const recordsView: SavedDataViewDefinition = {
    tab: 'records', owner: { publisher: 'vendor', pack_slug: 'shop' }, entity: 'order',
  };
  const cursor = { at: 1_700_000_000_000, event_id: 'evt-1' };
  const setup = () => {
    const store = createSavedDataViewStore(open());
    const view = store.create({ name: 'Orders', definition: recordsView });
    return { store, view };
  };

  it('stores the cursor the reviewer supplied and clears on null', () => {
    const { store, view } = setup();
    const marked = store.update({ id: view.id, expected_revision: view.revision, review: cursor });
    expect(marked.review?.reviewed_through).toEqual(cursor);
    expect(marked.review?.reviewed_at).toBeGreaterThan(0);

    const cleared = store.update({ id: view.id, expected_revision: marked.revision, review: null });
    expect(cleared.review).toBeUndefined();
  });

  it('accepts a review mark as the only change', () => {
    const { store, view } = setup();
    // The guard used to demand definition-or-alert; a mark is neither.
    expect(() => store.update({ id: view.id, expected_revision: view.revision, review: cursor }))
      .not.toThrow();
    expect(() => store.update({ id: view.id, expected_revision: view.revision + 1 }))
      .toThrow(/Provide saved view settings/);
  });

  /** ⛔ REVIEW IS NARROWER THAN ALERTS. A task view supports alerts and has no
   *  pack, so there is no outbox to hold a cursor. Reusing
   *  `savedDataViewSupportsAlerts` here would accept this and store a mark that
   *  addresses nothing. */
  it('refuses a task view, which alerts would have accepted', () => {
    const store = createSavedDataViewStore(open());
    const task = store.create({ name: 'Calls',
      definition: { tab: 'task', query: 'call', source_id: null, booking_lifecycle: 'all' } });
    expect(() => store.update({ id: task.id, expected_revision: task.revision, review: cursor }))
      .toThrow(/Records view with a pack and kind/);
  });

  /** ⛔ THE SCOPE-NOT-EQUALITY TEST. Both halves matter and they pull opposite
   *  ways: comparing whole definitions would discard a good mark on every
   *  filter tweak, and comparing nothing would keep a cursor pointing into
   *  another pack's stream — which does not merely mislead, it makes the feed
   *  skip everything before that position. */
  it('survives a filter edit and is dropped when the pack or entity moves', () => {
    const { store, view } = setup();
    const marked = store.update({ id: view.id, expected_revision: view.revision, review: cursor });

    const filtered = store.update({
      id: view.id, expected_revision: marked.revision,
      definition: { ...recordsView, filters: { status: { op: 'eq', value: 'open' } } },
    });
    expect(filtered.review?.reviewed_through).toEqual(cursor);

    const reentitied = store.update({
      id: view.id, expected_revision: filtered.revision,
      definition: { ...recordsView, entity: 'invoice' },
    });
    expect(reentitied.review).toBeUndefined();
  });

  it('drops the mark when the view stops being a Records view at all', () => {
    const { store, view } = setup();
    const marked = store.update({ id: view.id, expected_revision: view.revision, review: cursor });
    const retabbed = store.update({
      id: view.id, expected_revision: marked.revision,
      definition: { tab: 'memory', origin: 'user_self' },
    });
    expect(retabbed.review).toBeUndefined();
  });

  // ⚠ `null` is deliberately ABSENT — it is the documented CLEAR, covered above.
  // Listing it here with an early `return` would have been a permanently green
  // arm asserting nothing.
  it.each([
    {}, { at: 1 }, { event_id: 'e' }, { at: -1, event_id: 'e' },
    { at: 1.5, event_id: 'e' }, { at: 1, event_id: '' },
    { at: 1, event_id: 'e', extra: true },
  ])('refuses a malformed cursor: %j', (bad) => {
    const { store, view } = setup();
    expect(() => store.update({
      id: view.id, expected_revision: view.revision, review: bad as never,
    })).toThrow(/Invalid review mark/);
  });
});
