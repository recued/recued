/** D-315 §9 — text read one way everywhere. Every reader, detector and identity
 *  key reads text as `canonicalMailFactText` gives it: its compatibility form,
 *  nothing that shows nothing, any space a space, a hyphen a hyphen. A value
 *  written in fullwidth or mathematical digits, with a zero-width character
 *  inside it, an odd space or hyphen, is the value written plainly — generated
 *  here, many ways, from a fixed seed, so a failure names the variant that
 *  broke. */

import {
  canonicalMailFactText,
  getMailFactBuiltinType,
  validateMailTemplateDefinition,
  type MailTemplateDefinition,
  type MailTemplateRule,
} from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { bodyForModel, MAIL_FACT_AI_BODY_MAX_CHARS } from '../mail-facts/ai-pass.js';
import { jsonLdNodes, microdataNodes } from '../mail-facts/html-scan.js';
import {
  containsCardNumber,
  containsIban,
  identityValueKey,
  normalizeAccountRef,
  normalizeHeldValue,
  normalizeValue,
  parseDate,
  parseDateTime,
  parseMoney,
} from '../mail-facts/normalize.js';
import { conditionsMayHold, RULES_TEXT_MAX_CHARS, runRulesPass, type MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import { looksLikeSecurityNoticeText } from '../mail-facts/security-notice.js';
import { runStandardsPass, schemaOrgReads } from '../mail-facts/standards-pass.js';
import { findTrackingNumbers } from '../mail-facts/tracking-numbers.js';

const shipment = getMailFactBuiltinType('shipment')!;
const bill = getMailFactBuiltinType('bill')!;

/** A small seeded generator (mulberry32): the same variants every run. */
const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]! };
};

const ZERO_WIDTH = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u200E', '\u00AD'];
const SPACES = ['\u00A0', '\u2009', '\u202F', '\u2007', '\u3000', '\u2002'];
const HYPHENS = ['\u2010', '\u2011', '\uFE63', '\uFF0D'];

/** Ways a sender writes the same text, each as NFKC reads it back. */
const fullwidth = (text: string): string => text.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xFEE0));
const mathDigits = (text: string): string => text.replace(/\d/g, (digit) => String.fromCodePoint(0x1D7CE + Number(digit)));
const withZeroWidth = (text: string, random: ReturnType<typeof seeded>): string =>
  [...text].map((char) => (random.next() < 0.3 ? `${char}${random.pick(ZERO_WIDTH)}` : char)).join('');
const withSpaces = (text: string, random: ReturnType<typeof seeded>): string => text.replace(/ /g, () => random.pick(SPACES));
const withHyphens = (text: string, random: ReturnType<typeof seeded>): string => text.replace(/-/g, () => random.pick(HYPHENS));

const variants = (text: string, seed: number, count = 24): string[] => {
  const random = seeded(seed);
  const ways = [
    (t: string) => fullwidth(t),
    (t: string) => mathDigits(t),
    (t: string) => withZeroWidth(t, random),
    (t: string) => withSpaces(t, random),
    (t: string) => withHyphens(t, random),
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let variant = text;
    for (const way of ways) if (random.next() < 0.5) variant = way(variant);
    out.push(variant === text ? withZeroWidth(text, random) : variant);
  }
  return out;
};

describe('canonicalMailFactText', () => {
  it('reads each variant as the text written plainly', () => {
    for (const text of ['Order A-123 for EUR 12.50', 'Tracking: 1Z999AA10123456784', 'alex@acme.com', 'Sep 26, 2026 10:00 AM', 'New sign-in']) {
      for (const variant of variants(text, 1)) expect(canonicalMailFactText(variant), JSON.stringify(variant)).toBe(text);
    }
  });
});

describe('the detectors read every variant', () => {
  it('finds a full card number however it is written, and none where the check digit fails', () => {
    for (const card of ['4111 1111 1111 1111', '5555 5555 5555 4444', '3782 822463 10005', '4111-1111-1111-1111']) {
      for (const variant of variants(card, 2)) expect(containsCardNumber(`paid with ${variant}`), JSON.stringify(variant)).toBe(true);
    }
    for (const variant of variants('4111 1111 1111 1112', 3)) expect(containsCardNumber(variant), JSON.stringify(variant)).toBe(false);
  });

  it('finds an IBAN however it is written, and none whose check fails', () => {
    for (const iban of ['DE89 3704 0044 0532 0130 00', 'GB82 WEST 1234 5698 7654 32']) {
      for (const variant of variants(iban, 4)) expect(containsIban(`pay to ${variant} by Friday`), JSON.stringify(variant)).toBe(true);
    }
    for (const variant of variants('DE89 3704 0044 0532 0130 01', 5)) expect(containsIban(variant), JSON.stringify(variant)).toBe(false);
  });

  it('knows a security notice however its words are written', () => {
    for (const subject of ['Your verification code', 'Reset your password', 'New sign-in to your account']) {
      for (const variant of variants(subject, 6)) {
        expect(looksLikeSecurityNoticeText(variant, ''), JSON.stringify(variant)).toBe(true);
      }
    }
    expect(looksLikeSecurityNoticeText('Your order has shipped', '')).toBe(false);
    // Each text is read no further than its bound, however it grows as it is read.
    expect(looksLikeSecurityNoticeText(`${'\uFDFA'.repeat(500)} Your verification code`, '')).toBe(false);
    expect(looksLikeSecurityNoticeText(`${'x'.repeat(7_900)} Your verification code`, '')).toBe(true);
    // Read from the first 8,000 characters as written, even when they show nothing.
    expect(looksLikeSecurityNoticeText('', `${'\u200B'.repeat(8_000)}Your verification code`)).toBe(false);
  });

  it('finds a carrier’s tracking number however it is written', () => {
    for (const variant of variants('UPS tracking number: 1Z999AA10123456784', 7)) {
      const found = findTrackingNumbers({ subject: '', body_text: variant, html: null, from_address: 'x@shop.example' });
      expect(found.map((one) => one.tracking_number), JSON.stringify(variant)).toEqual(['1Z999AA10123456784']);
    }
    // A carrier's link written in fullwidth is its link.
    const linked = findTrackingNumbers({
      subject: '', body_text: '', from_address: 'x@shop.example',
      html: '<a href="https://www.ups.com/track?tracknum=\uFF11Z999AA10123456784">Track</a>',
    });
    expect(linked.map((one) => [one.tracking_number, one.tracking_url])).toEqual([
      ['1Z999AA10123456784', 'https://www.ups.com/track?tracknum=1Z999AA10123456784'],
    ]);
    // Text that grows as it is read is cut where it is bounded (U+FDFA is eighteen).
    const grown = (repeat: number) => findTrackingNumbers({
      subject: '', html: null, from_address: 'x@shop.example', body_text: `${'\uFDFA'.repeat(repeat)} UPS tracking number: 1Z999AA10123456784`,
    });
    expect(grown(12_000)).toEqual([]);
    expect(grown(10_000)).toHaveLength(1);
    // Read from the first 200,000 characters as written, even when they show nothing.
    expect(findTrackingNumbers({
      subject: '', html: null, from_address: 'x@shop.example', body_text: `${'\u200B'.repeat(200_000)} UPS tracking number: 1Z999AA10123456784`,
    })).toEqual([]);
  });
});

describe('the readers read every variant as its plain value', () => {
  const plainAndVariants = <T>(text: string, seed: number, read: (text: string) => T): void => {
    const plain = read(text);
    expect(plain).toMatchObject({ ok: true });
    for (const variant of variants(text, seed)) expect(read(variant), JSON.stringify(variant)).toEqual(plain);
  };

  it('a date, a time with its zone, an amount and a number', () => {
    plainAndVariants('2026-09-28', 8, (text) => parseDate(text));
    plainAndVariants('26 September 2026', 9, (text) => parseDate(text));
    plainAndVariants('2026-09-28 10:00:00 +02:00', 10, (text) => parseDateTime(text));
    plainAndVariants('Sep 26, 2026 3:00 PM EDT', 11, (text) => parseDateTime(text));
    plainAndVariants('EUR 12.50', 12, (text) => parseMoney(text));
    plainAndVariants('1,234.5', 13, (text) => normalizeValue(text, 'number', { locale: 'en-US' }));
    plainAndVariants('A-123', 14, (text) => normalizeValue(text, 'id'));
    plainAndVariants('delivered', 15, (text) => normalizeValue(text, 'enum', { values: ['in_transit', 'delivered'] }));
    // A value a query names, as JSON writes a number; an account's last four.
    plainAndVariants('1e-7', 21, (text) => normalizeHeldValue(text, 'number'));
    plainAndVariants('XXXX-1234', 22, (text) => normalizeAccountRef(text));
  });

  it('keeps a text variable as a fact stores text — canonical — and keys it so', () => {
    for (const variant of variants('Shop A', 16)) {
      expect(normalizeValue(variant, 'text'), JSON.stringify(variant)).toEqual({ ok: true, value: 'Shop A' });
      expect(identityValueKey(variant, 'text', 'merchant'), JSON.stringify(variant)).toBe(identityValueKey('Shop A', 'text', 'merchant'));
    }
    // What shows nothing is no value: a required one is not read.
    expect(normalizeValue('\u200B\u2060 \u00AD', 'text')).toEqual({ ok: false, reason: 'empty' });
    for (const variant of variants('alex@acme.com', 17)) {
      expect(identityValueKey(variant, 'text', 'email'), JSON.stringify(variant)).toBe(identityValueKey('alex@acme.com', 'text', 'email'));
    }
    // Two values stay two, however written.
    expect(identityValueKey(fullwidth('alex@acme.com'), 'text', 'email')).not.toBe(identityValueKey('alex@acme.net', 'text', 'email'));
  });
});

describe('hostile shapes cost the rest of the email nothing (§9)', () => {
  it('reads a valid item beside a value nested any depth, in any property', () => {
    const random = seeded(18);
    for (let i = 0; i < 12; i += 1) {
      const depth = 40 + Math.floor(random.next() * 20_000);
      const property = random.pick(['merchant', 'seller', 'price', 'orderStatus', 'url', 'orderDate']);
      const inner = random.pick(['name', 'value', '@value', '@id']);
      const deep = `{"@type":"Order","orderNumber":"D-${i}","${property}":${`{"${inner}":`.repeat(depth)}"x"${'}'.repeat(depth)}}`;
      const valid = '<div itemscope itemtype="https://schema.org/Order"><span itemprop="orderNumber">V-1</span></div>';
      const html = `<script type="application/ld+json">${deep}</script>${valid}`;
      const reads = schemaOrgReads([...jsonLdNodes(html), ...microdataNodes(html)]);
      expect(reads.map((read) => read.values.order_id), `${property}.${inner} × ${depth}`).toContain('V-1');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// A template (§4, §9)
// ────────────────────────────────────────────────────────────────

const shopTemplate: MailTemplateDefinition = {
  name: 'Shop',
  type: 'shipment',
  entrance: {
    conditions: [
      { field: 'from', op: 'domain_is', value: 'shop.example' },
      // Met by the sender's name, not its address.
      { field: 'from', op: 'contains', value: 'Shop A' },
      { field: 'subject', op: 'contains', value: 'has shipped' },
    ],
    variables: ['tracking_number'],
  },
  rules: [
    { target: { variable: 'carrier' }, source: 'body', find: { kind: 'pattern', pattern: 'Carrier: (\\w+)' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking number:' } },
    { target: { variable: 'order_id' }, source: 'body', find: { kind: 'pattern', pattern: 'Order #([A-Z0-9-]+)' } },
    { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'whole' } },
    { target: { variable: 'expected_at' }, source: 'body', find: { kind: 'after_label', label: 'Arrives:' } },
    { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: 'has shipped', value: 'in_transit' }] } },
  ],
  html: false,
  ai: { enabled: false },
};

const shopEmail: MailFactSourceEmail = {
  subject: 'Your order has shipped',
  body_text: 'Carrier: UPS\nTracking number: 1Z999AA10123456784\nOrder #A-123\nArrives: 2026-09-30\n',
  html: null,
  from_address: 'orders@shop.example',
  from_name: 'Shop A',
  headers: {},
  labels: ['INBOX'],
  relationships: [],
  attachments: [],
};

describe('a template reads every variant of an email as the email written plainly', () => {
  it('reads the same facts from each, whatever its conditions, labels, keywords and patterns meet', () => {
    const plain = runRulesPass(shopTemplate, shipment, shopEmail);
    expect(plain).toMatchObject({
      kind: 'facts',
      facts: [{ variables: { carrier: 'UPS', tracking_number: '1Z999AA10123456784', order_id: 'A-123', merchant: 'Shop A', expected_at: '2026-09-30', state: 'in_transit' } }],
    });
    const random = seeded(19);
    for (let i = 0; i < 40; i += 1) {
      const email: MailFactSourceEmail = {
        ...shopEmail,
        subject: random.pick(variants(shopEmail.subject, 100 + i, 4)),
        body_text: random.pick(variants(shopEmail.body_text, 200 + i, 4)),
        from_address: random.pick(variants(shopEmail.from_address, 300 + i, 4)),
        from_name: random.pick(variants(shopEmail.from_name, 400 + i, 4)),
      };
      expect(runRulesPass(shopTemplate, shipment, email), JSON.stringify(email)).toEqual(plain);
    }
  });

  it('reads a template written in fullwidth as its plain form, over an email written either way', () => {
    const written: MailTemplateDefinition = {
      name: 'ショップ',
      type: 'shipment',
      entrance: {
        conditions: [
          // Typed on a Japanese keyboard: fullwidth, as the owner's IME writes it.
          { field: 'from', op: 'domain_is', value: 'ｓｈｏｐ．ｅｘａｍｐｌｅ' },
          { field: 'subject', op: 'contains', value: '発送しました' },
        ],
        variables: ['tracking_number'],
      },
      rules: [
        { target: { variable: 'carrier' }, source: 'body', find: { kind: 'constant', value: 'ＵＰＳ' } },
        { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: '（発送）', value: 'in_transit' }] } },
        { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: '追跡番号：' } },
        { target: { variable: 'order_id' }, source: 'body', find: { kind: 'pattern', pattern: '注文番号：([Ａ-Ｚ０-９－]+)' } },
        // Its fullwidth brackets are brackets to match, never a group.
        { target: { variable: 'merchant' }, source: 'body', find: { kind: 'pattern', pattern: '（([^）]+)）' } },
      ],
      html: false,
      ai: { enabled: false },
    };
    expect(validateMailTemplateDefinition(written, shipment)).toEqual([]);
    const email = (body_text: string): MailFactSourceEmail => ({ ...shopEmail, subject: '(発送)ご注文の商品を発送しました', body_text });
    const plainly = runRulesPass(written, shipment, email('追跡番号:1Z999AA10123456784\n注文番号:A-123\n(Shop A)'));
    expect(plainly).toMatchObject({
      kind: 'facts',
      facts: [{ variables: { carrier: 'UPS', tracking_number: '1Z999AA10123456784', order_id: 'A-123', merchant: 'Shop A', state: 'in_transit' } }],
    });
    expect(runRulesPass(written, shipment, email('追跡番号：１Ｚ９９９ＡＡ１０１２３４５６７８４\n注文番号：Ａ－１２３\n（Ｓｈｏｐ Ａ）'))).toEqual(plainly);
  });

  it('reads the rest of the email as the pass does: headers, labels, HTML and attachment names', () => {
    const fromHeader: MailTemplateDefinition = {
      ...shopTemplate,
      entrance: { conditions: [{ field: 'label', op: 'is', value: 'Receipts' }], variables: ['tracking_number'] },
      rules: [
        { target: { variable: 'carrier' }, source: 'header', header: 'x-shipment', find: { kind: 'after_label', label: 'Carrier:' } },
        { target: { variable: 'tracking_number' }, source: 'html', find: { kind: 'after_label', label: 'Tracking number:' } },
      ],
      html: true,
    };
    const read = (over: Partial<MailFactSourceEmail>) => runRulesPass(fromHeader, shipment, { ...shopEmail, ...over });
    const plain = read({ labels: ['Receipts'], headers: { 'x-shipment': 'Carrier: UPS' }, html: 'Tracking number: 1Z999AA10123456784' });
    expect(plain).toMatchObject({ kind: 'facts', facts: [{ variables: { carrier: 'UPS', tracking_number: '1Z999AA10123456784' } }] });
    expect(read({
      labels: ['\uFF32eceipts'],
      headers: { 'x-shipment': 'Carrier\uFF1A\u200B UPS' },
      html: 'Tracking\u00A0number\uFF1A 1Z999AA10123456784',
    })).toEqual(plain);

    const document: MailTemplateDefinition = {
      name: 'Power', type: 'bill',
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'power.example' }], variables: ['issuer'] },
      rules: [
        { target: { variable: 'issuer' }, source: 'from_name', find: { kind: 'whole' } },
        { target: { variable: 'document' }, source: 'attachment', find: { kind: 'attachment', by: 'name', match: '\uFF49nvoice' } },
      ],
      html: false,
      ai: { enabled: false },
    };
    const attached = (filename: string) => runRulesPass(document, bill, {
      ...shopEmail, from_address: 'billing@power.example', from_name: 'Power Co',
      attachments: [{ file_id: 'file_1', filename, mime_type: 'application/pdf' }],
    });
    expect(attached('Invoice-2026.pdf')).toMatchObject({ kind: 'facts', facts: [{ variables: { document: 'file_1' } }] });
    expect(attached('\uFF29nvoice-2026.pdf')).toMatchObject({ kind: 'facts', facts: [{ variables: { document: 'file_1' } }] });
  });

  it('decides on a stored copy as on the email itself (§6.2)', () => {
    for (const variant of variants(shopEmail.subject, 23, 8)) {
      expect(conditionsMayHold(shopTemplate.entrance.conditions, { ...shopEmail, subject: variant }, false), JSON.stringify(variant)).toBe(true);
    }
  });

  it('reads nothing where a template stored unchecked looks for nothing (§4.1)', () => {
    const nothing = '\u200B\u2060\u00AD';
    const withRule = (index: number, rule: MailTemplateRule): MailTemplateDefinition =>
      ({ ...shopTemplate, rules: shopTemplate.rules.map((kept, i) => (i === index ? rule : kept)) });
    // A label of nothing is found nowhere — not at the start of every line.
    expect(runRulesPass(
      withRule(1, { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: nothing } }),
      shipment,
      shopEmail,
    )).toMatchObject({ kind: 'not_entered' });
    // A keyword of nothing is never the one found.
    const keyword = runRulesPass(
      withRule(5, { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: nothing, value: 'delivered' }] } }),
      shipment,
      shopEmail,
    );
    expect(keyword).toMatchObject({ kind: 'facts', facts: [{ variables: { state: null } }] });
    // A content condition of nothing holds for no email, and its negation for every one.
    const condition = (negate: boolean): MailTemplateDefinition => ({
      ...shopTemplate,
      entrance: { ...shopTemplate.entrance, conditions: [{ field: 'subject', op: 'contains', value: nothing, ...(negate ? { negate } : {}) }] },
    });
    expect(runRulesPass(condition(false), shipment, shopEmail)).toEqual({ kind: 'no_match' });
    expect(runRulesPass(condition(true), shipment, shopEmail)).toMatchObject({ kind: 'facts' });
  });

  it('reads each text no further than it is bounded, however it grows as it is read', () => {
    // U+FDFA is eighteen characters read canonical: a text of it grows eighteenfold,
    // and is cut where it is bounded — what follows is not read.
    const grown = '\uFDFA'.repeat(Math.ceil(RULES_TEXT_MAX_CHARS / 18) + 1_000);
    expect(grown.length).toBeLessThan(RULES_TEXT_MAX_CHARS);
    expect(runRulesPass(shopTemplate, shipment, { ...shopEmail, body_text: `${grown}\n${shopEmail.body_text}` })).toMatchObject({ kind: 'not_entered' });
    // Read from at most that many characters as written, even when they show nothing.
    const hidden = '\u200B'.repeat(RULES_TEXT_MAX_CHARS);
    expect(runRulesPass(shopTemplate, shipment, { ...shopEmail, body_text: `${hidden}\n${shopEmail.body_text}` })).toMatchObject({ kind: 'not_entered' });
    // Within the bound, a text is read whole.
    const long = `${'x'.repeat(RULES_TEXT_MAX_CHARS - 1_000)}\n${shopEmail.body_text}`;
    expect(runRulesPass(shopTemplate, shipment, { ...shopEmail, body_text: long })).toMatchObject({ kind: 'facts' });
  });
});

// ────────────────────────────────────────────────────────────────
// The markup, and the model (§7, §8, §9)
// ────────────────────────────────────────────────────────────────

describe('the markup reader reads every variant of a value as the value written plainly', () => {
  const html = (values: { number: string; status: string; order: string; shop: string; until: string; invoice: string; account: string; due: string }): string =>
    `<script type="application/ld+json">${JSON.stringify([
      {
        '@context': 'https://schema.org',
        '@type': 'ParcelDelivery',
        carrier: { '@type': 'Organization', name: 'UPS' },
        trackingNumber: values.number,
        deliveryStatus: values.status,
        expectedArrivalUntil: values.until,
        partOfOrder: { '@type': 'Order', orderNumber: values.order, merchant: { '@type': 'Organization', name: values.shop } },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Invoice',
        provider: { '@type': 'Organization', name: 'Power Co' },
        confirmationNumber: values.invoice,
        accountId: values.account,
        paymentDueDate: values.due,
        totalPaymentDue: { '@type': 'PriceSpecification', price: '42.00', priceCurrency: 'EUR' },
        paymentStatus: 'https://schema.org/PaymentDue',
      },
    ])}</script>`;
  const plainValues = {
    number: '1Z999AA10123456784',
    status: 'https://schema.org/OrderInTransit',
    order: 'A-123',
    shop: 'Shop A',
    until: '2026-09-30T12:00:00-08:00',
    invoice: 'INV-7',
    account: '1234 5678 9012',
    due: '2026-10-15',
  };

  it('a parcel’s number, status, order and arrival, and a bill’s account and due date', () => {
    const read = (values: typeof plainValues) => runStandardsPass({ ...shopEmail, html: html(values) }, null);
    const plain = read(plainValues);
    expect(plain.map((fact) => fact.type).sort()).toEqual(['bill', 'purchase', 'shipment']);
    expect(plain.find((fact) => fact.type === 'shipment')!.variables).toMatchObject({
      tracking_number: '1Z999AA10123456784', state: 'in_transit', order_id: 'A-123', merchant: 'Shop A', expected_at: '2026-09-30',
    });
    expect(plain.find((fact) => fact.type === 'bill')!.variables).toMatchObject({ invoice_number: 'INV-7', account_ref: '9012', due_at: '2026-10-15' });
    const random = seeded(20);
    for (let i = 0; i < 24; i += 1) {
      const values = Object.fromEntries(Object.entries(plainValues).map(([key, value], j) =>
        [key, random.pick(variants(value, 500 + i * 10 + j, 4))])) as typeof plainValues;
      expect(read(values), JSON.stringify(values)).toEqual(plain);
    }
  });
});

describe('the model reads the email as every reader does', () => {
  it('gets canonical text, cut by what it reads, not by what shows nothing', () => {
    expect(bodyForModel('Ｏｒｄｅｒ\u200B Ａ－１２３')).toEqual({ body_text: 'Order A-123' });
    // Half of it shows nothing: read, it is short enough to send whole.
    const sparse = 'a\u200B'.repeat(MAIL_FACT_AI_BODY_MAX_CHARS * 0.8);
    expect(bodyForModel(sparse)).toEqual({ body_text: 'a'.repeat(MAIL_FACT_AI_BODY_MAX_CHARS * 0.8) });
    // One that grows as it is read is cut, and says so.
    const grown = bodyForModel('\uFDFA'.repeat(MAIL_FACT_AI_BODY_MAX_CHARS));
    expect(grown.body_text.length).toBe(MAIL_FACT_AI_BODY_MAX_CHARS);
    expect(grown.body_truncated).toBe(true);
    expect(bodyForModel('b'.repeat(MAIL_FACT_AI_BODY_MAX_CHARS * 4 + 1)).body_truncated).toBe(true);
    // Past what is read, the rest was cut even when what was read shows nothing.
    expect(bodyForModel(`${'\u200B'.repeat(MAIL_FACT_AI_BODY_MAX_CHARS * 4)}tail`)).toEqual({ body_text: '', body_truncated: true });
  });
});
