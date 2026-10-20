import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRule, MailFactThing, SituationQuery } from '@recued/contracts';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { runDueStatusSweep } from '../work-entity-due-status-sweep.js';

let db: Database.Database; let work: WorkEntityStore;
const now = Date.parse('2026-10-17T12:00Z');
const DAY = 86_400_000;
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); });
afterEach(() => db.close());
const build = (options: { time?: number; zone?: string } = {}) => {
  const reminders = createReminderStore(db); const contacts = createContactStore(db); const mailFacts = createMailFactStore(db);
  const calendar = createCalendarTable({ db, slug: 'personal' });
  const sources = buildSituationSources({ db, work, reminders, contacts, mailFacts, calendars: () => [{ slug: 'personal', table: calendar }],
    now: () => options.time ?? now, timeZone: () => options.zone ?? 'UTC' });
  const query = createSituationQuery({ sources, sourceForCollection: situationSourceAccess, now: () => options.time ?? now });
  const run = (input: Partial<SituationQuery> = {}) => query({ time: { from: options.time ?? now, to: (options.time ?? now) + 7 * DAY }, ...input }, {
    owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true },
  });
  return { reminders, contacts, mailFacts, calendar, run, query, sources };
};

describe('D-325 warehouse-backed situation sources', () => {
  it('marks a last-done question missing for the tool and keeps it off Today and the digest', async () => {
    const rule: AssetRule = { id: 'service', title: 'Service', enabled: true, muted: false, pinned: false, consequence: 'routine',
      expiry_policy: 'strict_expire', when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } },
      reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
    work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Boiler', dates: { serviced_on: null }, rules: [rule] }, now);
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => now });
    await createAssetOccurrenceService({ db, work, dispatchers, now: () => now, timeZone: () => 'UTC' }).tick();
    const question = work.listCommitments().find(row => row.lifecycle_state === 'pending')!;
    expect(question.statement).toBe('Last done date needed: Service · Boiler');
    // Without the asset grant its clock cannot merge in, so the commitment row
    // alone has to say it is a question.
    const fixture = build(); const ids = async (surface: SituationQuery['surface']) => (await fixture.query({ time: { from: now, to: now + 7 * DAY }, surface }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: collection => collection !== 'asset', isTopicReadGranted: () => true } })).clusters.flatMap(cluster => cluster.items);
    expect((await ids('tool')).find(item => item.ref.id === question.id)?.reasons).toEqual(expect.arrayContaining(['due', 'missing']));
    for (const surface of ['today', 'digest'] as const) expect((await ids(surface)).map(item => item.ref.id)).not.toContain(question.id);
  });
  it.each(['expired', 'cancelled'] as const)('shows the next interval lead after a cycle was %s', async outcome => {
    let time = Date.parse('2026-01-17T12:00Z');
    const rule: AssetRule = { id: 'service', title: 'Service', enabled: true, muted: false, pinned: false, consequence: 'routine',
      expiry_policy: 'strict_expire', when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } },
      reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 6, unit: 'months' }], on_day: true } };
    const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Boiler', dates: { serviced_on: '2025-01-01' }, rules: [rule] }, time);
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time });
    const service = createAssetOccurrenceService({ db, work, dispatchers, now: () => time, timeZone: () => 'UTC' });
    await service.tick(); const first = work.listCommitments()[0]!;
    if (outcome === 'expired') runDueStatusSweep({ store: work, now: () => time });
    else await dispatchers.commitmentCancel({ id: first.id });
    await service.tick(); time = Date.parse('2026-08-01T12:00Z'); await service.tick(); await service.tick();
    const pending = work.listCommitments().filter(row => row.lifecycle_state === 'pending'); expect(pending).toHaveLength(1);
    const fixture = build({ time }); const result = await fixture.run({ surface: 'digest' });
    const items = result.clusters.flatMap(cluster => cluster.items);
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ ref: { collection: 'commitment', id: pending[0]!.id }, when_day: '2027-01-01' });
    expect(items[0]!.reasons).toContain('due'); expect(work.readCommitment(first.id)!.lifecycle_state).toBe(outcome);
    expect(work.readAsset(asset.id)!.dates.serviced_on).toBe('2025-01-01');
    const read = vi.spyOn(work, 'readCommitment');
    await fixture.query({ time }, { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: collection => collection !== 'commitment', isTopicReadGranted: () => true } });
    expect(read).not.toHaveBeenCalled(); read.mockRestore();
  });
  it('does not resurrect a closed canonical cycle, and never reads its private lifecycle through the asset grant', async () => {
    const fixture = build();
    const rule: AssetRule = { id: 'renew', title: 'Renew', enabled: true, muted: false, pinned: false, consequence: 'floor',
      expiry_policy: 'escalate_overdue', when: { kind: 'expiry', field: 'expires_on' }, reaction: { notify: true, occurrence: 'action', emit: false },
      schedule: { before: [{ amount: 6, unit: 'months' }], on_day: true } };
    const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Passport', dates: { expires_on: '2027-04-01' }, rules: [rule] }, now);
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => now });
    await createAssetOccurrenceService({ db, work, dispatchers, now: () => now, timeZone: () => 'UTC' }).reconcileAsset(asset.id);
    await dispatchers.commitmentFulfill({ id: work.listCommitments()[0]!.id });
    expect((await fixture.run()).clusters).toEqual([]);
    const read = vi.spyOn(work, 'readCommitment');
    const result = await fixture.query({ time: { from: now, to: now + 7 * DAY } }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: collection => collection !== 'commitment', isTopicReadGranted: () => true } });
    expect(read).not.toHaveBeenCalled(); expect(result.clusters.flatMap(cluster => cluster.items).map(item => item.ref.collection)).toEqual(['asset']); read.mockRestore();
  });
  it('includes an active condition without inventing a due date', async () => {
    const fixture = build();
    work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Boiler',
      observations: { offline: { active: true, certainty: 'confirmed', as_of: now - 1000, evidence: [], source: 'owner' } },
      rules: [{ id: 'offline', title: 'Check offline boiler', enabled: true, muted: false, pinned: false, consequence: 'floor', expiry_policy: 'indefinite',
        when: { kind: 'condition', field: 'offline', certainty: 'confirmed' }, reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } }] }, now);
    const item = (await fixture.run()).clusters[0]!.items[0]!;
    expect(item.what.value).toBe('Check offline boiler · Boiler'); expect(item.when).toMatchObject({ value: null, verdict: 'unknown' }); expect(item.reasons).toContain('due');
    // §4.10 — once the owner marks that state expected, Today and the brief leave it out.
    const boiler = work.listAssets({ search: 'Boiler' })[0]!;
    work.writeAsset({ id: boiler.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' },
      settings: { expected_patterns: { offline: { active: true, at: now - 1000 } } } }, now + 1);
    expect((await fixture.run()).clusters).toEqual([]);
  });
  it('reads current tasks, commitments, bookings and reminders through the shared query', async () => {
    const fixture = build();
    work.writeTask({ source_id: 'recued.task', title: 'Service visit', due_at: now + DAY, done: false }, now);
    work.writeCommitment({ source_id: 'recued.commitment', direction: 'outbound', statement: 'Send quote', derivation: 'user_declared', promised_for_at: now + DAY }, now);
    work.writeBooking({ source_id: 'recued.booking', title: 'Dentist', slot_start_at: now + DAY, slot_end_at: now + DAY + 1000 }, now);
    fixture.reminders.create({ text: 'Call the vet', at: now + DAY, time_zone: 'UTC', origin: {} }, now);
    const result = await fixture.run();
    expect(result.clusters.flatMap(cluster => cluster.items).map(item => item.ref.collection).sort()).toEqual(['booking', 'commitment', 'reminder', 'task']);
    expect(JSON.stringify(result)).toContain('Send quote');
  });
  it('pages only open work rows, so a long closed history never counts against the scan bound', async () => {
    const fixture = build();
    work.writeTask({ source_id: 'recued.task', title: 'Open task', due_at: now + DAY, done: false }, now);
    work.writeTask({ source_id: 'recued.task', title: 'Done task', due_at: now + DAY, done: true }, now);
    work.writeCommitment({ source_id: 'recued.commitment', direction: 'outbound', statement: 'Pending promise', derivation: 'user_declared', promised_for_at: now + DAY }, now);
    work.writeCommitment({ source_id: 'recued.commitment', direction: 'outbound', statement: 'Kept promise', derivation: 'user_declared', promised_for_at: now + DAY, lifecycle_state: 'fulfilled' }, now);
    work.writeBooking({ source_id: 'recued.booking', title: 'Dentist', slot_start_at: now + DAY, slot_end_at: now + DAY + 1000 }, now);
    work.writeBooking({ source_id: 'recued.booking', title: 'Cancelled lesson', slot_start_at: now + DAY, slot_end_at: now + DAY + 1000, lifecycle_state: 'cancelled' }, now);
    const listed = vi.spyOn(work, 'listByKind');
    const byId = (['readTask', 'readCommitment', 'readBooking'] as const).map(name => vi.spyOn(work, name));
    const result = await fixture.run();
    expect(result.clusters.flatMap(cluster => cluster.items).map(item => item.what.value).sort()).toEqual(['Dentist', 'Open task', 'Pending promise']);
    // An indexed read loads open rows by id (§6.3); a source read whole pages
    // them. Neither reads a closed row.
    const titles = (rows: unknown[]) => (rows.filter(Boolean) as Array<Record<string, unknown>>).map(row => row.title ?? row.statement).sort();
    expect(titles(byId.flatMap(spy => spy.mock.results.map(call => call.value)))).toEqual(['Dentist', 'Open task', 'Pending promise']);
    expect(listed).not.toHaveBeenCalled();
    for (const source of fixture.sources.filter(source => ['task', 'commitment', 'booking'].includes(source.collection))) await source.read({ time: now });
    expect(titles(listed.mock.results.flatMap(call => call.value as unknown[]))).toEqual(['Dentist', 'Open task', 'Pending promise']);
    expect(work.countCommitments({ commitment_lifecycle_states: ['pending'] })).toBe(1);
    expect(() => work.listCommitments({ commitment_lifecycle_states: ['someday' as 'pending'] })).toThrow(/unknown commitment lifecycle_state/);
    expect(() => work.listTasks({ commitment_lifecycle_states: ['pending'] })).toThrow(/requires commitments/);
  });
  it('computes a yearless birthday at call time without storing an occurrence', async () => {
    const fixture = build(); fixture.contacts.upsertManual({ email: 'alice@example.test', name: 'Alice', birthday: '--10-20' }, now);
    const result = await fixture.run(); const item = result.clusters.flatMap(cluster => cluster.items).find(item => item.kind === 'birthday')!;
    expect(item.what.value).toBe('Alice · birthday'); expect(item.when.value?.from).toBe(Date.parse('2026-10-20'));
    expect(work.countCommitments()).toBe(0); expect(fixture.reminders.countPending()).toBe(0);
  });
  it('keeps an all-day event through its actual local day even after its stored UTC end', async () => {
    const late = Date.parse('2026-10-18T02:00Z'); const fixture = build({ time: late, zone: 'America/Los_Angeles' });
    fixture.calendar.upsert({ size_bytes: 0, event: { source_id: 'event-1', ical_uid: 'event-1', calendar_id: 'home',
      summary: 'Family day', start_at: Date.parse('2026-10-17'), end_at: Date.parse('2026-10-18'), is_all_day: true,
      timezone: 'America/Los_Angeles', status: 'confirmed', created_at: now, updated_at: now } });
    const result = await fixture.run();
    expect(result.clusters[0]?.items[0]?.when.value).toEqual({ from: Date.parse('2026-10-17T07:00Z'), to: Date.parse('2026-10-18T07:00Z') });
  });
  it('walks past a tied mail-fact page and emits only the minimum declared facts', async () => {
    const fixture = build();
    for (let index = 0; index < 505; index += 1) {
      const thing: MailFactThing = { thing_id: `thing-${String(index).padStart(4, '0')}`, type: 'bill', identity_keys: [`invoice:${index}`],
        variables: { issuer: index === 0 ? 'OldVendor' : 'Other', due_at: '2026-10-20', account_ref: 'secret-account', state: 'issued' },
        passes: {}, variable_email_at: {}, last_email_at: now, missing: [], complete: true, created_at: now, updated_at: now };
      fixture.mailFacts.saveThing(thing);
    }
    const result = await fixture.run({ surface: 'prefetch', text: 'OldVendor' });
    expect(result.clusters.flatMap(cluster => cluster.items).map(item => item.ref.id)).toEqual(['thing-0000']);
    expect(JSON.stringify(result)).not.toContain('secret-account');
  });
  // The title is what the owner reads on Today and the model reads in a result: the kind as the
  // owner names it, as the thing's own page heads it. The kind stays the stored type.
  it('titles a mail fact by its kind’s name, and a question finds it by those words through the index or a full read', async () => {
    const fixture = build();
    const thing = (thing_id: string, type: string, variables: Record<string, unknown>): void => fixture.mailFacts.saveThing({ thing_id, type, identity_keys: [`${type}:${thing_id}`],
      variables, passes: {}, variable_email_at: {}, last_email_at: now, missing: [], complete: true, created_at: now, updated_at: now } as MailFactThing);
    fixture.mailFacts.saveCustomType({ id: 'custom_parking_fine', name: 'Parking fines', description: 'A fine.', states: [], notices: [],
      variables: [{ name: 'notice_no', kind: 'text', required: true }], identity: [['notice_no']] });
    // Due after the week, so only a question that names it brings it.
    thing('power', 'bill', { issuer: 'Acme Power', due_at: '2026-12-20', state: 'issued' });
    // An empty label is passed over, as the page does.
    thing('slip', 'pay_tax_document', { issuer: '', merchant: 'Northwind', state: 'available' });
    thing('fine', 'custom_parking_fine', { notice_no: 'N-1' });
    // A type since deleted keeps its id's words.
    thing('toll', 'custom_toll_notice', { notice_no: 'T-1' });
    const context = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } };
    const scan = createSituationQuery({ sources: fixture.sources.map(({ index: _index, ...source }) => source), sourceForCollection: situationSourceAccess, now: () => now });
    for (const read of [fixture.run, (input: Partial<SituationQuery>) => scan({ time: { from: now, to: now + 7 * DAY }, ...input }, context)]) {
      const titles = async (input: Partial<SituationQuery>) => (await read(input)).clusters.flatMap(cluster => cluster.items)
        .filter(item => item.ref.collection === 'mail_fact').map(item => [item.what.value, item.kind]).sort();
      expect(await titles({ text: 'acme' })).toEqual([['Bill: Acme Power', 'bill']]);
      expect(await titles({ text: 'payslip' })).toEqual([['Payslip or tax form: Northwind', 'pay_tax_document']]);
      expect(await titles({ text: 'parking fines' })).toEqual([['Parking fines', 'custom_parking_fine']]);
      expect(await titles({ text: 'toll notice' })).toEqual([['Toll notice', 'custom_toll_notice']]);
      expect(await titles({ surface: 'prefetch', text: 'Where is my tax form?' })).toEqual([['Payslip or tax form: Northwind', 'pay_tax_document']]);
      // The stored id is no word of the owner's.
      expect(await titles({ text: 'document' })).toEqual([]);
    }
    // A type renamed is read by its new name at the next question.
    fixture.mailFacts.saveCustomType({ id: 'custom_parking_fine', name: 'Parking tickets', description: 'A fine.', states: [], notices: [],
      variables: [{ name: 'notice_no', kind: 'text', required: true }], identity: [['notice_no']] });
    expect((await fixture.run({ text: 'parking tickets' })).clusters.flatMap(cluster => cluster.items).map(item => item.what.value)).toEqual(['Parking tickets']);
  });
  // D-315 §7.4 — a request the owner mailed their own server is carried out by its trigger;
  // no question, chat message, change or reference brings it back as an item.
  it('leaves a request the owner mailed their own server out of every read', async () => {
    const fixture = build();
    const thing = (thing_id: string, type: string, variables: Record<string, unknown>): void => fixture.mailFacts.saveThing({ thing_id, type, identity_keys: [`${type}:${thing_id}`],
      variables, passes: {}, variable_email_at: {}, last_email_at: now, missing: [], complete: true, created_at: now, updated_at: now } as MailFactThing);
    thing('remind', 'owner_request', { tag: 'remind', message_id: 'm-1', state: 'new' });
    thing('task', 'owner_request', { tag: 'task', message_id: 'm-2', state: 'new' });
    // Due after the week, so only a question that names it brings it.
    thing('power', 'bill', { issuer: 'Server Power', due_at: '2026-12-20', state: 'issued' });
    const context = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } };
    const scan = createSituationQuery({ sources: fixture.sources.map(({ index: _index, ...source }) => source), sourceForCollection: situationSourceAccess, now: () => now });
    for (const read of [fixture.run, (input: Partial<SituationQuery>) => scan({ time: { from: now, to: now + 7 * DAY }, ...input }, context)]) {
      const found = async (input: Partial<SituationQuery>) => { const result = await read(input);
        return { ids: result.clusters.flatMap(cluster => cluster.items).filter(item => item.ref.collection === 'mail_fact').map(item => item.ref.id).sort(), ambiguous: result.ambiguous }; };
      expect(await found({ text: 'server' })).toEqual({ ids: ['power'], ambiguous: [] });
      expect(await found({ text: 'request' })).toEqual({ ids: [], ambiguous: [] });
      expect(await found({ surface: 'prefetch', text: 'Did my server get the request?' })).toEqual({ ids: ['power'], ambiguous: [] });
      expect((await found({ changed_since: now - DAY })).ids).toEqual(['power']);
      expect((await found({ subjects: [{ collection: 'mail_fact', id: 'remind' }] })).ids).toEqual([]);
    }
  });
  it('folds a clock lead into its existing ordinary commitment, without counting the obligation twice', async () => {
    const fixture = build();
    const rule: AssetRule = { id: 'renew', title: 'Renew passport', when: { kind: 'expiry', field: 'expires_on' },
      enabled: true, muted: false, pinned: false, consequence: 'floor', expiry_policy: 'escalate_overdue',
      reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 6, unit: 'months' }], on_day: true } };
    const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Passport',
      dates: { expires_on: '2027-04-01' }, rules: [rule] }, now);
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => now });
    await createAssetOccurrenceService({ db, work, dispatchers, now: () => now, timeZone: () => 'UTC' }).reconcileAsset(asset.id);
    const result = await fixture.run(); const items = result.clusters.flatMap(cluster => cluster.items);
    expect(items).toHaveLength(1); expect(items[0]?.ref.collection).toBe('commitment'); expect(items[0]?.reasons).toContain('due');
    expect(items[0]?.when.value?.from).toBe(Date.parse('2027-04-01')); expect(result.omitted).toBe(0);
  });
});
