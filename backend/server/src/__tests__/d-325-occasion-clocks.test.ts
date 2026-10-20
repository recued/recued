import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRule, OccasionInput } from '@recued/contracts';
import { createAskDeliveryStore, createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type AskDeliveryRecord, type Channel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createOccasionClockService } from '../situations/occasion-clock-service.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetReminderService, type AssetReminderService } from '../situations/asset-reminder-service.js';
import { declaredOccasions } from '../situations/declared-occasions.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const habit = (): AssetRule => ({ id: 'flowers', title: 'Buy flowers', enabled: true, muted: false, pinned: true, consequence: 'routine',
  when: { kind: 'expiry', field: 'next_on' }, reaction: { notify: true, occurrence: 'action', emit: false },
  expiry_policy: 'strict_expire', schedule: { before: [{ amount: 1, unit: 'weeks' }], on_day: true } });
const fixture = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db)); const rows = createAssetOccurrenceStore(db);
  const points = createOccurrenceReminderStore(db); const reminders = createReminderStore(db);
  let time = Date.parse('2026-10-17T12:00Z'); let quiet = false; let sealed = false; let excluded = false;
  let declarations: OccasionInput[] = []; let sender: AssetReminderService;
  const now = () => time; const outcomes = vi.fn(); const errors = vi.fn(); let sends = 0;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now });
  const boot = () => {
    const clocks = createOccasionClockService({ db, work, dispatchers, timeZone: () => 'America/Los_Angeles', now,
      declared: () => declarations, excludedPerson: () => excluded, isVaultUnlocked: () => !sealed,
      withdraw: id => sender?.withdraw(id), outcome: outcomes });
    const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'America/Los_Angeles', now,
      withdraw: async id => sender?.withdraw(id) });
    sender = createAssetReminderService({ db, work, dispatchers, occurrences, additionalSubjects: clocks,
      timeZone: () => 'America/Los_Angeles', now, isQuiet: () => quiet, isVaultUnlocked: () => !sealed, log: errors });
    const channel: Channel = { name: 'telegram', capability: 'inline', owns_llm_egress: false, deliverNotify: async () => {}, deliverAsk: async () => {}, closeAsk: async () => {},
      deliverAskDelivery: async envelope => { expect(envelope.destination.id).toBe('owner'); sends++; return { outcome: 'delivered', provider_message_id: `p-${sends}` }; },
      withdrawAskDelivery: async () => true, restoreAskDelivery: async () => {} };
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'asks')),
      deliveryStore: createAskDeliveryStore(createSQLiteCollection<AskDeliveryRecord>(db, 'deliveries')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')),
      channels: [createUiChannel({ busSink: () => {} }), channel], now, isVaultUnlocked: () => !sealed,
      shouldHoldReminder: () => quiet,
      resolveReminderDestinations: async () => ({ destinations: [{ id: 'ui', channel: 'ui' }, { id: 'owner', channel: 'telegram',
        connection_name: 'private', connection_enrolled_at: 1, recipient: 'owner', expected_sender: 'owner' }], issues: [] }) });
    sender.bind(block); return { sender, block, clocks };
  };
  cleanups.push(async () => { await sender?.stop(); db.close(); });
  const save = (rules: AssetRule[] = []) => history.saveOccasion({ title: 'Ana birthday', month_day: '10-24', people: ['ana'], muted: false, rules, sphere: 'personal' }, now());
  return { db, work, history, rows, points, reminders, boot, save, outcomes, errors, now,
    at: (value: string) => { time = Date.parse(value); }, sends: () => sends,
    quiet: (value: boolean) => { quiet = value; }, seal: (value: boolean) => { sealed = value; }, exclude: () => { excluded = true; },
    declarations: (value: OccasionInput[]) => { declarations = value; } };
};

describe('D-325 actual annual occasion clocks', () => {
  it('changes a notice into an action in the same year without reusing a notice receipt as a commitment', async () => {
    const f = fixture(); const occasion = f.save(); const b = f.boot(); await b.sender.tick(); const notice = f.rows.byOccasion(occasion.id)[0]!;
    f.history.saveOccasion({ ...occasion, rules: [{ ...occasion.rules[0]!, reaction: { notify: true, occurrence: 'action', emit: false } }] }, f.now());
    await b.sender.tick(); const action = f.rows.byOccasion(occasion.id).find(row => row.commitment_id)!;
    expect(action.id).not.toBe(notice.id); expect(f.work.readCommitment(action.commitment_id!)!.lifecycle_state).toBe('pending');
    // The default rule carries the occasion's title, so the task is named once, here and on Today.
    expect(f.work.readCommitment(action.commitment_id!)!.statement).toBe('Ana birthday');
    const query = createSituationQuery({ sources: buildSituationSources({ db: f.db, work: f.work, reminders: f.reminders, calendars: () => [], now: f.now, timeZone: () => 'UTC' }),
      sourceForCollection: situationSourceAccess, now: f.now });
    // Today shows the task; a reader that cannot read tasks sees the occasion's own item.
    const titles = async (tasks: boolean) => (await query({ time: { from: f.now(), to: f.now() + 8 * 86_400_000 } }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: collection => tasks || collection !== 'commitment', isTopicReadGranted: () => true } }))
      .clusters.flatMap(cluster => cluster.items.map(item => [item.ref.collection, item.what.value]));
    expect(await titles(true)).toEqual([['commitment', 'Ana birthday']]); expect(await titles(false)).toEqual([['occasion', 'Ana birthday']]);
    expect(f.points.control(notice.id).current_ask_id).toBeNull(); expect(f.points.control(action.id).current_ask_id).not.toBeNull();
    await b.sender.tick(); expect(f.work.listCommitments()).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
  });
  it('uses expanded calendar dates including moved and biennial instances, and invents no year after COUNT ends', async () => {
    const f = fixture(); const calendar = createCalendarTable({ db: f.db, slug: 'home' });
    // CalDAV's shape: the first instance is the series, a later one names it.
    const put = (id: string, date: string, status: 'confirmed' | 'cancelled' = 'confirmed') => calendar.upsert({ size_bytes: 0,
      event: { source_id: id, ical_uid: 'biennial', calendar_id: 'home', summary: 'Family gathering', start_at: Date.parse(date), end_at: Date.parse(date) + 86_400_000,
        timezone: 'UTC', is_all_day: true, status, recurrence_rule: 'FREQ=YEARLY;INTERVAL=2;COUNT=2', created_at: f.now(), updated_at: f.now(),
        ...(id === 'home:biennial' ? {} : { recurring_event_id: 'home:biennial' }) } });
    put('home:biennial', '2024-10-24'); put('home:biennial:2026', '2026-10-25');
    const declared = () => declaredOccasions({ calendars: () => [{ slug: 'home', table: calendar }], timeZone: () => 'UTC', now: f.now });
    expect(declared()).toMatchObject([{ month_day: '10-25', source_next_on: '2026-10-25' }]);
    f.declarations(declared()); const b = f.boot(); await b.sender.tick(); expect(f.rows.all()).toEqual([]);
    f.at('2026-10-18T12:00Z'); await b.sender.tick(); expect(f.rows.all()).toHaveLength(1);
    f.at('2026-10-26T12:00Z'); f.declarations(declared()); await b.sender.tick();
    expect(f.history.occasions()[0]!.source_next_on).toBeNull(); expect(await b.block.listOpenAsks()).toEqual([]);
    f.at('2027-10-18T12:00Z'); await b.sender.tick(); expect(f.rows.all()).toHaveLength(1);
  });
  it('keeps one occasion across years for a series whose every occurrence has its own UID, as Graph lists it', () => {
    const f = fixture();
    const declared = (year: number) => {
      const calendar = createCalendarTable({ db: f.db, slug: `work-${year}` });
      calendar.upsert({ size_bytes: 0, event: { source_id: `occurrence-${year}`, ical_uid: `uid-${year}`, recurring_event_id: 'ana-master',
        calendar_id: 'work', summary: 'Ana birthday', start_at: Date.parse(`${year}-10-24`), end_at: Date.parse(`${year}-10-25`), timezone: 'UTC',
        is_all_day: true, status: 'confirmed', recurrence_rule: 'RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=24', created_at: f.now(), updated_at: f.now() } });
      return declaredOccasions({ calendars: () => [{ slug: 'work', table: calendar }], timeZone: () => 'UTC', now: f.now });
    };
    const [thisYear, nextYear] = [declared(2026), declared(2027)];
    expect(thisYear).toMatchObject([{ class_id: 'annual_calendar', month_day: '10-24', source_next_on: '2026-10-24' }]);
    expect(nextYear).toHaveLength(1);
    expect(nextYear[0]!.id).toBe(thisYear[0]!.id);
  });
  it('rings a D-324 notice at each annual point, expires its buttons and never creates an overdue birthday', async () => {
    const f = fixture(); const occasion = f.save(); let b = f.boot();
    f.quiet(true); await b.sender.tick(); expect(f.sends()).toBe(0);
    f.quiet(false); await b.sender.tick(); expect(f.sends()).toBe(1); expect(f.work.listCommitments()).toEqual([]);
    const row = f.rows.byOccasion(occasion.id)[0]!; const first = f.points.control(row.id).current_ask_id!;
    expect((await b.block.getAsk(first))!.ui_link_url).toBe(`#yours/occasions/occasion/${occasion.id}`);
    expect(f.reminders.clockForAsk(first)).toMatchObject({ state: 'delivered' });
    await b.sender.stop(); b = f.boot(); await b.sender.tick(); expect(f.sends()).toBe(1);
    f.at('2026-10-18T12:00Z'); await b.sender.tick(); expect((await b.block.getAsk(first))!.status).toBe('handled');
    f.at('2026-10-24T12:00Z'); await b.sender.tick(); expect(f.sends()).toBe(2);
    f.at('2026-10-25T12:00Z'); await b.sender.tick(); expect(await b.block.listOpenAsks()).toEqual([]); expect(f.work.listCommitments()).toEqual([]);
    f.at('2027-10-17T12:00Z'); await b.sender.tick(); expect(f.sends()).toBe(3); expect(f.rows.byOccasion(occasion.id)).toHaveLength(2);
    expect(f.work.countByKind('asset')).toBe(0); expect(f.errors).not.toHaveBeenCalled();
  });
  it('keeps a habit as one canonical strict-expire commitment, closes that commitment and creates a new annual cycle', async () => {
    const f = fixture(); const occasion = f.save([habit()]); const b = f.boot(); await b.sender.tick();
    const row = f.rows.byOccasion(occasion.id)[0]!; const first = f.work.readCommitment(row.commitment_id!)!;
    expect(first.statement).toBe('Buy flowers · Ana birthday');
    expect(first).toMatchObject({ derivation: 'rule_emitted', expiry_policy: 'strict_expire', lifecycle_state: 'pending' });
    await b.block.submitAnswer({ ask_id: f.points.control(row.id).current_ask_id!, option: 'done', via: 'ui' }); await b.sender.tick();
    expect(f.work.readCommitment(first.id)!.lifecycle_state).toBe('fulfilled'); expect(f.outcomes).toHaveBeenCalledTimes(1);
    await b.sender.tick(); expect(f.outcomes).toHaveBeenCalledTimes(1); expect(f.work.listCommitments()).toHaveLength(1);
    f.at('2027-10-17T12:00Z'); await b.sender.tick(); expect(f.work.listCommitments()).toHaveLength(2);
    f.at('2027-10-25T12:00Z'); await b.sender.tick(); const next = f.work.listCommitments().find(value => value.id !== first.id)!;
    expect(next.lifecycle_state).toBe('expired'); expect((await b.block.listOpenAsks())).toEqual([]); expect(f.outcomes).toHaveBeenCalledTimes(2);
  });
  it('muting stops reminders while preserving the original obligation, and deleting the occasion cancels it', async () => {
    const f = fixture(); const occasion = f.save([habit()]); const b = f.boot(); await b.sender.tick();
    const row = f.rows.byOccasion(occasion.id)[0]!;
    await b.block.submitAnswer({ ask_id: f.points.control(row.id).current_ask_id!, option: 'stop_requested', via: 'ui' }); await b.sender.tick();
    expect(f.history.occasion(occasion.id)!.rules[0]).toMatchObject({ muted: true, pinned: true });
    expect(f.work.readCommitment(row.commitment_id!)!.lifecycle_state).toBe('pending');
    f.history.deleteOccasion(occasion.id); await b.sender.tick(); expect(f.work.readCommitment(row.commitment_id!)!.lifecycle_state).toBe('cancelled');
    // Its close is counted like any other (`clock.closure`), by id alone: the occasion is gone.
    expect(f.outcomes).toHaveBeenCalledTimes(1);
    expect(f.outcomes).toHaveBeenCalledWith(expect.objectContaining({ occasion: { id: occasion.id }, commitment: expect.objectContaining({ lifecycle_state: 'cancelled' }) }));
    await b.sender.tick(); expect(f.outcomes).toHaveBeenCalledTimes(1);
  });
  it('names a reminder of an occasion’s own date once, as it names the occasion', async () => {
    const f = fixture(); const occasion = f.history.saveOccasion({ title: 'Summer party', month_day: '10-24', people: [], muted: false, rules: [] }, f.now());
    const b = f.boot(); await b.sender.tick();
    const ask = (await b.block.getAsk(f.points.control(f.rows.byOccasion(occasion.id)[0]!.id).current_ask_id!))!;
    expect(ask.message.text).toMatch(/^Summer party\. /u); expect(ask.message.text).not.toContain('Summer party · Summer party');
  });
  it('renames a declared occasion’s default rule with its contact', async () => {
    const f = fixture(); const contacts = createContactStore(f.db); contacts.upsertManual({ email: 'ana@example.test', name: 'Ana', birthday: '--10-24' });
    const declare = () => f.declarations(declaredOccasions({ contacts, calendars: () => [], timeZone: () => 'UTC' }));
    declare(); const b = f.boot(); await b.sender.tick();
    expect(f.history.occasions().map(occasion => [occasion.title, occasion.rules.map(rule => rule.title)])).toEqual([['Ana · birthday', ['Ana · birthday']]]);
    contacts.upsertManual({ email: 'ana@example.test', name: 'Ana Lima' }); declare(); await b.sender.tick();
    expect(f.history.occasions().map(occasion => [occasion.title, occasion.rules.map(rule => rule.title)])).toEqual([['Ana Lima · birthday', ['Ana Lima · birthday']]]);
  });
  it('reconciles exact declarations, preserves owner edits, suspends hidden/removed sources, and respects deletion tombstones', async () => {
    const f = fixture(); const contact = createContactStore(f.db).upsertManual({ email: 'ana@example.test', name: 'Ana', birthday: '--10-24' });
    const declarations = declaredOccasions({ contacts: createContactStore(f.db), calendars: () => [], timeZone: () => 'UTC' });
    expect(declarations).toMatchObject([{ month_day: '10-24', source: { collection: 'contact', id: contact.contact_id, field: 'birthday' } }]);
    f.declarations(declarations); const b = f.boot(); await b.sender.tick(); const original = f.history.occasions()[0]!;
    f.history.saveOccasion({ ...original, title: 'My title', source_pinned: true }, f.now());
    f.declarations([{ ...declarations[0]!, title: 'Provider title' }]); await b.sender.tick(); expect(f.history.occasion(original.id)!.title).toBe('My title');
    f.declarations([]); await b.sender.tick(); expect(f.history.occasion(original.id)!.source_active).toBe(false); expect(await b.block.listOpenAsks()).toEqual([]);
    f.history.deleteOccasion(original.id); f.declarations(declarations); await b.sender.tick(); expect(f.history.occasions()).toEqual([]);
    const query = createSituationQuery({ sources: buildSituationSources({ db: f.db, work: f.work, reminders: f.reminders, contacts: createContactStore(f.db), calendars: () => [], now: f.now, timeZone: () => 'UTC' }), sourceForCollection: situationSourceAccess, now: f.now });
    expect((await query({ time: { from: f.now(), to: f.now() + 8 * 86_400_000 } }, { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } })).clusters).toEqual([]);
  });
  it('applies a blocked occasion date to its earlier reminders and hides an existing habit before the minute reconciliation', async () => {
    const f = fixture(); const occasion = f.save([habit()]); const b = f.boot(); await b.sender.tick(); const row = f.rows.byOccasion(occasion.id)[0]!;
    createProactiveProposalStore(f.db).saveSuppression({ kind: 'date_range', from: Date.parse('2026-10-24T07:00Z'), to: Date.parse('2026-10-25T06:59:59.999Z') }, f.now());
    const query = createSituationQuery({ sources: buildSituationSources({ db: f.db, work: f.work, reminders: f.reminders, calendars: () => [], now: f.now, timeZone: () => 'America/Los_Angeles' }), sourceForCollection: situationSourceAccess, now: f.now });
    expect((await query({ time: { from: f.now(), to: f.now() + 8 * 86_400_000 } }, { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } })).clusters).toEqual([]);
    await b.sender.tick(); expect(f.work.readCommitment(row.commitment_id!)!.lifecycle_state).toBe('cancelled'); expect(await b.block.listOpenAsks()).toEqual([]);
  });
  it('requires original source grants, fences canonical lifecycle reads, and inherits the occasion sphere on its habit', async () => {
    const f = fixture(); const occasion = f.history.saveOccasion({ title: 'Annual', month_day: '10-24', people: [], muted: false,
      source: { collection: 'contact', id: 'ana', field: 'birthday' }, rules: [habit()], sphere: 'personal' }, f.now());
    const clocks = createOccasionClockService({ db: f.db, work: f.work, dispatchers: createWorkEntityDispatchers({ store: f.work, resolver: createWorkEntityResolver(f.work) }), now: f.now, timeZone: () => 'UTC' });
    await clocks.tick(); const row = f.rows.byOccasion(occasion.id)[0]!;
    expect(createSphereStore(f.db, f.work).resolve({ collection: 'commitment', id: row.commitment_id! }).sphere).toBe('personal');
    const query = createSituationQuery({ sources: buildSituationSources({ db: f.db, work: f.work, reminders: f.reminders, calendars: () => [], now: f.now, timeZone: () => 'UTC' }), sourceForCollection: situationSourceAccess, now: f.now });
    const read = vi.spyOn(f.work, 'readCommitment');
    const denied = await query({ time: { from: f.now(), to: f.now() + 8 * 86_400_000 } }, { owner: true, grants: {
      isVerbOpGranted: op => op !== 'core.contact.resolve', isCollectionReadGranted: collection => collection === 'occasion', isTopicReadGranted: () => true } });
    expect(denied.clusters).toEqual([]); expect(read).not.toHaveBeenCalled();
    const allowed = await query({ time: { from: f.now(), to: f.now() + 8 * 86_400_000 } }, { owner: true, grants: {
      isVerbOpGranted: () => true, isCollectionReadGranted: collection => collection !== 'commitment', isTopicReadGranted: () => true } });
    expect(allowed.clusters.flatMap(cluster => cluster.items).map(item => item.ref.collection)).toEqual(['occasion']); expect(read).not.toHaveBeenCalled();
  });
});
