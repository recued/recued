/** D-315 — who is whose, whatever the order (the matching sweep, §13).
 *
 *  Every matcher — a reading to its predecessor, a template's reading to the
 *  markup's, an answer to what it fills, a fact to its thing — decides by one
 *  rule: exactly one candidate, or none. Taken in turn, the first of several
 *  won: a refund that named only its order joined the first return it met
 *  when it came first, and neither when it came last. So each scenario here is
 *  read in many orders — its emails arriving in any order, the readings of
 *  each email in any order — and every order must leave the same facts and
 *  the same things. Generated from a fixed seed. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { MailFactTypeSpec, MailFactValue, MailTemplateDefinition } from '@recued/contracts';

import { createMailFactWriter } from '../mail-facts/fact-writer.js';
import { byWhatItSays, pairEach, thingGroups } from '../mail-facts/matching.js';
import { identitiesDisagree, identityKeysOf } from '../mail-facts/thing-fold.js';
import type { MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import { runStandardsPass } from '../mail-facts/standards-pass.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';

const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { next, shuffle, pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]! };
};

/** A reading of one block: the variables written in it, each as `Name: value`. */
type Block = Readonly<Record<string, string>>;
interface Email { readonly id: string; readonly at: number; readonly blocks: readonly Block[] }

/** A template reading each block of an email: a block begins at `--`. */
const templateFor = (type: MailTemplateDefinition['type'], labels: Readonly<Record<string, string>>, entrance: readonly string[]): MailTemplateDefinition => ({
  name: `${type} notices`,
  type,
  entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'shop.example' }], variables: [...entrance] },
  rules: Object.entries(labels).map(([variable, label]) => ({
    target: { variable },
    source: 'body' as const,
    find: { kind: 'after_label' as const, label: `${label}:` },
  })),
  repeat: { source: 'body', split: '--' },
  html: false,
  ai: { enabled: false },
});

const bodyOf = (blocks: readonly Block[], labels: Readonly<Record<string, string>>): string =>
  blocks.map((block) => `--\n${Object.entries(block).map(([name, value]) => `${labels[name]}: ${value}`).join('\n')}\n`).join('');

/** Every email read in `order`, each with its blocks in the order given; what
 *  the store holds after, named without the ids a store mints. */
const readAll = (
  template: MailTemplateDefinition,
  labels: Readonly<Record<string, string>>,
  emails: readonly Email[],
  removed: readonly string[] = [],
) => {
  const db = new Database(':memory:');
  const store = createMailFactStore(db, { now: () => 2_000_000_000_000 });
  const writer = createMailFactWriter({ store, emit: () => {}, now: () => 2_000_000_000_000 });
  store.createTemplate({ definition: template, origin: { kind: 'owner' } });
  for (const email of emails) {
    const source: MailFactSourceEmail = {
      subject: 'About your order',
      body_text: bodyOf(email.blocks, labels),
      html: null,
      from_address: 'returns@shop.example',
      from_name: 'Shop',
      headers: {},
      labels: ['INBOX'],
      relationships: [],
      attachments: [],
    };
    writer.write({
      ref: { slug: 'work', record_id: email.id },
      email: source,
      email_at: email.at,
      content_fingerprint: `${email.id}:${source.body_text}`,
      may_trigger: false,
      count_health: false,
    });
  }
  writer.removeEmails('work', removed);
  const facts = store.listFacts();
  const named = (variables: Readonly<Record<string, MailFactValue | null>>) =>
    JSON.stringify(Object.fromEntries(Object.entries(variables).filter(([, value]) => value !== null).sort()));
  const factName = new Map(facts.map((fact) => [fact.fact_id, `${fact.email.record_id} ${named(fact.variables)}`]));
  const byThing = new Map<string, string[]>();
  for (const fact of facts) {
    const key = fact.thing_id ?? `alone:${fact.fact_id}`;
    byThing.set(key, [...(byThing.get(key) ?? []), factName.get(fact.fact_id)!]);
  }
  const picture = {
    facts: [...factName.values()].sort(),
    things: [...byThing.values()].map((members) => members.sort().join(' + ')).sort(),
  };
  db.close();
  return picture;
};

/** Many orders of one scenario: all must read alike. */
const inAnyOrder = (
  template: MailTemplateDefinition,
  labels: Readonly<Record<string, string>>,
  emails: readonly Email[],
  seed: number,
  orders = 12,
): void => {
  const random = seeded(seed);
  const first = readAll(template, labels, emails);
  for (let i = 0; i < orders; i += 1) {
    const shuffled = random.shuffle(emails).map((email) => ({ ...email, blocks: random.shuffle(email.blocks) }));
    expect(readAll(template, labels, shuffled), `order ${shuffled.map((email) => email.id).join(', ')}`).toEqual(first);
  }
  // An email deleted after is one never read: what it alone made two ways is
  // one again.
  const gone = random.pick(emails).id;
  expect(readAll(template, labels, random.shuffle(emails), [gone]), `${gone} deleted`)
    .toEqual(readAll(template, labels, emails.filter((email) => email.id !== gone)));
};

describe('returns and refunds, identified by return or by order (§3.1)', () => {
  const labels = { merchant: 'Merchant', return_id: 'Return', order_id: 'Order' };
  const template = templateFor('return_refund', labels, ['merchant']);

  it('a refund naming only its order, beside two returns of it, is neither’s — whichever came first', () => {
    const emails: Email[] = [
      { id: 'mail:refund', at: 1_000, blocks: [{ merchant: 'Shop', order_id: 'O-1' }] },
      { id: 'mail:return-1', at: 2_000, blocks: [{ merchant: 'Shop', return_id: 'R-1', order_id: 'O-1' }] },
      { id: 'mail:return-2', at: 3_000, blocks: [{ merchant: 'Shop', return_id: 'R-2', order_id: 'O-1' }] },
    ];
    inAnyOrder(template, labels, emails, 1);
  });

  it('generated: any returns and refunds of a few orders, read in any order', () => {
    const random = seeded(2);
    for (let scenario = 0; scenario < 30; scenario += 1) {
      const emails: Email[] = [];
      const count = 2 + Math.floor(random.next() * 4);
      for (let e = 0; e < count; e += 1) {
        const blocks: Block[] = [];
        const size = 1 + Math.floor(random.next() * 2);
        for (let b = 0; b < size; b += 1) {
          const block: Record<string, string> = { merchant: 'Shop' };
          const order = random.pick(['O-1', 'O-2']);
          const shape = random.next();
          if (shape < 0.4) block.order_id = order;
          else if (shape < 0.7) block.return_id = `R-${order.slice(-1)}${random.pick(['a', 'b'])}`;
          else {
            block.order_id = order;
            block.return_id = `R-${order.slice(-1)}${random.pick(['a', 'b'])}`;
          }
          blocks.push(block);
        }
        emails.push({ id: `mail:${scenario}-${e}`, at: 1_000 * (e + 1), blocks });
      }
      inAnyOrder(template, labels, emails, 100 + scenario, 6);
    }
  });
});

describe('bills, identified by number or by period (§3.1)', () => {
  const labels = { issuer: 'Issuer', invoice_number: 'Invoice', period: 'Period', amount_due: 'Due', due_at: 'By' };
  const template = templateFor('bill', labels, ['issuer']);

  it('generated: invoices and statements of a few periods, read in any order', () => {
    const random = seeded(3);
    for (let scenario = 0; scenario < 30; scenario += 1) {
      const emails: Email[] = [];
      const count = 2 + Math.floor(random.next() * 4);
      for (let e = 0; e < count; e += 1) {
        const blocks: Block[] = [];
        const size = 1 + Math.floor(random.next() * 2);
        for (let b = 0; b < size; b += 1) {
          const block: Record<string, string> = { issuer: 'Power Co', amount_due: 'EUR 10.00', due_at: '2026-10-01' };
          const period = random.pick(['2026-08', '2026-09']);
          const shape = random.next();
          if (shape < 0.4) block.period = period;
          else if (shape < 0.7) block.invoice_number = `INV-${random.pick(['1', '2', '3'])}`;
          else {
            block.period = period;
            block.invoice_number = `INV-${random.pick(['1', '2', '3'])}`;
          }
          blocks.push(block);
        }
        emails.push({ id: `mail:${scenario}-${e}`, at: 1_000 * (e + 1), blocks });
      }
      inAnyOrder(template, labels, emails, 200 + scenario, 6);
    }
  });
});

describe('the markup, its items in any order (§7.1)', () => {
  const parcel = (tracking: string, until: string | null) => ({
    '@context': 'https://schema.org', '@type': 'ParcelDelivery', carrier: { name: 'UPS' }, trackingNumber: tracking,
    ...(until !== null ? { expectedArrivalUntil: until } : {}),
  });
  const invoice = (number: string | null, period: string | null, amount: string) => ({
    '@context': 'https://schema.org', '@type': 'Invoice', provider: { name: 'Power Co' },
    ...(number !== null ? { confirmationNumber: number } : {}),
    ...(period !== null ? { billingPeriod: period } : {}),
    totalPaymentDue: { '@type': 'PriceSpecification', price: amount, priceCurrency: 'EUR' },
  });
  const email = (items: readonly unknown[]): MailFactSourceEmail => ({
    subject: 'Your account', body_text: '', html: `<script type="application/ld+json">${JSON.stringify(items)}</script>`,
    from_address: 'billing@shop.example', from_name: 'Shop', headers: {}, labels: ['INBOX'], relationships: [], attachments: [],
  });

  it('reads one thing read twice as one fact, and a value it reads two ways as none', () => {
    const facts = runStandardsPass(email([parcel('1Z999AA10123456784', '2026-09-30'), parcel('1Z999AA10123456784', '2026-10-01')]), null);
    expect(facts).toEqual([expect.objectContaining({
      variables: expect.objectContaining({ tracking_number: '1Z999AA10123456784', expected_at: null }),
      refused: [{ variable: 'expected_at', reason: 'the markup reads it two ways' }],
    })]);
    // Read alike, it stands.
    expect(runStandardsPass(email([parcel('1Z999AA10123456784', '2026-09-30'), parcel('1Z999AA10123456784', '2026-09-30')]), null))
      .toEqual([expect.objectContaining({ variables: expect.objectContaining({ expected_at: '2026-09-30' }), refused: [] })]);
  });

  it('reads data one thing’s readings give two ways by what they say, not by the markup’s order', () => {
    const linked = (url: string) => ({ ...parcel('1Z999AA10123456784', null), trackingUrl: url });
    const one = runStandardsPass(email([linked('https://www.ups.com/track?a'), linked('https://www.ups.com/track?b')]), null);
    expect(runStandardsPass(email([linked('https://www.ups.com/track?b'), linked('https://www.ups.com/track?a')]), null)).toEqual(one);
    expect(one).toHaveLength(1);
  });

  it('generated: parcels and invoices, in any order, read alike', () => {
    const random = seeded(4);
    for (let scenario = 0; scenario < 40; scenario += 1) {
      const items: unknown[] = [];
      const count = 2 + Math.floor(random.next() * 4);
      for (let i = 0; i < count; i += 1) {
        if (random.next() < 0.4) {
          items.push(parcel(random.pick(['1Z999AA10123456784', '1Z999AA10123456793']), random.pick([null, '2026-09-30', '2026-10-01'])));
        } else {
          items.push(invoice(random.pick([null, 'INV-1', 'INV-2']), random.pick([null, '2026-08', '2026-09']), random.pick(['10.00', '20.00'])));
        }
      }
      const first = runStandardsPass(email(items), null);
      for (let order = 0; order < 6; order += 1) {
        expect(runStandardsPass(email(random.shuffle(items)), null), JSON.stringify(items)).toEqual(first);
      }
    }
  });
});

describe('a reading again, and a move, by the one rule (§5)', () => {
  const labels = { merchant: 'Merchant', return_id: 'Return', order_id: 'Order' };
  const setUp = () => {
    const db = new Database(':memory:');
    let ids = 0;
    const store = createMailFactStore(db, { now: () => 2_000_000_000_000, mintId: (prefix) => `${prefix}_${(ids += 1)}` });
    const writer = createMailFactWriter({ store, emit: () => {}, now: () => 2_000_000_000_000 });
    const write = (record_id: string, blocks: readonly Block[], over: { readonly may_trigger?: boolean; readonly force?: boolean } = {}) =>
      writer.write({
        ref: { slug: 'work', record_id },
        email: {
          subject: 'About your order', body_text: bodyOf(blocks, labels), html: null, from_address: 'returns@shop.example',
          from_name: 'Shop', headers: {}, labels: ['INBOX'], relationships: [], attachments: [],
        },
        email_at: 1_000,
        content_fingerprint: `${record_id}:${bodyOf(blocks, labels)}`,
        may_trigger: over.may_trigger ?? false,
        count_health: false,
        ...(over.force === true ? { force: true } : {}),
      });
    return { db, store, writer, write };
  };

  it('a reading two facts read before could each be replaces neither: a refund of an order is neither return of it', () => {
    const { db, store, write } = setUp();
    try {
      const template = store.createTemplate({ definition: templateFor('return_refund', labels, ['merchant']), origin: { kind: 'owner' } });
      write('mail:1', [{ merchant: 'Shop', return_id: 'R-1', order_id: 'O-1' }, { merchant: 'Shop', return_id: 'R-2', order_id: 'O-1' }]);
      const before = store.factsForEmail({ slug: 'work', record_id: 'mail:1' }).map((fact) => fact.fact_id);
      expect(before).toHaveLength(2);
      // Its rules no longer read the return: each block now reads the order alone.
      store.updateTemplate(template.template_id, { definition: templateFor('return_refund', { merchant: 'Merchant', order_id: 'Order' }, ['merchant']) });
      write('mail:1', [{ merchant: 'Shop', return_id: 'R-1', order_id: 'O-1' }, { merchant: 'Shop', return_id: 'R-2', order_id: 'O-1' }], { force: true });
      const after = store.factsForEmail({ slug: 'work', record_id: 'mail:1' });
      expect(after).toHaveLength(2);
      expect(after.filter((fact) => before.includes(fact.fact_id))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('of facts read before that are one another, a reading keeps the one in its place', () => {
    const { db, store, write } = setUp();
    try {
      const template = store.createTemplate({ definition: templateFor('return_refund', labels, ['merchant']), origin: { kind: 'owner' } });
      // One return read twice, with its order and without: two facts that are one another.
      write('mail:1', [{ merchant: 'Shop', return_id: 'R-1', order_id: 'O-1' }, { merchant: 'Shop', return_id: 'R-1' }]);
      const [first, second] = store.factsForEmail({ slug: 'work', record_id: 'mail:1' });
      expect([first?.position, second?.position]).toEqual([0, 1]);
      // Read again, the first block is another return: the second keeps the fact in its place.
      store.updateTemplate(template.template_id, { definition: { ...templateFor('return_refund', labels, ['merchant']), name: 'edited' } });
      write('mail:1', [{ merchant: 'Shop', return_id: 'R-9', order_id: 'O-9' }, { merchant: 'Shop', return_id: 'R-1' }], { force: true });
      const now = store.factsForEmail({ slug: 'work', record_id: 'mail:1' });
      expect(now.find((fact) => fact.variables.return_id === 'R-1')?.fact_id).toBe(second!.fact_id);
    } finally {
      db.close();
    }
  });

  it('a reading one fact read before could be keeps it', () => {
    const { db, store, write } = setUp();
    try {
      const template = store.createTemplate({ definition: templateFor('return_refund', labels, ['merchant']), origin: { kind: 'owner' } });
      write('mail:1', [{ merchant: 'Shop', return_id: 'R-1', order_id: 'O-1' }]);
      const [before] = store.factsForEmail({ slug: 'work', record_id: 'mail:1' });
      store.updateTemplate(template.template_id, { definition: templateFor('return_refund', { merchant: 'Merchant', order_id: 'Order' }, ['merchant']) });
      write('mail:1', [{ merchant: 'Shop', return_id: 'R-1', order_id: 'O-1' }], { force: true });
      expect(store.factsForEmail({ slug: 'work', record_id: 'mail:1' }).map((fact) => fact.fact_id)).toEqual([before!.fact_id]);
    } finally {
      db.close();
    }
  });

  it('a move tells nothing of a fact the old id never told: a return of another number shares the order, and is not it', () => {
    const { db, store, writer, write } = setUp();
    try {
      store.createTemplate({ definition: templateFor('return_refund', labels, ['merchant']), origin: { kind: 'owner' } });
      write('mail:old', [{ merchant: 'Shop', return_id: 'R-1', order_id: 'O-1' }], { may_trigger: true });
      expect(store.factRecordsForEmail({ slug: 'work', record_id: 'mail:old' })[0]?.announced).toBe(true);
      // Read first under the new id, it says another return, stored silently.
      write('mail:new', [{ merchant: 'Shop', return_id: 'R-2', order_id: 'O-1' }]);
      writer.rekeyEmail('work', 'mail:old', 'mail:new');
      expect(store.factRecordsForEmail({ slug: 'work', record_id: 'mail:new' }).map((fact) => [fact.variables.return_id, fact.announced]))
        .toEqual([['R-2', false]]);
    } finally {
      db.close();
    }
  });
});

describe('things settled by the one rule keep what they had (§5)', () => {
  const labels = { merchant: 'Merchant', return_id: 'Return', order_id: 'Order' };
  const setUp = () => {
    const db = new Database(':memory:');
    let ids = 0;
    let clock = 1_000;
    const store = createMailFactStore(db, { now: () => clock, mintId: (prefix) => `${prefix}_${(ids += 1)}` });
    const writer = createMailFactWriter({ store, emit: () => {}, now: () => clock });
    const template = store.createTemplate({ definition: templateFor('return_refund', labels, ['merchant']), origin: { kind: 'owner' } });
    const write = (record_id: string, blocks: readonly Block[], force = false) => {
      clock += 1_000;
      writer.write({
        ref: { slug: 'work', record_id },
        email: {
          subject: 'About your order', body_text: bodyOf(blocks, labels), html: null, from_address: 'returns@shop.example',
          from_name: 'Shop', headers: {}, labels: ['INBOX'], relationships: [], attachments: [],
        },
        email_at: clock,
        content_fingerprint: `${record_id}:${bodyOf(blocks, labels)}:${force}`,
        may_trigger: false,
        count_health: false,
        ...(force ? { force: true } : {}),
      });
    };
    const thingOf = (record_id: string) => store.factsForEmail({ slug: 'work', record_id })[0]?.thing_id;
    return { db, store, writer, template, write, thingOf };
  };
  const refund = { merchant: 'Shop', order_id: 'O-1' };
  const returnOf = (id: string) => ({ merchant: 'Shop', return_id: id, order_id: 'O-1' });

  it('a return keeps its thing when the refund that shared it is taken off', () => {
    const { db, write, thingOf } = setUp();
    try {
      write('mail:refund', [refund]);
      write('mail:r1', [returnOf('R-1')]);
      const shared = thingOf('mail:r1');
      expect(thingOf('mail:refund')).toBe(shared);
      write('mail:r2', [returnOf('R-2')]);
      expect(thingOf('mail:r1')).toBe(shared);
      expect(thingOf('mail:refund')).not.toBe(shared);
      expect(thingOf('mail:refund')).not.toBe(thingOf('mail:r2'));
    } finally {
      db.close();
    }
  });

  it('a thing that is wholly another’s once an email goes is merged into it, its runs along', () => {
    const { db, store, writer, write, thingOf } = setUp();
    try {
      write('mail:r1', [returnOf('R-1')]);
      write('mail:r2', [returnOf('R-2')]);
      write('mail:refund', [refund]);
      const undecided = thingOf('mail:refund')!;
      expect([thingOf('mail:r1'), thingOf('mail:r2')]).not.toContain(undecided);
      store.recordRun({ email: { slug: 'work', record_id: 'mail:refund' }, thing_id: undecided, trigger_id: 't1', recipe_id: 'r1', outcome: 'completed', at: 1 });
      writer.removeEmails('work', ['mail:r2']);
      expect(thingOf('mail:refund')).toBe(thingOf('mail:r1'));
      expect(store.runsForEmail({ slug: 'work', record_id: 'mail:refund' }).map((run) => run.thing_id)).toEqual([thingOf('mail:r1')]);
      expect(store.getThing(undecided)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a fact read again without its identity stays on its thing', () => {
    const { db, store, template, write, thingOf } = setUp();
    try {
      write('mail:1', [returnOf('R-1')]);
      write('mail:2', [returnOf('R-1')]);
      const thing = thingOf('mail:1');
      expect(thingOf('mail:2')).toBe(thing);
      // Its rules no longer read the merchant: the email's reading has no identity.
      store.updateTemplate(template.template_id, {
        definition: { ...templateFor('return_refund', { return_id: 'Return', order_id: 'Order' }, ['order_id']) },
      });
      write('mail:2', [returnOf('R-1')], true);
      expect(store.factsForEmail({ slug: 'work', record_id: 'mail:2' })[0]?.identity_keys).toEqual([]);
      // Both where they were: the one without an identity, and the one with.
      expect(thingOf('mail:2')).toBe(thing);
      expect(thingOf('mail:1')).toBe(thing);
      // And when the thing is settled again, for another email of it.
      store.updateTemplate(template.template_id, { definition: templateFor('return_refund', labels, ['merchant']) });
      write('mail:3', [returnOf('R-1')]);
      expect([thingOf('mail:1'), thingOf('mail:2'), thingOf('mail:3')]).toEqual([thing, thing, thing]);
    } finally {
      db.close();
    }
  });
});

describe('the one rule itself (`pairEach`)', () => {
  type Reading = { readonly id: string; readonly variables: Readonly<Record<string, string>>; readonly group: string };
  const reading = (id: string, group: string): Reading => ({ id, variables: { id }, group });
  const pair = (readings: readonly Reading[], candidates: readonly Reading[], share: boolean) => {
    const paired = pairEach({
      readings,
      candidates,
      could: (a, b) => a.group === b.group,
      readingsApart: () => false,
      candidatesApart: () => false,
      rank: (_reading, a, b) => byWhatItSays(a, b),
      readingRank: byWhatItSays,
      share,
    });
    return [...paired].map(([a, b]) => `${a.id}→${b.id}`).sort();
  };

  it('of candidates that are one another, takes the first by what they say, whatever order they are given in', () => {
    const r = reading('r', 'g');
    const [c1, c2] = [reading('c1', 'g'), reading('c2', 'g')];
    expect(pair([r], [c1, c2], false)).toEqual(['r→c1']);
    expect(pair([r], [c2, c1], false)).toEqual(['r→c1']);
  });

  it('of readings after one candidate, the first by what they say takes it where they may not share, whatever their order', () => {
    const [r1, r2] = [reading('r1', 'g'), reading('r2', 'g')];
    const c = reading('c', 'g');
    expect(pair([r1, r2], [c], false)).toEqual(['r1→c']);
    expect(pair([r2, r1], [c], false)).toEqual(['r1→c']);
    // Where they may, both do.
    expect(pair([r2, r1], [c], true)).toEqual(['r1→c', 'r2→c']);
  });
});

describe('a thing holds no two readings that are not one another, however they chain (§5)', () => {
  // A kind named by any one of three values alone.
  const trio: MailFactTypeSpec = {
    id: 'custom_trio', name: 'Trio', description: 'Named by any one of three.', states: [], notices: [],
    variables: [{ name: 'aa', kind: 'id', required: false }, { name: 'bb', kind: 'id', required: false }, { name: 'cc', kind: 'id', required: false }],
    identity: [['aa'], ['bb'], ['cc']],
  };
  type Named = { readonly name: string; readonly variables: Readonly<Record<string, string>>; readonly identity_keys: readonly string[] };
  const keyed = (spec: MailFactTypeSpec, list: readonly { readonly name: string; readonly variables: Readonly<Record<string, string>> }[]): Named[] =>
    list.map((reading) => ({ ...reading, identity_keys: identityKeysOf(spec, reading.variables) }));
  const readings = keyed(trio, [
    { name: '1', variables: { aa: '2', cc: '2' } },
    { name: '2', variables: { bb: '2', cc: '2' } },
    { name: '3', variables: { bb: '1', cc: '1' } },
    { name: '4', variables: { aa: '2', bb: '1' } },
    { name: '5', variables: { aa: '1', bb: '2', cc: '2' } },
  ]);
  type Groups = readonly { readonly members: readonly { readonly name: string; readonly identity_keys: readonly string[] }[] }[];
  const named = (groups: Groups) =>
    groups.map((group) => group.members.map((member) => member.name).sort().join('+')).sort();
  const noneApart = (groups: Groups) => {
    for (const group of groups) {
      for (const a of group.members) {
        for (const b of group.members) expect(identitiesDisagree(a.identity_keys, b.identity_keys), `${a.name} and ${b.name}`).toBe(false);
      }
    }
  };

  it('keeps apart what two it could be would join: each of these is its own, in any order', () => {
    const groups = thingGroups(readings);
    noneApart(groups);
    expect(named(groups)).toEqual(['1', '2', '3', '4', '5']);
    const random = seeded(5);
    for (let order = 0; order < 12; order += 1) expect(named(thingGroups(random.shuffle(readings)))).toEqual(named(groups));
  });

  it('keeps apart two a chain of readings joins though none of them could be two', () => {
    const chain: MailFactTypeSpec = { ...trio, identity: [['aa'], ['bb'], ['cc'], ['dd']], variables: [...trio.variables, { name: 'dd', kind: 'id', required: false }] };
    const links = keyed(chain, [
      { name: 'x', variables: { aa: '1', bb: '1' } },
      { name: 'p', variables: { bb: '1', cc: '1' } },
      { name: 'q', variables: { cc: '1', dd: '1' } },
      { name: 'y', variables: { dd: '1', aa: '2' } },
    ]);
    const groups = thingGroups(links);
    noneApart(groups);
    const random = seeded(6);
    for (let order = 0; order < 12; order += 1) {
      expect(named(thingGroups(random.shuffle(links)))).toEqual(named(groups));
    }
  });

  it('keeps each its own where every one of them could be two that are not one another', () => {
    // A square: each could be the two beside it, which are not one another.
    const square = [
      { name: 'a', identity_keys: ['e1=1', 'e4=1', 'x=1'] },
      { name: 'b', identity_keys: ['e1=1', 'e2=1', 'y=1'] },
      { name: 'c', identity_keys: ['e2=1', 'e3=1', 'x=2'] },
      { name: 'd', identity_keys: ['e3=1', 'e4=1', 'y=2'] },
    ];
    const groups = thingGroups(square);
    expect(groups.map((group) => group.members.map((member) => member.name).join('+')).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(groups.every((group) => group.undecided)).toBe(true);
  });

  it('still joins what could be one another, and a reading of two that are not one another is neither’s', () => {
    const spec: MailFactTypeSpec = { ...trio, identity: [['aa', 'bb'], ['aa', 'cc']] };
    const plain = keyed(spec, [
      { name: 'return-1', variables: { aa: 'O', bb: 'R1' } },
      { name: 'return-1-again', variables: { aa: 'O', bb: 'R1', cc: 'X' } },
      { name: 'return-2', variables: { aa: 'O', bb: 'R2', cc: 'X' } },
      { name: 'refund', variables: { aa: 'O', cc: 'X' } },
    ]);
    const groups = thingGroups(plain);
    noneApart(groups);
    expect(named(groups)).toEqual(named(thingGroups([...plain].reverse())));
    // return-1-again is return-1 read with its reference too: one. The refund
    // could be either return, which are not one another: it is neither's, and
    // told as undecided; the rest is decided.
    const flags = Object.fromEntries(groups.map((group) => [group.members.map((member) => member.name).sort().join('+'), group.undecided]));
    expect(flags).toEqual({ 'return-1+return-1-again': false, 'return-2': false, 'refund': true });
  });

  it('the writer keeps them apart, whatever order the mail comes in', () => {
    const labels = { aa: 'AA', bb: 'BB', cc: 'CC' };
    const readAllOf = (order: readonly Named[]) => {
      const db = new Database(':memory:');
      const store = createMailFactStore(db, { now: () => 2_000_000_000_000 });
      const writer = createMailFactWriter({ store, emit: () => {}, now: () => 2_000_000_000_000 });
      store.saveCustomType(trio);
      store.createTemplate({ definition: templateFor('custom_trio', labels, []), origin: { kind: 'owner' } });
      for (const reading of order) {
        const body = bodyOf([reading.variables], labels);
        writer.write({
          ref: { slug: 'work', record_id: `mail:${reading.name}` },
          email: {
            subject: 'About it', body_text: body, html: null, from_address: 'desk@shop.example', from_name: 'Shop',
            headers: {}, labels: ['INBOX'], relationships: [], attachments: [],
          },
          email_at: 1_000 * Number(reading.name),
          content_fingerprint: `mail:${reading.name}:${body}`,
          may_trigger: false,
          count_health: false,
        });
      }
      const byThing = new Map<string, { email: string; keys: readonly string[] }[]>();
      for (const fact of store.listFacts()) {
        byThing.set(fact.thing_id!, [...(byThing.get(fact.thing_id!) ?? []), { email: fact.email.record_id, keys: fact.identity_keys }]);
      }
      for (const members of byThing.values()) {
        for (const a of members) for (const b of members) expect(identitiesDisagree(a.keys, b.keys), `${a.email} and ${b.email}`).toBe(false);
      }
      const picture = [...byThing.values()].map((members) => members.map((member) => member.email).sort().join('+')).sort();
      db.close();
      return picture;
    };
    const first = readAllOf(readings);
    expect(first).toHaveLength(5);
    const random = seeded(7);
    for (let order = 0; order < 8; order += 1) expect(readAllOf(random.shuffle(readings))).toEqual(first);
  });
});
