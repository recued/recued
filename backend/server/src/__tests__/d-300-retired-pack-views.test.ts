/** D-300 — a pack update that stops shipping a view the owner set up keeps it, retired,
 *  for the owner to resolve.
 *
 *  A pack view's identity is publisher + slug + name (D-289), so a rename is a new view.
 *  The sync deleted the old one and, with it, the owner's alert, hide and review mark —
 *  nothing could tell which new view replaced which (the D-293 no-rename ruling). These
 *  tests drive the real store: sync, set up, rename by update, resolve. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SAVED_DATA_VIEW_LIMIT, type SavedDataViewDefinition } from '@recued/contracts';

import { packSavedViewId } from '../pack-saved-views.js';
import { makeSavedDataViewHandlers } from '../saved-data-view-handler.js';
import { createSavedDataViewStore } from '../saved-data-view-store.js';

const pack = { publisher: 'vendor', slug: 'invoices' } as const;
const records = (entity = 'invoice'): SavedDataViewDefinition =>
  ({ tab: 'records', owner: { publisher: 'vendor', pack_slug: 'invoices' }, entity });
const decl = (name: string, definition = records()) => ({ id: packSavedViewId(pack, name), name, definition });
const ALERT = { enabled: true, time_zone: 'UTC' } as const;
const CURSOR = { at: 100, event_id: 'evt-1' };

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const open = () => {
  const db = new Database(':memory:');
  dbs.push(db);
  return createSavedDataViewStore(db, { readRecords: () => [{ id: 'r1' }] });
};

/** A pack view the owner put an alert on (and optionally hid / reviewed), then an update
 *  that renames it. */
const renamed = (setUp: { hidden?: boolean; review?: boolean } = {}) => {
  const store = open();
  store.syncPackViews(pack, [decl('Overdue')]);
  let old = store.get(decl('Overdue').id)!;
  old = store.update({ id: old.id, expected_revision: old.revision, alert: ALERT });
  if (setUp.review) old = store.update({ id: old.id, expected_revision: old.revision, review: CURSOR });
  if (setUp.hidden) old = store.update({ id: old.id, expected_revision: old.revision, hidden: true });
  store.syncPackViews(pack, [decl('Past due')]);
  return { store, oldId: old.id, newId: decl('Past due').id };
};

describe('syncPackViews — a dropped view the owner set up is retired, not deleted', () => {
  it('⛔ a rename keeps the old view for the owner, out of every listing, its alert stopped', () => {
    const { store, oldId, newId } = renamed();
    expect(store.list().map((v) => v.name)).toEqual(['Past due']);
    expect(store.get(oldId)).toBeNull();
    const [retired] = store.listRetired();
    expect(retired).toMatchObject({
      id: oldId,
      name: 'Overdue',
      retired: { replacements: [{ id: newId, name: 'Past due' }], alert: ALERT },
    });
    expect(retired!.alert).toBeUndefined();
    // …and no alert watches it: an evaluation leaves the retired row as it was.
    store.alerts.evaluate();
    expect(store.listRetired()[0]).toEqual(retired);
  });

  it('the replacements are what the update ADDED, not every view it still ships', () => {
    const store = open();
    store.syncPackViews(pack, [decl('Overdue'), decl('Paid')]);
    const old = store.get(decl('Overdue').id)!;
    store.update({ id: old.id, expected_revision: old.revision, alert: ALERT });
    store.syncPackViews(pack, [decl('Past due'), decl('Paid')]);
    expect(store.listRetired()[0]!.retired!.replacements).toEqual([{ id: decl('Past due').id, name: 'Past due' }]);
  });

  it('a view with nothing of the owner\'s on it goes, as before', () => {
    const store = open();
    store.syncPackViews(pack, [decl('Overdue')]);
    store.syncPackViews(pack, [decl('Past due')]);
    expect(store.listRetired()).toEqual([]);
    expect(store.list().map((v) => v.name)).toEqual(['Past due']);
  });

  it('a later update that ships the old name again brings it back as the owner left it', () => {
    const { store, oldId } = renamed();
    store.syncPackViews(pack, [decl('Overdue'), decl('Past due')]);
    expect(store.listRetired()).toEqual([]);
    expect(store.get(oldId)).toMatchObject({ name: 'Overdue', alert: { enabled: true, status: 'watching' } });
    expect(store.get(oldId)!.retired).toBeUndefined();
  });

  it('an uninstall removes a retired view with the rest of the pack', () => {
    const { store } = renamed();
    store.removePackViews(pack.slug, pack.publisher);
    expect(store.listRetired()).toEqual([]);
  });
});

describe('resolveRetired — the owner\'s answer', () => {
  it('⛔ apply: the replacement is set up the same way — alert, hide, review — and the old one goes', () => {
    const { store, oldId, newId } = renamed({ hidden: true, review: true });
    const view = store.resolveRetired({ id: oldId, action: 'apply', to_id: newId })!;
    expect(view).toMatchObject({
      id: newId, hidden: true, alert: { enabled: true, time_zone: 'UTC', status: 'watching' },
      review: { reviewed_through: CURSOR },
    });
    expect(store.listRetired()).toEqual([]);
  });

  it('apply carries no review mark into a DIFFERENT stream — it would skip changes', () => {
    const store = open();
    store.syncPackViews(pack, [decl('Overdue')]);
    let old = store.get(decl('Overdue').id)!;
    old = store.update({ id: old.id, expected_revision: old.revision, review: CURSOR });
    store.syncPackViews(pack, [decl('Payments', records('payment'))]);
    const view = store.resolveRetired({ id: old.id, action: 'apply', to_id: decl('Payments').id })!;
    expect(view.review).toBeUndefined();
  });

  it('apply refuses a view the pack did not ship', () => {
    const { store, oldId } = renamed();
    const mine = store.create({ name: 'Mine', definition: records() });
    expect(() => store.resolveRetired({ id: oldId, action: 'apply', to_id: mine.id }))
      .toThrow(/views this pack update added/);
    // …nor another pack's view, which has a `pack` too.
    const other = { publisher: 'vendor', slug: 'payments' } as const;
    store.syncPackViews(other, [{ id: packSavedViewId(other, 'Refunds'), name: 'Refunds', definition: records() }]);
    expect(() => store.resolveRetired({ id: oldId, action: 'apply', to_id: packSavedViewId(other, 'Refunds') }))
      .toThrow(/views this pack update added/);
  });

  it('keep: the owner\'s own view, old name, settings and alert, under a FRESH id', () => {
    const { store, oldId } = renamed();
    const kept = store.resolveRetired({ id: oldId, action: 'keep' })!;
    expect(kept.id).not.toBe(oldId);
    expect(kept).toMatchObject({ name: 'Overdue', definition: records(), alert: { enabled: true, status: 'watching' } });
    expect(kept.pack).toBeUndefined();
    expect(store.listRetired()).toEqual([]);
    // A later update that ships the old name again does not collide with the copy.
    store.syncPackViews(pack, [decl('Overdue'), decl('Past due')]);
    expect(store.list().map((v) => v.name)).toEqual(['Overdue', 'Overdue', 'Past due']);
  });

  it('keep counts against the owner\'s allowance', () => {
    const { store, oldId } = renamed();
    for (let i = 0; i < SAVED_DATA_VIEW_LIMIT; i += 1) store.create({ name: `v${i}`, definition: records() });
    expect(() => store.resolveRetired({ id: oldId, action: 'keep' })).toThrow(/up to/);
    expect(store.listRetired()).toHaveLength(1);
  });

  it('⛔ a LIVE view is not a retired one: answering it is refused, not a delete', () => {
    const { store, newId } = renamed();
    expect(() => store.resolveRetired({ id: newId, action: 'dismiss' })).toThrow(/already dealt with/);
    expect(store.get(newId)).not.toBeNull();
  });

  it('dismiss drops it, and a second answer finds nothing to resolve', () => {
    const { store, oldId } = renamed();
    expect(store.resolveRetired({ id: oldId, action: 'dismiss' })).toBeNull();
    expect(store.listRetired()).toEqual([]);
    expect(() => store.resolveRetired({ id: oldId, action: 'dismiss' })).toThrow(/already dealt with/);
  });
});

describe('the rpc', () => {
  it('data_views.list carries the retired views, and data_views.retired.resolve answers one', async () => {
    const { store, oldId, newId } = renamed();
    const handlers = makeSavedDataViewHandlers(store)!.handlers;
    const client = { instance_id: 'paired' } as never;
    const listed = await handlers['data_views.list']!(undefined as never, client);
    expect(listed.retired?.map((v) => v.id)).toEqual([oldId]);
    const resolved = await handlers['data_views.retired.resolve']!({ id: oldId, action: 'apply', to_id: newId }, client);
    expect(resolved.view?.id).toBe(newId);
    expect((await handlers['data_views.list']!(undefined as never, client)).retired).toEqual([]);
  });
});
