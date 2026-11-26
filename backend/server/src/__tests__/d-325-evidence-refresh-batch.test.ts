import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRule, RecipeDefinition } from '@recued/contracts';
import { canonicalJsonString, canonicalRecipeDefinition } from '@recued/recipes';
import { createWorkEntityStore, ensureWorkEntitySchema, type AssetObservationBinding } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createRecipeStore } from '../recipe-store.js';

const at = Date.parse('2026-10-17T12:00Z');
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const definition = JSON.parse(readFileSync('community/recipes/record-asset-evidence-paperless.json', 'utf8')) as RecipeDefinition;
const recipe_hash = createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(definition))).digest('hex');
const rule: AssetRule = { id: 'renew', title: 'Renew', enabled: true, muted: false, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  when: { kind: 'expiry', field: 'expires_on' }, reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: false } };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured) { if (typeof sql !== 'string') throw new Error('Missing SQL trace'); measured.push(sql); } } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const directory = mkdtempSync(join(tmpdir(), 'd325-evidence-refresh-'));
  const annotations = createAnnotationStore({ db, blobs: createBlobStore(join(directory, 'blobs')), now: () => at });
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, annotations, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  const recipes = createRecipeStore(directory, db); recipes.save(definition, 'fixture', 'bundled', at); service.bindRecipes(recipes);
  disposals.push(async () => { await service.stop(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const measure = async <T>(read: () => T | Promise<T>) => {
    const sql: string[] = []; measured = sql;
    try { return { value: await read(), sql }; } finally { measured = undefined; }
  };
  const plain = (id: string) => work.writeAsset({ ...base, id, name: id, observations: { document_evidence: null, spare: null } }, at - 1);
  const binding = (id: string): AssetObservationBinding => ({ id: `binding:${id}`, asset_id: id, actor_ref: `recipe:${definition.recipe_id}`,
    source_ref: `document:${id}`, fields: ['observations.document_evidence'], enabled: true, recipe_hash });
  const observed = (id: string, options: { active?: boolean; evidence?: boolean } = {}) => {
    work.writeAsset({ ...base, id, name: id, dates: { expires_on: '2026-01-01' }, observations: { document_evidence: null, spare: null }, rules: [rule] }, at - 1);
    const enrolled = binding(id); work.bindAssetObservations(enrolled);
    work.writeAssetObservations({ binding_id: enrolled.id, actor_ref: enrolled.actor_ref, recipe_hash,
      observations: { document_evidence: { active: options.active ?? true, certainty: 'confirmed', as_of: at,
        evidence: options.evidence === false ? [] : [{ collection: 'file', id: `file:fixture:${id}`, field: 'dates.expires_on', value: '2027-01-01' }] } } }, at);
    return enrolled;
  };
  return { db, work, service, annotations, measure, plain, binding, observed };
};
const bindingSelects = (sql: string[]) => sql.filter(statement => /^\s*SELECT\b/iu.test(statement) && /\bFROM\s+asset_observation_binding\b/iu.test(statement));
const evidenceSelects = (sql: string[]) => sql.filter(statement => /^\s*WITH\s+evidence_first\b/iu.test(statement)
  || /\bFROM data_asset WHERE id\s*>[\s\S]*\bLIMIT 500(?:\.0+)?\s*$/iu.test(statement));
const emptySearch = { search: 'zzznomatchzz' };
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('bounded observation binding reads and evidence refresh', () => {
  it('matches individual binding DTOs across batches, missing and quoted ids, with fresh independent results', async () => {
    const f = fixture(); const ids = Array.from({ length: 1001 }, (_, index) => `asset-${String(index).padStart(4, '0')}`);
    ids.push("asset-'quoted?");
    f.db.transaction(() => {
      for (const [index, id] of ids.entries()) {
        f.plain(id); const binding = f.binding(id);
        f.work.bindAssetObservations({ ...binding, enabled: index % 2 === 0, recipe_hash: index % 3 ? recipe_hash : undefined });
      }
      f.work.bindAssetObservations({ ...f.binding(ids[0]!), id: 'second-binding', actor_ref: 'recipe:another' });
    })();
    const keys = [...ids, 'absent', 'another-absent', ids[0]!];
    const expected = new Map([...new Set(keys)].map(id => [id, f.work.listAssetObservationBindings(id)]));
    const batch = await f.measure(() => f.work.listAssetObservationBindingsForAssets(keys));
    expect(batch.value).toEqual(expected); expect([...batch.value.keys()]).toEqual([...new Set(keys)]);
    expect(batch.value.get('absent')).toEqual([]); expect(batch.value.get('absent')).not.toBe(batch.value.get('another-absent'));
    expect(bindingSelects(batch.sql)).toHaveLength(6); expect(batch.sql.every(sql => /^\s*SELECT\b/iu.test(sql))).toBe(true);
    const first = f.work.listAssetObservationBindings(ids[0]!)[0]!;
    f.work.bindAssetObservations({ ...first, enabled: false });
    batch.value.get(ids[0]!)![0]!.fields.push('observations.changed');
    expect(f.work.listAssetObservationBindingsForAssets([ids[0]!]).get(ids[0]!)).toEqual(f.work.listAssetObservationBindings(ids[0]!));
    expect(f.work.listAssetObservationBindings(ids[0]!).find(row => row.id === first.id)?.enabled).toBe(false);
    f.plain('moved'); f.work.moveAssetObservations(ids[0]!, 'moved');
    const moved = f.work.listAssetObservationBindingsForAssets([ids[0]!, 'moved']);
    expect(moved.get(ids[0]!)).toEqual([]); expect(moved.get('moved')).toEqual(f.work.listAssetObservationBindings('moved'));
    const empty = await f.measure(() => f.work.listAssetObservationBindingsForAssets([]));
    expect(empty.value.size).toBe(0); expect(empty.sql).toEqual([]);
  });

  it('keeps the first matching binding stable when query statistics select a different database plan', () => {
    for (const size of [2, 5, 201]) {
      const f = fixture(); const ids = Array.from({ length: size }, (_, index) => `asset-${index}`);
      for (const id of ids) {
        f.plain(id);
        // Reverse insertion order makes a full scan differ from an index scan.
        for (const actor of ['z', 'a']) f.work.bindAssetObservations({ ...f.binding(id), id: `${id}:${actor}`, actor_ref: `recipe:${actor}` });
      }
      for (const analyze of [false, true]) {
        if (analyze) f.db.exec('ANALYZE');
        const batch = f.work.listAssetObservationBindingsForAssets(ids);
        for (const id of ids) {
          expect(f.work.listAssetObservationBindings(id).map(row => row.actor_ref)).toEqual(['recipe:a', 'recipe:z']);
          expect(batch.get(id)).toEqual(f.work.listAssetObservationBindings(id));
        }
      }
    }
  });

  it('does no binding reads for an empty result over a large library without active source-owned observations', async () => {
    const f = fixture();
    f.db.transaction(() => {
      for (let index = 0; index < 1001; index++) {
        const asset = f.plain(`quiet-${index}`);
        if (index % 3 === 0) f.work.writeAsset({ ...base, id: asset.id,
          observations: { document_evidence: { active: true, certainty: 'confirmed', source: 'owner', as_of: at, evidence: [] } } }, at);
      }
    })();
    const read = await f.measure(() => f.service.snapshot(emptySearch));
    expect(read.value.assets).toEqual([]); expect(read.value.total_assets).toBe(0);
    expect(bindingSelects(read.sql)).toEqual([]);
    expect(evidenceSelects(read.sql)).toHaveLength(1);
    expect(read.sql.some(sql => /\bFROM\s+data_asset\b/iu.test(sql))).toBe(true);
  });

  it('returns only eligible observations while retaining the old raw page cursor and asset snapshots', () => {
    const f = fixture(); const id = (index: number) => `asset-${String(index).padStart(5, '0')}`;
    f.db.transaction(() => {
      for (let index = 0; index < 1013; index++) f.plain(id(index));
      for (const index of [2, 499, 500, 998, 1000, 1002]) f.observed(id(index), { evidence: false });
      f.observed("asset-'quoted", { evidence: false });
      f.observed('asset-漢', { evidence: false });
      f.observed('closed', { evidence: false }); f.work.writeAsset({ ...base, id: 'closed', status: 'retired' }, at);
      f.observed('inactive', { active: false, evidence: false });
    })();
    for (const after of ['', id(498), id(500), id(1002), 'zzzz']) for (const size of [1, 7, 500]) {
      let cursor = after;
      let expected: ReturnType<typeof f.work.walkAssetsForEvidenceRefresh> = { assets: [], cursor: after };
      for (;;) {
        const raw = f.work.walkByAssetId(cursor, size); if (!raw.length) break;
        cursor = raw.at(-1)!.id;
        const assets = raw.filter(asset => ['active', 'lent'].includes(asset.status)
          && Object.entries(asset.observations).some(([field, observation]) => observation?.active && asset.field_sources[`observations.${field}`]?.kind === 'observation'));
        if (assets.length) { expected = { assets, cursor }; break; }
      }
      expect(f.work.walkAssetsForEvidenceRefresh(after, size)).toEqual(expected);
    }
    const first = f.work.walkAssetsForEvidenceRefresh('', 500);
    first.assets[0]!.observations.document_evidence!.active = false;
    expect(f.work.walkAssetsForEvidenceRefresh('', 500).assets[0]!.observations.document_evidence?.active).toBe(true);
    f.work.writeAsset({ ...base, id: id(2), observations: { document_evidence: null } }, at + 1);
    expect(f.work.walkAssetsForEvidenceRefresh('', 500).assets.some(asset => asset.id === id(2))).toBe(false);
  });

  it('batches eligible observations after an entirely skipped page without creating document proposals from empty evidence', async () => {
    const f = fixture();
    f.db.transaction(() => {
      for (let index = 0; index < 501; index++) f.plain(`quiet-${String(index).padStart(4, '0')}`);
      for (let index = 0; index < 301; index++) f.observed(`report-${String(index).padStart(4, '0')}`, { evidence: false });
    })();
    const read = await f.measure(() => f.service.snapshot(emptySearch));
    expect(read.value.assets).toEqual([]); expect(read.value.total_assets).toBe(0); expect(read.value.proposals).toEqual([]);
    expect(bindingSelects(read.sql)).toHaveLength(2);
    expect(bindingSelects(read.sql).every(sql => /\basset_id IN\s*\(/u.test(sql))).toBe(true);
  });

  it('keeps field provenance correlated and excludes hidden rows from raw page boundaries after query statistics change', () => {
    const f = fixture(); const id = (index: number) => `asset-${String(index).padStart(2, '0')}`;
    for (let index = 0; index < 16; index++) f.observed(id(index), { evidence: false });
    for (const [index, state] of [[1, 'orphaned'], [4, 'tombstoned'], [8, 'stale_unreachable']] as const) {
      f.db.prepare('UPDATE data_asset SET sync_state=? WHERE id=?').run(state, id(index));
    }
    f.work.deleteAsset(id(2), { tombstone: true, now: at });
    for (const [index, status] of [[5, 'sold'], [9, 'lost'], [12, 'retired']] as const) f.work.writeAsset({ ...base, id: id(index), status }, at);
    // The active owner field and inactive source field must not qualify together.
    const owner = f.work.readAsset(id(3))!.observations.document_evidence!;
    f.work.writeAsset({ ...base, id: id(3), observations: { document_evidence: owner } }, at);
    const binding = { ...f.binding(id(3)), fields: ['observations.spare'] }; f.work.bindAssetObservations(binding);
    f.work.writeAssetObservations({ binding_id: binding.id, actor_ref: binding.actor_ref, recipe_hash,
      observations: { spare: { active: false, certainty: 'confirmed', as_of: at, evidence: [] } } }, at);
    const expectedIds = [0, 6, 7, 8, 10, 11, 13, 14, 15].map(id);
    for (const analyze of [false, true]) {
      if (analyze) f.db.exec('ANALYZE');
      for (const size of [1, 4, 7, 500]) {
        let cursor = ''; const ids: string[] = [];
        for (;;) {
          let rawCursor = cursor; let expected = { assets: [] as ReturnType<typeof f.work.walkByAssetId>, cursor };
          for (;;) {
            const raw = f.work.walkByAssetId(rawCursor, size); if (!raw.length) break;
            rawCursor = raw.at(-1)!.id;
            const assets = raw.filter(asset => ['active', 'lent'].includes(asset.status)
              && Object.entries(asset.observations).some(([field, observation]) => observation?.active && asset.field_sources[`observations.${field}`]?.kind === 'observation'));
            if (assets.length) { expected = { assets, cursor: rawCursor }; break; }
          }
          const actual = f.work.walkAssetsForEvidenceRefresh(cursor, size); expect(actual).toEqual(expected);
          if (!actual.assets.length) break;
          ids.push(...actual.assets.map(asset => asset.id)); cursor = actual.cursor;
        }
        expect(ids).toEqual(expectedIds);
      }
    }
  });

  it('preserves status, provenance, enrollment and field guards, and proposes once without advancing canonical dates', async () => {
    const f = fixture(); const valid = f.observed('active'); f.observed('lent');
    f.work.writeAsset({ ...base, id: 'lent', status: 'lent' }, at);
    f.observed('closed'); f.work.writeAsset({ ...base, id: 'closed', status: 'sold' }, at);
    f.observed('inactive', { active: false });
    f.observed('owner'); const manual = f.work.readAsset('owner')!.observations.document_evidence!;
    f.work.writeAsset({ ...base, id: 'owner', observations: { document_evidence: manual } }, at);
    const disabled = f.observed('disabled'); f.work.bindAssetObservations({ ...disabled, enabled: false });
    const unversioned = f.observed('unversioned'); f.work.bindAssetObservations({ ...unversioned, recipe_hash: undefined });
    const other = f.observed('wrong-field'); f.work.bindAssetObservations({ ...other, fields: ['observations.spare'] });
    const first = await f.service.snapshot(emptySearch);
    expect(first.proposals.map(row => row.subject?.id).sort()).toEqual(['active', 'lent']);
    expect(first.proposals.every(row => row.kind === 'close' && row.payload.on === '2027-01-01')).toBe(true);
    expect(f.work.readAsset('active')?.dates.expires_on).toBe('2026-01-01');
    expect(f.work.readAsset('lent')?.dates.expires_on).toBe('2026-01-01');
    expect((await f.annotations.listLinks({ from_collection: 'asset' })).map(row => row.from_id).sort()).toEqual(['active', 'lent']);
    const repeated = await f.service.snapshot(emptySearch);
    expect(repeated.proposals.map(row => row.id)).toEqual(first.proposals.map(row => row.id));
    expect(await f.annotations.listLinks({ from_collection: 'asset' })).toHaveLength(2);
    f.work.bindAssetObservations({ ...disabled, enabled: true });
    f.work.bindAssetObservations({ ...valid, enabled: false });
    const changed = await f.service.snapshot(emptySearch);
    expect(changed.proposals.map(row => row.subject?.id).sort()).toEqual(['active', 'disabled', 'lent']);
  });

  for (const path of ['upsert', 'existing-link'] as const) for (const enrollment of ['disabled', 'missing'] as const) it(`reads ${enrollment} later bindings afresh after the ${path} annotation await`, async () => {
    const f = fixture(); f.observed('a'); const b = f.observed('b'); const c = f.observed('c');
    if (enrollment === 'disabled') f.work.bindAssetObservations({ ...c, enabled: false });
    else f.db.prepare('DELETE FROM asset_observation_binding WHERE asset_id=?').run('c');
    const started = gate(); const resume = gate(); let paused = false;
    const pauseOnce = async () => { if (!paused) { paused = true; started.resolve(); await resume.promise; } };
    if (path === 'upsert') {
      const original = f.annotations.upsertLink!.bind(f.annotations);
      f.annotations.upsertLink = async input => { await pauseOnce(); return original(input); };
    } else {
      await f.annotations.link({ from_collection: 'asset', from_id: 'a', to_collection: 'file', to_id: 'file:fixture:a', role: 'attachment', authored_by_recipe_id: definition.recipe_id });
      delete f.annotations.upsertLink;
      const original = f.annotations.listLinks.bind(f.annotations);
      f.annotations.listLinks = async input => { await pauseOnce(); return original(input); };
    }
    const pending = f.service.snapshot(emptySearch);
    try {
      await started.promise;
      f.work.bindAssetObservations({ ...b, enabled: false });
      f.work.bindAssetObservations({ ...c, enabled: true });
    } finally { resume.resolve(); }
    const read = await pending;
    expect(read.proposals.map(row => row.subject?.id).sort()).toEqual(['a', 'c']);
    expect((await f.annotations.listLinks({ from_collection: 'asset' })).map(row => row.from_id).sort()).toEqual(['a', 'c']);
    expect(f.work.readAsset('c')?.dates.expires_on).toBe('2026-01-01');
  });

  for (const change of ['clear', 'retire', 'delete', 'orphan'] as const) it(`reads a later raw page after an annotation await and sees its ${change} change`, async () => {
    const f = fixture(); f.observed('a');
    for (let index = 0; index < 500; index++) f.plain(`middle-${String(index).padStart(4, '0')}`);
    f.observed('z');
    const started = gate(); const resume = gate(); let paused = false;
    const original = f.annotations.upsertLink!.bind(f.annotations);
    f.annotations.upsertLink = async input => {
      if (!paused) { paused = true; started.resolve(); await resume.promise; }
      return original(input);
    };
    const pending = f.service.snapshot(emptySearch);
    try {
      await started.promise;
      if (change === 'clear') f.work.writeAsset({ ...base, id: 'z', observations: { document_evidence: null } }, at + 1);
      else if (change === 'retire') f.work.writeAsset({ ...base, id: 'z', status: 'retired' }, at + 1);
      else if (change === 'delete') f.work.deleteAsset('z', { tombstone: true, now: at + 1 });
      else f.db.prepare("UPDATE data_asset SET sync_state='orphaned' WHERE id='z'").run();
    } finally { resume.resolve(); }
    const read = await pending;
    expect(read.proposals.map(row => row.subject?.id)).toEqual(['a']);
    expect((await f.annotations.listLinks({ from_collection: 'asset' })).map(row => row.from_id)).toEqual(['a']);
  });

  it('keeps the original last partial page boundary when an ineligible asset changes during an annotation await', async () => {
    const f = fixture(); f.observed('a'); f.plain('b');
    const started = gate(); const resume = gate(); let paused = false;
    const original = f.annotations.upsertLink!.bind(f.annotations);
    f.annotations.upsertLink = async input => {
      if (!paused) { paused = true; started.resolve(); await resume.promise; }
      return original(input);
    };
    const pending = f.service.snapshot(emptySearch);
    try { await started.promise; f.observed('b'); } finally { resume.resolve(); }
    expect((await pending).proposals.map(row => row.subject?.id)).toEqual(['a']);
    expect((await f.service.snapshot(emptySearch)).proposals.map(row => row.subject?.id).sort()).toEqual(['a', 'b']);
  });
});
