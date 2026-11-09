/** D-343 slice 1 (ruling 15) — a mail fact stays the mail's, and the agenda shows it through the
 *  record made from it. Measured before this (2026-11-06): a bill with the Bills pack's commitment
 *  showed twice, and marking the commitment done left the bill there until an email said paid.
 *  Now a fact a live record links (`source_extension_blob: { kind: 'mail_fact', thing_id }`, as
 *  both packs write it) is that record's on the agenda: once, closing by the record's rules, and
 *  back when the record is deleted.
 *
 *  ⛔ DRIVEN ON THE REAL SOURCES, QUERY AND STORES, as `d-325-situation-sources.test.ts` is. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MailFactThing, SituationQuery } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import { buildSituationSources } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';

const NOW = Date.parse('2026-11-07T12:00Z');
const DAY = 86_400_000;
let db: Database.Database; let work: WorkEntityStore;
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); });
afterEach(() => db.close());

const harness = () => {
  const mailFacts = createMailFactStore(db);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => NOW });
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), contacts: createContactStore(db), mailFacts,
    calendars: () => [], now: () => NOW, timeZone: () => 'UTC' });
  const query = createSituationQuery({ sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }), now: () => NOW });
  /** The week's agenda, each item as "collection: title". */
  const week = async (input: Partial<SituationQuery> = {}) => (await query({ time: { from: NOW, to: NOW + 7 * DAY }, ...input },
    { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } }))
    .clusters.flatMap(cluster => cluster.items).map(item => `${item.ref.collection}: ${item.what.value}`).sort();
  const thing = (thing_id: string, type: string, variables: Record<string, unknown>) => mailFacts.saveThing({ thing_id, type, identity_keys: [`${type}:${thing_id}`],
    variables, passes: {}, variable_email_at: {}, last_email_at: NOW - DAY, missing: [], complete: true, created_at: NOW - DAY, updated_at: NOW - DAY } as MailFactThing);
  const link = (thing_id: string, fact_type: string) => ({ source_extension_blob: { kind: 'mail_fact', fact_type, thing_id } });
  return { dispatchers, week, thing, link };
};

describe('D-343 ruling 15 — the agenda shows a mail fact through the record made from it', () => {
  it('shows a bill once, as the commitment the Bills pack made from it, which closes it', async () => {
    const f = harness();
    f.thing('acme', 'bill', { issuer: 'Acme Power', due_at: '2026-11-10', state: 'issued' });
    expect(await f.week()).toEqual(['mail_fact: Bill: Acme Power']);
    const pay = (await f.dispatchers.commitmentCreate({ direction: 'outbound', statement: 'Pay Acme Power bill', derivation: 'mail_extracted',
      promised_for_at: Date.parse('2026-11-10T00:00Z'), ...f.link('acme', 'bill') } as never)).commitment;
    expect(await f.week()).toEqual(['commitment: Pay Acme Power bill']);
    // Kept, the bill closes with it, though no email has said it was paid.
    await f.dispatchers.commitmentFulfill({ id: pay.id });
    expect(await f.week()).toEqual([]);
  });
  it('gives the fact back when its record is deleted, and keeps a fact another record names', async () => {
    const f = harness();
    f.thing('acme', 'bill', { issuer: 'Acme Power', due_at: '2026-11-10', state: 'issued' });
    f.thing('water', 'bill', { issuer: 'City Water', due_at: '2026-11-11', state: 'issued' });
    const pay = (await f.dispatchers.commitmentCreate({ direction: 'outbound', statement: 'Pay Acme Power bill', derivation: 'mail_extracted',
      promised_for_at: Date.parse('2026-11-10T00:00Z'), ...f.link('acme', 'bill') } as never)).commitment;
    expect(await f.week()).toEqual(['commitment: Pay Acme Power bill', 'mail_fact: Bill: City Water']);
    await f.dispatchers.commitmentDelete({ id: pay.id });
    expect(await f.week()).toEqual(['mail_fact: Bill: Acme Power', 'mail_fact: Bill: City Water']);
  });
  it('shows a reservation once, as the booking the Bookings pack made from it', async () => {
    const f = harness();
    const at = Date.parse('2026-11-09T15:00Z');
    f.thing('ryokan', 'reservation', { kind: 'lodging', provider: 'Kyoto ryokan', starts_at: at, ends_at: at + 2 * DAY, state: 'confirmed' });
    f.thing('table', 'reservation', { kind: 'restaurant', provider: 'Trattoria', starts_at: at + DAY, ends_at: at + DAY + 7_200_000, state: 'confirmed' });
    await f.dispatchers.bookingCreate({ title: 'Kyoto ryokan', lifecycle_state: 'confirmed', slot_start_at: at, slot_end_at: at + 2 * DAY,
      ...f.link('ryokan', 'reservation') } as never);
    expect(await f.week()).toEqual(['booking: Kyoto ryokan', 'mail_fact: Reservation: Trattoria']);
  });
});
