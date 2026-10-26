/** D-325 (2026-10-24) — `work.type`, and the `asset` kind of `work.create`. The
 *  owner: "hint.tool for the create job so AI knows what shape the passport obj is
 *  to create a passport out of blank", and "the create tool hint will have to
 *  reference work.type on its description so agent knows where to look".
 *
 *  ⛔ DRIVEN ON THE REAL STORE, DISPATCHERS AND TYPES. `work.create` reports the
 *  reminders it started; that is only true if the asset holds its type's rows, so
 *  a double at the dispatcher would test the report and not the reminders. Both
 *  tools are `read`/`unknown`, so the asset create's op grant is their only gate,
 *  and each refusal below checks nothing was written. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS, type AssetClassPreset, type ExecutionSource } from '@recued/contracts';
import { ASSET_CREATE_OP_ID, buildChatTier1Handlers, checkWorkCreate, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createContactStore } from '../storage/contact-store.js';
import { assetTypes } from '../situations/asset-types.js';
import { createAssetClassStore } from '../situations/asset-classes.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const door: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call-1',
  mcp_token_id: 'tok-1', contract_id: 'door-1' };
const inChat = (source: ExecutionSource = owner) =>
  ({ channel: 'internal_function_call', session_id: 'sess-1', execution_source: source }) as never;
const overMcp = { channel: 'mcp_wire', mcp_token_id: 'tok-1', execution_source: door } as never;

type Ok = { ok: true; result: Record<string, unknown> };
type Refused = { ok: false; reason: string; detail: string };

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = (granted: readonly string[] = [ASSET_CREATE_OP_ID]) => {
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => 1_000, assetTypes: assetTypes(db) });
  const contacts = createContactStore(db);
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false,
      isOpGranted: (_source: ExecutionSource, op?: string) => op !== undefined && granted.includes(op) }),
    getAssetTypes: () => assetTypes(db),
    getContactStore: () => contacts,
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  return { store, contacts, deps, type: handlers['work.type']!, create: handlers['work.create']! };
};
/** The tool's clock: a reading the user gave with no time was read now. */
const NOW = Date.parse('2026-10-25T09:30:00Z');
const passport = { kind: 'asset', type: 'passport', title: "Maya's passport", dates: { expires_on: '2027-03-01' }, holder_email: 'Maya@Example.com' };

describe('work.type — what a type keeps, before the create', () => {
  it('lists every type with its dates, and says which need a holder', async () => {
    const f = harness();
    const res = await f.type({ kind: 'asset' }, inChat()) as Ok;
    expect(res.ok).toBe(true);
    const types = res.result.types as Array<Record<string, unknown>>;
    expect(types).toContainEqual({ type: 'passport', name: 'Passport', dates: ['expires_on', 'issued_on'], holder_required: true });
    expect(types).toContainEqual({ type: 'boiler', name: 'Boiler', dates: ['last_serviced_on'] });
  });

  it('describes one type: its dates and the reminders they send', async () => {
    const f = harness();
    const res = await f.type({ kind: 'asset', type: 'passport' }, inChat()) as Ok;
    expect(res.result).toMatchObject({ kind: 'asset', type: 'passport', dates: ['expires_on', 'issued_on'], holder_required: true,
      search_keywords: ['trip', 'travel', 'holiday', 'international', 'overseas'],
      reminders: [{ title: 'Renew', due: 'on expires_on' }] });
    expect(res.result.note).toContain('work.create: kind "asset", type "passport", its title, holder_email and dates');
  });

  it('names the types there are when asked for one that is not', async () => {
    const f = harness();
    const res = await f.type({ kind: 'asset', type: 'pasport' }, inChat()) as Refused;
    expect(res).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(res.detail).toContain('There is no asset type `pasport`');
    expect(res.detail).toContain('`passport`');
  });

  it('answers for assets only', async () => {
    const res = await harness().type({ kind: 'task' }, inChat()) as Refused;
    expect(res).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(res.detail).toContain('`asset` types only');
  });

  it('is refused to a contract that may not add things it owns', async () => {
    const res = await harness(['core.work-entity.task.create']).type({ kind: 'asset' }, inChat()) as Refused;
    expect(res).toMatchObject({ ok: false, reason: 'classification_blocked' });
  });

  it('the create tool sends the model to it', () => {
    expect(TIER1_TOOL_DESCRIPTORS['work.create'].description).toContain('an `asset` they own (call `work.type` first)');
    expect(TIER1_TOOL_DESCRIPTORS['work.type'].classification).toBe('read');
  });
});

describe('work.create — an asset, to its type', () => {
  it("creates a passport at the AI's rank, with its type's reminders on", async () => {
    const f = harness();
    const maya = f.contacts.upsertManual({ email: 'maya@example.com', name: 'Maya Chen' });
    const res = await f.create(passport, inChat()) as Ok;
    expect(res.result).toEqual({ created: true, kind: 'asset', id: expect.any(String), type: 'passport',
      fields: ['title', 'type', 'dates', 'holder_email'], reminders: ['Renew'] });
    const asset = f.store.readAsset(res.result.id as string)!;
    expect(asset).toMatchObject({ name: "Maya's passport", class_id: 'passport', dates: { expires_on: '2027-03-01', issued_on: null } });
    // Kept as the Yours picker keeps a holder: the contact's id.
    expect(asset.holder_contact).toBe(maya.contact_id);
    expect(asset.rules.map(rule => [rule.id, rule.enabled])).toEqual([['renew', true]]);
    expect(asset.field_sources['dates.expires_on']).toMatchObject({ kind: 'extracted', ref: 'chat:sess-1' });
    expect(asset.field_sources['rules.renew']).toMatchObject({ kind: 'owner', ref: `type:passport@${assetTypes(db).get('passport')!.version}` });
  });

  it('keeps the email of a holder who is not a contact', async () => {
    const f = harness();
    const res = await f.create(passport, inChat()) as Ok;
    expect(f.store.readAsset(res.result.id as string)!.holder_contact).toBe('maya@example.com');
  });

  it('says which reminders wait for a date the user did not give', async () => {
    const f = harness();
    const res = await f.create({ ...passport, dates: { issued_on: '2017-03-01' } }, inChat()) as Ok;
    expect(res.result).toMatchObject({ reminders: ['Renew'], reminders_wait_for: ['expires_on'] });
  });

  it('refuses a date its type does not keep, naming the ones it keeps and work.type, and writes nothing', async () => {
    const f = harness();
    const res = await f.create({ ...passport, dates: { expiry: '2027-03-01' } }, inChat()) as Refused;
    expect(res).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(res.detail).toBe('work.create: Type `passport` keeps the dates `expires_on` and `issued_on`, not `expiry`. work.type describes each type.');
    expect(f.store.listAssets({})).toEqual([]);
  });

  it('asks for the holder in its own words', async () => {
    const f = harness();
    const { holder_email: _holder, ...noHolder } = passport;
    const res = await f.create(noHolder, inChat()) as Refused;
    expect(res.detail).toContain('needs its holder: pass `holder_email`');
    expect(f.store.listAssets({})).toEqual([]);
  });

  it('refuses a name as a holder, a date that is not one, and a field an asset does not have', async () => {
    const f = harness();
    expect((await f.create({ ...passport, holder_email: 'Maya Chen' }, inChat()) as Refused).detail).toContain('never a name');
    expect((await f.create({ ...passport, dates: { expires_on: 'next March' } }, inChat()) as Refused).detail)
      .toContain('`dates.expires_on` must be a date as YYYY-MM-DD');
    expect((await f.create({ ...passport, due_at: 5 }, inChat()) as Refused).detail).toContain('not `due_at`');
    expect((await f.create({ ...passport, type: 'pasport' }, inChat()) as Refused).detail).toContain('There is no asset type `pasport`');
    expect(f.store.listAssets({})).toEqual([]);
  });

  it('an asset with no type keeps a name and no dates', async () => {
    const f = harness();
    expect((await f.create({ kind: 'asset', title: 'Old camera', dates: { bought_on: '2020-01-01' } }, inChat()) as Refused).detail)
      .toContain('an asset with no type keeps no dates');
    const res = await f.create({ kind: 'asset', title: 'Old camera' }, inChat()) as Ok;
    expect(res.result).toMatchObject({ created: true, fields: ['title'], reminders: [] });
    expect(f.store.readAsset(res.result.id as string)).toMatchObject({ name: 'Old camera', rules: [] });
  });

  it('is refused, writing nothing, to a contract that may add tasks but not things it owns', async () => {
    const f = harness(['core.work-entity.task.create']);
    const res = await f.create(passport, inChat()) as Refused;
    expect(res).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(res.detail).toContain('asset');
    expect(f.store.listAssets({})).toEqual([]);
  });

  it('serves an AI app over MCP the same way, under its own provenance', async () => {
    const f = harness();
    const res = await f.create(passport, overMcp) as Ok;
    const asset = f.store.readAsset(res.result.id as string)!;
    expect(asset.field_sources['dates.expires_on']).toMatchObject({ kind: 'extracted', ref: 'mcp:tok-1' });
    expect(asset.rules[0]!.enabled).toBe(true);
  });

  it('keeps what the user said about a thing with no type: its details, where it is kept and a note', async () => {
    // ⛔ Live (2026-10-25): with nowhere to put them, the AI sent a bike's details as `body` in
    // 3 of 3 runs, and the owner approved a create that then refused `body`.
    const f = harness();
    const res = await f.create({ kind: 'asset', title: 'Road bike', attributes: { brand: 'Trek', frame_size: '56 cm', electric: false },
      place: 'the garage', body: 'Bought second-hand.' }, inChat()) as Ok;
    expect(res.result).toMatchObject({ created: true, fields: ['title', 'attributes', 'body', 'place'], reminders: [] });
    expect(f.store.readAsset(res.result.id as string)).toMatchObject({ name: 'Road bike', rules: [],
      attributes: { brand: 'Trek', frame_size: '56 cm', electric: false, note: 'Bought second-hand.' },
      anchors: [{ kind: 'place', name: 'the garage' }] });
  });

  it('refuses details it cannot keep, saying how, and writes nothing', async () => {
    const f = harness();
    const bike = { kind: 'asset', title: 'Road bike' };
    for (const [args, says] of [
      [{ attributes: ['Trek'] }, '`attributes` must be an object of named details'],
      [{ attributes: { size: { cm: 56 } } }, '`attributes.size` must be text'],
      [{ attributes: { ' ': 'x' } }, 'name each attribute in lower-case letters'],
      // ⛔ The Yours form refuses any other attribute name on save.
      [{ attributes: { '2nd_owner': 'x' } }, 'name each attribute in lower-case letters'],
      [{ attributes: { 'Frame size': '56 cm', frame_size: '54 cm' } }, '`attributes` names `frame_size` twice'],
      [{ attributes: { document_details: 'x' } }, '`document_details` belongs to a document attached in Yours'],
      [{ attributes: Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`a${n}`, 'x'])) }, 'at most 20 attributes'],
      [{ attributes: { note: 'one' }, body: 'two' }, 'give an asset its note once'],
      [{ body: '   ' }, '`body` is a note about the asset'],
      [{ place: '' }, '`place` says where it is kept'],
    ] as const) {
      expect((await f.create({ ...bike, ...args }, inChat()) as Refused).detail).toContain(says);
    }
    expect(f.store.listAssets({})).toEqual([]);
  });

  it('answers a check before asking with the refusal the create would give, and writes nothing either way', async () => {
    // The check runs the create's own dispatcher, then rolls its writes back.
    const f = harness([ASSET_CREATE_OP_ID, 'core.work-entity.task.create']);
    expect(await checkWorkCreate(f.deps, { kind: 'asset', title: 'Road bike', place: 'the garage' }, inChat())).toBeNull();
    expect(await checkWorkCreate(f.deps, passport, inChat())).toBeNull();
    expect(await checkWorkCreate(f.deps, { kind: 'asset', title: 'Road bike', colour: 'blue' }, inChat()))
      .toMatchObject({ ok: false, reason: 'invalid_args', detail: expect.stringContaining('not `colour`') });
    expect(await checkWorkCreate(f.deps, { kind: 'task' }, inChat())).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(f.store.listAssets({})).toEqual([]);
  });

  it('refuses the asset arguments on another kind', async () => {
    const f = harness([...[ASSET_CREATE_OP_ID], 'core.work-entity.task.create']);
    const res = await f.create({ kind: 'task', title: 'Renew passport', dates: { expires_on: '2027-03-01' } }, inChat()) as Refused;
    expect(res.detail).toBe('work.create: `dates` applies to an asset only');
  });
});

/** A type whose reminder reads `usage` in kWh: no starter type reads a reading. */
const meter: AssetClassPreset = { id: 'meter', name: 'Meter', version: 1, origin: 'test', audience: 'owner', retirement: 'part',
  fields: { dates: {}, readings: { usage: null }, observations: {}, settings: {} },
  rules: [{ id: 'cap', title: 'Check usage', enabled: true, muted: false, pinned: false, consequence: 'routine', expiry_policy: 'strict_expire',
    when: { kind: 'objective', field: 'usage', target: 500, unit: 'kWh', direction: 'rising', mode: 'usage', lead_days: 0 },
    reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [], on_day: true } }] };

describe('work.create — the readings the user gave', () => {
  const car = { kind: 'asset', type: 'vehicle', title: 'Family car' };

  it('records a reading under its type\'s name, read now unless the user said when', async () => {
    const f = harness();
    const res = await f.create({ ...car, readings: { odometer: { value: 12400, unit: 'km' } } }, inChat()) as Ok;
    expect(res.result.fields).toEqual(['title', 'type', 'readings']);
    expect(f.store.readAsset(res.result.id as string)!.readings.odometer).toEqual({ value: 12400, unit: 'km', as_of: NOW, evidence: [] });
  });

  it('reads a day as its noon in the turn\'s zone, an exact time as given, and never a time still to come', async () => {
    const f = harness();
    const at = async (as_of: string, ctx: never = inChat()) => {
      const res = await f.create({ ...car, readings: { odometer: { value: 1, unit: 'km', as_of } } }, ctx);
      return res.ok ? f.store.readAsset((res as Ok).result.id as string)!.readings.odometer!.as_of : (res as Refused).detail;
    };
    const newYork = { ...(inChat() as object), time_zone: 'America/New_York' } as never;
    expect(await at('2026-10-01', newYork)).toBe(Date.parse('2026-10-01T16:00:00Z'));
    // The MCP wire has no zone: a day's noon is UTC's.
    expect(await at('2026-10-01')).toBe(Date.parse('2026-10-01T12:00:00Z'));
    expect(await at('2026-10-24T18:05:00+02:00')).toBe(Date.parse('2026-10-24T16:05:00Z'));
    // Today's noon is still to come at 09:30, so a reading of today was read by now.
    expect(await at('2026-10-25')).toBe(NOW);
    for (const later of ['2026-10-26', '2026-10-25T10:00:00Z', '2026-10-24T18:05:00', 'yesterday']) {
      expect(await at(later)).toContain('`readings.odometer`.as_of is when it was read');
    }
  });

  it('keeps to its type\'s readings and the unit its reminders read them in, and writes nothing else', async () => {
    const f = harness();
    createAssetClassStore(db).register(meter);
    for (const [args, says] of [
      [{ title: 'Road bike', readings: { odometer: { value: 1, unit: 'km' } } }, 'an asset with no type keeps no dates or readings'],
      [{ ...car, readings: { mileage: { value: 1, unit: 'km' } } }, 'Type `vehicle` keeps the readings `odometer`, not `mileage`'],
      [{ ...car, readings: [] }, '`readings` must be an object of readings by name'],
      [{ ...car, readings: { odometer: 12400 } }, '`readings.odometer` is {"value": <the number>, "unit": "<its unit>"}'],
      [{ ...car, readings: { odometer: { value: 1, unit: 'km', source: 'me' } } }, '`readings.odometer` is {"value"'],
      [{ ...car, readings: { odometer: { value: '12400', unit: 'km' } } }, '`readings.odometer`.value is the number read'],
      [{ ...car, readings: { odometer: { value: 1, unit: ' ' } } }, '`readings.odometer`.unit says what it is read in'],
      [{ kind: 'asset', type: 'meter', title: 'Meter', readings: { usage: { value: 1, unit: 'Wh' } } }, '`usage` is read in `kWh`, not `Wh`'],
    ] as const) {
      expect((await f.create({ kind: 'asset', ...args }, inChat()) as Refused).detail).toContain(says);
    }
    expect(f.store.listAssets({})).toEqual([]);
    const res = await f.create({ kind: 'asset', type: 'meter', title: 'Meter', readings: { usage: { value: 120, unit: 'kWh' } } }, inChat()) as Ok;
    expect(res.result.reminders).toEqual(['Check usage']);
  });

  it('records an approved create\'s readings as the owner\'s own samples, and the rest at the AI\'s rank', async () => {
    // The owner's ruling of 2026-10-25: "readings mine, rest AI's".
    const f = harness();
    const approved = { ...(inChat() as object), owner_approved: true } as never;
    const res = await f.create({ ...car, readings: { odometer: { value: 12400, unit: 'km' } }, attributes: { colour: 'blue' } }, approved) as Ok;
    const asset = f.store.readAsset(res.result.id as string)!;
    expect(asset.field_sources['readings.odometer']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1', revision: expect.any(String) });
    expect(asset.field_sources['attributes.colour']).toMatchObject({ kind: 'extracted', ref: 'chat:sess-1' });
    expect(asset.field_sources.name).toMatchObject({ kind: 'extracted', ref: 'chat:sess-1' });
    const unapproved = await f.create({ ...car, readings: { odometer: { value: 1, unit: 'km' } } }, inChat()) as Ok;
    expect(f.store.readAsset(unapproved.result.id as string)!.field_sources['readings.odometer']).toMatchObject({ kind: 'extracted' });
  });
});
