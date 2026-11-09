/** D-342 slice 4 (§6) — the chat creates a pursuit from the owner's own words: `work.type` says what a
 *  pursuit keeps, its attributes included, and to write any time in them as the date it means
 *  (ruling 10); `work.create` of an asset of type `pursuit` makes one with its type's defaults
 *  (personal, not private, no rules) and the owner's words under the type's names; the approval
 *  calls it "Add a pursuit"; and the catalog tells a model to propose one when the user states a
 *  goal, never one they did not state.
 *
 *  ⛔ DRIVEN ON THE REAL STORE, DISPATCHERS AND TYPES, as `work-type-tier1-tool.test.ts` is. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PURSUIT_CLASS_ID, TIER1_TOOL_DESCRIPTORS, tier1CallTitle, type ExecutionSource } from '@recued/contracts';
import { ASSET_CREATE_OP_ID, buildChatTier1Handlers, checkWorkCreate, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { assetTypes } from '../situations/asset-types.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true } as never;
type Ok = { ok: true; result: Record<string, unknown> };
const NOW = Date.parse('2026-11-06T18:00:00Z');

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = () => {
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW, assetTypes: assetTypes(db) });
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: (_source: ExecutionSource, op?: string) => op === ASSET_CREATE_OP_ID }),
    getAssetTypes: () => assetTypes(db),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  return { store, deps, type: handlers['work.type']!, create: handlers['work.create']! };
};
const marathon = { kind: 'asset', type: PURSUIT_CLASS_ID, title: 'Run a marathon',
  attributes: { horizon: 'in 2027', why: 'To prove to myself I can', where_i_am: 'Running 10 km a week' } };

describe('D-342 slice 4 — work.type says what a pursuit keeps', () => {
  it('names its target date, its progress and the attributes it keeps the user’s words under', async () => {
    const f = harness();
    const res = await f.type({ kind: 'asset', type: PURSUIT_CLASS_ID }, inChat) as Ok;
    expect(res.result).toMatchObject({ kind: 'asset', type: 'pursuit', name: 'Pursuit', dates: ['target_on'], readings: ['progress'], reminders: [],
      attributes: { horizon: expect.stringContaining('none for a habit'), why: expect.any(String), where_i_am: expect.any(String) } });
    expect(Object.keys(res.result.attributes as object)).toEqual(['horizon', 'why', 'where_i_am']);
    expect(res.result.note).toContain('type "pursuit"');
    expect(res.result.note).toContain('and attributes under these names, in the user\'s words');
  });
  it('asks for any time in them as the date it means, and gives a horizon by its year (ruling 10)', async () => {
    const f = harness();
    const res = await f.type({ kind: 'asset', type: PURSUIT_CLASS_ID }, inChat) as Ok;
    expect(res.result.note).toContain('Write any time in the title or attributes as the date it means, with its year, never "next year" or "this morning": '
      + 'they are read on later days.');
    expect((res.result.attributes as Record<string, string>).horizon).toBe('when, such as "2027" or "by summer 2027"; none for a habit');
  });
  it('names no attributes for a type that keeps none, nor for a class whose id is an object’s own key', async () => {
    const f = harness();
    const passport = await f.type({ kind: 'asset', type: 'passport' }, inChat) as Ok;
    expect(passport.result).not.toHaveProperty('attributes');
    expect(passport.result.note).not.toContain('attributes');
    expect(passport.result.note).not.toContain('the date it means');
    // `TYPE_ATTRIBUTES['constructor']` is Object's constructor: an owner class may take that id.
    assetTypes(db);
    db.prepare('INSERT INTO asset_class_presets(id,version,origin,value) VALUES(?,?,?,?)').run('constructor', 1, 'owner', JSON.stringify({ id: 'constructor',
      name: 'Builder', version: 1, origin: 'owner', fields: { dates: {}, readings: {}, observations: {}, settings: {} }, rules: [], audience: 'owner', retirement: 'part' }));
    expect((await f.type({ kind: 'asset', type: 'constructor' }, inChat) as Ok).result).not.toHaveProperty('attributes');
  });
});

describe('D-342 slice 4 — work.create makes a pursuit in the user’s words', () => {
  it('keeps its type’s defaults, personal and not private with no rules, and the user’s words under its names', async () => {
    const f = harness();
    expect(await checkWorkCreate(f.deps, { ...marathon, dates: { target_on: '2027-10-01' } }, inChat)).toBeNull();
    const res = await f.create({ ...marathon, dates: { target_on: '2027-10-01' }, readings: { progress: { value: 10, unit: 'km a week' } } }, approved) as Ok;
    expect(res.ok).toBe(true);
    const pursuit = f.store.readAsset(res.result.id as string)!;
    expect(pursuit).toMatchObject({ name: 'Run a marathon', class_id: 'pursuit', status: 'active', sphere: 'personal', audience: 'owner', rules: [],
      attributes: marathon.attributes, dates: { target_on: '2027-10-01' }, readings: { progress: { value: 10, unit: 'km a week' } } });
    // Not private (ruling 9), so the daily suggestions name it.
    expect(pursuit.settings).not.toHaveProperty('sensitive');
    // The words are the owner's, through the chat they approved (D-343 ruling 16); its type's
    // settings are its type's, which only the owner changes.
    expect(pursuit.field_sources['attributes.where_i_am']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1' });
    expect(pursuit.field_sources['settings.class_version']).toMatchObject({ kind: 'owner', ref: 'type:pursuit@1' });
  });
  it('is put to the owner as "Add a pursuit"; any other thing stays "Add a thing you own"', () => {
    expect(tier1CallTitle('work.create', marathon)).toBe('Add a pursuit');
    expect(tier1CallTitle('work.create', { kind: 'asset', type: 'passport', title: 'Passport' })).toBe('Add a thing you own');
    expect(tier1CallTitle('work.create', { kind: 'asset', title: 'Road bike' })).toBe('Add a thing you own');
  });
});

describe('D-342 §6 — the catalog says when to propose a pursuit', () => {
  it('proposes one when the user states a goal, never one they did not state', () => {
    const create = TIER1_TOOL_DESCRIPTORS['work.create'];
    expect(create.description).toContain('When they tell you something they want to achieve or keep up ("I want to run a marathon next year"), '
      + 'propose keeping it as a pursuit (kind `asset`, type `pursuit`), not a memory, with any time in it as the date it means ("2027", not "next year"). '
      + 'Never one they did not state.');
    expect(JSON.stringify(create.arg_schema)).toContain('or a pursuit they work toward (type `pursuit`); a type is optional.');
    expect(TIER1_TOOL_DESCRIPTORS['work.type'].description).toContain('What a type of thing the user owns or works toward keeps (a passport, a car, a pursuit)');
  });
});
