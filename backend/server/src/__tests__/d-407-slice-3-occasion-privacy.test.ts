/** D-407 slice 3 (D-407 §4.2, §8, §10.3; Q4 ruled 2026-11-20, the owner: "agree all above") — each
 *  occasion is Private or Shown by name. Its own choice (`Occasion.private`) decides; without one, the rule before
 *  decides (a person in it), so an occasion private before stays private. One rule (`occasionIsPrivate`) for its
 *  reminders, the Agenda's privacy (`privateRecord`), the events of a yearly series it declares, and what every model
 *  reads: the chat's copy and, new, a recipe's or an MCP app's (the kernel `situation-query`).
 *
 *  Through the real stores: the occasion store, the clock and reminder services with a real notification block, the
 *  situation sources, query and scheduled situations on a real calendar table, and the composed execution context's
 *  kernel read. The app's Private box is checked in a browser (the commit message says how). */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigStore } from '@recued/config';
import { occasionIsPrivate, type CanonicalEvent, type OccasionInput, type SituationItem } from '@recued/contracts';
import { createAskDeliveryStore, createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type AskDeliveryRecord, type Channel, type NotificationSettings, type PendingAsk } from '@recued/notification';

import { createBootTrace } from '../cli/boot-trace.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import type { NotificationSendArgs } from '../notification-handler.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeExecutionContext, createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createSituationAccess } from '../situations/access.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetReminderService, type AssetReminderService } from '../situations/asset-reminder-service.js';
import { calendarSeriesOccasionId, declaredOccasions } from '../situations/declared-occasions.js';
import { markPrivateSituationItems } from '../situations/model-projection.js';
import { createOccasionClockService } from '../situations/occasion-clock-service.js';
import { createSituationQuery } from '../situations/query.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { buildSituationSources } from '../situations/sources.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createYoursService } from '../situations/yours-service.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const occasion = (title: string, patch: Partial<OccasionInput> = {}): OccasionInput =>
  ({ title, month_day: '10-24', people: [], muted: false, rules: [], sphere: 'personal', ...patch });
const DAY = 86_400_000;

describe('D-407 slice 3 — one rule for whether an occasion is private', () => {
  it('its own choice decides; without one, a person in it does; a stored value that is not true or false is not read', () => {
    expect(occasionIsPrivate({ people: [], private: true })).toBe(true);
    expect(occasionIsPrivate({ people: ['ana'], private: false })).toBe(false);
    // Saved before slice 3: as before, so one private then stays private.
    expect(occasionIsPrivate({ people: ['ana'] })).toBe(true);
    expect(occasionIsPrivate({ people: [] })).toBe(false);
    // An older server stored what a client sent, unchecked.
    for (const stored of ['yes', 'false', 1, 0, null]) expect(occasionIsPrivate({ people: [], private: stored })).toBe(false);
    expect(occasionIsPrivate({ people: ['ana'], private: 'no' })).toBe(true);
  });

  it('the store keeps true or false, refuses anything else, and adds nothing to an occasion saved without one', () => {
    const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
    const history = createProactiveHistoryStore(db, createProactiveProposalStore(db)); const at = Date.parse('2026-10-17T12:00Z');
    expect(history.saveOccasion(occasion('Biopsy', { private: true }), at).private).toBe(true);
    expect(history.saveOccasion(occasion('Reunion', { private: false }), at).private).toBe(false);
    expect(() => history.saveOccasion(occasion('Odd', { private: 'yes' as never }), at)).toThrow('Invalid occasion privacy');
    expect(history.saveOccasion(occasion('Ana birthday', { people: ['ana'] }), at)).not.toHaveProperty('private');
  });
});

/** The occasion clocks and their reminders as the composition root wires them, with a real notification block. */
const clocks = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db)); const rows = createAssetOccurrenceStore(db);
  const points = createOccurrenceReminderStore(db);
  const now = () => Date.parse('2026-10-17T12:00Z');
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now });
  let sender: AssetReminderService | undefined;
  const clockService = createOccasionClockService({ db, work, dispatchers, timeZone: () => 'America/Los_Angeles', now,
    declared: () => [], excludedPerson: () => false, isVaultUnlocked: () => true, withdraw: id => sender?.withdraw(id), outcome: vi.fn() });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'America/Los_Angeles', now,
    withdraw: async id => sender?.withdraw(id) });
  sender = createAssetReminderService({ db, work, dispatchers, occurrences, additionalSubjects: clockService,
    timeZone: () => 'America/Los_Angeles', now, isQuiet: () => false, isVaultUnlocked: () => true, log: vi.fn() });
  const channel: Channel = { name: 'telegram', capability: 'inline', owns_llm_egress: false, deliverNotify: async () => {}, deliverAsk: async () => {},
    closeAsk: async () => {}, deliverAskDelivery: async () => ({ outcome: 'delivered', provider_message_id: `p-${Math.random()}` }),
    withdrawAskDelivery: async () => true, restoreAskDelivery: async () => {} };
  const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'asks')),
    deliveryStore: createAskDeliveryStore(createSQLiteCollection<AskDeliveryRecord>(db, 'deliveries')),
    settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')),
    channels: [createUiChannel({ busSink: () => {} }), channel], now, isVaultUnlocked: () => true, shouldHoldReminder: () => false,
    resolveReminderDestinations: async () => ({ destinations: [{ id: 'ui', channel: 'ui' }, { id: 'owner', channel: 'telegram',
      connection_name: 'private', connection_enrolled_at: 1, recipient: 'owner', expected_sender: 'owner' }], issues: [] }) });
  sender.bind(block);
  cleanups.push(async () => { await sender?.stop(); db.close(); });
  const message = async (id: string) => {
    const row = rows.byOccasion(id)[0]; if (!row) throw new Error(`no reminder for ${id}`);
    return (await block.getAsk(points.control(row.id).current_ask_id!))!.message;
  };
  return { history, sender, message, now };
};

describe('D-407 slice 3 — an occasion\'s own reminder', () => {
  it('a private one is "Reminder in Yours", with or without a person; one shown by name is named, people and all', async () => {
    const f = clocks();
    const before = f.history.saveOccasion(occasion('Ana birthday', { people: ['ana'] }), f.now());
    const biopsy = f.history.saveOccasion(occasion('Biopsy', { private: true }), f.now());
    const reunion = f.history.saveOccasion(occasion('Family reunion', { people: ['ana', 'bo'], private: false }), f.now());
    const gathering = f.history.saveOccasion(occasion('Street party'), f.now());
    await f.sender.tick();
    expect((await f.message(before.id)).title).toBe('Reminder in Yours');
    expect((await f.message(biopsy.id)).title).toBe('Reminder in Yours');
    expect(JSON.stringify(await f.message(biopsy.id))).not.toContain('Biopsy');
    expect((await f.message(reunion.id)).title).toBe('Family reunion');
    expect((await f.message(gathering.id)).title).toBe('Street party');
  });
});

/** The owner's day on one connected calendar, as the composition root wires it. */
const day = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const contracts = createContractStore(db); const store = createSituationStore(db);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const table = createCalendarTable({ db, slug: 'personal' });
  const calendars = () => [{ slug: 'personal', table }];
  let at = Date.parse('2026-10-19T20:00:00Z');
  const send = vi.fn(async (_message: NotificationSendArgs) => ({ delivered_to: ['in_app', 'telegram'] }));
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars, timeZone: () => 'UTC', now: () => at });
  const query = createSituationQuery({ now: () => at, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  const access = createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true });
  const service = createScheduledSituations({ db, work, store, query, timeZone: () => 'UTC', isVaultUnlocked: () => true, isQuiet: () => false,
    overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }), send, now: () => at, calendars });
  service.bindAccess(access);
  cleanups.push(async () => { await service.stop(); db.close(); });
  return { db, table, history, service, query, at: () => at, time: (value: number) => { at = value; },
    agenda: async () => {
      service.setSettings({ frequency: 'off', day_of: false }); service.setAgenda({ enabled: true, time: '20:00', day: 'tomorrow' });
      await service.tick(); return send.mock.calls.map(([message]) => message.text);
    } };
};
const event = (source_id: string, summary: string, from: number, patch: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  source_id, ical_uid: `uid-${source_id}`, calendar_id: 'primary', summary, start_at: from, end_at: from + 3_600_000, timezone: 'UTC',
  is_all_day: false, status: 'confirmed', created_at: 0, updated_at: 0, ...patch });

describe('D-407 slice 3 — the events of a yearly series follow the occasion it declares', () => {
  // Tuesday 20 October 2026, 18:00 UTC: the Agenda the evening before.
  const tuesday = Date.parse('2026-10-20T18:00:00Z');
  const seed = (f: ReturnType<typeof day>, privacy?: boolean) => {
    f.table.upsert({ size_bytes: 0, event: event('dinner', 'Anniversary dinner', tuesday, { recurrence_rule: 'RRULE:FREQ=YEARLY' }) });
    f.table.upsert({ size_bytes: 0, event: event('sync', 'Team sync', tuesday + 7_200_000) });
    const declared = declaredOccasions({ calendars: () => [{ slug: 'personal', table: f.table }], timeZone: () => 'UTC', now: f.at });
    expect(declared.map(row => row.id)).toEqual([calendarSeriesOccasionId('personal', f.table.get('dinner')!)]);
    // Its own reminder switched off, so only the series rule can hide the event: a reminder's clock
    // folds into the event it stands for and would hide it by itself (`query.ts`, `represents`).
    const saved = f.history.saveOccasion({ ...declared[0]!, source_active: true, ...(privacy === undefined ? {} : { private: privacy }),
      rules: [{ id: 'date', title: declared[0]!.title, enabled: false, muted: false, pinned: false, consequence: 'routine', expiry_policy: 'strict_expire',
        when: { kind: 'expiry', field: 'next_on' }, reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [], on_day: true } }] }, f.at());
    return saved;
  };

  it('a private series occasion hides every instance of its event in the Agenda; the rest stay named', async () => {
    const f = day(); seed(f, true);
    expect(await f.agenda()).toEqual(['18:00 Reminder in Yours\n20:00 Team sync']);
  });

  it('shown by name, or with no choice and no person, the event keeps its name', async () => {
    const shown = day(); seed(shown, false);
    expect(await shown.agenda()).toEqual(['18:00 Anniversary dinner\n20:00 Team sync']);
    const unset = day(); seed(unset);
    expect(await unset.agenda()).toEqual(['18:00 Anniversary dinner\n20:00 Team sync']);
  });

  it('a model reading the day is told which items are private: the occasion and its event alike', async () => {
    const f = day(); const saved = seed(f, true);
    const items: SituationItem[] = (await f.query({ time: { from: tuesday - DAY, to: tuesday + DAY } }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } })).clusters.flatMap(cluster => cluster.items);
    const marked = markPrivateSituationItems({ clusters: [{ id: 'c', subjects: [], span: null, items, omitted: 0 }], omitted: 0, ambiguous: [] },
      item => f.service.isPrivateItem(item)).clusters[0]!.items;
    expect(Object.fromEntries(marked.map(item => [item.what.value, item.private ?? false]))).toEqual({ 'Anniversary dinner': true, 'Team sync': false });
    expect(f.service.isPrivateItem({ ref: { collection: 'occasion', id: saved.id }, evidence: [] } as unknown as SituationItem)).toBe(true);
    // Beside the title, as in the chat's copy.
    expect(Object.keys(marked.find(item => item.private)!).slice(0, 3)).toEqual(['ref', 'kind', 'private']);
  });
});

describe('D-407 slice 3 — the owner\'s choice through Yours (I5)', () => {
  it('the snapshot says this server reads it, a save keeps it, and a value that is not true or false is refused', async () => {
    const db = new Database(':memory:'); ensureWorkEntitySchema(db);
    const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
    let occurrences: ReturnType<typeof createAssetOccurrenceService>;
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work),
      onAssetChanged: async asset => { await occurrences.reconcileAsset(asset.id); }, onAssetDeleted: async asset => { await occurrences.retireAsset(asset.id); } });
    occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC' });
    const dir = mkdtempSync(join(tmpdir(), 'd407-s3-yours-'));
    const annotations = createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')) });
    const service = createYoursService({ db, work, dispatchers, occurrences, annotations, situations: createSituationStore(db), isVaultUnlocked: () => true });
    cleanups.push(async () => { await service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const owner = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' } as const;
    const { id } = await service.command({ action: 'occasion.save', occasion: occasion('Biopsy', { private: true }) }, owner);
    const snapshot = await service.snapshot({});
    expect(snapshot.occasion_privacy).toBe(true);
    expect(snapshot.occasions.find(row => row.id === id)).toMatchObject({ title: 'Biopsy', private: true });
    await service.command({ action: 'occasion.save', occasion: { ...snapshot.occasions.find(row => row.id === id)!, private: false } }, owner);
    expect((await service.snapshot({})).occasions.find(row => row.id === id)?.private).toBe(false);
    await expect(service.command({ action: 'occasion.save', occasion: occasion('Odd', { private: 'yes' as never }) }, owner)).rejects.toThrow('Invalid occasion privacy');
  });
});

describe('D-407 slice 3 — a recipe\'s or an MCP app\'s read says so too (I4)', () => {
  it('the composed kernel situation-query marks a private occasion, and only it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd407-s3-'));
    const dbPath = join(dir, 'realm.sqlite'), runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      runtimeConfig, vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    try {
      const lateBound = createExecutionLateBoundRefs();
      const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig,
        gateRegistry: storage.gateRegistry, auditLog: storage.auditLog, eventBus: storage.eventBus,
        serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
        pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: lateBound });
      await unlockServerVault(app.keys!);
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig,
        manifests: storage.manifests, baseVault: storage.baseVault, auditLog: storage.auditLog,
        cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus, contactStore: app.contactStoreRef,
        mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry, accountStore: storage.accountStore,
        eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
      const context = await composeExecutionContext({ storage, app, collection, baseVault: storage.baseVault,
        lateBound, env: { RECUED_SERVER_NAME: 'Occasion privacy fixture' } });
      const history = createProactiveHistoryStore(storage.db, createProactiveProposalStore(storage.db));
      const soon = new Date(Date.now() + 3 * DAY).toISOString().slice(5, 10);
      history.saveOccasion(occasion('Biopsy', { month_day: soon, private: true }), Date.now());
      history.saveOccasion(occasion('Street party', { month_day: soon }), Date.now());
      const source = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' } as never;
      const result = await context.executorConfig.kernelDispatchers!.situationQuery!({ time: { from: Date.now(), to: Date.now() + 10 * DAY } }, source) as {
        clusters: Array<{ items: Array<{ what: { value?: string }; private?: true }> }> };
      const marks = Object.fromEntries(result.clusters.flatMap(cluster => cluster.items).map(item => [item.what.value, item.private ?? false]));
      expect(marks).toEqual({ Biopsy: true, 'Street party': false });
      await collection.scheduledSituations?.stop();
    } finally {
      await storage.drainAuditWrites?.();
      if (storage.db.open) storage.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
