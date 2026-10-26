import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSET_SEARCH_TERMS, parseAssetSearchTerms, type AssetClassPreset, type ChatDispatchContext, type SituationQuery } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, WORK_ENTITY_FTS_TABLE, ASSET_SEARCH_TEXT_REINDEX_ID, type WorkEntityStore } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createAssetClassStore, type AssetClassStore } from '../situations/asset-classes.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createSituationQuery, type SituationReadContext } from '../situations/query.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { runWorkEntitySearchTool, type WorkEntityReadToolsDeps } from '../work-entity-read-tools.js';
import { createSituationAccess } from '../situations/access.js';
import { createSituationPrefetch } from '../situations/prefetch.js';
import { createContractStore } from '../storage/contract-store.js';
import { createSituationNamedPeople } from '../situations/named-people.js';
import type { EntityPromptPart, TurnContext } from '@recued/middleware';

const at = Date.parse('2026-10-25T12:00Z');
const trip = 'Plan my trip to London for 7–12 November 2026.';
const context: SituationReadContext = { owner: true, grants: {
  isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true,
} };
let db: Database.Database; let work: WorkEntityStore; let classes: AssetClassStore;
beforeEach(() => {
  db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  classes = createAssetClassStore(db);
});
afterEach(() => db.close());
const put = (id: string, class_id?: string, attributes: Record<string, unknown> = {}) => work.writeAsset({
  id, name: id === 'passport' ? 'Riley’s document' : id, class_id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' },
  dates: { expires_on: '2026-11-15' }, attributes,
}, at);
const sources = () => buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now: () => at, timeZone: () => 'UTC' });
const query = () => createSituationQuery({ sources: sources(), sourceForCollection: situationSourceAccess, now: () => at });
const input = (text: string): SituationQuery => ({ text, surface: 'prefetch', time: { from: at, to: at + 14 * 86_400_000 }, limit_clusters: 2, limit_items: 3 });
const ids = async (text: string, readContext = context) => (await query()(input(text), readContext)).clusters.flatMap(c => c.items.map(item => item.ref.id)).sort();
const custom = (id: string, terms: unknown, origin = 'owner'): AssetClassPreset => ({ id, name: id, version: 1, origin,
  fields: { dates: {}, readings: {}, observations: {}, settings: { [ASSET_SEARCH_TERMS]: terms } },
  rules: [], audience: 'owner', retirement: 'part',
});
const readDeps = (): WorkEntityReadToolsDeps => ({ getResolver: () => createWorkEntityResolver(work), getTargetedReadDeps: () => undefined,
  isVerbOpGranted: () => true, isCollectionReadGranted: () => true });
const dispatch: ChatDispatchContext = { channel: 'internal_function_call' };
const packet = async (text: string, named = false) => {
  const contacts = createContactStore(db);
  const run = createSituationQuery({ sources: sources(), sourceForCollection: situationSourceAccess, now: () => at,
    ...(named ? { namedPeople: createSituationNamedPeople(contacts) } : {}) });
  const access = createSituationAccess({ contracts: createContractStore(db, { now: () => at }), query: run, now: () => at, isVaultUnlocked: () => true });
  const parts: Omit<EntityPromptPart, 'source'>[] = [];
  await createSituationPrefetch({ getAccess: () => access }).prompt!({ source: { channel: 'chat', actor: 'user_self', user_id: 'local', chat_session_id: 'keyword-rank' },
    history: [{ role: 'user', text }], state: {}, prompt: { contribute: (part: Omit<EntityPromptPart, 'source'>) => { parts.push(part); } } } as unknown as TurnContext);
  return { rows: parts.flatMap(part => part.payload) as Array<{ ref: { id: string }; what: { verdict: string }; who: { verdict: string }; consequence: string }>,
    text: parts.map(part => part.render(part.payload)).join('\n') };
};

describe('Yours search keywords in existing metadata', () => {
  it('retrieves both travel documents for an ordinary trip prompt without naming them or changing asset facts', async () => {
    const passport = put('passport', 'passport'); const visa = put('entry-permission', 'visa'); put('boiler', 'boiler');
    const before = [work.readAsset(passport.id), work.readAsset(visa.id)];
    expect(await ids(trip)).toEqual(['entry-permission', 'passport']);
    expect(await ids('Explain how to bake bread.')).toEqual([]);
    expect([work.readAsset(passport.id), work.readAsset(visa.id)]).toEqual(before);
    const result = await runWorkEntitySearchTool(readDeps(), { kind: 'asset', query: 'trip' }, dispatch);
    expect(result).toMatchObject({ ok: true, result: { total: 2 } });
  });

  it('combines type defaults and instance additions and removes cleared instance terms from both paths', async () => {
    put('passport', 'passport', { [ASSET_SEARCH_TERMS]: ['Reunion', ' FAMILY   VISIT '] });
    expect(await ids('Plan a reunion.')).toEqual(['passport']);
    expect(work.searchIdsByText('asset', 'reunion travel', 10)).toEqual(['passport']);
    const q = query(); const request = input('Reunion');
    expect((await q(request, context)).clusters).toHaveLength(1);
    work.writeAsset({ id: 'passport', source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, attributes: { [ASSET_SEARCH_TERMS]: null } }, at + 1);
    expect((await q(request, context)).clusters).toEqual([]);
    expect(work.searchIdsByText('asset', 'reunion', 10)).toEqual([]);
    expect(await ids(trip)).toEqual(['passport']);
  });

  it('supports mixed name/keyword queries and holder/keyword searches without exposing unreadable holders', async () => {
    const contacts = createContactStore(db); const holder = contacts.upsertManual({ name: 'Maya Chen', email: 'maya@example.test' }, at);
    put('passport', 'passport');
    work.writeAsset({ id: 'passport', source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, holder_contact: holder.contact_id }, at + 1);
    const result = await query()({ ...input('Riley travel'), surface: 'tool' }, context);
    expect(result.clusters.flatMap(c => c.items.map(item => item.ref.id))).toEqual(['passport']);
    const scope = { limited: false, context, allows: () => true, cleanWork: <T,>(row: T) => row };
    const found = await runWorkEntitySearchTool({ ...readDeps(), personName: id => id === holder.contact_id ? 'Maya Chen' : undefined,
      getReadScope: () => scope as never }, { kind: 'asset', query: 'Maya travel' }, dispatch);
    expect(found).toMatchObject({ ok: true, result: { total: 1 } });
    const hidden = await runWorkEntitySearchTool(readDeps(), { kind: 'asset', query: 'Maya travel' }, dispatch);
    expect(hidden).toMatchObject({ ok: true, result: { total: 0 } });
  });

  it('applies type edits immediately to existing assets and reused query objects, without retaining copied settings', async () => {
    classes.saveOwner(custom('family_paper', ['reunion']), true); const asset = put('paper', 'family_paper');
    const q = query(); const request = input('Reunion');
    expect((await q(request, context)).clusters).toHaveLength(1);
    expect(work.searchIdsByText('asset', 'reunion', 10)).toEqual(['paper']);
    work.writeAsset({ id: asset.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, settings: { [ASSET_SEARCH_TERMS]: ['reunion'] } }, at + 1);
    const before = work.readAsset(asset.id);
    classes.saveOwner(custom('family_paper', ['gathering']));
    expect((await q(request, context)).clusters).toEqual([]);
    expect(await ids('Gathering')).toEqual(['paper']);
    expect(work.searchIdsByText('asset', 'reunion', 10)).toEqual([]);
    expect(work.searchIdsByText('asset', 'gathering', 10)).toEqual(['paper']);
    expect(work.readAsset(asset.id)).toEqual(before);
    classes.deleteOwner('family_paper');
    expect(await ids('Gathering')).toEqual([]); expect(work.searchIdsByText('asset', 'gathering', 10)).toEqual([]);
  });

  it('refreshes pack keywords on update and removes them on uninstall without deleting the assets', async () => {
    const pack = (version: number, terms: string[]) => ({ ...custom('pack_paper', terms, 'pack:author/papers'), version });
    classes.syncPack('author', 'papers', [pack(1, ['journey'])]); put('paper', 'pack_paper');
    expect(work.searchIdsByText('asset', 'journey', 10)).toEqual(['paper']);
    classes.syncPack('author', 'papers', [pack(2, ['voyage'])]);
    expect(await ids('Journey')).toEqual([]); expect(work.searchIdsByText('asset', 'journey', 10)).toEqual([]);
    expect(await ids('Voyage')).toEqual(['paper']);
    classes.removePack('papers');
    expect(work.searchIdsByText('asset', 'voyage', 10)).toEqual([]); expect(await ids('Voyage')).toEqual([]);
    expect(work.readAsset('paper')).not.toBeNull();
  });

  it('keeps keyword writes and derived index refresh atomic', () => {
    classes.saveOwner(custom('family_paper', ['reunion']), true); put('paper', 'family_paper');
    expect(() => db.transaction(() => { classes.saveOwner(custom('family_paper', ['gathering'])); throw new Error('rollback'); })()).toThrow('rollback');
    expect(work.searchIdsByText('asset', 'reunion', 10)).toEqual(['paper']);
    expect(work.searchIdsByText('asset', 'gathering', 10)).toEqual([]);
    expect(classes.get('family_paper')?.fields.settings[ASSET_SEARCH_TERMS]).toEqual(['reunion']);
  });

  it('backfills older indexes once and keeps future writes reachable', () => {
    put('passport', 'passport', { [ASSET_SEARCH_TERMS]: ['reunion'] });
    db.prepare(`DELETE FROM ${WORK_ENTITY_FTS_TABLE}`).run();
    // Leave another kind indexed: this must exercise the asset-only repair.
    work.writeNote({ source_id: 'recued.note', title: 'Keep the index populated', body: '' }, at);
    db.prepare('DELETE FROM data_repairs WHERE repair_id=?').run(ASSET_SEARCH_TEXT_REINDEX_ID);
    ensureWorkEntitySchema(db);
    expect(work.searchIdsByText('asset', 'reunion travel', 10)).toEqual(['passport']);
    db.prepare(`DELETE FROM ${WORK_ENTITY_FTS_TABLE} WHERE key=?`).run('asset.passport');
    ensureWorkEntitySchema(db); expect(work.searchIdsByText('asset', 'travel', 10)).toEqual([]);
    work.writeAsset({ id: 'passport', source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, name: 'Updated document' }, at + 1);
    expect(work.searchIdsByText('asset', 'reunion travel', 10)).toEqual(['passport']);
  });

  it('honours grants and sphere fences before returning keyword matches or counts', async () => {
    put('passport', 'passport');
    work.writeAsset({ id: 'passport', source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, sphere: 'personal' }, at + 1);
    const inventory = sources(); const assetSource = inventory.find(s => s.collection === 'asset')!; const read = vi.spyOn(assetSource, 'read');
    const q = createSituationQuery({ sources: inventory, sourceForCollection: situationSourceAccess, now: () => at });
    const denied = { ...context, grants: { ...context.grants, isCollectionReadGranted: (name: string) => name !== 'asset' } };
    expect((await q(input(trip), denied)).clusters).toEqual([]); expect(read).not.toHaveBeenCalled();
    expect((await q(input(trip), { ...context, owner: false, spheres: ['professional'] })).clusters).toEqual([]);
    expect((await q(input(trip), { ...context, owner: false, spheres: ['personal'] })).clusters).toHaveLength(1);
    expect(await runWorkEntitySearchTool({ ...readDeps(), isCollectionReadGranted: () => false }, { kind: 'asset', query: 'travel' }, dispatch))
      .toMatchObject({ ok: true, result: { entities: [], total: 0 } });
  });

  it('keeps indexed and full-source prefetch selection identical, within existing item limits', async () => {
    for (let i = 0; i < 7; i++) put(`document-${i}`, i % 2 ? 'passport' : 'visa');
    const indexed = sources(); const scanned = indexed.map(({ index: _index, ...source }) => source);
    const a = createSituationQuery({ sources: indexed, sourceForCollection: situationSourceAccess, now: () => at });
    const b = createSituationQuery({ sources: scanned, sourceForCollection: situationSourceAccess, now: () => at });
    expect(await a(input(trip), context)).toEqual(await b(input(trip), context));
    expect((await a(input(trip), context)).clusters.flatMap(c => c.items).length).toBeLessThanOrEqual(3);
  });

  it('bounds and validates metadata while retaining ordinary descriptive attributes', () => {
    expect(parseAssetSearchTerms(' Travel, TRAVEL, family   visit\nholiday ')).toEqual(['travel', 'family visit', 'holiday']);
    for (const value of [true, { query: 'trip' }, Array(33).fill('trip'), ['x'.repeat(81)]]) {
      expect(() => put('invalid', undefined, { [ASSET_SEARCH_TERMS]: value })).toThrow(/search/i);
      expect(() => classes.saveOwner(custom('invalid_type', value), true)).toThrow(/search/i);
    }
    put('unclassified', undefined, { [ASSET_SEARCH_TERMS]: 'reunion, travel', notes: 'Blue folder' });
    expect(work.searchIdsByText('asset', 'reunion', 10)).toEqual(['unclassified']);
    expect(work.searchIdsByText('asset', 'blue', 10)).toEqual(['unclassified']);
  });

  it('ranks an actual name ahead of newer keyword-only hits before the prefetch cap', async () => {
    put('passport', 'passport');
    for (let i = 0; i < 5; i++) {
      const record = put(`keyword-${i}`, 'passport', { [ASSET_SEARCH_TERMS]: ['riley', 'document', 'trip', 'london', 'plan'] });
      work.writeAsset({ id: record.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, name: `Folder ${i}` }, at + i + 1);
    }
    const found = await query()(input('Find Riley’s document'), context);
    expect(found.clusters[0]?.items[0]?.ref.id).toBe('passport');
  });

  it('keeps direct-name items ahead of keyword-only groups when the rendered block fills', async () => {
    const parent = put('equipment', undefined);
    for (const name of ['equipment alpha', 'equipment beta']) {
      const record = put(name, undefined);
      work.writeAsset({ id: record.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, belongs_to: parent.id }, at);
    }
    put('unrelated-folder', undefined, { [ASSET_SEARCH_TERMS]: ['equipment'] });
    const result = await packet('Equipment');
    expect(result.rows.map(row => row.ref.id).sort()).toEqual(['equipment', 'equipment alpha', 'equipment beta']);
  });

  it('reports keyword matches as matching rather than outside', async () => {
    put('passport', 'passport');
    const result = await packet(trip);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.what.verdict).toBe('match');
  });

  it('keeps floor clocks ahead of ordinary names even when the clock is found through a keyword', async () => {
    put('equipment', undefined);
    put('alarm', undefined, { [ASSET_SEARCH_TERMS]: ['equipment'] });
    work.writeAsset({ id: 'alarm', source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' },
      observations: { fault: { active: true, certainty: 'confirmed', as_of: at, evidence: [], source: 'owner' } },
      rules: [{ id: 'fault', title: 'Inspect alarm', enabled: true, muted: false, pinned: false, consequence: 'floor', expiry_policy: 'escalate_overdue',
        when: { kind: 'condition', field: 'fault', certainty: 'confirmed' }, reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [], on_day: true } }] }, at);
    expect((await packet('Equipment')).rows[0]?.ref.id).toBe('alarm');
  });

  it('ranks an explicitly named holder ahead of misleading name and keyword hits', async () => {
    const contacts = createContactStore(db); const maya = contacts.upsertManual({ name: 'Maya Chen', email: 'maya@example.test' }, at);
    const actual = put('primary-paper', 'passport');
    work.writeAsset({ id: actual.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, holder_contact: maya.contact_id }, at);
    for (const name of ['Maya travel alpha', 'Maya travel beta', 'Maya travel gamma']) put(name, 'passport');
    const result = await packet('Maya travel', true);
    expect(result.rows[0]?.ref.id).toBe('primary-paper');
    expect(result.rows[0]?.who.verdict).toBe('match');
  });

  it('does not turn a document holder into the speaker identity for an I/my request', async () => {
    const contacts = createContactStore(db); const riley = contacts.upsertManual({ name: 'Riley Quinn', email: 'riley@example.test' }, at);
    const asset = put('passport', 'passport');
    work.writeAsset({ id: asset.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, holder_contact: riley.contact_id }, at);
    const result = await packet('Plan my trip', true);
    expect(result.rows[0]?.who.verdict).toBe('unknown');
    expect(result.text).toContain('does not identify the speaker');
  });

  it('keeps explicit search newest-first before limiting regardless of additional keyword length or frequency', () => {
    put('older', 'passport');
    put('newer', 'passport', { [ASSET_SEARCH_TERMS]: Array.from({ length: 30 }, (_, i) => `unused${i}`) });
    work.writeAsset({ id: 'newer', source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' }, name: 'Document' }, at + 1);
    expect(work.searchIdsByText('asset', 'trip', 1)).toEqual(['newer']);
    put('a-tie', 'passport'); put('z-tie', 'passport', { [ASSET_SEARCH_TERMS]: ['trip'] });
    expect(work.searchIdsByText('asset', 'trip', 10)).toEqual(['newer', 'a-tie', 'older', 'z-tie']);
  });

  it('does not increase prefetch rank for duplicate or nonmatching additional keywords', async () => {
    put('a-paper', 'passport'); put('z-paper', 'passport');
    const run = query(); const request = input('Plan my trip');
    const order = async () => (await run(request, context)).clusters.flatMap(c => c.items.map(item => item.ref.id));
    const before = await order();
    work.writeAsset({ id: 'z-paper', source_id: 'recued.asset', source: { kind: 'owner', ref: 'test' },
      attributes: { [ASSET_SEARCH_TERMS]: ['trip', 'TRIP', ...Array.from({ length: 28 }, (_, i) => `unrelated${i}`)] } }, at);
    expect(await order()).toEqual(before);
  });

  it('uses distinct query matches to prefer a destination hint within the keyword tier', async () => {
    put('a-paper', 'visa'); put('z-paper', 'visa', { [ASSET_SEARCH_TERMS]: ['London'] });
    const found = await query()(input('London trip'), context);
    expect(found.clusters[0]?.items[0]?.ref.id).toBe('z-paper');
  });
});
