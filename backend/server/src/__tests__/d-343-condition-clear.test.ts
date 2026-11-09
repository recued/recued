/** D-343 slice 1 (ruling 14) — the chat clears a condition the user says is over ("I replaced
 *  the alarm battery"), or records it back, through `work.update`'s `conditions`, as Yours'
 *  "Update condition" does. A clear condition ends the reminder it raised, kept. Before this,
 *  the chat could close the reminder but not the condition, so the thing still said "Present".
 *  The owner's approved entry is theirs (ruling 16), so it pauses a device that reports the
 *  condition, as their own entry does, and the result says so.
 *
 *  ⛔ DRIVEN ON THE REAL STORE, DISPATCHERS, TYPES, OCCURRENCE SERVICE AND HANDLERS. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Asset, type ExecutionSource } from '@recued/contracts';
import { buildChatTier1Handlers, checkWorkUpdate, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { assetTypeApplication, assetTypes } from '../situations/asset-types.js';
import { createConditionReminderLookup } from '../situations/renewal-guard.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const member: ExecutionSource = { channel: 'chat', actor: 'contracted_user', chat_session_id: 'chat-2', user_id: 'member-1', contract_id: 'household-1' } as never;
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, time_zone: 'Europe/Dublin' } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true, time_zone: 'Europe/Dublin' } as never;
const theirs = { channel: 'internal_function_call', session_id: 'sess-2', execution_source: member } as never;
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
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW, assetTypes: assetTypes(db),
    conditionOfReminder: createConditionReminderLookup(db, store, () => NOW) });
  const occurrences = createAssetOccurrenceService({ db, work: store, dispatchers, timeZone: () => 'Europe/Dublin', now: () => NOW,
    withdraw: async () => {}, emitRule: async () => {}, outcome: async () => {} });
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: () => true }),
    getAssetTypes: () => assetTypes(db),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const update = buildChatTier1Handlers(deps)['work.update']!;
  /** A smoke alarm of its type, its battery reported low by `by` (a device, unless the owner). */
  const alarm = async (by: 'observation' | 'owner' = 'observation'): Promise<{ asset: Asset; reminder: () => string }> => {
    const made = store.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner:user-1' }, name: 'Hall smoke alarm',
      dates: { last_tested_on: null }, observations: { battery_low: null } } as never, NOW - 2 * DAY);
    const typed = store.writeAsset({ ...assetTypeApplication(assetTypes(db).get('smoke_alarm')!), id: made.id, source_id: made.source_id }, NOW - 2 * DAY);
    const low = { active: true, certainty: 'confirmed' as const, as_of: NOW - DAY, evidence: [] };
    if (by === 'owner') store.writeAsset({ id: typed.id, source_id: typed.source_id, source: { kind: 'owner', ref: 'owner:user-1' },
      observations: { battery_low: { ...low, source: '' } } }, NOW - DAY);
    else {
      // The alarm's own report, through the writer bound to it, as a device's comes.
      store.bindAssetObservations({ id: 'binding-hall', asset_id: typed.id, actor_ref: 'device:hall', source_ref: 'device:hall',
        fields: ['observations.battery_low'], enabled: true });
      store.writeAssetObservations({ binding_id: 'binding-hall', actor_ref: 'device:hall', observations: { battery_low: low } }, NOW - DAY);
    }
    const asset = store.readAsset(typed.id)!;
    await occurrences.reconcileAsset(asset.id);
    const reminder = () => createAssetOccurrenceStore(db).byAsset(asset.id).find((row) => row.rule_id === 'battery')!.commitment_id!;
    return { asset, reminder };
  };
  return { store, deps, update, alarm, occurrences };
};

describe('D-343 slice 1 — the chat keeps a condition’s reminder by clearing the condition', () => {
  it('points the close of a reminder whose condition holds to the condition, which keeps it', async () => {
    const f = harness();
    const { asset, reminder } = await f.alarm();
    const keep = { kind: 'commitment', id: reminder(), done: true };
    // Live, the model kept "Replace alarm battery" and left the alarm saying its battery was low.
    expect((await checkWorkUpdate(f.deps, keep, inChat) as Refused).detail).toBe(`work.update: “Replace alarm battery · Hall smoke alarm” closes once `
      + `\`battery_low\` is clear: send work.update with kind \`asset\`, id \`${asset.id}\` and conditions {"battery_low": "clear"}, which records it on `
      + 'Hall smoke alarm and keeps the reminder');
    expect(await f.update({ kind: 'asset', id: asset.id, conditions: { battery_low: 'clear' } }, approved)).toMatchObject({ ok: true });
    await f.occurrences.reconcileAsset(asset.id);
    expect(f.store.readCommitment(reminder())!.lifecycle_state).toBe('fulfilled');
    expect((await checkWorkUpdate(f.deps, keep, inChat) as Refused).detail).toBe('work.update: “Replace alarm battery · Hall smoke alarm” is already kept');
  });
  it('closes a reminder whose condition already cleared before the clock’s pass, without pointing at it', async () => {
    const f = harness();
    const { asset, reminder } = await f.alarm();
    // The alarm reports a good battery; the minute pass has not yet closed the reminder.
    f.store.writeAssetObservations({ binding_id: 'binding-hall', actor_ref: 'device:hall',
      observations: { battery_low: { active: false, certainty: 'confirmed', as_of: NOW - 1000, evidence: [] } } }, NOW);
    expect(f.store.readCommitment(reminder())!.lifecycle_state).toBe('pending');
    expect(f.store.readAsset(asset.id)!.observations.battery_low).toMatchObject({ active: false });
    expect(await checkWorkUpdate(f.deps, { kind: 'commitment', id: reminder(), done: true }, inChat)).toBeNull();
  });
  it('lets a reminder be cancelled, and a household member’s chat close it, as before', async () => {
    const f = harness();
    const { reminder } = await f.alarm();
    expect(await checkWorkUpdate(f.deps, { kind: 'commitment', id: reminder(), state: 'cancelled' }, inChat)).toBeNull();
    expect(await checkWorkUpdate(f.deps, { kind: 'commitment', id: reminder(), done: true }, theirs)).toBeNull();
  });
});

describe('D-343 slice 1 — the chat clears a condition', () => {
  it('records a condition over, asked before the owner is, and its reminder closes kept', async () => {
    const f = harness();
    const { asset, reminder } = await f.alarm();
    expect(f.store.readCommitment(reminder())!.lifecycle_state).toBe('pending');
    const clear = { kind: 'asset', id: asset.id, conditions: { battery_low: 'clear' } };
    expect(await checkWorkUpdate(f.deps, clear, inChat)).toBeNull();
    expect(await f.update(clear, approved)).toEqual({ ok: true, result: { updated: true, kind: 'asset', id: asset.id, fields: ['conditions'],
      note: 'A device or recipe reported `battery_low`. The user\'s entry now stands, and pauses it until they allow its automatic updates in Yours. Say so.' } });
    const after = f.store.readAsset(asset.id)!;
    expect(after.observations.battery_low).toMatchObject({ active: false, certainty: 'confirmed', as_of: NOW });
    expect(after.field_sources['observations.battery_low']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1' });
    await f.occurrences.reconcileAsset(asset.id);
    expect(f.store.readCommitment(reminder())!.lifecycle_state).toBe('fulfilled');
  });
  it('says nothing of a device when the condition was the owner’s own, and records one back', async () => {
    const f = harness();
    const { asset } = await f.alarm('owner');
    const res = await f.update({ kind: 'asset', id: asset.id, conditions: { battery_low: 'clear' } }, approved) as Ok;
    expect(res.result).not.toHaveProperty('note');
    expect(await f.update({ kind: 'asset', id: asset.id, conditions: { battery_low: 'present' } }, approved)).toMatchObject({ ok: true });
    expect(f.store.readAsset(asset.id)!.observations.battery_low).toMatchObject({ active: true });
  });
  it('refuses what the thing keeps no condition of, or a state it is already in, before anyone is asked', async () => {
    const f = harness();
    const { asset } = await f.alarm();
    for (const [conditions, words] of [
      [{ smoke_detected: 'clear' }, '`Hall smoke alarm` keeps the conditions `battery_low`, not `smoke_detected`. The user can add the field in Yours'],
      [{ battery_low: 'fixed' }, '`conditions.battery_low` is `clear` or `present`'],
      [{ battery_low: 'present' }, '`Hall smoke alarm`\'s `battery_low` is already present'],
      ['clear', '`conditions` names each condition with `clear` or `present`'],
    ] as const) {
      const refused = await checkWorkUpdate(f.deps, { kind: 'asset', id: asset.id, conditions }, inChat) as Refused;
      expect(refused, JSON.stringify(conditions)).toMatchObject({ ok: false, reason: 'invalid_args' });
      expect(refused.detail, JSON.stringify(conditions)).toContain(words);
    }
    expect(f.store.readAsset(asset.id)!.observations.battery_low).toMatchObject({ active: true });
  });
  it('leaves a device’s condition to the owner in a household member’s chat', async () => {
    const f = harness();
    const { asset, reminder } = await f.alarm();
    expect((await checkWorkUpdate(f.deps, { kind: 'asset', id: asset.id, conditions: { battery_low: 'clear' } }, theirs) as Refused).detail)
      .toBe('work.update: a device or recipe reports `battery_low`, so an AI may not change it. Tell the user why, and that the owner can change it in Yours. '
        + 'Leave it out to change the rest');
    expect(f.store.readCommitment(reminder())!.lifecycle_state).toBe('pending');
  });
});
