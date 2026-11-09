/** D-342 — a pursuit's fields reach a model wherever it changes one. The owner: "every item in the
 *  agenda should have a way for model to update it". `work.type` names a pursuit's attributes, but
 *  an update calls no `work.type`, and a pursuit with no Where I am yet showed no such field. So:
 *  - a read of a typed thing (`work.read`, and the details the chat's context and the suggestions
 *    show) names each attribute its type keeps, an unset one as null, as its dates already are;
 *  - an AI's write to it keeps to those names, a create as an update, and is refused before the
 *    owner is asked when it sends another, in words that name the right ones. One the thing
 *    already has stays its own, and search keywords stay open to every thing.
 *
 *  ⛔ DRIVEN ON THE REAL STORE, DISPATCHERS, TYPES AND HANDLERS, as the slice 2 and 4 tests are. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PURSUIT_CLASS_ID, RECUED_BUILTIN_SOURCE_ID, type Asset, type ExecutionSource } from '@recued/contracts';
import { ASSET_CREATE_OP_ID, ASSET_UPDATE_OP_ID, buildChatTier1Handlers, checkWorkCreate, checkWorkUpdate, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type AssetWriteInput } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { assetTypeApplication, assetTypes } from '../situations/asset-types.js';
import { situationAssetDetails } from '../situations/asset-details.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true } as never;
type Ok = { ok: true; result: Record<string, unknown> };
type Refused = { ok: false; reason: string; detail: string };
const NOW = Date.parse('2026-11-06T18:00:00Z');
const DAY = 86_400_000;
const WORDS = 'Type `pursuit` keeps its details under the attributes `horizon`, `why` and `where_i_am`';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = () => {
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW, assetTypes: assetTypes(db) });
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getWorkEntityResolver: () => resolver,
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false,
      isOpGranted: (_source: ExecutionSource, op?: string) => op === ASSET_CREATE_OP_ID || op === ASSET_UPDATE_OP_ID || op === 'core.work-entity.read' }),
    getAssetTypes: () => assetTypes(db),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  /** A thing as the owner keeps it in Yours, its type applied as the page applies it. */
  const owners = (input: Omit<AssetWriteInput, 'source' | 'source_id'>): Asset => {
    const made = store.writeAsset({ ...input, source_id: RECUED_BUILTIN_SOURCE_ID('asset'), source: { kind: 'owner', ref: 'owner:user-1' } }, NOW - DAY);
    const type = input.class_id ? assetTypes(db).get(input.class_id) : null;
    return type ? store.writeAsset({ ...assetTypeApplication(type), id: made.id, source_id: made.source_id }, NOW - DAY) : made;
  };
  // Made on the Pursuits tab with a horizon only: no why, no Where I am yet.
  const marathon = owners({ name: 'Run a marathon', class_id: PURSUIT_CLASS_ID, dates: { target_on: null }, readings: { progress: null },
    attributes: { horizon: '2027' } });
  /** A read as a model makes one: by the id `work.search` gave it, found by the name's last word. */
  const read = async (name: string) => {
    const found = await handlers['work.search']!({ kind: 'asset', query: name.split(' ').at(-1) }, inChat) as Ok;
    const id = (found.result.entities as Array<{ id: string; name: string }>).find((entity) => entity.name === name)!.id;
    return (await handlers['work.read']!({ kind: 'asset', id }, inChat) as Ok).result.entity as Asset;
  };
  return { store, deps, owners, marathon, read, update: handlers['work.update']! };
};

describe('D-342 — a typed thing’s read names the attributes its type keeps', () => {
  it('shows a pursuit’s unset why and Where I am as null in work.read, beside its null target date', async () => {
    const f = harness();
    expect(await f.read('Run a marathon')).toMatchObject({ class_id: 'pursuit', dates: { target_on: null }, readings: { progress: null },
      attributes: { horizon: '2027', why: null, where_i_am: null } });
    // Nothing is written: the store still holds the horizon alone.
    expect(f.store.readAsset(f.marathon.id)!.attributes).toEqual({ horizon: '2027' });
  });
  it('adds nothing to a type that names no attributes, nor to a pursuit that has them all', async () => {
    const f = harness();
    f.owners({ name: 'Grandfather’s watch', class_id: 'heirloom', attributes: { maker: 'Omega' } });
    expect((await f.read('Grandfather’s watch')).attributes).toEqual({ maker: 'Omega' });
    f.owners({ name: 'Learn Spanish', class_id: PURSUIT_CLASS_ID, attributes: { horizon: 'ongoing', why: 'Family', where_i_am: 'Unit 4' } });
    expect((await f.read('Learn Spanish')).attributes).toEqual({ horizon: 'ongoing', why: 'Family', where_i_am: 'Unit 4' });
  });
  it('shows them as null in the details the chat’s context and the suggestions read, and a removed note of another thing not at all', () => {
    const f = harness();
    expect(situationAssetDetails(f.marathon)).toMatchObject({ class_id: 'pursuit', attributes: { horizon: '2027', why: null, where_i_am: null } });
    const bike = f.owners({ name: 'Bike', attributes: { colour: 'red', note: null as never } });
    expect(situationAssetDetails(bike).attributes).toEqual({ colour: 'red' });
  });
});

describe('D-342 — an AI’s write to a pursuit keeps to the attributes its type names', () => {
  it('refuses another name on an update before the owner is asked, and names the right ones', async () => {
    const f = harness();
    const change = { kind: 'asset', id: f.marathon.id, attributes: { progress_note: 'Ran 15 km on 6 November 2026' } };
    const refused = await checkWorkUpdate(f.deps, change, inChat) as Refused;
    expect(refused).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(refused.detail).toBe(`work.update: ${WORDS}, not \`progress_note\`.`);
    expect(f.store.readAsset(f.marathon.id)!.attributes).toEqual({ horizon: '2027' });
  });
  it('refuses a note (`body`) on a pursuit the same way, and takes the words under where_i_am', async () => {
    const f = harness();
    expect((await checkWorkUpdate(f.deps, { kind: 'asset', id: f.marathon.id, body: 'Ran 15 km' }, inChat) as Refused).detail)
      .toBe(`work.update: ${WORDS}, not a note.`);
    const change = { kind: 'asset', id: f.marathon.id, attributes: { where_i_am: 'Ran 15 km on 6 November 2026' } };
    expect(await checkWorkUpdate(f.deps, change, inChat)).toBeNull();
    expect(await f.update(change, approved)).toMatchObject({ ok: true, result: { fields: ['attributes'] } });
    expect(f.store.readAsset(f.marathon.id)!.attributes).toEqual({ horizon: '2027', where_i_am: 'Ran 15 km on 6 November 2026' });
  });
  it('lets one the pursuit already has stay its own, keeps search keywords open, and leaves every other thing as it was', async () => {
    const f = harness();
    // A detail an AI kept on it before this check: its own, so the AI may still change it.
    f.store.writeAsset({ id: f.marathon.id, source_id: f.marathon.source_id, source: { kind: 'extracted', ref: 'chat:earlier' },
      attributes: { coach: 'Ana' } }, NOW - 1000);
    expect(await checkWorkUpdate(f.deps, { kind: 'asset', id: f.marathon.id, attributes: { coach: 'Ben' } }, inChat)).toBeNull();
    expect(await checkWorkUpdate(f.deps, { kind: 'asset', id: f.marathon.id, attributes: { search_terms: ['running', 'race'] } }, inChat)).toBeNull();
    const bike = f.owners({ name: 'Bike', attributes: { colour: 'red' } });
    expect(await checkWorkUpdate(f.deps, { kind: 'asset', id: bike.id, attributes: { frame_size: '56 cm' }, body: 'Bought second-hand.' }, inChat)).toBeNull();
  });
  it('refuses another name, or a note, on a create of a pursuit, and takes the type’s own', async () => {
    const f = harness();
    const base = { kind: 'asset', type: PURSUIT_CLASS_ID, title: 'Read 20 books' };
    expect((await checkWorkCreate(f.deps, { ...base, attributes: { goal: '20 books by 31 December 2026' } }, inChat) as Refused).detail)
      .toContain(`${WORDS}, not \`goal\`.`);
    expect((await checkWorkCreate(f.deps, { ...base, body: 'Read 20 books by 31 December 2026' }, inChat) as Refused).detail)
      .toContain(`${WORDS}, not a note.`);
    expect(await checkWorkCreate(f.deps, { ...base, attributes: { horizon: 'by 31 December 2026', where_i_am: 'Finished 3 books',
      search_terms: ['reading'] } }, inChat)).toBeNull();
    // Another type stays as it was: a keepsake keeps any detail the user gave.
    expect(await checkWorkCreate(f.deps, { kind: 'asset', type: 'heirloom', title: 'Grandfather’s watch',
      attributes: { maker: 'Omega' }, body: 'From 1962.' }, inChat)).toBeNull();
  });
});
