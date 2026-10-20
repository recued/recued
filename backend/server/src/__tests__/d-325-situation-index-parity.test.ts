import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetRule, AssetRuleWhen, MailFactThing, SituationFact, SituationQuery, SituationRef, Sphere, TravelValidityRule } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createSituationQuery, type SituationReadContext, type SituationSource } from '../situations/query.js';
import { relateTravelDocuments, travelDocumentsVisible } from '../situations/travel-document-relations.js';
import { createSituationNamedPeople } from '../situations/named-people.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createTripDetailsStore } from '../storage/trip-details-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createProactiveLearning } from '../situations/learning-runtime.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createSituationStore } from '../storage/situation-store.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-17T12:00Z');
const day = (offset: number): string => new Date(T0 + offset * DAY).toISOString().slice(0, 10);
const RULES: TravelValidityRule[] = [{ id: 'schengen', destination_countries: ['FR', 'PT'], except_nationalities: ['FR', 'PT'], months_after_exit: 3,
  issued_within_years: 10, verified_as_of: '2026-09-01', source_url: 'https://example.test/schengen', label: 'Schengen short stay' }];
let db: Database.Database; let work: WorkEntityStore; let time: number;
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); time = T0; });
afterEach(() => db.close());
const rule = (id: string, when: AssetRuleWhen, extra: Partial<AssetRule> = {}): AssetRule => ({ id, title: id.replace(/_/gu, ' '), enabled: true, muted: false, pinned: false,
  consequence: 'routine', expiry_policy: 'escalate_overdue', when, reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true }, ...extra });
// A seeded generator, so a failure names a case that can be run again.
const random = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const fixture = async (zone: string) => {
  const contacts = createContactStore(db); const mailFacts = createMailFactStore(db); const reminders = createReminderStore(db);
  const calendar = createCalendarTable({ db, slug: 'home' }); const trips = createTripDetailsStore(db);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => time, timeZone: () => zone });
  const ana = contacts.upsertManual({ email: 'ana@example.test', name: 'Ana Lima', birthday: '--10-25' }, T0);
  const bob = contacts.upsertManual({ email: 'bob@example.test', name: 'Bob Stone', anniversary: '--11-20' }, T0);
  const person = (contact: typeof ana) => contact.contact_id ?? contact.email;
  const work_ids = new Set<string>();
  const put = (input: Omit<Parameters<WorkEntityStore['writeAsset']>[0], 'source_id' | 'source'>) =>
    work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, ...input }, time);

  const project = work.writeProject({ source_id: 'recued.project', title: 'Kitchen renovation' }, T0);
  work.writeTask({ source_id: 'recued.task', title: 'Order kitchen tiles', due_at: T0 + 2 * DAY, done: false, parent_project_id: project.id }, T0);
  work.writeTask({ source_id: 'recued.task', title: 'Book flights to Paris', due_at: Date.parse(day(9)), done: false, assigned_contact_id: person(ana) }, T0);
  work.writeTask({ source_id: 'recued.task', title: 'File tax return', due_at: T0 + 90 * DAY, done: false }, T0);
  work.writeTask({ source_id: 'recued.task', title: 'Fix the gate', due_at: T0 - 3 * DAY, done: false }, T0);
  work.writeTask({ source_id: 'recued.task', title: 'Someday learn piano', done: false, parent_project_id: project.id }, T0);
  work.writeNote({ source_id: 'recued.note', title: 'Tile supplier notes', body: 'Ask about grout colour', related_project_ids: [project.id], related_contact_ids: [person(bob)] }, T0);
  work.writeNote({ source_id: 'recued.note', body: 'Ana prefers aisle seats', related_contact_ids: [person(ana)] }, T0);
  const quote = work.writeCommitment({ source_id: 'recued.commitment', direction: 'outbound', statement: 'Send Bob the insurance quote', derivation: 'user_declared',
    promised_for_at: Date.parse(day(5)), counterparty_contact_id: person(bob) }, T0);
  work_ids.add(quote.id);
  work.writeCommitment({ source_id: 'recued.commitment', direction: 'outbound', statement: 'Return the ladder', derivation: 'user_declared', promised_for_at: T0 + 200 * DAY }, T0);
  const paris = work.writeBooking({ source_id: 'recued.booking', title: 'Paris apartment', slot_start_at: Date.parse(day(20)), slot_end_at: Date.parse(day(27)),
    source_extension_blob: { trip: { destination_country: 'FR', traveller_contact_ids: [person(ana)] } } }, T0);
  work.writeBooking({ source_id: 'recued.booking', title: 'Dentist', slot_start_at: T0 + DAY, slot_end_at: T0 + DAY + 3_600_000, counterparty_contact_id: person(bob) }, T0);
  work.writeBooking({ source_id: 'recued.booking', title: 'Cancelled lesson', slot_start_at: T0 + DAY, slot_end_at: T0 + DAY + 1000, lifecycle_state: 'cancelled' }, T0);
  work.writeBooking({ source_id: 'recued.booking', title: 'Haircut', slot_start_at: T0 + 50 * DAY, slot_end_at: T0 + 50 * DAY + 3_600_000, counterparty_contact_id: person(ana) }, T0);
  work.writeBooking({ source_id: 'recued.booking', title: 'Lisbon flight', slot_start_at: Date.parse(day(35)), slot_end_at: Date.parse(day(35)) + 7_200_000,
    source_extension_blob: { fact_type: 'reservation', reservation_kind: 'transport', traveller_contact_ids: [person(ana)] } }, T0);
  reminders.create({ text: 'Call the vet', at: T0 + DAY, time_zone: zone, origin: {} }, T0);
  reminders.create({ text: 'Renew the gym pass', at: T0 + 40 * DAY, time_zone: zone, origin: {} }, T0);
  const event = (id: string, summary: string, start: number, end: number, extra: Record<string, unknown> = {}) => calendar.upsert({ size_bytes: 0, event: {
    source_id: id, ical_uid: id, calendar_id: 'home', summary, start_at: start, end_at: end, is_all_day: false, timezone: zone, status: 'confirmed', created_at: T0, updated_at: T0, ...extra } });
  event('offsite', 'Team offsite', T0 + 3 * DAY, T0 + 3 * DAY + 7_200_000, { location: 'Lisbon', attendees: [{ email: 'bob@example.test' }] });
  event('conference', 'Design conference', T0 + 60 * DAY, T0 + 62 * DAY, { location: 'Berlin' });
  event('lisbon', 'Lisbon conference', T0 + 40 * DAY, T0 + 41 * DAY, { location: 'Lisbon' });
  event('dinner', 'Dinner with Bob', T0 + 25 * DAY, T0 + 25 * DAY + 7_200_000, { attendees: [{ email: 'bob@example.test' }] });
  event('review', 'Quarterly review', T0 + 20 * DAY, T0 + 20 * DAY + 3_600_000, { location: 'Lisbon' });
  // East of UTC an all-day event starts before its stored midnight.
  event('holiday', 'School holiday', Date.parse(day(9)), Date.parse(day(10)), { is_all_day: true });
  event('porto', 'Porto weekend', T0 + 30 * DAY, T0 + 33 * DAY, { location: 'Porto' });
  const porto = calendar.listSnapshots({ limit: 100 }).find(row => row.hot.summary === 'Porto weekend')!;
  trips.save({ subject: { collection: 'calendar', id: `home:${porto.record_id}` }, travellers: [person(ana), person(bob)], destination_country: 'PT' });
  const thing = (thing_id: string, type: string, variables: Record<string, unknown>, at = T0): void => mailFacts.saveThing({ thing_id, type, identity_keys: [`${type}:${thing_id}`], variables,
    passes: {}, variable_email_at: {}, last_email_at: at, missing: [], complete: true, created_at: at, updated_at: at } as MailFactThing);
  thing('power', 'bill', { issuer: 'Power Co', due_at: day(4), state: 'issued' });
  thing('paid', 'bill', { issuer: 'Water Co', due_at: day(2), state: 'paid' });
  thing('parcel', 'shipment', { carrier: 'Parcel Post', expected_at: day(2), state: 'in_transit' });
  thing('hotel', 'reservation', { kind: 'lodging', provider: 'Hotel Lumière', starts_at: `${day(20)}T15:00:00Z`, ends_at: `${day(27)}T10:00:00Z`, location: 'Paris', state: 'confirmed' });
  // Saved earlier: newest-first listing and the index disagree on which trip comes last.
  thing('flight', 'reservation', { kind: 'transport', provider: 'Air Lisboa', starts_at: `${day(38)}T08:00:00Z`, location: 'Lisbon', state: 'confirmed',
    traveller_contact_ids: [person(ana)] }, T0 - DAY);
  thing('stream', 'subscription', { merchant: 'StreamCo', state: 'active' });
  history.saveOccasion({ title: 'Wedding anniversary', month_day: day(6).slice(5), people: [person(bob)], muted: false, sphere: 'personal',
    rules: [rule('date', { kind: 'expiry', field: 'next_on' }, { reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [{ amount: 3, unit: 'days' }], on_day: true } })] }, T0);

  // The household's own assets, then a generated batch over every rule shape.
  const passport = put({ name: 'Ana passport', class_id: 'passport', holder_contact: person(ana), dates: { expires_on: '2027-01-15', issued_on: '2017-02-01' },
    settings: { nationality: 'GB' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' }, { consequence: 'floor', schedule: { before: [{ amount: 6, unit: 'months' }], on_day: true } })] });
  const car = put({ name: 'Family car', dates: { serviced_on: '2026-02-01' }, anchors: [{ kind: 'place', name: 'Lisbon' }],
    rules: [rule('service', { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } })] });
  const insurance = put({ name: 'Car insurance', belongs_to: car.id, dates: { expires_on: day(10) }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' })] });
  put({ name: 'Boiler', dates: { serviced_on: '2025-10-01' }, rules: [rule('service', { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } },
    { schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } })] });
  const bike = put({ name: 'Road bike', dates: {}, rules: [] });
  const oldBike = put({ name: 'Road bike (old record)', dates: { warranty_ends: day(12) },
    rules: [rule('warranty', { kind: 'expiry', field: 'warranty_ends' }, { reaction: { notify: true, occurrence: 'notice', emit: false } })] });
  db.exec('CREATE TABLE IF NOT EXISTS asset_identity_links (left_id TEXT NOT NULL, right_id TEXT NOT NULL, PRIMARY KEY(left_id,right_id))');
  db.prepare('INSERT INTO asset_identity_links(left_id,right_id) VALUES(?,?)').run(bike.id, oldBike.id);
  put({ name: 'Travel adapter', class_id: 'travel_adapter', dates: {}, rules: [] });
  // Known only by an alias: its label never says the place's own name.
  history.savePlace({ name: 'Lisbon', aliases: ['Lisboa', 'LIS'] });
  const flat = put({ name: 'Rental flat', dates: {}, anchors: [{ kind: 'place', name: 'Lisboa' }], rules: [] });
  const flatBoiler = put({ name: 'Flat boiler', belongs_to: flat.id, dates: {}, rules: [] });
  // Two levels down it still takes the flat's place, beyond one hop of relations.
  put({ name: 'Boiler filter', belongs_to: flatBoiler.id, dates: {}, rules: [] });
  // Reached only as another fact's subject: its parent, child and linked record
  // have no clocks, holders or recent changes of their own.
  const shed = put({ name: 'Garden shed', dates: {}, rules: [] });
  const pump = put({ name: 'Garden pump', belongs_to: shed.id, dates: {}, rules: [] });
  put({ name: 'Pump filter', belongs_to: pump.id, dates: {}, rules: [] });
  const oldPump = put({ name: 'Garden pump (old record)', dates: {}, rules: [] });
  db.prepare('INSERT INTO asset_identity_links(left_id,right_id) VALUES(?,?)').run(oldPump.id, pump.id);
  const hose = put({ name: 'Garden hose', dates: {}, rules: [] });
  const next = random(325);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const generated: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const offset = Math.floor(next() * 500) - 120;
    const kind = pick(['expiry', 'expiry_notice', 'interval', 'question', 'condition', 'usage', 'none'] as const);
    const rules = kind === 'none' ? [] : [kind === 'expiry' ? rule('renew', { kind: 'expiry', field: 'expires_on' }, { schedule: { before: [{ amount: Math.floor(next() * 3), unit: 'months' }], on_day: true } })
      : kind === 'expiry_notice' ? rule('ends', { kind: 'expiry', field: 'expires_on' }, { reaction: { notify: true, occurrence: 'notice', emit: false } })
      : kind === 'interval' || kind === 'question' ? rule('service', { kind: 'interval', field: 'serviced_on', every: { amount: 1 + Math.floor(next() * 12), unit: 'months' } })
      : kind === 'condition' ? rule('alarm', { kind: 'condition', field: 'alarm', certainty: 'confirmed' })
      : rule('usage', { kind: 'objective', field: 'meter', target: 1000, unit: 'kWh', direction: 'rising', mode: 'usage', lead_days: 10 })];
    const asset = put({ name: `${pick(['Garden', 'Office', 'Spare', 'Main', 'Guest'])} ${pick(['heater', 'printer', 'licence', 'pump', 'router', 'lease'])} ${index}`,
      ...(index > 4 && next() < 0.3 ? { belongs_to: pick(generated) } : {}), ...(next() < 0.2 ? { holder_contact: person(pick([ana, bob])) } : {}),
      ...(next() < 0.5 ? { sphere: pick(['personal', 'professional'] as Sphere[]) } : {}),
      dates: kind === 'expiry' || kind === 'expiry_notice' ? { expires_on: day(offset) } : kind === 'interval' ? { serviced_on: day(offset - 365) } : kind === 'question' ? { serviced_on: null } : {},
      ...(kind === 'condition' ? { observations: { alarm: { active: next() < 0.7, certainty: 'confirmed' as const, as_of: T0 - 3_600_000, evidence: [], source: 'owner' } } } : {}),
      ...(kind === 'usage' ? { readings: { meter: { value: Math.floor(next() * 1200), unit: 'kWh', as_of: T0 - DAY, evidence: [] } } } : {}), rules });
    generated.push(asset.id);
  }
  // A whole source, like the episodes, whose fact names records by subject and relation.
  const recalled = (): SituationFact[] => [{ ref: { collection: 'episode', id: 'pump-service' }, title: 'Serviced the garden pump', kind: 'episode', basis: 'declared',
    when: { from: T0 - 2 * DAY, to: T0 - 2 * DAY }, act_by: T0 - 2 * DAY, people: [], subjects: [{ collection: 'asset', id: pump.id }],
    related: [{ collection: 'asset', id: hose.id }], evidence: [{ collection: 'episode', id: 'pump-service' }], consequence: 'routine', sphere: 'personal', updated_at: T0 - 2 * DAY }];
  await occurrences.tick();
  // Written after the last evaluation: these are read as dirty.
  put({ name: 'New visa', class_id: 'passport', holder_contact: person(bob), dates: { expires_on: day(15) }, settings: { nationality: 'US' },
    rules: [rule('renew', { kind: 'expiry', field: 'expires_on' }, { consequence: 'floor' })] });
  work.writeAsset({ id: generated[3]!, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Renamed lease' }, time);

  const sphereOf = (ref: SituationRef): Sphere => ref.collection === 'asset' ? work.readAssetEffective(ref.id)?.sphere ?? 'personal' : work_ids.has(ref.id) ? 'professional' : 'personal';
  const reads: Array<{ source: string; only?: number }> = [];
  const episodes: SituationSource = { id: 'episode', collection: 'episode', verb_op: situationSourceAccess('episode')!.verb_op, read: recalled };
  const sources = [...buildSituationSources({ db, work, reminders, contacts, mailFacts, calendars: () => [{ slug: 'home', table: calendar }],
    now: () => time, timeZone: () => zone, sphere: ref => sphereOf(ref), place: value => history.place(value) }), episodes].map((source): SituationSource => ({ ...source,
    read: (query, signal, context, only) => { reads.push({ source: source.collection, ...(only ? { only: only.size } : {}) }); return source.read(query, signal, context, only); } }));
  const learned = (facts: readonly SituationFact[]): SituationFact[] => facts.filter(trip => trip.trip && trip.sphere === 'personal').flatMap(trip => facts
    .filter(candidate => candidate.sphere === 'personal' && candidate.ref.collection === 'asset' && work.readAssetEffective(candidate.ref.id)?.class_id === 'travel_adapter')
    .map(candidate => ({ ...candidate, related: [...candidate.related, trip.ref], subjects: [...candidate.subjects, trip.ref], basis: 'declared' as const, evidence: [...candidate.evidence, ...trip.evidence] })));
  const deps = { sources, sourceForCollection: situationSourceAccess, now: () => time, namedPeople: createSituationNamedPeople(contacts),
    relate: (facts: readonly SituationFact[], _query: SituationQuery, context: SituationReadContext) => [
      ...relateTravelDocuments(facts, RULES, zone, travelDocumentsVisible(context, situationSourceAccess('asset'))), ...learned(facts)],
    relationClasses: () => ['travel_adapter'] };
  const boilerService = work.listCommitments().find(row => row.statement === 'service · Boiler')!;
  // The reference reads every record: the same sources without their indexes.
  return { scan: createSituationQuery({ ...deps, sources: sources.map(({ index: _index, ...source }) => source) }), indexed: createSituationQuery(deps), reads, sphereOf, sources,
    ids: { porto: `home:${porto.record_id}`, ana: person(ana), bob: person(bob), car: car.id, insurance: insurance.id, passport: passport.id, paris: paris.id, quote: quote.id, project: project.id, boilerService: boilerService.id } };
};

const grants = (denied: string[] = []) => ({ isVerbOpGranted: () => true, isCollectionReadGranted: (collection: string) => !denied.includes(collection), isTopicReadGranted: () => true });
describe('D-325 §6.3 indexed situation read', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Pacific/Auckland'])('selects exactly what the full scan selects (%s)', async zone => {
    const f = await fixture(zone);
    const contexts: Record<string, SituationReadContext> = {
      owner: { owner: true, grants: grants() },
      'no commitments': { owner: true, grants: grants(['commitment']) },
      'no assets': { owner: true, grants: grants(['asset']) },
      personal: { owner: false, spheres: ['personal'], grants: grants(), referenceSphere: ref => f.sphereOf(ref) },
      'all spheres': { owner: false, all_spheres: true, grants: grants() },
    };
    const queries = (at: number): SituationQuery[] => [
      { time: { from: at, to: at + 14 * DAY } }, { time: { from: at, to: at + DAY }, surface: 'today' }, { time: at },
      { time: { from: at, to: at + 60 * DAY }, surface: 'digest' }, { time: { from: at, to: at + 2 * DAY }, surface: 'push' },
      { time: { from: at - 30 * DAY, to: at - 10 * DAY } }, { time: { from: at + 15 * DAY, to: at + 30 * DAY } },
      { time: { from: at, to: at + 400 * DAY }, limit_items: 2, limit_clusters: 3 },
      { time: { from: at, to: at + 7 * DAY }, subjects: [{ collection: 'asset', id: f.ids.car }] },
      { time: { from: at, to: at + 7 * DAY }, subjects: [{ collection: 'booking', id: f.ids.paris }] },
      { time: { from: at, to: at + 7 * DAY }, subjects: [{ collection: 'asset', id: f.ids.passport }, { collection: 'project', id: f.ids.project }] },
      { time: { from: at, to: at + 7 * DAY }, people: [f.ids.ana] }, { time: { from: at, to: at + 3 * DAY }, people: [f.ids.bob] },
      { time: { from: at, to: at + 7 * DAY }, people: ['bob@example.test'] },
      { time: { from: at, to: at + 7 * DAY }, place: { key: 'label:lisbon', name: 'Lisbon' } },
      { time: { from: at, to: at + 7 * DAY }, text: 'insurance' }, { time: { from: at, to: at + 7 * DAY }, text: 'boiler service' },
      { time: { from: at, to: at + 7 * DAY }, changed_since: T0 - 1 },
      // East of UTC a day's due starts before its stored midnight.
      { time: { from: at, to: Math.max(at, Date.parse(day(9)) - 1) } }, { time: { from: at, to: Math.max(at, Date.parse(day(5)) - 1) }, surface: 'today' },
      // Before its clock's act-by, the commitment is named while its clock is not.
      { time: { from: at - 60 * DAY, to: at - 50 * DAY }, subjects: [{ collection: 'commitment', id: f.ids.boilerService }] },
      { time: { from: at, to: at + 14 * DAY }, surface: 'prefetch', text: 'Is the Paris trip ready, and what about Ana?', limit_clusters: 2, limit_items: 3 },
      { time: { from: at, to: at + 14 * DAY }, surface: 'prefetch', text: 'remind me about the router lease', limit_clusters: 2, limit_items: 3 },
      { time: { from: at, to: at + 14 * DAY }, surface: 'prefetch', text: 'Anything on in Lisbon soon?', limit_clusters: 2, limit_items: 3 },
      { time: { from: at, to: at + 14 * DAY }, surface: 'prefetch', text: 'which warranty ends first, and whose birthday is next', limit_clusters: 2, limit_items: 3 },
      { time: { from: at, to: at + 14 * DAY }, surface: 'prefetch', text: 'aisle or window for the tile trip?', limit_clusters: 2, limit_items: 3 },
      { time: { from: at, to: at + 7 * DAY }, text: 'vet' }, { time: { from: at, to: at + 30 * DAY }, text: 'Power Co' },
      // Named by text alone: none of these is due in the window.
      { time: { from: at, to: at + 7 * DAY }, text: 'gym' }, { time: { from: at, to: at + 7 * DAY }, text: 'conference' },
      { time: { from: at, to: at + 7 * DAY }, text: 'StreamCo' },
      { time: { from: at, to: at + 7 * DAY }, surface: 'prefetch', text: 'what time is dinner?', limit_clusters: 2, limit_items: 3 },
      { time: { from: at, to: at + 7 * DAY }, place: { key: 'label:porto', name: 'Porto' } },
    ];
    let items = 0; let compared = 0;
    // The index rows were written at T0; later reads must not need a new evaluation.
    for (const at of [T0, T0 + 10 * DAY, T0 + 45 * DAY]) {
      time = at;
      for (const query of queries(at)) for (const [name, context] of Object.entries(contexts)) {
        const expected = await f.scan(query, context); const actual = await f.indexed(query, context);
        expect({ at: new Date(at).toISOString(), query, context: name, result: actual }).toEqual({ at: new Date(at).toISOString(), query, context: name, result: expected });
        items += expected.clusters.reduce((sum, cluster) => sum + cluster.items.length, 0); compared += 1;
      }
    }
    expect(compared).toBe(3 * 33 * 5); expect(items).toBeGreaterThan(400);
    time = T0;
    // The calendar event carries its trip, so its travellers' documents are checked against it.
    const [porto] = await f.sources.find(source => source.collection === 'calendar')!.read({ time: T0 }, undefined, contexts.owner, new Set([f.ids.porto]));
    expect(porto?.trip).toMatchObject({ destination_country: 'PT', travellers: [f.ids.ana, f.ids.bob] });
    // Long before anything is due, naming the insurance brings in its car by one hop of relations.
    f.reads.length = 0;
    const named = await f.indexed({ time: T0 - 500 * DAY, subjects: [{ collection: 'asset', id: f.ids.insurance }] }, contexts.owner!);
    expect(named.clusters).toHaveLength(1);
    expect(new Set(named.clusters[0]!.items.map(item => item.ref.id))).toEqual(new Set([f.ids.insurance, f.ids.car]));
    expect(f.reads.filter(read => read.source === 'asset').every(read => read.only !== undefined)).toBe(true);
  }, 180_000);

  it('reads the classes a learned relation names, as the server composes it', async () => {
    const spheres = createSphereStore(db, work);
    const learning = createProactiveLearning({ db, work, spheres, situations: createSituationStore(db), now: () => time, timeZone: () => 'UTC', isVaultUnlocked: () => true });
    learning.store.setRelation({ key: 'trip:travel_adapter', from: 'trip', target_class: 'travel_adapter', sphere: 'personal', evidence: [] });
    const trip = work.writeBooking({ source_id: 'recued.booking', title: 'Rome trip', slot_start_at: T0 + 60 * DAY, slot_end_at: T0 + 64 * DAY,
      source_extension_blob: { trip: { destination_country: 'IT' } } }, time);
    const adapter = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Plug adapter', class_id: 'travel_adapter', dates: {}, rules: [] }, time);
    for (const ref of [{ collection: 'booking', id: trip.id }, { collection: 'asset', id: adapter.id }]) spheres.setItem(ref, 'personal');
    await createAssetOccurrenceService({ db, work, dispatchers: createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time }),
      now: () => time, timeZone: () => 'UTC' }).tick();
    const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now: () => time, timeZone: () => 'UTC',
      sphere: (ref, source) => spheres.resolve(ref, source).sphere });
    const deps = { sources, sourceForCollection: situationSourceAccess, now: () => time, relate: (facts: readonly SituationFact[]) => learning.related(facts),
      relationClasses: () => learning.relationClasses() };
    const query: SituationQuery = { time: { from: T0, to: T0 + 7 * DAY }, subjects: [{ collection: 'booking', id: trip.id }] };
    const expected = await createSituationQuery({ ...deps, sources: sources.map(({ index: _index, ...source }) => source) })(query, { owner: true, grants: grants() });
    expect(expected.clusters.flatMap(cluster => cluster.items).map(item => item.ref.id).sort()).toEqual([adapter.id, trip.id].sort());
    expect(await createSituationQuery(deps)(query, { owner: true, grants: grants() })).toEqual(expected);
  });

  it('evaluates the assets a window needs, not every asset on file', async () => {
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time });
    const renew = rule('renew', { kind: 'expiry', field: 'expires_on' }, { schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } });
    for (let index = 0; index < 300; index += 1) work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: `Licence ${index}`,
      dates: { expires_on: day(200 + index) }, rules: [renew] }, time);
    const due = ['Passport', 'Boiler cover', 'Car tax'].map((name, index) => work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name,
      dates: { expires_on: day(20 + index) }, rules: [renew] }, time).id);
    await createAssetOccurrenceService({ db, work, dispatchers, now: () => time, timeZone: () => 'UTC' }).tick();
    const reads: Array<number | undefined> = [];
    const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now: () => time, timeZone: () => 'UTC' })
      .map((source): SituationSource => source.collection !== 'asset' ? source : { ...source, read: (query, signal, context, only) => { reads.push(only?.size); return source.read(query, signal, context, only); } });
    const indexed = createSituationQuery({ sources, sourceForCollection: situationSourceAccess, now: () => time });
    const result = await indexed({ time: { from: T0, to: T0 + 14 * DAY } }, { owner: true, grants: grants() });
    // Each lead has merged into the commitment it stands for.
    expect(result.clusters.flatMap(cluster => cluster.items).map(item => item.ref.collection)).toEqual(['commitment', 'commitment', 'commitment']);
    expect(result.clusters.flatMap(cluster => cluster.subjects).map(ref => ref.id).sort()).toEqual([...due].sort());
    expect(reads).toEqual([3]);
    // A chat message keeps only what it names, so it reads just that asset.
    reads.length = 0;
    const named = await indexed({ time: { from: T0, to: T0 + 14 * DAY }, surface: 'prefetch', text: 'Is the boiler cover sorted?', limit_clusters: 2, limit_items: 3 },
      { owner: true, grants: grants() });
    expect(named.clusters.flatMap(cluster => cluster.subjects).map(ref => ref.id)).toEqual([due[1]]);
    expect(reads).toEqual([1]);
  });
});
