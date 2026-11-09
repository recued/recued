/** D-342 slice 2 (ruling 7) — a pursuit's Where I am and progress are kept by both the owner
 *  and the owner's chat. It began as an exception to D-325's "readings mine, rest AI's": the
 *  owner's approved chat, and an AI app over MCP once the owner approved its write (ruling 11:
 *  its door refuses a tool the app's contract does not grant), could replace the note the owner
 *  typed and nothing else. D-343 ruling 16 (2026-11-06) made every write the owner approves
 *  theirs, so the exception is the rule: such a write changes any of a pursuit's facts, at the
 *  owner's rank under the chat or app it came from. A chat under a contract, a recipe, or a
 *  write nobody approved still changes none of the owner's.
 *
 *  ⛔ DRIVEN ON THE REAL STORE AND DISPATCHERS, as `work-asset-update-tier1-tool.test.ts` is:
 *  which source holds a field is the store's decision. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PURSUIT_CLASS_ID, RECUED_BUILTIN_SOURCE_ID, type Asset, type ExecutionSource } from '@recued/contracts';
import { ASSET_UPDATE_OP_ID, buildChatTier1Handlers, checkWorkUpdate, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type AssetWriteInput } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { assetTypes } from '../situations/asset-types.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const member: ExecutionSource = { channel: 'chat', actor: 'contracted_user', chat_session_id: 'chat-2', user_id: 'member-1', contract_id: 'household-1' } as never;
const door: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call-1', mcp_token_id: 'tok-1', contract_id: 'door-1' };
/** The owner's chat before they are asked (the check), and once they approved the call. */
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true } as never;
const overMcp = { channel: 'mcp_wire', mcp_token_id: 'tok-1', execution_source: door, owner_approved: true } as never;
/** The same app's call before the owner answered: the door's check runs on it, as a dispatch
 *  nobody approved would. */
const mcpUnapproved = { channel: 'mcp_wire', mcp_token_id: 'tok-1', execution_source: door } as never;
const memberChat = { channel: 'internal_function_call', session_id: 'sess-2', execution_source: member } as never;

type Ok = { ok: true; result: Record<string, unknown> };
type Refused = { ok: false; reason: string; detail: string };
const NOW = Date.parse('2026-11-06T18:00:00Z');
const DAY = 86_400_000;

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = () => {
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW, assetTypes: assetTypes(db) });
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: (_source: ExecutionSource, op?: string) => op === ASSET_UPDATE_OP_ID }),
    getAssetTypes: () => assetTypes(db),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  /** A thing as the owner keeps it in Yours: every fact at their own rank. */
  const owners = (input: Omit<AssetWriteInput, 'source' | 'source_id'>): Asset => store.writeAsset({
    ...input, source_id: RECUED_BUILTIN_SOURCE_ID('asset'), source: { kind: 'owner', ref: 'owner:user-1' } }, NOW - DAY);
  const spanish = owners({ name: 'Learn Spanish', class_id: PURSUIT_CLASS_ID, dates: { target_on: '2026-12-31' },
    attributes: { horizon: 'ongoing', why: 'To talk with Ana’s family', where_i_am: 'Finished unit 4' },
    readings: { progress: { value: 4, unit: 'units', as_of: NOW - DAY, evidence: [] } } });
  return { store, dispatchers, deps, owners, spanish, update: buildChatTier1Handlers(deps)['work.update']! };
};
const where = (id: string, note: string) => ({ kind: 'asset', id, attributes: { where_i_am: note } });

describe('D-342 ruling 7 — the owner’s chat keeps a pursuit’s Where I am and progress', () => {
  it('writes a new progress the owner approves as their own sample, over the one they typed', async () => {
    const f = harness();
    const change = { kind: 'asset', id: f.spanish.id, readings: { progress: { value: 5, unit: 'units' } } };
    expect(await checkWorkUpdate(f.deps, change, inChat)).toBeNull();
    expect(await f.update(change, approved)).toMatchObject({ ok: true, result: { fields: ['readings'] } });
    const after = f.store.readAsset(f.spanish.id)!;
    expect(after.readings.progress).toMatchObject({ value: 5, unit: 'units', as_of: NOW });
    expect(after.field_sources['readings.progress']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1' });
    expect(f.store.assetReadingHistory(f.spanish.id, 'progress').map(row => row.value)).toEqual([5, 4]);
  });
  it('replaces the Where I am the owner typed, keeping the chat as its source, and leaves every other fact alone', async () => {
    const f = harness();
    const change = where(f.spanish.id, 'Finished unit 5');
    // Asked before the owner is asked (D-329): it would go through, so the owner is asked.
    expect(await checkWorkUpdate(f.deps, change, inChat)).toBeNull();
    expect(f.store.readAsset(f.spanish.id)).toEqual(f.spanish);
    expect(await f.update(change, approved)).toMatchObject({ ok: true, result: { fields: ['attributes'] } });
    const after = f.store.readAsset(f.spanish.id)!;
    expect(after.attributes).toEqual({ horizon: 'ongoing', why: 'To talk with Ana’s family', where_i_am: 'Finished unit 5' });
    expect(after.field_sources['attributes.where_i_am']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1' });
    for (const path of ['attributes.horizon', 'attributes.why', 'dates.target_on', 'readings.progress'])
      expect(after.field_sources[path]).toEqual(f.spanish.field_sources[path]);
    // And the owner's own next note replaces the chat's.
    const typed = f.store.writeAsset({ id: f.spanish.id, source_id: f.spanish.source_id, source: { kind: 'owner', ref: 'owner:user-1' },
      attributes: { where_i_am: 'Halfway through unit 6' } }, NOW + 1000);
    expect(typed.attributes.where_i_am).toBe('Halfway through unit 6');
    expect(typed.field_sources['attributes.where_i_am']).toMatchObject({ kind: 'owner' });
  });
  it('changes the owner’s other facts too once they approve: why, horizon and target date (D-343 ruling 16)', async () => {
    const f = harness();
    for (const change of [{ kind: 'asset', id: f.spanish.id, attributes: { why: 'For work' } },
      { kind: 'asset', id: f.spanish.id, attributes: { horizon: 'this year' } },
      { kind: 'asset', id: f.spanish.id, dates: { target_on: '2027-06-30' } },
      { kind: 'asset', id: f.spanish.id, attributes: { why: 'For work and family', where_i_am: 'Finished unit 5' } }]) {
      expect(await checkWorkUpdate(f.deps, change, inChat), JSON.stringify(change)).toBeNull();
      expect(await f.update(change, approved), JSON.stringify(change)).toMatchObject({ ok: true });
    }
    const after = f.store.readAsset(f.spanish.id)!;
    expect(after).toMatchObject({ dates: { target_on: '2027-06-30' },
      attributes: { horizon: 'this year', why: 'For work and family', where_i_am: 'Finished unit 5' } });
    for (const path of ['attributes.horizon', 'attributes.why', 'dates.target_on', 'attributes.where_i_am'])
      expect(after.field_sources[path], path).toMatchObject({ kind: 'owner', ref: 'chat:sess-1' });
  });
  it('covers any thing the owner approves a write to, and none they did not', async () => {
    const f = harness();
    const bike = f.owners({ name: 'Bike', attributes: { where_i_am: 'In the shed' } });
    expect((await f.update(where(bike.id, 'At the shop'), inChat) as Refused).detail).toContain('an AI may not change');
    expect(f.store.readAsset(bike.id)).toEqual(bike);
    expect(await f.update(where(bike.id, 'At the shop'), approved)).toMatchObject({ ok: true });
    expect(f.store.readAsset(bike.id)!.attributes.where_i_am).toBe('At the shop');
  });
  it('covers an AI app over MCP too, once the owner approved its write (ruling 11)', async () => {
    const f = harness();
    const change = where(f.spanish.id, 'Finished unit 5');
    // Asked before the owner is asked, as the door asks it: it would go through, so the owner is asked.
    expect(await checkWorkUpdate(f.deps, change, mcpUnapproved)).toBeNull();
    // Run without the owner's approval, it is refused, as before.
    expect((await f.update(change, mcpUnapproved) as Refused).detail).toContain('an AI may not change');
    expect(f.store.readAsset(f.spanish.id)).toEqual(f.spanish);
    // Approved, the note is the app's, and every other fact stays the owner's.
    expect(await f.update(change, overMcp)).toMatchObject({ ok: true, result: { fields: ['attributes'] } });
    const after = f.store.readAsset(f.spanish.id)!;
    expect(after.attributes).toEqual({ ...f.spanish.attributes, where_i_am: 'Finished unit 5' });
    expect(after.field_sources['attributes.where_i_am']).toMatchObject({ kind: 'owner', ref: 'mcp:tok-1' });
    for (const path of ['attributes.horizon', 'attributes.why', 'dates.target_on', 'readings.progress'])
      expect(after.field_sources[path]).toEqual(f.spanish.field_sources[path]);
    // Its other facts too, once the owner approves (D-343 ruling 16); never without.
    const why = { kind: 'asset', id: f.spanish.id, attributes: { why: 'For work' } };
    expect(await checkWorkUpdate(f.deps, why, mcpUnapproved)).toBeNull();
    expect((await f.update(why, mcpUnapproved) as Refused).detail).toContain('an AI may not change');
  });
  it('covers the owner’s approval only: not a chat under a contract, or a recipe', async () => {
    const f = harness();
    expect((await f.update(where(f.spanish.id, 'Finished unit 5'), memberChat) as Refused).ok).toBe(false);
    // A recipe's write through the kernel op names its own source, so "chat:" in it is a claim, not the chat.
    await expect(f.dispatchers.assetUpdate({ id: f.spanish.id, attributes: { where_i_am: 'Finished unit 5' },
      source: { kind: 'extracted', ref: 'chat:sess-1' } })).resolves.toMatchObject({ asset: { attributes: { where_i_am: 'Finished unit 4' } } });
    expect(f.store.readAsset(f.spanish.id)).toEqual(f.spanish);
  });
});
