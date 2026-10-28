/** D-325 (2026-10-25) — `work.update` of an `asset`, and the ranks an AI's asset writes
 *  land at. The owner's ruling, "readings mine, rest AI's": a reading the owner approves
 *  is their own sample, at their rank, so it replaces one they typed. A name, a date, a
 *  detail or a place keeps the AI's rank: an AI fills an empty field or replaces what an
 *  AI wrote, and where the owner set the value it is refused before they are asked.
 *
 *  ⛔ DRIVEN ON THE REAL STORE AND DISPATCHERS. Which source holds a field is the store's
 *  decision (`writeAsset`), so a double at the dispatcher would test the handler's guess
 *  at it. Each refusal checks that nothing was written. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelAdapter } from '@recued/ingredients';
import {
  ASSET_SEARCH_TERMS, ownerApprovesCallsOf, qualifyWorkEntityId, RECUED_BUILTIN_SOURCE_ID, type Asset, type AssetRule, type ExecutionSource,
} from '@recued/contracts';
import {
  ASSET_CREATE_OP_ID, ASSET_UPDATE_OP_ID, buildChatTier1Handlers, buildChatToolRegistryInputs, checkWorkUpdate, type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type AssetWriteInput } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createContactStore } from '../storage/contact-store.js';
import { assetTypes } from '../situations/asset-types.js';
import { runWorkEntitySearchTool } from '../work-entity-read-tools.js';
import { createSituationQuery } from '../situations/query.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createReminderStore } from '../storage/reminder-store.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const door: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call-1',
  mcp_token_id: 'tok-1', contract_id: 'door-1' };
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner } as never;
/** What the server sets once the owner approved the call (an ask, or a standing rule). */
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true } as never;
const overMcp = { channel: 'mcp_wire', mcp_token_id: 'tok-1', execution_source: door, owner_approved: true } as never;

type Ok = { ok: true; result: Record<string, unknown> };
type Refused = { ok: false; reason: string; detail: string };

const NOW = Date.parse('2026-10-25T09:30:00Z');
const DAY = 86_400_000;

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = (granted: readonly string[] = [ASSET_CREATE_OP_ID, ASSET_UPDATE_OP_ID]) => {
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW, assetTypes: assetTypes(db) });
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false,
      isOpGranted: (_source: ExecutionSource, op?: string) => op !== undefined && granted.includes(op) }),
    getAssetTypes: () => assetTypes(db),
    getContactStore: () => createContactStore(db),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  /** An asset as the owner keeps it in Yours: every fact at their own rank. */
  const ownersAsset = (input: Omit<AssetWriteInput, 'source' | 'source_id'>): Asset => store.writeAsset({
    ...input, source_id: RECUED_BUILTIN_SOURCE_ID('asset'), source: { kind: 'owner', ref: 'owner:user-1' } }, NOW - DAY);
  /** One an AI added from a chat, at its own rank. */
  const aisAsset = async (args: Record<string, unknown>): Promise<Asset> => {
    const res = await handlers['work.create']!({ kind: 'asset', ...args }, inChat) as Ok;
    return store.readAsset(res.result.id as string)!;
  };
  return { store, dispatchers, deps, ownersAsset, aisAsset, create: handlers['work.create']!, update: handlers['work.update']! };
};
const odometer = (value: number, unit = 'km', as_of = NOW - DAY) => ({ value, unit, as_of, evidence: [] });

describe('work.update — a thing the user owns', () => {
  it('lets AI replace user-entered keywords, then the user replace them again, without changing other facts', async () => {
    const f = harness();
    const paper = f.ownersAsset({ name: 'Family paper', class_id: 'visa', dates: { expires_on: '2027-01-01' },
      attributes: { [ASSET_SEARCH_TERMS]: ['reunion'], colour: 'blue' } });
    const change = { kind: 'asset', id: paper.id, attributes: { [ASSET_SEARCH_TERMS]: ['Family visit', 'LONDON', 'London'] } };
    expect(await checkWorkUpdate(f.deps, change, inChat)).toBeNull();
    expect(f.store.readAsset(paper.id)).toEqual(paper);
    expect(f.store.searchIdsByText('asset', 'reunion', 10)).toEqual([paper.id]);
    expect(f.store.searchIdsByText('asset', 'london', 10)).toEqual([]);
    expect(await f.update(change, approved)).toMatchObject({ ok: true, result: { fields: ['attributes'] } });
    const updated = f.store.readAsset(paper.id)!;
    expect(updated.attributes).toEqual({ [ASSET_SEARCH_TERMS]: ['family visit', 'london'], colour: 'blue' });
    expect(updated.field_sources[`attributes.${ASSET_SEARCH_TERMS}`]).toMatchObject({ kind: 'extracted', ref: 'chat:sess-1' });
    expect(updated.dates).toEqual(paper.dates);
    expect(updated.rules).toEqual(paper.rules);
    expect(updated.field_sources['attributes.colour']).toEqual(paper.field_sources['attributes.colour']);
    expect(f.store.searchIdsByText('asset', 'reunion', 10)).toEqual([]);
    expect(f.store.searchIdsByText('asset', 'london', 10)).toEqual([paper.id]);
    const query = createSituationQuery({ sources: buildSituationSources({ db, work: f.store, reminders: createReminderStore(db),
      calendars: () => [], now: () => NOW, timeZone: () => 'UTC' }), sourceForCollection: situationSourceAccess, now: () => NOW });
    const result = await query({ text: 'Plan a London visit', surface: 'prefetch', time: NOW }, { owner: true, grants: {
      isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true,
    } });
    expect(result.clusters.flatMap(cluster => cluster.items.map(item => item.ref.id))).toContain(paper.id);
    f.store.writeAsset({ id: paper.id, source_id: paper.source_id, source: { kind: 'owner', ref: 'owner:user-1' },
      attributes: { [ASSET_SEARCH_TERMS]: ['gathering'] } }, NOW + 1);
    expect(f.store.searchIdsByText('asset', 'london', 10)).toEqual([]);
    expect(f.store.searchIdsByText('asset', 'gathering', 10)).toEqual([paper.id]);
  });

  it('accepts comma-separated keywords and clears only the additions, preserving type defaults', async () => {
    const f = harness();
    const paper = f.ownersAsset({ name: 'Family paper', class_id: 'visa', attributes: { [ASSET_SEARCH_TERMS]: ['reunion'] } });
    expect(await f.update({ kind: 'asset', id: paper.id, attributes: { search_terms: ' LONDON, family  visit, london ' } }, approved))
      .toMatchObject({ ok: true });
    expect(f.store.readAsset(paper.id)!.attributes.search_terms).toEqual(['london', 'family visit']);
    expect(await f.update({ kind: 'asset', id: paper.id, attributes: { search_terms: null } }, approved)).toMatchObject({ ok: true });
    expect(f.store.searchIdsByText('asset', 'london', 10)).toEqual([]);
    expect(f.store.searchIdsByText('asset', 'trip', 10)).toEqual([paper.id]);
    expect(f.store.readAsset(paper.id)!.attributes.search_terms).toBeNull();
  });

  it('adds keyword arrays when AI creates an asset and allows later removal through MCP', async () => {
    const f = harness();
    const response = await f.create({ kind: 'asset', title: 'Family folder', attributes: { search_terms: ['REUNION', 'reunion'] } }, approved) as Ok;
    expect(response.ok).toBe(true);
    const id = response.result.id as string;
    expect(f.store.readAsset(id)!.attributes.search_terms).toEqual(['reunion']);
    expect(await f.update({ kind: 'asset', id, attributes: { search_terms: [] } }, overMcp)).toMatchObject({ ok: true });
    expect(f.store.searchIdsByText('asset', 'reunion', 10)).toEqual([]);
    expect(f.store.readAsset(id)!.field_sources['attributes.search_terms']).toMatchObject({ kind: 'extracted', ref: 'mcp:tok-1' });
  });

  it('keeps keyword edits atomic with held facts and rejects malformed or oversized hints', async () => {
    const f = harness();
    const paper = f.ownersAsset({ name: 'Family paper', attributes: { search_terms: ['reunion'], colour: 'blue' } });
    const mixed = { kind: 'asset', id: paper.id, attributes: { search_terms: ['london'], colour: 'red' } };
    expect(await checkWorkUpdate(f.deps, mixed, inChat)).toMatchObject({ ok: false, detail: expect.stringContaining('`colour`') });
    expect(await f.update(mixed, approved)).toMatchObject({ ok: false });
    for (const bad of [true, 4, { word: 'trip' }, ['x'.repeat(81)], Array(33).fill('trip'), 'x'.repeat(2049)]) {
      expect(await f.update({ kind: 'asset', id: paper.id, attributes: { search_terms: bad } }, approved)).toMatchObject({ ok: false, reason: 'invalid_args' });
    }
    expect(await f.update({ kind: 'asset', id: paper.id, attributes: { other: ['trip'] } }, approved)).toMatchObject({ ok: false });
    expect(f.store.readAsset(paper.id)).toEqual(paper);
    expect(f.store.searchIdsByText('asset', 'london', 10)).toEqual([]);
  });

  it('requires the existing asset update grant for keyword-only edits', async () => {
    const f = harness([]); const paper = f.ownersAsset({ name: 'Family paper', attributes: { search_terms: ['reunion'] } });
    const change = { kind: 'asset', id: paper.id, attributes: { search_terms: ['london'] } };
    expect(await checkWorkUpdate(f.deps, change, inChat)).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(await f.update(change, approved)).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(f.store.readAsset(paper.id)).toEqual(paper);
  });

  it('changes what an AI wrote down: its name, details, note and place, at the AI\'s rank', async () => {
    const f = harness();
    const bike = await f.aisAsset({ title: 'Road bike', attributes: { brand: 'Trek', colour: 'blue' }, place: 'the garage' });
    // A serial number read from a receipt is not the bike's place, and stays.
    f.store.writeAsset({ id: bike.id, source_id: bike.source_id, source: { kind: 'extracted', ref: 'mail:receipt-1' },
      anchors: [...bike.anchors, { kind: 'identifier', scheme: 'serial', value: 'WTU123' }] }, NOW);
    const res = await f.update({ kind: 'asset', id: bike.id, title: 'Trek Domane',
      attributes: { colour: 'red', 'Frame size': '56 cm', brand: null }, body: 'Serviced in May.', place: 'the shed' }, inChat) as Ok;
    expect(res).toEqual({ ok: true, result: { updated: true, kind: 'asset', id: bike.id, fields: ['title', 'attributes', 'body', 'place'] } });
    const after = f.store.readAsset(bike.id)!;
    expect(after).toMatchObject({ name: 'Trek Domane',
      attributes: { brand: null, colour: 'red', frame_size: '56 cm', note: 'Serviced in May.' },
      anchors: [{ kind: 'identifier', scheme: 'serial', value: 'WTU123' }, { kind: 'place', name: 'the shed' }] });
    for (const path of ['name', 'attributes.colour', 'attributes.frame_size', 'attributes.note', 'anchors']) {
      expect(after.field_sources[path], path).toMatchObject({ kind: 'extracted', ref: 'chat:sess-1' });
    }
  });

  it('adds to what the owner entered, and refuses to change it, before they are asked and when it runs', async () => {
    const f = harness();
    const bike = f.ownersAsset({ name: 'Road bike', attributes: { brand: 'Trek' }, anchors: [{ kind: 'place', name: 'the garage' }] });
    const change = { kind: 'asset', id: bike.id, title: 'Trek Domane', attributes: { brand: 'Specialized', colour: 'blue' }, place: 'the shed' };
    const says = 'work.update: the user set its name, where it is kept and `brand` themselves, so an AI may not change them. '
      + 'Tell the user why, and that they can change them in Yours. Leave them out to change the rest';
    expect(await checkWorkUpdate(f.deps, change, inChat)).toEqual({ ok: false, reason: 'invalid_args', detail: says });
    expect(await f.update(change, approved)).toEqual({ ok: false, reason: 'invalid_args', detail: says });
    expect(f.store.readAsset(bike.id)).toEqual(bike);
    // A new detail is the AI's to add; the owner's own stay as they are.
    expect(await f.update({ kind: 'asset', id: bike.id, attributes: { colour: 'blue', brand: 'Trek' } }, approved)).toMatchObject({ ok: true });
    expect(f.store.readAsset(bike.id)).toMatchObject({ name: 'Road bike', attributes: { brand: 'Trek', colour: 'blue' } });
    expect(f.store.readAsset(bike.id)!.field_sources['attributes.brand']).toMatchObject({ kind: 'owner' });
  });

  it('names each source that holds a field it cannot change', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car', class_id: 'vehicle', dates: { legal_check_on: null, last_serviced_on: null },
      readings: { odometer: null } });
    f.store.writeAsset({ id: car.id, source_id: car.source_id, source: { kind: 'confirmed_document', ref: 'file:mot-1' },
      dates: { legal_check_on: '2027-01-31' } }, NOW);
    const res = await checkWorkUpdate(f.deps, { kind: 'asset', id: car.id, title: 'Our car', dates: { legal_check_on: '2027-02-28' } }, inChat);
    expect(res).toMatchObject({ detail: 'work.update: the user set its name themselves and `legal_check_on` comes from a document '
      + 'the user confirmed, so an AI may not change them. Tell the user why, and that they can change them in Yours. '
      + 'Leave them out to change the rest' });
  });

  it('records an approved reading as the owner\'s own sample, which replaces one they typed', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car', class_id: 'vehicle', readings: { odometer: odometer(10_000) } });
    const reading = { kind: 'asset', id: car.id, readings: { odometer: { value: 12_400, unit: 'km' } } };
    // Asked first: the write runs only once the owner approves it, as their sample.
    expect(await checkWorkUpdate(f.deps, reading, inChat)).toBeNull();
    // Unapproved, it is the AI's, which never replaces the owner's.
    expect(await f.update(reading, inChat)).toMatchObject({ ok: false,
      detail: expect.stringContaining('the user set `odometer` themselves, so an AI may not change it') });
    expect(f.store.readAsset(car.id)).toEqual(car);
    expect(await f.update(reading, approved)).toMatchObject({ ok: true, result: { fields: ['readings'] } });
    const after = f.store.readAsset(car.id)!;
    expect(after.readings.odometer).toEqual({ value: 12_400, unit: 'km', as_of: NOW, evidence: [] });
    expect(after.field_sources['readings.odometer']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1', revision: expect.any(String) });
    expect(f.store.assetReadingHistory(car.id, 'odometer').map(row => row.value).sort()).toEqual([10_000, 12_400]);
  });

  it('checks a household member\'s chat as its write will run: their yes is not the owner\'s', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car', class_id: 'vehicle', readings: { odometer: odometer(10_000) } });
    const member = { channel: 'internal_function_call', session_id: 'sess-2', execution_source: {
      channel: 'chat', actor: 'contracted_user', chat_session_id: 'chat-2', user_id: 'member-1', contract_id: 'k-house' } } as never;
    // ⚠ The AI passes the reason on, so it must be true of the member: the owner set it (2026-10-27).
    expect(await checkWorkUpdate(f.deps, { kind: 'asset', id: car.id, readings: { odometer: { value: 12_400, unit: 'km' } } }, member))
      .toMatchObject({ detail: 'work.update: the owner set `odometer` themselves, so an AI may not change it. '
        + 'Tell the user why, and that the owner can change it in Yours. Leave it out to change the rest' });
  });

  it('tells an AI app that the owner set a value, since its user may not be the owner', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car', class_id: 'vehicle', anchors: [{ kind: 'place', name: 'the driveway' }] });
    f.store.writeAsset({ id: car.id, source_id: car.source_id, source: { kind: 'confirmed_document', ref: 'file:mot-1' },
      dates: { legal_check_on: '2027-01-31' } }, NOW);
    expect(await f.update({ kind: 'asset', id: car.id, place: 'the street', dates: { legal_check_on: '2027-02-28' } }, overMcp))
      .toMatchObject({ detail: 'work.update: the owner set where it is kept themselves and `legal_check_on` comes from a '
        + 'document the owner confirmed, so an AI may not change them. Tell the user why, and that the owner can change them '
        + 'in Yours. Leave them out to change the rest' });
  });

  it('records an AI app\'s approved reading under its own token', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car', class_id: 'vehicle', readings: { odometer: null } });
    expect(await f.update({ kind: 'asset', id: car.id, readings: { odometer: { value: 900, unit: 'km' } } }, overMcp)).toMatchObject({ ok: true });
    expect(f.store.readAsset(car.id)!.field_sources['readings.odometer']).toMatchObject({ kind: 'owner', ref: 'mcp:tok-1' });
  });

  it('keeps a reading in the unit it is read in', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car', class_id: 'vehicle', readings: { odometer: odometer(10_000) } });
    expect(await f.update({ kind: 'asset', id: car.id, readings: { odometer: { value: 7_700, unit: 'mi' } } }, approved))
      .toMatchObject({ detail: 'work.update: `odometer` is read in `km`, not `mi`. Convert the reading, or ask the user' });
    // With no reading yet, a reminder that reads it says the unit; two that disagree stop it.
    const rule = (id: string, unit: string): AssetRule => ({ id, title: id, enabled: true, muted: false, pinned: false, consequence: 'routine',
      expiry_policy: 'strict_expire', when: { kind: 'objective', field: 'usage', target: 500, unit, direction: 'rising', mode: 'usage', lead_days: 0 },
      reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [], on_day: true } });
    const meter = f.ownersAsset({ name: 'Meter', readings: { usage: null }, rules: [rule('cap', 'kWh')] });
    expect(await f.update({ kind: 'asset', id: meter.id, readings: { usage: { value: 1, unit: 'Wh' } } }, approved))
      .toMatchObject({ detail: expect.stringContaining('`usage` is read in `kWh`, not `Wh`') });
    const split = f.ownersAsset({ name: 'Split meter', readings: { usage: null }, rules: [rule('cap', 'kWh'), rule('peak', 'Wh')] });
    expect(await f.update({ kind: 'asset', id: split.id, readings: { usage: { value: 1, unit: 'kWh' } } }, approved))
      .toMatchObject({ detail: expect.stringContaining('the reminders on `usage` read it in different units') });
    expect(f.store.readAsset(split.id)).toEqual(split);
  });

  it('keeps to the dates and readings the asset has', async () => {
    const f = harness();
    const bike = await f.aisAsset({ title: 'Road bike' });
    expect(await f.update({ kind: 'asset', id: bike.id, dates: { last_serviced_on: '2026-05-01' } }, approved)).toMatchObject({
      detail: 'work.update: `Road bike` keeps no dates, not `last_serviced_on`. The user can add the field in Yours' });
    const car = await f.aisAsset({ type: 'vehicle', title: 'Family car' });
    expect(await f.update({ kind: 'asset', id: car.id, readings: { mileage: { value: 1, unit: 'km' } } }, approved))
      .toMatchObject({ detail: expect.stringContaining('`Family car` keeps the readings `odometer`, not `mileage`') });
    expect(await f.update({ kind: 'asset', id: car.id, dates: { legal_check_on: '31/01/2027' } }, approved))
      .toMatchObject({ detail: 'work.update: `dates.legal_check_on` must be a date as YYYY-MM-DD' });
    expect(await f.update({ kind: 'asset', id: car.id, dates: { legal_check_on: '2027-01-31' } }, approved)).toMatchObject({ ok: true });
    expect(f.store.readAsset(car.id)!.dates.legal_check_on).toBe('2027-01-31');
    expect(f.store.readAsset(car.id)!.field_sources['dates.legal_check_on']).toMatchObject({ kind: 'extracted' });
  });

  it('answers a check before asking: what the write would refuse, a change that changes nothing, or that it would run', async () => {
    const f = harness();
    const bike = await f.aisAsset({ title: 'Road bike', attributes: { colour: 'blue' } });
    expect(await checkWorkUpdate(f.deps, { kind: 'asset', id: bike.id, attributes: { colour: 'red' } }, inChat)).toBeNull();
    expect(await checkWorkUpdate(f.deps, { kind: 'asset', id: bike.id, attributes: { colour: 'blue' } }, inChat))
      .toMatchObject({ detail: 'work.update: `Road bike` already says that, so nothing would change' });
    expect(await checkWorkUpdate(f.deps, { kind: 'asset', id: 'no-such-asset', title: 'x' }, inChat))
      .toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(f.store.readAsset(bike.id)).toEqual(bike);
    // Another kind's own checks answer first too.
    expect(await checkWorkUpdate(f.deps, { kind: 'task', id: 'task-1', done: true, title: 'x' }, inChat))
      .toMatchObject({ detail: expect.stringContaining('send `done` on its own') });
  });

  it('is the check the registry runs before the owner is asked, as production wires it', async () => {
    const f = harness();
    const bike = f.ownersAsset({ name: 'Road bike' });
    const check = buildChatToolRegistryInputs(f.deps).tier1Checks['work.update']!;
    expect(await check({ kind: 'asset', id: bike.id, title: 'Trek' }, inChat))
      .toMatchObject({ ok: false, detail: expect.stringContaining('the user set its name themselves') });
    expect(await check({ kind: 'asset', id: bike.id, attributes: { colour: 'blue' } }, inChat)).toBeNull();
  });

  it('refuses what an asset has no place for, a change of nothing, and the asset arguments on another kind', async () => {
    const f = harness();
    const bike = await f.aisAsset({ title: 'Road bike' });
    for (const [args, says] of [
      [{ done: true }, 'an asset takes `title`, `body`, `dates`, `readings`, `attributes`, `place` and `belongs_to`, not `done`'],
      [{}, 'send at least one change to the asset'],
      [{ attributes: { colour: null } }, '`Road bike` has no attribute `colour` to remove'],
      [{ title: ' ' }, '`title` is the asset\'s new name'],
      [{ place: '' }, '`place` says where it is kept'],
    ] as const) {
      expect((await f.update({ kind: 'asset', id: bike.id, ...args }, approved) as Refused).detail).toContain(says);
    }
    expect(f.store.readAsset(bike.id)).toEqual(bike);
    expect(await f.update({ kind: 'task', id: 'task-1', readings: { odometer: { value: 1, unit: 'km' } } }, approved))
      .toMatchObject({ detail: 'work.update: `readings` applies to an asset only' });
  });

  it('is the asset update switch\'s to allow', async () => {
    const f = harness([ASSET_CREATE_OP_ID]);
    const bike = await f.aisAsset({ title: 'Road bike' });
    expect(await f.update({ kind: 'asset', id: bike.id, title: 'Trek' }, approved)).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(f.store.readAsset(bike.id)).toEqual(bike);
  });
});

describe('what a thing belongs to', () => {
  it('a new thing joins the one it is part of, by the id a search gave, and is kept where that is', async () => {
    const f = harness();
    const bike = await f.aisAsset({ title: 'Road bike', place: 'the garage' });
    const lock = await f.aisAsset({ title: 'Bike lock',
      belongs_to: qualifyWorkEntityId({ kind: 'asset', source_id: bike.source_id, local_id: bike.id }) });
    expect(lock.belongs_to).toBe(bike.id);
    expect(lock.field_sources.belongs_to).toMatchObject({ kind: 'extracted', ref: 'chat:sess-1' });
    expect(f.store.readAssetEffective(lock.id)!.anchors).toEqual([{ kind: 'place', name: 'the garage' }]);
  });

  it('an update ties a thing to another, never to itself or to its own part, and writes nothing it refuses', async () => {
    const f = harness();
    const bike = await f.aisAsset({ title: 'Road bike' });
    const lock = await f.aisAsset({ title: 'Bike lock' });
    expect(await f.update({ kind: 'asset', id: lock.id, belongs_to: bike.id }, approved))
      .toMatchObject({ ok: true, result: { fields: ['belongs_to'] } });
    expect(f.store.readAsset(lock.id)!.belongs_to).toBe(bike.id);
    const before = f.store.readAsset(bike.id);
    for (const [args, says] of [
      [{ id: bike.id, belongs_to: lock.id }, 'work.update: belongs_to would create a cycle'],
      [{ id: lock.id, belongs_to: lock.id }, 'work.update: a thing cannot belong to itself'],
      [{ id: lock.id, belongs_to: 'no-such-asset' }, 'work.update: `belongs_to` names no thing they own'],
      [{ id: lock.id, belongs_to: ' ' }, '`belongs_to` is the id of another thing they own'],
    ] as const) {
      expect((await checkWorkUpdate(f.deps, { kind: 'asset', ...args }, inChat) as Refused).detail).toContain(says);
      expect((await f.update({ kind: 'asset', ...args }, approved) as Refused).detail).toContain(says);
    }
    expect(f.store.readAsset(bike.id)).toEqual(before);
  });

  it('a tie the owner made is theirs to change', async () => {
    const f = harness();
    const laptop = f.ownersAsset({ name: 'Laptop' });
    const desk = f.ownersAsset({ name: 'Desk' });
    const charger = f.ownersAsset({ name: 'Charger', belongs_to: laptop.id });
    expect(await f.update({ kind: 'asset', id: charger.id, belongs_to: desk.id }, approved)).toMatchObject({
      detail: 'work.update: the user set what it belongs to themselves, so an AI may not change it. '
        + 'Tell the user why, and that they can change it in Yours. Leave it out to change the rest' });
    expect(f.store.readAsset(charger.id)).toEqual(charger);
  });

  it('is an asset\'s alone, as are its other arguments', async () => {
    const f = harness([ASSET_CREATE_OP_ID, ASSET_UPDATE_OP_ID, 'core.work-entity.task.create']);
    const bike = await f.aisAsset({ title: 'Road bike' });
    for (const name of ['belongs_to', 'attributes', 'place', 'readings'] as const) {
      expect(await f.create({ kind: 'task', title: 'Oil the chain', [name]: name === 'belongs_to' ? bike.id : name === 'place' ? 'the garage' : {} }, inChat))
        .toEqual({ ok: false, reason: 'invalid_args', detail: `work.create: \`${name}\` applies to an asset only` });
    }
    expect(await f.update({ kind: 'task', id: 'task-1', belongs_to: bike.id }, approved))
      .toMatchObject({ detail: 'work.update: `belongs_to` applies to an asset only' });
  });
});

describe('work.search finds a thing by what it shares with others', () => {
  const search = async (f: ReturnType<typeof harness>, query: string): Promise<string[]> => {
    const res = await runWorkEntitySearchTool({ getResolver: () => createWorkEntityResolver(f.store), getTargetedReadDeps: () => undefined,
      isCollectionReadGranted: () => true, isVerbOpGranted: () => true }, { kind: 'asset', query }, inChat) as Ok;
    return (res.result.entities as Array<{ title: string }>).map((entity) => entity.title).sort();
  };

  it('by where it is kept, and where it was moved to', async () => {
    // ⛔ Live (2026-10-25): "What do I keep in the garage?" — `work.search(asset, "garage")` found nothing.
    const f = harness();
    const bike = await f.aisAsset({ title: 'Road bike', place: 'the garage' });
    await f.aisAsset({ title: 'Lawn mower', place: 'the garage' });
    await f.aisAsset({ title: 'Laptop', place: 'the study' });
    expect(await search(f, 'garage')).toEqual(['Lawn mower', 'Road bike']);
    await f.update({ kind: 'asset', id: bike.id, place: 'the shed' }, approved);
    expect(await search(f, 'garage')).toEqual(['Lawn mower']);
    expect(await search(f, 'shed')).toEqual(['Road bike']);
  });

  it('by a detail or an identifier two things share', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car', anchors: [{ kind: 'identifier', scheme: 'vin', value: 'WVW123' }] });
    f.ownersAsset({ name: 'Car insurance', belongs_to: car.id, anchors: [{ kind: 'identifier', scheme: 'vin', value: 'WVW123' }] });
    await f.aisAsset({ title: 'Road bike', attributes: { brand: 'Trek' } });
    await f.aisAsset({ title: 'Kids bike', attributes: { brand: 'Trek' } });
    expect(await search(f, 'WVW123')).toEqual(['Car insurance', 'Family car']);
    expect(await search(f, 'Trek')).toEqual(['Kids bike', 'Road bike']);
  });
});

describe('the names a held work call is asked about with', () => {
  // ⛔ Live (2026-10-25): an approved reading was put to the owner as "id: we1:asset:…e1a798e8…".
  const askLabels = (f: ReturnType<typeof harness>, tool: 'work.create' | 'work.update', args: Record<string, unknown>) =>
    buildChatToolRegistryInputs(f.deps).tier1AskLabels[tool](args);

  it('names the thing an update changes, by a local id or the one a search gave, and the thing it belongs to', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car' });
    const searched = qualifyWorkEntityId({ kind: 'asset', source_id: car.source_id, local_id: car.id });
    expect(await askLabels(f, 'work.update', { kind: 'asset', id: car.id, readings: {} })).toEqual({ id: { [car.id]: 'Family car' } });
    expect(await askLabels(f, 'work.update', { kind: 'asset', id: searched })).toEqual({ id: { [searched]: 'Family car' } });
    const lock = f.ownersAsset({ name: 'Bike lock' });
    expect(await askLabels(f, 'work.update', { kind: 'asset', id: lock.id, belongs_to: searched }))
      .toEqual({ id: { [lock.id]: 'Bike lock' }, belongs_to: { [searched]: 'Family car' } });
    expect(await askLabels(f, 'work.create', { kind: 'asset', title: 'Charger', belongs_to: car.id }))
      .toEqual({ belongs_to: { [car.id]: 'Family car' } });
  });

  it('names any kind\'s row by what it is known by', async () => {
    const f = harness();
    f.store.writeTask({ id: 'task-1', source_id: RECUED_BUILTIN_SOURCE_ID('task'), title: 'Call the dentist', done: false,
      state: 'LOCAL_OPEN', created_at: NOW, updated_at: NOW }, NOW);
    f.store.writeCommitment({ id: 'commit-1', source_id: RECUED_BUILTIN_SOURCE_ID('commitment'), direction: 'outbound',
      statement: 'Send Anna the quote', derivation: 'user_declared', created_at: NOW, updated_at: NOW }, NOW);
    expect(await askLabels(f, 'work.update', { kind: 'task', id: 'task-1', done: true })).toEqual({ id: { 'task-1': 'Call the dentist' } });
    expect(await askLabels(f, 'work.update', { kind: 'commitment', id: 'commit-1' })).toEqual({ id: { 'commit-1': 'Send Anna the quote' } });
  });

  it('names nothing it cannot read: an unknown id, another kind\'s id, or no kind', async () => {
    const f = harness();
    const car = f.ownersAsset({ name: 'Family car' });
    expect(await askLabels(f, 'work.update', { kind: 'asset', id: 'no-such-asset' })).toBeUndefined();
    expect(await askLabels(f, 'work.update', { kind: 'task', id: car.id })).toBeUndefined();
    expect(await askLabels(f, 'work.update', { id: car.id })).toBeUndefined();
    expect(await askLabels(f, 'work.create', { kind: 'task', title: 'x', belongs_to: car.id })).toBeUndefined();
  });
});

describe('the owner\'s rank is the server\'s to give, never a caller\'s', () => {
  it('the owner approves an AI app\'s writes and their own chats\', never a chat under a contract', () => {
    expect(ownerApprovesCallsOf(door)).toBe(true);
    expect(ownerApprovesCallsOf(owner)).toBe(true);
    expect(ownerApprovesCallsOf({ channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' })).toBe(true);
    expect(ownerApprovesCallsOf({ ...owner, contract_id: 'k-self' })).toBe(false);
    expect(ownerApprovesCallsOf({ channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: '43', contract_id: 'k-house' })).toBe(false);
    expect(ownerApprovesCallsOf({ channel: 'reception', actor: 'anonymous', reception_id: 'r-1' })).toBe(false);
  });

  const forged = { readings_source: { kind: 'owner', ref: 'owner:user-1' }, owner_approved: true, check: false };

  it('a dispatcher input that claims it keeps the AI\'s rank', async () => {
    const f = harness();
    const car = await f.aisAsset({ type: 'vehicle', title: 'Family car' });
    await f.dispatchers.assetUpdate({ id: car.id, source: { kind: 'extracted', ref: 'recipe:odometer' },
      readings: { odometer: odometer(500) }, ...forged } as never);
    expect(f.store.readAsset(car.id)!.field_sources['readings.odometer']).toMatchObject({ kind: 'extracted', ref: 'recipe:odometer' });
    // The second argument, which only the chat tools pass, is what makes it the owner's.
    await f.dispatchers.assetUpdate({ id: car.id, source: { kind: 'extracted', ref: 'chat:sess-1' },
      readings: { odometer: odometer(600) } }, { owner_approved: true });
    expect(f.store.readAsset(car.id)!.field_sources['readings.odometer']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1' });
  });

  it('a recipe step that claims it keeps the AI\'s rank', async () => {
    const f = harness();
    const car = await f.aisAsset({ type: 'vehicle', title: 'Family car' });
    await createKernelAdapter(f.dispatchers as unknown as Parameters<typeof createKernelAdapter>[0])({
      slug: 'asset-update', risk_tier: 'write', output: {},
      input: { id: car.id, source: { kind: 'extracted', ref: 'recipe:odometer' }, readings: { odometer: odometer(500) }, ...forged },
    });
    expect(f.store.readAsset(car.id)!.field_sources['readings.odometer']).toMatchObject({ kind: 'extracted', ref: 'recipe:odometer' });
  });
});

describe('the store\'s strict write and dry run', () => {
  it('a strict write refuses a field a higher rank holds and writes none of its fields; a plain one keeps it', () => {
    const f = harness();
    const bike = f.ownersAsset({ name: 'Road bike', attributes: { brand: 'Trek' } });
    const write = { id: bike.id, source_id: bike.source_id, source: { kind: 'extracted' as const, ref: 'chat:sess-1' },
      name: 'Trek Domane', attributes: { colour: 'blue' } };
    expect(() => f.store.writeAsset(write, NOW, { strict: true })).toThrow('A higher-ranked source holds name');
    expect(f.store.readAsset(bike.id)).toEqual(bike);
    // Unchanged values are not a conflict.
    expect(f.store.writeAsset({ ...write, name: 'Road bike' }, NOW, { strict: true }).attributes).toEqual({ brand: 'Trek', colour: 'blue' });
    expect(f.store.writeAsset({ ...write, attributes: { colour: 'red' } }, NOW).name).toBe('Road bike');
  });

  it('a dry run makes every check and keeps nothing', () => {
    const f = harness();
    const bike = f.ownersAsset({ name: 'Road bike' });
    const seen = f.store.dryRun(() => f.store.writeAsset({ id: bike.id, source_id: bike.source_id,
      source: { kind: 'owner', ref: 'owner:user-1' }, attributes: { colour: 'blue' }, readings: { usage: odometer(1) } }, NOW));
    expect(seen.attributes).toEqual({ colour: 'blue' });
    expect(f.store.readAsset(bike.id)).toEqual(bike);
    expect(f.store.assetReadingHistory(bike.id, 'usage')).toEqual([]);
    expect(() => f.store.dryRun(() => f.store.writeAsset({ id: bike.id, source_id: bike.source_id,
      source: { kind: 'owner', ref: 'owner:user-1' }, belongs_to: 'no-such-asset' }, NOW))).toThrow('belongs_to must name a live asset');
  });
});
