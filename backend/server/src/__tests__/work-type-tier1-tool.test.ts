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
import { TIER1_TOOL_DESCRIPTORS, type ExecutionSource } from '@recued/contracts';
import { ASSET_CREATE_OP_ID, buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createContactStore } from '../storage/contact-store.js';
import { assetTypes } from '../situations/asset-types.js';

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
  const handlers = buildChatTier1Handlers({
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false,
      isOpGranted: (_source: ExecutionSource, op?: string) => op !== undefined && granted.includes(op) }),
    getAssetTypes: () => assetTypes(db),
    getContactStore: () => contacts,
  } as unknown as ChatToolHandlerDeps);
  return { store, contacts, type: handlers['work.type']!, create: handlers['work.create']! };
};
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
    expect(asset.field_sources['rules.renew']).toMatchObject({ kind: 'owner', ref: 'type:passport@1' });
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

  it('refuses the asset arguments on another kind', async () => {
    const f = harness([...[ASSET_CREATE_OP_ID], 'core.work-entity.task.create']);
    const res = await f.create({ kind: 'task', title: 'Renew passport', dates: { expires_on: '2027-03-01' } }, inChat()) as Refused;
    expect(res.detail).toBe('work.create: `dates` applies to an asset only');
  });
});
