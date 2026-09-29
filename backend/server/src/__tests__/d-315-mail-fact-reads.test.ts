/** D-315 slice 1 — the reads behind `core.mail.fact.get` / `.list` (§5), over a
 *  real store filled by the real writer. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MailFact, MailFactThing, MailTemplateDefinition } from '@recued/contracts';

import { createMailFactWriter, type MailFactWriteInput } from '../mail-facts/fact-writer.js';
import { listMailFacts, readMailFact } from '../mail-facts/mail-fact-reads.js';
import type { MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';

let dir: string;
let db: Database.Database;
let store: MailFactStore;
let clock: number;

const ups: MailTemplateDefinition = {
  name: 'UPS',
  type: 'shipment',
  entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['tracking_number'] },
  rules: [
    { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'constant', value: 'UPS' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
    {
      target: { variable: 'state' },
      source: 'subject',
      find: { kind: 'keyword_map', cases: [{ contains: 'Delivered', value: 'delivered' }, { contains: 'On the way', value: 'in_transit' }] },
    },
  ],
  html: false,
  ai: { enabled: false },
};

const email = (subject: string, tracking: string): MailFactSourceEmail => ({
  subject,
  body_text: `Tracking Number: ${tracking}\n`,
  html: null,
  from_address: 'pkginfo@ups.com',
  from_name: 'UPS',
  headers: {},
  labels: ['INBOX'],
  relationships: [],
  attachments: [],
});

const write = (record_id: string, subject: string, tracking: string, email_at: number): void => {
  const input: MailFactWriteInput = {
    ref: { slug: 'work', record_id },
    email: email(subject, tracking),
    email_at,
    content_fingerprint: `${record_id}:${subject}:${tracking}`,
    may_trigger: false,
    count_health: true,
  };
  createMailFactWriter({ store, emit: () => {}, now: () => clock }).write(input);
  clock += 10;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-reads-'));
  db = new Database(join(dir, 'test.db'));
  clock = 1_000;
  store = createMailFactStore(db, { now: () => clock });
  store.createTemplate({ definition: ups, origin: { kind: 'owner' } });
  write('mail:1', 'UPS Update: On the way', '1Z0000000000000001', 100);
  write('mail:2', 'UPS Update: Delivered', '1Z0000000000000001', 200);
  write('mail:3', 'UPS Update: On the way', '1Z0000000000000002', 300);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const things = (): MailFactThing[] => listMailFacts(store, { of: 'things' }) as MailFactThing[];

describe('core.mail.fact.get', () => {
  it('returns a thing with its facts in the order of their emails', () => {
    const delivered = things().find((thing) => thing.variables.state === 'delivered')!;
    const read = readMailFact(store, delivered.thing_id);
    expect(read.thing?.thing_id).toBe(delivered.thing_id);
    expect(read.facts.map((fact) => fact.email.record_id)).toEqual(['mail:1', 'mail:2']);
  });

  it('returns one fact with its thing', () => {
    const [fact] = store.factsForEmail({ slug: 'work', record_id: 'mail:3' });
    const read = readMailFact(store, fact!.fact_id);
    expect(read.facts).toEqual([fact]);
    expect(read.thing?.thing_id).toBe(fact!.thing_id);
  });

  it('returns nothing for an unknown id', () => {
    expect(readMailFact(store, 'mthing_nope')).toEqual({ thing: null, facts: [] });
  });
});

describe('core.mail.fact.list', () => {
  it('lists things newest first, by type and state', () => {
    expect(things().map((thing) => thing.variables.tracking_number)).toEqual([
      '1Z0000000000000002',
      '1Z0000000000000001',
    ]);
    expect(listMailFacts(store, { of: 'things', type: 'shipment', state: 'delivered' })).toHaveLength(1);
    expect(listMailFacts(store, { of: 'things', type: 'bill' })).toEqual([]);
  });

  it('lists facts newest first, by the email’s date', () => {
    const facts = listMailFacts(store, { of: 'facts', since: 150 }) as MailFact[];
    expect(facts.map((fact) => fact.email.record_id)).toEqual(['mail:3', 'mail:2']);
    expect(listMailFacts(store, { of: 'facts', limit: 1 })).toHaveLength(1);
  });

  it('finds a thing by identity the way the writer stored it, spacing and case aside', () => {
    const found = listMailFacts(store, {
      of: 'things',
      type: 'shipment',
      identity: { carrier: 'ups', tracking_number: '1Z 0000 0000 0000 0001' },
    }) as MailFactThing[];
    expect(found).toHaveLength(1);
    expect(found[0]?.variables.state).toBe('delivered');
    // The identity names one thing; other filters still apply to it.
    expect(listMailFacts(store, {
      of: 'things', type: 'shipment', state: 'in_transit',
      identity: { carrier: 'UPS', tracking_number: '1Z0000000000000001' },
    })).toEqual([]);
  });

  it('normalizes each identity value for its variable, as the writer did (a masked account → its last four)', () => {
    store.createTemplate({
      definition: {
        name: 'First Bank statements',
        type: 'statement',
        entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'firstbank.example' }], variables: ['account_ref'] },
        rules: [
          { target: { variable: 'issuer' }, source: 'from_name', find: { kind: 'constant', value: 'First Bank' } },
          { target: { variable: 'account_ref' }, source: 'body', find: { kind: 'after_label', label: 'Account:' } },
          { target: { variable: 'period_start' }, source: 'body', find: { kind: 'after_label', label: 'From:' } },
          { target: { variable: 'period_end' }, source: 'body', find: { kind: 'after_label', label: 'To:' } },
        ],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    createMailFactWriter({ store, emit: () => {}, now: () => clock }).write({
      ref: { slug: 'work', record_id: 'mail:9' },
      email: {
        ...email('Your statement is ready', ''),
        from_address: 'statements@firstbank.example',
        body_text: 'Account: ****1234\nFrom: 2026-09-01\nTo: 2026-09-30\n',
      },
      email_at: 400,
      content_fingerprint: 'mail:9',
      may_trigger: false,
      count_health: true,
    });
    const byIdentity = (account_ref: string) => listMailFacts(store, {
      of: 'things',
      type: 'statement',
      identity: { issuer: 'First Bank', account_ref, period_end: '2026-09-30' },
    });
    expect(byIdentity('xxxx-1234')).toHaveLength(1);
    expect(byIdentity('1234')).toHaveLength(1);
    expect(byIdentity('5678')).toEqual([]);
  });

  it('never answers with a thing whose identity disagrees: two returns of one order are asked for apart', () => {
    store.createTemplate({
      definition: {
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
      },
      origin: { kind: 'owner' },
    });
    const writer = createMailFactWriter({ store, emit: () => {}, now: () => clock });
    for (const [record_id, body] of [['mail:r1', 'Order: A-1\nReturn: R-1\n'], ['mail:r2', 'Order: A-1\nReturn: R-2\n']] as const) {
      writer.write({
        ref: { slug: 'work', record_id },
        email: { ...email('Your return', ''), from_address: 'returns@shop.example', from_name: 'Shop', body_text: body },
        email_at: 400,
        content_fingerprint: record_id,
        may_trigger: false,
        count_health: true,
      });
      clock += 10;
    }
    const returnIds = (identity: Record<string, string>): unknown[] =>
      (listMailFacts(store, { of: 'things', type: 'return_refund', identity }) as MailFactThing[]).map((thing) => thing.variables.return_id);
    expect(returnIds({ merchant: 'Shop', order_id: 'A-1', return_id: 'R-2' })).toEqual(['R-2']);
    expect(returnIds({ merchant: 'Shop', return_id: 'R-1' })).toEqual(['R-1']);
    // The order alone names both, oldest first.
    expect(returnIds({ merchant: 'Shop', order_id: 'A-1' })).toEqual(['R-1', 'R-2']);
    // And the bound holds as it does for any list.
    expect((listMailFacts(store, { of: 'things', type: 'return_refund', identity: { merchant: 'Shop', order_id: 'A-1' }, limit: 1 }) as MailFactThing[])
      .map((thing) => thing.variables.return_id)).toEqual(['R-1']);
  });

  it('names a stored number as the thing holds it: 1.125 is not 1125', () => {
    store.saveCustomType({
      id: 'custom_meter', name: 'Meter', description: 'A meter reading.', states: [], notices: [],
      variables: [{ name: 'reading', kind: 'number', required: true }],
      identity: [['reading']],
    });
    store.createTemplate({
      definition: {
        name: 'Meter readings',
        type: 'custom_meter',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'meter@example.com' }], variables: ['reading'] },
        rules: [{ target: { variable: 'reading' }, source: 'body', find: { kind: 'after_label', label: 'Reading:' }, locale: 'en-US' }],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const writer = createMailFactWriter({ store, emit: () => {}, now: () => clock });
    for (const [record_id, reading] of [['mail:m1', '1.125'], ['mail:m2', '1125']] as const) {
      writer.write({
        ref: { slug: 'work', record_id },
        email: { ...email('Your reading', ''), from_address: 'meter@example.com', body_text: `Reading: ${reading}\n` },
        email_at: 400,
        content_fingerprint: record_id,
        may_trigger: false,
        count_health: true,
      });
      clock += 10;
    }
    const readings = (value: string): unknown[] =>
      (listMailFacts(store, { of: 'things', type: 'custom_meter', identity: { reading: value } }) as MailFactThing[])
        .map((thing) => thing.variables.reading);
    expect(readings('1.125')).toEqual([1.125]);
    expect(readings('1125')).toEqual([1125]);
    // In JSON's own form too, as a read gives a number back.
    expect(readings('1125e-3')).toEqual([1.125]);
  });

  it('names a stored amount with a decimal point: EUR 12.500 is the gift card of EUR 12.50', () => {
    store.saveCustomType({
      id: 'custom_gift', name: 'Gift card', description: 'A gift card, told apart by its amount.', states: [], notices: [],
      variables: [{ name: 'amount', kind: 'money', required: true }],
      identity: [['amount']],
    });
    store.createTemplate({
      definition: {
        name: 'Gift cards',
        type: 'custom_gift',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'gifts@example.com' }], variables: ['amount'] },
        rules: [{ target: { variable: 'amount' }, source: 'body', find: { kind: 'after_label', label: 'Amount:' } }],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    createMailFactWriter({ store, emit: () => {}, now: () => clock }).write({
      ref: { slug: 'work', record_id: 'mail:g1' },
      email: { ...email('Your gift card', ''), from_address: 'gifts@example.com', body_text: 'Amount: EUR 12.50\n' },
      email_at: 400,
      content_fingerprint: 'mail:g1',
      may_trigger: false,
      count_health: true,
    });
    const amounts = (value: string): unknown[] =>
      (listMailFacts(store, { of: 'things', type: 'custom_gift', identity: { amount: value } }) as MailFactThing[])
        .map((thing) => thing.variables.amount);
    expect(amounts('EUR 12.500')).toEqual([{ amount: '12.50', currency: 'EUR' }]);
    expect(amounts('EUR 12.5')).toEqual([{ amount: '12.50', currency: 'EUR' }]);
  });

  it('finds nothing for an identity that is incomplete or names a variable the type lacks', () => {
    expect(listMailFacts(store, { of: 'things', type: 'shipment', identity: { carrier: 'UPS' } })).toEqual([]);
    expect(listMailFacts(store, {
      of: 'things', type: 'shipment', identity: { carrier: 'UPS', parcel: '1Z0000000000000001' },
    })).toEqual([]);
  });
});
