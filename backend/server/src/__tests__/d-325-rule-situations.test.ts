/**
 * D-325 — a rule that publishes its cycles resolves each one once it is over. A task
 * resolves when it closes, or when its asset or occasion goes. A notice has no task,
 * so it resolves when its day has passed, its clock has left the cycle, or its asset,
 * occasion or rule has gone.
 *
 * The clock services run with the server's own publish and resolve helpers and a
 * controlled clock. The last two cases compose the real collection context.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createRuntimeConfigStore } from '@recued/config';
import type { Asset, AssetRule, MailFactThing } from '@recued/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createOccasionClockService } from '../situations/occasion-clock-service.js';
import { occasionRuleSituation, resolveRuleSituation, ruleSituation } from '../situations/rule-situation.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createSituationStore, type SituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { AssetReminderOpenError, createWorkEntityDispatchers, RenewalDateRequiredError } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const DAY = 86_400_000;
const source = { kind: 'owner' as const, ref: 'owner:local' };
const notice = (patch: Partial<AssetRule> = {}): AssetRule => ({ id: 'warranty', title: 'Warranty ends', enabled: true, muted: false, pinned: false,
  consequence: 'routine', expiry_policy: 'strict_expire', when: { kind: 'expiry', field: 'warranty_ends_on' },
  reaction: { notify: true, occurrence: 'notice', emit: true }, schedule: { before: [{ amount: 1, unit: 'weeks' }], on_day: true }, ...patch });
const task = (): AssetRule => notice({ id: 'renew', title: 'Renew', expiry_policy: 'escalate_overdue', reaction: { notify: true, occurrence: 'action', emit: true } });
const card: AssetRule = { ...notice({ id: 'card', title: 'Send a card' }), when: { kind: 'expiry', field: 'next_on' } };
const states = (situations: SituationStore, id: string) => situations.revisionsAfter(0, 1000).filter(row => row.situation_id === id).map(row => row.after.state);
const dbs: Database.Database[] = []; const dirs: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** The clocks as the server composes them (compose-collection-context), on a clock the test moves. */
const clocks = () => {
  const db = new Database(':memory:'); dbs.push(db); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const situations = createSituationStore(db); let time = Date.parse('2026-10-17T12:00Z'); const now = () => time;
  let failing = false; const ended: string[] = [];
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now });
  const assets = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now,
    emitRule: async input => { if (failing) throw new Error('the feed is unavailable'); situations.save(ruleSituation(input), { source: `asset-rule:${input.occurrence.id}` }, now()); },
    cycleEnded: occurrence => { ended.push(occurrence.id); resolveRuleSituation(situations, occurrence.id, `asset-rule:${occurrence.id}`, now()); },
    outcome: async input => { resolveRuleSituation(situations, input.occurrence.id, `commitment:${input.commitment.id}`, input.commitment.lifecycle_changed_at); } });
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const occasions = createOccasionClockService({ db, work, dispatchers, timeZone: () => 'UTC', now,
    emitRule: input => { if (failing) throw new Error('the feed is unavailable'); situations.save(occasionRuleSituation(input), { source: `occasion-rule:${input.occurrence.id}` }, now()); },
    cycleEnded: occurrence => { ended.push(occurrence.id); resolveRuleSituation(situations, occurrence.id, `occasion-rule:${occurrence.id}`, now()); } });
  const rows = createAssetOccurrenceStore(db);
  return { db, work, situations, assets, occasions, history, rows, ended,
    put: (name: string, rules: AssetRule[], warranty_ends_on = '2026-10-20'): Asset =>
      work.writeAsset({ source_id: 'recued.asset', source, name, dates: { warranty_ends_on }, rules }, time),
    change: (asset: Asset, patch: Partial<Asset>): Asset => work.writeAsset({ id: asset.id, source_id: asset.source_id, source, ...patch }, time),
    cycle: (asset: Asset) => rows.byAsset(asset.id).at(-1)!,
    state: (id: string) => situations.get(id)?.snapshot.state,
    at: (value: string) => { time = Date.parse(value); }, fail: (value: boolean) => { failing = value; } };
};

describe('D-325 rule situations — a published notice resolves when its cycle ends', () => {
  it('resolves an emitting notice once its day has passed, once', async () => {
    const f = clocks(); const tv = f.put('Television', [notice()]);
    await f.assets.tick(); const cycle = f.cycle(tv);
    expect(f.state(cycle.id)).toBe('proposed');
    // On its day it is still current.
    f.at('2026-10-20T12:00Z'); await f.assets.tick(); expect(f.state(cycle.id)).toBe('proposed');
    f.at('2026-10-21T12:00Z'); await f.assets.tick(); await f.assets.tick();
    expect(states(f.situations, cycle.id)).toEqual(['proposed', 'resolved']);
    expect(f.rows.get(cycle.id)!.close_processed_at).toBe(Date.parse('2026-10-21T12:00Z'));
  });

  it('resolves it when its clock leaves the cycle, its rule is turned off or becomes a task, or its asset is retired or deleted, once each', async () => {
    const f = clocks();
    const renewed = f.put('Laptop', [notice()]); const off = f.put('Camera', [notice()]); const tasked = f.put('Phone', [notice()]);
    const sold = f.put('Bicycle', [notice()]); const deleted = f.put('Console', [notice()]); const removed = f.put('Router', [notice()]);
    const kept = f.put('Fridge', [notice()]);
    await f.assets.tick();
    const cycles = [renewed, off, tasked, sold, deleted, removed, kept].map(asset => f.cycle(asset).id);
    expect(cycles.map(f.state)).toEqual(Array(7).fill('proposed'));
    f.change(renewed, { dates: { warranty_ends_on: '2027-10-20' } });
    f.change(off, { rules: [notice({ enabled: false })] });
    f.change(tasked, { rules: [{ ...task(), id: 'warranty' }] });
    f.change(sold, { status: 'sold' });
    f.work.deleteAsset(deleted.id, { tombstone: true, now: Date.parse('2026-10-17T12:00Z') });
    f.change(removed, { rules: [] });
    await f.assets.tick(); await f.assets.tick(); await f.assets.tick();
    expect(cycles.map(f.state)).toEqual(['resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'proposed']);
    expect([...f.ended].sort()).toEqual(cycles.slice(0, 6).sort());
    // A rule that became a task publishes its own cycle, which its task holds open.
    const taskCycle = f.rows.byAsset(tasked.id).find(row => row.commitment_id)!;
    expect(f.state(taskCycle.id)).toBe('proposed');
  });

  it('resolves a published task whose asset is retired or deleted, since its close is never processed, once each', async () => {
    const f = clocks(); const sold = f.put('Car', [task()]); const deleted = f.put('Boat', [task()]); const kept = f.put('Passport', [task()]);
    await f.assets.tick();
    const cycles = [sold, deleted, kept].map(asset => f.cycle(asset).id);
    expect(cycles.map(f.state)).toEqual(['proposed', 'proposed', 'proposed']);
    f.change(sold, { status: 'sold' }); f.work.deleteAsset(deleted.id, { tombstone: true, now: Date.parse('2026-10-17T12:00Z') });
    await f.assets.tick(); await f.assets.tick(); await f.assets.tick();
    expect(cycles.map(f.state)).toEqual(['resolved', 'resolved', 'proposed']);
    expect(cycles.slice(0, 2).map(id => f.work.readCommitment(f.rows.get(id)!.commitment_id!)!.lifecycle_state)).toEqual(['cancelled', 'cancelled']);
    expect([...f.ended].sort()).toEqual(cycles.slice(0, 2).sort());
  });

  it('waits to resolve a notice until its start is published, so the end never comes first', async () => {
    const f = clocks(); const tv = f.put('Television', [notice()]);
    f.fail(true);
    await expect(f.assets.tick()).rejects.toThrow('the feed is unavailable');
    const cycle = f.cycle(tv);
    f.change(tv, { dates: { warranty_ends_on: '2027-10-20' } });
    await expect(f.assets.tick()).rejects.toThrow('the feed is unavailable');
    expect([f.state(cycle.id), f.rows.get(cycle.id)!.close_processed_at]).toEqual([undefined, null]);
    f.fail(false); await f.assets.tick(); await f.assets.tick();
    expect(states(f.situations, cycle.id)).toEqual(['proposed', 'resolved']);
  });

  it('records the end of a notice that never published, and resolves a published task when it closes', async () => {
    const f = clocks(); const quiet = f.put('Kettle', [notice({ reaction: { notify: true, occurrence: 'notice', emit: false } })]);
    const passport = f.put('Passport', [task()]);
    await f.assets.tick(); const silent = f.cycle(quiet); const renewal = f.cycle(passport);
    expect([f.state(silent.id), f.state(renewal.id)]).toEqual([undefined, 'proposed']);
    f.at('2026-10-18T12:00Z');
    await f.assets.completeOccurrence({ occurrence_id: renewal.id, answered_at: Date.parse('2026-10-18T12:00Z'), owner_action: true });
    f.at('2026-10-21T12:00Z'); await f.assets.tick(); await f.assets.tick();
    expect([f.state(silent.id), f.rows.get(silent.id)!.close_processed_at]).toEqual([undefined, Date.parse('2026-10-21T12:00Z')]);
    expect(states(f.situations, renewal.id)).toEqual(['proposed', 'resolved']);
  });

  it('resolves an emitting occasion notice once its day has passed, and an occasion’s notice or task when the occasion is deleted', async () => {
    const f = clocks();
    const flowers: AssetRule = { ...card, id: 'flowers', title: 'Buy flowers', reaction: { notify: true, occurrence: 'action', emit: true } };
    const at = Date.parse('2026-10-17T12:00Z');
    const birthday = f.history.saveOccasion({ title: 'Ana birthday', month_day: '10-20', people: [], muted: false, rules: [card] }, at);
    const party = f.history.saveOccasion({ title: 'Summer party', month_day: '10-22', people: [], muted: false, rules: [card] }, at);
    const anniversary = f.history.saveOccasion({ title: 'Anniversary', month_day: '10-23', people: [], muted: false, rules: [flowers] }, at);
    await f.occasions.tick();
    const [birthdayCycle] = f.rows.byOccasion(birthday.id); const [partyCycle] = f.rows.byOccasion(party.id); const [flowersCycle] = f.rows.byOccasion(anniversary.id);
    expect([birthdayCycle, partyCycle, flowersCycle].map(row => f.state(row!.id))).toEqual(['proposed', 'proposed', 'proposed']);
    // On the day, the notice is current and the task is open.
    f.at('2026-10-20T12:00Z'); await f.occasions.tick(); expect([birthdayCycle, flowersCycle].map(row => f.state(row!.id))).toEqual(['proposed', 'proposed']);
    f.at('2026-10-21T12:00Z'); f.history.deleteOccasion(party.id); f.history.deleteOccasion(anniversary.id);
    await f.occasions.tick(); await f.occasions.tick();
    expect([birthdayCycle, partyCycle, flowersCycle].map(row => states(f.situations, row!.id))).toEqual([['proposed', 'resolved'], ['proposed', 'resolved'], ['proposed', 'resolved']]);
    expect([...f.ended].sort()).toEqual([birthdayCycle!.id, partyCycle!.id, flowersCycle!.id].sort());
  });

  // An occasion's default rule takes the occasion's title; the published item named it twice.
  it('names a published occasion rule once when the rule carries the occasion’s title', async () => {
    const f = clocks(); const at = Date.parse('2026-10-17T12:00Z');
    const own = f.history.saveOccasion({ title: 'Ana birthday', month_day: '10-20', people: [], muted: false, rules: [{ ...card, title: 'Ana birthday' }] }, at);
    const gift = f.history.saveOccasion({ title: 'Anniversary', month_day: '10-23', people: [], muted: false,
      rules: [{ ...card, id: 'flowers', title: 'Buy flowers', reaction: { notify: true, occurrence: 'action', emit: true } }] }, at);
    await f.occasions.tick();
    const named = (id: string) => f.situations.get(f.rows.byOccasion(id)[0]!.id)!.snapshot.cluster.items[0]!.what.value;
    expect([named(own.id), named(gift.id)]).toEqual(['Ana birthday', 'Buy flowers · Anniversary']);
    expect(f.work.readCommitment(f.rows.byOccasion(gift.id)[0]!.commitment_id!)!.statement).toBe('Buy flowers · Anniversary');
  });
  it('resolves an occasion notice when the occasion is hidden, its rule is turned off, or the rule becomes a task', async () => {
    const f = clocks(); const at = Date.parse('2026-10-17T12:00Z');
    const save = (title: string) => f.history.saveOccasion({ title, month_day: '10-20', people: [], muted: false, rules: [card] }, at);
    const hidden = save('Ana birthday'); const off = save('Ben birthday'); const tasked = save('Cy birthday'); const kept = save('Di birthday');
    await f.occasions.tick();
    const cycles = [hidden, off, tasked, kept].map(occasion => f.rows.byOccasion(occasion.id)[0]!.id);
    expect(cycles.map(f.state)).toEqual(Array(4).fill('proposed'));
    createProactiveProposalStore(f.db).saveSuppression({ kind: 'episode', value: hidden.id }, at);
    f.history.saveOccasion({ ...off, rules: [{ ...card, enabled: false }] }, at);
    f.history.saveOccasion({ ...tasked, rules: [{ ...card, reaction: { notify: true, occurrence: 'action', emit: true } }] }, at);
    await f.occasions.tick(); await f.occasions.tick();
    expect(cycles.map(f.state)).toEqual(['resolved', 'resolved', 'resolved', 'proposed']);
    expect([...f.ended].sort()).toEqual(cycles.slice(0, 3).sort());
  });

  it('never publishes an occasion cycle that ended before its start went out, so nothing stays proposed', async () => {
    const f = clocks();
    const birthday = f.history.saveOccasion({ title: 'Ana birthday', month_day: '10-20', people: [], muted: false, rules: [card] }, Date.parse('2026-10-17T12:00Z'));
    f.fail(true); await expect(f.occasions.tick()).rejects.toThrow('the feed is unavailable');
    const [cycle] = f.rows.byOccasion(birthday.id);
    f.at('2026-10-21T12:00Z'); await f.occasions.tick(); await f.occasions.tick();
    expect([states(f.situations, cycle!.id), f.rows.get(cycle!.id)!.close_processed_at]).toEqual([[], Date.parse('2026-10-21T12:00Z')]);
  });
});

describe('D-325 rule situations — composed', () => {
  /** The server's own storage, app and collection contexts, its vault unlocked. */
  const composedServer = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-rule-situations-')); dirs.push(dir);
    const dbPath = join(dir, 'server.db'); const runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath, runtimeConfig,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    try {
      const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig, gateRegistry: storage.gateRegistry,
        auditLog: storage.auditLog, eventBus: storage.eventBus, serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
        pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: createExecutionLateBoundRefs() });
      await unlockServerVault(app.keys!);
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig, manifests: storage.manifests,
        baseVault: storage.baseVault, auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
        contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
        accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef,
        ...(app.occasionsRef ? { occasionsRef: app.occasionsRef } : {}), ...(app.mailFactsRef ? { mailFactsRef: app.mailFactsRef } : {}),
        ...(app.closingRecordsRef ? { closingRecordsRef: app.closingRecordsRef } : {}) });
      return { storage, app, collection };
    } catch (error) { storage.db.close(); throw error; }
  };
  it('the server resolves a published notice when its cycle ends, an occasion’s when it is deleted, and a task when it closes', async () => {
    const { storage, collection } = await composedServer();
    try {
      const work = storage.workEntityStoreRef!; const situations = collection.situationStore!; const service = collection.assetOccurrences!;
      const history = createProactiveHistoryStore(storage.db, createProactiveProposalStore(storage.db));
      const rows = createAssetOccurrenceStore(storage.db);
      // Due in three days: inside each rule's week of reminders, whatever the server's zone.
      const due = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10); const later = new Date(Date.now() + 400 * DAY).toISOString().slice(0, 10);
      const tv = work.writeAsset({ source_id: 'recued.asset', source, name: 'Television', dates: { warranty_ends_on: due }, rules: [notice()] }, Date.now());
      const passport = work.writeAsset({ source_id: 'recued.asset', source, name: 'Passport', dates: { warranty_ends_on: due }, rules: [task()] }, Date.now());
      const party = history.saveOccasion({ title: 'Summer party', month_day: due.slice(5), people: [], muted: false, rules: [card] }, Date.now());
      // The reminder service ticks both clocks, assets and occasions.
      const tick = () => collection.assetReminders!.tick();
      await tick();
      const [warranty] = rows.byAsset(tv.id); const [renewal] = rows.byAsset(passport.id); const [gathering] = rows.byOccasion(party.id);
      expect([warranty, renewal, gathering].map(row => states(situations, row!.id))).toEqual([['proposed'], ['proposed'], ['proposed']]);
      work.writeAsset({ id: tv.id, source_id: tv.source_id, source, dates: { warranty_ends_on: later } }, Date.now());
      await service.completeOccurrence({ occurrence_id: renewal!.id, answered_at: Date.now(), owner_action: true });
      history.deleteOccasion(party.id);
      await tick(); await tick();
      expect([warranty, renewal, gathering].map(row => states(situations, row!.id))).toEqual([['proposed', 'resolved'], ['proposed', 'resolved'], ['proposed', 'resolved']]);
    } finally { storage.db.close(); }
  }, 60_000);
  it('the server refuses Done alone on a class’s renewal, the owner’s or an agent’s, while its asset holds the task’s own date (§15.7, 2026-10-24)', async () => {
    const { storage, collection } = await composedServer();
    try {
      const work = storage.workEntityStoreRef!; const dispatchers = collection.workEntityDispatchers!;
      // A renewal as a class makes it: the class's own rule, due within its reminders.
      const passport = work.writeAsset({ source_id: 'recued.asset', source, name: 'Passport', settings: { class_rule_ids: ['renew'] },
        dates: { warranty_ends_on: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10) }, rules: [task()] }, Date.now());
      await collection.assetOccurrences!.reconcileAsset(passport.id);
      const [renewal] = createAssetOccurrenceStore(storage.db).byAsset(passport.id); const id = renewal!.commitment_id!;
      await expect(dispatchers.ownerCommitmentFulfill({ id })).rejects.toBeInstanceOf(RenewalDateRequiredError);
      await expect(dispatchers.commitmentFulfill({ id })).rejects.toBeInstanceOf(RenewalDateRequiredError);
      expect(work.readCommitment(id)!.lifecycle_state).toBe('pending');
    } finally { storage.db.close(); }
  }, 60_000);
  it('the server refuses an AI’s write of a date an open reminder reads, and names the reminder to keep (D-343 ruling 16)', async () => {
    const { storage, collection } = await composedServer();
    try {
      const work = storage.workEntityStoreRef!; const dispatchers = collection.workEntityDispatchers!;
      const service: AssetRule = { id: 'service', title: 'Service boiler', enabled: true, muted: false, pinned: false, consequence: 'routine',
        expiry_policy: 'escalate_overdue', when: { kind: 'interval', field: 'last_serviced_on', every: { amount: 12, unit: 'months' } },
        reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } };
      const last = new Date(Date.now() - 350 * DAY).toISOString().slice(0, 10);
      const boiler = work.writeAsset({ source_id: 'recued.asset', source, name: 'Boiler', dates: { last_serviced_on: last }, rules: [service] }, Date.now());
      await collection.assetOccurrences!.reconcileAsset(boiler.id);
      const [row] = createAssetOccurrenceStore(storage.db).byAsset(boiler.id);
      const write = { id: boiler.id, source: { kind: 'extracted' as const, ref: 'chat:sess-1' },
        dates: { last_serviced_on: new Date().toISOString().slice(0, 10) } };
      // Approved or not, the reminder is the one to keep: the date would cancel it.
      await expect(dispatchers.assetUpdate(write, { owner_approved: true })).rejects.toMatchObject(
        { name: 'AssetReminderOpenError', reminder: { commitment_id: row!.commitment_id, field: 'last_serviced_on' } });
      await expect(dispatchers.assetUpdate(write, { check: true })).rejects.toBeInstanceOf(AssetReminderOpenError);
      expect(work.readAsset(boiler.id)!.dates.last_serviced_on).toBe(last);
      expect(work.readCommitment(row!.commitment_id!)!.lifecycle_state).toBe('pending');
    } finally { storage.db.close(); }
  }, 60_000);
  it('the server hands the chat the occasions made in Yours, and saves a change as Yours does (D-343 slice 1)', async () => {
    const { storage, app } = await composedServer();
    try {
      const occasions = app.occasionsRef!.current!;
      const party = createProactiveHistoryStore(storage.db, createProactiveProposalStore(storage.db)).saveOccasion({ title: 'Summer party',
        month_day: '06-20', people: [], muted: false, rules: [] }, Date.now());
      expect(occasions.read(party.id)).toMatchObject({ title: 'Summer party', month_day: '06-20' });
      await occasions.save({ ...occasions.read(party.id)!, title: 'Summer barbecue', month_day: '06-27' },
        { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'local' });
      expect(occasions.read(party.id)).toMatchObject({ title: 'Summer barbecue', month_day: '06-27' });
      // Only the owner's own change reaches Yours, whatever let it through.
      await expect(occasions.save({ ...occasions.read(party.id)!, title: 'Party' }, { channel: 'chat', actor: 'contracted_user',
        chat_session_id: 'chat-2', user_id: 'member-1', contract_id: 'household-1' } as never)).rejects.toThrow('Only the owner changes an occasion');
      expect(occasions.read(party.id)!.title).toBe('Summer barbecue');
    } finally { storage.db.close(); }
  }, 60_000);
  it('the server hands the chat the mail facts, and closes one by making the record it shows through (D-343 slice 1)', async () => {
    const { storage, app } = await composedServer();
    try {
      storage.mailFactStoreRef!.saveThing({ thing_id: 'mthing_water', type: 'bill', identity_keys: ['bill:mthing_water'],
        variables: { issuer: 'City Water', due_at: '2026-11-10', state: 'issued' }, passes: {}, variable_email_at: {}, last_email_at: Date.now(),
        missing: [], complete: true, created_at: Date.now(), updated_at: Date.now() } as MailFactThing);
      const facts = app.mailFactsRef!.current!;
      expect(facts.read('mthing_water')).toMatchObject({ title: 'Bill: City Water', closed: false, record: null });
      const record = await facts.close({ thing_id: 'mthing_water', to: 'done', at: Date.now() });
      expect(storage.workEntityStoreRef!.readCommitment(record.id)).toMatchObject({ statement: 'Pay City Water', lifecycle_state: 'fulfilled' });
      expect(facts.read('mthing_water')!.record).toEqual(record);
    } finally { storage.db.close(); }
  }, 60_000);
  it('the server hands the chat the owner’s closing records, kept where Yours lists episodes (D-343 slice 2)', async () => {
    const { storage, app } = await composedServer();
    try {
      const closing = app.closingRecordsRef!.current!;
      const day = new Date(Date.now() - DAY).toISOString().slice(0, 10);
      const [record] = closing.record({ day, time_zone: 'UTC', records: [{ title: 'Went for a walk', outcome: 'done' }] });
      expect(record).toMatchObject({ title: 'Went for a walk', outcome: 'done', basis: 'declared', storage_reason: 'owner_record' });
      expect(createProactiveHistoryStore(storage.db, createProactiveProposalStore(storage.db)).episode(record!.id)).toMatchObject({ title: 'Went for a walk' });
    } finally { storage.db.close(); }
  }, 60_000);
  it('the server names the condition a reminder stands for while it holds, for the chat’s close (D-343 slice 1)', async () => {
    const { storage, collection } = await composedServer();
    try {
      const work = storage.workEntityStoreRef!; const dispatchers = collection.workEntityDispatchers!;
      const recall: AssetRule = { id: 'recall', title: 'Check vehicle recall', enabled: true, muted: false, pinned: false, consequence: 'floor',
        expiry_policy: 'escalate_overdue', when: { kind: 'condition', field: 'open_recall', certainty: 'conditional' },
        reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
      const car = work.writeAsset({ source_id: 'recued.asset', source, name: 'Family car', rules: [recall],
        observations: { open_recall: { active: true, certainty: 'confirmed', as_of: Date.now() - DAY, evidence: [], source: '' } } }, Date.now());
      await collection.assetOccurrences!.reconcileAsset(car.id);
      const [row] = createAssetOccurrenceStore(storage.db).byAsset(car.id);
      expect(dispatchers.commitmentCondition(work.readCommitment(row!.commitment_id!)!))
        .toEqual({ asset_id: car.id, asset_name: 'Family car', field: 'open_recall' });
    } finally { storage.db.close(); }
  }, 60_000);
});
