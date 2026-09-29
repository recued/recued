/** D-315 slice 2 — the standards pass in the writer (§4, §7.1, §7.4): its facts
 *  alone, paired with a template's, left unpaired, switched off, and owner
 *  requests from the envelope. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMailFactBuiltinType, type MailTemplateDefinition } from '@recued/contracts';
import type { WarehouseEvent } from '@recued/warehouse-events';

import { createMailFactWriter, type MailFactWriteInput, type MailFactWriter } from '../mail-facts/fact-writer.js';
import type { MailFactSourceEmail, RulesPassFact } from '../mail-facts/rules-pass.js';
import { combineFacts, combineFactsByPass } from '../mail-facts/standards-pass.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';

let dir: string;
let db: Database.Database;
let store: MailFactStore;
let writer: MailFactWriter;
let events: WarehouseEvent[];
let ids: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-merge-'));
  db = new Database(join(dir, 'test.db'));
  ids = 0;
  events = [];
  store = createMailFactStore(db, { now: () => 5_000, mintId: (prefix) => `${prefix}_${(ids += 1)}` });
  writer = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => 5_000 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const email = (over: Partial<MailFactSourceEmail> = {}): MailFactSourceEmail => ({
  subject: 'Your parcel is on the way',
  body_text: '',
  html: null,
  from_address: 'ship@shop.example',
  from_name: 'Shop',
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
  content_fingerprint: record_id,
  may_trigger: true,
  count_health: true,
  ...over,
});

/** A shop template that reads the state from the subject and no identity:
 *  the standards pass has to supply the parcel. */
const stateOnly = (over: Partial<MailTemplateDefinition> = {}): MailTemplateDefinition => ({
  name: 'Shop shipping notices',
  type: 'shipment',
  entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: [] },
  rules: [
    {
      target: { variable: 'state' },
      source: 'subject',
      find: { kind: 'keyword_map', cases: [{ contains: 'on the way', value: 'in_transit' }, { contains: 'delivered', value: 'delivered' }] },
    },
  ],
  html: false,
  ai: { enabled: false },
  ...over,
});

describe('a standards fact on its own (§7.1)', () => {
  it('goes straight to its thing and its triggers when no template reads the type', () => {
    expect(writer.write(input('m1', { email: email({ body_text: 'UPS: 1Z999AA10123456784' }) })))
      .toEqual({ facts: 1, events: 1 });
    const record = events[0]?.record as Record<string, unknown>;
    expect(record).toMatchObject({ carrier: 'UPS', tracking_number: '1Z999AA10123456784', template: null });
    expect(record.passes).toMatchObject({ carrier: 'standard', tracking_number: 'standard' });
  });
});

describe('paired with a template’s fact (§4)', () => {
  it('pairs one with one when their identities do not disagree: the rule’s state, the standard’s parcel', () => {
    const template = store.createTemplate({ definition: stateOnly(), origin: { kind: 'owner' } });
    writer.write(input('m1', { email: email({ body_text: 'Track it: 1Z999AA10123456784' }) }));
    const facts = store.listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ template_id: template.template_id, thing_id: expect.any(String) });
    expect(facts[0]?.variables).toMatchObject({ state: 'in_transit', carrier: 'UPS', tracking_number: '1Z999AA10123456784' });
    expect(facts[0]?.passes).toMatchObject({ state: 'rule', tracking_number: 'standard' });
    expect(events.map((e) => e.event_kind)).toEqual(['created']);
  });

  it('names the carrier as the four are named, so a shop’s “United Parcel Service” and UPS’s own mail are one parcel', () => {
    store.createTemplate({
      definition: stateOnly({
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['tracking_number'] },
        rules: [
          { target: { variable: 'carrier' }, source: 'body', find: { kind: 'after_label', label: 'Carrier:' } },
          { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking:' } },
          { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: 'on the way', value: 'in_transit' }] } },
        ],
      }),
      origin: { kind: 'owner' },
    });
    writer.write(input('m1', { email: email({ body_text: 'Carrier: United Parcel Service\nTracking: 1Z999AA10123456784\n' }) }));
    // The template's reading and the tracking-number reader's agree on the
    // parcel, so they are one fact.
    expect(store.listFacts()).toHaveLength(1);
    expect(store.listFacts()[0]?.variables).toMatchObject({ carrier: 'UPS', tracking_number: '1Z999AA10123456784', state: 'in_transit' });
    // UPS's own mail about it, with no template: the same parcel.
    writer.write(input('m2', {
      email_at: 2_000,
      email: email({ from_address: 'pkginfo@ups.com', from_name: 'UPS', subject: 'UPS Update: Delivered', body_text: 'Tracking Number: 1Z999AA10123456784' }),
    }));
    expect(store.listFacts()).toHaveLength(2);
    expect(store.listThings()).toHaveLength(1);
    expect(new Set(store.listFacts().map((fact) => fact.thing_id)).size).toBe(1);
  });

  it('pairs by identity: two parcels from both passes are two things, the owner’s rule winning each', () => {
    store.createTemplate({
      definition: stateOnly({
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['tracking_number'] },
        repeat: { source: 'body', split: 'Parcel \\d' },
        rules: [
          { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'constant', value: 'UPS' } },
          { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking:' } },
          { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'constant', value: 'The Shop' } },
        ],
      }),
      origin: { kind: 'owner' },
    });
    const body = 'Parcel 1\nTracking: 1Z999AA10123456784\nParcel 2\nTracking: 1Z999AA10123456795\n';
    writer.write(input('m1', { email: email({ body_text: body }) }));
    const facts = store.listFacts();
    expect(facts).toHaveLength(2);
    expect(new Set(facts.map((f) => f.thing_id)).size).toBe(2);
    expect(facts.every((f) => f.variables.merchant === 'The Shop' && f.passes.tracking_number === 'rule')).toBe(true);
  });

  it('pairs by the ids when the names are written differently: one email, one order', () => {
    store.createTemplate({
      definition: {
        name: 'Shop orders',
        type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['order_id'] },
        rules: [
          { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'constant', value: 'Shop' } },
          { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
        ],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const markup = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Order', orderNumber: 'A-100',
      seller: { '@type': 'Organization', name: 'Shop Europe S.a.r.l.' },
    })}</script>`;
    writer.write(input('m1', { email: email({ body_text: 'Order: A-100', html: markup }) }));
    const facts = store.factsForEmail({ slug: 'work', record_id: 'm1' });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.variables).toMatchObject({ merchant: 'Shop', order_id: 'A-100' });
  });

  it('keeps apart a parcel the template did not read, when the template read its own', () => {
    store.createTemplate({
      definition: stateOnly({
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['tracking_number'] },
        rules: [
          { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'constant', value: 'UPS' } },
          { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking:' } },
        ],
      }),
      origin: { kind: 'owner' },
    });
    writer.write(input('m1', { email: email({ body_text: 'Tracking: 1Z999AA10123456784\nAlso 1Z999AA10123456795 by UPS' }) }));
    const facts = store.listFacts();
    expect(facts).toHaveLength(2);
    expect(facts.every((f) => f.thing_id !== null)).toBe(true);
    expect(events.map((e) => e.event_kind)).toEqual(['created', 'created']);
  });

  it('⛔ leaves a standards fact UNPAIRED when it might be a template fact that read no identity', () => {
    // Two notices in one email, the template reading no parcel for either, and
    // one tracking number: which notice is it? Guessing could cross values.
    store.createTemplate({
      definition: stateOnly({ repeat: { source: 'body', split: 'Notice' } }),
      origin: { kind: 'owner' },
    });
    const body = 'Notice: on the way\nNotice: delivered\nUPS 1Z999AA10123456784';
    writer.write(input('m1', { email: email({ body_text: body }) }));
    const facts = store.listFacts();
    const unpaired = facts.filter((f) => f.thing_id === null);
    expect(unpaired).toHaveLength(1);
    expect(unpaired[0]).toMatchObject({ template_id: null, type: 'shipment' });
    expect(unpaired[0]?.variables.tracking_number).toBe('1Z999AA10123456784');
    // It triggers nothing and no thing holds its parcel.
    expect(events.every((e) => (e.record as Record<string, unknown>).tracking_number === null)).toBe(true);
    expect(store.listThings().some((t) => t.variables.tracking_number !== null)).toBe(false);
  });
});

describe('two readings of one thing, value by value down to a nested path (§4)', () => {
  const shipment = getMailFactBuiltinType('shipment')!;
  const reading = (data: Record<string, unknown>, passes: Record<string, 'rule' | 'standard' | 'ai'>): RulesPassFact => ({
    position: 0, variables: {}, passes, data, refused: [], missing: [], complete: false,
  });
  // The template's rule read the link's label; the markup read the whole link.
  const template = reading({ url: { label: 'Track it' } }, { 'data.url.label': 'rule' });
  const markup = reading({ url: 'https://track.example/1Z', note: 'Leave at the door' }, { 'data.url': 'standard', 'data.note': 'standard' });

  it('joined late, a rule’s nested value keeps its place: the markup’s value above it does not replace it', () => {
    const joined = combineFactsByPass(shipment, template, markup);
    expect(joined.data).toEqual({ url: { label: 'Track it' }, note: 'Leave at the door' });
    expect(joined.passes).toEqual({ 'data.url.label': 'rule', 'data.note': 'standard' });
  });

  it('joined late, the markup’s value outranks the AI’s below it — and the AI’s reading goes with its pass', () => {
    const answered = reading({ url: { label: 'Track it' } }, { 'data.url.label': 'ai' });
    const joined = combineFactsByPass(shipment, answered, markup);
    expect(joined.data).toEqual({ url: 'https://track.example/1Z', note: 'Leave at the door' });
    expect(joined.passes).toEqual({ 'data.url': 'standard', 'data.note': 'standard' });
  });

  it('at the write, the template’s reading stands, and the markup names only what it filled', () => {
    const joined = combineFacts(shipment, template, markup);
    expect(joined.data).toEqual({ url: { label: 'Track it' }, note: 'Leave at the door' });
    expect(joined.passes).toEqual({ 'data.url.label': 'rule', 'data.note': 'standard' });
  });

  it('a reading above another stays or goes whole: outranked below, the AI’s whole link goes with its pass', () => {
    const answered = reading({ url: { href: 'https://track.example/1Z' } }, { 'data.url': 'ai' });
    const labelled = reading({ url: { label: 'Track it' } }, { 'data.url.label': 'standard' });
    const joined = combineFactsByPass(shipment, answered, labelled);
    expect(joined.data).toEqual({ url: { label: 'Track it' } });
    expect(joined.passes).toEqual({ 'data.url.label': 'standard' });
    // At the write the first reading stands, whole, and the one below it stays out.
    const written = combineFacts(shipment, answered, labelled);
    expect(written.data).toEqual({ url: { href: 'https://track.example/1Z' } });
    expect(written.passes).toEqual({ 'data.url': 'ai' });
  });
});

describe('switched off per type (ruling 10)', () => {
  it('reads nothing of a switched-off type from new mail; what it read stays with its email', () => {
    store.createTemplate({
      definition: {
        name: 'Shop orders',
        type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: [] },
        rules: [],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const parcel = input('m1', { email: email({ body_text: 'UPS: 1Z999AA10123456784' }), may_trigger: false });
    expect(writer.write(parcel).facts).toBe(2);
    store.setStandardsOn('shipment', false);
    // Re-listed (a restart): read already, so not read again (ruling 13).
    expect(writer.write(parcel)).toMatchObject({ skipped: 'unchanged' });
    // New mail: no parcel is read.
    expect(writer.write(input('m2', { email: email({ body_text: 'UPS: 1Z999AA10123456784' }), may_trigger: false })).facts).toBe(1);
    // Read again by a backfill, the first email keeps its parcel.
    writer.write({ ...parcel, force: true });
    expect(store.factsForEmail({ slug: 'work', record_id: 'm1' }).map((f) => f.type).sort()).toEqual(['purchase', 'shipment']);
    expect(store.factsForEmail({ slug: 'work', record_id: 'm2' }).map((f) => f.type)).toEqual(['purchase']);
  });
});

describe('invoices of one issuer and period (§4)', () => {
  // A template that reads the invoice number and the period; markup that
  // names two invoices of that issuer and period.
  const invoices: MailTemplateDefinition = {
    name: 'Invoices', type: 'bill',
    entrance: { conditions: [{ field: 'from', op: 'is', value: 'billing@shop.example' }], variables: [] },
    rules: [
      { target: { variable: 'issuer' }, source: 'from_name', find: { kind: 'constant', value: 'Shop' } },
      { target: { variable: 'period' }, source: 'body', find: { kind: 'after_label', label: 'Period:' } },
      { target: { variable: 'invoice_number' }, source: 'body', find: { kind: 'after_label', label: 'Invoice:' } },
    ],
    html: false, ai: { enabled: false },
  };
  const markup = (ids: readonly string[]): string => `<script type="application/ld+json">${JSON.stringify(ids.map((id) => ({
    '@type': 'Invoice', provider: { name: 'Shop' }, confirmationNumber: id, billingPeriod: '2026-09',
    totalPaymentDue: { value: id === 'I-1' ? '10' : '20', currency: 'EUR' },
  })))}</script>`;
  const billEmail = (body: string, html: string | null) =>
    email({ subject: 'Your invoices', body_text: body, html, from_address: 'billing@shop.example', from_name: 'Shop' });

  it('pairs the template’s invoice only with the markup’s same invoice: the other is its own thing', () => {
    store.createTemplate({ definition: invoices, origin: { kind: 'owner' } });
    writer.write(input('m1', { email: billEmail('Invoice: I-2\nPeriod: 2026-09', markup(['I-1', 'I-2'])) }));
    const things = store.listThings();
    expect(things.map((thing) => thing.variables.invoice_number).sort()).toEqual(['I-1', 'I-2']);
    // Each keeps its own amount.
    expect(things.find((thing) => thing.variables.invoice_number === 'I-2')?.variables.amount_due).toMatchObject({ amount: '20' });
    expect(things.find((thing) => thing.variables.invoice_number === 'I-1')?.variables.amount_due).toMatchObject({ amount: '10' });
    expect(events.map((event) => (event.record as { invoice_number?: string }).invoice_number).sort()).toEqual(['I-1', 'I-2']);
  });

  it.each([
    ['I-1 first', ['I-1', 'I-2']],
    ['I-2 first', ['I-2', 'I-1']],
  ] as const)('pairs a template’s invoice that names only its issuer and period with neither of two such invoices (%s)', (_, order) => {
    // Its issuer and period, not its number.
    const periodOnly: MailTemplateDefinition = { ...invoices, rules: [invoices.rules[0]!, invoices.rules[1]!] };
    const template = store.createTemplate({ definition: periodOnly, origin: { kind: 'owner' } });
    writer.write(input('m1', { email: billEmail('Period: 2026-09', markup(order)) }));
    // Which of the two it is, it does not say: it takes neither's number or amount.
    const mine = store.factsForEmail({ slug: 'work', record_id: 'm1' }).find((fact) => fact.template_id === template.template_id)!;
    expect(mine.variables).toMatchObject({ invoice_number: null, amount_due: null });
    // Each markup invoice is its own, with its own amount.
    const standards = store.factsForEmail({ slug: 'work', record_id: 'm1' }).filter((fact) => fact.template_id === null);
    expect(standards.map((fact) => [fact.variables.invoice_number, (fact.variables.amount_due as { amount: string }).amount]).sort())
      .toEqual([['I-1', '10'], ['I-2', '20']]);
  });

  it('pairs markup that names only the issuer and period with neither of two invoices the template read of it', () => {
    // One block per invoice: the template reads two, each with its number.
    const blocks: MailTemplateDefinition = { ...invoices, repeat: { source: 'body', split: 'Block \\d+' } };
    const template = store.createTemplate({ definition: blocks, origin: { kind: 'owner' } });
    const periodOnly = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Invoice', provider: { name: 'Shop' }, billingPeriod: '2026-09', totalPaymentDue: { value: '30', currency: 'EUR' },
    })}</script>`;
    writer.write(input('m1', { email: billEmail('Block 1\nInvoice: I-1\nPeriod: 2026-09\nBlock 2\nInvoice: I-2\nPeriod: 2026-09\n', periodOnly) }));
    const facts = store.factsForEmail({ slug: 'work', record_id: 'm1' });
    const mine = facts.filter((fact) => fact.template_id === template.template_id);
    expect(mine.map((fact) => fact.variables.invoice_number).sort()).toEqual(['I-1', 'I-2']);
    // Which of the two the markup's amount is, it does not say: neither takes it.
    expect(mine.map((fact) => fact.variables.amount_due)).toEqual([null, null]);
    expect(facts.filter((fact) => fact.template_id === null)).toHaveLength(1);
  });

  it('pairs by the one rule: two blocks of one invoice are one another, and both take the markup’s reading — whichever came first', () => {
    const blocks: MailTemplateDefinition = { ...invoices, repeat: { source: 'body', split: 'Block \\d+' } };
    const template = store.createTemplate({ definition: blocks, origin: { kind: 'owner' } });
    writer.write(input('m1', { email: billEmail('Block 1\nInvoice: I-1\nPeriod: 2026-09\nBlock 2\nInvoice: I-1\nPeriod: 2026-09\n', markup(['I-1'])) }));
    const facts = store.factsForEmail({ slug: 'work', record_id: 'm1' });
    expect(facts.filter((fact) => fact.template_id === template.template_id).map((fact) => (fact.variables.amount_due as { amount: string } | null)?.amount ?? null))
      .toEqual(['10', '10']);
    expect(facts.filter((fact) => fact.template_id === null)).toEqual([]);
    expect(store.listThings()).toEqual([expect.objectContaining({ variables: expect.objectContaining({ invoice_number: 'I-1', amount_due: expect.objectContaining({ amount: '10' }) }) })]);
  });

  it('pairs one of each only when no part of the identity both read disagrees: a template’s INV-2 is not the markup’s INV-1', () => {
    // The template reads the invoice number, not the issuer: no identity of its own.
    const numberOnly: MailTemplateDefinition = {
      ...invoices,
      rules: [{ target: { variable: 'invoice_number' }, source: 'body', find: { kind: 'after_label', label: 'Invoice:' } }],
    };
    store.createTemplate({ definition: numberOnly, origin: { kind: 'owner' } });
    const owing = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Invoice', provider: { name: 'Utility' }, confirmationNumber: 'INV-1',
      totalPaymentDue: { value: 99, currency: 'EUR' }, paymentDueDate: '2026-09-30',
    })}</script>`;
    writer.write(input('m1', { email: billEmail('Invoice: INV-2', owing) }));
    const template = () => store.factsForEmail({ slug: 'work', record_id: 'm1' }).find((fact) => fact.template_id !== null);
    expect(store.factsForEmail({ slug: 'work', record_id: 'm1' })).toHaveLength(2);
    expect(template()?.variables).toMatchObject({ invoice_number: 'INV-2', amount_due: null });
    // The same number: one invoice, the markup's amount on it.
    writer.write(input('m2', { email: billEmail('Invoice: INV-1', owing) }));
    const facts = store.factsForEmail({ slug: 'work', record_id: 'm2' });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.variables).toMatchObject({ invoice_number: 'INV-1', amount_due: { amount: '99', currency: 'EUR' } });
  });

  it('pairs one of each though their names are written differently: the sender’s name, the markup’s seller', () => {
    store.createTemplate({
      definition: {
        name: 'Shop orders', type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'billing@shop.example' }], variables: [] },
        rules: [{ target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'whole' } }],
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const order = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Order', orderNumber: 'A-1', seller: { '@type': 'Organization', name: 'Shop' }, price: '10.00', priceCurrency: 'EUR',
    })}</script>`;
    writer.write(input('m1', { email: { ...billEmail('Thank you', order), from_name: 'Shop Orders Team' } }));
    const facts = store.factsForEmail({ slug: 'work', record_id: 'm1' });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.variables).toMatchObject({ merchant: 'Shop Orders Team', order_id: 'A-1' });
  });

  it('does not pair the same invoice number of another period: only the names may be written differently', () => {
    store.createTemplate({ definition: invoices, origin: { kind: 'owner' } });
    // The markup's August invoice has the number the email's September one has.
    const august = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Invoice', provider: { name: 'Shop' }, confirmationNumber: 'I-1', billingPeriod: '2026-08',
      totalPaymentDue: { value: '99.00', currency: 'EUR' },
    })}</script>`;
    writer.write(input('m1', { email: billEmail('Invoice: I-1\nPeriod: 2026-09', august) }));
    const facts = store.listFacts();
    expect(facts.map((fact) => fact.variables.period).sort()).toEqual(['2026-08', '2026-09']);
    // September keeps no amount of August's.
    expect(facts.find((fact) => fact.variables.period === '2026-09')?.variables.amount_due ?? null).toBeNull();
    expect(store.listThings()).toHaveLength(2);
  });

  it('does not pair one invoice with the other when each pass read only one', () => {
    store.createTemplate({ definition: invoices, origin: { kind: 'owner' } });
    writer.write(input('m1', { email: billEmail('Invoice: I-2\nPeriod: 2026-09', markup(['I-1'])) }));
    expect(store.listThings().map((thing) => thing.variables.invoice_number).sort()).toEqual(['I-1', 'I-2']);
  });

  it('a switched-off template’s kept invoice does not swallow another invoice of its period', () => {
    const template = store.createTemplate({ definition: invoices, origin: { kind: 'owner' } });
    writer.write(input('m1', { email: billEmail('Invoice: I-1\nPeriod: 2026-09', null), may_trigger: false }));
    store.updateTemplate(template.template_id, { active: false });
    writer.write(input('m1', { email: billEmail('', markup(['I-2'])), content_fingerprint: 'two', force: true }));
    expect(store.listThings().map((thing) => thing.variables.invoice_number).sort()).toEqual(['I-1', 'I-2']);
  });
});

describe('owner requests from the envelope (§7.4)', () => {
  it('reads a +tag the provider records the account as sending, and routes by tag', () => {
    const result = writer.write(input('m1', {
      email: email({ subject: 'water the plants', body_text: 'Every Sunday.', labels: ['SENT'] }),
      envelope: {
        slug: 'work',
        account_email: 'me@example.com',
        to: ['me+remind@example.com'],
        cc: [],
        sent_by_account: true,
        rfc_message_id: 'abc@example.com',
        thread_id: 't1',
      },
    }));
    expect(result).toEqual({ facts: 1, events: 1 });
    expect(events[0]).toMatchObject({ slug: 'owner_request', event_kind: 'created' });
    expect(events[0]?.record).toMatchObject({ tag: 'remind', message_id: 'abc@example.com' });
  });

  it('is news from the Sent copy even when the Inbox copy of the same email was read first', () => {
    // IMAP keeps an email to yourself twice: the copy received in INBOX, and the
    // copy the account sent, in Sent — two ids, one Message-ID, the same text.
    // Only the Sent copy is a request; the Inbox copy reads nothing.
    const request = { subject: 'water the plants', body_text: 'Every Sunday.' };
    const envelope = (sent: boolean) => ({
      slug: 'work', account_email: 'me@example.com', to: ['me+remind@example.com'], cc: [],
      sent_by_account: sent, rfc_message_id: 'abc@example.com', thread_id: 't1',
    });
    expect(writer.write(input('7@INBOX', { email: email({ ...request, from_address: 'me@example.com', labels: ['INBOX'] }), envelope: envelope(false) })))
      .toEqual({ facts: 0, events: 0 });
    const sent = writer.write(input('3@Sent', { email: email({ ...request, from_address: 'me@example.com', labels: ['Sent'] }), envelope: envelope(true) }));
    expect(sent).toEqual({ facts: 1, events: 1 });
    expect(events).toEqual([expect.objectContaining({ slug: 'owner_request', event_kind: 'created' })]);
    // The same Sent copy found again under a new id (the folder's ids reset) is the same email.
    expect(writer.write(input('9@Sent', { email: email({ ...request, from_address: 'me@example.com', labels: ['Sent'] }), envelope: envelope(true), email_at: 2_000 })).events).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('reads mail the account sent only as a request, or by a template that names a label', () => {
    const envelope = {
      slug: 'work', account_email: 'me@example.com', to: ['buyer@shop.example'], cc: [],
      sent_by_account: true, rfc_message_id: 'x@example.com', thread_id: 't1',
    };
    const toBuyer = email({ from_address: 'me@example.com', subject: 'Your parcel', body_text: 'UPS: 1Z999AA10123456784', labels: ['SENT'] });
    store.createTemplate({
      definition: {
        name: 'Anything UPS', type: 'shipment',
        entrance: { conditions: [{ field: 'body', op: 'contains', value: 'UPS' }], variables: [] },
        rules: [], html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    // No parcel from the tracking number, and the template does not read it.
    expect(writer.write(input('m1', { email: toBuyer, envelope }))).toEqual({ facts: 0, events: 0 });
    store.createTemplate({
      definition: {
        name: 'Parcels I send', type: 'shipment',
        entrance: { conditions: [{ field: 'label', op: 'is', value: 'SENT' }], variables: [] },
        rules: [], html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    expect(writer.write(input('m2', { email: toBuyer, envelope })).facts).toBe(1);
  });

  it('is never taken for a security notice, whatever it says; a notice from anyone else is skipped, and the ledger says why', () => {
    const envelope = {
      slug: 'work',
      account_email: 'me@example.com',
      to: ['me+remind@example.com'],
      cc: [],
      sent_by_account: true,
      rfc_message_id: 'abc@example.com',
      thread_id: 't1',
    };
    const request = email({ subject: 'Reset password on the router', body_text: 'This weekend.', labels: ['SENT'] });
    expect(writer.write(input('m1', { email: request, envelope }))).toEqual({ facts: 1, events: 1 });
    expect(writer.write(input('m2', { email: request, envelope: { ...envelope, sent_by_account: false } })))
      .toEqual({ skipped: 'security_notice', facts: 0, events: 0 });
    expect(store.getEmailLedger({ slug: 'work', record_id: 'm2' })).toMatchObject({ skipped: 'security_notice', news: false });
  });
});

describe('a reading left as it was keeps what it took, one reading each (§4)', () => {
  it('an unchanged re-read keeps the other shop’s order of the same number: the template’s fact took one, not both', () => {
    store.createTemplate({
      definition: {
        name: 'Orders', type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: [] },
        rules: [
          { target: { variable: 'merchant' }, source: 'body', find: { kind: 'after_label', label: 'Shop:' } },
          { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
        ],
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const orders = `<script type="application/ld+json">${JSON.stringify([
      { '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'Shop A' }, price: '10.00', priceCurrency: 'EUR' },
      { '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'Shop B' }, price: '20.00', priceCurrency: 'EUR' },
    ])}</script>`;
    const mail = input('m1', { email: email({ body_text: 'Shop: Shop A\nOrder: ORD-1\n', html: orders }) });
    const read = () => store.factsForEmail({ slug: 'work', record_id: 'm1' })
      .map((fact) => [fact.variables.merchant, (fact.variables.total as { amount: string } | null)?.amount ?? null])
      .sort();
    writer.write(mail);
    expect(read()).toEqual([['Shop A', '10.00'], ['Shop B', '20.00']]);
    writer.write({ ...mail, force: true });
    expect(read()).toEqual([['Shop A', '10.00'], ['Shop B', '20.00']]);
  });
});

describe('one markup reading for one template fact, a key before the ids (§4)', () => {
  it('pairs each shop’s order of one number with its own: a key they share is taken before the same ids', () => {
    store.createTemplate({
      definition: {
        name: 'Orders', type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: [] },
        rules: [
          { target: { variable: 'merchant' }, source: 'body', find: { kind: 'after_label', label: 'Shop:' } },
          { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
        ],
        repeat: { source: 'body', split: 'Item \\d+' },
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    // The email names Shop B's order first; the markup, Shop A's.
    const orders = `<script type="application/ld+json">${JSON.stringify([
      { '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'Shop A' }, price: '10.00', priceCurrency: 'EUR' },
      { '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'Shop B' }, price: '20.00', priceCurrency: 'EUR' },
    ])}</script>`;
    writer.write(input('m1', { email: email({ body_text: 'Item 1\nShop: Shop B\nOrder: ORD-1\nItem 2\nShop: Shop A\nOrder: ORD-1\n', html: orders }) }));
    const totals = store.factsForEmail({ slug: 'work', record_id: 'm1' })
      .map((fact) => [fact.variables.merchant, (fact.variables.total as { amount: string } | null)?.amount ?? null])
      .sort();
    expect(totals).toEqual([['Shop A', '10.00'], ['Shop B', '20.00']]);
  });

  it('pairs by the ids alone only with the one reading they name: two shops’ orders of one number are no match for a third', () => {
    store.createTemplate({
      definition: {
        name: 'Orders', type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['order_id'] },
        rules: [
          { target: { variable: 'merchant' }, source: 'body', find: { kind: 'constant', value: 'Shop C' } },
          { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
        ],
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const both = [
      { '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'Shop A' }, price: '10.00', priceCurrency: 'EUR' },
      { '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'Shop B' }, price: '20.00', priceCurrency: 'EUR' },
    ];
    // Either order of the markup: the template's order takes neither amount.
    for (const [record_id, orders] of [['m1', both], ['m2', [...both].reverse()]] as const) {
      writer.write(input(record_id, { email: email({ body_text: 'Order: ORD-1\n', html: `<script type="application/ld+json">${JSON.stringify(orders)}</script>` }) }));
      const facts = store.factsForEmail({ slug: 'work', record_id });
      expect(facts).toHaveLength(3);
      expect(facts.find((fact) => fact.template_id !== null)?.variables.total).toBeNull();
    }
  });

  it('pairs by the ids alone only a reading no other fact names: Shop C’s and Shop D’s orders of one number share none', () => {
    store.createTemplate({
      definition: {
        name: 'Orders', type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: [] },
        rules: [
          { target: { variable: 'merchant' }, source: 'body', find: { kind: 'after_label', label: 'Shop:' } },
          { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
        ],
        repeat: { source: 'body', split: 'Item \\d+' },
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const order = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'Shop A' }, price: '10.00', priceCurrency: 'EUR',
    })}</script>`;
    writer.write(input('m1', { email: email({ body_text: 'Item 1\nShop: Shop C\nOrder: ORD-1\nItem 2\nShop: Shop D\nOrder: ORD-1\n', html: order }) }));
    const totals = store.factsForEmail({ slug: 'work', record_id: 'm1' })
      .map((fact) => [fact.variables.merchant, (fact.variables.total as { amount: string } | null)?.amount ?? null])
      .sort();
    expect(totals).toEqual([['Shop A', '10.00'], ['Shop C', null], ['Shop D', null]]);
  });

  it('gives one markup reading to one template fact: Shop C’s order of Shop A’s number takes none of Shop A’s', () => {
    store.createTemplate({
      definition: {
        name: 'Orders', type: 'purchase',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: [] },
        rules: [
          { target: { variable: 'merchant' }, source: 'body', find: { kind: 'after_label', label: 'Shop:' } },
          { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } },
        ],
        repeat: { source: 'body', split: 'Item \\d+' },
        html: false, ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const order = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Order', orderNumber: 'ORD-1', seller: { '@type': 'Organization', name: 'Shop A' }, price: '10.00', priceCurrency: 'EUR',
    })}</script>`;
    writer.write(input('m1', { email: email({ body_text: 'Item 1\nShop: Shop A\nOrder: ORD-1\nItem 2\nShop: Shop C\nOrder: ORD-1\n', html: order }) }));
    const totals = store.factsForEmail({ slug: 'work', record_id: 'm1' })
      .map((fact) => [fact.variables.merchant, (fact.variables.total as { amount: string } | null)?.amount ?? null])
      .sort();
    expect(totals).toEqual([['Shop A', '10.00'], ['Shop C', null]]);
  });
});

describe('an email whose markup a sender shaped any way (§9)', () => {
  it('is read, its markup as far as it can be, whatever its tags are named or its arrays nest', () => {
    const odd = '<div itemscope itemtype="https://schema.org/Order"><constructor></constructor>'
      + '<span itemprop="orderNumber">A-1</span><span itemprop="seller">Shop</span></div>'
      + `<script type="application/ld+json">${'['.repeat(7_000)}1${']'.repeat(7_000)}</script>`;
    expect(writer.write(input('m1', { email: email({ html: odd }) }))).toMatchObject({ facts: 1 });
    expect(store.factsForEmail({ slug: 'work', record_id: 'm1' })).toEqual([
      expect.objectContaining({ type: 'purchase', variables: expect.objectContaining({ order_id: 'A-1' }) }),
    ]);
  });
});

describe('the markup’s readings of a type switched off (§7.1)', () => {
  it('take none of the email’s hundred: a hundred orders, their type off, leave room for its tracking number', () => {
    store.setStandardsOn('purchase', false);
    const orders = Array.from({ length: 100 }, (_, i) => ({ '@type': 'Order', merchant: { name: 'Shop' }, orderNumber: `A-${i}` }));
    writer.write(input('m1', {
      email: email({ body_text: 'Your shipment: 1Z999AA10123456784', html: `<script type="application/ld+json">${JSON.stringify(orders)}</script>` }),
    }));
    expect(store.listFacts({ type: 'shipment' })).toHaveLength(1);
    expect(store.listFacts({ type: 'purchase' })).toEqual([]);
  });
});
