import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetRule, ConnectionRow } from '@recued/contracts';
import {
  createAskDeliveryStore, createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, extractAskId,
  type AskDeliveryEnvelope, type AskDeliveryRecord, type Channel, type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetReminderService, type AssetReminderService } from '../situations/asset-reminder-service.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createHouseholdDeliveryStore } from '../storage/household-delivery-store.js';
import { authorizeReminderOrigin } from '../situations/reminder-destinations.js';

const source = { kind: 'owner' as const, ref: 'owner:local' };
const rule = (patch: Partial<AssetRule> = {}): AssetRule => ({ id: 'renew', title: 'Renew', enabled: true, muted: false,
  pinned: false, consequence: 'floor', expiry_policy: 'escalate_overdue', when: { kind: 'expiry', field: 'expires_on' },
  reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [
    { amount: 6, unit: 'months' }, { amount: 3, unit: 'months' }, { amount: 1, unit: 'months' },
  ], on_day: true, after: { amount: 1, unit: 'months' } }, ...patch });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const fixture = (realHousehold = false) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let time = Date.parse('2026-10-17T12:00Z'); let quiet = false; let unlocked = true; let phone = true; let refuses = false; let refusesHousehold = false;
  let service: AssetReminderService;
  const sends: AskDeliveryEnvelope[] = [];
  const withdrawals = vi.fn(async () => true);
  const errors = vi.fn();
  const household = createHouseholdDeliveryStore(db);
  const connections: ConnectionRow[] = [{ pk: 'notification:family', kind: 'notification', subtype: 'telegram', name: 'family', display_name: 'Family',
    enrolled_at: 200, updated_at: 200, config_json: JSON.stringify({ chat_id: '-100123', principal_id: '1001' }), auth_ciphertext: 'not-used' }];
  if (realHousehold) household.setTelegram(connections[0]!, ['1001', '1002'], time);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time });
  const channel: Channel = { name: 'telegram', capability: 'inline', owns_llm_egress: false, deliverNotify: async () => {}, deliverAsk: async () => {}, closeAsk: async () => {},
    deliverAskDelivery: async envelope => { sends.push(structuredClone(envelope));
      return refuses || (refusesHousehold && envelope.destination.audience === 'household') ? { outcome: 'not_delivered', error: 'offline' }
        : { outcome: 'delivered', provider_message_id: `provider-${sends.length}` }; },
    withdrawAskDelivery: withdrawals, restoreAskDelivery: async () => {} };
  const boot = () => {
    const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'America/Los_Angeles', now: () => time,
      isVaultUnlocked: () => unlocked, withdraw: async id => { service?.withdraw(id); } });
    service = createAssetReminderService({ db, work, dispatchers, occurrences, timeZone: () => 'America/Los_Angeles',
      isQuiet: () => quiet, isVaultUnlocked: () => unlocked, now: () => time, log: errors,
      householdDestinations: async () => realHousehold ? household.destinations(connections) : [{ id: 'household', channel: 'telegram', connection_name: 'family',
        connection_enrolled_at: 200, recipient: 'family-chat', expected_sender: 'owner' }] });
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      deliveryStore: createAskDeliveryStore(createSQLiteCollection<AskDeliveryRecord>(db, 'ask_deliveries')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} }), channel], now: () => time, isVaultUnlocked: () => unlocked,
      shouldHoldReminder: () => quiet,
      ...(realHousehold ? { authorizeReminderOrigin: (destination, origin, reply) => destination.id === 'owner' ? origin.sender === 'owner'
        && origin.connection_name === 'private' && origin.connection_enrolled_at === 100 && origin.recipient === 'private-chat'
        : authorizeReminderOrigin(destination, origin, connections, household, reply) } : {}),
      resolveReminderDestinations: async () => ({ destinations: [{ id: 'owner-ui', channel: 'ui' }, ...(phone ? [{ id: 'owner', channel: 'telegram' as const,
        connection_name: 'private', connection_enrolled_at: 100, recipient: 'private-chat', expected_sender: 'owner' }] : [])], issues: [] }) });
    service.bind(block);
    return { block, service, occurrences };
  };
  cleanups.push(async () => { await service?.stop(); db.close(); });
  const put = (patch: Partial<Asset> & { name: string }) => work.writeAsset({ source_id: 'recued.asset', source, ...patch }, time);
  const occurrence = (asset: Asset) => createAssetOccurrenceStore(db).byAsset(asset.id).find(row => !row.commitment_id || work.readCommitment(row.commitment_id)?.lifecycle_state === 'pending')!;
  const currentAsk = (asset: Asset) => createOccurrenceReminderStore(db).control(occurrence(asset).id).current_ask_id!;
  return { db, work, dispatchers, put, boot, sends, withdrawals, errors, occurrence, currentAsk, household, connections,
    advance: (date: string) => { time = Date.parse(date); }, quiet: (value: boolean) => { quiet = value; }, seal: () => { unlocked = false; }, unlock: () => { unlocked = true; }, toastOnly: () => { phone = false; }, refuse: (value: boolean) => { refuses = value; },
    refuseHousehold: (value: boolean) => { refusesHousehold = value; } };
};

describe('D-325 actual clock reminder caller', () => {
  it('asks the owner to confirm household service before advancing its interval', async () => {
    const f = fixture(true); const asset = f.put({ name: 'Shared boiler', audience: 'household', dates: { serviced_on: '2025-10-17' },
      rules: [rule({ when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } } })] });
    const b = f.boot(); await b.service.tick(); const occurrence = f.occurrence(asset); const ask_id = f.currentAsk(asset);
    await b.block.submitAnswer({ ask_id, option: 'done', via: 'telegram', origin: {
      connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', sender: '1002' } });
    await b.service.tick();
    expect(f.work.readCommitment(occurrence.commitment_id!)!.lifecycle_state).toBe('fulfilled');
    expect(createAssetOccurrenceStore(f.db).completion(occurrence.id)).toMatchObject({ known: false });
    expect(f.work.readAsset(asset.id)!.dates.serviced_on).toBe('2025-10-17');
    await b.occurrences.confirmCompletion({ occurrence_id: occurrence.id, on: '2026-10-17' });
    expect(createAssetOccurrenceStore(f.db).completion(occurrence.id)).toMatchObject({ owner_action: true, confirmed_on: '2026-10-17' });
    expect(f.work.readAsset(asset.id)!.dates.serviced_on).toBe('2026-10-17');
    await b.service.tick();
    f.advance('2027-07-17T12:00Z'); await b.service.tick(); const next = f.occurrence(f.work.readAsset(asset.id)!);
    expect(next.id).not.toBe(occurrence.id); expect(f.work.readCommitment(next.commitment_id!)!.promised_for_at).toBe(Date.parse('2027-10-17'));
  });
  it('cancels only the current interval when the owner answers Not needed', async () => {
    const f = fixture(true); const asset = f.put({ name: 'Boiler upkeep', dates: { serviced_on: '2025-10-17' },
      rules: [rule({ when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } } })] });
    const b = f.boot(); await b.service.tick(); const original = f.occurrence(asset);
    await b.block.submitAnswer({ ask_id: f.currentAsk(asset), option: 'not_needed', via: 'telegram', origin: {
      connection_name: 'private', connection_enrolled_at: 100, recipient: 'private-chat', sender: 'owner' } });
    await b.service.tick();
    expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('cancelled');
    expect(f.work.readAsset(asset.id)!.rules[0]).toMatchObject({ enabled: true, muted: false });
    f.advance('2027-07-17T12:00Z'); await b.service.tick(); const next = f.occurrence(asset);
    expect(next).toBeDefined(); expect(next.id).not.toBe(original.id);
    expect(f.work.readCommitment(next.commitment_id!)!.promised_for_at).toBe(Date.parse('2027-10-17'));
  });
  it('lets only an original and currently allowed household member close the original shared task', async () => {
    const f = fixture(true); const shared = f.put({ name: 'Car', audience: 'household', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const privateAsset = f.put({ name: 'Passport', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick();
    const sharedAsk = f.currentAsk(shared); const privateAsk = f.currentAsk(privateAsset); const sharedOccurrence = f.occurrence(shared); const original = sharedOccurrence.commitment_id!;
    expect(f.sends.filter(send => send.destination.audience === 'household').flatMap(send => send.asks.map(ask => ask.ask_id))).toEqual([sharedAsk]);
    const origin = { connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', sender: '1002', provider_message_id: 'household-message' };
    await b.block.submitAnswer({ ask_id: sharedAsk, option: 'stop_requested', via: 'telegram', origin });
    expect((await b.block.getAsk(sharedAsk))!.status).toBe('open'); expect(f.work.readAsset(shared.id)!.rules[0]!.muted).toBe(false);
    for (const [ask_id, patch] of [[privateAsk, {}], [sharedAsk, { sender: '1003' }], [sharedAsk, { recipient: '-100999' }]] as const) {
      await b.block.submitAnswer({ ask_id, option: 'done', via: 'telegram', origin: { ...origin, ...patch } });
      expect((await b.block.getAsk(ask_id))!.status).toBe('open');
    }
    await b.block.submitAnswer({ ask_id: sharedAsk, option: 'done', via: 'telegram', origin });
    expect((await b.block.getAsk(sharedAsk))!.owner_answer).toBe(false);
    expect(createOccurrenceReminderStore(f.db).answers().find(answer => answer.ask_id === sharedAsk)!.owner_action).toBe(false);
    expect(createAssetOccurrenceStore(f.db).completion(sharedOccurrence.id)?.owner_action).toBeUndefined();
    expect(f.work.readCommitment(original)!.lifecycle_state).toBe('fulfilled');
    expect(f.work.listCommitments()).toHaveLength(2); expect((await b.block.getAsk(privateAsk))!.status).toBe('open');
    expect(f.withdrawals).toHaveBeenCalled(); expect(f.errors).not.toHaveBeenCalled();
  });
  it('revokes old member replies immediately and does not grant newly added members an old ask', async () => {
    const f = fixture(true); const shared = f.put({ name: 'Boiler', audience: 'household', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); const ask_id = f.currentAsk(shared);
    const commitment_id = f.occurrence(shared).commitment_id!;
    f.household.setTelegram(f.connections[0]!, ['1001', '1003']);
    for (const sender of ['1002', '1003']) await b.block.submitAnswer({ ask_id, option: 'done', via: 'telegram', origin: {
      connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', sender } });
    expect((await b.block.getAsk(ask_id))!.status).toBe('open');
    await b.block.submitAnswer({ ask_id, option: 'done', via: 'telegram', origin: {
      connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', sender: '1001' } });
    expect((await b.block.getAsk(ask_id))!.owner_answer).toBe(true);
    expect(createOccurrenceReminderStore(f.db).answers().find(answer => answer.ask_id === ask_id)!.owner_action).toBe(true);
    expect(f.work.readCommitment(commitment_id)!.lifecycle_state).toBe('fulfilled');
  });
  it('does not follow a deleted or changed household connection for old asks', async () => {
    const f = fixture(true); const shared = f.put({ name: 'Car', audience: 'household', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); const ask_id = f.currentAsk(shared); const original = { ...f.connections[0]! };
    const commitment_id = f.occurrence(shared).commitment_id!;
    for (const replacement of [{ ...original, enrolled_at: 201 }, { ...original, config_json: JSON.stringify({ chat_id: '-100456', principal_id: '1001' }) }]) {
      f.connections[0] = replacement;
      await b.block.submitAnswer({ ask_id, option: 'done', via: 'telegram', origin: {
        connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', sender: '1002' } });
      expect((await b.block.getAsk(ask_id))!.status).toBe('open'); expect(f.household.destinations(f.connections)).toEqual([]);
    }
    f.connections[0] = original; f.household.setTelegram(null);
    await b.block.submitAnswer({ ask_id, option: 'done', via: 'telegram', origin: {
      connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', sender: '1002' } });
    expect((await b.block.getAsk(ask_id))!.status).toBe('open');
    await b.block.submitAnswer({ ask_id, option: 'done', via: 'ui' });
    expect(f.work.readCommitment(commitment_id)!.lifecycle_state).toBe('fulfilled');
  });
  it('offers phone enrollment once for the first enabled clock even while its anchor date is unknown', async () => {
    const f = fixture(); f.toastOnly(); f.put({ name: 'Passport', dates: { expires_on: null }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); await b.service.tick();
    const asks = await b.block.listOpenAsks(); expect(asks).toHaveLength(1); expect(asks[0]!.handler_kind).toBe('asset-clock-phone-enrollment');
    await b.block.submitAnswer({ ask_id: asks[0]!.ask_id, option: 'later', via: 'ui' }); await b.service.tick();
    expect(await b.block.listOpenAsks()).toEqual([]); expect(f.work.listCommitments()).toEqual([]); expect(f.errors).not.toHaveBeenCalled();
  });
  it('holds failed destination retries during quiet hours, while an owner answer still withdraws accepted buttons', async () => {
    const f = fixture(); f.refuse(true); const asset = f.put({ name: 'Passport', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); expect(f.sends).toHaveLength(1);
    f.quiet(true); f.advance('2026-10-17T12:01Z'); await b.block.recoverPendingAsks(); expect(f.sends).toHaveLength(1);
    f.refuse(false); f.quiet(false); await b.block.recoverReminderAsks(); expect(f.sends).toHaveLength(2);
    f.quiet(true); await b.block.submitAnswer({ ask_id: f.currentAsk(asset), option: 'done', via: 'ui' });
    expect(f.withdrawals).toHaveBeenCalled(); expect(f.errors).not.toHaveBeenCalled();
  });
  it('coalesces past points and bundles by audience, preserving each independent question across restart', async () => {
    const f = fixture(); const passport = f.put({ name: 'Passport', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const licence = f.put({ name: 'Licence', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    f.put({ name: 'Car', audience: 'household', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    let b = f.boot(); await b.service.tick();
    expect(f.sends.map(send => `${send.destination.id}:${send.asks.length}`).sort()).toEqual(['household:1', 'owner:1', 'owner:2']);
    const first = f.currentAsk(passport); const second = f.currentAsk(licence);
    expect(first).not.toBe(second); expect((await b.block.getAsk(first))!.message.text).toContain('Due 2026-11-17');
    await b.service.stop(); b = f.boot(); await b.block.recoverPendingAsks(); await b.service.tick();
    expect(f.sends).toHaveLength(3); expect(f.currentAsk(passport)).toBe(first);
    await b.block.submitAnswer({ ask_id: second, option: 'done', via: 'ui' }); await b.service.tick();
    expect(f.work.readCommitment(f.occurrence(passport).commitment_id!)!.lifecycle_state).toBe('pending');
    expect((await b.block.getAsk(first))!.status).toBe('open'); expect((await b.block.getAsk(second))!.status).toBe('handled');
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('holds clocks through quiet hours, replaces an old ask at the next point, and treats dismissal as no answer', async () => {
    const f = fixture(); const asset = f.put({ name: 'Passport', dates: { expires_on: '2027-04-17' }, rules: [rule()] });
    const b = f.boot(); f.quiet(true); await b.service.tick(); expect(f.sends).toEqual([]);
    f.quiet(false); await b.service.tick(); const first = f.currentAsk(asset);
    await b.service.tick(); expect(f.sends).toHaveLength(1); expect((await b.block.getAsk(first))!.status).toBe('open');
    f.advance('2027-01-17T12:00Z'); await b.service.tick();
    expect(f.sends).toHaveLength(2); expect(f.currentAsk(asset)).not.toBe(first);
    expect((await b.block.getAsk(first))!.status).toBe('handled'); expect((await b.block.getAsk(first))!.answer).toBeUndefined();
    expect(f.withdrawals).toHaveBeenCalled(); expect(f.errors).not.toHaveBeenCalled();
  });

  it('mints each reminder ask so an emailed reply can name it, the follow-up too', async () => {
    const f = fixture(); const asset = f.put({ name: 'Passport', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); const first = f.currentAsk(asset);
    await b.block.submitAnswer({ ask_id: first, option: 'later', via: 'ui' }); await b.service.tick();
    for (const ask_id of [first, f.currentAsk(asset)]) expect(extractAskId(`Re: Recued reminders [#${ask_id}]`)).toBe(ask_id);
  });

  it('snoozes only the next reminder and lets its follow-up choose tomorrow without changing the rule or deadline', async () => {
    const f = fixture(); const asset = f.put({ name: 'Passport', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); const original = f.work.readAsset(asset.id)!.rules;
    const commitment = f.work.readCommitment(f.occurrence(asset).commitment_id!)!;
    await b.block.submitAnswer({ ask_id: f.currentAsk(asset), option: 'later', via: 'ui' }); await b.service.tick();
    const choice = f.currentAsk(asset); expect((await b.block.getAsk(choice))!.handler_payload.mode).toBe('later_choice');
    expect(createOccurrenceReminderStore(f.db).control(f.occurrence(asset).id).later_until).toBe(Date.parse('2026-10-24T12:00Z'));
    await b.block.submitAnswer({ ask_id: choice, option: 'later_tomorrow', via: 'ui' }); await b.service.tick();
    f.advance('2026-10-18T12:00Z'); await b.service.tick();
    expect((await b.block.getAsk(f.currentAsk(asset)))!.handler_payload.mode).toBe('action');
    expect(f.work.readAsset(asset.id)!.rules).toEqual(original);
    expect(f.work.readCommitment(commitment.id)!.promised_for_at).toBe(commitment.promised_for_at);
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('keeps an item made private out of the household: no retry posts it there and no member can answer it', async () => {
    const f = fixture(true); const asset = f.put({ name: 'Car', audience: 'household', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const householdSends = () => f.sends.filter(envelope => envelope.destination.audience === 'household').length;
    f.refuseHousehold(true); // The bot is not in the family group yet.
    const b = f.boot(); await b.service.tick(); expect(householdSends()).toBe(1);
    const ask_id = f.currentAsk(asset);
    f.work.writeAsset({ id: asset.id, source_id: 'recued.asset', source, audience: 'owner' });
    f.refuseHousehold(false); f.advance('2026-10-17T14:00Z'); await b.block.recoverReminderAsks();
    expect(householdSends()).toBe(1);
    await b.block.submitAnswer({ ask_id, option: 'done', via: 'telegram', origin: {
      connection_name: 'family', connection_enrolled_at: 200, recipient: '-100123', sender: '1002' } });
    expect((await b.block.getAsk(ask_id))!.status).toBe('open');
  });
  it('withdraws a delivered household copy of an item made private, and keeps the owner’s copy', async () => {
    const f = fixture(true); const asset = f.put({ name: 'Car', audience: 'household', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); const ask_id = f.currentAsk(asset);
    expect(f.withdrawals).not.toHaveBeenCalled();
    f.work.writeAsset({ id: asset.id, source_id: 'recued.asset', source, audience: 'owner' });
    await b.block.recoverReminderAsks();
    const calls = f.withdrawals.mock.calls as unknown as Array<[{ destination: { audience?: string } }, string[]]>;
    expect(calls.map(([receipt, closed]) => [receipt.destination.audience ?? 'owner', closed])).toEqual([['household', [ask_id]]]);
    expect((await b.block.getAsk(ask_id))!.status).toBe('open');
  });
  it('does not remind twice on the day a typo fix moves the date, then follows the corrected date', async () => {
    const f = fixture(); const asset = f.put({ name: 'Passport', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); expect(f.sends).toHaveLength(1);
    f.work.writeAsset({ id: asset.id, source_id: 'recued.asset', source, dates: { expires_on: '2026-11-18' } });
    await b.occurrences.reconcileAsset(asset.id); await b.service.tick();
    expect(f.sends).toHaveLength(1);
    f.advance('2026-10-18T12:00Z'); await b.service.tick();
    expect(f.sends).toHaveLength(2);
    expect(JSON.stringify(f.sends.at(-1))).toContain('2026-11-18');
  });
  it('spends the points a Later slept through, so the on-day reminder is not sent again after it', async () => {
    const f = fixture(); const asset = f.put({ name: 'Passport', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick(); expect(f.sends).toHaveLength(1);
    await b.block.submitAnswer({ ask_id: f.currentAsk(asset), option: 'later', via: 'ui' }); await b.service.tick();
    await b.block.submitAnswer({ ask_id: f.currentAsk(asset), option: 'later_month', via: 'ui' }); await b.service.tick();
    // A month in the owner's zone crosses the clock change, so it ends at 13:00Z.
    const before = f.sends.length;
    f.advance('2026-11-17T20:00Z'); await b.service.tick();
    expect(f.sends).toHaveLength(before + 1);
    f.advance('2026-11-18T20:00Z'); await b.service.tick();
    expect(f.sends).toHaveLength(before + 1);
    f.advance('2026-12-17T20:00Z'); await b.service.tick();
    expect(f.sends).toHaveLength(before + 2); // The schedule itself carries on: the first monthly repeat.
    expect(f.errors).not.toHaveBeenCalled();
  });
  it('requires a second explicit answer before muting a floor rule and leaves the obligation open', async () => {
    const f = fixture(); const asset = f.put({ name: 'Passport', dates: { expires_on: '2026-11-17' }, rules: [rule()] });
    const b = f.boot(); await b.service.tick();
    await b.block.submitAnswer({ ask_id: f.currentAsk(asset), option: 'stop_requested', via: 'ui' }); await b.service.tick();
    expect(f.work.readAsset(asset.id)!.rules[0]!.muted).toBe(false);
    const confirmation = f.currentAsk(asset); expect((await b.block.getAsk(confirmation))!.handler_payload.mode).toBe('confirm_stop');
    await b.block.submitAnswer({ ask_id: confirmation, option: 'muted', via: 'ui' }); await b.service.tick();
    expect(f.work.readAsset(asset.id)!.rules[0]).toMatchObject({ muted: true, pinned: true });
    expect(f.work.readCommitment(f.occurrence(asset).commitment_id!)!.lifecycle_state).toBe('pending');
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('uses a real D-324 reminder for a notice, never the generic sender, and expires its button after its ringing day', async () => {
    const f = fixture(); const asset = f.put({ name: 'Warranty', dates: { expires_on: '2026-11-17' }, rules: [rule({ consequence: 'routine',
      reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } })] });
    const b = f.boot(); await b.service.tick(); const ask = f.currentAsk(asset);
    const store = createReminderStore(f.db); expect(store.listHistory(10)[0]).toMatchObject({ state: 'delivered', clock: { ask_id: ask } });
    expect(store.listDue(Number.MAX_SAFE_INTEGER, 100)).toEqual([]); expect(f.work.listCommitments()).toEqual([]);
    f.advance('2026-10-18T12:00Z'); await b.service.tick();
    expect((await b.block.getAsk(ask))!.status).toBe('handled'); expect(f.sends).toHaveLength(1);
    await b.block.submitAnswer({ ask_id: ask, option: 'stop_notices', via: 'ui' });
    expect(f.work.readAsset(asset.id)!.rules[0]!.muted).toBe(false); expect(f.errors).not.toHaveBeenCalled();
  });
  it('withdraws a toast-only notice cancelled from the ordinary D-324 list before any late Stop these press', async () => {
    const f = fixture(); f.toastOnly(); const asset = f.put({ name: 'Warranty', dates: { expires_on: '2026-11-17' }, rules: [rule({ consequence: 'routine',
      reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } })] });
    const b = f.boot(); await b.service.tick(); const ask = f.currentAsk(asset); const store = createReminderStore(f.db);
    const reminder = store.clockForAsk(ask)!; expect(reminder.state).toBe('pending'); store.cancel(reminder.reminder_id, Date.parse('2026-10-17T12:01Z'));
    await b.block.submitAnswer({ ask_id: ask, option: 'stop_notices', via: 'ui' });
    expect((await b.block.getAsk(ask))!.answer).toBeUndefined(); expect(f.work.readAsset(asset.id)!.rules[0]!.muted).toBe(false);
  });

  it('asks once for unknown last done, never invents a date, and withdraws a question closed through Today', async () => {
    const f = fixture(); const asset = f.put({ name: 'Boiler', dates: { serviced_on: null }, rules: [rule({ when: {
      kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } } })] });
    const b = f.boot(); await b.service.tick(); const ask = f.currentAsk(asset);
    await b.block.submitAnswer({ ask_id: ask, option: 'unknown_last_done', via: 'ui' }); await b.service.tick();
    f.advance('2027-04-17T12:00Z'); await b.service.tick(); expect(f.sends).toHaveLength(1);
    expect(f.work.readAsset(asset.id)!.dates.serviced_on).toBeNull();
    const other = f.put({ name: 'Passport', dates: { expires_on: '2027-05-17' }, rules: [rule()] });
    await b.service.tick(); const stale = f.currentAsk(other);
    await f.dispatchers.commitmentCancel({ id: f.occurrence(other).commitment_id! });
    await b.block.submitAnswer({ ask_id: stale, option: 'done', via: 'ui' });
    expect((await b.block.getAsk(stale))!.answer).toBeUndefined(); expect(f.errors).not.toHaveBeenCalled();
  });

  it('replays a durable Done using the actual answer-time service reading rather than a later odometer', async () => {
    const f = fixture(); const asset = f.put({ name: 'Car', readings: { odometer: { value: 51_000, unit: 'km', as_of: Date.parse('2026-10-17T11:00Z'), evidence: [] } },
      rules: [rule({ when: { kind: 'objective', field: 'odometer', unit: 'km', mode: 'usage', target: 50_000, every: 10_000,
        direction: 'rising', lead_days: 14 }, schedule: { before: [], on_day: true } })] });
    const b = f.boot(); await b.service.tick(); const ask = f.currentAsk(asset); const occurrence = f.occurrence(asset);
    f.seal(); await b.block.submitAnswer({ ask_id: ask, option: 'done', via: 'ui' });
    expect((await b.block.getAsk(ask))!.status).toBe('answered');
    f.advance('2026-10-18T12:00Z');
    f.work.writeAsset({ id: asset.id, source_id: asset.source_id, source,
      readings: { odometer: { value: 70_000, unit: 'km', as_of: Date.parse('2026-10-18T11:00Z'), evidence: [] } } }, Date.parse('2026-10-18T12:00Z'));
    f.unlock(); await b.block.recoverPendingAsks(); await b.service.tick();
    expect(f.work.readAsset(asset.id)!.rules[0]!.when).toMatchObject({ target: 61_000 });
    expect(f.work.readCommitment(occurrence.commitment_id!)!.lifecycle_state).toBe('fulfilled');
    expect((await b.block.getAsk(ask))!.status).toBe('handled'); expect(f.errors).not.toHaveBeenCalled();
  });
});
