/** D-315 slice 1 — the rules pass: one template read over one email (§4, §4.1,
 *  §4.2, §9). Conditions, the entrance, finders, repeated blocks, provenance,
 *  refusals, and the data cap. */

import { describe, expect, it } from 'vitest';

import {
  getMailFactBuiltinType,
  type MailTemplateDefinition,
} from '@recued/contracts';

import {
  finishFact,
  MAIL_FACT_DATA_MAX_BYTES,
  runRulesPass,
  setPath,
  type MailFactSourceEmail,
} from '../mail-facts/rules-pass.js';

const shipment = getMailFactBuiltinType('shipment')!;
const bill = getMailFactBuiltinType('bill')!;

const email = (over: Partial<MailFactSourceEmail> = {}): MailFactSourceEmail => ({
  subject: 'UPS Update: Package Delivered',
  body_text: 'Hello,\nYour package was delivered.\nTracking Number: 1Z 999 AA1 01 2345 6784\nScheduled: 09/26/2026\n',
  html: null,
  from_address: 'pkginfo@ups.com',
  from_name: 'UPS',
  headers: {},
  labels: ['INBOX'],
  relationships: [],
  attachments: [],
  ...over,
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
          { contains: 'Out for delivery', value: 'out_for_delivery' },
        ],
      },
    },
    { target: { variable: 'expected_at' }, source: 'body', find: { kind: 'after_label', label: 'Scheduled:' }, locale: 'en-US' },
    { target: { data: 'greeting' }, source: 'body', find: { kind: 'pattern', pattern: '^(Hello)' , flags: 'm' } },
  ],
  html: false,
  ai: { enabled: false },
  ...over,
});

describe('conditions (§4.1)', () => {
  it('reads nothing when a condition does not hold', () => {
    expect(runRulesPass(upsTemplate(), shipment, email({ from_address: 'news@shop.example' }))).toEqual({
      kind: 'no_match',
    });
  });

  it('matches a subdomain for domain_is, and honours a negated condition', () => {
    const template = upsTemplate({
      entrance: {
        conditions: [
          { field: 'from', op: 'domain_is', value: 'ups.com' },
          { field: 'subject', op: 'contains', value: 'sign-in', negate: true },
        ],
        variables: ['tracking_number'],
      },
    });
    expect(runRulesPass(template, shipment, email({ from_address: 'mcinfo@mail.ups.com' })).kind).toBe('facts');
    expect(runRulesPass(template, shipment, email({ subject: 'Your sign-in code' })).kind).toBe('no_match');
  });

  it('holds a relationship condition for any of the sender’s relationships', () => {
    const template = upsTemplate({
      entrance: {
        conditions: [{ field: 'relationship', op: 'is', value: 'work' }],
        variables: ['tracking_number'],
      },
    });
    expect(runRulesPass(template, shipment, email({ relationships: ['social', 'work'] })).kind).toBe('facts');
    expect(runRulesPass(template, shipment, email({ relationships: ['family'] })).kind).toBe('no_match');
    expect(runRulesPass(template, shipment, email({ relationships: [] })).kind).toBe('no_match');
  });

  it('tests the content in the HTML too, only when the template reads HTML', () => {
    const conditions = [{ field: 'body' as const, op: 'contains' as const, value: 'Ihr Paket' }];
    const stub = email({ body_text: 'Tracking Number: 1Z01\n', html: '<p>Ihr Paket ist unterwegs</p>' });
    const reading = upsTemplate({ html: true, entrance: { conditions, variables: ['tracking_number'] } });
    const notReading = upsTemplate({ html: false, entrance: { conditions, variables: ['tracking_number'] } });
    expect(runRulesPass(reading, shipment, stub).kind).toBe('facts');
    expect(runRulesPass(notReading, shipment, stub).kind).toBe('no_match');
  });
});

describe('the entrance (§4, ruling 37)', () => {
  it('reads a fact: variables normalized, each marked rule, required ones counted', () => {
    const outcome = runRulesPass(upsTemplate(), shipment, email());
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    const [fact] = outcome.facts;
    expect(fact!.variables.tracking_number).toBe('1Z999AA10123456784');
    expect(fact!.variables.carrier).toBe('UPS');
    expect(fact!.variables.state).toBe('delivered');
    expect(fact!.variables.expected_at).toBe('2026-09-26');
    expect(fact!.variables.order_id).toBeNull(); // every variable present, null when unread
    expect(fact!.passes.tracking_number).toBe('rule');
    expect(fact!.data).toEqual({ greeting: 'Hello' });
    expect(fact!.passes['data.greeting']).toBe('rule');
    expect(fact!.complete).toBe(true); // carrier and tracking_number are the required ones
  });

  it('makes no fact when an entrance variable is unread, and says which', () => {
    const outcome = runRulesPass(upsTemplate(), shipment, email({ body_text: 'Your package is on its way.' }));
    expect(outcome).toEqual({ kind: 'not_entered', unread: ['tracking_number'] });
  });

  it('does not let a constant satisfy the entrance: it is not read from the email', () => {
    const template = upsTemplate({
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['carrier'] },
    });
    expect(runRulesPass(template, shipment, email()).kind).toBe('not_entered');
  });

  it('keeps an incomplete fact once its entrance is met (ruling 8)', () => {
    const template = upsTemplate({
      rules: upsTemplate().rules.filter((rule) => !('variable' in rule.target && rule.target.variable === 'carrier')),
    });
    const outcome = runRulesPass(template, shipment, email());
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.complete).toBe(false);
    expect(outcome.facts[0]!.missing).toEqual(['carrier']);
  });
});

describe('finders (§4.2)', () => {
  it('finds a label without case in the line as written, whatever lower-casing does to its length', () => {
    const lira = upsTemplate({
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['tracking_number'] },
      rules: [{ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'sipariş numarası:' } }],
    });
    const outcome = runRulesPass(lira, shipment, email({ body_text: 'İİİ Sipariş numarası: R12345\n' }));
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.variables.tracking_number).toBe('R12345');
  });

  it('keeps a minus sign after a label, and drops a dash that only separates', () => {
    const read = (body: string): unknown => {
      const template = upsTemplate({
        entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: ['tracking_number'] },
        rules: [{ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Ref:' } }],
      });
      const outcome = runRulesPass(template, shipment, email({ body_text: body }));
      return outcome.kind === 'facts' ? outcome.facts[0]!.variables.tracking_number : null;
    };
    // An id has no sign: a dash before it is a separator.
    expect(read('Ref:-1Z999AA10123456784\n')).toBe('1Z999AA10123456784');
    expect(read('Ref: - 1Z999AA10123456784\n')).toBe('1Z999AA10123456784');
    // A number keeps its sign.
    const lots = { ...shipment, id: 'custom_lots' as const, variables: [...shipment.variables, { name: 'lot', kind: 'number' as const, required: false }] };
    const numbered = upsTemplate({
      type: 'custom_lots',
      rules: [
        { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
        { target: { variable: 'lot' }, source: 'body', find: { kind: 'after_label', label: 'Lot:' } },
      ],
    });
    const outcome = runRulesPass(numbered, lots, email({ body_text: 'Tracking Number: 1Z999AA10123456784\nLot: -125\n' }));
    expect(outcome.kind === 'facts' && outcome.facts[0]!.variables.lot).toBe(-125);
  });

  it('takes the next line when a label ends its line', () => {
    const outcome = runRulesPass(
      upsTemplate(),
      shipment,
      email({ body_text: 'Tracking Number:\n\n  1Z999AA10123456784\n' }),
    );
    expect(outcome.kind === 'facts' && outcome.facts[0]!.variables.tracking_number).toBe('1Z999AA10123456784');
  });

  it('picks an attachment by type into a file variable, and never reads it (ruling 25)', () => {
    const template: MailTemplateDefinition = {
      name: 'Power bill',
      type: 'bill',
      entrance: { conditions: [{ field: 'from', op: 'is', value: 'billing@power.example' }], variables: ['document'] },
      rules: [
        { target: { variable: 'document' }, source: 'attachment', find: { kind: 'attachment', by: 'type', match: 'application/pdf' } },
      ],
      html: false,
      ai: { enabled: false },
    };
    const outcome = runRulesPass(
      template,
      bill,
      email({
        from_address: 'billing@power.example',
        attachments: [
          { file_id: 'file_logo', filename: 'logo.png', mime_type: 'image/png' },
          { file_id: 'file_bill', filename: 'bill-09.pdf', mime_type: 'application/pdf' },
        ],
      }),
    );
    expect(outcome.kind === 'facts' && outcome.facts[0]!.variables.document).toBe('file_bill');
  });

  it('reads HTML only when the template says html: true', () => {
    const rules = [
      ...upsTemplate().rules,
      { target: { data: 'link' }, source: 'html' as const, find: { kind: 'pattern' as const, pattern: 'href="([^"]+)"' } },
    ];
    const withHtml = email({ html: '<a href="https://www.ups.com/track?n=1Z">Track</a>' });
    const off = runRulesPass(upsTemplate({ rules }), shipment, withHtml);
    const on = runRulesPass(upsTemplate({ rules, html: true }), shipment, withHtml);
    expect(off.kind === 'facts' && off.facts[0]!.data).toEqual({ greeting: 'Hello' });
    expect(on.kind === 'facts' && (on.facts[0]!.data as { link?: string }).link).toBe('https://www.ups.com/track?n=1Z');
  });
});

describe('repeated blocks (§4.2)', () => {
  it('yields one fact per block that meets the entrance', () => {
    const template = upsTemplate({
      repeat: { source: 'body', split: 'Parcel \\d+ of \\d+' },
    });
    const body = [
      'Your order ships in 3 parcels.',
      'Parcel 1 of 3',
      'Tracking Number: 1Z0000000000000001',
      'Parcel 2 of 3',
      'Tracking Number: 1Z0000000000000002',
      'Parcel 3 of 3',
      'Tracking details to follow.',
    ].join('\n');
    const outcome = runRulesPass(template, shipment, email({ body_text: body }));
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts.map((fact) => fact.variables.tracking_number)).toEqual([
      '1Z0000000000000001',
      '1Z0000000000000002',
    ]);
    expect(outcome.facts.map((fact) => fact.position)).toEqual([0, 1]);
    // Rules on other sources apply to every block.
    expect(outcome.facts.every((fact) => fact.variables.state === 'delivered')).toBe(true);
  });

  it('reads at most 100 blocks, and says the rest were not read', () => {
    const template = upsTemplate({ repeat: { source: 'body', split: 'Parcel \\d+' } });
    // Only the parcels past the cap say when they come.
    const body = Array.from({ length: 120 }, (_, i) => [
      `Parcel ${i + 1}`,
      `Tracking Number: 1Z${String(i + 1).padStart(16, '0')}`,
      ...(i >= 100 ? ['Scheduled: 09/30/2026'] : []),
    ].join('\n')).join('\n');
    const outcome = runRulesPass(template, shipment, email({ body_text: body }));
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts).toHaveLength(100);
    // The last block read ends where the next would begin: nothing past it.
    expect(outcome.facts[99]!.variables.tracking_number).toBe(`1Z${'100'.padStart(16, '0')}`);
    expect(outcome.facts.every((fact) => fact.variables.expected_at === null)).toBe(true);
    expect(outcome.warnings).toEqual(['the repeated block: more than 100 blocks; the rest were not read']);
  });
});

describe('refusals (§9)', () => {
  it('refuses a value that is not its kind, and says why', () => {
    const outcome = runRulesPass(
      upsTemplate(),
      shipment,
      email({ body_text: 'Tracking Number: 1Z999AA10123456784\nScheduled: sometime soon\n' }),
    );
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.variables.expected_at).toBeNull();
    expect(outcome.facts[0]!.refused).toEqual([{ variable: 'expected_at', reason: "'sometime soon' is not a date" }]);
  });

  it('refuses a full card number anywhere in the fact, data included', () => {
    const template = upsTemplate({
      rules: [
        ...upsTemplate().rules,
        { target: { data: 'payment' }, source: 'body', find: { kind: 'after_label', label: 'Paid with:' } },
      ],
    });
    const outcome = runRulesPass(
      template,
      shipment,
      email({ body_text: 'Tracking Number: 1Z999AA10123456784\nPaid with: 4111 1111 1111 1111\n' }),
    );
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect((outcome.facts[0]!.data as { payment?: unknown }).payment).toBeNull();
    expect(outcome.facts[0]!.refused).toContainEqual({ variable: 'data.payment', reason: 'holds a full card number' });
  });

  it('counts a required variable that is not there at all as missing, as one that is empty', () => {
    const fact = finishFact(shipment, { position: 0, variables: { carrier: 'UPS' }, passes: {}, refused: [], data: {} });
    expect(fact.missing).toEqual(['tracking_number']);
    expect(fact.complete).toBe(false);
  });

  it('refuses a card or an IBAN held as a number or as a key', () => {
    const fact = finishFact(shipment, {
      position: 0,
      variables: {},
      passes: {},
      refused: [],
      data: { paid: 4111111111111111, ledger: { 'DE89 3704 0044 0532 0130 00': 'rent' }, note: 'fine' },
    });
    expect(fact.data).toEqual({ paid: null, ledger: {}, note: 'fine' });
    expect(fact.refused).toEqual([
      { variable: 'data.paid', reason: 'holds a full card number' },
      { variable: 'data.ledger', reason: 'a key holds a full account number (an IBAN)' },
    ]);
  });

  it('refuses a card or an IBAN whose groups a no-break space parts, as it refuses one a space parts', () => {
    const fact = finishFact(shipment, {
      position: 0,
      variables: {},
      passes: {},
      refused: [],
      data: { paid: 'Visa 4111\u00A01111\u00A01111\u00A01111', iban: 'DE89\u00A03704\u00A00044\u00A00532\u00A00130\u00A000' },
    });
    expect(fact.data).toEqual({ paid: null, iban: null });
    expect(fact.refused).toEqual([
      { variable: 'data.paid', reason: 'holds a full card number' },
      { variable: 'data.iban', reason: 'holds a full account number (an IBAN)' },
    ]);
  });

  it('reads a range’s start with the p.m. only its end says: a table at nine at night, not nine in the morning', () => {
    const template: MailTemplateDefinition = {
      name: 'Bistro',
      type: 'reservation',
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'bistro.example' }], variables: ['starts_at'] },
      rules: [
        { target: { variable: 'kind' }, source: 'body', find: { kind: 'constant', value: 'event' } },
        { target: { variable: 'provider' }, source: 'from_name', find: { kind: 'whole' } },
        { target: { variable: 'confirmation_code' }, source: 'body', find: { kind: 'after_label', label: 'Code:' } },
        { target: { variable: 'starts_at' }, source: 'body', find: { kind: 'after_label', label: 'When:' } },
      ],
      html: false,
      ai: { enabled: false },
    };
    const outcome = runRulesPass(template, getMailFactBuiltinType('reservation')!, email({
      from_address: 'table@bistro.example', from_name: 'Bistro', subject: 'Your table',
      body_text: 'Code: R-1\nWhen: 28 September 2026 9:00\u201310:00 PM (UTC+01:00)\n',
    }));
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.variables.starts_at).toBe('2026-09-28T21:00:00+01:00');
  });

  it('refuses a card or an IBAN written in fullwidth, in a variable and in data: the key reads it as plain digits', () => {
    const fullwidth = (text: string): string => text.replace(/[0-9A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xFEE0));
    const template = upsTemplate({
      rules: [
        ...upsTemplate().rules,
        { target: { variable: 'merchant' }, source: 'body', find: { kind: 'after_label', label: 'Paid:' } },
        { target: { data: 'note' }, source: 'body', find: { kind: 'after_label', label: 'Note:' } },
        { target: { data: 'bank' }, source: 'body', find: { kind: 'after_label', label: 'Bank:' } },
      ],
    });
    const outcome = runRulesPass(template, shipment, email({
      body_text: `Tracking Number: 1Z999AA10123456784\nPaid: ${fullwidth('4111111111111111')}\nNote: ${fullwidth('4111 1111 1111 1111')}\nBank: ${fullwidth('DE89370400440532013000')}\n`,
    }));
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.variables.merchant).toBeNull();
    expect(outcome.facts[0]!.data).toMatchObject({ note: null, bank: null });
    expect(outcome.facts[0]!.refused).toEqual(expect.arrayContaining([
      { variable: 'merchant', reason: 'holds a full card number' },
      { variable: 'data.note', reason: 'holds a full card number' },
      { variable: 'data.bank', reason: 'holds a full account number (an IBAN)' },
    ]));
  });

  it('refuses a time whose offset is not read whole: a required one then does not enter', () => {
    const template: MailTemplateDefinition = {
      name: 'Bistro',
      type: 'reservation',
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'bistro.example' }], variables: ['starts_at'] },
      rules: [
        { target: { variable: 'kind' }, source: 'body', find: { kind: 'constant', value: 'event' } },
        { target: { variable: 'provider' }, source: 'from_name', find: { kind: 'whole' } },
        { target: { variable: 'confirmation_code' }, source: 'body', find: { kind: 'after_label', label: 'Code:' } },
        { target: { variable: 'starts_at' }, source: 'body', find: { kind: 'after_label', label: 'When:' } },
      ],
      html: false,
      ai: { enabled: false },
    };
    for (const when of ['2026-09-28 10:00:00 +02:000', 'Sep 28, 2026 10:00 -070099']) {
      const outcome = runRulesPass(template, getMailFactBuiltinType('reservation')!, email({
        from_address: 'table@bistro.example', from_name: 'Bistro', subject: 'Your table', body_text: `Code: R-1\nWhen: ${when}\n`,
      }));
      expect(outcome.kind, when).not.toBe('facts');
    }
  });

  it('refuses a card or an IBAN whose groups a run of spaces parts, as it refuses one a space parts', () => {
    const template = upsTemplate({
      rules: [
        ...upsTemplate().rules,
        { target: { data: 'note' }, source: 'body', find: { kind: 'after_label', label: 'Note:' } },
        { target: { data: 'bank' }, source: 'body', find: { kind: 'after_label', label: 'Bank:' } },
      ],
    });
    const outcome = runRulesPass(template, shipment, email({
      body_text: 'Tracking Number: 1Z999AA10123456784\nNote: 4111    1111    1111    1111\nBank: DE89    3704    0044    0532    0130    00\n',
    }));
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.data).toMatchObject({ note: null, bank: null });
    expect(outcome.facts[0]!.refused).toEqual(expect.arrayContaining([
      { variable: 'data.note', reason: 'holds a full card number' },
      { variable: 'data.bank', reason: 'holds a full account number (an IBAN)' },
    ]));
  });

  it('refuses an IBAN grouped by dashes in a variable and in data', () => {
    const template = upsTemplate({
      rules: [
        ...upsTemplate().rules,
        { target: { variable: 'merchant' }, source: 'body', find: { kind: 'after_label', label: 'Bank:' } },
        { target: { data: 'bank' }, source: 'body', find: { kind: 'after_label', label: 'Bank:' } },
      ],
    });
    const outcome = runRulesPass(template, shipment, email({ body_text: 'Tracking Number: 1Z999AA10123456784\nBank: DE89-3704-0044-0532-0130-00\n' }));
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.variables.merchant).toBeNull();
    expect((outcome.facts[0]!.data as { bank?: unknown }).bank).toBeNull();
    expect(outcome.facts[0]!.refused).toEqual(expect.arrayContaining([
      { variable: 'merchant', reason: 'holds a full account number (an IBAN)' },
      { variable: 'data.bank', reason: 'holds a full account number (an IBAN)' },
    ]));
  });

  it('drops data over the 64 KB cap with the reason, keeping the variables', () => {
    const template = upsTemplate({
      rules: [
        ...upsTemplate().rules,
        { target: { data: 'everything' }, source: 'body', find: { kind: 'whole' } },
      ],
    });
    const huge = `Tracking Number: 1Z999AA10123456784\n${'x'.repeat(MAIL_FACT_DATA_MAX_BYTES)}`;
    const outcome = runRulesPass(template, shipment, email({ body_text: huge }));
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.data).toBeNull();
    expect(outcome.facts[0]!.refused).toContainEqual({ variable: 'data', reason: 'data over 64 KB' });
    expect(outcome.facts[0]!.variables.tracking_number).toBe('1Z999AA10123456784');
  });
});

describe('data paths (§4.2)', () => {
  it('never writes through what an object inherits, even from a template that was never checked', () => {
    const target: Record<string, unknown> = {};
    setPath(target, '__proto__.polluted_by_mail', 'x');
    setPath(target, 'constructor.prototype.polluted_by_mail', 'x');
    setPath(target, 'order.__proto__', 'x');
    expect(target).toEqual({});
    setPath(target, 'order.id', 'A-1');
    expect(target).toEqual({ order: { id: 'A-1' } });

    const stored = upsTemplate({
      rules: [...upsTemplate().rules, { target: { data: '__proto__.polluted_by_mail' }, source: 'body', find: { kind: 'whole' } }],
    });
    expect(runRulesPass(stored, shipment, email()).kind).toBe('facts');
    expect(({} as Record<string, unknown>).polluted_by_mail).toBeUndefined();
  });
});

describe('a pattern that runs too long (§9)', () => {
  it('is stopped, and the value is refused with the reason instead of a silent miss', () => {
    const template = upsTemplate({
      rules: [
        ...upsTemplate().rules,
        // Anchored per line (m), one capture group, nested quantifier: catastrophic on 'aaa…!'.
        { target: { data: 'slow' }, source: 'body', find: { kind: 'pattern', pattern: '^((?:a+)+)$', flags: 'm' } },
      ],
    });
    const outcome = runRulesPass(
      template,
      shipment,
      email({ body_text: `Tracking Number: 1Z999AA10123456784\n${'a'.repeat(40)}!` }),
    );
    expect(outcome.kind).toBe('facts');
    if (outcome.kind !== 'facts') return;
    expect(outcome.facts[0]!.refused.find((r) => r.variable === 'data.slow')?.reason).toMatch(/was stopped/);
    expect(outcome.facts[0]!.variables.tracking_number).toBe('1Z999AA10123456784');
  });

  it('in a condition counts as not holding, with a warning for health', () => {
    const template = upsTemplate({
      entrance: {
        conditions: [{ field: 'body', op: 'matches', value: '^(a+)+$' }],
        variables: ['tracking_number'],
      },
    });
    const outcome = runRulesPass(template, shipment, email({ body_text: `${'a'.repeat(40)}!` }));
    expect(outcome.kind).toBe('no_match');
    expect(outcome.warnings?.[0]).toMatch(/body condition: .*was stopped/);
  });
});
