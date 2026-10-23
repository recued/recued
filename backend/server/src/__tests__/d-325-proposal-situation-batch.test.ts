import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SituationSnapshot } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createSphereStore, nonAssetSphereOrigins } from '../storage/sphere-store.js';
import { proposalSituation, publishProposalEvents } from '../situations/proposal-events.js';

const disposals: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0).reverse()) dispose(); });
const fixture = (options: { path?: string; emit?: () => void; origin?: Parameters<typeof createSphereStore>[3] } = {}) => {
  let sql: string[] | undefined; let serial = 0;
  const db = new Database(options.path ?? ':memory:', { verbose: statement => sql?.push(String(statement)) });
  disposals.push(() => db.close()); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const spheres = createSphereStore(db, work, undefined, options.origin);
  const proposals = createProactiveProposalStore(db);
  const situations = createSituationStore(db, options.emit ? { emit: options.emit } : undefined);
  const offer = (id = `asset-${serial++}`) => {
    work.writeAsset({ id, name: id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' } }, 100);
    return proposals.ensure({ key: `offer-${id}`, kind: 'rule', title: `Offer ${id}`, explanation: 'Review', sources: [], payload: {},
      confidence: 'high', origin: 'owner', subject: { collection: 'asset', id } }, 100);
  };
  const seed = (count: number) => db.transaction(() => Array.from({ length: count }, () => offer()))();
  const measure = <T>(run: () => T) => { const statements: string[] = []; sql = statements;
    try { return { value: run(), sql: statements }; } finally { sql = undefined; }
  };
  const publish = () => measure(() => publishProposalEvents(proposals, situations, spheres));
  return { db, work, spheres, proposals, situations, offer, seed, measure, publish };
};
const points = (sql: string[]) => sql.filter(statement => /^SELECT snapshot, revision FROM situations WHERE id=/u.test(statement));
const batches = (sql: string[]) => sql.filter(statement => /^WITH publication_situation_requested\b/u.test(statement));
const counters = (sql: string[]) => sql.filter(statement => /^SELECT total_changes\(\) AS writes,data_version,schema_version/u.test(statement));
const writes = (sql: string[]) => sql.filter(statement => /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(statement));

describe('D-325 prior situations in native proposal publication', () => {
  for (const count of [0, 1, 2, 3, 100, 101, 201, 401]) it(`shares freshness checks for ${count} events without adding writes`, () => {
    const f = fixture(); const offers = f.seed(count); const expected = offers.map(row => proposalSituation(row, f.spheres));
    const full = Math.floor(count / 100), tail = count % 100;
    const measured = f.publish();
    expect(points(measured.sql)).toHaveLength(full + (tail === 2 ? 2 : tail ? 1 : 0));
    expect(batches(measured.sql)).toHaveLength(full + (tail >= 3 ? 1 : 0));
    expect(counters(measured.sql)).toHaveLength(full * 101 + (tail >= 3 ? tail + 1 : 0));
    expect(writes(measured.sql)).toHaveLength(count * 3);
    expect(offers.map(row => f.situations.get(`proposal:${row.id}`)?.snapshot)).toEqual(expected);
    expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(count); expect(f.proposals.pendingEvents()).toEqual([]);
    const warm = f.publish(); expect(points(warm.sql)).toEqual([]); expect(batches(warm.sql)).toEqual([]);
    expect(counters(warm.sql)).toEqual([]); expect(writes(warm.sql)).toEqual([]);
  });

  it('replays acknowledged events without new revisions or extra writes', () => {
    const f = fixture(); f.seed(201); f.publish(); const before = f.situations.revisionsAfter(0, 1000);
    f.db.prepare('UPDATE proactive_proposal_events SET delivered=0').run();
    const replay = f.publish(); expect(points(replay.sql)).toHaveLength(3); expect(batches(replay.sql)).toHaveLength(2);
    expect(writes(replay.sql)).toHaveLength(201); expect(f.situations.revisionsAfter(0, 1000)).toEqual(before);
    expect(f.proposals.pendingEvents()).toEqual([]);
  });

  it('consumes a repeated situation once and reads later versions afresh', () => {
    const f = fixture(); const row = f.offer('repeated');
    const versions = [row, ...Array.from({ length: 4 }, (_, i) => f.proposals.edit(row.id, { title: `Revision ${i}` }, 101 + i))];
    const read = f.publish(); expect(points(read.sql)).toHaveLength(4); expect(batches(read.sql)).toHaveLength(1);
    const revisions = f.situations.revisionsAfter(0, 1000); expect(revisions).toHaveLength(5);
    expect(revisions.map(revision => revision.after.cluster.items[0]?.what.value)).toEqual(versions.map(version => version.title));
    expect(revisions.slice(1).map(revision => revision.before?.cluster.items[0]?.what.value)).toEqual(versions.slice(0, -1).map(version => version.title));
  });

  for (const existing of [false, true]) it(`keeps the latest prior when a proposal changes from a non-asset target to an asset, existing=${existing}`, () => {
    const f = fixture(); f.seed(2);
    f.work.writeAsset({ id: 'changed-target', name: 'Changed target', source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' } }, 100);
    const first = f.proposals.ensure({ key: 'changed-target', kind: 'rule', title: 'Initially a note', explanation: 'Review', sources: [], payload: {},
      confidence: 'high', origin: 'owner', subject: { collection: 'note', id: 'initial-note' } }, 100);
    const last = { ...first, title: 'Now an asset', subject: { collection: 'asset', id: 'changed-target' }, updated_at: 101 };
    if (existing) f.situations.save(proposalSituation({ ...last, title: 'Older asset proposal' }, f.spheres), { source: 'seed' }, 99);
    f.proposals.save(last); f.offer('tail');
    const measured = f.publish();
    const revisions = f.situations.revisionsAfter(0, 1000).filter(row => row.situation_id === `proposal:${first.id}`);
    expect(revisions).toHaveLength(existing ? 3 : 2);
    expect(revisions.at(-1)?.before).toEqual(revisions.at(-2)?.after);
    expect(revisions.at(-1)?.before).toEqual(proposalSituation(first, f.spheres));
    expect(revisions.at(-1)?.after).toEqual(proposalSituation(last, f.spheres));
    expect(points(measured.sql)).toHaveLength(4); expect(batches(measured.sql)).toHaveLength(1);
    expect(writes(measured.sql)).toHaveLength(15); expect(f.proposals.pendingEvents()).toEqual([]);
  });

  for (const mode of ['update', 'forget', 'delete', 'rollback', 'schema'] as const) it(`invalidates both reads after a listener ${mode}`, () => {
    let armed = false, fired = false, emitted = 0; let expectedBefore: SituationSnapshot | null | undefined;
    const f = fixture({ emit: () => {
      if (!armed || fired || ++emitted !== 2) return; fired = true;
      const id = `proposal:${target.id}`;
      expect(f.db.inTransaction).toBe(false);
      if (mode === 'update') {
        f.situations.save({ ...old, state: 'accepted' }, { source: 'listener' }, 101);
        f.spheres.setItem(target.subject!, 'professional');
      }
      if (mode === 'forget') f.situations.forget(id);
      if (mode === 'delete') f.db.prepare('DELETE FROM situations WHERE id=?').run(id);
      if (mode === 'rollback') { try { f.db.transaction(() => {
        f.db.prepare('UPDATE situations SET snapshot=? WHERE id=?').run(JSON.stringify({ ...old, state: 'accepted' }), id);
        throw new Error('Fixture rollback');
      })(); } catch { /* Expected caller rollback. */ } }
      if (mode === 'schema') f.db.exec('CREATE TABLE listener_schema_change (id TEXT)');
      expectedBefore = f.situations.get(id)?.snapshot ?? null;
    } });
    const offers = f.seed(5), target = offers[4]!;
    const old = { ...proposalSituation(target, f.spheres), proposal: { ...proposalSituation(target).proposal!, text: 'Old private evidence' } };
    f.situations.save(old, { source: 'seed' }, 99); armed = true;
    const read = f.publish(); expect(fired).toBe(true); expect(batches(read.sql)).toHaveLength(1); expect(points(read.sql).length).toBeGreaterThan(1);
    const revisions = f.situations.revisionsAfter(0, 1000).filter(revision => revision.situation_id === `proposal:${target.id}`);
    expect(revisions.at(-1)?.before).toEqual(expectedBefore); expect(revisions.at(-1)?.after).toEqual(proposalSituation(target, f.spheres));
    if (mode === 'forget') expect(JSON.stringify(revisions.at(-1)?.before)).not.toContain('Old private evidence');
    expect(f.proposals.pendingEvents()).toEqual([]);
  });

  it('reads a listener commit from another SQLite connection after the shared batch was loaded', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd325-prior-')); disposals.push(() => rmSync(directory, { recursive: true, force: true }));
    let armed = false, emitted = 0, expected: SituationSnapshot;
    const f = fixture({ path: join(directory, 'realm.sqlite'), emit: () => {
      if (!armed || ++emitted !== 2) return;
      expect(f.db.inTransaction).toBe(false);
      other.prepare('UPDATE situations SET snapshot=? WHERE id=?').run(JSON.stringify(expected), expected.id);
    } });
    const other = new Database(join(directory, 'realm.sqlite')); disposals.push(() => other.close());
    const target = f.seed(5)[4]!; const initial = proposalSituation(target, f.spheres);
    f.situations.save(initial, { source: 'seed' }, 99); expected = { ...initial, state: 'accepted' }; armed = true;
    f.publish(); const revisions = f.situations.revisionsAfter(0, 1000).filter(row => row.situation_id === initial.id);
    expect(revisions.at(-1)?.before).toEqual(expected); expect(revisions.at(-1)?.after).toEqual(initial);
  });

  for (const mode of ['pinned', 'origin', 'custom-save', 'save-accessor', 'custom-pending', 'pending-accessor', 'custom-resolve', 'no-spheres'] as const) {
    it(`retains point reads and callback timing for ${mode}`, () => {
      let callbacks = 0;
      const f = fixture(mode === 'origin' ? { origin: () => { callbacks++; expect(f.db.inTransaction).toBe(false); return undefined; } } : {});
      const offers = f.seed(3);
      if (mode === 'pinned') for (const row of offers) f.spheres.setItem(row.subject!, 'personal');
      if (mode === 'custom-save') { const save = f.situations.save; f.situations.save = (...args) => {
        callbacks++; expect(f.db.inTransaction).toBe(false); return save(...args);
      }; }
      if (mode === 'save-accessor') { const save = f.situations.save; Object.defineProperty(f.situations, 'save', { get() {
        callbacks++; expect(f.db.inTransaction).toBe(false); return save;
      } }); }
      if (mode === 'custom-pending') { const pending = f.proposals.pendingEvents; f.proposals.pendingEvents = limit => {
        const page = pending(limit); for (const event of page) {
          const title = event.proposal.title; Object.defineProperty(event.proposal, 'title', { get() {
            callbacks++; expect(f.db.inTransaction).toBe(false); return title;
          } });
        } return page;
      }; }
      if (mode === 'pending-accessor') { const pending = f.proposals.pendingEvents; Object.defineProperty(f.proposals, 'pendingEvents', { get() {
        callbacks++; expect(f.db.inTransaction).toBe(false); return pending;
      } }); }
      if (mode === 'custom-resolve') f.spheres.resolve = () => { callbacks++; expect(f.db.inTransaction).toBe(false); return { pinned: false, reason: 'custom' }; };
      const read = mode === 'no-spheres' ? f.measure(() => publishProposalEvents(f.proposals, f.situations)) : f.publish();
      expect(points(read.sql)).toHaveLength(3); expect(batches(read.sql)).toEqual([]);
      expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(3);
      if (['origin', 'custom-save', 'custom-pending', 'custom-resolve'].includes(mode)) expect(callbacks).toBeGreaterThan(0);
      if (mode === 'pending-accessor') expect(callbacks).toBe(2);
      if (mode === 'save-accessor') expect(callbacks).toBe(3);
    });
  }

  it('refuses to share prior reads across database connections', () => {
    const f = fixture(), other = fixture(); f.seed(3);
    const read = other.measure(() => publishProposalEvents(f.proposals, other.situations, f.spheres));
    expect(points(read.sql)).toHaveLength(3); expect(batches(read.sql)).toEqual([]);
    expect(other.situations.revisionsAfter(0, 1000)).toHaveLength(3); expect(f.proposals.pendingEvents()).toEqual([]);
  });

  for (const when of ['before-use', 'after-load'] as const) it(`keeps a replaced placement reader outside the transaction ${when}`, () => {
    let emitted = 0, callbacks = 0;
    let batch: ReturnType<ReturnType<typeof createSphereStore>['prefetchAssetPlacements']>;
    const replace = () => {
      const read = batch!.read;
      batch!.read = id => { callbacks++; expect(f.db.inTransaction).toBe(false); return read(id); };
    };
    const f = fixture({ emit: () => { if (++emitted === 2 && when === 'after-load') replace(); } });
    const prefetch = f.spheres.prefetchAssetPlacements.bind(f.spheres);
    f.spheres.prefetchAssetPlacements = ids => {
      batch = prefetch(ids); if (when === 'before-use') replace(); return batch;
    };
    f.seed(3); const read = f.publish();
    expect(points(read.sql)).toHaveLength(when === 'before-use' ? 3 : 2);
    expect(batches(read.sql)).toHaveLength(when === 'before-use' ? 0 : 1);
    expect(callbacks).toBe(when === 'before-use' ? 2 : 1);
    expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(3); expect(f.proposals.pendingEvents()).toEqual([]);
  });

  for (const field of ['hasDefaultAssetProjection', 'readAssetEffective', 'readAssetsEffective'] as const) {
    for (const when of ['before-use', 'after-load'] as const) it(`keeps projection customizations outside the transaction: ${field}, ${when}`, () => {
      let emitted = 0; const contexts: boolean[] = [];
      const customize = () => {
        if (field === 'hasDefaultAssetProjection') {
          const guard = f.work.hasDefaultAssetProjection.bind(f.work);
          f.work.hasDefaultAssetProjection = () => { contexts.push(f.db.inTransaction); return guard(); };
        } else {
          const value = f.work[field]; Object.defineProperty(f.work, field, { get() { contexts.push(f.db.inTransaction); return value; } });
        }
      };
      const f = fixture({ emit: () => { if (++emitted === 2 && when === 'after-load') customize(); } });
      f.seed(3); if (when === 'before-use') customize();
      const measured = f.publish(); expect(contexts.length).toBeGreaterThan(0); expect(contexts.every(value => !value)).toBe(true);
      expect(points(measured.sql)).toHaveLength(when === 'before-use' ? 3 : 2);
      expect(batches(measured.sql)).toHaveLength(when === 'before-use' ? 0 : 1);
      expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(3); expect(f.proposals.pendingEvents()).toEqual([]);
    });
  }

  it('shares native asset reads with the server non-asset origin routing', () => {
    const seen: string[] = [];
    const f = fixture({ origin: nonAssetSphereOrigins(ref => {
      expect(f.db.inTransaction).toBe(false); seen.push(ref.collection); return { sphere: 'professional' };
    }) });
    f.seed(3); const read = f.publish(); expect(points(read.sql)).toHaveLength(1); expect(batches(read.sql)).toHaveLength(1);
    expect(seen).toEqual([]); expect(f.spheres.resolve({ collection: 'episode', id: 'later' }).sphere).toBe('professional');
    expect(seen).toEqual(['episode']);
  });

  for (const failure of ['prepare', 'execution'] as const) it(`falls back after prior-batch ${failure} fails`, () => {
    const f = fixture(); f.seed(3); const prepare = f.db.prepare.bind(f.db); let attempted = false;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (/^WITH publication_situation_requested\b/u.test(sql)) {
        attempted = true; if (failure === 'prepare') throw new Error('Fixture prior batch failed');
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture prior batch failed'); }); return statement;
      } return prepare(sql);
    });
    const read = f.publish(); expect(attempted).toBe(true); expect(points(read.sql)).toHaveLength(3);
    expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(3); expect(f.proposals.pendingEvents()).toEqual([]);
  });

  it('keeps an omitted row unknown while consuming another complete result', () => {
    const f = fixture(); const offers = f.seed(3); const missing = `proposal:${offers[2]!.id}`, prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (/^WITH publication_situation_requested\b/u.test(sql)) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementationOnce((...args) => (all(...args) as Array<{ id: string }>).filter(row => row.id !== missing));
      } return statement;
    });
    const read = f.publish(); expect(points(read.sql)).toHaveLength(2); expect(batches(read.sql)).toHaveLength(1);
    expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(3); expect(f.proposals.pendingEvents()).toEqual([]);
  });

  it('decodes legacy prior JSON only after earlier saves and acknowledgements', () => {
    const f = fixture(); const offers = f.seed(3), target = offers[2]!;
    f.situations.save(proposalSituation(target, f.spheres), { source: 'seed' }, 99);
    f.db.prepare('UPDATE situations SET snapshot=? WHERE id=?').run('invalid JSON', `proposal:${target.id}`);
    expect(() => f.publish()).toThrow(SyntaxError);
    expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(3);
    expect(f.proposals.pendingEvents().map(event => event.proposal.id)).toEqual([target.id]);
    for (const row of offers.slice(0, 2)) expect(f.situations.get(`proposal:${row.id}`)).not.toBeNull();
  });

  it('discards prior values across a custom save and later restoration of native save', () => {
    let emitted = 0; const f = fixture({ emit: () => {
      if (++emitted === 2) f.situations.save = (...args) => native(...args);
      if (emitted === 3) f.situations.save = native;
    } });
    const native = f.situations.save;
    f.offer('a'); f.offer('b'); const repeated = f.offer('c'); f.proposals.edit(repeated.id, { title: 'Updated c' }, 101); f.offer('tail');
    f.publish(); const revisions = f.situations.revisionsAfter(0, 1000).filter(row => row.situation_id === `proposal:${repeated.id}`);
    expect(revisions).toHaveLength(2); expect(revisions[1]?.before?.cluster.items[0]?.what.value).toBe(repeated.title);
    expect(revisions[1]?.after.cluster.items[0]?.what.value).toBe('Updated c');
  });

  it('loads fresh prior state on later publication pages', () => {
    let armed = false, emitted = 0; let expected: SituationSnapshot;
    const f = fixture({ emit: () => {
      if (!armed || ++emitted !== 100) return;
      f.situations.save(expected, { source: 'listener' }, 101);
    } });
    const target = f.seed(201)[150]!; expected = { ...proposalSituation(target, f.spheres), state: 'accepted' }; armed = true;
    f.publish(); const revisions = f.situations.revisionsAfter(0, 1000).filter(row => row.situation_id === expected.id);
    expect(revisions.at(-1)?.before).toEqual(expected); expect(revisions.at(-1)?.after).toEqual(proposalSituation(target, f.spheres));
  });

  it('binds quoted and Unicode situation identities without changing their history', () => {
    const f = fixture(); f.offer('first'); const original = f.offer('odd');
    f.proposals.save({ ...original, id: "quoted-'漢😀", key: 'quoted', title: 'Quoted identity' }); f.offer('tail');
    f.publish(); expect(f.situations.get("proposal:quoted-'漢😀")?.snapshot.cluster.id).toBe("proposal:quoted-'漢😀");
    expect(f.situations.revisionsAfter(0, 1000)).toHaveLength(4); expect(f.proposals.pendingEvents()).toEqual([]);
  });
});
