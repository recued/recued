import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProactiveProposalInput, SituationRef } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { proposalSituation, publishProposalEvents } from '../situations/proposal-events.js';

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
const fixture = (options: { path?: string; emit?: () => void; origin?: Parameters<typeof createSphereStore>[3] } = {}) => {
  let sql: string[] | undefined; let serial = 0;
  const db = new Database(options.path ?? ':memory:', { verbose(statement) { sql?.push(String(statement)); } });
  disposals.push(() => db.close()); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const spheres = createSphereStore(db, work, undefined, options.origin);
  const proposals = createProactiveProposalStore(db);
  const situations = createSituationStore(db, options.emit ? { emit: options.emit } : undefined);
  const put = (id: string, patch: Partial<Parameters<typeof work.writeAsset>[0]> = {}) => work.writeAsset({
    id, name: id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, ...patch,
  }, 100);
  const offer = (subject?: SituationRef, patch: Partial<ProactiveProposalInput> = {}) => proposals.ensure({
    key: `offer-${serial++}`, kind: 'rule', title: `Offer ${serial}`, explanation: 'Review', sources: [], payload: {},
    confidence: 'high', origin: 'owner', ...(subject ? { subject } : {}), ...patch,
  }, 100);
  const measure = <T>(run: () => T) => { const statements: string[] = []; sql = statements;
    try { return { value: run(), sql: statements }; } finally { sql = undefined; }
  };
  const publish = () => measure(() => publishProposalEvents(proposals, situations, spheres));
  return { db, work, spheres, proposals, situations, put, offer, measure, publish };
};
const assetReads = (sql: string[]) => sql.filter(query => /^SELECT \* FROM data_asset WHERE id = /u.test(query));
const ancestryReads = (sql: string[]) => sql.filter(query => /^WITH RECURSIVE ancestry\(/u.test(query));
const counterReads = (sql: string[]) => sql.filter(query => /^SELECT total_changes\(\) AS writes,data_version,schema_version/u.test(query));
const priorPoints = (sql: string[]) => sql.filter(query => /^SELECT snapshot, revision FROM situations WHERE id=/u.test(query));
const priorBatches = (sql: string[]) => sql.filter(query => /^WITH publication_situation_requested\b/u.test(query));

describe('D-325 proposal publication asset placements', () => {
  for (const count of [0, 1, 100, 101, 201]) it(`publishes ${count} events with bounded asset projection and no repeated-publication reads`, () => {
    const f = fixture();
    const offers = f.db.transaction(() => Array.from({ length: count }, (_, index) => {
      const id = `asset-${index}`; f.put(id); return f.offer({ collection: 'asset', id });
    }))();
    const expected = offers.map(row => proposalSituation(row, f.spheres));
    const { sql } = f.publish();
    const points = Math.ceil(count / 100); const batches = Math.floor(count / 100);
    expect(assetReads(sql)).toHaveLength(points); expect(ancestryReads(sql)).toHaveLength(batches);
    expect(counterReads(sql)).toHaveLength(count - points + 2 * batches);
    expect(priorPoints(sql)).toHaveLength(points); expect(priorBatches(sql)).toHaveLength(batches);
    expect(offers.map(row => f.situations.get(`proposal:${row.id}`)?.snapshot)).toEqual(expected);
    expect(f.proposals.pendingEvents()).toEqual([]); expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(count);
    const repeated = f.publish(); expect(assetReads(repeated.sql)).toEqual([]); expect(counterReads(repeated.sql)).toEqual([]);
    expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(count);
  });

  it('matches point resolution for pins, inheritance, missing and unavailable assets, and target precedence', () => {
    const f = fixture(); f.put('parent', { sphere: 'professional' }); f.put('inherited', { belongs_to: 'parent' });
    f.put('override', { sphere_override: 'personal', sphere: 'professional' });
    f.put('placed'); f.spheres.setSource('asset:placed', 'professional');
    f.put('pinned'); f.spheres.setItem({ collection: 'asset', id: 'pinned' }, 'personal');
    f.put('orphan', { sync_state: 'orphaned', sphere: 'professional' });
    f.put('deleted', { sphere: 'professional' }); f.work.deleteAsset('deleted', { tombstone: true });
    const offers = ['inherited', 'override', 'placed', 'pinned', 'orphan', 'deleted', 'missing'].map(id => f.offer({ collection: 'asset', id }));
    const completed = f.offer();
    offers.push(f.proposals.outcome(completed.id, 'accepted', 101, { collection: 'asset', id: 'inherited' }));
    offers.push(f.offer(undefined, { sources: [{ collection: 'asset', id: 'placed' }] }));
    offers.push(f.offer({ collection: 'contact', id: 'contact' })); offers.push(f.offer());
    const expected = offers.map(row => proposalSituation(row, f.spheres));
    f.publish(); expect(offers.map(row => f.situations.get(`proposal:${row.id}`)?.snapshot)).toEqual(expected);
  });

  for (const parent of ['parent', 7]) it(`keeps a legacy blob parent ${String(parent)} absent from its canonical column`, () => {
    const f = fixture(); f.put(String(parent), { sphere: 'professional' });
    f.put('first'); f.offer({ collection: 'asset', id: 'first' }); f.put('legacy');
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.belongs_to',?) WHERE id='legacy'").run(parent);
    const legacy = f.offer({ collection: 'asset', id: 'legacy' }); f.put('tail'); f.offer({ collection: 'asset', id: 'tail' });
    const expected = proposalSituation(legacy, f.spheres); f.publish();
    expect(expected.cluster.items[0]?.sphere).toBe(typeof parent === 'string' ? 'professional' : undefined);
    expect(f.situations.get(`proposal:${legacy.id}`)?.snapshot).toEqual(expected);
  });

  it('deduplicates projection IDs while publishing every revision in order', () => {
    const f = fixture(); f.put('a');
    const first = f.offer({ collection: 'asset', id: 'a' }); f.proposals.edit(first.id, { title: 'Owner edit' }, 101); f.proposals.outcome(first.id, 'not_this_one', 102);
    const { sql } = f.publish(); expect(ancestryReads(sql)).toHaveLength(1); expect(assetReads(sql)).toHaveLength(1);
    expect(f.situations.revisionsAfter(0, 1000).map(row => row.after.state)).toEqual(['proposed', 'proposed', 'dismissed']);
    expect(f.proposals.pendingEvents()).toEqual([]);
  });

  it('keeps item pins shielding corrupt asset or parent JSON', () => {
    const f = fixture(); f.put('healthy'); f.offer({ collection: 'asset', id: 'healthy' });
    f.put('parent'); f.put('a', { belongs_to: 'parent' }); f.put('b');
    f.spheres.setItem({ collection: 'asset', id: 'a' }, 'personal'); f.spheres.setItem({ collection: 'asset', id: 'b' }, 'professional');
    f.db.prepare("UPDATE data_asset SET data_blob='invalid JSON' WHERE id IN ('parent','b')").run();
    const a = f.offer({ collection: 'asset', id: 'a' }), b = f.offer({ collection: 'asset', id: 'b' });
    f.publish(); expect(f.situations.get(`proposal:${a.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('personal');
    expect(f.situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('professional');
  });

  it('calls origin callbacks once per event in original order, including custom calendar fallback', () => {
    const seen: string[] = [];
    const f = fixture({ origin: ref => { seen.push(ref.id); return ref.id === 'a' ? { source: 'calendar:fixture:sub' } : undefined; } });
    f.put('a'); f.put('b'); f.put('c'); f.spheres.setSource('calendar:fixture', 'professional');
    const a = f.offer({ collection: 'asset', id: 'a' }), b = f.offer({ collection: 'asset', id: 'b' });
    f.offer({ collection: 'asset', id: 'c' });
    f.publish(); expect(seen).toEqual(['a', 'b', 'c']);
    expect(f.situations.get(`proposal:${a.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('professional');
    expect(f.situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere).toBeUndefined();
  });

  for (const mode of ['source', 'sphere'] as const) it(`skips unused freshness checks when every event has an explicit ${mode} origin`, () => {
    const seen: string[] = [];
    const f = fixture({ origin: ref => {
      seen.push(ref.id);
      return mode === 'source' ? { source: 'calendar:fixture:sub' } : { sphere: 'professional' };
    } });
    f.spheres.setSource('calendar:fixture', 'professional');
    const ids = Array.from({ length: 100 }, (_, index) => `asset-${index}`);
    const offers = ids.map(id => { f.put(id); return f.offer({ collection: 'asset', id }); });
    const expected = offers.map(row => proposalSituation(row, f.spheres)); seen.length = 0;
    const { sql } = f.publish();
    expect(seen).toEqual(ids); expect(ancestryReads(sql)).toHaveLength(1);
    expect(assetReads(sql)).toHaveLength(100); expect(counterReads(sql)).toHaveLength(2);
    expect(offers.map(row => f.situations.get(`proposal:${row.id}`)?.snapshot)).toEqual(expected);
  });

  it('retains cached placements after a single explicit origin in a mixed page', () => {
    const seen: string[] = [];
    const f = fixture({ origin: ref => { seen.push(ref.id); return ref.id === 'asset-1' ? { sphere: 'professional' } : undefined; } });
    const ids = Array.from({ length: 100 }, (_, index) => `asset-${index}`);
    const offers = ids.map(id => { f.put(id); return f.offer({ collection: 'asset', id }); });
    const expected = offers.map(row => proposalSituation(row, f.spheres)); seen.length = 0;
    const { sql } = f.publish();
    expect(seen).toEqual(ids); expect(ancestryReads(sql)).toHaveLength(1);
    expect(assetReads(sql)).toHaveLength(2); expect(counterReads(sql)).toHaveLength(100);
    expect(offers.map(row => f.situations.get(`proposal:${row.id}`)?.snapshot)).toEqual(expected);
  });

  it('checks freshness before reusing a placement after an explicit origin writes a later pin', () => {
    const seen: string[] = [];
    const f = fixture({ origin: ref => {
      seen.push(ref.id);
      if (ref.id !== 'b') return undefined;
      f.db.prepare("INSERT INTO sphere_items(collection,id,sphere) VALUES('asset','c','professional')").run();
      return { sphere: 'personal' };
    } });
    for (const id of ['a', 'b', 'c']) f.put(id);
    f.offer({ collection: 'asset', id: 'a' }); const b = f.offer({ collection: 'asset', id: 'b' }); const c = f.offer({ collection: 'asset', id: 'c' });
    f.publish(); expect(seen).toEqual(['a', 'b', 'c']);
    expect(f.situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('personal');
    expect(f.situations.get(`proposal:${c.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('professional');
  });

  for (const pin of ['item', 'override'] as const) it(`keeps the cheap point path for a page of ${pin} pins`, () => {
    const f = fixture();
    for (let index = 0; index < 100; index++) {
      const id = `pin-${index}`; f.put(id, pin === 'override' ? { sphere_override: 'professional' } : {});
      if (pin === 'item') f.spheres.setItem({ collection: 'asset', id }, 'professional');
      f.offer({ collection: 'asset', id });
    }
    const { sql } = f.publish(); expect(counterReads(sql)).toEqual([]); expect(ancestryReads(sql)).toEqual([]);
    expect(assetReads(sql)).toHaveLength(pin === 'override' ? 100 : 0);
    expect(f.situations.revisionsAfter(0, 1000).every(row => row.after.cluster.items[0]?.sphere === 'professional')).toBe(true);
  });

  for (const mode of ['resolve', 'resolveAssets', 'readAssetEffective', 'readAssetsEffective'] as const) it(`keeps point resolution with customized ${mode}`, () => {
    const f = fixture(); f.put('a'); f.put('b'); f.put('c'); const seen: string[] = [];
    const offers = ['a', 'b', 'c'].map(id => f.offer({ collection: 'asset', id }));
    if (mode === 'resolve') f.spheres.resolve = ref => { seen.push(ref.id); return { sphere: 'personal', pinned: false, reason: 'custom' }; };
    if (mode === 'resolveAssets') f.spheres.resolveAssets = () => { throw new Error('Point readers must remain in use'); };
    if (mode === 'readAssetEffective') { const read = f.work.readAssetEffective; f.work.readAssetEffective = id => { seen.push(id); return { ...read(id)!, sphere: 'personal' }; }; }
    if (mode === 'readAssetsEffective') f.work.readAssetsEffective = () => { throw new Error('Point readers must remain in use'); };
    const { sql } = f.publish(); expect(counterReads(sql)).toEqual([]); expect(ancestryReads(sql)).toEqual([]);
    if (mode === 'resolve' || mode === 'readAssetEffective') {
      expect(seen).toEqual(['a', 'b', 'c']);
      expect(offers.map(row => f.situations.get(`proposal:${row.id}`)?.snapshot.cluster.items[0]?.sphere)).toEqual(['personal', 'personal', 'personal']);
    }
  });

  for (const mode of ['failure', 'incomplete', 'unavailable'] as const) it(`retains ordered point reads when prefetch is ${mode}`, () => {
    const f = fixture(); f.put('a'); f.put('b'); f.put('c'); for (const id of ['a', 'b', 'c']) f.offer({ collection: 'asset', id });
    if (mode === 'failure') f.spheres.prefetchAssetPlacements = () => { throw new Error('Unavailable'); };
    if (mode === 'incomplete') f.spheres.prefetchAssetPlacements = () => ({ read: () => undefined, wrote() {}, invalidate() {} });
    if (mode === 'unavailable') delete (f.spheres as Partial<typeof f.spheres>).prefetchAssetPlacements;
    expect(assetReads(f.publish().sql)).toHaveLength(3); expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(3);
  });

  for (const mode of ['asset', 'payload', 'target'] as const) it(`keeps earlier saves and acknowledgements before a later malformed ${mode}`, () => {
    const f = fixture(); f.put('a'); f.put('b'); const a = f.offer({ collection: 'asset', id: 'a' });
    const b = f.offer(mode === 'target' ? undefined : { collection: 'asset', id: 'b' });
    f.put('c'); const c = f.offer({ collection: 'asset', id: 'c' });
    if (mode === 'asset') f.db.prepare("UPDATE data_asset SET data_blob='invalid JSON' WHERE id='b'").run();
    else f.db.prepare('UPDATE proactive_proposal_events SET value=? WHERE json_extract(value,\'$.id\')=?')
      .run(JSON.stringify({ ...b, ...(mode === 'payload' ? { payload: null } : { sources: null }) }), b.id);
    expect(() => f.publish()).toThrow();
    expect(f.situations.get(`proposal:${a.id}`)).not.toBeNull(); expect(f.situations.get(`proposal:${b.id}`)).toBeNull();
    expect(f.proposals.pendingEvents().map(row => row.proposal.id)).toEqual([b.id, c.id]);
  });

  for (const mode of ['save', 'acknowledgement'] as const) it(`replays after a failed ${mode} without duplicate situation revisions`, () => {
    const f = fixture(); f.put('a'); f.put('b'); const a = f.offer({ collection: 'asset', id: 'a' }); f.offer({ collection: 'asset', id: 'b' }); f.put('c'); f.offer({ collection: 'asset', id: 'c' });
    const save = f.situations.save, acknowledge = f.proposals.acknowledgeEvent;
    if (mode === 'save') f.situations.save = (snapshot, cause, at, wrote) => { if (snapshot.id !== `proposal:${a.id}`) throw new Error('Save failed'); return save(snapshot, cause, at, wrote); };
    else f.proposals.acknowledgeEvent = () => { throw new Error('Ack failed'); };
    expect(() => f.publish()).toThrow(); expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(1);
    f.situations.save = save; f.proposals.acknowledgeEvent = acknowledge;
    f.publish(); expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(3); expect(f.proposals.pendingEvents()).toEqual([]);
  });

  for (const mode of ['item-pin', 'asset', 'source', 'delete', 'rollback'] as const) it(`sees a listener's ${mode} change before the next event in the same page`, () => {
    let emitted = 0;
    const f = fixture({ emit: () => {
      if (emitted++) return;
      if (mode === 'item-pin') f.spheres.setItem({ collection: 'asset', id: 'b' }, 'professional');
      if (mode === 'asset') f.put('b', { sphere: 'professional' });
      if (mode === 'source') f.spheres.setSource('work:recued.asset', 'professional');
      if (mode === 'delete') f.work.deleteAsset('b');
      if (mode === 'rollback') { try { f.db.transaction(() => { f.put('b', { sphere: 'professional' }); throw new Error('Rollback'); })(); } catch { /* intentional */ } }
    } });
    f.put('a'); f.put('b', mode === 'delete' ? { sphere: 'professional' } : {});
    f.offer({ collection: 'asset', id: 'a' }); const b = f.offer({ collection: 'asset', id: 'b' }); f.put('tail'); f.offer({ collection: 'asset', id: 'tail' });
    const { sql } = f.publish(); expect(assetReads(sql).length).toBeGreaterThan(0);
    expect(f.situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere)
      .toBe(mode === 'delete' || mode === 'rollback' ? undefined : 'professional');
  });

  it('sees a listener commit made through another SQLite connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd325-pub-')); disposals.push(() => rmSync(dir, { recursive: true, force: true }));
    let emitted = 0; let other: Database.Database;
    const f = fixture({ path: join(dir, 'realm.sqlite'), emit: () => { if (!emitted++) other.prepare("INSERT INTO sphere_items VALUES('asset','b','professional',NULL)").run(); } });
    other = new Database(join(dir, 'realm.sqlite')); disposals.push(() => other.close());
    f.put('a'); f.put('b'); f.offer({ collection: 'asset', id: 'a' }); const b = f.offer({ collection: 'asset', id: 'b' }); f.put('tail'); f.offer({ collection: 'asset', id: 'tail' });
    f.publish(); expect(f.situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('professional');
  });

  for (const writer of ['save', 'acknowledge'] as const) it(`discards cached reads when a customized ${writer} omits write accounting`, () => {
    const f = fixture(); f.put('a'); f.put('b'); f.offer({ collection: 'asset', id: 'a' }); const b = f.offer({ collection: 'asset', id: 'b' }); f.put('tail'); f.offer({ collection: 'asset', id: 'tail' }); let changed = false;
    const change = () => { if (!changed) { changed = true; f.spheres.setItem({ collection: 'asset', id: 'b' }, 'professional'); } };
    if (writer === 'save') { const save = f.situations.save; f.situations.save = (snapshot, cause, at) => { const result = save(snapshot, cause, at); change(); return result; }; }
    else { const ack = f.proposals.acknowledgeEvent; f.proposals.acknowledgeEvent = revision => { ack(revision); change(); }; }
    f.publish(); expect(f.situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('professional');
  });

  it('retains resolver replacement by a listener without requiring a database write', () => {
    let emitted = 0;
    const f = fixture({ emit: () => { if (!emitted++) f.spheres.resolve = () => ({ sphere: 'professional', reason: 'custom', pinned: false }); } });
    f.put('a'); f.put('b'); f.offer({ collection: 'asset', id: 'a' }); const b = f.offer({ collection: 'asset', id: 'b' }); f.put('tail'); f.offer({ collection: 'asset', id: 'tail' });
    f.publish(); expect(f.situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('professional');
  });

  it('rejects write accounting from a different database instead of hiding listener changes', () => {
    const f = fixture(); const other = new Database(':memory:'); disposals.push(() => other.close()); let emitted = 0;
    const situations = createSituationStore(other, { emit: () => {
      if (emitted++) return;
      f.spheres.setItem({ collection: 'asset', id: 'b' }, 'professional');
      f.spheres.setItem({ collection: 'asset', id: 'tail' }, 'personal');
    } });
    f.situations.save = situations.save;
    f.put('a'); f.put('b'); f.put('tail'); f.offer({ collection: 'asset', id: 'a' });
    const b = f.offer({ collection: 'asset', id: 'b' }); f.offer({ collection: 'asset', id: 'tail' });
    f.publish(); expect(situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('professional');
  });

  it('sees a projection reader that an origin callback replaces for the current event', () => {
    const seen: string[] = [];
    const f = fixture({ origin: ref => {
      seen.push(ref.id);
      if (ref.id === 'b') {
        const read = f.work.readAssetEffective;
        f.work.readAssetEffective = id => { const row = read(id); return row ? { ...row, sphere: 'professional' } : null; };
      }
      return undefined;
    } });
    for (const id of ['a', 'b', 'tail']) f.put(id);
    f.offer({ collection: 'asset', id: 'a' }); const b = f.offer({ collection: 'asset', id: 'b' }); f.offer({ collection: 'asset', id: 'tail' });
    f.publish(); expect(seen).toEqual(['a', 'b', 'tail']);
    expect(f.situations.get(`proposal:${b.id}`)?.snapshot.cluster.items[0]?.sphere).toBe('professional');
  });
});
