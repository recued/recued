/** D-315 slice 1 — the fact writer over a real store (§4, §4.1, §5, §5.3, §9). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMailFactBuiltinType, type MailTemplateDefinition } from '@recued/contracts';
import type { WarehouseEvent } from '@recued/warehouse-events';

import {
  createMailFactWriter,
  factSourceHash,
  MAIL_FACT_SWEEP_PAGE,
  sweepGoneEmails,
  type MailFactWriteInput,
  type MailFactWriter,
} from '../mail-facts/fact-writer.js';
import { mailFactEmailAt } from '../mail-facts/mail-ingest.js';
import { MAIL_FACT_READING_VERSION } from '../mail-facts/normalize.js';
import type { MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';

let dir: string;
let db: Database.Database;
let store: MailFactStore;
let writer: MailFactWriter;
let events: WarehouseEvent[];
let clock: number;
let ids: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-writer-'));
  db = new Database(join(dir, 'test.db'));
  clock = 10_000;
  ids = 0;
  events = [];
  store = createMailFactStore(db, { now: () => clock, mintId: (prefix) => `${prefix}_${(ids += 1)}` });
  writer = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => clock });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const upsTemplate = (over: Partial<MailTemplateDefinition> = {}): MailTemplateDefinition => ({
  name: 'UPS',
  type: 'shipment',
  entrance: {
    conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }],
    variables: ['tracking_number'],
  },
  rules: [
    { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'constant', value: 'UPS' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
    {
      target: { variable: 'state' },
      source: 'subject',
      find: {
        kind: 'keyword_map',
        cases: [
          { contains: 'Delivered', value: 'delivered' },
          { contains: 'On the way', value: 'in_transit' },
        ],
      },
    },
    { target: { data: 'note' }, source: 'body', find: { kind: 'after_label', label: 'Note:' } },
  ],
  html: false,
  ai: { enabled: false },
  ...over,
});

const email = (over: Partial<MailFactSourceEmail> = {}): MailFactSourceEmail => ({
  subject: 'UPS Update: On the way',
  body_text: 'Tracking Number: 1Z0000000000000001\nNote: leave at the door\n',
  html: null,
  from_address: 'pkginfo@ups.com',
  from_name: 'UPS',
  headers: {},
  labels: ['INBOX'],
  relationships: [],
  attachments: [],
  ...over,
});

const input = (record_id: string, over: Partial<MailFactWriteInput> = {}): MailFactWriteInput => ({
  ref: { slug: 'work', record_id },
  email: email(),
  email_at: 1_000,
  content_fingerprint: `content-of-${record_id}`,
  may_trigger: true,
  count_health: true,
  ...over,
});

describe('a new email', () => {
  it('stores its fact, creates the thing and emits `created` with the fact in `record`', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    const result = writer.write(input('mail:1'));
    expect(result).toEqual({ facts: 1, events: 1 });

    const [event] = events;
    expect(event?.platform).toBe('mail_fact');
    expect(event?.slug).toBe('shipment');
    expect(event?.entity_type).toBe('thing');
    expect(event?.event_kind).toBe('created');
    expect(event?.at).toBe(1_000);
    // Every variable read, and when its newest email arrived (ruling 44).
    expect([...(event?.changed_fields ?? [])].sort()).toEqual(['carrier', 'last_email_at', 'state', 'tracking_number']);
    const record = event?.record as Record<string, unknown>;
    // Variables at the top level, every one present: null when unread (strict where).
    expect(record.tracking_number).toBe('1Z0000000000000001');
    expect(record.state).toBe('in_transit');
    expect(record.merchant).toBeNull();
    expect(record.template).toBe('mtpl_1');
    expect((record.fact as { data: unknown }).data).toEqual({ note: 'leave at the door' });
    expect(event?.prev).toBeUndefined();
  });

  it('stores facts silently when the email may not trigger (past mail, a first backfill)', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    expect(writer.write(input('mail:1', { may_trigger: false }))).toEqual({ facts: 1, events: 0 });
    expect(store.listThings({ type: 'shipment' })).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe('several emails about one thing', () => {
  it('a later email joins the thing and emits `updated` with what changed and `prev`', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    clock += 1;
    writer.write(input('mail:2', { email: email({ subject: 'UPS Update: Delivered' }), email_at: 2_000 }));
    expect(events).toHaveLength(2);
    const updated = events[1]!;
    expect(updated.event_kind).toBe('updated');
    expect(updated.record_id).toBe(events[0]!.record_id); // the same thing
    expect(updated.changed_fields).toEqual(['state', 'last_email_at']);
    expect((updated.prev as Record<string, unknown>).state).toBe('in_transit');
    expect((updated.record as Record<string, unknown>).state).toBe('delivered');
    expect((updated.prev as Record<string, unknown>).last_email_at).toBe(1_000);
    expect((updated.record as Record<string, unknown>).last_email_at).toBe(2_000);
  });

  // Ruling 44: a carrier's daily "still in transit" is news only to a trigger
  // that asked for every email; the dispatcher keeps it from the rest.
  it('a newer email that says nothing new changes only when its newest email arrived — and says so', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    writer.write(input('mail:2', { email_at: 2_000 }));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ event_kind: 'updated', changed_fields: ['last_email_at'] });
    expect((events[1]!.record as Record<string, unknown>).last_email_at).toBe(2_000);
    expect(store.listThings()[0]?.last_email_at).toBe(2_000);
  });

  it('a payment read after a reminder of the same date leaves no notice: the newest email is the one read last', () => {
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Bill notices', type: 'bill',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'bills@example.com' }], variables: ['invoice_number'] },
        rules: [
          { target: { variable: 'issuer' }, source: 'body', find: { kind: 'constant', value: 'Power Co' } },
          { target: { variable: 'invoice_number' }, source: 'body', find: { kind: 'after_label', label: 'Invoice:' } },
          { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: 'reminder', value: 'issued' }, { contains: 'Paid', value: 'paid' }] } },
          { target: { variable: 'notice' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: 'reminder', value: 'reminder' }] } },
        ],
        html: false, ai: { enabled: false },
      },
    });
    writer.write(input('mail:reminder', { email: email({ from_address: 'bills@example.com', subject: 'Payment reminder', body_text: 'Invoice: INV-1\n' }) }));
    clock += 1;
    writer.write(input('mail:payment', { email: email({ from_address: 'bills@example.com', subject: 'Paid', body_text: 'Invoice: INV-1\n' }) }));
    expect(store.listThings()[0]?.variables).toMatchObject({ state: 'paid', notice: null });
    expect(events.at(-1)?.record).toMatchObject({ state: 'paid', notice: null });
  });

  it('a delivery time written again at another offset wakes nothing watching it: 10:00+01:00, then 09:00Z', () => {
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Deliveries', type: 'shipment',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'parcels@example.com' }], variables: ['tracking_number'] },
        rules: [
          { target: { variable: 'carrier' }, source: 'body', find: { kind: 'constant', value: 'DHL' } },
          { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking:' } },
          { target: { variable: 'delivered_at' }, source: 'body', find: { kind: 'after_label', label: 'Delivered:' } },
        ],
        html: false, ai: { enabled: false },
      },
    });
    writer.write(input('mail:d1', { email: email({ from_address: 'parcels@example.com', body_text: 'Tracking: ABC123\nDelivered: 2026-09-27T10:00:00+01:00\n' }), email_at: 1_000 }));
    writer.write(input('mail:d2', { email: email({ from_address: 'parcels@example.com', body_text: 'Tracking: ABC123\nDelivered: 2026-09-27T09:00:00Z\n' }), email_at: 2_000 }));
    expect(events.map((event) => event.changed_fields?.includes('delivered_at'))).toEqual([true, false]);
  });

  it('of two emails of one date read in one millisecond, the one read after is the newer — whatever their facts’ ids', () => {
    // The later fact's id sorts first.
    const factIds = ['mfact_ffffffff-ffff-4fff-8fff-ffffffffffff', 'mfact_00000000-0000-4000-8000-000000000000'];
    store = createMailFactStore(db, { now: () => clock, mintId: (prefix) => (prefix === 'mfact' ? factIds.shift()! : `${prefix}_${(ids += 1)}`) });
    writer = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => clock });
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1', { email_at: 1_000 }));
    writer.write(input('mail:2', { email_at: 1_000, email: email({ subject: 'UPS Update: Delivered' }) }));
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
    expect(events.map((event) => (event.record as { state?: string }).state)).toEqual(['in_transit', 'delivered']);
  });

  it('two emails of one date that say the same are each news to a recipe on every email', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1', { email_at: 1_000 }));
    clock += 1;
    writer.write(input('mail:2', { email_at: 1_000 }));
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:2' })).toHaveLength(1);
    expect(events.map((event) => [event.event_kind, event.changed_fields])).toEqual([
      ['created', expect.arrayContaining(['last_email_at'])],
      ['updated', ['last_email_at']],
    ]);
  });

  it('an older email arriving late neither moves the state back nor emits', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:2', { email: email({ subject: 'UPS Update: Delivered' }), email_at: 2_000 }));
    writer.write(input('mail:1', { email_at: 1_000 }));
    expect(events.map((e) => e.event_kind)).toEqual(['created']);
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
  });
});

const ref = (record_id: string) => ({ slug: 'work', record_id });

/** A purchase template that reads no identity: each fact is its own thing. */
const anyOrder: MailTemplateDefinition = {
  name: 'Any shipped order',
  type: 'purchase',
  entrance: { conditions: [{ field: 'subject', op: 'contains', value: 'UPS' }], variables: [] },
  rules: [],
  html: false,
  ai: { enabled: false },
};

describe('reading an email again (ruling 13)', () => {
  it('reads again what an older reader read, though its email and template did not change: a parser fixed since corrects it', () => {
    const bistro: MailTemplateDefinition = {
      name: 'Bistro', type: 'reservation',
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'bistro.example' }], variables: ['starts_at'] },
      rules: [
        { target: { variable: 'kind' }, source: 'body', find: { kind: 'constant', value: 'event' } },
        { target: { variable: 'provider' }, source: 'from_name', find: { kind: 'whole' } },
        { target: { variable: 'confirmation_code' }, source: 'body', find: { kind: 'after_label', label: 'Code:' } },
        { target: { variable: 'starts_at' }, source: 'body', find: { kind: 'after_label', label: 'When:' } },
      ],
      html: false, ai: { enabled: false },
    };
    const template = store.createTemplate({ definition: bistro, origin: { kind: 'owner' } });
    const table = email({ from_address: 'table@bistro.example', from_name: 'Bistro', subject: 'Your table', body_text: 'Code: R-1\nWhen: 28 September 2026 9:00\u201310:00 PM (UTC+01:00)\n' });
    writer.write(input('mail:1', { email: table, may_trigger: false }));
    const read = store.factRecordsForEmail(ref('mail:1'))[0]!;
    expect(read.variables.starts_at).toBe('2026-09-28T21:00:00+01:00');
    // As the reader before this one stored it: nine in the morning.
    store.updateFact({
      ...read,
      variables: { ...read.variables, starts_at: '2026-09-28T09:00:00+01:00' },
      source_hash: factSourceHash('content-of-mail:1', template, getMailFactBuiltinType('reservation')!, false, MAIL_FACT_READING_VERSION - 1),
    });
    writer.write(input('mail:1', { email: table, may_trigger: true, force: true, origin: 'backfill', backfill_template: template.template_id }));
    expect(store.factRecordsForEmail(ref('mail:1'))[0]?.variables.starts_at).toBe('2026-09-28T21:00:00+01:00');
    expect(events).toEqual([expect.objectContaining({ record: expect.objectContaining({ starts_at: '2026-09-28T21:00:00+01:00' }) })]);
  });

  it('skips an email it read already with the same content: a restart re-lists it', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    expect(writer.write(input('mail:1'))).toEqual({ skipped: 'unchanged', facts: 1, events: 0 });
    expect(events).toHaveLength(1);
  });

  it('reads past mail with a template made or changed only when a backfill asks', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    const [first] = store.factsForEmail(ref('mail:1'));
    store.updateTemplate(template.template_id, { definition: upsTemplate({ name: 'UPS (renamed)' }) });
    const relisted = input('mail:1', { may_trigger: false, count_health: false });
    expect(writer.write(relisted)).toMatchObject({ skipped: 'unchanged' });
    // The backfill reads it again. The same reading: nothing is written, the
    // fact keeps its id and revision, and nothing fires.
    expect(writer.write({ ...relisted, force: true })).toEqual({ facts: 0, events: 0 });
    expect(store.factsForEmail(ref('mail:1'))).toEqual([expect.objectContaining({ fact_id: first!.fact_id, revision: 1 })]);
  });

  it('reads an email already read with a template added later only in a backfill', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    store.createTemplate({ definition: anyOrder, origin: { kind: 'owner' } });
    expect(writer.write(input('mail:1', { may_trigger: false }))).toMatchObject({ skipped: 'unchanged' });
    expect(writer.write(input('mail:1', { may_trigger: false, force: true }))).toEqual({ facts: 1, events: 0 });
    expect(store.factsForEmail(ref('mail:1')).map((fact) => fact.type).sort()).toEqual(['purchase', 'shipment']);
  });

  it('re-reads when a label a template tests is added later, and not for one no template tests', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    store.createTemplate({
      definition: {
        name: 'Receipts label',
        type: 'purchase',
        entrance: { conditions: [{ field: 'label', op: 'is', value: 'Receipts' }], variables: [] },
        rules: [],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    expect(writer.write(input('mail:1')).facts).toBe(1);
    // Read → no longer UNREAD: nothing a template tests changed.
    // A later reading is never a first sighting, so it may not trigger.
    const again = (labels: string[]): MailFactWriteInput =>
      input('mail:1', { email: email({ labels }), may_trigger: false, count_health: false });
    expect(writer.write(again(['INBOX', 'UNREAD']))).toMatchObject({ skipped: 'unchanged' });
    // The owner files it under Receipts: the purchase template now enters.
    expect(writer.write(again(['INBOX', 'Receipts']))).toEqual({ facts: 1, events: 0 });
    expect(store.factsForEmail(ref('mail:1'))).toHaveLength(2);
  });

  it('keeps the facts of a template switched off, or deleted, when the email is read again', () => {
    const ups = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    const other = store.createTemplate({ definition: anyOrder, origin: { kind: 'owner' } });
    const backfill = input('mail:1', { may_trigger: false, force: true, backfill_template: other.template_id });
    store.updateTemplate(ups.template_id, { active: false });
    writer.write(backfill);
    expect(store.factsForEmail(ref('mail:1')).map((fact) => fact.type).sort()).toEqual(['purchase', 'shipment']);
    store.deleteTemplate(ups.template_id);
    writer.write(backfill);
    expect(store.factsForEmail(ref('mail:1')).map((fact) => fact.type).sort()).toEqual(['purchase', 'shipment']);
  });

  it('keeps a fact that reads no identity on its thing when a changed template reads it again', () => {
    const template = store.createTemplate({ definition: anyOrder, origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    const [before] = store.factsForEmail(ref('mail:1'));
    store.updateTemplate(template.template_id, {
      definition: { ...anyOrder, rules: [{ target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'whole' } }] },
    });
    expect(writer.write(input('mail:1', { may_trigger: false, force: true }))).toEqual({ facts: 1, events: 0 });
    const [after] = store.factsForEmail(ref('mail:1'));
    expect(after).toMatchObject({ type: 'purchase', fact_id: before!.fact_id, thing_id: before!.thing_id, revision: 2 });
    expect(after!.variables.merchant).toBe('UPS');
    expect(store.listThings({ type: 'purchase' })).toHaveLength(1);
  });
});

describe('news (§5)', () => {
  it('stays news until its facts are read: a stop before the reading does not lose it', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    // The row landed and was news; the process stopped before the facts were read.
    writer.markNews(ref('mail:1'));
    // The restart's re-list sees the row as old: no first sighting, and still news.
    expect(writer.write(input('mail:1', { may_trigger: false, count_health: false }))).toEqual({ facts: 1, events: 1 });
    // Delivered: reading it again is not news.
    expect(writer.write(input('mail:1', { may_trigger: false, count_health: false, force: true }))).toEqual({ facts: 0, events: 0 });
    expect(events).toHaveLength(1);
  });

  it('is announced by a backfill that runs recipes when it was stored silently — once, and only its template’s', () => {
    const ups = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    store.createTemplate({ definition: anyOrder, origin: { kind: 'owner' } });
    writer.write(input('mail:1', { may_trigger: false }));
    expect(events).toEqual([]);
    const backfill = input('mail:1', {
      may_trigger: true, origin: 'backfill', force: true, backfill_template: ups.template_id,
    });
    expect(writer.write(backfill)).toEqual({ facts: 0, events: 1 });
    expect(events[0]).toMatchObject({ slug: 'shipment', event_kind: 'created', origin: 'backfill' });
    expect(events[0]!.prev).toBeUndefined();
    // Once: a second backfill with recipes starts nothing.
    expect(writer.write(backfill)).toEqual({ facts: 0, events: 0 });
  });

  it('replays past mail as it came: a backfill that runs recipes tells each email against what was told before it', () => {
    const ups = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    // Three notices of one parcel, stored silently by the first scan.
    const notices = [
      ['mail:1', 'UPS Update: On the way', 1_000],
      ['mail:2', 'UPS Update: On the way', 2_000],
      ['mail:3', 'UPS Update: Delivered', 3_000],
    ] as const;
    for (const [id, subject, at] of notices) writer.write(input(id, { may_trigger: false, email_at: at, email: email({ subject }) }));
    expect(events).toEqual([]);
    // The backfill, oldest first, as it reads them.
    for (const [id, subject, at] of notices) {
      writer.write(input(id, {
        may_trigger: true, origin: 'backfill', force: true, backfill_template: ups.template_id, email_at: at, email: email({ subject }),
      }));
    }
    expect(events.map((event) => [
      event.event_kind, event.changed_fields, (event.record as { state?: string }).state, (event.prev as { state?: string } | undefined)?.state ?? null,
    ])).toEqual([
      ['created', expect.arrayContaining(['state', 'tracking_number']), 'in_transit', null],
      ['updated', ['last_email_at'], 'in_transit', 'in_transit'],
      ['updated', ['state', 'last_email_at'], 'delivered', 'in_transit'],
    ]);
  });

  it('tells an older email backfilled after a newer one fired against what was heard: no change it would have made then', () => {
    const ups = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    // The delivery fired live; the transit notice before it was stored silently.
    writer.write(input('mail:2', { email_at: 2_000, email: email({ subject: 'UPS Update: Delivered' }) }));
    writer.write(input('mail:1', { may_trigger: false, email_at: 1_000 }));
    expect(events.map((event) => event.event_kind)).toEqual(['created']);
    // Told now, in transit → delivered would fire the delivery's recipes again.
    writer.write(input('mail:1', {
      may_trigger: true, origin: 'backfill', force: true, backfill_template: ups.template_id, email_at: 1_000,
    }));
    expect(events.map((event) => event.event_kind)).toEqual(['created']);
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
  });

  it('tells live mail against everything known of the thing, past mail stored silently included', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1', { may_trigger: false, email_at: 1_000 }));
    writer.write(input('mail:2', { email_at: 2_000, email: email({ subject: 'UPS Update: Delivered' }) }));
    expect(events).toEqual([expect.objectContaining({ event_kind: 'updated', prev: expect.objectContaining({ state: 'in_transit' }) })]);
  });

  it('is never announced twice: a backfill that runs recipes skips what fired live', () => {
    const ups = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    expect(events).toHaveLength(1);
    writer.write(input('mail:1', { may_trigger: true, origin: 'backfill', force: true, backfill_template: ups.template_id }));
    expect(events).toHaveLength(1);
  });
});

describe('identity (§3.1)', () => {
  const returns: MailTemplateDefinition = {
    name: 'Returns',
    type: 'return_refund',
    entrance: { conditions: [{ field: 'from', op: 'is', value: 'returns@shop.example' }], variables: ['merchant'] },
    rules: [
      { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'whole' } },
      { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
      { target: { variable: 'return_id' }, source: 'body', find: { kind: 'after_label', label: 'Return:' } },
    ],
    html: false,
    ai: { enabled: false },
  };
  const returnEmail = (body: string): MailFactSourceEmail =>
    email({ from_address: 'returns@shop.example', from_name: 'Shop', subject: 'Your return', body_text: body });
  const thingOf = (record_id: string): string | null => store.factsForEmail(ref(record_id))[0]!.thing_id;

  beforeEach(() => {
    store.createTemplate({ definition: returns, origin: { kind: 'owner' } });
  });

  it('keeps two returns of one order apart: their return ids disagree', () => {
    writer.write(input('mail:1', { email: returnEmail('Order: A-1\nReturn: R-1\n') }));
    writer.write(input('mail:2', { email: returnEmail('Order: A-1\nReturn: R-2\n'), email_at: 2_000 }));
    expect(thingOf('mail:1')).not.toBe(thingOf('mail:2'));
    expect(store.listThings().map((thing) => thing.variables.return_id).sort()).toEqual(['R-1', 'R-2']);
  });

  it('never hands one return’s fact, and its announcement, to another return of the same order', () => {
    const template = store.listTemplates()[0]!;
    writer.write(input('mail:1', { email: returnEmail('Order: A-1\nReturn: R-1\n') }));
    const first = store.factRecordsForEmail(ref('mail:1'))[0]!;
    expect(first).toMatchObject({ announced: true, variables: expect.objectContaining({ return_id: 'R-1' }) });
    events.length = 0;
    // Read again, with news, and it is now about R-2: a different return.
    writer.write(input('mail:1', {
      email: returnEmail('Order: A-1\nReturn: R-2\n'),
      content_fingerprint: 'content-now-R-2',
      force: true, origin: 'backfill', backfill_template: template.template_id,
    }));
    const now = store.factRecordsForEmail(ref('mail:1'));
    expect(now.map((fact) => fact.variables.return_id)).toEqual(['R-2']);
    expect(now[0]!.fact_id).not.toBe(first.fact_id);
    expect(now[0]!.announced).toBe(true);
    expect(events).toEqual([expect.objectContaining({ event_kind: 'created', record: expect.objectContaining({ return_id: 'R-2' }) })]);
  });

  it.each([
    ['R-1 first', ['R-1', 'R-2']],
    ['R-2 first', ['R-2', 'R-1']],
  ] as const)('joins a refund that names only the order to neither of two returns of it: which, it does not say (%s)', (_, order) => {
    writer.write(input('mail:1', { email: returnEmail(`Order: A-1\nReturn: ${order[0]}\n`) }));
    clock += 1;
    writer.write(input('mail:2', { email: returnEmail(`Order: A-1\nReturn: ${order[1]}\n`), email_at: 2_000 }));
    events.length = 0;
    writer.write(input('mail:3', { email: returnEmail('Order: A-1\nYour refund is on its way.\n'), email_at: 3_000 }));
    const refund = thingOf('mail:3');
    expect([thingOf('mail:1'), thingOf('mail:2')]).not.toContain(refund);
    expect(events).toEqual([expect.objectContaining({ record: expect.objectContaining({ order_id: 'A-1', return_id: null }) })]);
    // Nor does an email about one of the returns settle it: the refund stays its own.
    const r2 = order[0] === 'R-2' ? thingOf('mail:1') : thingOf('mail:2');
    writer.write(input('mail:4', { email: returnEmail('Order: A-1\nReturn: R-2\n'), email_at: 4_000 }));
    expect(thingOf('mail:4')).toBe(r2);
    expect(thingOf('mail:3')).toBe(refund);
    expect(store.listThings()).toHaveLength(3);
  });

  it('makes one thing of two that an email shows are one, runs and all', () => {
    writer.write(input('mail:1', { email: returnEmail('Order: B-7\n') }));
    clock += 1;
    writer.write(input('mail:2', { email: returnEmail('Return: R-9\n'), email_at: 2_000 }));
    const [older, newer] = [thingOf('mail:1')!, thingOf('mail:2')!];
    expect(older).not.toBe(newer);
    store.recordRun({ email: ref('mail:2'), thing_id: newer, trigger_id: 't-1', recipe_id: 'r-1', outcome: 'completed', at: 1 });
    writer.write(input('mail:3', { email: returnEmail('Order: B-7\nReturn: R-9\n'), email_at: 3_000 }));
    expect([thingOf('mail:1'), thingOf('mail:2'), thingOf('mail:3')]).toEqual([older, older, older]);
    expect(store.getThing(newer)).toBeNull();
    expect(store.runsForEmail(ref('mail:2'))[0]?.thing_id).toBe(older);
    expect(store.listThings()).toEqual([expect.objectContaining({ thing_id: older, variables: expect.objectContaining({ order_id: 'B-7', return_id: 'R-9' }) })]);
  });

  it('hands a shared key on when the thing it named loses its last fact with it, and lives on', () => {
    writer.write(input('mail:1', { email: returnEmail('Order: A-1\nReturn: R-1\n') }));
    writer.write(input('mail:2', { email: returnEmail('Order: A-1\nReturn: R-2\n'), email_at: 2_000 }));
    const second = thingOf('mail:2');
    // The first return goes on with another email that names only its return id…
    writer.write(input('mail:3', { email: returnEmail('Return: R-1\n'), email_at: 3_000 }));
    // …and loses the email that tied it to the order: the order's key is the second's now.
    writer.removeEmails('work', ['mail:1']);
    writer.write(input('mail:4', { email: returnEmail('Order: A-1\n'), email_at: 4_000 }));
    expect(thingOf('mail:4')).toBe(second);
    expect(store.listThings()).toHaveLength(2);
  });

  it('keeps every key of a thing an email merged for the email’s later blocks', () => {
    store.saveCustomType({
      id: 'custom_link', name: 'Link', description: 'Linked references.', states: [], notices: [],
      variables: ['a', 'b', 'c'].map((name) => ({ name, kind: 'id' as const, required: false })),
      identity: [['a'], ['b'], ['c']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Linked notices', type: 'custom_link',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'notices@example.com' }], variables: [] },
        rules: ['a', 'b', 'c'].map((name) => ({
          target: { variable: name }, source: 'body' as const, find: { kind: 'after_label' as const, label: `${name.toUpperCase()}:` },
        })),
        repeat: { source: 'body', split: 'Item \\d+' },
        html: false, ai: { enabled: false },
      },
    });
    const send = (record_id: string, body_text: string): void => {
      clock += 1;
      writer.write(input(record_id, { email: email({ from_address: 'notices@example.com', subject: 'Notice', body_text }), email_at: clock }));
    };
    send('mail:10', 'Item 1\nA: ONE\n');
    send('mail:11', 'Item 1\nB: TWO\nC: THREE\n');
    expect(store.listThings()).toHaveLength(2);
    // The first block names both: they are one. The second names only the
    // key the merged thing brought, which the index no longer holds.
    send('mail:12', 'Item 1\nA: ONE\nB: TWO\nItem 2\nC: THREE\n');
    expect(store.listThings()).toEqual([
      expect.objectContaining({ identity_keys: expect.arrayContaining(['a=one', 'b=two', 'c=three']) }),
    ]);
  });

  it('keeps the keys of a thing the same email made and merged: no later block finds the one that went', () => {
    store.saveCustomType({
      id: 'custom_link', name: 'Link', description: 'Linked references.', states: [], notices: [],
      variables: ['a', 'b', 'c', 'd'].map((name) => ({ name, kind: 'id' as const, required: false })),
      identity: [['a'], ['b'], ['c'], ['d']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Linked notices', type: 'custom_link',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'notices@example.com' }], variables: [] },
        rules: ['a', 'b', 'c', 'd'].map((name) => ({
          target: { variable: name }, source: 'body' as const, find: { kind: 'after_label' as const, label: `${name.toUpperCase()}:` },
        })),
        repeat: { source: 'body', split: 'Item \\d+' },
        html: false, ai: { enabled: false },
      },
    });
    // Two things this email made, which its third block makes one before
    // either is stored. Each holds a key that block does not name, and a
    // later block names each of those on its own.
    writer.write(input('mail:13', {
      email: email({
        from_address: 'notices@example.com',
        body_text: 'Item 1\nA: ONE\nC: THREE\nItem 2\nB: TWO\nD: FOUR\nItem 3\nA: ONE\nB: TWO\nItem 4\nC: THREE\nItem 5\nD: FOUR\n',
      }),
    }));
    expect(store.listThings()).toEqual([
      expect.objectContaining({ identity_keys: expect.arrayContaining(['a=one', 'b=two', 'c=three', 'd=four']) }),
    ]);
  });

  it('finds a thing whose keys are each held by an older thing it disagrees with', () => {
    store.saveCustomType({
      id: 'custom_pair', name: 'Pair', description: 'Two references.', states: [], notices: [],
      variables: ['a', 'b'].map((name) => ({ name, kind: 'id' as const, required: false })),
      identity: [['a'], ['b']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Pair notices', type: 'custom_pair',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'notices@example.com' }], variables: [] },
        rules: ['a', 'b'].map((name) => ({
          target: { variable: name }, source: 'body' as const, find: { kind: 'after_label' as const, label: `${name}:` },
        })),
        html: false, ai: { enabled: false },
      },
    });
    const send = (record_id: string, a: string, b: string): string | null => {
      clock += 1;
      writer.write(input(record_id, {
        email: email({ from_address: 'notices@example.com', body_text: `a: ${a}\nb: ${b}\n` }), email_at: clock,
      }));
      return thingOf(record_id);
    };
    send('mail:20', 'X', 'ONE');
    send('mail:21', 'Y', 'TWO');
    // Its a is the first thing's, its b the second's, and it disagrees with each.
    const third = send('mail:22', 'X', 'TWO');
    expect(store.listThings()).toHaveLength(3);
    events.length = 0;
    // The same pair again: the third thing, not a fourth.
    expect(send('mail:23', 'X', 'TWO')).toBe(third);
    expect(store.listThings()).toHaveLength(3);
    expect(events.map((event) => [event.event_kind, event.record_id])).toEqual([['updated', third]]);
  });

  it('keeps apart blocks of one email that each disagree with another: (X, ONE), (X, TWO), (Y, ONE) are three things', () => {
    store.saveCustomType({
      id: 'custom_pair', name: 'Pair', description: 'Two references.', states: [], notices: [],
      variables: ['a', 'b'].map((name) => ({ name, kind: 'id' as const, required: false })),
      identity: [['a'], ['b']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Pair notices', type: 'custom_pair',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'notices@example.com' }], variables: [] },
        rules: ['a', 'b'].map((name) => ({
          target: { variable: name }, source: 'body' as const, find: { kind: 'after_label' as const, label: `${name}:` },
        })),
        repeat: { source: 'body', split: 'Item \\d+' },
        html: false, ai: { enabled: false },
      },
    });
    writer.write(input('mail:30', {
      email: email({ from_address: 'notices@example.com', body_text: 'Item 1\na: X\nb: ONE\nItem 2\na: X\nb: TWO\nItem 3\na: Y\nb: ONE\n' }),
    }));
    expect(store.listThings().map((thing) => [...thing.identity_keys].sort().join(' ')).sort()).toEqual([
      'a=x b=one', 'a=x b=two', 'a=y b=one',
    ]);
  });

  it('finds every thing of one email that holds a key: a later block fitting only the first joins it', () => {
    store.saveCustomType({
      id: 'custom_trio', name: 'Trio', description: 'Three references.', states: [], notices: [],
      variables: ['a', 'b', 'c'].map((name) => ({ name, kind: 'id' as const, required: false })),
      identity: [['a'], ['b'], ['c']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Trio notices', type: 'custom_trio',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'notices@example.com' }], variables: [] },
        rules: ['a', 'b', 'c'].map((name) => ({
          target: { variable: name }, source: 'body' as const, find: { kind: 'after_label' as const, label: `${name}:` },
        })),
        repeat: { source: 'body', split: 'Item \\d+' },
        html: false, ai: { enabled: false },
      },
    });
    // Two things hold X, told apart by b. The third block names X and a c
    // the second thing disagrees with: it is the first thing's.
    writer.write(input('mail:31', {
      email: email({ from_address: 'notices@example.com', body_text: 'Item 1\na: X\nb: ONE\nItem 2\na: X\nb: TWO\nc: K\nItem 3\na: X\nc: M\n' }),
    }));
    expect(store.listThings().map((thing) => [...thing.identity_keys].sort().join(' ')).sort()).toEqual([
      'a=x b=one c=m', 'a=x b=two c=k',
    ]);
  });

  it('tells a thing keyed by an enum by the value it declares: v1_2 and v12 are two releases', () => {
    store.saveCustomType({
      id: 'custom_release', name: 'Release', description: 'A software release.', states: [], notices: [],
      variables: [{ name: 'version', kind: 'enum' as const, required: true, values: ['v1_2', 'v12'] }],
      identity: [['version']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Releases', type: 'custom_release',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'releases@example.com' }], variables: ['version'] },
        rules: [{ target: { variable: 'version' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'Version:' } }],
        html: false, ai: { enabled: false },
      },
    });
    for (const version of ['v1_2', 'v12']) {
      clock += 1;
      writer.write(input(`mail:${version}`, {
        email: email({ from_address: 'releases@example.com', body_text: `Version: ${version}\n` }), email_at: clock,
      }));
    }
    expect(store.listThings().map((thing) => thing.variables.version).sort()).toEqual(['v12', 'v1_2']);
    expect(thingOf('mail:v1_2')).not.toBe(thingOf('mail:v12'));
  });

  it('tells two leads apart by their addresses: alex@acme.com and alex@acme.net are two', () => {
    store.createTemplate({
      definition: {
        name: 'Leads', type: 'lead',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'forms@site.example' }], variables: ['email'] },
        rules: [
          { target: { variable: 'source' }, source: 'body', find: { kind: 'constant', value: 'Contact form' } },
          { target: { variable: 'reference' }, source: 'body', find: { kind: 'constant', value: 'quote' } },
          { target: { variable: 'email' }, source: 'body', find: { kind: 'after_label', label: 'Email:' } },
        ],
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const lead = (address: string) => email({ from_address: 'forms@site.example', from_name: 'Site', subject: 'A lead', body_text: `Email: ${address}\n` });
    writer.write(input('mail:1', { email: lead('alex@acme.com') }));
    writer.write(input('mail:2', { email: lead('alex@acme.net'), email_at: 2_000 }));
    expect(store.listThings().map((thing) => thing.variables.email).sort()).toEqual(['alex@acme.com', 'alex@acme.net']);
    expect(events.map((event) => event.event_kind)).toEqual(['created', 'created']);
  });

  it('tells a thing keyed by an amount by its value: EUR 12.50 and EUR 12.5 are one gift card', () => {
    store.saveCustomType({
      id: 'custom_gift', name: 'Gift card', description: 'A gift card, told apart by its amount.', states: [], notices: [],
      variables: [{ name: 'amount', kind: 'money' as const, required: true }],
      identity: [['amount']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Gift cards', type: 'custom_gift',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'gifts@example.com' }], variables: ['amount'] },
        rules: [{ target: { variable: 'amount' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'Amount:' } }],
        html: false, ai: { enabled: false },
      },
    });
    for (const [record_id, amount] of [['mail:g1', 'EUR 12.50'], ['mail:g2', 'EUR 12.5'], ['mail:g3', 'EUR 12.05']] as const) {
      clock += 1;
      writer.write(input(record_id, { email: email({ from_address: 'gifts@example.com', body_text: `Amount: ${amount}\n` }), email_at: clock }));
    }
    expect(thingOf('mail:g2')).toBe(thingOf('mail:g1'));
    expect(thingOf('mail:g3')).not.toBe(thingOf('mail:g1'));
    expect(store.listThings()).toHaveLength(2);
  });

  it('reads no fact whose required number is too large to hold: nothing stored, nothing started', () => {
    store.saveCustomType({
      id: 'custom_meter', name: 'Meter', description: 'A meter reading.', states: [], notices: [],
      variables: [{ name: 'reading', kind: 'number' as const, required: true }],
      identity: [['reading']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Meter readings', type: 'custom_meter',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'meter@example.com' }], variables: ['reading'] },
        rules: [{ target: { variable: 'reading' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'Reading:' } }],
        html: false, ai: { enabled: false },
      },
    });
    const result = writer.write(input('mail:huge', {
      email: email({ from_address: 'meter@example.com', body_text: `Reading: ${'9'.repeat(400)}\n` }),
    }));
    expect(result).toMatchObject({ facts: 0, events: 0 });
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:huge' })).toEqual([]);
    expect(events).toEqual([]);
  });

  it('tells observations a fraction of a second apart as two, and reads none at an offset no zone has', () => {
    store.saveCustomType({
      id: 'custom_observation', name: 'Observation', description: 'An observation, by its time.', states: [], notices: [],
      variables: [{ name: 'observed_at', kind: 'datetime' as const, required: true }],
      identity: [['observed_at']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Observations', type: 'custom_observation',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'sensor@example.com' }], variables: ['observed_at'] },
        rules: [{ target: { variable: 'observed_at' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'At:' } }],
        html: false, ai: { enabled: false },
      },
    });
    const send = (record_id: string, at: string) => {
      clock += 1;
      return writer.write(input(record_id, { email: email({ from_address: 'sensor@example.com', body_text: `At: ${at}\n` }), email_at: clock }));
    };
    send('mail:o1', '2026-09-28T10:00:00.100Z');
    send('mail:o2', '2026-09-28T10:00:00.900Z');
    expect(store.listThings()).toHaveLength(2);
    // An offset no time zone has is no time: the entrance is not met.
    expect(send('mail:o3', '2026-09-28T10:00:00+99:99')).toMatchObject({ facts: 0, events: 0 });
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:o3' })).toEqual([]);
  });

  it('tells a thing keyed by a datetime by the instant it names: the zone\'s sign counts', () => {
    store.saveCustomType({
      id: 'custom_slot', name: 'Slot', description: 'A booked time.', states: [], notices: [],
      variables: [{ name: 'start', kind: 'datetime' as const, required: false }],
      identity: [['start']],
    });
    store.createTemplate({
      origin: { kind: 'owner' },
      definition: {
        name: 'Slot notices', type: 'custom_slot',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'slots@example.com' }], variables: [] },
        rules: [{ target: { variable: 'start' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'Start:' } }],
        html: false, ai: { enabled: false },
      },
    });
    const send = (record_id: string, start: string): string | null => {
      clock += 1;
      writer.write(input(record_id, {
        email: email({ from_address: 'slots@example.com', body_text: `Start: ${start}\n` }), email_at: clock,
      }));
      return thingOf(record_id);
    };
    const east = send('mail:40', '2026-09-27T10:00:00+01:00');
    // The same clock two hours later in the world: another booking.
    const west = send('mail:41', '2026-09-27T10:00:00-01:00');
    expect(west).not.toBe(east);
    // The first instant written in UTC: the first booking.
    expect(send('mail:42', '2026-09-27T09:00:00Z')).toBe(east);
    expect(store.listThings()).toHaveLength(2);
  });

  it('finds a thing by a key it shares with one that went', () => {
    writer.write(input('mail:1', { email: returnEmail('Order: A-1\nReturn: R-1\n') }));
    writer.write(input('mail:2', { email: returnEmail('Order: A-1\nReturn: R-2\n'), email_at: 2_000 }));
    const second = thingOf('mail:2');
    // The first return's email goes, and its thing with it: the order's key
    // names the second now.
    writer.removeEmails('work', ['mail:1']);
    writer.write(input('mail:3', { email: returnEmail('Order: A-1\n'), email_at: 3_000 }));
    expect(thingOf('mail:3')).toBe(second);
    expect(store.listThings()).toHaveLength(1);
  });
});

describe('an email’s date, fixed when it is first read (§5)', () => {
  it('a future-dated notice read again later keeps its date: it never moves past a newer delivery', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    // Dated far ahead: read at 1,000, it is dated 1,000.
    writer.write(input('mail:future', { email_at: mailFactEmailAt(1_000_000, 1_000) }));
    writer.write(input('mail:delivered', { email_at: 2_000, email: email({ subject: 'UPS Update: Delivered' }) }));
    expect(store.listThings()[0]!.variables.state).toBe('delivered');
    // The template is edited, and a backfill reads the notice again at 3,000.
    store.updateTemplate(template.template_id, { definition: upsTemplate({ name: 'UPS edited' }) });
    writer.write(input('mail:future', {
      email_at: mailFactEmailAt(1_000_000, 3_000), force: true, may_trigger: false, backfill_template: template.template_id,
    }));
    expect(store.factsForEmail(ref('mail:future'))[0]!.email_at).toBe(1_000);
    expect(store.listThings()[0]!.variables.state).toBe('delivered');
  });

  it('an email read before its date was kept takes the date its facts have', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:future', { email_at: 1_000 }));
    // The ledger as it was: no date.
    db.prepare('UPDATE mail_fact_email SET email_at = NULL').run();
    store.updateTemplate(template.template_id, { definition: upsTemplate({ name: 'UPS edited' }) });
    writer.write(input('mail:future', { email_at: 3_000, force: true, may_trigger: false, backfill_template: template.template_id }));
    expect(store.factsForEmail(ref('mail:future'))[0]!.email_at).toBe(1_000);
  });
});

describe('the standards pass switched on again (§7.1)', () => {
  const shipping: MailTemplateDefinition = {
    name: 'Shop shipping', type: 'shipment',
    entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: [] },
    rules: [{ target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: 'on the way', value: 'in_transit' }] } }],
    html: false, ai: { enabled: false },
  };
  const parcel = email({ from_address: 'ship@shop.example', subject: 'Your parcel is on the way', body_text: 'UPS: 1Z999AA10123456784' });
  const templateFact = (template_id: string) =>
    store.factsForEmail(ref('mail:1')).find((fact) => fact.template_id === template_id)!;

  it('a backfill reads anew what was read while it was off: the tracking number it finds joins the fact', () => {
    const template = store.createTemplate({ definition: shipping, origin: { kind: 'owner' } });
    store.setStandardsOn('shipment', false);
    writer.write(input('mail:1', { email: parcel, may_trigger: false }));
    expect(templateFact(template.template_id).variables.tracking_number).toBeNull();
    store.setStandardsOn('shipment', true);
    writer.write(input('mail:1', { email: parcel, may_trigger: false, force: true, backfill_template: template.template_id }));
    expect(templateFact(template.template_id).variables.tracking_number).toBe('1Z999AA10123456784');
  });

  it('switched off, it takes nothing back: a backfill keeps what it read', () => {
    const template = store.createTemplate({ definition: shipping, origin: { kind: 'owner' } });
    writer.write(input('mail:1', { email: parcel, may_trigger: false }));
    expect(templateFact(template.template_id).variables.tracking_number).toBe('1Z999AA10123456784');
    store.setStandardsOn('shipment', false);
    writer.write(input('mail:1', { email: parcel, may_trigger: false, force: true, backfill_template: template.template_id }));
    expect(templateFact(template.template_id).variables.tracking_number).toBe('1Z999AA10123456784');
  });

  describe('an edited template read again while the pass is off', () => {
    const orders: MailTemplateDefinition = {
      name: 'Orders', type: 'purchase',
      entrance: { conditions: [{ field: 'from', op: 'is', value: 'shop@example.com' }], variables: ['order_id'] },
      rules: [
        { target: { variable: 'merchant' }, source: 'body', find: { kind: 'constant', value: 'Shop' } },
        { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
      ],
      html: false, ai: { enabled: false },
    };
    // The total and the order's page only the markup says.
    const markup = {
      '@type': 'Order', merchant: { name: 'Shop' }, orderNumber: 'A-123', price: '10.00', priceCurrency: 'EUR',
      url: 'https://shop.example/orders/A-123',
    };
    const html = `<script type="application/ld+json">${JSON.stringify(markup)}</script>`;
    const order = email({
      from_address: 'shop@example.com', from_name: 'Shop', subject: 'Order confirmation', body_text: 'Order: A-123\nTotal: EUR 12.00\nReplaces: B-9\n', html,
    });
    let reread: ReturnType<MailFactWriter['write']> | undefined;
    const readAgain = (definition: MailTemplateDefinition, first: MailTemplateDefinition = orders) => {
      const template = store.createTemplate({ definition: first, origin: { kind: 'owner' } });
      writer.write(input('mail:1', { email: order, may_trigger: false }));
      expect(templateFact(template.template_id)).toMatchObject({ variables: expect.objectContaining({ total: { amount: '10.00', currency: 'EUR' } }), passes: expect.objectContaining({ total: 'standard' }) });
      store.setStandardsOn('purchase', false);
      store.updateTemplate(template.template_id, { definition });
      reread = writer.write(input('mail:1', { email: order, may_trigger: false, force: true, backfill_template: template.template_id }));
      return templateFact(template.template_id);
    };

    it('keeps what the pass read when it was on: renamed, the order keeps its total and its page, and nothing changed', () => {
      expect(readAgain({ ...orders, name: 'Orders, renamed' })).toMatchObject({
        variables: expect.objectContaining({ order_id: 'A-123', total: { amount: '10.00', currency: 'EUR' } }),
        passes: expect.objectContaining({ total: 'standard', 'data.url': 'standard' }),
        data: expect.objectContaining({ url: 'https://shop.example/orders/A-123' }),
        revision: 1,
      });
      expect(reread?.facts).toBe(0);
    });

    it('keeps only what the pass gave: a rule taken out takes its value with it', () => {
      expect(readAgain({ ...orders, rules: [orders.rules[1]!] })).toMatchObject({
        variables: expect.objectContaining({ merchant: null, order_id: 'A-123', total: { amount: '10.00', currency: 'EUR' } }),
      });
    });

    it('keeps the order the pass named when only it did: the fact keeps its key', () => {
      // Rules that read no order: the markup's number names it.
      const nameless: MailTemplateDefinition = { ...orders, entrance: { ...orders.entrance, variables: [] }, rules: [orders.rules[0]!] };
      const template = store.createTemplate({ definition: nameless, origin: { kind: 'owner' } });
      writer.write(input('mail:1', { email: order, may_trigger: false }));
      const before = templateFact(template.template_id);
      expect(before.identity_keys).not.toEqual([]);
      store.setStandardsOn('purchase', false);
      store.updateTemplate(template.template_id, { definition: { ...nameless, name: 'Orders, renamed' } });
      writer.write(input('mail:1', { email: order, may_trigger: false, force: true, backfill_template: template.template_id }));
      expect(templateFact(template.template_id)).toMatchObject({ identity_keys: before.identity_keys, variables: expect.objectContaining({ order_id: 'A-123' }) });
    });

    it('asks the AI nothing the pass read: the total it gave fills the slot', () => {
      const asking: MailTemplateDefinition = { ...orders, ai: { enabled: true, prompt: 'x', slots: ['total'], pool: 'free_only' } };
      expect(readAgain({ ...asking, name: 'Orders, renamed' }, asking)).toMatchObject({
        variables: expect.objectContaining({ total: { amount: '10.00', currency: 'EUR' } }),
        thing_id: expect.any(String),
      });
      expect(store.aiJobsForEmail(ref('mail:1'))).toEqual([]);
    });

    it('switched on, the pass reads what it reads now: read again without its markup, the order has no total', () => {
      const template = store.createTemplate({ definition: orders, origin: { kind: 'owner' } });
      writer.write(input('mail:1', { email: order, may_trigger: false }));
      writer.write(input('mail:1', { email: { ...order, html: null }, content_fingerprint: 'without-markup', may_trigger: false }));
      expect(templateFact(template.template_id)).toMatchObject({ variables: expect.objectContaining({ order_id: 'A-123', total: null }) });
    });

    it('keeps nothing when the rules now name another order: what the pass read was the first one’s', () => {
      expect(readAgain({
        ...orders,
        rules: [orders.rules[0]!, { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Replaces:' } }],
      })).toMatchObject({ variables: expect.objectContaining({ order_id: 'B-9', total: null }) });
    });

    it('keeps nothing when the rules name another order though they read no merchant: another order is another fact', () => {
      // The merchant only the markup says: the rules alone name no whole identity.
      const orderOnly: MailTemplateDefinition = { ...orders, rules: [orders.rules[1]!] };
      const template = store.createTemplate({ definition: orderOnly, origin: { kind: 'owner' } });
      writer.write(input('mail:1', { email: order, may_trigger: false }));
      const before = templateFact(template.template_id);
      expect(before).toMatchObject({ variables: expect.objectContaining({ merchant: 'Shop', order_id: 'A-123' }) });
      store.setStandardsOn('purchase', false);
      store.updateTemplate(template.template_id, {
        definition: { ...orderOnly, rules: [{ target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Replaces:' } }] },
      });
      events.length = 0;
      writer.write(input('mail:1', { email: order, may_trigger: true, force: true, origin: 'backfill', backfill_template: template.template_id }));
      const after = templateFact(template.template_id);
      expect(after).toMatchObject({ variables: expect.objectContaining({ order_id: 'B-9', total: null }) });
      expect(after.fact_id).not.toBe(before.fact_id);
      expect(after.data).not.toMatchObject({ url: expect.anything() });
      expect(JSON.stringify(events)).not.toContain('10.00');
    });

    it('the owner’s rule still wins: a rule that reads the total now reads it', () => {
      expect(readAgain({
        ...orders,
        rules: [...orders.rules, { target: { variable: 'total' }, source: 'body', find: { kind: 'after_label', label: 'Total:' } }],
      })).toMatchObject({
        variables: expect.objectContaining({ total: { amount: '12.00', currency: 'EUR' } }),
        passes: expect.objectContaining({ total: 'rule' }),
      });
    });
  });
});

describe('what is skipped or chosen (§4.1, §9)', () => {
  it('skips a security notice, best effort', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    const result = writer.write(input('mail:1', { email: email({ subject: 'Your UPS verification code' }) }));
    expect(result).toEqual({ skipped: 'security_notice', facts: 0, events: 0 });
    expect(store.listFacts()).toEqual([]);
  });

  it('lets the most specific template that meets its entrance win, per type', () => {
    const domain = store.createTemplate({ definition: upsTemplate({ name: 'domain' }), origin: { kind: 'owner' } });
    const address = store.createTemplate({
      definition: upsTemplate({
        name: 'address',
        entrance: {
          conditions: [{ field: 'from', op: 'is', value: 'pkginfo@ups.com' }],
          variables: ['tracking_number'],
        },
      }),
      origin: { kind: 'owner' },
    });
    writer.write(input('mail:1'));
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:1' }).map((f) => f.template_id)).toEqual([
      address.template_id,
    ]);
    // When the address template does not enter, the domain one gets its turn.
    writer.write(input('mail:2', { email: email({ from_address: 'mcinfo@ups.com' }) }));
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:2' })[0]?.template_id).toBe(domain.template_id);
  });

  it('counts health only on a first reading', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    writer.write(input('mail:2', { email: email({ body_text: 'no tracking here' }), count_health: false }));
    expect(store.getTemplate(template.template_id)?.health).toMatchObject({ matched: 1, entered: 1, not_entered: 0 });
  });
});

describe('repeated blocks and facts without identity', () => {
  it('makes one thing per parcel', () => {
    store.createTemplate({
      definition: upsTemplate({ repeat: { source: 'body', split: 'Parcel \\d+' } }),
      origin: { kind: 'owner' },
    });
    const body = 'Parcel 1\nTracking Number: 1Z01\nParcel 2\nTracking Number: 1Z02\n';
    writer.write(input('mail:1', { email: email({ body_text: body }) }));
    expect(events.map((e) => e.event_kind)).toEqual(['created', 'created']);
    expect(new Set(events.map((e) => e.record_id)).size).toBe(2);
  });
});

describe('deleting an email (rulings 11, 29)', () => {
  it('removes its facts and re-folds the thing silently; a thing with no facts left goes', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    writer.write(input('mail:2', { email: email({ subject: 'UPS Update: Delivered' }), email_at: 2_000 }));
    const before = events.length;
    writer.removeEmails('work', ['mail:2']);
    expect(events.length).toBe(before); // silent
    expect(store.listThings()[0]?.variables.state).toBe('in_transit');
    writer.removeEmails('work', ['mail:1']);
    expect(store.listThings()).toEqual([]);
  });

  it('keeps a moved email’s facts under its new id', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    writer.rekeyEmail('work', 'mail:1', 'mail:9');
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:9' })).toHaveLength(1);
  });

  it('keeps one copy when the sync read the moved email under its new id first, runs and all', () => {
    const template = store.createTemplate({
      definition: upsTemplate({ ai: { enabled: true, prompt: 'x', slots: ['data.note'], pool: 'free_only' } }),
      origin: { kind: 'owner' },
    });
    writer.write(input('mail:1', { email: email({ body_text: 'Tracking Number: 1Z0000000000000001\n' }) }));
    const thing = store.factsForEmail(ref('mail:1'))[0]!.thing_id;
    store.recordRun({ email: ref('mail:1'), thing_id: thing ?? 'mthing_x', trigger_id: 't-1', recipe_id: 'r-1', outcome: 'completed', at: 1 });
    // The moved copy lands first; both ids wait on the same template's AI.
    writer.write(input('mail:9', { email: email({ body_text: 'Tracking Number: 1Z0000000000000001\n' }), may_trigger: false }));
    expect(store.aiJobsForEmail(ref('mail:1')).map((job) => job.template_id)).toEqual([template.template_id]);
    expect(() => writer.rekeyEmail('work', 'mail:1', 'mail:9')).not.toThrow();
    expect(store.factsForEmail(ref('mail:1'))).toEqual([]);
    expect(store.factsForEmail(ref('mail:9'))).toHaveLength(1);
    expect(store.aiJobsForEmail(ref('mail:1'))).toEqual([]);
    expect(store.aiJobsForEmail(ref('mail:9'))).toHaveLength(1);
    expect(store.runsForEmail(ref('mail:9'))).toHaveLength(1);
    expect(store.getEmailLedger(ref('mail:1'))).toBeNull();
  });
});

describe('delivery', () => {
  it('never loses the facts when an event cannot be emitted', () => {
    const failing = createMailFactWriter({
      store,
      emit: () => {
        throw new Error('bus down');
      },
      now: () => clock,
    });
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    expect(failing.write(input('mail:1')).facts).toBe(1);
    expect(store.listFacts()).toHaveLength(1);
  });
});

describe('the boot sweep: a fact follows its email when a hook failed (§5.3)', () => {
  const work = (holding: readonly string[]) => ({ slug: 'work', get: (id: string) => (holding.includes(id) ? {} : null) });

  it('drops what an email a live mailbox no longer holds left behind, silently, and keeps the rest', async () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    writer.write(input('mail:2', { email: email({ body_text: 'Tracking Number: 1Z0000000000000002\n' }) }));
    // Read, and gave no fact: its ledger row is all that names it.
    writer.write(input('mail:3', { email: email({ from_address: 'news@club.example' }) }));
    // A run whose email's facts a re-read already dropped.
    store.recordRun({ email: { slug: 'work', record_id: 'mail:4' }, thing_id: 'mthing_x', trigger_id: 't', recipe_id: 'r', outcome: 'completed', at: 1 });
    // Another mailbox that is not live is not looked at.
    writer.write(input('mail:1', { ref: { slug: 'home', record_id: 'mail:1' } }));
    const thingOf1 = store.factsForEmail({ slug: 'work', record_id: 'mail:1' })[0]!.thing_id!;
    events.length = 0;

    await sweepGoneEmails(writer, [work(['mail:2'])]);

    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:1' })).toEqual([]);
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:2' })).toHaveLength(1);
    expect(store.getEmailLedger({ slug: 'work', record_id: 'mail:3' })).toBeNull();
    expect(store.runsForEmail({ slug: 'work', record_id: 'mail:4' })).toEqual([]);
    expect(store.getThing(thingOf1)).not.toBeNull(); // the home mailbox's fact still holds it
    expect(store.factsForEmail({ slug: 'home', record_id: 'mail:1' })).toHaveLength(1);
    expect(store.emailIdsOf('work', null, 10)).toEqual(['mail:2']);
    expect(events).toEqual([]);
  });

  it('pages through a mailbox of any size', async () => {
    const count = MAIL_FACT_SWEEP_PAGE + 7;
    for (let i = 0; i < count; i += 1) store.markEmailNews({ slug: 'work', record_id: `m-${String(i).padStart(4, '0')}` });
    expect(store.emailIdsOf('work', null, 3)).toEqual(['m-0000', 'm-0001', 'm-0002']);
    expect(store.emailIdsOf('work', 'm-0001', 2)).toEqual(['m-0002', 'm-0003']);
    await sweepGoneEmails(writer, [work(['m-0005'])]);
    expect(store.emailIdsOf('work', null, count)).toEqual(['m-0005']);
  });

  it('goes on to the next mailbox when one fails', async () => {
    store.markEmailNews({ slug: 'work', record_id: 'kept' });
    store.markEmailNews({ slug: 'home', record_id: 'gone' });
    const warnings: string[] = [];
    await sweepGoneEmails(
      writer,
      [{ slug: 'work', get: () => { throw new Error('closed'); } }, { slug: 'home', get: () => null }],
      { warn: (message) => warnings.push(message) },
    );
    expect(warnings).toEqual(['mail fact: the sweep of a mailbox stopped']);
    expect(store.emailIdsOf('work', null, 10)).toEqual(['kept']);
    expect(store.emailIdsOf('home', null, 10)).toEqual([]);
  });
});

describe('the same email found again under another id is not news (§5, ruling 13)', () => {
  const envelope = (rfc_message_id: string | null) => ({
    slug: 'work', account_email: 'me@example.com', to: ['me@example.com'], cc: [],
    sent_by_account: false, rfc_message_id, thread_id: 't-1',
  });

  it('stores the copy’s facts silently: its first reading carried the news', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { envelope: envelope('abc@ups.example') }));
    expect(events).toHaveLength(1);
    // An IMAP mailbox whose ids were reset: the same message, a new id — and
    // news as far as the mailbox can tell.
    // A later time: were it news, `last_email_at` would move and announce it.
    const result = writer.write(input('7@INBOX', { envelope: envelope('abc@ups.example'), content_fingerprint: 'other', email_at: 2_000 }));
    expect(result.events).toBe(0);
    expect(events).toHaveLength(1);
    expect(store.factsForEmail({ slug: 'work', record_id: '7@INBOX' })).toHaveLength(1);
    expect(store.getEmailLedger({ slug: 'work', record_id: '7@INBOX' })).toMatchObject({ news: false });
    // Dated as its original: the same email.
    expect(store.factsForEmail({ slug: 'work', record_id: '7@INBOX' })[0]?.email_at).toBe(1_000);
  });

  it('keeps its original’s place among mail of its date: a copy of the transit notice leaves the parcel delivered', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { envelope: envelope('transit@ups.example') }));
    writer.write(input('2@INBOX', { envelope: envelope('delivered@ups.example'), email: email({ subject: 'UPS Update: Delivered' }) }));
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
    // The transit notice found again under another id, read after the delivery.
    writer.write(input('9@INBOX', { envelope: envelope('transit@ups.example') }));
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
    expect(store.getEmailLedger({ slug: 'work', record_id: '9@INBOX' })?.arrival)
      .toBe(store.getEmailLedger({ slug: 'work', record_id: '1@INBOX' })?.arrival);
    // Moved there after all: still delivered.
    writer.rekeyEmail('work', '1@INBOX', '9@INBOX');
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
    expect(events).toHaveLength(2);
  });

  it('a move onto an id read first as its own email keeps the earlier place among mail of its date', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { envelope: envelope('transit@ups.example') }));
    writer.write(input('2@INBOX', { envelope: envelope('delivered@ups.example'), email: email({ subject: 'UPS Update: Delivered' }) }));
    // Found in another folder before the move was heard of: no copy there,
    // an email of its own, read after the delivery.
    writer.write(input('5@Archive', { envelope: envelope('transit@ups.example'), email: email({ labels: ['Archive'] }), may_trigger: false }));
    expect(store.listThings()[0]?.variables.state).toBe('in_transit');
    // The move says it is the transit notice, read before the delivery.
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
  });

  it('a move onto an id read first keeps the email’s date too: a future-dated transit notice stays older than the delivery', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    // Dated ahead, read first: dated when it was read.
    clock = 1_000;
    writer.write(input('1@INBOX', { envelope: envelope('transit@ups.example'), email_at: mailFactEmailAt(9_000, clock) }));
    clock = 2_000;
    writer.write(input('2@INBOX', { envelope: envelope('delivered@ups.example'), email: email({ subject: 'UPS Update: Delivered' }), email_at: 2_000 }));
    // Found in another folder later — no copy there — and dated as read then.
    clock = 3_000;
    writer.write(input('5@Archive', {
      envelope: envelope('transit@ups.example'), email: email({ labels: ['Archive'] }), email_at: mailFactEmailAt(9_000, clock), may_trigger: false,
    }));
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
    expect(store.factRecordsForEmail({ slug: 'work', record_id: '5@Archive' })[0]?.email_at).toBe(1_000);
    expect(store.getEmailLedger({ slug: 'work', record_id: '5@Archive' })?.email_at).toBe(1_000);
  });

  it('a move from an id read before the template existed dates the new id’s facts by that first reading, and folds the thing again', () => {
    // No carrier's number: only the template reads these.
    const body_text = 'Tracking Number: TRACK-A\n';
    // Read before any template: its date and place are kept, and no facts.
    clock = 1_000;
    writer.write(input('1@INBOX', { envelope: envelope('transit@ups.example'), email: email({ body_text }), email_at: mailFactEmailAt(9_000, clock) }));
    expect(store.factsForEmail({ slug: 'work', record_id: '1@INBOX' })).toEqual([]);
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    clock = 2_000;
    writer.write(input('2@INBOX', { envelope: envelope('delivered@ups.example'), email: email({ subject: 'UPS Update: Delivered', body_text }), email_at: 2_000 }));
    clock = 3_000;
    writer.write(input('5@Archive', {
      envelope: envelope('transit@ups.example'), email: email({ labels: ['Archive'], body_text }), email_at: mailFactEmailAt(9_000, clock), may_trigger: false,
    }));
    expect(store.listThings()[0]?.variables.state).toBe('in_transit');
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.factRecordsForEmail({ slug: 'work', record_id: '5@Archive' })[0]?.email_at).toBe(1_000);
    expect(store.listThings()[0]?.variables.state).toBe('delivered');
  });

  it('a move onto the copy the sync read first keeps what the email told: a backfill tells nothing again', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { envelope: envelope('abc@ups.example') }));
    writer.write(input('7@INBOX', { envelope: envelope('abc@ups.example') }));
    expect(events).toHaveLength(1);
    writer.rekeyEmail('work', '1@INBOX', '7@INBOX');
    expect(store.factRecordsForEmail({ slug: 'work', record_id: '7@INBOX' })).toEqual([expect.objectContaining({ announced: true })]);
    const again = writer.write(input('7@INBOX', {
      envelope: envelope('abc@ups.example'), force: true, origin: 'backfill', backfill_template: template.template_id,
    }));
    expect(again.events).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('a move while the new id’s attachments download tells nothing again: its mark was the old news', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { envelope: envelope('abc@ups.example') }));
    // The sync saw the moved message under its new id and marked it: the
    // upsert that reads it comes after its attachments.
    writer.markNews({ slug: 'work', record_id: '7@INBOX' });
    writer.rekeyEmail('work', '1@INBOX', '7@INBOX');
    expect(writer.write(input('7@INBOX', { envelope: envelope('abc@ups.example') })).events).toBe(0);
    expect(events).toHaveLength(1);
    expect(store.factsForEmail({ slug: 'work', record_id: '7@INBOX' })).toHaveLength(1);
  });

  it('is news when the text differs, when there is no Message-ID, or when a backfill runs recipes', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { envelope: envelope('abc@ups.example') }));
    events.length = 0;
    // A sender that reuses a Message-ID for a new notice.
    writer.write(input('2@INBOX', {
      envelope: envelope('abc@ups.example'),
      email: email({ subject: 'UPS Update: Delivered' }),
    }));
    expect(events).toHaveLength(1);
    // No Message-ID: nothing says two emails are one.
    writer.write(input('3@INBOX', { envelope: envelope(null), email: email({ body_text: 'Tracking Number: 1Z0000000000000003\n' }) }));
    writer.write(input('4@INBOX', { envelope: envelope(null), email: email({ body_text: 'Tracking Number: 1Z0000000000000003\n' }), email_at: 2_000 }));
    expect(events).toHaveLength(3);
    // A backfill that runs recipes says what fires.
    events.length = 0;
    writer.write(input('9@INBOX', { envelope: envelope('abc@ups.example'), force: true, origin: 'backfill', email_at: 3_000 }));
    expect(events.length).toBeGreaterThan(0);
  });

  it('is news in another folder: each copy is its own sighting', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { envelope: envelope('abc@ups.example') }));
    events.length = 0;
    // A second folder holds it (a template may test that folder).
    writer.write(input('4@Receipts', { envelope: envelope('abc@ups.example'), email: email({ labels: ['Receipts'] }), email_at: 2_000 }));
    expect(events).toHaveLength(1);
  });

  it('is news as the copy the account sent, in the same folder', () => {
    // Mail the account sent is read by a template that names a label.
    store.createTemplate({
      definition: upsTemplate({
        entrance: {
          conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }, { field: 'label', op: 'is', value: 'INBOX' }],
          variables: ['tracking_number'],
        },
      }),
      origin: { kind: 'owner' },
    });
    writer.write(input('1@INBOX', { envelope: envelope('abc@ups.example') }));
    events.length = 0;
    writer.write(input('5@INBOX', { envelope: { ...envelope('abc@ups.example'), sent_by_account: true }, email_at: 3_000 }));
    expect(events).toHaveLength(1);
  });

  it('keeps news a copy of an email in another mailbox would have', () => {
    store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { envelope: envelope('abc@ups.example') }));
    events.length = 0;
    writer.write(input('5@INBOX', { ref: { slug: 'home', record_id: '5@INBOX' }, envelope: { ...envelope('abc@ups.example'), slug: 'home' }, email_at: 2_000 }));
    expect(events).toHaveLength(1);
  });
});

describe('a move keeps what the new id’s reading did not read (§4.3, §5)', () => {
  // No carrier's number: only the template reads these.
  const body_text = 'Tracking Number: TRACK-A\n';

  it('a move onto an id the sync read with the template switched off keeps its fact and its thing', () => {
    const changes: string[] = [];
    writer = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => clock, onChanged: (what) => changes.push(what) });
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { email: email({ body_text }) }));
    const [fact] = store.factsForEmail(ref('1@INBOX'));
    expect(fact?.thing_id).toEqual(expect.any(String));
    store.updateTemplate(template.template_id, { active: false });
    // Read under its new id with the template off: no fact of it there.
    writer.write(input('5@Archive', { email: email({ body_text, labels: ['Archive'] }), may_trigger: false }));
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([]);
    changes.length = 0;
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    // The screens hear of it: the fact is on another email.
    expect(changes).toContain('facts');
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([
      expect.objectContaining({ fact_id: fact!.fact_id, template_id: template.template_id, thing_id: fact!.thing_id }),
    ]);
    expect(store.factsForEmail(ref('1@INBOX'))).toEqual([]);
    expect(store.listThings().map((thing) => thing.thing_id)).toEqual([fact!.thing_id]);
    expect(store.factsForThing(fact!.thing_id!).map((one) => one.email.record_id)).toEqual(['5@Archive']);
    expect(events).toHaveLength(1);
  });

  it('keeps one fact when the kept one took the pass’s reading in: the new id’s copy of that reading goes', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    // A carrier's number: the standards pass reads it too, and the template's fact takes it in.
    const parcel = email({ body_text: 'Tracking Number: 1Z999AA10123456784\n' });
    writer.write(input('1@INBOX', { email: parcel }));
    const [fact] = store.factsForEmail(ref('1@INBOX'));
    expect(fact).toMatchObject({ template_id: template.template_id });
    store.updateTemplate(template.template_id, { active: false });
    // The template off, the pass alone read it under the new id — the newest
    // reading of the parcel, which its thing shows.
    writer.write(input('5@Archive', { email: { ...parcel, labels: ['Archive'] }, may_trigger: false }));
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([expect.objectContaining({ template_id: null })]);
    expect(store.listThings()[0]?.passes.tracking_number).toBe('standard');
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    // As a reading of one id leaves it: the template's fact alone, and its
    // thing folded again from it.
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([expect.objectContaining({ fact_id: fact!.fact_id })]);
    expect(store.listThings()).toEqual([expect.objectContaining({ passes: expect.objectContaining({ tracking_number: 'rule' }) })]);
    expect(events).toHaveLength(1);
  });

  it('a pass’s fact of a kind switched off stays beside the template’s fact the new id read: two parcels, two things', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    // The template reads one parcel; the pass reads a carrier's number for another.
    const two = email({ body_text: 'Tracking Number: TRACK-A\nAlso on its way: 1Z999AA10123456784\n' });
    writer.write(input('1@INBOX', { email: two }));
    const standards = store.factsForEmail(ref('1@INBOX')).find((fact) => fact.template_id === null);
    expect(standards).toBeDefined();
    store.setStandardsOn('shipment', false);
    writer.write(input('5@Archive', { email: { ...two, labels: ['Archive'] }, may_trigger: false }));
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    const after = store.factsForEmail(ref('5@Archive'));
    expect(after).toHaveLength(2);
    expect(after).toEqual(expect.arrayContaining([
      expect.objectContaining({ template_id: template.template_id }),
      expect.objectContaining({ fact_id: standards!.fact_id }),
    ]));
    expect(store.listThings()).toHaveLength(2);
  });

  it('what a template that is on did not read under the new id goes, as a reading of one id drops it', () => {
    // It reads the inbox only.
    store.createTemplate({
      definition: upsTemplate({
        entrance: {
          conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }, { field: 'label', op: 'is', value: 'INBOX' }],
          variables: ['tracking_number'],
        },
      }),
      origin: { kind: 'owner' },
    });
    writer.write(input('1@INBOX', { email: email({ body_text }) }));
    expect(store.listFacts()).toHaveLength(1);
    writer.write(input('5@Archive', { email: email({ body_text, labels: ['Archive'] }), may_trigger: false }));
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.listFacts()).toEqual([]);
    expect(store.listThings()).toEqual([]);
  });

  it('what the pass, on, did not read under the new id goes too', () => {
    const parcel = email({ from_address: 'ship@shop.example', from_name: 'Shop', subject: 'Your parcel', body_text: 'UPS: 1Z999AA10123456784' });
    writer.write(input('1@INBOX', { email: parcel }));
    expect(store.listFacts()).toHaveLength(1);
    // Read under its new id, the pass found no number there: the reading of the
    // email now, as a reading of one id would be.
    writer.write(input('5@Archive', { email: { ...parcel, body_text: 'Your parcel is on its way', labels: ['Archive'] }, may_trigger: false }));
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.listFacts()).toEqual([]);
  });

  it('a fact it keeps takes the email’s date where it is now: the new id’s, read first', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    store.updateTemplate(template.template_id, { active: false });
    // Dated ahead, read first under the id the move leads to, the template off.
    clock = 1_000;
    writer.write(input('5@Archive', { email: email({ body_text, labels: ['Archive'] }), email_at: mailFactEmailAt(9_000, clock), may_trigger: false }));
    store.updateTemplate(template.template_id, { active: true });
    clock = 2_000;
    writer.write(input('1@INBOX', { email: email({ body_text }), email_at: mailFactEmailAt(9_000, clock) }));
    store.updateTemplate(template.template_id, { active: false });
    expect(store.listThings()[0]?.last_email_at).toBe(2_000);
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.factRecordsForEmail(ref('5@Archive'))).toEqual([
      expect.objectContaining({ template_id: template.template_id, email_at: 1_000 }),
    ]);
    // Its thing is folded again by that date.
    expect(store.listThings()[0]?.last_email_at).toBe(1_000);
  });

  it('the pass’s copy it took in goes with the thing it started, when only the order number joined them', () => {
    const shop = store.createTemplate({
      definition: {
        name: 'Shop A', type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop-a.example' }], variables: ['order_id'] },
        rules: [
          { target: { variable: 'merchant' }, source: 'body', find: { kind: 'constant', value: 'Shop A' } },
          { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
        ],
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    // The shop's markup names it otherwise: the order number alone joins them.
    const markup = { '@context': 'https://schema.org', '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'A-Store Online' }, price: '10.00', priceCurrency: 'EUR' };
    const order = email({
      from_address: 'orders@shop-a.example', from_name: 'Shop A', subject: 'Your order', body_text: 'Order: ORD-1\n',
      html: `<script type="application/ld+json">${JSON.stringify(markup)}</script>`,
    });
    writer.write(input('1@INBOX', { email: order }));
    expect(store.factsForEmail(ref('1@INBOX'))).toEqual([expect.objectContaining({ template_id: shop.template_id })]);
    store.updateTemplate(shop.template_id, { active: false });
    writer.write(input('5@Archive', { email: { ...order, labels: ['Archive'] }, may_trigger: false }));
    // The markup alone, by the name it writes: a thing of its own.
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([expect.objectContaining({ template_id: null })]);
    expect(store.listThings()).toHaveLength(2);
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([expect.objectContaining({ template_id: shop.template_id })]);
    expect(store.listThings()).toHaveLength(1);
  });

  it('the pass’s copy it took in goes with the thing it started when the new id was read first', () => {
    const shop = store.createTemplate({
      definition: {
        name: 'Shop A', type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop-a.example' }], variables: ['order_id'] },
        rules: [
          { target: { variable: 'merchant' }, source: 'body', find: { kind: 'constant', value: 'Shop A' } },
          { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
        ],
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const markup = { '@context': 'https://schema.org', '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'A-Store Online' }, price: '10.00', priceCurrency: 'EUR' };
    const order = email({
      from_address: 'orders@shop-a.example', from_name: 'Shop A', subject: 'Your order', body_text: 'Order: ORD-1\n',
      html: `<script type="application/ld+json">${JSON.stringify(markup)}</script>`,
    });
    // Read first under the id the move leads to, the template off: the markup
    // alone, a thing by the name it writes.
    store.updateTemplate(shop.template_id, { active: false });
    writer.write(input('5@Archive', { email: { ...order, labels: ['Archive'] }, may_trigger: false }));
    store.updateTemplate(shop.template_id, { active: true });
    writer.write(input('1@INBOX', { email: order }));
    expect(store.listThings()).toHaveLength(2);
    store.updateTemplate(shop.template_id, { active: false });
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([expect.objectContaining({ template_id: shop.template_id })]);
    expect(store.listThings()).toHaveLength(1);
  });

  it('the pass’s copy a waiting fact took in goes with the thing it started alone', () => {
    const template = store.createTemplate({
      definition: upsTemplate({ ai: { enabled: true, prompt: 'x', slots: ['data.note'], pool: 'free_only' } }),
      origin: { kind: 'owner' },
    });
    // A carrier's number, which the waiting fact took in: it joins no thing yet.
    const parcel = email({ body_text: 'Tracking Number: 1Z999AA10123456784\n' });
    writer.write(input('1@INBOX', { email: parcel }));
    expect(store.factRecordsForEmail(ref('1@INBOX'))).toEqual([expect.objectContaining({ thing_id: null, ai: expect.objectContaining({ state: 'waiting' }) })]);
    store.updateTemplate(template.template_id, { active: false });
    // The pass alone under the new id: the parcel's only thing.
    writer.write(input('5@Archive', { email: { ...parcel, labels: ['Archive'] }, may_trigger: false }));
    expect(store.listThings()).toHaveLength(1);
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    // As a reading of one id leaves it: the waiting fact alone, and no thing
    // until its call settles it.
    expect(store.factRecordsForEmail(ref('5@Archive'))).toEqual([expect.objectContaining({ template_id: template.template_id, thing_id: null })]);
    expect(store.listThings()).toEqual([]);
  });

  it('a move onto an id read while the template was on keeps that reading: one fact, not two', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { email: email({ body_text }) }));
    writer.write(input('5@Archive', { email: email({ body_text, labels: ['Archive'] }), may_trigger: false }));
    const [read] = store.factsForEmail(ref('5@Archive'));
    store.updateTemplate(template.template_id, { active: false });
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([expect.objectContaining({ fact_id: read!.fact_id })]);
  });

  it('keeps a fact of a standards kind switched off since, as a reading of one id does', () => {
    // No template: the pass alone reads the carrier's number.
    const parcel = email({ from_address: 'ship@shop.example', from_name: 'Shop', subject: 'Your parcel', body_text: 'UPS: 1Z999AA10123456784' });
    writer.write(input('1@INBOX', { email: parcel }));
    const [fact] = store.factsForEmail(ref('1@INBOX'));
    expect(fact).toMatchObject({ template_id: null, type: 'shipment' });
    store.setStandardsOn('shipment', false);
    writer.write(input('5@Archive', { email: { ...parcel, labels: ['Archive'] }, may_trigger: false }));
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([]);
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([expect.objectContaining({ fact_id: fact!.fact_id })]);
    expect(store.listThings()).toHaveLength(1);
  });

  it('a fact waiting on the AI when its template was switched off moves with its call, which then places it', () => {
    const template = store.createTemplate({
      definition: upsTemplate({ ai: { enabled: true, prompt: 'x', slots: ['data.note'], pool: 'free_only' } }),
      origin: { kind: 'owner' },
    });
    writer.write(input('1@INBOX', { email: email({ body_text }) }));
    const [fact] = store.factRecordsForEmail(ref('1@INBOX'));
    expect(fact?.ai?.state).toBe('waiting');
    store.updateTemplate(template.template_id, { active: false });
    writer.write(input('5@Archive', { email: email({ body_text, labels: ['Archive'] }), may_trigger: false }));
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    const [job] = store.aiJobsForEmail(ref('5@Archive'));
    expect(job).toMatchObject({ template_id: template.template_id });
    // Its call runs: switched off, the fact settles on what the rules read, and is placed.
    writer.applyAi(job!, [{
      fact_id: fact!.fact_id,
      reading: { variables: fact!.variables, passes: fact!.passes, data: { note: 'at the door' }, refused: [], missing: [], complete: true },
      ai: { state: 'read', filled: ['data.note'], at: clock },
    }]);
    expect(store.factsForEmail(ref('5@Archive'))).toEqual([
      expect.objectContaining({ fact_id: fact!.fact_id, thing_id: expect.any(String), ai: expect.objectContaining({ state: 'not_read' }) }),
    ]);
  });

  it('keeps nothing when the new id’s reading was a security notice, as a reading of one id keeps nothing', () => {
    const template = store.createTemplate({ definition: upsTemplate(), origin: { kind: 'owner' } });
    writer.write(input('1@INBOX', { email: email({ body_text }) }));
    store.updateTemplate(template.template_id, { active: false });
    // Read as a security notice under its new id (the check changed since).
    writer.write(input('5@Archive', { email: email({ body_text, subject: 'Your UPS verification code', labels: ['Archive'] }), may_trigger: false }));
    expect(store.getEmailLedger(ref('5@Archive'))?.skipped).toBe('security_notice');
    writer.rekeyEmail('work', '1@INBOX', '5@Archive');
    expect(store.listFacts()).toEqual([]);
    expect(store.listThings()).toEqual([]);
  });
});

describe('a final round: what a reading lets past (§5, §9)', () => {
  it('lets no card number into a fact through a number its separators hid, nor into its key or an event', () => {
    store.saveCustomType({
      id: 'custom_ticket', name: 'Ticket', description: 'A ticket.', states: [], notices: [],
      variables: [{ name: 'ticket_no', kind: 'number', required: true }],
      identity: [['ticket_no']],
    });
    store.createTemplate({
      definition: {
        name: 'Tickets',
        type: 'custom_ticket',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'desk@tickets.example' }], variables: ['ticket_no'] },
        rules: [{ target: { variable: 'ticket_no' }, source: 'body', find: { kind: 'after_label', label: 'Ticket:' }, locale: 'en-US' }],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    writer.write(input('mail:1', { email: email({ from_address: 'desk@tickets.example', body_text: 'Ticket: 4,111,111,111,111,111\n' }) }));
    expect(store.listFacts()).toEqual([]);
    expect(events).toEqual([]);
    // The control: a ticket number no card is.
    writer.write(input('mail:2', { email: email({ from_address: 'desk@tickets.example', body_text: 'Ticket: 4,111,111,111,111,112\n' }) }));
    expect(store.listFacts().map((fact) => fact.variables.ticket_no)).toEqual([4111111111111112]);
    expect(events).toHaveLength(1);
  });

  it('meets no entrance with a malformed time: 10:000 is not ten o’clock', () => {
    store.saveCustomType({
      id: 'custom_visit', name: 'Visit', description: 'A visit.', states: [], notices: [],
      variables: [{ name: 'ref', kind: 'id', required: true }, { name: 'starts_at', kind: 'datetime', required: true }],
      identity: [['ref']],
    });
    store.createTemplate({
      definition: {
        name: 'Visits',
        type: 'custom_visit',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'desk@visits.example' }], variables: ['ref', 'starts_at'] },
        rules: [
          { target: { variable: 'ref' }, source: 'body', find: { kind: 'after_label', label: 'Ref:' } },
          { target: { variable: 'starts_at' }, source: 'body', find: { kind: 'after_label', label: 'When:' } },
        ],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const visit = (record_id: string, when: string) => writer.write(input(record_id, {
      email: email({ from_address: 'desk@visits.example', body_text: `Ref: V-1\nWhen: ${when}\n` }),
    }));
    visit('mail:1', 'September 28, 2026 10:000');
    expect(store.listFacts()).toEqual([]);
    expect(events).toEqual([]);
    visit('mail:2', 'September 28, 2026 10:00');
    expect(store.listFacts().map((fact) => fact.variables.starts_at)).toEqual(['2026-09-28T10:00:00']);
    expect(events).toHaveLength(1);
  });

  describe('a move after a template edit tells what it never told', () => {
    const orders: MailTemplateDefinition = {
      name: 'Shop orders',
      type: 'purchase',
      entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }], variables: ['order_id'] },
      rules: [
        { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'whole' } },
        { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
      ],
      html: false,
      ai: { enabled: false },
    };
    const byRef: MailTemplateDefinition = {
      ...orders,
      rules: [orders.rules[0]!, { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Ref:' } }],
    };
    const order = (over: Partial<MailFactWriteInput> = {}): Partial<MailFactWriteInput> => ({
      email: email({ from_address: 'orders@shop.example', from_name: 'Shop', subject: 'Your order', body_text: 'Order: A-123\nRef: B-9\n' }),
      content_fingerprint: 'the-order-email',
      ...over,
    });

    it('moved onto a copy read again silently, B-9 is not taken for A-123: a backfill with recipes tells it', () => {
      const template = store.createTemplate({ definition: orders, origin: { kind: 'owner' } });
      writer.write(input('mail:old', order()));
      expect(store.factRecordsForEmail({ slug: 'work', record_id: 'mail:old' }).map((fact) => [fact.variables.order_id, fact.announced]))
        .toEqual([['A-123', true]]);
      // The template now reads the reference: the sync reads the moved copy with it, silently.
      store.updateTemplate(template.template_id, { definition: byRef });
      writer.write(input('mail:new', order({ may_trigger: false })));
      writer.rekeyEmail('work', 'mail:old', 'mail:new');
      expect(store.factRecordsForEmail({ slug: 'work', record_id: 'mail:new' }).map((fact) => [fact.variables.order_id, fact.announced]))
        .toEqual([['B-9', false]]);
      events.length = 0;
      writer.write(input('mail:new', order({ force: true, backfill_template: template.template_id, origin: 'backfill' })));
      expect(events.map((event) => (event.record as { order_id?: unknown } | undefined)?.order_id)).toEqual(['B-9']);
    });

    it('the control: read again where it is, B-9 is told once', () => {
      const template = store.createTemplate({ definition: orders, origin: { kind: 'owner' } });
      writer.write(input('mail:old', order()));
      store.updateTemplate(template.template_id, { definition: byRef });
      events.length = 0;
      writer.write(input('mail:old', order({ force: true, backfill_template: template.template_id, origin: 'backfill' })));
      expect(events.map((event) => (event.record as { order_id?: unknown } | undefined)?.order_id)).toEqual(['B-9']);
    });
  });
});

describe('a label read as the rules read it (§4.1, §9)', () => {
  // The template's facts: the markup's reading of the tracking number is there whatever the labels.
  const read = () => store.listFacts().filter((fact) => fact.template_id !== null);
  const watched = (value: string): MailTemplateDefinition => upsTemplate({
    entrance: {
      conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }, { field: 'label', op: 'is', value }],
      variables: ['tracking_number'],
    },
  });

  it('notices a label the rules read, written in fullwidth, come and go', () => {
    store.createTemplate({ definition: watched('watch'), origin: { kind: 'owner' } });
    writer.write(input('mail:1', { email: email({ labels: ['INBOX'] }) }));
    expect(read()).toEqual([]);
    // It comes on, written in fullwidth: the rules read it as watch.
    expect(writer.write(input('mail:1', { email: email({ labels: ['INBOX', '\uFF57\uFF41\uFF54\uFF43\uFF48'] }) })).skipped).toBeUndefined();
    expect(read()).toHaveLength(1);
    // And it goes: so does its fact.
    expect(writer.write(input('mail:1', { email: email({ labels: ['INBOX'] }) })).skipped).toBeUndefined();
    expect(read()).toEqual([]);
  });

  it('notices a label come and go that a condition written in fullwidth tests', () => {
    store.createTemplate({ definition: watched('\uFF57\uFF41\uFF54\uFF43\uFF48'), origin: { kind: 'owner' } });
    writer.write(input('mail:1', { email: email({ labels: ['INBOX'] }) }));
    expect(writer.write(input('mail:1', { email: email({ labels: ['INBOX', 'watch'] }) })).skipped).toBeUndefined();
    expect(read()).toHaveLength(1);
    expect(writer.write(input('mail:1', { email: email({ labels: ['INBOX'] }) })).skipped).toBeUndefined();
    expect(read()).toEqual([]);
  });

  it('reads a relationship as a label: written in fullwidth, on the email or in the condition', () => {
    const related = (value: string): MailTemplateDefinition => upsTemplate({
      entrance: {
        conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }, { field: 'relationship', op: 'is', value }],
        variables: ['tracking_number'],
      },
    });
    const work = '\uFF57\uFF4F\uFF52\uFF4B';
    const template = store.createTemplate({ definition: related('work'), origin: { kind: 'owner' } });
    writer.write(input('mail:1', { email: email({ relationships: [work] }) }));
    expect(read()).toHaveLength(1);
    expect(writer.write(input('mail:1', { email: email({ relationships: [] }) })).skipped).toBeUndefined();
    expect(read()).toEqual([]);
    // A condition stored with it written so.
    store.updateTemplate(template.template_id, { definition: related(work) });
    writer.write(input('mail:2', { email: email({ relationships: [] }) }));
    expect(writer.write(input('mail:2', { email: email({ relationships: ['work'] }) })).skipped).toBeUndefined();
    expect(read().map((fact) => fact.email.record_id)).toEqual(['mail:2']);
  });

  it('the control: an unchanged email with its labels as they were is skipped', () => {
    store.createTemplate({ definition: watched('watch'), origin: { kind: 'owner' } });
    writer.write(input('mail:1', { email: email({ labels: ['INBOX', 'watch'] }) }));
    expect(writer.write(input('mail:1', { email: email({ labels: ['INBOX', 'watch', 'other'] }) })).skipped).toBe('unchanged');
    expect(read()).toHaveLength(1);
  });
});
