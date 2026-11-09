/** D-343 slice 1 (ruling 14) — the chat keeps or cancels a commitment, as the owner's Done in
 *  Today does: `work.update` with `done: true` (and `done_on`, the day it was done), or
 *  `state: "cancelled"`. A due item from a thing's clock stands for a commitment, so this closes
 *  it too. The owner's approved close is their own completion, so a due item's clock runs from
 *  the day it was done; a renewal still closes only by its new date (2026-10-24j), and the
 *  refusal says which date to enter.
 *
 *  ⛔ DRIVEN ON THE REAL STORE, DISPATCHERS, OCCURRENCE SERVICE, RENEWAL GUARD AND HANDLERS,
 *  composed as the server composes them (`compose-collection-context.ts`). */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tier1CallTitle, type AssetRule, type Commitment, type ExecutionSource } from '@recued/contracts';
import { ASSET_UPDATE_OP_ID, buildChatTier1Handlers, checkWorkUpdate, COMMITMENT_CANCEL_OP_ID, COMMITMENT_FULFILL_OP_ID,
  type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createOwnerCompletionWriter } from '../situations/owner-completion.js';
import { createReminderDateGuard, createRenewalFulfillGuard } from '../situations/renewal-guard.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { assetTypeApplication, assetTypes } from '../situations/asset-types.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const member: ExecutionSource = { channel: 'chat', actor: 'contracted_user', chat_session_id: 'chat-2', user_id: 'member-1', contract_id: 'household-1' } as never;
/** The owner's chat before they are asked (the check), and once they approved the call. */
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, time_zone: 'Europe/Dublin' } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true, time_zone: 'Europe/Dublin' } as never;
const memberApproved = { channel: 'internal_function_call', session_id: 'sess-2', execution_source: member, owner_approved: true } as never;
type Ok = { ok: true; result: Record<string, unknown> };
type Refused = { ok: false; reason: string; detail: string };
const NOW = Date.parse('2026-11-06T18:00:00Z');
const DAY = 86_400_000;
const service: AssetRule = { id: 'service', title: 'Service boiler', enabled: true, muted: false, pinned: false, consequence: 'routine',
  expiry_policy: 'escalate_overdue', when: { kind: 'interval', field: 'last_serviced_on', every: { amount: 12, unit: 'months' } },
  reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } };

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = (granted: (op: string) => boolean = () => true) => {
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW, assetTypes: assetTypes(db),
    ownerCompletionWrite: createOwnerCompletionWriter(db, store), commitmentFulfillGuard: createRenewalFulfillGuard(db, store),
    aiAssetDateGuard: createReminderDateGuard(db, store) });
  const occurrences = createAssetOccurrenceService({ db, work: store, dispatchers, timeZone: () => 'Europe/Dublin', now: () => NOW,
    withdraw: async () => {}, emitRule: async () => {}, outcome: async () => {} });
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: (_source: ExecutionSource, op?: string) => op === undefined || granted(op) }),
    getAssetTypes: () => assetTypes(db),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const update = buildChatTier1Handlers(deps)['work.update']!;
  const promise = async (statement: string, patch: Record<string, unknown> = {}): Promise<Commitment> => (await dispatchers.commitmentCreate({
    direction: 'outbound', statement, derivation: 'user_declared', promised_for_at: NOW + 3 * DAY, ...patch } as never)).commitment;
  /** A thing with a clock, its due item made as the server makes it: its own rules, or its type's,
   *  and its dates set by the owner unless an AI set them. */
  const dueItem = async (name: string, rules: AssetRule[] | string, dates: Record<string, string>, by: 'owner' | 'extracted' = 'owner') => {
    const made = store.writeAsset({ source_id: 'recued.asset', source: by === 'owner' ? { kind: 'owner', ref: 'owner:user-1' } : { kind: 'extracted', ref: 'chat:earlier' }, name, dates,
      ...(typeof rules === 'string' ? {} : { rules }) } as never, NOW - DAY);
    const type = typeof rules === 'string' ? assetTypes(db).get(rules)! : null;
    const asset = type ? store.writeAsset({ ...assetTypeApplication(type), id: made.id, source_id: made.source_id }, NOW - DAY) : made;
    await occurrences.reconcileAsset(asset.id);
    const [row] = createAssetOccurrenceStore(db).byAsset(asset.id);
    return { asset, row: row!, commitment: store.readCommitment(row!.commitment_id!)! };
  };
  return { store, dispatchers, occurrences, deps, update, promise, dueItem, rows: createAssetOccurrenceStore(db) };
};

describe('D-343 slice 1 — the chat keeps or cancels a commitment', () => {
  it('keeps a promise once the owner approves it, asked before they are, under a title in their words', async () => {
    const f = harness(); const quote = await f.promise('Send Anna the signed quote');
    const keep = { kind: 'commitment', id: quote.id, done: true };
    expect(await checkWorkUpdate(f.deps, keep, inChat)).toBeNull();
    expect(f.store.readCommitment(quote.id)!.lifecycle_state).toBe('pending');
    expect(tier1CallTitle('work.update', keep)).toBe('Mark a commitment kept');
    expect(await f.update(keep, approved)).toEqual({ ok: true, result: { updated: true, kind: 'commitment', id: quote.id, done: true } });
    expect(f.store.readCommitment(quote.id)).toMatchObject({ lifecycle_state: 'fulfilled', lifecycle_changed_at: NOW });
    // Once kept, it stays so: asked again, the model is told, and the owner is not asked.
    expect((await checkWorkUpdate(f.deps, keep, inChat) as Refused).detail).toBe('work.update: “Send Anna the signed quote” is already kept');
  });
  it('cancels one no longer needed, by `state: "cancelled"`', async () => {
    const f = harness(); const trial = await f.promise('Decide on the Netflix trial');
    const cancel = { kind: 'commitment', id: trial.id, state: 'cancelled' };
    expect(tier1CallTitle('work.update', cancel)).toBe('Cancel a commitment');
    expect(await checkWorkUpdate(f.deps, cancel, inChat)).toBeNull();
    expect(await f.update(cancel, approved)).toMatchObject({ ok: true, result: { cancelled: true } });
    expect(f.store.readCommitment(trial.id)!.lifecycle_state).toBe('cancelled');
    expect((await checkWorkUpdate(f.deps, { kind: 'commitment', id: trial.id, done: true }, inChat) as Refused).detail)
      .toBe('work.update: “Decide on the Netflix trial” was cancelled');
  });
  it('closes a due item, and the owner’s approved close runs its clock from the day it was done', async () => {
    const f = harness();
    const boiler = await f.dueItem('Boiler', [service], { last_serviced_on: '2025-11-20' });
    expect(boiler.commitment).toMatchObject({ lifecycle_state: 'pending', derivation: 'rule_emitted' });
    expect(await f.update({ kind: 'commitment', id: boiler.commitment.id, done: true, done_on: '2026-11-03' }, approved)).toMatchObject({ ok: true });
    await f.occurrences.reconcileAsset(boiler.asset.id);
    expect(f.rows.completion(boiler.row.id)).toMatchObject({ owner_action: true });
    expect(f.store.readAsset(boiler.asset.id)!.dates.last_serviced_on).toBe('2026-11-03');
  });
  it('runs it from today with no `done_on`, and asks the owner when the close is not theirs', async () => {
    const f = harness();
    const today = await f.dueItem('Boiler', [service], { last_serviced_on: '2025-11-20' });
    await f.update({ kind: 'commitment', id: today.commitment.id, done: true }, approved);
    await f.occurrences.reconcileAsset(today.asset.id);
    expect(f.store.readAsset(today.asset.id)!.dates.last_serviced_on).toBe('2026-11-06');
    // A household member's chat approves its own card, which is no word from the owner.
    const theirs = await f.dueItem('Hall alarm', [{ ...service, id: 'test', title: 'Test alarm' }], { last_serviced_on: '2025-11-25' });
    await f.update({ kind: 'commitment', id: theirs.commitment.id, done: true, done_on: '2026-11-04' }, memberApproved);
    await f.occurrences.reconcileAsset(theirs.asset.id);
    expect(f.rows.completion(theirs.row.id)).toMatchObject({ known: false });
    expect(f.rows.completion(theirs.row.id)!.owner_action).not.toBe(true);
    expect(f.store.readAsset(theirs.asset.id)!.dates.last_serviced_on).toBe('2025-11-25');
  });
  it('refuses a renewal’s close before asking and names its new date, which the owner’s approved chat enters (ruling 16)', async () => {
    const f = harness();
    const passport = await f.dueItem('Passport', 'passport', { expires_on: '2027-02-01' });
    const named = (due: { commitment: Commitment; asset: { id: string } }, name: string) => `work.update: “${due.commitment.statement}” closes `
      + `once its new date is entered: change \`expires_on\` on ${name} (kind \`asset\`, id \`${due.asset.id}\`) with work.update`;
    expect((await checkWorkUpdate(f.deps, { kind: 'commitment', id: passport.commitment.id, done: true }, inChat) as Refused).detail)
      .toBe(named(passport, 'Passport'));
    expect(f.store.readCommitment(passport.commitment.id)!.lifecycle_state).toBe('pending');
    // The date the owner typed: their approved write of the new one is theirs, and closes the renewal, kept.
    const renewal = { kind: 'asset', id: passport.asset.id, dates: { expires_on: '2036-03-10' } };
    expect(await checkWorkUpdate(f.deps, renewal, inChat)).toBeNull();
    expect(await f.update(renewal, approved)).toMatchObject({ ok: true });
    await f.occurrences.reconcileAsset(passport.asset.id);
    expect(f.store.readAsset(passport.asset.id)!.field_sources['dates.expires_on']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1' });
    expect(f.store.readCommitment(passport.commitment.id)!.lifecycle_state).toBe('fulfilled');
    // A household member did not set it and has no Yours, so their chat is told whose it is.
    const family = await f.dueItem('Family passport', 'passport', { expires_on: '2027-02-15' });
    const theirs = { channel: 'internal_function_call', session_id: 'sess-2', execution_source: member } as never;
    expect((await checkWorkUpdate(f.deps, { kind: 'commitment', id: family.commitment.id, done: true }, theirs) as Refused).detail)
      .toBe(`work.update: “${family.commitment.statement}” closes once its new date is entered: `
        + 'the owner set Family passport\'s `expires_on` themselves, so tell the user the owner enters the new date under Yours → Due');
    // A date an AI set, any chat may change, and is told how.
    const kept = await f.dueItem('Travel passport', 'passport', { expires_on: '2027-03-01' }, 'extracted');
    expect((await checkWorkUpdate(f.deps, { kind: 'commitment', id: kept.commitment.id, done: true }, theirs) as Refused).detail)
      .toBe(named(kept, 'Travel passport'));
  });
  it('keeps a service date’s open reminder: the date is refused before asking, and keeping the reminder records it (ruling 16)', async () => {
    const f = harness();
    const boiler = await f.dueItem('Boiler', [service], { last_serviced_on: '2025-11-20' });
    const id = boiler.commitment.id; const statement = boiler.commitment.statement;
    const date = { kind: 'asset', id: boiler.asset.id, dates: { last_serviced_on: '2026-11-03' } };
    // Live, the model kept the reminder and wrote the date in one turn, 5 of 5 times, and the date
    // ran first, which closed the reminder as cancelled. So the date names the reminder instead.
    expect((await checkWorkUpdate(f.deps, date, inChat) as Refused).detail).toBe(`work.update: “${statement}” is open, and keeping it `
      + `records \`last_serviced_on\`: send work.update with kind \`commitment\`, id \`${id}\` and \`done: true\`, with \`done_on\` for the day it was `
      + 'done. If it was not done and the date is only wrong, tell the user they can correct it in Yours. Leave `last_serviced_on` out to change the rest');
    expect(await f.update(date, approved)).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(f.store.readAsset(boiler.asset.id)!.dates.last_serviced_on).toBe('2025-11-20');
    // The turn's other call keeps it, and records the date as the owner's.
    const keep = { kind: 'commitment', id, done: true, done_on: '2026-11-03' };
    expect(await checkWorkUpdate(f.deps, keep, inChat)).toBeNull();
    expect(await f.update(keep, approved)).toMatchObject({ ok: true });
    await f.occurrences.reconcileAsset(boiler.asset.id);
    expect(f.store.readCommitment(id)!.lifecycle_state).toBe('fulfilled');
    expect(f.store.readAsset(boiler.asset.id)!.dates.last_serviced_on).toBe('2026-11-03');
    // With no reminder open, the date is the owner's approved chat's to change, as an edit.
    const fix = { kind: 'asset', id: boiler.asset.id, dates: { last_serviced_on: '2026-11-04' } };
    expect(await checkWorkUpdate(f.deps, fix, inChat)).toBeNull();
    expect(await f.update(fix, approved)).toMatchObject({ ok: true });
    expect(f.store.readAsset(boiler.asset.id)!.field_sources['dates.last_serviced_on']).toMatchObject({ kind: 'owner', ref: 'chat:sess-1' });
  });
  it('tells a household member’s chat the owner confirms the date, and leaves a date no open reminder reads to the ranks', async () => {
    const f = harness();
    const boiler = await f.dueItem('Boiler', [service], { last_serviced_on: '2025-11-20' });
    const theirs = { channel: 'internal_function_call', session_id: 'sess-2', execution_source: member } as never;
    expect((await checkWorkUpdate(f.deps, { kind: 'asset', id: boiler.asset.id, dates: { last_serviced_on: '2026-11-03' } }, theirs) as Refused).detail)
      .toBe(`work.update: “${boiler.commitment.statement}” is open, and keeping it records the date once the owner confirms it: `
        + `send work.update with kind \`commitment\`, id \`${boiler.commitment.id}\` and \`done: true\`. `
        + 'If it was not done and the date is only wrong, tell the user the owner can correct it in Yours. Leave `last_serviced_on` out to change the rest');
    // Another date: the owner's approved chat changes it; a member's chat is refused by its rank, with no reminder named.
    const bike = f.store.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner:user-1' }, name: 'Bike', dates: { bought_on: '2024-05-01' } } as never, NOW - DAY);
    const bought = { kind: 'asset', id: bike.id, dates: { bought_on: '2024-05-02' } };
    expect(await checkWorkUpdate(f.deps, bought, inChat)).toBeNull();
    expect((await checkWorkUpdate(f.deps, bought, theirs) as Refused).detail).toBe('work.update: the owner set `bought_on` themselves, so an AI may not '
      + 'change it. Tell the user why, and that the owner can change it in Yours. Leave it out to change the rest');
  });
  it('succeeds without changing anything when the same close landed before its card was approved', async () => {
    const f = harness();
    const boiler = await f.dueItem('Boiler', [service], { last_serviced_on: '2025-11-20' });
    const keep = { kind: 'commitment', id: boiler.commitment.id, done: true, done_on: '2026-11-03' };
    expect(await checkWorkUpdate(f.deps, keep, inChat)).toBeNull();
    // Kept from Today before the card was approved.
    await f.dispatchers.ownerCommitmentFulfill({ id: boiler.commitment.id });
    const kept = f.store.readCommitment(boiler.commitment.id)!;
    expect(await f.update(keep, approved)).toEqual({ ok: true, result: { updated: true, kind: 'commitment', id: boiler.commitment.id, done: true } });
    expect(f.store.readCommitment(boiler.commitment.id)).toEqual(kept);
    // Asked about first, it is refused: there is nothing to approve.
    expect((await checkWorkUpdate(f.deps, keep, inChat) as Refused).detail).toBe(`work.update: “${boiler.commitment.statement}” is already kept`);
  });
});

describe('D-343 slice 1 — what a commitment’s close refuses', () => {
  it('refuses what a commitment cannot take, each before the owner is asked', async () => {
    const f = harness(); const quote = await f.promise('Send Anna the signed quote');
    const task = (await f.dispatchers.taskCreate({ title: 'Book the dentist' } as never)).task;
    for (const [call, words] of [
      [{ done: false }, 'a kept or cancelled commitment stays closed'],
      [{ state: 'blocked' }, 'a commitment\'s only `state` is `cancelled`'],
      [{ done: true, state: 'cancelled' }, 'not both'],
      [{ done_on: '2026-11-03' }, '`done_on` goes with `done: true`'],
      [{ done: true, done_on: '2026-11-09' }, 'not after today'],
      [{ done: true, done_on: 'last Tuesday' }, 'as YYYY-MM-DD'],
      [{ done: true, title: 'Send the quote' }, 'on its own, without `title`'],
    ] as const) {
      const refused = await checkWorkUpdate(f.deps, { kind: 'commitment', id: quote.id, ...call }, inChat) as Refused;
      expect(refused, JSON.stringify(call)).toMatchObject({ ok: false, reason: 'invalid_args' });
      expect(refused.detail, JSON.stringify(call)).toContain(words);
    }
    expect((await checkWorkUpdate(f.deps, { kind: 'task', id: task.id, done: true, done_on: '2026-11-03' }, inChat) as Refused).detail)
      .toBe('work.update: `done_on` applies to a commitment only');
    expect(f.store.readCommitment(quote.id)!.lifecycle_state).toBe('pending');
  });
  it('keeps to the contract’s grants: keeping and cancelling each need their own', async () => {
    const f = harness((op) => op !== COMMITMENT_FULFILL_OP_ID); const quote = await f.promise('Send Anna the signed quote');
    expect(await checkWorkUpdate(f.deps, { kind: 'commitment', id: quote.id, done: true }, inChat)).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(await checkWorkUpdate(f.deps, { kind: 'commitment', id: quote.id, state: 'cancelled' }, inChat)).toBeNull();
    const g = harness((op) => op !== COMMITMENT_CANCEL_OP_ID && op !== ASSET_UPDATE_OP_ID);
    expect(await checkWorkUpdate(g.deps, { kind: 'commitment', id: (await g.promise('Call the bank')).id, state: 'cancelled' }, inChat))
      .toMatchObject({ ok: false, reason: 'classification_blocked' });
  });
  it('says a routine reminder that lapsed on its date stays closed', async () => {
    const f = harness(); const lapsed = await f.promise('Water the plants', { expiry_policy: 'strict_expire' });
    f.store.writeCommitment({ ...f.store.readCommitment(lapsed.id)!, lifecycle_state: 'expired' } as never, NOW);
    expect((await checkWorkUpdate(f.deps, { kind: 'commitment', id: lapsed.id, done: true }, inChat) as Refused).detail)
      .toBe('work.update: “Water the plants” lapsed on its date and stays closed');
  });
});
